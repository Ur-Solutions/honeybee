/**
 * The simulated node: the real WP1 CoreStore + SimDriver + SimDaemon + fault
 * injector, driven by a seeded random workload under a virtual clock, with the
 * invariant checker evaluated after every step.
 *
 * `runSim(seed, dbPath, config)` is fully deterministic: the same (seed,
 * config) reproduces the same op log, the same violations and the same final
 * state — the replayability guarantee of the spec.
 */
import { openCoreStore, type CoreStore, type StateDump } from "../../core/src/index.ts";
import { SimClock } from "./clock.ts";
import { Prng } from "./prng.ts";
import { SimDriver, type SimDriverConfig } from "./sim-driver.ts";
import { FaultInjector, type FaultConfig } from "./faults.ts";
import { ExecutorCrashError, SimDaemon, type DaemonPolicy } from "./daemon.ts";
import {
  InvariantChecker,
  takePreBootSnapshot,
  type PreBootSnapshot,
  type Violation,
} from "./invariants.ts";

export interface WorkloadConfig {
  maxBees: number;
  createProbability: number;
  sendProbability: number;
  stopProbability: number;
  archiveProbability: number;
  deleteProbability: number;
}

export interface PolicyConfig extends DaemonPolicy {
  /** B5 retry budget handed to the CoreStore. */
  maxAttempts: number;
  /** B5 backoff base in sim steps handed to the CoreStore. */
  backoffBaseSteps: number;
}

export interface SimConfig {
  /** Workload steps (faults + traffic). */
  steps: number;
  /** Quiescent steps at the end: no faults, no traffic — storms settle (I3). */
  settleSteps: number;
  driver: SimDriverConfig;
  faults: FaultConfig;
  workload: WorkloadConfig;
  policy: PolicyConfig;
  /** I1 bound override; default Q1: 2 × (max boot delay + max turn duration). */
  i1BoundSteps?: number;
  /** I6 bound: max age of an unsettled command, in steps. */
  queueBoundSteps: number;
  maxViolations: number;
  /** Op-history lines attached to each violation. */
  opLogTail: number;
}

export function defaultConfig(): SimConfig {
  return {
    steps: 400,
    settleSteps: 150,
    driver: {
      bootDelay: [2, 6],
      turnDuration: [3, 10],
      crashProbability: 0,
      hangProbability: 0,
      exitProbability: 0.02,
    },
    faults: {
      daemonCrashEvery: null,
      daemonCrashProbability: 0,
      machineRebootEvery: null,
      machineRebootProbability: 0,
      executorCrashProbability: 0,
      driverTimeoutProbability: 0,
      daemonDownSteps: [1, 3],
    },
    workload: {
      maxBees: 4,
      createProbability: 0.08,
      sendProbability: 0.35,
      stopProbability: 0.03,
      archiveProbability: 0.02,
      deleteProbability: 0.01,
    },
    policy: {
      bootHangTimeoutSteps: 20,
      turnHangTimeoutSteps: 30,
      commandsPerStep: 4,
      maxAttempts: 4,
      backoffBaseSteps: 2,
    },
    queueBoundSteps: 200,
    maxViolations: 25,
    opLogTail: 40,
  };
}

/** Deep-ish partial: every section may be partially overridden. */
export interface SimConfigOverrides {
  steps?: number;
  settleSteps?: number;
  driver?: Partial<SimDriverConfig>;
  faults?: Partial<FaultConfig>;
  workload?: Partial<WorkloadConfig>;
  policy?: Partial<PolicyConfig>;
  i1BoundSteps?: number;
  queueBoundSteps?: number;
  maxViolations?: number;
  opLogTail?: number;
}

export function makeConfig(overrides: SimConfigOverrides = {}): SimConfig {
  const d = defaultConfig();
  return {
    ...d,
    ...overrides,
    driver: { ...d.driver, ...overrides.driver },
    faults: { ...d.faults, ...overrides.faults },
    workload: { ...d.workload, ...overrides.workload },
    policy: { ...d.policy, ...overrides.policy },
  };
}

/** Q1 default: 2 × (max boot delay + max turn duration), per pending message. */
export function i1DefaultBoundSteps(cfg: SimConfig): number {
  return 2 * (cfg.driver.bootDelay[1] + cfg.driver.turnDuration[1]);
}

export interface SimStats {
  sends: number;
  delivered: number;
  beesCreated: number;
  daemonCrashes: number;
  machineReboots: number;
  executorCrashes: number;
  boots: number;
  machineRestartStops: number;
  systemStops: number;
  wakesEnqueued: number;
}

export interface SimResult {
  seed: number;
  violations: Violation[];
  opLog: string[];
  stats: SimStats;
  finalDump: StateDump;
}

export type DriverFactory = (cfg: SimDriverConfig, prng: Prng, now: () => number) => SimDriver;

const OP_LOG_CAP = 4000;

export function runSim(
  seed: number,
  dbPath: string,
  config: SimConfig,
  driverFactory?: DriverFactory,
): SimResult {
  const clock = new SimClock();
  const prng = new Prng(seed);
  const driver = (driverFactory ?? ((c, p, n) => new SimDriver(c, p, n)))(
    config.driver,
    prng,
    clock.now,
  );
  const injector = new FaultInjector(config.faults, prng);
  const opLog: string[] = [];
  let currentStep = 0;
  const log = (op: string): void => {
    if (opLog.length >= OP_LOG_CAP) opLog.shift();
    opLog.push(`s${currentStep} ${op}`);
  };
  const opsTail = (): string[] => opLog.slice(-config.opLogTail);

  const checker = new InvariantChecker(
    seed,
    {
      i1BoundSteps: config.i1BoundSteps ?? i1DefaultBoundSteps(config),
      queueBoundSteps: config.queueBoundSteps,
      maxAttempts: config.policy.maxAttempts,
      turnHangTimeoutSteps: config.policy.turnHangTimeoutSteps,
    },
    opsTail,
    config.maxViolations,
  );

  const stats: SimStats = {
    sends: 0,
    delivered: 0,
    beesCreated: 0,
    daemonCrashes: 0,
    machineReboots: 0,
    executorCrashes: 0,
    boots: 0,
    machineRestartStops: 0,
    systemStops: 0,
    wakesEnqueued: 0,
  };

  const storeOpts = {
    now: clock.now,
    maxAttempts: config.policy.maxAttempts,
    backoffBaseMs: config.policy.backoffBaseSteps,
  };

  let store: CoreStore | null = openCoreStore(dbPath, storeOpts);
  let daemon = new SimDaemon({ store, driver, injector, policy: config.policy, now: clock.now, log });
  const firstBoot = daemon.boot();
  stats.boots += 1;
  stats.wakesEnqueued += firstBoot.wakesEnqueued;

  let downUntil = 0;
  let preBoot: PreBootSnapshot = { failedCommandIds: [], activeFlagIds: [] };
  let downKind = "daemon_crash";
  let beeSeq = 0;
  let msgSeq = 0;
  let settling = false;

  const goDown = (kind: string, snapshotFrom: CoreStore): void => {
    preBoot = takePreBootSnapshot(snapshotFrom);
    snapshotFrom.close();
    store = null;
    downKind = kind;
    if (kind === "machine_reboot") {
      driver.killAll();
      stats.machineReboots += 1;
    } else if (kind === "executor_crash") {
      stats.executorCrashes += 1;
    } else {
      stats.daemonCrashes += 1;
    }
    downUntil = currentStep + injector.downSteps();
    log(`fault.${kind} downUntil=${downUntil}`);
  };

  const reopen = (step: number): CoreStore => {
    const s = openCoreStore(dbPath, storeOpts);
    store = s;
    daemon = new SimDaemon({ store: s, driver, injector, policy: config.policy, now: clock.now, log });
    const report = daemon.boot();
    stats.boots += 1;
    stats.machineRestartStops += downKind === "machine_reboot" ? report.stoppedByReconcile : 0;
    stats.wakesEnqueued += report.wakesEnqueued;
    checker.checkBoot(step, s, driver, preBoot, downKind);
    return s;
  };

  const workload = (s: CoreStore): void => {
    const bees = s.listBees();
    if (bees.length < config.workload.maxBees && prng.chance(config.workload.createProbability)) {
      beeSeq += 1;
      const id = `bee-${beeSeq}`;
      s.createBee({ id, name: id, agent: "sim", substrate: "sim", cwd: "/sim" });
      s.enqueueCommand("spawn", id);
      stats.beesCreated += 1;
      log(`work.create bee=${id}`);
    }
    if (prng.chance(config.workload.sendProbability)) {
      const bee = prng.pick(s.listBees());
      if (bee) {
        msgSeq += 1;
        // v8 urgency dimension: mostly `next` (the default path), with `now`
        // (mid-turn interrupts) and `idle` (held while running) mixed in so
        // the fuzz exercises eligibility + the interrupt path + the
        // suspended I1 clock under every fault schedule.
        const urgency = prng.pick(["next", "next", "next", "now", "idle"] as const) ?? "next";
        const res = s.send(bee.id, `m${msgSeq}`, { sender: "sim", urgency });
        stats.sends += 1;
        log(`work.send bee=${bee.id} msg=${res.message.id} urgency=${urgency} wake=${res.wakeCommand?.id ?? "none"}`);
      }
    }
    if (prng.chance(config.workload.stopProbability)) {
      const bee = prng.pick(s.listBees());
      const rt = bee ? s.currentRuntime(bee.id) : null;
      if (bee && rt && rt.state !== "stopped") {
        s.enqueueCommand("stop", bee.id, { cause: "stopped_by_user" });
        stats.systemStops += 1;
        log(`work.stop bee=${bee.id} gen=${rt.generation}`);
      }
    }
    if (prng.chance(config.workload.archiveProbability)) {
      const bee = prng.pick(s.listBees());
      if (bee && bee.lifecycle === "active") {
        s.enqueueCommand("archive", bee.id);
        log(`work.archive bee=${bee.id}`);
      }
    }
    if (prng.chance(config.workload.deleteProbability)) {
      const all = s.listBees();
      const bee = prng.pick(all);
      if (bee && all.length > 1) {
        s.enqueueCommand("delete", bee.id);
        log(`work.delete bee=${bee.id}`);
      }
    }
  };

  const totalSteps = config.steps + config.settleSteps;
  for (let step = 1; step <= totalSteps; step++) {
    currentStep = step;
    clock.advance(1);
    const now = clock.now();
    if (!settling && step > config.steps) {
      settling = true;
      injector.disable();
      driver.quiesce();
      log("settle.begin");
    }

    let s = store;
    if (s == null) {
      // Daemon down: the world keeps moving, the store does not.
      driver.tick();
      if (step < downUntil) continue;
      s = reopen(step);
    } else {
      const fault = injector.stepFault(step);
      if (fault !== "none") {
        goDown(fault, s);
        continue;
      }
      driver.tick();
    }

    if (!settling) workload(s);

    try {
      daemon.step();
    } catch (err) {
      if (err instanceof ExecutorCrashError) {
        goDown("executor_crash", s);
        continue;
      }
      throw err;
    }

    checker.checkStep(step, now, s, driver);
  }

  // The run must end with the store open for the final checks.
  let s = store;
  if (s == null) {
    currentStep = totalSteps;
    s = reopen(totalSteps);
  }
  checker.checkSettle(totalSteps, clock.now(), s);
  checker.checkReplay(totalSteps, s);
  stats.delivered = driver.consumedCount();
  const finalDump = s.dumpState();
  s.close();

  return { seed, violations: checker.violations, opLog, stats, finalDump };
}
