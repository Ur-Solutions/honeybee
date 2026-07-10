/**
 * Cross-process admission control for fragile HSR harness cold starts.
 *
 * Codex app-server performs an online model refresh during startup. Large bursts
 * of detached hosts can all enter that refresh + thread handshake together,
 * amplifying the codex-cli startup race. Keep only a small number of those
 * handshakes in flight; the slot is released as soon as adapter.start returns,
 * so normal agent turns are never serialized.
 *
 * Slots are long-lived PID-owned locks. If a queued/starting host is killed,
 * the next waiter can reclaim its slot immediately after observing the dead
 * owner instead of waiting for an mtime-based stale timeout.
 */

import { join } from "node:path";
import { acquireLongLivedLock, LockBusyError, storeRoot } from "../fsx.js";

export const DEFAULT_CODEX_STARTUP_CONCURRENCY = 2;
export const DEFAULT_CODEX_STARTUP_QUEUE_TIMEOUT_MS = 10 * 60_000;

const POLL_MS = 100;
const MAX_CONCURRENCY = 32;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function positiveIntegerEnv(name: string, fallback: number, options: { allowZero?: boolean; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) return fallback;
  return Math.min(value, options.max ?? Number.MAX_SAFE_INTEGER);
}

/** `0` disables admission control; positive values are concurrent cold starts. */
export function codexStartupConcurrency(): number {
  return positiveIntegerEnv("HIVE_CODEX_START_CONCURRENCY", DEFAULT_CODEX_STARTUP_CONCURRENCY, {
    allowZero: true,
    max: MAX_CONCURRENCY,
  });
}

function startupQueueTimeoutMs(): number {
  return positiveIntegerEnv("HIVE_CODEX_START_QUEUE_TIMEOUT_MS", DEFAULT_CODEX_STARTUP_QUEUE_TIMEOUT_MS);
}

function slotPath(index: number): string {
  return join(storeRoot(), "locks", "hsr-startup", `codex-${index}.lock`);
}

/**
 * Run one Codex adapter cold start in a bounded machine-wide slot.
 *
 * This is intentionally a small admission queue rather than a task scheduler:
 * the detached host already owns the durable bee/run-dir lifecycle, and only
 * the startup handshake needs protection. Slot choice is best-effort fair
 * across polling waiters; no agent execution remains behind the gate.
 */
export async function withCodexStartupSlot<T>(bee: string, fn: () => Promise<T>): Promise<T> {
  const concurrency = codexStartupConcurrency();
  if (concurrency === 0) return fn();

  const deadline = Date.now() + startupQueueTimeoutMs();
  for (;;) {
    for (let index = 0; index < concurrency; index += 1) {
      let lock: Awaited<ReturnType<typeof acquireLongLivedLock>>;
      try {
        lock = await acquireLongLivedLock(slotPath(index), { label: `codex startup ${bee}` });
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error;
        continue;
      }
      // Keep fn outside the acquisition catch: an adapter is allowed to throw
      // any Error subtype, including LockBusyError, and must never be mistaken
      // for a busy startup slot and silently retried.
      try {
        return await fn();
      } finally {
        await lock.release().catch(() => undefined);
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a Codex startup slot after ${startupQueueTimeoutMs()}ms (${bee})`);
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}
