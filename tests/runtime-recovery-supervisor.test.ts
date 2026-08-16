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
  type RecoveryRuntimeProbe,
  type RuntimeRecoveryTransitionEvent,
} from "../src/daemon/runtimeRecovery.js";
import {
  beginRuntimeRecovery,
  claimRuntimeRecoveryAttempt,
  finishRuntimeRecoveryAttempt,
  readRuntimeRecovery,
} from "../src/recovery/store.js";
import { readBeeRequests } from "../src/requests/store.js";
import { readStagedPendingHsrTurns } from "../src/hsr/pendingTurns.js";
import {
  __testOnlySetHsrEventAuthorityTimeout,
  appendHsrEvent,
  ensureHsrRunDir,
  readHsrMetaStrict,
  withHsrEventAuthorityLock,
  writeHsrMeta,
  type HsrMeta,
} from "../src/hsr/runDir.js";
import { readHsrEventIntegrityReceipt } from "../src/hsr/eventIntegrity.js";
import type { HsrAnswerHostIdentity } from "../src/answerReceipt.js";
import { withSessionLifecycleTransaction } from "../src/lifecycle.js";
import { readBeeNameLaunchReservation } from "../src/nameAdmission.js";
import { reviveHsrForAutomaticRecovery } from "../src/recovery/revive.js";
import { loadSession, saveSession, transitionSession, updateSession, type SessionRecord } from "../src/store.js";
import type { DeadHsrReAdoptionProbe, LiveHsrReAdoptionProbe } from "../src/daemon/reAdoption.js";
import { lifecycleCursor } from "./lifecycle-fixtures.js";

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

function needsYouRecord(name: string): SessionRecord {
  const candidate = record(name);
  candidate.stateMachine!.work = "needs-you";
  return candidate;
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

function providerNeverStartedMeta(record: SessionRecord): HsrMeta {
  return {
    bee: record.name,
    harness: "stub",
    tier: "stream",
    hostPid: 2_147_000_000,
    childAdmission: "none",
    startupFailure: { stage: "adapter-start", message: "fixture provider never started" },
    startedAt: new Date(START - 5_000).toISOString(),
    controlSocket: "",
    status: "exited",
    endedAt: new Date(START - 4_000).toISOString(),
  };
}

function runningDeadMeta(
  record: SessionRecord,
  childAdmission: "none" | "pending" = "none",
): HsrMeta {
  return {
    bee: record.name,
    harness: "stub",
    tier: "stream",
    hostPid: record.runnerPid ?? 2_147_000_000,
    ...(record.runnerFingerprint ? { hostFingerprint: record.runnerFingerprint } : {}),
    childAdmission,
    startedAt: new Date(START - 5_000).toISOString(),
    runningAt: new Date(START - 4_000).toISOString(),
    controlSocket: "",
    status: "running",
  };
}

function deadRuntimeRecord(name: string): SessionRecord {
  const hostPid = 2_147_000_000;
  return {
    ...record(name),
    runnerPid: hostPid,
    runnerFingerprint: { pgid: hostPid, startedAt: `fixture-host:${name}` },
  };
}

function deathProbe(
  record: SessionRecord,
  outcome: "alive" | "dead" | "unreachable",
): RecoveryRuntimeProbe {
  return {
    evidence: probe(record, outcome),
    ...(outcome === "dead"
      ? { deadHsr: { meta: providerNeverStartedMeta(record), hostVerdict: "gone" as const } }
      : {}),
  };
}

async function publishRuntimeFixture(candidate: SessionRecord): Promise<void> {
  const desired = candidate.stateMachine;
  await saveSession({
    ...candidate,
    status: "running",
    stateMachine: undefined,
    lastObservedState: undefined,
    lastPromptAt: undefined,
  });
  const at = new Date(START - 2_000).toISOString();
  if (desired?.work === "needs-you") {
    await transitionSession(candidate.name, {
      type: "request.opened",
      eventId: `fixture-request-opened:${candidate.name}`,
      at,
      cause: "question",
      requestId: `fixture-request:${candidate.name}`,
      evidence: {
        kind: "request",
        requestId: `fixture-request:${candidate.name}`,
        observedAt: at,
        action: "opened",
      },
    });
  } else {
    await transitionSession(candidate.name, {
      type: "turn.started",
      eventId: `fixture-turn-started:${candidate.name}`,
      at,
      cause: "first-turn",
      evidence: {
        kind: "hook",
        hookId: `fixture-turn-started:${candidate.name}`,
        observedAt: at,
        hook: "turn-start",
      },
    });
    if (desired?.work === "done") {
      await transitionSession(candidate.name, {
        type: "turn.settled",
        eventId: `fixture-turn-settled:${candidate.name}`,
        at: new Date(START - 1_500).toISOString(),
        cause: "turn-settled",
        evidence: {
          kind: "hook",
          hookId: `fixture-turn-settled:${candidate.name}`,
          observedAt: new Date(START - 1_500).toISOString(),
          hook: "turn-end",
        },
        probe: probe(candidate, "alive"),
      });
    }
  }
  if (desired?.runtime === "recovering") {
    await transitionSession(candidate.name, {
      type: "runtime.lost",
      eventId: `fixture-runtime-lost:${candidate.name}`,
      at: new Date(START - 1_000).toISOString(),
      cause: "mid-turn-death",
      probe: probe(candidate, "dead"),
    });
  } else if (desired?.runtime === "parked") {
    await transitionSession(candidate.name, {
      type: "runtime.parked",
      eventId: `fixture-runtime-parked:${candidate.name}`,
      at: new Date(START - 1_000).toISOString(),
      cause: "idle-death",
      probe: probe(candidate, "dead"),
    });
  }
  if (candidate.status !== "running") await updateSession(candidate.name, { status: candidate.status });
}

test("verified idle death parks silently while mid-turn death recovers; uncertainty does nothing", async () => {
  await withTempStore(async () => {
    const idle = record("idle");
    const working = record("working");
    const uncertain = record("uncertain");
    const exactLive = record("exact-live");
    await Promise.all([idle, working, uncertain, exactLive].map(publishRuntimeFixture));
    const transitions: Array<[string, RuntimeRecoveryTransitionEvent]> = [];
    const decisions = await reconcileRuntimeDeaths([idle, working, uncertain, exactLive], {
      probe: async (candidate) => deathProbe(
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

test("runtime death recovery admits canonical active stale-done while excluding archive and failed-stop doubt", async () => {
  await withTempStore(async () => {
    const active = {
      ...record("recovery-active-stale-done"),
      status: "done" as const,
      stateMachine: lifecycleCursor("recovery-active-stale-done", "active", new Date(START).toISOString()),
    };
    const archived = {
      ...record("recovery-archived-stale-running"),
      status: "running" as const,
      stateMachine: lifecycleCursor("recovery-archived-stale-running", "archived", new Date(START).toISOString()),
    };
    const stopDoubt = {
      ...record("recovery-active-kill-failed"),
      status: "kill_failed" as const,
      stateMachine: lifecycleCursor("recovery-active-kill-failed", "active", new Date(START).toISOString()),
    };
    await publishRuntimeFixture(active);
    const probed: string[] = [];
    const decisions = await reconcileRuntimeDeaths([active, archived, stopDoubt], {
      probe: async (candidate) => {
        probed.push(candidate.name);
        return deathProbe(candidate, "dead");
      },
      hasPendingTurns: async () => false,
      transition: async () => undefined,
      now: () => START,
    });

    assert.deepEqual(probed, [active.name]);
    assert.deepEqual(decisions.map(({ bee, action }) => ({ bee, action })), [
      { bee: active.name, action: "recovering" },
    ]);
  });
});

test("needs-you death parks even when HSR markers and staged work look unfinished", async () => {
  await withTempStore(async () => {
    const waiting = needsYouRecord("apiary-waggle-mso8zefe-1");
    await publishRuntimeFixture(waiting);
    const transitions: RuntimeRecoveryTransitionEvent[] = [];
    const [decision] = await reconcileRuntimeDeaths([waiting], {
      probe: async (candidate) => deathProbe(candidate, "dead"),
      hasPendingTurns: async () => true,
      hasUnfinishedMarker: async () => true,
      transition: async (_bee, event) => { transitions.push(event); },
      now: () => START,
    });

    assert.equal(decision?.action, "parked");
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]?.type, "runtime.parked");
    assert.equal(await readRuntimeRecovery(waiting.name), null);
  });
});

test("a completed recovery budget does not turn a later idle death into mid-turn recovery", async () => {
  await withTempStore(async () => {
    const idle = record("idle-after-recovery");
    await publishRuntimeFixture(idle);
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
      probe: async (candidate) => deathProbe(candidate, "dead"),
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
    await publishRuntimeFixture(torn);
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
      probe: async (candidate) => deathProbe(candidate, "dead"),
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
      diskMeta: providerNeverStartedMeta(idle),
      hostVerdict: "gone",
    } as unknown as DeadHsrReAdoptionProbe;
    assert.equal(await handleVerifiedBootRuntimeDeath(deadProbe, {
      hasPendingTurns: async () => false,
      hasUnfinishedMarker: async () => false,
    }), "handled");
    assert.equal((await loadSession(idle.name))?.stateMachine?.runtime, "parked");

    const waitingSeed = { ...record("boot-needs-you"), stateMachine: undefined };
    await saveSession(waitingSeed);
    await transitionSession(waitingSeed.name, {
      type: "turn.started",
      eventId: "boot-needs-you-started",
      at: new Date(START - 2_000).toISOString(),
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "boot-needs-you-started", observedAt: new Date(START - 2_000).toISOString(), hook: "turn-start" },
    });
    await transitionSession(waitingSeed.name, {
      type: "request.opened",
      eventId: "boot-needs-you-request",
      at: new Date(START - 1_000).toISOString(),
      cause: "question",
      requestId: "boot-needs-you-request",
      evidence: { kind: "request", requestId: "boot-needs-you-request", observedAt: new Date(START - 1_000).toISOString(), action: "opened" },
    });
    const waiting = (await loadSession(waitingSeed.name))!;
    const waitingProbe = {
      ...deadProbe,
      record: waiting,
      evidence: probe(waiting, "dead") as RecoveryProbeEvidence & { outcome: "dead" },
      diskMeta: providerNeverStartedMeta(waiting),
    } as DeadHsrReAdoptionProbe;
    assert.equal(await handleVerifiedBootRuntimeDeath(waitingProbe, {
      hasPendingTurns: async () => true,
      hasUnfinishedMarker: async () => true,
    }), "handled");
    assert.equal((await loadSession(waiting.name))?.stateMachine?.runtime, "parked");
    assert.equal((await loadSession(waiting.name))?.stateMachine?.work, "needs-you");

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

test("boot death fallback ignores a predecessor host's retained unfinished turn", async () => {
  await withTempStore(async () => {
    const candidate = {
      ...record("boot-host-refresh"),
      stateMachine: undefined,
      lastObservedState: "idle_with_output" as const,
      lastObservedStateAt: new Date(START - 1_000).toISOString(),
    };
    const hostA: HsrAnswerHostIdentity = {
      hostPid: 301,
      startedAt: new Date(START - 20_000).toISOString(),
      hostFingerprint: { pgid: 301, startedAt: "runtime-host-a" },
    };
    const hostB: HsrAnswerHostIdentity = {
      hostPid: 302,
      startedAt: new Date(START - 5_000).toISOString(),
      hostFingerprint: { pgid: 302, startedAt: "runtime-host-b" },
    };
    await ensureHsrRunDir(candidate.name);
    const hostBMeta: HsrMeta = {
      bee: candidate.name,
      harness: "stub",
      tier: "stream",
      hostPid: hostB.hostPid,
      hostFingerprint: hostB.hostFingerprint,
      childAdmission: "none",
      startedAt: hostB.startedAt,
      controlSocket: "/tmp/runtime-host-b.sock",
      status: "exited",
      endedAt: new Date(START).toISOString(),
    };
    await writeHsrMeta(candidate.name, hostBMeta);
    await appendHsrEvent(candidate.name, { type: "turn_start", ts: START - 19_000, host: hostA });
    await appendHsrEvent(candidate.name, {
      type: "needs_input",
      ts: START - 18_000,
      kind: "question",
      question: "old host question",
      requestId: "r1",
      host: hostA,
    });
    await appendHsrEvent(candidate.name, { type: "host_epoch", ts: START - 5_000, host: hostB });
    await appendHsrEvent(candidate.name, { type: "exit", ts: START, code: 1, host: hostB });
    await saveSession(candidate);

    const transitions: RuntimeRecoveryTransitionEvent[] = [];
    const deadProbe = {
      classification: "dead",
      record: candidate,
      evidence: probe(candidate, "dead") as RecoveryProbeEvidence & { outcome: "dead" },
      diskMeta: hostBMeta,
      hostVerdict: "gone",
    } as unknown as DeadHsrReAdoptionProbe;
    assert.equal(await handleVerifiedBootRuntimeDeath(deadProbe, {
      hasPendingTurns: async () => false,
      transition: async (_bee, event) => { transitions.push(event); },
      markVerified: async () => candidate,
      now: () => START,
      random: () => 0.5,
    }), "handled");
    assert.equal(transitions[0]?.type, "runtime.parked", "old host work cannot trigger recovery for idle B");
  });
});

test("dead running host without a sealed provider stream fences manual integrity before recovery", async () => {
  await withTempStore(async () => {
    const candidate = deadRuntimeRecord("zero-byte-provider-window");
    await publishRuntimeFixture(candidate);
    const meta = runningDeadMeta(candidate);
    await ensureHsrRunDir(candidate.name);
    await writeHsrMeta(candidate.name, meta);
    let transitions = 0;

    const [decision] = await reconcileRuntimeDeaths([candidate], {
      probe: async () => ({ evidence: probe(candidate, "dead"), deadHsr: { meta, hostVerdict: "gone" } }),
      transition: async () => { transitions += 1; },
      hasPendingTurns: async () => false,
      hasUnfinishedMarker: async () => false,
    });

    assert.equal(decision?.action, "integrity");
    assert.equal(transitions, 0);
    const receipt = await readHsrEventIntegrityReceipt(candidate.name);
    assert.equal(receipt?.phase, "unresolved");
    assert.equal(receipt?.stopState, "confirmed");
    const canonical = await loadSession(candidate.name);
    assert.equal(canonical?.status, "kill_failed");
    assert.equal(canonical?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
    assert.match((await readHsrMetaStrict(candidate.name))?.eventIntegrityFailure ?? "", /without positive durable provider-stream closure/);
    assert.equal(await readRuntimeRecovery(candidate.name), null);
  });
});

test("terminal event at durable high-water heals a lost final meta write and remains automatically recoverable", async () => {
  await withTempStore(async () => {
    const candidate = deadRuntimeRecord("terminal-high-water-heal");
    await publishRuntimeFixture(candidate);
    const meta = runningDeadMeta(candidate);
    const host = {
      hostPid: meta.hostPid,
      startedAt: meta.startedAt,
      hostFingerprint: meta.hostFingerprint!,
    };
    await ensureHsrRunDir(candidate.name);
    await writeHsrMeta(candidate.name, meta);
    await appendHsrEvent(candidate.name, { type: "host_epoch", ts: START - 4_000, host });
    await appendHsrEvent(candidate.name, { type: "exit", ts: START - 3_000, code: 0, host });
    const transitions: RuntimeRecoveryTransitionEvent[] = [];

    const [decision] = await reconcileRuntimeDeaths([candidate], {
      probe: async () => ({ evidence: probe(candidate, "dead"), deadHsr: { meta, hostVerdict: "gone" } }),
      transition: async (_bee, event) => { transitions.push(event); },
      hasPendingTurns: async () => false,
      hasUnfinishedMarker: async () => false,
    });

    assert.equal(decision?.action, "parked");
    assert.equal(transitions[0]?.type, "runtime.parked");
    const healed = await readHsrMetaStrict(candidate.name);
    assert.equal(healed?.status, "exited");
    assert.equal(healed?.eventStreamClosure?.lastSeq, 2);
    assert.equal(await readHsrEventIntegrityReceipt(candidate.name), null);
  });
});

test("known append failure cannot be laundered by a later contiguous terminal exit", async () => {
  await withTempStore(async () => {
    const candidate = deadRuntimeRecord("known-loss-before-terminal-exit");
    await publishRuntimeFixture(candidate);
    const meta: HsrMeta = {
      ...runningDeadMeta(candidate),
      eventIntegrityFailure: "provider event append failed after an unknown tool effect",
    };
    const host = {
      hostPid: meta.hostPid,
      startedAt: meta.startedAt,
      hostFingerprint: meta.hostFingerprint!,
    };
    await ensureHsrRunDir(candidate.name);
    await writeHsrMeta(candidate.name, meta);
    await appendHsrEvent(candidate.name, { type: "host_epoch", ts: START - 4_000, host });
    await appendHsrEvent(candidate.name, { type: "exit", ts: START - 3_000, code: 0, host });
    let transitions = 0;

    const [decision] = await reconcileRuntimeDeaths([candidate], {
      probe: async () => ({ evidence: probe(candidate, "dead"), deadHsr: { meta, hostVerdict: "gone" } }),
      transition: async () => { transitions += 1; },
    });

    assert.equal(decision?.action, "integrity");
    assert.equal(transitions, 0);
    assert.equal((await readHsrEventIntegrityReceipt(candidate.name))?.phase, "unresolved");
    assert.equal((await loadSession(candidate.name))?.status, "kill_failed");
  });
});

test("busy event authority defers death classification without publishing a false integrity receipt", async () => {
  await withTempStore(async () => {
    const candidate = deadRuntimeRecord("busy-death-classification");
    await publishRuntimeFixture(candidate);
    const meta = runningDeadMeta(candidate);
    await ensureHsrRunDir(candidate.name);
    await writeHsrMeta(candidate.name, meta);
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withHsrEventAuthorityLock(candidate.name, async () => {
      entered();
      await released;
    });
    await acquired;
    __testOnlySetHsrEventAuthorityTimeout(20);
    try {
      const [decision] = await reconcileRuntimeDeaths([candidate], {
        probe: async () => ({ evidence: probe(candidate, "dead"), deadHsr: { meta, hostVerdict: "gone" } }),
        transition: async () => undefined,
      });
      assert.equal(decision?.action, "unverified");
      assert.equal(await readHsrEventIntegrityReceipt(candidate.name), null);
      assert.equal((await loadSession(candidate.name))?.status, "running");
    } finally {
      __testOnlySetHsrEventAuthorityTimeout(undefined);
      release();
      await holder;
    }
  });
});

test("sealed stream with pending child admission persists stop doubt and authorizes no recovery", async () => {
  await withTempStore(async () => {
    const candidate = deadRuntimeRecord("clean-stream-child-doubt");
    await publishRuntimeFixture(candidate);
    const meta = runningDeadMeta(candidate, "pending");
    const host = {
      hostPid: meta.hostPid,
      startedAt: meta.startedAt,
      hostFingerprint: meta.hostFingerprint!,
    };
    await ensureHsrRunDir(candidate.name);
    await writeHsrMeta(candidate.name, meta);
    await appendHsrEvent(candidate.name, { type: "host_epoch", ts: START - 4_000, host });
    await appendHsrEvent(candidate.name, { type: "exit", ts: START - 3_000, code: 0, host });

    const [decision] = await reconcileRuntimeDeaths([candidate], {
      probe: async () => ({ evidence: probe(candidate, "dead"), deadHsr: { meta, hostVerdict: "gone" } }),
      transition: async () => undefined,
    });

    assert.equal(decision?.action, "unverified");
    const canonical = await loadSession(candidate.name);
    assert.equal(canonical?.status, "kill_failed");
    assert.match(canonical?.lastError ?? "", /exact stop remains unresolved/);
    assert.equal(await readHsrEventIntegrityReceipt(candidate.name), null);
  });
});

test("a due recovery revives, requires a successful post-launch probe, and publishes success", async () => {
  await withTempStore(async () => {
    const bee = record("success", "recovering");
    await saveSession({ ...bee, stateMachine: undefined });
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
      probe: async (candidate) => deathProbe(candidate, ++probes === 1 ? "dead" : "alive"),
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

test("a durable pre-upgrade recovery episode cannot replay across an unsealed dead host", async () => {
  await withTempStore(async () => {
    const candidate = {
      ...deadRuntimeRecord("legacy-accepted-recovery-integrity"),
      stateMachine: record("legacy-accepted-recovery-integrity", "recovering").stateMachine,
    };
    await publishRuntimeFixture(candidate);
    const meta = runningDeadMeta(candidate);
    await ensureHsrRunDir(candidate.name);
    await writeHsrMeta(candidate.name, meta);
    await beginRuntimeRecovery({
      bee: candidate.name,
      generation: candidate.runtimeGeneration ?? 0,
      probeId: "legacy-death-before-stream-proof",
      episodeId: "legacy-recovery-episode",
      nowMs: START - 15_000,
      random: () => 0.5,
    });
    let revives = 0;

    const [outcome] = await runRuntimeRecoverySweep([candidate], {
      now: () => START,
      loadRecord: loadSession,
      probe: async () => ({ evidence: probe(candidate, "dead"), deadHsr: { meta, hostVerdict: "gone" } }),
      transition: async () => undefined,
      revive: async () => {
        revives += 1;
        throw new Error("must not revive across unknown provider effects");
      },
    });

    assert.equal(outcome?.action, "integrity");
    assert.equal(revives, 0);
    assert.equal((await readRuntimeRecovery(candidate.name))?.attempts.length, 0);
    assert.equal((await loadSession(candidate.name))?.status, "kill_failed");
  });
});

test("simultaneous deaths respect the global recovery concurrency cap", async () => {
  await withTempStore(async () => {
    const records = Array.from({ length: 6 }, (_, index) => record(`bee-${index}`, "recovering"));
    for (const candidate of records) {
      await saveSession({ ...candidate, stateMachine: undefined });
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
        return deathProbe(candidate, count === 1 ? "dead" : "alive");
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
    await publishRuntimeFixture(bee);
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
      probe: async (candidate: SessionRecord) => deathProbe(candidate, "dead"),
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

test("automatic recovery claim loses to a concurrent kill without staging, stop, or successor launch", async () => {
  await withTempStore(async () => {
    const snapshot = record("recovery-kill-wins", "recovering");
    await saveSession({ ...snapshot, stateMachine: undefined });
    await beginRuntimeRecovery({
      bee: snapshot.name,
      generation: snapshot.runtimeGeneration ?? 0,
      probeId: "death-proof-before-kill",
      episodeId: "episode-kill-wins",
      nowMs: START - 15_000,
      random: () => 0.5,
    });
    let successorLaunches = 0;
    const outcomes = await runRuntimeRecoverySweep([snapshot], {
      now: () => START,
      random: () => 0.5,
      loadRecord: loadSession,
      probe: async (candidate) => deathProbe(candidate, "dead"),
      revive: async (candidate, episodeId) => {
        await withSessionLifecycleTransaction(candidate, (lifecycle) => lifecycle.commit({
          status: "kill_failed",
          lastError: "operator kill won after recovery claim",
          updatedAt: new Date(START).toISOString(),
        }));
        return reviveHsrForAutomaticRecovery(candidate, episodeId, {
          revive: async () => {
            successorLaunches += 1;
            throw new Error("must not launch");
          },
        });
      },
      transition: async () => undefined,
      appendEvent: async () => undefined,
    });

    assert.equal(outcomes[0]?.action, "failed");
    assert.match(outcomes[0]?.error ?? "", /unresolved stop ownership/);
    assert.equal(successorLaunches, 0);
    assert.equal(await readStagedPendingHsrTurns(snapshot.name), null);
    assert.equal(await readBeeNameLaunchReservation(snapshot.name), null);
    assert.equal((await loadSession(snapshot.name))?.lastError, "operator kill won after recovery claim");
  });
});

test("boot live-recovery handoff never drains work after stop doubt wins", async () => {
  await withTempStore(async () => {
    const initial = {
      ...record("boot-live-kill-wins"),
      stateMachine: undefined,
      lastPrompt: "continue exact work",
      lastPromptAt: new Date(START - 20_000).toISOString(),
    };
    await saveSession(initial);
    const dead = probe(initial, "dead");
    await transitionSession(initial.name, {
      type: "runtime.lost",
      eventId: "boot-live-kill-wins-lost",
      at: new Date(START - 15_000).toISOString(),
      cause: "mid-turn-death",
      probe: dead,
    });
    await beginRuntimeRecovery({
      bee: initial.name,
      generation: initial.runtimeGeneration ?? 0,
      probeId: dead.probeId,
      episodeId: "boot-live-kill-wins-episode",
      nowMs: START - 15_000,
      random: () => 0.5,
    });
    await claimRuntimeRecoveryAttempt({
      bee: initial.name,
      nowMs: START,
      attemptId: "boot-live-kill-wins-attempt",
      random: () => 0.5,
    });
    const recovering = (await loadSession(initial.name))!;
    await withSessionLifecycleTransaction(recovering, (lifecycle) => lifecycle.commit({
      status: "kill_failed",
      lastError: "explicit kill stop remains unconfirmed",
      updatedAt: new Date(START).toISOString(),
    }));
    const fenced = (await loadSession(initial.name))!;
    const liveProbe = {
      classification: "live",
      record: fenced,
      evidence: probe(fenced, "alive") as RecoveryProbeEvidence & { outcome: "alive" },
      diskMeta: {},
      ownedMeta: {},
      staleExitedMeta: false,
    } as unknown as LiveHsrReAdoptionProbe;
    let drains = 0;
    let transitions = 0;

    await handleVerifiedBootRuntimeLive(liveProbe, {
      drainStaged: async () => { drains += 1; return 1; },
      transition: async () => { transitions += 1; },
    });

    assert.equal(drains, 0);
    assert.equal(transitions, 0);
    assert.equal((await loadSession(initial.name))?.status, "kill_failed");
    assert.equal((await loadSession(initial.name))?.lastError, "explicit kill stop remains unconfirmed");
  });
});
