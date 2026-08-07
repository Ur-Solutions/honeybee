import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { canonicalActivationHomePath, readActivationHomeOwner, withActivationHomeLock } from "./accounts/activation.js";
import { hsrRoot } from "./hsr/runDir.js";
import { withSessionLifecycleLock, withSessionLifecycleTransaction, type SessionLifecycleTransaction } from "./lifecycle.js";
import { sealsRoot } from "./seal.js";
import {
  appendLedger,
  deleteSessionLocked,
  isActiveSessionRecord,
  listSessions,
  safeName,
  withSessionLock,
  type SessionRecord,
} from "./store.js";
import { syncCredentialPairIsolated } from "./daemon/credentialSweepProcess.js";
import { LOCAL_NODE_NAME } from "./node.js";
import { dropPoolClaimsForBee } from "./pool.js";
import { stopFailedRequestId } from "./requests/keys.js";
import { cancelOpenRequests, openRequest, removeBeeRequests, resolveRequest } from "./requests/store.js";
import { substrateFor, type Substrate } from "./substrates/index.js";

export type TransactionalKillOptions = {
  /** Substrate to drive (default: substrateFor(record)). Injectable for tests. */
  substrate?: Substrate;
  /** Poll attempts to confirm session is gone after substrate.kill (default 4). */
  pollAttempts?: number;
  /** Delay between poll attempts in ms (default 750). */
  pollIntervalMs?: number;
  /** Sleep implementation (default setTimeout). Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Append a ledger event (default true). */
  emitLedger?: boolean;
  /** Injectable best-effort final credential harvest after runtime exit. */
  finalCredentialSync?: (record: SessionRecord) => Promise<void>;
  /** Hard outer budget for finalCredentialSync (default 10s). */
  finalCredentialSyncBudgetMs?: number;
  /** Deterministic race-test hook after old-runtime teardown confirmation. */
  afterTeardown?: (record: SessionRecord) => Promise<void>;
};

export type PurgeSessionDataOptions = Pick<
  TransactionalKillOptions,
  "emitLedger" | "finalCredentialSync" | "finalCredentialSyncBudgetMs"
>;

export type KillOutcome =
  | { ok: true; alreadyGone: boolean; attempts: number }
  | { ok: false; lastError: string; stillRunning: boolean; attempts: number };

const DEFAULT_POLL_ATTEMPTS = 4;
const DEFAULT_POLL_INTERVAL_MS = 750;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

type TeardownVerdict = {
  attempts: number;
  alreadyGone: boolean;
  killReturnedFailure: boolean;
  stillRunning: boolean;
  lastError?: string;
};

/**
 * Explicit irreversible purge shared by `kill` and every clean mode. Artifact
 * stores are removed before the SessionRecord, so an interrupted purge keeps
 * the retry handle instead of leaving unaddressable seals/run data behind.
 * `deleteSession` remains the intentionally metadata-only low-level primitive.
 */
export async function purgeSessionData(
  record: SessionRecord,
  options: PurgeSessionDataOptions = {},
): Promise<void> {
  // Hardened readers intentionally reject a malformed embedded name, but
  // clean/purge must still be able to contain and remove its sanitized file
  // and artifacts. Such a record cannot participate in generation CAS (it is
  // not authoritative readable input), so serialize on the sanitized
  // lifecycle + session locks and retain the record-last retry semantics.
  if (safeName(record.name) !== record.name) {
    await withSessionLifecycleLock(record.name, async () => {
      await runFinalCredentialSync(record, options);
      await withSessionLock(record.name, async () => {
        await rm(containedArtifactPath(sealsRoot(), record.name), { recursive: true, force: true });
        await rm(containedArtifactPath(hsrRoot(), record.name), { recursive: true, force: true });
        await removeBeeRequests(record.name);
        await deleteSessionLocked(record.name);
      });
      if (record.poolKey) await dropPoolClaimsForBee(record.poolKey, record.name).catch(() => undefined);
    });
    return;
  }
  await withSessionLifecycleTransaction(record, async (lifecycle) => {
    await purgeSessionDataInTransaction(lifecycle, options);
  });
}

async function purgeSessionDataInTransaction(
  lifecycle: SessionLifecycleTransaction,
  options: PurgeSessionDataOptions,
): Promise<void> {
  const record = await lifecycle.refresh();
  // Credential harvest can touch the keychain, vault, and account locks. It is
  // deliberately bounded and completed before any artifact/session lock is
  // acquired or any retry handle is deleted.
  await runFinalCredentialSync(record, options);
  // The short record lock below is the destructive CAS point. Everything in
  // the callback is known not to re-acquire that lock; if cleanup is
  // interrupted, the canonical record remains the retry handle until the last
  // delete step.
  await lifecycle.destructiveCommit(async (current) => {
    await rm(containedArtifactPath(sealsRoot(), current.name), { recursive: true, force: true });
    await rm(containedArtifactPath(hsrRoot(), current.name), { recursive: true, force: true });
    await removeBeeRequests(current.name);
    await deleteSessionLocked(current.name);
  });
  if (record.poolKey) await dropPoolClaimsForBee(record.poolKey, record.name).catch(() => undefined);
}

/**
 * Session JSON is durable input and may be hand-edited or corrupted. Never let
 * its display name become a recursive-delete path: sanitize the leaf and then
 * prove the resolved target remains a strict child of the artifact root.
 */
function containedArtifactPath(root: string, bee: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, safeName(bee));
  if (!target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Refusing to purge artifact path outside ${resolvedRoot}`);
  }
  return target;
}

/**
 * Shared teardown core for kill and retire: substrate.kill -> poll
 * substrate.hasSession until the session is confirmed gone (or we give up).
 * Pure runtime work — the caller decides what happens to the SessionRecord.
 */
async function teardownSession(
  record: SessionRecord,
  options: TransactionalKillOptions,
): Promise<TeardownVerdict> {
  const substrate = options.substrate ?? substrateFor(record);
  const pollAttempts = Math.max(1, options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const sleep = options.sleep ?? defaultSleep;

  let attempts = 0;
  let killReturnedFailure = false;
  let killStderr: string | undefined;

  // Fast path: if the session is already gone, skip the substrate.kill call so
  // we report "alreadyGone" instead of swallowing an error from killing a
  // session that never existed.
  let alreadyGone = false;
  try {
    if (!(await substrate.hasSession(record.tmuxTarget))) alreadyGone = true;
  } catch {
    // Probe failures are non-fatal here; proceed to attempt kill.
  }

  // remote-hsr's kill RPC is also the remote cleanup hook: it shreds delivered
  // ephemeral credentials (APIA-93) and removes the remote run dir. A bee that
  // exited on its own still needs that, so the already-gone fast-path must not
  // skip the RPC there (it is idempotent on the remote).
  const needsRemoteCleanup = substrate.kind === "remote-hsr";
  const needsRemoteGroupProof = substrate.kind === "ssh-tmux";
  if (!alreadyGone || record.launcherPgid || needsRemoteCleanup || needsRemoteGroupProof) {
    attempts += 1;
    try {
      const killResult = await substrate.kill(record.tmuxTarget, {
        launcherPgid: record.launcherPgid,
        launcherFingerprint: record.launcherFingerprint,
      });
      if (!killResult.ok) {
        killReturnedFailure = true;
        killStderr = killResult.stderr?.trim() || killResult.stdout?.trim() || `kill exited with code ${killResult.exitCode}`;
      }
    } catch (error) {
      killReturnedFailure = true;
      killStderr = errorMessage(error);
    }
  }

  // Poll hasSession a few times so substrates with eventually-consistent
  // teardown (ssh-tmux, slow tmux server) have a chance to settle.
  let stillRunning = false;
  let lastProbeError: string | undefined;
  for (let i = 0; i < pollAttempts; i += 1) {
    try {
      const exists = await substrate.hasSession(record.tmuxTarget);
      if (!exists) {
        stillRunning = false;
        lastProbeError = undefined;
        break;
      }
      stillRunning = true;
    } catch (error) {
      lastProbeError = errorMessage(error);
      stillRunning = true; // We can't confirm it's gone, so treat as still-running.
    }
    if (i < pollAttempts - 1 && pollIntervalMs > 0) await sleep(pollIntervalMs);
  }

  return {
    attempts,
    alreadyGone,
    killReturnedFailure,
    stillRunning,
    ...(stillRunning || killReturnedFailure
      ? { lastError: lastProbeError ?? killStderr ?? "exact runtime cleanup is unconfirmed" }
      : {}),
  };
}

/**
 * Open the durable stop-failed manual-action request right after writing
 * status kill_failed (docs/INTERVENTION_REQUESTS.md): the recorded stop
 * intent is a fact, so the record is structured-grade even though the runtime
 * itself was only pane/pid-observed. Idempotent per generation; best-effort —
 * the kill outcome must be reported even when the request store misbehaves.
 */
async function openStopFailedRequest(record: SessionRecord, lastError: string): Promise<void> {
  const generation = record.runtimeGeneration ?? 0;
  await openRequest(record.name, {
    id: stopFailedRequestId(record.name, generation),
    kind: "manual-action",
    scope: "runtime-generation",
    grade: "structured",
    generation,
    question: `stop failed: ${lastError}`,
    evidence: { grade: "structured", source: "session-record", detail: "kill_failed" },
  }).catch(() => undefined);
}

/**
 * Harvest a runner home's last rotated credential after its process is
 * confirmed gone, before retire/purge makes the SessionRecord historical or
 * removes it. The record plus physical owner validation authorizes the home as
 * a locator; the isolated worker still requires provider content identity
 * before those bytes may enter the account vault.
 */
export async function syncSessionCredentialsOnExit(record: SessionRecord, timeoutMs?: number): Promise<void> {
  if (!record.accountId || !record.homePath) return;
  const outcome = await syncCredentialPairIsolated(record.accountId, record.homePath, { ...(timeoutMs ? { timeoutMs } : {}) });
  if (outcome.failedPairs > 0 || outcome.timedOutPairs > 0) throw new Error("final credential sync failed");
}

type CredentialBindingConflict = {
  accountId: string;
  reason: "home-rebound" | "activation-incomplete";
  session?: string;
  activationGeneration?: string;
};

function sessionBindingTime(record: SessionRecord): number {
  for (const value of [record.updatedAt, record.lastPromptAt, record.createdAt]) {
    const parsed = Date.parse(value ?? "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function conflictingHomeBinding(
  record: SessionRecord,
  canonicalHomePath: string,
): Promise<CredentialBindingConflict | null> {
  if (!record.accountId || !record.homePath) return null;
  const owner = await readActivationHomeOwner(canonicalHomePath);
  let bindingTime = sessionBindingTime(record);
  if (owner) {
    if (owner.state !== "ready") {
      return {
        accountId: owner.accountId,
        reason: "activation-incomplete",
        activationGeneration: owner.generation,
      };
    }
    if (owner.accountId !== record.accountId) {
      return { accountId: owner.accountId, reason: "home-rebound", activationGeneration: owner.generation };
    }
    bindingTime = Date.parse(owner.updatedAt);
    if (!Number.isFinite(bindingTime)) {
      return {
        accountId: owner.accountId,
        reason: "activation-incomplete",
        activationGeneration: owner.generation,
      };
    }
  }

  // Mixed-version writers do not update owner stamps. Even a matching ready
  // stamp must therefore yield to a live or newer foreign SessionRecord for
  // the same physical home. Without a stamp, the record itself is the legacy
  // ownership reference point.
  const candidates: SessionRecord[] = [];
  for (const candidate of await listSessions()) {
    if (
      candidate.name === record.name ||
      !candidate.accountId ||
      candidate.accountId === record.accountId ||
      !candidate.homePath ||
      (!isActiveSessionRecord(candidate) && sessionBindingTime(candidate) <= bindingTime)
    ) continue;
    if (await canonicalActivationHomePath(candidate.homePath) === canonicalHomePath) candidates.push(candidate);
  }
  candidates.sort((a, b) => {
    const live = Number(isActiveSessionRecord(b)) - Number(isActiveSessionRecord(a));
    if (live !== 0) return live;
    return sessionBindingTime(b) - sessionBindingTime(a);
  });
  const conflict = candidates[0];
  return conflict?.accountId
    ? { accountId: conflict.accountId, reason: "home-rebound", session: conflict.name }
    : null;
}

async function boundedCredentialSync(
  record: SessionRecord,
  sync: (record: SessionRecord) => Promise<void>,
  budgetMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sync(record),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`final credential sync timed out after ${budgetMs}ms`)), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runFinalCredentialSync(record: SessionRecord, options: PurgeSessionDataOptions): Promise<void> {
  if (!record.accountId || !record.homePath) return;
  const budgetMs = options.finalCredentialSyncBudgetMs ?? 10_000;
  const sync = options.finalCredentialSync ?? ((candidate: SessionRecord) =>
    syncSessionCredentialsOnExit(candidate, Math.max(1, budgetMs - 1_000)));
  const startedAt = Date.now();
  const binding: { conflict: CredentialBindingConflict | null } = { conflict: null };
  let ok = false;
  try {
    // Every home, including a nominal per-account slot, is publicly
    // activatable through an explicit --home path. Activation and final
    // harvest therefore always take the same resolved-home lock and validate
    // its owner stamp before trusting bytes.
    let expired = false;
    let overallTimer: NodeJS.Timeout | undefined;
    const lockedHarvest = withActivationHomeLock(record.homePath, async (canonicalHomePath) => {
      binding.conflict = await conflictingHomeBinding(record, canonicalHomePath);
      if (binding.conflict || expired) return;
      const remainingMs = budgetMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new Error(`final credential sync timed out after ${budgetMs}ms`);
      await boundedCredentialSync({ ...record, homePath: canonicalHomePath }, sync, remainingMs);
      if (!expired) ok = true;
    }, { timeoutMs: Math.max(1, budgetMs) });
    try {
      await Promise.race([
        lockedHarvest,
        new Promise<never>((_resolve, reject) => {
          overallTimer = setTimeout(() => {
            expired = true;
            reject(new Error(`final credential ownership validation timed out after ${budgetMs}ms`));
          }, budgetMs);
        }),
      ]);
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
    }
  } catch {
    // Runtime teardown must remain available during a credential outage. The
    // daemon's historical-home sweep remains the recovery backstop.
    ok = false;
  }
  if (options.emitLedger !== false) {
    const conflict = binding.conflict;
    await appendLedger({
      type: "account.final-sync",
      session: record.name,
      account: record.accountId,
      ok,
      ...(conflict ? {
        skipped: conflict.reason,
        ownerAccount: conflict.accountId,
        ...(conflict.session ? { ownerSession: conflict.session } : {}),
        ...(conflict.activationGeneration ? { ownerGeneration: conflict.activationGeneration } : {}),
      } : {}),
    }).catch(() => undefined);
  }
}

/**
 * Transactional kill: substrate.kill -> poll substrate.hasSession -> only then
 * deleteSession. On failure (session still exists after polling, or its absence
 * cannot be confirmed), the SessionRecord is updated with status='kill_failed'
 * and lastError. The record is NOT deleted while the bee may still be running.
 *
 * DESTRUCTIVE: the SessionRecord is removed from the store, so the bee cannot
 * be revived afterwards. This is the GC half of the lifecycle (`hive kill`,
 * `hive clean`); the everyday way to end a bee is transactionalRetire, which
 * keeps the record.
 *
 * Returns a KillOutcome describing whether the bee is gone (ok=true) or still
 * suspected of running (ok=false), plus the captured lastError when applicable.
 */
export async function transactionalKill(
  record: SessionRecord,
  options: TransactionalKillOptions = {},
): Promise<KillOutcome> {
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    const emitLedger = options.emitLedger !== false;
    const node = current.node ?? LOCAL_NODE_NAME;
    const verdict = await teardownSession(current, options);
    await options.afterTeardown?.(current);

    // Pane/session absence cannot override an indeterminate exact process-group
    // stop: an escaped child may have survived after tmux removed the target.
    if (verdict.stillRunning || verdict.killReturnedFailure) {
      const lastError = verdict.lastError ?? "exact runtime cleanup is unconfirmed";
      const failed = await lifecycle.commit({
        status: "kill_failed",
        lastError,
        updatedAt: new Date().toISOString(),
      });
      await openStopFailedRequest(failed, lastError);
      if (emitLedger) {
        await appendLedger({
          type: "session.kill",
          session: current.name,
          node,
          ok: false,
          attempts: verdict.attempts,
          lastError,
        });
      }
      return { ok: false, lastError, stillRunning: true, attempts: verdict.attempts };
    }

    await lifecycle.refresh();
    await purgeSessionDataInTransaction(lifecycle, options);
    if (emitLedger) {
      await appendLedger({
        type: "session.kill",
        session: current.name,
        node,
        ok: true,
        attempts: verdict.attempts,
      });
    }
    return { ok: true, alreadyGone: verdict.alreadyGone && !verdict.killReturnedFailure, attempts: verdict.attempts };
  });
}

/**
 * Transactional retire: the everyday way to end a bee. Tears down the runtime
 * exactly like transactionalKill (substrate.kill -> poll hasSession), then
 * FILES the record (status='done') instead of deleting it — the bee
 * leaves the active list but its record, seals, ledger history, and provider
 * session stay intact, so `hive revive` can bring it back and `hive seals` /
 * `hive spend` keep working. Distinguishes deliberate retirement from a crash:
 * a record still 'running' whose session is gone was never retired, so state
 * derivation reports it 'crashed'.
 */
export async function transactionalRetire(
  record: SessionRecord,
  options: TransactionalKillOptions = {},
): Promise<KillOutcome> {
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    const emitLedger = options.emitLedger !== false;
    const node = current.node ?? LOCAL_NODE_NAME;
    const verdict = await teardownSession(current, options);
    await options.afterTeardown?.(current);

    if (verdict.stillRunning || verdict.killReturnedFailure) {
      const lastError = verdict.lastError ?? "exact runtime cleanup is unconfirmed";
      const failed = await lifecycle.commit({
        status: "kill_failed",
        lastError,
        updatedAt: new Date().toISOString(),
      });
      await openStopFailedRequest(failed, lastError);
      if (emitLedger) {
        await appendLedger({
          type: "session.retire",
          session: current.name,
          node,
          ok: false,
          attempts: verdict.attempts,
          lastError,
        });
      }
      return { ok: false, lastError, stillRunning: true, attempts: verdict.attempts };
    }

    await lifecycle.refresh();
    await runFinalCredentialSync(current, options);
    const retired = await lifecycle.commit({
      status: "done",
      updatedAt: new Date().toISOString(),
      // A retired bee must not keep reporting a stale error from an earlier
      // failed kill; explicit undefined deletes the field.
      lastError: undefined,
    });
    // Request closures happen only after the generation-checked terminal
    // commit. A stale retire can therefore never close a replacement's asks.
    await resolveRequest(retired.name, stopFailedRequestId(retired.name, retired.runtimeGeneration ?? 0), { by: "stop-succeeded" }).catch(() => undefined);
    await cancelOpenRequests(retired.name, {}, "scope-closed", "retired").catch(() => undefined);
    if (retired.poolKey) await dropPoolClaimsForBee(retired.poolKey, retired.name).catch(() => undefined);
    if (emitLedger) {
      await appendLedger({
        type: "session.retire",
        session: current.name,
        node,
        ok: true,
        attempts: verdict.attempts,
      });
    }
    return { ok: true, alreadyGone: verdict.alreadyGone && !verdict.killReturnedFailure, attempts: verdict.attempts };
  });
}
