// Flow run inventory + on-disk layout.
//
// Storage:
//   ~/.hive/flows/<flowName>/runs/<runId>/meta.json
//   ~/.hive/flows/<flowName>/runs/<runId>/log.txt
//   ~/.hive/flows/<flowName>/runs/<runId>/result.json
//
// runId format mirrors src/buz.ts: 13-char base32 timestamp + 4-hex random.
// listRuns scans across all flows newest-first.

import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, defaultIsPidAlive, storeRoot } from "../fsx.js";

export type RunStatus = "running" | "ok" | "failed" | "cancelled" | "orphaned";

export type FlowRunMeta = {
  runId: string;
  flowName: string;
  args: Record<string, unknown>;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  pid?: number;
  /**
   * POSIX process-group id of the detached child running this flow. Present
   * only on background runs — set by spawnDetachedRun (patch 12). cancelRun
   * uses `process.kill(-pgid, signal)` to deliver SIGTERM/SIGKILL to the
   * whole process tree.
   */
  pgid?: number;
  /** Resolved cleanup policy ("keep" or "kill-on-end"). */
  cleanup?: "keep" | "kill-on-end";
  /** True for hive flow run --background; false (default) for foreground. */
  background?: boolean;
};

export type FlowRunResult = {
  runId: string;
  flowName: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  /** Return value of run() — JSON-serializable. */
  value?: unknown;
  error?: {
    message: string;
    stack?: string;
    cancelled?: boolean;
  };
};

const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a runId: 13-char base32 timestamp + 4-hex random, like buz ids.
 * Sortable lexicographically the same way as the underlying integer.
 */
export function generateRunId(now: number = Date.now()): string {
  return `${encodeBase32(now, 13)}-${randomHex(4)}`;
}

function encodeBase32(value: number, length: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`encodeBase32: value out of range: ${value}`);
  let n = Math.floor(value);
  const out: string[] = [];
  for (let i = 0; i < length; i += 1) {
    out.unshift(BASE32_ALPHABET[n % 32]!);
    n = Math.floor(n / 32);
  }
  return out.join("");
}

function randomHex(bytes: number): string {
  let out = "";
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Paths.
// ──────────────────────────────────────────────────────────────────────────

export function flowsRoot(): string {
  return join(storeRoot(), "flows");
}

export function flowRunsRoot(flowName: string): string {
  return join(flowsRoot(), flowName, "runs");
}

export function runDir(flowName: string, runId: string): string {
  return join(flowRunsRoot(flowName), runId);
}

export function runMetaPath(flowName: string, runId: string): string {
  return join(runDir(flowName, runId), "meta.json");
}

export function runLogPath(flowName: string, runId: string): string {
  return join(runDir(flowName, runId), "log.txt");
}

export function runResultPath(flowName: string, runId: string): string {
  return join(runDir(flowName, runId), "result.json");
}

// ──────────────────────────────────────────────────────────────────────────
// CRUD.
// ──────────────────────────────────────────────────────────────────────────

export async function createRunDir(flowName: string, runId: string): Promise<string> {
  const dir = runDir(flowName, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeMeta(flowName: string, runId: string, meta: FlowRunMeta): Promise<void> {
  await mkdir(runDir(flowName, runId), { recursive: true });
  await atomicWriteFile(runMetaPath(flowName, runId), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

export async function readMeta(flowName: string, runId: string): Promise<FlowRunMeta | null> {
  try {
    const raw = await readFile(runMetaPath(flowName, runId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeMeta(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeResult(flowName: string, runId: string, result: FlowRunResult): Promise<void> {
  await mkdir(runDir(flowName, runId), { recursive: true });
  let serialized: string;
  try {
    serialized = JSON.stringify(result, null, 2);
  } catch (error) {
    // The flow's return value is author-controlled and may be circular or
    // contain BigInt — a throw here must not strand the run without a result.
    const note = error instanceof Error ? error.message : String(error);
    const fallback: FlowRunResult = {
      ...result,
      value: `[unserializable flow result: ${note}] ${stringifyQuiet(result.value)}`,
    };
    serialized = JSON.stringify(fallback, null, 2);
  }
  await atomicWriteFile(runResultPath(flowName, runId), `${serialized}\n`, { mode: 0o600 });
}

function stringifyQuiet(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

export async function readResult(flowName: string, runId: string): Promise<FlowRunResult | null> {
  try {
    const raw = await readFile(runResultPath(flowName, runId), "utf8");
    return JSON.parse(raw) as FlowRunResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readLogFull(flowName: string, runId: string): Promise<string> {
  try {
    return await readFile(runLogPath(flowName, runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Inventory.
// ──────────────────────────────────────────────────────────────────────────

export type RunSummary = FlowRunMeta & { dir: string };

/**
 * Age past which a pid-less "running" record is presumed dead. The pre-write →
 * pid-patch window in spawnDetachedRun is milliseconds long; a record still
 * pid-less after this long means the spawn failed before the patch landed.
 */
export const PIDLESS_RUNNING_GRACE_MS = 30_000;

/**
 * List all runs across all flows. When `flowName` is provided, scope to that
 * flow only. Returned newest-first by startedAt; missing/invalid meta files
 * are skipped. PID liveness check is applied: status==='running' with a dead
 * pid downgrades to 'orphaned' in the returned view (the on-disk file is
 * left as-is — callers can persist the downgrade if desired). A pid-less
 * "running" record older than PIDLESS_RUNNING_GRACE_MS is downgraded the same
 * way — it can only mean the spawn died before the pid patch was written.
 */
export async function listRuns(opts: { flowName?: string; isPidAlive?: (pid: number) => boolean; now?: number } = {}): Promise<RunSummary[]> {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const now = opts.now ?? Date.now();
  const flowsList = opts.flowName
    ? [opts.flowName]
    : await readdir(flowsRoot()).catch(() => [] as string[]);
  const out: RunSummary[] = [];
  for (const flowName of flowsList) {
    if (flowName.startsWith(".")) continue;
    // Skip files (flow definitions) — we only descend into directories that
    // host a runs/ subfolder.
    const stat = await statQuiet(join(flowsRoot(), flowName));
    if (!stat?.isDirectory()) continue;
    const runDirsRoot = flowRunsRoot(flowName);
    const runIds = await readdir(runDirsRoot).catch(() => [] as string[]);
    for (const runId of runIds) {
      const meta = await readMeta(flowName, runId).catch(() => null);
      if (!meta) continue;
      let view: FlowRunMeta = meta;
      if (view.status === "running") {
        if (typeof view.pid === "number") {
          if (!isAlive(view.pid)) view = { ...view, status: "orphaned" };
        } else {
          const age = now - Date.parse(view.startedAt);
          if (Number.isFinite(age) && age > PIDLESS_RUNNING_GRACE_MS) {
            view = { ...view, status: "orphaned" };
          }
        }
      }
      out.push({ ...view, dir: runDir(flowName, runId) });
    }
  }
  // Newest first — startedAt is ISO so lexical sort matches chronological.
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

/**
 * Find a single run by runId across all flows. Returns null if not found.
 */
export async function findRunById(runId: string): Promise<RunSummary | null> {
  const all = await listRuns();
  return all.find((r) => r.runId === runId) ?? null;
}

function normalizeMeta(value: unknown): FlowRunMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.runId !== "string" || typeof obj.flowName !== "string" || typeof obj.startedAt !== "string") {
    return null;
  }
  const status = obj.status;
  if (status !== "running" && status !== "ok" && status !== "failed" && status !== "cancelled" && status !== "orphaned") {
    return null;
  }
  const args = obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
    ? (obj.args as Record<string, unknown>)
    : {};
  const out: FlowRunMeta = {
    runId: obj.runId,
    flowName: obj.flowName,
    args,
    status,
    startedAt: obj.startedAt,
  };
  if (typeof obj.endedAt === "string") out.endedAt = obj.endedAt;
  if (typeof obj.pid === "number") out.pid = obj.pid;
  if (typeof obj.pgid === "number") out.pgid = obj.pgid;
  if (obj.cleanup === "keep" || obj.cleanup === "kill-on-end") out.cleanup = obj.cleanup;
  if (typeof obj.background === "boolean") out.background = obj.background;
  return out;
}

async function statQuiet(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
