// Detached recovery lane for durably accepted buz messages.
//
// Selection and outcome collection are tick-cheap. Liveness probes, cwd
// validation, credential activation, and provider spawn run in a background
// single-flight with their own concurrency, never inline with buz draining.

import { assertReviveWorkingDirectory } from "../commands/migrate.js";
import {
  clearMessageRecovery,
  openMessageDeliveryRequest,
  readMessageById,
  type MessageUndeliverableReason,
} from "../buz.js";
import { withSessionLifecycleTransaction } from "../lifecycle.js";
import { wakeRuntimeForQueuedSend } from "../recovery/wake.js";
import { loadSession, type SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";
import { envMs } from "./timeouts.js";

export const DEFAULT_BUZ_RECOVERY_CONCURRENCY = 2;
export const DEFAULT_BUZ_RECOVERY_MAX_AGE_MS = 15 * 60_000;
export const DEFAULT_BUZ_WAKE_RETRY_MS = 5_000;
export const MAX_BUZ_WAKE_RETRY_MS = 5 * 60_000;
export const DEFAULT_BUZ_WAKE_MAX_FAILURES = 8;

export type BuzRecoveryOutcome = {
  recipient: string;
  action: "started" | "deferred" | "live" | "resolved" | "failed" | "undeliverable" | "skipped";
  messageId?: string;
  attempt?: number;
  retryAt?: string;
  reason?: MessageUndeliverableReason | "marker-changed";
  error?: string;
};

export type BuzRecoveryDeps = {
  now?: () => number;
  concurrency?: number;
  maxRequestAgeMs?: number;
  maxFailures?: number;
  loadRecord?: typeof loadSession;
  readMessage?: typeof readMessageById;
  isLive?: (record: SessionRecord) => Promise<boolean>;
  assertCwd?: typeof assertReviveWorkingDirectory;
  wakeRecipient?: (record: SessionRecord) => Promise<SessionRecord>;
  openUndeliverable?: typeof openMessageDeliveryRequest;
  clearRecovery?: typeof clearMessageRecovery;
};

export type BuzRecoveryDispatcherOptions = BuzRecoveryDeps & {
  /** @internal deterministic background scheduler for tests. */
  startBackground?: (job: () => Promise<void>) => void;
};

export type BuzRecoveryDispatcher = (records: SessionRecord[]) => Promise<BuzRecoveryOutcome[]>;

function maxFailuresFromEnv(): number {
  const value = Number(process.env.HIVE_BUZ_WAKE_MAX_FAILURES ?? DEFAULT_BUZ_WAKE_MAX_FAILURES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_BUZ_WAKE_MAX_FAILURES;
}

export function buzWakeRetryDelayMs(attempt: number): number {
  return Math.min(
    MAX_BUZ_WAKE_RETRY_MS,
    DEFAULT_BUZ_WAKE_RETRY_MS * 2 ** Math.max(0, Math.min(20, attempt - 1)),
  );
}

async function commitRecoveryAttempt(
  record: SessionRecord,
  messageId: string,
  attempt: number,
  retryAt: string,
): Promise<boolean> {
  try {
    return await withSessionLifecycleTransaction(record, async (lifecycle) => {
      const current = await lifecycle.refresh();
      if (current.recoveryMessageId !== messageId || !current.recoveryRequestedAt) return false;
      await lifecycle.commit({
        recoveryAttemptCount: attempt,
        recoveryNextAttemptAt: retryAt,
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  } catch {
    return false;
  }
}

async function markUndeliverable(
  record: SessionRecord,
  messageId: string,
  reason: MessageUndeliverableReason,
  deps: BuzRecoveryDeps,
  nowMs: number,
): Promise<BuzRecoveryOutcome> {
  await (deps.openUndeliverable ?? openMessageDeliveryRequest)(record, messageId, reason, new Date(nowMs).toISOString());
  await (deps.clearRecovery ?? clearMessageRecovery)(record.name, messageId);
  return { recipient: record.name, action: "undeliverable", messageId, reason };
}

async function processRecoveryRecord(
  snapshot: SessionRecord,
  deps: BuzRecoveryDeps,
): Promise<BuzRecoveryOutcome> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const record = await (deps.loadRecord ?? loadSession)(snapshot.name);
  if (!record?.recoveryRequestedAt || !record.recoveryMessageId) {
    return { recipient: snapshot.name, action: "skipped", reason: "marker-changed" };
  }
  const messageId = record.recoveryMessageId;
  const retryAtMs = Date.parse(record.recoveryNextAttemptAt ?? "");
  if (Number.isFinite(retryAtMs) && retryAtMs > nowMs) {
    return {
      recipient: record.name,
      action: "deferred",
      messageId,
      attempt: record.recoveryAttemptCount ?? 0,
      retryAt: record.recoveryNextAttemptAt,
    };
  }

  const stored = await (deps.readMessage ?? readMessageById)(record.name, messageId);
  if (stored?.mailbox === "inbox" || stored?.mailbox === "read") {
    await (deps.clearRecovery ?? clearMessageRecovery)(record.name, messageId, { resolveRequestBy: "buz-delivery" });
    return { recipient: record.name, action: "resolved", messageId };
  }
  if (!stored || stored.mailbox !== "queue") {
    return markUndeliverable(record, messageId, "queued-message-missing", deps, nowMs);
  }

  const failAttempt = async (error: unknown): Promise<BuzRecoveryOutcome> => {
    const latest = await (deps.loadRecord ?? loadSession)(record.name);
    if (!latest?.recoveryRequestedAt || latest.recoveryMessageId !== messageId) {
      return { recipient: record.name, action: "skipped", messageId, reason: "marker-changed" };
    }
    const attempt = (latest.recoveryAttemptCount ?? 0) + 1;
    const maxFailures = deps.maxFailures ?? maxFailuresFromEnv();
    const message = error instanceof Error ? error.message : String(error);
    if (attempt >= maxFailures) {
      const outcome = await markUndeliverable(latest, messageId, "wake-retry-exhausted", deps, now());
      return { ...outcome, attempt, error: message };
    }
    const retryAt = new Date(now() + buzWakeRetryDelayMs(attempt)).toISOString();
    const committed = await commitRecoveryAttempt(latest, messageId, attempt, retryAt);
    return committed
      ? { recipient: record.name, action: "failed", messageId, attempt, retryAt, error: message }
      : { recipient: record.name, action: "skipped", messageId, reason: "marker-changed" };
  };

  let live: boolean;
  try {
    live = await (deps.isLive ?? ((candidate) => substrateFor(candidate).hasSession(candidate.tmuxTarget)))(record);
  } catch (error) {
    return failAttempt(error);
  }
  if (live && record.stateMachine?.runtime !== "parked") {
    return { recipient: record.name, action: "live", messageId };
  }
  if (record.status === "kill_failed") {
    return markUndeliverable(record, messageId, "archive-unresolved", deps, nowMs);
  }

  const requestedAtMs = Date.parse(record.recoveryRequestedAt);
  const maxRequestAgeMs = deps.maxRequestAgeMs ?? envMs(
    "HIVE_BUZ_RECOVERY_MAX_AGE_MS",
    DEFAULT_BUZ_RECOVERY_MAX_AGE_MS,
  );
  if (!Number.isFinite(requestedAtMs) || nowMs - requestedAtMs > maxRequestAgeMs) {
    return markUndeliverable(record, messageId, "recovery-request-expired", deps, nowMs);
  }

  try {
    await (deps.assertCwd ?? assertReviveWorkingDirectory)(record);
  } catch {
    return markUndeliverable(record, messageId, "missing-cwd", deps, nowMs);
  }
  if (!record.providerSessionId) {
    return markUndeliverable(record, messageId, "missing-provider-session", deps, nowMs);
  }

  try {
    await (deps.wakeRecipient ?? wakeRuntimeForQueuedSend)(record);
    return {
      recipient: record.name,
      action: "started",
      messageId,
      attempt: record.recoveryAttemptCount ?? 0,
    };
  } catch (error) {
    return failAttempt(error);
  }
}

export async function runBuzRecoverySweep(
  records: SessionRecord[],
  deps: BuzRecoveryDeps = {},
): Promise<BuzRecoveryOutcome[]> {
  const candidates = records.filter((record) => record.recoveryRequestedAt && record.recoveryMessageId);
  if (candidates.length === 0) return [];
  const concurrency = deps.concurrency ?? envConcurrency(
    "HIVE_BUZ_RECOVERY_CONCURRENCY",
    DEFAULT_BUZ_RECOVERY_CONCURRENCY,
  );
  return mapWithConcurrency(candidates, concurrency, (record) => processRecoveryRecord(record, deps));
}

/**
 * Tick-facing detached scheduler. Like flightSweep, each tick only collects a
 * settled result batch and starts at most one background sweep.
 */
export function createBuzRecoveryDispatcher(options: BuzRecoveryDispatcherOptions = {}): BuzRecoveryDispatcher {
  const startBackground = options.startBackground ?? ((job: () => Promise<void>) => {
    queueMicrotask(() => void job());
  });
  let inFlight = false;
  let pending: BuzRecoveryOutcome[] = [];
  return async (records) => {
    const report = pending;
    pending = [];
    if (inFlight || !records.some((record) => record.recoveryRequestedAt && record.recoveryMessageId)) {
      return report;
    }
    inFlight = true;
    startBackground(async () => {
      try {
        pending = await runBuzRecoverySweep(records, options);
      } catch (error) {
        pending = [{
          recipient: "<recovery-sweep>",
          action: "failed",
          error: error instanceof Error ? error.message : String(error),
        }];
      } finally {
        inFlight = false;
      }
    });
    return report;
  };
}
