import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export function storeRoot(): string {
  return process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive");
}

export type AtomicWriteOptions = {
  mode?: number;
};

// Monotonic counter so two same-process writes to one destination in the same
// millisecond never collide on the temp file name.
let atomicWriteCounter = 0;

export async function atomicWriteFile(path: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  atomicWriteCounter += 1;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${atomicWriteCounter}.tmp`);
  await writeFile(tmp, data, options.mode !== undefined ? { mode: options.mode } : undefined);
  await rename(tmp, path);
}

export type LockMeta = {
  pid: number;
  hostname: string;
  startedAt: string;
  token?: string;
  label?: string;
};

export type LongLivedLock = {
  meta: LockMeta;
  token: string;
  release: () => Promise<void>;
};

export type AcquireLockOptions = {
  label?: string;
  force?: boolean;
  isPidAlive?: (pid: number) => boolean;
};

export class LockBusyError extends Error {
  readonly existing: LockMeta | null;
  constructor(message: string, existing: LockMeta | null) {
    super(message);
    this.name = "LockBusyError";
    this.existing = existing;
  }
}

function generateLockToken(): string {
  return `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// How long an unreadable (empty/garbled) lock file may sit before we treat it
// as the debris of a crashed writer and steal it. A healthy acquirer writes
// the meta through the wx handle, so any in-flight write completes in
// milliseconds, not tens of seconds.
const UNREADABLE_LOCK_STALE_MS = 30_000;

export async function acquireLongLivedLock(path: string, options: AcquireLockOptions = {}): Promise<LongLivedLock> {
  await mkdir(dirname(path), { recursive: true });
  const aliveCheck = options.isPidAlive ?? defaultIsPidAlive;
  const currentHost = hostname();
  await cleanupOrphanedStagedFiles(path);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const token = generateLockToken();
      const meta: LockMeta = {
        pid: process.pid,
        hostname: currentHost,
        startedAt: new Date().toISOString(),
        token,
        ...(options.label ? { label: options.label } : {}),
      };
      // Write the meta through the wx handle directly so the window in which a
      // reader can observe a zero-byte lock file is only the write itself.
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(meta, null, 2));
      } finally {
        await handle.close().catch(() => undefined);
      }
      return {
        meta,
        token,
        release: async () => releaseIfOwner(path, token),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const existing = await readLockMeta(path);
      if (options.force) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      if (!existing) {
        // Unreadable or empty lock file — e.g. a writer crashed between
        // open(wx) and writing the meta. It can never become valid on its own
        // (the pid/hostname checks are skipped without meta), so steal it once
        // it is old enough that no in-flight write can explain it.
        const info = await stat(path).catch(() => null);
        if (!info) continue; // disappeared between open and stat; retry
        if (Date.now() - info.mtimeMs > UNREADABLE_LOCK_STALE_MS) {
          await stealLongLivedLock(path, async () => {
            if (await readLockMeta(path)) return false; // became readable; not stealable as debris
            const again = await stat(path).catch(() => null);
            return !!again && Date.now() - again.mtimeMs > UNREADABLE_LOCK_STALE_MS;
          });
          continue;
        }
        throw new LockBusyError(`Lock busy: ${path}`, null);
      }
      // Treat missing or empty hostname as unknown — refuse rather than risk a wrong-host steal.
      if (!existing.hostname || existing.hostname !== currentHost) {
        throw new LockBusyError(
          `Lock held by pid ${existing.pid} on host ${existing.hostname || "<unknown>"} since ${existing.startedAt}`,
          existing,
        );
      }
      if (!aliveCheck(existing.pid)) {
        await stealLongLivedLock(path, async () => {
          const meta = await readLockMeta(path);
          return !!meta && meta.hostname === currentHost && !aliveCheck(meta.pid);
        });
        continue;
      }
      throw new LockBusyError(
        `Lock held by pid ${existing.pid} since ${existing.startedAt}${existing.label ? ` (${existing.label})` : ""}`,
        existing,
      );
    }
  }

  throw new LockBusyError(`Could not acquire lock: ${path}`, null);
}

// Older versions staged lock meta to `.{name}.{pid}.{ts}.staged` siblings; a
// crash between staging and rename leaked them forever. Sweep any that are old
// enough to not belong to a still-racing legacy acquirer.
async function cleanupOrphanedStagedFiles(path: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `.${basename(path)}.`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".staged")) continue;
    const full = join(dir, entry);
    const info = await stat(full).catch(() => null);
    if (!info || Date.now() - info.mtimeMs <= UNREADABLE_LOCK_STALE_MS) continue;
    await rm(full, { force: true }).catch(() => undefined);
  }
}

async function releaseIfOwner(path: string, ourToken: string): Promise<void> {
  const meta = await readLockMeta(path);
  // Only remove the lockfile if we still own it. If it was force-stolen,
  // a different token now sits at this path; do not clobber it.
  if (!meta || meta.token !== ourToken) return;
  await rm(path, { force: true }).catch(() => undefined);
}

// A stealer that crashes mid-steal leaves the guard behind; steals take
// microseconds, so anything older than this is debris.
const STEAL_GUARD_STALE_MS = 10_000;

/**
 * Remove a stealable lock so the caller can retry acquisition. Stealers
 * serialize behind a `.steal` guard (open wx) and re-verify stealability
 * while holding it — without this, two waiters that both observed a
 * stale/dead lock can take turns deleting each other's freshly recreated
 * locks (the same TOCTOU lock.ts guards against). The removal itself goes
 * through rename so we never delete a file we did not inspect.
 */
async function stealLongLivedLock(path: string, stillStealable: () => Promise<boolean>): Promise<void> {
  const guardPath = `${path}.steal`;
  let guard;
  try {
    guard = await open(guardPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await stat(guardPath).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STEAL_GUARD_STALE_MS) {
      await rm(guardPath, { force: true }).catch(() => undefined);
    }
    return;
  }
  try {
    if (!(await stillStealable())) return;
    const stalePath = `${path}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await rename(path, stalePath).catch(() => undefined);
    await rm(stalePath, { force: true }).catch(() => undefined);
  } finally {
    await guard.close().catch(() => undefined);
    await rm(guardPath, { force: true }).catch(() => undefined);
  }
}

export async function readLockMeta(path: string): Promise<LockMeta | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    if (typeof object.pid !== "number" || typeof object.startedAt !== "string") return null;
    return {
      pid: object.pid,
      hostname: typeof object.hostname === "string" ? object.hostname : "",
      startedAt: object.startedAt,
      ...(typeof object.token === "string" ? { token: object.token } : {}),
      ...(typeof object.label === "string" ? { label: object.label } : {}),
    };
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}
