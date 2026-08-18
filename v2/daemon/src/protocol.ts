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
import type {
  AuditRow,
  BeeRow,
  BeeView,
  CommandRow,
  CommandStatus,
  FrozenImportReport,
  LocalConfigImportReport,
  MessageRow,
  MirrorQuestionRow,
  MirrorSealRow,
  MirrorTemplateRow,
  MirrorTrackRow,
  RuntimeRow,
  TemplatePackage,
  TrackPackage,
} from "../../core/src/index.ts";
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
  /** Registry refusals (WP6a): missing rows and per-scope name collisions. */
  "template_not_found",
  "track_not_found",
  "name_conflict",
  /** A package document failed header/field validation. */
  "invalid_package",
  /** v6 (additive): question / seal lookups. */
  "question_not_found",
  "seal_not_found",
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
  // templates + tracks + packages (WP6a, spec 06 §1.4.1)
  "template.list",
  "template.get",
  "template.put",
  "template.delete",
  "template.export",
  "template.import",
  "track.list",
  "track.get",
  "track.put",
  "track.delete",
  "track.export",
  "track.import",
  "packages.importLocalConfig",
  // WP7 (spec 07 B4): import the operator's active old-world bees from a frozen store
  "import.fromFrozen",
  // schema v5: replace a bee's per-bee spawn args (takes effect on the next runtime)
  "bee.setArgs",
  // WP6 §5 cell exit path (spec 05 points 4 + 6): the WP5 driver primitives as verbs
  "cell.capture",
  "cell.remove",
  // v6 pre-flip verb set (additive to v2/1): rename, tag, interrupt, fork,
  // parenting read, questions, seals. `spawn` also takes `parentId?`.
  "bee.rename",
  "bee.tag",
  "bee.interrupt",
  "bee.fork",
  "bee.children",
  "question.ask",
  "question.answer",
  "question.list",
  "seal.create",
  "seal.list",
  "seal.get",
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

/**
 * One-key idempotency (spec 06 §4.2): every mutation verb accepts an optional
 * caller-supplied `idempotencyKey` param. A key already seen answers with the
 * ORIGINAL recorded result plus these replay markers instead of executing
 * again — `deduped: true`, and (for command-backed mutations) `status` = the
 * original command's CURRENT status, so a replay after settle returns the
 * settled outcome, not a new command. Fresh executions omit both fields.
 */
export interface DedupMarkers {
  deduped?: boolean;
  status?: CommandStatus;
}

export interface SpawnResult extends DedupMarkers {
  beeId: string;
  commandId: number;
}

// ---------------------------------------------------------------------------
// v6 pre-flip verbs — shapes. All mutations take the optional idempotencyKey.
// ---------------------------------------------------------------------------

/**
 * `bee.rename {beeId, name}` — names follow createBee's rules (non-empty,
 * NOT unique: the id is the identity). `applied:false` = already that name.
 * Audit `bee.renamed`.
 */
export interface RenameResult extends DedupMarkers {
  bee: BeeRow;
  applied: boolean;
}

/**
 * `bee.tag {beeId, add?: string[], remove?: string[]}` — remove first, then
 * add; order preserved; duplicates collapse. Apiary uses `apiary:workspace=…`
 * tags for workspace membership, so tag-after-spawn = moving a bee between
 * workspaces. Audit `bee.tagged` (payload carries the full new list).
 */
export interface TagResult extends DedupMarkers {
  bee: BeeRow;
  applied: boolean;
  added: string[];
  removed: string[];
}

/**
 * `bee.interrupt {beeId}` — stop the CURRENT TURN without ending the runtime
 * (claude stream-json control_request interrupt; codex turn/interrupt; tmux
 * C-c). `interrupted:false` + `reason` is a RESULT, never an error: `idle`
 * (nothing to interrupt), `no_process` (no live runtime), `not_ready`
 * (booting / dying / re-adopted without a channel), `unsupported` (harness
 * has no in-band interrupt). The turn_ended that follows a successful
 * interrupt is an ordinary observation. Audit `bee.interrupted` (informational).
 */
export interface InterruptResult extends DedupMarkers {
  beeId: string;
  generation: number | null;
  interrupted: boolean;
  reason?: "idle" | "no_process" | "not_ready" | "unsupported";
}

/**
 * `bee.fork {beeId, name?, prompt?, id?}` — a NEW bee with the source's
 * agent / substrate / cwd / args / env / title / tags, `parentId` = source,
 * `forkedFrom` = source, and provider-session continuity: the fork's FIRST
 * runtime forks the source's conversation (`forkSeed` = the source's provider
 * session id → claude `--resume <seed> --fork-session`, codex `thread/fork`)
 * into a NEW session of its own, which the daemon records on the fork when
 * its runtime reports it (the seed is consumed then). A `spawn` command is
 * enqueued (`commandId`); `prompt` is enqueued as the fork's first mailbox
 * message (`messageId`). Cell-substrate bees cannot be forked
 * (`invalid_request` — the cell checkout is single-tenant). Audit:
 * `bee.created` (+ `bee.forked`, informational).
 */
export interface ForkResult extends DedupMarkers {
  beeId: string;
  commandId: number;
  forkedFrom: string;
  /** The source's provider session id the fork will fork from; null when the source had none (fork boots fresh). */
  forkSeed: string | null;
  messageId: number | null;
  bee: BeeRow;
}

/** `bee.children {beeId}` — bees whose parentId is this bee (any lifecycle), as view results. */
export interface ChildrenResult {
  beeId: string;
  children: ViewResult[];
}

/**
 * `question.ask {beeId, text, options?}` — a bee asks the operator (called
 * from the bee's runtime: `hive v2 ask "…"` reads HIVE_BEE_ID). Row is open
 * until `question.answer`. Audit `question.asked`.
 */
export interface QuestionAskResult extends DedupMarkers {
  question: MirrorQuestionRow;
}

/**
 * `question.answer {questionId, answer, answeredBy?}` — marks answered AND
 * delivers the answer to the bee as an ordinary mailbox message prefixed
 * `[answer to question <id>]` (send()'s wake/unarchive rules apply). A
 * non-open question is `invalid_request`. Audit `question.answered`.
 */
export interface QuestionAnswerResult extends DedupMarkers {
  question: MirrorQuestionRow;
  messageId: number;
  /** The send_wake enqueued for the delivery, when one was needed. */
  commandId: number | null;
  unarchived: boolean;
}

/** `question.list {beeId?, open?}` */
export interface QuestionListResult {
  questions: MirrorQuestionRow[];
}

/**
 * `seal.create {beeId, title, body, refs?}` — metadata only, tied to the
 * bee's current generation. Audit `seal.created`.
 */
export interface SealCreateResult extends DedupMarkers {
  seal: MirrorSealRow;
}

/** `seal.list {beeId?}` */
export interface SealListResult {
  seals: MirrorSealRow[];
}

/** `seal.get {sealId}` — `seal_not_found` when absent. */
export interface SealGetResult {
  seal: MirrorSealRow;
}

/**
 * The substrates the daemon can spawn onto (contract §1: tmux | hsr | cell;
 * tmux is not wired into the daemon yet). `spawn` takes `substrate?`
 * (default `hsr`) and, for `cell`, a `cell` object (SpawnCellParams).
 * v6: `spawn` also takes `parentId?` — the calling bee (the CLI fills it from
 * HIVE_BEE_ID; apiary passes it explicitly). The parent must exist
 * (`bee_not_found` otherwise); the child's runtime env is stamped
 * HIVE_BEE / HIVE_BEE_ID / HIVE_PARENT.
 */
export const SPAWN_SUBSTRATES = ["hsr", "cell"] as const;
export type SpawnSubstrate = (typeof SPAWN_SUBSTRATES)[number];

/**
 * `spawn { substrate: "cell", cell: {…} }` — the cell half of a cell spawn.
 * The daemon reserves the cell (seed `box/cell.json`) in the same call and
 * records the bee with `substrate = "cell"` and `cwd` = the space checkout
 * (`<cells-root>/<wrapper>/<repo>-space-<id>`); the first runtime start
 * provisions against that ledger. `cwd` in the spawn params is ignored for
 * cell spawns (the cell owns the cwd).
 */
export interface SpawnCellParams {
  /** The origin repository (working-tree root) the cell is provisioned from. */
  originRepo: string;
  /** Commit-ish to materialize; default = the origin's HEAD. Resolved to a full sha at spawn. */
  sha?: string;
  /**
   * Warm artifact dirs (A5, CoW-only): `true` = the node's per-repo list for
   * this origin (`cells.warm[originRepo]`), `false`/absent = cold, or an
   * explicit list of working-tree-relative dirs.
   */
  warm?: boolean | string[];
  /** Per-cell sandbox override (A4); absent = node-kind default / node-wide override. */
  sandbox?: boolean;
}

/**
 * `bee.setArgs` (schema v5). Params: `{ beeId, args: string[] | null }` —
 * null clears. Bee-scoped; the CURRENT runtime is untouched (stop/revive to
 * apply). `applied:false` = the value was already exactly that.
 * `spawn` also accepts `args?: string[]` (the bee's initial per-bee args) and
 * `revive` accepts `args?: string[] | null` (replace them as the revive runs).
 */
export interface SetArgsResult extends DedupMarkers {
  bee: BeeRow;
  applied: boolean;
}

export interface SendRpcResult extends DedupMarkers {
  messageId: number;
  /** The send_wake enqueued in the same transaction, when one was needed. */
  commandId: number | null;
  unarchived: boolean;
}

export interface MutationResult extends DedupMarkers {
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
  /** Mirror-shaped registry rows (WP6a): store rows verbatim, snapshot-consistent with `seq`. */
  templates: MirrorTemplateRow[];
  tracks: MirrorTrackRow[];
  /** v6 (additive): questions + seals, store rows verbatim, snapshot-consistent with `seq`. */
  questions: MirrorQuestionRow[];
  seals: MirrorSealRow[];
}

// ---------------------------------------------------------------------------
// Template / track / package verb shapes (WP6a)
// ---------------------------------------------------------------------------

export interface TemplateListResult {
  templates: MirrorTemplateRow[];
}

export interface TemplateGetResult {
  template: MirrorTemplateRow;
}

export interface TemplatePutResult extends DedupMarkers {
  template: MirrorTemplateRow;
  outcome: "created" | "updated" | "unchanged";
}

export interface TemplateDeleteResult extends DedupMarkers {
  template: MirrorTemplateRow;
}

export interface TemplateExportResult {
  /** The parsed package document. */
  package: TemplatePackage;
  /** Canonical serialized text (what belongs in a file, byte-stable). */
  text: string;
}

export interface TemplateImportResult extends DedupMarkers {
  template: MirrorTemplateRow;
  outcome: "created" | "updated" | "unchanged";
}

export interface TrackListResult {
  tracks: MirrorTrackRow[];
}

export interface TrackGetResult {
  track: MirrorTrackRow;
}

export interface TrackPutResult extends DedupMarkers {
  track: MirrorTrackRow;
  outcome: "created" | "updated" | "unchanged";
}

export interface TrackDeleteResult extends DedupMarkers {
  track: MirrorTrackRow;
}

export interface TrackExportResult {
  package: TrackPackage;
  text: string;
}

export interface TrackImportResult extends DedupMarkers {
  track: MirrorTrackRow;
  outcome: "created" | "updated" | "unchanged";
}

export type ImportLocalConfigResult = LocalConfigImportReport & DedupMarkers;

/**
 * `import.fromFrozen` (WP7). Params: `{ root?: string, dryRun?: boolean,
 * force?: boolean }` — root defaults to the node's old-world store (~/.hive).
 * Result is core's FrozenImportReport verbatim: `applied:false` + `refusal`
 * when the FROZEN marker is missing or the preflight found live old-world
 * runtimes (never an RPC error — the report IS the answer).
 */
export type ImportFromFrozenResult = FrozenImportReport & DedupMarkers;

// ---------------------------------------------------------------------------
// Cell verb shapes (WP6 §5.1 / spec 05 points 4 + 6)
// ---------------------------------------------------------------------------

/**
 * `cell.capture` — params `{ beeId, targetBranch, mode: "merge"|"rebase",
 * idempotencyKey? }`. Result = the driver's CaptureReport verbatim (plus the
 * dedup markers): refusals (`target_checked_out` | `target_moved` |
 * `no_cell_head`) and conflicts are RESULTS, never `ok:false` errors, so a
 * replayed key returns the same report. A failed land leaves the origin's
 * ref set bit-identical (A1). Errors: `bee_not_found`; `invalid_request`
 * for a bee that is not on the cell substrate / a bad mode.
 */
export type CellCaptureMode = "merge" | "rebase";

/**
 * Cell results carry their OWN `status` (the report outcome), so they take
 * only the `deduped` replay marker — withIdempotency never overlays the
 * command status onto a result that already has a status of its own.
 */
export interface CellDedupMarker {
  deduped?: boolean;
}

/** `cell.capture` params. */
export interface CellCaptureParams {
  beeId: string;
  /** Branch in the origin to land onto (created if absent). */
  targetBranch: string;
  mode: CellCaptureMode;
  idempotencyKey?: string;
}

export interface CellCaptureResult extends CellDedupMarker {
  status: "landed" | "nothing_to_capture" | "conflict" | "refused";
  targetBranch: string;
  mode: CellCaptureMode;
  /** The cell HEAD that was captured. */
  cellHead: string | null;
  /** The target tip the operation started from (null = branch created). */
  baseTarget: string | null;
  /** The commit the target branch now points at (landed only). */
  resultSha: string | null;
  /** Conflicted paths (conflict only) — staged for the operator, never auto-resolved. */
  conflicts: string[];
  /** Refusal reason (refused only). */
  reason: "target_checked_out" | "target_moved" | "no_cell_head" | null;
}

/** The driver's DirtyReport verbatim (A2 — the three causes). */
export interface CellDirtyReport {
  dirty: boolean;
  /** Uncommitted working-tree changes in the space. */
  uncommitted: boolean;
  /** Cell HEAD commits the origin repo does not contain. */
  unpushed: boolean;
  /** The origin could not be consulted (missing/moved) — treated as dirty. */
  originUnknown: boolean;
}

/**
 * `cell.remove` — params `{ beeId, force?, idempotencyKey? }`. `deleted` =
 * the cell directory is gone AND the bee's lifecycle `delete` was enqueued
 * in the same call (`commandId`); `refused` = dirty without force (report
 * carries the causes; nothing changed; `commandId` null); `absent` = no
 * cell on disk (bee delete still enqueued). A bee with a live runtime is
 * `runtime_refused` (stop it first); a non-cell bee is `invalid_request`.
 */
/** `cell.remove` params. `force` = the `--force` equivalent (A2). */
export interface CellRemoveParams {
  beeId: string;
  force?: boolean;
  idempotencyKey?: string;
}

export interface CellRemoveResult extends CellDedupMarker {
  status: "deleted" | "refused" | "absent";
  forced: boolean;
  report: CellDirtyReport | null;
  /** The lifecycle delete command (deleted | absent). */
  commandId: number | null;
}

export class RpcError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}
