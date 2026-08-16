/** Derived idle policy and detached scheduler for intentional HSR parking. */

import { idleHsrParkAfterMs } from "../config.js";
import type { HsrObservation } from "../hsr/observe.js";
import { LifecycleConflictError } from "../lifecycle.js";
import {
  parkIdleHsrRuntime,
  type IdleRuntimeParkingIntent,
  type ParkIdleHsrRuntimeDeps,
  type ParkIdleHsrRuntimeResult,
} from "../recovery/park.js";
import type { BeeState } from "../state.js";
import { legacyStateMachineSeed, type SessionRecord } from "../store.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";

const DEFAULT_IDLE_PARK_CONCURRENCY = 2;

export type RuntimeParkingCandidate = {
  record: SessionRecord;
  intent: IdleRuntimeParkingIntent;
};

export type RuntimeParkingOutcome = {
  bee: string;
  action: "parked" | "skipped" | "failed";
  generation: number;
  reason?: string;
  error?: string;
};

export type RuntimeParkingDispatcher = (
  records: SessionRecord[],
  currentStates: ReadonlyMap<string, BeeState>,
  observations: ReadonlyMap<string, HsrObservation>,
  nowMs: number,
) => Promise<RuntimeParkingOutcome[]>;

export type RuntimeParkingDeps = ParkIdleHsrRuntimeDeps & {
  graceMs?: number | null;
  concurrency?: number;
  park?: (
    record: SessionRecord,
    intent: IdleRuntimeParkingIntent,
    deps: ParkIdleHsrRuntimeDeps,
  ) => Promise<ParkIdleHsrRuntimeResult>;
  startBackground?: (job: () => Promise<void>) => void;
};

function workForObservedState(state: BeeState | undefined): "done" | undefined {
  if (state === "idle_with_output" || state === "ready" || state === "done") return "done";
  return undefined;
}

/**
 * The policy is derived entirely from the current trusted HSR observation and
 * record. No warm/cold state is persisted: the activity event timestamp is the
 * idle lease boundary, while the bounded cursor is the eligibility fence.
 */
export function selectRuntimeParkingCandidates(
  records: readonly SessionRecord[],
  currentStates: ReadonlyMap<string, BeeState>,
  observations: ReadonlyMap<string, HsrObservation>,
  nowMs: number,
  graceMs: number | null,
): RuntimeParkingCandidate[] {
  if (graceMs === null || !Number.isFinite(graceMs) || graceMs <= 0) return [];
  const candidates: RuntimeParkingCandidate[] = [];
  for (const record of records) {
    if (record.substrate !== "hsr" || record.status !== "running" || record.stateUnverified) continue;
    if (!record.providerSessionId || record.recoveryRequestedAt) continue;
    // These bees already have an external work producer whose queue/nudge path
    // is not the ordinary direct/queued-send wake contract.
    if (record.taskSupply?.on || record.contract) continue;

    const observation = observations.get(record.name);
    if (!observation?.live || !observation.activity) continue;
    const observedWork = workForObservedState(currentStates.get(record.name));
    if (!observedWork) continue;
    const state = record.stateMachine ?? legacyStateMachineSeed(record);
    if (state.lifecycle !== "active" || state.runtime !== "live" || state.work !== observedWork) continue;

    const idleSinceMs = Math.min(observation.activity.at, nowMs);
    if (!Number.isFinite(idleSinceMs) || nowMs - idleSinceMs < graceMs) continue;
    const idleSince = new Date(idleSinceMs);
    if (!Number.isFinite(idleSince.getTime())) continue;
    candidates.push({
      record,
      intent: {
        idleSince: idleSince.toISOString(),
        graceMs,
        work: observedWork,
      },
    });
  }
  return candidates;
}

export async function runRuntimeParkingSweep(
  records: SessionRecord[],
  currentStates: ReadonlyMap<string, BeeState>,
  observations: ReadonlyMap<string, HsrObservation>,
  nowMs: number,
  deps: RuntimeParkingDeps = {},
): Promise<RuntimeParkingOutcome[]> {
  const graceMs = deps.graceMs === undefined ? idleHsrParkAfterMs() : deps.graceMs;
  const candidates = selectRuntimeParkingCandidates(records, currentStates, observations, nowMs, graceMs);
  if (candidates.length === 0) return [];
  const concurrency = deps.concurrency ?? envConcurrency(
    "HIVE_DAEMON_HSR_IDLE_PARK_CONCURRENCY",
    DEFAULT_IDLE_PARK_CONCURRENCY,
  );
  const park = deps.park ?? parkIdleHsrRuntime;
  return mapWithConcurrency(candidates, concurrency, async ({ record, intent }) => {
    try {
      const result = await park(record, intent, deps);
      return {
        bee: record.name,
        action: result.action,
        generation: result.record.runtimeGeneration ?? 0,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    } catch (error) {
      if (error instanceof LifecycleConflictError) {
        return {
          bee: record.name,
          action: "skipped" as const,
          generation: record.runtimeGeneration ?? 0,
          reason: "lifecycle-race",
        };
      }
      return {
        bee: record.name,
        action: "failed" as const,
        generation: record.runtimeGeneration ?? 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** Tick-cheap collector/launcher: stop/probe work always runs off the tick. */
export function createRuntimeParkingDispatcher(deps: RuntimeParkingDeps = {}): RuntimeParkingDispatcher {
  const startBackground = deps.startBackground ?? ((job: () => Promise<void>) => {
    queueMicrotask(() => void job());
  });
  let inFlight = false;
  let pending: RuntimeParkingOutcome[] = [];
  return async (records, currentStates, observations, nowMs) => {
    const settled = pending;
    pending = [];
    const graceMs = deps.graceMs === undefined ? idleHsrParkAfterMs() : deps.graceMs;
    if (inFlight || selectRuntimeParkingCandidates(records, currentStates, observations, nowMs, graceMs).length === 0) {
      return settled;
    }
    inFlight = true;
    startBackground(async () => {
      try {
        pending = await runRuntimeParkingSweep(records, currentStates, observations, nowMs, {
          ...deps,
          graceMs,
        });
      } finally {
        inFlight = false;
      }
    });
    return settled;
  };
}
