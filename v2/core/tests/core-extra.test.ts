/**
 * Additional coverage beyond the 14 spec tests: edge cases the logic deserves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BeeNotFoundError,
  CommandProtocolError,
  CoreError,
  IllegalTransitionError,
  UnknownFailureCauseError,
  UnknownVerbError,
  openCoreStore,
} from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("send to a live runtime does not enqueue a wake", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  // booting counts as live: the runtime is coming up and will consume the mailbox.
  assert.equal(store.send(bee.id, "early").wakeCommand, null);
  bootToRunning(store, bee.id, 1, 1);
  assert.equal(store.send(bee.id, "mid").wakeCommand, null);
  store.updateRuntimeState(bee.id, 1, "idle");
  assert.equal(store.send(bee.id, "idle").wakeCommand, null);
  assert.equal(store.listCommands({ beeId: bee.id }).length, 0);
  store.close();
});

test("repeat sends to a stopped bee dedupe to one pending send_wake", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  const first = store.send(bee.id, "a").wakeCommand;
  const second = store.send(bee.id, "b").wakeCommand;
  assert.ok(first);
  assert.equal(second?.id, first.id); // bounded queue: same pending wake returned
  assert.equal(store.listCommands({ beeId: bee.id }).length, 1);
  store.close();
});

test("unknown verb and unknown failure cause throw (closed lists)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  assert.throws(() => store.enqueueCommand("kill", bee.id), UnknownVerbError); // kill no longer exists
  assert.throws(() => store.enqueueCommand("retire", bee.id), UnknownVerbError); // neither does retire
  const cmd = store.enqueueCommand("stop", bee.id);
  store.claimNextCommand();
  assert.throws(() => store.reportCommandFailure(cmd.id, "kill_failed"), UnknownFailureCauseError);
  store.close();
});

test("command protocol: settle requires a claim; backoff grows exponentially", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open({ maxAttempts: 5, backoffBaseMs: 1_000_000_000 });
  const { bee } = makeBee(store);
  const cmd = store.enqueueCommand("stop", bee.id);
  assert.throws(() => store.completeCommand(cmd.id), CommandProtocolError);
  assert.throws(() => store.reportCommandFailure(cmd.id, "resource_blocked"), CommandProtocolError);

  store.claimNextCommand();
  const r1 = store.reportCommandFailure(cmd.id, "resource_blocked");
  // Backed off far into the future: not claimable now.
  assert.equal(store.claimNextCommand(), null);
  const requeued = store.getCommand(cmd.id);
  assert.equal(requeued?.status, "queued");
  assert.ok(r1.nextAttemptAt != null && r1.nextAttemptAt > h.now());
  store.close();
});

test("backoff doubles per attempt", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  // Hold the clock still during each call so backoff deltas are exact.
  let tick = 5_000_000;
  const store = openCoreStore(h.path, { now: () => tick, maxAttempts: 5, backoffBaseMs: 8 });
  const { bee } = makeBee(store);
  const cmd = store.enqueueCommand("stop", bee.id);
  const deltas: number[] = [];
  for (let i = 0; i < 3; i++) {
    tick += 100_000; // pass the previous backoff window
    assert.equal(store.claimNextCommand()?.id, cmd.id);
    const res = store.reportCommandFailure(cmd.id, "resource_blocked");
    assert.ok(res.nextAttemptAt != null);
    deltas.push(res.nextAttemptAt - tick);
  }
  assert.deepEqual(deltas, [8, 16, 32]);
  store.close();
});

test("mailbox is per-bee FIFO; priority column is reserved and unused in ordering (Q2)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 9, 9);
  store.send(bee.id, "first", { priority: 0 });
  store.send(bee.id, "second", { priority: 9 }); // higher tier must NOT jump the line today
  store.send(bee.id, "third", { priority: 5 });
  assert.deepEqual(
    store.undeliveredMessages(bee.id).map((m) => m.body),
    ["first", "second", "third"],
  );
  assert.equal(store.undeliveredMessages(bee.id)[1]?.priority, 9); // but the tier is stored
  store.close();
});

test("delivery marks are fenced: stale generation and non-live generation are recorded no-ops", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 4, 4);
  const { message } = store.send(bee.id, "hello");
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  assert.equal(store.markDelivered(message.id, 1).applied, false); // gen 1 not live
  store.reviveBee(bee.id);
  assert.equal(store.markDelivered(message.id, 1).applied, false); // gen 1 stale
  assert.equal(store.markDelivered(message.id, 2).applied, true);
  const noops = store.auditRows().filter((r) => r.kind === "mail.deliver_noop");
  assert.equal(noops.length, 2);
  store.close();
});

test("delete is immediate and total (Q1): rows gone, pending commands settled, log path returned", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = store.createBee({
    name: "doomed",
    agent: "codex",
    substrate: "cell",
    cwd: "/tmp/d",
    sessionLogPath: "/tmp/d/session.log",
    tags: ["x"],
    title: "Doomed",
  });
  bootToRunning(store, bee.id, 77, 7);
  store.send(bee.id, "mail");
  store.setFlag(bee.id, "auth_needed", "x");
  const cmd = store.enqueueCommand("stop", bee.id);
  store.archiveBee(bee.id);

  const res = store.deleteBee(bee.id);
  assert.equal(res.sessionLogPath, "/tmp/d/session.log");
  assert.equal(res.livePid, 77); // caller must reap the process
  assert.deepEqual(res.settledCommandIds, [cmd.id]);
  assert.equal(store.getCommand(cmd.id)?.status, "done"); // moot, not failed

  const dump = store.dumpState();
  assert.deepEqual(dump.bees, []);
  assert.deepEqual(dump.runtimes, []);
  assert.deepEqual(dump.flags, []);
  assert.deepEqual(dump.mailbox, []);
  store.close();
});

test("delete of an active bee passes through archived on B1's graph (audited)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  store.deleteBee(bee.id);
  const kinds = store.auditRows().map((r) => r.kind);
  const archIdx = kinds.lastIndexOf("bee.archived");
  const delIdx = kinds.lastIndexOf("bee.deleted");
  assert.ok(archIdx !== -1 && delIdx === archIdx + 1);
  store.close();
});

test("revive: only from stopped; reviving an archived bee unarchives it", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  assert.throws(() => store.reviveBee(bee.id), IllegalTransitionError); // booting is live
  bootToRunning(store, bee.id, 3, 3);
  assert.throws(() => store.reviveBee(bee.id), IllegalTransitionError);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
  store.archiveBee(bee.id);
  const rt = store.reviveBee(bee.id);
  assert.equal(rt.generation, 2);
  assert.equal(rt.state, "booting");
  assert.equal(store.getBee(bee.id)?.lifecycle, "active");
  store.close();
});

test("exit causes: required on stopped, rejected elsewhere", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  assert.throws(() => store.updateRuntimeState(bee.id, 1, "stopped"), IllegalTransitionError);
  assert.throws(
    () => store.updateRuntimeState(bee.id, 1, "running", { exitCause: "clean", pid: 1, pidStartedAt: 1 }),
    IllegalTransitionError,
  );
  store.close();
});

test("boot requeue touches only running commands", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  const { bee } = makeBee(store);
  const done = store.enqueueCommand("stop", bee.id);
  store.claimNextCommand();
  store.completeCommand(done.id);
  const queued = store.enqueueCommand("archive", bee.id);
  const running = store.enqueueCommand("unarchive", bee.id);
  store.claimNextCommand(); // claims `queued` (archive) — order by id
  store.claimNextCommand(); // claims `running` (unarchive)
  store.completeCommand(queued.id);
  store.close();

  store = h.open();
  assert.equal(store.getCommand(done.id)?.status, "done");
  assert.equal(store.getCommand(queued.id)?.status, "done");
  assert.equal(store.getCommand(running.id)?.status, "queued"); // reverted for replay
  store.close();
});

test("currentRuntime is the highest generation; generations are append-only history", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  for (let generation = 1; generation <= 3; generation++) {
    store.updateRuntimeState(bee.id, generation, "stopped", { exitCause: "crashed" });
    if (generation < 3) store.reviveBee(bee.id);
  }
  assert.equal(store.currentRuntime(bee.id)?.generation, 3);
  assert.deepEqual(store.listRuntimes(bee.id).map((r) => r.generation), [1, 2, 3]);
  assert.ok(store.listRuntimes(bee.id).every((r) => r.state === "stopped"));
  store.close();
});

test("createBee rejects duplicate ids; bee ops on unknown ids are bee-not-found", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  store.createBee({ id: "fixed", name: "a", agent: "claude", substrate: "tmux", cwd: "/t" });
  assert.throws(
    () => store.createBee({ id: "fixed", name: "b", agent: "claude", substrate: "tmux", cwd: "/t" }),
    CoreError,
  );
  assert.throws(() => store.setFlag("ghost", "auth_needed", "x"), BeeNotFoundError);
  assert.throws(() => store.enqueueCommand("stop", "ghost"), BeeNotFoundError);
  assert.throws(() => store.recordOutput("ghost"), BeeNotFoundError);
  store.close();
});

test("claim skips commands whose backoff is still in the future", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open({ maxAttempts: 3, backoffBaseMs: 1_000_000_000 });
  const { bee } = makeBee(store);
  const delayed = store.enqueueCommand("stop", bee.id);
  store.claimNextCommand();
  store.reportCommandFailure(delayed.id, "resource_blocked"); // far-future retry
  const later = store.enqueueCommand("archive", bee.id);
  assert.equal(store.claimNextCommand()?.id, later.id); // delayed one doesn't block the queue
  store.close();
});
