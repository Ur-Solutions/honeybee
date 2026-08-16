import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "../src/comb/types.js";
import { cmdExecution } from "../src/commands/execution.js";
import {
  repairLegacyLeaseExpiryArchive,
  type LeaseArchiveRepairDependencies,
} from "../src/execution/archiveRepair.js";
import type { OperationRecord } from "../src/execution/opsStore.js";
import type { RunReservation, StoredRunEvent } from "../src/execution/runStore.js";
import type { HsrMeta } from "../src/hsr/runDir.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import type { Parsed } from "../src/parse.js";
import type { RuntimeRecoveryRecord } from "../src/recovery/store.js";
import {
  loadSession,
  isPendingSessionRuntimeReplacement,
  saveSession,
  transitionSession,
  updateSession,
  type SessionRecord,
} from "../src/store.js";
import type { BeeTransitionReceipt, ProbeEvidence } from "../src/stateMachine.js";
import { withTempStore } from "./executionTestKit.js";

const BEE = "xr-faf6952a6854";
const BEE_ID = "CO.ce1a";
const RUN = "run-1102d5c0be5d543f17f84c6902a82851";
const LEASE_AT = "2026-08-16T09:44:27.265Z";
const CANCEL_AT = "2026-08-16T09:44:52.224Z";
const CLOSED_AT = "2026-08-16T09:44:52.320Z";
const ARCHIVED_AT = "2026-08-16T09:44:53.631Z";
const FINISHED_AT = "2026-08-16T09:44:53.649Z";
const REPAIR_AT = "2026-08-16T14:55:00.000Z";
const FINGERPRINT = { pgid: 4242, startedAt: "Sun Aug 16 09:40:00 2026" };
const CORRECTED_AT = "2026-08-16T13:38:10.906Z";
const LOST_AT = "2026-08-16T13:38:15.656Z";
const RECOVERED_AT = "2026-08-16T13:38:31.710Z";
const SUCCESSOR_PID = 22961;
const SUCCESSOR_FINGERPRINT = { pgid: SUCCESSOR_PID, startedAt: "Sun Aug 16 15:38:31 2026" };
const RECOVERY_EPISODE = "327f-recovery-episode";
const RECOVERY_ATTEMPT = "ac7584-recovery-attempt";
const LOST_PROBE_ID = "4f8222-dead-probe";

function deadProbe(id: string, at = ARCHIVED_AT): ProbeEvidence {
  return {
    kind: "probe",
    probeId: id,
    observerId: "legacy-execution-reconciler",
    observedAt: at,
    outcome: "dead",
    target: { substrate: "hsr", runnerPid: 4242 },
    detail: "legacy execution stop observed the exact HSR generation absent",
  };
}

function session(): SessionRecord {
  return {
    name: BEE,
    id: BEE_ID,
    agent: "codex",
    cwd: "/tmp/intentionally-dirty-cell-working-copy",
    command: "codex",
    tmuxTarget: BEE,
    substrate: "hsr",
    runnerPid: 4242,
    runnerFingerprint: FINGERPRINT,
    providerSessionId: "thread-ce1a",
    executionRunId: RUN,
    runtimeGeneration: 3,
    createdAt: "2026-08-16T09:40:00.000Z",
    updatedAt: ARCHIVED_AT,
    status: "running",
    lastObservedState: "archived",
    lastObservedStateAt: ARCHIVED_AT,
  };
}

function reservation(overrides: Partial<RunReservation> = {}): RunReservation {
  return {
    version: 1,
    runId: RUN,
    effectKey: `${RUN}/start`,
    requestDigest: `sha256:${"1".repeat(64)}`,
    receipt: {
      receiptId: "receipt-lease-archive",
      effectKey: `${RUN}/start`,
      requestDigest: `sha256:${"1".repeat(64)}`,
      outcome: "created",
      resultVersion: 1,
      recordedAt: "2026-08-16T09:40:00.000Z",
    },
    protocolVersion: "0.1",
    schemaDigest: `sha256:${"2".repeat(64)}`,
    ownerScopeId: "scope-1",
    workspaceId: "workspace-1",
    jobId: "job-1",
    leaseId: "lease-1",
    leaseExpiresAt: LEASE_AT,
    capabilityLeaseId: "capability-1",
    intent: {},
    beeName: BEE,
    phase: "started",
    startedAt: "2026-08-16T09:40:01.000Z",
    sessionRef: BEE_ID,
    cancel: { requestedAt: CANCEL_AT, reason: "lease_expired" },
    result: { outcome: "cancelled", cause: "lease_expired", finishedAt: FINISHED_AT },
    createdAt: "2026-08-16T09:40:00.000Z",
    updatedAt: FINISHED_AT,
    ...overrides,
  };
}

function runEvent(seq: number, type: string, occurredAt: string, payload: Record<string, unknown>): StoredRunEvent {
  return {
    protocolVersion: "0.1",
    runId: RUN,
    seq,
    eventId: `evt-${seq}`,
    type,
    occurredAt,
    ingestedAt: occurredAt,
    origin: { nodeId: "node-1" },
    payload: payload as JsonValue,
  };
}

function events(): StoredRunEvent[] {
  return [
    runEvent(1, "run.accepted", "2026-08-16T09:40:00.000Z", {}),
    runEvent(2, "cancel.requested", CANCEL_AT, { reason: "lease_expired" }),
    runEvent(3, "run.cancelled", "2026-08-16T09:44:53.650Z", { cause: "lease_expired" }),
  ];
}

function meta(overrides: Partial<HsrMeta> = {}): HsrMeta {
  return {
    bee: BEE,
    harness: "codex",
    tier: "server",
    sessionId: "thread-ce1a",
    hostPid: 4242,
    hostFingerprint: FINGERPRINT,
    startedAt: "2026-08-16T09:40:00.000Z",
    controlSocket: "/tmp/closed-ce1a.sock",
    status: "exited",
    exitCode: 0,
    endedAt: CLOSED_AT,
    eventStreamClosure: { version: 1, lastSeq: 1076, closedAt: CLOSED_AT },
    ...overrides,
  };
}

function operation(method: "run.cancel" | "run.release"): OperationRecord {
  return {
    version: 1,
    method,
    runId: RUN,
    effectKey: `${RUN}/${method}`,
    requestDigest: `sha256:${"3".repeat(64)}`,
    receipt: {
      receiptId: `receipt-${method}`,
      effectKey: `${RUN}/${method}`,
      requestDigest: `sha256:${"3".repeat(64)}`,
      outcome: "created",
      resultVersion: 1,
      recordedAt: CANCEL_AT,
    },
    protocolVersion: "0.1",
    schemaDigest: `sha256:${"2".repeat(64)}`,
    createdAt: CANCEL_AT,
    updatedAt: CANCEL_AT,
  };
}

async function archiveFixture(): Promise<void> {
  await saveSession(session(), { probeEvidence: deadProbe("legacy-observer") });
  await transitionSession(BEE, {
    type: "bee.archived",
    eventId: "legacy-lease-archive",
    at: ARCHIVED_AT,
    cause: "retire",
    evidence: { kind: "operator", actionId: "legacy-lease-retire", observedAt: ARCHIVED_AT, action: "retire" },
    probe: deadProbe("legacy-lease-retire-probe"),
  });
}

function dependencies(overrides: LeaseArchiveRepairDependencies = {}): LeaseArchiveRepairDependencies {
  return {
    readReservation: async () => reservation(),
    readRunEvents: async () => events(),
    listOperations: async () => [],
    readLedgerEvents: async () => [
      {
        type: "state.transition.accepted",
        session: BEE,
        event: { eventId: "legacy-lease-archive", type: "bee.archived", cause: "retire" },
      },
      // Historical execution teardown can carry the same generic audit row as
      // a manual retire. Explicit --apply intent, not this ambiguous row,
      // authorizes the one correction.
      { type: "session.retire", session: BEE, ok: true },
    ],
    readHsrMeta: async () => meta(),
    verifyEventClosure: async () => true,
    isRuntimeLive: async () => false,
    now: () => new Date(REPAIR_AT),
    ...overrides,
  };
}

function successorProbe(outcome: "alive" | "dead", observedAt = RECOVERED_AT): ProbeEvidence {
  return {
    kind: "probe",
    probeId: `successor-${outcome}`,
    observerId: "repair-test",
    observedAt,
    outcome,
    target: { substrate: "hsr", runnerPid: SUCCESSOR_PID },
  };
}

function recoverySuccessReceipt(): BeeTransitionReceipt {
  return {
    eventId: `recovery-succeeded:${RECOVERY_ATTEMPT}`,
    type: "recovery.succeeded",
    cause: "revive-ok",
    at: RECOVERED_AT,
    evidence: [
      {
        kind: "recovery",
        attemptId: RECOVERY_ATTEMPT,
        observedAt: RECOVERED_AT,
        attempt: 1,
        budget: 10,
        outcome: "succeeded",
        detail: "replayed 0 pending turns",
      },
      successorProbe("alive"),
    ],
  };
}

function recoveredSuccessor(marker = true): SessionRecord {
  return {
    ...session(),
    status: "running",
    runnerPid: SUCCESSOR_PID,
    runnerFingerprint: SUCCESSOR_FINGERPRINT,
    runtimeGeneration: 4,
    lastPromptAt: "2026-08-16T05:44:27.952Z",
    updatedAt: RECOVERED_AT,
    lastObservedState: "working",
    lastObservedStateAt: RECOVERED_AT,
    ...(marker ? {
      stateUnverified: {
        since: "2026-08-16T13:43:30.868Z",
        reason: "observer-offline" as const,
        probeScheduledAt: "2026-08-16T13:43:30.868Z",
        observer: {
          observerId: "daemon:73606:2026-08-16T06:43:00.739Z",
          offlineSince: "2026-08-16T13:43:30.868Z",
          lastSeenAt: "2026-08-16T13:43:30.867Z",
          reason: "signal:SIGTERM",
        },
      },
    } : {}),
    stateMachine: {
      lifecycle: "active",
      runtime: "live",
      work: "working",
      revision: 2,
      transitionedAt: RECOVERED_AT,
      lastEventId: `recovery-succeeded:${RECOVERY_ATTEMPT}`,
      lastTransition: recoverySuccessReceipt(),
    },
  };
}

async function saveRecoveredSuccessor(marker = true): Promise<void> {
  const target = recoveredSuccessor(false);
  const initial = {
    ...target,
    runnerPid: 4242,
    runnerFingerprint: FINGERPRINT,
    runtimeGeneration: 3,
    updatedAt: LOST_AT,
    lastObservedState: "working",
    lastObservedStateAt: LOST_AT,
  };
  delete (initial as Partial<SessionRecord>).stateMachine;
  await saveSession(initial);
  const lostProbe: ProbeEvidence = {
    kind: "probe",
    probeId: LOST_PROBE_ID,
    observerId: "daemon:73606:2026-08-16T06:43:00.739Z",
    observedAt: LOST_AT,
    outcome: "dead",
    target: { substrate: "hsr", runnerPid: 4242 },
  };
  await transitionSession(BEE, {
    type: "runtime.lost",
    eventId: `runtime-lost:${LOST_PROBE_ID}`,
    at: LOST_AT,
    cause: "mid-turn-death",
    probe: lostProbe,
  });
  await updateSession(BEE, {
    runnerPid: SUCCESSOR_PID,
    runnerFingerprint: SUCCESSOR_FINGERPRINT,
    runtimeGeneration: 4,
    updatedAt: RECOVERED_AT,
  });
  const receipt = recoverySuccessReceipt();
  await transitionSession(BEE, {
    type: "recovery.succeeded",
    eventId: receipt.eventId,
    at: receipt.at,
    cause: "revive-ok",
    evidence: receipt.evidence[0] as Extract<typeof receipt.evidence[number], { kind: "recovery" }>,
    probe: receipt.evidence[1] as ProbeEvidence,
  });
  if (marker) await updateSession(BEE, { stateUnverified: target.stateUnverified });
}

function successorMeta(stopped: boolean): HsrMeta {
  return {
    bee: BEE,
    harness: "codex",
    tier: "server",
    sessionId: "thread-ce1a",
    hostPid: SUCCESSOR_PID,
    hostFingerprint: SUCCESSOR_FINGERPRINT,
    childPid: 22997,
    childPgid: 22997,
    childFingerprint: { pgid: 22997, startedAt: "Sun Aug 16 15:38:31 2026" },
    childAdmission: "admitted",
    startedAt: "2026-08-16T13:38:31.499Z",
    runningAt: "2026-08-16T13:38:31.700Z",
    controlSocket: "/tmp/successor.sock",
    status: stopped ? "exited" : "running",
    ...(stopped ? {
      exitCode: 0,
      endedAt: "2026-08-16T14:55:01.000Z",
      eventStreamClosure: { version: 1 as const, lastSeq: 1078, closedAt: "2026-08-16T14:55:01.000Z" },
    } : {}),
  };
}

function successorEvents(stopped: boolean): RunnerEvent[] {
  const host = {
    hostPid: SUCCESSOR_PID,
    startedAt: "2026-08-16T13:38:31.499Z",
    hostFingerprint: SUCCESSOR_FINGERPRINT,
  };
  return [
    { type: "host_epoch", ts: Date.parse(host.startedAt), seq: 1077, host },
    ...(stopped ? [{ type: "exit" as const, ts: Date.parse("2026-08-16T14:55:01.000Z"), seq: 1078, code: 0, host }] : []),
  ];
}

function recoveryRecord(overrides: Partial<RuntimeRecoveryRecord> = {}): RuntimeRecoveryRecord {
  return {
    version: 1,
    bee: BEE,
    episodeId: RECOVERY_EPISODE,
    generation: 3,
    detectedAt: "2026-08-16T13:38:15.670Z",
    probeId: LOST_PROBE_ID,
    status: "recovered",
    maxAttempts: 10,
    attempts: [{
      attemptId: RECOVERY_ATTEMPT,
      attempt: 1,
      scheduledDelayMs: 14_905,
      startedAt: "2026-08-16T13:38:31.106Z",
      leaseUntil: "2026-08-16T13:43:31.106Z",
      outcome: "succeeded",
      endedAt: "2026-08-16T13:38:31.714Z",
    }],
    updatedAt: "2026-08-16T13:38:31.714Z",
    ...overrides,
  };
}

function compatibilityLedger() {
  const correctionEventId = `lease-expiry-archive-correction:${RUN}:legacy-lease-archive:1076`;
  const correction = {
    kind: "repair" as const,
    repairId: correctionEventId,
    observedAt: CORRECTED_AT,
    action: "lease-expiry-archive-correction" as const,
    runId: RUN,
    sessionRef: BEE_ID,
    providerSessionId: "thread-ce1a",
    leaseExpiresAt: LEASE_AT,
    archivedEventId: "legacy-lease-archive",
    runtimeGeneration: 3,
    runnerPid: 4242,
    runnerFingerprint: FINGERPRINT,
    closureLastSeq: 1076,
    closureClosedAt: CLOSED_AT,
  };
  const lostProbe: ProbeEvidence = {
    kind: "probe",
    probeId: LOST_PROBE_ID,
    observerId: "daemon:73606:2026-08-16T06:43:00.739Z",
    observedAt: LOST_AT,
    outcome: "dead",
    target: { substrate: "hsr", runnerPid: 4242 },
  };
  return [
    {
      type: "state.transition.accepted",
      session: BEE,
      event: {
        eventId: "legacy-lease-archive",
        type: "bee.archived",
        cause: "retire",
        at: ARCHIVED_AT,
        evidence: [
          { kind: "operator", actionId: "legacy-lease-retire", observedAt: ARCHIVED_AT, action: "retire" },
          deadProbe("legacy-lease-retire-probe"),
        ],
      },
      from: { lifecycle: "active", runtime: "live", work: "working" },
      to: { lifecycle: "archived", runtime: "parked", work: "done" },
      revision: 5,
    },
    {
      type: "state.transition.accepted",
      session: BEE,
      event: {
        eventId: correctionEventId,
        type: "bee.archive-corrected",
        cause: "lease-expiry-offload-repair",
        at: CORRECTED_AT,
        evidence: [correction, { ...deadProbe("correction-probe", CORRECTED_AT), target: { substrate: "hsr", runnerPid: 4242 } }],
      },
      from: { lifecycle: "archived", runtime: "parked", work: "done" },
      to: { lifecycle: "active", runtime: "parked", work: "done" },
      revision: 6,
    },
    {
      type: "state.transition.accepted",
      session: BEE,
      event: {
        eventId: `runtime-lost:${LOST_PROBE_ID}`,
        type: "runtime.lost",
        cause: "mid-turn-death",
        at: LOST_AT,
        evidence: [lostProbe],
      },
      from: { lifecycle: "active", runtime: "live", work: "working" },
      to: { lifecycle: "active", runtime: "recovering", work: "working" },
      revision: 1,
    },
    {
      type: "runtime.recovery.attempt",
      session: BEE,
      episodeId: RECOVERY_EPISODE,
      attemptId: RECOVERY_ATTEMPT,
      attempt: 1,
      budget: 10,
      outcome: "started",
      ts: "2026-08-16T13:38:31.106Z",
    },
    {
      type: "state.verified",
      session: BEE,
      evidence: successorProbe("alive"),
    },
    {
      type: "state.transition.accepted",
      session: BEE,
      event: recoverySuccessReceipt(),
      from: { lifecycle: "active", runtime: "recovering", work: "working" },
      to: { lifecycle: "active", runtime: "live", work: "working" },
      revision: 2,
    },
  ];
}

function compatibilityDependencies(
  state: { stopped: boolean; pending?: boolean; stopFails?: boolean },
  overrides: LeaseArchiveRepairDependencies = {},
): LeaseArchiveRepairDependencies {
  return dependencies({
    readLedgerEvents: async () => compatibilityLedger(),
    readRecovery: async () => recoveryRecord(),
    readHsrMeta: async () => successorMeta(state.stopped),
    readCurrentEvents: async () => successorEvents(state.stopped),
    hasPendingTurns: async () => state.pending === true,
    readStagedTurns: async () => null,
    hasQueuedMessages: async () => false,
    isRuntimeLive: async () => !state.stopped,
    readProcessIdentity: async () => null,
    probeRuntime: async () => successorProbe(state.stopped ? "dead" : "alive", state.stopped ? "2026-08-16T14:55:01.000Z" : RECOVERED_AT),
    stopRuntime: async () => {
      if (state.stopFails) return { ok: false, stdout: "", stderr: "child group still live", exitCode: 1 };
      state.stopped = true;
      return { ok: true, stdout: "", stderr: "", exitCode: 0, incarnationStopped: true };
    },
    verifyEventClosure: async () => true,
    ...overrides,
  });
}

test("CO.ce1a-shaped lease archive is dry-run eligible, explicitly corrected, and idempotent without touching its working copy", async () => {
  await withTempStore(async () => {
    await archiveFixture();
    const dry = await repairLegacyLeaseExpiryArchive(BEE, RUN, { dependencies: dependencies() });
    assert.equal(dry.status, "eligible");
    assert.equal((await loadSession(BEE))!.status, "done", "inspection is read-only");

    const applied = await repairLegacyLeaseExpiryArchive(BEE, RUN, { apply: true, dependencies: dependencies() });
    assert.equal(applied.status, "repaired");
    const corrected = (await loadSession(BEE))!;
    assert.equal(corrected.status, "running");
    assert.deepEqual(
      {
        lifecycle: corrected.stateMachine?.lifecycle,
        runtime: corrected.stateMachine?.runtime,
        work: corrected.stateMachine?.work,
      },
      { lifecycle: "active", runtime: "parked", work: "done" },
    );
    assert.equal(corrected.providerSessionId, "thread-ce1a");
    assert.equal(corrected.cwd, "/tmp/intentionally-dirty-cell-working-copy", "working-copy contents/path are outside repair scope");
    assert.equal(corrected.lastObservedState, undefined, "stale archived observer vocabulary cannot leak into Apiary");
    assert.equal(corrected.lastObservedStateAt, undefined);

    const replay = await repairLegacyLeaseExpiryArchive(BEE, RUN, { apply: true, dependencies: dependencies() });
    assert.equal(replay.status, "already-repaired");
    assert.equal((await loadSession(BEE))!.stateMachine?.revision, corrected.stateMachine?.revision);
  });
});

test("old-daemon overwrite plus one zero-replay successor is strictly stopped and restored to active parked/done", async () => {
  await withTempStore(async () => {
    await saveRecoveredSuccessor();
    const state = { stopped: false };
    const deps = compatibilityDependencies(state);

    const dry = await repairLegacyLeaseExpiryArchive(BEE, RUN, { dependencies: deps });
    assert.equal(dry.status, "eligible");
    assert.equal(state.stopped, false, "dry-run never touches the live successor");

    const applied = await repairLegacyLeaseExpiryArchive(BEE, RUN, { apply: true, dependencies: deps });
    assert.equal(applied.status, "repaired");
    assert.equal(state.stopped, true, "apply strictly stops the exact no-work successor");
    const corrected = (await loadSession(BEE))!;
    assert.equal(corrected.status, "running");
    assert.deepEqual(
      {
        lifecycle: corrected.stateMachine?.lifecycle,
        runtime: corrected.stateMachine?.runtime,
        work: corrected.stateMachine?.work,
        type: corrected.stateMachine?.lastTransition.type,
      },
      {
        lifecycle: "active",
        runtime: "parked",
        work: "done",
        type: "bee.archive-correction-restored",
      },
    );
    assert.equal(corrected.runtimeReplacement, undefined);
    assert.equal(corrected.stateUnverified, undefined);
    assert.equal(corrected.lastError, undefined);
    assert.equal(corrected.providerSessionId, "thread-ce1a");

    const replay = await repairLegacyLeaseExpiryArchive(BEE, RUN, { apply: true, dependencies: deps });
    assert.equal(replay.status, "already-repaired");
    assert.equal((await loadSession(BEE))!.stateMachine?.revision, corrected.stateMachine?.revision);
  });
});

test("compatibility cleanup refuses newer work and leaves a crash-safe fence when strict stop is unconfirmed", async () => {
  await withTempStore(async () => {
    await saveRecoveredSuccessor();
    const state = { stopped: false, pending: false };
    const arrived = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      apply: true,
      dependencies: compatibilityDependencies(state, {
        afterStopFence: () => { state.pending = true; },
      }),
    });
    assert.deepEqual({ status: arrived.status, reason: arrived.status === "refused" ? arrived.reason : undefined }, {
      status: "refused",
      reason: "newer-user-work",
    });
    assert.equal(state.stopped, false, "a newly pending turn wins before stop");
    const unchanged = (await loadSession(BEE))!;
    assert.equal(unchanged.status, "running");
    assert.equal(unchanged.runtimeReplacement, undefined);
    assert.equal(unchanged.stateMachine?.work, "working");
  });

  await withTempStore(async () => {
    await saveRecoveredSuccessor();
    const state = { stopped: false, stopFails: true };
    const failed = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      apply: true,
      dependencies: compatibilityDependencies(state),
    });
    assert.deepEqual({ status: failed.status, reason: failed.status === "refused" ? failed.reason : undefined }, {
      status: "refused",
      reason: "runtime-stop-unconfirmed",
    });
    const fenced = (await loadSession(BEE))!;
    assert.equal(fenced.status, "kill_failed");
    assert.equal(fenced.runtimeReplacement?.state, "stop-failed");
    assert.match(fenced.lastError ?? "", /child group still live/);
    assert.equal(fenced.stateMachine?.runtime, "live", "failed stop cannot publish parked");
    assert.equal(fenced.stateMachine?.work, "working");
  });

  await withTempStore(async () => {
    await saveRecoveredSuccessor();
    const state = { stopped: false };
    const explicitIntent = {
      version: 1 as const,
      action: "retire" as const,
      generation: 4,
      requestedAt: "2026-08-16T14:55:00.500Z",
      attempts: 1,
    };
    const raced = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      apply: true,
      dependencies: compatibilityDependencies(state, {
        afterStopFence: async () => {
          await updateSession(BEE, { stopIntent: explicitIntent, lastError: "explicit retire won" });
        },
      }),
    });
    assert.deepEqual({ status: raced.status, reason: raced.status === "refused" ? raced.reason : undefined }, {
      status: "refused",
      reason: "newer-user-work",
    });
    assert.equal(state.stopped, false, "a stronger lifecycle fence wins before destructive stop");
    const winner = (await loadSession(BEE))!;
    assert.equal(winner.status, "kill_failed", "repair rollback cannot erase the winning fence");
    assert.deepEqual(winner.stopIntent, explicitIntent);
    assert.equal(winner.lastError, "explicit retire won");
    assert.equal(winner.runtimeReplacement?.state, "pending");
    assert.equal(
      isPendingSessionRuntimeReplacement(winner),
      false,
      "the stronger stop fence outranks retained replacement provenance",
    );
  });

  await withTempStore(async () => {
    await saveRecoveredSuccessor();
    const state = { stopped: false };
    const failedCas = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      apply: true,
      dependencies: compatibilityDependencies(state, {
        transition: async () => { throw new Error("injected post-stop CAS winner"); },
      }),
    });
    assert.deepEqual({ status: failedCas.status, reason: failedCas.status === "refused" ? failedCas.reason : undefined }, {
      status: "refused",
      reason: "archive-changed",
    });
    assert.equal(state.stopped, true);
    const fenced = (await loadSession(BEE))!;
    assert.equal(fenced.status, "kill_failed");
    assert.equal(fenced.runtimeReplacement?.state, "stop-failed");
    assert.match(fenced.lastError ?? "", /correction restore CAS failed/);
    assert.equal(fenced.stateMachine?.runtime, "live", "failed post-stop CAS never falsely publishes parked");
  });
});

test("compatibility cleanup accepts only the exact stopped-daemon marker and one succeeded zero-replay episode", async () => {
  await withTempStore(async () => {
    await saveRecoveredSuccessor(false);
    const invalidMarker = {
      since: "2026-08-16T13:43:30.868Z",
      reason: "stale-cursor" as const,
      probeScheduledAt: "2026-08-16T13:43:30.868Z",
    };
    await updateSession(BEE, { stateUnverified: invalidMarker });
    const refused = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      dependencies: compatibilityDependencies({ stopped: false }),
    });
    assert.deepEqual({ status: refused.status, reason: refused.status === "refused" ? refused.reason : undefined }, {
      status: "refused",
      reason: "unsafe-session-fence",
    });
  });

  await withTempStore(async () => {
    await saveRecoveredSuccessor();
    const secondAttempt = recoveryRecord({
      attempts: [
        ...recoveryRecord().attempts,
        {
          attemptId: "unexpected-second-attempt",
          attempt: 2,
          scheduledDelayMs: 60_000,
          startedAt: "2026-08-16T13:39:31.106Z",
          leaseUntil: "2026-08-16T13:44:31.106Z",
          outcome: "succeeded",
          endedAt: "2026-08-16T13:39:31.714Z",
        },
      ],
    });
    const refused = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      dependencies: compatibilityDependencies({ stopped: false }, { readRecovery: async () => secondAttempt }),
    });
    assert.deepEqual({ status: refused.status, reason: refused.status === "refused" ? refused.reason : undefined }, {
      status: "refused",
      reason: "recovery-proof-mismatch",
    });
  });
});

test("legacy correction refuses explicit execution lifecycle actions, mismatched binding, and unclean closure", async () => {
  await withTempStore(async () => {
    await archiveFixture();
    const explicit = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      dependencies: dependencies({ listOperations: async () => [operation("run.cancel")] }),
    });
    assert.deepEqual({ status: explicit.status, reason: explicit.status === "refused" ? explicit.reason : undefined }, {
      status: "refused",
      reason: "explicit-lifecycle-operation",
    });

    const mismatch = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      dependencies: dependencies({ readReservation: async () => reservation({ sessionRef: "CO.someone-else" }) }),
    });
    assert.deepEqual({ status: mismatch.status, reason: mismatch.status === "refused" ? mismatch.reason : undefined }, {
      status: "refused",
      reason: "run-binding-mismatch",
    });

    const unclean = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      dependencies: dependencies({ verifyEventClosure: async () => false }),
    });
    assert.deepEqual({ status: unclean.status, reason: unclean.status === "refused" ? unclean.reason : undefined }, {
      status: "refused",
      reason: "event-closure-unconfirmed",
    });
    assert.equal((await loadSession(BEE))!.stateMachine?.lifecycle, "archived");
  });
});

test("a later operator transition or concurrent identity/fence write wins over historical repair", async () => {
  await withTempStore(async () => {
    await archiveFixture();
    const laterReviveAt = "2026-08-16T09:45:10.000Z";
    await transitionSession(BEE, {
      type: "bee.revived",
      eventId: "later-operator-revive",
      at: laterReviveAt,
      cause: "revive",
      resume: "done",
      evidence: { kind: "operator", actionId: "later-operator-revive", observedAt: laterReviveAt, action: "revive" },
      probe: { ...deadProbe("later-revive-live", laterReviveAt), outcome: "alive" },
    });
    const laterArchiveAt = "2026-08-16T09:45:11.000Z";
    await transitionSession(BEE, {
      type: "bee.archived",
      eventId: "later-operator-archive",
      at: laterArchiveAt,
      cause: "retire",
      evidence: { kind: "operator", actionId: "later-operator-archive", observedAt: laterArchiveAt, action: "retire" },
      probe: deadProbe("later-operator-archive-probe", laterArchiveAt),
    });
    const later = await repairLegacyLeaseExpiryArchive(BEE, RUN, { apply: true, dependencies: dependencies() });
    assert.deepEqual({ status: later.status, reason: later.status === "refused" ? later.reason : undefined }, {
      status: "refused",
      reason: "execution-chronology-mismatch",
    });
  });

  await withTempStore(async () => {
    await archiveFixture();
    let explicitCancelWon = false;
    const raced = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      apply: true,
      dependencies: dependencies({
        listOperations: async () => explicitCancelWon ? [operation("run.cancel")] : [],
        beforeTransition: () => { explicitCancelWon = true; },
      }),
    });
    assert.deepEqual({ status: raced.status, reason: raced.status === "refused" ? raced.reason : undefined }, {
      status: "refused",
      reason: "explicit-lifecycle-operation",
    });
    assert.equal((await loadSession(BEE))!.stateMachine?.lifecycle, "archived");
  });

  await withTempStore(async () => {
    await archiveFixture();
    let releaseWon = false;
    const raced = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      apply: true,
      dependencies: dependencies({
        readReservation: async () => reservation(releaseWon ? { releasedAt: REPAIR_AT } : {}),
        beforeTransition: () => { releaseWon = true; },
      }),
    });
    assert.deepEqual({ status: raced.status, reason: raced.status === "refused" ? raced.reason : undefined }, {
      status: "refused",
      reason: "archive-changed",
    });
    assert.equal((await loadSession(BEE))!.stateMachine?.lifecycle, "archived");
  });

  await withTempStore(async () => {
    await archiveFixture();
    const raced = await repairLegacyLeaseExpiryArchive(BEE, RUN, {
      apply: true,
      dependencies: dependencies({
        beforeTransition: async () => {
          await updateSession(BEE, { executionRunId: "run-concurrent-replacement" });
        },
      }),
    });
    assert.deepEqual({ status: raced.status, reason: raced.status === "refused" ? raced.reason : undefined }, {
      status: "refused",
      reason: "archive-changed",
    });
    assert.equal((await loadSession(BEE))!.stateMachine?.lifecycle, "archived");
  });
});

test("execution repair CLI resolves a user-facing CO id to the canonical session name", async () => {
  await withTempStore(async () => {
    await archiveFixture();
    const parsed: Parsed = {
      command: "execution",
      args: ["repair-lease-archive", BEE_ID],
      flags: new Map([["run", RUN]]),
      rest: [],
    };
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await assert.rejects(cmdExecution(parsed), /run-missing/);
    } finally {
      console.log = original;
    }
    assert.ok(lines.some((line) => line.includes(`\t${BEE}\t${RUN}\trefused\trun-missing`)), lines.join("\n"));
  });
});
