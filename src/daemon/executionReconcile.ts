// Detached node-owned reconciliation for durable execution reservations.
// The daemon tick only collects the previous page and schedules the next one;
// launch/readiness, stop, release, and filesystem locks never consume the
// observation-loop budget.

import type {
  ExecutionInventoryOutcome,
  ExecutionInventoryPage,
} from "../execution/service.js";

export const DEFAULT_EXECUTION_RECONCILE_INTERVAL_MS = 5_000;
export const DEFAULT_EXECUTION_RECONCILE_BATCH_SIZE = 32;
const MAX_EXECUTION_RECONCILE_BATCH_SIZE = 256;

export type ExecutionInventoryDispatcher = (() => Promise<ExecutionInventoryOutcome[]>) & {
  close(): Promise<void>;
};

export type ExecutionInventoryDispatcherOptions = {
  service: () =>
    | { reconcileInventory(options?: { afterDirectory?: string; limit?: number }): Promise<ExecutionInventoryPage> }
    | Promise<{ reconcileInventory(options?: { afterDirectory?: string; limit?: number }): Promise<ExecutionInventoryPage> }>;
  now?: () => number;
  intervalMs?: number;
  batchSize?: number;
  /** @internal deterministic background scheduler for tests. */
  startBackground?: (job: () => Promise<void>) => void;
};

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0
    ? Math.min(maximum, numeric)
    : fallback;
}

function configuredIntervalMs(value?: number): number {
  return positiveInteger(
    value ?? process.env.HIVE_EXECUTION_RECONCILE_INTERVAL_MS,
    DEFAULT_EXECUTION_RECONCILE_INTERVAL_MS,
    5 * 60_000,
  );
}

function configuredBatchSize(value?: number): number {
  return positiveInteger(
    value ?? process.env.HIVE_EXECUTION_RECONCILE_BATCH_SIZE,
    DEFAULT_EXECUTION_RECONCILE_BATCH_SIZE,
    MAX_EXECUTION_RECONCILE_BATCH_SIZE,
  );
}

/**
 * Build the daemon's tick-cheap execution inventory lane. Pages are bounded,
 * sorted, and cursor-driven; a fresh dispatcher starts from the durable head,
 * so daemon restart requires no ephemeral work queue to recover obligations.
 */
export function createExecutionInventoryDispatcher(
  options: ExecutionInventoryDispatcherOptions,
): ExecutionInventoryDispatcher {
  const now = options.now ?? Date.now;
  const intervalMs = configuredIntervalMs(options.intervalMs);
  const batchSize = configuredBatchSize(options.batchSize);
  const startBackground = options.startBackground ?? ((job: () => Promise<void>) => {
    queueMicrotask(() => void job());
  });
  let inFlight = false;
  let inFlightJob: Promise<void> | null = null;
  let closed = false;
  let nextSweepAt = 0;
  let afterDirectory: string | undefined;
  let pending: ExecutionInventoryOutcome[] = [];

  const dispatch = (async () => {
    const report = pending;
    pending = [];
    if (closed || inFlight || now() < nextSweepAt) return report;
    inFlight = true;
    const runJob = async () => {
      try {
        // close() may win after scheduling but before the microtask starts.
        // In that case there is no active side effect to drain.
        if (closed) return;
        const service = await options.service();
        const page = await service.reconcileInventory({
          ...(afterDirectory ? { afterDirectory } : {}),
          limit: batchSize,
        });
        pending = page.outcomes;
        afterDirectory = page.nextAfterDirectory ?? undefined;
      } catch (error) {
        pending = [{
          directory: "*",
          action: "error",
          error: error instanceof Error ? error.message : String(error),
        }];
      } finally {
        nextSweepAt = now() + intervalMs;
        inFlight = false;
      }
    };
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    inFlightJob = settlement;
    const job = async () => {
      try {
        await runJob();
      } finally {
        if (inFlightJob === settlement) inFlightJob = null;
        resolveSettlement();
      }
    };
    try {
      startBackground(job);
    } catch (error) {
      pending = [{
        directory: "*",
        action: "error",
        error: error instanceof Error ? error.message : String(error),
      }];
      nextSweepAt = now() + intervalMs;
      inFlight = false;
      if (inFlightJob === settlement) inFlightJob = null;
      resolveSettlement();
    }
    return report;
  }) as ExecutionInventoryDispatcher;

  dispatch.close = async () => {
    closed = true;
    // Never release the daemon ownership lock while an old coordinator page
    // can still launch, stop, or release. The work is deliberately not
    // cancelled: its existing launch/readiness and file-lock bounds must reach
    // a real settlement before a replacement daemon may take ownership.
    const active = inFlightJob;
    if (active) await active;
  };
  return dispatch;
}
