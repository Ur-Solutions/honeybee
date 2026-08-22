/**
 * The spawn-failure budget (contract §4.2 `spawn_failed`, spec 01 B5, spec 03
 * contrary-evidence clearing): a bee whose runtime dies during boot must not
 * loop crash → send_wake → revive unboundedly. Every wake is a fresh command,
 * so B5's per-command attempts never accumulate — the budget therefore lives
 * on the BEE (`spawnFailures`), counts consecutive boot exits across
 * wake-driven revives, defers the next wake on the B5 backoff table, and at
 * `maxAttempts` sets `spawn_failed` and suppresses wakes until a successful
 * boot or an operator revive resets it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openCoreStore, replayAudit, type CoreStore } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

/** Current generation exits during boot (the store must be `booting`). */
function bootCrash(store: CoreStore, beeId: string, cause: "crashed" | "clean" = "crashed"): number {
  const rt = store.currentRuntime(beeId);
  if (!rt) throw new Error("no runtime");
  assert.equal(rt.state, "booting", "bootCrash precondition");
  store.updateRuntimeState(beeId, rt.generation, "stopped", { exitCause: cause });
  return rt.generation;
}

test("budget.1: exits during booting count on ONE per-bee budget; the next wake is deferred on the B5 backoff table", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  // A clock the test advances by hand, so the backoff arithmetic is exact.
  const clock = { now: 1_000_000 };
  const store = openCoreStore(h.path, { now: () => clock.now, maxAttempts: 4, backoffBaseMs: 100, ephemeral: true });
  const { bee } = makeBee(store);
  assert.equal(bee.spawnFailures, 0);
  // gen 1 is booting (live) so this send enqueues no wake; the pending mail is
  // what makes every later boot exit revive-worthy.
  assert.equal(store.send(bee.id, "hello").wakeCommand, null);

  const expectedBackoff = [100, 200, 400]; // base × 2^(n-1) for n = 1..3
  for (let n = 1; n <= 3; n++) {
    clock.now += 10;
    bootCrash(store, bee.id);
    const failedAt = store.currentRuntime(bee.id)!.updatedAt;
    assert.equal(failedAt, clock.now);
    assert.equal(store.getBee(bee.id)?.spawnFailures, n, `failure ${n} counted`);
    assert.deepEqual(store.activeFlags(bee.id), [], `below budget after ${n} failures: no flag`);
    // The wake for the next revive is deferred: not immediately claimable.
    clock.now += 5;
    const wake = store.enqueueWake(bee.id);
    assert.equal(wake.outcome, "enqueued");
    assert.equal(wake.command?.enqueuedAt, clock.now);
    assert.equal(wake.command?.nextAttemptAt, failedAt + expectedBackoff[n - 1]!);
    // Idempotent: a second sweep / another send finds the pending wake.
    assert.equal(store.enqueueWake(bee.id).outcome, "pending");
    assert.equal(store.send(bee.id, `m${n}`).wakeCommand?.id, wake.command?.id);
    // Not claimable until the backoff elapses.
    assert.equal(store.claimNextCommand(), null, "wake is deferred, not claimable yet");
    clock.now = wake.command!.nextAttemptAt - 1;
    assert.equal(store.claimNextCommand(), null);
    clock.now = wake.command!.nextAttemptAt;
    const claimed = store.claimNextCommand();
    assert.equal(claimed?.id, wake.command?.id);
    store.completeCommand(claimed!.id);
    store.reviveBee(bee.id); // what the executor does with the wake
  }
  // Fourth consecutive boot exit = the budget (maxAttempts 4): flag set, wakes suppressed.
  clock.now += 10;
  bootCrash(store, bee.id, "clean"); // a clean exit during boot is a boot failure too
  assert.equal(store.getBee(bee.id)?.spawnFailures, 4);
  const flags = store.activeFlags(bee.id);
  assert.deepEqual(flags.map((f) => f.flag), ["spawn_failed"]);
  assert.match(flags[0]!.detail, /4 times in a row/);
  assert.equal(store.view(bee.id).blocked, true);
  assert.equal(store.view(bee.id).reachable, true, "flagged ≠ unreachable: mail stays durable");
  const suppressed = store.enqueueWake(bee.id);
  assert.equal(suppressed.outcome, "suppressed");
  assert.equal(suppressed.command, null);
  const late = store.send(bee.id, "still here?");
  assert.equal(late.wakeCommand, null, "send() enqueues no wake while spawn_failed is set");
  assert.equal(store.undeliveredMessages(bee.id).length, 5, "every message is still durable");
  assert.equal(store.listCommands({ beeId: bee.id, status: "queued" }).length, 0, "nothing left to revive with");
  // Audit replay reproduces the counter, the flag and the deferred wakes.
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("budget.1b: a prompt-less boot failure retries on the same bounded policy", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const clock = { now: 1_000_000 };
  const store = openCoreStore(h.path, {
    now: () => clock.now,
    maxAttempts: 2,
    backoffBaseMs: 100,
    ephemeral: true,
  });
  const { bee } = makeBee(store);

  bootCrash(store, bee.id);
  assert.equal(store.enqueueWake(bee.id).outcome, "no_mail");
  const retry = store.enqueueBootRetry(bee.id);
  assert.equal(retry.outcome, "enqueued");
  assert.equal(retry.command?.nextAttemptAt, clock.now + 100);
  assert.equal(store.enqueueBootRetry(bee.id).outcome, "pending");

  clock.now = retry.command!.nextAttemptAt;
  const claimed = store.claimNextCommand();
  assert.equal(claimed?.id, retry.command?.id);
  store.completeCommand(claimed!.id);
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  assert.deepEqual(store.activeFlags(bee.id).map((flag) => flag.flag), ["spawn_failed"]);
  assert.equal(store.enqueueBootRetry(bee.id).outcome, "suppressed");
  store.close();
});

test("budget.2: a crash after running/idle is NOT a spawn failure; system/user stops and machine restarts during boot do not count", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open({ maxAttempts: 2, backoffBaseMs: 100 });
  const { bee } = makeBee(store);
  // gen 1 boots fine, then crashes mid-turn: budget untouched, wake immediate.
  store.updateRuntimeState(bee.id, 1, "running", { pid: 10, pidStartedAt: 1 });
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  assert.equal(store.getBee(bee.id)?.spawnFailures, 0);
  const res = store.send(bee.id, "again");
  assert.equal(res.wakeCommand?.nextAttemptAt, res.wakeCommand?.enqueuedAt, "no backoff without boot failures");
  // gen 2: idle then clean exit → still 0.
  store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, 2, "running", { pid: 11, pidStartedAt: 2 });
  store.updateRuntimeState(bee.id, 2, "idle");
  store.updateRuntimeState(bee.id, 2, "stopped", { exitCause: "clean" });
  assert.equal(store.getBee(bee.id)?.spawnFailures, 0);
  // Stops during boot that are not the process dying on its own do not count.
  store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, 3, "stopped", { exitCause: "stopped_by_system" }); // boot-hang policy
  store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, 4, "stopped", { exitCause: "stopped_by_user" });
  store.reviveBee(bee.id);
  store.reconcileAtBoot([]); // gen 5 booting, pid unknown → machine_restart (B7)
  assert.equal(store.currentRuntime(bee.id)?.exitCause, "machine_restart");
  assert.equal(store.getBee(bee.id)?.spawnFailures, 0);
  assert.deepEqual(store.activeFlags(bee.id), []);
  // Only genuine boot exits count — and two of them (maxAttempts 2) flag.
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  assert.deepEqual(store.activeFlags(bee.id).map((f) => f.flag), ["spawn_failed"]);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("budget.3: contrary evidence — a successful boot resets the counter and clears spawn_failed; an operator revive resets it explicitly", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open({ maxAttempts: 2, backoffBaseMs: 100 });
  const { bee } = makeBee(store);
  store.send(bee.id, "work");
  bootCrash(store, bee.id);
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  assert.deepEqual(store.activeFlags(bee.id).map((f) => f.flag), ["spawn_failed"]);
  assert.equal(store.enqueueWake(bee.id).outcome, "suppressed");

  // Operator revive: counter reset + flag cleared (audited), idempotent.
  assert.deepEqual(store.resetSpawnFailures(bee.id, "operator revive"), { applied: true });
  assert.equal(store.getBee(bee.id)?.spawnFailures, 0);
  assert.deepEqual(store.activeFlags(bee.id), []);
  assert.deepEqual(store.resetSpawnFailures(bee.id), { applied: false });
  // Wakes flow again, immediately (no stale backoff after a reset).
  const wake = store.enqueueWake(bee.id);
  assert.equal(wake.outcome, "enqueued");
  assert.equal(wake.command?.nextAttemptAt, wake.command?.enqueuedAt);

  // Fresh budget: one more boot exit is below the budget again.
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  assert.equal(store.getBee(bee.id)?.spawnFailures, 1);
  assert.deepEqual(store.activeFlags(bee.id), []);

  // Success is the natural clearer: booting → running resets everything.
  store.reviveBee(bee.id);
  const gen = store.currentRuntime(bee.id)!.generation;
  store.updateRuntimeState(bee.id, gen, "running", { pid: 42, pidStartedAt: 7 });
  assert.equal(store.getBee(bee.id)?.spawnFailures, 0);
  const resets = store.auditRows().filter((r) => r.kind === "bee.spawn_failures" && r.payload.spawnFailures === 0);
  assert.equal(resets.length, 2, "one reset per operator revive, one per successful boot (no-op resets are silent)");

  // And a flag set by the budget clears on the very next successful boot.
  store.updateRuntimeState(bee.id, gen, "stopped", { exitCause: "crashed" }); // after running: not counted
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  assert.deepEqual(store.activeFlags(bee.id).map((f) => f.flag), ["spawn_failed"]);
  store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, store.currentRuntime(bee.id)!.generation, "running", { pid: 43, pidStartedAt: 8 });
  assert.deepEqual(store.activeFlags(bee.id), [], "booted clears spawn_failed (spec 03)");
  assert.equal(store.getBee(bee.id)?.spawnFailures, 0);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("budget.4: the counter and the suppression survive a store close/reopen (daemon restart)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open({ maxAttempts: 3, backoffBaseMs: 100 });
  const { bee } = makeBee(store);
  store.send(bee.id, "persist me");
  bootCrash(store, bee.id);
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  assert.equal(store.getBee(bee.id)?.spawnFailures, 2);
  store.close();

  store = h.open({ maxAttempts: 3, backoffBaseMs: 100 });
  store.reconcileAtBoot([]); // nothing live; gen 2 already stopped
  assert.equal(store.getBee(bee.id)?.spawnFailures, 2, "counter persisted across reopen");
  // The third boot exit after the restart exhausts the budget — the restart
  // did not hand out a fresh one.
  store.reviveBee(bee.id);
  bootCrash(store, bee.id);
  assert.deepEqual(store.activeFlags(bee.id).map((f) => f.flag), ["spawn_failed"]);
  store.close();

  store = h.open({ maxAttempts: 3, backoffBaseMs: 100 });
  assert.equal(store.enqueueWake(bee.id).outcome, "suppressed", "suppression persisted across reopen");
  assert.equal(store.send(bee.id, "more").wakeCommand, null);
  store.close();
});

test("budget.8 (v9 synthetic boot): a synthetic booting→running never resets the budget; its crashed/clean exit counts like a booting exit; recordBootEvidence is the contrary evidence", (t) => {
  // The 2026-08-18 soak loop: a readyAtSpawn harness (claude) spawns fine,
  // dies instantly with zero output. The driver-minted synthetic booted moved
  // the store to running, which — pre-fix — reset spawn_failures every
  // generation, so the crash → wake → revive loop never converged.
  const h = harness();
  t.after(() => h.cleanup());
  // Large backoff base: the helper clock advances 1s per call, so the
  // deferral must dominate that drift to be observable.
  const store = h.open({ maxAttempts: 3, backoffBaseMs: 60_000 });
  const { bee } = makeBee(store);
  store.send(bee.id, "hello");
  assert.equal(store.currentRuntime(bee.id)?.bootEvidence, null, "no evidence while booting");

  // Failure 1: plain booting exit (baseline, unchanged).
  bootCrash(store, bee.id);
  assert.equal(store.getBee(bee.id)?.spawnFailures, 1);

  // Failure 2: gen 2 goes running on a SYNTHETIC booted, then crashes.
  store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, 2, "running", { pid: 10, pidStartedAt: 1, synthetic: true });
  assert.equal(store.getBee(bee.id)?.spawnFailures, 1, "REGRESSION: the synthetic booted must not reset the counter");
  assert.equal(store.currentRuntime(bee.id)?.bootEvidence, "synthetic");
  store.updateRuntimeState(bee.id, 2, "stopped", { exitCause: "crashed" });
  assert.equal(store.getBee(bee.id)?.spawnFailures, 2, "a synthetic-running crash counts like a booting exit");
  // The next wake sits on the B5 backoff table exactly like a booting exit.
  const wake = store.enqueueWake(bee.id);
  assert.equal(wake.outcome, "enqueued");
  assert.ok(wake.command!.nextAttemptAt > wake.command!.enqueuedAt, "backoff applies");

  // Failure 3: a CLEAN exit from synthetic-running counts too → budget → flag.
  store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, 3, "running", { pid: 11, pidStartedAt: 2, synthetic: true });
  store.updateRuntimeState(bee.id, 3, "stopped", { exitCause: "clean" });
  assert.equal(store.getBee(bee.id)?.spawnFailures, 3);
  assert.deepEqual(store.activeFlags(bee.id).map((f) => f.flag), ["spawn_failed"]);
  assert.equal(store.enqueueWake(bee.id).outcome, "suppressed");

  // Operator revive resets as before; then REAL evidence upgrades gen 4:
  // the crash afterwards is an ordinary post-running crash, uncounted.
  store.resetSpawnFailures(bee.id, "operator revive");
  store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, 4, "running", { pid: 12, pidStartedAt: 3, synthetic: true });
  const ev = store.recordBootEvidence(bee.id, 4);
  assert.equal(ev.applied, true);
  assert.equal(store.currentRuntime(bee.id)?.bootEvidence, "real");
  assert.deepEqual(store.recordBootEvidence(bee.id, 4), { applied: false }, "idempotent");
  store.updateRuntimeState(bee.id, 4, "stopped", { exitCause: "crashed" });
  assert.equal(store.getBee(bee.id)?.spawnFailures, 0, "real evidence made this a normal post-running crash");
  assert.deepEqual(store.activeFlags(bee.id), []);
  const immediate = store.enqueueWake(bee.id);
  assert.equal(immediate.command?.nextAttemptAt, immediate.command?.enqueuedAt, "no backoff after real evidence");
  assert.deepEqual(store.recordBootEvidence(bee.id, 4), { applied: false }, "stopped runtime: silent no-op");
  assert.deepEqual(store.recordBootEvidence(bee.id, 99), { applied: false }, "stale generation: silent no-op");

  // Evidence may also land while still `booting` (a real booted parsed before
  // the daemon applies the transition): it resets the counter right there,
  // and spawn_failed clears with it.
  store.reviveBee(bee.id);
  bootCrash(store, bee.id); // failures 1
  store.reviveBee(bee.id);
  assert.equal(store.getBee(bee.id)?.spawnFailures, 1);
  const gen = store.currentRuntime(bee.id)!.generation;
  assert.equal(store.recordBootEvidence(bee.id, gen).applied, true);
  assert.equal(store.getBee(bee.id)?.spawnFailures, 0);
  assert.equal(store.currentRuntime(bee.id)?.bootEvidence, "real");
  store.updateRuntimeState(bee.id, gen, "running", { pid: 13, pidStartedAt: 4, synthetic: true });
  assert.equal(store.currentRuntime(bee.id)?.bootEvidence, "real", "real is sticky — never downgraded to synthetic");

  // Audit replay reproduces the evidence column, the counter and the flags.
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});
