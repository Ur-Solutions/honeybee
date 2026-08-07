import type { CredentialSweepTelemetry } from "./credentialSweep.js";
import { CredentialSweepTimeoutError } from "./credentialSweepProcess.js";

export type CredentialSyncSettlement = {
  status: "completed" | "failed" | "timed-out";
  durationMs: number;
  telemetry?: CredentialSweepTelemetry;
  error?: Error;
};

export type CredentialSyncRunOutcome = CredentialSyncSettlement | {
  status: "skipped-inflight";
  inFlightMs: number;
};

export type CredentialSyncControllerOptions = {
  budgetMs: number;
  now?: () => number;
  onLateSettlement?: (settlement: CredentialSyncSettlement) => void;
};

/**
 * Strict single-flight wrapper for the recurring credential track. Timing out
 * never clears the active slot: later intervals skip until the exact abandoned
 * promise settles. The production sync also kills its worker at an inner
 * deadline, but this containment remains correct for injected/fallback syncs.
 */
export function createCredentialSyncController(
  sync: () => Promise<CredentialSweepTelemetry | void>,
  options: CredentialSyncControllerOptions,
): { run: () => Promise<CredentialSyncRunOutcome>; inFlight: () => boolean } {
  const now = options.now ?? Date.now;
  let active: { startedAt: number; promise: Promise<CredentialSyncSettlement>; timedOut: boolean } | null = null;

  const run = async (): Promise<CredentialSyncRunOutcome> => {
    if (active) return { status: "skipped-inflight", inFlightMs: Math.max(0, now() - active.startedAt) };

    const startedAt = now();
    const entry = {
      startedAt,
      timedOut: false,
      promise: Promise.resolve()
        .then(sync)
        .then<CredentialSyncSettlement>((telemetry) => ({
          status: "completed",
          durationMs: Math.max(0, now() - startedAt),
          ...(telemetry ? { telemetry } : {}),
        }))
        .catch<CredentialSyncSettlement>((value: unknown) => {
          const error = value instanceof Error ? value : new Error(String(value));
          return {
            status: error instanceof CredentialSweepTimeoutError ? "timed-out" : "failed",
            durationMs: Math.max(0, now() - startedAt),
            ...(error instanceof CredentialSweepTimeoutError ? { telemetry: error.telemetry } : {}),
            error,
          };
        }),
    };
    active = entry;
    void entry.promise.then((settlement) => {
      if (active !== entry) return;
      active = null;
      if (entry.timedOut) options.onLateSettlement?.(settlement);
    });

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<CredentialSyncSettlement>((resolveBudget) => {
      timer = setTimeout(() => {
        entry.timedOut = true;
        resolveBudget({
          status: "timed-out",
          durationMs: Math.max(0, now() - startedAt),
          error: new Error(`syncChains timed out after ${options.budgetMs}ms`),
        });
      }, options.budgetMs);
    });
    const outcome = await Promise.race([entry.promise, budget]);
    if (timer) clearTimeout(timer);
    return outcome;
  };

  return { run, inFlight: () => active !== null };
}
