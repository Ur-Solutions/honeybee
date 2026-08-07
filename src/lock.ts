import { open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
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
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), token }));
      } finally {
        await handle.close().catch(() => undefined);
      }
      // Refresh the lock's mtime while held so a critical section longer than
      // staleMs (e.g. a slow ssh drain) is not stolen mid-flight by a waiter.
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(path, now, now).catch(() => undefined);
      }, Math.max(50, Math.floor(staleMs / 3)));
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
          // Only remove the lock if our token is still in it. If a waiter
          // declared us stale and stole the lock, the file now belongs to the
          // new holder; deleting it would let a third party acquire in parallel.
          // The read->rm pair is not atomic (no flock), but a steal landing in
          // that window requires staleMs of missed heartbeats first — the
          // holder refreshes mtime every staleMs/3 — so the residual race is
          // theoretical: it needs a process frozen long enough to be declared
          // stale that resumes precisely between the read and the rm.
          const current = await readFile(path, "utf8").catch(() => null);
          if (current === null) return;
          try {
            const parsed = JSON.parse(current) as { token?: unknown };
            if (parsed?.token !== token) return;
          } catch {
            return;
          }
          await rm(path, { force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
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
      const owner = await readLockOwner(path);
      if (owner && owner.hostname === hostname() && owner.pid !== undefined && !isPidAlive(owner.pid)) {
        await stealDeadLock(path, owner);
        if (performance.now() - started >= timeoutMs) throwTimeout();
        continue;
      }

      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await stealStaleLock(path, staleMs);
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
async function readLockOwner(path: string): Promise<LockOwnerMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (raw.length > 16 * 1024) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      ...(typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : {}),
      ...(typeof value.hostname === "string" && value.hostname.length <= 255 ? { hostname: value.hostname } : {}),
      ...(typeof value.createdAt === "string" && value.createdAt.length <= 64 ? { createdAt: value.createdAt } : {}),
    };
  } catch {
    return null;
  }
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
async function stealDeadLock(path: string, expected: LockOwnerMetadata): Promise<void> {
  const guardPath = `${path}.steal`;
  let guard;
  try {
    guard = await open(guardPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return;
  }
  try {
    const current = await readLockOwner(path);
    if (!current || current.pid !== expected.pid || current.hostname !== expected.hostname || current.createdAt !== expected.createdAt) return;
    if (current.pid !== undefined && isPidAlive(current.pid)) return;
    const stalePath = `${path}.dead.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await rename(path, stalePath).catch(() => undefined);
    await rm(stalePath, { force: true }).catch(() => undefined);
  } finally {
    await guard.close().catch(() => undefined);
    await rm(guardPath, { force: true }).catch(() => undefined);
  }
}

// A stealer that crashes mid-steal leaves the guard behind; steals themselves
// take microseconds, so anything older than this is debris.
const STEAL_GUARD_STALE_MS = 10_000;

/**
 * Remove a stale lock so the caller can retry acquisition. Stealers serialize
 * behind a `.steal` guard (open wx) and re-check staleness while holding it,
 * so two waiters that both observed a stale lock can't take turns deleting
 * each other's freshly recreated locks: only the first one in finds a stale
 * file, the rest re-stat and see either nothing or the winner's fresh lock.
 * The removal itself goes through rename so a racing legacy rm cannot make us
 * delete a file we did not inspect.
 */
async function stealStaleLock(path: string, staleMs: number): Promise<void> {
  const guardPath = `${path}.steal`;
  let guard;
  try {
    guard = await open(guardPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another stealer is mid-steal; clear its guard only if it clearly crashed.
    const guardInfo = await stat(guardPath).catch(() => null);
    if (guardInfo && Date.now() - guardInfo.mtimeMs > STEAL_GUARD_STALE_MS) {
      await rm(guardPath, { force: true }).catch(() => undefined);
    }
    return;
  }
  try {
    const current = await stat(path).catch(() => null);
    if (!current || Date.now() - current.mtimeMs <= staleMs) return; // already stolen or refreshed
    const stalePath = `${path}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await rename(path, stalePath).catch(() => undefined);
    await rm(stalePath, { force: true }).catch(() => undefined);
  } finally {
    await guard.close().catch(() => undefined);
    await rm(guardPath, { force: true }).catch(() => undefined);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
