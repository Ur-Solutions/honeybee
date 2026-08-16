/** Bounded automatic retry for explicit HSR stop-doubt records. */

import { transactionalKill, transactionalRetire, type KillOutcome } from "../kill.js";
import { LifecycleConflictError, withSessionLifecycleTransaction } from "../lifecycle.js";
import { appendLedger, loadSession, type SessionRecord, type SessionStopIntent } from "../store.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";

const DEFAULT_HSR_STOP_RECOVERY_CONCURRENCY = 1;
const DEFAULT_HSR_STOP_RECOVERY_MAX_ATTEMPTS = 5;
const DEFAULT_HSR_STOP_RECOVERY_BASE_DELAY_MS = 10_000;
const DEFAULT_HSR_STOP_RECOVERY_MAX_DELAY_MS = 10 * 60_000;

export type HsrStopRecoveryOutcome = {
  bee: string;
  action: "deferred" | "killed" | "retired" | "failed" | "exhausted" | "integrity" | "skipped";
  intent?: SessionStopIntent["action"];
  generation?: number;
  attempt?: number;
  retryAt?: string;
  error?: string;
};

export type HsrStopRecoveryDeps = {
  now?: () => number;
  concurrency?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  loadRecord?: typeof loadSession;
  killRecord?: (record: SessionRecord) => Promise<KillOutcome>;
  retireRecord?: (record: SessionRecord) => Promise<KillOutcome>;
  appendEvent?: typeof appendLedger;
};

export type HsrStopRecoveryDispatcher = (records: SessionRecord[]) => Promise<HsrStopRecoveryOutcome[]>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayMs(attempt: number, deps: HsrStopRecoveryDeps): number {
  const base = Math.max(0, deps.baseDelayMs ?? DEFAULT_HSR_STOP_RECOVERY_BASE_DELAY_MS);
  const max = Math.max(base, deps.maxDelayMs ?? DEFAULT_HSR_STOP_RECOVERY_MAX_DELAY_MS);
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(max, base * 2 ** exponent);
}

function intentMatchesRecord(record: SessionRecord): boolean {
  const intent = record.stopIntent;
  return !!intent &&
    intent.version === 1 &&
    record.status === "kill_failed" &&
    record.substrate === "hsr" &&
    intent.generation === (record.runtimeGeneration ?? 0) &&
    !intent.blockedReason;
}

export function hasRetryableHsrStopIntent(record: SessionRecord, nowMs = Date.now()): boolean {
  if (!intentMatchesRecord(record)) return false;
  const next = record.stopIntent!.nextAttemptAt ? Date.parse(record.stopIntent!.nextAttemptAt) : 0;
  return !Number.isFinite(next) || next <= nowMs;
}

async function markStopIntentBlocked(
  snapshot: SessionRecord,
  reason: NonNullable<SessionStopIntent["blockedReason"]>,
  detail: string,
): Promise<HsrStopRecoveryOutcome> {
  return withSessionLifecycleTransaction(snapshot, async (lifecycle) => {
    const current = await lifecycle.refresh();
    const intent = current.stopIntent;
    if (!intentMatchesRecord(current) || !intent) {
      return { bee: snapshot.name, action: "skipped" };
    }
    await lifecycle.commit({
      status: "kill_failed",
      lastError: detail,
      stopIntent: { ...intent, blockedReason: reason, nextAttemptAt: undefined },
      updatedAt: new Date().toISOString(),
    });
    return {
      bee: current.name,
      action: reason === "event-integrity" ? "integrity" : "exhausted",
      intent: intent.action,
      generation: intent.generation,
      attempt: intent.attempts,
      error: detail,
    };
  });
}

async function claimAttempt(
  snapshot: SessionRecord,
  deps: HsrStopRecoveryDeps,
): Promise<
  | { action: "claimed"; record: SessionRecord; attempt: number }
  | HsrStopRecoveryOutcome
> {
  const now = deps.now ?? Date.now;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_HSR_STOP_RECOVERY_MAX_ATTEMPTS);
  return withSessionLifecycleTransaction(snapshot, async (lifecycle) => {
    const current = await lifecycle.refresh();
    const intent = current.stopIntent;
    if (!intentMatchesRecord(current) || !intent) {
      return { bee: snapshot.name, action: "skipped" };
    }
    if (current.eventIntegrityDoubt) {
      await lifecycle.commit({
        status: "kill_failed",
        lastError: current.eventIntegrityDoubt.fenceError,
        stopIntent: { ...intent, blockedReason: "event-integrity", nextAttemptAt: undefined },
        updatedAt: new Date().toISOString(),
      });
      return {
        bee: current.name,
        action: "integrity",
        intent: intent.action,
        generation: intent.generation,
        attempt: intent.attempts,
        error: current.eventIntegrityDoubt.fenceError,
      };
    }
    const nextMs = intent.nextAttemptAt ? Date.parse(intent.nextAttemptAt) : 0;
    if (Number.isFinite(nextMs) && nextMs > now()) {
      return {
        bee: current.name,
        action: "deferred",
        intent: intent.action,
        generation: intent.generation,
        attempt: intent.attempts,
        retryAt: intent.nextAttemptAt,
      };
    }
    if (intent.attempts >= maxAttempts) {
      const detail = `automatic HSR ${intent.action} stop recovery exhausted ${maxAttempts} attempt(s)`;
      await lifecycle.commit({
        status: "kill_failed",
        lastError: detail,
        stopIntent: { ...intent, blockedReason: "exhausted", nextAttemptAt: undefined },
        updatedAt: new Date().toISOString(),
      });
      return {
        bee: current.name,
        action: "exhausted",
        intent: intent.action,
        generation: intent.generation,
        attempt: intent.attempts,
        error: detail,
      };
    }
    const attempt = intent.attempts + 1;
    const nowMs = now();
    const lastAttemptAt = new Date(nowMs).toISOString();
    const nextAttemptAt = new Date(nowMs + retryDelayMs(attempt, deps)).toISOString();
    const claimed = await lifecycle.commit({
      stopIntent: {
        ...intent,
        attempts: attempt,
        lastAttemptAt,
        nextAttemptAt,
      },
      updatedAt: lastAttemptAt,
    });
    return { action: "claimed" as const, record: claimed, attempt };
  });
}

async function recoverOne(snapshot: SessionRecord, deps: HsrStopRecoveryDeps): Promise<HsrStopRecoveryOutcome> {
  const loaded = await (deps.loadRecord ?? loadSession)(snapshot.name);
  if (!loaded) return { bee: snapshot.name, action: "skipped" };
  if (!intentMatchesRecord(loaded)) return { bee: loaded.name, action: "skipped" };

  const claimed = await claimAttempt(loaded, deps);
  if (claimed.action !== "claimed") return claimed;

  const intent = claimed.record.stopIntent!;
  await (deps.appendEvent ?? appendLedger)({
    type: "hsr.stop-recovery.attempt",
    session: claimed.record.name,
    intent: intent.action,
    generation: intent.generation,
    attempt: claimed.attempt,
    ts: intent.lastAttemptAt,
  }).catch(() => undefined);

  const outcome = intent.action === "kill"
    ? await (deps.killRecord ?? ((record) => transactionalKill(record)))(claimed.record)
    : await (deps.retireRecord ?? ((record) => transactionalRetire(record)))(claimed.record);

  if (outcome.ok) {
    return {
      bee: claimed.record.name,
      action: intent.action === "kill" ? "killed" : "retired",
      intent: intent.action,
      generation: intent.generation,
      attempt: claimed.attempt,
    };
  }

  if (!outcome.stillRunning) {
    return markStopIntentBlocked(claimed.record, "event-integrity", outcome.lastError);
  }

  return {
    bee: claimed.record.name,
    action: "failed",
    intent: intent.action,
    generation: intent.generation,
    attempt: claimed.attempt,
    retryAt: claimed.record.stopIntent?.nextAttemptAt,
    error: outcome.lastError,
  };
}

export async function runHsrStopRecoverySweep(
  records: SessionRecord[],
  deps: HsrStopRecoveryDeps = {},
): Promise<HsrStopRecoveryOutcome[]> {
  const now = deps.now ?? Date.now;
  const candidates = records.filter((record) => hasRetryableHsrStopIntent(record, now()));
  if (candidates.length === 0) return [];
  const concurrency = deps.concurrency ?? envConcurrency(
    "HIVE_DAEMON_HSR_STOP_RECOVERY_CONCURRENCY",
    DEFAULT_HSR_STOP_RECOVERY_CONCURRENCY,
  );
  return mapWithConcurrency(candidates, concurrency, async (record) => {
    try {
      return await recoverOne(record, deps);
    } catch (error) {
      if (error instanceof LifecycleConflictError) {
        return { bee: record.name, action: "skipped" as const };
      }
      return { bee: record.name, action: "failed" as const, error: errorMessage(error) };
    }
  });
}

export function createHsrStopRecoveryDispatcher(
  deps: HsrStopRecoveryDeps & { startBackground?: (job: () => Promise<void>) => void } = {},
): HsrStopRecoveryDispatcher {
  const startBackground = deps.startBackground ?? ((job: () => Promise<void>) => queueMicrotask(() => void job()));
  let inFlight = false;
  let pending: HsrStopRecoveryOutcome[] = [];
  return async (records) => {
    const report = pending;
    pending = [];
    const now = deps.now ?? Date.now;
    if (inFlight || !records.some((record) => hasRetryableHsrStopIntent(record, now()))) {
      return report;
    }
    inFlight = true;
    startBackground(async () => {
      try {
        pending = await runHsrStopRecoverySweep(records, deps);
      } catch (error) {
        pending = [{ bee: "<hsr-stop-recovery-sweep>", action: "failed", error: errorMessage(error) }];
      } finally {
        inFlight = false;
      }
    });
    return report;
  };
}
