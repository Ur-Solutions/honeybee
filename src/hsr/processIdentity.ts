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
import { performance } from "node:perf_hooks";

const PROCESS_CENSUS_TIMEOUT_MS = 5_000;
// The current Node process already has an immutable per-incarnation clock
// origin. This self identity keeps in-process remote hosts verifiable inside a
// contained Cell where `/bin/ps` process enumeration is intentionally denied.
const SELF_PROCESS_BIRTH: ProcessBirthFingerprint = {
  pgid: process.pid,
  startedAt: `node-time-origin:${performance.timeOrigin}`,
};

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
export type ProcessGroupPresence = "present" | "absent" | "unverifiable";
export type ProcessGroupPresenceReader = (pgid: number) => Promise<ProcessGroupPresence>;

export type ProcessBirthCaptureOptions = {
  /** Total admission budget. Zero still performs one capture attempt. */
  timeoutMs?: number;
  /** Delay between capture attempts. */
  pollIntervalMs?: number;
  /** Injectable capture implementation for deterministic admission tests. */
  capture?: (pid: number) => Promise<ProcessBirthFingerprint | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_BIRTH_CAPTURE_TIMEOUT_MS = 1_000;
const DEFAULT_BIRTH_CAPTURE_POLL_MS = 10;

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

/**
 * Capture only an OS identity that another process can compare later.
 * Detached hosts and every durable cross-process locator must use this form;
 * failure is an admission failure, never permission to publish a local token.
 */
export async function capturePersistableProcessBirthFingerprint(
  pid: number,
  reader: ProcessIdentityReader = readProcessBirthFingerprint,
): Promise<ProcessBirthFingerprint | undefined> {
  try {
    return (await reader(pid)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort identity, including the contained in-process host fallback. */
export async function captureProcessBirthFingerprint(
  pid: number,
  reader: ProcessIdentityReader = readProcessBirthFingerprint,
): Promise<ProcessBirthFingerprint | undefined> {
  const persistable = await capturePersistableProcessBirthFingerprint(pid, reader);
  if (persistable) return persistable;
  // A remote controller can host logical HSR sessions in-process inside a
  // contained Cell where /bin/ps is intentionally unavailable. Keep that
  // supported shape verifiable by the same process, but never prefer this
  // process-local clock over the OS identity that detached local hosts must
  // persist for their parent/daemon observers.
  return pid === process.pid ? SELF_PROCESS_BIRTH : undefined;
}

/**
 * Capture a newly-created process's immutable birth identity within a bounded
 * admission window. A just-spawned process can briefly miss the first `ps`
 * census under load; callers must retry that observation, but must never
 * publish a durable ready/running record when the budget expires.
 */
export async function captureProcessBirthFingerprintWithRetry(
  pid: number,
  options: ProcessBirthCaptureOptions = {},
): Promise<ProcessBirthFingerprint | undefined> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_BIRTH_CAPTURE_TIMEOUT_MS);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_BIRTH_CAPTURE_POLL_MS);
  const capture = options.capture ?? captureProcessBirthFingerprint;
  const pause = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const fingerprint = await capture(pid);
    if (fingerprint) return fingerprint;
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    await pause(Math.min(pollIntervalMs, remaining));
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
  // Only the process that minted the contained-host fallback can validate it.
  // An external observer must continue through the OS reader, where the
  // incomparable node-time-origin token safely yields mismatch/unverifiable.
  if (pid === process.pid && sameProcessBirthFingerprint(expected, SELF_PROCESS_BIRTH)) {
    return "match";
  }
  try {
    const current = await reader(pid);
    if (!current) return "gone";
    return sameProcessBirthFingerprint(current, expected) ? "match" : "mismatch";
  } catch {
    return "unverifiable";
  }
}

/**
 * Read process-group presence without sending a signal. Signal 0 is an OS
 * identity probe: ESRCH proves absence, EPERM proves presence, and every other
 * failure is uncertainty rather than death evidence.
 */
export async function readProcessGroupPresence(pgid: number): Promise<ProcessGroupPresence> {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return "unverifiable";
  try {
    process.kill(-pgid, 0);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "present";
    return "unverifiable";
  }
}

/**
 * Observe the exact birth-bound process group persisted by a runtime.
 *
 * The group and its leader are deliberately checked together. A matching live
 * leader plus a present group is the recorded mutator. A gone leader plus an
 * absent group, or a birth-mismatched replacement, proves that exact group is
 * gone. Every contradictory, partial, missing, or unreadable observation stays
 * unverifiable so pool capacity fails closed.
 */
export async function inspectProcessGroupBirth(
  pgid: number,
  expected: ProcessBirthFingerprint | undefined,
  identityReader: ProcessIdentityReader = readProcessBirthFingerprint,
  groupReader: ProcessGroupPresenceReader = readProcessGroupPresence,
): Promise<ProcessIdentityVerdict> {
  if (!expected || expected.pgid !== pgid || !Number.isSafeInteger(pgid) || pgid <= 0) {
    return "unverifiable";
  }
  const birth = await inspectProcessBirth(pgid, expected, identityReader);
  if (birth === "mismatch") return "mismatch";

  let presence: ProcessGroupPresence;
  try {
    presence = await groupReader(pgid);
  } catch {
    return "unverifiable";
  }
  if (birth === "match" && presence === "present") return "match";
  if (birth === "gone" && presence === "absent") return "gone";
  return "unverifiable";
}
