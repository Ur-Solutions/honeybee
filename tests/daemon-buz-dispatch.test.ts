import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beeMailboxDir,
  parseBuzMessage,
  sendBuzMessage,
  type BuzSender,
} from "../src/buz.js";
import { dispatchBuzDrains, selectBuzDispatchTriggers } from "../src/daemon/buzDispatcher.js";
import { tick, type ProbeResult, type TickDeps, type TickTransition } from "../src/daemon/run.js";
import type { BeeState } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import type { Substrate } from "../src/substrates/index.js";

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

function fakeSubstrate(impl: Partial<Substrate> = {}): Substrate {
  const base: Substrate = {
    kind: "local-tmux",
    node: "local",
    probe: async () => ({ ok: true }),
    hasSession: async () => true,
    newSession: async () => undefined,
    kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [],
    listSessionStates: async () => new Map<string, string>(),
    setUserOptions: async () => undefined,
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

test("selectBuzDispatchTriggers ignores transitions for unknown records", async () => {
  const transitions: TickTransition[] = [
    { name: "ghost", from: "active", to: "idle_with_output" },
  ];
  const triggers = await selectBuzDispatchTriggers([], transitions, queueNonEmpty);
  assert.equal(triggers.length, 0);
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

    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0]!.result.delivered, [a.message.id, b.message.id]);
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).length, 0);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 2);
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
    assert.deepEqual(calls, ["while-idle"]);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "queue"))).filter((f) => f.endsWith(".md")).length, 0);
    assert.equal((await readdir(beeMailboxDir(recipient.name, "inbox"))).length, 1);
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

test("dispatchBuzDrains delivers queued messages in id order across two senders", async () => {
  await withTempStore(async () => {
    const recipient = makeRecord("CO.aaa");
    const sent: { id: string; body: string }[] = [];
    for (const body of ["m1", "m2", "m3"]) {
      const r = await sendBuzMessage({ recipient, sender, tier: "queue", body });
      sent.push({ id: r.message.id, body });
      await new Promise((r) => setTimeout(r, 5));
    }

    const calls: string[] = [];
    const substrate = fakeSubstrate({ sendText: async (_t, text) => { calls.push(text); } });
    const outcomes = await dispatchBuzDrains(
      [recipient],
      [{ name: recipient.name, from: "active", to: "idle_with_output" }],
      { resolveSubstrate: () => substrate },
    );

    assert.deepEqual(calls, sent.map((s) => s.body));
    assert.deepEqual(outcomes[0]!.result.delivered, sent.map((s) => s.id));
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
