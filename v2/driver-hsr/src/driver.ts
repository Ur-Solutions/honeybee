/**
 * HsrDriver — the first real substrate driver (WP3 of the reset).
 *
 * Implements the RuntimeDriver interface EXACTLY as fixed by WP2
 * (v2/harness/src/driver.ts): the WP2 SimDaemon drives this driver unmodified.
 * Spec: docs/design/specs/reset-03-hsr-driver.md.
 *
 * Behavior mapping to the spec:
 *  1. Parenthood — `start` spawns a detached runner host in its OWN process
 *     group; that host owns the agent child and its pipes. The driver captures
 *     host pid + start-time AT SPAWN (`procOf`), so core can record and exactly
 *     re-adopt the durable runtime across daemon restarts.
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
 *     the runner's output-only, generation-scoped journal and host-exit facts.
 *     The core checkpoints parsed journal bytes only after their effects, so
 *     undrained evidence survives daemon death without transcript guessing.
 *
 * WP4 addition — cross-restart re-adoption (contract §3.2): when the daemon
 * PROCESS restarts, ChildProcess handles are gone but the detached host and
 * agent survive. `adopt(...)` verifies exact pid/start-time, reconnects the
 * host socket, and resumes the exact generation journal at core's committed
 * cursor. Missing/corrupt proof falls back to a conservative degraded exact-
 * pid adoption; silence never manufactures idle.
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
import { executableNotFoundDetail, type SpawnCommandResolution } from "../../core/src/executables.ts";
import { pidAlive, verifyProcessIdentity } from "./psutil.ts";

/** What `start` needs to know per bee: which agent, how to spawn it. */
export interface SpawnSpec {
  adapter: HarnessAdapter;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * How `command` was resolved (core resolveSpawnCommand — the one rule,
   * F8). `not_found` means the resolver searched PATH + fallbacks and found
   * nothing: the spawn proceeds with the bare name (honest ENOENT) and the
   * exit detail names the missing executable for the operator.
   */
  commandResolution?: SpawnCommandResolution;
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
  /** Provider-declared instant (epoch ms) the condition lifts, when stated. */
  resetsAt?: number;
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

/**
 * Highest fully parsed runner-journal byte for one generation. The daemon
 * commits this only after every normalized effect emitted before it has
 * settled in the core store.
 */
export interface ObservationCursorEvidence {
  beeId: string;
  generation: number;
  cursor: number;
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
  /** RPC deliveries written but not yet accepted by the harness. */
  pendingDeliveries: Set<number>;
  /** Durable protocol acknowledgements waiting for the daemon to mark mailbox truth. */
  confirmedDeliveries: Set<number>;
  /** First requested stop cause; fixes the exit cause of a signaled process. */
  stopCause: StopCause | null;
  killTimer: NodeJS.Timeout | null;
  /** Incomplete final line from the output-only observation journal. */
  stdoutRest: Buffer;
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
  /** Output-only journal (v15+) or the legacy shared transcript fallback. */
  observationPath: string | null;
  /** Byte offset consumed from observationPath by the observation tail. */
  logOffset: number;
  /** Cursor exposed at spawn so core can durably establish the generation baseline. */
  initialObservationCursor: number;
  /** Highest signal-bearing line parsed since the daemon last checkpointed. */
  pendingObservationCursor: number | null;
  /** Legacy hosts only: their observation source is the bidirectional session log. */
  legacySharedObservation: boolean;
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
  /** Resolution fact for the spawned command (own spawns only; null on adoption). */
  commandResolution: SpawnCommandResolution | null;
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

interface RecoveredAdapterContext {
  sessionId: string | null;
  turnId: string | null;
  confirmedDeliveries: Set<number>;
}

/**
 * Rebuild adapter-local delivery context from the exact generation journal
 * prefix already committed by core. This is not lifecycle inference from a
 * rendered transcript: every line is the native output-only protocol stream
 * and is normalized by the same pure adapter used live.
 */
function recoverAdapterContext(
  adapter: HarnessAdapter,
  path: string,
  endOffset: number,
  providerSessionId: string | null,
): RecoveredAdapterContext {
  let sessionId = providerSessionId;
  let turnId: string | null = null;
  const confirmedDeliveries = new Set<number>();
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    let offset = 0;
    let rest = Buffer.alloc(0);
    while (offset < endOffset) {
      const wanted = Math.min(256 * 1024, endOffset - offset);
      const chunk = Buffer.alloc(wanted);
      const bytesRead = readSync(fd, chunk, 0, wanted, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const data = rest.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
      let lineStart = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        let raw = data.subarray(lineStart, newline);
        if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
        lineStart = newline + 1;
        if (raw.length === 0) continue;
        for (const signal of adapter.parseLine(raw.toString("utf8"))) {
          if (signal.kind === "booted" && signal.sessionId && sessionId == null) {
            sessionId = signal.sessionId;
            continue;
          }
          if (signal.kind === "delivery_confirmed") {
            confirmedDeliveries.add(signal.messageId);
            continue;
          }
          if (signal.kind === "delivery_refused") {
            confirmedDeliveries.delete(signal.messageId);
            continue;
          }
          if (signal.kind !== "turn_started" && signal.kind !== "turn_ended") continue;
          if (signal.threadId && sessionId && signal.threadId !== sessionId) continue;
          if (signal.kind === "turn_started") turnId = signal.turnId ?? null;
          else turnId = null;
        }
      }
      rest = Buffer.from(data.subarray(lineStart));
    }
  } catch {
    // Supplemental context recovery fails closed: durable phase/session truth
    // still adopts, while turn-addressed delivery refuses until new evidence.
  } finally {
    if (fd != null) closeSync(fd);
  }
  return { sessionId, turnId, confirmedDeliveries };
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

  private runnerPaths(
    beeId: string,
    generation: number,
  ): { config: string; socket: string; status: string; observations: string } {
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
      observations: `${base}.observations.jsonl`,
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
      generation,
      command: spec.command,
      args: spec.args,
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env: spec.env ?? ({ ...process.env } as Record<string, string>),
      sessionLogPath: this.sessionLogPath(beeId),
      observationLogPath: paths.observations,
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
      pendingDeliveries: new Set(),
      confirmedDeliveries: new Set(),
      stopCause: null,
      killTimer: null,
      stdoutRest: Buffer.alloc(0),
      exited: false,
      spawnError: null,
      commandResolution: spec.commandResolution ?? null,
      realEvidence: false,
      hostStyle: true,
      agentPid: null,
      socket: null,
      socketRetry: null,
      socketPath: paths.socket,
      statusPath: paths.status,
      observationPath: paths.observations,
      // One output-only journal per generation starts at byte zero. Core
      // persists this baseline with the pid identity before any fold.
      logOffset: 0,
      initialObservationCursor: 0,
      pendingObservationCursor: null,
      legacySharedObservation: false,
      outboundPending: [],
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
      // The driver's phase is idle from here; the synthetic booted below is
      // paired with a synthetic turn_ended so the store lands on the same
      // idle (see pollHost) instead of a `running` no output will ever close.
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
    if (p.adapter.confirmsDelivery) {
      if (p.confirmedDeliveries.delete(messageId)) {
        this.consumed.set(messageId, generation);
        return { accepted: true };
      }
      if (p.pendingDeliveries.has(messageId)) return { accepted: false, reason: "not_ready" };
    }
    const encoded = p.adapter.encodeMessage(body, {
      sessionId: p.sessionId,
      messageId,
      turnActive: p.phase === "running",
      turnId: p.turnId,
    });
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
    if (p.adapter.confirmsDelivery) p.pendingDeliveries.add(messageId);
    else this.consumed.set(messageId, generation);
    if (p.phase === "idle") {
      // The driver owns the turn_started edge: input was injected into an
      // idle runtime (claude emits no explicit turn-start line; adapters that
      // do emit one are deduplicated by phase in onSignal). v9: synthetic —
      // writing to stdin proves nothing about the process; only parsed
      // output is boot evidence for the spawn-failure budget.
      p.phase = "running";
      this.events.push({ beeId, generation, kind: "turn_started", synthetic: true });
    }
    return p.adapter.confirmsDelivery
      ? { accepted: false, reason: "not_ready" }
      : { accepted: true };
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
            if (p.phase === "idle") {
              // Nothing has been injected yet: the agent sits at its prompt
              // (claude emits no line until the first stdin message). booted
              // alone leaves the store `running` — a turn no output will ever
              // close, since the driver's own phase is idle and drops the
              // late init/result edges. Field finding 2026-09-02: a swap of an
              // idle bee (stop → revive, empty mailbox) showed "working" for
              // hours (CL.60c9, CL.e72f). Mint the "boots straight to ready"
              // turn_ended the adapter would have parsed — synthetic: never
              // boot evidence, never an output fact. A delivery that already
              // opened the turn (phase running) suppresses it: the real
              // result closes that turn.
              this.events.push({
                beeId: p.beeId,
                generation: p.generation,
                kind: "turn_ended",
                synthetic: true,
              });
            }
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

  /** Read new output-only journal bytes and normalize complete agent lines. */
  private pumpHostTail(p: ManagedProcess): void {
    if (!p.adapter || !p.observationPath) return;
    const path = p.observationPath;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return; // no log yet
    }
    if (size < p.logOffset) {
      // A generation journal is append-only. Truncation destroys the replay
      // proof; fail closed and let degraded-mail policy rotate this exact live
      // process when work arrives. Never rewind and synthesize lifecycle edges.
      p.degraded = true;
      p.adapter = null;
      p.observationPath = null;
      p.stdoutRest = Buffer.alloc(0);
      this.appendSidecar(p.beeId, `runner observation journal truncated for generation ${p.generation}\n`);
      return;
    }
    if (size === p.logOffset) return;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    let chunk: Buffer;
    const readOffset = p.logOffset;
    try {
      const length = size - p.logOffset;
      const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, p.logOffset);
      p.logOffset += bytesRead;
      chunk = buffer.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
    }
    const dataStart = readOffset - p.stdoutRest.length;
    const data = p.stdoutRest.length === 0 ? chunk : Buffer.concat([p.stdoutRest, chunk]);
    let lineStart = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, lineStart);
      if (newline < 0) break;
      let raw = data.subarray(lineStart, newline);
      if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
      const line = raw.toString("utf8");
      const lineEndCursor = dataStart + newline + 1;
      lineStart = newline + 1;
      if (line.trim().length === 0) continue;
      // v15 journals contain runner output only. Legacy adopted hosts tail the
      // shared bidirectional transcript from their adoption EOF and still need
      // exact-match suppression for commands sent by THIS daemon generation.
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
      if (signals.length > 0) p.pendingObservationCursor = lineEndCursor;
    }
    p.stdoutRest = Buffer.from(data.subarray(lineStart));
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
    lastAppliedObservationCursor?: number | null,
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
      const hasGenerationIdentity = status.beeId !== undefined || status.generation !== undefined;
      const exactGenerationIdentity = status.beeId === beeId && status.generation === generation;
      let adapter: HarnessAdapter | null = null;
      try {
        adapter = this.cfg.resolve(beeId).adapter;
      } catch {
        adapter = null; // unresolvable harness: fall through to degraded
      }
      // A v15 host proves its output-only journal belongs to this exact
      // generation. A pre-v15 host has neither identity field: keep the old
      // full-capability EOF behavior for NEW bytes, but do not replay its
      // bidirectional transcript. A mismatched/partial identity is corrupt
      // recovery evidence and falls through to conservative degraded adoption.
      if (adapter && (!hasGenerationIdentity || exactGenerationIdentity)) {
        let observationPath: string | null;
        let observationOffset: number;
        let legacySharedObservation: boolean;
        let recovered: RecoveredAdapterContext = {
          sessionId: providerSessionId ?? null,
          turnId: null,
          confirmedDeliveries: new Set(),
        };
        if (exactGenerationIdentity) {
          let journalSize: number | null = null;
          try {
            journalSize = statSync(paths.observations).size;
          } catch {
            journalSize = null;
          }
          const cursor = lastAppliedObservationCursor ?? 0;
          const validCursor = Number.isSafeInteger(cursor) && cursor >= 0 && journalSize !== null && cursor <= journalSize;
          if (status.observationError || !validCursor) {
            adapter = null; // fail closed below: never guess an idle edge
            observationPath = null;
            observationOffset = 0;
            legacySharedObservation = false;
          } else {
            observationPath = paths.observations;
            observationOffset = cursor;
            legacySharedObservation = false;
            if (
              recovered.sessionId == null
              || adapter.midTurnMessageNeedsTurnId === true && lastKnownState === "running"
              || adapter.confirmsDelivery === true
            ) {
              recovered = recoverAdapterContext(adapter, observationPath, observationOffset, recovered.sessionId);
            }
          }
        } else {
          observationPath = this.sessionLogPath(beeId);
          observationOffset = this.sessionLogSize(beeId);
          legacySharedObservation = true;
        }
        if (!adapter) {
          // The exact process is still adopted below, but without a trustworthy
          // evidence/delivery lane. Pending mail rotates it through the normal
          // degraded-runtime policy; silence never changes its phase.
        } else {
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
            // adopts with its accept point OPEN. The 2026-08-21 deploy soak
            // showed why the blanket "running" claim was wrong for known-idle
            // bees: it promised a turn_ended that could never come. Without a
            // hint, "running" remains the conservative claim; the next tailed
            // edge corrects it, and elapsed time alone never changes it.
            phase: lastKnownState === "idle" ? "idle" : "running",
            // The durable provider thread is a bee fact. Adapter-local active
            // turn and accepted-request evidence are replayed from the exact
            // generation journal so a daemon deploy cannot strand either a
            // mid-turn steer or an acknowledgement in the crash gap.
            sessionId: recovered.sessionId,
            turnId: lastKnownState === "running" ? recovered.turnId : null,
            pendingDeliveries: new Set(),
            confirmedDeliveries: recovered.confirmedDeliveries,
            stopCause: null,
            killTimer: null,
            stdoutRest: Buffer.alloc(0),
            exited: false,
            spawnError: null,
            commandResolution: null,
            realEvidence: false,
            hostStyle: true,
            agentPid: typeof status.agentPid === "number" ? status.agentPid : null,
            socket: null,
            socketRetry: null,
            socketPath: paths.socket,
            statusPath: paths.status,
            observationPath,
            // v15 resumes at the core's generation-scoped applied cursor. Legacy
            // hosts have no separated journal, so only their post-adoption bytes
            // are observable; history is never rewound heuristically.
            logOffset: observationOffset,
            initialObservationCursor: observationOffset,
            pendingObservationCursor: null,
            legacySharedObservation,
            outboundPending: [],
            pendingWrites: [],
            socketBroken: false,
          };
          this.procs.set(beeId, proc);
          this.connectSocket(proc);
          return true;
        }
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
      // is the conservative claim. Mail-driven degraded-runtime rotation
      // replaces it when work arrives; silence alone never authorizes a stop.
      phase: "running",
      sessionId: null,
      turnId: null,
      pendingDeliveries: new Set(),
      confirmedDeliveries: new Set(),
      stopCause: null,
      killTimer: null,
      stdoutRest: Buffer.alloc(0),
      exited: false,
      spawnError: null,
      commandResolution: null,
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
      observationPath: null,
      logOffset: 0,
      initialObservationCursor: 0,
      pendingObservationCursor: null,
      legacySharedObservation: false,
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
  procOf(
    beeId: string,
    generation: number,
  ): { pid: number; pidStartedAt: number; observationCursor: number } | null {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.pid <= 0) return null;
    return {
      pid: p.pid,
      pidStartedAt: p.pidStartedAt,
      observationCursor: p.initialObservationCursor,
    };
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

  /**
   * Drain the latest signal-bearing journal cursor per live generation. The
   * daemon calls this after applying observations/evidence/session ids; if it
   * crashes before the core-store checkpoint, the successor replays from the
   * previous cursor and the idempotent projections settle again.
   */
  observeRecoveryCursors(): ObservationCursorEvidence[] {
    this.pumpAll();
    const out: ObservationCursorEvidence[] = [];
    for (const p of this.procs.values()) {
      if (p.pendingObservationCursor == null) continue;
      out.push({ beeId: p.beeId, generation: p.generation, cursor: p.pendingObservationCursor });
      p.pendingObservationCursor = null;
    }
    return out;
  }

  /** Verbatim native-stream session log path for a bee (Q1). */
  sessionLogPath(beeId: string): string {
    return join(this.cfg.sessionLogDir, `${beeId}.jsonl`);
  }

  /** Output-only recovery journal for exactly one runtime generation. */
  observationLogPath(beeId: string, generation: number): string {
    return this.runnerPaths(beeId, generation).observations;
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
      // The HOST is the transcript's single writer. v15 observation journals
      // are output-only, so outbound suppression is needed only while talking
      // to an adopted legacy host that still tails the shared transcript.
      try {
        if (p.legacySharedObservation) p.outboundPending.push(line);
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
    if (
      (signal.kind === "turn_started" || signal.kind === "turn_ended")
      && signal.threadId
      && p.sessionId
      && signal.threadId !== p.sessionId
    ) {
      // codex app-server multiplexes the root thread and native subagent
      // threads onto one stdout stream. Only the provider session learned at
      // boot owns this bee's lifecycle: a child completion must not idle the
      // root, and a child start must not replace the root turn id used by
      // interrupt. Unscoped signals remain valid for older/non-codex adapters.
      return;
    }
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
      case "delivery_confirmed": {
        p.pendingDeliveries.delete(signal.messageId);
        p.confirmedDeliveries.add(signal.messageId);
        return;
      }
      case "delivery_refused": {
        p.pendingDeliveries.delete(signal.messageId);
        p.confirmedDeliveries.delete(signal.messageId);
        return;
      }
      case "flag": {
        this.evidence.push({
          beeId: p.beeId,
          generation: p.generation,
          flag: signal.flag,
          action: signal.action,
          detail: signal.detail,
          ...(signal.resetsAt !== undefined ? { resetsAt: signal.resetsAt } : {}),
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
    // F8: when the spawn config already knew the executable resolved nowhere,
    // the exit detail names it — this text reaches the operator through the
    // mirror. The crashed/spawn_failed mechanics themselves are untouched.
    const notFound = p.spawnError && p.commandResolution?.source === "not_found"
      ? ` — ${executableNotFoundDetail(p.commandResolution.executable)}`
      : "";
    this.events.push({
      beeId: p.beeId,
      generation: p.generation,
      kind: "exited",
      exitCause: cause,
      ...(p.spawnError ? { detail: `spawn error: ${p.spawnError}${notFound}` } : {}),
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
