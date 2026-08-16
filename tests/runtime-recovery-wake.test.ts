import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeManualRuntimeRevive } from "../src/recovery/manual.js";
import { probeRecoverableRuntime } from "../src/recovery/runtimeProbe.js";
import {
  ensureLiveRuntimeForSend,
  markLiveRuntimeSteered,
} from "../src/recovery/wake.js";
import { openRequest, readBeeRequests } from "../src/requests/store.js";
import {
  loadSession,
  saveSession,
  transitionSession,
  updateSession,
  type SessionRecord,
} from "../src/store.js";
import type { ProbeEvidence, RecoveryEvidence } from "../src/stateMachine.js";
import type { RuntimeRecoveryRecord } from "../src/recovery/store.js";
import { withSessionLifecycleTransaction, type SessionLifecycleTransaction } from "../src/lifecycle.js";
import type { RemoteHsrSubstrate, RemoteLaunchHead } from "../src/substrates/remote-hsr.js";

const T0 = Date.parse("2026-08-11T20:00:00.000Z");

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-runtime-wake-"));
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
    providerSessionId: `thread-${name}`,
    runtimeGeneration: 1,
    createdAt: new Date(T0 - 60_000).toISOString(),
    updatedAt: new Date(T0 - 30_000).toISOString(),
    status: "running",
    ...overrides,
  };
}

function probe(id: string, outcome: ProbeEvidence["outcome"]): ProbeEvidence {
  return {
    kind: "probe",
    probeId: id,
    observerId: "wake-test",
    observedAt: new Date(T0).toISOString(),
    outcome,
    target: { substrate: "hsr", runnerPid: 4242 },
  };
}

function remoteProbe(id: string, outcome: ProbeEvidence["outcome"], source: SessionRecord): ProbeEvidence {
  return {
    kind: "probe",
    probeId: id,
    observerId: "remote-wake-test",
    observedAt: new Date(T0).toISOString(),
    outcome,
    target: {
      substrate: "remote-hsr",
      node: source.node,
      remoteLaunchId: source.remoteLaunchId,
      remoteIncarnation: source.remoteIncarnation,
    },
  };
}

test("concurrent direct sends lazily respawn one parked runner and serialize the steer edge", async () => {
  await withTempStore(async () => {
    const initial = record("CO.parked", {
      lastObservedState: "idle_with_output",
      lastObservedStateAt: new Date(T0 - 1_000).toISOString(),
    });
    await saveSession(initial);
    await transitionSession(initial.name, {
      type: "runtime.parked",
      eventId: "parked-before-send",
      at: new Date(T0).toISOString(),
      cause: "idle-death",
      probe: probe("idle-death", "dead"),
    });
    const parked = (await loadSession(initial.name))!;

    let live = false;
    let launches = 0;
    const deps = {
      isLive: async () => live,
      probe: async () => probe(live ? "replacement-alive" : "still-dead", live ? "alive" : "dead"),
      markVerified: async (_name: string, _evidence: ProbeEvidence) => parked,
      assertCwd: async () => undefined,
      reviveInTransaction: async (lifecycle: SessionLifecycleTransaction) => {
        launches += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const current = await lifecycle.refresh();
        const revived = await lifecycle.commit({
          runtimeGeneration: (current.runtimeGeneration ?? 0) + 1,
          status: "running" as const,
        });
        live = true;
        return revived;
      },
    };

    const wakes = await Promise.all([
      ensureLiveRuntimeForSend(parked, deps),
      ensureLiveRuntimeForSend(parked, deps),
    ]);
    assert.equal(launches, 1);
    assert.equal(wakes.filter((wake) => wake.woke).length, 1);
    assert.deepEqual(new Set(wakes.map((wake) => wake.record.runtimeGeneration)), new Set([2]));

    await Promise.all(wakes.map((wake) => markLiveRuntimeSteered(wake.record)));
    const steered = (await loadSession(initial.name))!;
    assert.equal(steered.stateMachine?.runtime, "live");
    assert.equal(steered.stateMachine?.work, "working");
    assert.equal(steered.stateMachine?.revision, 3, "parked→revived and done→working are separate durable edges");
  });
});

test("remote recovery probe rejects a live same-name successor and proves only exact tokens", async () => {
  const canonical = record("CO.remote-proof", {
    substrate: undefined,
    node: "remote-node",
    remoteLaunchId: "launch-a",
    remoteIncarnation: "incarnation-a",
  });
  let head = {
    state: "running" as const,
    launchId: "launch-a",
    incarnation: "incarnation-a",
  };
  let eventReads = 0;
  const remote = {
    kind: "remote-hsr",
    launchHeadRemote: async () => head,
    hasSession: async () => true,
    eventsTail: async (_bee: string, _after: number | undefined, locator: { remoteLaunchId?: string; remoteIncarnation?: string }) => {
      eventReads += 1;
      assert.deepEqual(locator, { remoteLaunchId: "launch-a", remoteIncarnation: "incarnation-a" });
      return [];
    },
  } as unknown as RemoteHsrSubstrate;
  const resolveSubstrate = () => remote;

  assert.equal((await probeRecoverableRuntime(canonical, "test", { resolveSubstrate })).outcome, "alive");
  assert.equal(eventReads, 1);

  head = { state: "running", launchId: "launch-b", incarnation: "incarnation-b" };
  const stale = await probeRecoverableRuntime(canonical, "test", { resolveSubstrate });
  assert.equal(stale.outcome, "unreachable");
  assert.match(stale.detail ?? "", /no longer own/);
  assert.equal(eventReads, 1, "mismatched head is rejected before reading successor events");
});

test("cold remote wake replaces an exact stopped head and publishes parked→live", async () => {
  await withTempStore(async () => {
    const initial = record("CO.remote-parked", {
      substrate: undefined,
      node: "remote-node",
      remoteLaunchId: "launch-a",
      remoteIncarnation: "incarnation-a",
      lastObservedState: "idle_with_output",
    });
    await saveSession(initial);
    await transitionSession(initial.name, {
      type: "runtime.parked",
      eventId: "remote-parked",
      at: new Date(T0).toISOString(),
      cause: "idle-death",
      probe: remoteProbe("remote-dead", "dead", initial),
    });
    const parked = (await loadSession(initial.name))!;
    let head: RemoteLaunchHead = {
      state: "stopped",
      launchId: "launch-a",
      incarnation: "incarnation-a",
    };
    let live = false;
    const remote = {
      kind: "remote-hsr",
      launchHeadRemote: async () => head,
      hasSession: async () => live,
      eventsTail: async () => [],
    } as unknown as RemoteHsrSubstrate;
    let launches = 0;

    const woke = await ensureLiveRuntimeForSend(parked, {
      resolveSubstrate: () => remote,
      reviveInTransaction: async (lifecycle) => {
        launches += 1;
        const current = await lifecycle.refresh();
        const revived = await lifecycle.commit({
          runtimeGeneration: (current.runtimeGeneration ?? 0) + 1,
          remoteLaunchId: "launch-b",
          remoteIncarnation: "incarnation-b",
          status: "running",
        });
        head = { state: "running", launchId: "launch-b", incarnation: "incarnation-b" };
        live = true;
        return revived;
      },
    });

    assert.equal(launches, 1);
    assert.equal(woke.woke, true);
    assert.equal(woke.record.remoteLaunchId, "launch-b");
    assert.equal(woke.record.stateMachine?.runtime, "live");
    assert.equal(woke.record.stateMachine?.work, "done");
  });
});

test("direct send cannot admit work through canonical-active failed-stop doubt", async () => {
  await withTempStore(async () => {
    const initial = record("CO.stop-doubt");
    await saveSession(initial);
    await transitionSession(initial.name, {
      type: "turn.started",
      eventId: "stop-doubt-turn",
      at: new Date(T0).toISOString(),
      cause: "first-turn",
      evidence: {
        kind: "hook",
        hookId: "stop-doubt-turn",
        observedAt: new Date(T0).toISOString(),
        hook: "turn-start",
      },
    });
    await updateSession(initial.name, { status: "kill_failed", lastError: "exact stop unconfirmed" });
    const stopDoubt = (await loadSession(initial.name))!;
    let livenessProbes = 0;

    await assert.rejects(
      ensureLiveRuntimeForSend(stopDoubt, {
        isLive: async () => {
          livenessProbes += 1;
          return true;
        },
      }),
      /unresolved stop state/,
    );
    assert.equal(livenessProbes, 0, "existence proof cannot override explicit stop intent");
  });
});

test("manual revive resolves the one recovery-failed request and resets its durable budget", async () => {
  await withTempStore(async () => {
    const initial = record("CO.manual", { lastPrompt: "finish this", lastPromptAt: new Date(T0 - 5_000).toISOString() });
    await saveSession(initial);
    const death = probe("death-proof", "dead");
    await transitionSession(initial.name, {
      type: "runtime.lost",
      eventId: "lost",
      at: new Date(T0).toISOString(),
      cause: "mid-turn-death",
      probe: death,
    });
    const requestId = "recovery-failed:CO.manual:episode";
    await openRequest(initial.name, {
      id: requestId,
      kind: "manual-action",
      scope: "bee",
      generation: 1,
      openedAt: new Date(T0 + 1_000).toISOString(),
      question: "repair runtime",
      input: { attempts: [{ attempt: 1, outcome: "failed" }] },
      evidence: { grade: "structured", source: "runtime-recovery-supervisor" },
    });
    const failedEvidence: RecoveryEvidence = {
      kind: "recovery",
      attemptId: "attempt-10",
      observedAt: new Date(T0 + 1_000).toISOString(),
      attempt: 10,
      budget: 10,
      outcome: "failed",
    };
    await transitionSession(initial.name, {
      type: "recovery.failed",
      eventId: "failed",
      at: new Date(T0 + 1_000).toISOString(),
      cause: "budget-exhausted",
      requestId,
      evidence: failedEvidence,
      probe: death,
    });
    const lost = (await loadSession(initial.name))!;
    const recovery: RuntimeRecoveryRecord = {
      version: 1,
      bee: initial.name,
      episodeId: "episode",
      generation: 1,
      detectedAt: new Date(T0).toISOString(),
      probeId: death.probeId,
      status: "failed",
      maxAttempts: 10,
      attempts: [{
        attemptId: "attempt-10",
        attempt: 10,
        scheduledDelayMs: 3_600_000,
        startedAt: new Date(T0).toISOString(),
        leaseUntil: new Date(T0 + 60_000).toISOString(),
        endedAt: new Date(T0 + 1_000).toISOString(),
        outcome: "failed",
        error: "still dead",
      }],
      recoveryFailedRequestId: requestId,
      updatedAt: new Date(T0 + 1_000).toISOString(),
    };
    let resets = 0;
    let drains = 0;
    const finalized = await finalizeManualRuntimeRevive(lost, {
      probe: async () => probe("manual-live", "alive"),
      drainStaged: async () => { drains += 1; return 1; },
      readRecovery: async () => recovery,
      resetRecovery: async () => { resets += 1; },
      now: () => T0 + 2_000,
    });

    assert.equal(finalized.stateMachine?.runtime, "live");
    assert.equal(finalized.stateMachine?.work, "working");
    assert.equal(drains, 1);
    assert.equal(resets, 1);
    const requests = await readBeeRequests(initial.name);
    assert.equal(requests.filter((request) => request.id === requestId).length, 1);
    assert.equal(requests.find((request) => request.id === requestId)?.status, "resolved");
    assert.equal(requests.find((request) => request.id === requestId)?.resolvedBy, "hive-revive");
  });
});

test("explicit remote revive finalization proves authority and clears lost state without local drain", async () => {
  await withTempStore(async () => {
    const initial = record("CO.remote-manual", {
      substrate: undefined,
      node: "remote-node",
      remoteLaunchId: "launch-a",
      remoteIncarnation: "incarnation-a",
      lastPrompt: "finish this",
      lastPromptAt: new Date(T0 - 5_000).toISOString(),
    });
    await saveSession(initial);
    const death = remoteProbe("remote-lost", "dead", initial);
    await transitionSession(initial.name, {
      type: "runtime.lost",
      eventId: "remote-runtime-lost",
      at: new Date(T0).toISOString(),
      cause: "mid-turn-death",
      probe: death,
    });
    const requestId = "recovery-failed:CO.remote-manual:episode";
    await openRequest(initial.name, {
      id: requestId,
      kind: "manual-action",
      scope: "bee",
      generation: 1,
      openedAt: new Date(T0 + 1_000).toISOString(),
      question: "repair remote runtime",
      evidence: { grade: "structured", source: "runtime-recovery-supervisor" },
    });
    await transitionSession(initial.name, {
      type: "recovery.failed",
      eventId: "remote-recovery-failed",
      at: new Date(T0 + 1_000).toISOString(),
      cause: "budget-exhausted",
      requestId,
      evidence: {
        kind: "recovery",
        attemptId: "remote-attempt",
        observedAt: new Date(T0 + 1_000).toISOString(),
        attempt: 1,
        budget: 1,
        outcome: "failed",
      },
      probe: death,
    });
    await updateSession(initial.name, {
      runtimeGeneration: 2,
      remoteLaunchId: "launch-b",
      remoteIncarnation: "incarnation-b",
      status: "running",
    });
    const launched = (await loadSession(initial.name))!;
    const remote = { kind: "remote-hsr" } as unknown as RemoteHsrSubstrate;
    let drains = 0;
    const finalized = await finalizeManualRuntimeRevive(launched, {
      resolveSubstrate: () => remote,
      probe: async (candidate) => remoteProbe("remote-live", "alive", candidate),
      drainStaged: async () => { drains += 1; return 0; },
      readRecovery: async () => ({ recoveryFailedRequestId: requestId } as RuntimeRecoveryRecord),
      resetRecovery: async () => undefined,
    });

    assert.equal(finalized.runtimeGeneration, 2);
    assert.equal(finalized.stateMachine?.runtime, "live");
    assert.equal(finalized.stateMachine?.work, "working");
    assert.equal(drains, 0, "remote finalization never inspects a controller-local HSR run dir");
    assert.equal((await readBeeRequests(initial.name)).find((request) => request.id === requestId)?.status, "resolved");
  });
});

test("manual recovery finalization loses to a kill after selection with zero proof, drain, or transition", async () => {
  await withTempStore(async () => {
    const initial = record("CO.manual-finalize-kill-wins", {
      lastPrompt: "continue exact work",
      lastPromptAt: new Date(T0 - 5_000).toISOString(),
    });
    await saveSession(initial);
    await transitionSession(initial.name, {
      type: "runtime.lost",
      eventId: "manual-finalize-selected-lost",
      at: new Date(T0).toISOString(),
      cause: "mid-turn-death",
      probe: probe("manual-finalize-dead", "dead"),
    });
    const selected = (await loadSession(initial.name))!;
    await withSessionLifecycleTransaction(selected, (lifecycle) => lifecycle.commit({
      status: "kill_failed",
      lastError: "operator kill won after manual finalization selection",
      updatedAt: new Date(T0 + 1_000).toISOString(),
    }));
    let probes = 0;
    let drains = 0;
    let transitions = 0;

    await assert.rejects(
      finalizeManualRuntimeRevive(selected, {
        probe: async () => { probes += 1; return probe("must-not-probe", "alive"); },
        drainStaged: async () => { drains += 1; return 1; },
        transition: async () => { transitions += 1; return null; },
      }),
      /unresolved stop ownership/,
    );

    assert.equal(probes, 0);
    assert.equal(drains, 0);
    assert.equal(transitions, 0);
    assert.equal((await loadSession(initial.name))?.lastError, "operator kill won after manual finalization selection");
  });
});
