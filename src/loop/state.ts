// Loop on-disk state — paths + loop.json + per-iteration artifact CRUD.
//
// Storage (mirrors the flow-run state pattern so status/logs/inspect come for
// free), rooted ONLY at storeRoot():
//   ~/.hive/loops/<loopId>/loop.json          — config + live state
//   ~/.hive/loops/<loopId>/progress.md         — rolling detailed summary
//   ~/.hive/loops/<loopId>/history.md          — rolling digest (re-derived)
//   ~/.hive/loops/<loopId>/history.log         — append-only, one line/iter
//   ~/.hive/loops/<loopId>/iter-NNN.log        — per-iteration driver log
//   ~/.hive/loops/<loopId>/seals/iter-NNN.json — the iteration's seal artifact
//   ~/.hive/loops/<loopId>/stop-request        — graceful-stop sentinel
//
// Everything is written 0o600 via atomicWriteFile (append-only logs use
// appendFile with the same mode). No console.* here — callers own printing.

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import type { SealRecord, SealStatus } from "../seal.js";

export type LoopStatus = "running" | "paused" | "stopped" | "done" | "errored" | "orphaned";
export type LoopContextMode = "persistent" | "ralph" | "rolling";
export type LoopCarrier = "same" | "fresh";
export type LoopMemory = "harness" | "none" | "rolling";

export type LoopStopConfig = {
  max: number | null;
  maxDurationMs: number | null;
  forever: boolean;
  until: string | null;
  stopOnSeal: SealStatus[];
  stopOnSentinel: string | null;
  judge: string | null;
};

export type LoopConfig = {
  loopId: string;
  bee: string;
  cwd: string;
  context: LoopContextMode;
  carrier: LoopCarrier;
  memory: LoopMemory;
  prompt: string;
  stop: LoopStopConfig;
  summarizer: "self" | "bee";
  yolo: boolean;
  status: LoopStatus;
  iteration: number;
  currentBee?: string;
  lastSealStatus?: string;
  lastStopCheck?: { condition: string; result: boolean; at: string };
  stopReason?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  pid?: number;
  pgid?: number;
};

// ──────────────────────────────────────────────────────────────────────────
// Paths.
// ──────────────────────────────────────────────────────────────────────────

export function loopsRoot(): string {
  return join(storeRoot(), "loops");
}

export function loopDir(id: string): string {
  return join(loopsRoot(), id);
}

export function loopConfigPath(id: string): string {
  return join(loopDir(id), "loop.json");
}

export function loopProgressPath(id: string): string {
  return join(loopDir(id), "progress.md");
}

export function loopHistoryMdPath(id: string): string {
  return join(loopDir(id), "history.md");
}

export function loopHistoryLogPath(id: string): string {
  return join(loopDir(id), "history.log");
}

export function loopIterLogPath(id: string, n: number): string {
  return join(loopDir(id), `iter-${padIter(n)}.log`);
}

export function loopSealPath(id: string, n: number): string {
  return join(loopDir(id), "seals", `iter-${padIter(n)}.json`);
}

export function loopStopRequestPath(id: string): string {
  return join(loopDir(id), "stop-request");
}

function padIter(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(3, "0");
}

// ──────────────────────────────────────────────────────────────────────────
// CRUD.
// ──────────────────────────────────────────────────────────────────────────

export async function ensureLoopDir(id: string): Promise<void> {
  await mkdir(join(loopDir(id), "seals"), { recursive: true });
}

export async function readLoopConfig(id: string): Promise<LoopConfig | null> {
  try {
    const raw = await readFile(loopConfigPath(id), "utf8");
    return JSON.parse(raw) as LoopConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeLoopConfig(cfg: LoopConfig): Promise<void> {
  await ensureLoopDir(cfg.loopId);
  await atomicWriteFile(loopConfigPath(cfg.loopId), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

export async function updateLoopConfig(id: string, patch: Partial<LoopConfig>): Promise<LoopConfig> {
  const current = await readLoopConfig(id);
  if (!current) throw new Error(`Unknown loop: ${id}`);
  const merged: LoopConfig = { ...current, ...patch, loopId: current.loopId, updatedAt: new Date().toISOString() };
  await writeLoopConfig(merged);
  return merged;
}

/**
 * Reconcile a loop's persisted status against driver-process liveness: a loop
 * stuck on status "running" whose driver pid is dead (SIGKILLed, crashed,
 * machine rebooted) is shown as "orphaned". The on-disk loop.json is left
 * untouched — this is a view-level downgrade mirroring flow runs (runs.ts).
 * Records with no pid yet (the pre-driver write window) are left as-is.
 */
export function reconcileLoopStatus(cfg: LoopConfig, isPidAlive: (pid: number) => boolean = defaultIsPidAlive): LoopConfig {
  if (cfg.status !== "running") return cfg;
  if (typeof cfg.pid !== "number" || cfg.pid <= 0) return cfg;
  if (isPidAlive(cfg.pid)) return cfg;
  return { ...cfg, status: "orphaned" };
}

export async function listLoops(opts: { isPidAlive?: (pid: number) => boolean } = {}): Promise<LoopConfig[]> {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const entries = await readdir(loopsRoot(), { withFileTypes: true }).catch(() => []);
  const out: LoopConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cfg = await readLoopConfig(entry.name).catch(() => null);
    if (cfg) out.push(reconcileLoopStatus(cfg, isAlive));
  }
  // Newest first — startedAt is ISO so lexical sort matches chronological.
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
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

// ──────────────────────────────────────────────────────────────────────────
// Per-iteration artifacts.
// ──────────────────────────────────────────────────────────────────────────

export async function appendIterLog(id: string, n: number, text: string): Promise<void> {
  await ensureLoopDir(id);
  const stamp = new Date().toISOString();
  await appendFile(loopIterLogPath(id, n), `[${stamp}] ${text}\n`, { mode: 0o600 });
}

export async function writeIterSeal(id: string, n: number, seal: SealRecord): Promise<void> {
  await ensureLoopDir(id);
  await atomicWriteFile(loopSealPath(id, n), `${JSON.stringify(seal, null, 2)}\n`, { mode: 0o600 });
}

// ──────────────────────────────────────────────────────────────────────────
// Graceful-stop sentinel.
// ──────────────────────────────────────────────────────────────────────────

export async function requestStop(id: string): Promise<void> {
  await ensureLoopDir(id);
  await atomicWriteFile(loopStopRequestPath(id), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export async function isStopRequested(id: string): Promise<boolean> {
  return existsSync(loopStopRequestPath(id));
}
