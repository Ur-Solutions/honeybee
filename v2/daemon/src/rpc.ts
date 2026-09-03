/**
 * The daemon's RPC server — unix socket, jsonl frames, one negotiated
 * protocol (spec 04 "RPC surface"; framing defined in protocol.ts).
 *
 * The server is transport only: it parses frames, enforces the hello, maps
 * errors onto the closed list, and owns the per-connection watch cursors.
 * Verb semantics live in the daemon's dispatch function.
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { AuditRow } from "../../core/src/index.ts";
import {
  AccountNotFoundError,
  AccountReferencedError,
  BeeNotFoundError,
  CoreError,
  IllegalTransitionError,
  NameConflictError,
  PackageError,
  QuestionNotFoundError,
  SealNotFoundError,
  TaskNotFoundError,
  TemplateNotFoundError,
  TrackNotFoundError,
} from "../../core/src/index.ts";
import { LeaseRefusal } from "./accountsService.ts";
import { LoginFlowRefusal } from "./loginFlows.ts";
import {
  DAEMON_CAPABILITIES,
  PROTOCOL,
  RPC_VERBS,
  RpcError,
  type HelloFrame,
  type RpcErrorCode,
  type RpcVerb,
  type WatchFrame,
} from "./protocol.ts";

export interface RpcConn {
  /** Push a raw frame (used for watch deltas/gaps). */
  send(obj: unknown): void;
  /** Enter watch mode from this seq; subsequent flushes stream deltas. */
  subscribeWatch(cursor: number): void;
  /** Re-align the watch cursor (after serving a snapshot to a watching client). */
  alignWatch(cursor: number): void;
}

export type RpcDispatch = (
  verb: RpcVerb,
  params: Record<string, unknown>,
  conn: RpcConn,
) => unknown;

export interface RpcServerOptions {
  socketPath: string;
  log: (op: string) => void;
  dispatch: RpcDispatch;
}

interface Connection extends RpcConn {
  socket: Socket;
  buffer: string;
  helloDone: boolean;
  watchCursor: number | null;
}

/** Map any thrown error onto the closed RPC error list. */
export function toRpcError(err: unknown): { code: RpcErrorCode; message: string } {
  if (err instanceof RpcError) return { code: err.code, message: err.message };
  if (err instanceof LoginFlowRefusal) return { code: err.code, message: err.message };
  if (err instanceof LeaseRefusal) return { code: err.code, message: err.message };
  if (err instanceof BeeNotFoundError) return { code: "bee_not_found", message: err.message };
  if (err instanceof TemplateNotFoundError) return { code: "template_not_found", message: err.message };
  if (err instanceof TrackNotFoundError) return { code: "track_not_found", message: err.message };
  if (err instanceof QuestionNotFoundError) return { code: "question_not_found", message: err.message };
  if (err instanceof SealNotFoundError) return { code: "seal_not_found", message: err.message };
  if (err instanceof TaskNotFoundError) return { code: "task_not_found", message: err.message };
  if (err instanceof AccountNotFoundError) return { code: "account_not_found", message: err.message };
  if (err instanceof AccountReferencedError) return { code: "account_referenced", message: err.message };
  if (err instanceof NameConflictError) return { code: "name_conflict", message: err.message };
  if (err instanceof PackageError) return { code: "invalid_package", message: err.message };
  if (err instanceof IllegalTransitionError) {
    const code: RpcErrorCode = err.message.includes("lifecycle") ? "lifecycle_refused" : "runtime_refused";
    return { code, message: err.message };
  }
  if (err instanceof CoreError) return { code: "invalid_request", message: err.message };
  return { code: "invalid_request", message: err instanceof Error ? err.message : String(err) };
}

export class RpcServer {
  private readonly opts: RpcServerOptions;
  private readonly server: Server;
  private readonly conns = new Set<Connection>();
  private listening = false;

  constructor(opts: RpcServerOptions) {
    this.opts = opts;
    this.server = createServer((socket) => this.onConnection(socket));
  }

  listen(): Promise<void> {
    // The store's EXCLUSIVE lock already guarantees single-daemon-per-node;
    // any socket file left at this path is a stale corpse from a dead daemon.
    if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath);
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.socketPath, () => {
        this.listening = true;
        this.opts.log(`rpc.listen socket=${this.opts.socketPath}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const conn of this.conns) conn.socket.destroy();
    this.conns.clear();
    return new Promise((resolve) => {
      if (!this.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.listening = false;
    });
  }

  /**
   * Stream pending audit rows to every watching connection. Deltas carry
   * `baseSeq` (what the client last held) and `seq` (new cursor): the client
   * fails closed on any `baseSeq` mismatch. A batch larger than `maxBatch`
   * becomes an explicit `{type:"gap"}` — the server never sends unbounded
   * frames, and the gap is detectable by construction.
   */
  flushWatch(latestSeq: number, eventsSince: (fromSeq: number) => AuditRow[], maxBatch: number): void {
    // Steady-state watchers share a cursor: fetch each distinct cursor once
    // per pass instead of once per connection.
    const byCursor = new Map<number, AuditRow[]>();
    for (const conn of this.conns) {
      if (conn.watchCursor == null || conn.watchCursor >= latestSeq) continue;
      let events = byCursor.get(conn.watchCursor);
      if (events === undefined) {
        events = eventsSince(conn.watchCursor);
        byCursor.set(conn.watchCursor, events);
      }
      if (events.length === 0) continue;
      if (events.length > maxBatch) {
        const frame: WatchFrame = { type: "gap", seq: latestSeq };
        conn.send(frame);
        conn.watchCursor = latestSeq;
        this.opts.log(`rpc.watch.gap cursor=${latestSeq} dropped=${events.length}`);
        continue;
      }
      const last = events[events.length - 1] as AuditRow;
      const frame: WatchFrame = { type: "delta", baseSeq: conn.watchCursor, seq: last.seq, events };
      conn.send(frame);
      conn.watchCursor = last.seq;
    }
  }

  private onConnection(socket: Socket): void {
    const conn: Connection = {
      socket,
      buffer: "",
      helloDone: false,
      watchCursor: null,
      send: (obj: unknown) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`);
      },
      subscribeWatch: (cursor: number) => {
        conn.watchCursor = cursor;
      },
      alignWatch: (cursor: number) => {
        if (conn.watchCursor != null) conn.watchCursor = cursor;
      },
    };
    this.conns.add(conn);
    socket.setEncoding("utf8");
    // Versioned hello, server side (negotiated once). Capability tags are
    // additive: a pre-v16 client ignores the extra key.
    conn.send({ protocol: PROTOCOL, capabilities: DAEMON_CAPABILITIES } satisfies HelloFrame);
    socket.on("data", (chunk: string) => this.onData(conn, chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.conns.delete(conn));
  }

  private onData(conn: Connection, chunk: string): void {
    conn.buffer += chunk;
    for (;;) {
      const nl = conn.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = conn.buffer.slice(0, nl).trim();
      conn.buffer = conn.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this.onFrame(conn, line);
    }
  }

  private onFrame(conn: Connection, line: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      frame = parsed as Record<string, unknown>;
    } catch {
      conn.send({ id: -1, ok: false, error: { code: "invalid_request", message: "frame is not a json object" } });
      return;
    }
    if (!conn.helloDone) {
      if (frame.protocol !== PROTOCOL) {
        conn.send({
          id: -1,
          ok: false,
          error: {
            code: "protocol_mismatch",
            message: `server speaks ${PROTOCOL}; client offered ${JSON.stringify(frame.protocol ?? null)}`,
          },
        });
        conn.socket.end();
        return;
      }
      conn.helloDone = true;
      return;
    }
    const id = typeof frame.id === "number" ? frame.id : -1;
    const verb = frame.verb;
    if (typeof verb !== "string" || !(RPC_VERBS as readonly string[]).includes(verb)) {
      conn.send({ id, ok: false, error: { code: "invalid_request", message: `unknown verb: ${String(verb)}` } });
      return;
    }
    const params =
      frame.params === undefined
        ? {}
        : frame.params !== null && typeof frame.params === "object" && !Array.isArray(frame.params)
          ? (frame.params as Record<string, unknown>)
          : null;
    if (params === null) {
      conn.send({ id, ok: false, error: { code: "invalid_request", message: "params must be an object" } });
      return;
    }
    try {
      const result = this.opts.dispatch(verb as RpcVerb, params, conn);
      // v7: verbs with a bounded async leg (limits fetch before an auto pick,
      // the login seat's keychain baseline) return a promise; sync verbs are
      // answered on the spot exactly as before.
      if (result instanceof Promise) {
        result.then(
          (value) => conn.send({ id, ok: true, result: value }),
          (err) => conn.send({ id, ok: false, error: toRpcError(err) }),
        );
        return;
      }
      conn.send({ id, ok: true, result });
    } catch (err) {
      conn.send({ id, ok: false, error: toRpcError(err) });
    }
  }
}
