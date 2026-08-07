import { link, open, readFile, rename, rm, stat, utimes, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";

export type LockOwnerMetadata = {
  /** Process id advertised by the holder. Never treated as identity by itself. */
  pid?: number;
  /** Host that created the lock. Absent on legacy lock files. */
  hostname?: string;
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
  staleMs?: number;
  pollMs?: number;
  /** Called once when acquisition first observes another holder. */
  onWait?: (info: LockWaitInfo) => void;
  /** Called after acquisition, with the full monotonic wait and first owner. */
  onAcquired?: (info: LockAcquiredInfo) => void;
  /** Called immediately before a timed-out acquisition rejects. */
  onTimeout?: (info: LockWaitInfo) => void;
};

type LockHandle = {
  acquired: LockAcquiredInfo;
  release: () => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 25;

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
  const initToken = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
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

async function reclaimDeadMutationGuard(guardPath: string, expected: FileLockOwnerIdentity): Promise<boolean> {
  let guardOwner: { pid?: unknown; hostname?: unknown; lockFingerprint?: unknown } | null = null;
  try {
    const raw = await readFile(guardPath, "utf8");
    if (raw.length > 16 * 1024) return false;
    guardOwner = JSON.parse(raw) as { pid?: unknown; hostname?: unknown; lockFingerprint?: unknown };
  } catch {
    return false;
  }
  if (
    guardOwner?.lockFingerprint !== expected.fingerprint
    || guardOwner.hostname !== hostname()
    || typeof guardOwner.pid !== "number"
    || !Number.isSafeInteger(guardOwner.pid)
    || guardOwner.pid <= 0
    || isPidAlive(guardOwner.pid)
  ) return false;
  // The path is generation-scoped. Removing a dead guard for G cannot touch or
  // block a replacement lock H, whose random lock token yields another SHA-256
  // guard path. Contenders for G retry open("wx") and exact revalidation.
  await rm(guardPath, { force: true }).catch(() => undefined);
  return true;
}

async function acquireMutationGuard(path: string, expected: FileLockOwnerIdentity, timeoutMs = 250): Promise<MutationGuard | null> {
  const guardPath = fileLockMutationGuardPath(path, expected);
  const deadline = performance.now() + Math.max(0, timeoutMs);
  while (true) {
    try {
      const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      const published = await publishLockMutationGuardAtomically(guardPath, JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
        token,
        lockFingerprint: expected.fingerprint,
      }));
      if (!published) throw Object.assign(new Error(`Lock mutation guard exists: ${guardPath}`), { code: "EEXIST" });
      return {
        release: async () => {
          await rm(guardPath, { force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimDeadMutationGuard(guardPath, expected)) continue;
      if (performance.now() >= deadline) return null;
      await sleep(5);
    }
  }
}

export type GuardedFileLockOwnerResult<T> =
  | { matched: true; value: T }
  | { matched: false };

/** Run one mutation only while the exact observed lock generation owns path. */
export async function withGuardedFileLockOwner<T>(
  path: string,
  expected: FileLockOwnerIdentity,
  action: (current: FileLockOwnerIdentity) => Promise<T>,
  guardTimeoutMs = 250,
): Promise<GuardedFileLockOwnerResult<T>> {
  const guard = await acquireMutationGuard(path, expected, guardTimeoutMs);
  if (!guard) return { matched: false };
  try {
    const current = await readFileLockIdentity(path);
    if (!current || current.fingerprint !== expected.fingerprint) return { matched: false };
    return { matched: true, value: await action(current) };
  } finally {
    await guard.release();
  }
}

async function refreshFileLockIfOwner(path: string, expected: FileLockOwnerIdentity, timeoutMs: number): Promise<boolean> {
  const refreshed = await withGuardedFileLockOwner(path, expected, async () => {
    const now = new Date();
    await utimes(path, now, now);
    return true;
  }, timeoutMs).catch(() => ({ matched: false } as const));
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
  let reportedWait = false;
  let firstOwner: LockOwnerMetadata | null = null;

  const throwTimeout = (): never => {
    const info = { waitMs: Math.max(0, performance.now() - started), owner: firstOwner };
    safeCallback(() => options.onTimeout?.(info));
    throw new Error(`Timed out waiting for lock: ${path}`);
  };

  await mkdir(dirname(path), { recursive: true });

  while (true) {
    try {
      const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      const rawIdentity = JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), token });
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(rawIdentity);
      } finally {
        await handle.close().catch(() => undefined);
      }
      const expected = identityFromRaw(rawIdentity, Date.now())!;
      // Refresh the lock's mtime while held so a critical section longer than
      // staleMs (e.g. a slow ssh drain) is not stolen mid-flight by a waiter.
      const heartbeatMs = Math.max(50, Math.floor(staleMs / 3));
      let heartbeatRunning = false;
      const heartbeat = setInterval(() => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        void refreshFileLockIfOwner(path, expected, heartbeatMs)
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
          await removeFileLockIfOwner(path, expected, { suffix: "released", guardTimeoutMs: 1_000 }).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!reportedWait) {
        reportedWait = true;
        firstOwner = await readLockOwner(path);
        const info = { waitMs: Math.max(0, performance.now() - started), owner: firstOwner };
        // Observability must never be able to break mutual exclusion. In
        // particular, do not let a telemetry callback throw between EEXIST and
        // the retry loop and strand an activation.
        safeCallback(() => options.onWait?.(info));
      }

      // Current-format local locks advertise their host + pid. A dead owner can
      // be reclaimed immediately instead of forcing every activation to wait
      // for the mtime stale window. Legacy/remote-host records retain the
      // conservative stale timeout because a pid alone is not safe identity.
      const identity = await readFileLockIdentity(path);
      if (identity && identity.owner.hostname === hostname() && identity.owner.pid !== undefined && !isPidAlive(identity.owner.pid)) {
        await stealDeadLock(path, identity);
        if (performance.now() - started >= timeoutMs) throwTimeout();
        continue;
      }

      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await stealStaleLock(path, staleMs, identity ?? undefined);
        if (performance.now() - started >= timeoutMs) throwTimeout();
        continue;
      }

      if (performance.now() - started >= timeoutMs) throwTimeout();
      await sleep(pollMs);
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

/** Parse only a secret-free, bounded metadata projection from a lock file. */
function identityFromRaw(raw: string, mtimeMs: number): FileLockOwnerIdentity | null {
  if (raw.length > 16 * 1024) return null;
  let owner: LockOwnerMetadata;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    owner = {
      ...(typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : {}),
      ...(typeof value.hostname === "string" && value.hostname.length <= 255 ? { hostname: value.hostname } : {}),
      ...(typeof value.createdAt === "string" && value.createdAt.length <= 64 ? { createdAt: value.createdAt } : {}),
    };
  } catch {
    return null;
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

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reclaim only if the same advertised dead owner still owns the file. */
async function stealDeadLock(path: string, expected: FileLockOwnerIdentity): Promise<void> {
  await removeFileLockIfOwner(path, expected, {
    suffix: "dead",
    validate: (current) => current.owner.pid === undefined || !isPidAlive(current.owner.pid),
  });
}

/**
 * Remove a stale lock so the caller can retry acquisition. Stealers serialize
 * behind a generation-scoped mutation guard and re-check staleness while holding it,
 * so two waiters that both observed a stale lock can't take turns deleting
 * each other's freshly recreated locks: only the first one in finds a stale
 * file, the rest re-stat and see either nothing or the winner's fresh lock.
 * The removal itself goes through rename so a racing legacy rm cannot make us
 * delete a file we did not inspect.
 */
async function stealStaleLock(path: string, staleMs: number, observed?: FileLockOwnerIdentity): Promise<void> {
  const expected = observed ?? await readFileLockIdentity(path);
  if (!expected) return;
  await removeFileLockIfOwner(path, expected, {
    suffix: "stale",
    validate: (current) => Date.now() - current.mtimeMs > staleMs,
  });
}

export type RemoveFileLockOptions = {
  suffix?: string;
  guardTimeoutMs?: number;
  validate?: (current: FileLockOwnerIdentity) => boolean;
};

/**
 * Rename/remove a lock only after exact owner revalidation under the same
 * generation gate used by releases, heartbeats, and other reclaimers. A new
 * direct open("wx") cannot succeed until the guarded rename removes the old
 * path, and its random token gives the replacement a different guard.
 */
export async function removeFileLockIfOwner(
  path: string,
  expected: FileLockOwnerIdentity,
  options: RemoveFileLockOptions = {},
): Promise<boolean> {
  let movedPath: string | null = null;
  const move = async (current: FileLockOwnerIdentity): Promise<boolean> => {
    if (options.validate && !options.validate(current)) return false;
    const suffix = options.suffix?.replace(/[^a-z0-9_-]/gi, "") || "removed";
    movedPath = `${path}.${suffix}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const moved = await rename(path, movedPath).then(() => true).catch(() => false);
    if (!moved) movedPath = null;
    return moved;
  };
  try {
    const guarded = await withGuardedFileLockOwner(path, expected, move, options.guardTimeoutMs ?? 250);
    return guarded.matched && guarded.value;
  } finally {
    if (movedPath) await rm(movedPath, { force: true }).catch(() => undefined);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
