/**
 * The v2 core store — the single serialized write API (B9).
 *
 * One SQLite database per node, WAL journal, EXCLUSIVE locking mode: this process's
 * connection is the only writer (and, under WAL+EXCLUSIVE, the only reader) for the
 * lifetime of the handle. A second `openCoreStore` on the same path fails loudly.
 *
 * Every write is transactional and appends audit rows in the same transaction (test 13:
 * replaying the audit log reproduces the exact table state — see audit.ts).
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  BeeNotFoundError,
  CommandProtocolError,
  CoreError,
  EXIT_CAUSES,
  FLAGS,
  IllegalTransitionError,
  RUNTIME_TRANSITIONS,
  RUNTIME_VERBS,
  SecondWriterError,
  MESSAGE_URGENCIES,
  UnknownFailureCauseError,
  UnknownFlagError,
  UnknownUrgencyError,
  UnknownVerbError,
  VERBS,
  type AccountLimitsDisplayWindow,
  type AccountLimitsRow,
  type AccountLimitsUnreadableReason,
  type AccountRow,
  type AccountStatus,
  type AuditRow,
  type BeeRow,
  type BeeView,
  type CommandRow,
  type ExitCause,
  type FailureCause,
  type Flag,
  type FlagRow,
  type MessageRow,
  NAMING_USAGE_STATUSES,
  type NamingUsageRow,
  type NamingUsageStatus,
  type NamingUsageSummary,
  type QuestionRow,
  type RuntimeRow,
  type RuntimeState,
  type SealRow,
  type SelectionCursorRow,
  type StateDump,
  type TemplateRow,
  type TrackRow,
  type Urgency,
  type Verb,
  ACCOUNT_STATUSES,
  AccountNotFoundError,
  AccountReferencedError,
  NameConflictError,
  QuestionNotFoundError,
  QuestionNotOpenError,
  SchemaVersionError,
  SealNotFoundError,
  TaskNotFoundError,
  TemplateNotFoundError,
  TrackNotFoundError,
  type TaskRow,
  type TaskStatus,
  type TaskSupplyRow,
  type TaskTransitionAction,
} from "./types.ts";
import {
  beeTaskList,
  buildTaskFeedBody,
  CLOSING_TASK_ACTIONS,
  DEFAULT_TASK_SUPPLY_LIMIT,
  defaultTaskSupply,
  evaluateSupplyGate,
  formatTaskList,
  MAX_TASK_TITLE_LENGTH,
  normalizeSupplyLimit,
  ORDER_STEP,
  parseTaskContext,
  parseTaskListRef,
  resolveTaskAuto,
  TASK_ID_PREFIX,
  TASK_SUPPLY_SENDER_NAME,
  TASK_TRANSITIONS,
} from "./tasks.ts";
import { BEES_ADDITIVE_COLUMNS, HANDLE_INDEX_SQL, IDEMPOTENCY_INDEX_SQL, MAILBOX_ADDITIVE_COLUMNS, RUNTIMES_ADDITIVE_COLUMNS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";
import { deriveBeeView } from "./view.ts";
import {
  fieldsEqual,
  normalizeTemplate,
  normalizeTrack,
  type NormalizeOptions,
  type TemplateFields,
  type TrackFields,
} from "./registry.ts";

export interface CoreStoreOptions {
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Injectable randomness (0..1) for deterministic handle minting in tests. */
  random?: () => number;
  /**
   * B5 bounded retries: attempts allowed before a command settles `failed`.
   * Also the spawn-failure budget: consecutive boot failures per bee before
   * `spawn_failed` is set and wake-driven revives stop. Default 5.
   */
  maxAttempts?: number;
  /**
   * B5 backoff base: next_attempt_at = now + base * 2^(attempts-1). The same
   * table schedules the next wake after a boot failure. Default 30s.
   */
  backoffBaseMs?: number;
  /**
   * Retention bound for the rpc_idempotency table (spec 06 §4.2): the newest N
   * recorded mutation results are kept; the oldest beyond N are evicted on
   * insert. Default 10 000.
   */
  maxRpcIdempotencyRows?: number;
  /**
   * Test-only: keep WAL + EXCLUSIVE (B9 / second-writer) but skip fsync and
   * keep temp/pager in memory. Crash/reopen in the same process still works;
   * an OS crash is allowed to lose the file. Production never sets this.
   */
  ephemeral?: boolean;
}

export interface CreateBeeInput {
  /** Known process identity at spawn time, so a daemon restart mid-boot can re-adopt (WP2 finding). */
  proc?: { pid: number; pidStartedAt: number };
  id?: string;
  name: string;
  agent: string;
  substrate: string;
  cwd: string;
  title?: string;
  tags?: string[];
  sessionLogPath?: string;
  /** v3 — a known harness session/thread id to resume on the first runtime (imports). */
  providerSessionId?: string;
  /** v3 — per-bee env overrides applied over the agent spec at spawn. */
  env?: Record<string, string>;
  /** v3 — provenance marker; null/absent for v2-born bees. */
  importedFrom?: string;
  /** v5 — per-bee harness CLI args layered over the agent spec at spawn; null/absent = none. */
  args?: string[] | null;
  /** v6 — the spawning bee (soft reference); absent = operator/apiary-spawned root. */
  parentId?: string | null;
  /** v6 — fork provenance: the source bee id. */
  forkedFrom?: string | null;
  /** v6 — one-shot fork seed: the source's provider session id to fork from on the first runtime. */
  forkSeed?: string | null;
  /** v7 — the account this bee runs on (must exist; the daemon resolves `auto` before this). */
  account?: string | null;
  /**
   * v10 — explicit display handle (importers preserving an old pretty id).
   * Absent = the store mints one (`CL.a3f2`: harness prefix + hex, unique
   * per node). Must be unique; a taken handle is a loud CoreError.
   */
  handle?: string;
  /**
   * Creation timestamp override (epoch ms) — importers preserve the original
   * record's creation time. Defaults to the store clock.
   */
  createdAt?: number;
}

/** One authoritative, internally consistent bee/read-model row for list RPCs. */
export interface BeeViewRow {
  bee: BeeRow;
  runtime: RuntimeRow | null;
  view: BeeView;
}

/** `tagBee` outcome: the row after the edit plus what actually changed. */
export interface TagResult {
  bee: BeeRow;
  applied: boolean;
  added: string[];
  removed: string[];
}

/** `askQuestion` input. */
export interface AskQuestionInput {
  id?: string;
  text: string;
  options?: string[] | null;
}

/** `answerQuestion` outcome: the answered row + the mailbox delivery it produced. */
export interface AnswerResult {
  question: QuestionRow;
  send: SendResult;
}

/** v7 — `createAccount` input. */
export interface CreateAccountInput {
  id: string;
  harness: string;
  homePath: string;
  label: string;
  status?: AccountStatus;
  penalty?: number;
  lastLoginAt?: number | null;
  /** Registration timestamp override (the importer preserves the old registry's addedAt). */
  addedAt?: number;
}

/** v7 — `putAccountLimits` input (the fetcher's parsed snapshot). */
export interface PutAccountLimitsInput {
  readable: boolean;
  unreadableReason?: AccountLimitsUnreadableReason | null;
  error?: string | null;
  plan?: string | null;
  fiveHour?: { usedPercent: number; resetsAt?: number | null; windowMinutes?: number | null } | null;
  weekly?: { usedPercent: number; resetsAt?: number | null; windowMinutes?: number | null } | null;
  fableWeekly?: { usedPercent: number; resetsAt?: number | null; windowMinutes?: number | null } | null;
  /** Provider-authored display buckets; standard windows above remain routing truth. */
  displayWindows?: Array<{
    key: string;
    label: string;
    usedPercent: number;
    resetsAt?: number | null;
    windowMinutes?: number | null;
  }>;
  /** Snapshot time override; defaults to the store clock. */
  fetchedAt?: number;
}

/** v14 — one immutable title-generator attempt written to naming_usage. */
export interface RecordNamingUsageInput {
  beeId?: string | null;
  backend: string;
  provider: string;
  model: string;
  status: NamingUsageStatus;
  latencyMs: number;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  inputRateNanoUsd?: number | null;
  cachedInputRateNanoUsd?: number | null;
  cacheWriteRateNanoUsd?: number | null;
  outputRateNanoUsd?: number | null;
  estimatedCostNanoUsd?: number | null;
  responseId?: string | null;
  requestId?: string | null;
  error?: string | null;
  recordedAt?: number;
}

/** `createSeal` input. */
export interface CreateSealInput {
  id?: string;
  title: string;
  body: string;
  refs?: string[];
}

/** `addTask` input. */
export interface AddTaskInput {
  /** `bee:<beeId>` or `shared:<name>`. */
  list: string;
  title: string;
  body?: string | null;
  context?: Record<string, unknown> | null;
  originKind: TaskRow["originKind"];
  originSender: string;
  autoRequested?: boolean;
  questId?: string | null;
  id?: string;
}

export interface TransitionTaskInput {
  reason?: string;
}

export interface EditTaskInput {
  title?: string;
  body?: string | null;
  auto?: boolean;
}

export interface SetTaskSupplyInput {
  on?: boolean;
  limit?: number;
}

export interface SendResult {
  message: MessageRow;
  /**
   * The send_wake enqueued in the same transaction when no live runtime
   * existed (B4/B5) — or the already-pending one. Null when a runtime is live,
   * or when the bee carries `spawn_failed` (the wake is suppressed: the bee is
   * visibly blocked until contrary evidence or an operator revive; the mail
   * stays durable and is delivered by the next live runtime).
   */
  wakeCommand: CommandRow | null;
  /** True when the send auto-unarchived an archived bee (Q3). */
  unarchived: boolean;
}

/** Outcome of a wake request (send() inline, or the daemon's sweeps). */
export interface WakeResult {
  /** The send_wake now pending for the bee (new or already there); null when none. */
  command: CommandRow | null;
  /**
   * enqueued   — a new send_wake was enqueued (possibly deferred: see nextAttemptAt)
   * pending    — an identical wake was already queued/running for this generation
   * live       — a runtime is live; nothing to wake
   * no_mail    — nothing undelivered (enqueueWake only)
   * suppressed — `spawn_failed` is set: visibly blocked, no wake until an
   *              operator revive or contrary evidence clears it
   */
  outcome: "enqueued" | "pending" | "live" | "no_mail" | "suppressed";
}

export interface DeleteResult {
  beeId: string;
  /** Path of the session log file (outside the DB) the caller must remove (Q1). */
  sessionLogPath: string | null;
  /** Pid of a non-stopped runtime at delete time, for the daemon to reap. */
  livePid: number | null;
  /** Pending (queued/running) commands settled as moot by the delete. */
  settledCommandIds: number[];
  /** v6 — children whose parent_id was nulled (orphaned, never cascaded). */
  orphanedChildIds: string[];
}

export interface ReconcileResult {
  /** Runtimes transitioned to stopped(machine_restart). NEVER a failed state (B7). */
  stopped: Array<{ beeId: string; generation: number }>;
  /** Surviving runtimes re-adopted by pid + pid_started_at match. */
  adopted: Array<{ beeId: string; generation: number; pid: number }>;
  /** Commands reverted running → queued at boot (B5); requeued by open(), reported here. */
  requeuedCommandIds: number[];
}

export interface LivePid {
  pid: number;
  startedAt: number;
}

/** Outcome of an idempotent put/import: one row, created / updated / left alone. */
export type PutOutcome = "created" | "updated" | "unchanged";

/**
 * enqueueCommand's result (spec 06 §4.2): the command row itself, plus whether
 * the caller-supplied idempotencyKey matched an EXISTING row (`deduped: true`
 * = the returned row is the original command at its CURRENT status — queued,
 * running, or already settled — and nothing new was enqueued).
 */
export interface EnqueuedCommand extends CommandRow {
  deduped: boolean;
}

/** A recorded RPC mutation result (the rpc_idempotency table). */
export interface RpcIdempotencyRecord {
  key: string;
  verb: string;
  /** The command the mutation enqueued, when it enqueued one. */
  commandId: number | null;
  /** The result exactly as first returned (JSON round-tripped). */
  result: unknown;
  createdAt: number;
}

export interface PutTemplateInput extends NormalizeOptions {
  /** Stable id to match/create; absent = match by (scope, name), else mint one. */
  id?: string;
  /** Raw template fields — validated by registry.normalizeTemplate. */
  fields: unknown;
}

export interface PutTrackInput extends NormalizeOptions {
  id?: string;
  fields: unknown;
}

const LIVE_STATES: readonly RuntimeState[] = ["booting", "running", "idle"];

type Row = Record<string, unknown>;

/**
 * v10 — pretty handle shape: harness prefix + '.' + lowercase hex
 * (`CL.a3f2`). The regex is what the migration backfill uses to let an
 * imported bee whose OLD id already looks like a handle keep it.
 */
export const HANDLE_RE = /^[A-Z]{2}\.[0-9a-f]{3,8}$/;

/** Harness → handle prefix: first two letters, uppercased (claude→CL, codex→CO, grok→GR). */
export function handlePrefix(agent: string): string {
  const letters = agent.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
  return letters.length === 2 ? letters : (letters + "XX").slice(0, 2);
}

function mapBee(r: Row): BeeRow {
  return {
    id: r.id as string,
    name: r.name as string,
    agent: r.agent as string,
    substrate: r.substrate as string,
    cwd: r.cwd as string,
    title: (r.title as string | null) ?? null,
    tags: JSON.parse(r.tags as string) as string[],
    sessionLogPath: (r.session_log_path as string | null) ?? null,
    lifecycle: r.lifecycle as BeeRow["lifecycle"],
    createdAt: Number(r.created_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    lastOutputAt: r.last_output_at == null ? null : Number(r.last_output_at),
    providerSessionId: (r.provider_session_id as string | null) ?? null,
    env: JSON.parse((r.env as string | null) ?? "{}") as Record<string, string>,
    importedFrom: (r.imported_from as string | null) ?? null,
    spawnFailures: Number(r.spawn_failures ?? 0),
    args: parseArgsColumn(r.args),
    parentId: (r.parent_id as string | null) ?? null,
    forkedFrom: (r.forked_from as string | null) ?? null,
    forkSeed: (r.fork_seed as string | null) ?? null,
    account: (r.account as string | null) ?? null,
    handle: (r.handle as string | null) ?? null,
  };
}

function mapAccount(r: Row): AccountRow {
  return {
    id: r.id as string,
    harness: r.harness as string,
    homePath: r.home_path as string,
    label: r.label as string,
    status: r.status as AccountStatus,
    penalty: Number(r.penalty),
    lastLoginAt: r.last_login_at == null ? null : Number(r.last_login_at),
    exhaustedAt: r.exhausted_at == null ? null : Number(r.exhausted_at),
    addedAt: Number(r.added_at),
    updatedAt: Number(r.updated_at),
  };
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function nonNegativeInteger(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CoreError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function displayWindowsOrEmpty(value: unknown): AccountLimitsDisplayWindow[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      if (
        typeof row.key !== "string" || row.key.length === 0 ||
        typeof row.label !== "string" || row.label.length === 0 ||
        typeof row.usedPercent !== "number" || !Number.isFinite(row.usedPercent)
      ) return [];
      return [{
        key: row.key,
        label: row.label,
        usedPercent: row.usedPercent,
        resetsAt: row.resetsAt == null ? null : Number(row.resetsAt),
        windowMinutes: row.windowMinutes == null ? null : Number(row.windowMinutes),
      }];
    });
  } catch {
    return [];
  }
}

function mapAccountLimits(r: Row): AccountLimitsRow {
  return {
    account: r.account as string,
    fetchedAt: Number(r.fetched_at),
    readable: Number(r.readable) === 1,
    unreadableReason: (r.unreadable_reason as AccountLimitsUnreadableReason | null) ?? null,
    error: (r.error as string | null) ?? null,
    plan: (r.plan as string | null) ?? null,
    fiveHourPct: numOrNull(r.five_hour_pct),
    fiveHourResetsAt: numOrNull(r.five_hour_resets_at),
    fiveHourMinutes: numOrNull(r.five_hour_minutes),
    weeklyPct: numOrNull(r.weekly_pct),
    weeklyResetsAt: numOrNull(r.weekly_resets_at),
    weeklyMinutes: numOrNull(r.weekly_minutes),
    fableWeeklyPct: numOrNull(r.fable_weekly_pct),
    fableResetsAt: numOrNull(r.fable_resets_at),
    fableMinutes: numOrNull(r.fable_minutes),
    displayWindows: displayWindowsOrEmpty(r.display_windows),
  };
}

function mapSelectionCursor(r: Row): SelectionCursorRow {
  return { harness: r.harness as string, lastAccountId: r.last_account_id as string, updatedAt: Number(r.updated_at) };
}

function mapNamingUsage(r: Row): NamingUsageRow {
  return {
    id: Number(r.id),
    beeId: (r.bee_id as string | null) ?? null,
    backend: String(r.backend),
    provider: String(r.provider),
    model: String(r.model),
    status: r.status as NamingUsageStatus,
    latencyMs: Number(r.latency_ms),
    inputTokens: numOrNull(r.input_tokens),
    cachedInputTokens: numOrNull(r.cached_input_tokens),
    cacheWriteInputTokens: numOrNull(r.cache_write_input_tokens),
    outputTokens: numOrNull(r.output_tokens),
    reasoningTokens: numOrNull(r.reasoning_tokens),
    totalTokens: numOrNull(r.total_tokens),
    inputRateNanoUsd: numOrNull(r.input_rate_nano_usd),
    cachedInputRateNanoUsd: numOrNull(r.cached_input_rate_nano_usd),
    cacheWriteRateNanoUsd: numOrNull(r.cache_write_rate_nano_usd),
    outputRateNanoUsd: numOrNull(r.output_rate_nano_usd),
    estimatedCostNanoUsd: numOrNull(r.estimated_cost_nano_usd),
    responseId: (r.response_id as string | null) ?? null,
    requestId: (r.request_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    recordedAt: Number(r.recorded_at),
  };
}

function mapQuestion(r: Row): QuestionRow {
  return {
    id: r.id as string,
    beeId: r.bee_id as string,
    generation: r.generation == null ? null : Number(r.generation),
    text: r.text as string,
    options: r.options == null ? null : (JSON.parse(r.options as string) as string[]),
    status: r.status as QuestionRow["status"],
    answer: (r.answer as string | null) ?? null,
    askedAt: Number(r.asked_at),
    answeredAt: r.answered_at == null ? null : Number(r.answered_at),
    answeredBy: (r.answered_by as string | null) ?? null,
    deliveryMessageId: r.delivery_message_id == null ? null : Number(r.delivery_message_id),
  };
}

function mapSeal(r: Row): SealRow {
  return {
    id: r.id as string,
    beeId: r.bee_id as string,
    generation: r.generation == null ? null : Number(r.generation),
    title: r.title as string,
    body: r.body as string,
    refs: JSON.parse(r.refs as string) as string[],
    createdAt: Number(r.created_at),
  };
}

function mapTask(r: Row): TaskRow {
  return {
    id: r.id as string,
    list: r.list as string,
    beeId: (r.bee_id as string | null) ?? null,
    title: r.title as string,
    body: (r.body as string | null) ?? null,
    context: r.context == null ? null : (JSON.parse(r.context as string) as Record<string, unknown>),
    originKind: r.origin_kind as TaskRow["originKind"],
    originSender: r.origin_sender as string,
    auto: Number(r.auto) === 1,
    status: r.status as TaskStatus,
    claimedBy: (r.claimed_by as string | null) ?? null,
    order: Number(r.sort_order),
    questId: (r.quest_id as string | null) ?? null,
    mailboxMessageId: r.mailbox_message_id == null ? null : Number(r.mailbox_message_id),
    fedAt: r.fed_at == null ? null : Number(r.fed_at),
    stalledAt: r.stalled_at == null ? null : Number(r.stalled_at),
    blockedReason: (r.blocked_reason as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    closedAt: r.closed_at == null ? null : Number(r.closed_at),
  };
}

function mapTaskSupply(r: Row): TaskSupplyRow {
  return {
    beeId: r.bee_id as string,
    on: Number(r.enabled) === 1,
    limit: Number(r.feed_limit ?? DEFAULT_TASK_SUPPLY_LIMIT),
    feeds: Number(r.feeds ?? 0),
    paused: Number(r.paused) === 1,
  };
}

/** Validate an optional list of non-empty strings (tags, options, refs). */
function normalizeStringList(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new CoreError(`${where}: expected an array of strings`);
  }
  return [...(value as string[])];
}

function requireNonEmpty(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new CoreError(`${where}: expected a non-empty string`);
  return value;
}

/** v5 `bees.args`: NULL → null; otherwise a json array of strings. */
function parseArgsColumn(raw: unknown): string[] | null {
  if (raw == null) return null;
  const parsed = JSON.parse(String(raw)) as unknown;
  return Array.isArray(parsed) ? (parsed as string[]) : null;
}

/** Validate a per-bee args value: null (none) or an array of strings. */
function normalizeBeeArgs(args: unknown, where: string): string[] | null {
  if (args === undefined || args === null) return null;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new CoreError(`${where}: args must be an array of strings or null`);
  }
  return [...(args as string[])];
}

/** v7 — the operator's auto-pick penalty: 0..100 effective-load points (the old registry's bounds). */
function normalizePenalty(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new CoreError(`${where}: penalty must be a number from 0 to 100`);
  }
  return value;
}

function sameArgs(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function mapRuntime(r: Row): RuntimeRow {
  return {
    beeId: r.bee_id as string,
    generation: Number(r.generation),
    state: r.state as RuntimeState,
    exitCause: (r.exit_cause as ExitCause | null) ?? null,
    pid: r.pid == null ? null : Number(r.pid),
    pidStartedAt: r.pid_started_at == null ? null : Number(r.pid_started_at),
    bootEvidence: (r.boot_evidence as RuntimeRow["bootEvidence"]) ?? null,
    startedAt: Number(r.started_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapFlag(r: Row): FlagRow {
  return {
    id: Number(r.id),
    beeId: r.bee_id as string,
    flag: r.flag as Flag,
    detail: r.detail as string,
    setAt: Number(r.set_at),
    clearedAt: r.cleared_at == null ? null : Number(r.cleared_at),
  };
}

function mapMessage(r: Row): MessageRow {
  return {
    id: Number(r.id),
    beeId: r.bee_id as string,
    sender: r.sender as string,
    body: r.body as string,
    priority: Number(r.priority),
    urgency: r.urgency as Urgency,
    enqueuedAt: Number(r.enqueued_at),
    deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
    deliveredGeneration: r.delivered_generation == null ? null : Number(r.delivered_generation),
  };
}

function mapCommand(r: Row): CommandRow {
  return {
    id: Number(r.id),
    verb: r.verb as Verb,
    beeId: r.bee_id as string,
    args: JSON.parse(r.args as string) as Record<string, unknown>,
    targetGeneration: r.target_generation == null ? null : Number(r.target_generation),
    status: r.status as CommandRow["status"],
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    enqueuedAt: Number(r.enqueued_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    failureCause: (r.failure_cause as FailureCause | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
  };
}

function mapTemplate(r: Row): TemplateRow {
  return {
    id: r.id as string,
    name: r.name as string,
    scope: r.scope as TemplateRow["scope"],
    source: r.source as TemplateRow["source"],
    description: (r.description as string | null) ?? null,
    agent: r.agent as string,
    substrate: (r.substrate as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    args: JSON.parse(r.args as string) as string[],
    prompt: r.prompt as string,
    preamble: (r.preamble as string | null) ?? null,
    preambleEnabled: Number(r.preamble_enabled) === 1,
    cwdPolicy: r.cwd_policy as TemplateRow["cwdPolicy"],
    cwd: (r.cwd as string | null) ?? null,
    env: JSON.parse(r.env as string) as Record<string, string>,
    account: (r.account as string | null) ?? null,
    yolo: Number(r.yolo) === 1,
    tags: JSON.parse(r.tags as string) as string[],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapTrack(r: Row): TrackRow {
  return {
    id: r.id as string,
    name: r.name as string,
    scope: r.scope as TrackRow["scope"],
    source: r.source as TrackRow["source"],
    description: (r.description as string | null) ?? null,
    steps: JSON.parse(r.steps as string) as TrackRow["steps"],
    tags: JSON.parse(r.tags as string) as string[],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** Content fields of a stored row (drops id + timestamps) for the unchanged test. */
function templateFieldsOf(row: TemplateRow): TemplateFields {
  const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = row;
  return fields;
}

function trackFieldsOf(row: TrackRow): TrackFields {
  const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = row;
  return fields;
}

function mapAudit(r: Row): AuditRow {
  return {
    seq: Number(r.seq),
    ts: Number(r.ts),
    kind: r.kind as string,
    beeId: (r.bee_id as string | null) ?? null,
    payload: JSON.parse(r.payload as string) as Record<string, unknown>,
  };
}

export class CoreStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxRpcIdempotencyRows: number;
  private readonly stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private txDepth = 0;
  private closed = false;
  /** Commands requeued running→queued by open() (B5 boot replay); reported by reconcileAtBoot. */
  private bootRequeuedCommandIds: number[] = [];

  constructor(path: string, opts: CoreStoreOptions = {}) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 30_000;
    this.maxRpcIdempotencyRows = opts.maxRpcIdempotencyRows ?? 10_000;
    this.db = new DatabaseSync(path);
    try {
      // Fail immediately (no waiting) if another writer holds the lock.
      this.db.exec("PRAGMA busy_timeout = 0");
      // B9: WAL + EXCLUSIVE — the first write below acquires an exclusive lock that is
      // held until close(); any second connection's first access throws SQLITE_BUSY.
      this.db.exec("PRAGMA locking_mode = EXCLUSIVE");
      this.db.exec("PRAGMA journal_mode = WAL");
      // Production durability. Tests pass `ephemeral` to skip fsync; B9 locking
      // and crash/reopen-in-process semantics stay intact.
      this.db.exec(opts.ephemeral ? "PRAGMA synchronous = OFF" : "PRAGMA synchronous = NORMAL");
      if (opts.ephemeral) {
        this.db.exec("PRAGMA temp_store = MEMORY");
        this.db.exec("PRAGMA cache_size = -8000");
      }
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(SCHEMA_SQL);
      this.tx(() => {
        // Version gate + explicit migrations FIRST (before any other write
        // touches possibly-old tables), atomically with the stamp.
        this.ensureSchemaVersion();
        // Guaranteed write on open: takes the exclusive lock now, not lazily.
        this.stmt(
          "INSERT INTO meta(key, value) VALUES('opened_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(String(this.now()));
        this.bootRequeueRunningCommands();
      });
    } catch (err) {
      this.stmts.clear();
      try {
        this.db.close();
      } catch {
        /* already unusable */
      }
      if (err instanceof CoreError) throw err;
      throw new SecondWriterError(path, err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    this.db.close();
  }

  /** Reuse StatementSync objects. `prepare()` on every dumpState/getBee is the sim hot path. */
  private stmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
    const cached = this.stmts.get(sql);
    if (cached) return cached;
    const created = this.db.prepare(sql);
    this.stmts.set(sql, created);
    return created;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Serialize every write into one IMMEDIATE transaction; nested calls join the outer tx. */
  private tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* rollback after failed commit */
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  /**
   * Schema-version discipline (spec 06 §6, mirrored by apiaryd): the store is
   * stamped with SCHEMA_VERSION; a NEWER stamp is a downgrade and is refused
   * with a typed error; an OLDER (or pre-stamp v1) store is migrated here by
   * explicit code — no silent bumps. Runs inside the open() transaction so
   * migration + stamp commit atomically.
   */
  private ensureSchemaVersion(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as Row | undefined;
    const stored = row === undefined ? 1 : Number(row.value); // pre-stamp stores are v1
    if (stored > SCHEMA_VERSION) {
      throw new SchemaVersionError(
        "schema_newer",
        `core store at ${this.path} is schema v${stored}; this build speaks v${SCHEMA_VERSION} — ` +
          "refusing to open a newer store (downgrade). Update the daemon or roll the store back.",
      );
    }
    if (stored < SCHEMA_VERSION) {
      // v1 → v2: additive idempotency_key column on commands. A FRESH database
      // already has the column from SCHEMA_SQL (also unstamped, so it takes
      // this path too) — the pragma check makes the ALTER apply only to real
      // v1 stores.
      const cols = this.stmt("SELECT name FROM pragma_table_info('commands')").all() as Row[];
      if (!cols.some((c) => c.name === "idempotency_key")) {
        this.db.exec("ALTER TABLE commands ADD COLUMN idempotency_key TEXT");
      }
      // v2 → v3: additive bee columns (provider_session_id, env, imported_from);
      // v3 → v4: spawn_failures; v4 → v5: args. Same discipline: add iff
      // missing, so fresh and v1 stores (whose bees table was just created in
      // full) are untouched.
      const beeCols = new Set(
        (this.stmt("SELECT name FROM pragma_table_info('bees')").all() as Row[]).map((c) => String(c.name)),
      );
      for (const [name, ddl] of BEES_ADDITIVE_COLUMNS) {
        if (!beeCols.has(name)) this.db.exec(`ALTER TABLE bees ADD COLUMN ${ddl}`);
      }
      // v7 → v8: additive urgency column on mailbox (spec 01 Q2 amendment).
      const mailCols = new Set(
        (this.stmt("SELECT name FROM pragma_table_info('mailbox')").all() as Row[]).map((c) => String(c.name)),
      );
      for (const [name, ddl] of MAILBOX_ADDITIVE_COLUMNS) {
        if (!mailCols.has(name)) this.db.exec(`ALTER TABLE mailbox ADD COLUMN ${ddl}`);
      }
      // v8 → v9: additive boot_evidence column on runtimes (synthetic-boot
      // budget). Existing rows migrate as NULL — never treated as synthetic,
      // so a pre-migration live runtime is never punished retroactively.
      const runtimeCols = new Set(
        (this.stmt("SELECT name FROM pragma_table_info('runtimes')").all() as Row[]).map((c) => String(c.name)),
      );
      for (const [name, ddl] of RUNTIMES_ADDITIVE_COLUMNS) {
        if (!runtimeCols.has(name)) this.db.exec(`ALTER TABLE runtimes ADD COLUMN ${ddl}`);
      }
      // v11 → v12: typed account-limit failure class. Existing unreadable
      // rows stay null until the next bounded limits sweep refreshes them.
      const accountLimitCols = new Set(
        (this.stmt("SELECT name FROM pragma_table_info('account_limits')").all() as Row[]).map((c) => String(c.name)),
      );
      if (!accountLimitCols.has("unreadable_reason")) {
        this.db.exec(
          "ALTER TABLE account_limits ADD COLUMN unreadable_reason TEXT CHECK (unreadable_reason IS NULL OR unreadable_reason IN ('unsupported','auth_expired','auth_failed','provider_error','timeout'))",
        );
      }
      // v12 → v13: provider-authored display buckets. Existing rows have no
      // extra buckets; the standard routing windows remain untouched.
      if (!accountLimitCols.has("display_windows")) {
        this.db.exec("ALTER TABLE account_limits ADD COLUMN display_windows TEXT NOT NULL DEFAULT '[]'");
      }
      // v9 → v10: mint display handles for existing bees. An imported bee
      // whose old id already IS a pretty handle (CL.7920-style) keeps it —
      // the operator's known references survive the cutover.
      const unhandled = this.stmt("SELECT id, agent FROM bees WHERE handle IS NULL").all() as Row[];
      for (const b of unhandled) {
        const id = String(b.id);
        const keepOldId =
          HANDLE_RE.test(id) &&
          this.stmt("SELECT 1 FROM bees WHERE handle = ?").get(id) === undefined;
        const handle = keepOldId ? id : this.mintHandle(String(b.agent));
        this.stmt("UPDATE bees SET handle = ? WHERE id = ?").run(handle, id);
      }
    }
    // The partial UNIQUE indexes need their columns, so they are created here
    // — after the migration — not in SCHEMA_SQL.
    this.db.exec(IDEMPOTENCY_INDEX_SQL);
    this.db.exec(HANDLE_INDEX_SQL);
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(SCHEMA_VERSION));
  }

  private audit(kind: string, beeId: string | null, payload: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, ?, ?, ?)")
      .run(this.now(), kind, beeId, JSON.stringify(payload));
  }

  private mustGetBee(beeId: string): BeeRow {
    const bee = this.getBee(beeId);
    if (!bee) throw new BeeNotFoundError(beeId);
    return bee;
  }

  /** B5 — on library re-open ("boot"), all `running` commands revert to `queued`. */
  private bootRequeueRunningCommands(): void {
    const rows = this.db
      .prepare("SELECT id FROM commands WHERE status = 'running' ORDER BY id")
      .all() as Row[];
    this.bootRequeuedCommandIds = rows.map((r) => Number(r.id));
    if (this.bootRequeuedCommandIds.length === 0) return;
    const at = this.now();
    this.db
      .prepare("UPDATE commands SET status = 'queued', next_attempt_at = ? WHERE status = 'running'")
      .run(at);
    this.audit("command.boot_requeued", null, {
      commandIds: this.bootRequeuedCommandIds,
      nextAttemptAt: at,
    });
  }

  // -------------------------------------------------------------------------
  // B1 — bee lifecycle
  // -------------------------------------------------------------------------

  /**
   * v10 — mint a unique display handle for the agent: prefix + 4 hex chars,
   * growing to 5 then 6 on sustained collision. Single writer per node, so
   * a read-check + retry is race-free. ~65k values at 4 chars per node; the
   * growth path means exhaustion degrades to longer handles, never failure
   * (a hard bound guards a broken rng).
   */
  private mintHandle(agent: string): string {
    const prefix = handlePrefix(agent);
    const taken = this.stmt("SELECT 1 FROM bees WHERE handle = ?");
    for (let attempt = 0; attempt < 64; attempt++) {
      const len = attempt < 16 ? 4 : attempt < 40 ? 5 : 6;
      let suffix = "";
      for (let i = 0; i < len; i++) suffix += Math.floor(this.random() * 16).toString(16);
      const handle = `${prefix}.${suffix}`;
      if (!taken.get(handle)) return handle;
    }
    throw new CoreError(`mintHandle: could not find a free handle for ${agent} after 64 attempts`);
  }

  createBee(input: CreateBeeInput): { bee: BeeRow; runtime: RuntimeRow } {
    return this.tx(() => {
      const id = input.id ?? randomUUID();
      if (this.getBee(id)) throw new CoreError(`bee already exists: ${id}`);
      let handle: string;
      if (input.handle !== undefined) {
        requireNonEmpty(input.handle, "createBee: handle");
        if (this.stmt("SELECT 1 FROM bees WHERE handle = ?").get(input.handle)) {
          throw new CoreError(`createBee: handle already taken: ${input.handle}`);
        }
        handle = input.handle;
      } else {
        handle = this.mintHandle(input.agent);
      }
      const at = this.now();
      const createdAt = input.createdAt ?? at;
      if (!Number.isFinite(createdAt)) throw new CoreError("createBee: createdAt must be a finite epoch-ms number");
      const args = normalizeBeeArgs(input.args, "createBee");
      requireNonEmpty(input.name, "createBee: name");
      const account = input.account ?? null;
      if (account !== null) {
        if (typeof account !== "string" || account.length === 0) throw new CoreError("createBee: account must be a non-empty string or null");
        if (account === "auto") throw new CoreError("createBee: account 'auto' is a selection intent, never a stored binding — resolve it first");
        this.mustGetAccount(account);
      }
      this.db
        .prepare(
          `INSERT INTO bees(id, name, agent, substrate, cwd, title, tags, session_log_path, lifecycle, created_at,
                            provider_session_id, env, imported_from, args, parent_id, forked_from, fork_seed, account, handle)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.agent,
          input.substrate,
          input.cwd,
          input.title ?? null,
          JSON.stringify(input.tags ?? []),
          input.sessionLogPath ?? null,
          createdAt,
          input.providerSessionId ?? null,
          JSON.stringify(input.env ?? {}),
          input.importedFrom ?? null,
          args === null ? null : JSON.stringify(args),
          input.parentId ?? null,
          input.forkedFrom ?? null,
          input.forkSeed ?? null,
          account,
          handle,
        );
      const bee = this.mustGetBee(id);
      this.audit("bee.created", id, { bee });
      const runtime = this.insertRuntime(id, 1, at, input.proc);
      return { bee, runtime };
    });
  }

  getBee(beeId: string): BeeRow | null {
    const row = this.stmt("SELECT * FROM bees WHERE id = ?").get(beeId) as Row | undefined;
    return row ? mapBee(row) : null;
  }

  listBees(): BeeRow[] {
    const rows = this.stmt("SELECT * FROM bees ORDER BY id").all() as Row[];
    return rows.map(mapBee);
  }

  /**
   * v6 — rename. Names follow createBee's rules (non-empty; NOT unique — the
   * id is the identity, names are labels; the CLI resolves ambiguous names by
   * refusing). An identical name is a silent no-op; a change is audited as
   * `bee.renamed` and replayable.
   */
  renameBee(beeId: string, name: string): { bee: BeeRow; applied: boolean } {
    requireNonEmpty(name, "renameBee: name");
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.name === name) return { bee, applied: false };
      this.stmt("UPDATE bees SET name = ? WHERE id = ?").run(name, beeId);
      this.audit("bee.renamed", beeId, { beeId, name, previous: bee.name });
      return { bee: this.mustGetBee(beeId), applied: true };
    });
  }

  /**
   * Display title (the Apiary tab/list label when `name` is a generated slug).
   * Identity stays on id/handle/name. Identical title is a silent no-op.
   * Audit `bee.titled` so the mirror fold updates `bee.title`.
   */
  setBeeTitle(beeId: string, title: string, source = "auto"): { bee: BeeRow; applied: boolean } {
    requireNonEmpty(title, "setBeeTitle: title");
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.title === title) return { bee, applied: false };
      this.stmt("UPDATE bees SET title = ? WHERE id = ?").run(title, beeId);
      this.audit("bee.titled", beeId, { beeId, title, previous: bee.title, source });
      return { bee: this.mustGetBee(beeId), applied: true };
    });
  }

  /**
   * v6 — tag edit: `remove` first, then `add` (so add-then-remove of the same
   * tag removes). Order is preserved: surviving tags keep their position, new
   * tags append in `add` order, duplicates collapse. Unchanged = silent no-op;
   * a change is audited as `bee.tagged` (payload carries the full new list —
   * the mirror row is `tags` verbatim).
   */
  tagBee(beeId: string, edit: { add?: string[]; remove?: string[] }): TagResult {
    const add = normalizeStringList(edit.add, "tagBee: add");
    const remove = normalizeStringList(edit.remove, "tagBee: remove");
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      const removeSet = new Set(remove);
      const next: string[] = [];
      for (const t of bee.tags) if (!removeSet.has(t) && !next.includes(t)) next.push(t);
      for (const t of add) if (!next.includes(t)) next.push(t);
      const removed = bee.tags.filter((t) => !next.includes(t));
      const added = next.filter((t) => !bee.tags.includes(t));
      const applied = next.length !== bee.tags.length || next.some((t, i) => bee.tags[i] !== t);
      if (!applied) return { bee, applied: false, added: [], removed: [] };
      this.stmt("UPDATE bees SET tags = ? WHERE id = ?").run(JSON.stringify(next), beeId);
      this.audit("bee.tagged", beeId, { beeId, tags: next, previous: bee.tags, added, removed });
      return { bee: this.mustGetBee(beeId), applied: true, added, removed };
    });
  }

  /** v6 — the bees whose parent_id is this bee (any lifecycle), by id. */
  listChildren(beeId: string): BeeRow[] {
    const rows = this.stmt("SELECT * FROM bees WHERE parent_id = ? ORDER BY id").all(beeId) as Row[];
    return rows.map(mapBee);
  }

  archiveBee(beeId: string): BeeRow {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.lifecycle !== "active") {
        throw new IllegalTransitionError(
          `lifecycle ${bee.lifecycle} → archived is outside B1's graph (bee ${beeId})`,
        );
      }
      return this.applyArchive(beeId);
    });
  }

  private applyArchive(beeId: string): BeeRow {
    const at = this.now();
    this.stmt("UPDATE bees SET lifecycle = 'archived', archived_at = ? WHERE id = ?").run(at, beeId);
    this.audit("bee.archived", beeId, { beeId, archivedAt: at });
    return this.mustGetBee(beeId);
  }

  unarchiveBee(beeId: string): BeeRow {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.lifecycle !== "archived") {
        throw new IllegalTransitionError(
          `lifecycle ${bee.lifecycle} → active is outside B1's graph (bee ${beeId})`,
        );
      }
      return this.applyUnarchive(beeId);
    });
  }

  private applyUnarchive(beeId: string): BeeRow {
    this.stmt("UPDATE bees SET lifecycle = 'active', archived_at = NULL WHERE id = ?").run(beeId);
    this.audit("bee.unarchived", beeId, { beeId });
    return this.mustGetBee(beeId);
  }

  /**
   * Q1 — delete is immediate: record, mailbox, runtimes, flags all removed now; the
   * session log path is returned for the caller to remove (core does no file I/O).
   * An active bee passes through `archived` first (audited) so every step stays on
   * B1's graph. Pending commands for the bee settle `done` (moot — B6 philosophy).
   */
  deleteBee(beeId: string): DeleteResult {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.lifecycle === "active") this.applyArchive(beeId);
      const current = this.currentRuntime(beeId);
      const livePid = current && current.state !== "stopped" ? current.pid : null;
      const at = this.now();
      const pending = this.db
        .prepare("SELECT id FROM commands WHERE bee_id = ? AND status IN ('queued','running') ORDER BY id")
        .all(beeId) as Row[];
      const settledCommandIds = pending.map((r) => Number(r.id));
      if (settledCommandIds.length > 0) {
        this.db
          .prepare("UPDATE commands SET status = 'done', finished_at = ? WHERE bee_id = ? AND status IN ('queued','running')")
          .run(at, beeId);
      }
      // v6 parenting policy: delete ORPHANS children (parent_id → null,
      // audited per child), never cascades. Archive touches no child at all.
      const orphanedChildIds = this.listChildren(beeId).map((c) => c.id);
      for (const childId of orphanedChildIds) {
        this.stmt("UPDATE bees SET parent_id = NULL WHERE id = ?").run(childId);
        this.audit("bee.orphaned", childId, { beeId: childId, parentId: beeId, reason: "parent_deleted" });
      }
      // ON DELETE CASCADE removes runtimes, flags, mailbox, questions, seals,
      // tasks, and task_supply.
      this.stmt("DELETE FROM bees WHERE id = ?").run(beeId);
      this.audit("bee.deleted", beeId, {
        beeId,
        deletedAt: at,
        sessionLogPath: bee.sessionLogPath,
        settledCommandIds,
      });
      return { beeId, sessionLogPath: bee.sessionLogPath, livePid, settledCommandIds, orphanedChildIds };
    });
  }

  // -------------------------------------------------------------------------
  // B2 — runtime states & generations
  // -------------------------------------------------------------------------

  currentRuntime(beeId: string): RuntimeRow | null {
    const row = this.db
      .prepare("SELECT * FROM runtimes WHERE bee_id = ? ORDER BY generation DESC LIMIT 1")
      .get(beeId) as Row | undefined;
    return row ? mapRuntime(row) : null;
  }

  listRuntimes(beeId: string): RuntimeRow[] {
    const rows = this.db
      .prepare("SELECT * FROM runtimes WHERE bee_id = ? ORDER BY generation")
      .all(beeId) as Row[];
    return rows.map(mapRuntime);
  }

  private insertRuntime(
    beeId: string,
    generation: number,
    at: number,
    proc?: { pid: number; pidStartedAt: number },
  ): RuntimeRow {
    this.db
      .prepare(
        `INSERT INTO runtimes(bee_id, generation, state, exit_cause, pid, pid_started_at, started_at, updated_at)
         VALUES(?, ?, 'booting', NULL, ?, ?, ?, ?)`,
      )
      .run(beeId, generation, proc?.pid ?? null, proc?.pidStartedAt ?? null, at, at);
    const runtime = this.currentRuntime(beeId);
    if (!runtime || runtime.generation !== generation) throw new CoreError("runtime insert lost");
    this.audit("runtime.created", beeId, { runtime });
    return runtime;
  }

  /**
   * B2 — state update stamped with the generation it refers to. An update for a
   * non-current generation is a recorded no-op (audit row, no state change).
   * Illegal transitions for the CURRENT generation throw.
   *
   * v9 `opts.synthetic` (booting → running only): the transition was derived
   * from a DRIVER-MINTED observation (the readyAtSpawn synthetic booted), not
   * from real process output. The state still moves — delivery needs the
   * runtime out of `booting` — but it is provisional: the spawn-failure
   * budget is NOT reset, and a later crashed/clean exit of this generation
   * counts against the budget exactly like an exit during `booting` (unless
   * `recordBootEvidence` upgraded it to real first).
   */
  updateRuntimeState(
    beeId: string,
    generation: number,
    state: RuntimeState,
    opts: { exitCause?: ExitCause; exitDetail?: string; pid?: number; pidStartedAt?: number; synthetic?: boolean } = {},
  ): { applied: boolean } {
    if (!RUNTIME_TRANSITIONS[state]) {
      throw new IllegalTransitionError(`unknown runtime state: ${state}`);
    }
    return this.tx(() => {
      this.mustGetBee(beeId);
      const current = this.currentRuntime(beeId);
      if (!current) throw new CoreError(`bee ${beeId} has no runtime rows`);
      if (generation !== current.generation) {
        this.audit("runtime.stale_update", beeId, {
          beeId,
          generation,
          currentGeneration: current.generation,
          requestedState: state,
        });
        return { applied: false };
      }
      if (!RUNTIME_TRANSITIONS[current.state].includes(state)) {
        throw new IllegalTransitionError(
          `runtime ${beeId}#${generation}: ${current.state} → ${state} is outside B2's graph`,
        );
      }
      if (state === "stopped") {
        if (!opts.exitCause || !EXIT_CAUSES.includes(opts.exitCause)) {
          throw new IllegalTransitionError(
            `runtime ${beeId}#${generation}: stopped requires an exit_cause from (${EXIT_CAUSES.join(", ")})`,
          );
        }
      } else if (opts.exitCause) {
        throw new IllegalTransitionError(
          `runtime ${beeId}#${generation}: exit_cause is only valid on stopped`,
        );
      }
      if (opts.pid !== undefined && opts.pidStartedAt === undefined) {
        throw new CoreError("pid updates require pidStartedAt (boot re-adoption needs both)");
      }
      const at = this.now();
      const pid = opts.pid !== undefined ? opts.pid : current.pid;
      const pidStartedAt = opts.pidStartedAt !== undefined ? opts.pidStartedAt : current.pidStartedAt;
      // v9 boot evidence: set on the booting → running edge, sticky afterwards
      // ('real' is never downgraded — evidence, once seen, stays evidence).
      let bootEvidence = current.bootEvidence;
      if (current.state === "booting" && state === "running" && bootEvidence !== "real") {
        bootEvidence = opts.synthetic === true ? "synthetic" : "real";
      }
      this.db
        .prepare(
          `UPDATE runtimes SET state = ?, exit_cause = ?, pid = ?, pid_started_at = ?, boot_evidence = ?, updated_at = ?
           WHERE bee_id = ? AND generation = ?`,
        )
        .run(state, opts.exitCause ?? null, pid, pidStartedAt, bootEvidence, at, beeId, generation);
      const runtime = this.currentRuntime(beeId);
      this.audit("runtime.updated", beeId, { runtime });
      // Spawn-failure budget (contract §4.2 spawn_failed, B5 bounded): a
      // runtime that dies on its own having proven NOTHING — still booting,
      // or running only on a synthetic booted (the 2026-08-18 soak loop) —
      // is a boot failure; REAL evidence (adapter-parsed output) is the
      // contrary evidence that resets the budget.
      if (state === "stopped" && (opts.exitCause === "crashed" || opts.exitCause === "clean")) {
        if (current.state === "booting" || current.bootEvidence === "synthetic") {
          this.applySpawnFailure(beeId, generation, opts.exitCause, opts.exitDetail);
        }
      } else if (current.state === "booting" && state === "running" && bootEvidence === "real") {
        this.applySpawnFailuresReset(beeId, `runtime booted (generation ${generation})`);
      }
      return { applied: true };
    });
  }

  /**
   * v9 — real boot evidence for the CURRENT generation: the adapter parsed an
   * actual line from the process (a real booted/init, a turn signal, flag
   * evidence — any parsed output). Upgrades a provisional (synthetic) or
   * still-booting runtime to `boot_evidence = 'real'`, resets the bee's
   * spawn-failure budget and clears `spawn_failed` (spec 03 contrary
   * evidence). Idempotent; a stale generation or an already-stopped runtime
   * is a silent no-op — the exit accounting for it has already happened.
   */
  recordBootEvidence(beeId: string, generation: number, reason?: string): { applied: boolean } {
    return this.tx(() => {
      this.mustGetBee(beeId);
      const current = this.currentRuntime(beeId);
      if (!current || current.generation !== generation || current.state === "stopped") {
        return { applied: false };
      }
      if (current.bootEvidence !== "real") {
        this.db
          .prepare("UPDATE runtimes SET boot_evidence = 'real' WHERE bee_id = ? AND generation = ?")
          .run(beeId, generation);
        this.audit("runtime.updated", beeId, { runtime: this.currentRuntime(beeId) });
      }
      const { applied } = this.applySpawnFailuresReset(
        beeId,
        reason ?? `runtime produced real output (generation ${generation})`,
      );
      return { applied: applied || current.bootEvidence !== "real" };
    });
  }

  /**
   * One more consecutive boot failure for the bee. Below the budget the next
   * wake is deferred by the B5 backoff table (see applyWakeIfNeeded); at the
   * budget the `spawn_failed` flag is set — visibly blocked — and no further
   * wakes are enqueued until contrary evidence clears it.
   */
  private applySpawnFailure(beeId: string, generation: number, exitCause: ExitCause, detail?: string): void {
    const failures = this.mustGetBee(beeId).spawnFailures + 1;
    this.stmt("UPDATE bees SET spawn_failures = ? WHERE id = ?").run(failures, beeId);
    this.audit("bee.spawn_failures", beeId, {
      beeId,
      spawnFailures: failures,
      reason: "boot_exit",
      generation,
      exitCause,
      budget: this.maxAttempts,
      ...(detail ? { detail } : {}),
    });
    if (failures >= this.maxAttempts) {
      this.applySetFlag(
        beeId,
        "spawn_failed",
        `runtime exited during boot ${failures} times in a row (generation ${generation}, ${exitCause}` +
          `${detail ? `: ${detail}` : ""}); ` +
          "not reviving again until it boots or an operator revives it",
      );
    }
  }

  private applySpawnFailuresReset(beeId: string, reason: string): { applied: boolean } {
    const bee = this.mustGetBee(beeId);
    let applied = false;
    if (bee.spawnFailures !== 0) {
      this.stmt("UPDATE bees SET spawn_failures = 0 WHERE id = ?").run(beeId);
      this.audit("bee.spawn_failures", beeId, { beeId, spawnFailures: 0, reason });
      applied = true;
    }
    // Contrary evidence clears the flag (spec 03): every setter has a clearer.
    // Silent when nothing was set — success is the common case.
    if (this.applyClearFlag(beeId, "spawn_failed", reason, { auditNoop: false }).applied) applied = true;
    return { applied };
  }

  /**
   * Operator action against the spawn-failure budget: an explicit `revive`
   * resets the counter and clears `spawn_failed`, granting a fresh budget for
   * the attempt it is about to make ("no flag is permanent short of operator
   * action", spec 03). Idempotent; a no-op when nothing is set.
   */
  resetSpawnFailures(beeId: string, reason = "operator revive"): { applied: boolean } {
    return this.tx(() => {
      this.mustGetBee(beeId);
      return this.applySpawnFailuresReset(beeId, reason);
    });
  }

  /**
   * When the next wake-driven revive may run after boot failures: the B5
   * table (base × 2^(n-1)) from the moment the last generation stopped.
   * Undefined = no boot failures, wake immediately.
   */
  private wakeNotBefore(bee: BeeRow, current: RuntimeRow | null): number | undefined {
    if (bee.spawnFailures <= 0 || !current) return undefined;
    return current.updatedAt + this.backoffBaseMs * 2 ** (bee.spawnFailures - 1);
  }

  /**
   * Enqueue a send_wake for a bee with no live runtime — the ONE place a wake
   * is scheduled (send() and the daemon's wake sweeps both land here). Bounded
   * queue: an identical pending wake for the same generation is returned as-is.
   * Suppressed (null) while `spawn_failed` is set — the bee is visibly blocked;
   * mail stays durable; the operator's revive is the way back. Deferred by the
   * B5 backoff table when the bee has consecutive boot failures.
   */
  private applyWakeIfNeeded(beeId: string): WakeResult {
    const bee = this.mustGetBee(beeId);
    const current = this.currentRuntime(beeId);
    if (current && LIVE_STATES.includes(current.state)) return { command: null, outcome: "live" };
    const targetGeneration = current?.generation ?? 0;
    const dupe = this.db
      .prepare(
        `SELECT * FROM commands WHERE bee_id = ? AND verb = 'send_wake'
         AND status IN ('queued','running') AND target_generation = ? LIMIT 1`,
      )
      .get(beeId, targetGeneration) as Row | undefined;
    if (dupe) return { command: mapCommand(dupe), outcome: "pending" };
    const flagged = this.db
      .prepare("SELECT id FROM flags WHERE bee_id = ? AND flag = 'spawn_failed' AND cleared_at IS NULL")
      .get(beeId) as Row | undefined;
    if (flagged) {
      this.audit("wake.suppressed", beeId, {
        beeId,
        targetGeneration,
        flag: "spawn_failed",
        spawnFailures: bee.spawnFailures,
      });
      return { command: null, outcome: "suppressed" };
    }
    const command = this.applyEnqueue("send_wake", beeId, {}, targetGeneration, null, this.wakeNotBefore(bee, current));
    return { command, outcome: "enqueued" };
  }

  /**
   * Daemon wake sweep: enqueue a send_wake iff the bee has undelivered mail
   * and no live runtime (and no pending wake). Same rules as send()'s inline
   * wake — flag suppression and boot-failure backoff included.
   */
  enqueueWake(beeId: string): WakeResult {
    return this.tx(() => {
      this.mustGetBee(beeId);
      if (this.undeliveredMessages(beeId).length === 0) return { command: null, outcome: "no_mail" };
      return this.applyWakeIfNeeded(beeId);
    });
  }

  /**
   * Retry a failed boot even when the bee has no mailbox work. This shares
   * the exact bounded budget, backoff, generation fence, and spawn_failed
   * suppression used by mailbox wakes.
   */
  enqueueBootRetry(beeId: string): WakeResult {
    return this.tx(() => {
      this.mustGetBee(beeId);
      return this.applyWakeIfNeeded(beeId);
    });
  }

  /**
   * WP2 pid-at-spawn amendment (WP4 wiring): record the process identity the
   * driver captured at spawn on the current, live runtime row — no state
   * transition. A daemon restart at any point (even mid-boot) can then
   * re-adopt by pid + start-time. Stale generation / stopped row: recorded
   * no-op, mirroring B2.
   */
  recordRuntimeProc(
    beeId: string,
    generation: number,
    proc: { pid: number; pidStartedAt: number },
  ): { applied: boolean } {
    return this.tx(() => {
      this.mustGetBee(beeId);
      const current = this.currentRuntime(beeId);
      if (!current || current.generation !== generation || current.state === "stopped") {
        this.audit("runtime.stale_update", beeId, {
          beeId,
          generation,
          currentGeneration: current?.generation ?? null,
          requestedState: "proc_record",
        });
        return { applied: false };
      }
      this.db
        .prepare("UPDATE runtimes SET pid = ?, pid_started_at = ? WHERE bee_id = ? AND generation = ?")
        .run(proc.pid, proc.pidStartedAt, beeId, generation);
      const runtime = this.currentRuntime(beeId);
      this.audit("runtime.updated", beeId, { runtime });
      return { applied: true };
    });
  }

  /**
   * B2 — no transition out of stopped; revival creates generation N+1 (booting).
   * v5: `args` (when given, including null) replaces the bee's per-bee spawn
   * args in the same transaction, before the new generation is minted — so the
   * revived runtime is resolved with them.
   */
  reviveBee(beeId: string, opts: { proc?: { pid: number; pidStartedAt: number }; args?: string[] | null } = {}): RuntimeRow {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.lifecycle === "archived") this.applyUnarchive(beeId); // Q3 spirit: revival implies active
      const current = this.currentRuntime(beeId);
      if (current && current.state !== "stopped") {
        throw new IllegalTransitionError(
          `bee ${beeId}: cannot revive while generation ${current.generation} is ${current.state}`,
        );
      }
      if (opts.args !== undefined) this.applyArgs(beeId, normalizeBeeArgs(opts.args, "reviveBee"));
      const generation = (current?.generation ?? 0) + 1;
      return this.insertRuntime(beeId, generation, this.now(), opts.proc);
    });
  }

  /**
   * v5 — replace a bee's per-bee spawn args (`null` clears them). Bee-scoped;
   * takes effect on the NEXT runtime (the current process is untouched — stop
   * or revive to apply). An identical value is a silent no-op; a change is
   * audited as `bee.args_set` and replayable.
   */
  updateBeeArgs(beeId: string, args: string[] | null): { bee: BeeRow; applied: boolean } {
    const next = normalizeBeeArgs(args, "updateBeeArgs");
    return this.tx(() => {
      this.mustGetBee(beeId);
      const applied = this.applyArgs(beeId, next);
      return { bee: this.mustGetBee(beeId), applied };
    });
  }

  private applyArgs(beeId: string, next: string[] | null): boolean {
    const bee = this.mustGetBee(beeId);
    if (sameArgs(bee.args, next)) return false;
    this.stmt("UPDATE bees SET args = ? WHERE id = ?").run(next === null ? null : JSON.stringify(next), beeId);
    this.audit("bee.args_set", beeId, { beeId, args: next, previous: bee.args });
    return true;
  }

  /**
   * v3 (spec 07 §F) — record the harness-native session/thread id a runtime
   * reported on boot. Bee-scoped (the conversation identity outlives any
   * generation); an identical value is a silent no-op, so replays and late
   * duplicate boots never spam the audit log.
   */
  recordProviderSessionId(beeId: string, providerSessionId: string): { applied: boolean } {
    if (typeof providerSessionId !== "string" || providerSessionId.length === 0) {
      throw new CoreError("recordProviderSessionId: providerSessionId must be a non-empty string");
    }
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (bee.providerSessionId === providerSessionId) return { applied: false };
      // v6: learning the fork's OWN session id consumes the one-shot fork
      // seed — from here on the bee resumes its own conversation.
      this.db
        .prepare("UPDATE bees SET provider_session_id = ?, fork_seed = NULL WHERE id = ?")
        .run(providerSessionId, beeId);
      this.audit("bee.provider_session", beeId, {
        beeId,
        providerSessionId,
        previous: bee.providerSessionId,
        ...(bee.forkSeed != null ? { forkSeedConsumed: bee.forkSeed } : {}),
      });
      return { applied: true };
    });
  }

  /**
   * v6 — informational record of an operator interrupt request against a
   * runtime (the outcome the driver reported). No row changes: the
   * turn_ended that follows a successful interrupt is observed like any
   * other. Replay: no-op.
   */
  recordInterrupt(beeId: string, generation: number | null, outcome: { interrupted: boolean; reason?: string }): void {
    this.tx(() => {
      this.mustGetBee(beeId);
      this.audit("bee.interrupted", beeId, {
        beeId,
        generation,
        interrupted: outcome.interrupted,
        reason: outcome.reason ?? null,
      });
    });
  }

  /** v6 — informational fork provenance row (the bee row already carries forkedFrom/forkSeed). Replay: no-op. */
  recordFork(beeId: string, forkedFrom: string, forkSeed: string | null): void {
    this.tx(() => {
      this.mustGetBee(beeId);
      this.audit("bee.forked", beeId, { beeId, forkedFrom, forkSeed });
    });
  }

  /**
   * v3 — append the `bee.imported` provenance row (the importer's forensic
   * record: where the bee came from and what the old record said). Informational
   * by definition — replayAudit treats it as a no-op; the state-bearing facts
   * (id, providerSessionId, env, importedFrom) live on the bee row itself.
   */
  recordImportProvenance(beeId: string, payload: Record<string, unknown>): void {
    this.tx(() => {
      this.mustGetBee(beeId);
      this.audit("bee.imported", beeId, payload);
    });
  }

  // -------------------------------------------------------------------------
  // B3 — condition flags (closed list)
  // -------------------------------------------------------------------------

  private assertKnownFlag(flag: string): asserts flag is Flag {
    if (!(FLAGS as readonly string[]).includes(flag)) throw new UnknownFlagError(flag);
  }

  setFlag(beeId: string, flag: string, detail: string): FlagRow {
    this.assertKnownFlag(flag);
    return this.tx(() => {
      this.mustGetBee(beeId);
      return this.applySetFlag(beeId, flag, detail);
    });
  }

  private applySetFlag(beeId: string, flag: Flag, detail: string): FlagRow {
    const existing = this.db
      .prepare("SELECT * FROM flags WHERE bee_id = ? AND flag = ? AND cleared_at IS NULL")
      .get(beeId, flag) as Row | undefined;
    if (existing) {
      this.stmt("UPDATE flags SET detail = ? WHERE id = ?").run(detail, Number(existing.id));
      const row = mapFlag({ ...existing, detail });
      this.audit("flag.set", beeId, { flag: row });
      return row;
    }
    const at = this.now();
    const res = this.db
      .prepare("INSERT INTO flags(bee_id, flag, detail, set_at, cleared_at) VALUES(?, ?, ?, ?, NULL)")
      .run(beeId, flag, detail, at);
    const row: FlagRow = {
      id: Number(res.lastInsertRowid),
      beeId,
      flag,
      detail,
      setAt: at,
      clearedAt: null,
    };
    this.audit("flag.set", beeId, { flag: row });
    return row;
  }

  clearFlag(beeId: string, flag: string, detail?: string): { applied: boolean } {
    this.assertKnownFlag(flag);
    return this.tx(() => {
      this.mustGetBee(beeId);
      return this.applyClearFlag(beeId, flag, detail ?? null, { auditNoop: true });
    });
  }

  private applyClearFlag(
    beeId: string,
    flag: Flag,
    detail: string | null,
    opts: { auditNoop: boolean },
  ): { applied: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM flags WHERE bee_id = ? AND flag = ? AND cleared_at IS NULL")
      .get(beeId, flag) as Row | undefined;
    if (!existing) {
      if (opts.auditNoop) this.audit("flag.clear_noop", beeId, { beeId, flag });
      return { applied: false };
    }
    const at = this.now();
    this.stmt("UPDATE flags SET cleared_at = ? WHERE id = ?").run(at, Number(existing.id));
    this.audit("flag.cleared", beeId, {
      flagId: Number(existing.id),
      beeId,
      flag,
      clearedAt: at,
      detail,
    });
    return { applied: true };
  }

  activeFlags(beeId: string): FlagRow[] {
    const rows = this.db
      .prepare("SELECT * FROM flags WHERE bee_id = ? AND cleared_at IS NULL ORDER BY id")
      .all(beeId) as Row[];
    return rows.map(mapFlag);
  }

  // -------------------------------------------------------------------------
  // B4 / B4a — mailbox (buz IS this mailbox; sender is buz metadata)
  // -------------------------------------------------------------------------

  /**
   * B4 — a single transactional insert. Succeeds iff lifecycle ≠ deleted (a deleted
   * bee has no row → BeeNotFoundError). Archived bees auto-unarchive (Q3). When no
   * live runtime exists, a `send_wake` command is enqueued in the SAME transaction.
   */
  send(beeId: string, body: string, opts: { sender?: string; priority?: number; urgency?: Urgency } = {}): SendResult {
    const urgency = opts.urgency ?? "next";
    if (!(MESSAGE_URGENCIES as readonly string[]).includes(urgency)) throw new UnknownUrgencyError(urgency);
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      let unarchived = false;
      if (bee.lifecycle === "archived") {
        this.applyUnarchive(beeId);
        unarchived = true;
      }
      const at = this.now();
      const res = this.db
        .prepare("INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at) VALUES(?, ?, ?, ?, ?, ?)")
        .run(beeId, opts.sender ?? "operator", body, opts.priority ?? 0, urgency, at);
      const message: MessageRow = {
        id: Number(res.lastInsertRowid),
        beeId,
        sender: opts.sender ?? "operator",
        body,
        priority: opts.priority ?? 0,
        urgency,
        enqueuedAt: at,
        deliveredAt: null,
        deliveredGeneration: null,
      };
      this.audit("mail.enqueued", beeId, { message });
      // Human (and bee) interaction resets the consecutive-feed counter; the
      // supply loop's own sends are excluded by sender name.
      if ((opts.sender ?? "operator") !== TASK_SUPPLY_SENDER_NAME) {
        this.applyResetTaskSupplyFeeds(beeId);
      }
      const wakeCommand = this.applyWakeIfNeeded(beeId).command;
      return { message, wakeCommand, unarchived };
    });
  }

  /**
   * Undelivered messages, per-bee FIFO (Q2 — priority column intentionally
   * unused). v8: `urgency` rides along; ELIGIBILITY is the daemon delivery
   * loop's job — the store never reorders or filters by it.
   */
  undeliveredMessages(beeId: string): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL ORDER BY id")
      .all(beeId) as Row[];
    return rows.map(mapMessage);
  }

  /** All undelivered mail in per-bee FIFO order (daemon tick batch read). */
  listUndeliveredMessages(): MessageRow[] {
    const rows = this.stmt(
      "SELECT * FROM mailbox WHERE delivered_at IS NULL ORDER BY bee_id, id",
    ).all() as Row[];
    return rows.map(mapMessage);
  }

  /** All messages for a bee, delivered or not, per-bee FIFO order. */
  listMessages(beeId: string): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM mailbox WHERE bee_id = ? ORDER BY id")
      .all(beeId) as Row[];
    return rows.map(mapMessage);
  }

  getMessage(messageId: number): MessageRow | null {
    const row = this.stmt("SELECT * FROM mailbox WHERE id = ?").get(messageId) as Row | undefined;
    return row ? mapMessage(row) : null;
  }

  /**
   * Cancel an UNDELIVERED message: the row is removed before any runtime ever
   * consumes it (the queued-steering "cancel" affordance). A delivered
   * message is history, never cancelable — typed refusal, not an error.
   */
  cancelMessage(messageId: number): { canceled: boolean; reason?: "not_found" | "delivered" } {
    return this.tx(() => {
      const message = this.getMessage(messageId);
      if (!message) return { canceled: false, reason: "not_found" };
      if (message.deliveredAt != null) return { canceled: false, reason: "delivered" };
      this.stmt("DELETE FROM mailbox WHERE id = ?").run(messageId);
      this.audit("mail.canceled", message.beeId, { messageId, urgency: message.urgency });
      return { canceled: true };
    });
  }

  /**
   * Change an UNDELIVERED message's urgency (the queued-steering "send now":
   * idle → now). The delivery loop honors the new urgency on its next tick —
   * `now` interrupts a running turn exactly like a fresh `--urgency now` send.
   */
  expediteMessage(messageId: number, urgency: Urgency): { applied: boolean; reason?: "not_found" | "delivered" } {
    if (!MESSAGE_URGENCIES.includes(urgency)) throw new UnknownUrgencyError(urgency);
    return this.tx(() => {
      const message = this.getMessage(messageId);
      if (!message) return { applied: false, reason: "not_found" };
      if (message.deliveredAt != null) return { applied: false, reason: "delivered" };
      this.stmt("UPDATE mailbox SET urgency = ? WHERE id = ?").run(urgency, messageId);
      this.audit("mail.expedited", message.beeId, { messageId, from: message.urgency, to: urgency });
      return { applied: true };
    });
  }

  /**
   * B4 — delivery marks delivered_generation; never twice, and only to the bee's
   * CURRENT generation (a stale consumer's mark is a recorded no-op, mirroring B6).
   */
  markDelivered(messageId: number, generation: number): { applied: boolean } {
    return this.tx(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new CoreError(`message not found: ${messageId}`);
      if (message.deliveredAt != null) {
        this.audit("mail.deliver_noop", message.beeId, {
          messageId,
          reason: "already_delivered",
          deliveredGeneration: message.deliveredGeneration,
        });
        return { applied: false };
      }
      const current = this.currentRuntime(message.beeId);
      if (!current || current.generation !== generation || !LIVE_STATES.includes(current.state)) {
        this.audit("mail.deliver_noop", message.beeId, {
          messageId,
          reason:
            current && current.generation === generation ? "generation_not_live" : "stale_generation",
          generation,
          currentGeneration: current?.generation ?? null,
        });
        return { applied: false };
      }
      const at = this.now();
      this.db
        .prepare("UPDATE mailbox SET delivered_at = ?, delivered_generation = ? WHERE id = ?")
        .run(at, generation, messageId);
      this.audit("mail.delivered", message.beeId, { messageId, deliveredAt: at, deliveredGeneration: generation });
      return { applied: true };
    });
  }

  // -------------------------------------------------------------------------
  // Output recency (a core fact; read cursors live at the client layer)
  // -------------------------------------------------------------------------

  recordOutput(beeId: string): void {
    this.tx(() => {
      this.mustGetBee(beeId);
      const at = this.now();
      this.stmt("UPDATE bees SET last_output_at = ? WHERE id = ?").run(at, beeId);
      this.audit("output.recorded", beeId, { beeId, at });
    });
  }

  // -------------------------------------------------------------------------
  // B5 / B6 — command queue with generation fencing
  // -------------------------------------------------------------------------

  /**
   * Enqueue a command. With `opts.idempotencyKey` (spec 06 §4.2 one-key rule)
   * a key that matches an EXISTING command — queued, running, or settled —
   * returns that original row at its current status with `deduped: true`
   * instead of enqueueing again. The dedup lookup runs before the bee-exists
   * check so replaying a settled `delete` returns the settled outcome rather
   * than BeeNotFoundError.
   */
  enqueueCommand(
    verb: string,
    beeId: string,
    args: Record<string, unknown> = {},
    opts: { idempotencyKey?: string } = {},
  ): EnqueuedCommand {
    if (!(VERBS as readonly string[]).includes(verb)) throw new UnknownVerbError(verb);
    const key = opts.idempotencyKey;
    if (key !== undefined && (typeof key !== "string" || key.length === 0)) {
      throw new CoreError("idempotencyKey must be a non-empty string when given");
    }
    return this.tx(() => {
      if (key !== undefined) {
        const original = this.getCommandByIdempotencyKey(key);
        if (original) {
          this.audit("command.dedup", original.beeId, {
            commandId: original.id,
            idempotencyKey: key,
            verb,
            status: original.status,
          });
          return { ...original, deduped: true };
        }
      }
      this.mustGetBee(beeId);
      const isRuntimeVerb = RUNTIME_VERBS.includes(verb as Verb);
      const targetGeneration = isRuntimeVerb ? (this.currentRuntime(beeId)?.generation ?? 0) : null;
      return { ...this.applyEnqueue(verb as Verb, beeId, args, targetGeneration, key ?? null), deduped: false };
    });
  }

  getCommandByIdempotencyKey(key: string): CommandRow | null {
    const row = this.db
      .prepare("SELECT * FROM commands WHERE idempotency_key = ?")
      .get(key) as Row | undefined;
    return row ? mapCommand(row) : null;
  }

  private applyEnqueue(
    verb: Verb,
    beeId: string,
    args: Record<string, unknown>,
    targetGeneration: number | null,
    idempotencyKey: string | null = null,
    /** Earliest claim time (deferred wake after boot failures); never earlier than now. */
    notBefore?: number,
  ): CommandRow {
    const at = this.now();
    const nextAttemptAt = notBefore === undefined ? at : Math.max(at, notBefore);
    const res = this.db
      .prepare(
        `INSERT INTO commands(verb, bee_id, args, target_generation, status, attempts, next_attempt_at, enqueued_at, idempotency_key)
         VALUES(?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(verb, beeId, JSON.stringify(args), targetGeneration, nextAttemptAt, at, idempotencyKey);
    const command: CommandRow = {
      id: Number(res.lastInsertRowid),
      verb,
      beeId,
      args,
      targetGeneration,
      status: "queued",
      attempts: 0,
      nextAttemptAt,
      enqueuedAt: at,
      finishedAt: null,
      failureCause: null,
      idempotencyKey,
    };
    this.audit("command.enqueued", beeId, { command });
    return command;
  }

  getCommand(id: number): CommandRow | null {
    const row = this.stmt("SELECT * FROM commands WHERE id = ?").get(id) as Row | undefined;
    return row ? mapCommand(row) : null;
  }

  listCommands(filter: { beeId?: string; status?: CommandRow["status"] } = {}): CommandRow[] {
    let sql = "SELECT * FROM commands";
    const where: string[] = [];
    const params: Array<string> = [];
    if (filter.beeId !== undefined) {
      where.push("bee_id = ?");
      params.push(filter.beeId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY id";
    return (this.stmt(sql).all(...params) as Row[]).map(mapCommand);
  }

  /**
   * Claim the next ready command (queued → running). B6: a command whose
   * target_generation no longer matches the bee's current generation settles `done`
   * as a recorded no-op — the intent is moot, not failed — and claiming continues.
   */
  claimNextCommand(): CommandRow | null {
    return this.tx(() => {
      for (;;) {
        const row = this.db
          .prepare(
            "SELECT * FROM commands WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 1",
          )
          .get(this.now()) as Row | undefined;
        if (!row) return null;
        const command = mapCommand(row);
        if (command.targetGeneration != null) {
          const current = this.currentRuntime(command.beeId);
          const currentGeneration = current?.generation ?? 0;
          if (currentGeneration !== command.targetGeneration) {
            const at = this.now();
            this.db
              .prepare("UPDATE commands SET status = 'done', finished_at = ? WHERE id = ?")
              .run(at, command.id);
            this.audit("command.moot", command.beeId, {
              commandId: command.id,
              verb: command.verb,
              targetGeneration: command.targetGeneration,
              currentGeneration,
              finishedAt: at,
            });
            continue;
          }
        }
        this.stmt("UPDATE commands SET status = 'running' WHERE id = ?").run(command.id);
        this.audit("command.claimed", command.beeId, { commandId: command.id });
        return { ...command, status: "running" };
      }
    });
  }

  /** Settle a claimed command as done. Re-completing a settled command is a recorded no-op. */
  completeCommand(id: number): { applied: boolean } {
    return this.tx(() => {
      const command = this.getCommand(id);
      if (!command) throw new CoreError(`command not found: ${id}`);
      if (command.status === "done") {
        this.audit("command.complete_noop", command.beeId, { commandId: id });
        return { applied: false };
      }
      if (command.status !== "running") {
        throw new CommandProtocolError(`command ${id} is ${command.status}; claim before completing`);
      }
      const at = this.now();
      this.stmt("UPDATE commands SET status = 'done', finished_at = ? WHERE id = ?").run(at, id);
      this.audit("command.completed", command.beeId, { commandId: id, finishedAt: at });
      return { applied: true };
    });
  }

  /**
   * B5 — report a (real-world-boundary) execution failure: retries with exponential
   * backoff until maxAttempts, then settles `failed` with a closed-list failure_cause
   * and sets the corresponding bee flag. No unbounded background repair.
   */
  reportCommandFailure(
    id: number,
    cause: string,
    detail?: string,
  ): { status: "queued" | "failed"; attempts: number; nextAttemptAt: number | null } {
    if (!(FLAGS as readonly string[]).includes(cause)) throw new UnknownFailureCauseError(cause);
    return this.tx(() => {
      const command = this.getCommand(id);
      if (!command) throw new CoreError(`command not found: ${id}`);
      if (command.status !== "running") {
        throw new CommandProtocolError(`command ${id} is ${command.status}; claim before reporting failure`);
      }
      const attempts = command.attempts + 1;
      const at = this.now();
      if (attempts >= this.maxAttempts) {
        this.db
          .prepare("UPDATE commands SET status = 'failed', attempts = ?, finished_at = ?, failure_cause = ? WHERE id = ?")
          .run(attempts, at, cause, id);
        this.audit("command.failed", command.beeId, {
          commandId: id,
          attempts,
          finishedAt: at,
          failureCause: cause,
        });
        // Exhausted retries land in a §4.2 flag, visibly.
        if (this.getBee(command.beeId)) {
          this.applySetFlag(
            command.beeId,
            cause as FailureCause,
            detail ?? `${command.verb} failed after ${attempts} attempts: ${cause}`,
          );
        }
        return { status: "failed" as const, attempts, nextAttemptAt: null };
      }
      const nextAttemptAt = at + this.backoffBaseMs * 2 ** (attempts - 1);
      this.db
        .prepare("UPDATE commands SET status = 'queued', attempts = ?, next_attempt_at = ? WHERE id = ?")
        .run(attempts, nextAttemptAt, id);
      this.audit("command.requeued", command.beeId, {
        commandId: id,
        attempts,
        nextAttemptAt,
        cause,
        detail: detail ?? null,
      });
      return { status: "queued" as const, attempts, nextAttemptAt };
    });
  }

  // -------------------------------------------------------------------------
  // Spec 06 §4.2 — RPC mutation idempotency records
  // -------------------------------------------------------------------------

  /**
   * Run several store writes in ONE transaction (nested calls join it). Used
   * by the daemon to make a keyed RPC mutation — lookup, the mutation itself,
   * and the result record — atomic, so a crash can never leave the mutation
   * applied but unrecorded (which would let a replay double-execute).
   */
  transact<T>(fn: () => T): T {
    return this.tx(fn);
  }

  /** The recorded result for a caller-supplied RPC idempotency key, if any. */
  lookupRpcResult(key: string): RpcIdempotencyRecord | null {
    const row = this.db
      .prepare("SELECT * FROM rpc_idempotency WHERE key = ?")
      .get(key) as Row | undefined;
    if (!row) return null;
    return {
      key: row.key as string,
      verb: row.verb as string,
      commandId: row.command_id == null ? null : Number(row.command_id),
      result: JSON.parse(row.result as string) as unknown,
      createdAt: Number(row.created_at),
    };
  }

  /**
   * Record a keyed RPC mutation's result. Retention: the newest
   * maxRpcIdempotencyRows records are kept; the oldest beyond that are
   * evicted here (bounded queue — same philosophy as B5). NOT audited and NOT
   * in StateDump: dedup records are infrastructure, like meta.
   */
  recordRpcResult(key: string, verb: string, commandId: number | null, result: unknown): void {
    this.tx(() => {
      this.db
        .prepare("INSERT INTO rpc_idempotency(key, verb, command_id, result, created_at) VALUES(?, ?, ?, ?, ?)")
        .run(key, verb, commandId, JSON.stringify(result ?? null), this.now());
      const count = Number(
        (this.stmt("SELECT COUNT(*) AS n FROM rpc_idempotency").get() as Row).n,
      );
      const excess = count - this.maxRpcIdempotencyRows;
      if (excess > 0) {
        this.db
          .prepare(
            "DELETE FROM rpc_idempotency WHERE key IN (SELECT key FROM rpc_idempotency ORDER BY created_at, rowid LIMIT ?)",
          )
          .run(excess);
      }
    });
  }

  // -------------------------------------------------------------------------
  // B7 — boot reconciliation
  // -------------------------------------------------------------------------

  /**
   * The single boot entry point: every runtime in booting/running/idle whose
   * (pid, pid_started_at) is not in livePids becomes stopped(machine_restart).
   * A reboot produces ZERO failed states. Surviving runtimes are re-adopted.
   */
  reconcileAtBoot(livePids: LivePid[]): ReconcileResult {
    return this.tx(() => {
      const live = new Set(livePids.map((p) => `${p.pid}:${p.startedAt}`));
      const rows = this.db
        .prepare("SELECT * FROM runtimes WHERE state != 'stopped' ORDER BY bee_id, generation")
        .all() as Row[];
      const stopped: ReconcileResult["stopped"] = [];
      const adopted: ReconcileResult["adopted"] = [];
      for (const raw of rows) {
        const rt = mapRuntime(raw);
        const alive =
          rt.pid != null && rt.pidStartedAt != null && live.has(`${rt.pid}:${rt.pidStartedAt}`);
        if (alive) {
          adopted.push({ beeId: rt.beeId, generation: rt.generation, pid: rt.pid as number });
          continue;
        }
        const at = this.now();
        this.db
          .prepare(
            `UPDATE runtimes SET state = 'stopped', exit_cause = 'machine_restart', updated_at = ?
             WHERE bee_id = ? AND generation = ?`,
          )
          .run(at, rt.beeId, rt.generation);
        const updated = this.db
          .prepare("SELECT * FROM runtimes WHERE bee_id = ? AND generation = ?")
          .get(rt.beeId, rt.generation) as Row;
        this.audit("runtime.updated", rt.beeId, { runtime: mapRuntime(updated) });
        stopped.push({ beeId: rt.beeId, generation: rt.generation });
      }
      this.audit("boot.reconciled", null, {
        stopped,
        adopted,
        requeuedCommandIds: this.bootRequeuedCommandIds,
      });
      return { stopped, adopted, requeuedCommandIds: this.bootRequeuedCommandIds };
    });
  }

  // -------------------------------------------------------------------------
  // B8 — derived reads (the ONLY place these questions are answered)
  // -------------------------------------------------------------------------

  view(beeId: string, opts: { readCursor?: number } = {}): BeeView {
    const bee = this.getBee(beeId);
    return deriveBeeView(
      beeId,
      bee,
      bee ? this.currentRuntime(beeId) : null,
      bee ? this.activeFlags(beeId).map((f) => f.flag) : [],
      opts,
    );
  }

  /**
   * Batch the authoritative list projection into three SQLite reads: bees,
   * latest runtimes, and active flags. The old `listBees().map(view)` path
   * repeated getBee/currentRuntime/activeFlags for every row (and the daemon
   * then repeated getBee/currentRuntime once more while shaping the RPC),
   * making `hive ls` scale as hundreds of queries on an ordinary hive.
   */
  listBeeViewRows(lifecycle: string | null = null): BeeViewRow[] {
    const bees = this.listBees().filter((bee) => lifecycle === null || bee.lifecycle === lifecycle);
    if (bees.length === 0) return [];
    const selected = new Set(bees.map((bee) => bee.id));

    const runtimes = (
      this.stmt(
        `SELECT runtime.*
         FROM runtimes AS runtime
         LEFT JOIN runtimes AS newer
           ON newer.bee_id = runtime.bee_id AND newer.generation > runtime.generation
         WHERE newer.bee_id IS NULL
         ORDER BY runtime.bee_id`,
      ).all() as Row[]
    ).map(mapRuntime);
    const runtimeByBee = new Map(
      runtimes
        .filter((runtime) => selected.has(runtime.beeId))
        .map((runtime) => [runtime.beeId, runtime] as const),
    );

    const flagsByBee = new Map<string, Flag[]>();
    const activeFlagRows = this.stmt(
      "SELECT * FROM flags WHERE cleared_at IS NULL ORDER BY bee_id, id",
    ).all() as Row[];
    for (const raw of activeFlagRows) {
      const row = mapFlag(raw);
      if (!selected.has(row.beeId)) continue;
      flagsByBee.set(row.beeId, [...(flagsByBee.get(row.beeId) ?? []), row.flag]);
    }

    return bees.map((bee) => {
      const runtime = runtimeByBee.get(bee.id) ?? null;
      return {
        bee,
        runtime,
        view: deriveBeeView(bee.id, bee, runtime, flagsByBee.get(bee.id) ?? []),
      };
    });
  }

  views(): BeeView[] {
    return this.listBeeViewRows().map((row) => row.view);
  }

  // -------------------------------------------------------------------------
  // Templates + tracks (spec 06 §1.4.1) — hive-owned registries
  // -------------------------------------------------------------------------

  getTemplate(id: string): TemplateRow | null {
    const row = this.stmt("SELECT * FROM templates WHERE id = ?").get(id) as Row | undefined;
    return row ? mapTemplate(row) : null;
  }

  getTemplateByName(scope: TemplateRow["scope"], name: string): TemplateRow | null {
    const row = this.stmt("SELECT * FROM templates WHERE scope = ? AND name = ?").get(scope, name) as
      | Row
      | undefined;
    return row ? mapTemplate(row) : null;
  }

  listTemplates(filter: { scope?: TemplateRow["scope"] } = {}): TemplateRow[] {
    const rows = (
      filter.scope
        ? this.stmt("SELECT * FROM templates WHERE scope = ? ORDER BY id").all(filter.scope)
        : this.stmt("SELECT * FROM templates ORDER BY id").all()
    ) as Row[];
    return rows.map(mapTemplate);
  }

  /**
   * Idempotent upsert. Match order: by `id` when given, else by (scope, name).
   * An id that matches nothing while (scope, name) matches a DIFFERENT row is a
   * NameConflictError (names are unique per scope; the caller decides).
   * Identical content = `unchanged`: no write, no audit row, timestamps untouched.
   */
  putTemplate(input: PutTemplateInput): { template: TemplateRow; outcome: PutOutcome } {
    return this.tx(() => {
      const fields = normalizeTemplate(input.fields, input);
      const target = this.resolvePutTarget(
        input.id,
        () => (input.id ? this.getTemplate(input.id) : null),
        () => this.getTemplateByName(fields.scope, fields.name),
        "template",
      );
      const at = this.now();
      if (target) {
        if (fieldsEqual(templateFieldsOf(target), fields)) return { template: target, outcome: "unchanged" };
        this.db
          .prepare(
            `UPDATE templates SET name = ?, scope = ?, source = ?, description = ?, agent = ?, substrate = ?, model = ?,
               effort = ?, args = ?, prompt = ?, preamble = ?, preamble_enabled = ?, cwd_policy = ?, cwd = ?, env = ?,
               account = ?, yolo = ?, tags = ?, updated_at = ? WHERE id = ?`,
          )
          .run(...templateBindings(fields), at, target.id);
        const template = this.getTemplate(target.id) as TemplateRow;
        this.audit("template.put", null, { template, outcome: "updated" });
        return { template, outcome: "updated" };
      }
      const id = input.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO templates(name, scope, source, description, agent, substrate, model, effort, args, prompt,
             preamble, preamble_enabled, cwd_policy, cwd, env, account, yolo, tags, updated_at, id, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...templateBindings(fields), at, id, at);
      const template = this.getTemplate(id) as TemplateRow;
      this.audit("template.put", null, { template, outcome: "created" });
      return { template, outcome: "created" };
    });
  }

  deleteTemplate(id: string): TemplateRow {
    return this.tx(() => {
      const template = this.getTemplate(id);
      if (!template) throw new TemplateNotFoundError(id);
      this.stmt("DELETE FROM templates WHERE id = ?").run(id);
      this.audit("template.deleted", null, { templateId: id, deletedAt: this.now() });
      return template;
    });
  }

  getTrack(id: string): TrackRow | null {
    const row = this.stmt("SELECT * FROM tracks WHERE id = ?").get(id) as Row | undefined;
    return row ? mapTrack(row) : null;
  }

  getTrackByName(scope: TrackRow["scope"], name: string): TrackRow | null {
    const row = this.stmt("SELECT * FROM tracks WHERE scope = ? AND name = ?").get(scope, name) as Row | undefined;
    return row ? mapTrack(row) : null;
  }

  listTracks(filter: { scope?: TrackRow["scope"] } = {}): TrackRow[] {
    const rows = (
      filter.scope
        ? this.stmt("SELECT * FROM tracks WHERE scope = ? ORDER BY id").all(filter.scope)
        : this.stmt("SELECT * FROM tracks ORDER BY id").all()
    ) as Row[];
    return rows.map(mapTrack);
  }

  /** Same idempotent upsert contract as putTemplate. */
  putTrack(input: PutTrackInput): { track: TrackRow; outcome: PutOutcome } {
    return this.tx(() => {
      const fields = normalizeTrack(input.fields, input);
      const target = this.resolvePutTarget(
        input.id,
        () => (input.id ? this.getTrack(input.id) : null),
        () => this.getTrackByName(fields.scope, fields.name),
        "track",
      );
      const at = this.now();
      if (target) {
        if (fieldsEqual(trackFieldsOf(target), fields)) return { track: target, outcome: "unchanged" };
        this.db
          .prepare(
            "UPDATE tracks SET name = ?, scope = ?, source = ?, description = ?, steps = ?, tags = ?, updated_at = ? WHERE id = ?",
          )
          .run(...trackBindings(fields), at, target.id);
        const track = this.getTrack(target.id) as TrackRow;
        this.audit("track.put", null, { track, outcome: "updated" });
        return { track, outcome: "updated" };
      }
      const id = input.id ?? randomUUID();
      this.db
        .prepare(
          "INSERT INTO tracks(name, scope, source, description, steps, tags, updated_at, id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(...trackBindings(fields), at, id, at);
      const track = this.getTrack(id) as TrackRow;
      this.audit("track.put", null, { track, outcome: "created" });
      return { track, outcome: "created" };
    });
  }

  deleteTrack(id: string): TrackRow {
    return this.tx(() => {
      const track = this.getTrack(id);
      if (!track) throw new TrackNotFoundError(id);
      this.stmt("DELETE FROM tracks WHERE id = ?").run(id);
      this.audit("track.deleted", null, { trackId: id, deletedAt: this.now() });
      return track;
    });
  }

  private resolvePutTarget<T extends { id: string; name: string; scope: string }>(
    wantedId: string | undefined,
    byId: () => T | null,
    byName: () => T | null,
    what: string,
  ): T | null {
    const idMatch = byId();
    const nameMatch = byName();
    if (idMatch) {
      if (nameMatch && nameMatch.id !== idMatch.id) {
        throw new NameConflictError(
          `${what} name '${nameMatch.name}' in scope '${nameMatch.scope}' is already taken by ${nameMatch.id} (put targets ${idMatch.id})`,
        );
      }
      return idMatch;
    }
    if (nameMatch && wantedId !== undefined && wantedId !== nameMatch.id) {
      throw new NameConflictError(
        `${what} name '${nameMatch.name}' in scope '${nameMatch.scope}' already exists as ${nameMatch.id}; refusing to create ${wantedId} — delete it or import without an id`,
      );
    }
    return nameMatch;
  }

  // -------------------------------------------------------------------------
  // v6 — questions (a bee asks the operator; the answer comes back as mail)
  // -------------------------------------------------------------------------

  askQuestion(beeId: string, input: AskQuestionInput): QuestionRow {
    const text = requireNonEmpty(input.text, "askQuestion: text");
    const options = input.options === undefined || input.options === null ? null : normalizeStringList(input.options, "askQuestion: options");
    return this.tx(() => {
      this.mustGetBee(beeId);
      const id = input.id ?? randomUUID();
      if (this.getQuestion(id)) throw new CoreError(`question already exists: ${id}`);
      const at = this.now();
      const generation = this.currentRuntime(beeId)?.generation ?? null;
      this.db
        .prepare(
          `INSERT INTO questions(id, bee_id, generation, text, options, status, answer, asked_at, answered_at, answered_by, delivery_message_id)
           VALUES(?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL, NULL)`,
        )
        .run(id, beeId, generation, text, options === null ? null : JSON.stringify(options), at);
      const question = this.getQuestion(id) as QuestionRow;
      this.audit("question.asked", beeId, { question });
      return question;
    });
  }

  /**
   * Answer an open question: the row is marked answered AND the answer is
   * delivered to the bee as an ordinary mailbox message (clearly prefixed),
   * in the same transaction — send()'s wake/unarchive rules apply verbatim.
   * Answering a non-open question is a QuestionNotOpenError.
   */
  answerQuestion(questionId: string, answer: string, opts: { answeredBy?: string } = {}): AnswerResult {
    const text = requireNonEmpty(answer, "answerQuestion: answer");
    return this.tx(() => {
      const question = this.getQuestion(questionId);
      if (!question) throw new QuestionNotFoundError(questionId);
      if (question.status !== "open") {
        throw new QuestionNotOpenError(`question ${questionId} is already ${question.status} (answered at ${question.answeredAt})`);
      }
      const answeredBy = opts.answeredBy ?? "operator";
      const body = `[answer to question ${questionId}] ${text}\n\n(question was: ${question.text})`;
      // Urgency ruling: an answer is "as soon as convenient" — `next`, never an
      // interrupt (the bee asked; it is presumably working toward the answer).
      const send = this.send(question.beeId, body, { sender: answeredBy, urgency: "next" });
      const at = this.now();
      this.db
        .prepare(
          "UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, answered_by = ?, delivery_message_id = ? WHERE id = ?",
        )
        .run(text, at, answeredBy, send.message.id, questionId);
      const updated = this.getQuestion(questionId) as QuestionRow;
      this.audit("question.answered", question.beeId, {
        questionId,
        beeId: question.beeId,
        answer: text,
        answeredAt: at,
        answeredBy,
        deliveryMessageId: send.message.id,
      });
      return { question: updated, send };
    });
  }

  getQuestion(id: string): QuestionRow | null {
    const row = this.stmt("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapQuestion(row) : null;
  }

  listQuestions(filter: { beeId?: string; open?: boolean } = {}): QuestionRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.beeId !== undefined) {
      where.push("bee_id = ?");
      params.push(filter.beeId);
    }
    if (filter.open === true) where.push("status = 'open'");
    else if (filter.open === false) where.push("status = 'answered'");
    const sql = `SELECT * FROM questions${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY asked_at, rowid`;
    return (this.stmt(sql).all(...params) as Row[]).map(mapQuestion);
  }

  // -------------------------------------------------------------------------
  // v6 — seals
  // -------------------------------------------------------------------------

  createSeal(beeId: string, input: CreateSealInput): SealRow {
    const title = requireNonEmpty(input.title, "createSeal: title");
    if (typeof input.body !== "string") throw new CoreError("createSeal: body must be a string");
    const refs = normalizeStringList(input.refs, "createSeal: refs");
    return this.tx(() => {
      this.mustGetBee(beeId);
      const id = input.id ?? randomUUID();
      if (this.getSeal(id)) throw new CoreError(`seal already exists: ${id}`);
      const at = this.now();
      const generation = this.currentRuntime(beeId)?.generation ?? null;
      this.db
        .prepare("INSERT INTO seals(id, bee_id, generation, title, body, refs, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
        .run(id, beeId, generation, title, input.body, JSON.stringify(refs), at);
      const seal = this.getSeal(id) as SealRow;
      this.audit("seal.created", beeId, { seal });
      return seal;
    });
  }

  getSeal(id: string): SealRow | null {
    const row = this.stmt("SELECT * FROM seals WHERE id = ?").get(id) as Row | undefined;
    return row ? mapSeal(row) : null;
  }

  mustGetSeal(id: string): SealRow {
    const seal = this.getSeal(id);
    if (!seal) throw new SealNotFoundError(id);
    return seal;
  }

  listSeals(filter: { beeId?: string } = {}): SealRow[] {
    const rows = (
      filter.beeId !== undefined
        ? this.stmt("SELECT * FROM seals WHERE bee_id = ? ORDER BY created_at, rowid").all(filter.beeId)
        : this.stmt("SELECT * FROM seals ORDER BY created_at, rowid").all()
    ) as Row[];
    return rows.map(mapSeal);
  }

  // -------------------------------------------------------------------------
  // v7 — accounts (spec 08): identity rows, limits snapshots, selection cursor
  // -------------------------------------------------------------------------

  private mustGetAccount(id: string): AccountRow {
    const account = this.getAccount(id);
    if (!account) throw new AccountNotFoundError(id);
    return account;
  }

  getAccount(id: string): AccountRow | null {
    const row = this.stmt("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
    return row ? mapAccount(row) : null;
  }

  /** Accounts, registration order (added_at, then id) — the selector's deterministic tie-break order. */
  listAccounts(filter: { harness?: string } = {}): AccountRow[] {
    const rows = (
      filter.harness !== undefined
        ? this.stmt("SELECT * FROM accounts WHERE harness = ? ORDER BY added_at, id").all(filter.harness)
        : this.stmt("SELECT * FROM accounts ORDER BY added_at, id").all()
    ) as Row[];
    return rows.map(mapAccount);
  }

  /**
   * v7 — register an account (one row = one provider identity = one
   * run-home). Audited as `account.put {account, outcome:"created"}`; every
   * later field change is `account.put {account, outcome:"updated", changed}`
   * so the mirror row is always the payload verbatim.
   */
  createAccount(input: CreateAccountInput): AccountRow {
    const id = requireNonEmpty(input.id, "createAccount: id");
    const harness = requireNonEmpty(input.harness, "createAccount: harness");
    const homePath = requireNonEmpty(input.homePath, "createAccount: homePath");
    const label = requireNonEmpty(input.label, "createAccount: label");
    if (id === "auto") throw new CoreError("createAccount: 'auto' is reserved (the selection intent)");
    const status = input.status ?? "ok";
    if (!(ACCOUNT_STATUSES as readonly string[]).includes(status)) throw new CoreError(`createAccount: status must be one of ${ACCOUNT_STATUSES.join("|")}`);
    const penalty = normalizePenalty(input.penalty ?? 0, "createAccount");
    return this.tx(() => {
      if (this.getAccount(id)) throw new CoreError(`account already exists: ${id}`);
      const at = this.now();
      const addedAt = input.addedAt ?? at;
      if (!Number.isFinite(addedAt)) throw new CoreError("createAccount: addedAt must be a finite epoch-ms number");
      this.db
        .prepare(
          `INSERT INTO accounts(id, harness, home_path, label, status, penalty, last_login_at, exhausted_at, added_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, harness, homePath, label, status, penalty, input.lastLoginAt ?? null, addedAt, at);
      const account = this.mustGetAccount(id);
      this.audit("account.put", null, { account, outcome: "created" });
      return account;
    });
  }

  /** Bees (any lifecycle) bound to the account, by id. */
  beesOnAccount(accountId: string): BeeRow[] {
    const rows = this.stmt("SELECT * FROM bees WHERE account = ? ORDER BY id").all(accountId) as Row[];
    return rows.map(mapBee);
  }

  /**
   * v7 — remove an account. REFUSES (typed AccountReferencedError) while any
   * bee references it — swap or delete them first. The limits row cascades.
   */
  removeAccount(id: string): AccountRow {
    return this.tx(() => {
      const account = this.mustGetAccount(id);
      const referenced = this.beesOnAccount(id).map((b) => b.id);
      if (referenced.length > 0) throw new AccountReferencedError(id, referenced);
      this.stmt("DELETE FROM accounts WHERE id = ?").run(id);
      // A cursor pointing at the removed account is stale but harmless (the
      // rotation treats an unknown last id as "start over"); drop it anyway
      // so the dump stays tidy.
      const cursor = this.getSelectionCursor(account.harness);
      if (cursor && cursor.lastAccountId === id) {
        this.stmt("DELETE FROM selection_cursors WHERE harness = ?").run(account.harness);
      }
      this.audit("account.removed", null, {
        accountId: id,
        harness: account.harness,
        removedAt: this.now(),
        cursorCleared: cursor?.lastAccountId === id,
      });
      return account;
    });
  }

  private applyAccountUpdate(id: string, patch: Partial<Pick<AccountRow, "status" | "penalty" | "lastLoginAt" | "exhaustedAt" | "homePath" | "label">>, reason: string | null): { account: AccountRow; applied: boolean } {
    const before = this.mustGetAccount(id);
    const next: AccountRow = { ...before, ...patch };
    const changed = (Object.keys(patch) as Array<keyof typeof patch>).filter((k) => before[k] !== next[k]);
    if (changed.length === 0) return { account: before, applied: false };
    const at = this.now();
    this.db
      .prepare(
        "UPDATE accounts SET status = ?, penalty = ?, last_login_at = ?, exhausted_at = ?, home_path = ?, label = ?, updated_at = ? WHERE id = ?",
      )
      .run(next.status, next.penalty, next.lastLoginAt, next.exhaustedAt, next.homePath, next.label, at, id);
    const account = this.mustGetAccount(id);
    this.audit("account.put", null, { account, outcome: "updated", changed, previous: Object.fromEntries(changed.map((k) => [k, before[k]])), reason });
    return { account, applied: true };
  }

  /**
   * v7 — set the account status (ok | auth_needed | paused). `reason` is the
   * evidence (audit only). Identical = silent no-op.
   */
  setAccountStatus(id: string, status: AccountStatus, reason?: string): { account: AccountRow; applied: boolean } {
    if (!(ACCOUNT_STATUSES as readonly string[]).includes(status)) throw new CoreError(`setAccountStatus: status must be one of ${ACCOUNT_STATUSES.join("|")}`);
    return this.tx(() => this.applyAccountUpdate(id, { status }, reason ?? null));
  }

  /** v7 — the operator's placement penalty (0..100 effective-load points; 0 clears). */
  setAccountPenalty(id: string, penalty: number): { account: AccountRow; applied: boolean } {
    const value = normalizePenalty(penalty, "setAccountPenalty");
    return this.tx(() => this.applyAccountUpdate(id, { penalty: value }, "operator"));
  }

  /** v7 — a completed login: status ok + last_login_at (contrary evidence for auth_needed). */
  recordAccountLogin(id: string, at?: number): { account: AccountRow; applied: boolean } {
    return this.tx(() => {
      const before = this.mustGetAccount(id);
      const loginAt = at ?? this.now();
      // A paused account stays paused (the operator parked it); auth_needed clears.
      const status: AccountStatus = before.status === "paused" ? "paused" : "ok";
      return this.applyAccountUpdate(id, { status, lastLoginAt: loginAt }, "login completed");
    });
  }

  /** v7 — rate-limit exhaustion evidence on the account (rotation cool-off). null clears. */
  recordAccountExhaustion(id: string, at: number | null): { account: AccountRow; applied: boolean } {
    return this.tx(() => this.applyAccountUpdate(id, { exhaustedAt: at }, at === null ? "provider served a turn" : "rate limit evidence"));
  }

  /** v7 — relabel / re-home (importer + operator edits). */
  updateAccountFields(id: string, patch: { homePath?: string; label?: string }): { account: AccountRow; applied: boolean } {
    const next: { homePath?: string; label?: string } = {};
    if (patch.homePath !== undefined) next.homePath = requireNonEmpty(patch.homePath, "updateAccountFields: homePath");
    if (patch.label !== undefined) next.label = requireNonEmpty(patch.label, "updateAccountFields: label");
    return this.tx(() => this.applyAccountUpdate(id, next, "fields"));
  }

  /**
   * v7 — bind (or unbind: null) a bee to an account. The account must exist;
   * the caller (daemon) enforces harness match and derives the home env.
   * Audited `bee.account_set {beeId, account, previous}`; identical = no-op.
   */
  setBeeAccount(beeId: string, account: string | null): { bee: BeeRow; applied: boolean } {
    if (account !== null && (typeof account !== "string" || account.length === 0)) throw new CoreError("setBeeAccount: account must be a non-empty string or null");
    if (account === "auto") throw new CoreError("setBeeAccount: account 'auto' is a selection intent, never a stored binding");
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (account !== null) this.mustGetAccount(account);
      if (bee.account === account) return { bee, applied: false };
      this.stmt("UPDATE bees SET account = ? WHERE id = ?").run(account, beeId);
      this.audit("bee.account_set", beeId, { beeId, account, previous: bee.account });
      return { bee: this.mustGetBee(beeId), applied: true };
    });
  }

  /**
   * v7 — replace a bee's env overrides (the home-env mechanism the account
   * binding derives). Audited `bee.env_set {beeId, env, previous}`; identical
   * = no-op. Takes effect on the NEXT runtime.
   */
  setBeeEnv(beeId: string, env: Record<string, string>): { bee: BeeRow; applied: boolean } {
    if (env === null || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) {
      throw new CoreError("setBeeEnv: env must be an object of strings");
    }
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      const next = { ...env };
      if (JSON.stringify(bee.env) === JSON.stringify(next)) return { bee, applied: false };
      this.stmt("UPDATE bees SET env = ? WHERE id = ?").run(JSON.stringify(next), beeId);
      this.audit("bee.env_set", beeId, { beeId, env: next, previous: bee.env });
      return { bee: this.mustGetBee(beeId), applied: true };
    });
  }

  /**
   * v7 — set the fork seed / provider session pair directly (bee.swapAccount:
   * a claude cross-account move resumes the source conversation under a NEW
   * session id via `--resume <seed> --fork-session`, exactly like bee.fork).
   * Audited `bee.session_rekeyed {beeId, forkSeed, previousProviderSessionId}`.
   */
  rekeyBeeSession(beeId: string): { bee: BeeRow; applied: boolean } {
    return this.tx(() => {
      const bee = this.mustGetBee(beeId);
      if (!bee.providerSessionId) return { bee, applied: false };
      this.stmt("UPDATE bees SET fork_seed = ?, provider_session_id = NULL WHERE id = ?").run(bee.providerSessionId, beeId);
      this.audit("bee.session_rekeyed", beeId, { beeId, forkSeed: bee.providerSessionId, previousProviderSessionId: bee.providerSessionId });
      return { bee: this.mustGetBee(beeId), applied: true };
    });
  }

  getAccountLimits(accountId: string): AccountLimitsRow | null {
    const row = this.stmt("SELECT * FROM account_limits WHERE account = ?").get(accountId) as Row | undefined;
    return row ? mapAccountLimits(row) : null;
  }

  listAccountLimits(): AccountLimitsRow[] {
    return (this.stmt("SELECT * FROM account_limits ORDER BY account").all() as Row[]).map(mapAccountLimits);
  }

  /** v14 — append one immutable generator attempt. Telemetry is not audit-replayed state. */
  recordNamingUsage(input: RecordNamingUsageInput): NamingUsageRow {
    if (!input.backend.trim() || !input.provider.trim() || !input.model.trim()) {
      throw new CoreError("naming usage backend, provider, and model must be non-empty");
    }
    if (!(NAMING_USAGE_STATUSES as readonly string[]).includes(input.status)) {
      throw new CoreError(`unknown naming usage status: ${String(input.status)}`);
    }
    const latencyMs = nonNegativeInteger(input.latencyMs, "latencyMs");
    const recordedAt = nonNegativeInteger(input.recordedAt ?? this.now(), "recordedAt");
    const values = {
      inputTokens: nonNegativeInteger(input.inputTokens, "inputTokens"),
      cachedInputTokens: nonNegativeInteger(input.cachedInputTokens, "cachedInputTokens"),
      cacheWriteInputTokens: nonNegativeInteger(input.cacheWriteInputTokens, "cacheWriteInputTokens"),
      outputTokens: nonNegativeInteger(input.outputTokens, "outputTokens"),
      reasoningTokens: nonNegativeInteger(input.reasoningTokens, "reasoningTokens"),
      totalTokens: nonNegativeInteger(input.totalTokens, "totalTokens"),
      inputRateNanoUsd: nonNegativeInteger(input.inputRateNanoUsd, "inputRateNanoUsd"),
      cachedInputRateNanoUsd: nonNegativeInteger(input.cachedInputRateNanoUsd, "cachedInputRateNanoUsd"),
      cacheWriteRateNanoUsd: nonNegativeInteger(input.cacheWriteRateNanoUsd, "cacheWriteRateNanoUsd"),
      outputRateNanoUsd: nonNegativeInteger(input.outputRateNanoUsd, "outputRateNanoUsd"),
      estimatedCostNanoUsd: nonNegativeInteger(input.estimatedCostNanoUsd, "estimatedCostNanoUsd"),
    };
    return this.tx(() => {
      const inserted = this.stmt(
        `INSERT INTO naming_usage(
           bee_id, backend, provider, model, status, latency_ms,
           input_tokens, cached_input_tokens, cache_write_input_tokens,
           output_tokens, reasoning_tokens, total_tokens,
           input_rate_nano_usd, cached_input_rate_nano_usd,
           cache_write_rate_nano_usd, output_rate_nano_usd,
           estimated_cost_nano_usd, response_id, request_id, error, recorded_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.beeId ?? null,
        input.backend.trim(),
        input.provider.trim(),
        input.model.trim(),
        input.status,
        latencyMs,
        values.inputTokens,
        values.cachedInputTokens,
        values.cacheWriteInputTokens,
        values.outputTokens,
        values.reasoningTokens,
        values.totalTokens,
        values.inputRateNanoUsd,
        values.cachedInputRateNanoUsd,
        values.cacheWriteRateNanoUsd,
        values.outputRateNanoUsd,
        values.estimatedCostNanoUsd,
        input.responseId ?? null,
        input.requestId ?? null,
        input.error?.slice(0, 500) ?? null,
        recordedAt,
      );
      const row = this.stmt("SELECT * FROM naming_usage WHERE id = ?").get(inserted.lastInsertRowid) as Row;
      return mapNamingUsage(row);
    });
  }

  /** Newest immutable attempts, primarily for diagnostics and tests. */
  listNamingUsage(limit = 100): NamingUsageRow[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new CoreError("naming usage limit must be an integer from 1 to 10000");
    }
    return (this.stmt("SELECT * FROM naming_usage ORDER BY recorded_at DESC, id DESC LIMIT ?").all(limit) as Row[])
      .map(mapNamingUsage);
  }

  /** All-time naming usage aggregate; monetary sums include only priced rows. */
  namingUsageSummary(): NamingUsageSummary {
    const select = `
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN estimated_cost_nano_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS priced_requests,
      COALESCE(SUM(CASE WHEN estimated_cost_nano_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_requests,
      COALESCE(SUM(estimated_cost_nano_usd), 0) AS estimated_cost_nano_usd,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      AVG(latency_ms) AS average_latency_ms,
      MIN(recorded_at) AS first_recorded_at,
      MAX(recorded_at) AS last_recorded_at`;
    const total = this.stmt(`SELECT ${select} FROM naming_usage`).get() as Row;
    const byModel = this.stmt(
      `SELECT backend, provider, model, ${select}
       FROM naming_usage
       GROUP BY backend, provider, model
       ORDER BY estimated_cost_nano_usd DESC, requests DESC, backend, model`,
    ).all() as Row[];
    const common = (row: Row) => ({
      requests: Number(row.requests ?? 0),
      succeeded: Number(row.succeeded ?? 0),
      failed: Number(row.failed ?? 0),
      pricedRequests: Number(row.priced_requests ?? 0),
      unpricedRequests: Number(row.unpriced_requests ?? 0),
      estimatedCostNanoUsd: Number(row.estimated_cost_nano_usd ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      cachedInputTokens: Number(row.cached_input_tokens ?? 0),
      cacheWriteInputTokens: Number(row.cache_write_input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      reasoningTokens: Number(row.reasoning_tokens ?? 0),
      averageLatencyMs: row.average_latency_ms == null ? null : Number(row.average_latency_ms),
      lastRecordedAt: numOrNull(row.last_recorded_at),
    });
    return {
      ...common(total),
      firstRecordedAt: numOrNull(total.first_recorded_at),
      byModel: byModel.map((row) => ({
        backend: String(row.backend),
        provider: String(row.provider),
        model: String(row.model),
        ...common(row),
      })),
    };
  }

  /** v7 — replace the account's limits snapshot (one row per account). Audited `account_limits.put {limits}`. */
  putAccountLimits(accountId: string, input: PutAccountLimitsInput): AccountLimitsRow {
    return this.tx(() => {
      this.mustGetAccount(accountId);
      const at = input.fetchedAt ?? this.now();
      const w = (x: PutAccountLimitsInput["weekly"]) =>
        x ? [x.usedPercent, x.resetsAt ?? null, x.windowMinutes ?? null] : [null, null, null];
      this.db
        .prepare(
          `INSERT INTO account_limits(account, fetched_at, readable, unreadable_reason, error, plan,
             five_hour_pct, five_hour_resets_at, five_hour_minutes,
             weekly_pct, weekly_resets_at, weekly_minutes,
             fable_weekly_pct, fable_resets_at, fable_minutes,
             display_windows)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account) DO UPDATE SET
             fetched_at = excluded.fetched_at, readable = excluded.readable, unreadable_reason = excluded.unreadable_reason, error = excluded.error, plan = excluded.plan,
             five_hour_pct = excluded.five_hour_pct, five_hour_resets_at = excluded.five_hour_resets_at, five_hour_minutes = excluded.five_hour_minutes,
             weekly_pct = excluded.weekly_pct, weekly_resets_at = excluded.weekly_resets_at, weekly_minutes = excluded.weekly_minutes,
             fable_weekly_pct = excluded.fable_weekly_pct, fable_resets_at = excluded.fable_resets_at, fable_minutes = excluded.fable_minutes,
             display_windows = excluded.display_windows`,
        )
        .run(
          accountId,
          at,
          input.readable ? 1 : 0,
          input.readable ? null : (input.unreadableReason ?? "provider_error"),
          input.error ?? null,
          input.plan ?? null,
          ...w(input.fiveHour),
          ...w(input.weekly),
          ...w(input.fableWeekly),
          JSON.stringify((input.displayWindows ?? []).map((window) => ({
            key: window.key,
            label: window.label,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt ?? null,
            windowMinutes: window.windowMinutes ?? null,
          }))),
        );
      const limits = this.getAccountLimits(accountId) as AccountLimitsRow;
      this.audit("account_limits.put", null, { limits });
      return limits;
    });
  }

  getSelectionCursor(harness: string): SelectionCursorRow | null {
    const row = this.stmt("SELECT * FROM selection_cursors WHERE harness = ?").get(harness) as Row | undefined;
    return row ? mapSelectionCursor(row) : null;
  }

  listSelectionCursors(): SelectionCursorRow[] {
    return (this.stmt("SELECT * FROM selection_cursors ORDER BY harness").all() as Row[]).map(mapSelectionCursor);
  }

  /** v7 — advance the per-harness near-tie rotation cursor. Audited `selection_cursor.set`. */
  setSelectionCursor(harness: string, lastAccountId: string): SelectionCursorRow {
    requireNonEmpty(harness, "setSelectionCursor: harness");
    requireNonEmpty(lastAccountId, "setSelectionCursor: lastAccountId");
    return this.tx(() => {
      const at = this.now();
      this.db
        .prepare(
          "INSERT INTO selection_cursors(harness, last_account_id, updated_at) VALUES(?, ?, ?) ON CONFLICT(harness) DO UPDATE SET last_account_id = excluded.last_account_id, updated_at = excluded.updated_at",
        )
        .run(harness, lastAccountId, at);
      const cursor = this.getSelectionCursor(harness) as SelectionCursorRow;
      this.audit("selection_cursor.set", null, { cursor });
      return cursor;
    });
  }

  // -------------------------------------------------------------------------
  // v11 — agent task lists
  // -------------------------------------------------------------------------

  addTask(input: AddTaskInput): { task: TaskRow; warning?: string } {
    const title = requireNonEmpty(input.title, "addTask: title");
    if (title.includes("\n")) throw new CoreError("addTask: title must be a single line (use body for detail)");
    if (title.length > MAX_TASK_TITLE_LENGTH) {
      throw new CoreError(`addTask: title exceeds ${MAX_TASK_TITLE_LENGTH} characters (use body for detail)`);
    }
    const parsed = parseTaskListRef(input.list);
    const context = input.context === undefined || input.context === null ? null : parseTaskContext(input.context);
    const { auto, warning } = resolveTaskAuto(input.originKind, input.autoRequested);
    return this.tx(() => {
      let list: string;
      let beeId: string | null;
      if (parsed.kind === "bee") {
        this.mustGetBee(parsed.name);
        beeId = parsed.name;
        list = beeTaskList(parsed.name);
      } else {
        beeId = null;
        list = formatTaskList("shared", parsed.name);
      }
      const id = input.id ?? `${TASK_ID_PREFIX}${randomUUID()}`;
      if (this.getTask(id)) throw new CoreError(`task already exists: ${id}`);
      const existing = this.listTasks({ list });
      const maxOrder = existing.reduce((max, t) => Math.max(max, t.order), 0);
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO tasks(id, list, bee_id, title, body, context, origin_kind, origin_sender, auto, status, claimed_by, sort_order, quest_id, mailbox_message_id, fed_at, stalled_at, blocked_reason, created_at, updated_at, closed_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          id,
          list,
          beeId,
          title,
          input.body ?? null,
          context === null ? null : JSON.stringify(context),
          input.originKind,
          input.originSender,
          auto ? 1 : 0,
          maxOrder + ORDER_STEP,
          input.questId ?? null,
          at,
          at,
        );
      const task = this.getTask(id) as TaskRow;
      this.audit("task.put", beeId, { task, outcome: "created" });
      return { task, ...(warning ? { warning } : {}) };
    });
  }

  getTask(id: string): TaskRow | null {
    const row = this.stmt("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? mapTask(row) : null;
  }

  mustGetTask(id: string): TaskRow {
    const task = this.getTask(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  listTasks(filter: { list?: string; beeId?: string; statuses?: TaskStatus[] } = {}): TaskRow[] {
    const where: string[] = [];
    const params: Array<string> = [];
    if (filter.list !== undefined) {
      where.push("list = ?");
      params.push(filter.list);
    }
    if (filter.beeId !== undefined) {
      where.push("bee_id = ?");
      params.push(filter.beeId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      params.push(...filter.statuses);
    }
    const sql = `SELECT * FROM tasks${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sort_order, id`;
    return (this.stmt(sql).all(...params) as Row[]).map(mapTask);
  }

  listTaskLists(): Array<{ id: string; total: number }> {
    const rows = this.stmt("SELECT list AS id, COUNT(*) AS total FROM tasks GROUP BY list ORDER BY list").all() as Row[];
    return rows.map((r) => ({ id: String(r.id), total: Number(r.total) }));
  }

  transitionTask(id: string, action: TaskTransitionAction, opts: TransitionTaskInput = {}): TaskRow {
    const rule = TASK_TRANSITIONS[action];
    return this.tx(() => {
      const current = this.mustGetTask(id);
      if (!rule.from.includes(current.status)) {
        throw new CoreError(`task ${id} is ${current.status}; ${action} requires one of: ${rule.from.join(", ")}`);
      }
      const at = this.now();
      let mailboxMessageId = current.mailboxMessageId;
      if (current.status === "queued" && CLOSING_TASK_ACTIONS.includes(action) && current.mailboxMessageId != null) {
        const canceled = this.cancelMessage(current.mailboxMessageId);
        if (canceled.canceled) mailboxMessageId = null;
        else mailboxMessageId = null;
      }
      const closedAt = CLOSING_TASK_ACTIONS.includes(action) ? at : action === "start" ? null : current.closedAt;
      const blockedReason = action === "block" ? (opts.reason ?? current.blockedReason) : action === "start" ? null : current.blockedReason;
      this.stmt(
        "UPDATE tasks SET status = ?, updated_at = ?, closed_at = ?, blocked_reason = ?, mailbox_message_id = ? WHERE id = ?",
      ).run(rule.to, at, closedAt, blockedReason, mailboxMessageId, id);
      const task = this.getTask(id) as TaskRow;
      this.audit("task.put", task.beeId, { task, outcome: "updated" });
      return task;
    });
  }

  claimTask(list: string, claimant: string): TaskRow | null {
    const who = requireNonEmpty(claimant, "claimTask: claimant");
    return this.tx(() => {
      const tasks = this.listTasks({ list, statuses: ["pending"] });
      const top = tasks.find((task) => task.claimedBy === null);
      if (!top) return null;
      const at = this.now();
      this.stmt("UPDATE tasks SET status = 'in-progress', claimed_by = ?, updated_at = ? WHERE id = ?").run(who, at, top.id);
      const task = this.getTask(top.id) as TaskRow;
      this.audit("task.put", task.beeId, { task, outcome: "updated" });
      return task;
    });
  }

  moveTask(id: string, anchor: { before?: string; after?: string }): TaskRow {
    const hasBefore = typeof anchor.before === "string";
    const hasAfter = typeof anchor.after === "string";
    if (hasBefore === hasAfter) throw new CoreError("moveTask: pass exactly one of before or after");
    const anchorId = (anchor.before ?? anchor.after)!;
    if (anchorId === id) throw new CoreError("moveTask: a task cannot anchor on itself");
    return this.tx(() => {
      const current = this.mustGetTask(id);
      const tasks = this.listTasks({ list: current.list }).filter((task) => task.id !== id);
      const anchorIdx = tasks.findIndex((task) => task.id === anchorId);
      if (anchorIdx === -1) throw new CoreError(`moveTask: anchor task ${anchorId} not found in ${current.list}`);
      const anchorOrder = tasks[anchorIdx]!.order;
      let nextOrder: number;
      if (hasBefore) {
        const prev = tasks[anchorIdx - 1];
        nextOrder = prev ? (prev.order + anchorOrder) / 2 : anchorOrder - ORDER_STEP;
      } else {
        const after = tasks[anchorIdx + 1];
        nextOrder = after ? (anchorOrder + after.order) / 2 : anchorOrder + ORDER_STEP;
      }
      const at = this.now();
      this.stmt("UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?").run(nextOrder, at, id);
      const task = this.getTask(id) as TaskRow;
      this.audit("task.put", task.beeId, { task, outcome: "updated" });
      return task;
    });
  }

  editTask(id: string, patch: EditTaskInput): TaskRow {
    return this.tx(() => {
      const current = this.mustGetTask(id);
      let title = current.title;
      if (patch.title !== undefined) {
        title = requireNonEmpty(patch.title, "editTask: title");
        if (title.includes("\n")) throw new CoreError("editTask: title must be a single line");
        if (title.length > MAX_TASK_TITLE_LENGTH) throw new CoreError(`editTask: title exceeds ${MAX_TASK_TITLE_LENGTH} characters`);
      }
      const body = patch.body === undefined ? current.body : patch.body;
      let auto = current.auto;
      if (patch.auto !== undefined) {
        if (current.originKind === "self" && patch.auto) {
          auto = false;
        } else {
          auto = patch.auto;
        }
      }
      const at = this.now();
      this.stmt("UPDATE tasks SET title = ?, body = ?, auto = ?, updated_at = ? WHERE id = ?").run(
        title,
        body,
        auto ? 1 : 0,
        at,
        id,
      );
      const task = this.getTask(id) as TaskRow;
      this.audit("task.put", task.beeId, { task, outcome: "updated" });
      return task;
    });
  }

  getTaskSupply(beeId: string): TaskSupplyRow {
    const row = this.stmt("SELECT * FROM task_supply WHERE bee_id = ?").get(beeId) as Row | undefined;
    return row ? mapTaskSupply(row) : defaultTaskSupply(beeId);
  }

  listTaskSupply(filter: { on?: boolean } = {}): TaskSupplyRow[] {
    const rows = (this.stmt("SELECT * FROM task_supply ORDER BY bee_id").all() as Row[]).map(mapTaskSupply);
    return filter.on === true ? rows.filter((r) => r.on) : rows;
  }

  setTaskSupply(beeId: string, patch: SetTaskSupplyInput): TaskSupplyRow {
    return this.tx(() => {
      this.mustGetBee(beeId);
      const current = this.getTaskSupply(beeId);
      const on = patch.on === undefined ? current.on : patch.on;
      const limit = patch.limit === undefined ? current.limit : normalizeSupplyLimit(patch.limit);
      // --on clears the tripped breaker AND the consecutive-feed counter.
      const feeds = patch.on === true ? 0 : current.feeds;
      const paused = patch.on === true ? false : current.paused;
      this.db
        .prepare(
          `INSERT INTO task_supply(bee_id, enabled, feed_limit, feeds, paused) VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(bee_id) DO UPDATE SET enabled = excluded.enabled, feed_limit = excluded.feed_limit, feeds = excluded.feeds, paused = excluded.paused`,
        )
        .run(beeId, on ? 1 : 0, limit, feeds, paused ? 1 : 0);
      const supply = this.getTaskSupply(beeId);
      this.audit("task_supply.put", beeId, { supply });
      return supply;
    });
  }

  /**
   * If the six-condition gate fires, mark the top eligible task queued, send
   * one idle mailbox message carrying the feed body, record its id, and bump
   * the consecutive-feed counter (tripping the breaker at the limit).
   */
  tryFeedTaskSupply(beeId: string): { fed: TaskRow; supply: TaskSupplyRow } | null {
    return this.tx(() => {
      const bee = this.getBee(beeId);
      if (!bee) return null;
      const supply = this.getTaskSupply(beeId);
      const tasks = this.listTasks({ list: beeTaskList(beeId) });
      const needsInput = this.listQuestions({ beeId, open: true }).length > 0;
      const mailboxEmpty = this.undeliveredMessages(beeId).length === 0;
      const decision = evaluateSupplyGate({ supply, needsInput, mailboxEmpty, tasks });
      if (!decision.feed) return null;
      const task = decision.feed;
      const at = this.now();
      this.stmt("UPDATE tasks SET status = 'queued', fed_at = ?, stalled_at = NULL, updated_at = ? WHERE id = ?").run(
        at,
        at,
        task.id,
      );
      const remaining = tasks.filter((t) => t.status === "pending" && t.id !== task.id).length;
      const queued = this.getTask(task.id) as TaskRow;
      const body = buildTaskFeedBody(queued, remaining);
      const sent = this.send(beeId, body, { sender: TASK_SUPPLY_SENDER_NAME, urgency: "idle" });
      this.stmt("UPDATE tasks SET mailbox_message_id = ?, updated_at = ? WHERE id = ?").run(sent.message.id, at, task.id);
      const feeds = supply.feeds + 1;
      const paused = supply.paused || feeds >= supply.limit;
      this.db
        .prepare(
          `INSERT INTO task_supply(bee_id, enabled, feed_limit, feeds, paused) VALUES(?, 1, ?, ?, ?)
           ON CONFLICT(bee_id) DO UPDATE SET feeds = excluded.feeds, paused = excluded.paused`,
        )
        .run(beeId, supply.limit, feeds, paused ? 1 : 0);
      const fed = this.getTask(task.id) as TaskRow;
      this.audit("task.put", beeId, { task: fed, outcome: "updated" });
      const nextSupply = this.getTaskSupply(beeId);
      this.audit("task_supply.put", beeId, { supply: nextSupply });
      return { fed, supply: nextSupply };
    });
  }

  /**
   * One idle tick with empty mail and an auto-fed in-flight task: stamp
   * stalledAt (idempotent). The inbox surfaces stalled tasks.
   */
  maybeStallFedTask(beeId: string): TaskRow | null {
    return this.tx(() => {
      const rt = this.currentRuntime(beeId);
      if (rt && (rt.state === "booting" || rt.state === "running")) return null;
      if (this.undeliveredMessages(beeId).length > 0) return null;
      const inflight = this.listTasks({ list: beeTaskList(beeId) }).find(
        (task) => (task.status === "queued" || (task.status === "in-progress" && task.fedAt !== null)) && task.stalledAt === null && task.fedAt !== null,
      );
      if (!inflight) return null;
      const at = this.now();
      this.stmt("UPDATE tasks SET stalled_at = ?, updated_at = ? WHERE id = ?").run(at, at, inflight.id);
      const task = this.getTask(inflight.id) as TaskRow;
      this.audit("task.put", beeId, { task, outcome: "updated" });
      return task;
    });
  }

  private applyResetTaskSupplyFeeds(beeId: string): void {
    const current = this.getTaskSupply(beeId);
    if (current.feeds <= 0) return;
    this.db
      .prepare(
        `INSERT INTO task_supply(bee_id, enabled, feed_limit, feeds, paused) VALUES(?, ?, ?, 0, ?)
         ON CONFLICT(bee_id) DO UPDATE SET feeds = 0`,
      )
      .run(beeId, current.on ? 1 : 0, current.limit, current.paused ? 1 : 0);
    this.audit("task_supply.put", beeId, { supply: this.getTaskSupply(beeId) });
  }

  // -------------------------------------------------------------------------
  // Audit access & snapshots
  // -------------------------------------------------------------------------

  /** Highest audit seq written so far (0 for an empty log) — the store's change version. */
  lastAuditSeq(): number {
    const row = this.stmt("SELECT MAX(seq) AS seq FROM audit").get() as Row | undefined;
    return row?.seq == null ? 0 : Number(row.seq);
  }

  auditRows(fromSeq = 0, limit?: number): AuditRow[] {
    // Bounded when the caller says so: the watch flush reads maxBatch+1 to
    // detect a gap WITHOUT materializing the whole backlog — the unbounded
    // read here was the 5.9s accept-loop stall of 2026-08-21 (every watcher
    // with an old cursor triggered a full audit-table scan per tick).
    const rows = (
      limit !== undefined
        ? this.db.prepare("SELECT * FROM audit WHERE seq > ? ORDER BY seq LIMIT ?").all(fromSeq, limit)
        : this.db.prepare("SELECT * FROM audit WHERE seq > ? ORDER BY seq").all(fromSeq)
    ) as Row[];
    return rows.map(mapAudit);
  }

  /** The LAST `limit` audit rows after `afterSeq` (optionally one bee's), in
   * ascending order — the audit-tail RPC used to read the whole table and
   * slice in JS. */
  auditTail(afterSeq: number, limit: number, beeId?: string | null): AuditRow[] {
    const rows = (
      beeId
        ? this.db
            .prepare("SELECT * FROM audit WHERE seq > ? AND bee_id = ? ORDER BY seq DESC LIMIT ?")
            .all(afterSeq, beeId, limit)
        : this.db
            .prepare("SELECT * FROM audit WHERE seq > ? ORDER BY seq DESC LIMIT ?")
            .all(afterSeq, limit)
    ) as Row[];
    return rows.map(mapAudit).reverse();
  }

  /** Deterministic snapshot of all replayable state (meta and audit excluded). */
  dumpState(): StateDump {
    return {
      bees: this.listBees(),
      runtimes: (this.stmt("SELECT * FROM runtimes ORDER BY bee_id, generation").all() as Row[]).map(
        mapRuntime,
      ),
      flags: (this.stmt("SELECT * FROM flags ORDER BY id").all() as Row[]).map(mapFlag),
      mailbox: (this.stmt("SELECT * FROM mailbox ORDER BY id").all() as Row[]).map(mapMessage),
      commands: (this.stmt("SELECT * FROM commands ORDER BY id").all() as Row[]).map(mapCommand),
      templates: this.listTemplates(),
      tracks: this.listTracks(),
      questions: (this.stmt("SELECT * FROM questions ORDER BY id").all() as Row[]).map(mapQuestion),
      seals: (this.stmt("SELECT * FROM seals ORDER BY id").all() as Row[]).map(mapSeal),
      accounts: this.listAccounts(),
      accountLimits: this.listAccountLimits(),
      selectionCursors: this.listSelectionCursors(),
      tasks: (this.stmt("SELECT * FROM tasks ORDER BY id").all() as Row[]).map(mapTask),
      taskSupply: (this.stmt("SELECT * FROM task_supply ORDER BY bee_id").all() as Row[]).map(mapTaskSupply),
    };
  }
}

/** Positional bindings in UPDATE/INSERT column order (name … tags). */
function templateBindings(f: TemplateFields): Array<string | number | null> {
  return [
    f.name,
    f.scope,
    f.source,
    f.description,
    f.agent,
    f.substrate,
    f.model,
    f.effort,
    JSON.stringify(f.args),
    f.prompt,
    f.preamble,
    f.preambleEnabled ? 1 : 0,
    f.cwdPolicy,
    f.cwd,
    JSON.stringify(f.env),
    f.account,
    f.yolo ? 1 : 0,
    JSON.stringify(f.tags),
  ];
}

function trackBindings(f: TrackFields): Array<string | number | null> {
  return [f.name, f.scope, f.source, f.description, JSON.stringify(f.steps), JSON.stringify(f.tags)];
}

/** Open (or create) the node's core store. The returned object is the single writer (B9). */
export function openCoreStore(path: string, opts: CoreStoreOptions = {}): CoreStore {
  return new CoreStore(path, opts);
}
