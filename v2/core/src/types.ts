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
  /** Last time the operator read the bee's output (drives B8 waiting_for_you on stopped). */
  outputReadAt: number | null;
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
  reachable: boolean;
  blocked: boolean;
  flags: Flag[];
}

/** Deterministic full-store snapshot (audit excluded); comparison target for replay. */
export interface StateDump {
  bees: BeeRow[];
  runtimes: RuntimeRow[];
  flags: FlagRow[];
  mailbox: MessageRow[];
  commands: CommandRow[];
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
