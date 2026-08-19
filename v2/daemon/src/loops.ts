/**
 * DaemonCore — the daemon's loop cores (WP4 of the reset), extracted from the
 * WP2 SimDaemon so one implementation serves both worlds:
 *
 *  - the invariant harness (`v2:harness`, `v2:harness:real`) drives this exact
 *    code under a virtual clock / fault injector via the SimDaemon wrapper
 *    (v2/harness/src/daemon.ts), so every WP2 invariant keeps proving the
 *    production loops;
 *  - the real daemon (daemon.ts) drives it over wall time with the HsrDriver.
 *
 * Responsibilities per step (spec 04 "Daemon behavior" 1, 3, 4, 5):
 *  1. drain driver observations into the store's four-state model
 *  2. flag policy: apply adapter condition-flag evidence (contrary-evidence
 *     clearing per spec 03 — every setter has a clearer); and record the
 *     harness session id a runtime reported (spec 07 §F: revive resumes it)
 *  3. hang policy: stop runtimes stuck in booting/running past their timeout
 *  4. scale-to-zero: stop(stopped_by_system) idle runtimes past the idle
 *     window (Q4 ruling; revive-on-message undoes it)
 *  5. degraded-runtime policy: a re-adopted runtime has no event stream or
 *     stdin (pipes died with the previous daemon process); when mail arrives
 *     for one, stop it so revive-on-message hands the mailbox to a fresh
 *     generation — delivery stays bounded, I1 holds
 *  6. execute queued commands (claim → effect via driver → settle,
 *     generation-fenced, idempotent). Revive-on-message is bounded by the
 *     store's spawn-failure budget: a runtime that exits during boot counts
 *     against the BEE (not the wake command), the next wake sits on the B5
 *     backoff table, and at the budget `spawn_failed` is set and wakes stop —
 *     an explicit `revive` resets the budget and retries regardless
 *  7. delivery loop: push undelivered mailbox messages into live runtimes,
 *     honoring per-message urgency (v8, spec 01 Q2 amendment): `next` = the
 *     accept point (unchanged), `idle` = hold while the runtime is running,
 *     `now` = interrupt the turn first, then deliver. Urgency governs
 *     eligibility only; among eligible messages FIFO enqueue order wins
 *  8. I1 telemetry: record undelivered-past-deadline messages as structured
 *     violations (spec 04 behavior 5 — the 99.99% counter). An `idle`
 *     message's clock starts at eligibility (runtime left `running`), not at
 *     enqueue — long turns are not false violations
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
import type { DriverObservation, RuntimeDriver, StopCause } from "../../harness/src/driver.ts";

/** Where the (injected) executor-crash fault hits, if it does. */
export type ExecutorCrashPoint = "none" | "before_effect" | "after_effect";

export interface DaemonPolicy {
  /** Stop a runtime stuck in `booting` longer than this many steps (ms for the real daemon). */
  bootHangTimeoutSteps: number;
  /** Stop a runtime stuck in `running` longer than this many steps (ms for the real daemon). */
  turnHangTimeoutSteps: number;
  /** Max commands executed per step (executor loop budget). */
  commandsPerStep: number;
  /**
   * Scale-to-zero (spec 04 behavior 3): stop(stopped_by_system) an idle
   * runtime after this window. Omitted/null = disabled (the harness default —
   * the sim proves the loops; the timer is daemon policy).
   */
  idleWindowSteps?: number | null;
  /**
   * I1 telemetry (spec 04 behavior 5): per pending mailbox position, the
   * delivery deadline in steps/ms. Omitted/null = telemetry off. The real
   * daemon computes this policy-aware (≥ hang timeout + boot + turn
   * allowances — the WP2 finding).
   */
  i1DeadlineSteps?: number | null;
}

/** Injected fault hooks (the harness's FaultInjector; absent in production). */
export interface FaultHooks {
  executorCrash(): ExecutorCrashPoint;
  driverTimeout(): boolean;
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

/** Condition-flag evidence, structurally matching HsrDriver's FlagEvidence. */
export interface FlagEvidenceLike {
  beeId: string;
  generation: number;
  flag: "auth_needed" | "resource_blocked" | "spawn_failed";
  action: "set" | "clear";
  detail: string;
}

/** Harness session identity, structurally matching HsrDriver's SessionEvidence. */
export interface SessionEvidenceLike {
  beeId: string;
  generation: number;
  sessionId: string;
}

/**
 * Optional driver capabilities beyond the WP2 RuntimeDriver contract. All are
 * duck-typed: the SimDriver has none of them and the loops stay byte-for-byte
 * compatible with the WP2 harness behavior when they are absent.
 */
interface ExtendedDriver {
  /** Drain adapter flag evidence (HsrDriver.observeEvidence). */
  observeEvidence?(): FlagEvidenceLike[];
  /** Process identity captured at spawn (HsrDriver.procOf) — the WP2 pid-at-spawn amendment. */
  procOf?(beeId: string, generation: number): { pid: number; pidStartedAt: number } | null;
  /** Whether (bee, generation) is a re-adopted degraded process (no event stream). */
  isDegraded?(beeId: string, generation: number): boolean;
  /** Drain harness session ids learned from booted signals (HsrDriver.observeSessions). */
  observeSessions?(): SessionEvidenceLike[];
}

/** One I1 deadline breach, shaped like the harness violation ledger. */
export interface I1ViolationEvent {
  detectedAt: number;
  beeId: string;
  messageId: number;
  enqueuedAt: number;
  deadline: number;
  detail: string;
}

export interface DaemonCoreOptions {
  store: CoreStore;
  driver: RuntimeDriver;
  policy: DaemonPolicy;
  now: () => number;
  log: (op: string) => void;
  faults?: FaultHooks;
  /** Recorder for I1 deadline breaches (the real daemon's i1_violations table). */
  onI1Violation?: (violation: I1ViolationEvent) => void;
  /** Q1 (spec 01): delete removes the session log file; core does no file I/O, the daemon does. */
  removeSessionLog?: (path: string) => void;
  /**
   * v7 (spec 08): account policy hook — called AFTER each flag evidence is
   * applied to the store, so the daemon can enact the account-level rules
   * (auth_needed ↔ accounts.status; rate-limit resource_blocked → exhaustion
   * evidence + automatic rotation). Absent in the harness (no accounts).
   */
  onFlagEvidence?: (ev: FlagEvidenceLike) => void;
}

const LIVE: readonly RuntimeState[] = ["booting", "running", "idle"];

export class DaemonCore {
  protected readonly store: CoreStore;
  protected readonly driver: RuntimeDriver;
  protected readonly policy: DaemonPolicy;
  protected readonly now: () => number;
  protected readonly log: (op: string) => void;
  private readonly faults: FaultHooks | null;
  private readonly onI1Violation: ((violation: I1ViolationEvent) => void) | null;
  private readonly removeSessionLog: ((path: string) => void) | null;
  private readonly onFlagEvidence: ((ev: FlagEvidenceLike) => void) | null;
  /** In-memory dedup so a breach is reported once per daemon lifetime; the recorder dedups durably. */
  private readonly reportedI1 = new Set<number>();

  constructor(opts: DaemonCoreOptions) {
    this.store = opts.store;
    this.driver = opts.driver;
    this.policy = opts.policy;
    this.now = opts.now;
    this.log = opts.log;
    this.faults = opts.faults ?? null;
    this.onI1Violation = opts.onI1Violation ?? null;
    this.removeSessionLog = opts.removeSessionLog ?? null;
    this.onFlagEvidence = opts.onFlagEvidence ?? null;
  }

  private get ext(): ExtendedDriver {
    return this.driver as ExtendedDriver;
  }

  /** Boot: reconcile, reap orphans, sweep the mailbox for needed wakes (spec 04 behavior 2). */
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
    this.applyEvidence();
    this.applySessionIds();
    this.hangPolicy();
    this.scaleToZeroPolicy();
    this.degradedMailPolicy();
    this.executeCommands();
    this.deliveryLoop();
    this.i1Telemetry();
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
    // v9 synthetic-boot budget: a non-synthetic booted/turn observation was
    // parsed by the adapter from REAL process output — the boot evidence that
    // resets the bee's spawn-failure budget and clears spawn_failed. Driver-
    // minted observations (synthetic: the readyAtSpawn booted, the deliver-
    // opened turn_started) prove nothing and never touch the budget.
    if (obs.kind !== "exited" && obs.synthetic !== true && rt.bootEvidence !== "real") {
      const { applied } = this.store.recordBootEvidence(obs.beeId, obs.generation);
      if (applied) this.log(`spawn.evidence bee=${obs.beeId} gen=${obs.generation} kind=${obs.kind}`);
    }
    if (obs.kind === "booted" && rt.state !== "booting") {
      // booted only ever moves booting → running. A late/duplicate booted
      // (readyAtSpawn harnesses emit their real init after the first message)
      // is evidence — recorded above — never a state edge (an idle runtime
      // must not phantom-start a turn from it).
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=booted reason=already_${rt.state}`);
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
      // v9: a generation whose running state came only from a synthetic
      // booted (bootEvidence 'synthetic') is still a boot failure when it
      // dies on its own — same budget as an exit during `booting`.
      const countable = rt.state === "booting" || rt.bootEvidence === "synthetic";
      const failuresBefore = countable ? (this.store.getBee(obs.beeId)?.spawnFailures ?? 0) : null;
      this.store.updateRuntimeState(obs.beeId, obs.generation, "stopped", {
        exitCause: obs.exitCause ?? "crashed",
        exitDetail: obs.detail,
      });
      this.log(
        `obs.exited bee=${obs.beeId} gen=${obs.generation} cause=${obs.exitCause}${obs.detail ? ` detail=${obs.detail}` : ""}`,
      );
      if (failuresBefore != null) {
        // The store counts a boot exit iff the process died on its own
        // (crashed/clean) — one budget per bee across wake-driven revives.
        const failures = this.store.getBee(obs.beeId)?.spawnFailures ?? 0;
        if (failures > failuresBefore) {
          const flagged = this.store.activeFlags(obs.beeId).some((f) => f.flag === "spawn_failed");
          this.log(`spawn.failure bee=${obs.beeId} gen=${obs.generation} failures=${failures} flagged=${flagged}`);
        }
      }
      // A dead runtime with pending mail must be revived — no user intervention
      // (I1) — on the boot-failure backoff table, and never while spawn_failed
      // is set (visibly blocked; the operator's revive is the way back).
      this.ensureWake(obs.beeId);
      this.reviveAfterStopIfRequested(obs.beeId, obs.generation);
    } else if (obs.kind === "booted") {
      this.store.updateRuntimeState(obs.beeId, obs.generation, "running", {
        pid: obs.pid,
        pidStartedAt: obs.pidStartedAt,
        // Provisional when driver-minted: the budget resets only on REAL
        // evidence (recordBootEvidence above), never on the synthetic booted.
        synthetic: obs.synthetic === true,
      });
      this.log(`obs.booted bee=${obs.beeId} gen=${obs.generation} pid=${obs.pid}${obs.synthetic ? " synthetic" : ""}`);
    } else {
      this.store.updateRuntimeState(obs.beeId, obs.generation, target);
      if (obs.kind === "turn_ended") this.store.recordOutput(obs.beeId);
      this.log(`obs.${obs.kind} bee=${obs.beeId} gen=${obs.generation}`);
    }
  }

  /**
   * Enqueue a send_wake iff the bee has undelivered mail, no live runtime and
   * no pending wake. The store owns the rule (send() shares it): a wake is
   * deferred on the B5 backoff table after boot failures and suppressed while
   * `spawn_failed` is set. Returns true iff a NEW wake was enqueued now.
   */
  private ensureWake(beeId: string): boolean {
    const { command, outcome } = this.store.enqueueWake(beeId);
    if (outcome === "suppressed") {
      this.log(`wake.suppressed bee=${beeId} flag=spawn_failed`);
      return false;
    }
    if (outcome !== "enqueued" || !command) return false;
    this.log(
      `wake.enqueued bee=${beeId} gen=${command.targetGeneration ?? 0}` +
        (command.nextAttemptAt > command.enqueuedAt ? ` notBefore=${command.nextAttemptAt}` : ""),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // flag policy — adapters report evidence, the daemon enacts it (spec 03/04)
  // -------------------------------------------------------------------------

  /**
   * Contrary-evidence clearing (spec 03, resolving WP2 ambiguity 6): every
   * flag-setter has a clearer in the same adapter, and this policy applies
   * both directions verbatim. Flags are bee-scoped; evidence from a stale
   * generation still describes this bee's provider boundary, so it applies.
   */
  private applyEvidence(): void {
    if (typeof this.ext.observeEvidence !== "function") return;
    for (const ev of this.ext.observeEvidence()) {
      if (!this.store.getBee(ev.beeId)) {
        this.log(`flag.skip bee=${ev.beeId} flag=${ev.flag} reason=no_bee`);
        continue;
      }
      if (ev.action === "set") {
        this.store.setFlag(ev.beeId, ev.flag, ev.detail);
      } else {
        this.store.clearFlag(ev.beeId, ev.flag, ev.detail);
      }
      this.log(`flag.${ev.action} bee=${ev.beeId} flag=${ev.flag} gen=${ev.generation}`);
      // v7: account policy (spec 08) rides the same evidence — never throws
      // into the loop (a policy bug must not stall observation drain).
      if (this.onFlagEvidence) {
        try {
          this.onFlagEvidence(ev);
        } catch (err) {
          this.log(`account.policy_error bee=${ev.beeId} flag=${ev.flag} err=${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /**
   * v7 (bee.swapAccount): a `stop` command may carry `thenRevive: true` —
   * "stop this generation, then start the next one" — the durable form of
   * stop → revive that a swap needs (a plain revive enqueued alongside the
   * stop would be claimed while the old process is still dying). When the
   * runtime is observed stopped, the pending intent is honored ONCE by
   * enqueueing a `revive` (which mints generation N+1 with the new account's
   * env). Idempotent: an existing queued/running revive/wake is enough.
   */
  private reviveAfterStopIfRequested(beeId: string, generation: number): void {
    const cmds = this.store.listCommands({ beeId });
    const requested = cmds.some(
      (c) => c.verb === "stop" && c.targetGeneration === generation && c.args.thenRevive === true && (c.status === "done" || c.status === "running"),
    );
    if (!requested) return;
    const pending = cmds.some(
      (c) => (c.verb === "revive" || c.verb === "send_wake") && (c.status === "queued" || c.status === "running") && (c.targetGeneration ?? 0) >= generation,
    );
    if (pending) return;
    // Only the generation the stop targeted; a later generation means the
    // revive already happened (or the operator moved on).
    const rt = this.store.currentRuntime(beeId);
    if (!rt || rt.generation !== generation || rt.state !== "stopped") return;
    const cmd = this.store.enqueueCommand("revive", beeId, { reason: "after_stop" });
    this.log(`revive.after_stop bee=${beeId} gen=${generation} cmd=${cmd.id}`);
  }

  /**
   * Continuity (spec 07 §F): the harness session/thread id a runtime reports
   * on boot is a fact about the BEE's conversation — record it so the next
   * generation resumes it. Only the current generation may write it: a stale
   * generation's late init describes a conversation the bee has moved past.
   */
  private applySessionIds(): void {
    if (typeof this.ext.observeSessions !== "function") return;
    for (const ev of this.ext.observeSessions()) {
      const rt = this.store.getBee(ev.beeId) ? this.store.currentRuntime(ev.beeId) : null;
      if (!rt || rt.generation !== ev.generation) {
        this.log(`session.skip bee=${ev.beeId} gen=${ev.generation} reason=${rt ? "stale_generation" : "no_bee"}`);
        continue;
      }
      const { applied } = this.store.recordProviderSessionId(ev.beeId, ev.sessionId);
      if (applied) this.log(`session.recorded bee=${ev.beeId} gen=${ev.generation} id=${ev.sessionId}`);
    }
  }

  // -------------------------------------------------------------------------
  // hang policy — the hook that turns hung runtimes into stopped ones
  // -------------------------------------------------------------------------

  private pendingStopExists(beeId: string, generation: number): boolean {
    return this.store
      .listCommands({ beeId })
      .some(
        (c) =>
          c.verb === "stop" &&
          (c.status === "queued" || c.status === "running") &&
          c.targetGeneration === generation,
      );
  }

  private hangPolicy(): void {
    const now = this.now();
    for (const bee of this.store.listBees()) {
      const rt = this.store.currentRuntime(bee.id);
      if (!rt) continue;
      const overdue =
        (rt.state === "booting" && now - rt.startedAt > this.policy.bootHangTimeoutSteps) ||
        (rt.state === "running" && now - rt.updatedAt > this.policy.turnHangTimeoutSteps);
      if (!overdue) continue;
      if (this.pendingStopExists(bee.id, rt.generation)) continue;
      this.store.enqueueCommand("stop", bee.id, { cause: "stopped_by_system", reason: "hang_policy" });
      this.log(`policy.hang_stop bee=${bee.id} gen=${rt.generation} state=${rt.state}`);
    }
  }

  // -------------------------------------------------------------------------
  // scale-to-zero — idle → stop(stopped_by_system) after the idle window
  // -------------------------------------------------------------------------

  private scaleToZeroPolicy(): void {
    const window = this.policy.idleWindowSteps;
    if (window == null) return;
    const now = this.now();
    for (const bee of this.store.listBees()) {
      const rt = this.store.currentRuntime(bee.id);
      if (!rt || rt.state !== "idle") continue;
      if (now - rt.updatedAt <= window) continue;
      // Pending mail means the delivery loop is about to use this runtime —
      // stopping it now would only bounce through revive-on-message.
      if (this.store.undeliveredMessages(bee.id).length > 0) continue;
      if (this.pendingStopExists(bee.id, rt.generation)) continue;
      this.store.enqueueCommand("stop", bee.id, { cause: "stopped_by_system", reason: "idle_window" });
      this.log(`policy.idle_stop bee=${bee.id} gen=${rt.generation} idleFor=${now - rt.updatedAt}`);
    }
  }

  // -------------------------------------------------------------------------
  // degraded-runtime policy — re-adopted processes cannot accept deliveries
  // -------------------------------------------------------------------------

  private degradedMailPolicy(): void {
    if (typeof this.ext.isDegraded !== "function") return;
    for (const bee of this.store.listBees()) {
      const rt = this.store.currentRuntime(bee.id);
      if (!rt || !LIVE.includes(rt.state)) continue;
      if (!this.ext.isDegraded(bee.id, rt.generation)) continue;
      if (this.store.undeliveredMessages(bee.id).length === 0) continue;
      if (this.pendingStopExists(bee.id, rt.generation)) continue;
      this.store.enqueueCommand("stop", bee.id, { cause: "stopped_by_system", reason: "degraded_runtime" });
      this.log(`policy.degraded_stop bee=${bee.id} gen=${rt.generation}`);
    }
  }

  // -------------------------------------------------------------------------
  // executor loop
  // -------------------------------------------------------------------------

  private executeCommands(): void {
    for (let i = 0; i < this.policy.commandsPerStep; i++) {
      const cmd = this.store.claimNextCommand();
      if (!cmd) return;
      const crash = this.faults?.executorCrash() ?? "none";
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

  /**
   * driver.start for a claimed spawn-shaped command. A driver that throws
   * BEFORE it owns a process (a cell whose provisioning failed: origin gone,
   * git/CoW error; a harness whose spawn spec cannot be resolved) is a
   * spawn failure on the B5 retry table — `spawn_failed` at the budget,
   * visibly — never a wedged `running` command or a tick error. Returns
   * false when the command was reported failed (the caller does not settle).
   */
  private startRuntime(cmd: CommandRow, generation: number): boolean {
    try {
      this.driver.start(cmd.beeId, generation);
      return true;
    } catch (err) {
      if (err instanceof CoreError) throw err; // contract rejections keep their moot path
      const detail = err instanceof Error ? err.message : String(err);
      const res = this.store.reportCommandFailure(cmd.id, "spawn_failed", `driver start failed: ${detail}`);
      this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} gen=${generation} start_failed status=${res.status} attempts=${res.attempts} err=${JSON.stringify(detail)}`);
      return false;
    }
  }

  /** Record pid + start-time at spawn (the WP2 amendment) when the driver can report it. */
  private recordProcAtSpawn(beeId: string, generation: number): void {
    if (typeof this.ext.procOf !== "function") return;
    const proc = this.ext.procOf(beeId, generation);
    if (proc) this.store.recordRuntimeProc(beeId, generation, proc);
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
        const result = this.store.deleteBee(cmd.beeId); // settles this command too (pending → done)
        if (rt && LIVE.includes(rt.state)) {
          this.driver.stop(cmd.beeId, rt.generation, "stopped_by_system");
        }
        if (result.sessionLogPath && this.removeSessionLog) {
          this.removeSessionLog(result.sessionLogPath);
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
          // thenRevive: this stop command is still `running` here (settled by the caller).
          this.reviveAfterStopIfRequested(cmd.beeId, gen);
        }
        this.log(`cmd.stop id=${cmd.id} bee=${cmd.beeId} gen=${gen} cause=${cause} hadProcess=${hadProcess}`);
        return true;
      }
      case "spawn":
      case "revive":
      case "send_wake": {
        if (cmd.verb === "revive") {
          // Operator action (explicit verb): a fresh spawn-failure budget and
          // the spawn_failed flag cleared — the attempt below runs regardless
          // of the flag. spawn_failed clears otherwise only on contrary
          // evidence (a successful boot), never on the mere act of starting.
          const { applied } = this.store.resetSpawnFailures(cmd.beeId, `operator revive (command ${cmd.id})`);
          if (applied) this.log(`spawn.budget_reset bee=${cmd.beeId} by=revive cmd=${cmd.id}`);
        }
        // revive may carry replacement per-bee args (schema v5): applied
        // before the driver resolves the spawn (same transaction as the new
        // generation on the mint path), so the started runtime sees them.
        const reviveArgs = cmd.verb === "revive" && cmd.args.args !== undefined ? (cmd.args.args as string[] | null) : undefined;
        const rt = this.store.currentRuntime(cmd.beeId);
        if (rt && LIVE.includes(rt.state)) {
          if (this.driver.hasProcess(cmd.beeId, rt.generation)) {
            // Idempotent replay: the runtime is already up. Nothing to do.
            this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} noop=live`);
            return true;
          }
          if (this.faults?.driverTimeout() ?? false) {
            this.store.reportCommandFailure(cmd.id, "spawn_failed", "sim: driver start timeout");
            this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} timeout gen=${rt.generation}`);
            return false;
          }
          if (reviveArgs !== undefined) this.store.updateBeeArgs(cmd.beeId, reviveArgs);
          if (!this.startRuntime(cmd, rt.generation)) return false;
          this.recordProcAtSpawn(cmd.beeId, rt.generation);
          this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} start gen=${rt.generation}`);
          return true;
        }
        if (this.faults?.driverTimeout() ?? false) {
          this.store.reportCommandFailure(cmd.id, "spawn_failed", "sim: driver start timeout");
          this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} timeout`);
          return false;
        }
        const next = this.store.reviveBee(cmd.beeId, reviveArgs === undefined ? {} : { args: reviveArgs });
        if (!this.startRuntime(cmd, next.generation)) return false;
        this.recordProcAtSpawn(cmd.beeId, next.generation);
        this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} revive gen=${next.generation}`);
        return true;
      }
      default:
        return true;
    }
  }

  // -------------------------------------------------------------------------
  // delivery loop (v8: urgency-aware — spec 01 Q2 amendment 2026-08-18)
  // -------------------------------------------------------------------------

  /**
   * `now` messages whose turn-interrupt has already been issued (per message
   * id), so a slow-to-land turn_ended is not re-interrupted every step.
   * In-memory on purpose: after a daemon restart a still-undelivered `now`
   * message earns at most one fresh interrupt — idempotent and correct
   * (the message IS still urgent).
   */
  private readonly interruptRequested = new Set<number>();

  /**
   * Eligibility/ordering rule (Q2 amendment): urgency governs WHEN a message
   * becomes eligible for delivery —
   *   next — always eligible (today's behavior: the harness's accept point);
   *   now  — always eligible; mid-turn it additionally asks the driver to
   *          interrupt the current turn (once), then delivers at the
   *          resulting accept point;
   *   idle — eligible only while the runtime is NOT `running` (a running turn
   *          is never disturbed; revive-on-message for stopped bees is
   *          unchanged and urgency never affects wakes).
   * Among ELIGIBLE messages, enqueue order (per-bee FIFO, Q2) wins: an `idle`
   * message waiting out a turn does not block a later `next`/`now` message
   * from delivering at the next accept point.
   */
  private deliveryLoop(): void {
    for (const bee of this.store.listBees()) {
      const rt = this.store.currentRuntime(bee.id);
      if (!rt || rt.state === "stopped" || rt.state === "booting") continue;
      const pending = this.store.undeliveredMessages(bee.id);
      if (pending.length === 0) continue;
      const eligible = rt.state === "running" ? pending.filter((m) => m.urgency !== "idle") : pending;
      if (eligible.length === 0) continue;
      if (rt.state === "running") {
        // Mid-turn `now`: interrupt first (the v6 verb), then deliver. One
        // interrupt per message; an eligible `now` behind an undelivered
        // `next` still interrupts — the accept point it creates serves the
        // whole FIFO, which keeps delivering in enqueue order.
        const urgent = eligible.find((m) => m.urgency === "now" && !this.interruptRequested.has(m.id));
        if (urgent) {
          const res = this.driver.interrupt(bee.id, rt.generation);
          // no_process / not_ready resolve on later steps (exit observation,
          // driver-side boot skew) — retry then. interrupted / idle /
          // unsupported are final: the accept point exists or never will.
          if (res.interrupted || res.reason === "idle" || res.reason === "unsupported") {
            this.interruptRequested.add(urgent.id);
          }
          this.log(
            `deliver.interrupt bee=${bee.id} msg=${urgent.id} gen=${rt.generation} interrupted=${res.interrupted}` +
              (res.reason ? ` reason=${res.reason}` : ""),
          );
        }
      }
      const msg = eligible[0] as (typeof eligible)[number];
      const outcome = this.driver.deliver(bee.id, rt.generation, msg.id, msg.body);
      if (outcome.accepted) {
        this.store.markDelivered(msg.id, rt.generation);
        this.interruptRequested.delete(msg.id);
        this.log(`deliver bee=${bee.id} msg=${msg.id} gen=${rt.generation} urgency=${msg.urgency}`);
      } else {
        this.log(`deliver.refused bee=${bee.id} msg=${msg.id} reason=${outcome.reason}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // I1 telemetry — the 99.99% counter (spec 04 behavior 5)
  // -------------------------------------------------------------------------

  /**
   * Mirrors the harness checker's I1 shape: per-bee pending queue, position-
   * aware deadlines, and a suspended clock while a closed-list flag is active
   * (a visibly blocked bee is at an external boundary — I3/I6 territory).
   */
  private i1Telemetry(): void {
    const bound = this.policy.i1DeadlineSteps;
    const record = this.onI1Violation;
    if (bound == null || record == null) return;
    const now = this.now();
    for (const bee of this.store.listBees()) {
      if (this.store.activeFlags(bee.id).length > 0) continue;
      const rt = this.store.currentRuntime(bee.id);
      const pending = this.store.undeliveredMessages(bee.id);
      pending.forEach((m, pos) => {
        // v8 (Q2 amendment): an `idle` message's deadline clock starts when it
        // becomes ELIGIBLE (the runtime not `running`), not at enqueue — a
        // long turn is exactly what `idle` opted into waiting for, never an
        // I1 violation. While the runtime is running the clock is suspended;
        // once out of `running`, the base is that transition (rt.updatedAt).
        let base = m.enqueuedAt;
        if (m.urgency === "idle") {
          if (rt?.state === "running") return;
          base = Math.max(base, rt?.updatedAt ?? m.enqueuedAt);
        }
        const deadline = base + (pos + 1) * bound;
        if (now <= deadline || this.reportedI1.has(m.id)) return;
        this.reportedI1.add(m.id);
        const detail = `message ${m.id} undelivered past deadline (enqueued=${m.enqueuedAt} urgency=${m.urgency} pos=${pos} deadline=${deadline} now=${now})`;
        record({ detectedAt: now, beeId: bee.id, messageId: m.id, enqueuedAt: m.enqueuedAt, deadline, detail });
        this.log(`i1.violation bee=${bee.id} msg=${m.id} deadline=${deadline}`);
      });
    }
  }
}
