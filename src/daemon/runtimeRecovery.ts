/** Probe-verified HSR death classification and bounded automatic recovery. */

import {
  drainStagedPendingHsrTurns,
  hasPendingHsrTurns,
  readStagedPendingHsrTurns,
  type StagedPendingTurnDrain,
} from "../hsr/pendingTurns.js";
import { readCurrentHsrEventTail, structuredStateFromEvents } from "../hsr/observe.js";
import { stopHsrIncarnation } from "../hsr/substrate.js";
import {
  HsrSourceEventLogBusyError,
  hsrMetaProvesProviderNeverStarted,
  readHsrMetaStrict,
  sealHsrEventStreamClosure,
  verifyHsrEventStreamClosure,
  writeHsrMeta,
  type HsrEventStreamClosure,
  type HsrMeta,
} from "../hsr/runDir.js";
import {
  assertHsrSourceEventLogIntegrity,
  HsrSourceEventIntegrityError,
} from "../hsr/eventIntegrity.js";
import { withSessionLifecycleTransaction } from "../lifecycle.js";
import { assertNoUnresolvedBeeNameLaunchReservationInAdmission } from "../nameAdmission.js";
import { assertNoUnresolvedHsrEventIntegrity } from "../hsr/eventIntegrity.js";
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
import {
  isRunnableSessionRecord,
  type BeeTransitionEvent,
  type ProbeEvidence,
  type RecoveryEvidence,
} from "../stateMachine.js";
import {
  appendLedger,
  legacyStateMachineSeed,
  loadSession,
  markSessionVerified,
  transitionSession,
  type SessionRecord,
} from "../store.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";
import {
  sameHsrHostIncarnation,
  type DeadHsrReAdoptionProbe,
  type LiveHsrReAdoptionProbe,
} from "./reAdoption.js";

export const DEFAULT_RUNTIME_RECOVERY_CONCURRENCY = 2;

export type RecoveryProbeEvidence = ProbeEvidence;

export type RuntimeRecoveryTransitionEvent = Extract<
  BeeTransitionEvent,
  { type: "runtime.lost" | "runtime.parked" | "recovery.succeeded" | "recovery.failed" }
>;

export type RecoveryRuntimeProbe = {
  evidence: RecoveryProbeEvidence;
  /** Exact disk authority is required before a dead HSR may recover. */
  deadHsr?: {
    meta: HsrMeta;
    hostVerdict: "gone" | "mismatch";
  };
};

export type ProbeBeeRuntime = (record: SessionRecord) => Promise<RecoveryRuntimeProbe>;
export type TransitionBeeRuntime = (bee: string, event: RuntimeRecoveryTransitionEvent) => Promise<unknown>;

export type RuntimeDeathDecision = {
  bee: string;
  action: "live" | "parked" | "recovering" | "integrity" | "unverified" | "skipped";
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
  markVerified?: typeof markSessionVerified;
  now?: () => number;
  random?: () => number;
  concurrency?: number;
};

function isRuntimeRecoveryLifecycleCandidate(record: SessionRecord): boolean {
  return record.substrate === "hsr" && isRunnableSessionRecord(record);
}

type DeadStreamDisposition =
  | { kind: "safe" }
  | { kind: "integrity"; detail: string }
  | { kind: "stop-doubt"; detail: string }
  | { kind: "unverified"; detail: string };

const DEAD_STREAM_LOCK_TIMEOUT_MS = 250;

function sameDeadStreamIncarnation(left: HsrMeta, right: HsrMeta): boolean {
  return sameHsrHostIncarnation(left, right) || (
    left.bee === right.bee
    && left.hostPid === right.hostPid
    && left.startedAt === right.startedAt
    && left.hostFingerprint === undefined
    && right.hostFingerprint === undefined
  );
}

async function settleDeadHsrEventStream(
  record: SessionRecord,
  proof: NonNullable<RecoveryRuntimeProbe["deadHsr"]>,
): Promise<DeadStreamDisposition> {
  const { meta } = proof;
  if (meta.bee !== record.name || (record.runnerPid !== undefined && record.runnerPid !== meta.hostPid)) {
    return { kind: "unverified", detail: "dead-runtime metadata no longer owns the canonical SessionRecord" };
  }

  let recoveredClosure: HsrEventStreamClosure | undefined;
  // A host-published append failure is stronger than a later contiguous tail:
  // the lost provider event received no seq, so a subsequent exit can never
  // prove that earlier effect absent. Recover the receipt before considering
  // any positive closure/no-child exception.
  let clean = !meta.eventIntegrityFailure && hsrMetaProvesProviderNeverStarted(meta);
  if (!clean && !meta.eventIntegrityFailure) {
    try {
      if (meta.eventStreamClosure) {
        clean = await verifyHsrEventStreamClosure(record.name, meta, DEAD_STREAM_LOCK_TIMEOUT_MS);
      } else {
        // The terminal event/high-water can be durable even if the host died
        // between sealing it and publishing the final meta. Reconstruct that
        // proof from exact host-stamped bytes; no exit or any gap rejects.
        recoveredClosure = await sealHsrEventStreamClosure(record.name, meta, DEAD_STREAM_LOCK_TIMEOUT_MS);
        clean = true;
      }
    } catch (error) {
      if (error instanceof HsrSourceEventLogBusyError) {
        return { kind: "unverified", detail: error.message };
      }
      clean = false;
    }
  }

  if (!clean) {
    const detail = meta.eventIntegrityFailure
      ?? "HSR host ended without positive durable provider-stream closure; provider output or tool effects may be missing";
    let markedMeta = meta;
    try {
      const latest = await readHsrMetaStrict(record.name);
      if (!latest || !sameDeadStreamIncarnation(meta, latest)) {
        return { kind: "unverified", detail: "HSR incarnation changed before event-integrity doubt could be published" };
      }
      if (latest.eventIntegrityFailure !== detail) {
        markedMeta = { ...latest, eventIntegrityFailure: detail };
        await writeHsrMeta(record.name, markedMeta);
      } else {
        markedMeta = latest;
      }
      await assertHsrSourceEventLogIntegrity({
        bee: record.name,
        meta: markedMeta,
        operation: "automatic runtime recovery",
      });
    } catch (error) {
      if (!(error instanceof HsrSourceEventIntegrityError)) throw error;
    }
    // The outside receipt is durable before this stop. The substrate owns the
    // exact host birth and detached child-group census; it upgrades the receipt
    // to confirmed only when both are absent.
    await stopHsrIncarnation(record.name, markedMeta);
    return { kind: "integrity", detail };
  }

  // A complete stream is not process-ownership proof. Confirm the exact dead
  // host and detached child group before allowing park/recovery. A failure is
  // retried conservatively; replacement admission remains responsible for its
  // normal durable stop-doubt fence.
  const stopped = await stopHsrIncarnation(record.name, meta);
  if (!stopped.ok) {
    return {
      kind: "stop-doubt",
      detail: stopped.stderr || "clean event stream exists but exact host/child stop is unconfirmed",
    };
  }

  if (recoveredClosure) {
    const latest = await readHsrMetaStrict(record.name);
    if (!latest || !sameDeadStreamIncarnation(meta, latest)) {
      return { kind: "unverified", detail: "HSR incarnation changed before clean stream closure could be healed" };
    }
    await writeHsrMeta(record.name, {
      ...latest,
      status: "exited",
      exitCode: latest.exitCode ?? null,
      endedAt: latest.endedAt ?? recoveredClosure.closedAt,
      eventStreamClosure: recoveredClosure,
    });
  }
  return { kind: "safe" };
}

/**
 * Classify only after an exact probe. Unreachable/uncertain evidence performs
 * zero transitions. This runs before the legacy observation write so parked
 * and recovering never publish a transient `crashed` cursor.
 */
export async function reconcileRuntimeDeaths(
  records: SessionRecord[],
  deps: RuntimeDeathReconcileDeps,
): Promise<RuntimeDeathDecision[]> {
  const candidates = records.filter(isRuntimeRecoveryLifecycleCandidate);
  return mapWithConcurrency(
    candidates,
    deps.concurrency ?? DEFAULT_RUNTIME_RECOVERY_CONCURRENCY,
    async (snapshot): Promise<RuntimeDeathDecision> =>
      withSessionLifecycleTransaction(snapshot, async (lifecycle) => {
        const record = await lifecycle.refresh();
        if (!isRuntimeRecoveryLifecycleCandidate(record)) {
          return { bee: record.name, action: "skipped", suppressLegacyCrash: true };
        }
        let observed: RecoveryRuntimeProbe;
        try {
          observed = await deps.probe(record);
        } catch {
          return { bee: record.name, action: "unverified", suppressLegacyCrash: true };
        }
        const probe = observed.evidence;
        if (probe.outcome === "unreachable") {
          return { bee: record.name, action: "unverified", suppressLegacyCrash: true, probe };
        }
        if (probe.outcome === "alive") {
          await (deps.markVerified ?? markSessionVerified)(record.name, probe);
          // This reconciler is entered only after the coarse observer derived a
          // death. Exact live evidence must therefore fence that false crash at
          // the write site just like parked/recovering classifications do.
          return { bee: record.name, action: "live", suppressLegacyCrash: true, probe };
        }

        // A dead pid/socket is not event-stream closure. Without the exact
        // disk authority a caller cannot authorize automatic work at all.
        if (!observed.deadHsr) {
          return { bee: record.name, action: "unverified", suppressLegacyCrash: true, probe };
        }
        let stream: DeadStreamDisposition;
        try {
          stream = await settleDeadHsrEventStream(record, observed.deadHsr);
        } catch (error) {
          const detail = `automatic runtime recovery could not persist source-integrity authority: ${error instanceof Error ? error.message : String(error)}`;
          await lifecycle.commit({ status: "kill_failed", lastError: detail, updatedAt: new Date().toISOString() });
          return { bee: record.name, action: "unverified", suppressLegacyCrash: true, probe };
        }
        if (stream.kind === "unverified") {
          return { bee: record.name, action: "unverified", suppressLegacyCrash: true, probe };
        }
        if (stream.kind === "stop-doubt") {
          await lifecycle.commit({
            status: "kill_failed",
            lastError: `automatic runtime recovery exact stop remains unresolved: ${stream.detail}`,
            updatedAt: new Date().toISOString(),
          });
          return { bee: record.name, action: "unverified", suppressLegacyCrash: true, probe };
        }
        if (stream.kind === "integrity") {
          return { bee: record.name, action: "integrity", suppressLegacyCrash: true, probe };
        }

        const state = record.stateMachine?.runtime;
        if (state === "lost") {
          await (deps.markVerified ?? markSessionVerified)(record.name, probe);
          return { bee: record.name, action: "skipped", suppressLegacyCrash: true, probe };
        }
        const existingRecovery = await readRuntimeRecovery(record.name);
        const staged = await readStagedPendingHsrTurns(record.name);
        if (state === "recovering") {
          await (deps.markVerified ?? markSessionVerified)(record.name, probe);
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
        const boundedWork = record.stateMachine?.work ?? legacyStateMachineSeed(record).work;
        const reusableRecovery = existingRecovery?.status === "recovering" || existingRecovery?.status === "failed"
          ? existingRecovery
          : null;
        // ADR: needs-you is an already-suspended turn. A structured blocked
        // marker, staged input, or stale recovery episode cannot promote its
        // runner death back into in-flight work; the open request outlives the
        // runtime and the replacement is started lazily when delivery needs it.
        const durableMidTurn = boundedWork !== "needs-you" && (
          pending || unfinished || boundedWork === "working" || staged !== null || reusableRecovery !== null
        );
        if (!durableMidTurn) {
          if (state !== "parked") {
            await deps.transition(record.name, {
              type: "runtime.parked",
              eventId: `runtime-parked:${probe.probeId}`,
              at: probe.observedAt,
              cause: "idle-death",
              probe,
            });
          } else {
            await (deps.markVerified ?? markSessionVerified)(record.name, probe);
          }
          return { bee: record.name, action: "parked", suppressLegacyCrash: true, probe };
        }

        const recovery = reusableRecovery ?? await beginRuntimeRecovery({
            bee: record.name,
            generation: record.runtimeGeneration ?? 0,
            probeId: probe.probeId,
            nowMs: (deps.now ?? Date.now)(),
            random: deps.random,
          });
        await deps.transition(record.name, {
          type: "runtime.lost",
          eventId: `runtime-lost:${probe.probeId}`,
          at: probe.observedAt,
          cause: "mid-turn-death",
          probe,
        });
        return {
          bee: record.name,
          action: "recovering",
          suppressLegacyCrash: true,
          probe,
          episodeId: recovery.episodeId,
        };
      }),
  );
}

export type RuntimeRecoveryOutcome = {
  bee: string;
  action: "deferred" | "started" | "recovered" | "failed" | "exhausted" | "integrity" | "unverified" | "skipped";
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
  markVerified?: typeof markSessionVerified;
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
    attempt: attempt?.attempt ?? Math.max(1, record.attempts.length),
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
    eventId: `recovery-failed:${latest?.attemptId ?? record.episodeId}`,
    at: record.updatedAt,
    cause: "budget-exhausted",
    probe,
    evidence: recoveryEvidence(record, latest, "failed", record.updatedAt, latest?.error),
    requestId,
  });
  return { bee: record.bee, action: "exhausted", attempt: latest?.attempt, requestId, error: latest?.error };
}

async function publishVerifiedRecoverySuccess(
  record: SessionRecord,
  recovery: RuntimeRecoveryRecord,
  probe: RecoveryProbeEvidence,
  deps: RuntimeRecoverySweepDeps,
): Promise<RuntimeRecoveryOutcome> {
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    await assertNoUnresolvedBeeNameLaunchReservationInAdmission(
      current,
      "automatic runtime recovery completion",
    );
    await assertNoUnresolvedHsrEventIntegrity(current.name, "automatic runtime recovery completion");
    if (!isRunnableSessionRecord(current)) {
      return { bee: current.name, action: "skipped" };
    }
    const now = deps.now ?? Date.now;
    const staged = await readStagedPendingHsrTurns(current.name);
    let replayedTurns = 0;
    if (staged) replayedTurns = await (deps.drainStaged ?? drainStagedPendingHsrTurns)(current.name);
    const started = latestStartedAttempt(recovery);
    const latest = started ?? recovery.attempts.at(-1);
    const observedAt = new Date(now()).toISOString();
    await deps.transition(current.name, {
      type: "recovery.succeeded",
      eventId: `recovery-succeeded:${latest?.attemptId ?? recovery.episodeId}`,
      at: observedAt,
      cause: "revive-ok",
      probe,
      evidence: recoveryEvidence(
        recovery,
        latest,
        "succeeded",
        observedAt,
        `replayed ${replayedTurns} pending turns`,
      ),
    });
    if (started) {
      await finishRuntimeRecoveryAttempt({
        bee: current.name,
        attemptId: started.attemptId,
        outcome: "succeeded",
        nowMs: now(),
      });
    }
    return { bee: current.name, action: "recovered", attempt: latest?.attempt, replayedTurns };
  });
}

async function runRecoveryCandidate(
  snapshot: SessionRecord,
  deps: RuntimeRecoverySweepDeps,
): Promise<RuntimeRecoveryOutcome> {
  const now = deps.now ?? Date.now;
  const record = await (deps.loadRecord ?? loadSession)(snapshot.name);
  if (!record || !isRuntimeRecoveryLifecycleCandidate(record)) {
    return { bee: snapshot.name, action: "skipped" };
  }
  const recovery = await readRuntimeRecovery(record.name);
  if (!recovery) return { bee: record.name, action: "skipped" };

  let beforeObserved: RecoveryRuntimeProbe;
  try {
    beforeObserved = await deps.probe(record);
  } catch {
    return { bee: record.name, action: "unverified" };
  }
  const before = beforeObserved.evidence;
  if (before.outcome === "unreachable") return { bee: record.name, action: "unverified" };
  if (before.outcome === "dead") {
    if (!beforeObserved.deadHsr) return { bee: record.name, action: "unverified" };
    const stream = await withSessionLifecycleTransaction(record, async (lifecycle) => {
      const current = await lifecycle.refresh();
      if (!isRuntimeRecoveryLifecycleCandidate(current)) {
        return { kind: "unverified", detail: "runtime recovery lost canonical source admission" } as DeadStreamDisposition;
      }
      try {
        const disposition = await settleDeadHsrEventStream(current, beforeObserved.deadHsr!);
        if (disposition.kind === "stop-doubt") {
          await lifecycle.commit({
            status: "kill_failed",
            lastError: `automatic runtime recovery exact stop remains unresolved: ${disposition.detail}`,
            updatedAt: new Date().toISOString(),
          });
        }
        return disposition;
      } catch (error) {
        const detail = `automatic runtime recovery could not persist source-integrity authority: ${error instanceof Error ? error.message : String(error)}`;
        await lifecycle.commit({ status: "kill_failed", lastError: detail, updatedAt: new Date().toISOString() });
        return { kind: "unverified", detail } as DeadStreamDisposition;
      }
    });
    if (stream.kind === "integrity") return { bee: record.name, action: "integrity" };
    if (stream.kind !== "safe") return { bee: record.name, action: "unverified" };
  }
  await (deps.markVerified ?? markSessionVerified)(record.name, before);
  if (before.outcome === "alive") {
    // A prior launch may have committed before the daemon died. Finish its
    // replay before publishing success; the durable marker makes this retryable.
    return publishVerifiedRecoverySuccess(record, recovery, before, deps);
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
  let revived: Awaited<ReturnType<typeof reviveHsrForAutomaticRecovery>>;
  let after: RecoveryProbeEvidence;
  try {
    revived = await (deps.revive ?? reviveHsrForAutomaticRecovery)(record, claim.record.episodeId);
    after = (await deps.probe(revived.record)).evidence;
    if (after.outcome !== "alive") throw new Error(`replacement runtime probe returned ${after.outcome}`);
    await (deps.markVerified ?? markSessionVerified)(record.name, after);
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

  // Persist the bounded success edge before consuming the attempt. If the
  // store write fails, the started lease remains retryable and the next sweep
  // observes the already-live replacement instead of charging a false failure.
  const succeededAt = new Date(now()).toISOString();
  await deps.transition(record.name, {
    type: "recovery.succeeded",
    eventId: `recovery-succeeded:${attempt.attemptId}`,
    at: succeededAt,
    cause: "revive-ok",
    probe: after,
    evidence: recoveryEvidence(claim.record, attempt, "succeeded", succeededAt, `replayed ${revived.replayedTurns} pending turns`),
  });
  await finishRuntimeRecoveryAttempt({
    bee: record.name,
    attemptId: attempt.attemptId,
    outcome: "succeeded",
    nowMs: now(),
    random: deps.random,
  });
  return { bee: record.name, action: "recovered", attempt: attempt.attempt, replayedTurns: revived.replayedTurns };
}

/** Boot handoff: persist the exact death classification before clearing H1's marker. */
export async function handleVerifiedBootRuntimeDeath(
  probe: DeadHsrReAdoptionProbe,
  deps: Partial<RuntimeDeathReconcileDeps> = {},
): Promise<"handled" | "deferred"> {
  const decisions = await reconcileRuntimeDeaths([probe.record], {
    probe: async () => ({
      evidence: probe.evidence,
      deadHsr: { meta: probe.diskMeta, hostVerdict: probe.hostVerdict },
    }),
    transition: deps.transition ?? transitionSession,
    hasPendingTurns: deps.hasPendingTurns,
    hasUnfinishedMarker: deps.hasUnfinishedMarker ?? (async (bee) => {
      const state = structuredStateFromEvents(await readCurrentHsrEventTail(bee));
      return state === "active" || state === "blocked" || state === "auth-needed";
    }),
    markVerified: deps.markVerified,
    now: deps.now,
    random: deps.random,
    concurrency: 1,
  });
  const decision = decisions[0];
  return decision && decision.action !== "unverified" && decision.action !== "live"
    ? "handled"
    : "deferred";
}

/** Boot handoff: a live recovering incarnation completes replay + success. */
export async function handleVerifiedBootRuntimeLive(
  probe: LiveHsrReAdoptionProbe,
  deps: Partial<RuntimeRecoverySweepDeps> = {},
): Promise<void> {
  const record = await (deps.loadRecord ?? loadSession)(probe.record.name);
  if (!record || record.stateMachine?.runtime !== "recovering") return;
  const recovery = await readRuntimeRecovery(record.name);
  if (!recovery) throw new Error(`recovering bee ${record.name} has no durable recovery budget`);
  await publishVerifiedRecoverySuccess(record, recovery, probe.evidence, {
    ...deps,
    probe: async () => ({ evidence: probe.evidence }),
    transition: deps.transition ?? transitionSession,
  });
}

export async function runRuntimeRecoverySweep(
  records: SessionRecord[],
  deps: RuntimeRecoverySweepDeps,
): Promise<RuntimeRecoveryOutcome[]> {
  const candidates = records.filter((record) =>
    isRuntimeRecoveryLifecycleCandidate(record) &&
    record.stateMachine?.runtime === "recovering");
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
      isRuntimeRecoveryLifecycleCandidate(record) && record.stateMachine?.runtime === "recovering");
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
