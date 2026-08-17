/**
 * The 14 numbered tests from docs/design/specs/reset-01-core.md ("Test list").
 * Each test name carries its spec number.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BeeNotFoundError,
  FLAGS,
  IllegalTransitionError,
  SecondWriterError,
  UnknownFlagError,
  openCoreStore,
  replayAudit,
  type CoreStore,
} from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("spec01.1: send to a bee with no live runtime enqueues send_wake in the same transaction", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });

  const res = store.send(bee.id, "hello");
  assert.equal(res.wakeCommand?.verb, "send_wake");
  assert.equal(res.wakeCommand?.status, "queued");
  assert.equal(res.wakeCommand?.targetGeneration, 1);
  assert.equal(store.undeliveredMessages(bee.id).length, 1);

  // Same transaction: a failing send leaves neither a message nor a command behind.
  const before = store.dumpState();
  assert.throws(() => store.send("no-such-bee", "x"), BeeNotFoundError);
  assert.deepEqual(store.dumpState(), before);

  // A live runtime means no wake is enqueued.
  const { bee: live } = makeBee(store, "live");
  bootToRunning(store, live.id, 111, 5);
  assert.equal(store.send(live.id, "hi").wakeCommand, null);
  store.close();
});

test("spec01.2: send to a deleted bee fails bee-not-found; archived bee auto-unarchives (Q3)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();

  const { bee: gone } = makeBee(store, "gone");
  store.updateRuntimeState(gone.id, 1, "stopped", { exitCause: "clean" });
  store.archiveBee(gone.id);
  store.deleteBee(gone.id);
  assert.throws(() => store.send(gone.id, "hello?"), BeeNotFoundError);

  const { bee: parked } = makeBee(store, "parked");
  store.updateRuntimeState(parked.id, 1, "stopped", { exitCause: "stopped_by_user" });
  store.archiveBee(parked.id);
  const res = store.send(parked.id, "wake up");
  assert.equal(res.unarchived, true);
  assert.equal(store.getBee(parked.id)?.lifecycle, "active");
  assert.equal(store.getBee(parked.id)?.archivedAt, null);
  assert.equal(res.wakeCommand?.verb, "send_wake"); // revive-on-message everywhere
  store.close();
});

test("spec01.3: a message undelivered at crash is delivered exactly once to the next generation", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 42, 7);
  const { message } = store.send(bee.id, "important");
  store.close(); // crash before delivery

  store = h.open();
  store.reconcileAtBoot([]); // machine restarted; pid 42 gone
  assert.equal(store.currentRuntime(bee.id)?.state, "stopped");
  assert.equal(store.currentRuntime(bee.id)?.exitCause, "machine_restart");

  const gen2 = store.reviveBee(bee.id);
  assert.equal(gen2.generation, 2);
  assert.deepEqual(store.undeliveredMessages(bee.id).map((m) => m.id), [message.id]);

  assert.equal(store.markDelivered(message.id, 2).applied, true);
  assert.equal(store.undeliveredMessages(bee.id).length, 0);
  assert.equal(store.markDelivered(message.id, 2).applied, false); // never twice
  assert.equal(store.getMessage(message.id)?.deliveredGeneration, 2);
  store.close();
});

test("spec01.4: stop for generation 1 no-ops after revival to generation 2", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 10, 1);
  const stop = store.enqueueCommand("stop", bee.id);
  assert.equal(stop.targetGeneration, 1);

  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  store.reviveBee(bee.id); // generation 2

  assert.equal(store.claimNextCommand(), null); // stop settled moot, nothing claimable
  assert.equal(store.getCommand(stop.id)?.status, "done"); // moot, not failed
  assert.ok(store.auditRows().some((r) => r.kind === "command.moot" && r.payload.commandId === stop.id));
  store.close();
});

test("spec01.5: crash mid-command — on boot the command replays and settles idempotently", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 20, 2);
  const stop = store.enqueueCommand("stop", bee.id);
  assert.equal(store.claimNextCommand()?.id, stop.id); // running
  store.close(); // crash mid-execution

  store = h.open(); // boot: running → queued
  assert.equal(store.getCommand(stop.id)?.status, "queued");
  assert.ok(store.auditRows().some((r) => r.kind === "command.boot_requeued"));

  const replayed = store.claimNextCommand();
  assert.equal(replayed?.id, stop.id);
  assert.equal(store.completeCommand(stop.id).applied, true);
  assert.equal(store.completeCommand(stop.id).applied, false); // idempotent settle
  assert.equal(store.getCommand(stop.id)?.status, "done");
  store.close();
});

test("spec01.6: reboot reconciliation marks every stale runtime stopped(machine_restart), never failed", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  const { bee: survivor } = makeBee(store, "survivor");
  bootToRunning(store, survivor.id, 100, 5);
  const { bee: booter } = makeBee(store, "booter"); // booting, no pid yet
  const { bee: idler } = makeBee(store, "idler");
  bootToRunning(store, idler.id, 200, 9);
  store.updateRuntimeState(idler.id, 1, "idle");
  const { bee: reused } = makeBee(store, "pid-reused");
  bootToRunning(store, reused.id, 300, 1);
  store.close();

  store = h.open();
  const result = store.reconcileAtBoot([
    { pid: 100, startedAt: 5 },
    { pid: 300, startedAt: 2 }, // same pid, different start time: NOT our runtime
  ]);
  assert.deepEqual(result.adopted, [{ beeId: survivor.id, generation: 1, pid: 100 }]);
  assert.deepEqual(
    result.stopped.map((s) => s.beeId).sort(),
    [booter.id, idler.id, reused.id].sort(),
  );
  assert.equal(store.currentRuntime(survivor.id)?.state, "running");
  for (const beeId of [booter.id, idler.id, reused.id]) {
    const rt = store.currentRuntime(beeId);
    assert.equal(rt?.state, "stopped");
    assert.equal(rt?.exitCause, "machine_restart");
  }
  // Zero failed states: no failed commands, no flags, every bee unblocked.
  assert.equal(store.listCommands({ status: "failed" }).length, 0);
  for (const view of store.views()) {
    assert.equal(view.blocked, false);
    assert.deepEqual(view.flags, []);
  }
  store.close();
});

test("spec01.7: state update for a stale generation is audited and ignored", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  store.reviveBee(bee.id); // generation 2 current

  const res = store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
  assert.equal(res.applied, false);
  const gen1 = store.listRuntimes(bee.id).find((r) => r.generation === 1);
  assert.equal(gen1?.state, "stopped"); // unchanged
  const stale = store.auditRows().filter((r) => r.kind === "runtime.stale_update");
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.payload.generation, 1);
  assert.equal(stale[0]?.payload.currentGeneration, 2);
  store.close();
});

test("spec01.8: lifecycle transitions outside B1's graph throw", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);

  assert.throws(() => store.unarchiveBee(bee.id), IllegalTransitionError); // active → active
  store.archiveBee(bee.id);
  assert.throws(() => store.archiveBee(bee.id), IllegalTransitionError); // archived → archived
  store.unarchiveBee(bee.id);
  store.archiveBee(bee.id);
  store.deleteBee(bee.id);
  // deleted is terminal: the record is gone, every verb is bee-not-found.
  assert.throws(() => store.archiveBee(bee.id), BeeNotFoundError);
  assert.throws(() => store.unarchiveBee(bee.id), BeeNotFoundError);
  assert.throws(() => store.deleteBee(bee.id), BeeNotFoundError);

  // Runtime graph is equally closed (B2).
  const { bee: b2 } = makeBee(store, "rt");
  assert.throws(() => store.updateRuntimeState(b2.id, 1, "idle"), IllegalTransitionError); // booting → idle
  bootToRunning(store, b2.id, 1, 1);
  assert.throws(() => store.updateRuntimeState(b2.id, 1, "booting"), IllegalTransitionError);
  store.updateRuntimeState(b2.id, 1, "stopped", { exitCause: "clean" });
  assert.throws(() => store.updateRuntimeState(b2.id, 1, "running"), IllegalTransitionError); // out of stopped
  store.close();
});

test("spec01.9: unknown flag write throws; the four known flags set/clear with causes", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);

  assert.throws(() => store.setFlag(bee.id, "wedged", "nope"), UnknownFlagError);
  assert.throws(() => store.clearFlag(bee.id, "zombie"), UnknownFlagError);

  for (const flag of FLAGS) {
    const row = store.setFlag(bee.id, flag, `cause: ${flag}`);
    assert.equal(row.detail, `cause: ${flag}`);
  }
  assert.deepEqual(store.activeFlags(bee.id).map((f) => f.flag), [...FLAGS]);
  assert.equal(store.view(bee.id).blocked, true);

  for (const flag of FLAGS) {
    assert.equal(store.clearFlag(bee.id, flag, "resolved").applied, true);
  }
  assert.deepEqual(store.activeFlags(bee.id), []);
  assert.equal(store.view(bee.id).blocked, false);
  for (const f of store.dumpState().flags) assert.ok(f.clearedAt != null && f.clearedAt >= f.setAt);
  store.close();
});

test("spec01.10: retry exhaustion on spawn sets spawn_failed and stops retrying", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open({ maxAttempts: 3, backoffBaseMs: 10 });
  const { bee } = makeBee(store);
  const spawn = store.enqueueCommand("spawn", bee.id);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const claimed = store.claimNextCommand();
    assert.equal(claimed?.id, spawn.id);
    const res = store.reportCommandFailure(spawn.id, "spawn_failed", "runtime exited during boot");
    assert.equal(res.attempts, attempt);
    assert.equal(res.status, attempt < 3 ? "queued" : "failed");
  }

  assert.equal(store.getCommand(spawn.id)?.status, "failed");
  assert.equal(store.getCommand(spawn.id)?.failureCause, "spawn_failed");
  assert.deepEqual(store.activeFlags(bee.id).map((f) => f.flag), ["spawn_failed"]);
  assert.equal(store.view(bee.id).blocked, true);
  assert.equal(store.claimNextCommand(), null); // stopped retrying
  store.close();
});

test("spec01.11: derived reads — stopped bee is reachable and waiting-for-you iff unread output exists", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);

  assert.equal(store.view(bee.id).working, true); // booting
  bootToRunning(store, bee.id, 50, 3);
  assert.equal(store.view(bee.id).working, true); // running

  store.recordOutput(bee.id);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_user" });
  let view = store.view(bee.id);
  assert.equal(view.reachable, true); // stopped is reachable — sending revives it
  assert.equal(view.working, false);
  assert.equal(view.waitingForYou, true); // unread output exists

  store.markOutputRead(bee.id);
  view = store.view(bee.id);
  assert.equal(view.waitingForYou, false); // no unread output
  assert.equal(view.reachable, true);

  store.reviveBee(bee.id);
  bootToRunning(store, bee.id, 51, 4);
  store.updateRuntimeState(bee.id, 2, "idle");
  assert.equal(store.view(bee.id).waitingForYou, true); // idle always waits

  store.updateRuntimeState(bee.id, 2, "stopped", { exitCause: "clean" });
  store.archiveBee(bee.id);
  assert.equal(store.view(bee.id).reachable, true); // archived ≠ deleted
  store.deleteBee(bee.id);
  const goneView = store.view(bee.id);
  assert.equal(goneView.exists, false);
  assert.equal(goneView.reachable, false); // reachable ⇔ lifecycle ≠ deleted
  store.close();
});

test("spec01.12: two writer connections — second fails loudly, store stays consistent", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const first = h.open();
  const { bee } = makeBee(first, "held");

  assert.throws(() => openCoreStore(h.path, { now: h.now }), SecondWriterError); // loud

  // First writer is unaffected and consistent.
  first.send(bee.id, "still fine");
  assert.equal(first.undeliveredMessages(bee.id).length, 1);
  first.close();

  // After release, a new writer opens and sees consistent state.
  const second = h.open();
  assert.equal(second.getBee(bee.id)?.name, "held");
  assert.equal(second.undeliveredMessages(bee.id).length, 1);
  second.close();
});

test("spec01.13: audit rows exist for every write — replaying audit reproduces state", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open({ maxAttempts: 2, backoffBaseMs: 10 });

  const { bee: a } = makeBee(store, "alpha");
  const { bee: b } = makeBee(store, "beta");
  const { bee: c } = makeBee(store, "gamma");

  bootToRunning(store, a.id, 100, 1);
  store.send(a.id, "one"); // live: no wake
  store.recordOutput(a.id);
  store.updateRuntimeState(a.id, 1, "idle");
  const msg = store.send(a.id, "two", { sender: "bee:beta", priority: 3 });
  store.markDelivered(msg.message.id, 1);
  store.markDelivered(msg.message.id, 1); // deliver_noop
  store.updateRuntimeState(a.id, 1, "stopped", { exitCause: "clean" });
  store.markOutputRead(a.id);

  store.updateRuntimeState(b.id, 1, "stopped", { exitCause: "crashed" });
  store.send(b.id, "wake"); // enqueues send_wake
  store.send(b.id, "wake again"); // deduped wake
  store.reviveBee(b.id);
  store.updateRuntimeState(b.id, 1, "running", { pid: 5, pidStartedAt: 5 }); // stale: audited no-op
  store.setFlag(b.id, "auth_needed", "login expired");
  store.setFlag(b.id, "auth_needed", "login expired again"); // re-set updates detail
  store.clearFlag(b.id, "auth_needed", "re-authed");
  store.clearFlag(b.id, "node_unreachable"); // clear_noop

  const spawn = store.enqueueCommand("spawn", c.id);
  store.claimNextCommand(); // moot-settles b's send_wake (gen moved 1→2), claims spawn
  store.reportCommandFailure(spawn.id, "spawn_failed"); // requeue (attempt 1)
  const claimedAgain = store.claimNextCommand();
  assert.equal(claimedAgain?.id, spawn.id);
  store.reportCommandFailure(spawn.id, "spawn_failed"); // exhausted → failed + flag
  store.archiveBee(c.id);
  store.unarchiveBee(c.id);
  const pending = store.enqueueCommand("archive", c.id);
  store.claimNextCommand(); // pending archive → running
  store.close(); // crash with a running command

  store = h.open({ maxAttempts: 2, backoffBaseMs: 10 }); // boot: requeue running
  store.reconcileAtBoot([]); // b gen2 booting → stopped(machine_restart)
  store.archiveBee(c.id);
  store.deleteBee(c.id); // settles the pending archive command, removes rows

  assert.ok(pending.id > 0);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

// spec01.14 lives in spec01-fuzz.test.ts
