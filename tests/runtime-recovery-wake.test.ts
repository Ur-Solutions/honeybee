import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeManualRuntimeRevive } from "../src/recovery/manual.js";
import {
  ensureLiveRuntimeForSend,
  markLiveRuntimeSteered,
} from "../src/recovery/wake.js";
import { openRequest, readBeeRequests } from "../src/requests/store.js";
import {
  loadSession,
  saveSession,
  transitionSession,
  type SessionRecord,
} from "../src/store.js";
import type { ProbeEvidence, RecoveryEvidence } from "../src/stateMachine.js";
import type { RuntimeRecoveryRecord } from "../src/recovery/store.js";
import type { SessionLifecycleTransaction } from "../src/lifecycle.js";

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
    assert.equal(steered.stateMachine?.revision, 2);
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
