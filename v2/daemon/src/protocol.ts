/**
 * The v2 RPC surface (spec 04 "RPC surface") — shared by the daemon's server
 * (rpc.ts) and the thin CLI client (v2/cli/src/client.ts).
 *
 * Transport: unix domain socket, jsonl frames (one json object per line).
 * Versioned hello, negotiated once: the server writes `{"protocol":"v2/1"}`
 * on connect; the client's FIRST frame must be `{"protocol":"v2/1"}`. A
 * mismatch is answered with a `protocol_mismatch` error and the connection is
 * closed. No capability sniffing.
 *
 * Requests:  {id, verb, params?}
 * Responses: {id, ok:true, result} | {id, ok:false, error:{code, message}}
 * Watch push frames (no id):
 *   {type:"delta", baseSeq, seq, events:[AuditRow…]}  — contiguous: baseSeq
 *     always equals the seq the client last held; anything else IS a gap.
 *   {type:"gap", seq} — the server bounded the batch (or restarted) and the
 *     client must refetch the snapshot (fail-closed cursor).
 */
import type { AuditRow, BeeRow, BeeView, CommandRow, MessageRow, RuntimeRow } from "../../core/src/index.ts";
import type { BootReport } from "./loops.ts";

export const PROTOCOL = "v2/1";
export const DAEMON_VERSION = "2.0.0-wp4";

/** Closed-list, typed errors — never fuzzy (spec 04). */
export const RPC_ERROR_CODES = [
  "bee_not_found",
  "node_stopped",
  "protocol_mismatch",
  "invalid_request",
  /** Verb-specific refusal: the lifecycle graph forbids the transition. */
  "lifecycle_refused",
  /** Verb-specific refusal: the runtime state forbids the operation. */
  "runtime_refused",
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export const RPC_VERBS = [
  // the seven mutations — thin wrappers over store + queue
  "spawn",
  "send",
  "stop",
  "revive",
  "archive",
  "unarchive",
  "delete",
  // reads
  "view",
  "list",
  "mailbox",
  "commands",
  "deployInfo",
  "health",
  // watch
  "watch",
  "snapshot",
] as const;
export type RpcVerb = (typeof RPC_VERBS)[number];

export interface RpcRequest {
  id: number;
  verb: RpcVerb;
  params?: Record<string, unknown>;
}

export interface RpcErrorShape {
  code: RpcErrorCode;
  message: string;
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: RpcErrorShape };

export type WatchFrame =
  | { type: "delta"; baseSeq: number; seq: number; events: AuditRow[] }
  | { type: "gap"; seq: number };

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface SpawnResult {
  beeId: string;
  commandId: number;
}

export interface SendRpcResult {
  messageId: number;
  /** The send_wake enqueued in the same transaction, when one was needed. */
  commandId: number | null;
  unarchived: boolean;
}

export interface MutationResult {
  commandId: number;
}

export interface ViewResult {
  view: BeeView;
  bee: BeeRow | null;
  runtime: RuntimeRow | null;
}

export interface ListResult {
  views: ViewResult[];
}

export interface MailboxResult {
  messages: MessageRow[];
}

export interface CommandsResult {
  commands: CommandRow[];
}

export interface DeployInfoResult {
  protocol: string;
  daemonVersion: string;
  nodeVersion: string;
  pid: number;
  startedAt: number;
  dataDir: string;
  socketPath: string;
  storePath: string;
}

export interface HealthResult {
  protocol: string;
  pid: number;
  startedAt: number;
  uptimeMs: number;
  ticks: number;
  lastTickAt: number | null;
  tickErrors: number;
  stopping: boolean;
  lastBoot: BootReport | null;
  i1Violations: number;
  bees: { total: number; active: number; archived: number };
}

export interface SnapshotResult {
  seq: number;
  views: ViewResult[];
}

export class RpcError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}
