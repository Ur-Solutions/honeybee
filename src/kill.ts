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

/**
 * Transactional kill: substrate.kill -> poll substrate.hasSession -> only then
 * deleteSession. On failure (session still exists after polling, or its absence
 * cannot be confirmed), the SessionRecord is updated with status='kill_failed'
 * and lastError. The record is NOT deleted while the bee may still be running.
 *
 * Returns a KillOutcome describing whether the bee is gone (ok=true) or still
 * suspected of running (ok=false), plus the captured lastError when applicable.
 */
export async function transactionalKill(
  record: SessionRecord,
  options: TransactionalKillOptions = {},
): Promise<KillOutcome> {
  const substrate = options.substrate ?? substrateFor(record);
  const pollAttempts = Math.max(1, options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const sleep = options.sleep ?? defaultSleep;
  const emitLedger = options.emitLedger !== false;
  const node = record.node ?? LOCAL_NODE_NAME;

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

  // Only the poll verdict decides failure: when it confirmed the session is
  // gone (stillRunning === false) we proceed to deleteSession even if the
  // substrate's kill call reported failure — the session may have died
  // between the hasSession fast-path and the kill (a benign race).
  if (stillRunning) {
    const lastError = lastProbeError ?? killStderr ?? "session still exists after kill";
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
        attempts,
        lastError,
      });
    }
    return { ok: false, lastError, stillRunning, attempts };
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
      attempts,
    });
  }
  return { ok: true, alreadyGone: alreadyGone && !killReturnedFailure, attempts };
}
