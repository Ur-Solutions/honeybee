/**
 * WP4 unit tier: the DaemonCore loop cores under a controllable fake driver
 * and a virtual clock (spec 04 test plan: "loops against SimDriver — fast,
 * deterministic"). The full six-invariant proof of the shared executor/
 * delivery/hang logic lives in `v2:harness` / `v2:harness:real`, which drive
 * this same DaemonCore through the SimDaemon wrapper; here we pin the WP4
 * additions: scale-to-zero, flag policy, degraded-runtime policy, pid-at-
 * spawn recording, and I1 telemetry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { DaemonCore, type DaemonPolicy, type I1ViolationEvent } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

interface Rig {
  dir: string;
  store: CoreStore;
  driver: FakeDriver;
  core: DaemonCore;
  clock: { now: number };
  violations: I1ViolationEvent[];
  ops: string[];
  cleanup: () => void;
}

function makeRig(policy: Partial<DaemonPolicy> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-loops-"));
  const clock = { now: 1000 };
  const now = (): number => clock.now;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now, maxAttempts: 3, backoffBaseMs: 1 });
  const driver = new FakeDriver(now);
  const violations: I1ViolationEvent[] = [];
  const ops: string[] = [];
  const core = new DaemonCore({
    store,
    driver,
    policy: {
      bootHangTimeoutSteps: 50,
      turnHangTimeoutSteps: 50,
      commandsPerStep: 8,
      ...policy,
    },
    now,
    log: (op) => ops.push(op),
    onI1Violation: (v) => violations.push(v),
  });
  core.boot();
  return {
    dir,
    store,
    driver,
    core,
    clock,
    violations,
    ops,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function spawnIdleBee(rig: Rig, id = "bee-1"): void {
  rig.store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
  rig.store.enqueueCommand("spawn", id);
  rig.core.step(); // execute spawn (driver auto-boots: booted + turn_ended queued)
  rig.core.step(); // drain observations → running → idle
  rig.core.step();
  assert.equal(rig.store.currentRuntime(id)?.state, "idle");
}

test("unit.1: scale-to-zero — idle past the window stops with stopped_by_system; send revives (Q4 + Q3)", () => {
  const rig = makeRig({ idleWindowSteps: 100 });
  try {
    spawnIdleBee(rig);
    // Within the window: nothing happens.
    rig.clock.now += 90;
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    // Past the window: stop enqueued, executed, exit cause stopped_by_system.
    rig.clock.now += 20;
    rig.core.step(); // enqueue + execute stop
    rig.core.step(); // drain exited observation
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.state, "stopped");
    assert.equal(rt?.exitCause, "stopped_by_system");
    // Revive-on-message undoes it.
    const res = rig.store.send("bee-1", "wake up");
    assert.ok(res.wakeCommand, "send to a stopped bee must enqueue send_wake");
    rig.core.step(); // execute send_wake → revive gen 2
    rig.core.step(); // observations → idle
    rig.core.step(); // delivery
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 2);
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("unit.2: scale-to-zero never stops an idle bee with undelivered mail", () => {
  const rig = makeRig({ idleWindowSteps: 100 });
  try {
    spawnIdleBee(rig);
    rig.driver.acceptDeliveries = false; // keep the message pending
    rig.store.send("bee-1", "pending");
    rig.clock.now += 500;
    rig.core.step();
    rig.core.step();
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.state, "idle", "idle bee with pending mail must not be scale-to-zero'd");
    // The moment the mail drains, the window applies again.
    rig.driver.acceptDeliveries = true;
    rig.core.step(); // deliver
    rig.clock.now += 200;
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
  } finally {
    rig.cleanup();
  }
});

test("unit.3: flag policy — adapter evidence sets flags and contrary evidence clears them (spec 03)", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.driver.evidence.push({
      beeId: "bee-1",
      generation: 1,
      flag: "auth_needed",
      action: "set",
      detail: "Not logged in",
    });
    rig.core.step();
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["auth_needed"]);
    // Contrary evidence: a successful authenticated turn clears it.
    rig.driver.evidence.push({
      beeId: "bee-1",
      generation: 1,
      flag: "auth_needed",
      action: "clear",
      detail: "successful authenticated turn",
    });
    rig.core.step();
    assert.equal(rig.store.activeFlags("bee-1").length, 0);
    // Evidence for a deleted bee is skipped, never a crash.
    rig.driver.evidence.push({
      beeId: "ghost",
      generation: 1,
      flag: "resource_blocked",
      action: "set",
      detail: "429",
    });
    rig.core.step();
    assert.ok(rig.ops.some((o) => o.includes("flag.skip bee=ghost")));
  } finally {
    rig.cleanup();
  }
});

test("unit.4: pid-at-spawn recording — procOf lands on the booting runtime row (WP2 amendment)", () => {
  const rig = makeRig();
  try {
    rig.driver.autoBoot = false; // stay in booting: the pid must already be recorded
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    rig.store.enqueueCommand("spawn", "bee-1");
    rig.core.step();
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.state, "booting");
    assert.ok(rt?.pid != null && rt.pid > 0, "pid recorded at spawn, before booted");
    assert.ok(rt?.pidStartedAt != null);
    assert.deepEqual(rig.driver.procOf("bee-1", 1), { pid: rt.pid, pidStartedAt: rt.pidStartedAt });
  } finally {
    rig.cleanup();
  }
});

test("unit.5: degraded-runtime policy — mail for a re-adopted runtime rotates the generation", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.driver.markDegraded("bee-1");
    // No mail: a degraded runtime is left alone.
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 1);
    // Mail arrives: deliver refuses (degraded), policy stops, wake revives gen 2, message lands there.
    const res = rig.store.send("bee-1", "hello survivor");
    rig.core.step(); // degraded policy enqueues stop; executor stops gen 1
    rig.core.step(); // exited observation → stopped → wake enqueued
    rig.core.step(); // send_wake → revive gen 2
    rig.core.step(); // boot observations → idle
    rig.core.step(); // delivery
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.generation, 2);
    assert.equal(rig.store.getMessage(res.message.id)?.deliveredGeneration, 2);
    const gen1 = rig.store.listRuntimes("bee-1").find((r) => r.generation === 1);
    assert.equal(gen1?.exitCause, "stopped_by_system");
    // Zero failed commands, zero flags: rotation is policy, not failure.
    assert.ok(rig.store.listCommands({ status: "failed" }).length === 0);
    assert.equal(rig.store.activeFlags("bee-1").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("unit.6: I1 telemetry — a message undelivered past the deadline is recorded exactly once", () => {
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    spawnIdleBee(rig);
    rig.driver.acceptDeliveries = false;
    const res = rig.store.send("bee-1", "will be late");
    rig.clock.now += 150;
    rig.core.step();
    assert.equal(rig.violations.length, 0, "no violation inside the deadline");
    rig.clock.now += 100;
    rig.core.step();
    rig.core.step();
    assert.equal(rig.violations.length, 1, "breach recorded once, not per tick");
    const v = rig.violations[0];
    assert.equal(v?.beeId, "bee-1");
    assert.equal(v?.messageId, res.message.id);
    assert.equal(v?.enqueuedAt, res.message.enqueuedAt);
    assert.ok((v?.detectedAt ?? 0) > (v?.deadline ?? Infinity - 1));
  } finally {
    rig.cleanup();
  }
});

test("unit.7: I1 telemetry — the clock is suspended while a closed-list flag is active", () => {
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    spawnIdleBee(rig);
    rig.driver.acceptDeliveries = false;
    rig.store.setFlag("bee-1", "resource_blocked", "429 storm");
    rig.store.send("bee-1", "blocked at the boundary");
    rig.clock.now += 1000;
    rig.core.step();
    assert.equal(rig.violations.length, 0, "a visibly blocked bee is not an I1 breach");
    rig.store.clearFlag("bee-1", "resource_blocked", "provider recovered");
    rig.driver.acceptDeliveries = true;
    rig.core.step();
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0);
    assert.equal(rig.violations.length, 0);
  } finally {
    rig.cleanup();
  }
});

test("unit.8: continuity (spec 07 §F) — a booted session id is recorded on the bee for the CURRENT generation only; stale/no-bee evidence is skipped", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig, "bee-s");
    rig.driver.sessions.push({ beeId: "bee-s", generation: 1, sessionId: "sid-gen1" });
    rig.core.step();
    assert.equal(rig.store.getBee("bee-s")?.providerSessionId, "sid-gen1");
    assert.ok(rig.ops.some((o) => o.startsWith("session.recorded bee=bee-s gen=1")));
    // same value again → no audit spam
    const auditBefore = rig.store.lastAuditSeq();
    rig.driver.sessions.push({ beeId: "bee-s", generation: 1, sessionId: "sid-gen1" });
    rig.core.step();
    assert.equal(rig.store.lastAuditSeq(), auditBefore);
    // stale generation and unknown bee are skipped
    rig.driver.sessions.push({ beeId: "bee-s", generation: 0, sessionId: "sid-stale" });
    rig.driver.sessions.push({ beeId: "ghost", generation: 1, sessionId: "sid-ghost" });
    rig.core.step();
    assert.equal(rig.store.getBee("bee-s")?.providerSessionId, "sid-gen1");
    assert.ok(rig.ops.some((o) => o.includes("session.skip bee=bee-s gen=0 reason=stale_generation")));
    assert.ok(rig.ops.some((o) => o.includes("session.skip bee=ghost gen=1 reason=no_bee")));
    // revive keeps the id on the bee (the driver's resolve reads it for --resume)
    rig.store.enqueueCommand("stop", "bee-s", { cause: "stopped_by_user" });
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-s")?.state, "stopped");
    rig.store.send("bee-s", "wake");
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-s")?.generation, 2);
    assert.equal(rig.store.getBee("bee-s")?.providerSessionId, "sid-gen1");
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Spawn-failure budget (the WP7 importer hazard): a runtime that dies during
// boot must revive on a bounded, backed-off schedule and end in spawn_failed —
// never crash → wake → revive at tick speed forever.
// ---------------------------------------------------------------------------

/** Run steps until the wake backoff elapses each time; returns the op log slice. */
function stepUntilQuiet(rig: Rig, maxSteps: number): void {
  for (let i = 0; i < maxSteps; i++) {
    rig.core.step();
    const pending = rig.store.listCommands({ beeId: "bee-1", status: "queued" });
    // Jump the clock to the next deferred wake (the real daemon just waits).
    const next = pending.reduce((acc, c) => Math.max(acc, c.nextAttemptAt), 0);
    if (next > rig.clock.now) rig.clock.now = next;
  }
}

test("budget.5: immediate-exit runtime → bounded revives with backoff, spawn_failed at the budget, no further wakes", () => {
  // maxAttempts 3 / backoffBaseMs 1 in the rig: failures 1,2 defer the next
  // wake by 1 and 2 ms; failure 3 sets the flag.
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    rig.driver.bootCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "hsr", cwd: "/nope" });
    rig.store.enqueueCommand("spawn", "bee-1");
    rig.store.send("bee-1", "hello?"); // pending mail is what makes revives happen
    stepUntilQuiet(rig, 40);

    const bee = rig.store.getBee("bee-1")!;
    assert.equal(bee.spawnFailures, 3, "one budget across wake-driven revives");
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    // Exactly the budget's worth of starts (spawn + 2 revives), not 40.
    assert.equal(rig.driver.starts.length, 3, `starts: ${JSON.stringify(rig.driver.starts)}`);
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 3);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
    // Wakes were deferred on the backoff table: each revive's wake had a
    // nextAttemptAt strictly after its enqueue.
    const wakes = rig.store.listCommands({ beeId: "bee-1" }).filter((c) => c.verb === "send_wake");
    assert.equal(wakes.length, 2, "one wake per revive below the budget; none once flagged");
    for (const w of wakes) assert.ok(w.nextAttemptAt > w.enqueuedAt, `wake ${w.id} was not deferred`);
    assert.equal(rig.store.listCommands({ beeId: "bee-1", status: "queued" }).length, 0, "no wake pending");
    assert.ok(rig.ops.some((o) => o.startsWith("wake.suppressed bee=bee-1")), "suppression is logged");
    // Steady state: more steps + more mail change nothing but the mailbox.
    const startsBefore = rig.driver.starts.length;
    rig.store.send("bee-1", "anyone?");
    rig.clock.now += 10_000;
    for (let i = 0; i < 20; i++) rig.core.step();
    assert.equal(rig.driver.starts.length, startsBefore, "no revive while spawn_failed is set");
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 2, "mail stays durable");
    assert.equal(rig.store.view("bee-1").reachable, true);
    assert.equal(rig.store.view("bee-1").blocked, true);
    assert.equal(rig.violations.length, 0, "flagged = visibly blocked; the I1 clock is suspended");
    // A fresh DaemonCore over the same store (daemon restart) sweeps no wake for it either.
    const core2 = new DaemonCore({
      store: rig.store,
      driver: rig.driver,
      policy: { bootHangTimeoutSteps: 50, turnHangTimeoutSteps: 50, commandsPerStep: 8 },
      now: () => rig.clock.now,
      log: (op) => rig.ops.push(op),
    });
    const report = core2.boot();
    assert.equal(report.wakesEnqueued, 0, "boot sweep respects spawn_failed");
    for (let i = 0; i < 5; i++) core2.step();
    assert.equal(rig.driver.starts.length, startsBefore);
  } finally {
    rig.cleanup();
  }
});

test("budget.5b: a driver that THROWS from start (cell provisioning failed) is a spawn failure on the B5 table — retried with backoff, spawn_failed at the budget, never a wedged command or a loop error", () => {
  const rig = makeRig();
  try {
    rig.driver.startError = "provision: origin /gone has no .git";
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "cell", cwd: "/cells/w/repo-space-1" });
    const cmd = rig.store.enqueueCommand("spawn", "bee-1");
    // No step throws: the failure is reported, not propagated.
    stepUntilQuiet(rig, 40);
    const settled = rig.store.getCommand(cmd.id)!;
    assert.equal(settled.status, "failed");
    assert.equal(settled.failureCause, "spawn_failed");
    assert.equal(settled.attempts, 3, "maxAttempts 3 in the rig: 1 attempt + 2 retries");
    assert.equal(rig.driver.starts.length, 3, "one start per attempt");
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    assert.ok(rig.ops.some((o) => o.includes("start_failed") && o.includes("origin /gone")), "the driver's reason is logged");
    assert.equal(rig.store.listCommands({ beeId: "bee-1", status: "running" }).length, 0, "nothing wedged in running");
    // Fixing the driver + an operator revive recovers (budget.6 semantics apply).
    rig.driver.startError = null;
    rig.store.enqueueCommand("revive", "bee-1");
    stepUntilQuiet(rig, 20);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
  } finally {
    rig.cleanup();
  }
});

test("budget.6: an explicit operator revive retries regardless of spawn_failed and clears it on success; the mail then flows", () => {
  const rig = makeRig();
  try {
    rig.driver.bootCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "hsr", cwd: "/nope" });
    rig.store.enqueueCommand("spawn", "bee-1");
    const sent = rig.store.send("bee-1", "deliver me eventually");
    stepUntilQuiet(rig, 30);
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    const startsBefore = rig.driver.starts.length;

    // Still broken: revive tries once more (fresh budget), fails, and the
    // budget runs down again from zero — bounded, then flagged again.
    rig.store.enqueueCommand("revive", "bee-1");
    rig.core.step(); // executes revive: reset + start (crashes at boot)
    assert.ok(rig.ops.some((o) => o.startsWith("spawn.budget_reset bee=bee-1 by=revive")));
    assert.equal(rig.driver.starts.length, startsBefore + 1, "revive retried despite the flag");
    stepUntilQuiet(rig, 30);
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"], "flagged again after a fresh budget");
    assert.equal(rig.driver.starts.length, startsBefore + 3, "fresh budget of maxAttempts (3) starts, no more");

    // Fixed (cwd restored, binary present): revive boots, the flag clears on
    // booted (contrary evidence), the counter resets, the mail is delivered.
    rig.driver.bootCrash = false;
    rig.store.enqueueCommand("revive", "bee-1");
    for (let i = 0; i < 4; i++) rig.core.step();
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.deepEqual(rig.driver.deliveredIds, [sent.message.id]);
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("budget.7: a runtime that reached running/idle and then crashed is not a spawn failure — revive is immediate and uncounted", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig); // gen 1 idle
    rig.driver.acceptDeliveries = false; // keep mail pending so the crash triggers a wake
    rig.store.send("bee-1", "pending");
    // Crash mid-life, three times over — more than the budget of 3.
    for (let gen = 1; gen <= 3; gen++) {
      const rt = rig.store.currentRuntime("bee-1")!;
      assert.equal(rt.generation, gen);
      rig.driver.procs.delete("bee-1");
      rig.driver.events.push({ beeId: "bee-1", generation: gen, kind: "exited", exitCause: "crashed" });
      rig.core.step(); // exit → stopped(crashed) → wake (immediate)
      const wake = rig.store.listCommands({ beeId: "bee-1" }).filter((c) => c.verb === "send_wake").at(-1)!;
      assert.equal(wake.nextAttemptAt, wake.enqueuedAt, "no backoff for a post-boot crash");
      rig.core.step(); // wake → revive → booted + turn_ended
      rig.core.step(); // drain → idle
      assert.equal(rig.store.currentRuntime("bee-1")?.generation, gen + 1);
      assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0);
    }
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    // Hang-policy stops of a booting runtime are not boot failures either.
    rig.driver.autoBoot = false;
    rig.driver.procs.delete("bee-1");
    rig.driver.events.push({ beeId: "bee-1", generation: 4, kind: "exited", exitCause: "crashed" });
    rig.core.step(); // → wake
    rig.core.step(); // → revive gen 5, booting forever
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "booting");
    rig.clock.now += 100; // past bootHangTimeoutSteps (50)
    rig.core.step(); // hang policy enqueues stop
    rig.core.step(); // stop executes → exited(stopped_by_system)
    rig.core.step(); // drain (→ wake → gen 6 booting again; slow loop, bounded by the hang timeout)
    const gen5 = rig.store.listRuntimes("bee-1").find((r) => r.generation === 5);
    assert.equal(gen5?.state, "stopped");
    assert.equal(gen5?.exitCause, "stopped_by_system");
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0, "a boot hang stopped by policy is not a spawn failure");
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
  } finally {
    rig.cleanup();
  }
});

test("unit.9 (spec 08 swap): a `stop {thenRevive}` command revives the NEXT generation once the runtime is observed stopped — durable, once, and never while a wake is already pending; the account policy hook sees every applied evidence", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_system", reason: "swap_account:test", thenRevive: true });
    rig.core.step(); // execute stop → process dying (exited queued)
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle", "the stop is async: exited not yet observed");
    rig.core.step(); // exited observed → stopped → revive enqueued (after_stop) → executed in the same step
    const revives = rig.store.listCommands({ beeId: "bee-1" }).filter((c) => c.verb === "revive");
    assert.equal(revives.length, 1, "exactly one revive");
    assert.equal(revives[0]?.args.reason, "after_stop");
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 2);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.ok(rig.ops.some((o) => o.startsWith("revive.after_stop bee=bee-1 gen=1")));
    // a plain stop (no thenRevive) never revives
    rig.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_user" });
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 2);
    // thenRevive with mail already pending: the send_wake carries the revive; no duplicate
    rig.store.enqueueCommand("revive", "bee-1");
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 3);
    rig.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_system", thenRevive: true });
    rig.core.step(); // stop executed, process dying
    rig.store.send("bee-1", "mail during the swap"); // runtime still 'idle' in the store → no wake yet
    rig.core.step(); // exited → stopped; ensureWake enqueues send_wake; thenRevive sees it pending → no revive
    const cmds = rig.store.listCommands({ beeId: "bee-1" });
    assert.equal(cmds.filter((c) => c.verb === "revive").length, 2, "no third revive: the wake covers it");
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 4);
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0, "the mail rode the swap onto generation 4");
  } finally {
    rig.cleanup();
  }
});

test("unit.10 (spec 08): the onFlagEvidence hook fires after each applied evidence and a throwing hook never stalls the loop", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-loops-"));
  const clock = { now: 1000 };
  const now = (): number => clock.now;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now });
  const driver = new FakeDriver(now);
  const seen: string[] = [];
  const ops: string[] = [];
  const core = new DaemonCore({
    store,
    driver,
    policy: { bootHangTimeoutSteps: 50, turnHangTimeoutSteps: 50, commandsPerStep: 8 },
    now,
    log: (op) => ops.push(op),
    onFlagEvidence: (ev) => {
      seen.push(`${ev.flag}:${ev.action}`);
      if (ev.detail === "boom") throw new Error("policy bug");
    },
  });
  try {
    core.boot();
    store.createBee({ id: "b", name: "b", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store.enqueueCommand("spawn", "b");
    core.step();
    core.step();
    driver.evidence.push({ beeId: "b", generation: 1, flag: "resource_blocked", action: "set", detail: "boom" });
    driver.evidence.push({ beeId: "b", generation: 1, flag: "auth_needed", action: "set", detail: "not logged in" });
    core.step();
    assert.deepEqual(seen, ["resource_blocked:set", "auth_needed:set"]);
    assert.deepEqual(store.activeFlags("b").map((f) => f.flag).sort(), ["auth_needed", "resource_blocked"], "both flags applied despite the throwing hook");
    assert.ok(ops.some((o) => o.startsWith("account.policy_error bee=b flag=resource_blocked")));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Delivery urgency (schema v8 — spec 01 Q2 amendment 2026-08-18): the delivery
// loop's eligibility rule, the mid-turn interrupt for `now`, the FIFO-among-
// eligible ordering, and the I1 clock that starts at eligibility for `idle`.
// ---------------------------------------------------------------------------

/** Drive an idle bee into a turn (store state `running`). */
function startTurn(rig: Rig, id = "bee-1"): void {
  const rt = rig.store.currentRuntime(id);
  assert.equal(rt?.state, "idle", "startTurn wants an idle runtime");
  rig.driver.events.push({ beeId: id, generation: rt!.generation, kind: "turn_started" });
  rig.core.step();
  assert.equal(rig.store.currentRuntime(id)?.state, "running");
}

test("urgency.d1: `idle` is not delivered while the runtime is running — it lands at turn end", () => {
  const rig = makeRig({ turnHangTimeoutSteps: 1_000_000 });
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    const res = rig.store.send("bee-1", "when you are done", { urgency: "idle" });
    for (let i = 0; i < 5; i++) {
      rig.clock.now += 10;
      rig.core.step();
    }
    assert.deepEqual(rig.driver.deliveredIds, [], "held for the whole turn");
    assert.equal(rig.driver.interrupts.length, 0, "idle never interrupts");
    // Turn ends → same step: observation drains to idle, delivery loop delivers.
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.store.getMessage(res.message.id)?.deliveredGeneration, 1);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d2: `now` mid-turn interrupts exactly once, then delivers at the resulting accept point", () => {
  const rig = makeRig({ turnHangTimeoutSteps: 1_000_000 });
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    rig.driver.acceptDeliveries = false; // the accept point is slow to open
    const res = rig.store.send("bee-1", "drop everything", { urgency: "now" });
    rig.core.step();
    assert.deepEqual(rig.driver.interrupts, [{ beeId: "bee-1", generation: 1 }], "interrupt issued");
    // Simulate the turn_ended landing slowly: swallow it and keep stepping —
    // the interrupt must NOT be re-issued for the same message.
    rig.driver.events = [];
    rig.core.step();
    rig.core.step();
    assert.equal(rig.driver.interrupts.length, 1, "one interrupt per message");
    assert.deepEqual(rig.driver.deliveredIds, [], "not delivered while refused");
    // The accept point opens (turn_ended observed, deliveries accepted).
    rig.driver.acceptDeliveries = true;
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.driver.interrupts.length, 1);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d3: `now` to an idle runtime is a plain delivery — no interrupt", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    const res = rig.store.send("bee-1", "asap", { urgency: "now" });
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.driver.interrupts.length, 0);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d4: ordering — urgency governs WHEN a message is eligible; among eligible, enqueue order wins", () => {
  const rig = makeRig({ turnHangTimeoutSteps: 1_000_000 });
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    const m1 = rig.store.send("bee-1", "idle-1", { urgency: "idle" }).message;
    const m2 = rig.store.send("bee-1", "next-2").message;
    const m3 = rig.store.send("bee-1", "idle-3", { urgency: "idle" }).message;
    const m4 = rig.store.send("bee-1", "now-4", { urgency: "now" }).message;
    // Mid-turn: m1/m3 are held; m2 and m4 are eligible; m2 (older) delivers
    // first; m4's now-ness still interrupts the turn.
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [m2.id], "idle does not block a later next");
    assert.deepEqual(rig.driver.interrupts, [{ beeId: "bee-1", generation: 1 }], "the pending now interrupts");
    // The interrupt's turn_ended drains → idle: everything is eligible, FIFO wins.
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [m2.id, m1.id, m3.id, m4.id], "enqueue order among eligible");
  } finally {
    rig.cleanup();
  }
});

test("urgency.d5: `idle` to a stopped bee still revives (revive-on-message unchanged) and delivers once idle", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_user" });
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
    const res = rig.store.send("bee-1", "for later", { urgency: "idle" });
    assert.ok(res.wakeCommand, "urgency never affects the wake");
    rig.core.step(); // send_wake → revive gen 2 (autoBoot: booted + turn_ended)
    rig.core.step(); // observations → idle; delivery in the same step
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.store.getMessage(res.message.id)?.deliveredGeneration, 2);
    assert.equal(rig.driver.interrupts.length, 0);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d6: I1 telemetry — an `idle` message's deadline clock starts at eligibility (turn end), not enqueue", () => {
  const rig = makeRig({ i1DeadlineSteps: 200, turnHangTimeoutSteps: 1_000_000 });
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    const res = rig.store.send("bee-1", "patient", { urgency: "idle" });
    // Far past what would breach an enqueue-based deadline: no violation —
    // the turn is exactly what `idle` opted into waiting for.
    rig.clock.now += 5_000;
    rig.core.step();
    assert.equal(rig.violations.length, 0, "no false I1 violation during a long turn");
    // Turn ends but delivery is refused: the clock now runs from eligibility.
    rig.driver.acceptDeliveries = false;
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.core.step();
    const eligibleAt = rig.clock.now;
    rig.clock.now += 150; // inside the 200-step bound from ELIGIBILITY
    rig.core.step();
    assert.equal(rig.violations.length, 0, "inside the eligibility-based deadline");
    rig.clock.now += 100; // past it
    rig.core.step();
    assert.equal(rig.violations.length, 1, "breach recorded once eligible + overdue");
    assert.equal(rig.violations[0]?.messageId, res.message.id);
    assert.ok((rig.violations[0]?.deadline ?? 0) >= eligibleAt + 200, "deadline base is eligibility, not enqueue");
  } finally {
    rig.cleanup();
  }
});
