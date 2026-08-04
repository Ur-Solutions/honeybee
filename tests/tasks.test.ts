import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { beeMailboxDir, sendBuzMessage } from "../src/buz.js";
import { saveSession, type SessionRecord } from "../src/store.js";
import {
  addTask,
  claimTask,
  editTask,
  findTaskById,
  formatListId,
  generateTaskId,
  isTaskId,
  listTaskLists,
  listTasks,
  markTaskQueuedForFeed,
  markTaskStalled,
  moveTask,
  parseListId,
  parseTask,
  parseTaskContext,
  recordTaskBuzMessage,
  resolveTaskAuto,
  revertTaskFeed,
  serializeTask,
  transitionTask,
  type HiveTask,
  type TaskListId,
} from "../src/tasks.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-tasks-"));
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

const USER = { kind: "user", sender: "tormod" } as const;
const BEE_LIST: TaskListId = { kind: "bee", name: "CL.aaa" };

// ──────────────────────────────────────────────────────────────────────────
// Ids + list ids.
// ──────────────────────────────────────────────────────────────────────────

test("generateTaskId produces task_-prefixed UUIDv7 ids and accepts legacy ids", () => {
  const id = generateTaskId(1700000000000);
  assert.match(id, /^task_018bcfe5-6800-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(isTaskId(id), true);
  assert.equal(isTaskId("task_00001KZ5P6CKM-9ad70d"), true);
  assert.equal(isTaskId("task_018bcfe5-6800-4abc-8def-0123456789ab"), false);
  assert.equal(isTaskId("msg-nope"), false);
});

test("parseListId: bare name means bee:<name>", () => {
  assert.deepEqual(parseListId("CL.aaa"), { kind: "bee", name: "CL.aaa" });
  assert.deepEqual(parseListId("bee:CL.aaa"), { kind: "bee", name: "CL.aaa" });
  assert.deepEqual(parseListId("shared:review"), { kind: "shared", name: "review" });
  assert.equal(formatListId(parseListId("worker-1")), "bee:worker-1");
});

test("parseListId rejects unknown kinds and unsafe names", () => {
  assert.throws(() => parseListId("colony:x"), /Unknown task list kind/);
  assert.throws(() => parseListId("bee:"), /Invalid task list name/);
  assert.throws(() => parseListId("bee:../escape"), /Invalid task list name/);
  assert.throws(() => parseListId(""), /must not be empty/);
});

// ──────────────────────────────────────────────────────────────────────────
// Serialization round-trip.
// ──────────────────────────────────────────────────────────────────────────

test("serializeTask/parseTask round-trips every field", () => {
  const task: HiveTask = {
    id: generateTaskId(),
    list: "bee:CL.aaa",
    title: "make the button red: urgently",
    body: "Some markdown\n\n```js\ncode();\n```\n",
    context: { kind: "browser-comment", payload: { n: 1, comment: "too blue" } },
    origin: { kind: "user", sender: "tormod" },
    auto: true,
    status: "queued",
    claimedBy: "CL.aaa",
    order: 15,
    questId: "quest-9",
    buzMessageId: "ABC123-fff",
    fedAt: "2026-07-24T10:00:00.000Z",
    stalledAt: "2026-07-24T10:05:00.000Z",
    blockedReason: "waiting on: design",
    createdAt: "2026-07-24T09:00:00.000Z",
    updatedAt: "2026-07-24T10:05:00.000Z",
    closedAt: "2026-07-24T11:00:00.000Z",
  };
  const parsed = parseTask(serializeTask(task));
  assert.deepEqual(parsed, task);
});

test("parseTask drops a malformed context but keeps the task", () => {
  const task: HiveTask = {
    id: generateTaskId(),
    list: "bee:CL.aaa",
    title: "t",
    origin: USER,
    auto: false,
    status: "pending",
    order: 10,
    createdAt: "2026-07-24T09:00:00.000Z",
    updatedAt: "2026-07-24T09:00:00.000Z",
  };
  const withBadContext = serializeTask(task).replace("\nupdatedAt:", '\ncontext: "{broken"\nupdatedAt:');
  assert.match(withBadContext, /context: /);
  const parsed = parseTask(withBadContext);
  assert.equal(parsed.id, task.id);
  assert.equal(parsed.context, undefined);
});

test("parseTaskContext enforces shape and size bound", () => {
  assert.throws(() => parseTaskContext("nope"), /JSON object/);
  assert.throws(() => parseTaskContext({ payload: 1 }), /string `kind`/);
  assert.throws(() => parseTaskContext({ kind: "text", blob: "x".repeat(70 * 1024) }), /exceeds/);
  assert.deepEqual(parseTaskContext({ kind: "text" }), { kind: "text" });
});

// ──────────────────────────────────────────────────────────────────────────
// Provenance → auto defaults.
// ──────────────────────────────────────────────────────────────────────────

test("resolveTaskAuto: user defaults true, respects flags", () => {
  assert.deepEqual(resolveTaskAuto(USER, undefined), { auto: true });
  assert.deepEqual(resolveTaskAuto(USER, false), { auto: false });
  assert.deepEqual(resolveTaskAuto(USER, true), { auto: true });
});

test("resolveTaskAuto: bee-origin is always false; --auto ignored with warning", () => {
  const origin = { kind: "bee", sender: "CL.bbb" } as const;
  assert.deepEqual(resolveTaskAuto(origin, undefined), { auto: false });
  const promoted = resolveTaskAuto(origin, true);
  assert.equal(promoted.auto, false);
  assert.match(promoted.warning ?? "", /bee-origin/);
});

test("resolveTaskAuto: self-origin is never auto", () => {
  const origin = { kind: "self", sender: "CL.aaa" } as const;
  assert.deepEqual(resolveTaskAuto(origin, undefined), { auto: false });
  const promoted = resolveTaskAuto(origin, true);
  assert.equal(promoted.auto, false);
  assert.match(promoted.warning ?? "", /self-origin/);
});

// ──────────────────────────────────────────────────────────────────────────
// Store: add / list / show.
// ──────────────────────────────────────────────────────────────────────────

test("addTask writes a pending task with FIFO order steps", async () => {
  await withTempStore(async () => {
    const a = (await addTask({ list: BEE_LIST, title: "first", origin: USER })).task;
    const b = (await addTask({ list: BEE_LIST, title: "second", origin: USER, body: "detail" })).task;
    assert.equal(a.status, "pending");
    assert.equal(a.auto, true);
    assert.equal(b.order > a.order, true);
    const tasks = await listTasks(BEE_LIST);
    assert.deepEqual(tasks.map((t) => t.title), ["first", "second"]);

    const found = await findTaskById(b.id);
    assert.equal(found?.task.body, "detail");
    assert.equal(found?.list.name, "CL.aaa");
  });
});

test("addTask rejects empty and multi-line titles", async () => {
  await withTempStore(async () => {
    await assert.rejects(addTask({ list: BEE_LIST, title: "  ", origin: USER }), /must not be empty/);
    await assert.rejects(addTask({ list: BEE_LIST, title: "a\nb", origin: USER }), /single line/);
  });
});

test("listTasks filters by status and sorts by order", async () => {
  await withTempStore(async () => {
    const a = (await addTask({ list: BEE_LIST, title: "a", origin: USER })).task;
    await addTask({ list: BEE_LIST, title: "b", origin: USER });
    await transitionTask(BEE_LIST, a.id, "done");
    const pending = await listTasks(BEE_LIST, { statuses: ["pending"] });
    assert.deepEqual(pending.map((t) => t.title), ["b"]);
    const done = await listTasks(BEE_LIST, { statuses: ["done"] });
    assert.deepEqual(done.map((t) => t.title), ["a"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Transitions.
// ──────────────────────────────────────────────────────────────────────────

test("legal transitions: pending→in-progress→done sets closedAt", async () => {
  await withTempStore(async () => {
    const task = (await addTask({ list: BEE_LIST, title: "t", origin: USER })).task;
    const started = await transitionTask(BEE_LIST, task.id, "start");
    assert.equal(started.status, "in-progress");
    const done = await transitionTask(BEE_LIST, task.id, "done");
    assert.equal(done.status, "done");
    assert.equal(typeof done.closedAt, "string");
  });
});

test("illegal transitions throw (done→start, done→done)", async () => {
  await withTempStore(async () => {
    const task = (await addTask({ list: BEE_LIST, title: "t", origin: USER })).task;
    await transitionTask(BEE_LIST, task.id, "done");
    await assert.rejects(transitionTask(BEE_LIST, task.id, "start"), /requires one of/);
    await assert.rejects(transitionTask(BEE_LIST, task.id, "done"), /requires one of/);
  });
});

test("block records the reason; start from blocked reopens", async () => {
  await withTempStore(async () => {
    const task = (await addTask({ list: BEE_LIST, title: "t", origin: USER })).task;
    const blocked = await transitionTask(BEE_LIST, task.id, "block", { reason: "waiting on review" });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockedReason, "waiting on review");
    assert.equal(typeof blocked.closedAt, "string");
    const reopened = await transitionTask(BEE_LIST, task.id, "start");
    assert.equal(reopened.status, "in-progress");
    assert.equal(reopened.blockedReason, undefined);
    assert.equal(reopened.closedAt, undefined);
  });
});

test("done from queued cancels the carrying buz message and clears buzMessageId", async () => {
  await withTempStore(async () => {
    const record = makeRecord("CL.aaa");
    await saveSession(record);
    const task = (await addTask({ list: BEE_LIST, title: "t", origin: USER })).task;
    const fed = await markTaskQueuedForFeed(BEE_LIST, task.id);
    assert.equal(fed?.status, "queued");
    assert.equal(typeof fed?.fedAt, "string");

    const sent = await sendBuzMessage({
      recipient: record,
      sender: { kind: "human", name: "task-supply" },
      tier: "queue",
      body: "carrier",
    });
    await recordTaskBuzMessage(BEE_LIST, task.id, sent.message.id);

    const queueBefore = await readdir(beeMailboxDir("CL.aaa", "queue"));
    assert.equal(queueBefore.filter((f) => f.endsWith(".md")).length, 1);

    const done = await transitionTask(BEE_LIST, task.id, "done");
    assert.equal(done.status, "done");
    assert.equal(done.buzMessageId, undefined);
    const queueAfter = await readdir(beeMailboxDir("CL.aaa", "queue")).catch(() => [] as string[]);
    assert.equal(queueAfter.filter((f) => f.endsWith(".md")).length, 0);
  });
});

test("cancel from queued with an already-delivered message still closes and clears", async () => {
  await withTempStore(async () => {
    const task = (await addTask({ list: BEE_LIST, title: "t", origin: USER })).task;
    await markTaskQueuedForFeed(BEE_LIST, task.id);
    await recordTaskBuzMessage(BEE_LIST, task.id, "GONE0000000000-abc123");
    const cancelled = await transitionTask(BEE_LIST, task.id, "cancel");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.buzMessageId, undefined);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Claim.
// ──────────────────────────────────────────────────────────────────────────

test("claim takes the top unclaimed pending task atomically", async () => {
  await withTempStore(async () => {
    const list: TaskListId = { kind: "shared", name: "review" };
    const a = (await addTask({ list, title: "a", origin: USER })).task;
    await addTask({ list, title: "b", origin: USER });
    const claimed = await claimTask(list, "CL.aaa");
    assert.equal(claimed?.id, a.id);
    assert.equal(claimed?.status, "in-progress");
    assert.equal(claimed?.claimedBy, "CL.aaa");
  });
});

test("concurrent claims get distinct tasks; exhausted list claims null", async () => {
  await withTempStore(async () => {
    const list: TaskListId = { kind: "shared", name: "review" };
    await addTask({ list, title: "a", origin: USER });
    await addTask({ list, title: "b", origin: USER });
    await addTask({ list, title: "c", origin: USER });

    const claims = await Promise.all([
      claimTask(list, "bee-1"),
      claimTask(list, "bee-2"),
      claimTask(list, "bee-3"),
    ]);
    const ids = claims.map((task) => task?.id);
    assert.equal(ids.every((id) => typeof id === "string"), true);
    assert.equal(new Set(ids).size, 3, "each concurrent claim must win a distinct task");

    assert.equal(await claimTask(list, "bee-4"), null);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// mv / edit.
// ──────────────────────────────────────────────────────────────────────────

test("moveTask --before/--after reorders; anchors validated", async () => {
  await withTempStore(async () => {
    const a = (await addTask({ list: BEE_LIST, title: "a", origin: USER })).task;
    const b = (await addTask({ list: BEE_LIST, title: "b", origin: USER })).task;
    const c = (await addTask({ list: BEE_LIST, title: "c", origin: USER })).task;

    await moveTask(BEE_LIST, c.id, { before: a.id });
    assert.deepEqual((await listTasks(BEE_LIST)).map((t) => t.title), ["c", "a", "b"]);

    await moveTask(BEE_LIST, a.id, { after: b.id });
    assert.deepEqual((await listTasks(BEE_LIST)).map((t) => t.title), ["c", "b", "a"]);

    await moveTask(BEE_LIST, b.id, { before: a.id });
    assert.deepEqual((await listTasks(BEE_LIST)).map((t) => t.title), ["c", "b", "a"]);

    await assert.rejects(moveTask(BEE_LIST, a.id, {}), /exactly one of/);
    await assert.rejects(moveTask(BEE_LIST, a.id, { before: a.id }), /anchor on itself/);
    await assert.rejects(moveTask(BEE_LIST, a.id, { before: generateTaskId() }), /not found/);
  });
});

test("editTask mutates title/body/auto; rejects auto promotion for self-origin", async () => {
  await withTempStore(async () => {
    const task = (await addTask({ list: BEE_LIST, title: "old", origin: USER, autoRequested: false })).task;
    const edited = await editTask(BEE_LIST, task.id, { title: "new", body: "b", auto: true });
    assert.equal(edited.title, "new");
    assert.equal(edited.body, "b");
    assert.equal(edited.auto, true);

    const selfTask = (await addTask({ list: BEE_LIST, title: "mine", origin: { kind: "self", sender: "CL.aaa" } })).task;
    await assert.rejects(editTask(BEE_LIST, selfTask.id, { auto: true }), /self-origin/);
    const demoted = await editTask(BEE_LIST, selfTask.id, { auto: false });
    assert.equal(demoted.auto, false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Feed bookkeeping + stall + lists.
// ──────────────────────────────────────────────────────────────────────────

test("markTaskQueuedForFeed only feeds pending+auto; revert restores pending", async () => {
  await withTempStore(async () => {
    const manual = (await addTask({ list: BEE_LIST, title: "manual", origin: USER, autoRequested: false })).task;
    assert.equal(await markTaskQueuedForFeed(BEE_LIST, manual.id), null);

    const auto = (await addTask({ list: BEE_LIST, title: "auto", origin: USER })).task;
    const fed = await markTaskQueuedForFeed(BEE_LIST, auto.id);
    assert.equal(fed?.status, "queued");
    assert.equal(await markTaskQueuedForFeed(BEE_LIST, auto.id), null, "already queued is not re-fed");

    await revertTaskFeed(BEE_LIST, auto.id);
    const reverted = await findTaskById(auto.id);
    assert.equal(reverted?.task.status, "pending");
    assert.equal(reverted?.task.fedAt, undefined);
  });
});

test("markTaskStalled flags open fed tasks once", async () => {
  await withTempStore(async () => {
    const task = (await addTask({ list: BEE_LIST, title: "t", origin: USER })).task;
    await markTaskQueuedForFeed(BEE_LIST, task.id);
    const stalled = await markTaskStalled(BEE_LIST, task.id);
    assert.equal(typeof stalled?.stalledAt, "string");
    assert.equal(await markTaskStalled(BEE_LIST, task.id), null, "idempotent");
  });
});

test("listTaskLists enumerates bee and shared lists with counts", async () => {
  await withTempStore(async () => {
    await addTask({ list: BEE_LIST, title: "a", origin: USER });
    const done = (await addTask({ list: BEE_LIST, title: "b", origin: USER })).task;
    await transitionTask(BEE_LIST, done.id, "done");
    await addTask({ list: { kind: "shared", name: "review" }, title: "c", origin: USER });

    const lists = await listTaskLists();
    assert.deepEqual(lists.map((l) => l.id), ["bee:CL.aaa", "shared:review"]);
    const bee = lists[0]!;
    assert.equal(bee.total, 2);
    assert.equal(bee.counts.pending, 1);
    assert.equal(bee.counts.done, 1);
  });
});
