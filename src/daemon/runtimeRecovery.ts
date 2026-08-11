/** Probe-verified HSR death classification and bounded automatic recovery. */

import {
  drainStagedPendingHsrTurns,
  hasPendingHsrTurns,
  readStagedPendingHsrTurns,
  type StagedPendingTurnDrain,
} from "../hsr/pendingTurns.js";
import { openRequest } from "../requests/store.js";
import { recoveryFailedRequestId } from "../requests/keys.js";
import {
  beginRuntimeRecovery,
  claimRuntimeRecoveryAttempt,
  finishRuntimeRecoveryAttempt,
  markRuntimeRecoveryFailedRequest,
  readRuntimeRecovery,
  type RuntimeRecoveryAttempt,
  type RuntimeRecoveryRecord,
} from "../recovery/store.js";
import { reviveHsrForAutomaticRecovery } from "../recovery/revive.js";
import { appendLedger, loadSession, type SessionRecord } from "../store.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";

export const DEFAULT_RUNTIME_RECOVERY_CONCURRENCY = 2;

export type RecoveryProbeEvidence = {
  kind: "probe";
  probeId: string;
  observerId: string;
  observedAt: string;
  outcome: "alive" | "dead" | "unreachable";
  target: {
    substrate: "local-tmux" | "hsr";
    node?: string;
    tmuxTarget?: string;
    agentPaneId?: string;
    runnerPid?: number;
  };
  detail?: string;
};

export type RecoveryEvidence = {
  kind: "recovery";
  attemptId: string;
  observedAt: string;
  attempt: number;
  budget: number;
  outcome: "started" | "succeeded" | "failed";
  detail?: string;
};

export type RuntimeRecoveryTransitionEvent =
  | { type: "runtime.lost"; cause: "mid-turn-death"; probe: RecoveryProbeEvidence }
  | { type: "runtime.parked"; cause: "idle-death"; probe: RecoveryProbeEvidence }
  | { type: "recovery.succeeded"; probe: RecoveryProbeEvidence; recovery: RecoveryEvidence }
  | { type: "recovery.failed"; probe: RecoveryProbeEvidence; recovery: RecoveryEvidence; requestId: string };

export type ProbeBeeRuntime = (record: SessionRecord) => Promise<RecoveryProbeEvidence>;
export type TransitionBeeRuntime = (bee: string, event: RuntimeRecoveryTransitionEvent) => Promise<unknown>;

type RecordWithStateMachine = SessionRecord & {
  stateMachine?: { runtime?: "live" | "parked" | "recovering" | "lost"; lifecycle?: "active" | "archived" };
};

export type RuntimeDeathDecision = {
  bee: string;
  action: "live" | "parked" | "recovering" | "unverified" | "skipped";
  /** True means tick must not persist/mirror its derived legacy crashed cursor. */
  suppressLegacyCrash: boolean;
  probe?: RecoveryProbeEvidence;
  episodeId?: string;
};

export type RuntimeDeathReconcileDeps = {
  probe: ProbeBeeRuntime;
  transition: TransitionBeeRuntime;
  hasPendingTurns?: (bee: string) => Promise<boolean>;
  hasUnfinishedMarker?: (bee: string) => Promise<boolean>;
  now?: () => number;
  random?: () => number;
  concurrency?: number;
};

/**
 * Classify only after an exact probe. Unreachable/uncertain evidence performs
 * zero transitions. This runs before the legacy observation write so parked
 * and recovering never publish a transient `crashed` cursor.
 */
export async function reconcileRuntimeDeaths(
  records: SessionRecord[],
  deps: RuntimeDeathReconcileDeps,
): Promise<RuntimeDeathDecision[]> {
  const candidates = records.filter((record) =>
    record.substrate === "hsr" && record.status === "running" &&
    (record as RecordWithStateMachine).stateMachine?.lifecycle !== "archived");
  return mapWithConcurrency(
    candidates,
    deps.concurrency ?? DEFAULT_RUNTIME_RECOVERY_CONCURRENCY,
    async (record): Promise<RuntimeDeathDecision> => {
      let probe: RecoveryProbeEvidence;
      try {
        probe = await deps.probe(record);
      } catch {
        return { bee: record.name, action: "unverified", suppressLegacyCrash: false };
      }
      if (probe.outcome === "unreachable") {
        return { bee: record.name, action: "unverified", suppressLegacyCrash: false, probe };
      }
      if (probe.outcome === "alive") {
        return { bee: record.name, action: "live", suppressLegacyCrash: false, probe };
      }

      const state = (record as RecordWithStateMachine).stateMachine?.runtime;
      const existingRecovery = await readRuntimeRecovery(record.name);
      const staged = await readStagedPendingHsrTurns(record.name);
      const alreadyRecovering = state === "recovering" || existingRecovery?.status === "recovering" || staged !== null;
      if (alreadyRecovering) {
        return {
          bee: record.name,
          action: "recovering",
          suppressLegacyCrash: true,
          probe,
          ...(existingRecovery ? { episodeId: existingRecovery.episodeId } : {}),
        };
      }

      const [pending, unfinished] = await Promise.all([
        (deps.hasPendingTurns ?? hasPendingHsrTurns)(record.name),
        deps.hasUnfinishedMarker?.(record.name) ?? Promise.resolve(false),
      ]);
      if (!pending && !unfinished) {
        if (state !== "parked") {
          await deps.transition(record.name, { type: "runtime.parked", cause: "idle-death", probe });
        }
        return { bee: record.name, action: "parked", suppressLegacyCrash: true, probe };
      }

      const recovery = await beginRuntimeRecovery({
        bee: record.name,
        generation: record.runtimeGeneration ?? 0,
        probeId: probe.probeId,
        nowMs: (deps.now ?? Date.now)(),
        random: deps.random,
      });
      await deps.transition(record.name, { type: "runtime.lost", cause: "mid-turn-death", probe });
      return {
        bee: record.name,
        action: "recovering",
        suppressLegacyCrash: true,
        probe,
        episodeId: recovery.episodeId,
      };
    },
  );
}

export type RuntimeRecoveryOutcome = {
  bee: string;
  action: "deferred" | "started" | "recovered" | "failed" | "exhausted" | "unverified" | "skipped";
  attempt?: number;
  retryAt?: string;
  requestId?: string;
  replayedTurns?: number;
  error?: string;
};

export type RuntimeRecoverySweepDeps = {
  probe: ProbeBeeRuntime;
  transition: TransitionBeeRuntime;
  now?: () => number;
  random?: () => number;
  concurrency?: number;
  loadRecord?: typeof loadSession;
  revive?: typeof reviveHsrForAutomaticRecovery;
  drainStaged?: (bee: string, drain?: StagedPendingTurnDrain) => Promise<number>;
  appendEvent?: typeof appendLedger;
  openFailureRequest?: typeof openRecoveryFailedRequest;
};

function latestStartedAttempt(record: RuntimeRecoveryRecord): RuntimeRecoveryAttempt | undefined {
  const latest = record.attempts.at(-1);
  return latest?.outcome === "started" ? latest : undefined;
}

function recoveryEvidence(
  record: RuntimeRecoveryRecord,
  attempt: RuntimeRecoveryAttempt | undefined,
  outcome: RecoveryEvidence["outcome"],
  observedAt: string,
  detail?: string,
): RecoveryEvidence {
  return {
    kind: "recovery",
    attemptId: attempt?.attemptId ?? record.episodeId,
    observedAt,
    attempt: attempt?.attempt ?? record.attempts.length,
    budget: record.maxAttempts,
    outcome,
    ...(detail ? { detail } : {}),
  };
}

export async function openRecoveryFailedRequest(record: RuntimeRecoveryRecord): Promise<string> {
  const requestId = recoveryFailedRequestId(record.bee, record.episodeId);
  const attempts = record.attempts.map(({ attemptId, attempt, scheduledDelayMs, startedAt, endedAt, outcome, error }) => ({
    attemptId,
    attempt,
    scheduledDelayMs,
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    outcome,
    ...(error ? { error } : {}),
  }));
  await openRequest(record.bee, {
    id: requestId,
    kind: "manual-action",
    scope: "bee",
    grade: "structured",
    generation: record.generation,
    openedAt: record.updatedAt,
    question: `Automatic runtime recovery exhausted ${record.maxAttempts} attempts. Run hive revive ${record.bee} after correcting the underlying failure.`,
    input: { episodeId: record.episodeId, attempts },
    evidence: {
      grade: "structured",
      source: "runtime-recovery-supervisor",
      observedAt: record.updatedAt,
      detail: `recovery budget exhausted after ${record.attempts.length} attempts`,
    },
  });
  await markRuntimeRecoveryFailedRequest(record.bee, requestId);
  return requestId;
}

async function publishExhausted(
  record: RuntimeRecoveryRecord,
  probe: RecoveryProbeEvidence,
  deps: RuntimeRecoverySweepDeps,
): Promise<RuntimeRecoveryOutcome> {
  const requestId = await (deps.openFailureRequest ?? openRecoveryFailedRequest)(record);
  const latest = record.attempts.at(-1);
  await deps.transition(record.bee, {
    type: "recovery.failed",
    probe,
    recovery: recoveryEvidence(record, latest, "failed", record.updatedAt, latest?.error),
    requestId,
  });
  return { bee: record.bee, action: "exhausted", attempt: latest?.attempt, requestId, error: latest?.error };
}

async function runRecoveryCandidate(
  snapshot: SessionRecord,
  deps: RuntimeRecoverySweepDeps,
): Promise<RuntimeRecoveryOutcome> {
  const now = deps.now ?? Date.now;
  const record = await (deps.loadRecord ?? loadSession)(snapshot.name);
  if (!record || record.status !== "running" || record.substrate !== "hsr") {
    return { bee: snapshot.name, action: "skipped" };
  }
  const recovery = await readRuntimeRecovery(record.name);
  if (!recovery || recovery.status === "recovered") return { bee: record.name, action: "skipped" };

  let before: RecoveryProbeEvidence;
  try {
    before = await deps.probe(record);
  } catch {
    return { bee: record.name, action: "unverified" };
  }
  if (before.outcome === "unreachable") return { bee: record.name, action: "unverified" };
  if (before.outcome === "alive") {
    // A prior launch may have committed before the daemon died. Finish its
    // replay before publishing success; the durable marker makes this retryable.
    const staged = await readStagedPendingHsrTurns(record.name);
    let replayedTurns = 0;
    if (staged) {
      replayedTurns = await (deps.drainStaged ?? drainStagedPendingHsrTurns)(record.name);
    }
    const started = latestStartedAttempt(recovery);
    const completed = started
      ? await finishRuntimeRecoveryAttempt({ bee: record.name, attemptId: started.attemptId, outcome: "succeeded", nowMs: now() })
      : recovery;
    const effective = completed ?? recovery;
    await deps.transition(record.name, {
      type: "recovery.succeeded",
      probe: before,
      recovery: recoveryEvidence(effective, started, "succeeded", new Date(now()).toISOString(), `replayed ${replayedTurns} pending turns`),
    });
    return { bee: record.name, action: "recovered", attempt: started?.attempt, replayedTurns };
  }

  const claim = await claimRuntimeRecoveryAttempt({ bee: record.name, nowMs: now(), random: deps.random });
  if (claim.action === "deferred") {
    return { bee: record.name, action: "deferred", retryAt: claim.retryAt, attempt: claim.record.attempts.length };
  }
  if (claim.action === "inactive") return { bee: record.name, action: "skipped" };
  if (claim.action === "exhausted") return publishExhausted(claim.record, before, deps);

  const attempt = claim.attempt;
  await (deps.appendEvent ?? appendLedger)({
    type: "runtime.recovery.attempt",
    session: record.name,
    episodeId: claim.record.episodeId,
    attemptId: attempt.attemptId,
    attempt: attempt.attempt,
    budget: claim.record.maxAttempts,
    outcome: "started",
    ts: attempt.startedAt,
  });
  try {
    const revived = await (deps.revive ?? reviveHsrForAutomaticRecovery)(record, claim.record.episodeId);
    const after = await deps.probe(revived.record);
    if (after.outcome !== "alive") throw new Error(`replacement runtime probe returned ${after.outcome}`);
    const completed = await finishRuntimeRecoveryAttempt({
      bee: record.name,
      attemptId: attempt.attemptId,
      outcome: "succeeded",
      nowMs: now(),
      random: deps.random,
    });
    const effective = completed ?? claim.record;
    await deps.transition(record.name, {
      type: "recovery.succeeded",
      probe: after,
      recovery: recoveryEvidence(effective, attempt, "succeeded", new Date(now()).toISOString(), `replayed ${revived.replayedTurns} pending turns`),
    });
    return { bee: record.name, action: "recovered", attempt: attempt.attempt, replayedTurns: revived.replayedTurns };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await finishRuntimeRecoveryAttempt({
      bee: record.name,
      attemptId: attempt.attemptId,
      outcome: "failed",
      error: message,
      nowMs: now(),
      random: deps.random,
    });
    await (deps.appendEvent ?? appendLedger)({
      type: "runtime.recovery.attempt",
      session: record.name,
      episodeId: claim.record.episodeId,
      attemptId: attempt.attemptId,
      attempt: attempt.attempt,
      budget: claim.record.maxAttempts,
      outcome: "failed",
      error: message.slice(0, 2_000),
      ts: new Date(now()).toISOString(),
    });
    if (failed?.status === "failed") return publishExhausted(failed, before, deps);
    return { bee: record.name, action: "failed", attempt: attempt.attempt, retryAt: failed?.nextAttemptAt, error: message };
  }
}

export async function runRuntimeRecoverySweep(
  records: SessionRecord[],
  deps: RuntimeRecoverySweepDeps,
): Promise<RuntimeRecoveryOutcome[]> {
  const candidates = records.filter((record) =>
    record.substrate === "hsr" && record.status === "running" &&
    (record as RecordWithStateMachine).stateMachine?.runtime === "recovering");
  return mapWithConcurrency(
    candidates,
    deps.concurrency ?? envConcurrency("HIVE_RUNTIME_RECOVERY_CONCURRENCY", DEFAULT_RUNTIME_RECOVERY_CONCURRENCY),
    (record) => runRecoveryCandidate(record, deps),
  );
}

export type RuntimeRecoveryDispatcher = (records: SessionRecord[]) => Promise<RuntimeRecoveryOutcome[]>;

/** Tick-facing collector/launcher: at most one background sweep per daemon. */
export function createRuntimeRecoveryDispatcher(
  deps: RuntimeRecoverySweepDeps & { startBackground?: (job: () => Promise<void>) => void },
): RuntimeRecoveryDispatcher {
  const startBackground = deps.startBackground ?? ((job: () => Promise<void>) => queueMicrotask(() => void job()));
  let inFlight = false;
  let pending: RuntimeRecoveryOutcome[] = [];
  return async (records) => {
    const report = pending;
    pending = [];
    const candidates = records.some((record) =>
      record.substrate === "hsr" && (record as RecordWithStateMachine).stateMachine?.runtime === "recovering");
    if (inFlight || !candidates) return report;
    inFlight = true;
    startBackground(async () => {
      try {
        pending = await runRuntimeRecoverySweep(records, deps);
      } catch (error) {
        pending = [{ bee: "<runtime-recovery-sweep>", action: "failed", error: error instanceof Error ? error.message : String(error) }];
      } finally {
        inFlight = false;
      }
    });
    return report;
  };
}
