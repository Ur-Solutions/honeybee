import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { hsrRoot } from "./hsr/runDir.js";
import { sealsRoot } from "./seal.js";
import { appendLedger, deleteSession, safeName, updateSession, type SessionRecord } from "./store.js";
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
  // Credential harvest can touch the keychain, vault, and account locks. It is
  // deliberately bounded and completed before any artifact/session lock is
  // acquired or any retry handle is deleted.
  await runFinalCredentialSync(record, options);
  await rm(containedArtifactPath(sealsRoot(), record.name), { recursive: true, force: true });
  await rm(containedArtifactPath(hsrRoot(), record.name), { recursive: true, force: true });
  await removeBeeRequests(record.name);
  await deleteSession(record.name);
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
  if (!alreadyGone || record.launcherPgid || needsRemoteCleanup) {
    attempts += 1;
    try {
      const killResult = await substrate.kill(record.tmuxTarget, { launcherPgid: record.launcherPgid });
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
    ...(stillRunning ? { lastError: lastProbeError ?? killStderr ?? "session still exists after kill" } : {}),
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
 * removes it. The explicit record binding is the trust proof for an arbitrary
 * home; provider-specific sync still validates identities where possible.
 */
export async function syncSessionCredentialsOnExit(record: SessionRecord, timeoutMs?: number): Promise<void> {
  if (!record.accountId || !record.homePath) return;
  const outcome = await syncCredentialPairIsolated(record.accountId, record.homePath, { ...(timeoutMs ? { timeoutMs } : {}) });
  if (outcome.failedPairs > 0 || outcome.timedOutPairs > 0) throw new Error("final credential sync failed");
}

async function runFinalCredentialSync(record: SessionRecord, options: PurgeSessionDataOptions): Promise<void> {
  if (!record.accountId || !record.homePath) return;
  const budgetMs = options.finalCredentialSyncBudgetMs ?? 10_000;
  const sync = options.finalCredentialSync ?? ((candidate: SessionRecord) =>
    syncSessionCredentialsOnExit(candidate, Math.max(1, budgetMs - 1_000)));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sync(record),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`final credential sync timed out after ${budgetMs}ms`)), budgetMs);
      }),
    ]);
    if (options.emitLedger !== false) {
      await appendLedger({ type: "account.final-sync", session: record.name, account: record.accountId, ok: true });
    }
  } catch {
    // Runtime teardown must remain available during a credential outage. The
    // daemon's historical-home sweep remains the recovery backstop.
    if (options.emitLedger !== false) {
      await appendLedger({ type: "account.final-sync", session: record.name, account: record.accountId, ok: false }).catch(() => undefined);
    }
  } finally {
    if (timer) clearTimeout(timer);
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
  const emitLedger = options.emitLedger !== false;
  const node = record.node ?? LOCAL_NODE_NAME;
  const verdict = await teardownSession(record, options);

  // Only the poll verdict decides failure: when it confirmed the session is
  // gone (stillRunning === false) we proceed to deleteSession even if the
  // substrate's kill call reported failure — the session may have died
  // between the hasSession fast-path and the kill (a benign race).
  if (verdict.stillRunning) {
    const lastError = verdict.lastError ?? "session still exists after kill";
    await updateSession(record.name, {
      status: "kill_failed",
      lastError,
      updatedAt: new Date().toISOString(),
    });
    await openStopFailedRequest(record, lastError);
    if (emitLedger) {
      await appendLedger({
        type: "session.kill",
        session: record.name,
        node,
        ok: false,
        attempts: verdict.attempts,
        lastError,
      });
    }
    return { ok: false, lastError, stillRunning: true, attempts: verdict.attempts };
  }

  await purgeSessionData(record, options);
  if (emitLedger) {
    await appendLedger({
      type: "session.kill",
      session: record.name,
      node,
      ok: true,
      attempts: verdict.attempts,
    });
  }
  return { ok: true, alreadyGone: verdict.alreadyGone && !verdict.killReturnedFailure, attempts: verdict.attempts };
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
  const emitLedger = options.emitLedger !== false;
  const node = record.node ?? LOCAL_NODE_NAME;
  const verdict = await teardownSession(record, options);

  if (verdict.stillRunning) {
    const lastError = verdict.lastError ?? "session still exists after retire";
    await updateSession(record.name, {
      status: "kill_failed",
      lastError,
      updatedAt: new Date().toISOString(),
    });
    await openStopFailedRequest(record, lastError);
    if (emitLedger) {
      await appendLedger({
        type: "session.retire",
        session: record.name,
        node,
        ok: false,
        attempts: verdict.attempts,
        lastError,
      });
    }
    return { ok: false, lastError, stillRunning: true, attempts: verdict.attempts };
  }

  await runFinalCredentialSync(record, options);
  // Request closures BEFORE filing (retire keeps the file — revivable
  // history): a pending stop-failed from an earlier failed kill/retire is now
  // a fact resolved by this successful stop; everything else open closes with
  // the bee. Order matters — resolve first so cancel-all can't claim it.
  await resolveRequest(record.name, stopFailedRequestId(record.name, record.runtimeGeneration ?? 0), { by: "stop-succeeded" }).catch(() => undefined);
  await cancelOpenRequests(record.name, {}, "scope-closed", "retired").catch(() => undefined);
  await updateSession(record.name, {
    status: "done",
    updatedAt: new Date().toISOString(),
    // A retired bee must not keep reporting a stale error from an earlier
    // failed kill; explicit undefined deletes the field.
    lastError: undefined,
  });
  if (record.poolKey) await dropPoolClaimsForBee(record.poolKey, record.name).catch(() => undefined);
  if (emitLedger) {
    await appendLedger({
      type: "session.retire",
      session: record.name,
      node,
      ok: true,
      attempts: verdict.attempts,
    });
  }
  return { ok: true, alreadyGone: verdict.alreadyGone && !verdict.killReturnedFailure, attempts: verdict.attempts };
}
