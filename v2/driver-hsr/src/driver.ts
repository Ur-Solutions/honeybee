/**
 * HsrDriver — the first real substrate driver (WP3 of the reset).
 *
 * Implements the RuntimeDriver interface EXACTLY as fixed by WP2
 * (v2/harness/src/driver.ts): the WP2 SimDaemon drives this driver unmodified.
 * Spec: docs/design/specs/reset-03-hsr-driver.md.
 *
 * Behavior mapping to the spec:
 *  1. Parenthood — `start` spawns the agent CLI as a direct child in its OWN
 *     process group (detached:true), and captures pid + start-time AT SPAWN
 *     (`procOf`), so the caller can record them in core's createBee/reviveBee
 *     `proc` (the WP2 pid-at-spawn amendment) and a daemon restart at any
 *     point can re-adopt.
 *  2. Truth = structured events — the driver consumes the child's stdout as an
 *     NDJSON line stream; no screen scraping. Every raw line is appended
 *     VERBATIM to the bee's session log (Q1: the log is the native stream;
 *     adapters re-derive observations); the harness adapter distills lines
 *     into DriverObservations and condition-flag evidence.
 *  3. Deliver — writes the adapter-encoded message to the child's stdin at its
 *     accept point. Deterministic: accepted, or refused with `no_process` /
 *     `not_ready` (Q2: a booting runtime refuses; the daemon's delivery loop
 *     retries — no hidden driver-side queue). Delivery doubt cannot exist.
 *  4. Stop — signals the exact spawned process: TERM to its process group,
 *     escalate to KILL after a bounded wait. A dead-already process is
 *     `hadProcess:false`, never an error.
 *  5. Exact identity everywhere — signal targets are only ever the pid the
 *     driver itself spawned and still holds the live ChildProcess handle for
 *     (parenthood: the pid cannot be recycled before the exit event fires,
 *     because the unreaped child holds it). pid + start-time are the durable
 *     identity handed to core for cross-restart re-adoption. No name, alias
 *     or pane is ever a signal target (the CO.a8d2 lesson).
 *  6. observe() never blocks — events drain from an internal buffer fed by
 *     stdout-line and child-exit callbacks. Undrained events survive a daemon
 *     restart (the driver object outlives the store connection; a machine
 *     reboot kills driver and children together and B7 reconciliation takes
 *     over from snapshotLive()).
 *
 * WP4 addition — cross-restart re-adoption (contract §3.2): when the daemon
 * PROCESS restarts, the ChildProcess handles and pipes are gone but detached
 * children may survive. `adopt(beeId, generation, pid, pidStartedAt)` verifies
 * exact identity (pid alive + OS start time within tolerance of the recorded
 * spawn stamp) and registers the process as *degraded*: it counts as live
 * (snapshotLive/hasProcess — so reconcileAtBoot keeps its runtime row, B7),
 * can be stopped (signaled by verified pid), and its death is observed by
 * polling — but it has no event stream and no stdin, so `deliver` refuses and
 * the daemon's degraded-runtime policy rotates it out when mail arrives.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  DeliverOutcome,
  DriverObservation,
  LiveProcess,
  RuntimeDriver,
  StopCause,
} from "../../harness/src/driver.ts";
import type { HarnessAdapter } from "../../adapters/src/index.ts";
import { pidAlive, verifyProcessIdentity } from "./psutil.ts";

/** What `start` needs to know per bee: which agent, how to spawn it. */
export interface SpawnSpec {
  adapter: HarnessAdapter;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface HsrDriverConfig {
  /** Resolve the spawn spec for a bee (agent binary + adapter). */
  resolve(beeId: string): SpawnSpec;
  /** Directory for session logs; one `<beeId>.jsonl` per bee, verbatim native stream. */
  sessionLogDir: string;
  /** Bounded wait between TERM and KILL escalation (spec point 4). Default 5000ms. */
  stopKillGraceMs?: number;
  /** Start-time tolerance for cross-restart re-adoption identity checks. Default 5000ms. */
  adoptToleranceMs?: number;
  now?: () => number;
}

/** Condition-flag evidence surfaced by adapters, stamped with process identity. */
export interface FlagEvidence {
  beeId: string;
  generation: number;
  flag: "auth_needed" | "resource_blocked" | "spawn_failed";
  action: "set" | "clear";
  detail: string;
}

interface ManagedProcess {
  beeId: string;
  generation: number;
  pid: number;
  pidStartedAt: number;
  /** Null for a re-adopted (degraded) process — the handle died with the previous daemon. */
  child: ChildProcess | null;
  /** Null for a re-adopted (degraded) process — there is no event stream to normalize. */
  adapter: HarnessAdapter | null;
  /** True when this process was re-adopted across a daemon restart (no pipes). */
  degraded: boolean;
  /** Driver-side accept-point phase; the store's state is derived downstream. */
  phase: "booting" | "running" | "idle";
  sessionId: string | null;
  /** First requested stop cause; fixes the exit cause of a signaled process. */
  stopCause: StopCause | null;
  killTimer: NodeJS.Timeout | null;
  stdoutRest: string;
  exited: boolean;
}

export class HsrDriver implements RuntimeDriver {
  private readonly cfg: HsrDriverConfig;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly adoptTolMs: number;
  /** Keyed by beeId — at most one live process per bee (driver-level invariant). */
  private readonly procs = new Map<string, ManagedProcess>();
  /**
   * Real-process asynchrony the SimDriver never had: a stop() leaves the old
   * process *dying* (TERM sent, exit event pending) while the daemon may
   * already start the next generation. `start` for a bee whose process is
   * dying is deferred here and spawned from the old process's exit callback —
   * still "returns immediately; boot progress arrives as observations".
   */
  private readonly pendingStarts = new Map<string, { generation: number }>();
  private events: DriverObservation[] = [];
  private evidence: FlagEvidence[] = [];
  /** Delivery ground truth for the invariant checker: messageId → generation. */
  private readonly consumed = new Map<number, number>();

  constructor(cfg: HsrDriverConfig) {
    this.cfg = cfg;
    this.now = cfg.now ?? Date.now;
    this.graceMs = cfg.stopKillGraceMs ?? 5000;
    this.adoptTolMs = cfg.adoptToleranceMs ?? 5000;
    mkdirSync(cfg.sessionLogDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // RuntimeDriver — the fixed WP2 contract
  // -------------------------------------------------------------------------

  start(beeId: string, generation: number): void {
    const existing = this.procs.get(beeId);
    if (existing) {
      if (existing.stopCause != null || this.pendingStarts.has(beeId)) {
        // The previous generation is dying (exit event pending). Defer the
        // spawn to its exit callback — one live process per bee, always.
        this.pendingStarts.set(beeId, { generation });
        return;
      }
      throw new Error(
        `hsr driver: bee ${beeId} already has a live process (generation ${existing.generation}, pid ${existing.pid})`,
      );
    }
    const spec = this.cfg.resolve(beeId);
    // Own process group (spec point 1): detached puts the child in a new
    // group whose pgid is the child's pid, so group signals reach the whole
    // agent process tree and never any sibling of ours.
    if (process.env.HIVE_SPAWN_TRACE) {
      // Diagnostics only: exact spawn shape for post-mortem replay.
      appendFileSync(process.env.HIVE_SPAWN_TRACE, JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd, envKeys: Object.keys(spec.env ?? {}).length, at: Date.now() }) + "\n");
    }
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? { ...process.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const proc: ManagedProcess = {
      beeId,
      generation,
      // pid captured AT SPAWN (WP2 amendment); -1 only if the spawn itself
      // failed, in which case the error handler below reports exited(crashed).
      pid: child.pid ?? -1,
      pidStartedAt: this.now(),
      child,
      adapter: spec.adapter,
      degraded: false,
      phase: "booting",
      sessionId: null,
      stopCause: null,
      killTimer: null,
      stdoutRest: "",
      exited: false,
    };
    this.procs.set(beeId, proc);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(proc, chunk));
    // stderr is diagnostics, not the structured stream (Q1): keep it out of
    // the session log but drain it so the child never blocks on a full pipe.
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.appendSidecar(beeId, String(chunk));
    });
    // Spawn failure (missing binary, EACCES): surface as exited(crashed) so it
    // flows through the daemon's spawn-retry path, never as a driver throw.
    child.on("error", () => this.onExit(proc, null, null));
    child.on("exit", (code, signal) => this.onExit(proc, code, signal));
    // stdin errors (EPIPE against a dying child) must not crash the daemon.
    child.stdin?.on("error", () => undefined);

    for (const line of spec.adapter.bootLines()) this.writeLine(proc, line);

    if (spec.adapter.readyAtSpawn) {
      // claude stream-json emits nothing until the first stdin message; treat
      // spawn as ready (stdin buffers safely) instead of deadlocking on init.
      proc.phase = "idle";
      this.events.push({
        beeId,
        generation,
        kind: "booted",
        pid: proc.pid,
        pidStartedAt: proc.pidStartedAt,
      });
    }
  }

  deliver(beeId: string, generation: number, messageId: number, body: string): DeliverOutcome {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) {
      return { accepted: false, reason: "no_process" };
    }
    // A re-adopted process has no stdin (pipes died with the previous daemon).
    // Refuse deterministically; the daemon's degraded-runtime policy rotates
    // the generation so the mailbox record reaches a fresh runtime.
    if (p.degraded || p.adapter == null) return { accepted: false, reason: "not_ready" };
    // Q2 resolution: a booting runtime refuses; the daemon retries.
    if (p.phase === "booting") return { accepted: false, reason: "not_ready" };
    // A dying (TERM'd) process has no accept point: it might still read stdin
    // but will never work the turn — accepting would mark the mailbox row
    // delivered and doom the message. Refuse; the exit observation follows
    // and the next generation consumes it (delivery doubt cannot exist).
    if (p.stopCause != null) return { accepted: false, reason: "not_ready" };
    // A harness without a mid-turn accept point refuses until idle.
    if (p.phase === "running" && !p.adapter.acceptsMidTurn) {
      return { accepted: false, reason: "not_ready" };
    }
    const encoded = p.adapter.encodeMessage(body, { sessionId: p.sessionId, messageId });
    if (encoded == null) return { accepted: false, reason: "not_ready" };
    if (!p.child?.stdin || p.child.stdin.destroyed || !p.child.stdin.writable) {
      // stdin gone means the process is dying; its exit observation follows.
      return { accepted: false, reason: "no_process" };
    }
    this.writeLine(p, encoded);
    // Ground truth recorded at the accept point, deterministic (spec point 3).
    this.consumed.set(messageId, generation);
    if (p.phase === "idle") {
      // The driver owns the turn_started edge: input was injected into an
      // idle runtime (claude emits no explicit turn-start line; adapters that
      // do emit one are deduplicated by phase in onSignal).
      p.phase = "running";
      this.events.push({ beeId, generation, kind: "turn_started" });
    }
    return { accepted: true };
  }

  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    const pending = this.pendingStarts.get(beeId);
    if (pending && pending.generation === generation) {
      // A deferred spawn that never happened: cancel it and report the stop
      // as an immediate exit fact (there is nothing to signal).
      this.pendingStarts.delete(beeId);
      this.events.push({ beeId, generation, kind: "exited", exitCause: cause });
      return { hadProcess: true };
    }
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { hadProcess: false };
    if (p.stopCause == null) p.stopCause = cause;
    // Exact identity (spec points 4–5): we signal only the pid we spawned and
    // still hold the un-exited handle for — parenthood guarantees the pid has
    // not been recycled (the child is unreaped until the exit event fires).
    this.signalGroup(p, "SIGTERM");
    if (p.killTimer == null) {
      p.killTimer = setTimeout(() => {
        if (!p.exited) this.signalGroup(p, "SIGKILL");
      }, this.graceMs);
      p.killTimer.unref();
    }
    return { hadProcess: true };
  }

  observe(): DriverObservation[] {
    // Adopted (degraded) processes have no exit callback — their death is a
    // fact recovered by polling the exact pid (cheap signal-0 probe).
    this.pollDegraded();
    const out = this.events;
    this.events = [];
    return out;
  }

  hasProcess(beeId: string, generation: number): boolean {
    const pending = this.pendingStarts.get(beeId);
    if (pending && pending.generation === generation) return true; // spawn in flight
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation && !p.exited;
  }

  snapshotLive(): LiveProcess[] {
    return [...this.procs.values()]
      .filter((p) => !p.exited && p.pid > 0)
      .map((p) => ({
        beeId: p.beeId,
        generation: p.generation,
        pid: p.pid,
        pidStartedAt: p.pidStartedAt,
      }));
  }

  // -------------------------------------------------------------------------
  // Beyond the WP2 interface — what the real daemon needs
  // -------------------------------------------------------------------------

  /**
   * Cross-restart re-adoption (contract §3.2, spec 04 boot sequence): claim a
   * surviving process from a previous daemon generation by exact identity.
   * Returns false — never throws — when the pid is gone, unreadable, recycled
   * (start-time mismatch) or the bee already has a live process.
   */
  adopt(beeId: string, generation: number, pid: number, pidStartedAt: number): boolean {
    if (pid <= 0) return false;
    if (this.procs.has(beeId) || this.pendingStarts.has(beeId)) return false;
    if (!verifyProcessIdentity(pid, pidStartedAt, this.adoptTolMs)) return false;
    this.procs.set(beeId, {
      beeId,
      generation,
      pid,
      pidStartedAt,
      child: null,
      adapter: null,
      degraded: true,
      // Unknown phase — the event stream died with the old daemon. "running"
      // is the safe claim: hang policy bounds it, and turn_ended can never be
      // observed for it anyway.
      phase: "running",
      sessionId: null,
      stopCause: null,
      killTimer: null,
      stdoutRest: "",
      exited: false,
    });
    return true;
  }

  /** Whether (bee, generation) is a live re-adopted process with no event stream. */
  isDegraded(beeId: string, generation: number): boolean {
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation && p.degraded && !p.exited;
  }

  private pollDegraded(): void {
    for (const p of [...this.procs.values()]) {
      if (!p.degraded || p.exited) continue;
      if (!pidAlive(p.pid)) this.onExit(p, null, null);
    }
  }

  /**
   * Process identity captured at spawn, for core's createBee/reviveBee `proc`
   * (the WP2 amendment). Available immediately after start() returns.
   */
  procOf(beeId: string, generation: number): { pid: number; pidStartedAt: number } | null {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.pid <= 0) return null;
    return { pid: p.pid, pidStartedAt: p.pidStartedAt };
  }

  /** Drain condition-flag evidence (adapters report; the daemon acts). */
  observeEvidence(): FlagEvidence[] {
    const out = this.evidence;
    this.evidence = [];
    return out;
  }

  /** Verbatim native-stream session log path for a bee (Q1). */
  sessionLogPath(beeId: string): string {
    return join(this.cfg.sessionLogDir, `${beeId}.jsonl`);
  }

  // --- DeliveryGroundTruth (invariant checker, spec test tier 3) -----------

  consumedGeneration(messageId: number): number | undefined {
    return this.consumed.get(messageId);
  }

  consumedCount(): number {
    return this.consumed.size;
  }

  liveProcesses(): LiveProcess[] {
    return this.snapshotLive();
  }

  /**
   * Daemon shutdown: release every event-loop reference to the children
   * WITHOUT signaling them — runtimes deliberately survive a daemon stop and
   * the next boot re-adopts them (contract §3.2). The OS closes our pipe ends
   * when the process exits; agents that exit on stdin EOF stop then, agents
   * that survive it stay adoptable.
   */
  detachAll(): void {
    for (const p of this.procs.values()) {
      if (p.killTimer) {
        clearTimeout(p.killTimer);
        p.killTimer = null;
      }
      p.child?.unref();
      // stdio pipes are net.Socket instances (unref exists at runtime).
      for (const stream of [p.child?.stdin, p.child?.stdout, p.child?.stderr]) {
        (stream as unknown as { unref?: () => void } | null | undefined)?.unref?.();
      }
    }
  }

  /** Test/teardown only: SIGKILL every child group and drop pending events. */
  disposeAll(): void {
    this.pendingStarts.clear();
    for (const p of this.procs.values()) {
      if (p.killTimer) clearTimeout(p.killTimer);
      if (!p.exited) {
        if (p.stopCause == null) p.stopCause = "stopped_by_system";
        this.signalGroup(p, "SIGKILL");
      }
    }
    this.events = [];
    this.evidence = [];
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private writeLine(p: ManagedProcess, line: string): void {
    if (process.env.HIVE_SPAWN_TRACE) {
      appendFileSync(process.env.HIVE_SPAWN_TRACE, JSON.stringify({ write: line.slice(0, 160), at: Date.now(), stack: new Error().stack?.split("\n").slice(2, 6).join(" | ") }) + "\n");
    }
    try {
      p.child?.stdin?.write(`${line}\n`);
    } catch {
      // A write race against a dying child; its exit observation follows.
    }
  }

  private signalGroup(p: ManagedProcess, signal: "SIGTERM" | "SIGKILL"): void {
    if (p.pid <= 0) return;
    if (p.degraded) {
      // Adopted pid: parenthood does not protect it from recycling, so the
      // exact identity (pid + start-time) is re-verified immediately before
      // every signal. A failed check means the process is gone; the poll in
      // observe() owns the exit bookkeeping.
      if (!verifyProcessIdentity(p.pid, p.pidStartedAt, this.adoptTolMs)) return;
      try {
        process.kill(-p.pid, signal);
      } catch {
        try {
          process.kill(p.pid, signal);
        } catch {
          // Already gone.
        }
      }
      return;
    }
    try {
      // Negative pid = the child's own process group (created by detached).
      process.kill(-p.pid, signal);
    } catch {
      try {
        p.child?.kill(signal);
      } catch {
        // Already gone; the exit callback owns the bookkeeping.
      }
    }
  }

  private onStdout(p: ManagedProcess, chunk: string): void {
    const adapter = p.adapter;
    if (!adapter) return; // degraded processes have no stream (and no stdout wiring)
    const data = p.stdoutRest + chunk;
    const lines = data.split("\n");
    p.stdoutRest = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) continue;
      // Q1: append the raw native line verbatim, before any interpretation.
      this.appendSessionLog(p.beeId, line);
      const signals = adapter.parseLine(line);
      // A late `booted` (readyAtSpawn harnesses emit init only after the first
      // message) is informational — the process is already live and mid-turn.
      // Its companion bootedToIdle `turn_ended` must NOT close the in-flight
      // turn (live 2026-08-17: the cell smoke saw a phantom turn_ended ~100ms
      // after delivery and tore claude down mid-turn). Drop the trailing idle
      // marker whenever the booted itself is a no-op duplicate.
      const lateBoot = p.phase !== "booting" && signals.some((sig) => sig.kind === "booted");
      for (const signal of signals) {
        if (lateBoot && signal.kind === "turn_ended") continue;
        this.onSignal(p, signal);
      }
    }
  }

  private onSignal(p: ManagedProcess, signal: ReturnType<HarnessAdapter["parseLine"]>[number]): void {
    switch (signal.kind) {
      case "booted": {
        if (signal.sessionId) p.sessionId = signal.sessionId; // late init still carries it
        if (p.phase !== "booting") return; // duplicate readiness — normalize away
        // booted = "live and working its initial turn" (running). The adapter
        // follows with turn_ended when the harness boots straight to ready.
        p.phase = "running";
        this.events.push({
          beeId: p.beeId,
          generation: p.generation,
          kind: "booted",
          pid: p.pid,
          pidStartedAt: p.pidStartedAt,
        });
        return;
      }
      case "turn_started": {
        if (p.phase !== "idle") return; // driver already opened this turn (deliver)
        p.phase = "running";
        this.events.push({ beeId: p.beeId, generation: p.generation, kind: "turn_started" });
        return;
      }
      case "turn_ended": {
        if (p.phase !== "running") return;
        p.phase = "idle";
        this.events.push({ beeId: p.beeId, generation: p.generation, kind: "turn_ended" });
        return;
      }
      case "flag": {
        this.evidence.push({
          beeId: p.beeId,
          generation: p.generation,
          flag: signal.flag,
          action: signal.action,
          detail: signal.detail,
        });
        return;
      }
      case "respond": {
        for (const line of signal.lines) this.writeLine(p, line);
        return;
      }
    }
  }

  private onExit(p: ManagedProcess, code: number | null, _signal: NodeJS.Signals | null): void {
    if (p.exited) return;
    p.exited = true;
    if (p.killTimer) {
      clearTimeout(p.killTimer);
      p.killTimer = null;
    }
    this.procs.delete(p.beeId);
    // Cause: a requested stop fixes its cause; otherwise exit code 0 is clean
    // and anything else (non-zero, signal, spawn error) is a crash — death is
    // a fact reported to the parent, never a hypothesis (contract §3.2).
    const cause = p.stopCause ?? (code === 0 ? "clean" : "crashed");
    this.events.push({
      beeId: p.beeId,
      generation: p.generation,
      kind: "exited",
      exitCause: cause,
    });
    // A start deferred behind this death can now actually spawn.
    const pending = this.pendingStarts.get(p.beeId);
    if (pending) {
      this.pendingStarts.delete(p.beeId);
      this.start(p.beeId, pending.generation);
    }
  }

  private appendSessionLog(beeId: string, line: string): void {
    appendFileSync(this.sessionLogPath(beeId), `${line}\n`);
  }

  private appendSidecar(beeId: string, text: string): void {
    try {
      appendFileSync(join(this.cfg.sessionLogDir, `${beeId}.stderr.log`), text);
    } catch {
      // Diagnostics only; never let stderr plumbing break the driver.
    }
  }
}
