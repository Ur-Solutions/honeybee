/**
 * Exact process identity probing for cross-restart re-adoption (WP4).
 *
 * Contract §3.2: after a daemon restart, surviving runtimes are re-adopted
 * once, at boot, by pid + start-time check. The recorded identity is the
 * driver's wall-clock timestamp at spawn; the OS start time is recovered via
 * `ps -o etime=` (POSIX, locale-independent, macOS + Linux) and compared
 * within a small tolerance — `ps` rounds elapsed time to seconds and the
 * recorded stamp is taken a few ms after the actual fork.
 */
import { spawnSync } from "node:child_process";

/** True while the OS still knows the pid (signal 0 probe; EPERM counts as alive). */
export function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parse a POSIX `ps` etime value — `[[dd-]hh:]mm:ss` — into milliseconds. */
export function parseEtimeMs(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const days = Number(m[1] ?? "0");
  const hours = Number(m[2] ?? "0");
  const minutes = Number(m[3] ?? "0");
  const seconds = Number(m[4] ?? "0");
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** OS start time of a live pid in epoch ms, or null when it cannot be determined. */
export function processStartTimeMs(pid: number, now: () => number = Date.now): number | null {
  const res = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  const elapsed = parseEtimeMs(res.stdout);
  if (elapsed == null) return null;
  return now() - elapsed;
}

/**
 * The exact-identity check (the CO.a8d2 lesson): a pid is only "the process we
 * recorded" when it is alive AND its OS start time matches the recorded spawn
 * stamp within tolerance. Anything else — dead, unreadable, or a recycled pid
 * with a different start time — is NOT our process.
 */
export function verifyProcessIdentity(
  pid: number,
  expectedStartedAtMs: number,
  toleranceMs = 5000,
): boolean {
  if (!pidAlive(pid)) return false;
  const start = processStartTimeMs(pid);
  if (start == null) return false;
  return Math.abs(start - expectedStartedAtMs) <= toleranceMs;
}
