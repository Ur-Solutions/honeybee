/**
 * WP4 test helpers. SAFETY: everything runs against fresh OS temp dirs
 * (mkdtemp) — store, socket, logs, session logs. Never ~/.hive, never the
 * repo, never the live daemon or its socket, never a real service manager.
 * The only agent ever spawned is the stub (v2/driver-hsr/test-agent).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DriverObservation, LiveProcess, RuntimeDriver, StopCause } from "../../harness/src/driver.ts";
import type { FlagEvidenceLike } from "../src/loops.ts";
import type { NodeConfigFile } from "../src/config.ts";
import { RpcClient } from "../../cli/src/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_PATH = join(here, "..", "..", "driver-hsr", "test-agent", "agent.mjs");
export const DAEMON_BIN = join(here, "..", "src", "bin.ts");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  timeoutMs = 8000,
  intervalMs = 40,
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
  readonly deliveredIds: number[] = [];
  /** When false, deliver refuses not_ready (I1-breach scenarios). */
  acceptDeliveries = true;
  /** When true, start immediately queues booted + turn_ended (idle runtime). */
  autoBoot = true;
  private nextPid = 100;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  start(beeId: string, generation: number): void {
    if (this.procs.has(beeId)) throw new Error(`fake driver: ${beeId} already live`);
    const pid = this.nextPid++;
    const proc: FakeProc = { generation, pid, pidStartedAt: this.now(), degraded: false };
    this.procs.set(beeId, proc);
    if (this.autoBoot) {
      this.events.push({ beeId, generation, kind: "booted", pid, pidStartedAt: proc.pidStartedAt });
      this.events.push({ beeId, generation, kind: "turn_ended" });
    }
  }

  deliver(beeId: string, generation: number, messageId: number, _body: string): { accepted: boolean; reason?: "no_process" | "not_ready" } {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { accepted: false, reason: "no_process" };
    if (p.degraded || !this.acceptDeliveries) return { accepted: false, reason: "not_ready" };
    this.deliveredIds.push(messageId);
    return { accepted: true };
  }

  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { hadProcess: false };
    this.procs.delete(beeId);
    this.events.push({ beeId, generation, kind: "exited", exitCause: cause });
    return { hadProcess: true };
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
    tickMs: 40,
    bootHangTimeoutMs: 4000,
    turnHangTimeoutMs: 4000,
    bootAllowanceMs: 1000,
    turnAllowanceMs: 1000,
    idleWindowMs: 0, // scale-to-zero off unless a test opts in
    stopKillGraceMs: 500,
    retry: { maxAttempts: 4, backoffBaseMs: 50 },
    ...file,
    agents: {
      stub: {
        command: process.execPath,
        args: [AGENT_PATH],
        adapter: "stub",
        env: { STUB_TURN_MS: "10", ...(stubEnv ?? {}) },
      },
      ...(file.agents ?? {}),
    },
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
    env: { ...process.env, HIVE_V2_DATA_DIR: dir },
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
    },
  };
  // Ready when the socket accepts a hello.
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
    10_000,
    60,
  );
  return handle;
}
