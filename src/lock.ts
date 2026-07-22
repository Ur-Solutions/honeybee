import { open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export type LockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  /** Called once when acquisition first observes another holder. */
  onWait?: () => void;
};

type LockHandle = {
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
  const started = Date.now();
  let reportedWait = false;

  await mkdir(dirname(path), { recursive: true });

  while (true) {
    try {
      const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token }));
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
      return {
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
        options.onWait?.();
      }

      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await stealStaleLock(path, staleMs);
        if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${path}`);
        continue;
      }

      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${path}`);
      await sleep(pollMs);
    }
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
