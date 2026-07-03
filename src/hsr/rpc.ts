/**
 * HSR JSON-RPC 2.0 over a unix-domain socket (APIA-73).
 *
 * A small, reusable transport: newline-delimited JSON framing (one JSON-RPC 2.0
 * object per line) over an AF_UNIX stream. It backs both the per-bee runner
 * control sockets (`~/.hive/hsr/<bee>/control.sock`) and the daemon-level
 * aggregate control/observe endpoint (docs/HSR_EXPLORATION.md §6, §7). Runner
 * hosts expose `send`/`interrupt`/`answer`/`stop`/`snapshot` as request methods
 * and push a live event stream to connected observers via server notifications.
 *
 * Node builtins only — no deps. Scope here is JUST the transport + codec; no
 * spawning, no daemon/CLI wiring.
 */

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

// --- JSON-RPC 2.0 wire shapes -------------------------------------------------

type JsonRpcId = number;

type JsonRpcRequest = { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown };
type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
type JsonRpcError = { code: number; message: string; data?: unknown };
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

// Standard JSON-RPC 2.0 error codes we emit.
const CODE_PARSE_ERROR = -32700;
const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INTERNAL = -32000; // server-defined: handler threw

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o700;
// Per-connection outbound broadcast bound (HIVE-70). Mirrors the local
// transport's inbound DEFAULT_MAX_QUEUE (remoteTransport.ts): once a client
// stops draining and this many frames are queued, we DROP-OLDEST rather than
// let Node buffer hsr.event frames without bound in the serve process.
const DEFAULT_MAX_BROADCAST_QUEUE = 256;

/** Serialize one JSON-RPC object as a single newline-delimited frame. */
function frame(value: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest): string {
  return `${JSON.stringify(value)}\n`;
}

// A newline-delimited-JSON line reader. Buffers partial lines and yields one
// raw JSON string per complete line; blank lines are ignored. Shared by both
// server connections and the client.
function makeLineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) onLine(trimmed);
      newlineIndex = buffer.indexOf("\n");
    }
  };
}

// --- Server -------------------------------------------------------------------

export type RpcConnectionCtx = { connectionId: number; close(): void };
export type RpcMethodHandler = (params: unknown, ctx: RpcConnectionCtx) => Promise<unknown> | unknown;

export type RpcServer = {
  path: string;
  /**
   * Push a notification to every connected client (used for event streams).
   * Backpressure-aware (HIVE-70): honors socket.write() return per connection;
   * a slow client gets a bounded drop-oldest queue instead of unbounded Node
   * write buffering.
   */
  broadcast(method: string, params?: unknown): void;
  /** Number of live client connections. */
  connectionCount(): number;
  /** Total broadcast frames dropped across all connections (backpressure telemetry). */
  broadcastDroppedCount(): number;
  close(): Promise<void>;
};

/**
 * Standard unix-socket staleness handling: if a file already exists at
 * `socketPath`, probe it by connecting. A successful connect means a live
 * server owns the path (fatal — caller must not steal it). ECONNREFUSED/ENOENT
 * means the file is a stale leftover from a crashed process, safe to unlink.
 */
async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const live = await new Promise<boolean>((resolve) => {
    const probe = createConnection(socketPath);
    const settle = (isLive: boolean): void => {
      probe.destroy();
      resolve(isLive);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
  });
  if (live) {
    throw new Error(`hive hsr: a live RPC server is already listening at ${socketPath}`);
  }
  // Stale socket file from a dead process — remove it before we listen.
  await unlink(socketPath).catch(() => {});
}

// Per-connection outbound state for broadcast backpressure (HIVE-70). `blocked`
// is set when socket.write() reports a full stream buffer and cleared on
// 'drain'; while blocked (or while a backlog exists), broadcast frames queue
// here — bounded, drop-oldest — instead of piling into Node's write buffer.
type ServerConnection = {
  socket: Socket;
  queue: string[];
  blocked: boolean;
  dropped: number;
};

export async function startRpcServer(opts: {
  socketPath: string;
  methods: Record<string, RpcMethodHandler>;
  /** Optional: called once per new client connection. */
  onConnection?: (ctx: RpcConnectionCtx) => void;
  /** Max queued broadcast frames per slow connection before drop-oldest (HIVE-70). */
  maxBroadcastQueue?: number;
}): Promise<RpcServer> {
  const { socketPath, methods, onConnection } = opts;
  const maxBroadcastQueue = Math.max(1, opts.maxBroadcastQueue ?? DEFAULT_MAX_BROADCAST_QUEUE);

  await mkdir(dirname(socketPath), { recursive: true, mode: SOCKET_DIR_MODE });
  await clearStaleSocket(socketPath);

  const connections = new Map<number, ServerConnection>();
  let nextConnectionId = 1;
  let broadcastDropped = 0;

  // Write one broadcast frame to a connection, honoring backpressure. Direct
  // write while the socket is keeping up; once write() returns false (stream
  // buffer at highWaterMark) or a backlog exists, frames go through the bounded
  // per-connection queue and are flushed from the 'drain' handler.
  const sendBroadcast = (conn: ServerConnection, line: string): void => {
    if (!conn.socket.writable) return;
    if (!conn.blocked && conn.queue.length === 0) {
      if (!conn.socket.write(line, () => {})) conn.blocked = true;
      return;
    }
    if (conn.queue.length >= maxBroadcastQueue) {
      conn.queue.shift();
      conn.dropped++;
      broadcastDropped++;
    }
    conn.queue.push(line);
  };

  const flushBroadcastQueue = (conn: ServerConnection): void => {
    conn.blocked = false;
    while (!conn.blocked && conn.queue.length > 0) {
      if (!conn.socket.writable) {
        conn.queue.length = 0;
        return;
      }
      const line = conn.queue.shift() as string;
      if (!conn.socket.write(line, () => {})) conn.blocked = true;
    }
  };

  const server: Server = createServer((socket) => {
    const connectionId = nextConnectionId++;
    const conn: ServerConnection = { socket, queue: [], blocked: false, dropped: 0 };
    connections.set(connectionId, conn);

    const ctx: RpcConnectionCtx = {
      connectionId,
      close: () => socket.destroy(),
    };

    const respond = (response: JsonRpcResponse): void => {
      if (!socket.writable) return;
      socket.write(frame(response), () => {});
    };

    const handleLine = (line: string): void => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // Malformed line: no recoverable id → per JSON-RPC, respond with a
        // null-id parse error but never crash; then keep reading.
        respond({ jsonrpc: "2.0", id: null as unknown as JsonRpcId, error: { code: CODE_PARSE_ERROR, message: "Parse error" } });
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const req = msg as Partial<JsonRpcRequest>;
      // Requests carry a numeric id; anything without one (e.g. a stray
      // notification from the peer) is not answerable — drop it.
      if (typeof req.id !== "number" || typeof req.method !== "string") return;
      const id = req.id;
      const handler = methods[req.method];
      if (!handler) {
        respond({ jsonrpc: "2.0", id, error: { code: CODE_METHOD_NOT_FOUND, message: "Method not found" } });
        return;
      }
      // Requests on a connection may be handled concurrently; the id on each
      // response lets the client match them regardless of completion order.
      void (async () => {
        try {
          const result = await handler(req.params, ctx);
          respond({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          respond({ jsonrpc: "2.0", id, error: { code: CODE_INTERNAL, message } });
        }
      })();
    };

    socket.on("data", makeLineReader(handleLine));
    socket.on("drain", () => flushBroadcastQueue(conn));
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      conn.queue.length = 0;
      connections.delete(connectionId);
    });

    if (onConnection) {
      try {
        onConnection(ctx);
      } catch {
        // A misbehaving onConnection hook must never take down the server.
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  // Tighten permissions: owner-only, matching the 0o700 parent dir.
  await chmod(socketPath, SOCKET_MODE).catch(() => {});

  return {
    path: socketPath,
    broadcast(method: string, params?: unknown): void {
      const notification: JsonRpcNotification = params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params };
      const line = frame(notification);
      for (const conn of connections.values()) {
        // Best-effort fan-out: a dead/closing socket must not throw here, and
        // a slow one queues (bounded, drop-oldest) instead of buffering unboundedly.
        sendBroadcast(conn, line);
      }
    },
    connectionCount(): number {
      return connections.size;
    },
    broadcastDroppedCount(): number {
      return broadcastDropped;
    },
    async close(): Promise<void> {
      // Stop accepting, drop every client, then close the listener and unlink
      // the socket file so the path is clean for the next server.
      for (const conn of connections.values()) conn.socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
    },
  };
}

// --- Client -------------------------------------------------------------------

export type RpcClient = {
  call(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Subscribe to server push notifications for `method`. Returns an unsubscribe fn. */
  on(method: string, handler: (params: unknown) => void): () => void;
  close(): void;
  /** Resolves when the underlying socket closes (server gone / close() called). */
  readonly closed: Promise<void>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

export async function connectRpcClient(
  socketPath: string,
  opts?: { connectTimeoutMs?: number },
): Promise<RpcClient> {
  const connectTimeoutMs = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(socketPath);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`rpc connect to ${socketPath} timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const reason = error.code === "ENOENT"
        ? "no socket at path (server not running)"
        : error.code === "ECONNREFUSED"
          ? "connection refused (stale socket / server gone)"
          : error.message;
      reject(new Error(`rpc connect to ${socketPath} failed: ${reason}`));
    });
  });

  const pending = new Map<JsonRpcId, Pending>();
  const notifications = new EventEmitter();
  notifications.setMaxListeners(0);
  let nextId = 1;
  let closed = false;

  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    const err = new Error("rpc connection closed");
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    resolveClosed();
  };

  const handleLine = (line: string): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore garbage from the peer
    }
    if (!msg || typeof msg !== "object") return;
    const obj = msg as Partial<JsonRpcResponse> & Partial<JsonRpcNotification>;
    if (typeof obj.id === "number") {
      const p = pending.get(obj.id);
      if (!p) return;
      pending.delete(obj.id);
      clearTimeout(p.timer);
      if ("error" in obj && obj.error) {
        const rpcErr = obj.error as JsonRpcError;
        const error = new Error(rpcErr.message) as Error & { code?: number; data?: unknown };
        error.code = rpcErr.code;
        error.data = rpcErr.data;
        p.reject(error);
      } else {
        p.resolve((obj as { result: unknown }).result);
      }
      return;
    }
    // No id → a server push notification.
    if (typeof obj.method === "string") {
      notifications.emit(obj.method, obj.params);
    }
  };

  socket.on("data", makeLineReader(handleLine));
  socket.once("close", teardown);
  socket.on("error", () => {
    // Surfaced as a close; pending calls reject via teardown.
  });

  return {
    call(method: string, params?: unknown, callOpts?: { timeoutMs?: number }): Promise<unknown> {
      const timeoutMs = callOpts?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      if (closed) return Promise.reject(new Error("rpc connection closed"));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`rpc call ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        const request: JsonRpcRequest = params === undefined
          ? { jsonrpc: "2.0", id, method }
          : { jsonrpc: "2.0", id, method, params };
        if (!socket.writable) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("rpc connection closed"));
          return;
        }
        socket.write(frame(request), (error) => {
          if (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error(`rpc call ${method} failed to send: ${error.message}`));
          }
        });
      });
    },
    on(method: string, handler: (params: unknown) => void): () => void {
      notifications.on(method, handler);
      return () => notifications.removeListener(method, handler);
    },
    close(): void {
      socket.destroy();
      teardown();
    },
    get closed(): Promise<void> {
      return closedPromise;
    },
  };
}
