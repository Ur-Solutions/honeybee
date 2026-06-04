import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { storeRoot } from "../fsx.js";

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  msg: string;
} & Record<string, unknown>;

export type LogInput = {
  level: LogLevel;
  msg: string;
  ts?: string;
} & Record<string, unknown>;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 5;

export function daemonRoot(): string {
  return join(storeRoot(), "daemon");
}

export function daemonLogPath(): string {
  return join(daemonRoot(), "log.txt");
}

export function logMaxBytes(): number {
  const raw = Number(process.env.HIVE_DAEMON_LOG_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_BYTES;
  return raw;
}

export function logKeepCount(): number {
  const raw = Number(process.env.HIVE_DAEMON_LOG_KEEP ?? DEFAULT_KEEP);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_KEEP;
  return Math.floor(raw);
}

/**
 * Rotate the daemon log file if it exceeds the size threshold. Rotated files are
 * suffixed with an ISO-derived timestamp (`.YYYY-MM-DDTHH-MM-SS-mmmZ`). Older
 * rotated files beyond HIVE_DAEMON_LOG_KEEP are pruned (oldest first).
 *
 * Returns true if rotation occurred.
 */
export async function rotateDaemonLogIfNeeded(path = daemonLogPath()): Promise<boolean> {
  const maxBytes = logMaxBytes();
  const info = await stat(path).catch(() => null);
  if (!info || info.size < maxBytes) return false;

  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const rotatedPath = `${path}.${suffix}`;
  const renamed = await rename(path, rotatedPath).then(() => true).catch(() => false);
  if (!renamed) return false;

  await pruneRotatedLogs(path);
  return true;
}

async function pruneRotatedLogs(basePath: string): Promise<void> {
  const keep = logKeepCount();
  const dir = dirname(basePath);
  const prefix = `${basePath.slice(dir.length + 1)}.`;
  const entries = await readdir(dir).catch(() => []);
  const rotated = entries.filter((name) => name.startsWith(prefix)).sort();
  // Keep newest N (sort ascending == oldest first; pop the youngest end to keep).
  const toRemove = rotated.length > keep ? rotated.slice(0, rotated.length - keep) : [];
  for (const name of toRemove) {
    const fullPath = join(dir, name);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(fullPath, { force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Append a single structured log entry to the daemon log. Rotates first if the
 * file is over threshold. Each entry is a single JSON line.
 *
 * Errors are swallowed: logging must never crash the daemon.
 */
export async function appendDaemonLog(entry: LogInput, path = daemonLogPath()): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await rotateDaemonLogIfNeeded(path);
    const { level, msg, ts, ...rest } = entry;
    const full: LogEntry = {
      ts: ts ?? new Date().toISOString(),
      level,
      msg,
      ...rest,
    };
    await writeFile(path, `${JSON.stringify(full)}\n`, { flag: "a", mode: 0o600 });
  } catch {
    // logging failures must not crash the daemon
  }
}

