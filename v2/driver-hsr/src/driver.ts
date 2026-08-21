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
 * children may survive. `adopt(beeId, generation, pid, pidStartedAt, state,
 * providerSessionId)` verifies
 * exact identity (pid alive + OS start time within tolerance of the recorded
 * spawn stamp) and registers the process as *degraded*: it counts as live
 * (snapshotLive/hasProcess — so reconcileAtBoot keeps its runtime row, B7),
 * can be stopped (signaled by verified pid), and its death is observed by
 * polling — but it has no event stream and no stdin, so `deliver` refuses and
 * the daemon's degraded-runtime policy rotates it out when mail arrives.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { readRunnerStatus, type RunnerHostConfig } from "./runner-host.ts";
import type {
  DeliverOutcome,
  DriverObservation,
  InterruptOutcome,
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
  /**
   * Directory for runner-host artifacts (config/socket/status per runtime
   * generation). Default: `<sessionLogDir>/../runners`.
   */
  runnersDir?: string;
  /**
   * How to launch the runner host for a written config file. The default
   * invokes the sibling TS entry under --experimental-strip-types (dev and
   * tests); the daemon overrides it with its own CLI entry in production,
   * where v2 ships as a bundle and the source path does not exist.
   */
  hostCommand?: (configPath: string) => { command: string; args: string[] };
}

/** Condition-flag evidence surfaced by adapters, stamped with process identity. */
export interface FlagEvidence {
  beeId: string;
  generation: number;
  flag: "auth_needed" | "resource_blocked" | "spawn_failed";
  action: "set" | "clear";
  detail: string;
}

/**
 * Harness-native session identity reported by a runtime's booted signal
 * (claude system/init session_id, codex thread id). The daemon records it on
 * the bee so revive can resume the conversation (spec 07 §F).
 */
export interface SessionEvidence {
  beeId: string;
  generation: number;
  sessionId: string;
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
  /** v6: the harness-native id of the turn in flight (codex turn/started), for turn/interrupt. */
  turnId: string | null;
  /** First requested stop cause; fixes the exit cause of a signaled process. */
  stopCause: StopCause | null;
  killTimer: NodeJS.Timeout | null;
  stdoutRest: string;
  exited: boolean;
  /**
   * Runner-host runtime (WP5): `child` is the detached HOST process; the
   * agent is the host's child in the same process group. The host owns the
   * agent's pipes and writes the session log, so the runtime survives daemon
   * restarts; the driver observes by tailing the log and delivers over the
   * host's unix socket. False only for legacy degraded adoptions (runtimes
   * spawned by a pre-host daemon).
   */
  hostStyle: boolean;
  /** Agent pid learned from the host's status file (host pid is `pid`). */
  agentPid: number | null;
  socket: Socket | null;
  socketRetry: NodeJS.Timeout | null;
  socketPath: string | null;
  statusPath: string | null;
  /** Byte offset consumed from the session log by the observation tail. */
  logOffset: number;
  /**
   * Outbound lines the driver sent through the host (deliver/interrupt/
   * respond/boot). The host appends them to the session log in write order;
   * the tail matches-and-skips them so adapters only parse agent output.
   */
  outboundPending: string[];
  /**
   * Lines accepted before the host socket finished connecting (the host
   * needs a few ms to boot and listen). Flushed in order on connect — the
   * accept-at-spawn contract the kernel-buffered stdin pipe used to give.
   */
  pendingWrites: string[];
  /** The host reported its stdin lane could not be established: refuse
   * deliveries instead of queueing into a black hole. */
  socketBroken: boolean;
  /** The OS spawn/process error message, when the child emitted `error` (e.g. ENOENT). */
  spawnError: string | null;
  /**
   * v9: whether the adapter has parsed at least one signal from this
   * process's actual output. A readyAtSpawn runtime opens its accept point on
   * a driver-minted synthetic booted; only real output upgrades it — the
   * first parsed signal pushes a real `booted` observation so the daemon
   * learns, in stream order, that the process demonstrably runs (the
   * spawn-failure budget resets on that, never on the synthetic booted).
   */
  realEvidence: boolean;
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
  private sessions: SessionEvidence[] = [];
  /** Delivery ground truth for the invariant checker: messageId → generation. */
  private readonly consumed = new Map<number, number>();

  constructor(cfg: HsrDriverConfig) {
    this.cfg = cfg;
    this.now = cfg.now ?? Date.now;
    this.graceMs = cfg.stopKillGraceMs ?? 5000;
    this.adoptTolMs = cfg.adoptToleranceMs ?? 5000;
    mkdirSync(cfg.sessionLogDir, { recursive: true });
    mkdirSync(this.runnersDir(), { recursive: true });
  }

  private runnersDir(): string {
    return this.cfg.runnersDir ?? resolvePath(this.cfg.sessionLogDir, "..", "runners");
  }

  private runnerPaths(beeId: string, generation: number): { config: string; socket: string; status: string } {
    const base = join(this.runnersDir(), `${beeId}.${generation}`);
    // The unix socket CANNOT live beside the other artifacts: sun_path is
    // capped (104 bytes on macOS) and runnersDir under a test tmpdir already
    // blows it — listen fails silently and every delivery would black-hole.
    // A short deterministic tmpdir name keeps the path tiny and derivable at
    // adoption from the same identity inputs.
    const digest = createHash("sha256")
      .update(`${this.runnersDir()}\u0000${beeId}\u0000${generation}`)
      .digest("hex")
      .slice(0, 16);
    return {
      config: `${base}.json`,
      socket: join(tmpdir(), `hb-rh-${digest}.sock`),
      status: `${base}.status.json`,
    };
  }

  private hostCommandFor(configPath: string): { command: string; args: string[] } {
    if (this.cfg.hostCommand) return this.cfg.hostCommand(configPath);
    const entry = fileURLToPath(new URL("./runner-host-main.ts", import.meta.url));
    return { command: process.execPath, args: ["--experimental-strip-types", entry, configPath] };
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
    if (process.env.HIVE_SPAWN_TRACE) {
      // Diagnostics only: exact spawn shape for post-mortem replay.
      appendFileSync(process.env.HIVE_SPAWN_TRACE, JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd, envKeys: Object.keys(spec.env ?? {}).length, at: Date.now() }) + "\n");
    }
    // WP5: spawn the runner HOST, not the agent. The host is detached in its
    // own process group (spec point 1 — group signals reach host + agent and
    // never a sibling of ours) and spawns the agent as ITS child in that same
    // group, holding the agent's pipes. A daemon restart therefore takes no
    // pipe down: the runtime survives, and boot re-adoption reconnects with
    // full capability instead of the old degraded stop-on-mail rotation.
    const paths = this.runnerPaths(beeId, generation);
    const hostConfig: RunnerHostConfig = {
      beeId,
      command: spec.command,
      args: spec.args,
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env: spec.env ?? ({ ...process.env } as Record<string, string>),
      sessionLogPath: this.sessionLogPath(beeId),
      sidecarPath: join(this.cfg.sessionLogDir, `${beeId}.stderr.log`),
      socketPath: paths.socket,
      statusPath: paths.status,
      bootLines: spec.adapter.bootLines(),
    };
    writeFileSync(paths.config, JSON.stringify(hostConfig));
    const launch = this.hostCommandFor(paths.config);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const proc: ManagedProcess = {
      beeId,
      generation,
      // pid captured AT SPAWN (WP2 amendment) — the HOST's pid: host liveness
      // IS runtime liveness (the host exits when the agent exits), so the
      // stored proc identity adopts across daemon restarts unchanged.
      pid: child.pid ?? -1,
      pidStartedAt: this.now(),
      child,
      adapter: spec.adapter,
      degraded: false,
      phase: "booting",
      sessionId: null,
      turnId: null,
      stopCause: null,
      killTimer: null,
      stdoutRest: "",
      exited: false,
      spawnError: null,
      realEvidence: false,
      hostStyle: true,
      agentPid: null,
      socket: null,
      socketRetry: null,
      socketPath: paths.socket,
      statusPath: paths.status,
      // The session log may carry previous generations; only new bytes are
      // this runtime's stream.
      logOffset: this.sessionLogSize(beeId),
      outboundPending: [...hostConfig.bootLines],
      pendingWrites: [],
      socketBroken: false,
    };
    this.procs.set(beeId, proc);

    // Host spawn failure (missing node/CLI — configuration, not the agent):
    // surface as exited(crashed) through the daemon's spawn-retry path.
    child.on("error", (err) => {
      proc.spawnError = String(err?.message ?? err);
      this.appendSidecar(beeId, `runner host spawn error: ${proc.spawnError}\n`);
      this.finishHost(proc);
    });
    // Host exit = runtime exit (the host outlives the agent by milliseconds
    // to record the exit facts). Drain the tail before the exit observation
    // so trailing output lands in stream order.
    child.on("exit", () => this.finishHost(proc));

    this.connectSocket(proc);

    if (spec.adapter.readyAtSpawn) {
      // claude stream-json emits nothing until the first stdin message: the
      // accept point opens now (stdin buffers safely in the host). The
      // synthetic `booted` OBSERVATION waits for the host's status file to
      // confirm the AGENT process exists — the same "OS confirmed the spawn"
      // semantics the direct child's `spawn` event carried (v9: synthetic,
      // never boot evidence; an agent that fails to spawn reports spawnError
      // and exits while still booting, counting against the spawn budget).
      proc.phase = "idle";
    }
  }

  /** Current session-log size — the tail baseline for a new generation. */
  private sessionLogSize(beeId: string): number {
    try {
      return statSync(this.sessionLogPath(beeId)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Connect (and keep reconnecting) the write lane to the runner host. The
   * socket is fire-and-forget outbound only; deliver() refuses `not_ready`
   * until it is connected and the daemon's delivery loop retries — the same
   * bounded-refusal contract a booting runtime already has.
   */
  private connectSocket(p: ManagedProcess): void {
    if (p.exited || p.socket || p.socketRetry || !p.socketPath) return;
    const attempt = connect(p.socketPath);
    attempt.on("connect", () => {
      p.socket = attempt;
      for (const line of p.pendingWrites.splice(0)) {
        attempt.write(`${JSON.stringify({ op: "write", line })}\n`);
      }
    });
    attempt.on("error", () => undefined);
    attempt.on("close", () => {
      if (p.socket === attempt) p.socket = null;
      if (p.exited) return;
      p.socketRetry = setTimeout(() => {
        p.socketRetry = null;
        this.connectSocket(p);
      }, 200);
      p.socketRetry.unref();
    });
  }

  /** Host-style runtime finished (host exit observed or pid gone): drain the
   * observation tail, fold the host's recorded exit facts, emit exited. */
  private finishHost(p: ManagedProcess): void {
    if (p.exited) return;
    this.pumpHostTail(p);
    const status = p.statusPath ? readRunnerStatus(p.statusPath) : null;
    if (status?.spawnError && !p.spawnError) {
      p.spawnError = status.spawnError;
    }
    this.onExit(p, status?.exited ? (status.exitCode ?? null) : null, null);
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
    if (p.hostStyle && p.socketBroken) return { accepted: false, reason: "not_ready" };
    if (!p.hostStyle && (!p.child?.stdin || p.child.stdin.destroyed || !p.child.stdin.writable)) {
      // stdin gone means the process is dying; its exit observation follows.
      return { accepted: false, reason: "no_process" };
    }
    // Host-style: a still-connecting socket queues the line and flushes on
    // connect — the same accept-at-spawn guarantee the kernel-buffered stdin
    // pipe gave. A host that never comes up exits and rotates the generation,
    // exactly like a child that died after a buffered write.
    this.writeLine(p, encoded);
    // Ground truth recorded at the accept point, deterministic (spec point 3).
    this.consumed.set(messageId, generation);
    if (p.phase === "idle") {
      // The driver owns the turn_started edge: input was injected into an
      // idle runtime (claude emits no explicit turn-start line; adapters that
      // do emit one are deduplicated by phase in onSignal). v9: synthetic —
      // writing to stdin proves nothing about the process; only parsed
      // output is boot evidence for the spawn-failure budget.
      p.phase = "running";
      this.events.push({ beeId, generation, kind: "turn_started", synthetic: true });
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

  /**
   * v6 interrupt: hand the harness's in-band "stop the current turn" line to
   * a live, mid-turn runtime's stdin (claude control_request interrupt, codex
   * turn/interrupt, stub {"type":"interrupt"}). The turn_ended that follows
   * is observed like any other; the process stays live. Idle / booting /
   * dying / degraded / no channel: a reasoned no-op, never an error. SIGINT
   * is never used — it kills a headless child outright.
   */
  interrupt(beeId: string, generation: number): InterruptOutcome {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { interrupted: false, reason: "no_process" };
    if (p.degraded || p.adapter == null) return { interrupted: false, reason: "not_ready" };
    if (p.phase === "booting" || p.stopCause != null) return { interrupted: false, reason: "not_ready" };
    if (p.phase === "idle") return { interrupted: false, reason: "idle" };
    if (typeof p.adapter.encodeInterrupt !== "function") return { interrupted: false, reason: "unsupported" };
    const encoded = p.adapter.encodeInterrupt({ sessionId: p.sessionId, turnId: p.turnId });
    if (encoded == null) return { interrupted: false, reason: "not_ready" };
    if (p.hostStyle && p.socketBroken) return { interrupted: false, reason: "not_ready" };
    if (!p.hostStyle && (!p.child?.stdin || p.child.stdin.destroyed || !p.child.stdin.writable)) {
      return { interrupted: false, reason: "no_process" };
    }
    this.writeLine(p, encoded);
    return { interrupted: true };
  }

  observe(): DriverObservation[] {
    this.pumpAll();
    const out = this.events;
    this.events = [];
    return out;
  }

  /**
   * Parse everything new before any drain: host-style runtimes are observed
   * by files (status facts + session-log tail), so observations, flag
   * evidence, and session evidence all materialize HERE — every observe*()
   * surface pumps first, keeping the pipe-era semantics where evidence
   * accumulated without an observe() call.
   */
  private lastPumpAt = 0;

  private pumpAll(): void {
    // The daemon drains all three observe surfaces inside one step(); pumping
    // per surface tripled the per-tick stat/read pass over every runtime
    // (2026-08-21 telemetry: step 200-480ms with a large fleet). One pump per
    // 50ms keeps observation latency under any real tick while making the
    // extra drains free.
    const now = this.now();
    if (now - this.lastPumpAt < 50) return;
    this.lastPumpAt = now;
    for (const p of [...this.procs.values()]) {
      if (!p.hostStyle || p.exited) continue;
      this.pumpHost(p);
    }
    // Adopted (degraded) processes have no exit callback — their death is a
    // fact recovered by polling the exact pid (cheap signal-0 probe).
    this.pollDegraded();
  }

  /** One observation pass over a host-style runtime: status facts, log tail,
   * and (for adopted hosts with no exit callback) pid-liveness. */
  private pumpHost(p: ManagedProcess): void {
    // Read the status file only while it can still teach us something: the
    // agent pid / spawnError before the OS confirms the spawn, and the
    // socketError witness until the write lane is proven (connected). After
    // that, exits arrive via the child callback (own spawns) or the pid probe
    // + finishHost's status read (adopted hosts) — no per-tick read needed.
    if (p.statusPath && (p.agentPid == null || (!p.socket && !p.socketBroken))) {
      const status = readRunnerStatus(p.statusPath);
      if (status) {
        if (status.socketError && !p.socketBroken) {
          p.socketBroken = true;
          this.appendSidecar(p.beeId, `runner host socket failed: ${status.socketError}\n`);
        }
        if (p.agentPid == null && typeof status.agentPid === "number") {
          p.agentPid = status.agentPid;
          if (p.adapter?.readyAtSpawn) {
            // The OS confirmed the AGENT spawn (v9: synthetic, never boot
            // evidence) — the same edge the direct child's `spawn` event was.
            this.events.push({
              beeId: p.beeId,
              generation: p.generation,
              kind: "booted",
              pid: p.pid,
              pidStartedAt: p.pidStartedAt,
              synthetic: true,
            });
          }
        }
        if (status.exited) {
          this.finishHost(p);
          return;
        }
      }
    }
    this.pumpHostTail(p);
    // An adopted host has no ChildProcess exit callback; recover its death by
    // polling the exact identity, then fold the recorded exit facts.
    if (p.child == null && !pidAlive(p.pid)) this.finishHost(p);
  }

  /** Read new session-log bytes; parse agent lines, skipping outbound echoes. */
  private pumpHostTail(p: ManagedProcess): void {
    if (!p.adapter) return;
    const path = this.sessionLogPath(p.beeId);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return; // no log yet
    }
    if (size < p.logOffset) {
      // Truncated/rotated underneath us (never normal): restart from zero
      // rather than reading torn bytes at a stale offset.
      p.logOffset = 0;
      p.stdoutRest = "";
    }
    if (size === p.logOffset) return;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    let chunk: string;
    try {
      const length = size - p.logOffset;
      const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, p.logOffset);
      p.logOffset += bytesRead;
      chunk = buffer.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
    const data = p.stdoutRest + chunk;
    const lines = data.split("\n");
    p.stdoutRest = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) continue;
      // Outbound lines (deliver/interrupt/respond/boot) come back through the
      // host's single-writer log in send order — skip, never parse.
      if (p.outboundPending.length > 0 && p.outboundPending[0] === line) {
        p.outboundPending.shift();
        continue;
      }
      const signals = p.adapter.parseLine(line);
      const lateBoot = p.phase !== "booting" && signals.some((sig) => sig.kind === "booted");
      for (const signal of signals) {
        if (lateBoot && signal.kind === "turn_ended") continue;
        this.onSignal(p, signal);
      }
    }
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
  adopt(
    beeId: string,
    generation: number,
    pid: number,
    pidStartedAt: number,
    lastKnownState?: "booting" | "running" | "idle",
    providerSessionId?: string | null,
  ): boolean {
    if (pid <= 0) return false;
    if (this.procs.has(beeId) || this.pendingStarts.has(beeId)) return false;
    if (!verifyProcessIdentity(pid, pidStartedAt, this.adoptTolMs)) return false;
    // WP5: a runtime with runner-host artifacts for this exact (pid ==
    // host pid) re-adopts at FULL capability — reconnect the write socket,
    // resume the log tail, keep delivering. The degraded stop-on-mail
    // rotation below remains only for runtimes spawned by a pre-host daemon.
    const paths = this.runnerPaths(beeId, generation);
    const status = readRunnerStatus(paths.status);
    if (status && status.hostPid === pid && !status.exited) {
      let adapter: HarnessAdapter | null = null;
      try {
        adapter = this.cfg.resolve(beeId).adapter;
      } catch {
        adapter = null; // unresolvable harness: fall through to degraded
      }
      if (adapter) {
        const proc: ManagedProcess = {
          beeId,
          generation,
          pid,
          pidStartedAt,
          child: null,
          adapter,
          degraded: false,
          // The store's persisted runtime state is the phase truth at the
          // moment the old daemon stopped (rows-are-truth): an idle runtime
          // adopts with its accept point OPEN and, crucially, outside the
          // turn-hang policy — the 2026-08-21 deploy soak saw every idle
          // adopted bee hang-stopped minutes later because the blanket
          // "running" claim promised a turn_ended that could never come.
          // Without a hint, "running" stays the safe claim (hang policy
          // bounds it; the next tailed edge corrects it).
          phase: lastKnownState === "idle" ? "idle" : "running",
          // The adapter learned this id before the old daemon persisted it on
          // the bee. Adoption tails from EOF, so it will not see the original
          // boot signal again; restore the durable fact or session-addressed
          // protocols (Codex/Grok) can never encode another delivery.
          sessionId: providerSessionId ?? null,
          turnId: null,
          stopCause: null,
          killTimer: null,
          stdoutRest: "",
          exited: false,
          spawnError: null,
          realEvidence: false,
          hostStyle: true,
          agentPid: typeof status.agentPid === "number" ? status.agentPid : null,
          socket: null,
          socketRetry: null,
          socketPath: paths.socket,
          statusPath: paths.status,
          // History edges were the previous daemon's; observe only new bytes.
          logOffset: this.sessionLogSize(beeId),
          outboundPending: [],
          pendingWrites: [],
          socketBroken: false,
        };
        this.procs.set(beeId, proc);
        this.connectSocket(proc);
        return true;
      }
    }
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
      turnId: null,
      stopCause: null,
      killTimer: null,
      stdoutRest: "",
      exited: false,
      spawnError: null,
      // Degraded: no event stream, so no evidence can ever be parsed. The
      // store's persisted boot_evidence for the row (from before the daemon
      // restart) governs its exit accounting; this field is driver-local.
      realEvidence: false,
      hostStyle: false,
      agentPid: null,
      socket: null,
      socketRetry: null,
      socketPath: null,
      statusPath: null,
      logOffset: 0,
      outboundPending: [],
      pendingWrites: [],
      socketBroken: false,
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
    this.pumpAll();
    const out = this.evidence;
    this.evidence = [];
    return out;
  }

  /**
   * Drain harness session ids learned from booted signals (including the late
   * init a readyAtSpawn harness emits after its first message). The daemon
   * records them on the bee row (spec 07 §F continuity).
   */
  observeSessions(): SessionEvidence[] {
    this.pumpAll();
    const out = this.sessions;
    this.sessions = [];
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
      if (p.socketRetry) {
        clearTimeout(p.socketRetry);
        p.socketRetry = null;
      }
      // The write lane belongs to THIS daemon process; the next daemon
      // reconnects its own. Destroying it never touches the agent.
      p.socket?.destroy();
      p.socket = null;
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
    this.sessions = [];
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private writeLine(p: ManagedProcess, line: string): void {
    if (process.env.HIVE_SPAWN_TRACE) {
      appendFileSync(process.env.HIVE_SPAWN_TRACE, JSON.stringify({ write: line.slice(0, 160), at: Date.now(), stack: new Error().stack?.split("\n").slice(2, 6).join(" | ") }) + "\n");
    }
    // Bidirectional JSON-RPC (codex/grok ACP) and claude stream-json user
    // lines live on stdin; the session log is the verbatim native stream in
    // BOTH directions so panes can render the operator's prompt.
    if (p.hostStyle) {
      // The HOST is the session log's single writer: it appends the outbound
      // line (before stdin) exactly as it appends agent stdout, keeping one
      // append order the tail can skip against via `outboundPending`.
      try {
        p.outboundPending.push(line);
        if (p.socket && !p.socket.destroyed) {
          p.socket.write(`${JSON.stringify({ op: "write", line })}\n`);
        } else {
          p.pendingWrites.push(line);
          this.connectSocket(p);
        }
      } catch {
        // A write race against a dying host; its exit observation follows.
      }
      return;
    }
    this.appendSessionLog(p.beeId, line);
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


  private onSignal(p: ManagedProcess, signal: ReturnType<HarnessAdapter["parseLine"]>[number]): void {
    if (!p.realEvidence) {
      p.realEvidence = true;
      // v9: the first ADAPTER-PARSED signal from a process whose phase left
      // "booting" without real output (the readyAtSpawn synthetic path) is
      // the proof the agent actually runs. Push a real `booted` observation
      // so the daemon learns it in stream order — downstream it is a state
      // no-op (the store is already past booting) but it carries the boot
      // evidence that resets the spawn-failure budget. While the phase is
      // still "booting" the signal below drives the real booted itself, and
      // an exit before that stays an ordinary boot failure.
      if (p.phase !== "booting") {
        this.events.push({
          beeId: p.beeId,
          generation: p.generation,
          kind: "booted",
          pid: p.pid,
          pidStartedAt: p.pidStartedAt,
        });
      }
    }
    switch (signal.kind) {
      case "booted": {
        if (signal.sessionId) {
          // Late init still carries it (claude emits system/init only after the
          // first user message); the id is a bee fact whenever it is learned.
          if (p.sessionId !== signal.sessionId) {
            this.sessions.push({ beeId: p.beeId, generation: p.generation, sessionId: signal.sessionId });
          }
          p.sessionId = signal.sessionId;
        }
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
        // The harness-native turn id (codex) is learned even when the driver
        // already opened the turn at deliver() — interrupt needs it.
        if (signal.turnId) p.turnId = signal.turnId;
        if (p.phase !== "idle") return; // driver already opened this turn (deliver)
        p.phase = "running";
        this.events.push({ beeId: p.beeId, generation: p.generation, kind: "turn_started" });
        return;
      }
      case "turn_ended": {
        p.turnId = null;
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
    if (p.socketRetry) {
      clearTimeout(p.socketRetry);
      p.socketRetry = null;
    }
    p.socket?.destroy();
    p.socket = null;
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
      ...(p.spawnError ? { detail: `spawn error: ${p.spawnError}` } : {}),
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
