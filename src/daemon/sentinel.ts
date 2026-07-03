// Out-of-process daemon sentinel.
//
// Two production wedges (2026-06-29, 2026-07-02) proved that no in-process
// mechanism can guarantee a wedged daemon dies: a lost libuv threadpool
// completion poisons every subsequent async fs op, and Node's process.exit()
// deadlocks in uv__threadpool_cleanup joining the poisoned pool — the second
// incident spent ~9 hours stuck INSIDE process.exit() called by the watchdog.
// A synchronously-blocked event loop can't even run a watchdog timer.
//
// The sentinel is a separate tiny process spawned by runDaemon. It watches
// the daemon's state.json mtime — written every loop iteration, so it is the
// loop's heartbeat — and SIGKILLs the parent when the heartbeat goes stale.
// SIGKILL needs nothing from the wedged process (no signal handler, no event
// loop, no exit path) and works on SIGSTOPped processes too. Supervision
// (launchd KeepAlive) then starts a fresh daemon. The sentinel exits when the
// parent is gone, so daemon restarts never accumulate sentinels.

import { appendFileSync, statSync } from "node:fs";

export type SentinelOptions = {
  parentPid: number;
  /** The daemon state.json whose mtime is the loop heartbeat. */
  statePath: string;
  /** Heartbeat age beyond which the parent is judged wedged. */
  staleMs: number;
  /** Poll interval. */
  checkMs: number;
  /** JSON-lines log file for the kill record (best-effort). */
  logPath?: string;
};

export type SentinelDeps = {
  isAlive?: (pid: number) => boolean;
  /** mtime of the heartbeat file in ms, or null when unreadable/missing. */
  mtimeMs?: (path: string) => number | null;
  kill?: (pid: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Pure staleness judgment. A missing/unreadable state file falls back to the
 * sentinel's own start time — a daemon that never manages its first state
 * write is as wedged as one that stopped writing.
 */
export function heartbeatStale(mtimeMs: number | null, fallbackMs: number, nowMs: number, staleMs: number): boolean {
  const basis = mtimeMs ?? fallbackMs;
  return nowMs - basis > staleMs;
}

export async function runSentinel(options: SentinelOptions, deps: SentinelDeps = {}): Promise<"parent-exited" | "killed"> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs;
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const startMs = now();
  while (true) {
    if (!isAlive(options.parentPid)) return "parent-exited";
    if (heartbeatStale(mtimeMs(options.statePath), startMs, now(), options.staleMs)) {
      logKill(options);
      try {
        kill(options.parentPid);
      } catch {
        // Parent raced us to death; either way our job is done.
      }
      return "killed";
    }
    await sleep(options.checkMs);
  }
}

function logKill(options: SentinelOptions): void {
  if (!options.logPath) return;
  try {
    appendFileSync(
      options.logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "daemon.sentinel.kill",
        parentPid: options.parentPid,
        staleMs: options.staleMs,
      })}\n`,
    );
  } catch {
    // best effort — the kill matters, the log line doesn't
  }
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
