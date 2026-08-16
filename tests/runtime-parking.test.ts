import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestMessageRecoveryIfParked } from "../src/buz/recovery.js";
import {
  reconcileObservedHsrWork,
  runRuntimeParkingSweep,
  selectRuntimeParkingCandidates,
} from "../src/daemon/runtimeParking.js";
import { parkExpiredExecutionSession } from "../src/execution/runtimeSettlement.js";
import type { HsrObservation } from "../src/hsr/observe.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import type { SessionLifecycleTransaction } from "../src/lifecycle.js";
import { parkIdleHsrRuntime } from "../src/recovery/park.js";
import {
  markLiveRuntimeSteered,
  wakeRuntimeForQueuedSend,
} from "../src/recovery/wake.js";
import type { BeeState } from "../src/state.js";
import {
  loadSession,
  markSessionUnverified,
  saveSession,
  transitionSession,
  updateSession,
  type SessionRecord,
} from "../src/store.js";
import { reduceBeeTransition, type ProbeEvidence } from "../src/stateMachine.js";

const T0 = Date.parse("2026-08-15T08:00:00.000Z");
const GRACE_MS = 60_000;

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-runtime-parking-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function record(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    runnerPid: 4242,
    providerSessionId: `thread-${name}`,
    runtimeGeneration: 1,
    createdAt: new Date(T0 - 10 * GRACE_MS).toISOString(),
    updatedAt: new Date(T0 - 2 * GRACE_MS).toISOString(),
    status: "running",
    lastObservedState: "idle_with_output",
    lastObservedStateAt: new Date(T0 - 2 * GRACE_MS).toISOString(),
    ...overrides,
  };
}

function probe(id: string, outcome: ProbeEvidence["outcome"], at = T0): ProbeEvidence {
  return {
    kind: "probe",
    probeId: id,
    observerId: "runtime-parking-test",
    observedAt: new Date(at).toISOString(),
    outcome,
    target: { substrate: "hsr", runnerPid: 4242 },
  };
}

function oldIdleObservation(state: BeeState = "idle_with_output"): HsrObservation {
  return {
    live: true,
    state,
    snapshot: "idle",
    activity: {
      at: T0 - 2 * GRACE_MS,
      fingerprint: `event:${state}`,
      eventType: state === "blocked" ? "needs_input" : "turn_end",
    },
  };
}

function structuredIdleObservation(record: SessionRecord, turnEndAt: number): HsrObservation {
  const turnEnd: RunnerEvent = {
    type: "turn_end",
    ts: turnEndAt,
    seq: 17,
    threadId: record.providerSessionId,
  };
  return {
    live: true,
    state: "idle_with_output",
    snapshot: "idle",
    activity: {
      at: turnEndAt,
      fingerprint: `turn_end:${turnEndAt}:fixture`,
      eventType: "turn_end",
    },
    eventSnapshot: {
      events: [turnEnd],
      tailEvents: [turnEnd],
      activity: {
        at: turnEndAt,
        fingerprint: `turn_end:${turnEndAt}:fixture`,
        eventType: "turn_end",
      },
      usage: { totals: null },
      pendingNeedsInput: null,
    },
  };
}

function successfulParkingDeps(live: { value: boolean }) {
  return {
    now: () => T0,
    makeParkingId: () => "parking-1",
    hasQueuedMessages: async () => false,
    probe: async () => probe(live.value ? "live-before" : "dead-after", live.value ? "alive" : "dead"),
    stop: async () => { live.value = false; },
  };
}

test("intentional idle offload keeps lifecycle active/status running and carries two-sided evidence", async () => {
  await withTempStore(async () => {
    const initial = record("CO.intentional");
    await saveSession(initial);
    const live = { value: true };
    const result = await parkIdleHsrRuntime(initial, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(),
      graceMs: GRACE_MS,
      work: "done",
    }, successfulParkingDeps(live));

    assert.equal(result.action, "parked");
    assert.equal(result.record.status, "running");
    assert.equal(result.record.stateMachine?.lifecycle, "active");
    assert.equal(result.record.stateMachine?.runtime, "parked");
    assert.equal(result.record.stateMachine?.work, "done");
    assert.equal(result.record.stateMachine?.lastTransition.cause, "intentional-idle-offload");
    assert.deepEqual(
      result.record.stateMachine?.lastTransition.evidence.map((item) => item.kind),
      ["parking", "probe", "probe"],
    );
    assert.equal(result.record.stateMachine?.lastTransition.evidence[1]?.kind, "probe");
    assert.equal((result.record.stateMachine?.lastTransition.evidence[1] as ProbeEvidence).outcome, "alive");
    assert.equal((result.record.stateMachine?.lastTransition.evidence[2] as ProbeEvidence).outcome, "dead");
  });
});

test("intentional parking evidence is fenced to the current work axis", () => {
  assert.throws(() => reduceBeeTransition(
    { lifecycle: "active", runtime: "live", work: "done" },
    {
      type: "runtime.parked",
      eventId: "park-wrong-work",
      at: new Date(T0).toISOString(),
      cause: "intentional-idle-offload",
      evidence: {
        kind: "parking",
        parkingId: "parking-wrong-work",
        observedAt: new Date(T0).toISOString(),
        policy: "idle-grace",
        idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(),
        graceMs: GRACE_MS,
        runtimeGeneration: 1,
        work: "needs-you",
      },
      liveProbe: probe("live-before", "alive"),
      probe: probe("dead-after", "dead"),
    },
  ), /illegal runtime\.parked transition/);
});

test("trusted HSR turn_end settles a stale working cursor before idle parking", async () => {
  await withTempStore(async () => {
    const initial = record("CO.observed-settle", {
      lastObservedState: "active",
      lastPromptAt: new Date(T0 - 4 * GRACE_MS).toISOString(),
    });
    await saveSession(initial);
    const observation = structuredIdleObservation(initial, T0 - 2 * GRACE_MS);
    const live = { value: true };

    const result = await runRuntimeParkingSweep(
      [initial],
      new Map([[initial.name, "idle_with_output"]]),
      new Map([[initial.name, observation]]),
      T0,
      { graceMs: GRACE_MS, ...successfulParkingDeps(live) },
    );

    assert.equal(result[0]?.action, "parked");
    const parked = (await loadSession(initial.name))!;
    assert.equal(parked.status, "running");
    assert.equal(parked.stateMachine?.lifecycle, "active");
    assert.equal(parked.stateMachine?.runtime, "parked");
    assert.equal(parked.stateMachine?.work, "done");
    assert.equal(parked.stateMachine?.revision, 2, "turn_end settle and parking are separate audited edges");
  });
});

test("an old turn_end cannot settle or park a newer accepted prompt", async () => {
  await withTempStore(async () => {
    const initial = record("CO.observed-stale", {
      lastObservedState: "active",
      lastPromptAt: new Date(T0 - GRACE_MS).toISOString(),
    });
    await saveSession(initial);
    const observation = structuredIdleObservation(initial, T0 - 2 * GRACE_MS);
    const reconciled = await reconcileObservedHsrWork(
      initial,
      "idle_with_output",
      observation,
      T0,
    );
    assert.equal(reconciled.changed, false);
    assert.equal(reconciled.reason, "turn-end-predates-current-work");
    assert.equal((await loadSession(initial.name))!.stateMachine, undefined);
  });
});

test("a same-millisecond turn_end cannot prove it followed the current prompt", async () => {
  await withTempStore(async () => {
    const boundary = T0 - GRACE_MS;
    const initial = record("CO.observed-same-ms", {
      lastObservedState: "active",
      lastPromptAt: new Date(boundary).toISOString(),
    });
    await saveSession(initial);
    const reconciled = await reconcileObservedHsrWork(
      initial,
      "idle_with_output",
      structuredIdleObservation(initial, boundary),
      T0,
    );
    assert.equal(reconciled.changed, false);
    assert.equal(reconciled.reason, "turn-end-predates-current-work");
    assert.equal((await loadSession(initial.name))!.stateMachine, undefined);
  });
});

test("execution lease expiry parks an exact settled runtime but leaves the Bee active", async () => {
  await withTempStore(async () => {
    const initial = record("CO.execution-lease", {
      id: "BEE.execution-lease",
      executionRunId: "run-execution-lease",
      lastObservedState: "idle_with_output",
      lastPromptAt: new Date(T0 - 4 * GRACE_MS).toISOString(),
    });
    await saveSession(initial);
    const live = { value: true };
    const parked = await parkExpiredExecutionSession(
      {
        runId: "run-execution-lease",
        beeName: initial.name,
        sessionRef: initial.id,
      },
      new Date(T0 - 3 * GRACE_MS).toISOString(),
      "test lease expiry",
      {
        now: () => T0,
        parkDeps: successfulParkingDeps(live),
      },
    );
    assert.equal(parked.status, "parked");
    const recordAfter = (await loadSession(initial.name))!;
    assert.equal(recordAfter.status, "running");
    assert.equal(recordAfter.stateMachine?.lifecycle, "active");
    assert.equal(recordAfter.stateMachine?.runtime, "parked");
    assert.equal(recordAfter.stateMachine?.work, "done");
  });
});

test("an already-parked execution is terminal proof only when every resumability fence still matches", async () => {
  await withTempStore(async () => {
    const owner = (name: string) => ({ runId: `run-${name}`, beeName: name, sessionRef: `BEE.${name}` });
    const parkDone = async (name: string, overrides: Partial<SessionRecord> = {}) => {
      const initial = record(name, {
        id: `BEE.${name}`,
        executionRunId: `run-${name}`,
        lastObservedState: "idle_with_output",
        ...overrides,
      });
      await saveSession(initial);
      await transitionSession(name, {
        type: "runtime.parked",
        eventId: `park-${name}`,
        at: new Date(T0 - GRACE_MS).toISOString(),
        cause: "idle-death",
        probe: probe(`park-${name}`, "dead", T0 - GRACE_MS),
      });
      return (await loadSession(name))!;
    };

    const uncertain = await parkDone("CO.parked-unverified");
    await markSessionUnverified(uncertain.name, {
      since: new Date(T0).toISOString(),
      reason: "stale-cursor",
      probeScheduledAt: new Date(T0).toISOString(),
    });
    assert.equal((await parkExpiredExecutionSession(
      owner(uncertain.name),
      new Date(T0 - 2 * GRACE_MS).toISOString(),
      "unverified parked control",
      { now: () => T0 },
    )).status, "unconfirmed");

    const nonHsr = await parkDone("CO.parked-non-hsr");
    await updateSession(nonHsr.name, { substrate: undefined });
    assert.equal((await parkExpiredExecutionSession(
      owner(nonHsr.name),
      new Date(T0 - 2 * GRACE_MS).toISOString(),
      "non-HSR parked control",
      { now: () => T0 },
    )).status, "unconfirmed");

    const noProvider = await parkDone("CO.parked-no-provider");
    await updateSession(noProvider.name, { providerSessionId: undefined });
    assert.equal((await parkExpiredExecutionSession(
      owner(noProvider.name),
      new Date(T0 - 2 * GRACE_MS).toISOString(),
      "missing provider parked control",
      { now: () => T0 },
    )).status, "unconfirmed");

    const needsYou = record("CO.parked-needs-you", {
      id: "BEE.CO.parked-needs-you",
      executionRunId: "run-CO.parked-needs-you",
      lastObservedState: undefined,
      lastObservedStateAt: undefined,
    });
    await saveSession(needsYou);
    await transitionSession(needsYou.name, {
      type: "turn.started",
      eventId: "parked-needs-you-start",
      at: new Date(T0 - 3 * GRACE_MS).toISOString(),
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "parked-needs-you-start", observedAt: new Date(T0 - 3 * GRACE_MS).toISOString(), hook: "turn-start" },
    });
    await transitionSession(needsYou.name, {
      type: "request.opened",
      eventId: "parked-needs-you-request",
      at: new Date(T0 - 2 * GRACE_MS).toISOString(),
      cause: "question",
      requestId: "parked-needs-you-request",
      evidence: { kind: "request", requestId: "parked-needs-you-request", observedAt: new Date(T0 - 2 * GRACE_MS).toISOString(), action: "opened" },
    });
    await transitionSession(needsYou.name, {
      type: "runtime.parked",
      eventId: "parked-needs-you-dead",
      at: new Date(T0 - GRACE_MS).toISOString(),
      cause: "idle-death",
      probe: probe("parked-needs-you-dead", "dead", T0 - GRACE_MS),
    });
    assert.equal((await parkExpiredExecutionSession(
      owner(needsYou.name),
      new Date(T0 - 4 * GRACE_MS).toISOString(),
      "needs-you parked control",
      { now: () => T0 },
    )).status, "deferred");
  });
});

test("a concurrent uncertainty write after physical parking invalidates lease terminal proof", async () => {
  await withTempStore(async () => {
    const initial = record("CO.execution-park-race", {
      id: "BEE.execution-park-race",
      executionRunId: "run-execution-park-race",
      lastObservedState: "idle_with_output",
    });
    await saveSession(initial);
    const live = { value: true };
    const result = await parkExpiredExecutionSession(
      {
        runId: "run-execution-park-race",
        beeName: initial.name,
        sessionRef: initial.id,
      },
      new Date(T0 - 2 * GRACE_MS).toISOString(),
      "post-park uncertainty race",
      {
        now: () => T0,
        parkDeps: successfulParkingDeps(live),
        park: async (record, intent, deps) => {
          const parked = await parkIdleHsrRuntime(record, intent, deps);
          await markSessionUnverified(record.name, {
            since: new Date(T0).toISOString(),
            reason: "stale-cursor",
            probeScheduledAt: new Date(T0).toISOString(),
          });
          return parked;
        },
      },
    );
    assert.equal(result.status, "unconfirmed");
    assert.equal((await loadSession(initial.name))!.stateMachine?.runtime, "parked");
    assert.ok((await loadSession(initial.name))!.stateUnverified);
  });
});

test("needs-you runtimes stay live because interactive answer handles are process-local", async () => {
  await withTempStore(async () => {
    const initial = record("CO.needs-you", {
      lastObservedState: undefined,
      lastObservedStateAt: undefined,
    });
    await saveSession(initial);
    await transitionSession(initial.name, {
      type: "turn.started",
      eventId: "turn-start",
      at: new Date(T0 - 3 * GRACE_MS).toISOString(),
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "turn-start", observedAt: new Date(T0 - 3 * GRACE_MS).toISOString(), hook: "turn-start" },
    });
    await transitionSession(initial.name, {
      type: "request.opened",
      eventId: "question-open",
      at: new Date(T0 - 2 * GRACE_MS).toISOString(),
      cause: "question",
      requestId: "question-1",
      evidence: { kind: "request", requestId: "question-1", observedAt: new Date(T0 - 2 * GRACE_MS).toISOString(), action: "opened" },
    });
    await updateSession(initial.name, {
      lastObservedState: "blocked",
      lastObservedStateAt: new Date(T0 - 2 * GRACE_MS).toISOString(),
    });
    const waiting = (await loadSession(initial.name))!;
    let stops = 0;
    const result = await parkIdleHsrRuntime(waiting, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(),
      graceMs: GRACE_MS,
      work: "needs-you",
    }, {
      now: () => T0,
      hasQueuedMessages: async () => false,
      stop: async () => { stops += 1; },
    });
    assert.equal(result.action, "skipped");
    assert.equal(result.reason, "interactive-request-open");
    assert.equal(stops, 0);
    assert.equal(result.record.stateMachine?.runtime, "live");
    assert.equal(result.record.stateMachine?.work, "needs-you");
  });
});

test("working, spawning, archived, non-HSR, queued, and unverified runtimes are not parked", async () => {
  await withTempStore(async () => {
    const cases: Array<{ rec: SessionRecord; intent: "done" | "needs-you"; reason: string }> = [
      { rec: record("CO.working", { lastObservedState: "active", lastPromptAt: new Date(T0 - GRACE_MS).toISOString() }), intent: "done", reason: "work-changed" },
      { rec: record("CO.spawning", { lastObservedState: undefined, lastObservedStateAt: undefined }), intent: "done", reason: "work-changed" },
      { rec: record("CO.tmux", { substrate: "local-tmux" }), intent: "done", reason: "not-local-hsr" },
      { rec: record("CO.unverified", { stateUnverified: { since: new Date(T0 - GRACE_MS).toISOString(), reason: "stale-cursor", probeScheduledAt: new Date(T0).toISOString() } }), intent: "done", reason: "runtime-unverified" },
    ];
    let stops = 0;
    for (const entry of cases) {
      await saveSession(entry.rec);
      const result = await parkIdleHsrRuntime(entry.rec, {
        idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(),
        graceMs: GRACE_MS,
        work: entry.intent,
      }, {
        now: () => T0,
        hasQueuedMessages: async () => false,
        stop: async () => { stops += 1; },
      });
      assert.equal(result.action, "skipped");
      assert.equal(result.reason, entry.reason);
    }

    const archivedBase = record("CO.archived");
    await saveSession(archivedBase);
    await transitionSession(archivedBase.name, {
      type: "bee.archived",
      eventId: "archive",
      at: new Date(T0).toISOString(),
      cause: "retire",
      evidence: { kind: "operator", actionId: "archive", observedAt: new Date(T0).toISOString(), action: "retire" },
      probe: probe("archive-dead", "dead"),
    });
    const archived = (await loadSession(archivedBase.name))!;
    const archivedResult = await parkIdleHsrRuntime(archived, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(),
      graceMs: GRACE_MS,
      work: "done",
    }, { now: () => T0, stop: async () => { stops += 1; } });
    assert.equal(archivedResult.reason, "inactive-lifecycle");

    const queued = record("CO.queued");
    await saveSession(queued);
    const queuedResult = await parkIdleHsrRuntime(queued, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(), graceMs: GRACE_MS, work: "done",
    }, {
      now: () => T0,
      hasQueuedMessages: async () => true,
      stop: async () => { stops += 1; },
    });
    assert.equal(queuedResult.reason, "queued-send");
    assert.equal(stops, 0);
  });
});

test("failed stop or post-stop dead probe never records parked intent", async () => {
  await withTempStore(async () => {
    const stopFailure = record("CO.stop-failure");
    await saveSession(stopFailure);
    await assert.rejects(parkIdleHsrRuntime(stopFailure, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(), graceMs: GRACE_MS, work: "done",
    }, {
      now: () => T0,
      hasQueuedMessages: async () => false,
      probe: async () => probe("alive", "alive"),
      stop: async () => { throw new Error("exact cleanup unconfirmed"); },
    }), /exact cleanup unconfirmed/);
    assert.equal((await loadSession(stopFailure.name))?.stateMachine, undefined);

    const probeFailure = record("CO.probe-failure");
    await saveSession(probeFailure);
    let probes = 0;
    await assert.rejects(parkIdleHsrRuntime(probeFailure, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(), graceMs: GRACE_MS, work: "done",
    }, {
      now: () => T0,
      hasQueuedMessages: async () => false,
      probe: async () => probes++ === 0 ? probe("alive", "alive") : probe("uncertain", "unreachable"),
      stop: async () => undefined,
    }), /post-stop probe returned unreachable/);
    assert.equal((await loadSession(probeFailure.name))?.stateMachine, undefined);
  });
});

test("send winning the lifecycle race cancels parking before any stop", async () => {
  await withTempStore(async () => {
    const initial = record("CO.send-wins");
    await saveSession(initial);
    const steered = await markLiveRuntimeSteered(initial, { isLive: async () => true, now: () => T0 });
    assert.equal(steered.stateMachine?.work, "working");
    let stops = 0;
    const result = await parkIdleHsrRuntime(initial, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(), graceMs: GRACE_MS, work: "done",
    }, {
      now: () => T0,
      hasQueuedMessages: async () => false,
      stop: async () => { stops += 1; },
    });
    assert.equal(result.action, "skipped");
    assert.equal(result.reason, "work-changed");
    assert.equal(stops, 0);
  });
});

test("parking winning the lifecycle race makes a waiting direct send wake exactly one replacement", async () => {
  await withTempStore(async () => {
    const initial = record("CO.park-wins");
    await saveSession(initial);
    let live = true;
    let releaseStop!: () => void;
    let stopStarted!: () => void;
    const started = new Promise<void>((resolve) => { stopStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseStop = resolve; });
    const parking = parkIdleHsrRuntime(initial, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(), graceMs: GRACE_MS, work: "done",
    }, {
      now: () => T0,
      makeParkingId: () => "race-park",
      hasQueuedMessages: async () => false,
      probe: async () => probe(live ? "live" : "dead", live ? "alive" : "dead"),
      stop: async () => {
        stopStarted();
        await release;
        live = false;
      },
    });
    await started;

    let launches = 0;
    const sending = markLiveRuntimeSteered(initial, {
      isLive: async () => live,
      probe: async () => probe(live ? "replacement-live" : "parked-dead", live ? "alive" : "dead", T0 + 1_000),
      markVerified: async () => loadSession(initial.name),
      assertCwd: async () => undefined,
      reviveInTransaction: async (lifecycle) => {
        launches += 1;
        const current = await lifecycle.refresh();
        const revived = await lifecycle.commit({ runtimeGeneration: (current.runtimeGeneration ?? 0) + 1 });
        live = true;
        return revived;
      },
      now: () => T0 + 1_000,
    });
    releaseStop();
    const [parked, steered] = await Promise.all([parking, sending]);
    assert.equal(parked.action, "parked");
    assert.equal(launches, 1);
    assert.equal(steered.runtimeGeneration, 2);
    assert.equal(steered.stateMachine?.runtime, "live");
    assert.equal(steered.stateMachine?.work, "working");
  });
});

test("concurrent queued wakes launch one replacement and publish one steer edge", async () => {
  await withTempStore(async () => {
    const initial = record("CO.queued-wakes");
    await saveSession(initial);
    const live = { value: true };
    const parked = await parkIdleHsrRuntime(initial, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(), graceMs: GRACE_MS, work: "done",
    }, successfulParkingDeps(live));
    let launches = 0;
    const deps = {
      isLive: async () => live.value,
      probe: async () => probe(live.value ? "replacement-live" : "parked-dead", live.value ? "alive" : "dead", T0 + 1_000),
      markVerified: async () => loadSession(initial.name),
      assertCwd: async () => undefined,
      reviveInTransaction: async (lifecycle: SessionLifecycleTransaction) => {
        launches += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const current = await lifecycle.refresh();
        const revived = await lifecycle.commit({ runtimeGeneration: (current.runtimeGeneration ?? 0) + 1 });
        live.value = true;
        return revived;
      },
      now: () => T0 + 1_000,
    };
    const wakes = await Promise.all([
      wakeRuntimeForQueuedSend(parked.record, deps),
      wakeRuntimeForQueuedSend(parked.record, deps),
    ]);
    assert.equal(launches, 1);
    assert.deepEqual(new Set(wakes.map((item) => item.runtimeGeneration)), new Set([2]));
    const final = (await loadSession(initial.name))!;
    assert.equal(final.stateMachine?.work, "working");
    assert.equal(final.stateMachine?.revision, 3, "parking, exact revival, and the one steer edge are all durable");
  });
});

test("derived scheduler honors grace/eligibility and restart re-runs are idempotent", async () => {
  await withTempStore(async () => {
    const eligible = record("CO.scheduler");
    const recent = record("CO.recent");
    const working = record("CO.scheduler-working", { lastObservedState: "active", lastPromptAt: new Date(T0).toISOString() });
    const archived = record("CO.scheduler-archived", { status: "done" });
    const taskSupplied = record("CO.task-supplied", { taskSupply: { on: true } });
    const needsYou = record("CO.needs-you-scheduler", {
      lastObservedState: undefined,
      lastObservedStateAt: undefined,
    });
    await saveSession(needsYou);
    await transitionSession(needsYou.name, {
      type: "turn.started",
      eventId: "needs-you-turn-start",
      at: new Date(T0 - 3 * GRACE_MS).toISOString(),
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "needs-you-turn-start", observedAt: new Date(T0 - 3 * GRACE_MS).toISOString(), hook: "turn-start" },
    });
    await transitionSession(needsYou.name, {
      type: "request.opened",
      eventId: "needs-you-request",
      at: new Date(T0 - 2 * GRACE_MS).toISOString(),
      cause: "question",
      requestId: "needs-you-request",
      evidence: { kind: "request", requestId: "needs-you-request", observedAt: new Date(T0 - 2 * GRACE_MS).toISOString(), action: "opened" },
    });
    const waitingNeedsYou = (await loadSession(needsYou.name))!;
    const records = [eligible, recent, working, archived, taskSupplied, waitingNeedsYou];
    const states = new Map<string, BeeState>([
      [eligible.name, "idle_with_output"],
      [recent.name, "idle_with_output"],
      [working.name, "active"],
      [archived.name, "done"],
      [taskSupplied.name, "idle_with_output"],
      [needsYou.name, "blocked"],
    ]);
    const observations = new Map<string, HsrObservation>([
      [eligible.name, oldIdleObservation()],
      [recent.name, { ...oldIdleObservation(), activity: { at: T0 - 1_000, fingerprint: "event:recent", eventType: "turn_end" } }],
      [working.name, oldIdleObservation("active")],
      [archived.name, oldIdleObservation("done")],
      [taskSupplied.name, oldIdleObservation()],
      [needsYou.name, oldIdleObservation("blocked")],
    ]);
    assert.deepEqual(
      selectRuntimeParkingCandidates(records, states, observations, T0, GRACE_MS).map(({ record: item }) => item.name),
      [eligible.name],
    );

    await saveSession(eligible);
    const live = { value: true };
    const first = await runRuntimeParkingSweep([eligible], states, observations, T0, {
      graceMs: GRACE_MS,
      ...successfulParkingDeps(live),
    });
    assert.equal(first[0]?.action, "parked");
    const latest = (await loadSession(eligible.name))!;
    const afterRestart = await runRuntimeParkingSweep([latest], states, observations, T0 + GRACE_MS, {
      graceMs: GRACE_MS,
      ...successfulParkingDeps(live),
    });
    assert.deepEqual(afterRestart, []);
  });
});

test("a queue send after parking records one durable wake obligation", async () => {
  await withTempStore(async () => {
    const initial = record("CO.queue-marker");
    await saveSession(initial);
    const live = { value: true };
    const parked = await parkIdleHsrRuntime(initial, {
      idleSince: new Date(T0 - 2 * GRACE_MS).toISOString(), graceMs: GRACE_MS, work: "done",
    }, successfulParkingDeps(live));
    assert.equal(await requestMessageRecoveryIfParked(parked.record, "message-1", () => T0 + 1_000), true);
    assert.equal(await requestMessageRecoveryIfParked(parked.record, "message-2", () => T0 + 2_000), true);
    const marked = (await loadSession(initial.name))!;
    assert.equal(marked.recoveryMessageId, "message-1");
    assert.equal(marked.recoveryAttemptCount, 0);
  });
});
