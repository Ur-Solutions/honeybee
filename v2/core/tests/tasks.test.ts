/**
 * Schema v11 — agent task lists: add/transition/claim/move/edit, auto-supply
 * gate + feed via mailbox, breaker reset on human send, audit replay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CoreError,
  TASK_FEED_PROMPT_MARKER,
  TASK_SUPPLY_SENDER_NAME,
  TaskNotFoundError,
  beeTaskList,
  evaluateSupplyGate,
  replayAudit,
} from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("tasks.add: user origin defaults auto; self never auto; bee origin ignores --auto; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    const user = store.addTask({
      list: beeTaskList(bee.id),
      title: "paint the button",
      originKind: "user",
      originSender: "operator",
    });
    assert.equal(user.task.status, "pending");
    assert.equal(user.task.auto, true);
    assert.equal(user.task.list, beeTaskList(bee.id));
    assert.equal(user.warning, undefined);

    const self = store.addTask({
      list: beeTaskList(bee.id),
      title: "own plan",
      originKind: "self",
      originSender: bee.id,
      autoRequested: true,
    });
    assert.equal(self.task.auto, false);
    assert.match(self.warning ?? "", /self-origin/);

    const peer = store.addTask({
      list: beeTaskList(bee.id),
      title: "from another bee",
      originKind: "bee",
      originSender: "other",
      autoRequested: true,
    });
    assert.equal(peer.task.auto, false);
    assert.match(peer.warning ?? "", /bee-origin/);

    assert.throws(() => store.addTask({ list: beeTaskList(bee.id), title: "", originKind: "user", originSender: "operator" }), CoreError);
    assert.throws(
      () => store.addTask({ list: beeTaskList(bee.id), title: "a\nb", originKind: "user", originSender: "operator" }),
      CoreError,
    );
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.transition: start/done/block/cancel; queued close cancels carrying mail; start reopens blocked", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    const { task } = store.addTask({
      list: beeTaskList(bee.id),
      title: "do it",
      originKind: "user",
      originSender: "operator",
    });
    const started = store.transitionTask(task.id, "start");
    assert.equal(started.status, "in-progress");
    const blocked = store.transitionTask(task.id, "block", { reason: "need a decision" });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockedReason, "need a decision");
    assert.ok(blocked.closedAt);
    const reopened = store.transitionTask(task.id, "start");
    assert.equal(reopened.status, "in-progress");
    assert.equal(reopened.blockedReason, null);
    assert.equal(reopened.closedAt, null);
    const done = store.transitionTask(task.id, "done");
    assert.equal(done.status, "done");
    assert.throws(() => store.transitionTask(task.id, "start"), CoreError);
    assert.throws(() => store.transitionTask("nope", "done"), TaskNotFoundError);

    store.setTaskSupply(bee.id, { on: true });
    const { task: auto } = store.addTask({
      list: beeTaskList(bee.id),
      title: "auto one",
      originKind: "user",
      originSender: "operator",
    });
    const fed = store.tryFeedTaskSupply(bee.id);
    assert.ok(fed);
    assert.equal(fed.fed.id, auto.id);
    assert.equal(fed.fed.status, "queued");
    assert.ok(fed.fed.mailboxMessageId);
    assert.equal(store.undeliveredMessages(bee.id).length, 1);
    const canceled = store.transitionTask(auto.id, "cancel");
    assert.equal(canceled.status, "cancelled");
    assert.equal(canceled.mailboxMessageId, null);
    assert.equal(store.undeliveredMessages(bee.id).length, 0);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.claim/move/edit: claim takes top unclaimed; move bisects; edit respects self auto lock", () => {
  const h = harness();
  try {
    const store = h.open();
    const a = store.addTask({ list: "shared:backlog", title: "first", originKind: "user", originSender: "operator" }).task;
    const b = store.addTask({ list: "shared:backlog", title: "second", originKind: "user", originSender: "operator" }).task;
    assert.ok(a.order < b.order);
    const moved = store.moveTask(b.id, { before: a.id });
    assert.ok(moved.order < a.order);
    const claimed = store.claimTask("shared:backlog", "worker");
    assert.equal(claimed?.id, b.id);
    assert.equal(claimed?.claimedBy, "worker");
    assert.equal(claimed?.status, "in-progress");
    assert.equal(store.claimTask("shared:backlog", "other")?.id, a.id);

    const { bee } = makeBee(store, "selfy");
    const self = store.addTask({
      list: beeTaskList(bee.id),
      title: "plan",
      originKind: "self",
      originSender: bee.id,
    }).task;
    const edited = store.editTask(self.id, { title: "plan v2", auto: true });
    assert.equal(edited.title, "plan v2");
    assert.equal(edited.auto, false);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.supply: gate is six conditions; feed is one idle mailbox message; breaker; human send resets feeds", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    bootToRunning(store, bee.id, 11, h.now());
    const { task } = store.addTask({
      list: beeTaskList(bee.id),
      title: "eligible",
      originKind: "user",
      originSender: "operator",
    });
    assert.equal(store.tryFeedTaskSupply(bee.id), null, "supply off");
    store.setTaskSupply(bee.id, { on: true, limit: 2 });

    store.send(bee.id, "human note", { sender: "operator" });
    assert.equal(store.tryFeedTaskSupply(bee.id), null, "mailbox not empty");
    const mail = store.undeliveredMessages(bee.id)[0]!;
    store.cancelMessage(mail.id);

    const fed = store.tryFeedTaskSupply(bee.id);
    assert.ok(fed);
    assert.equal(fed.fed.id, task.id);
    assert.equal(fed.fed.status, "queued");
    assert.equal(fed.supply.feeds, 1);
    assert.equal(fed.supply.paused, false);
    const body = store.getMessage(fed.fed.mailboxMessageId as number)?.body ?? "";
    assert.ok(body.startsWith(TASK_FEED_PROMPT_MARKER));
    assert.equal(store.getMessage(fed.fed.mailboxMessageId as number)?.sender, TASK_SUPPLY_SENDER_NAME);
    assert.equal(store.getMessage(fed.fed.mailboxMessageId as number)?.urgency, "idle");

    store.addTask({
      list: beeTaskList(bee.id),
      title: "next",
      originKind: "user",
      originSender: "operator",
    });
    assert.equal(store.tryFeedTaskSupply(bee.id), null, "task in flight");
    store.transitionTask(task.id, "done");
    // cancel of queued mail already happened on done; remaining undelivered is none
    const fed2 = store.tryFeedTaskSupply(bee.id);
    assert.ok(fed2);
    assert.equal(fed2.supply.feeds, 2);
    assert.equal(fed2.supply.paused, true, "breaker trips at limit");
    store.transitionTask(fed2.fed.id, "done");
    assert.equal(store.tryFeedTaskSupply(bee.id), null, "breaker paused");

    store.send(bee.id, "thanks", { sender: "operator" });
    assert.equal(store.getTaskSupply(bee.id).feeds, 0, "human send resets feeds");
    assert.equal(store.getTaskSupply(bee.id).paused, true, "paused stays until --on");
    store.setTaskSupply(bee.id, { on: true });
    assert.equal(store.getTaskSupply(bee.id).paused, false);
    assert.equal(store.getTaskSupply(bee.id).feeds, 0);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.supply.gate: evaluateSupplyGate is ordered and pure", () => {
  const supply = { beeId: "b", on: true, limit: 5, feeds: 0, paused: false };
  const task = {
    id: "task_1",
    list: "bee:b",
    beeId: "b",
    title: "t",
    body: null,
    context: null,
    originKind: "user" as const,
    originSender: "operator",
    auto: true,
    status: "pending" as const,
    claimedBy: null,
    order: 10,
    questId: null,
    mailboxMessageId: null,
    fedAt: null,
    stalledAt: null,
    blockedReason: null,
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
  };
  assert.equal(evaluateSupplyGate({ supply: { ...supply, on: false }, needsInput: false, mailboxEmpty: true, tasks: [task] }).reason, "supply-off");
  assert.equal(evaluateSupplyGate({ supply, needsInput: true, mailboxEmpty: true, tasks: [task] }).reason, "needs-input");
  assert.equal(evaluateSupplyGate({ supply, needsInput: false, mailboxEmpty: false, tasks: [task] }).reason, "mailbox-not-empty");
  assert.equal(
    evaluateSupplyGate({
      supply,
      needsInput: false,
      mailboxEmpty: true,
      tasks: [{ ...task, status: "queued" }],
    }).reason,
    "task-in-flight",
  );
  assert.equal(evaluateSupplyGate({ supply, needsInput: false, mailboxEmpty: true, tasks: [] }).reason, "no-eligible-task");
  assert.equal(
    evaluateSupplyGate({ supply: { ...supply, paused: true }, needsInput: false, mailboxEmpty: true, tasks: [task] }).reason,
    "breaker",
  );
  assert.equal(evaluateSupplyGate({ supply, needsInput: false, mailboxEmpty: true, tasks: [task] }).feed?.id, "task_1");
});

test("tasks.stall: idle + empty mail + fed in-flight stamps stalledAt once", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    bootToRunning(store, bee.id, 9, h.now());
    const rt = store.currentRuntime(bee.id)!;
    store.updateRuntimeState(bee.id, rt.generation, "idle");
    store.setTaskSupply(bee.id, { on: true });
    store.addTask({ list: beeTaskList(bee.id), title: "one", originKind: "user", originSender: "operator" });
    const fed = store.tryFeedTaskSupply(bee.id);
    assert.ok(fed);
    assert.equal(store.maybeStallFedTask(bee.id), null, "mail still queued");
    store.cancelMessage(fed.fed.mailboxMessageId as number);
    const stalled = store.maybeStallFedTask(bee.id);
    assert.ok(stalled?.stalledAt);
    assert.equal(store.maybeStallFedTask(bee.id), null, "already stalled");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.delete: bee delete cascades tasks and supply; shared lists survive", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    store.addTask({ list: beeTaskList(bee.id), title: "mine", originKind: "user", originSender: "operator" });
    store.setTaskSupply(bee.id, { on: true });
    store.addTask({ list: "shared:keep", title: "ours", originKind: "user", originSender: "operator" });
    store.deleteBee(bee.id);
    assert.equal(store.listTasks({ list: beeTaskList(bee.id) }).length, 0);
    assert.equal(store.listTaskSupply().length, 0);
    assert.equal(store.listTasks({ list: "shared:keep" }).length, 1);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});
