import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isBuzTier, type BuzTier } from "./buz_tiers.js";
import { normalizeContract, type BeeContract } from "./contract.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import type { PreambleChannel } from "./preamble.js";
import { dedupeTags, isValidSessionTag, MAX_TAGS_PER_BEE } from "./tags.js";
import type { CombActivationBinding } from "./comb/types.js";

/**
 * Per-bee task auto-supply config (see tasks/supplyConfig.ts for semantics
 * and defaults). Stored on the session record like buzAccept so the daemon's
 * records snapshot carries it for free.
 */
export type TaskSupplyConfig = {
  on: boolean;
  /** Breaker: max consecutive auto-feeds without a human interaction. */
  limit?: number;
  /** Consecutive-feed counter (daemon-incremented; reset on human sends). */
  feeds?: number;
  /** Breaker tripped; cleared only by `hive task supply <bee> --on`. */
  paused?: boolean;
};

export type SessionRecord = {
  name: string;
  agent: string;
  cwd: string;
  /**
   * Immutable executable + argv resolved for the original launch. Hive-owned
   * provider-session pinning is deliberately excluded: revive may need to
   * replace that lifecycle routing with `resume` args or omit it for --fresh,
   * while every operator/config/model/yolo argument remains byte-for-byte.
   * Absent on legacy records, which fall back to the rendered `command`.
   */
  launchArgv?: string[];
  command: string;
  /** Rendered command used by the most recent revive; `command` stays original. */
  lastReviveCommand?: string;
  tmuxTarget: string;
  /**
   * The tmux pane id (e.g. "%7") this bee's agent actually runs in. Pins all
   * agent I/O and liveness to that pane instead of "whatever pane is active",
   * so splitting/adding panes no longer hijacks the bee. Absent on legacy
   * records → they keep the active-pane fallback.
   */
  agentPaneId?: string;
  /** Local tmux launcher process group; best-effort cleanup for drivers that survive pane teardown. */
  launcherPgid?: number;
  /**
   * LEGACY, read-only (APIA-85). Combs — multiple bees sharing one tmux session
   * via split panes — are retired: Apiary lineage views + HSR subagents replaced
   * them, so no new comb grouping is created. Spawn paths still write
   * `combId == tmuxTarget|name` (a solo bee is its own comb), and old multi-bee
   * records keep their shared combId, but nothing reads it to group bees anymore.
   * Retained so aged records deserialize; do not build new features on it.
   * (was: fork-and-pane Phase B)
   */
  combId?: string;
  /** Combs engine activation bindings. Legacy combId above is unrelated. */
  combActivations?: CombActivationBinding[];
  /** The bee this one was split from (intra-comb lineage). (Phase B) */
  parentId?: string;
  /** Operator-set owned-by/reports-to edge → target bee id. (Tags PRD Phase 2) */
  reportsToId?: string;
  /**
   * The bee that spawned this one, captured automatically at spawn time when the
   * spawning process is itself a bee (HIVE_BEE / agent-pane resolved). This is
   * the durable orchestrator→worker edge the fleet surface walks, so a
   * coordinator can reconcile its children from ground truth instead of holding
   * the roster in context (which compaction drops). Absent for operator/daemon-
   * launched roots. Stores the parent's `id ?? name`, like forkedFromId.
   */
  spawnedById?: string;
  /**
   * Cross-comb fork lineage → source bee id. Written later by fork-and-pane
   * Phase C; added now so `forks-of:` can read it. (Tags PRD Phase 2)
   */
  forkedFromId?: string;
  /** ISO timestamp when this bee was forked from its source. (Phase C) */
  forkedAt?: string;
  /**
   * How the fork was seeded: "resume" | "seal" | "summary" | "log" | "none".
   * Stored as a plain string for forward-compat with the deserializer's
   * string allow-list (the §5.1 union is aspirational). (Phase C)
   */
  seedMode?: string;
  /**
   * The seed anchor, e.g. "seal:<ISO>" | "resume:<providerSessionId>" |
   * "log:<path>" | "none". (Phase C)
   */
  forkCheckpoint?: string;
  /**
   * First-class model, independent of the frozen `command` string, so a later
   * resume/revive can re-derive it. e.g. "sonnet", "opus". (Phase C)
   */
  model?: string;
  /**
   * Harness CLI flags re-applied on every relaunch alongside the model
   * selector — reasoning/effort switches like `--effort high` or
   * `-c model_reasoning_effort="high"` that would otherwise live only in the
   * frozen `command` and be silently dropped by resume/revive. One
   * shell-words line; set (or replaced) by `hive set-model <bee> <model>
   * -- <flags>`.
   */
  modelExtraArgs?: string;
  /**
   * Free-form user tags (first-class). Holds ONLY bare or power-user-namespaced
   * labels, e.g. ["migration", "waiting-review", "prio:p1"]. Reserved-namespace
   * tags (colony:/swarm:/…) are NEVER stored here — they are derived on read by
   * src/tags.ts effectiveTags(). (TAGS_AND_RELATIONSHIPS_PRD Phase 1)
   */
  tags?: string[];
  /**
   * trmdy/kit capability pin: the kit content version and profile the bee's
   * home carried at spawn ("this bee ran on kit 0.2.0 / web-qa"), read from
   * the home's kit ownership manifest. Absent when the home isn't kit-managed
   * or the spawn was remote (kit bundle distribution pending).
   */
  kitVersion?: string;
  kitProfile?: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "dead" | "kill_failed" | "done";
  lastError?: string;
  notes?: string;
  id?: string;
  prefix?: string;
  uuid?: string;
  requestedAgent?: string;
  homePath?: string;
  lastPrompt?: string;
  lastPromptAt?: string;
  transcriptPath?: string;
  providerSessionId?: string;
  /**
   * A non-sealed terminal bee gets at most one best-effort transcript discovery
   * pass (sealed bees are skipped outright). Persisting the claim before
   * discovery prevents dead records with no transcript from being rescanned
   * forever on every daemon tick/restart.
   */
  terminalTranscriptDiscoveryAt?: string;
  /** Latest seal filename predating the current runtime incarnation. */
  sealHighWaterFilename?: string;
  /** Monotonic relaunch counter; initial spawn is generation zero. */
  runtimeGeneration?: number;
  title?: string;
  /** Who set `title`: user beats auto beats provider (see naming.ts). */
  titleSource?: "user" | "auto" | "provider";
  /**
   * Provenance within titleSource:"provider". A fallback is Honeybee's
   * provisional first-prompt label and remains eligible for semantic naming;
   * generated means explicit provider title metadata. Kept separate from
   * titleSource so older Honeybee binaries preserve it as an unknown field
   * during mixed-version rollouts instead of dropping a new enum value.
   */
  providerTitleKind?: "generated" | "fallback";
  /** Timestamp of the auto-titler's most recent attempt (claim + backoff key). */
  autoTitleAt?: string;
  /** How many times the auto-titler has attempted this bee (retry cap). */
  autoTitleAttempts?: number;
  colony?: string;
  swarmId?: string;
  caste?: string;
  brief?: string;
  briefedAt?: string;
  node?: string;
  /** Substrate hosting this bee. Absent = local-tmux (back-compat). "hsr" = pane-less Hive Substrate Runner. */
  substrate?: "local-tmux" | "hsr";
  /** HSR: runner process pid (structured-tier child or server). */
  runnerPid?: number;
  /** HSR: resolved runner tier for this bee ("server"|"stream"|"turn"|"pty"). */
  runnerTier?: string;
  buzAccept?: BuzTier[];
  /**
   * Task auto-supply configuration (tasks/supplyConfig.ts): whether the
   * daemon's supply loop feeds this bee's task backlog one task per idle
   * tick, plus the consecutive-feed breaker state. Absent = supply off.
   */
  taskSupply?: TaskSupplyConfig;
  lastObservedState?: string;
  lastObservedStateAt?: string;
  runId?: string;
  /**
   * Execution-protocol Run identity (contracts/execution/v1) this bee is bound
   * to, stamped atomically at record creation by a protocol `run.start` spawn.
   * Distinct from the flow `runId` above. Crash recovery uses it to prove a
   * reservation's launch actually persisted (started-receipt-lost vs
   * indeterminate) without ever counting processes.
   */
  executionRunId?: string;
  flowName?: string;
  /** Vault account bound to this bee's home (Phase 3 identity layer). */
  accountId?: string;
  /** Opt-in: the daemon's autoswap dispatcher may swap accounts on exhaustion. */
  autoswap?: boolean;
  /**
   * NON-SECRET expiry (unix SECONDS) of the short-lived access token delivered to
   * a REMOTE ephemeral-token codex bee at spawn — the shipped auth.json's JWT
   * `exp` (see hsr/remoteCreds.ts mintCodexAccessTokenCredential). This is the
   * daemon's source of truth for proactive token refresh (UNIT 2): the token
   * refresher re-mints + re-delivers before it dies. Only set for account-bound
   * remote codex spawns on an ephemeral-token node; absent everywhere else, so
   * non-remote / non-ephemeral bees are skipped by the refresher. Carries no
   * token bytes. Updated to the new `exp` after each successful refresh.
   */
  remoteTokenExpiresAt?: number;
  /**
   * Checkout-pool attribution (CHECKOUT_POOLS_PRD §6.4): the pool key
   * (`<area>-<project>-<repo>-<pool>`) this bee was allocated from, so
   * fleet/TUI/ledger can attribute bees to pools without re-deriving.
   */
  poolKey?: string;
  /** The allocated member number (the n of `<pool>-<n>`). */
  poolMember?: number;
  /**
   * Completion contract (CL.701 §4.1): how this bee signals task completion.
   * Set at spawn (`--contract`); consumers (flight controller, waiters) treat
   * idle-without-seal on a seal contract as a stall, never as done.
   */
  contract?: BeeContract;
  /**
   * Session preamble actually injected at spawn (src/preamble.ts). Persisted
   * so the transcript UI can show what the bee was told, `hive fork` can tell a
   * re-render from a copy, and the `message` channel can guarantee once-only
   * delivery. `channel: "system-prompt"` text also lives in launchArgv.
   */
  preamble?: SessionPreamble;
};

/** What was injected, how, and (for the message channel) whether it landed. */
export type SessionPreamble = {
  text: string;
  channel: PreambleChannel;
  /**
   * Message channel only: the preamble has already been folded into a
   * delivered brief/prompt, so the next delivery must not prepend it again.
   */
  delivered?: boolean;
};

export { storeRoot } from "./fsx.js";

export async function ensureStore() {
  await mkdir(sessionsDir(), { recursive: true });
}

/**
 * Persisted observed states that have no daemon work left to do. A later send
 * or revive clears the turn/runtime boundary before setting status=running,
 * which transactionally puts the record back in the active index.
 */
const TERMINAL_OBSERVED_STATES = new Set([
  "dead",
  "crashed",
  "done",
  "sealed",   // legacy spelling for a completed/sealed current turn
  "archived", // legacy spelling for a filed record
  "retired",
  "killed",
]);

/**
 * Whether a record belongs in operational hot paths. This is deliberately
 * narrower than status=running: a crashed bee or a warm runtime whose current
 * turn is sealed/done remains revivable history, but does not need probing and
 * must not bias automatic account selection.
 */
export function isActiveSessionRecord(
  record: Pick<SessionRecord, "status" | "lastObservedState">,
): boolean {
  // kill_failed means teardown could not prove the runtime stopped. Keep it in
  // the daemon work set until an operator retries/repairs it. Likewise a
  // provider/runtime `error` observation can recover on a later tick. Neither
  // contributes an account commitment (limits/commitments owns that policy).
  if (record.status !== "running" && record.status !== "kill_failed") return false;
  return !TERMINAL_OBSERVED_STATES.has(record.lastObservedState ?? "");
}

export const ACTIVE_SESSION_INDEX_VERSION = 2;
const LEGACY_ACTIVE_SESSION_INDEX_VERSION = 1;

/**
 * A mixed-version writer does not know about the derived active index. Bound
 * how long its canonical SessionRecord can remain absent without making every
 * hot-path read walk all historical records.
 */
export const DEFAULT_ACTIVE_SESSION_RECONCILE_INTERVAL_MS = 5 * 60_000;

type ActiveSessionIndex = {
  version: typeof ACTIVE_SESSION_INDEX_VERSION;
  complete: true;
  root: string;
  active: string[];
  checksum: string;
  /** Last full current+legacy SessionRecord walk, not a delta membership write. */
  reconciledAt: string;
  /** Exact directory generations observed by that full walk. */
  directoryMtimeMs?: { current: number; legacy: number };
  updatedAt: string;
};

type StorePaths = {
  root: string;
  currentDir: string;
  legacyDir: string;
};

function captureStorePaths(): StorePaths {
  return { root: storeRoot(), currentDir: sessionsDir(), legacyDir: legacySessionsDir() };
}

/** Root-scoped operational index. The file-per-record store remains canonical. */
export function activeSessionIndexPath(root = storeRoot()): string {
  return join(root, "active-sessions.json");
}

function activeSessionIndexLockPath(root: string): string {
  return join(root, ".active-sessions.lock");
}

function activeIndexChecksum(
  root: string,
  active: readonly string[],
  reconciledAt: string,
  directoryMtimeMs?: ActiveSessionIndex["directoryMtimeMs"],
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: ACTIVE_SESSION_INDEX_VERSION,
      root,
      active,
      reconciledAt,
      ...(directoryMtimeMs ? { directoryMtimeMs } : {}),
    }))
    .digest("hex");
}

function legacyActiveIndexChecksum(root: string, active: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: LEGACY_ACTIVE_SESSION_INDEX_VERSION, root, active }))
    .digest("hex");
}

function makeActiveSessionIndex(
  root: string,
  names: Iterable<string>,
  options: {
    reconciledAt?: string;
    directoryMtimeMs?: ActiveSessionIndex["directoryMtimeMs"];
  } = {},
): ActiveSessionIndex {
  const active = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const now = new Date().toISOString();
  const reconciledAt = options.reconciledAt ?? now;
  return {
    version: ACTIVE_SESSION_INDEX_VERSION,
    complete: true,
    root,
    active,
    checksum: activeIndexChecksum(root, active, reconciledAt, options.directoryMtimeMs),
    reconciledAt,
    ...(options.directoryMtimeMs ? { directoryMtimeMs: options.directoryMtimeMs } : {}),
    updatedAt: now,
  };
}

async function readActiveSessionIndex(root: string): Promise<ActiveSessionIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(activeSessionIndexPath(root), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<ActiveSessionIndex> & { version?: unknown };
    if (
      candidate.complete !== true ||
      candidate.root !== root ||
      !Array.isArray(candidate.active) ||
      !candidate.active.every((name): name is string => typeof name === "string" && name.length > 0) ||
      typeof candidate.checksum !== "string" ||
      typeof candidate.updatedAt !== "string"
    ) return null;
    const normalized = [...new Set(candidate.active)].sort((a, b) => a.localeCompare(b));
    if (normalized.length !== candidate.active.length) return null;
    if (normalized.some((name, index) => name !== candidate.active![index])) return null;
    if (candidate.version === ACTIVE_SESSION_INDEX_VERSION) {
      if (typeof candidate.reconciledAt !== "string") return null;
      if (candidate.directoryMtimeMs !== undefined && (
        typeof candidate.directoryMtimeMs !== "object" ||
        typeof candidate.directoryMtimeMs.current !== "number" ||
        !Number.isFinite(candidate.directoryMtimeMs.current) ||
        typeof candidate.directoryMtimeMs.legacy !== "number" ||
        !Number.isFinite(candidate.directoryMtimeMs.legacy)
      )) return null;
      if (candidate.checksum !== activeIndexChecksum(
        root,
        normalized,
        candidate.reconciledAt,
        candidate.directoryMtimeMs,
      )) return null;
      return candidate as ActiveSessionIndex;
    }
    if (candidate.version !== LEGACY_ACTIVE_SESSION_INDEX_VERSION) return null;
    if (candidate.checksum !== legacyActiveIndexChecksum(root, normalized)) return null;
    // A checksum-valid v1 projection is safe to serve immediately. Normalize it
    // only in memory; the paced canonical pass will publish v2 without making
    // the first post-upgrade operational snapshot scan all historical rows.
    const reconciledAt = candidate.updatedAt;
    return {
      version: ACTIVE_SESSION_INDEX_VERSION,
      complete: true,
      root,
      active: normalized,
      checksum: activeIndexChecksum(root, normalized, reconciledAt),
      reconciledAt,
      updatedAt: candidate.updatedAt,
    };
  } catch {
    return null;
  }
}

async function writeActiveSessionIndex(index: ActiveSessionIndex): Promise<void> {
  await atomicWriteFile(activeSessionIndexPath(index.root), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

async function sessionDirectoryMtimes(paths: StorePaths): Promise<{ current: number; legacy: number }> {
  const directoryMtime = async (path: string): Promise<number> => {
    try {
      return (await stat(path)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  };
  const [current, legacy] = await Promise.all([
    directoryMtime(paths.currentDir),
    directoryMtime(paths.legacyDir),
  ]);
  return { current, legacy };
}

const ACTIVE_SESSION_RECONCILE_GENERATION_ATTEMPTS = 3;

export type ActiveSessionIndexRebuildOptions = {
  /** Attempt observation hook used by deterministic race tests/telemetry. */
  onAttempt?: (attempt: number) => Promise<void> | void;
};

async function rebuildActiveSessionIndexLocked(
  paths: StorePaths,
  options: ActiveSessionIndexRebuildOptions = {},
): Promise<ActiveSessionIndex> {
  await mkdir(paths.currentDir, { recursive: true });
  const previous = await readActiveSessionIndex(paths.root);
  for (let attempt = 1; attempt <= ACTIVE_SESSION_RECONCILE_GENERATION_ATTEMPTS; attempt += 1) {
    const generationBefore = await sessionDirectoryMtimes(paths);
    await options.onAttempt?.(attempt);
    const snapshot = await scanSessionsSnapshot(paths.currentDir, paths.legacyDir);
    const generationAfter = await sessionDirectoryMtimes(paths);
    if (
      generationAfter.current !== generationBefore.current ||
      generationAfter.legacy !== generationBefore.legacy
    ) {
      if (attempt < ACTIVE_SESSION_RECONCILE_GENERATION_ATTEMPTS) continue;
      throw new Error(
        `session directories changed during ${ACTIVE_SESSION_RECONCILE_GENERATION_ATTEMPTS} ` +
        "active-index reconciliation attempts; prior projection preserved",
      );
    }
    if (snapshot.readFailures.length > 0) {
      throw new AggregateError(
        snapshot.readFailures.map((failure) => failure.error),
        "active-index reconciliation could not authoritatively read every canonical record",
      );
    }
    const names = new Set(snapshot.records.filter(isActiveSessionRecord).map((record) => record.name));
    const index = makeActiveSessionIndex(paths.root, names, { directoryMtimeMs: generationAfter });
    await writeActiveSessionIndex(index);
    return index;
  }
  throw new Error("active-index reconciliation exhausted without an authoritative generation");
}

/**
 * Rebuild the derived index from authoritative current + legacy record files.
 * Safe to call operationally: history is only read, never moved or deleted.
 */
export async function rebuildActiveSessionIndex(options: ActiveSessionIndexRebuildOptions = {}): Promise<number> {
  const paths = captureStorePaths();
  const index = await withFileLock(
    activeSessionIndexLockPath(paths.root),
    () => rebuildActiveSessionIndexLocked(paths, options),
    { timeoutMs: 60_000 },
  );
  return index.active.length;
}

async function currentActiveSessionIndex(paths: StorePaths): Promise<ActiveSessionIndex> {
  const current = await readActiveSessionIndex(paths.root);
  if (current) return current;
  return withFileLock(
    activeSessionIndexLockPath(paths.root),
    async () => (await readActiveSessionIndex(paths.root)) ?? rebuildActiveSessionIndexLocked(paths),
    { timeoutMs: 60_000 },
  );
}

async function updateActiveMembershipLocked(
  paths: StorePaths,
  name: string,
  active: boolean,
): Promise<void> {
  const current = (await readActiveSessionIndex(paths.root)) ?? await rebuildActiveSessionIndexLocked(paths);
  const names = new Set(current.active);
  const changed = active ? !names.has(name) : names.has(name);
  if (!changed) return;
  if (active) names.add(name);
  else names.delete(name);
  await writeActiveSessionIndex(makeActiveSessionIndex(paths.root, names, {
    reconciledAt: current.reconciledAt,
    directoryMtimeMs: current.directoryMtimeMs,
  }));
}

function sessionLockPath(name: string): string {
  const root = resolve(storeRoot(), "sessions");
  const target = resolve(root, `.${safeName(name)}.lock`);
  if (dirname(target) !== root) {
    throw new Error(`session lock escaped its store root: ${name}`);
  }
  return target;
}

export async function withSessionLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(sessionLockPath(name), fn);
}

/**
 * Write a FULL record, overwriting whatever is on disk. Only for creating a
 * record (spawn/fork) or deliberately re-creating one that was just deleted
 * (quest archiving). To mutate an existing record use updateSession instead:
 * this overwrite reverts any field a concurrent writer (the daemon's
 * auto-titler, touchSession heartbeats) persisted after the caller loaded its
 * snapshot (HIVE-49).
 */
export async function saveSession(record: SessionRecord) {
  // Serialize against touchSession/updateSession so a concurrent merge can't
  // interleave with this full-record overwrite.
  await withSessionLock(record.name, async () => {
    await saveSessionLocked(record);
  });
}

/**
 * Write a full record WITHOUT acquiring the session lock. Only for callers
 * already inside withSessionLock for the same record — the lock is not
 * reentrant, so calling saveSession there would deadlock.
 */
export async function saveSessionLocked(record: SessionRecord) {
  const paths = captureStorePaths();
  await mkdir(paths.currentDir, { recursive: true });
  // Full saves are uncommon (spawn/fork/re-create), so always take the global
  // membership lock. Activation is indexed BEFORE the live record lands: a
  // crash can leave a harmless stale name, never an unindexed live runtime.
  // Deactivation reverses the order: terminal truth lands first, then the name
  // disappears. Readers validate indexed candidates against the record and
  // prune either crash residue without touching history.
  await withFileLock(activeSessionIndexLockPath(paths.root), async () => {
    if (isActiveSessionRecord(record)) {
      await updateActiveMembershipLocked(paths, record.name, true);
      await atomicWriteFile(join(paths.currentDir, `${safeName(record.name)}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    } else {
      await atomicWriteFile(join(paths.currentDir, `${safeName(record.name)}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await updateActiveMembershipLocked(paths, record.name, false);
    }
  }, { timeoutMs: 60_000 });
  await appendLedger(compactSaveEvent(record));
}

// The ledger keeps a compact audit row per save instead of the full record:
// brief/lastPrompt can be kilobytes each, and `hive search` only filters
// ledger lines on name/colony/swarmId (plus the always-present ts).
function compactSaveEvent(record: SessionRecord): Record<string, unknown> {
  return {
    type: "session.save",
    name: record.name,
    status: record.status,
    updatedAt: record.updatedAt,
    ...(record.id ? { id: record.id } : {}),
    ...(record.agent ? { agent: record.agent } : {}),
    ...(record.colony ? { colony: record.colony } : {}),
    ...(record.swarmId ? { swarmId: record.swarmId } : {}),
    ...(record.title ? { title: record.title } : {}),
  };
}

// How often a pure `lastObservedStateAt` heartbeat is allowed to hit disk for
// live records. Terminal history never needs a freshness lease: its lifecycle
// status is authoritative, and rewriting thousands of retired records turns a
// single daemon sweep into an FSEvents storm for every fleet observer.
const TOUCH_HEARTBEAT_MS = 60_000;

/** Whether a record still benefits from a persisted observation freshness lease. */
export function shouldPersistObservationHeartbeat(
  record: Pick<SessionRecord, "status">,
): boolean {
  return record.status !== "done" && record.status !== "dead";
}

/**
 * touchSession atomically merges a subset of fields into a session record without
 * appending a ledger entry. Designed for the daemon's per-tick `lastObservedState`
 * updates so we don't drown the ledger in noise. touchSession is self-locking
 * (it acquires withSessionLock internally, and the lock is NOT reentrant) — do
 * not wrap calls to it in withSessionLock for the same record or they deadlock.
 *
 * Writes are skipped when the merge changes nothing but `lastObservedStateAt`,
 * unless the stored timestamp is older than TOUCH_HEARTBEAT_MS.
 *
 * Returns the merged record, or null when the record no longer exists on disk.
 */
export async function touchSession(name: string, fields: Partial<SessionRecord>): Promise<SessionRecord | null> {
  return mergeSessionFields(name, fields, { skipNoopWrites: true });
}

/**
 * updateSession is the locked read-merge-write counterpart to saveSession for
 * callers that mutate a few fields: it re-reads the record under the session
 * lock, applies the patch field-level, and persists the result, so concurrent
 * writers (e.g. the daemon's touchSession) can't be clobbered by a stale
 * load→modify→save cycle. Appends a compact ledger row like saveSession.
 *
 * A patch key set to an EXPLICIT undefined deletes that field from the record
 * (e.g. promote clears substrate/runnerPid); an absent key leaves the stored
 * value untouched.
 *
 * Returns the merged record, or null when the record no longer exists on disk.
 */
export async function updateSession(name: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
  const merged = await mergeSessionFields(name, patch);
  if (merged) await appendLedger(compactSaveEvent(merged));
  return merged;
}

async function mergeSessionFields(
  name: string,
  fields: Partial<SessionRecord>,
  options: { skipNoopWrites?: boolean } = {},
): Promise<SessionRecord | null> {
  return withSessionLock(name, async () => {
    const paths = captureStorePaths();
    const existing = await loadSessionFromDirectories(name, paths.currentDir, paths.legacyDir);
    if (!existing) return null;
    const merged: SessionRecord = { ...existing, ...fields, name: existing.name };
    // An explicitly-undefined patch value means "delete this field". Strip the
    // keys so the returned record matches what JSON.stringify persists.
    const bag = merged as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      if (bag[key] === undefined) delete bag[key];
    }
    if (options.skipNoopWrites && sessionFingerprint(existing) === sessionFingerprint(merged)) {
      if (existing.lastObservedStateAt === merged.lastObservedStateAt) return merged;
      if (!shouldPersistObservationHeartbeat(existing)) return merged;
      const previousAt = Date.parse(existing.lastObservedStateAt ?? "");
      const nextAt = Date.parse(merged.lastObservedStateAt ?? "");
      if (Number.isFinite(previousAt) && Number.isFinite(nextAt) && nextAt - previousAt < TOUCH_HEARTBEAT_MS) {
        return merged;
      }
    }
    await mkdir(paths.currentDir, { recursive: true });
    const wasActive = isActiveSessionRecord(existing);
    const isActive = isActiveSessionRecord(merged);
    if (wasActive === isActive) {
      // Rebuilds only care about membership. An active→active metadata write or
      // terminal→terminal annotation may safely run alongside a rebuild: both
      // versions classify identically.
      await atomicWriteFile(join(paths.currentDir, `${safeName(existing.name)}.json`), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    } else {
      await withFileLock(activeSessionIndexLockPath(paths.root), async () => {
        if (isActive) {
          await updateActiveMembershipLocked(paths, existing.name, true);
          await atomicWriteFile(join(paths.currentDir, `${safeName(existing.name)}.json`), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
        } else {
          await atomicWriteFile(join(paths.currentDir, `${safeName(existing.name)}.json`), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
          await updateActiveMembershipLocked(paths, existing.name, false);
        }
      }, { timeoutMs: 60_000 });
    }
    return merged;
  });
}

// Order-insensitive serialization of every persisted field except the
// `lastObservedStateAt` heartbeat, used to detect no-op touches.
function sessionFingerprint(record: SessionRecord): string {
  const entries = Object.entries(record as Record<string, unknown>)
    .filter(([key, value]) => key !== "lastObservedStateAt" && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

export async function loadSession(name: string): Promise<SessionRecord | null> {
  const paths = captureStorePaths();
  return loadSessionFromDirectories(name, paths.currentDir, paths.legacyDir);
}

async function loadSessionFromDirectories(name: string, currentDir: string, legacyDir: string): Promise<SessionRecord | null> {
  try {
    return await readSessionRecord(join(currentDir, `${safeName(name)}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    return await readSessionRecord(join(legacyDir, `${safeName(name)}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteSession(name: string) {
  // Take the session lock so an in-flight touchSession/updateSession (the
  // daemon persists observed state constantly) can't recreate the record file
  // right after we remove it, resurrecting a zombie bee in `hive ls`.
  await withSessionLock(name, async () => {
    const paths = captureStorePaths();
    await withFileLock(activeSessionIndexLockPath(paths.root), async () => {
      // Deletion is explicit purge. Remove canonical files first, then the
      // derived name: a crash leaves only a stale index entry, never a hidden
      // record that could still own a live runtime.
      await rm(join(paths.currentDir, `${safeName(name)}.json`), { force: true });
      await rm(join(paths.legacyDir, `${safeName(name)}.json`), { force: true });
      await updateActiveMembershipLocked(paths, name, false);
    }, { timeoutMs: 60_000 });
  });
  await appendLedger({ type: "session.delete", name, ts: new Date().toISOString() });
}

const DEFAULT_LIST_SESSION_CONCURRENCY = 32;
const ACTIVE_INDEX_READ_WARNING_INTERVAL_MS = 60_000;
const listSessionsInFlight = new Map<string, Promise<SessionRecord[]>>();
const listActiveSessionsHotInFlight = new Map<string, Promise<SessionRecord[]>>();
type ActiveSessionsSafetySnapshot = {
  records: SessionRecord[];
  /** Directory generation carried by the exact index used for `records`. */
  directoryMtimeMs: { current: number; legacy: number } | null;
};
const listActiveSessionsSafetyInFlight = new Map<string, Promise<ActiveSessionsSafetySnapshot>>();
const activeIndexReadWarningAt = new Map<string, number>();

function reportActiveIndexReadFailures(
  root: string,
  failures: readonly { name: string; error: unknown }[],
): void {
  const now = Date.now();
  const due = failures.filter(({ name }) => {
    const key = `${root}\0${name}`;
    const previous = activeIndexReadWarningAt.get(key);
    if (previous !== undefined && now >= previous && now - previous < ACTIVE_INDEX_READ_WARNING_INTERVAL_MS) {
      return false;
    }
    activeIndexReadWarningAt.set(key, now);
    return true;
  });
  if (due.length === 0) return;
  const detail = due.map(({ name, error }) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    return `${name}${code ? ` (${code})` : ""}: ${message}`;
  });
  process.emitWarning(
    `active-session record read failed; membership retained for retry: ${detail.join("; ")}`,
    { code: "HIVE_ACTIVE_INDEX_READ", type: "HiveStoreWarning" },
  );
}

/**
 * Enumerate one store snapshot with bounded read fan-out. The old sequential
 * loop took several seconds at 1,200+ records; callers timing it out then
 * started another full walk on the next daemon tick. The exported wrapper is
 * single-flight per store root, so even a slow/timed-out consumer can never
 * accumulate overlapping scans in this process.
 */
export function listSessions(): Promise<SessionRecord[]> {
  const root = storeRoot();
  const current = listSessionsInFlight.get(root);
  if (current) return current;

  // Capture both paths now: tests and embedders can swap HIVE_STORE_ROOT while
  // an asynchronous snapshot is still draining.
  const pending = listSessionsSnapshot(sessionsDir(), legacySessionsDir()).finally(() => {
    if (listSessionsInFlight.get(root) === pending) listSessionsInFlight.delete(root);
  });
  listSessionsInFlight.set(root, pending);
  return pending;
}

/**
 * Index-only operational projection. The daemon uses this because its
 * parent-owned controller performs canonical reconciliation out of process;
 * other consumers should use listActiveSessions() so a daemonless process
 * cannot trust a mixed-version omission forever.
 */
export function listActiveSessionsHot(): Promise<SessionRecord[]> {
  const paths = captureStorePaths();
  const current = listActiveSessionsHotInFlight.get(paths.root);
  if (current) return current;

  const pending = listActiveSessionsSnapshot(paths, { ambiguousReadPolicy: "tolerate" }).finally(() => {
    if (listActiveSessionsHotInFlight.get(paths.root) === pending) listActiveSessionsHotInFlight.delete(paths.root);
  });
  listActiveSessionsHotInFlight.set(paths.root, pending);
  return pending;
}

/**
 * Safety-sensitive active projection for direct/account-selection consumers.
 * A file-per-record writer publishes through temp+rename, which advances the
 * sessions directory mtime even when an older binary knows nothing about the
 * derived index. Trust a checksum-valid projection only when both canonical
 * directory generations exactly match its last full reconciliation;
 * otherwise do one canonical pass before returning.
 *
 * A failed canonical pass rejects instead of returning a known-stale
 * projection, so automatic account selection fails closed rather than
 * under-counting commitments. Concurrent callers share one pass per root.
 */
export type ListActiveSessionsOptions = {
  /** Test/telemetry barrier after the shared record snapshot is materialized. */
  onSnapshotRead?: () => Promise<void> | void;
};

const ACTIVE_SESSION_CALLER_GENERATION_ATTEMPTS = 3;

export function listActiveSessions(options: ListActiveSessionsOptions = {}): Promise<SessionRecord[]> {
  const paths = captureStorePaths();
  return listActiveSessionsForCaller(paths, options, 1);
}

async function listActiveSessionsForCaller(
  paths: StorePaths,
  options: ListActiveSessionsOptions,
  attempt: number,
): Promise<SessionRecord[]> {
  // This is the caller's linearization generation. It is deliberately outside
  // the shared flight: a caller arriving after an older-writer rename must not
  // inherit an earlier caller's already-in-flight projection.
  const callerGeneration = await sessionDirectoryMtimes(paths);
  const snapshot = await sharedActiveSessionsSafetySnapshot(paths, options);
  if (
    snapshot.directoryMtimeMs?.current === callerGeneration.current &&
    snapshot.directoryMtimeMs.legacy === callerGeneration.legacy
  ) return snapshot.records;
  if (attempt >= ACTIVE_SESSION_CALLER_GENERATION_ATTEMPTS) {
    throw new Error("active-session directory generation advanced across every strict snapshot attempt");
  }
  return listActiveSessionsForCaller(paths, {}, attempt + 1);
}

function sharedActiveSessionsSafetySnapshot(
  paths: StorePaths,
  options: ListActiveSessionsOptions,
): Promise<ActiveSessionsSafetySnapshot> {
  const current = listActiveSessionsSafetyInFlight.get(paths.root);
  if (current) return current;

  const pending = (async () => {
    const index = await currentActiveSessionIndex(paths);
    if (!(await activeSessionDirectoriesCovered(paths, index))) {
      await withFileLock(
        activeSessionIndexLockPath(paths.root),
        async () => {
          const currentIndex = await readActiveSessionIndex(paths.root);
          if (!currentIndex || !(await activeSessionDirectoriesCovered(paths, currentIndex))) {
            await rebuildActiveSessionIndexLocked(paths);
          }
        },
        { timeoutMs: 60_000 },
      );
    }
    const snapshot = await listActiveSessionsSnapshotWithIndex(paths, { ambiguousReadPolicy: "reject" });
    await options.onSnapshotRead?.();
    return snapshot;
  })().finally(() => {
    if (listActiveSessionsSafetyInFlight.get(paths.root) === pending) {
      listActiveSessionsSafetyInFlight.delete(paths.root);
    }
  });
  listActiveSessionsSafetyInFlight.set(paths.root, pending);
  return pending;
}

async function activeSessionDirectoriesCovered(paths: StorePaths, index: ActiveSessionIndex): Promise<boolean> {
  let directoryMtimeMs: { current: number; legacy: number };
  try {
    directoryMtimeMs = await sessionDirectoryMtimes(paths);
  } catch {
    // An ambiguous stat must not authorize a stale account commitment.
    return false;
  }
  if (index.directoryMtimeMs) {
    return directoryMtimeMs.current === index.directoryMtimeMs.current &&
      directoryMtimeMs.legacy === index.directoryMtimeMs.legacy;
  }
  // v1 and early-v2 indexes predate the exact generation pair. Their wall
  // clock cannot order same-ms writes or survive clock skew soundly, so direct
  // safety-sensitive consumers upgrade them with one canonical pass. The
  // daemon may still serve them through listActiveSessionsHot while its
  // isolated reconciler performs that upgrade in the background.
  return false;
}

async function listActiveSessionsSnapshot(
  paths: StorePaths,
  options: { ambiguousReadPolicy: "tolerate" | "reject" },
): Promise<SessionRecord[]> {
  return (await listActiveSessionsSnapshotWithIndex(paths, options)).records;
}

async function listActiveSessionsSnapshotWithIndex(
  paths: StorePaths,
  options: { ambiguousReadPolicy: "tolerate" | "reject" },
): Promise<ActiveSessionsSafetySnapshot> {
  const index = await currentActiveSessionIndex(paths);
  const records: SessionRecord[] = [];
  const needsRecheck: string[] = [];
  const recordNames = new Set<string>();
  let cursor = 0;
  const workerCount = Math.min(DEFAULT_LIST_SESSION_CONCURRENCY, index.active.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < index.active.length) {
      const name = index.active[cursor++];
      if (!name) continue;
      try {
        const record = await loadSessionFromDirectories(name, paths.currentDir, paths.legacyDir);
        if (record && isActiveSessionRecord(record)) {
          records.push(record);
          recordNames.add(record.name);
        } else {
          // null is authoritative ENOENT from both stores; a successfully
          // parsed terminal record is authoritative too. Both are safe to
          // prune after the locked re-check below.
          needsRecheck.push(name);
        }
      } catch {
        // EACCES/EIO/torn JSON are not absence. Re-check under the membership
        // lock, retain the name if ambiguity persists, and surface the failure
        // to the caller instead of silently making the bee invisible forever.
        needsRecheck.push(name);
      }
    }
  }));

  const readFailures: Array<{ name: string; error: unknown }> = [];
  if (needsRecheck.length > 0) {
    // Re-check under the membership lock: a concurrent activation publishes
    // its name before its record, so the first read may legitimately see a
    // stale-looking entry while the writer is still in its critical section.
    await withFileLock(activeSessionIndexLockPath(paths.root), async () => {
      const current = (await readActiveSessionIndex(paths.root)) ?? await rebuildActiveSessionIndexLocked(paths);
      const names = new Set(current.active);
      let changed = false;
      for (const name of needsRecheck) {
        if (!names.has(name)) continue;
        try {
          const record = await loadSessionFromDirectories(name, paths.currentDir, paths.legacyDir);
          if (record && isActiveSessionRecord(record)) {
            if (!recordNames.has(record.name)) {
              records.push(record);
              recordNames.add(record.name);
            }
          } else {
            names.delete(name);
            changed = true;
          }
        } catch (error) {
          readFailures.push({ name, error });
        }
      }
      if (changed) {
        await writeActiveSessionIndex(makeActiveSessionIndex(paths.root, names, {
          reconciledAt: current.reconciledAt,
          directoryMtimeMs: current.directoryMtimeMs,
        }));
      }
    }, { timeoutMs: 60_000 });
  }

  if (readFailures.length > 0) {
    // Both policies retain ambiguous membership and emit bounded telemetry.
    // Daemon work stays available from the readable subset; direct account
    // selection rejects because partial totals could stack new work onto the
    // unreadable bee's account.
    reportActiveIndexReadFailures(paths.root, readFailures);
    if (options.ambiguousReadPolicy === "reject") {
      throw new AggregateError(
        readFailures.map(({ error }) => error),
        `could not authoritatively read ${readFailures.length} indexed active session record(s)`,
      );
    }
  }

  return {
    records: records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    directoryMtimeMs: index.directoryMtimeMs ?? null,
  };
}

async function listSessionsSnapshot(currentDir: string, legacyDir: string): Promise<SessionRecord[]> {
  const snapshot = await scanSessionsSnapshot(currentDir, legacyDir);
  if (snapshot.readFailures.length > 0) {
    const detail = snapshot.readFailures.map(({ dir, file, error }) =>
      `${join(dir, file)}: ${error instanceof Error ? error.message : String(error)}`);
    process.emitWarning(
      `session record scan skipped malformed/unreadable source(s): ${detail.join("; ")}`,
      { code: "HIVE_SESSION_RECORD_READ", type: "HiveStoreWarning" },
    );
  }
  return snapshot.records;
}

type SessionSnapshotScan = {
  records: SessionRecord[];
  readFailures: Array<{ dir: string; file: string; error: unknown }>;
};

async function scanSessionsSnapshot(currentDir: string, legacyDir: string): Promise<SessionSnapshotScan> {
  await mkdir(currentDir, { recursive: true });
  const [files, legacyFiles] = await Promise.all([
    readdir(currentDir),
    readdir(legacyDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }),
  ]);
  const seen = new Set<string>();
  const candidates: Array<{ dir: string; file: string }> = [];

  for (const [dir, dirFiles] of [[currentDir, files], [legacyDir, legacyFiles]] as const) {
    for (const file of dirFiles.filter((name) => name.endsWith(".json"))) {
      if (seen.has(file)) continue;
      seen.add(file);
      candidates.push({ dir, file });
    }
  }

  const records: SessionRecord[] = [];
  const readFailures: SessionSnapshotScan["readFailures"] = [];
  let cursor = 0;
  const workerCount = Math.min(DEFAULT_LIST_SESSION_CONCURRENCY, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      if (!candidate) continue;
      try {
        records.push(await readSessionRecord(join(candidate.dir, candidate.file)));
      } catch (error) {
        readFailures.push({ ...candidate, error });
      }
    }
  }));

  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { records, readFailures };
}

export async function appendLedger(event: Record<string, unknown>) {
  await ensureStore();
  const path = ledgerPath();
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  const bytes = Buffer.byteLength(line);
  const maxBytes = ledgerMaxBytes();

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    ledgerSizeCache = undefined;
    await writeLedgerLine(path, line);
    return;
  }

  if (shouldCheckLedgerRotation(path, maxBytes, bytes)) {
    await withFileLock(`${path}.lock`, async () => {
      const currentSize = await rotateLedgerIfNeeded(path, maxBytes);
      await writeLedgerLine(path, line);
      rememberLedgerSize(path, maxBytes, currentSize + bytes, 0);
    });
    return;
  }

  await writeLedgerLine(path, line);
  if (ledgerSizeCache && ledgerSizeCache.path === path && ledgerSizeCache.maxBytes === maxBytes) {
    rememberLedgerSize(path, maxBytes, ledgerSizeCache.estimatedSize + bytes, ledgerSizeCache.appendsSinceCheck + 1);
  }
}

const LEDGER_ROTATION_CHECK_APPENDS = 64;

type LedgerSizeCache = {
  path: string;
  maxBytes: number;
  estimatedSize: number;
  appendsSinceCheck: number;
};

let ledgerSizeCache: LedgerSizeCache | undefined;

function shouldCheckLedgerRotation(path: string, maxBytes: number, nextBytes: number): boolean {
  const cache = ledgerSizeCache;
  if (!cache || cache.path !== path || cache.maxBytes !== maxBytes) return true;
  if (cache.appendsSinceCheck >= LEDGER_ROTATION_CHECK_APPENDS) return true;
  return cache.estimatedSize + nextBytes >= maxBytes;
}

function rememberLedgerSize(path: string, maxBytes: number, estimatedSize: number, appendsSinceCheck: number): void {
  ledgerSizeCache = { path, maxBytes, estimatedSize, appendsSinceCheck };
}

async function writeLedgerLine(path: string, line: string): Promise<void> {
  await appendFile(path, line, { mode: 0o600 });
}

export function safeName(value: string) {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/g, "-");
  if (/^[.]*$/.test(sanitized)) return sanitized.replace(/[.]/g, "-") || "-";
  return sanitized;
}

async function readSessionRecord(path: string): Promise<SessionRecord> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in session record ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = normalizeSessionRecord(parsed, path);
  const source = basename(path);
  const expected = `${record.name}.json`;
  if (record.name !== safeName(record.name) || source !== expected) {
    throw new Error(
      `Invalid session record identity ${path}: embedded name ${JSON.stringify(record.name)} ` +
      `must be canonical and match source filename ${JSON.stringify(source)}`,
    );
  }
  return record;
}

const OPTIONAL_STRING_SESSION_KEYS = ["notes", "id", "prefix", "uuid", "requestedAgent", "homePath", "lastPrompt", "lastPromptAt", "transcriptPath", "providerSessionId", "terminalTranscriptDiscoveryAt", "sealHighWaterFilename", "title", "autoTitleAt", "colony", "swarmId", "caste", "brief", "briefedAt", "lastError", "node", "lastObservedState", "lastObservedStateAt", "runId", "flowName", "accountId", "agentPaneId", "combId", "parentId", "reportsToId", "spawnedById", "forkedFromId", "forkedAt", "seedMode", "forkCheckpoint", "model", "modelExtraArgs", "runnerTier", "poolKey", "kitVersion", "kitProfile", "lastReviveCommand"] as const;

const KNOWN_SESSION_KEYS = new Set<string>([
  "name", "agent", "cwd", "command", "tmuxTarget", "createdAt", "updatedAt", "status",
  ...OPTIONAL_STRING_SESSION_KEYS,
  "launchArgv",
  "substrate",
  "runnerPid",
  "remoteTokenExpiresAt",
  "launcherPgid",
  "poolMember",
  "titleSource",
  "providerTitleKind",
  "autoTitleAttempts",
  "runtimeGeneration",
  "buzAccept",
  "taskSupply",
  "tags",
  "contract",
  "preamble",
  "combActivations",
]);

const DANGEROUS_SESSION_META_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeSessionRecord(value: unknown, path: string): SessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid session record shape: ${path}`);
  // Parse through a null-prototype bag so neither a polluted Object.prototype
  // nor JSON keys such as `__proto__` can supply security-sensitive fields.
  // Dangerous meta keys are rejected instead of round-tripped: older binaries
  // never emitted them, and accepting them would let a later plain assignment
  // mutate the normalized record's prototype.
  const object = Object.create(null) as Record<string, unknown>;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_SESSION_META_KEYS.has(key)) {
      throw new Error(`Invalid session record ${path}: disallowed metadata key ${JSON.stringify(key)}`);
    }
    Object.defineProperty(object, key, {
      value: raw,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  for (const key of ["name", "agent", "cwd", "command", "tmuxTarget", "createdAt", "updatedAt"]) {
    if (typeof object[key] !== "string") throw new Error(`Invalid session record ${path}: missing string ${key}`);
  }

  const record: SessionRecord = {
    name: object.name as string,
    agent: object.agent as string,
    cwd: object.cwd as string,
    command: object.command as string,
    tmuxTarget: object.tmuxTarget as string,
    createdAt: object.createdAt as string,
    updatedAt: object.updatedAt as string,
    status:
      object.status === "running" || object.status === "dead" || object.status === "kill_failed" || object.status === "done"
        ? object.status
        : // Legacy filed records predate the archived → done rename.
          object.status === "archived"
          ? "done"
          : "dead",
  };

  for (const key of OPTIONAL_STRING_SESSION_KEYS) {
    if (typeof object[key] === "string") record[key] = object[key];
  }

  // Structured original launch. Invalid/empty arrays are ignored so a newer
  // or hand-edited record degrades to the legacy rendered-command fallback.
  if (Array.isArray(object.launchArgv) && object.launchArgv.length > 0 && object.launchArgv.every((part) => typeof part === "string")) {
    record.launchArgv = [...object.launchArgv] as string[];
  }

  if (object.autoswap === true) record.autoswap = true;

  // Session preamble: forward-compatible like contract — a malformed block is
  // dropped on load rather than throwing. An unknown channel degrades to
  // "message", the conservative reading (a system-prompt preamble already rode
  // argv, so mis-reading it as a message only risks one redundant prefix,
  // whereas the reverse would silently drop it).
  if (object.preamble && typeof object.preamble === "object" && !Array.isArray(object.preamble)) {
    const raw = object.preamble as Record<string, unknown>;
    if (typeof raw.text === "string" && raw.text.length > 0) {
      record.preamble = {
        text: raw.text,
        channel: raw.channel === "system-prompt" ? "system-prompt" : "message",
        ...(raw.delivered === true ? { delivered: true } : {}),
      };
    }
  }

  // Completion contract: forward-compatible like buzAccept — an invalid or
  // unknown-shaped contract is dropped on load, never thrown.
  if (object.contract !== undefined) {
    const contract = normalizeContract(object.contract);
    if (contract) record.contract = contract;
  }

  if (Array.isArray(object.combActivations)) {
    const bindings: CombActivationBinding[] = [];
    for (const value of object.combActivations) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const raw = value as Record<string, unknown>;
      if (
        typeof raw.runId !== "string" ||
        typeof raw.nodeId !== "string" ||
        !Number.isSafeInteger(raw.attempt) ||
        !Number.isSafeInteger(raw.itemIndex) ||
        typeof raw.taskId !== "string" ||
        (raw.status !== "current" && raw.status !== "historical") ||
        typeof raw.attachedAt !== "string"
      ) continue;
      bindings.push({
        runId: raw.runId,
        nodeId: raw.nodeId,
        attempt: raw.attempt as number,
        itemIndex: raw.itemIndex as number,
        taskId: raw.taskId,
        status: raw.status,
        attachedAt: raw.attachedAt,
        ...(typeof raw.trackDigest === "string" ? { trackDigest: raw.trackDigest } : {}),
        ...(typeof raw.deliveredAt === "string" ? { deliveredAt: raw.deliveredAt } : {}),
        ...(typeof raw.endedAt === "string" ? { endedAt: raw.endedAt } : {}),
      });
    }
    if (bindings.length) record.combActivations = bindings;
  }

  // HSR fields. `substrate` is a closed union (absent = local-tmux); an
  // unrecognized value is dropped rather than trusted. runnerPid is validated
  // like launcherPgid; runnerTier rides the optional-string loop above.
  if (object.substrate === "local-tmux" || object.substrate === "hsr") {
    record.substrate = object.substrate;
  }
  if (typeof object.runnerPid === "number" && Number.isSafeInteger(object.runnerPid) && object.runnerPid > 0) {
    record.runnerPid = object.runnerPid;
  }
  if (typeof object.remoteTokenExpiresAt === "number" && Number.isFinite(object.remoteTokenExpiresAt) && object.remoteTokenExpiresAt > 0) {
    record.remoteTokenExpiresAt = object.remoteTokenExpiresAt;
  }

  if (object.titleSource === "user" || object.titleSource === "auto" || object.titleSource === "provider") {
    record.titleSource = object.titleSource;
  }
  if (object.providerTitleKind === "generated" || object.providerTitleKind === "fallback") {
    record.providerTitleKind = object.providerTitleKind;
  }

  if (typeof object.autoTitleAttempts === "number" && Number.isFinite(object.autoTitleAttempts)) {
    record.autoTitleAttempts = object.autoTitleAttempts;
  }
  if (typeof object.runtimeGeneration === "number" && Number.isSafeInteger(object.runtimeGeneration) && object.runtimeGeneration >= 0) {
    record.runtimeGeneration = object.runtimeGeneration;
  }
  if (typeof object.launcherPgid === "number" && Number.isSafeInteger(object.launcherPgid) && object.launcherPgid > 0) {
    record.launcherPgid = object.launcherPgid;
  }
  // Pool member numbers are 1-based (`<pool>-<n>`); validated like launcherPgid.
  if (typeof object.poolMember === "number" && Number.isSafeInteger(object.poolMember) && object.poolMember > 0) {
    record.poolMember = object.poolMember;
  }

  // buzAccept is the per-bee acceptance policy for buz messages. The field
  // is forward-compatible: unknown tier values are dropped silently so an
  // older binary reading a record written by a newer one does not throw.
  if (Array.isArray(object.buzAccept)) {
    const tiers = object.buzAccept.filter(
      (value): value is BuzTier => isBuzTier(value),
    );
    if (tiers.length > 0) record.buzAccept = tiers;
  }

  // taskSupply is the per-bee auto-supply config. Forward-compatible like
  // buzAccept: an invalid shape is dropped on load, never thrown; invalid
  // sub-fields are dropped individually (resolveTaskSupply re-defaults them).
  if (typeof object.taskSupply === "object" && object.taskSupply !== null && !Array.isArray(object.taskSupply)) {
    const raw = object.taskSupply as Record<string, unknown>;
    if (typeof raw.on === "boolean") {
      const config: TaskSupplyConfig = { on: raw.on };
      if (typeof raw.limit === "number" && Number.isSafeInteger(raw.limit) && raw.limit > 0) config.limit = raw.limit;
      if (typeof raw.feeds === "number" && Number.isSafeInteger(raw.feeds) && raw.feeds >= 0) config.feeds = raw.feeds;
      if (raw.paused === true) config.paused = true;
      record.taskSupply = config;
    }
  }

  // tags is the array of free-form user labels (bare or power-user namespaced,
  // e.g. ["migration", "prio:p1"]). Like buzAccept, it is forward-compatible:
  // grammar-invalid OR reserved-namespace entries are DROPPED on load — not
  // thrown — so a hand-edited file that smuggles `colony:x` into tags, or a
  // record written by a newer binary, never crashes a load (PRD §13, S1). The
  // list is deduped and capped (MAX_TAGS_PER_BEE).
  if (Array.isArray(object.tags)) {
    const validated = dedupeTags(
      object.tags.filter((item): item is string => typeof item === "string").filter((tag) => isValidSessionTag(tag)),
    ).slice(0, MAX_TAGS_PER_BEE);
    if (validated.length > 0) record.tags = validated;
  }

  // Carry unknown keys through untouched so an older binary's load→save cycle
  // does not destroy fields written by a newer version. They ride along as
  // extra runtime properties (invisible to the SessionRecord type) and are
  // serialized back out on the next save.
  for (const [key, raw] of Object.entries(object)) {
    if (!KNOWN_SESSION_KEYS.has(key)) {
      Object.defineProperty(record, key, {
        value: raw,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  return record;
}

function legacyRoot() {
  if (process.env.HIVE_STORE_ROOT) return join(storeRoot(), "legacy-agentpit");
  return join(homedir(), ".agentpit");
}

function sessionsDir() {
  return join(storeRoot(), "sessions");
}

function legacySessionsDir() {
  return join(legacyRoot(), "sessions");
}

export function ledgerPath(): string {
  return join(storeRoot(), "ledger.jsonl");
}

function ledgerMaxBytes(): number {
  return Number(process.env.HIVE_LEDGER_MAX_BYTES ?? 10 * 1024 * 1024);
}

async function rotateLedgerIfNeeded(path: string, maxBytes: number): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (info.size < maxBytes) return info.size;
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const rotated = await rename(path, `${path}.${suffix}`).then(() => true, () => false);
  if (!rotated) return (await stat(path).catch(() => null))?.size ?? 0;
  await pruneLedgerRotations(path);
  return 0;
}

// Rotation suffixes are ISO timestamps with `:`/`.` replaced by `-`, e.g.
// `ledger.jsonl.2026-06-10T12-34-56-789Z`. The strict pattern keeps the lock
// file (`ledger.jsonl.lock`) and stray temp files out of the prune sweep.
const LEDGER_ROTATION_SUFFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

const DEFAULT_LEDGER_KEEP_ROTATIONS = 5;

async function pruneLedgerRotations(path: string = ledgerPath()): Promise<void> {
  const keep = Number(process.env.HIVE_LEDGER_KEEP_ROTATIONS ?? DEFAULT_LEDGER_KEEP_ROTATIONS);
  if (!Number.isFinite(keep) || keep < 0) return;
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  const rotations = entries
    .filter((entry) => entry.startsWith(prefix) && LEDGER_ROTATION_SUFFIX_RE.test(entry.slice(prefix.length)))
    .sort()
    .reverse();
  for (const stale of rotations.slice(Math.floor(keep))) {
    await rm(join(dir, stale), { force: true }).catch(() => undefined);
  }
}
