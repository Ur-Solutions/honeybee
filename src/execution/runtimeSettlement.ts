/** Stop and settle one protocol-owned execution runtime without a revive gap. */

import { sameProcessBirthFingerprint } from "../hsr/processIdentity.js";
import {
  purgeSessionAfterConfirmedRuntimeStopInTransaction,
  transactionalRetire,
} from "../kill.js";
import { LifecycleConflictError, withSessionLifecycleTransaction } from "../lifecycle.js";
import {
  parkIdleHsrRuntime,
  type ParkIdleHsrRuntimeDeps,
} from "../recovery/park.js";
import type { SpawnRuntimeCleanup, SpawnedRuntimeHandle } from "../spawnRuntime.js";
import {
  legacyStateMachineSeed,
  loadSession,
  type SessionRecord,
} from "../store.js";

export type ExecutionRuntimeOwner = {
  runId: string;
  beeName: string;
};

export type ExecutionRuntimeSettlement =
  | { settled: true; detail: string; cleanup: SpawnRuntimeCleanup }
  | {
      settled: false;
      detail: string;
      cleanup: SpawnRuntimeCleanup;
      stopDoubtPersisted: boolean;
    };

export type ExecutionRuntimeSettlementOptions = {
  /** Deterministic crash-window seam after stop dispatch, before purge. */
  afterStopDispatch?: () => void | Promise<void>;
  /**
   * Settle a spawn/name ownership journal with the same cleanup verdict.
   * This runs while the lifecycle fence is still held when a row exists.
   */
  settleLaunchOwnership?: (cleanup: SpawnRuntimeCleanup) => void | Promise<void>;
  /** Runtime is down, but prior work effects remain ambiguous; retain evidence. */
  retainCanonicalAfterConfirmedStop?: string;
};

export type ExecutionSessionOwner = ExecutionRuntimeOwner & { sessionRef?: string };

export type ExecutionRuntimeParkingResult =
  | { status: "parked"; detail: string }
  | { status: "deferred"; detail: string }
  | { status: "unconfirmed"; detail: string };

export type ExecutionRuntimeParkingOptions = {
  load?: typeof loadSession;
  park?: typeof parkIdleHsrRuntime;
  parkDeps?: ParkIdleHsrRuntimeDeps;
  now?: () => number;
};

const STOP_INTENT = "execution runtime stop is in progress; exact cleanup is not yet confirmed";

export function exactPublishedExecutionRecord(
  owner: ExecutionRuntimeOwner,
  runtime: SpawnedRuntimeHandle,
  record: SessionRecord,
): boolean {
  return runtime.identity.kind === "hsr"
    && runtime.identity.beeName === owner.beeName
    && record.name === owner.beeName
    && record.executionRunId === owner.runId
    && record.substrate === "hsr"
    && record.runnerPid === runtime.identity.hostPid
    && sameProcessBirthFingerprint(record.runnerFingerprint, runtime.identity.hostFingerprint);
}

async function stopRuntime(runtime: SpawnedRuntimeHandle): Promise<SpawnRuntimeCleanup> {
  try {
    return await runtime.stop();
  } catch (error) {
    return { stopped: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function unresolved(
  detail: string,
  cleanup: SpawnRuntimeCleanup,
  stopDoubtPersisted: boolean,
): ExecutionRuntimeSettlement {
  return { settled: false, detail, cleanup, stopDoubtPersisted };
}

/**
 * Stop a launched execution runtime and remove its exact canonical generation.
 *
 * A published row is lifecycle-locked, birth-qualified, and durably changed
 * to the non-runnable `kill_failed` state before the first signal. The same
 * lock spans signal, exact-stop proof, launch-journal settlement, and purge.
 * Therefore a coordinator crash at any point after dispatch leaves a durable
 * stop-doubt fence that daemon recovery cannot revive.
 *
 * Absence is the only pre-publication case: there is no canonical work row to
 * fence, so the exact pid-scoped runtime may be stopped directly. Read errors
 * and identity mismatches send no signal.
 */
export async function stopAndSettleExecutionRuntime(
  owner: ExecutionRuntimeOwner,
  runtime: SpawnedRuntimeHandle,
  context: string,
  options: ExecutionRuntimeSettlementOptions = {},
): Promise<ExecutionRuntimeSettlement> {
  let snapshot: SessionRecord | null;
  try {
    snapshot = await loadSession(owner.beeName);
  } catch (error) {
    const cleanup = { stopped: false, detail: "stop was not dispatched" };
    return unresolved(
      `${context}; canonical SessionRecord could not be read before stop dispatch: ${error instanceof Error ? error.message : String(error)}`,
      cleanup,
      false,
    );
  }

  if (!snapshot) {
    const cleanup = await stopRuntime(runtime);
    try {
      await options.afterStopDispatch?.();
    } catch (error) {
      return unresolved(
        `${context}; coordinator failed after pre-publication stop dispatch: ${error instanceof Error ? error.message : String(error)}`,
        cleanup,
        false,
      );
    }
    try {
      await options.settleLaunchOwnership?.(cleanup);
    } catch (error) {
      return unresolved(
        `${context}; exact runtime cleanup completed but launch ownership settlement failed: ${error instanceof Error ? error.message : String(error)}`,
        cleanup,
        false,
      );
    }
    return cleanup.stopped
      ? { settled: true, detail: "exact pre-publication runtime stop confirmed", cleanup }
      : unresolved(`${context}; exact pre-publication runtime cleanup unconfirmed: ${cleanup.detail}`, cleanup, false);
  }

  if (!exactPublishedExecutionRecord(owner, runtime, snapshot)) {
    const cleanup = { stopped: false, detail: "stop was not dispatched" };
    return unresolved(
      `${context}; canonical SessionRecord does not prove Run ${owner.runId}'s exact launched runtime`,
      cleanup,
      false,
    );
  }

  try {
    return await withSessionLifecycleTransaction(snapshot, async (lifecycle) => {
      const current = await lifecycle.refresh();
      if (!exactPublishedExecutionRecord(owner, runtime, current)) {
        const cleanup = { stopped: false, detail: "stop was not dispatched" };
        return unresolved(
          `${context}; canonical execution generation changed before stop dispatch`,
          cleanup,
          false,
        );
      }

      // This durable non-runnable fence MUST precede runtime.stop(). The lock
      // itself is not crash durable and cannot substitute for this write.
      const stopping = await lifecycle.commit({
        status: "kill_failed",
        lastError: `${STOP_INTENT}: ${context}`,
        updatedAt: new Date().toISOString(),
      });
      const cleanup = await stopRuntime(runtime);

      try {
        await options.afterStopDispatch?.();
      } catch (error) {
        return unresolved(
          `${context}; coordinator failed after stop dispatch: ${error instanceof Error ? error.message : String(error)}`,
          cleanup,
          true,
        );
      }

      try {
        await options.settleLaunchOwnership?.(cleanup);
      } catch (error) {
        return unresolved(
          `${context}; launch ownership settlement failed after stop dispatch: ${error instanceof Error ? error.message : String(error)}`,
          cleanup,
          true,
        );
      }

      if (!cleanup.stopped) {
        const detail = `${context}; exact runtime cleanup unconfirmed: ${cleanup.detail}`;
        await lifecycle.commit({
          status: "kill_failed",
          lastError: detail,
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined);
        return unresolved(detail, cleanup, true);
      }

      if (options.retainCanonicalAfterConfirmedStop) {
        const detail = `${context}; ${options.retainCanonicalAfterConfirmedStop}`;
        await lifecycle.commit({
          status: "kill_failed",
          lastError: detail,
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined);
        return unresolved(detail, cleanup, true);
      }

      try {
        await purgeSessionAfterConfirmedRuntimeStopInTransaction(
          lifecycle,
          stopping,
          { emitLedger: false },
        );
        return {
          settled: true,
          detail: "exact runtime and canonical execution generation were purged",
          cleanup,
        };
      } catch (error) {
        // The pre-signal kill_failed write is already durable. A purge fault
        // therefore remains safely non-runnable even if this final detail
        // update also fails.
        const detail = `${context}; exact runtime stopped but canonical SessionRecord purge was unconfirmed: ${error instanceof Error ? error.message : String(error)}`;
        await lifecycle.commit({
          status: "kill_failed",
          lastError: detail,
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined);
        return unresolved(detail, cleanup, true);
      }
    });
  } catch (error) {
    const cleanup = { stopped: false, detail: "stop was not dispatched" };
    return unresolved(
      `${context}; lifecycle admission failed before stop dispatch: ${error instanceof Error ? error.message : String(error)}`,
      cleanup,
      false,
    );
  }
}

function exactExecutionSession(owner: ExecutionSessionOwner, record: SessionRecord): boolean {
  return record.name === owner.beeName
    && record.executionRunId === owner.runId
    && (owner.sessionRef === undefined || record.id === owner.sessionRef);
}

function isExactParkedExecutionSession(owner: ExecutionSessionOwner, record: SessionRecord): boolean {
  const state = record.stateMachine ?? legacyStateMachineSeed(record);
  return exactExecutionSession(owner, record)
    && record.status === "running"
    && record.stateUnverified === undefined
    && record.substrate === "hsr"
    && Boolean(record.providerSessionId)
    && state.lifecycle === "active"
    && state.runtime === "parked"
    && state.work === "done";
}

/**
 * Scale an expired execution runtime to zero without filing its logical Bee.
 *
 * Lease expiry is resource policy, not an operator lifecycle decision. Only a
 * settled, exact, active HSR generation is stopped here. A real in-flight turn
 * is deferred until the daemon's structured turn_end reconciliation changes
 * the bounded work axis to done; an explicit run.cancel/run.release continues
 * to use stopAndRetireExecutionSession instead.
 */
export async function parkExpiredExecutionSession(
  owner: ExecutionSessionOwner,
  leaseExpiresAt: string,
  context: string,
  options: ExecutionRuntimeParkingOptions = {},
): Promise<ExecutionRuntimeParkingResult> {
  const load = options.load ?? loadSession;
  let snapshot: SessionRecord | null;
  try {
    snapshot = await load(owner.beeName);
  } catch (error) {
    return {
      status: "unconfirmed",
      detail: `${context}; canonical SessionRecord could not be read before parking: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!snapshot || !exactExecutionSession(owner, snapshot)) {
    return {
      status: "unconfirmed",
      detail: `${context}; no exact canonical execution generation authorizes runtime parking`,
    };
  }
  const state = snapshot.stateMachine ?? legacyStateMachineSeed(snapshot);
  if (state.lifecycle !== "active") {
    return {
      status: "unconfirmed",
      detail: `${context}; exact execution SessionRecord is archived rather than actively parked`,
    };
  }
  if (snapshot.status !== "running" || snapshot.stateUnverified) {
    return {
      status: "unconfirmed",
      detail: `${context}; exact execution SessionRecord has unresolved runtime state`,
    };
  }
  if (state.work !== "done") {
    return {
      status: "deferred",
      detail: `${context}; bounded work is ${state.work}, so expiry will not interrupt an in-flight turn`,
    };
  }
  if (snapshot.substrate !== "hsr" || !snapshot.providerSessionId) {
    return {
      status: "unconfirmed",
      detail: `${context}; exact execution runtime is not a resumable local HSR`,
    };
  }
  // Idempotent success is still proof-bound: a parked needs-you row, an
  // unverified cursor, or a non-resumable substrate must never terminalize a
  // Run merely because one axis happens to say parked.
  if (isExactParkedExecutionSession(owner, snapshot)) {
    return { status: "parked", detail: "exact execution runtime was already parked; logical Bee remains active" };
  }
  if (state.runtime !== "live") {
    return {
      status: "deferred",
      detail: `${context}; runtime is ${state.runtime}, so expiry waits for runtime reconciliation`,
    };
  }

  try {
    const parked = await (options.park ?? parkIdleHsrRuntime)(snapshot, {
      idleSince: leaseExpiresAt,
      graceMs: 0,
      work: "done",
    }, {
      ...options.parkDeps,
      now: options.now ?? options.parkDeps?.now,
    });
    // Re-read after every parking attempt, including an apparent winner. A
    // concurrent uncertainty/fence write is independent of the lifecycle lock
    // and must win over the in-memory parking result.
    const latest = await load(owner.beeName);
    if (latest && isExactParkedExecutionSession(owner, latest)) {
      return {
        status: "parked",
        detail: parked.action === "parked"
          ? "exact execution runtime parked; logical Bee remains active"
          : "a concurrent parking winner left the logical Bee active",
      };
    }
    if (parked.action === "parked") {
      return {
        status: "unconfirmed",
        detail: `${context}; post-stop canonical parked proof was invalidated by a concurrent state/fence write`,
      };
    }
    const deferredReasons = new Set([
      "work-changed",
      "queued-send",
      "runtime-not-live",
      "runtime-died-before-offload",
    ]);
    return deferredReasons.has(parked.reason ?? "")
      ? { status: "deferred", detail: `${context}; parking deferred (${parked.reason})` }
      : { status: "unconfirmed", detail: `${context}; parking was not authorized (${parked.reason ?? "unknown reason"})` };
  } catch (error) {
    if (error instanceof LifecycleConflictError) {
      return { status: "deferred", detail: `${context}; a concurrent lifecycle mutation won before parking` };
    }
    return {
      status: "unconfirmed",
      detail: `${context}; runtime parking could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Lifecycle-fenced clean stop for ordinary cancel/expiry/release paths, where
 * the launch-time in-memory runtime handle is no longer available. Canonical
 * Run/session identity and the lifecycle generation fence the control RPC;
 * the control implementation independently birth-checks the recorded host.
 */
export async function stopAndRetireExecutionSession(
  owner: ExecutionSessionOwner,
  context: string,
  options: Pick<ExecutionRuntimeSettlementOptions, "afterStopDispatch"> = {},
): Promise<ExecutionRuntimeSettlement> {
  let snapshot: SessionRecord | null;
  try {
    snapshot = await loadSession(owner.beeName);
  } catch (error) {
    return unresolved(
      `${context}; canonical SessionRecord could not be read before stop dispatch: ${error instanceof Error ? error.message : String(error)}`,
      { stopped: false, detail: "stop was not dispatched" },
      false,
    );
  }
  if (!snapshot || !exactExecutionSession(owner, snapshot)) {
    return unresolved(
      `${context}; no exact canonical execution generation authorizes a stop`,
      { stopped: false, detail: "stop was not dispatched" },
      false,
    );
  }

  try {
    // transactionalRetire owns the complete strict protocol: lifecycle CAS +
    // durable kill_failed fence, then substrate-specific exact teardown
    // (including detached child groups and remote incarnation tokens), and
    // only then the proof-carrying archive transition.
    const outcome = await transactionalRetire(snapshot, {
      emitLedger: false,
      ...(options.afterStopDispatch
        ? { afterStopDispatch: async () => { await options.afterStopDispatch?.(); } }
        : {}),
    });
    if (outcome.ok) {
      return {
        settled: true,
        detail: "strict runtime teardown and canonical execution archive confirmed",
        cleanup: { stopped: true, detail: outcome.alreadyGone ? "runtime was already absent" : "strict teardown confirmed" },
      };
    }
    return unresolved(
      `${context}; strict runtime teardown or canonical archive unconfirmed: ${outcome.lastError}`,
      { stopped: false, detail: outcome.lastError },
      true,
    );
  } catch (error) {
    let stopDoubtPersisted = false;
    try {
      const current = await loadSession(owner.beeName);
      stopDoubtPersisted = !!current && exactExecutionSession(owner, current) && current.status === "kill_failed";
    } catch {
      // An unreadable canonical store is itself unresolved; never claim proof.
    }
    return unresolved(
      `${context}; strict runtime stop/archive protocol failed: ${error instanceof Error ? error.message : String(error)}`,
      { stopped: false, detail: "strict teardown completion is unconfirmed" },
      stopDoubtPersisted,
    );
  }
}
