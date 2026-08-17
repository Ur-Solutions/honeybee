/**
 * Thin RPC client over the daemon's unix socket (protocol.ts framing).
 * Mutations and watch ALWAYS go through here; reads fall back to the
 * read-only store (readonly.ts) only when the daemon is down.
 */
import { createConnection, type Socket } from "node:net";
import {
  PROTOCOL,
  RpcError,
  type RpcVerb,
  type WatchFrame,
} from "../../daemon/src/protocol.ts";

/** The daemon is not reachable at the socket — the read-fallback trigger. */
export class DaemonDownError extends Error {
  constructor(socketPath: string, cause: string) {
    super(`daemon not reachable at ${socketPath} (${cause})`);
    this.name = "DaemonDownError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class RpcClient {
  private readonly socket: Socket;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;
  private closed = false;
  /** Watch push frames (deltas/gaps) land here. */
  onEvent: ((frame: WatchFrame) => void) | null = null;
  onClose: (() => void) | null = null;

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  static connect(socketPath: string, timeoutMs = 3000): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DaemonDownError(socketPath, "connect timeout"));
      }, timeoutMs);
      timer.unref();
      socket.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new DaemonDownError(socketPath, err.code ?? err.message));
      });
      socket.once("connect", () => {
        const client = new RpcClient(socket);
        socket.setEncoding("utf8");
        // Wait for the server hello, then answer with ours (negotiated once).
        const onHello = (chunk: string): void => {
          client.buffer += chunk;
          const nl = client.buffer.indexOf("\n");
          if (nl < 0) return;
          const line = client.buffer.slice(0, nl);
          client.buffer = client.buffer.slice(nl + 1);
          socket.off("data", onHello);
          clearTimeout(timer);
          let hello: Record<string, unknown>;
          try {
            hello = JSON.parse(line) as Record<string, unknown>;
          } catch {
            socket.destroy();
            reject(new RpcError("protocol_mismatch", "server hello is not json"));
            return;
          }
          if (hello.protocol !== PROTOCOL) {
            socket.destroy();
            reject(
              new RpcError(
                "protocol_mismatch",
                `client speaks ${PROTOCOL}; server offered ${JSON.stringify(hello.protocol ?? null)}`,
              ),
            );
            return;
          }
          socket.write(`${JSON.stringify({ protocol: PROTOCOL })}\n`);
          socket.on("data", (c: string) => client.onData(c));
          socket.on("close", () => client.onSocketClose());
          socket.on("error", () => socket.destroy());
          // Drain anything that arrived glued to the hello.
          if (client.buffer.length > 0) client.onData("");
          resolve(client);
        };
        socket.on("data", onHello);
      });
    });
  }

  request<T = unknown>(verb: RpcVerb, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new DaemonDownError("(closed)", "connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonDownError(this.socket.remoteAddress ?? "(socket)", `rpc timeout on ${verb}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(`${JSON.stringify({ id, verb, params })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this.onFrame(line);
    }
  }

  private onFrame(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // a torn frame on a dying socket; close handling owns cleanup
    }
    if (typeof frame.type === "string") {
      this.onEvent?.(frame as unknown as WatchFrame);
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok === true) {
      pending.resolve(frame.result);
    } else {
      const err = (frame.error ?? {}) as { code?: string; message?: string };
      pending.reject(
        new RpcError(
          (err.code as RpcError["code"]) ?? "invalid_request",
          err.message ?? "rpc error",
        ),
      );
    }
  }

  private onSocketClose(): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new DaemonDownError("(socket)", "connection closed"));
    this.pending.clear();
    this.onClose?.();
  }
}
