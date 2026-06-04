import { open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

type LockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
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

  await mkdir(dirname(path), { recursive: true });

  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return {
        release: async () => {
          await handle.close().catch(() => undefined);
          await rm(path, { force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }

      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${path}`);
      await sleep(pollMs);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
