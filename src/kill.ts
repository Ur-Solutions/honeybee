import { appendLedger, deleteSession, updateSession, type SessionRecord } from "./store.js";
import { LOCAL_NODE_NAME } from "./node.js";
import { dropPoolClaimsForBee } from "./pool.js";
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
};

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

  if (!alreadyGone || record.launcherPgid) {
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

  await deleteSession(record.name);
  // Eager pool-claim cleanup (CHECKOUT_POOLS_PRD §6.2): a killed bee's claim
  // would otherwise count toward its member's occupancy until pendingUntil.
  // Best-effort — claim expiry is the backstop.
  if (record.poolKey) await dropPoolClaimsForBee(record.poolKey, record.name).catch(() => undefined);
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
 * ARCHIVES the record (status='archived') instead of deleting it — the bee
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

  await updateSession(record.name, {
    status: "archived",
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
