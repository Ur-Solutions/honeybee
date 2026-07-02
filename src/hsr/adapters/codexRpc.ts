/**
 * HSR codex transport — a bidirectional stdio JSON-RPC 2.0 peer (APIA-75).
 *
 * codex `app-server` speaks JSON-RPC 2.0 over its child stdio: WE write requests
 * to its stdin and read responses + notifications + SERVER REQUESTS (approvals)
 * off its stdout. Framing is NDJSON (one JSON object per line) with partial-line
 * buffering, mirroring src/hsr/rpc.ts / streamRunner.ts.
 *
 * This module is TRANSPORT-ONLY — it knows nothing about codex methods. It:
 *   - request(method, params) → Promise<result>  (numeric id, timeout, rejects on error)
 *   - notify(method, params)                      (fire-and-forget, no id)
 *   - onNotification(method, handler) + a catch-all for unmatched notifications
 *   - onServerRequest((method, id, params) => void) with respond()/respondError()
 *
 * Message classification off a single inbound line:
 *   id + (result|error) → a RESPONSE to one of our requests
 *   id + method         → a SERVER REQUEST (needs a respond/respondError)
 *   method (no id)      → a NOTIFICATION
 *
 * Node builtins only.
 */

import type { Readable, Writable } from "node:stream";

type JsonRpcId = string | number;

// Standard JSON-RPC 2.0 error codes.
export const CODEX_RPC_METHOD_NOT_FOUND = -32601;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Split a byte stream into complete lines; buffers the partial trailing line. */
function makeLineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.trim().length > 0) onLine(line);
      nl = buffer.indexOf("\n");
    }
  };
}

export type CodexRpcPeer = {
  /** Send a JSON-RPC request; resolves with `result` or rejects on error/timeout. */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Send a JSON-RPC notification (no id, no response). */
  notify(method: string, params?: unknown): void;
  /** Register a per-method notification handler. Returns an unsubscribe fn. */
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  /** Handler for notifications with no specific handler registered (unknown methods). */
  onNotificationCatchAll(handler: (method: string, params: unknown) => void): void;
  /** Handler for inbound server requests (approvals); MUST respond/respondError. */
  onServerRequest(handler: (method: string, id: JsonRpcId, params: unknown) => void): void;
  /** Send the success response for an inbound server request. */
  respond(id: JsonRpcId, result: unknown): void;
  /** Send an error response for an inbound server request. */
  respondError(id: JsonRpcId, code: number, message: string): void;
  /** Reject all pending requests and stop reading. */
  dispose(err?: Error): void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Wrap a child's stdin(Writable)/stdout(Readable) as a JSON-RPC 2.0 peer.
 * No spawning here — the caller owns the child lifecycle.
 */
export function createCodexRpcPeer(stdin: Writable, stdout: Readable): CodexRpcPeer {
  const pending = new Map<number, Pending>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  let notificationCatchAll: ((method: string, params: unknown) => void) | undefined;
  let serverRequestHandler: ((method: string, id: JsonRpcId, params: unknown) => void) | undefined;
  let nextId = 1;
  let disposed = false;

  const write = (value: unknown): void => {
    if (disposed || !stdin.writable) return;
    try {
      stdin.write(`${JSON.stringify(value)}\n`);
    } catch {
      // A write on a closing pipe (EPIPE) must not throw into the caller.
    }
  };

  const handleLine = (line: string): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore garbage
    }
    if (!msg || typeof msg !== "object") return;
    const obj = msg as { id?: unknown; method?: unknown; result?: unknown; error?: unknown; params?: unknown };

    const hasId = typeof obj.id === "number" || typeof obj.id === "string";
    const hasMethod = typeof obj.method === "string";

    // A RESPONSE to one of our requests: id + (result | error), no method.
    if (hasId && !hasMethod && ("result" in obj || "error" in obj)) {
      // Our request ids are always numeric.
      if (typeof obj.id !== "number") return;
      const p = pending.get(obj.id);
      if (!p) return;
      pending.delete(obj.id);
      clearTimeout(p.timer);
      if (obj.error) {
        const e = obj.error as { code?: number; message?: string; data?: unknown };
        const error = new Error(e.message ?? "codex rpc error") as Error & { code?: number; data?: unknown };
        error.code = e.code;
        error.data = e.data;
        p.reject(error);
      } else {
        p.resolve(obj.result);
      }
      return;
    }

    // A SERVER REQUEST: id + method → the server wants a response from us.
    if (hasId && hasMethod) {
      if (serverRequestHandler) serverRequestHandler(obj.method as string, obj.id as JsonRpcId, obj.params);
      else respondError(obj.id as JsonRpcId, CODEX_RPC_METHOD_NOT_FOUND, "no server-request handler");
      return;
    }

    // A NOTIFICATION: method, no id.
    if (hasMethod) {
      const handler = notificationHandlers.get(obj.method as string);
      if (handler) handler(obj.params);
      else if (notificationCatchAll) notificationCatchAll(obj.method as string, obj.params);
      return;
    }
  };

  stdout.on("data", makeLineReader(handleLine));

  function respondError(id: JsonRpcId, code: number, message: string): void {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  const dispose = (err?: Error): void => {
    if (disposed) return;
    disposed = true;
    const error = err ?? new Error("codex rpc peer disposed");
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  return {
    request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
      if (disposed) return Promise.reject(new Error("codex rpc peer disposed"));
      const id = nextId++;
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex rpc request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const req = params === undefined
          ? { jsonrpc: "2.0", id, method }
          : { jsonrpc: "2.0", id, method, params };
        if (!stdin.writable) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`codex rpc request ${method} failed: child stdin not writable`));
          return;
        }
        write(req);
      });
    },
    notify(method: string, params?: unknown): void {
      write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
    },
    onNotification(method: string, handler: (params: unknown) => void): () => void {
      notificationHandlers.set(method, handler);
      return () => {
        if (notificationHandlers.get(method) === handler) notificationHandlers.delete(method);
      };
    },
    onNotificationCatchAll(handler: (method: string, params: unknown) => void): void {
      notificationCatchAll = handler;
    },
    onServerRequest(handler: (method: string, id: JsonRpcId, params: unknown) => void): void {
      serverRequestHandler = handler;
    },
    respond(id: JsonRpcId, result: unknown): void {
      write({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    },
    respondError,
    dispose,
  };
}
