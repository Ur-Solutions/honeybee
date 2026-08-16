/** Derived idle policy and detached scheduler for intentional HSR parking. */

import { idleHsrParkAfterMs } from "../config.js";
import type { HsrObservation } from "../hsr/observe.js";
import type { RunnerEvent } from "../hsr/types.js";
import {
  LifecycleConflictError,
  withSessionLifecycleTransaction,
} from "../lifecycle.js";
import {
  parkIdleHsrRuntime,
  type IdleRuntimeParkingIntent,
  type ParkIdleHsrRuntimeDeps,
  type ParkIdleHsrRuntimeResult,
} from "../recovery/park.js";
import type { BeeState } from "../state.js";
import {
  legacyStateMachineSeed,
  transitionSession,
  type SessionRecord,
} from "../store.js";
import type { ProbeEvidence } from "../stateMachine.js";
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

export type ObservedWorkReconciliation = {
  record: SessionRecord;
  changed: boolean;
  reason?: string;
};

type IndexedTurnEnd = {
  event: Extract<RunnerEvent, { type: "turn_end" }>;
  index: number;
};

function lifecycleEventBelongsToRecord(
  record: SessionRecord,
  event: Extract<RunnerEvent, { type: "turn_start" | "turn_end" }>,
): boolean {
  return event.threadId === undefined || !record.providerSessionId || event.threadId === record.providerSessionId;
}

function latestRootTurnEnd(record: SessionRecord, observation: HsrObservation): IndexedTurnEnd | undefined {
  const events = observation.eventSnapshot?.tailEvents;
  if (!events) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "turn_end" && lifecycleEventBelongsToRecord(record, event)) {
      return { event, index };
    }
  }
  return undefined;
}

function aliveObservationProbe(record: SessionRecord, observedAt: string): ProbeEvidence {
  return {
    kind: "probe",
    probeId: `runtime-work-observed:${record.name}:${record.runtimeGeneration ?? 0}:${observedAt}`,
    observerId: "hive-daemon-runtime-parking",
    observedAt,
    outcome: "alive",
    target: {
      substrate: "hsr",
      ...(record.node ? { node: record.node } : {}),
      ...(record.runnerPid ? { runnerPid: record.runnerPid } : {}),
    },
    detail: "trusted current-host HSR observation was live when turn_end was reconciled",
  };
}

function workReconciliationCandidate(
  record: SessionRecord,
  observedState: BeeState | undefined,
  observation: HsrObservation | undefined,
): boolean {
  if (!observation?.live || observation.unavailable || !observation.eventSnapshot) return false;
  if (observedState !== "idle_with_output" && observedState !== "ready" && observedState !== "done") return false;
  const state = record.stateMachine ?? legacyStateMachineSeed(record);
  return record.substrate === "hsr" && record.status === "running" && !record.stateUnverified &&
    state.lifecycle === "active" && state.runtime === "live" && state.work === "working" &&
    latestRootTurnEnd(record, observation) !== undefined;
}

/**
 * Fold one trusted current-host HSR turn_end into the bounded work cursor.
 *
 * The event must be at least as new as the latest accepted prompt and cursor
 * edge. That comparison is repeated after taking the lifecycle lock, so a send
 * that races an old observation either advances lastPromptAt first (we skip)
 * or waits for this settle edge and then publishes a fresh done->working edge.
 */
export async function reconcileObservedHsrWork(
  snapshot: SessionRecord,
  observedState: BeeState | undefined,
  observation: HsrObservation | undefined,
  nowMs: number,
  deps: Pick<RuntimeParkingDeps, "transition"> = {},
): Promise<ObservedWorkReconciliation> {
  if (!workReconciliationCandidate(snapshot, observedState, observation)) {
    return { record: snapshot, changed: false, reason: "not-a-settled-work-candidate" };
  }
  return withSessionLifecycleTransaction(snapshot, async (lifecycle) => {
    const current = await lifecycle.refresh();
    const state = current.stateMachine ?? legacyStateMachineSeed(current);
    if (
      current.substrate !== "hsr" || current.status !== "running" || current.stateUnverified ||
      state.lifecycle !== "active" || state.runtime !== "live" || state.work !== "working"
    ) {
      return { record: current, changed: false, reason: "work-changed" };
    }
    const turnEnd = latestRootTurnEnd(current, observation!);
    if (!turnEnd || !Number.isFinite(turnEnd.event.ts)) {
      return { record: current, changed: false, reason: "missing-current-turn-end" };
    }
    const promptAt = current.lastPromptAt ? Date.parse(current.lastPromptAt) : Number.NEGATIVE_INFINITY;
    const cursorAt = current.stateMachine ? Date.parse(current.stateMachine.transitionedAt) : Number.NEGATIVE_INFINITY;
    const boundary = Math.max(
      Number.isFinite(promptAt) ? promptAt : Number.NEGATIVE_INFINITY,
      Number.isFinite(cursorAt) ? cursorAt : Number.NEGATIVE_INFINITY,
    );
    if (turnEnd.event.ts <= boundary) {
      return { record: current, changed: false, reason: "turn-end-predates-current-work" };
    }
    const eventAt = new Date(turnEnd.event.ts).toISOString();
    const observedAt = new Date(nowMs).toISOString();
    const member = Number.isSafeInteger(turnEnd.event.seq)
      ? `seq-${turnEnd.event.seq}`
      : `index-${turnEnd.index}-ts-${turnEnd.event.ts}`;
    const hookId = `hsr-turn-end:${current.name}:${current.runtimeGeneration ?? 0}:${member}`;
    const transitioned = await (deps.transition ?? transitionSession)(current.name, {
      type: "turn.settled",
      eventId: `turn-settled:${hookId}`,
      at: eventAt,
      cause: "turn-settled",
      evidence: {
        kind: "hook",
        hookId,
        observedAt: eventAt,
        hook: "turn-end",
        detail: "trusted current-host HSR turn_end",
      },
      probe: aliveObservationProbe(current, observedAt),
    });
    if (!transitioned) throw new Error(`runtime work reconciliation: session disappeared for ${current.name}`);
    return { record: await lifecycle.refresh(), changed: transitioned.changed };
  });
}

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
  const concurrency = deps.concurrency ?? envConcurrency(
    "HIVE_DAEMON_HSR_IDLE_PARK_CONCURRENCY",
    DEFAULT_IDLE_PARK_CONCURRENCY,
  );
  const reconciledRecords = await mapWithConcurrency(records, concurrency, async (record) => {
    if (!workReconciliationCandidate(record, currentStates.get(record.name), observations.get(record.name))) return record;
    try {
      return (await reconcileObservedHsrWork(
        record,
        currentStates.get(record.name),
        observations.get(record.name),
        nowMs,
        deps,
      )).record;
    } catch (error) {
      // A send/lifecycle winner makes this stale observation harmless. Storage
      // faults are retried from the same structured event on the next sweep;
      // neither case may authorize parking from the stale snapshot.
      return record;
    }
  });
  const candidates = selectRuntimeParkingCandidates(reconciledRecords, currentStates, observations, nowMs, graceMs);
  if (candidates.length === 0) return [];
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
    const hasWorkReconciliation = records.some((record) =>
      workReconciliationCandidate(record, currentStates.get(record.name), observations.get(record.name)));
    if (
      inFlight ||
      (!hasWorkReconciliation && selectRuntimeParkingCandidates(records, currentStates, observations, nowMs, graceMs).length === 0)
    ) {
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
