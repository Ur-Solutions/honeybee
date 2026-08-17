/**
 * SimDaemon — the command-queue executor loop + delivery loop over virtual
 * time, the same logic shape the real daemon will use. It is written strictly
 * against the RuntimeDriver interface (driver.ts) and the real CoreStore, so
 * WP3 can lift this shape onto a real driver.
 *
 * Responsibilities per step:
 *  1. drain driver observations into the store's four-state model
 *  2. hang policy: stop runtimes stuck in booting/running past their timeout
 *  3. execute queued commands (claim → effect → settle, idempotent, fenced)
 *  4. delivery loop: push undelivered mailbox messages into live runtimes
 *
 * Boot sequence (after every store reopen): reconcileAtBoot with the driver's
 * live pids, reap orphan processes the store no longer recognizes, and sweep
 * the mailbox for bees that need a send_wake. Crash anywhere is safe: the
 * mailbox and command queue are durable, and every effect is idempotent.
 */
import {
  CoreError,
  RUNTIME_TRANSITIONS,
  type CommandRow,
  type CoreStore,
  type RuntimeState,
} from "../../core/src/index.ts";
import type { DriverObservation, RuntimeDriver, StopCause } from "./driver.ts";
import type { ExecutorCrashPoint, FaultInjector } from "./faults.ts";

export interface DaemonPolicy {
  /** Stop a runtime stuck in `booting` longer than this many steps. */
  bootHangTimeoutSteps: number;
  /** Stop a runtime stuck in `running` longer than this many steps. */
  turnHangTimeoutSteps: number;
  /** Max commands executed per step (executor loop budget). */
  commandsPerStep: number;
}

/**
 * Thrown when the fault injector kills the executor mid-command. The claimed
 * command row stays `running`; boot replay (B5) requeues and re-executes it.
 */
export class ExecutorCrashError extends Error {
  readonly point: ExecutorCrashPoint;

  constructor(point: ExecutorCrashPoint) {
    super(`executor crash (${point})`);
    this.name = "ExecutorCrashError";
    this.point = point;
  }
}

export interface BootReport {
  adopted: number;
  stoppedByReconcile: number;
  requeuedCommands: number;
  orphansReaped: number;
  wakesEnqueued: number;
}

export interface SimDaemonOptions {
  store: CoreStore;
  driver: RuntimeDriver;
  injector: FaultInjector;
  policy: DaemonPolicy;
  now: () => number;
  log: (op: string) => void;
}

const LIVE: readonly RuntimeState[] = ["booting", "running", "idle"];

export class SimDaemon {
  private readonly store: CoreStore;
  private readonly driver: RuntimeDriver;
  private readonly injector: FaultInjector;
  private readonly policy: DaemonPolicy;
  private readonly now: () => number;
  private readonly log: (op: string) => void;

  constructor(opts: SimDaemonOptions) {
    this.store = opts.store;
    this.driver = opts.driver;
    this.injector = opts.injector;
    this.policy = opts.policy;
    this.now = opts.now;
    this.log = opts.log;
  }

  /** Boot: reconcile, reap orphans, sweep the mailbox for needed wakes. */
  boot(): BootReport {
    const live = this.driver.snapshotLive();
    const rec = this.store.reconcileAtBoot(
      live.map((p) => ({ pid: p.pid, startedAt: p.pidStartedAt })),
    );
    let orphansReaped = 0;
    for (const p of live) {
      const bee = this.store.getBee(p.beeId);
      const rt = bee ? this.store.currentRuntime(p.beeId) : null;
      const adopted = rt != null && rt.generation === p.generation && rt.state !== "stopped";
      if (!adopted) {
        // The store no longer recognizes this process (e.g. it was still booting
        // when the daemon died — no pid recorded — and reconcile stopped the row).
        this.driver.stop(p.beeId, p.generation, "stopped_by_system");
        orphansReaped += 1;
        this.log(`boot.reap bee=${p.beeId} gen=${p.generation}`);
      }
    }
    let wakesEnqueued = 0;
    for (const bee of this.store.listBees()) {
      if (this.ensureWake(bee.id)) wakesEnqueued += 1;
    }
    const report: BootReport = {
      adopted: rec.adopted.length,
      stoppedByReconcile: rec.stopped.length,
      requeuedCommands: rec.requeuedCommandIds.length,
      orphansReaped,
      wakesEnqueued,
    };
    this.log(
      `boot adopted=${report.adopted} stopped=${report.stoppedByReconcile} requeued=${report.requeuedCommands} reaped=${orphansReaped} wakes=${wakesEnqueued}`,
    );
    return report;
  }

  /** One step of daemon work. May throw ExecutorCrashError (fault injection). */
  step(): void {
    this.drainObservations();
    this.hangPolicy();
    this.executeCommands();
    this.deliveryLoop();
  }

  // -------------------------------------------------------------------------
  // observations → store state
  // -------------------------------------------------------------------------

  private drainObservations(): void {
    for (const obs of this.driver.observe()) {
      this.applyObservation(obs);
    }
  }

  private applyObservation(obs: DriverObservation): void {
    if (!this.store.getBee(obs.beeId)) {
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=${obs.kind} reason=no_bee`);
      return;
    }
    const rt = this.store.currentRuntime(obs.beeId);
    if (!rt) return;
    const target: RuntimeState =
      obs.kind === "exited" ? "stopped" : obs.kind === "turn_ended" ? "idle" : "running";
    if (obs.generation !== rt.generation) {
      // Stale-generation update: the store records the no-op (audit trail, B2).
      this.store.updateRuntimeState(
        obs.beeId,
        obs.generation,
        target,
        target === "stopped" ? { exitCause: obs.exitCause ?? "crashed" } : {},
      );
      return;
    }
    if (rt.state === target) {
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=${obs.kind} reason=already_${target}`);
      return;
    }
    if (!RUNTIME_TRANSITIONS[rt.state].includes(target)) {
      // Duplicate re-drain after a crash, or an event for a state the store has
      // already moved past. The extraction layer normalizes; skipping is safe.
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=${obs.kind} reason=${rt.state}->${target}`);
      return;
    }
    if (target === "stopped") {
      this.store.updateRuntimeState(obs.beeId, obs.generation, "stopped", {
        exitCause: obs.exitCause ?? "crashed",
      });
      this.log(`obs.exited bee=${obs.beeId} gen=${obs.generation} cause=${obs.exitCause}`);
      // A dead runtime with pending mail must be revived — no user intervention (I1).
      this.ensureWake(obs.beeId);
    } else if (obs.kind === "booted") {
      this.store.updateRuntimeState(obs.beeId, obs.generation, "running", {
        pid: obs.pid,
        pidStartedAt: obs.pidStartedAt,
      });
      this.log(`obs.booted bee=${obs.beeId} gen=${obs.generation} pid=${obs.pid}`);
    } else {
      this.store.updateRuntimeState(obs.beeId, obs.generation, target);
      if (obs.kind === "turn_ended") this.store.recordOutput(obs.beeId);
      this.log(`obs.${obs.kind} bee=${obs.beeId} gen=${obs.generation}`);
    }
  }

  /** Enqueue a send_wake iff the bee has undelivered mail and no live runtime and no pending wake. */
  private ensureWake(beeId: string): boolean {
    if (this.store.undeliveredMessages(beeId).length === 0) return false;
    const rt = this.store.currentRuntime(beeId);
    if (rt && LIVE.includes(rt.state)) return false;
    const gen = rt?.generation ?? 0;
    const pending = this.store
      .listCommands({ beeId })
      .some(
        (c) =>
          c.verb === "send_wake" &&
          (c.status === "queued" || c.status === "running") &&
          c.targetGeneration === gen,
      );
    if (pending) return false;
    this.store.enqueueCommand("send_wake", beeId);
    this.log(`wake.enqueued bee=${beeId} gen=${gen}`);
    return true;
  }

  // -------------------------------------------------------------------------
  // hang policy — the hook that turns hung runtimes into stopped ones
  // -------------------------------------------------------------------------

  private hangPolicy(): void {
    const now = this.now();
    for (const bee of this.store.listBees()) {
      const rt = this.store.currentRuntime(bee.id);
      if (!rt) continue;
      const overdue =
        (rt.state === "booting" && now - rt.startedAt > this.policy.bootHangTimeoutSteps) ||
        (rt.state === "running" && now - rt.updatedAt > this.policy.turnHangTimeoutSteps);
      if (!overdue) continue;
      const pendingStop = this.store
        .listCommands({ beeId: bee.id })
        .some(
          (c) =>
            c.verb === "stop" &&
            (c.status === "queued" || c.status === "running") &&
            c.targetGeneration === rt.generation,
        );
      if (pendingStop) continue;
      this.store.enqueueCommand("stop", bee.id, { cause: "stopped_by_system", reason: "hang_policy" });
      this.log(`policy.hang_stop bee=${bee.id} gen=${rt.generation} state=${rt.state}`);
    }
  }

  // -------------------------------------------------------------------------
  // executor loop
  // -------------------------------------------------------------------------

  private executeCommands(): void {
    for (let i = 0; i < this.policy.commandsPerStep; i++) {
      const cmd = this.store.claimNextCommand();
      if (!cmd) return;
      const crash = this.injector.executorCrash();
      if (crash === "before_effect") {
        this.log(`cmd.crash id=${cmd.id} verb=${cmd.verb} point=before_effect`);
        throw new ExecutorCrashError(crash);
      }
      let settled: boolean;
      try {
        settled = this.execute(cmd);
      } catch (err) {
        if (!(err instanceof CoreError)) throw err;
        // A contract rejection means the intent is moot (bee deleted, state moved
        // on, …) — settle done, mirroring B6's no-op philosophy.
        this.log(`cmd.moot id=${cmd.id} verb=${cmd.verb} err=${err.name}`);
        settled = true;
      }
      if (crash === "after_effect") {
        this.log(`cmd.crash id=${cmd.id} verb=${cmd.verb} point=after_effect`);
        throw new ExecutorCrashError(crash);
      }
      if (settled) this.store.completeCommand(cmd.id);
    }
  }

  /** Execute one claimed command. Returns true when the caller should settle it done. */
  private execute(cmd: CommandRow): boolean {
    switch (cmd.verb) {
      case "archive": {
        const bee = this.store.getBee(cmd.beeId);
        if (bee?.lifecycle === "active") this.store.archiveBee(cmd.beeId);
        this.log(`cmd.archive id=${cmd.id} bee=${cmd.beeId}`);
        return true;
      }
      case "unarchive": {
        const bee = this.store.getBee(cmd.beeId);
        if (bee?.lifecycle === "archived") this.store.unarchiveBee(cmd.beeId);
        this.log(`cmd.unarchive id=${cmd.id} bee=${cmd.beeId}`);
        return true;
      }
      case "delete": {
        const rt = this.store.currentRuntime(cmd.beeId);
        this.store.deleteBee(cmd.beeId); // settles this command too (pending → done)
        if (rt && LIVE.includes(rt.state)) {
          this.driver.stop(cmd.beeId, rt.generation, "stopped_by_system");
        }
        this.log(`cmd.delete id=${cmd.id} bee=${cmd.beeId}`);
        return true;
      }
      case "stop": {
        const gen = cmd.targetGeneration;
        const cause: StopCause =
          cmd.args.cause === "stopped_by_user" ? "stopped_by_user" : "stopped_by_system";
        const rt = this.store.currentRuntime(cmd.beeId);
        if (gen == null || !rt || rt.generation !== gen || rt.state === "stopped") return true;
        const { hadProcess } = this.driver.stop(cmd.beeId, gen, cause);
        if (!hadProcess) {
          // Parenthood certainty: no process exists, so the stop is a fact now.
          this.store.updateRuntimeState(cmd.beeId, gen, "stopped", { exitCause: cause });
          this.ensureWake(cmd.beeId);
        }
        this.log(`cmd.stop id=${cmd.id} bee=${cmd.beeId} gen=${gen} cause=${cause} hadProcess=${hadProcess}`);
        return true;
      }
      case "spawn":
      case "revive":
      case "send_wake": {
        const rt = this.store.currentRuntime(cmd.beeId);
        if (rt && LIVE.includes(rt.state)) {
          if (this.driver.hasProcess(cmd.beeId, rt.generation)) {
            // Idempotent replay: the runtime is already up. Nothing to do.
            this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} noop=live`);
            return true;
          }
          if (this.injector.driverTimeout()) {
            this.store.reportCommandFailure(cmd.id, "spawn_failed", "sim: driver start timeout");
            this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} timeout gen=${rt.generation}`);
            return false;
          }
          this.driver.start(cmd.beeId, rt.generation);
          this.store.clearFlag(cmd.beeId, "spawn_failed", "runtime started");
          this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} start gen=${rt.generation}`);
          return true;
        }
        if (this.injector.driverTimeout()) {
          this.store.reportCommandFailure(cmd.id, "spawn_failed", "sim: driver start timeout");
          this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} timeout`);
          return false;
        }
        const next = this.store.reviveBee(cmd.beeId);
        this.driver.start(cmd.beeId, next.generation);
        this.store.clearFlag(cmd.beeId, "spawn_failed", "runtime started");
        this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} revive gen=${next.generation}`);
        return true;
      }
      default:
        return true;
    }
  }

  // -------------------------------------------------------------------------
  // delivery loop
  // -------------------------------------------------------------------------

  private deliveryLoop(): void {
    for (const bee of this.store.listBees()) {
      const rt = this.store.currentRuntime(bee.id);
      if (!rt || rt.state === "stopped" || rt.state === "booting") continue;
      const msg = this.store.undeliveredMessages(bee.id)[0];
      if (!msg) continue;
      const outcome = this.driver.deliver(bee.id, rt.generation, msg.id, msg.body);
      if (outcome.accepted) {
        this.store.markDelivered(msg.id, rt.generation);
        this.log(`deliver bee=${bee.id} msg=${msg.id} gen=${rt.generation}`);
      } else {
        this.log(`deliver.refused bee=${bee.id} msg=${msg.id} reason=${outcome.reason}`);
      }
    }
  }
}
