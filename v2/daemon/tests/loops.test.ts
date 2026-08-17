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
