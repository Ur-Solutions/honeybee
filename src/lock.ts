import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm, stat, utimes, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { mkdir } from "node:fs/promises";

type ProcessProbe =
  | { state: "dead" }
  | { state: "alive"; birthId?: string }
  | { state: "unknown" };

export type LockOwnerMetadata = {
  /** Process id advertised by the holder. Never treated as identity by itself. */
  pid?: number;
  /** Host that created the lock. Absent on the known local-only legacy format. */
  hostname?: string;
  /** OS process-incarnation fingerprint. Absent on legacy/unsupported systems. */
  processBirthId?: string;
  /** Wall-clock diagnostic stamp from the holder. */
  createdAt?: string;
};

/** Secret-free exact identity for one concrete lock-file generation. */
export type FileLockOwnerIdentity = {
  owner: LockOwnerMetadata;
  /** SHA-256 of the complete bounded lock record, including its private token. */
  fingerprint: string;
  mtimeMs: number;
};

export type LockWaitInfo = {
  /** Monotonic duration observed so far. */
  waitMs: number;
  /** Secret-free, size-bounded projection of the first holder observed. */
  owner: LockOwnerMetadata | null;
};

export type LockAcquiredInfo = LockWaitInfo & {
  waited: boolean;
};

export type LockOptions = {
  timeoutMs?: number;
  /**
   * Minimum age before checking a live PID's birth identity. Age alone never
   * expires ownership: a paused live holder remains the owner forever.
   */
  staleMs?: number;
  pollMs?: number;
  /** Called once when acquisition first observes another holder. */
  onWait?: (info: LockWaitInfo) => void;
  /** Called after acquisition, with the full monotonic wait and first owner. */
  onAcquired?: (info: LockAcquiredInfo) => void;
  /** Called immediately before a timed-out acquisition rejects. */
  onTimeout?: (info: LockWaitInfo) => void;
  /** @internal Deterministic process-census injection for lock protocol tests. */
  __testOnlyProbeProcess?: (pid: number) => Promise<ProcessProbe>;
};

type LockHandle = {
  acquired: LockAcquiredInfo;
  release: () => Promise<void>;
};

type LockProtocolContext = {
  hostname: string;
  processBirthId?: string;
  probeProcess: (pid: number) => Promise<ProcessProbe>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 25;
const PROCESS_PROBE_TIMEOUT_MS = 5_000;
const MAX_LOCK_RECORD_BYTES = 16 * 1024;
let selfProbePromise: Promise<ProcessProbe> | undefined;

type MutationGuard = { release: () => Promise<void> };

export function fileLockMutationGuardPath(path: string, expected: FileLockOwnerIdentity): string {
  return `${path}.mutate-${expected.fingerprint}`;
}

export type LockGuardInitWriter = (handle: FileHandle, raw: string) => Promise<void>;

/**
 * Publish a complete guard record without ever exposing an initializing inode
 * at the authoritative path. `link` is the no-overwrite commit point: two
 * complete contenders may race, but only one inode becomes the guard. A
 * SIGKILL before that point leaves at worst an ignored `.init-*` sibling.
 */
export async function publishLockMutationGuardAtomically(
  guardPath: string,
  raw: string,
  writeInit: LockGuardInitWriter = (handle, content) => handle.writeFile(content),
): Promise<boolean> {
  const initToken = `${process.pid}.${Date.now()}.${randomUUID()}`;
  const initPath = `${guardPath}.init-${initToken}`;
  const handle = await open(initPath, "wx", 0o600);
  try {
    try {
      await writeInit(handle, raw);
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      await link(initPath, guardPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(initPath, { force: true }).catch(() => undefined);
  }
}

async function lockProtocolContext(testProbe?: (pid: number) => Promise<ProcessProbe>): Promise<LockProtocolContext> {
  const probeProcess = testProbe ?? probeProcessOwner;
  const self = testProbe
    ? await probeProcess(process.pid)
    : await (selfProbePromise ??= probeProcess(process.pid));
  return {
    hostname: hostname(),
    ...(self.state === "alive" && self.birthId ? { processBirthId: self.birthId } : {}),
    probeProcess,
  };
}

async function reclaimDeadMutationGuard(
  guardPath: string,
  expected: FileLockOwnerIdentity,
  context: LockProtocolContext,
): Promise<boolean> {
  let guardOwner: LockOwnerMetadata | null = null;
  let lockFingerprint: unknown;
  try {
    const raw = await readFile(guardPath, "utf8");
    if (raw.length > MAX_LOCK_RECORD_BYTES) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    guardOwner = ownerMetadataFromObject(parsed);
    lockFingerprint = parsed.lockFingerprint;
  } catch {
    return false;
  }
  if (lockFingerprint !== expected.fingerprint || !guardOwner) return false;
  if (!(await canSafelyReclaim(guardOwner, context, true))) return false;
  // The path is generation-scoped. Removing a dead guard for G cannot touch or
  // block a replacement lock H, whose random token yields another SHA-256 path.
  await rm(guardPath, { force: true }).catch(() => undefined);
  return true;
}

async function acquireMutationGuard(
  path: string,
  expected: FileLockOwnerIdentity,
  context: LockProtocolContext,
  timeoutMs = 250,
): Promise<MutationGuard | null> {
  const guardPath = fileLockMutationGuardPath(path, expected);
  const deadline = performance.now() + Math.max(0, timeoutMs);
  while (true) {
    const token = `${process.pid}.${Date.now()}.${randomUUID()}`;
    const raw = JSON.stringify({
      pid: process.pid,
      hostname: context.hostname,
      ...(context.processBirthId ? { processBirthId: context.processBirthId } : {}),
      createdAt: new Date().toISOString(),
      token,
      lockFingerprint: expected.fingerprint,
      formatVersion: 2,
    });
    const published = await publishLockMutationGuardAtomically(guardPath, raw);
    if (published) {
      return {
        release: async () => {
          const current = await readFile(guardPath, "utf8").catch(() => null);
          if (current === raw) await rm(guardPath, { force: true }).catch(() => undefined);
        },
      };
    }
    if (await reclaimDeadMutationGuard(guardPath, expected, context)) continue;
    if (performance.now() >= deadline) return null;
    await sleep(5);
  }
}

export type GuardedFileLockOwnerResult<T> =
  | { matched: true; value: T }
  | { matched: false };

async function withGuardedFileLockOwnerContext<T>(
  path: string,
  expected: FileLockOwnerIdentity,
  action: (current: FileLockOwnerIdentity) => Promise<T>,
  guardTimeoutMs: number,
  context: LockProtocolContext,
): Promise<GuardedFileLockOwnerResult<T>> {
  const guard = await acquireMutationGuard(path, expected, context, guardTimeoutMs);
  if (!guard) return { matched: false };
  try {
    const current = await readFileLockIdentity(path);
    if (!current || current.fingerprint !== expected.fingerprint) return { matched: false };
    return { matched: true, value: await action(current) };
  } finally {
    await guard.release();
  }
}

/** Run one mutation only while the exact observed lock generation owns path. */
export async function withGuardedFileLockOwner<T>(
  path: string,
  expected: FileLockOwnerIdentity,
  action: (current: FileLockOwnerIdentity) => Promise<T>,
  guardTimeoutMs = 250,
): Promise<GuardedFileLockOwnerResult<T>> {
  const context = await lockProtocolContext();
  return withGuardedFileLockOwnerContext(path, expected, action, guardTimeoutMs, context);
}

async function refreshFileLockIfOwner(
  path: string,
  expected: FileLockOwnerIdentity,
  timeoutMs: number,
  context: LockProtocolContext,
): Promise<boolean> {
  const refreshed = await withGuardedFileLockOwnerContext(path, expected, async () => {
    const now = new Date();
    await utimes(path, now, now);
    return true;
  }, timeoutMs, context).catch(() => ({ matched: false } as const));
  return refreshed.matched;
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lock = await acquireFileLock(path, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function acquireFileLock(path: string, options: LockOptions): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const started = performance.now();
  const context = await lockProtocolContext(options.__testOnlyProbeProcess);
  let reportedWait = false;
  let firstOwner: LockOwnerMetadata | null = null;

  const throwTimeout = (): never => {
    const info = { waitMs: Math.max(0, performance.now() - started), owner: firstOwner };
    safeCallback(() => options.onTimeout?.(info));
    throw new Error(`Timed out waiting for lock: ${path}`);
  };

  await mkdir(dirname(path), { recursive: true });

  while (true) {
    const token = `${process.pid}.${Date.now()}.${randomUUID()}`;
    const rawIdentity = JSON.stringify({
      pid: process.pid,
      hostname: context.hostname,
      ...(context.processBirthId ? { processBirthId: context.processBirthId } : {}),
      createdAt: new Date().toISOString(),
      token,
      formatVersion: 2,
    });
    try {
      // Publish complete owner metadata atomically. An interrupted initializer
      // leaves only a non-authoritative unique sibling, never a partial lock.
      const published = await publishLockMutationGuardAtomically(path, rawIdentity);
      if (!published) throw Object.assign(new Error(`Lock exists: ${path}`), { code: "EEXIST" });
      const expected = identityFromRaw(rawIdentity, Date.now())!;
      const heartbeatMs = Math.max(50, Math.floor(staleMs / 3));
      let heartbeatRunning = false;
      const heartbeat = setInterval(() => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        void refreshFileLockIfOwner(path, expected, heartbeatMs, context)
          .finally(() => { heartbeatRunning = false; });
      }, heartbeatMs);
      heartbeat.unref?.();
      const acquired: LockAcquiredInfo = {
        waited: reportedWait,
        waitMs: Math.max(0, performance.now() - started),
        owner: firstOwner,
      };
      safeCallback(() => options.onAcquired?.(acquired));
      return {
        acquired,
        release: async () => {
          clearInterval(heartbeat);
          await removeFileLockIfOwnerContext(path, expected, {
            suffix: "released",
            guardTimeoutMs: 1_000,
          }, context).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!reportedWait) {
        reportedWait = true;
        firstOwner = await readLockOwner(path);
        const info = { waitMs: Math.max(0, performance.now() - started), owner: firstOwner };
        // Observability is non-authoritative and cannot break exclusion.
        safeCallback(() => options.onWait?.(info));
      }

      const identity = await readFileLockIdentity(path);
      if (identity) {
        const oldEnoughForBirthProbe = Date.now() - identity.mtimeMs > staleMs;
        if (await canSafelyReclaim(identity.owner, context, oldEnoughForBirthProbe)) {
          await stealDeadLock(path, identity, context, oldEnoughForBirthProbe);
          if (performance.now() - started >= timeoutMs) throwTimeout();
          continue;
        }
      }

      if (performance.now() - started >= timeoutMs) throwTimeout();
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (performance.now() - started))));
    }
  }
}

function safeCallback(fn: () => void): void {
  try {
    fn();
  } catch {
    // Metrics/debug hooks are deliberately non-authoritative.
  }
}

function ownerMetadataFromObject(value: Record<string, unknown>): LockOwnerMetadata {
  return {
    ...(isPid(value.pid) ? { pid: value.pid } : {}),
    ...(typeof value.hostname === "string" && value.hostname.length <= 255 ? { hostname: value.hostname } : {}),
    ...(typeof value.processBirthId === "string" && value.processBirthId.length <= 512
      ? { processBirthId: value.processBirthId }
      : {}),
    ...(typeof value.createdAt === "string" && value.createdAt.length <= 64 ? { createdAt: value.createdAt } : {}),
  };
}

/** Parse only a secret-free, bounded metadata projection from a lock file. */
function identityFromRaw(raw: string, mtimeMs: number): FileLockOwnerIdentity | null {
  if (raw.length > MAX_LOCK_RECORD_BYTES) return null;
  let owner: LockOwnerMetadata;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    owner = ownerMetadataFromObject(value as Record<string, unknown>);
  } catch {
    // Historical JSON.stringify records put pid first. Recover a truncated
    // record's owner so live partial writes fail closed and dead writers do not
    // strand a lock whose death is still provable.
    const pidMatch = /^\s*\{\s*"pid"\s*:\s*(\d+)\s*(?:,|$)/.exec(raw);
    if (!pidMatch) return null;
    const pid = Number(pidMatch[1]);
    if (!isPid(pid)) return null;
    const hostnameMatch = /(?:^|,)\s*"hostname"\s*:\s*"([^"]*)"/.exec(raw);
    owner = {
      pid,
      ...(hostnameMatch ? { hostname: hostnameMatch[1] } : {}),
    };
  }
  return { owner, fingerprint: createHash("sha256").update(raw).digest("hex"), mtimeMs };
}

/** Read an exact, secret-free identity for guarded lock-owner revalidation. */
export async function readFileLockIdentity(path: string): Promise<FileLockOwnerIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const info = await stat(path).catch(() => null);
  return info ? identityFromRaw(raw, info.mtimeMs) : null;
}

async function readLockOwner(path: string): Promise<LockOwnerMetadata | null> {
  return (await readFileLockIdentity(path))?.owner ?? null;
}

/**
 * Reclaim only a local owner whose process incarnation is provably gone.
 * Missing hostname means the known pre-hostname, local-only lock format;
 * empty/foreign hostname and missing PID remain ambiguous and fail closed.
 */
async function canSafelyReclaim(
  owner: LockOwnerMetadata,
  context: LockProtocolContext,
  checkBirthIdentity: boolean,
): Promise<boolean> {
  if (owner.hostname !== undefined && (!owner.hostname || owner.hostname !== context.hostname)) return false;
  if (owner.pid === undefined) return false;

  const existence = probePidExistence(owner.pid);
  if (existence === "dead") return true;
  if (existence !== "alive") return false;
  // A live PID without a birth fingerprint is the legacy PID-reuse ambiguity.
  if (!checkBirthIdentity || !owner.processBirthId) return false;

  const probe = await context.probeProcess(owner.pid);
  if (probe.state === "dead") return true;
  if (probe.state !== "alive" || !probe.birthId) return false;
  return probe.birthId !== owner.processBirthId;
}

/** Reclaim only if the same exact generation still has a proven-dead owner. */
async function stealDeadLock(
  path: string,
  expected: FileLockOwnerIdentity,
  context: LockProtocolContext,
  checkBirthIdentity: boolean,
): Promise<void> {
  await removeFileLockIfOwnerContext(path, expected, {
    suffix: "dead",
    validate: (current) => canSafelyReclaim(current.owner, context, checkBirthIdentity),
  }, context);
}

export type RemoveFileLockOptions = {
  suffix?: string;
  guardTimeoutMs?: number;
  validate?: (current: FileLockOwnerIdentity) => boolean | Promise<boolean>;
};

/**
 * Rename/remove a lock only after exact owner revalidation under the same
 * generation gate used by releases, heartbeats, and reclaimers. A new direct
 * acquisition cannot succeed until the guarded rename removes the old path,
 * and its random token gives the replacement a different guard.
 */
export async function removeFileLockIfOwner(
  path: string,
  expected: FileLockOwnerIdentity,
  options: RemoveFileLockOptions = {},
): Promise<boolean> {
  return removeFileLockIfOwnerContext(path, expected, options, await lockProtocolContext());
}

async function removeFileLockIfOwnerContext(
  path: string,
  expected: FileLockOwnerIdentity,
  options: RemoveFileLockOptions,
  context: LockProtocolContext,
): Promise<boolean> {
  let movedPath: string | null = null;
  const move = async (current: FileLockOwnerIdentity): Promise<boolean> => {
    if (options.validate && !(await options.validate(current))) return false;
    const suffix = options.suffix?.replace(/[^a-z0-9_-]/gi, "") || "removed";
    movedPath = `${path}.${suffix}.${process.pid}.${Date.now()}.${randomUUID()}`;
    const moved = await rename(path, movedPath).then(() => true).catch(() => false);
    if (!moved) movedPath = null;
    return moved;
  };
  try {
    const guarded = await withGuardedFileLockOwnerContext(
      path,
      expected,
      move,
      options.guardTimeoutMs ?? 250,
      context,
    );
    return guarded.matched && guarded.value;
  } finally {
    if (movedPath) await rm(movedPath, { force: true }).catch(() => undefined);
  }
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function probeProcessOwner(pid: number): Promise<ProcessProbe> {
  const existence = probePidExistence(pid);
  if (existence !== "alive") return { state: existence };

  if (process.platform === "linux") {
    try {
      const [rawStat, rawBootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const closeParen = rawStat.lastIndexOf(")");
      if (closeParen < 0) return { state: "alive" };
      // The suffix starts at field 3 (state); index 19 is field 22, starttime.
      const startTicks = rawStat.slice(closeParen + 1).trim().split(/\s+/)[19];
      const bootId = rawBootId.trim();
      if (!startTicks || !/^\d+$/.test(startTicks) || !bootId) return { state: "alive" };
      return { state: "alive", birthId: `linux:${bootId}:${startTicks}` };
    } catch {
      return probePidExistence(pid) === "dead" ? { state: "dead" } : { state: "unknown" };
    }
  }

  if (process.platform !== "win32") {
    try {
      const startedAt = (await execFileStdout("/bin/ps", ["-o", "lstart=", "-p", String(pid)])).trim();
      if (startedAt) return { state: "alive", birthId: `${process.platform}:${startedAt}` };
    } catch {
      // Re-probe below: ps failure while the PID remains alive is ambiguous.
    }
    return probePidExistence(pid) === "dead" ? { state: "dead" } : { state: "unknown" };
  }

  return { state: "alive" };
}

function probePidExistence(pid: number): "alive" | "dead" | "unknown" {
  if (!isPid(pid)) return "unknown";
  if (pid === process.pid) return "alive";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function execFileStdout(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
