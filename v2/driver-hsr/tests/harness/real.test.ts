/**
 * The WP3 invariant gate (`npm run v2:harness:real`, spec 03 test tier 3):
 * the UNMODIFIED WP2 SimDaemon + fault machinery + six-invariant checker
 * driving the REAL HsrDriver with REAL OS child processes (the stub agent).
 *
 * Fault schedules per the spec:
 *  - daemon crash / reboot-equivalent: the store connection is killed while
 *    the children stay alive; on reopen, boot() re-adopts survivors from
 *    `snapshotLive()` (reconcileAtBoot, B7) — checked by I4 at every boot.
 *  - executor crash mid-command: ExecutorCrashError from the fault injector;
 *    boot replay (B5) requeues and re-executes idempotently.
 *  - runtime faults come from the agents themselves (@crash/@exit message
 *    directives); long-running turns are never inferred failed from silence.
 *
 * Same six invariants as WP2, over real time (one "step" ≈ stepMs of wall
 * clock; all bounds are in ms because the store clock is Date.now).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../../core/src/index.ts";
import { ExecutorCrashError, SimDaemon } from "../../../harness/src/daemon.ts";
import { FaultInjector } from "../../../harness/src/faults.ts";
import {
  InvariantChecker,
  formatViolation,
  takePreBootSnapshot,
  type PreBootSnapshot,
  type Violation,
} from "../../../harness/src/invariants.ts";
import { Prng } from "../../../harness/src/prng.ts";
import { HsrDriver } from "../../src/index.ts";
import { stubAdapter } from "../../../adapters/src/index.ts";

const AGENT_PATH = join(import.meta.dirname, "..", "..", "test-agent", "agent.mjs");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RealRunConfig {
  steps: number;
  stepMs: number;
  settleMaxMs: number;
  /** Kill the store connection every K steps (null = never). */
  storeKillEverySteps: number | null;
  /** Steps the daemon stays down after a store kill. */
  downSteps: number;
  executorCrashProbability: number;
  workload: {
    maxBees: number;
    createProbability: number;
    sendProbability: number;
    stopProbability: number;
    archiveProbability: number;
    deleteProbability: number;
    /** Probability a sent message is a fault directive. Hang remains available for focused tests only. */
    hangProbability: number;
    crashProbability: number;
    exitProbability: number;
  };
  policy: {
    bootHangTimeoutMs: number;
    commandsPerStep: number;
    maxAttempts: number;
    backoffBaseMs: number;
  };
  i1BoundMs: number;
  queueBoundMs: number;
  agentBootDelayMs: number;
  agentTurnMs: number;
  stopKillGraceMs: number;
}

interface RealRunStats {
  sends: number;
  delivered: number;
  beesCreated: number;
  storeKills: number;
  executorCrashes: number;
  boots: number;
  adoptedTotal: number;
  reapedTotal: number;
  wallMs: number;
  settled: boolean;
}

interface RealRunResult {
  seed: number;
  violations: Violation[];
  stats: RealRunStats;
}

async function runRealSim(seed: number, cfg: RealRunConfig): Promise<RealRunResult> {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-real-"));
  const dbPath = join(dir, "core.sqlite3");
  const prng = new Prng(seed);
  const driver = new HsrDriver({
    sessionLogDir: join(dir, "logs"),
    stopKillGraceMs: cfg.stopKillGraceMs,
    resolve: () => ({
      adapter: stubAdapter,
      command: process.execPath,
      args: [AGENT_PATH],
      cwd: dir,
      env: {
        ...process.env,
        STUB_BOOT_DELAY_MS: String(cfg.agentBootDelayMs),
        STUB_TURN_MS: String(cfg.agentTurnMs),
      },
    }),
  });
  const injector = new FaultInjector(
    {
      daemonCrashEvery: null,
      daemonCrashProbability: 0,
      machineRebootEvery: null,
      machineRebootProbability: 0,
      executorCrashProbability: cfg.executorCrashProbability,
      driverTimeoutProbability: 0,
      daemonDownSteps: [cfg.downSteps, cfg.downSteps],
    },
    prng,
  );
  const policy = {
    bootHangTimeoutSteps: cfg.policy.bootHangTimeoutMs, // "steps" ARE ms here (now = Date.now)
    commandsPerStep: cfg.policy.commandsPerStep,
  };
  const storeOpts = {
    maxAttempts: cfg.policy.maxAttempts,
    backoffBaseMs: cfg.policy.backoffBaseMs,
  };
  const opLog: string[] = [];
  const log = (op: string): void => {
    if (opLog.length >= 4000) opLog.shift();
    opLog.push(op);
  };
  const checker = new InvariantChecker(
    seed,
    {
      i1BoundSteps: cfg.i1BoundMs,
      queueBoundSteps: cfg.queueBoundMs,
      maxAttempts: cfg.policy.maxAttempts,
    },
    () => opLog.slice(-40),
  );
  const stats: RealRunStats = {
    sends: 0,
    delivered: 0,
    beesCreated: 0,
    storeKills: 0,
    executorCrashes: 0,
    boots: 0,
    adoptedTotal: 0,
    reapedTotal: 0,
    wallMs: 0,
    settled: false,
  };

  let store: CoreStore | null = openCoreStore(dbPath, storeOpts);
  let daemon = new SimDaemon({ store, driver, injector, policy, now: Date.now, log });
  const firstBoot = daemon.boot();
  stats.boots += 1;
  stats.adoptedTotal += firstBoot.adopted;

  let preBoot: PreBootSnapshot = { failedCommandIds: [], activeFlagIds: [] };
  let downKind = "daemon_crash";
  let downUntilStep = 0;
  let beeSeq = 0;
  let msgSeq = 0;

  const goDown = (kind: string, s: CoreStore, step: number): void => {
    preBoot = takePreBootSnapshot(s);
    s.close();
    store = null;
    downKind = kind;
    downUntilStep = step + cfg.downSteps;
    if (kind === "executor_crash") stats.executorCrashes += 1;
    else stats.storeKills += 1;
    log(`fault.${kind} step=${step}`);
  };

  const reopen = (step: number): CoreStore => {
    const s = openCoreStore(dbPath, storeOpts);
    store = s;
    daemon = new SimDaemon({ store: s, driver, injector, policy, now: Date.now, log });
    const report = daemon.boot();
    stats.boots += 1;
    stats.adoptedTotal += report.adopted;
    stats.reapedTotal += report.orphansReaped;
    checker.checkBoot(step, s, driver, preBoot, downKind);
    return s;
  };

  const directiveBody = (): string => {
    const w = cfg.workload;
    const roll = prng.chance.bind(prng);
    if (roll(w.hangProbability)) return `please wait @hang`;
    if (roll(w.crashProbability)) return `oops @crash`;
    if (roll(w.exitProbability)) return `bye @exit`;
    return `hello #${msgSeq}`;
  };

  const workload = (s: CoreStore): void => {
    const w = cfg.workload;
    const bees = s.listBees();
    if (bees.length < w.maxBees && prng.chance(w.createProbability)) {
      beeSeq += 1;
      const id = `bee-${beeSeq}`;
      s.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: dir });
      s.enqueueCommand("spawn", id);
      stats.beesCreated += 1;
      log(`work.create bee=${id}`);
    }
    if (prng.chance(w.sendProbability)) {
      const bee = prng.pick(s.listBees());
      if (bee) {
        msgSeq += 1;
        const res = s.send(bee.id, directiveBody(), { sender: "real-harness" });
        stats.sends += 1;
        log(`work.send bee=${bee.id} msg=${res.message.id}`);
      }
    }
    if (prng.chance(w.stopProbability)) {
      const bee = prng.pick(s.listBees());
      const rt = bee ? s.currentRuntime(bee.id) : null;
      if (bee && rt && rt.state !== "stopped") {
        s.enqueueCommand("stop", bee.id, { cause: "stopped_by_user" });
        log(`work.stop bee=${bee.id} gen=${rt.generation}`);
      }
    }
    if (prng.chance(w.archiveProbability)) {
      const bee = prng.pick(s.listBees());
      if (bee && bee.lifecycle === "active") {
        s.enqueueCommand("archive", bee.id);
        log(`work.archive bee=${bee.id}`);
      }
    }
    if (prng.chance(w.deleteProbability)) {
      const all = s.listBees();
      const bee = prng.pick(all);
      if (bee && all.length > 1) {
        s.enqueueCommand("delete", bee.id);
        log(`work.delete bee=${bee.id}`);
      }
    }
  };

  const stepDaemon = (s: CoreStore, step: number): boolean => {
    try {
      daemon.step();
      return true;
    } catch (err) {
      if (err instanceof ExecutorCrashError) {
        goDown("executor_crash", s, step);
        return false;
      }
      throw err;
    }
  };

  try {
    // ---- workload + fault phase ----------------------------------------
    let step = 0;
    for (step = 1; step <= cfg.steps; step++) {
      await sleep(cfg.stepMs);
      let s = store;
      if (s == null) {
        if (step < downUntilStep) continue; // daemon down; the world keeps moving
        s = reopen(step);
      } else if (cfg.storeKillEverySteps != null && step % cfg.storeKillEverySteps === 0) {
        // The spec's reboot-equivalent: kill the store connection, leave the
        // children alive, then snapshotLive()-driven re-adoption at reopen.
        goDown("reboot_equivalent", s, step);
        continue;
      }
      workload(s);
      if (!stepDaemon(s, step)) continue;
      checker.checkStep(step, Date.now(), s, driver);
    }

    // ---- settle phase: no new work, no new faults ----------------------
    injector.disable();
    const settleDeadline = Date.now() + cfg.settleMaxMs;
    for (;;) {
      await sleep(cfg.stepMs);
      step += 1;
      let s = store;
      if (s == null) s = reopen(step);
      if (!stepDaemon(s, step)) continue;
      checker.checkStep(step, Date.now(), s, driver);
      const dump = s.dumpState();
      const settled =
        dump.commands.every((c) => c.status === "done" || c.status === "failed") &&
        dump.mailbox.every((m) => m.deliveredAt != null) &&
        dump.runtimes.every((r) => r.state === "idle" || r.state === "stopped");
      if (settled) {
        stats.settled = true;
        break;
      }
      if (Date.now() > settleDeadline) break; // checks below will surface why
    }
    let s = store;
    if (s == null) s = reopen(step);
    // A few extra beats so in-flight exits/observations drain into the store.
    for (let i = 0; i < 5; i++) {
      await sleep(cfg.stepMs);
      step += 1;
      if (stepDaemon(s, step)) checker.checkStep(step, Date.now(), s, driver);
      if (store == null) s = reopen(step);
    }
    checker.checkSettle(step, s);
    checker.checkReplay(step, s);
    stats.delivered = driver.consumedCount();
    s.close();
    store = null;
  } finally {
    driver.disposeAll();
    if (store != null) (store as CoreStore).close();
    // Give SIGKILLed children a beat to die before removing their cwd.
    await sleep(50);
    rmSync(dir, { recursive: true, force: true });
  }
  stats.wallMs = Date.now() - t0;
  return { seed, violations: checker.violations.slice(), stats };
}

function assertClean(result: RealRunResult): void {
  if (result.violations.length > 0) {
    for (const v of result.violations) console.error(formatViolation(v));
  }
  assert.equal(
    result.violations.length,
    0,
    `seed ${result.seed}: ${result.violations.length} invariant violation(s) — ledger printed above`,
  );
}

function baseConfig(overrides: Partial<RealRunConfig> = {}): RealRunConfig {
  return {
    steps: 150,
    stepMs: 12,
    settleMaxMs: 15_000,
    storeKillEverySteps: null,
    downSteps: 4,
    executorCrashProbability: 0,
    workload: {
      maxBees: 3,
      createProbability: 0.1,
      sendProbability: 0.4,
      stopProbability: 0.02,
      archiveProbability: 0.02,
      deleteProbability: 0.01,
      hangProbability: 0,
      crashProbability: 0,
      exitProbability: 0,
    },
    policy: {
      bootHangTimeoutMs: 2_000,
      commandsPerStep: 6,
      maxAttempts: 5,
      backoffBaseMs: 50,
    },
    i1BoundMs: 5_000,
    queueBoundMs: 10_000,
    agentBootDelayMs: 15,
    agentTurnMs: 15,
    stopKillGraceMs: 250,
    ...overrides,
  };
}

test("real.1: quiet workload — real processes, all six invariants hold", async () => {
  const result = await runRealSim(20260817, baseConfig());
  assertClean(result);
  assert.ok(result.stats.settled, "run did not settle");
  assert.ok(result.stats.sends > 15, `only ${result.stats.sends} sends`);
  assert.ok(result.stats.delivered > 15, `only ${result.stats.delivered} deliveries`);
  console.log(`real.1 stats: ${JSON.stringify(result.stats)}`);
});

test("real.2: reboot-equivalent storm — store-connection kills, snapshotLive re-adoption, I1+I4 hold", async () => {
  const result = await runRealSim(424242, baseConfig({
    steps: 200,
    storeKillEverySteps: 30,
    i1BoundMs: 7_000,
  }));
  assertClean(result);
  assert.ok(result.stats.settled, "run did not settle");
  assert.ok(result.stats.storeKills >= 5, `storm did not run (${result.stats.storeKills} kills)`);
  assert.ok(result.stats.boots >= 6, "no boot replays happened");
  assert.ok(
    result.stats.adoptedTotal > 0,
    "no surviving process was ever re-adopted — the reboot-equivalent proved nothing",
  );
  assert.ok(result.stats.delivered > 10, "deliveries did not survive the storm");
  console.log(`real.2 stats: ${JSON.stringify(result.stats)}`);
});

test("real.3: adversarial mix — executor crashes + agent crashes/clean exits; invariants hold", async () => {
  const result = await runRealSim(31337, baseConfig({
    steps: 220,
    storeKillEverySteps: 60,
    executorCrashProbability: 0.4,
    workload: {
      maxBees: 3,
      createProbability: 0.12,
      sendProbability: 0.4,
      stopProbability: 0.03,
      archiveProbability: 0.02,
      deleteProbability: 0.015,
      hangProbability: 0,
      crashProbability: 0.06,
      exitProbability: 0.05,
    },
    i1BoundMs: 12_000,
    queueBoundMs: 15_000,
    settleMaxMs: 20_000,
  }));
  assertClean(result);
  assert.ok(result.stats.settled, "run did not settle");
  assert.ok(result.stats.delivered > 10, "nothing delivered under adversity");
  assert.ok(result.stats.storeKills >= 1, "store-kill fault never fired");
  assert.ok(
    result.stats.executorCrashes >= 1,
    "executor-crash fault never fired — the schedule is vacuous for this path",
  );
  console.log(`real.3 stats: ${JSON.stringify(result.stats)}`);
});
