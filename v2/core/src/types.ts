/**
 * Closed vocabularies and row shapes for the v2 core store.
 * Spec: docs/design/specs/reset-01-core.md — the lists here are CLOSED (contract §4, invariant 4).
 */
import type { LoginFlowRow } from "./loginFlow.ts";

export const LIFECYCLES = ["active", "archived", "deleted"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/** B2 — exactly four runtime states. */
export const RUNTIME_STATES = ["booting", "running", "idle", "stopped"] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export const EXIT_CAUSES = [
  "clean",
  "crashed",
  "stopped_by_user",
  "stopped_by_system",
  "machine_restart",
] as const;
export type ExitCause = (typeof EXIT_CAUSES)[number];

/** B3 — the closed flag list (contract §4.2). */
export const FLAGS = [
  "auth_needed",
  "resource_blocked",
  "spawn_failed",
  "node_unreachable",
] as const;
export type Flag = (typeof FLAGS)[number];

/** B5 — command verbs. */
export const VERBS = [
  "spawn",
  "send_wake",
  "stop",
  "revive",
  "archive",
  "unarchive",
  "delete",
] as const;
export type Verb = (typeof VERBS)[number];

/** Verbs whose intent is bound to a specific runtime generation (B6 fencing). */
export const RUNTIME_VERBS: readonly Verb[] = ["spawn", "send_wake", "stop", "revive"];

export const COMMAND_STATUSES = ["queued", "running", "done", "failed"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/**
 * B5 — `failed` requires a failure_cause from the closed list. The closed list is the
 * flag list: every terminal command failure maps to exactly one condition flag
 * (contract §4.2 "an error that fits no flag is a software bug").
 */
export type FailureCause = Flag;

/** B2 — allowed runtime transitions: booting → running ⇄ idle → stopped (+ boot crash). */
export const RUNTIME_TRANSITIONS: Readonly<Record<RuntimeState, readonly RuntimeState[]>> = {
  booting: ["running", "stopped"],
  running: ["idle", "stopped"],
  idle: ["running", "stopped"],
  stopped: [], // no transition out of stopped — revival creates generation N+1
};

// ---------------------------------------------------------------------------
// Row shapes (as exposed by the API and by dumpState()/replayAudit()).
// ---------------------------------------------------------------------------

export interface BeeRow {
  id: string;
  name: string;
  agent: string;
  substrate: string;
  cwd: string;
  title: string | null;
  tags: string[];
  sessionLogPath: string | null;
  lifecycle: Lifecycle;
  createdAt: number;
  archivedAt: number | null;
  /** Last time the bee's runtime produced output (canonical fact, recorded by daemon). */
  lastOutputAt: number | null;
  /**
   * v3 — harness-native session/thread id of the bee's conversation (claude
   * `session_id`, codex thread id), recorded from the runtime's booted signal.
   * Revive hands it back to the harness so generation N+1 continues the same
   * conversation (spec 07 §F). Null until a runtime has reported one.
   */
  providerSessionId: string | null;
  /** v3 — per-bee env overrides applied over the agent spec at spawn. */
  env: Record<string, string>;
  /** v3 — provenance: null for v2-born bees; "frozen" for old-world imports. */
  importedFrom: string | null;
  /**
   * v4 — consecutive runtimes that exited (crashed/clean) while still
   * `booting`: the spawn-retry budget (contract §4.2 `spawn_failed`, B5) is
   * ONE budget per bee across wake-driven revives, so a runtime that dies
   * the instant it spawns cannot loop crash → wake → revive unboundedly. The
   * next wake is scheduled on the B5 backoff table (base × 2^(n-1)); at
   * `maxAttempts` the `spawn_failed` flag is set and wakes are suppressed
   * until contrary evidence — a successful boot (booting → running) or an
   * operator `revive` — resets it to 0. A crash AFTER running/idle is not a
   * spawn failure and never counts.
   */
  spawnFailures: number;
  /**
   * v5 — per-bee harness CLI args (e.g. `--model fable --effort high`),
   * layered over the agent spec's args at spawn (daemon resolveSpawnSpec).
   * Null = none. The frozen importer fills it from the old launch argv.
   */
  args: string[] | null;
  /**
   * v6 — the bee that spawned this one (the RPC caller identified itself as
   * a bee: `spawn {parentId}` / `bee.fork`). A soft reference: the parent may
   * be archived (children unaffected) or deleted (children are ORPHANED —
   * this becomes null, audited `bee.orphaned` — never cascaded).
   */
  parentId: string | null;
  /** v6 — provenance: the bee this one was forked from (`bee.fork`); null otherwise. */
  forkedFrom: string | null;
  /**
   * v6 — one-shot fork seed: the SOURCE bee's provider session id the fork's
   * FIRST runtime forks from (claude `--resume <seed> --fork-session`, codex
   * `thread/fork {threadId}`), so the fork continues the source's
   * conversation under a NEW provider session of its own. Consumed (nulled)
   * the moment the fork's runtime reports its own session id — later
   * generations resume that id like any bee. Null for non-forks.
   */
  forkSeed: string | null;
  /**
   * v7 — the account (accounts.id) this bee runs on; null = no account
   * binding (an env-only imported bee, or a harness with no accounts). Set
   * concretely at spawn (`auto` resolves BEFORE createBee and is never
   * stored) and by `bee.swapAccount`. bees.env[HOME_ENV[harness]] carries the
   * derived home path.
   */
  account: string | null;
  /**
   * v10 — short human display id (`CL.a3f2`: harness prefix + hex), minted
   * by the owning node at spawn and UNIQUE per node. The human tier of the
   * resolution ladder (id → handle → name → unique prefix); the UUID `id`
   * stays the only identifier machines pass around. Null only on rows from
   * a pre-v10 store opened read-only (the migration backfills on open).
   */
  handle: string | null;
}

/**
 * v9 — how a runtime left `booting` (null while it has not). 'synthetic':
 * only a driver-minted observation moved it (the readyAtSpawn spawn-event
 * booted) — provisional, proves nothing; a crashed/clean exit from it counts
 * against the bee's spawn-failure budget like an exit during `booting`.
 * 'real': the adapter parsed actual output from the process — the contrary
 * evidence that resets the budget and clears `spawn_failed`.
 */
export type BootEvidence = "synthetic" | "real";

export interface RuntimeRow {
  beeId: string;
  generation: number;
  state: RuntimeState;
  exitCause: ExitCause | null;
  pid: number | null;
  pidStartedAt: number | null;
  bootEvidence: BootEvidence | null;
  startedAt: number;
  updatedAt: number;
}

export interface FlagRow {
  id: number;
  beeId: string;
  flag: Flag;
  detail: string;
  setAt: number;
  clearedAt: number | null;
  /** Provider-declared instant (epoch ms) the block lifts; null = open-ended. */
  resetsAt: number | null;
}

/**
 * Delivery urgency (spec 01 Q2 amendment 2026-08-18) — the intent the old buz
 * tiers expressed as UX, kept as a first-class message attribute:
 *   now  — the agent needs this immediately: interrupt the current turn
 *          (driver.interrupt), then deliver at the resulting accept point.
 *   next — as soon as convenient: the harness's next accept point (default —
 *          today's behavior, unchanged).
 *   idle — when the agent is done: never delivered while the runtime state is
 *          `running`; delivered once it is idle (revive-on-message for stopped
 *          bees is unchanged — urgency never affects WHETHER a wake happens).
 * Urgency governs WHEN a message becomes eligible for delivery; among eligible
 * messages, enqueue order (per-bee FIFO, Q2) wins. It never reorders the queue.
 */
export const MESSAGE_URGENCIES = ["now", "next", "idle"] as const;
export type Urgency = (typeof MESSAGE_URGENCIES)[number];

export interface MessageRow {
  id: number;
  beeId: string;
  sender: string;
  body: string;
  /**
   * Q2 — the reserved tier column, kept for compat; its ROLE is superseded by
   * `urgency` (the amendment resolved what the tiers meant). NOT consulted by
   * ordering or delivery logic.
   */
  priority: number;
  /** v8 — delivery urgency; governs eligibility, never FIFO order (see MESSAGE_URGENCIES). */
  urgency: Urgency;
  enqueuedAt: number;
  deliveredAt: number | null;
  deliveredGeneration: number | null;
}

/** Bee ids are routing identities carried across every RPC and audit surface. */
export const MAX_BEE_ID_BYTES = 256;

/** Default and hard maximum for one node-wide mail history page. */
export const MAIL_HISTORY_DEFAULT_LIMIT = 100;
export const MAIL_HISTORY_MAX_LIMIT = 250;
/** Per-message UTF-8 preview bounds written into the send-time projection. */
export const MAIL_HISTORY_BODY_PREVIEW_BYTES = 16 * 1024;
export const MAIL_HISTORY_SENDER_PREVIEW_BYTES = 1024;
/** Sum of returned preview bodies per page. */
export const MAIL_HISTORY_PAGE_BODY_BUDGET_BYTES = 1024 * 1024;
/** Sum of individually encoded message objects per page, excluding small result framing. */
export const MAIL_HISTORY_PAGE_JSON_BUDGET_BYTES = 2 * 1024 * 1024;

export const MAIL_CANCELLATION_REASONS = ["requested", "bee_deleted"] as const;
export type MailCancellationReason = (typeof MAIL_CANCELLATION_REASONS)[number];

/** Typed admission path for mailbox traffic; consumers must not sniff bodies. */
export const MAIL_ORIGINS = ["mail.send", "spawn.prompt", "legacy.unknown"] as const;
export type MailOrigin = (typeof MAIL_ORIGINS)[number];

/**
 * The durable outcome of one accepted send. A discriminated union prevents a
 * consumer from observing contradictory queued/delivered/canceled fields.
 */
export type MailHistoryLifecycle =
  | { state: "queued" }
  | { state: "delivered"; deliveredAt: number; deliveredGeneration: number }
  | { state: "canceled"; canceledAt: number; reason: MailCancellationReason };

/** One accepted send reconstructed from typed mail audit events, never a raw audit row. */
export interface MailHistoryMessage {
  /** The `mail.enqueued` audit sequence. `beforeSeq` pages against this value. */
  seq: number;
  messageId: number;
  beeId: string;
  sender: string;
  senderTruncated: boolean;
  /** A bounded prefix of the accepted body. */
  body: string;
  bodyTruncated: boolean;
  priority: number;
  /** Current urgency after folding any `mail.expedited` events. */
  urgency: Urgency;
  enqueuedAt: number;
  /** Timestamp of the latest expedite, or null when urgency was never changed. */
  expeditedAt: number | null;
  lifecycle: MailHistoryLifecycle;
}

export interface MailHistoryParams {
  /** Defaults to 100 and is capped at 250. */
  limit?: number;
  /** Exclusive `MailHistoryMessage.seq` cursor for the next older page. */
  beforeSeq?: number;
  /** Optional result `snapshotSeq` to keep later pages on the same audit snapshot. */
  snapshotSeq?: number;
}

export interface MailHistoryResult {
  /** Newest sends first. */
  messages: MailHistoryMessage[];
  /** Pass as `beforeSeq` for the next older page; null means no older send exists. */
  nextBeforeSeq: number | null;
  /** True exactly when another older page exists at this snapshot. */
  hasMore: boolean;
  /** @deprecated Rolling-compatible alias of `hasMore`. */
  truncated: boolean;
  /** Audit high-water used for stable send selection and lifecycle folding. */
  snapshotSeq: number;
}

export interface MailPendingParams {
  /** Defaults to 100 and is capped at 250. */
  limit?: number;
}

/** One undelivered mailbox row with bounded UTF-8 previews. */
export interface MailPendingMessage {
  id: number;
  beeId: string;
  origin: MailOrigin;
  sender: string;
  senderTruncated: boolean;
  body: string;
  bodyTruncated: boolean;
  priority: number;
  urgency: Urgency;
  enqueuedAt: number;
}

export interface MailPendingResult {
  /** Undelivered rows in mailbox FIFO order. */
  messages: MailPendingMessage[];
  /** True when row or byte bounds leave additional pending rows undisclosed. */
  hasMore: boolean;
}

export interface CommandRow {
  id: number;
  verb: Verb;
  beeId: string;
  args: Record<string, unknown>;
  targetGeneration: number | null;
  status: CommandStatus;
  attempts: number;
  nextAttemptAt: number;
  enqueuedAt: number;
  finishedAt: number | null;
  failureCause: FailureCause | null;
  /**
   * Caller-supplied dedup key (spec 06 §4.2 one-key rule): UNIQUE when set;
   * re-enqueueing with the same key returns THIS row instead of a new one.
   * Null for internal enqueues (send_wake, loop policy stops).
   */
  idempotencyKey: string | null;
}

export interface AuditRow {
  seq: number;
  ts: number;
  kind: string;
  beeId: string | null;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// v7 — accounts (spec 08): identity rows, limits snapshots, selection cursor
// ---------------------------------------------------------------------------

export const ACCOUNT_STATUSES = ["ok", "auth_needed", "paused"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Credential-validation evidence for an account (cohort-0 F2): a credential
 * FILE existing is not health. Closed vocabulary, derived — never stored:
 *  - `absent`: no primary credential in the account's vault or home.
 *  - `unverified`: a credential file exists but no validation evidence was
 *    ever recorded (typical after an explicit importExisting account.add).
 *  - `verified`: a completed login/capture or a readable limits probe proved
 *    the credential once worked (a LATER failure shows as status
 *    `auth_needed`, which outranks this for rendering).
 */
export const CREDENTIAL_HEALTHS = ["absent", "unverified", "verified"] as const;
export type CredentialHealth = (typeof CREDENTIAL_HEALTHS)[number];

/**
 * Why a limits snapshot is unreadable. Keep this closed so clients never infer
 * from prose. `refresh_deferred` means the stored token is past expiry but a
 * live runtime owns the rotating refresh chain (HIVE-2), so the daemon stood
 * down; no sign-in is needed and clients must not render it as an auth failure.
 */
export const ACCOUNT_LIMITS_UNREADABLE_REASONS = [
  "unsupported",
  "auth_expired",
  "auth_failed",
  "provider_error",
  "timeout",
  "refresh_deferred",
] as const;
export type AccountLimitsUnreadableReason = (typeof ACCOUNT_LIMITS_UNREADABLE_REASONS)[number];

/** A provider login identity: the WHO. One account = one run-home. */
export interface AccountRow {
  /** `<harness>-<label>` (safe-named, lower-cased). */
  id: string;
  harness: string;
  /** The account's run-home (`~/.hive/homes/<id>` by default); every bee on the account shares it. */
  homePath: string;
  label: string;
  status: AccountStatus;
  /** Operator hint added to the selector's effective weekly load (0 = none). */
  penalty: number;
  lastLoginAt: number | null;
  /** Last rate-limit exhaustion evidence (rotation cool-off); null = never. */
  exhaustedAt: number | null;
  addedAt: number;
  updatedAt: number;
}

/**
 * The latest limits snapshot per account. `readable=false` = the fetch
 * failed (`error` says why); percentages are the provider's used% per
 * window; `*ResetsAt` epoch ms; `*Minutes` the window length (pace).
 */
export interface AccountLimitsRow {
  account: string;
  fetchedAt: number;
  readable: boolean;
  /** Null for readable rows; otherwise the typed class clients render. */
  unreadableReason: AccountLimitsUnreadableReason | null;
  error: string | null;
  plan: string | null;
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null;
  fiveHourMinutes: number | null;
  weeklyPct: number | null;
  weeklyResetsAt: number | null;
  weeklyMinutes: number | null;
  fableWeeklyPct: number | null;
  fableResetsAt: number | null;
  fableMinutes: number | null;
  /** Provider-authored display buckets that do not fit the routing windows. */
  displayWindows: AccountLimitsDisplayWindow[];
}

/** A named provider quota shown to operators but not used as a routing primitive. */
export interface AccountLimitsDisplayWindow {
  key: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes: number | null;
}

/** Per-harness near-tie rotation cursor. */
export interface SelectionCursorRow {
  harness: string;
  lastAccountId: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// v14 — automatic-naming usage (operational telemetry, not replay state)
// ---------------------------------------------------------------------------

export const NAMING_USAGE_STATUSES = ["succeeded", "failed"] as const;
export type NamingUsageStatus = (typeof NAMING_USAGE_STATUSES)[number];

/** One immutable title-generator attempt. Monetary values are integer nano-USD. */
export interface NamingUsageRow {
  id: number;
  /** Soft reference retained after a bee is deleted; null for unscoped/manual calls. */
  beeId: string | null;
  backend: string;
  provider: string;
  model: string;
  status: NamingUsageStatus;
  latencyMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  inputRateNanoUsd: number | null;
  cachedInputRateNanoUsd: number | null;
  cacheWriteRateNanoUsd: number | null;
  outputRateNanoUsd: number | null;
  /** Null when the configured model has no known price. */
  estimatedCostNanoUsd: number | null;
  responseId: string | null;
  requestId: string | null;
  error: string | null;
  recordedAt: number;
}

export interface NamingUsageModelSummary {
  backend: string;
  provider: string;
  model: string;
  requests: number;
  succeeded: number;
  failed: number;
  pricedRequests: number;
  unpricedRequests: number;
  estimatedCostNanoUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  averageLatencyMs: number | null;
  lastRecordedAt: number | null;
}

/** All-time aggregate returned by `naming.usage`; rows remain in SQLite. */
export interface NamingUsageSummary {
  requests: number;
  succeeded: number;
  failed: number;
  pricedRequests: number;
  unpricedRequests: number;
  estimatedCostNanoUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  averageLatencyMs: number | null;
  firstRecordedAt: number | null;
  lastRecordedAt: number | null;
  byModel: NamingUsageModelSummary[];
}

// ---------------------------------------------------------------------------
// v6 — questions (a bee asks the operator) and seals (a bee's structured record)
// ---------------------------------------------------------------------------

export const QUESTION_STATUSES = ["open", "answered"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export interface QuestionRow {
  id: string;
  beeId: string;
  /** The runtime generation that asked (null when the bee had no runtime row — never in practice). */
  generation: number | null;
  text: string;
  /** Suggested answers, when the bee offered a closed set; null = free-form. */
  options: string[] | null;
  status: QuestionStatus;
  answer: string | null;
  askedAt: number;
  answeredAt: number | null;
  /** Who answered (`operator` by default; apiary passes its principal). */
  answeredBy: string | null;
  /** The mailbox message the answer was delivered to the bee as. */
  deliveryMessageId: number | null;
}

export interface SealRow {
  id: string;
  beeId: string;
  /** The runtime generation that sealed. */
  generation: number | null;
  title: string;
  body: string;
  /** Free-form references (branches, commits, urls, paths). */
  refs: string[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// v11 — agent task lists (shared micro-task backlog; mailbox is the delivery path)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["pending", "queued", "in-progress", "done", "blocked", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_ORIGIN_KINDS = ["user", "self", "bee"] as const;
export type TaskOriginKind = (typeof TASK_ORIGIN_KINDS)[number];

export const TASK_TRANSITION_ACTIONS = ["start", "done", "block", "cancel"] as const;
export type TaskTransitionAction = (typeof TASK_TRANSITION_ACTIONS)[number];

/**
 * One micro-task. Bee lists are `bee:<beeId>` (cascade with the bee); shared
 * lists are `shared:<name>` with `beeId` null. Feeding a task sends one
 * mailbox message (urgency idle) and records it on `mailboxMessageId`.
 */
export interface TaskRow {
  id: string;
  list: string;
  beeId: string | null;
  title: string;
  body: string | null;
  /** Opaque structured payload (`{kind, ...}`); stored verbatim. */
  context: Record<string, unknown> | null;
  originKind: TaskOriginKind;
  originSender: string;
  auto: boolean;
  status: TaskStatus;
  claimedBy: string | null;
  order: number;
  questId: string | null;
  mailboxMessageId: number | null;
  fedAt: number | null;
  stalledAt: number | null;
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

/** Per-bee auto-supply config. Missing row = off / limit 5 / feeds 0 / not paused. */
export interface TaskSupplyRow {
  beeId: string;
  on: boolean;
  limit: number;
  feeds: number;
  paused: boolean;
}

/** B8 — the derived read model. Computed, never stored. */
export interface BeeView {
  beeId: string;
  exists: boolean;
  lifecycle: Lifecycle | null;
  generation: number | null;
  runtimeState: RuntimeState | null;
  exitCause: ExitCause | null;
  working: boolean;
  waitingForYou: boolean;
  /** Raw output-recency fact; clients compare against their own read cursor. */
  lastOutputAt: number | null;
  reachable: boolean;
  blocked: boolean;
  flags: Flag[];
}

// ---------------------------------------------------------------------------
// Templates + tracks — hive concepts (spec 06 §1.4.1 ownership table).
// "Rows are truth, files are packages": these tables are the registry; the
// package format in packages.ts is the portable artifact.
// ---------------------------------------------------------------------------

/** Scope is data on the row (spec 06 §1.4.1). */
export const SCOPES = ["personal", "team", "repo"] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * Where a row came from. Closed prefixes:
 *   `api`               — put through the RPC/CLI verbs
 *   `package:<path>`    — imported from a package document (path or `rpc`)
 *   `local-config`      — imported from the local config source (~/.hive/*)
 */
export type RowSource = "api" | "local-config" | `package:${string}`;

/** Where a template-spawned bee runs: caller's cwd, or a fixed absolute path. */
export const CWD_POLICIES = ["caller", "fixed"] as const;
export type CwdPolicy = (typeof CWD_POLICIES)[number];

export interface TemplateRow {
  id: string;
  name: string;
  scope: Scope;
  source: RowSource;
  description: string | null;
  /** Agent key (old system: `bee`) — resolved against the node's agent table at spawn. */
  agent: string;
  /** Substrate default; null = node default. */
  substrate: string | null;
  /** Model / effort defaults handed to the harness adapter; null = harness default. */
  model: string | null;
  effort: string | null;
  /** Extra harness CLI args, pass-through. */
  args: string[];
  /** The task instruction the spawned bee receives. */
  prompt: string;
  /** Custom preamble text (null = the node's default preamble when enabled). */
  preamble: string | null;
  /** false = spawn with no preamble at all (old system: `preamble: false`). */
  preambleEnabled: boolean;
  cwdPolicy: CwdPolicy;
  /** Absolute path when cwdPolicy = fixed; null otherwise. */
  cwd: string | null;
  env: Record<string, string>;
  /** Credential/account selector (old system field, kept faithful; null = default). */
  account: string | null;
  /** Skip-permissions mode for the harness (old system: `yolo`). */
  yolo: boolean;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export const TRACK_STEP_STATUSES = ["pending", "running", "done", "skipped"] as const;
export type TrackStepStatus = (typeof TRACK_STEP_STATUSES)[number];

/** One ordered step of a track: references a template by stable id, or is free-form. */
export interface TrackStep {
  id: string;
  name: string;
  /** Free-form step kind (old system node type: action|orchestrate|review|ask|deploy); default `action`. */
  kind: string;
  /** Stable template id this step spawns from; null = free-form. Not validated at import (loosely coupled). */
  templateId: string | null;
  instruction: string | null;
  note: string | null;
  status: TrackStepStatus;
}

export interface TrackRow {
  id: string;
  name: string;
  scope: Scope;
  source: RowSource;
  description: string | null;
  steps: TrackStep[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

/** Deterministic full-store snapshot (audit excluded); comparison target for replay. */
export interface StateDump {
  bees: BeeRow[];
  runtimes: RuntimeRow[];
  flags: FlagRow[];
  mailbox: MessageRow[];
  commands: CommandRow[];
  templates: TemplateRow[];
  tracks: TrackRow[];
  /** v6 */
  questions: QuestionRow[];
  seals: SealRow[];
  /** v7 */
  accounts: AccountRow[];
  accountLimits: AccountLimitsRow[];
  selectionCursors: SelectionCursorRow[];
  /** v11 */
  tasks: TaskRow[];
  taskSupply: TaskSupplyRow[];
  /** v16 */
  loginFlows: LoginFlowRow[];
}

// ---------------------------------------------------------------------------
// Errors — all core errors derive from CoreError so callers can distinguish
// contract violations (throw) from bugs.
// ---------------------------------------------------------------------------

export class CoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class BeeNotFoundError extends CoreError {
  constructor(beeId: string) {
    super(`bee not found: ${beeId} (never existed, or deleted)`);
  }
}

export class IllegalTransitionError extends CoreError {}

export class UnknownFlagError extends CoreError {
  constructor(flag: string) {
    super(`unknown flag: ${flag} — the flag list is closed (${FLAGS.join(", ")})`);
  }
}

export class UnknownVerbError extends CoreError {
  constructor(verb: string) {
    super(`unknown verb: ${verb} — the verb list is closed (${VERBS.join(", ")})`);
  }
}

/** v8 — send() with an urgency outside the closed list throws (mirrors UnknownFlagError). */
export class UnknownUrgencyError extends CoreError {
  constructor(urgency: string) {
    super(`unknown urgency: ${urgency} — the urgency list is closed (${MESSAGE_URGENCIES.join(", ")})`);
  }
}

export class UnknownFailureCauseError extends CoreError {
  constructor(cause: string) {
    super(`unknown failure cause: ${cause} — must be one of the closed flag list (${FLAGS.join(", ")})`);
  }
}

export class SecondWriterError extends CoreError {
  constructor(path: string, inner: unknown) {
    super(
      `core store at ${path} is already held by another writer (B9 single-writer); ` +
        `underlying: ${inner instanceof Error ? inner.message : String(inner)}`,
    );
  }
}

export class CommandProtocolError extends CoreError {}

/**
 * The store file is stamped with a schema version this code cannot open:
 * `schema_newer` = downgrade (a newer daemon wrote it — refuse, never guess);
 * `schema_migration_required` = an older version with no migration path in
 * this code (no silent bumps — migrations are explicit, spec 06 §6).
 */
export class SchemaVersionError extends CoreError {
  readonly kind: "schema_newer" | "schema_migration_required";

  constructor(kind: "schema_newer" | "schema_migration_required", message: string) {
    super(message);
    this.kind = kind;
  }
}

export class TemplateNotFoundError extends CoreError {
  constructor(id: string) {
    super(`template not found: ${id}`);
  }
}

export class TrackNotFoundError extends CoreError {
  constructor(id: string) {
    super(`track not found: ${id}`);
  }
}

/** A put/import would leave two rows with the same (scope, name) — names are unique per scope. */
export class NameConflictError extends CoreError {}

export class QuestionNotFoundError extends CoreError {
  constructor(id: string) {
    super(`question not found: ${id}`);
  }
}

/** Answering a question that is no longer open (already answered). */
export class QuestionNotOpenError extends CoreError {}

export class SealNotFoundError extends CoreError {
  constructor(id: string) {
    super(`seal not found: ${id}`);
  }
}

export class TaskNotFoundError extends CoreError {
  constructor(id: string) {
    super(`task not found: ${id}`);
  }
}

/** A package document (or a local config file) failed validation. */
export class PackageError extends CoreError {}

/** v7 — account lookups. */
export class AccountNotFoundError extends CoreError {
  constructor(id: string) {
    super(`account not found: ${id}`);
  }
}

/** v7 — `account.remove` while bees still reference the account. */
export class AccountReferencedError extends CoreError {
  readonly beeIds: string[];

  constructor(id: string, beeIds: string[]) {
    super(`account ${id} is referenced by ${beeIds.length} bee(s): ${beeIds.join(", ")} — swap or delete them first`);
    this.beeIds = beeIds;
  }
}
