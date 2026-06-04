import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import type { LockMeta } from "../fsx.js";
import { readLockMeta } from "../fsx.js";
import { daemonRoot } from "./log.js";

export const DAEMON_VERSION = "1";

export type DaemonConfig = {
  tickMs: number;
  /** Optional cap on how many ticks before voluntary exit (testing only). */
  maxTicks?: number;
};

export type RecentError = {
  ts: string;
  msg: string;
};

export type DaemonState = {
  startedAt: string;
  lastTickAt: string | null;
  tickCount: number;
  version: string;
  pid: number;
  recentErrors: RecentError[];
};

export type DaemonStatusReport = {
  running: boolean;
  lock: LockMeta | null;
  state: DaemonState | null;
  installed: boolean;
  plistPath: string | null;
};

const DEFAULT_TICK_MS = 2_000;
const MAX_RECENT_ERRORS = 10;

export function defaultDaemonConfig(): DaemonConfig {
  const raw = Number(process.env.HIVE_DAEMON_TICK_MS ?? DEFAULT_TICK_MS);
  const tickMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TICK_MS;
  return { tickMs };
}

export function maxRecentErrors(): number {
  return MAX_RECENT_ERRORS;
}

export function daemonLockPath(): string {
  return join(daemonRoot(), "daemon.lock");
}

export function daemonStatePath(): string {
  return join(daemonRoot(), "state.json");
}

export async function writeDaemonState(state: DaemonState): Promise<void> {
  await atomicWriteFile(daemonStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function readDaemonState(): Promise<DaemonState | null> {
  try {
    const raw = await readFile(daemonStatePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.startedAt !== "string") return null;
    if (typeof obj.version !== "string") return null;
    if (typeof obj.pid !== "number") return null;
    const tickCount = typeof obj.tickCount === "number" ? obj.tickCount : 0;
    const lastTickAt = typeof obj.lastTickAt === "string" ? obj.lastTickAt : null;
    const recentErrors = Array.isArray(obj.recentErrors)
      ? obj.recentErrors
          .filter((e): e is { ts: string; msg: string } => !!e && typeof e === "object" && typeof (e as RecentError).ts === "string" && typeof (e as RecentError).msg === "string")
          .map((e) => ({ ts: e.ts, msg: e.msg }))
      : [];
    return {
      startedAt: obj.startedAt,
      lastTickAt,
      tickCount,
      version: obj.version,
      pid: obj.pid,
      recentErrors,
    };
  } catch {
    return null;
  }
}

export type ReadDaemonStatusOptions = {
  /** LaunchAgent label to probe for installed-ness. Defaults to dev.honeybee.hive. */
  label?: string;
};

/**
 * Read both the daemon lock meta and the state.json snapshot, and infer
 * whether the daemon process is alive. "running" requires both an unexpired
 * lock and a live PID on the same host.
 *
 * The plist file presence is consulted via dynamic import so non-darwin
 * hosts still get a well-shaped report (installed=false, plistPath=null).
 */
export async function readDaemonStatus(
  now: () => number = Date.now,
  options: ReadDaemonStatusOptions = {},
): Promise<DaemonStatusReport> {
  const [lock, state, install] = await Promise.all([
    readLockMeta(daemonLockPath()),
    readDaemonState(),
    readInstallStatus(options.label),
  ]);
  const running = !!lock && isPidLikelyAlive(lock.pid);
  void now;
  return {
    running,
    lock,
    state,
    installed: install.plistExists,
    plistPath: install.plistExists ? install.plistPath : null,
  };
}

async function readInstallStatus(label?: string): Promise<{ plistExists: boolean; plistPath: string }> {
  try {
    // Dynamic import keeps this module importable on platforms where the
    // install module's launchctl dependency is undesirable to load eagerly.
    const mod = await import("./install.js");
    const status = await mod.getAgentInstallStatus(label);
    return { plistExists: status.plistExists, plistPath: status.plistPath };
  } catch {
    return { plistExists: false, plistPath: "" };
  }
}

function isPidLikelyAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export async function daemonStateExists(): Promise<boolean> {
  return !!(await stat(daemonStatePath()).catch(() => null));
}

export { daemonRoot, daemonLogPath } from "./log.js";
