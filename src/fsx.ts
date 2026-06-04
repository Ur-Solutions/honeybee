import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export function storeRoot(): string {
  return process.env.HIVE_STORE_ROOT ?? join(homedir(), ".hive");
}

export type AtomicWriteOptions = {
  mode?: number;
};

export async function atomicWriteFile(path: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
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

export async function acquireLongLivedLock(path: string, options: AcquireLockOptions = {}): Promise<LongLivedLock> {
  await mkdir(dirname(path), { recursive: true });
  const aliveCheck = options.isPidAlive ?? defaultIsPidAlive;
  const currentHost = hostname();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = generateLockToken();
      const meta: LockMeta = {
        pid: process.pid,
        hostname: currentHost,
        startedAt: new Date().toISOString(),
        token,
        ...(options.label ? { label: options.label } : {}),
      };
      // Stage the meta to a sibling temp first so readers between open(wx) and write
      // never observe a zero-byte lock file.
      const stagedPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.staged`);
      await writeFile(stagedPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.close();
        await rename(stagedPath, path);
      } catch (error) {
        await rm(stagedPath, { force: true }).catch(() => undefined);
        throw error;
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
      // Treat missing or empty hostname as unknown — refuse rather than risk a wrong-host steal.
      if (existing && (!existing.hostname || existing.hostname !== currentHost)) {
        throw new LockBusyError(
          `Lock held by pid ${existing.pid} on host ${existing.hostname || "<unknown>"} since ${existing.startedAt}`,
          existing,
        );
      }
      if (existing && !aliveCheck(existing.pid)) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      throw new LockBusyError(
        existing
          ? `Lock held by pid ${existing.pid} since ${existing.startedAt}${existing.label ? ` (${existing.label})` : ""}`
          : `Lock busy: ${path}`,
        existing,
      );
    }
  }

  throw new LockBusyError(`Could not acquire lock: ${path}`, null);
}

async function releaseIfOwner(path: string, ourToken: string): Promise<void> {
  const meta = await readLockMeta(path);
  // Only remove the lockfile if we still own it. If it was force-stolen,
  // a different token now sits at this path; do not clobber it.
  if (!meta || meta.token !== ourToken) return;
  await rm(path, { force: true }).catch(() => undefined);
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
