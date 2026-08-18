/**
 * Coverage beyond the 7 spec tests: the pieces of harness machinery whose own
 * logic deserves direct tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Prng,
  SimClock,
  SimDriver,
  defaultConfig,
  formatViolation,
  i1DefaultBoundSteps,
  makeConfig,
  runSim,
  type SimDriverConfig,
  type Violation,
} from "../src/index.ts";
import { tmpDirs } from "./helpers.ts";

test("prng: same seed yields the same stream; different seeds diverge", () => {
  const a = new Prng(42);
  const b = new Prng(42);
  const c = new Prng(43);
  const seqA = Array.from({ length: 50 }, () => a.next());
  const seqB = Array.from({ length: 50 }, () => b.next());
  const seqC = Array.from({ length: 50 }, () => c.next());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const x of seqA) assert.ok(x >= 0 && x < 1);
  const d = new Prng(7);
  for (let i = 0; i < 20; i++) {
    const n = d.int(3, 9);
    assert.ok(n >= 3 && n <= 9 && Number.isInteger(n));
  }
  assert.equal(new Prng(1).chance(0), false); // p<=0 must not consume the stream
});

test("config: Q1 default I1 bound is 2 x (max boot delay + max turn duration), configurable", () => {
  const cfg = defaultConfig();
  assert.equal(i1DefaultBoundSteps(cfg), 2 * (cfg.driver.bootDelay[1] + cfg.driver.turnDuration[1]));
  const overridden = makeConfig({ driver: { bootDelay: [1, 10], turnDuration: [1, 15] }, i1BoundSteps: 999 });
  assert.equal(i1DefaultBoundSteps(overridden), 50);
  assert.equal(overridden.i1BoundSteps, 999); // explicit bound wins in runSim
});

test("sim driver: boot/deliver/turn/stop cycle emits normalized observations", () => {
  const clock = new SimClock();
  const cfg: SimDriverConfig = {
    bootDelay: [3, 3],
    turnDuration: [4, 4],
    crashProbability: 0,
    hangProbability: 0,
    exitProbability: 0,
  };
  const driver = new SimDriver(cfg, new Prng(1), clock.now);
  driver.start("b", 1);
  assert.throws(() => driver.start("b", 2), /already has a live process/);
  assert.equal(driver.deliver("b", 1, 10, "x").accepted, false); // still booting
  for (let i = 0; i < 3; i++) {
    clock.advance(1);
    driver.tick();
  }
  let obs = driver.observe();
  assert.equal(obs.length, 1);
  assert.equal(obs[0]?.kind, "booted");
  assert.equal(typeof obs[0]?.pid, "number");
  // initial turn runs 4 steps, then idles
  for (let i = 0; i < 4; i++) {
    clock.advance(1);
    driver.tick();
  }
  obs = driver.observe();
  assert.deepEqual(obs.map((o) => o.kind), ["turn_ended"]);
  // delivery to an idle runtime starts a turn and records ground truth
  assert.equal(driver.deliver("b", 1, 10, "x").accepted, true);
  assert.equal(driver.consumedGeneration(10), 1);
  assert.deepEqual(driver.observe().map((o) => o.kind), ["turn_started"]);
  // delivery to a stale generation is refused
  assert.equal(driver.deliver("b", 2, 11, "y").accepted, false);
  // stop kills the process and reports the cause
  assert.deepEqual(driver.stop("b", 1, "stopped_by_user"), { hadProcess: true });
  assert.deepEqual(driver.stop("b", 1, "stopped_by_user"), { hadProcess: false });
  const exited = driver.observe();
  assert.equal(exited[0]?.kind, "exited");
  assert.equal(exited[0]?.exitCause, "stopped_by_user");
  assert.equal(driver.snapshotLive().length, 0);
});

test("sim driver: killAll drops every pid and pending events (machine reboot)", () => {
  const clock = new SimClock();
  const driver = new SimDriver(
    { bootDelay: [1, 1], turnDuration: [2, 2], crashProbability: 0, hangProbability: 0, exitProbability: 0 },
    new Prng(2),
    clock.now,
  );
  driver.start("a", 1);
  driver.start("b", 1);
  clock.advance(1);
  driver.tick(); // both boot → events pending
  driver.killAll();
  assert.equal(driver.snapshotLive().length, 0);
  assert.deepEqual(driver.observe(), []);
});

test("violation ledger: structured one-liner with seed, step, bee, invariant, op tail", () => {
  const v: Violation = {
    seed: 7,
    step: 123,
    beeId: "bee-1",
    invariant: "I1",
    detail: "message 9 undelivered past bound",
    ops: ["s122 work.send bee=bee-1 msg=9", "s123 deliver.refused bee=bee-1 msg=9 reason=not_ready"],
  };
  const line = formatViolation(v);
  assert.ok(!line.includes("\n"));
  assert.deepEqual(JSON.parse(line), {
    seed: 7,
    step: 123,
    bee: "bee-1",
    invariant: "I1",
    detail: "message 9 undelivered past bound",
    ops: v.ops,
  });
});

test("retry exhaustion under permanent driver timeouts surfaces spawn_failed, never a zombie", () => {
  // Driver timeouts on every start attempt: wakes exhaust their B5 budget, the
  // bee gets the spawn_failed flag (visible, blocked) and I1's clock suspends —
  // the run must still be violation-free because the failure SURFACED.
  const dirs = tmpDirs();
  try {
    const result = runSim(
      3,
      dirs.dbPath("timeout-exhaustion"),
      makeConfig({
        steps: 200,
        settleSteps: 100,
        faults: { driverTimeoutProbability: 1 },
        workload: { stopProbability: 0, archiveProbability: 0, deleteProbability: 0 },
      }),
    );
    for (const v of result.violations) console.error(formatViolation(v));
    assert.equal(result.violations.length, 0);
    const failed = result.finalDump.commands.filter((c) => c.status === "failed");
    assert.ok(failed.length > 0, "no command ever exhausted its retries");
    for (const cmd of failed) assert.equal(cmd.failureCause, "spawn_failed");
    // The failure surfaced as the spawn_failed flag; successful settle-phase
    // starts (injector off) may since have cleared it — the row remains.
    const surfaced = result.finalDump.flags.filter((f) => f.flag === "spawn_failed");
    assert.ok(surfaced.length > 0, "exhaustion did not surface a flag");
  } finally {
    dirs.cleanup();
  }
});

test("sim driver v6: interrupt — booting not_ready, idle no-op, mid-turn ends the turn early (turn_ended, process live), gone no_process", () => {
  const clock = new SimClock();
  const cfg: SimDriverConfig = { bootDelay: [1, 1], turnDuration: [1000, 1000], crashProbability: 0, hangProbability: 0, exitProbability: 0 };
  const driver = new SimDriver(cfg, new Prng(3), clock.now);
  driver.start("b", 1);
  assert.deepEqual(driver.interrupt("b", 1), { interrupted: false, reason: "not_ready" });
  clock.advance(1);
  driver.tick();
  assert.deepEqual(driver.observe().map((o) => o.kind), ["booted"]);
  // a 1000-step initial turn: 50 ticks in, still running (no turn_ended)
  for (let i = 0; i < 50; i++) {
    clock.advance(1);
    driver.tick();
  }
  assert.deepEqual(driver.observe(), []);
  assert.deepEqual(driver.interrupt("b", 1), { interrupted: true });
  assert.deepEqual(driver.observe().map((o) => o.kind), ["turn_ended"]);
  assert.ok(driver.hasProcess("b", 1), "interrupt never ends the runtime");
  assert.deepEqual(driver.interrupt("b", 1), { interrupted: false, reason: "idle" });
  assert.equal(driver.deliver("b", 1, 5, "next").accepted, true, "idle again: takes the next message");
  assert.deepEqual(driver.interrupt("b", 2), { interrupted: false, reason: "no_process" });
  assert.deepEqual(driver.interrupt("nobody", 1), { interrupted: false, reason: "no_process" });
});
