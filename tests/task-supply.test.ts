import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { beeMailboxDir, parseBuzMessage, processQueueForBee, sendBuzMessage } from "../src/buz.js";
import { createTaskSupplyDispatcher } from "../src/daemon/taskSupplyDispatcher.js";
import type { BeeState } from "../src/state.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { Substrate } from "../src/substrates/index.js";
import {
  addTask,
  buildTaskFeedBody,
  evaluateSupplyGate,
  findTaskById,
  DEFAULT_TASK_SUPPLY_LIMIT,
  resolveTaskSupply,
  TASK_FEED_PROMPT_MARKER,
  transitionTask,
  type HiveTask,
  type SupplyGateInput,
  type TaskListId,
} from "../src/tasks.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-task-supply-"));
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
    id: name,
    ...overrides,
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

function mkTask(overrides: Partial<HiveTask> = {}): HiveTask {
  return {
    id: `task_0000000000000-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`,
    list: "bee:CL.aaa",
    title: "t",
    origin: { kind: "user", sender: "tormod" },
    auto: true,
    status: "pending",
    order: 10,
    createdAt: "2026-07-24T09:00:00.000Z",
    updatedAt: "2026-07-24T09:00:00.000Z",
    ...overrides,
  };
}

function gateInput(overrides: Partial<SupplyGateInput> = {}): SupplyGateInput {
  return {
    supply: { on: true, limit: 5, feeds: 0, paused: false },
    needsInput: false,
    buzQueueEmpty: true,
    tasks: [mkTask()],
    ...overrides,
  };
}

const IDLE = new Map<string, BeeState>([["CL.aaa", "idle_with_output" as BeeState]]);

// ──────────────────────────────────────────────────────────────────────────
// The six-condition gate (pure).
// ──────────────────────────────────────────────────────────────────────────

test("gate feeds the top eligible task when all six conditions hold", () => {
  const low = mkTask({ order: 5, title: "low" });
  const high = mkTask({ order: 20, title: "high" });
  const decision = evaluateSupplyGate(gateInput({ tasks: [high, low] }));
  assert.equal(decision.feed?.title, "low", "lowest order wins");
});

test("gate condition 1: supply off blocks", () => {
  const decision = evaluateSupplyGate(gateInput({ supply: { on: false, limit: 5, feeds: 0, paused: false } }));
  assert.deepEqual(decision, { feed: null, reason: "supply-off" });
});

test("gate condition 2: needs_input blocks", () => {
  const decision = evaluateSupplyGate(gateInput({ needsInput: true }));
  assert.deepEqual(decision, { feed: null, reason: "needs-input" });
});

test("gate condition 3: non-empty buz queue blocks", () => {
  const decision = evaluateSupplyGate(gateInput({ buzQueueEmpty: false }));
  assert.deepEqual(decision, { feed: null, reason: "buz-queue-not-empty" });
});

test("gate condition 4: a queued task blocks; an auto-fed in-progress task blocks", () => {
  const queued = evaluateSupplyGate(gateInput({ tasks: [mkTask(), mkTask({ status: "queued", fedAt: "x" })] }));
  assert.deepEqual(queued, { feed: null, reason: "task-in-flight" });

  const fedInProgress = evaluateSupplyGate(gateInput({ tasks: [mkTask(), mkTask({ status: "in-progress", fedAt: "x" })] }));
  assert.deepEqual(fedInProgress, { feed: null, reason: "task-in-flight" });

  // A MANUALLY started task (no fedAt) does not block the gate.
  const manualInProgress = evaluateSupplyGate(gateInput({ tasks: [mkTask({ title: "next" }), mkTask({ status: "in-progress" })] }));
  assert.equal(manualInProgress.feed?.title, "next");
});

test("gate condition 5: no pending+auto task blocks", () => {
  const none = evaluateSupplyGate(gateInput({ tasks: [] }));
  assert.deepEqual(none, { feed: null, reason: "no-eligible-task" });
  const manualOnly = evaluateSupplyGate(gateInput({ tasks: [mkTask({ auto: false })] }));
  assert.deepEqual(manualOnly, { feed: null, reason: "no-eligible-task" });
  const closedOnly = evaluateSupplyGate(gateInput({ tasks: [mkTask({ status: "done" })] }));
  assert.deepEqual(closedOnly, { feed: null, reason: "no-eligible-task" });
});

test("gate condition 6: breaker blocks at the limit and when paused", () => {
  const atLimit = evaluateSupplyGate(gateInput({ supply: { on: true, limit: 3, feeds: 3, paused: false } }));
  assert.deepEqual(atLimit, { feed: null, reason: "breaker" });
  const paused = evaluateSupplyGate(gateInput({ supply: { on: true, limit: 5, feeds: 0, paused: true } }));
  assert.deepEqual(paused, { feed: null, reason: "breaker" });
  const underLimit = evaluateSupplyGate(gateInput({ supply: { on: true, limit: 3, feeds: 2, paused: false } }));
  assert.notEqual(underLimit.feed, null);
});

// ──────────────────────────────────────────────────────────────────────────
// Fed-message marker format.
// ──────────────────────────────────────────────────────────────────────────

test("buildTaskFeedBody: marker line, JSON payload line, instruction line", () => {
  const task = mkTask({
    id: "task_0000000000000-aaaaaa",
    title: "make it red",
    body: "detail",
    context: { kind: "browser-comment", payload: { n: 1 } },
    questId: "q1",
  });
  const body = buildTaskFeedBody(task, 3);
  const [markerLine, payloadLine, blank, instruction] = body.split("\n");
  assert.equal(markerLine, TASK_FEED_PROMPT_MARKER);
  const payload = JSON.parse(payloadLine!);
  assert.deepEqual(payload, {
    version: 1,
    id: "task_0000000000000-aaaaaa",
    list: "bee:CL.aaa",
    title: "make it red",
    body: "detail",
    context: { kind: "browser-comment", payload: { n: 1 } },
    origin: { kind: "user", sender: "tormod" },
    questId: "q1",
  });
  assert.equal(blank, "");
  assert.match(instruction!, /hive task done task_0000000000000-aaaaaa/);
  assert.match(instruction!, /hive task block task_0000000000000-aaaaaa/);
  assert.match(instruction!, /holds 3 more/);
});

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher: feed → queued task + one queue-tier buz message + counter.
// ──────────────────────────────────────────────────────────────────────────

const LIST: TaskListId = { kind: "bee", name: "CL.aaa" };

test("dispatcher feeds ONE task per idle tick and records the buz message", async () => {
  await withTempStore(async () => {
    const record = makeRecord("CL.aaa", { taskSupply: { on: true } });
    await saveSession(record);
    const a = (await addTask({ list: LIST, title: "first", origin: { kind: "user", sender: "tormod" } })).task;
    await addTask({ list: LIST, title: "second", origin: { kind: "user", sender: "tormod" } });

    const dispatch = createTaskSupplyDispatcher();
    const outcomes = await dispatch([record], IDLE, []);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.action, "fed");
    assert.equal(outcomes[0]!.taskId, a.id);
    assert.equal(outcomes[0]!.feeds, 1);

    const fed = await findTaskById(a.id);
    assert.equal(fed?.task.status, "queued");
    assert.equal(typeof fed?.task.fedAt, "string");
    assert.equal(fed?.task.buzMessageId, outcomes[0]!.buzMessageId);

    const queueFiles = (await readdir(beeMailboxDir("CL.aaa", "queue"))).filter((f) => f.endsWith(".md"));
    assert.equal(queueFiles.length, 1, "exactly one carrying buz message");
    const message = parseBuzMessage(await readFile(join(beeMailboxDir("CL.aaa", "queue"), queueFiles[0]!), "utf8"));
    assert.equal(message.deliveredAs, "queue");
    assert.deepEqual(message.from, { kind: "human", name: "task-supply" });
    assert.match(message.body, new RegExp(`^${TASK_FEED_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(message.body, /holds 1 more/);

    const stored = await loadSession("CL.aaa");
    assert.equal(resolveTaskSupply(stored!).feeds, 1);

    // Second tick: the carrying message is still queued → condition 3 blocks;
    // no second feed, no stall counting.
    const second = await dispatch([await loadSession("CL.aaa") ?? record], IDLE, []);
    assert.deepEqual(second, []);
  });
});

test("dispatcher: a tick whose drain delivered never also feeds", async () => {
  await withTempStore(async () => {
    const record = makeRecord("CL.aaa", { taskSupply: { on: true } });
    await saveSession(record);
    const first = (await addTask({ list: LIST, title: "waiting", origin: { kind: "user", sender: "tormod" } })).task;
    const dispatch = createTaskSupplyDispatcher();
    const outcomes = await dispatch([record], IDLE, [
      { recipient: "CL.aaa", result: { delivered: ["some-msg"], quarantined: [], errors: [] } },
    ]);
    assert.deepEqual(outcomes, []);
    assert.equal((await findTaskById(first.id))?.task.status, "pending", "nothing fed on a delivery tick");
  });
});

test("dispatcher respects supply-off default and non-idle bees", async () => {
  await withTempStore(async () => {
    const record = makeRecord("CL.aaa"); // no taskSupply config → off
    await saveSession(record);
    await addTask({ list: LIST, title: "t", origin: { kind: "user", sender: "tormod" } });
    const dispatch = createTaskSupplyDispatcher();
    assert.deepEqual(await dispatch([record], IDLE, []), []);

    const on = makeRecord("CL.aaa", { taskSupply: { on: true } });
    const busy = new Map<string, BeeState>([["CL.aaa", "active" as BeeState]]);
    assert.deepEqual(await dispatch([on], busy, []), []);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Breaker: count, trip, reset.
// ──────────────────────────────────────────────────────────────────────────

async function deliverQueue(record: SessionRecord): Promise<void> {
  await processQueueForBee(record, {
    transport: { substrate: fakeSubstrate(), tmuxTarget: record.tmuxTarget },
  });
}

test("breaker trips at the limit; task supply --on semantics clear it", async () => {
  await withTempStore(async () => {
    const record = makeRecord("CL.aaa", { taskSupply: { on: true, limit: 2 } });
    await saveSession(record);
    for (const title of ["a", "b", "c"]) {
      await addTask({ list: LIST, title, origin: { kind: "user", sender: "tormod" } });
    }
    const dispatch = createTaskSupplyDispatcher();

    // Feed 1.
    const first = await dispatch([record], IDLE, []);
    assert.equal(first[0]?.action, "fed");
    assert.equal(first[0]?.breakerTripped, undefined);
    await deliverQueue(record);
    await transitionTask(LIST, first[0]!.taskId!, "done");

    // Feed 2 hits the limit → trip.
    const fresh1 = (await loadSession("CL.aaa"))!;
    const second = await dispatch([fresh1], IDLE, []);
    assert.equal(second[0]?.action, "fed");
    assert.equal(second[0]?.feeds, 2);
    assert.equal(second[0]?.breakerTripped, true);
    await deliverQueue(record);
    await transitionTask(LIST, second[0]!.taskId!, "done");

    // Feed 3 blocked: paused.
    const fresh2 = (await loadSession("CL.aaa"))!;
    assert.equal(resolveTaskSupply(fresh2).paused, true);
    assert.deepEqual(await dispatch([fresh2], IDLE, []), []);
  });
});

test("a human-sender buz send resets the consecutive-feed counter (task-supply sender does not)", async () => {
  await withTempStore(async () => {
    const record = makeRecord("CL.aaa", { taskSupply: { on: true, limit: 5, feeds: 3 } });
    await saveSession(record);

    // The supply loop's own sender name must NOT reset the counter.
    await sendBuzMessage({ recipient: record, sender: { kind: "human", name: "task-supply" }, tier: "passive", body: "fed" });
    assert.equal(resolveTaskSupply((await loadSession("CL.aaa"))!).feeds, 3);

    // A bee sender must not reset it either.
    await sendBuzMessage({ recipient: record, sender: { kind: "bee", id: "CL.bbb" }, tier: "passive", body: "hi" });
    assert.equal(resolveTaskSupply((await loadSession("CL.aaa"))!).feeds, 3);

    // A real human sender resets it.
    const fresh = (await loadSession("CL.aaa"))!;
    await sendBuzMessage({ recipient: fresh, sender: { kind: "human", name: "tormod" }, tier: "passive", body: "steer" });
    assert.equal(resolveTaskSupply((await loadSession("CL.aaa"))!).feeds, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Stalled marking.
// ──────────────────────────────────────────────────────────────────────────

test("an open fed task stalls after one grace idle tick (and only once)", async () => {
  await withTempStore(async () => {
    const record = makeRecord("CL.aaa", { taskSupply: { on: true } });
    await saveSession(record);
    const task = (await addTask({ list: LIST, title: "t", origin: { kind: "user", sender: "tormod" } })).task;
    const dispatch = createTaskSupplyDispatcher();

    // Tick 1: feed.
    const fed = await dispatch([record], IDLE, []);
    assert.equal(fed[0]?.action, "fed");
    // The carrying message is delivered (drain), simulating harness consumption.
    await deliverQueue(record);

    // Tick 2: first open-idle observation = grace, no outcome, no stall.
    const fresh = (await loadSession("CL.aaa"))!;
    assert.deepEqual(await dispatch([fresh], IDLE, []), []);
    assert.equal((await findTaskById(task.id))?.task.stalledAt, undefined);

    // Tick 3: second open-idle observation → stalled.
    const outcomes = await dispatch([fresh], IDLE, []);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.action, "stalled");
    assert.equal(outcomes[0]?.taskId, task.id);
    assert.equal(typeof (await findTaskById(task.id))?.task.stalledAt, "string");

    // Tick 4: already stalled → nothing new, and nothing more is fed
    // (condition 4 still blocks on the open fed task).
    assert.deepEqual(await dispatch([fresh], IDLE, []), []);
  });
});

test("closing the fed task reopens the gate on the next idle tick", async () => {
  await withTempStore(async () => {
    const record = makeRecord("CL.aaa", { taskSupply: { on: true } });
    await saveSession(record);
    const first = (await addTask({ list: LIST, title: "first", origin: { kind: "user", sender: "tormod" } })).task;
    const second = (await addTask({ list: LIST, title: "second", origin: { kind: "user", sender: "tormod" } })).task;
    const dispatch = createTaskSupplyDispatcher();

    const t1 = await dispatch([record], IDLE, []);
    assert.equal(t1[0]?.taskId, first.id);
    await deliverQueue(record);
    await transitionTask(LIST, first.id, "done");

    const fresh = (await loadSession("CL.aaa"))!;
    const t2 = await dispatch([fresh], IDLE, []);
    assert.equal(t2[0]?.action, "fed");
    assert.equal(t2[0]?.taskId, second.id);
  });
});

test("DEFAULT_TASK_SUPPLY_LIMIT is 5 and resolveTaskSupply defaults are off", () => {
  assert.equal(DEFAULT_TASK_SUPPLY_LIMIT, 5);
  assert.deepEqual(resolveTaskSupply({}), { on: false, limit: 5, feeds: 0, paused: false });
  assert.deepEqual(
    resolveTaskSupply({ taskSupply: { on: true, limit: 2, feeds: 1, paused: true } }),
    { on: true, limit: 2, feeds: 1, paused: true },
  );
});
