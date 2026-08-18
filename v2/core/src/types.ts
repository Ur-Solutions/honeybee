/**
 * Closed vocabularies and row shapes for the v2 core store.
 * Spec: docs/design/specs/reset-01-core.md — the lists here are CLOSED (contract §4, invariant 4).
 */

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
}

export interface RuntimeRow {
  beeId: string;
  generation: number;
  state: RuntimeState;
  exitCause: ExitCause | null;
  pid: number | null;
  pidStartedAt: number | null;
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
}

export interface MessageRow {
  id: number;
  beeId: string;
  sender: string;
  body: string;
  /** Q2 — reserved for future queue tiers. NOT consulted by ordering logic today. */
  priority: number;
  enqueuedAt: number;
  deliveredAt: number | null;
  deliveredGeneration: number | null;
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

/** A package document (or a local config file) failed validation. */
export class PackageError extends CoreError {}
