/**
 * The seven spec-02 tests. Each runs full simulations (real CoreStore, virtual
 * everything else) over a seed batch; the fast profile is the CI gate and the
 * long profile (HARNESS_PROFILE=long) runs the large batch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimDriver,
  formatViolation,
  makeConfig,
  runSim,
  type DeliverOutcome,
  type SimConfigOverrides,
} from "../src/index.ts";
import { assertClean, scaleSteps, seeds, tmpDirs } from "./helpers.ts";

const FAST_SEEDS = [1, 20260817, 424242];
const LONG_SEEDS = [7, 99, 1234, 31337, 271828, 3141592, 8675309];

function runSeeds(
  name: string,
  overrides: SimConfigOverrides,
  perRun: (result: ReturnType<typeof runSim>) => void,
): void {
  const dirs = tmpDirs();
  try {
    for (const seed of seeds(FAST_SEEDS, LONG_SEEDS)) {
      const result = runSim(seed, dirs.dbPath(`${name}-${seed}`), makeConfig(overrides));
      perRun(result);
    }
  } finally {
    dirs.cleanup();
  }
}

test("spec02.1: quiet workload (no faults) — all invariants hold over long runs", () => {
  runSeeds(
    "quiet",
    { steps: scaleSteps(500) },
    (result) => {
      assertClean(result);
      // The run must actually have exercised the mailbox path end to end.
      assert.ok(result.stats.sends > 20, `seed ${result.seed}: only ${result.stats.sends} sends`);
      assert.ok(result.stats.delivered > 20, `seed ${result.seed}: only ${result.stats.delivered} deliveries`);
    },
  );
});

test("spec02.2: crash-storm workload — daemon crash every K steps, I1 still holds", () => {
  runSeeds(
    "crash-storm",
    {
      steps: scaleSteps(400),
      faults: { daemonCrashEvery: 25 },
      // Downtime + boot replay stretch delivery; the bound stays configurable (Q1).
      i1BoundSteps: 60,
    },
    (result) => {
      assertClean(result);
      assert.ok(result.stats.daemonCrashes >= 10, `seed ${result.seed}: storm did not run (${result.stats.daemonCrashes} crashes)`);
      assert.ok(result.stats.delivered > 10, `seed ${result.seed}: deliveries did not survive the storm`);
    },
  );
});

test("spec02.3: reboot-storm workload — repeated reboots mid-turn, zero failed states, I1 holds", () => {
  runSeeds(
    "reboot-storm",
    {
      steps: scaleSteps(400),
      faults: { machineRebootEvery: 40 },
      i1BoundSteps: 80,
    },
    (result) => {
      assertClean(result);
      assert.ok(result.stats.machineReboots >= 8, `seed ${result.seed}: storm did not run`);
      assert.ok(
        result.stats.machineRestartStops > 0,
        `seed ${result.seed}: no runtime was ever caught mid-flight by a reboot`,
      );
      // B7 the anti-kill_failed guarantee: a reboot never produces failed states.
      const failed = result.finalDump.commands.filter((c) => c.status === "failed");
      assert.equal(failed.length, 0, `seed ${result.seed}: reboots produced failed commands`);
      const flags = result.finalDump.flags.filter((f) => f.clearedAt == null);
      assert.equal(flags.length, 0, `seed ${result.seed}: reboots raised flags`);
      assert.ok(result.stats.delivered > 10, `seed ${result.seed}: deliveries did not survive the storm`);
    },
  );
});

test("spec02.4: executor crash mid-command — replay settles idempotently, no double effects", () => {
  runSeeds(
    "executor-crash",
    {
      steps: scaleSteps(400),
      faults: { executorCrashProbability: 0.2 },
      i1BoundSteps: 100,
      queueBoundSteps: 300,
    },
    (result) => {
      assertClean(result);
      assert.ok(result.stats.executorCrashes > 5, `seed ${result.seed}: executor crashes did not fire`);
      // No double effects: generations stay contiguous (no double revive) and every
      // store delivery is backed by exactly one consumption — both are invariant
      // checks (I2/I1); on top, audit replay equality (I5) proved no phantom writes.
      for (const bee of result.finalDump.bees) {
        const gens = result.finalDump.runtimes
          .filter((r) => r.beeId === bee.id)
          .map((r) => r.generation)
          .sort((a, b) => a - b);
        assert.deepEqual(gens, gens.map((_, i) => i + 1), `seed ${result.seed}: generation gap on ${bee.id}`);
      }
    },
  );
});

test("spec02.5: hang workload — hung runtimes get stopped by policy and messages re-deliver", () => {
  runSeeds(
    "hang",
    {
      steps: scaleSteps(400),
      settleSteps: 200,
      driver: { hangProbability: 0.25 },
      // Hang recovery costs hang-timeout + stop + reboot + turn per incident, and
      // incidents can chain; the bound is configurable per Q1.
      i1BoundSteps: 250,
      queueBoundSteps: 300,
    },
    (result) => {
      assertClean(result);
      const systemStopped = result.finalDump.runtimes.filter(
        (r) => r.exitCause === "stopped_by_system",
      );
      assert.ok(
        systemStopped.length > 0,
        `seed ${result.seed}: hang policy never stopped a hung runtime`,
      );
      assert.ok(result.stats.delivered > 10, `seed ${result.seed}: messages did not re-deliver past hangs`);
    },
  );
});

test("spec02.6: adversarial mix — all faults at high rates; invariants hold; replayable from seed", () => {
  const overrides: SimConfigOverrides = {
    steps: scaleSteps(500),
    settleSteps: 250,
    driver: {
      crashProbability: 0.015,
      hangProbability: 0.1,
      exitProbability: 0.05,
    },
    faults: {
      daemonCrashProbability: 0.02,
      machineRebootProbability: 0.008,
      executorCrashProbability: 0.08,
      driverTimeoutProbability: 0.08,
    },
    i1BoundSteps: 400,
    queueBoundSteps: 500,
  };
  const dirs = tmpDirs();
  try {
    for (const seed of seeds([99, 20260817], [5, 17, 4242, 987654])) {
      const first = runSim(seed, dirs.dbPath(`adv-${seed}-a`), makeConfig(overrides));
      assertClean(first);
      assert.ok(first.stats.delivered > 10, `seed ${seed}: nothing delivered under adversity`);
      // Replayability: the same (seed, config) reproduces the exact same run.
      const second = runSim(seed, dirs.dbPath(`adv-${seed}-b`), makeConfig(overrides));
      assert.deepEqual(second.opLog, first.opLog, `seed ${seed}: op log diverged on replay`);
      assert.deepEqual(second.finalDump, first.finalDump, `seed ${seed}: final state diverged on replay`);
      assert.deepEqual(second.violations, first.violations, `seed ${seed}: violations diverged on replay`);
    }
  } finally {
    dirs.cleanup();
  }
});

test("spec02.7: meta — a deliberately broken driver (drops deliveries) makes the harness FAIL", () => {
  const dirs = tmpDirs();
  try {
    // Variant A: the driver claims acceptance but drops the message on the floor.
    // The store's `delivered` mark is a lie — the ground-truth check must catch it.
    class DroppingDriver extends SimDriver {
      override deliver(): DeliverOutcome {
        return { accepted: true };
      }
    }
    const dropped = runSim(
      1,
      dirs.dbPath("meta-drop"),
      makeConfig({ steps: 120, settleSteps: 40 }),
      (cfg, prng, now) => new DroppingDriver(cfg, prng, now),
    );
    assert.ok(dropped.violations.length > 0, "dropping driver produced no violations — the instrument is blind");
    assert.ok(
      dropped.violations.some((v) => v.invariant === "I1" && v.detail.includes("dropped delivery")),
      "dropping driver was not caught by the I1 ground-truth check",
    );

    // Variant B: the driver silently refuses every delivery. Messages age past
    // the I1 bound — the yardstick itself must catch it.
    class RefusingDriver extends SimDriver {
      override deliver(): DeliverOutcome {
        return { accepted: false, reason: "not_ready" };
      }
    }
    const refused = runSim(
      1,
      dirs.dbPath("meta-refuse"),
      makeConfig({ steps: 120, settleSteps: 40 }),
      (cfg, prng, now) => new RefusingDriver(cfg, prng, now),
    );
    assert.ok(refused.violations.length > 0, "refusing driver produced no violations — the instrument is blind");
    assert.ok(
      refused.violations.some((v) => v.invariant === "I1" && v.detail.includes("undelivered past bound")),
      "refusing driver was not caught by the I1 bound check",
    );

    // The ledger lines are structured one-liners carrying seed, step, bee,
    // invariant and the op history tail — the future telemetry shape.
    for (const v of [...dropped.violations, ...refused.violations]) {
      const line = formatViolation(v);
      assert.ok(!line.includes("\n"), "ledger line is not a one-liner");
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(parsed.seed, 1);
      assert.equal(typeof parsed.step, "number");
      assert.ok(["I1", "I2", "I3", "I4", "I5", "I6"].includes(parsed.invariant as string));
      assert.ok(Array.isArray(parsed.ops) && (parsed.ops as string[]).length > 0);
    }
  } finally {
    dirs.cleanup();
  }
});
