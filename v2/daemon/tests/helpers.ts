/**
 * WP4 test helpers. SAFETY: everything runs against fresh OS temp dirs
 * (mkdtemp) — store, socket, logs, session logs. Never ~/.hive, never the
 * repo, never the live daemon or its socket, never a real service manager.
 * The only agent ever spawned is the stub (v2/driver-hsr/test-agent).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DriverObservation, InterruptOutcome, LiveProcess, RuntimeDriver, StopCause } from "../../harness/src/driver.ts";
import type { FlagEvidenceLike, ObservationCursorEvidenceLike, SessionEvidenceLike } from "../src/loops.ts";
import type { NodeConfigFile } from "../src/config.ts";
import { RpcClient } from "../../cli/src/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_PATH = join(here, "..", "..", "driver-hsr", "test-agent", "agent.mjs");
export const FAKE_LOGIN_PATH = join(here, "..", "..", "driver-hsr", "test-agent", "fake-login.mjs");
export const DAEMON_BIN = join(here, "..", "src", "bin.ts");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  timeoutMs = 8000,
  intervalMs = 15,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${what}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// FakeDriver — a fully controllable RuntimeDriver for loop-core unit tests
// ---------------------------------------------------------------------------

interface FakeProc {
  generation: number;
  pid: number;
  pidStartedAt: number;
  degraded: boolean;
}

export class FakeDriver implements RuntimeDriver {
  readonly procs = new Map<string, FakeProc>();
  events: DriverObservation[] = [];
  evidence: FlagEvidenceLike[] = [];
  sessions: SessionEvidenceLike[] = [];
  recoveryCursors: ObservationCursorEvidenceLike[] = [];
  readonly deliveredIds: number[] = [];
  /** The exact text handed over per delivery (envelope assertions). */
  readonly deliveredBodies: string[] = [];
  /** When false, deliver refuses not_ready (I1-breach scenarios). */
  acceptDeliveries = true;
  /** When true, start immediately queues booted + turn_ended (idle runtime). */
  autoBoot = true;
  /**
   * When true, start spawns a process that dies before it ever boots: the
   * exited(crashed) observation is queued and the process is gone (the
   * immediate-exit stub / missing-cwd shape). Wins over autoBoot.
   */
  bootCrash = false;
  /**
   * v9 — the readyAtSpawn instant-death shape (the 2026-08-18 soak loop): a
   * claude-like harness spawns fine (the driver mints a SYNTHETIC booted from
   * the OS spawn event), produces ZERO output, and dies ~instantly. start
   * queues booted{synthetic} + exited(crashed) and the process is gone. Wins
   * over autoBoot; loses to bootCrash/startError.
   */
  synthBootCrash = false;
  /**
   * v9 — a readyAtSpawn harness that DOES produce real output before dying
   * (claude emits its late init, then crashes): booted{synthetic}, then the
   * real booted the HsrDriver pushes when the adapter parses the first line,
   * then exited(crashed). Real evidence makes this a normal post-running
   * crash — never a spawn failure. Loses to bootCrash/synthBootCrash.
   */
  synthBootEvidenceCrash = false;
  /**
   * v9 — a healthy readyAtSpawn boot: booted{synthetic} and the process STAYS
   * ALIVE producing nothing (claude waiting for its first stdin). The store
   * shows running on synthetic evidence only — the shape the idle-urgency
   * eligibility rule exists for. Loses to the crash modes above.
   */
  synthBootAlive = false;
  /**
   * When set, start() THROWS this message before owning any process (a cell
   * whose provisioning failed, an unresolvable spawn spec). Wins over both.
   */
  startError: string | null = null;
  /** Every start() call, in order (bee, generation) — how many revives happened. */
  readonly starts: Array<{ beeId: string; generation: number }> = [];
  private nextPid = 100;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  start(beeId: string, generation: number): void {
    if (this.procs.has(beeId)) throw new Error(`fake driver: ${beeId} already live`);
    this.starts.push({ beeId, generation });
    if (this.startError != null) throw new Error(this.startError);
    const pid = this.nextPid++;
    const proc: FakeProc = { generation, pid, pidStartedAt: this.now(), degraded: false };
    this.procs.set(beeId, proc);
    if (this.bootCrash) {
      this.procs.delete(beeId);
      this.events.push({ beeId, generation, kind: "exited", exitCause: "crashed" });
      return;
    }
    if (this.synthBootAlive) {
      this.events.push({ beeId, generation, kind: "booted", pid, pidStartedAt: proc.pidStartedAt, synthetic: true });
      return;
    }
    if (this.synthBootCrash || this.synthBootEvidenceCrash) {
      this.events.push({ beeId, generation, kind: "booted", pid, pidStartedAt: proc.pidStartedAt, synthetic: true });
      if (this.synthBootEvidenceCrash) {
        // The HsrDriver pushes a real booted the moment the adapter parses
        // the first actual output line of a readyAtSpawn process.
        this.events.push({ beeId, generation, kind: "booted", pid, pidStartedAt: proc.pidStartedAt });
      }
      this.procs.delete(beeId);
      this.events.push({ beeId, generation, kind: "exited", exitCause: "crashed" });
      return;
    }
    if (this.autoBoot) {
      this.events.push({ beeId, generation, kind: "booted", pid, pidStartedAt: proc.pidStartedAt });
      this.events.push({ beeId, generation, kind: "turn_ended" });
    }
  }

  deliver(beeId: string, generation: number, messageId: number, body: string): { accepted: boolean; reason?: "no_process" | "not_ready" } {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { accepted: false, reason: "no_process" };
    if (p.degraded || !this.acceptDeliveries) return { accepted: false, reason: "not_ready" };
    this.deliveredIds.push(messageId);
    this.deliveredBodies.push(body);
    return { accepted: true };
  }

  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { hadProcess: false };
    this.procs.delete(beeId);
    this.events.push({ beeId, generation, kind: "exited", exitCause: cause });
    return { hadProcess: true };
  }

  /** Every interrupt() call, in order. */
  readonly interrupts: Array<{ beeId: string; generation: number }> = [];

  interrupt(beeId: string, generation: number): InterruptOutcome {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { interrupted: false, reason: "no_process" };
    this.interrupts.push({ beeId, generation });
    this.events.push({ beeId, generation, kind: "turn_ended" });
    return { interrupted: true };
  }

  observe(): DriverObservation[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  hasProcess(beeId: string, generation: number): boolean {
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation;
  }

  snapshotLive(): LiveProcess[] {
    return [...this.procs.entries()].map(([beeId, p]) => ({
      beeId,
      generation: p.generation,
      pid: p.pid,
      pidStartedAt: p.pidStartedAt,
    }));
  }

  // Optional capabilities the DaemonCore duck-types:
  observeEvidence(): FlagEvidenceLike[] {
    const out = this.evidence;
    this.evidence = [];
    return out;
  }

  observeSessions(): SessionEvidenceLike[] {
    const out = this.sessions;
    this.sessions = [];
    return out;
  }

  observeRecoveryCursors(): ObservationCursorEvidenceLike[] {
    const out = this.recoveryCursors;
    this.recoveryCursors = [];
    return out;
  }

  procOf(beeId: string, generation: number): { pid: number; pidStartedAt: number } | null {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return null;
    return { pid: p.pid, pidStartedAt: p.pidStartedAt };
  }

  isDegraded(beeId: string, generation: number): boolean {
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation && p.degraded;
  }

  markDegraded(beeId: string): void {
    const p = this.procs.get(beeId);
    if (p) p.degraded = true;
  }
}

// ---------------------------------------------------------------------------
// Real daemon process over a temp socket (integration tier)
// ---------------------------------------------------------------------------

export interface DaemonHandle {
  dir: string;
  socketPath: string;
  storePath: string;
  proc: ChildProcess;
  /** Connect a fresh RPC client (caller closes it). */
  client(): Promise<RpcClient>;
  /** SIGKILL the daemon process (children survive). */
  kill(): Promise<void>;
  /** Graceful SIGTERM + wait. */
  stop(): Promise<void>;
  output(): string;
}

export interface DaemonConfigOverrides extends NodeConfigFile {
  /** Extra env for the stub agent. */
  stubEnv?: Record<string, string>;
}

export function makeDaemonDir(overrides: DaemonConfigOverrides = {}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-daemon-"));
  const { stubEnv, ...file } = overrides;
  const config: NodeConfigFile = {
    tickMs: 20,
    // Real process startup can be delayed substantially on loaded release
    // hosts. Individual hang-policy tests override this with a short bound.
    bootHangTimeoutMs: 60_000,
    bootAllowanceMs: 1000,
    turnAllowanceMs: 1000,
    idleWindowMs: 0, // scale-to-zero off unless a test opts in
    stopKillGraceMs: 500,
    retry: { maxAttempts: 4, backoffBaseMs: 50 },
    ...file,
    // v7 SAFETY: the vault + homes ALWAYS live inside the temp dir — never
    // ~/.hive/vault or ~/.hive/homes; the private tmux socket only scopes legacy-seat cleanup.
    accounts: {
      vaultDir: join(dir, "vault"),
      homesDir: join(dir, "homes"),
      tmuxSocket: `hb-v2-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      limitsRefreshMs: 0,
      loginTimeoutMs: 20_000,
      ...(file.accounts ?? {}),
    },
    agents: {
      stub: {
        command: process.execPath,
        args: [AGENT_PATH],
        adapter: "stub",
        env: { STUB_TURN_MS: "10", ...(stubEnv ?? {}) },
      },
      ...(file.agents ?? {}),
    },
    // Tests never shell out to Codex/Claude for titles unless they opt in.
    naming: { auto: false, ...(file.naming ?? {}) },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function startDaemon(dir: string): Promise<DaemonHandle> {
  const socketPath = join(dir, "hived.sock");
  const storePath = join(dir, "core.sqlite3");
  const proc = spawn(process.execPath, [DAEMON_BIN, "--data-dir", dir], {
    // HIVE_NO_KEYCHAIN: the daemon under test never touches the developer's
    // real macOS Keychain (spec 08 keychain bridge is off unless injected).
    env: {
      ...process.env,
      HIVE_V2_DATA_DIR: dir,
      HIVE_NO_KEYCHAIN: "1",
      // Successful test shutdown owns and reaps its disposable runtimes.
      // Production never sets this; restart-survival semantics stay intact.
      HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (c: string) => (out += c));
  proc.stderr?.on("data", (c: string) => (out += c));
  const handle: DaemonHandle = {
    dir,
    socketPath,
    storePath,
    proc,
    output: () => out,
    client: () => RpcClient.connect(socketPath),
    kill: async () => {
      proc.kill("SIGKILL");
      await waitFor(() => proc.exitCode != null || proc.signalCode != null, "daemon killed", 4000);
    },
    stop: async () => {
      proc.kill("SIGTERM");
      await waitFor(() => proc.exitCode != null || proc.signalCode != null, "daemon stopped", 6000);
      await waitFor(
        () => liveRunnerHostPids(dir).length === 0,
        `test daemon runner hosts reaped (${liveRunnerHostPids(dir).join(", ")})`,
        4000,
      );
    },
  };
  // Ready when the socket accepts a hello.
  try {
    await waitFor(
      async () => {
        if (proc.exitCode != null) throw new Error(`daemon exited early (${proc.exitCode}):\n${out}`);
        try {
          const c = await RpcClient.connect(socketPath, 500);
          c.close();
          return true;
        } catch {
          return false;
        }
      },
      `daemon socket ${socketPath}`,
      60_000,
      20,
    );
  } catch (error) {
    // A startup timeout must not orphan a disposable daemon/runner tree and
    // then make every later process-backed test less reliable.
    proc.kill("SIGKILL");
    await waitFor(() => proc.exitCode != null || proc.signalCode != null, "timed-out daemon killed", 10_000)
      .catch(() => undefined);
    throw error;
  }
  return handle;
}

/** Test postcondition: a successful graceful stop leaves no detached host. */
function liveRunnerHostPids(dir: string): number[] {
  const runnersDir = join(dir, "runners");
  let names: string[];
  try {
    names = readdirSync(runnersDir).filter((name) => name.endsWith(".status.json"));
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    try {
      const status = JSON.parse(readFileSync(join(runnersDir, name), "utf8")) as { hostPid?: unknown };
      if (typeof status.hostPid === "number" && status.hostPid > 0 && pidAlive(status.hostPid)) pids.push(status.hostPid);
    } catch {
      // A status write racing shutdown is retried by waitFor.
    }
  }
  return pids;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
