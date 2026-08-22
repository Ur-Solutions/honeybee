/**
 * The WP5 invariant gate, tmux variant (`npm run v2:harness:real`, spec 05
 * test tier 3): the UNMODIFIED WP2 SimDaemon + six-invariant checker driving
 * the TmuxDriver — real tmux sessions on a private socket, real pane
 * processes — with the TRANSCRIPT-ONLY stub, proving the A3 equal-treatment
 * path end to end: a harness with no hooks and no notify gets the same
 * automation guarantees (I1 delivery, boundary observation, idle detection)
 * as everything else.
 *
 * The workload deliberately omits @hang directives: the transcript-only
 * observer derives turn ends from quiescence, so "hung" and "legitimately
 * long-running" are indistinguishable BY DESIGN. Silence never authorizes an
 * automatic stop.
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
import { TmuxDriver } from "../../src/driver.ts";
import { TmuxServer } from "../../src/tmux.ts";
import { AGENT_PATH, observationFor } from "../helpers.ts";

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

async function runTmuxSim(seed: number, cfg: RunConfig): Promise<{ violations: Violation[]; stats: RunStats }> {
  const dir = mkdtempSync(join(tmpdir(), "hbtmxr-"));
  const socketPath = join(dir, "tmux.sock");
  const dbPath = join(dir, "core.sqlite3");
  const prng = new Prng(seed);
  const driver = new TmuxDriver({
    socketPath,
    eventsDir: join(dir, "events"),
    stopKillGraceMs: cfg.stopKillGraceMs,
    allowKillServer: true,
    resolve: (beeId: string) => ({
      command: process.execPath,
      args: [AGENT_PATH],
      cwd: dir,
      env: {
        TMUX_STUB_STYLE: "transcript", // the A3 equal-treatment stub
        TMUX_STUB_TRANSCRIPT_DIR: join(dir, "tx", beeId),
        TMUX_STUB_TURN_MS: "40",
      },
      observation: observationFor("transcript", join(dir, "tx", beeId)),
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
    bootHangTimeoutSteps: cfg.policy.bootHangTimeoutMs,
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
      s.createBee({ id, name: id, agent: "stub", substrate: "tmux", cwd: dir });
      s.enqueueCommand("spawn", id);
      stats.beesCreated += 1;
      log(`work.create bee=${id}`);
    }
    if (prng.chance(w.sendProbability)) {
      const bee = prng.pick(s.listBees());
      if (bee) {
        msgSeq += 1;
        s.send(bee.id, directiveBody(), { sender: "tmux-harness" });
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
    checker.checkSettle(step, s);
    checker.checkReplay(step, s);
    stats.delivered = driver.consumedCount();
    s.close();
    store = null;
  } finally {
    driver.disposeAll();
    if (store != null) (store as CoreStore).close();
    try {
      new TmuxServer({ socketPath, allowKillServer: true }).killServer();
    } catch {
      // Server already gone.
    }
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
    steps: 110,
    stepMs: 25,
    settleMaxMs: 20_000,
    storeKillEverySteps: null,
    downSteps: 4,
    executorCrashProbability: 0,
    workload: {
      maxBees: 2,
      createProbability: 0.15,
      sendProbability: 0.3,
      stopProbability: 0.02,
      archiveProbability: 0.02,
      deleteProbability: 0.01,
      crashProbability: 0,
      exitProbability: 0,
    },
    policy: {
      // Quiescence-derived turn ends take turn+quiesce (~300ms); recovery is
      // based on explicit observation, never elapsed turn time.
      bootHangTimeoutMs: 5_000,
      commandsPerStep: 4,
      maxAttempts: 5,
      backoffBaseMs: 50,
    },
    i1BoundMs: 15_000,
    queueBoundMs: 20_000,
    stopKillGraceMs: 400,
    ...overrides,
  };
}

test("tmux-real.1: quiet workload, transcript-only observation — all six invariants hold", async () => {
  const seed = 20260817;
  const { violations, stats } = await runTmuxSim(seed, baseConfig());
  assertClean(seed, violations);
  assert.ok(stats.settled, "run did not settle");
  assert.ok(stats.sends > 8, `only ${stats.sends} sends`);
  assert.ok(stats.delivered > 8, `only ${stats.delivered} deliveries`);
  console.log(`tmux-real.1 stats: ${JSON.stringify(stats)}`);
});

test("tmux-real.2: reboot-equivalent storm + agent crashes/exits — invariants hold, sessions re-adopt", async () => {
  const seed = 424242;
  const { violations, stats } = await runTmuxSim(seed, baseConfig({
    steps: 160,
    storeKillEverySteps: 40,
    executorCrashProbability: 0.15,
    workload: {
      maxBees: 2,
      createProbability: 0.15,
      sendProbability: 0.3,
      stopProbability: 0.03,
      archiveProbability: 0.02,
      deleteProbability: 0.012,
      crashProbability: 0.05,
      exitProbability: 0.04,
    },
    settleMaxMs: 25_000,
  }));
  assertClean(seed, violations);
  assert.ok(stats.settled, "run did not settle");
  assert.ok(stats.storeKills >= 2, `storm did not run (${stats.storeKills} kills)`);
  assert.ok(stats.adoptedTotal > 0, "no surviving tmux runtime was ever re-adopted");
  assert.ok(stats.delivered > 5, "deliveries did not survive the storm");
  console.log(`tmux-real.2 stats: ${JSON.stringify(stats)}`);
});
