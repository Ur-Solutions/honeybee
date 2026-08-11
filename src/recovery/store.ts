/**
 * Durable per-bee automatic runtime-recovery budget.
 *
 * One owner-only JSON record survives daemon restarts. Every attempt is
 * claimed under a file lock before launch, carries a lease, and is completed
 * under the same lock. A daemon that dies mid-attempt therefore cannot reset
 * the cap or immediately launch a duplicate recovery storm.
 */

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { safeName } from "../store.js";

export const RUNTIME_RECOVERY_STORE_VERSION = 1 as const;
export const RUNTIME_RECOVERY_MAX_ATTEMPTS = 10;
export const RUNTIME_RECOVERY_ATTEMPT_LEASE_MS = 5 * 60_000;

const RECOVERY_BACKOFF_MS = [
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
] as const;

export type RuntimeRecoveryAttempt = {
  attemptId: string;
  attempt: number;
  scheduledDelayMs: number;
  startedAt: string;
  leaseUntil: string;
  outcome: "started" | "failed" | "succeeded";
  endedAt?: string;
  error?: string;
};

export type RuntimeRecoveryRecord = {
  version: typeof RUNTIME_RECOVERY_STORE_VERSION;
  bee: string;
  episodeId: string;
  generation: number;
  detectedAt: string;
  probeId: string;
  status: "recovering" | "recovered" | "failed";
  maxAttempts: number;
  nextAttemptAt?: string;
  attempts: RuntimeRecoveryAttempt[];
  recoveryFailedRequestId?: string;
  updatedAt: string;
};

export type RuntimeRecoveryClaim =
  | { action: "claimed"; record: RuntimeRecoveryRecord; attempt: RuntimeRecoveryAttempt }
  | { action: "deferred"; record: RuntimeRecoveryRecord; retryAt?: string; reason: "backoff" | "attempt-in-flight" | "attempt-lease-expired" }
  | { action: "exhausted"; record: RuntimeRecoveryRecord }
  | { action: "inactive"; record: RuntimeRecoveryRecord | null };

export function runtimeRecoveryRoot(): string {
  return join(storeRoot(), "runtime-recovery");
}

function runtimeRecoveryPath(bee: string): string {
  return join(runtimeRecoveryRoot(), `${safeName(bee)}.json`);
}

function runtimeRecoveryLockPath(bee: string): string {
  return join(runtimeRecoveryRoot(), `.${safeName(bee)}.lock`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function boundedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/** Base schedule 15s, 1m, 5m, 15m, 1h, then hourly; ±10% jitter. */
export function runtimeRecoveryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.max(0, Math.floor(attempt) - 1);
  const base = RECOVERY_BACKOFF_MS[Math.min(index, RECOVERY_BACKOFF_MS.length - 1)]!;
  return Math.round(base * (0.9 + boundedRandom(random) * 0.2));
}

function validAttempt(value: unknown): value is RuntimeRecoveryAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return typeof attempt.attemptId === "string" &&
    Number.isSafeInteger(attempt.attempt) && Number(attempt.attempt) > 0 &&
    Number.isFinite(attempt.scheduledDelayMs) && Number(attempt.scheduledDelayMs) >= 0 &&
    typeof attempt.startedAt === "string" &&
    typeof attempt.leaseUntil === "string" &&
    (attempt.outcome === "started" || attempt.outcome === "failed" || attempt.outcome === "succeeded");
}

function parseRecord(raw: string, bee: string): RuntimeRecoveryRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid runtime recovery state for ${bee}`);
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== RUNTIME_RECOVERY_STORE_VERSION ||
    record.bee !== bee ||
    typeof record.episodeId !== "string" ||
    !Number.isSafeInteger(record.generation) || Number(record.generation) < 0 ||
    typeof record.detectedAt !== "string" ||
    typeof record.probeId !== "string" ||
    (record.status !== "recovering" && record.status !== "recovered" && record.status !== "failed") ||
    !Number.isSafeInteger(record.maxAttempts) || Number(record.maxAttempts) < 1 ||
    !Array.isArray(record.attempts) || !record.attempts.every(validAttempt) ||
    typeof record.updatedAt !== "string"
  ) throw new Error(`Invalid runtime recovery state for ${bee}`);
  return record as unknown as RuntimeRecoveryRecord;
}

/** Strict read: malformed persisted budget is uncertainty, never a fresh cap. */
export async function readRuntimeRecovery(bee: string): Promise<RuntimeRecoveryRecord | null> {
  try {
    return parseRecord(await readFile(runtimeRecoveryPath(bee), "utf8"), bee);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeRuntimeRecovery(record: RuntimeRecoveryRecord): Promise<void> {
  await atomicWriteFile(runtimeRecoveryPath(record.bee), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function beginRuntimeRecovery(input: {
  bee: string;
  generation: number;
  probeId: string;
  nowMs?: number;
  random?: () => number;
  episodeId?: string;
  maxAttempts?: number;
}): Promise<RuntimeRecoveryRecord> {
  return withFileLock(runtimeRecoveryLockPath(input.bee), async () => {
    const existing = await readRuntimeRecovery(input.bee);
    if (existing?.status === "recovering" || existing?.status === "failed") return existing;
    const nowMs = input.nowMs ?? Date.now();
    const firstDelay = runtimeRecoveryBackoffMs(1, input.random);
    const record: RuntimeRecoveryRecord = {
      version: RUNTIME_RECOVERY_STORE_VERSION,
      bee: input.bee,
      episodeId: input.episodeId ?? randomUUID(),
      generation: input.generation,
      detectedAt: iso(nowMs),
      probeId: input.probeId,
      status: "recovering",
      maxAttempts: input.maxAttempts ?? RUNTIME_RECOVERY_MAX_ATTEMPTS,
      nextAttemptAt: iso(nowMs + firstDelay),
      attempts: [],
      updatedAt: iso(nowMs),
    };
    await writeRuntimeRecovery(record);
    return record;
  });
}

export async function claimRuntimeRecoveryAttempt(input: {
  bee: string;
  nowMs?: number;
  random?: () => number;
  leaseMs?: number;
  attemptId?: string;
}): Promise<RuntimeRecoveryClaim> {
  return withFileLock(runtimeRecoveryLockPath(input.bee), async () => {
    const record = await readRuntimeRecovery(input.bee);
    if (!record || record.status === "recovered") return { action: "inactive", record };
    if (record.status === "failed") return { action: "exhausted", record };
    const nowMs = input.nowMs ?? Date.now();
    const attempts = [...record.attempts];
    const current = attempts.at(-1);
    if (current?.outcome === "started") {
      const leaseUntilMs = Date.parse(current.leaseUntil);
      if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) {
        return { action: "deferred", record, retryAt: current.leaseUntil, reason: "attempt-in-flight" };
      }
      attempts[attempts.length - 1] = {
        ...current,
        outcome: "failed",
        endedAt: iso(nowMs),
        error: "recovery attempt lease expired before completion",
      };
      if (attempts.length >= record.maxAttempts) {
        const exhausted: RuntimeRecoveryRecord = {
          ...record,
          attempts,
          status: "failed",
          nextAttemptAt: undefined,
          updatedAt: iso(nowMs),
        };
        await writeRuntimeRecovery(exhausted);
        return { action: "exhausted", record: exhausted };
      }
      const delay = runtimeRecoveryBackoffMs(attempts.length + 1, input.random);
      const deferred: RuntimeRecoveryRecord = {
        ...record,
        attempts,
        nextAttemptAt: iso(nowMs + delay),
        updatedAt: iso(nowMs),
      };
      await writeRuntimeRecovery(deferred);
      return { action: "deferred", record: deferred, retryAt: deferred.nextAttemptAt, reason: "attempt-lease-expired" };
    }

    const retryAtMs = Date.parse(record.nextAttemptAt ?? "");
    if (Number.isFinite(retryAtMs) && retryAtMs > nowMs) {
      return { action: "deferred", record, retryAt: record.nextAttemptAt, reason: "backoff" };
    }
    if (attempts.length >= record.maxAttempts) {
      const exhausted: RuntimeRecoveryRecord = {
        ...record,
        status: "failed",
        nextAttemptAt: undefined,
        updatedAt: iso(nowMs),
      };
      await writeRuntimeRecovery(exhausted);
      return { action: "exhausted", record: exhausted };
    }

    const attemptNumber = attempts.length + 1;
    const scheduledAtMs = Date.parse(record.nextAttemptAt ?? "");
    const scheduledFromMs = Date.parse(attempts.at(-1)?.endedAt ?? record.detectedAt);
    // Persist the delay that actually gated this attempt. Re-sampling jitter
    // here would make the durable attempt history disagree with the schedule
    // the daemon honored before (and across) a restart.
    const persistedDelayMs = Number.isFinite(scheduledAtMs) && Number.isFinite(scheduledFromMs) &&
      scheduledAtMs >= scheduledFromMs
      ? scheduledAtMs - scheduledFromMs
      : runtimeRecoveryBackoffMs(attemptNumber, input.random);
    const attempt: RuntimeRecoveryAttempt = {
      attemptId: input.attemptId ?? randomUUID(),
      attempt: attemptNumber,
      scheduledDelayMs: persistedDelayMs,
      startedAt: iso(nowMs),
      leaseUntil: iso(nowMs + (input.leaseMs ?? RUNTIME_RECOVERY_ATTEMPT_LEASE_MS)),
      outcome: "started",
    };
    const claimed: RuntimeRecoveryRecord = {
      ...record,
      attempts: [...attempts, attempt],
      nextAttemptAt: undefined,
      updatedAt: iso(nowMs),
    };
    await writeRuntimeRecovery(claimed);
    return { action: "claimed", record: claimed, attempt };
  });
}

export async function finishRuntimeRecoveryAttempt(input: {
  bee: string;
  attemptId: string;
  outcome: "failed" | "succeeded";
  error?: string;
  nowMs?: number;
  random?: () => number;
}): Promise<RuntimeRecoveryRecord | null> {
  return withFileLock(runtimeRecoveryLockPath(input.bee), async () => {
    const record = await readRuntimeRecovery(input.bee);
    if (!record) return null;
    const index = record.attempts.findIndex((attempt) => attempt.attemptId === input.attemptId);
    if (index < 0 || record.attempts[index]!.outcome !== "started") return record;
    const nowMs = input.nowMs ?? Date.now();
    const attempts = [...record.attempts];
    attempts[index] = {
      ...attempts[index]!,
      outcome: input.outcome,
      endedAt: iso(nowMs),
      ...(input.error ? { error: input.error.slice(0, 2_000) } : {}),
    };
    const succeeded = input.outcome === "succeeded";
    const exhausted = !succeeded && attempts.length >= record.maxAttempts;
    const nextAttemptAt = !succeeded && !exhausted
      ? iso(nowMs + runtimeRecoveryBackoffMs(attempts.length + 1, input.random))
      : undefined;
    const completed: RuntimeRecoveryRecord = {
      ...record,
      attempts,
      status: succeeded ? "recovered" : exhausted ? "failed" : "recovering",
      nextAttemptAt,
      updatedAt: iso(nowMs),
    };
    await writeRuntimeRecovery(completed);
    return completed;
  });
}

/** Persist the one deterministic request id opened for an exhausted episode. */
export async function markRuntimeRecoveryFailedRequest(bee: string, requestId: string): Promise<RuntimeRecoveryRecord | null> {
  return withFileLock(runtimeRecoveryLockPath(bee), async () => {
    const record = await readRuntimeRecovery(bee);
    if (!record) return null;
    if (record.recoveryFailedRequestId) return record;
    const updated = { ...record, recoveryFailedRequestId: requestId, updatedAt: new Date().toISOString() };
    await writeRuntimeRecovery(updated);
    return updated;
  });
}

/** Explicit manual revive starts the next failure episode with a fresh cap. */
export async function resetRuntimeRecovery(bee: string): Promise<void> {
  await withFileLock(runtimeRecoveryLockPath(bee), async () => {
    await rm(runtimeRecoveryPath(bee), { force: true });
  });
}
