/**
 * Portable POSIX process-birth identity for destructive HSR recovery.
 *
 * A PID/PGID is only a recyclable locator.  `ps lstart` plus the process group
 * is the durable-enough incarnation fingerprint already used by
 * sessionBase's descendant ownership census.  Every meta-derived fallback
 * signal must re-read and match this fingerprint; missing/unreadable evidence
 * fails closed.
 */

import { execFile } from "node:child_process";

const PROCESS_CENSUS_TIMEOUT_MS = 5_000;

export type ProcessRow = {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: string;
};

export type ProcessBirthFingerprint = {
  pgid: number;
  startedAt: string;
};

export type ProcessIdentityReader = (pid: number) => Promise<ProcessBirthFingerprint | null>;
export type ProcessIdentityVerdict = "match" | "mismatch" | "gone" | "unverifiable";

/** Parse one coherent topology + birth-identity process census. */
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) continue;
    rows.push({ pid, ppid, pgid, startedAt: match[4] });
  }
  return rows;
}

function execPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: PROCESS_CENSUS_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export async function listProcessRows(): Promise<ProcessRow[]> {
  // Preserve sessionBase's non-POSIX census behavior: ownership discovery is
  // simply unavailable there. Destructive single-PID inspection below still
  // throws so its caller produces the fail-closed `unverifiable` verdict.
  if (process.platform === "win32") return [];
  return parseProcessRows(await execPs(["-A", "-o", "pid=,ppid=,pgid=,lstart="]));
}

/** Read the current incarnation of one PID; null means the PID is absent. */
export async function readProcessBirthFingerprint(pid: number): Promise<ProcessBirthFingerprint | null> {
  if (process.platform === "win32") throw new Error("process birth identity is unavailable on win32");
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let output: string;
  try {
    output = await execPs(["-o", "pid=,ppid=,pgid=,lstart=", "-p", String(pid)]);
  } catch (error) {
    // BSD/macOS and procps both return exit status 1 when no selected PID
    // exists. Other failures (timeout, missing ps, permissions) are not death
    // evidence and must remain distinguishable to callers.
    if ((error as { code?: unknown }).code === 1) return null;
    throw error;
  }
  const row = parseProcessRows(output).find((candidate) => candidate.pid === pid);
  return row ? { pgid: row.pgid, startedAt: row.startedAt } : null;
}

/** Best-effort persistence helper; absence makes later destructive recovery fail closed. */
export async function captureProcessBirthFingerprint(pid: number): Promise<ProcessBirthFingerprint | undefined> {
  try {
    return (await readProcessBirthFingerprint(pid)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function sameProcessBirthFingerprint(
  left: ProcessBirthFingerprint | undefined,
  right: ProcessBirthFingerprint | undefined,
): boolean {
  return !!left && !!right && left.pgid === right.pgid && left.startedAt === right.startedAt;
}

/**
 * Compare durable identity with the OS immediately before destructive action.
 * A different birth proves the recorded incarnation is gone, but says nothing
 * about ownership of the replacement and therefore never authorizes a signal.
 */
export async function inspectProcessBirth(
  pid: number,
  expected: ProcessBirthFingerprint | undefined,
  reader: ProcessIdentityReader = readProcessBirthFingerprint,
): Promise<ProcessIdentityVerdict> {
  if (!expected || !Number.isSafeInteger(expected.pgid) || expected.pgid <= 0 || !expected.startedAt) {
    return "unverifiable";
  }
  try {
    const current = await reader(pid);
    if (!current) return "gone";
    return sameProcessBirthFingerprint(current, expected) ? "match" : "mismatch";
  } catch {
    return "unverifiable";
  }
}
