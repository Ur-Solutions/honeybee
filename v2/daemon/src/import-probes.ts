/**
 * Real process/tmux probes for the WP7 import preflight (spec 07 A2) and
 * `hive v2 freeze`. Same exact-identity discipline as the driver's psutil
 * (pid alive + OS start-time within tolerance) — a recycled pid with a
 * different start time is NOT the old runtime. Conservative on doubt: an
 * alive pid whose start time cannot be read counts as live (refuse, never
 * guess).
 *
 * One `ps` call snapshots every process's elapsed time, so probing the whole
 * frozen fleet costs a single fork.
 */
import { spawnSync } from "node:child_process";
import type { PreflightProbes } from "../../core/src/index.ts";
import { parseEtimeMs, pidAlive } from "../../driver-hsr/src/psutil.ts";

/**
 * Old-world start stamps come from `ps lstart` text (second granularity) and
 * ISO lock timestamps written slightly after the fork; the daemon lock's
 * startedAt in particular can lag process start by seconds on a busy boot.
 */
export const OLD_RUNTIME_START_TOLERANCE_MS = 60_000;

/** pid → OS start time (epoch ms) for every visible process, from one `ps` call. */
export function snapshotProcessStarts(now: () => number = Date.now): Map<number, number> {
  const out = new Map<number, number>();
  const res = spawnSync("ps", ["-axo", "pid=,etime="], { encoding: "utf8" });
  if (res.error || res.status !== 0) return out;
  const at = now();
  for (const line of res.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const elapsed = parseEtimeMs(m[2] as string);
    if (elapsed == null) continue;
    out.set(Number(m[1]), at - elapsed);
  }
  return out;
}

export function tmuxHasSession(target: string): boolean {
  // `=name` pins an exact session name (no prefix matching).
  const res = spawnSync("tmux", ["has-session", "-t", `=${target}`], { encoding: "utf8" });
  return !res.error && res.status === 0;
}

/** Build the probes once per preflight (one ps snapshot; tmux checked per target). */
export function realPreflightProbes(opts: { now?: () => number; toleranceMs?: number } = {}): PreflightProbes {
  const starts = snapshotProcessStarts(opts.now);
  const tol = opts.toleranceMs ?? OLD_RUNTIME_START_TOLERANCE_MS;
  return {
    pidLive(pid, startedAtMs) {
      if (!pidAlive(pid)) return false;
      const start = starts.get(pid);
      if (start == null || startedAtMs == null) return true; // alive, unverifiable → live (conservative)
      return Math.abs(start - startedAtMs) <= tol;
    },
    tmuxSessionLive: tmuxHasSession,
  };
}
