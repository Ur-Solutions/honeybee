/**
 * The WP5 invariant gate, cell variant (`npm run v2:harness:real`, spec 05
 * test tier 3): the UNMODIFIED WP2 SimDaemon + six-invariant checker driving
 * the CellDriver — real OS child processes (the WP3 stub agent) running
 * inside real provisioned cells (fixture origin repo, per-bee spaces).
 *
 * Same fault schedules as the HSR gate: store-connection kills with
 * snapshotLive re-adoption (B7), executor crashes mid-command with boot
 * replay, agent-side hangs/crashes/clean exits. The cell layer must be
 * invisible to every invariant — pure delegation, proven under fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { stubAdapter } from "../../../adapters/src/index.ts";
import { CellDriver } from "../../src/driver.ts";
import { makeOrigin } from "../helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = join(here, "..", "..", "..", "driver-hsr", "test-agent", "agent.mjs");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RunConfig {
  steps: number;
  stepMs: number;
  settleMaxMs: number;
  storeKillEverySteps: number | null;
  downSteps: number;
  executorCrashProbability: number;
  workload: {
    maxBees: number;
    createProbability: number;
    sendProbability: number;
    stopProbability: number;
    archiveProbability: number;
    deleteProbability: number;
    hangProbability: number;
    crashProbability: number;
    exitProbability: number;
  };
  policy: {
    bootHangTimeoutMs: number;
    turnHangTimeoutMs: number;
    commandsPerStep: number;
    maxAttempts: number;
    backoffBaseMs: number;
  };
  i1BoundMs: number;
  queueBoundMs: number;
  stopKillGraceMs: number;
}

interface RunStats {
  sends: number;
  delivered: number;
  beesCreated: number;
  storeKills: number;
  executorCrashes: number;
  boots: number;
  adoptedTotal: number;
  settled: boolean;
}

async function runCellSim(seed: number, cfg: RunConfig): Promise<{ violations: Violation[]; stats: RunStats }> {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cell-real-"));
  const origin = makeOrigin(dir);
  const dbPath = join(dir, "core.sqlite3");
  const prng = new Prng(seed);
  const driver = new CellDriver({
    cellsRoot: join(dir, "cells"),
    nodeKind: "workstation",
    resolveHarness: () => ({
      adapter: stubAdapter,
      command: process.execPath,
      args: [AGENT_PATH],
      env: { ...(process.env as Record<string, string>), STUB_TURN_MS: "15", STUB_BOOT_DELAY_MS: "15" },
    }),
    resolveCell: (beeId: string) => ({
      provision: {
        beeId,
        originRepo: origin.repo,
        sha: origin.sha,
        wrapper: beeId,
        repoName: "fixture",
        cellId: beeId.replaceAll(/[^a-z0-9]/g, ""),
      },
      sandbox: null,
    }),
    hsr: { sessionLogDir: join(dir, "logs"), stopKillGraceMs: cfg.stopKillGraceMs },
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
    bootHangTimeoutSteps: cfg.policy.bootHangTimeoutMs,
    turnHangTimeoutSteps: cfg.policy.turnHangTimeoutMs,
    commandsPerStep: cfg.policy.commandsPerStep,
  };
  const storeOpts = { maxAttempts: cfg.policy.maxAttempts, backoffBaseMs: cfg.policy.backoffBaseMs };
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
      turnHangTimeoutSteps: cfg.policy.turnHangTimeoutMs,
    },
    () => opLog.slice(-40),
  );
  const stats: RunStats = {
    sends: 0,
    delivered: 0,
    beesCreated: 0,
    storeKills: 0,
    executorCrashes: 0,
    boots: 0,
    adoptedTotal: 0,
    settled: false,
  };

  let store: CoreStore | null = openCoreStore(dbPath, storeOpts);
  let daemon = new SimDaemon({ store, driver, injector, policy, now: Date.now, log });
  stats.boots += 1;
  stats.adoptedTotal += daemon.boot().adopted;

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
    checker.checkBoot(step, s, driver, preBoot, downKind);
    return s;
  };

  const directiveBody = (): string => {
    const w = cfg.workload;
    if (prng.chance(w.hangProbability)) return `please wait @hang`;
    if (prng.chance(w.crashProbability)) return `oops @crash`;
    if (prng.chance(w.exitProbability)) return `bye @exit`;
    return `hello #${msgSeq}`;
  };

  const workload = (s: CoreStore): void => {
    const w = cfg.workload;
    const bees = s.listBees();
    if (bees.length < w.maxBees && prng.chance(w.createProbability)) {
      beeSeq += 1;
      const id = `bee-${beeSeq}`;
      s.createBee({ id, name: id, agent: "stub", substrate: "cell", cwd: dir });
      s.enqueueCommand("spawn", id);
      stats.beesCreated += 1;
      log(`work.create bee=${id}`);
    }
    if (prng.chance(w.sendProbability)) {
      const bee = prng.pick(s.listBees());
      if (bee) {
        msgSeq += 1;
        s.send(bee.id, directiveBody(), { sender: "cell-harness" });
        stats.sends += 1;
      }
    }
    if (prng.chance(w.stopProbability)) {
      const bee = prng.pick(s.listBees());
      const rt = bee ? s.currentRuntime(bee.id) : null;
      if (bee && rt && rt.state !== "stopped") s.enqueueCommand("stop", bee.id, { cause: "stopped_by_user" });
    }
    if (prng.chance(w.archiveProbability)) {
      const bee = prng.pick(s.listBees());
      if (bee && bee.lifecycle === "active") s.enqueueCommand("archive", bee.id);
    }
    if (prng.chance(w.deleteProbability)) {
      const all = s.listBees();
      const bee = prng.pick(all);
      if (bee && all.length > 1) s.enqueueCommand("delete", bee.id);
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
    let step = 0;
    for (step = 1; step <= cfg.steps; step++) {
      await sleep(cfg.stepMs);
      let s = store;
      if (s == null) {
        if (step < downUntilStep) continue;
        s = reopen(step);
      } else if (cfg.storeKillEverySteps != null && step % cfg.storeKillEverySteps === 0) {
        goDown("reboot_equivalent", s, step);
        continue;
      }
      workload(s);
      if (!stepDaemon(s, step)) continue;
      checker.checkStep(step, Date.now(), s, driver);
    }

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
      if (Date.now() > settleDeadline) break;
    }
    let s = store;
    if (s == null) s = reopen(step);
    for (let i = 0; i < 5; i++) {
      await sleep(cfg.stepMs);
      step += 1;
      if (stepDaemon(s, step)) checker.checkStep(step, Date.now(), s, driver);
      if (store == null) s = reopen(step);
    }
    checker.checkSettle(step, Date.now(), s);
    checker.checkReplay(step, s);
    stats.delivered = driver.consumedCount();
    s.close();
    store = null;
  } finally {
    driver.disposeAll();
    if (store != null) (store as CoreStore).close();
    await sleep(50);
    rmSync(dir, { recursive: true, force: true });
  }
  return { violations: checker.violations.slice(), stats };
}

function assertClean(seed: number, violations: Violation[]): void {
  if (violations.length > 0) for (const v of violations) console.error(formatViolation(v));
  assert.equal(violations.length, 0, `seed ${seed}: ${violations.length} invariant violation(s)`);
}

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    steps: 130,
    stepMs: 12,
    settleMaxMs: 15_000,
    storeKillEverySteps: null,
    downSteps: 4,
    executorCrashProbability: 0,
    workload: {
      maxBees: 3,
      createProbability: 0.12,
      sendProbability: 0.4,
      stopProbability: 0.02,
      archiveProbability: 0.02,
      deleteProbability: 0.01,
      hangProbability: 0,
      crashProbability: 0,
      exitProbability: 0,
    },
    policy: {
      bootHangTimeoutMs: 3_000,
      turnHangTimeoutMs: 2_000,
      commandsPerStep: 6,
      maxAttempts: 5,
      backoffBaseMs: 50,
    },
    i1BoundMs: 8_000,
    queueBoundMs: 12_000,
    stopKillGraceMs: 250,
    ...overrides,
  };
}

test("cell-real.1: quiet workload in real cells — all six invariants hold", async () => {
  const seed = 20260817;
  const { violations, stats } = await runCellSim(seed, baseConfig());
  assertClean(seed, violations);
  assert.ok(stats.settled, "run did not settle");
  assert.ok(stats.sends > 10, `only ${stats.sends} sends`);
  assert.ok(stats.delivered > 10, `only ${stats.delivered} deliveries`);
  console.log(`cell-real.1 stats: ${JSON.stringify(stats)}`);
});

test("cell-real.2: reboot-equivalent storm + agent faults — invariants hold, cells replay/adopt", async () => {
  const seed = 424242;
  const { violations, stats } = await runCellSim(seed, baseConfig({
    steps: 180,
    storeKillEverySteps: 35,
    executorCrashProbability: 0.25,
    workload: {
      maxBees: 3,
      createProbability: 0.12,
      sendProbability: 0.4,
      stopProbability: 0.03,
      archiveProbability: 0.02,
      deleteProbability: 0.012,
      hangProbability: 0.05,
      crashProbability: 0.05,
      exitProbability: 0.04,
    },
    i1BoundMs: 12_000,
    queueBoundMs: 16_000,
    settleMaxMs: 20_000,
  }));
  assertClean(seed, violations);
  assert.ok(stats.settled, "run did not settle");
  assert.ok(stats.storeKills >= 3, `storm did not run (${stats.storeKills} kills)`);
  assert.ok(stats.adoptedTotal > 0, "no surviving cell runtime was ever re-adopted");
  assert.ok(stats.delivered > 8, "deliveries did not survive the storm");
  console.log(`cell-real.2 stats: ${JSON.stringify(stats)}`);
});
