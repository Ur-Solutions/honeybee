import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, lockOwnedByThisMachine } from "../fsx.js";
import type { LockMeta } from "../fsx.js";
import { readLockMeta } from "../fsx.js";
import { daemonRoot } from "./log.js";

export const DAEMON_VERSION = "1";

export type DaemonConfig = {
  tickMs: number;
  /**
   * Hard budget for a single tick. A tick that exceeds it is abandoned and
   * recorded in recentErrors; the loop keeps iterating but skips further
   * ticks (each skip counting as a failed iteration) until the abandoned
   * tick settles — the tick path is stateful and must never run twice
   * concurrently.
   */
  tickBudgetMs: number;
  /**
   * In-process watchdog threshold: if the tick loop stops beating for this
   * long the daemon hard-kills itself so supervision restarts it. Must
   * exceed tickBudgetMs (the budget is the first line of defense).
   */
  watchdogMs: number;
  /**
   * Consecutive failed loop iterations (tick error/timeout or wedged
   * bookkeeping IO) before the daemon judges its runtime poisoned — a lost
   * libuv completion kills ALL subsequent async fs — and hard-kills itself
   * for a supervised restart.
   */
  maxConsecutiveFailures: number;
  /**
   * Out-of-process sentinel: heartbeat (state.json mtime) age at which the
   * sentinel SIGKILLs the daemon. Sits above watchdogMs so the in-process
   * defenses get the first shot.
   */
  sentinelStaleMs: number;
  /** Sentinel poll interval. */
  sentinelCheckMs: number;
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
  /**
   * True when a lock exists but was written by a different host (shared or
   * synced store roots). Such locks never count as "running" here — we
   * cannot validate a foreign PID against the local PID table.
   */
  lockHeldByOtherHost: boolean;
  state: DaemonState | null;
  /**
   * True when the daemon process is alive but its loop is not: running &&
   * lastTickAt (or startedAt, if it never ticked) older than staleAfterMs.
   * A wedged loop inside a live process must read as an outage, not health.
   */
  stale: boolean;
  /** Age of the last tick in ms (running daemons only, null otherwise). */
  lastTickAgeMs: number | null;
  /** The threshold staleness was judged against. */
  staleAfterMs: number;
  installed: boolean;
  plistPath: string | null;
};

const DEFAULT_TICK_MS = 2_000;
const DEFAULT_TICK_BUDGET_MS = 120_000;
const MAX_RECENT_ERRORS = 10;
/**
 * Default staleness threshold for `hive daemon status`: a running daemon
 * whose lastTickAt is older than this is reported STALE (nonzero exit) so
 * external polling catches a wedged loop that the in-process defenses missed.
 * Comfortably above tickBudgetMs so a single slow-but-recovered tick never
 * false-positives.
 */
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export function defaultDaemonConfig(): DaemonConfig {
  const tickMs = positiveEnvMs("HIVE_DAEMON_TICK_MS", DEFAULT_TICK_MS);
  const tickBudgetMs = positiveEnvMs("HIVE_DAEMON_TICK_BUDGET_MS", DEFAULT_TICK_BUDGET_MS);
  // The watchdog only backstops what the tick budget missed, so it sits well
  // above the budget: a stall can only mean the budget machinery itself died.
  const watchdogMs = positiveEnvMs("HIVE_DAEMON_WATCHDOG_MS", Math.max(3 * tickMs, 2 * tickBudgetMs));
  const maxConsecutiveFailures = positiveEnvMs("HIVE_DAEMON_MAX_FAILURES", 5);
  // The sentinel is the outermost net; give the in-process watchdog a full
  // extra minute to act before the SIGKILL from outside.
  const sentinelStaleMs = positiveEnvMs("HIVE_DAEMON_SENTINEL_STALE_MS", watchdogMs + 60_000);
  const sentinelCheckMs = positiveEnvMs("HIVE_DAEMON_SENTINEL_CHECK_MS", 15_000);
  return { tickMs, tickBudgetMs, watchdogMs, maxConsecutiveFailures, sentinelStaleMs, sentinelCheckMs };
}

export function defaultStaleAfterMs(): number {
  return positiveEnvMs("HIVE_DAEMON_STALE_MS", DEFAULT_STALE_AFTER_MS);
}

function positiveEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
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
  /** Staleness threshold override; defaults to defaultStaleAfterMs(). */
  staleAfterMs?: number;
};

/**
 * Pure staleness judgment: is a running daemon's loop dead? Keys on
 * lastTickAt; a daemon that has not managed a first tick yet is judged on
 * startedAt so a boot wedge is caught too. Unparseable timestamps count as
 * stale — a state file we cannot interpret is not evidence of health.
 */
export function daemonLoopStale(state: DaemonState, nowMs: number, staleAfterMs: number): { stale: boolean; ageMs: number | null } {
  const basis = state.lastTickAt ?? state.startedAt;
  const parsed = Date.parse(basis);
  if (!Number.isFinite(parsed)) return { stale: true, ageMs: null };
  const ageMs = Math.max(0, nowMs - parsed);
  return { stale: ageMs > staleAfterMs, ageMs };
}

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
  // A shared/synced store root can carry a lock from another machine; a
  // foreign PID must not be validated against the local PID table. Identity
  // is the persisted machine id when the lock carries one (os.hostname()
  // flaps between DHCP and mDNS names on macOS — a rename must never make
  // the daemon's own lock look foreign); legacy locks fall back to hostname
  // equality, where a missing/empty hostname counts as foreign (matches the
  // lock-steal refusal in fsx.acquireLongLivedLock).
  const lockHeldByOtherHost = !!lock && !lockOwnedByThisMachine(lock);
  const running = !!lock && !lockHeldByOtherHost && isPidLikelyAlive(lock.pid);
  const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs();
  // Staleness only applies to a running daemon: a live process whose loop
  // stopped ticking. A down daemon is already reported as down.
  const loop = running && state ? daemonLoopStale(state, now(), staleAfterMs) : { stale: running && !state, ageMs: null };
  return {
    running,
    lock,
    lockHeldByOtherHost,
    state,
    stale: loop.stale,
    lastTickAgeMs: loop.ageMs,
    staleAfterMs,
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
