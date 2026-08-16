import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beeMailboxDir,
  formatBuzInjection,
  listMessages,
  parseBuzMessage,
  sendBuzMessageInAdmission as sendBuzMessage,
  type BuzSender,
} from "../src/buz.js";
import {
  createBuzDrainDispatcher,
  dispatchBuzDrains as dispatchBuzDrainsProduction,
  findStaleBuzQueues,
  selectBuzDispatchTriggers,
} from "../src/daemon/buzDispatcher.js";
import {
  createBuzRecoveryDispatcher,
  runBuzRecoverySweep,
} from "../src/daemon/buzRecovery.js";
import { reconcileRuntimeDeaths } from "../src/daemon/runtimeRecovery.js";
import { tick, type ProbeResult, type TickDeps, type TickTransition } from "../src/daemon/run.js";
import { wakeRuntimeForQueuedSend } from "../src/recovery/wake.js";
import { openRequest, readBeeRequests } from "../src/requests/store.js";
import type { BeeState } from "../src/state.js";
import type { ProbeEvidence } from "../src/stateMachine.js";
import { loadSession, saveSession, transitionSession, updateSession, type SessionRecord } from "../src/store.js";
import type { Substrate } from "../src/substrates/index.js";
import { projectBeeView } from "../src/view/project.js";

async function dispatchBuzDrains(
  ...args: Parameters<typeof dispatchBuzDrainsProduction>
): ReturnType<typeof dispatchBuzDrainsProduction> {
  // Most dispatcher fixtures historically used in-memory SessionRecords. The
  // production path now revalidates the canonical row under the lifecycle
  // lock, so publish only absent fixtures before exercising it.
  for (const record of args[0]) {
    if (!(await loadSession(record.name))) {
      await saveSession(record, { probeEvidence: terminalProbe(record) });
    }
  }
  return dispatchBuzDrainsProduction(...args);
}
import { lifecycleCursor } from "./lifecycle-fixtures.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-buz-dispatch-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function makeRecord(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: `tg-${name}`,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "running",
    buzAccept: ["queue", "passive", "interrupt"],
    ...overrides,
  };
}

function terminalProbe(record: SessionRecord): ProbeEvidence {
  return {
    kind: "probe",
    probeId: `buz-recovery-fixture:${record.name}`,
    observerId: "buz-recovery-fixture",
    observedAt: record.lastObservedStateAt ?? record.updatedAt,
    outcome: "dead",
    target: { substrate: "local-tmux", tmuxTarget: record.tmuxTarget },
    detail: "test fixture terminal observation",
  };
}

function fakeSubstrate(impl: Partial<Substrate> = {}): Substrate {
  const base: Substrate = {
    kind: "local-tmux",
    node: "local",
    probe: async () => ({ ok: true }),
    hasSession: async () => true,
    newSession: async () => ({ paneId: "%0" }),
    kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [],
    listPanes: async () => new Set<string>(),
    listSessionStates: async () => new Map<string, string>(),
    setUserOptions: async () => undefined,
    setWindowOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => ["tmux", "attach"],
    attachSession: async () => undefined,
  };
  return { ...base, ...impl };
}

const sender: BuzSender = { kind: "bee", id: "CL.x" };

// ─── selectBuzDispatchTriggers ────────────────────────────────────────────

const queueNonEmpty = async () => true;

test("selectBuzDispatchTriggers picks transitions into idle_with_output", async () => {
  const a = makeRecord("alpha");
  const b = makeRecord("beta");
  const c = makeRecord("gamma");
  const transitions: TickTransition[] = [
    { name: "alpha", from: "active", to: "idle_with_output" },
    { name: "beta", from: "active", to: "active" },
    { name: "gamma", from: "ready", to: "idle_with_output" },
  ];
  const triggers = await selectBuzDispatchTriggers([a, b, c], transitions, queueNonEmpty);
  assert.equal(triggers.length, 2);
  assert.equal(triggers[0]!.record.name, "alpha");
  assert.equal(triggers[1]!.record.name, "gamma");
});

test("selectBuzDispatchTriggers includes first observations (from === undefined) so a daemon restart drains idle bees", async () => {
  const a = makeRecord("alpha");
  const transitions: TickTransition[] = [
    { name: "alpha", from: undefined, to: "idle_with_output" },
  ];
  const triggers = await selectBuzDispatchTriggers([a], transitions, queueNonEmpty);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]!.record.name, "alpha");
});

test("selectBuzDispatchTriggers picks already-idle bees (no transition this tick) via lastObservedState", async () => {
  const idle = makeRecord("alpha", { lastObservedState: "idle_with_output" });
  const active = makeRecord("beta", { lastObservedState: "active" });
  const unknown = makeRecord("gamma");
  const triggers = await selectBuzDispatchTriggers([idle, active, unknown], [], queueNonEmpty);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]!.record.name, "alpha");
});

test("selectBuzDispatchTriggers prefers this tick's transition over a stale lastObservedState", async () => {
  // The bee left idle this tick; the persisted lastObservedState is stale.
  const a = makeRecord("alpha", { lastObservedState: "idle_with_output" });
  const transitions: TickTransition[] = [
    { name: "alpha", from: "idle_with_output", to: "active" },
  ];
  const triggers = await selectBuzDispatchTriggers([a], transitions, queueNonEmpty);
  assert.equal(triggers.length, 0);
});

test("selectBuzDispatchTriggers trusts this tick's currentStates over a stale persisted lastObservedState", async () => {
  // The previous tick's touchSession write failed, so the record on disk
  // still says "active" — but the daemon derived idle_with_output THIS tick.
  // With no transition (the in-memory observed map already updated last
  // tick), only currentStates can see the bee is drainable.
  const stale = makeRecord("alpha", { lastObservedState: "active" });
  const currentStates = new Map([["alpha", "idle_with_output"]]);
  const triggers = await selectBuzDispatchTriggers([stale], [], queueNonEmpty, currentStates);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]!.record.name, "alpha");
});

test("selectBuzDispatchTriggers via currentStates skips a bee that went active despite a stale idle lastObservedState", async () => {
  const stale = makeRecord("alpha", { lastObservedState: "idle_with_output" });
  const currentStates = new Map([["alpha", "active"]]);
  const triggers = await selectBuzDispatchTriggers([stale], [], queueNonEmpty, currentStates);
  assert.equal(triggers.length, 0);
});

test("selectBuzDispatchTriggers skips idle bees with an empty queue", async () => {
  const a = makeRecord("alpha", { lastObservedState: "idle_with_output" });
  const triggers = await selectBuzDispatchTriggers([a], [], async () => false);
  assert.equal(triggers.length, 0);
});

test("selectBuzDispatchTriggers drains runnable bees and fences stop doubt regardless of liveness", async () => {
  const ready = makeRecord("ready");
  const crashed = makeRecord("crashed");
  const stopFailed = makeRecord("stop-failed", { status: "kill_failed" });
  const archived = makeRecord("archived", { status: "done" });
  const canonicalActive = makeRecord("canonical-active-stale-done", {
    status: "done",
    stateMachine: lifecycleCursor("canonical-active-stale-done", "active", "2026-05-28T00:00:00.000Z"),
  });
  const canonicalArchived = makeRecord("canonical-archived-stale-running", {
    status: "running",
    stateMachine: lifecycleCursor("canonical-archived-stale-running", "archived", "2026-05-28T00:00:00.000Z"),
  });
  const current = new Map<string, BeeState>([
    [ready.name, "ready"],
    [crashed.name, "crashed"],
    [stopFailed.name, "kill_failed"],
    [archived.name, "done"],
    [canonicalActive.name, "ready"],
    [canonicalArchived.name, "ready"],
  ]);
  const triggers = await selectBuzDispatchTriggers(
    [ready, crashed, stopFailed, archived, canonicalActive, canonicalArchived],
    [],
    queueNonEmpty,
    current,
  );
  assert.deepEqual(
    triggers.map((trigger) => [trigger.record.name, trigger.action]),
    [
      ["ready", "drain"],
      ["canonical-active-stale-done", "drain"],
    ],
  );
});

test("selectBuzDispatchTriggers bounds concurrent mailbox probes", async () => {
  const records = ["alpha", "beta", "gamma", "delta"].map((name) => makeRecord(name, { lastObservedState: "idle_with_output" }));
  let active = 0;
  let maxActive = 0;
  const triggers = await selectBuzDispatchTriggers(
    records,
    [],
    async (record) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return record.name !== "gamma";
    },
    undefined,
    2,
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(triggers.map((trigger) => trigger.record.name), ["alpha", "beta", "delta"]);
});

test("selectBuzDispatchTriggers ignores transitions for unknown records", async () => {
  const transitions: TickTransition[] = [
    { name: "ghost", from: "active", to: "idle_with_output" },
  ];
  const triggers = await selectBuzDispatchTriggers([], transitions, queueNonEmpty);
  assert.equal(triggers.length, 0);
});

test("findStaleBuzQueues reports old mail for sendable hot or cold recipients, never archived ones", async () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const oldMessage = {
    id: "old",
    from: sender,
    to: "alpha",
    tier: "queue" as const,
    deliveredAs: "queue" as const,
    sentAt: "2026-07-28T11:30:00.000Z",
    body: "stalled",
  };
  const records = [makeRecord("alpha"), makeRecord("cold"), makeRecord("done", { status: "done" }), makeRecord("fresh")];
  const warnings = await findStaleBuzQueues(records, {
    now: () => now,
    staleAfterMs: 10 * 60_000,
    listQueue: async (record) => {
      if (record.name === "fresh") {
        return [{
          message: { ...oldMessage, id: "fresh", to: "fresh", sentAt: "2026-07-28T11:55:00.000Z" },
          path: "/tmp/fresh",
        }];
      }
      return [{ message: { ...oldMessage, to: record.name }, path: `/tmp/${record.name}` }];
    },
  });
  assert.deepEqual(warnings, ["alpha", "cold"].map((recipient) => ({
    recipient,
    count: 1,
    oldestSentAt: oldMessage.sentAt,
    ageMs: 30 * 60_000,
  })));
});

test("createBuzDrainDispatcher keeps stale diagnostics current but logs only their edge", async () => {
  let now = Date.parse("2026-07-28T12:00:00.000Z");
  let queued = true;
  const recipient = makeRecord("alpha");
  const states = new Map<string, BeeState>([["alpha", "active"]]);
  const dispatcher = createBuzDrainDispatcher({
    now: () => now,
    staleAfterMs: 10 * 60_000,
    scanIntervalMs: 1,
    hasQueuedMessages: async () => false,
    listQueue: async () => queued
      ? [{
          message: {
            id: "old",
            from: sender,
            to: recipient.name,
            tier: "queue",
            deliveredAs: "queue",
            sentAt: "2026-07-28T11:30:00.000Z",
            body: "stalled",
          },
          path: "/tmp/old",
        }]
      : [],
  });

  const first = await dispatcher([recipient], [], states);
  assert.equal(first[0]!.staleQueue?.newlyStale, true);
  now += 2;
  const unchanged = await dispatcher([recipient], [], states);
  assert.equal(unchanged[0]!.staleQueue?.newlyStale, false);
  queued = false;
  now += 2;
  assert.deepEqual(await dispatcher([recipient], [], states), []);
});

test("createBuzDrainDispatcher reports scan failures without rejecting delivery", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("alpha");
    await saveSession(recipient);
    const dispatcher = createBuzDrainDispatcher({
    now: () => Date.parse("2026-07-28T12:00:00.000Z"),
    scanIntervalMs: 1,
    hasQueuedMessages: async () => true,
    drain: async () => ({ delivered: ["delivered"], quarantined: [], errors: [] }),
    listQueue: async () => {
      throw new Error("mailbox unavailable");
    },
  });

    const outcomes = await dispatcher(
      [recipient],
      [],
      new Map<string, BeeState>([["alpha", "idle_with_output"]]),
    );
    assert.deepEqual(outcomes[0]!.result.delivered, ["delivered"]);
    assert.equal(outcomes[1]!.diagnosticError, "mailbox unavailable");
  });
});

test("createBuzDrainDispatcher backs off identical illegal transitions per recipient", async () => {
  await withTempStore(async () => {
    let now = Date.parse("2026-08-12T07:00:00.000Z");
    const recipient = makeRecord("CO.illegal");
    await saveSession(recipient);
    await transitionSession(recipient.name, {
      type: "turn.started",
      eventId: "illegal-fixture-start",
      at: new Date(now - 2_000).toISOString(),
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "illegal-fixture-start", observedAt: new Date(now - 2_000).toISOString(), hook: "turn-start" },
    });
    await transitionSession(recipient.name, {
      type: "request.opened",
      eventId: "illegal-fixture-request",
      at: new Date(now - 1_000).toISOString(),
      cause: "question",
      requestId: "illegal-fixture-request",
      evidence: { kind: "request", requestId: "illegal-fixture-request", observedAt: new Date(now - 1_000).toISOString(), action: "opened" },
    });
    const current = (await loadSession(recipient.name))!;
    let attempts = 0;
    const dispatcher = createBuzDrainDispatcher({
      now: () => now,
      scanIntervalMs: Number.MAX_SAFE_INTEGER,
      illegalTransitionBackoffMs: [60_000, 5 * 60_000, 15 * 60_000],
      hasQueuedMessages: async () => true,
      drain: async (record) => {
        attempts += 1;
        await transitionSession(record.name, {
          type: "runtime.lost",
          eventId: `illegal-drain-${attempts}`,
          at: new Date(now).toISOString(),
          cause: "mid-turn-death",
          probe: terminalProbe(record),
        });
        throw new Error("unreachable");
      },
      listQueue: async () => [],
    });
    const states = new Map<string, BeeState>([[recipient.name, "ready"]]);

    const first = await dispatcher([current], [], states);
    assert.equal(first[0]?.result.errors[0]?.code, "ILLEGAL_BEE_TRANSITION");
    assert.deepEqual(first[0]?.illegalTransitionBackoff, {
      attempt: 1,
      retryAt: new Date(now + 60_000).toISOString(),
    });

    for (let tick = 1; tick < 20; tick += 1) {
      now += 3_000;
      assert.deepEqual(await dispatcher([current], [], states), []);
    }
    assert.equal(attempts, 1, "ordinary daemon ticks are suppressed during the recipient backoff");
    const ledgerAfterHotTicks = (await readFile(join(process.env.HIVE_STORE_ROOT!, "ledger.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(ledgerAfterHotTicks.filter((row) => row.type === "state.transition.rejected").length, 1);

    now = Date.parse(first[0]!.illegalTransitionBackoff!.retryAt);
    const second = await dispatcher([current], [], states);
    assert.equal(second[0]?.illegalTransitionBackoff?.attempt, 2);
    assert.equal(Date.parse(second[0]!.illegalTransitionBackoff!.retryAt) - now, 5 * 60_000);
    now = Date.parse(second[0]!.illegalTransitionBackoff!.retryAt);
    const third = await dispatcher([current], [], states);
    assert.equal(Date.parse(third[0]!.illegalTransitionBackoff!.retryAt) - now, 15 * 60_000);
    now = Date.parse(third[0]!.illegalTransitionBackoff!.retryAt);
    const capped = await dispatcher([current], [], states);
    assert.equal(Date.parse(capped[0]!.illegalTransitionBackoff!.retryAt) - now, 15 * 60_000);
  });
});

// ─── dispatchBuzDrains end-to-end ────────────────────────────────────────

test("dispatchBuzDrains drains queue on active->idle_with_output and moves to inbox", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const a = await sendBuzMessage({ recipient, sender, tier: "queue", body: "first" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await sendBuzMessage({ recipient, sender, tier: "queue", body: "second" });

    const calls: string[] = [];
    const substrate = fakeSubstrate({ sendText: async (_t, text) => { calls.push(text); } });
    const outcomes = await dispatchBuzDrains(
      [recipient],
      [{ name: recipient.name, from: "active", to: "idle_with_output" }],
      { resolveSubstrate: () => substrate },
    );

    // One message per idle observation (queued-steering spec): the first
    // delivery starts a new turn, so "second" waits for the NEXT idle tick.
    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0]!.result.delivered, [a.message.id]);
    assert.deepEqual(calls, [formatBuzInjection(a.message)]);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).length, 1);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 1);

    const next = await dispatchBuzDrains(
      [recipient],
      [{ name: recipient.name, from: "active", to: "idle_with_output" }],
      { resolveSubstrate: () => substrate },
    );
    assert.deepEqual(next[0]!.result.delivered, [b.message.id]);
    assert.deepEqual(calls, [formatBuzInjection(a.message), formatBuzInjection(b.message)]);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).length, 0);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 2);
  });
});

test("dispatchBuzDrains promotes queued A when the current recovery owner B is delivered", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.promote-after-delivery", { lastObservedState: "idle_with_output" });
    await saveSession(recipient);
    const a = await sendBuzMessage({ recipient, sender, tier: "queue", body: "A" });
    const b = await sendBuzMessage({ recipient, sender, tier: "queue", body: "B" });
    assert.ok(a.queuePath && b.queuePath);

    // Force B to be the next FIFO delivery while A remains queued, recreating
    // a current-owner settlement with an older obligation still on disk.
    const stamp = Date.parse("2026-08-12T10:00:00.000Z");
    await utimes(b.queuePath, new Date(stamp), new Date(stamp));
    await utimes(a.queuePath, new Date(stamp + 1_000), new Date(stamp + 1_000));
    await updateSession(recipient.name, {
      recoveryRequestedAt: new Date(stamp).toISOString(),
      recoveryMessageId: b.message.id,
      recoveryAttemptCount: 2,
    });

    const outcomes = await dispatchBuzDrains([recipient], [], {
      currentStates: new Map([[recipient.name, "idle_with_output"]]),
      resolveSubstrate: () => fakeSubstrate(),
    });
    assert.deepEqual(outcomes[0]?.result.delivered, [b.message.id]);
    const after = (await loadSession(recipient.name))!;
    assert.equal(after.recoveryMessageId, a.message.id);
    assert.equal(after.recoveryAttemptCount, 0);
    assert.equal(after.recoveryNextAttemptAt, undefined);
  });
});

test("dispatchBuzDrains drains a bee that is ALREADY idle when a message lands in queue/ (no transition)", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { lastObservedState: "idle_with_output" });
    // The message arrives while the bee is already idle — no transition will
    // ever fire, but the next tick must still deliver it.
    const sent = await sendBuzMessage({ recipient, sender, tier: "queue", body: "while-idle" });

    const calls: string[] = [];
    const substrate = fakeSubstrate({ sendText: async (_t, text) => { calls.push(text); } });
    const outcomes = await dispatchBuzDrains([recipient], [], { resolveSubstrate: () => substrate });

    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0]!.result.delivered, [sent.message.id]);
    assert.deepEqual(calls, [formatBuzInjection(sent.message)]);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).filter((f) => f.endsWith(".md")).length, 0);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 1);
  });
});

test("dispatchBuzDrains never wakes a cold bee inline", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.cold", {
      lastObservedState: "crashed",
      providerSessionId: "thread-1",
      recoveryRequestedAt: "2026-08-10T00:00:00.000Z",
    });
    const sent = await sendBuzMessage({ recipient, sender, tier: "queue", body: "wake up" });
    const outcomes = await dispatchBuzDrains([recipient], []);
    assert.deepEqual(outcomes, []);
    const queued = await listMessages(recipient.name, "queue");
    assert.deepEqual(queued.map((entry) => entry.message.id), [sent.message.id]);
  });
});

test("live incident repro: needs-you dead runner parks, wakes lazily, and drains buz without closing its request", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-12T07:05:00.000Z");
    const recipient = makeRecord("apiary-waggle-mso8zefe-1", {
      substrate: "hsr",
      providerSessionId: "thread-live-incident",
      runtimeGeneration: 4,
    });
    await saveSession(recipient);
    await transitionSession(recipient.name, {
      type: "turn.started",
      eventId: "incident-turn-started",
      at: new Date(now - 3_000).toISOString(),
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "incident-turn-started", observedAt: new Date(now - 3_000).toISOString(), hook: "turn-start" },
    });
    const requestId = "incident-open-question";
    await openRequest(recipient.name, {
      id: requestId,
      kind: "question",
      scope: "turn",
      generation: 4,
      openedAt: new Date(now - 2_000).toISOString(),
      question: "Which Cloudflare account should I use?",
      evidence: { grade: "structured", source: "hsr-events", observedAt: new Date(now - 2_000).toISOString() },
    });
    await transitionSession(recipient.name, {
      type: "request.opened",
      eventId: "incident-request-opened",
      at: new Date(now - 2_000).toISOString(),
      cause: "question",
      requestId,
      evidence: { kind: "request", requestId, observedAt: new Date(now - 2_000).toISOString(), action: "opened" },
    });
    await updateSession(recipient.name, {
      lastObservedState: "blocked",
      lastObservedStateAt: new Date(now - 1_000).toISOString(),
    });
    const queued = await sendBuzMessage({ recipient, sender, tier: "queue", body: "review-ready update" });
    await updateSession(recipient.name, {
      recoveryRequestedAt: new Date(now).toISOString(),
      recoveryMessageId: queued.message.id,
      recoveryAttemptCount: 0,
    });

    const deadProbe: ProbeEvidence = {
      kind: "probe",
      probeId: "incident-runner-dead",
      observerId: "incident-repro",
      observedAt: new Date(now).toISOString(),
      outcome: "dead",
      target: { substrate: "hsr", runnerPid: 4242 },
    };
    const beforeDeath = (await loadSession(recipient.name))!;
    const [death] = await reconcileRuntimeDeaths([beforeDeath], {
      probe: async () => ({
        evidence: deadProbe,
        deadHsr: {
          meta: {
            bee: beforeDeath.name,
            harness: "stub",
            tier: "stream",
            hostPid: 2_147_000_000,
            childAdmission: "none",
            startupFailure: { stage: "adapter-start", message: "fixture provider never started" },
            startedAt: new Date(now - 4_000).toISOString(),
            controlSocket: "",
            status: "exited",
            endedAt: new Date(now - 3_500).toISOString(),
          },
          hostVerdict: "gone",
        },
      }),
      transition: transitionSession,
      // This is the production incident shape: the structured needs_input tail
      // looks unfinished even though bounded work has already suspended.
      hasPendingTurns: async () => true,
      hasUnfinishedMarker: async () => true,
      now: () => now,
    });
    assert.equal(death?.action, "parked");
    const parked = (await loadSession(recipient.name))!;
    assert.equal(parked.stateMachine?.runtime, "parked");
    assert.equal(parked.stateMachine?.work, "needs-you");

    let live = false;
    let launches = 0;
    const recovery = await runBuzRecoverySweep([parked], {
      now: () => now,
      isLive: async () => live,
      assertCwd: async () => undefined,
      wakeRecipient: (snapshot) => wakeRuntimeForQueuedSend(snapshot, {
        isLive: async () => live,
        probe: async () => ({
          ...deadProbe,
          probeId: live ? "incident-replacement-live" : "incident-confirmed-dead",
          outcome: live ? "alive" : "dead",
        }),
        assertCwd: async () => undefined,
        reviveInTransaction: async (lifecycle) => {
          launches += 1;
          const current = await lifecycle.refresh();
          const revived = await lifecycle.commit({
            runtimeGeneration: (current.runtimeGeneration ?? 0) + 1,
            status: "running",
          });
          live = true;
          return revived;
        },
        now: () => now,
      }),
    });
    assert.equal(recovery[0]?.action, "started");
    assert.equal(launches, 1);
    const awakened = (await loadSession(recipient.name))!;
    assert.equal(awakened.stateMachine?.work, "needs-you");

    const injected: string[] = [];
    const drained = await dispatchBuzDrains([awakened], [], {
      currentStates: new Map([[recipient.name, "ready"]]),
      resolveSubstrate: () => fakeSubstrate({ sendText: async (_target, text) => { injected.push(text); } }),
    });
    assert.deepEqual(drained[0]?.result.delivered, [queued.message.id]);
    assert.deepEqual(injected, [formatBuzInjection(queued.message)]);

    const final = (await loadSession(recipient.name))!;
    const storedRequests = await readBeeRequests(recipient.name);
    assert.equal(final.runtimeGeneration, 5);
    assert.equal(storedRequests.find((request) => request.id === requestId)?.generation, 5);
    assert.equal(storedRequests.find((request) => request.id === requestId)?.status, "open");
    const view = projectBeeView({
      record: final,
      context: {
        liveTargets: new Set(),
        hsrLive: new Set([recipient.name]),
        hsrStates: new Map([[recipient.name, "blocked"]]),
        now,
      },
      storedRequests,
      now,
    });
    assert.equal(final.stateMachine?.work, "needs-you");
    assert.equal(view.openRequests[0]?.id, requestId);
    assert.equal(view.openRequests[0]?.status, "open");
    const ledger = (await readFile(join(process.env.HIVE_STORE_ROOT!, "ledger.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(ledger.filter((row) => row.type === "state.transition.rejected").length, 0);
  });
});

test("dispatchBuzDrains never admits queued work through a live kill_failed bee", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.stop-failed", { status: "kill_failed" });
    const sent = await sendBuzMessage({ recipient, sender, tier: "queue", body: "still there?" });
    const outcomes = await dispatchBuzDrains([recipient], [], {
      currentStates: new Map([[recipient.name, "kill_failed"]]),
      resolveSubstrate: () => fakeSubstrate({ hasSession: async () => true }),
    });
    assert.deepEqual(outcomes, []);
    assert.deepEqual((await listMessages(recipient.name, "queue")).map(({ message }) => message.id), [sent.message.id]);
  });
});

test("daemon drain revalidates a stale runnable snapshot after canonical delivery doubt wins", async () => {
  await withTempStore(async () => {
    const stale = makeRecord("CO.delivery-doubt-race", { lastObservedState: "idle_with_output" });
    await saveSession(stale);
    const sent = await sendBuzMessage({ recipient: stale, sender, tier: "queue", body: "must remain staged" });
    await updateSession(stale.name, {
      status: "kill_failed",
      lastError: `Buz delivery ${sent.message.id} may have crossed provider acceptance`,
    });
    let drains = 0;

    const outcomes = await dispatchBuzDrainsProduction([stale], [], {
      drain: async () => {
        drains += 1;
        return { delivered: [sent.message.id], quarantined: [], errors: [] };
      },
    });

    assert.equal(drains, 0, "fresh lifecycle admission refuses before mailbox/provider work");
    assert.equal(outcomes.length, 1);
    assert.match(outcomes[0]?.result.errors[0]?.message ?? "", /not runnable|kill_failed|stop/i);
    assert.deepEqual((await listMessages(stale.name, "queue")).map(({ message }) => message.id), [sent.message.id]);
  });
});

// ─── detached recovery lane ──────────────────────────────────────────────

async function seedRecoveryRecord(
  name: string,
  now: number,
  overrides: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const base = makeRecord(name, {
    status: "dead",
    lastObservedState: "crashed",
    providerSessionId: `thread-${name}`,
    ...overrides,
  });
  const sent = await sendBuzMessage({ recipient: base, sender, tier: "queue", body: `recover ${name}` });
  const record = {
    ...base,
    recoveryRequestedAt: new Date(now).toISOString(),
    recoveryMessageId: sent.message.id,
    recoveryAttemptCount: 0,
  };
  await saveSession(record, { probeEvidence: terminalProbe(record) });
  return record;
}

test("runBuzRecoverySweep persists backoff across sweeps and opens needs-action after the cap", async () => {
  await withTempStore(async () => {
    let now = Date.parse("2026-08-10T12:00:00.000Z");
    const record = await seedRecoveryRecord("CO.retry-wake", now);
    let wakes = 0;
    const deps = {
      now: () => now,
      maxFailures: 3,
      isLive: async () => false,
      assertCwd: async () => undefined,
      wakeRecipient: async () => {
        wakes += 1;
        throw new Error("credential service unavailable");
      },
    };

    const first = await runBuzRecoverySweep([record], deps);
    assert.equal(first[0]?.action, "failed");
    assert.equal(first[0]?.attempt, 1);
    assert.equal(wakes, 1);
    const afterFirst = (await loadSession(record.name))!;
    assert.equal(afterFirst.recoveryAttemptCount, 1);

    const deferred = await runBuzRecoverySweep([afterFirst], deps);
    assert.equal(deferred[0]?.action, "deferred");
    assert.equal(wakes, 1);

    now = Date.parse(afterFirst.recoveryNextAttemptAt!);
    const second = await runBuzRecoverySweep([afterFirst], deps);
    assert.equal(second[0]?.attempt, 2);
    const afterSecond = (await loadSession(record.name))!;
    now = Date.parse(afterSecond.recoveryNextAttemptAt!);
    const exhausted = await runBuzRecoverySweep([afterSecond], deps);
    assert.equal(exhausted[0]?.action, "undeliverable");
    assert.equal(exhausted[0]?.reason, "wake-retry-exhausted");
    assert.equal(wakes, 3);

    const settled = (await loadSession(record.name))!;
    assert.equal(settled.recoveryRequestedAt, undefined);
    assert.equal(settled.recoveryMessageId, undefined);
    const request = (await readBeeRequests(record.name)).find((candidate) => candidate.status === "open");
    assert.equal(request?.kind, "manual-action");
    assert.equal(request?.scope, "bee");
    assert.equal(request?.evidence.detail, "wake-retry-exhausted");
  });
});

test("runBuzRecoverySweep resumes accepted cold mail after a sleep longer than 15 minutes", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const record = await seedRecoveryRecord("CO.slept-mail", now - 24 * 60 * 60_000);
    let wakes = 0;
    const outcomes = await runBuzRecoverySweep([record], {
      now: () => now,
      isLive: async () => false,
      assertCwd: async () => undefined,
      wakeRecipient: async (candidate) => {
        wakes += 1;
        return candidate;
      },
    });
    assert.equal(wakes, 1, "daemon downtime does not spend or expire the bounded wake budget");
    assert.equal(outcomes[0]?.action, "started");
    assert.equal((await loadSession(record.name))?.recoveryMessageId, record.recoveryMessageId);
    assert.equal((await readBeeRequests(record.name)).length, 0);
  });
});

test("runBuzRecoverySweep never classifies a remote cwd against the controller filesystem", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const record = await seedRecoveryRecord("CO.remote-cold-mail", now, {
      cwd: "/remote/node/checkout-that-is-not-local",
      node: "remote-hsr-node",
    });
    let wakes = 0;
    const outcomes = await runBuzRecoverySweep([record], {
      now: () => now,
      isLive: async () => false,
      resolveSubstrate: () => fakeSubstrate({ kind: "remote-hsr", node: "remote-hsr-node" }),
      wakeRecipient: async () => {
        wakes += 1;
        throw new Error("remote authority is temporarily unavailable");
      },
    });

    assert.equal(wakes, 1, "cold remote recovery reaches the authority path instead of local stat");
    assert.equal(outcomes[0]?.action, "failed");
    assert.notEqual(outcomes[0]?.reason, "missing-cwd");
    assert.equal((await listMessages(record.name, "queue")).length, 1);
    assert.equal((await listMessages(record.name, "quarantine")).length, 0);
    assert.equal((await readBeeRequests(record.name)).length, 0);
  });
});

test("runBuzRecoverySweep treats missing providerSessionId as a one-shot undeliverable skip", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const record = await seedRecoveryRecord("CO.no-provider", now, { providerSessionId: undefined });
    let wakes = 0;
    const outcomes = await runBuzRecoverySweep([record], {
      now: () => now,
      isLive: async () => false,
      assertCwd: async () => undefined,
      wakeRecipient: async (candidate) => {
        wakes += 1;
        return candidate;
      },
    });
    assert.equal(wakes, 0);
    assert.equal(outcomes[0]?.reason, "missing-provider-session");
    assert.equal((await loadSession(record.name))?.recoveryRequestedAt, undefined);
    assert.equal((await readBeeRequests(record.name)).length, 1);
  });
});

test("runBuzRecoverySweep turns kill_failed delivery into needs-action even when the escaped runtime is live", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const record = await seedRecoveryRecord("CO.stopped-after-accept", now, { status: "kill_failed" });
    const outcomes = await runBuzRecoverySweep([record], {
      now: () => now,
      isLive: async () => true,
    });
    assert.equal(outcomes[0]?.action, "undeliverable");
    assert.equal(outcomes[0]?.reason, "archive-unresolved");
    assert.equal((await readBeeRequests(record.name))[0]?.evidence.detail, "archive-unresolved");
  });
});

test("runBuzRecoverySweep separates stale lifecycle scalars from current stop doubt", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const at = new Date(now).toISOString();
    const activeSeed = await seedRecoveryRecord("CO.active-stale-done", now, {
      status: "running",
      lastObservedState: undefined,
    });
    await transitionSession(activeSeed.name, {
      type: "turn.started",
      eventId: "buz-active-stale-done",
      at,
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "buz-active-stale-done", observedAt: at, hook: "turn-start" },
    });
    await updateSession(activeSeed.name, { status: "done" });
    const active = (await loadSession(activeSeed.name))!;

    const stopDoubtSeed = await seedRecoveryRecord("CO.active-stop-doubt", now, {
      status: "running",
      lastObservedState: undefined,
    });
    await transitionSession(stopDoubtSeed.name, {
      type: "turn.started",
      eventId: "buz-active-stop-doubt",
      at,
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "buz-active-stop-doubt", observedAt: at, hook: "turn-start" },
    });
    await updateSession(stopDoubtSeed.name, { status: "kill_failed" });
    const stopDoubt = (await loadSession(stopDoubtSeed.name))!;

    const archivedSeed = await seedRecoveryRecord("CO.archived-stale-running", now, {
      status: "running",
      lastObservedState: undefined,
    });
    await transitionSession(archivedSeed.name, {
      type: "bee.archived",
      eventId: "buz-archived-stale-running",
      at,
      cause: "retire",
      evidence: { kind: "operator", actionId: "buz-archived-stale-running", observedAt: at, action: "retire" },
      probe: {
        kind: "probe",
        probeId: "buz-archived-stale-running",
        observerId: "buz-recovery-fixture",
        observedAt: at,
        outcome: "dead",
        target: { substrate: "local-tmux", tmuxTarget: archivedSeed.tmuxTarget },
      },
    });
    await updateSession(archivedSeed.name, { status: "running" });
    const archived = (await loadSession(archivedSeed.name))!;
    const wakes: string[] = [];
    const outcomes = await runBuzRecoverySweep([active, stopDoubt, archived], {
      now: () => now,
      isLive: async () => false,
      assertCwd: async () => undefined,
      wakeRecipient: async (candidate) => {
        wakes.push(candidate.name);
        return candidate;
      },
    });
    assert.deepEqual(wakes, [active.name]);
    assert.equal(outcomes.find((outcome) => outcome.recipient === active.name)?.action, "started");
    assert.equal(outcomes.find((outcome) => outcome.recipient === stopDoubt.name)?.reason, "archive-unresolved");
    assert.equal(outcomes.find((outcome) => outcome.recipient === archived.name)?.reason, "archive-unresolved");
  });
});

test("runBuzRecoverySweep limits provider wakes to its own concurrency", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const records = await Promise.all([
      seedRecoveryRecord("CO.wake-a", now),
      seedRecoveryRecord("CO.wake-b", now),
      seedRecoveryRecord("CO.wake-c", now),
      seedRecoveryRecord("CO.wake-d", now),
    ]);
    let active = 0;
    let maxActive = 0;
    const outcomes = await runBuzRecoverySweep(records, {
      now: () => now,
      concurrency: 2,
      isLive: async () => false,
      assertCwd: async () => undefined,
      wakeRecipient: async (candidate) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return candidate;
      },
    });
    assert.equal(maxActive, 2);
    assert.ok(outcomes.every((outcome) => outcome.action === "started"));
  });
});

test("createBuzRecoveryDispatcher queues wake work off the tick-facing call", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const record = await seedRecoveryRecord("CO.detached", now);
    const jobs: Array<() => Promise<void>> = [];
    let wakes = 0;
    const dispatcher = createBuzRecoveryDispatcher({
      now: () => now,
      isLive: async () => false,
      assertCwd: async () => undefined,
      wakeRecipient: async (candidate) => {
        wakes += 1;
        return candidate;
      },
      startBackground: (job) => jobs.push(job),
    });

    assert.deepEqual(await dispatcher([record]), []);
    assert.equal(wakes, 0, "tick-facing call only schedules work");
    assert.equal(jobs.length, 1);
    await jobs[0]!();
    const report = await dispatcher([]);
    assert.equal(report[0]?.action, "started");
    assert.equal(wakes, 1);
  });
});

test("dispatchBuzDrains drains on the daemon's first observation (from === undefined) of an idle bee", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const sent = await sendBuzMessage({ recipient, sender, tier: "queue", body: "after-restart" });

    const substrate = fakeSubstrate();
    const outcomes = await dispatchBuzDrains(
      [recipient],
      [{ name: recipient.name, from: undefined, to: "idle_with_output" }],
      { resolveSubstrate: () => substrate },
    );

    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0]!.result.delivered, [sent.message.id]);
  });
});

test("dispatchBuzDrains skips idle bees with an empty queue (no lock churn, no outcomes)", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { lastObservedState: "idle_with_output" });
    let drained = 0;
    const outcomes = await dispatchBuzDrains([recipient], [], {
      resolveSubstrate: () => fakeSubstrate(),
      drain: async () => {
        drained += 1;
        return { delivered: [], quarantined: [], errors: [] };
      },
    });
    assert.equal(outcomes.length, 0);
    assert.equal(drained, 0);
  });
});

test("dispatchBuzDrains does NOT drain when transition target is not idle_with_output", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender, tier: "queue", body: "x" });

    const sendCalls: string[] = [];
    const substrate = fakeSubstrate({ sendText: async (_t, text) => { sendCalls.push(text); } });

    const outcomes = await dispatchBuzDrains(
      [recipient],
      [{ name: recipient.name, from: "active", to: "active" }],
      { resolveSubstrate: () => substrate },
    );

    assert.equal(outcomes.length, 0);
    assert.equal(sendCalls.length, 0);
    // Message remains in queue/.
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).length, 1);
  });
});

test("dispatchBuzDrains delivers queued messages in id order across two senders, one per tick", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const sent: { id: string; injected: string }[] = [];
    for (const body of ["m1", "m2", "m3"]) {
      const r = await sendBuzMessage({ recipient, sender, tier: "queue", body });
      sent.push({ id: r.message.id, injected: formatBuzInjection(r.message) });
      await new Promise((r) => setTimeout(r, 5));
    }

    const calls: string[] = [];
    const substrate = fakeSubstrate({ sendText: async (_t, text) => { calls.push(text); } });
    const delivered: string[] = [];
    // One message per idle observation: three ticks drain three messages, in order.
    for (let tick = 0; tick < 3; tick += 1) {
      const outcomes = await dispatchBuzDrains(
        [recipient],
        [{ name: recipient.name, from: "active", to: "idle_with_output" }],
        { resolveSubstrate: () => substrate },
      );
      delivered.push(...outcomes[0]!.result.delivered);
    }

    assert.deepEqual(calls, sent.map((s) => s.injected));
    assert.deepEqual(delivered, sent.map((s) => s.id));
  });
});

test("dispatchBuzDrains stops on first failure; subsequent messages remain in queue", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender, tier: "queue", body: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await sendBuzMessage({ recipient, sender, tier: "queue", body: "second" });
    await new Promise((r) => setTimeout(r, 5));
    await sendBuzMessage({ recipient, sender, tier: "queue", body: "third" });

    let attempts = 0;
    const substrate = fakeSubstrate({
      sendText: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("substrate down");
      },
    });

    const outcomes = await dispatchBuzDrains(
      [recipient],
      [{ name: recipient.name, from: "active", to: "idle_with_output" }],
      { resolveSubstrate: () => substrate },
    );

    // Only ONE attempt happened — the dispatcher stopped on first failure.
    assert.equal(attempts, 1);
    assert.equal(outcomes[0]!.result.delivered.length, 0);
    assert.equal(outcomes[0]!.result.errors.length, 1);
    // All three messages are still in queue/ (the failure leaves the file
    // in place; the other two were never attempted).
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).filter((f) => f.endsWith(".md")).length, 3);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 0);
  });
});

test("dispatchBuzDrains: next tick retries a previously failed message while the bee stays idle", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa", { lastObservedState: "idle_with_output" });
    await sendBuzMessage({ recipient, sender, tier: "queue", body: "retry-me" });

    let fail = true;
    const substrate = fakeSubstrate({
      sendText: async () => {
        if (fail) throw new Error("substrate down");
      },
    });

    // First tick: the bee transitions into idle_with_output, drain fails.
    await dispatchBuzDrains(
      [recipient],
      [{ name: recipient.name, from: "active", to: "idle_with_output" }],
      { resolveSubstrate: () => substrate },
    );
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).filter((f) => f.endsWith(".md")).length, 1);

    // Second tick: substrate recovers. The bee is still idle — there is no
    // new transition — and the drain retries on current state alone.
    fail = false;
    const outcomes = await dispatchBuzDrains([recipient], [], { resolveSubstrate: () => substrate });
    assert.equal(outcomes[0]!.result.delivered.length, 1);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).filter((f) => f.endsWith(".md")).length, 0);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 1);
  });
});

test("daemon delivery never quarantines a valid message for transient runtime failures", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.retry", { lastObservedState: "idle_with_output" });
    await sendBuzMessage({ recipient, sender, tier: "queue", body: "must survive recovery" });
    const substrate = fakeSubstrate({ sendText: async () => { throw new Error("runner unavailable"); } });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await dispatchBuzDrains([recipient], [], { resolveSubstrate: () => substrate });
    }

    assert.equal((await listMessages(recipient.name, "queue")).length, 1);
    assert.equal((await listMessages(recipient.name, "quarantine")).length, 0);
  });
});

test("dispatchBuzDrains drains independently across multiple bees", async () => {
  await withTempStore(async () => {
    const a = makeRecord("CO.aaa");
    const b = makeRecord("CO.bbb");
    await sendBuzMessage({ recipient: a, sender, tier: "queue", body: "for-a" });
    await sendBuzMessage({ recipient: b, sender, tier: "queue", body: "for-b" });

    const calls: Array<{ target: string; text: string }> = [];
    const substrate = fakeSubstrate({
      sendText: async (target, text) => { calls.push({ target, text }); },
    });

    const outcomes = await dispatchBuzDrains(
      [a, b],
      [
        { name: a.name, from: "active", to: "idle_with_output" },
        { name: b.name, from: "active", to: "idle_with_output" },
      ],
      { resolveSubstrate: () => substrate },
    );

    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0]!.result.delivered.length, 1);
    assert.equal(outcomes[1]!.result.delivered.length, 1);
    const targets = new Set(calls.map((c) => c.target));
    assert.equal(targets.has(a.tmuxTarget), true);
    assert.equal(targets.has(b.tmuxTarget), true);
  });
});

test("dispatchBuzDrains captures resolveSubstrate exceptions per bee without aborting", async () => {
  await withTempStore(async () => {
    const a = makeRecord("CO.aaa");
    const b = makeRecord("CO.bbb");
    await sendBuzMessage({ recipient: a, sender, tier: "queue", body: "for-a" });
    await sendBuzMessage({ recipient: b, sender, tier: "queue", body: "for-b" });

    const substrate = fakeSubstrate();
    const outcomes = await dispatchBuzDrains(
      [a, b],
      [
        { name: a.name, from: "active", to: "idle_with_output" },
        { name: b.name, from: "active", to: "idle_with_output" },
      ],
      {
        resolveSubstrate: (record) => {
          if (record.name === "CO.aaa") throw new Error("no substrate for aaa");
          return substrate;
        },
      },
    );

    assert.equal(outcomes.length, 2);
    // a failed with no delivery; b still drained.
    const aaa = outcomes.find((o) => o.recipient === "CO.aaa")!;
    const bbb = outcomes.find((o) => o.recipient === "CO.bbb")!;
    assert.equal(aaa.result.delivered.length, 0);
    assert.equal(aaa.result.errors.length, 1);
    assert.equal(bbb.result.delivered.length, 1);
  });
});

// ─── per-bee lock ─────────────────────────────────────────────────────────

test("dispatchBuzDrains serializes concurrent drains for the same bee", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender, tier: "queue", body: "only-one" });

    // The substrate's sendText sleeps so the two drains overlap on the
    // shared lock. If the lock works, only one of them delivers; the other
    // sees an empty queue.
    let activeSends = 0;
    let maxConcurrent = 0;
    const substrate = fakeSubstrate({
      sendText: async () => {
        activeSends += 1;
        maxConcurrent = Math.max(maxConcurrent, activeSends);
        await new Promise((r) => setTimeout(r, 60));
        activeSends -= 1;
      },
    });

    const trigger = [{ name: recipient.name, from: "active" as BeeState, to: "idle_with_output" as BeeState }];
    const [outA, outB] = await Promise.all([
      dispatchBuzDrains([recipient], trigger, { resolveSubstrate: () => substrate }),
      dispatchBuzDrains([recipient], trigger, { resolveSubstrate: () => substrate }),
    ]);

    // sendText was never called concurrently for the same bee.
    assert.equal(maxConcurrent, 1);
    // Exactly one drain delivered the single message; the other found
    // queue/ empty (because the first call moved it to inbox/ atomically).
    const delivered = [...outA, ...outB].flatMap((o) => o.result.delivered);
    assert.equal(delivered.length, 1);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 1);
  });
});

// ─── integration with tick() ──────────────────────────────────────────────

function buildTickDeps(args: {
  records: SessionRecord[];
  liveTargets: Set<string>;
  panes?: Map<string, string>;
  now?: number;
  observedDispatchInputs?: Array<{ records: SessionRecord[]; transitions: TickTransition[] }>;
  outcomes?: Array<{ recipient: string; result: { delivered: string[]; quarantined: string[]; errors: { id: string; message: string }[] } }>;
}): TickDeps {
  const probe: ProbeResult = { liveTargets: args.liveTargets, unreachableNodes: new Set() };
  return {
    listSessions: async () => args.records,
    listNodes: async () => [],
    probeNodes: async () => probe,
    capturePanes: async () => args.panes ?? new Map(),
    sealedBeeNames: async () => new Set(),
    touchSession: async () => null,
    appendLedger: async () => undefined,
    dispatchBuzDrain: args.observedDispatchInputs
      ? async (records, transitions) => {
          args.observedDispatchInputs!.push({ records, transitions });
          return args.outcomes ?? [];
        }
      : undefined,
    now: () => args.now ?? Date.parse("2026-06-03T10:00:00.000Z"),
  };
}

test("tick invokes dispatchBuzDrain with records + transitions and surfaces outcomes", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const lastPromptAt = new Date(NOW - 60_000).toISOString();
    const record = makeRecord("alpha", { tmuxTarget: "hive:alpha", lastPromptAt });
    const observedInputs: Array<{ records: SessionRecord[]; transitions: TickTransition[] }> = [];
    const deps = buildTickDeps({
      records: [record],
      liveTargets: new Set([record.tmuxTarget]),
      panes: new Map([[record.tmuxTarget, "done\n\n❯ next task"]]),
      now: NOW,
      observedDispatchInputs: observedInputs,
      outcomes: [{ recipient: "alpha", result: { delivered: ["m-1"], quarantined: [], errors: [] } }],
    });
    const previous = new Map<string, BeeState>([[record.name, "active"]]);
    const result = await tick(deps, previous);

    assert.equal(observedInputs.length, 1);
    assert.equal(observedInputs[0]!.records.length, 1);
    assert.equal(observedInputs[0]!.transitions.length, 1);
    assert.deepEqual(observedInputs[0]!.transitions[0], { name: "alpha", from: "active", to: "idle_with_output" });
    assert.equal(result.buzDrains.length, 1);
    assert.equal(result.buzDrains[0]!.recipient, "alpha");
    assert.deepEqual(result.buzDrains[0]!.result.delivered, ["m-1"]);
  });
});

test("tick: dispatchBuzDrain throw is captured into errors[] and does not abort", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const lastPromptAt = new Date(NOW - 60_000).toISOString();
    const record = makeRecord("alpha", { tmuxTarget: "hive:alpha", lastPromptAt });
    const deps: TickDeps = {
      listSessions: async () => [record],
      listNodes: async () => [],
      probeNodes: async () => ({ liveTargets: new Set([record.tmuxTarget]), unreachableNodes: new Set() }),
      capturePanes: async () => new Map([[record.tmuxTarget, "done\n\n❯ next task"]]),
      sealedBeeNames: async () => new Set(),
      touchSession: async () => null,
      appendLedger: async () => undefined,
      dispatchBuzDrain: async () => { throw new Error("dispatcher boom"); },
      now: () => NOW,
    };
    const previous = new Map<string, BeeState>([[record.name, "active"]]);
    const result = await tick(deps, previous);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /dispatcher boom/);
    assert.equal(result.buzDrains.length, 0);
    // Tick still observed state.
    assert.equal(result.observed.get(record.name), "idle_with_output");
  });
});

test("tick with no dispatchBuzDrain dep does not call buz drainer (default deps not wired)", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const lastPromptAt = new Date(NOW - 60_000).toISOString();
    const record = makeRecord("alpha", { tmuxTarget: "hive:alpha", lastPromptAt });
    const deps = buildTickDeps({
      records: [record],
      liveTargets: new Set([record.tmuxTarget]),
      panes: new Map([[record.tmuxTarget, "done\n\n❯ next task"]]),
      now: NOW,
    });
    const previous = new Map<string, BeeState>([[record.name, "active"]]);
    const result = await tick(deps, previous);
    assert.equal(result.buzDrains.length, 0);
  });
});

// ─── ledger sanity ────────────────────────────────────────────────────────

test("dispatchBuzDrains: delivered message has deliveredAt in inbox file", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    await sendBuzMessage({ recipient, sender, tier: "queue", body: "hi" });

    const substrate = fakeSubstrate();
    await dispatchBuzDrains(
      [recipient],
      [{ name: recipient.name, from: "active", to: "idle_with_output" }],
      { resolveSubstrate: () => substrate },
    );

    const files = await readdir(beeMailboxDir(recipient.name, "inbox"));
    assert.equal(files.length, 1);
    const text = await readFile(join(beeMailboxDir(recipient.name, "inbox"), files[0]!), "utf8");
    const message = parseBuzMessage(text);
    assert.ok(message.deliveredAt, "deliveredAt should be set after drain");
    assert.equal(message.deliveredAs, "queue");
  });
});
