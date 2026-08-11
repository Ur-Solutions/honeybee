import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  handleVerifiedBootRuntimeDeath,
  handleVerifiedBootRuntimeLive,
  reconcileRuntimeDeaths,
  runRuntimeRecoverySweep,
  type RecoveryProbeEvidence,
  type RuntimeRecoveryTransitionEvent,
} from "../src/daemon/runtimeRecovery.js";
import {
  beginRuntimeRecovery,
  claimRuntimeRecoveryAttempt,
  finishRuntimeRecoveryAttempt,
  readRuntimeRecovery,
} from "../src/recovery/store.js";
import { readBeeRequests } from "../src/requests/store.js";
import { loadSession, saveSession, transitionSession, type SessionRecord } from "../src/store.js";
import type { DeadHsrReAdoptionProbe, LiveHsrReAdoptionProbe } from "../src/daemon/reAdoption.js";

const START = Date.parse("2026-08-11T12:00:00.000Z");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-runtime-supervisor-"));
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

function record(name: string, runtime: "live" | "parked" | "recovering" | "lost" = "live"): SessionRecord {
  return {
    name,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    providerSessionId: `thread-${name}`,
    runtimeGeneration: 2,
    createdAt: new Date(START - 60_000).toISOString(),
    updatedAt: new Date(START - 30_000).toISOString(),
    status: "running",
    stateMachine: {
      lifecycle: "active",
      runtime,
      work: runtime === "recovering" ? "working" : "done",
      revision: 1,
      transitionedAt: new Date(START - 30_000).toISOString(),
      lastEventId: `event-${name}`,
    },
  } as SessionRecord;
}

function probe(record: SessionRecord, outcome: "alive" | "dead" | "unreachable"): RecoveryProbeEvidence {
  return {
    kind: "probe",
    probeId: `probe-${record.name}-${outcome}`,
    observerId: "daemon-test",
    observedAt: new Date(START).toISOString(),
    outcome,
    target: { substrate: "hsr", tmuxTarget: record.tmuxTarget, runnerPid: record.runnerPid },
  };
}

test("verified idle death parks silently while mid-turn death recovers; uncertainty does nothing", async () => {
  await withTempStore(async () => {
    const idle = record("idle");
    const working = record("working");
    const uncertain = record("uncertain");
    const exactLive = record("exact-live");
    const transitions: Array<[string, RuntimeRecoveryTransitionEvent]> = [];
    const decisions = await reconcileRuntimeDeaths([idle, working, uncertain, exactLive], {
      probe: async (candidate) => probe(
        candidate,
        candidate.name === "uncertain" ? "unreachable" : candidate.name === "exact-live" ? "alive" : "dead",
      ),
      hasPendingTurns: async (bee) => bee === "working",
      transition: async (bee, event) => { transitions.push([bee, event]); },
      now: () => START,
      random: () => 0.5,
    });

    assert.deepEqual(decisions.map(({ bee, action, suppressLegacyCrash }) => ({ bee, action, suppressLegacyCrash })), [
      { bee: "idle", action: "parked", suppressLegacyCrash: true },
      { bee: "working", action: "recovering", suppressLegacyCrash: true },
      // Uncertainty changes no bounded axes, but it must also hold the legacy
      // cursor: a coarse dead observation is not proof of a crash.
      { bee: "uncertain", action: "unverified", suppressLegacyCrash: true },
      // Exact live proof contradicts the coarse dead observation that admitted
      // this candidate, so the legacy crash write is fenced too.
      { bee: "exact-live", action: "live", suppressLegacyCrash: true },
    ]);
    assert.deepEqual(transitions.map(([bee, event]) => [bee, event.type]), [
      ["idle", "runtime.parked"],
      ["working", "runtime.lost"],
    ]);
    assert.equal((await readRuntimeRecovery("working"))?.nextAttemptAt, new Date(START + 15_000).toISOString());
    assert.equal(await readRuntimeRecovery("idle"), null);
  });
});

test("a completed recovery budget does not turn a later idle death into mid-turn recovery", async () => {
  await withTempStore(async () => {
    const idle = record("idle-after-recovery");
    await beginRuntimeRecovery({
      bee: idle.name,
      generation: 2,
      probeId: "old-death",
      episodeId: "completed-episode",
      nowMs: START - 30_000,
      random: () => 0.5,
    });
    const claim = await claimRuntimeRecoveryAttempt({
      bee: idle.name,
      nowMs: START - 15_000,
      attemptId: "completed-attempt",
      random: () => 0.5,
    });
    assert.ok(claim);
    await finishRuntimeRecoveryAttempt({
      bee: idle.name,
      attemptId: "completed-attempt",
      outcome: "succeeded",
      nowMs: START - 14_000,
      random: () => 0.5,
    });

    const transitions: RuntimeRecoveryTransitionEvent[] = [];
    const [decision] = await reconcileRuntimeDeaths([idle], {
      probe: async (candidate) => probe(candidate, "dead"),
      hasPendingTurns: async () => false,
      hasUnfinishedMarker: async () => false,
      transition: async (_bee, event) => { transitions.push(event); },
      now: () => START,
    });

    assert.equal(decision?.action, "parked");
    assert.equal(transitions[0]?.type, "runtime.parked");
    assert.equal((await readRuntimeRecovery(idle.name))?.status, "recovered");
  });
});

test("a crash between budget creation and the bounded transition resumes the same recovery episode", async () => {
  await withTempStore(async () => {
    const torn = record("torn-transition");
    torn.stateMachine!.work = "working";
    const episode = await beginRuntimeRecovery({
      bee: torn.name,
      generation: 2,
      probeId: "earlier-death-proof",
      episodeId: "persisted-before-transition",
      nowMs: START,
      random: () => 0.5,
    });
    const transitions: RuntimeRecoveryTransitionEvent[] = [];
    const [decision] = await reconcileRuntimeDeaths([torn], {
      probe: async (candidate) => probe(candidate, "dead"),
      hasPendingTurns: async () => false,
      hasUnfinishedMarker: async () => false,
      transition: async (_bee, event) => { transitions.push(event); },
      now: () => START + 1_000,
    });

    assert.equal(decision?.action, "recovering");
    assert.equal(decision?.episodeId, episode.episodeId);
    assert.equal(transitions[0]?.type, "runtime.lost");
    assert.equal((await readRuntimeRecovery(torn.name))?.episodeId, "persisted-before-transition");
  });
});

test("boot re-adoption callbacks persist death and recovery-success before H1 clears uncertainty", async () => {
  await withTempStore(async () => {
    const idle = {
      ...record("boot-idle"),
      stateMachine: undefined,
      lastObservedState: "idle_with_output",
      lastObservedStateAt: new Date(START - 1_000).toISOString(),
    };
    await saveSession(idle);
    const deadEvidence = probe(idle, "dead") as RecoveryProbeEvidence & { outcome: "dead" };
    const deadProbe = {
      classification: "dead",
      record: idle,
      evidence: deadEvidence,
      diskMeta: {},
      hostVerdict: "gone",
    } as unknown as DeadHsrReAdoptionProbe;
    assert.equal(await handleVerifiedBootRuntimeDeath(deadProbe, {
      hasPendingTurns: async () => false,
      hasUnfinishedMarker: async () => false,
    }), "handled");
    assert.equal((await loadSession(idle.name))?.stateMachine?.runtime, "parked");

    const working = {
      ...record("boot-working"),
      stateMachine: undefined,
      lastPrompt: "continue",
      lastPromptAt: new Date(START - 5_000).toISOString(),
    };
    await saveSession(working);
    await transitionSession(working.name, {
      type: "runtime.lost",
      eventId: "boot-working-lost",
      at: new Date(START - 16_000).toISOString(),
      cause: "mid-turn-death",
      probe: probe(working, "dead"),
    });
    await beginRuntimeRecovery({
      bee: working.name,
      generation: 2,
      probeId: "boot-working-death",
      episodeId: "boot-working-episode",
      nowMs: START - 15_000,
      random: () => 0.5,
    });
    await claimRuntimeRecoveryAttempt({
      bee: working.name,
      nowMs: START,
      attemptId: "boot-working-attempt",
      random: () => 0.5,
    });
    const current = (await loadSession(working.name))!;
    const liveEvidence = probe(current, "alive") as RecoveryProbeEvidence & { outcome: "alive" };
    const liveProbe = {
      classification: "live",
      record: current,
      evidence: liveEvidence,
      diskMeta: {},
      ownedMeta: {},
      staleExitedMeta: false,
    } as unknown as LiveHsrReAdoptionProbe;
    await handleVerifiedBootRuntimeLive(liveProbe, {
      now: () => START + 1_000,
      drainStaged: async () => 0,
    });
    assert.equal((await loadSession(working.name))?.stateMachine?.runtime, "live");
    assert.equal((await readRuntimeRecovery(working.name))?.status, "recovered");
  });
});

test("a due recovery revives, requires a successful post-launch probe, and publishes success", async () => {
  await withTempStore(async () => {
    const bee = record("success", "recovering");
    await beginRuntimeRecovery({
      bee: bee.name,
      generation: 2,
      probeId: "death-proof",
      episodeId: "episode-success",
      nowMs: START - 15_000,
      random: () => 0.5,
    });
    let probes = 0;
    const transitions: RuntimeRecoveryTransitionEvent[] = [];
    const outcomes = await runRuntimeRecoverySweep([bee], {
      now: () => START,
      random: () => 0.5,
      probe: async (candidate) => probe(candidate, ++probes === 1 ? "dead" : "alive"),
      transition: async (_name, event) => { transitions.push(event); },
      loadRecord: async () => bee,
      revive: async (candidate) => ({ record: { ...candidate, runtimeGeneration: 3 }, replayedTurns: 1 }),
      appendEvent: async () => undefined,
    });

    assert.deepEqual(outcomes.map(({ action, attempt, replayedTurns }) => ({ action, attempt, replayedTurns })), [
      { action: "recovered", attempt: 1, replayedTurns: 1 },
    ]);
    assert.equal(probes, 2);
    assert.equal(transitions[0]?.type, "recovery.succeeded");
    assert.equal((await readRuntimeRecovery(bee.name))?.status, "recovered");
  });
});

test("simultaneous deaths respect the global recovery concurrency cap", async () => {
  await withTempStore(async () => {
    const records = Array.from({ length: 6 }, (_, index) => record(`bee-${index}`, "recovering"));
    for (const candidate of records) {
      await beginRuntimeRecovery({
        bee: candidate.name,
        generation: 2,
        probeId: `death-${candidate.name}`,
        nowMs: START - 15_000,
        random: () => 0.5,
      });
    }
    let active = 0;
    let maxActive = 0;
    const probeCounts = new Map<string, number>();
    const outcomes = await runRuntimeRecoverySweep(records, {
      concurrency: 2,
      now: () => START,
      random: () => 0.5,
      loadRecord: async (name) => records.find((candidate) => candidate.name === name) ?? null,
      probe: async (candidate) => {
        const count = (probeCounts.get(candidate.name) ?? 0) + 1;
        probeCounts.set(candidate.name, count);
        return probe(candidate, count === 1 ? "dead" : "alive");
      },
      revive: async (candidate) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(15);
        active -= 1;
        return { record: candidate, replayedTurns: 0 };
      },
      transition: async () => undefined,
      appendEvent: async () => undefined,
    });

    assert.equal(maxActive, 2);
    assert.equal(outcomes.length, 6);
    assert.ok(outcomes.every((outcome) => outcome.action === "recovered"));
  });
});

test("exhaustion opens exactly one durable recovery-failed request with attempt history", async () => {
  await withTempStore(async () => {
    const bee = record("exhausted", "recovering");
    await beginRuntimeRecovery({
      bee: bee.name,
      generation: 2,
      probeId: "death-proof",
      episodeId: "episode-failed",
      maxAttempts: 1,
      nowMs: START - 15_000,
      random: () => 0.5,
    });
    const transitions: RuntimeRecoveryTransitionEvent[] = [];
    const deps = {
      now: () => START,
      random: () => 0.5,
      loadRecord: async () => bee,
      probe: async (candidate: SessionRecord) => probe(candidate, "dead"),
      revive: async () => { throw new Error("provider resume rejected"); },
      transition: async (_name: string, event: RuntimeRecoveryTransitionEvent) => { transitions.push(event); },
      appendEvent: async () => undefined,
    };
    const first = await runRuntimeRecoverySweep([bee], deps);
    const second = await runRuntimeRecoverySweep([bee], deps);

    assert.equal(first[0]?.action, "exhausted");
    assert.equal(second[0]?.action, "exhausted");
    const requests = await readBeeRequests(bee.name);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual-action");
    assert.equal(requests[0]?.status, "open");
    assert.deepEqual((requests[0]?.input as { attempts: unknown[] }).attempts.length, 1);
    assert.ok(transitions.every((event) => event.type === "recovery.failed"));
  });
});
