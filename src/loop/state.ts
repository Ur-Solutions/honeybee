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
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import type { SealRecord } from "../seal.js";
import type { LoopStopConfig } from "./stopConditions.js";
export type { LoopStopConfig } from "./stopConditions.js";

export type LoopStatus = "running" | "paused" | "stopped" | "done" | "errored" | "orphaned";
export type LoopContextMode = "persistent" | "ralph" | "rolling";
export type LoopCarrier = "same" | "fresh";
export type LoopMemory = "harness" | "none" | "rolling";

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

function loopsLockPath(): string {
  return join(loopsRoot(), ".loops.lock");
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
// Loop ids — short, bee-id-style (`LP.<hex>`) so a loop reads and targets like
// a BID (`CL.270`) instead of a raw run id. The suffix is the shortest hex
// prefix (≥3) that is unambiguous against existing loops; loops are targetable
// by the full id, the bare suffix, or any unambiguous prefix (see resolveLoopId).
// ──────────────────────────────────────────────────────────────────────────

export const LOOP_ID_PREFIX = "LP.";

async function existingLoopIds(): Promise<string[]> {
  const entries = await readdir(loopsRoot(), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Allocate and reserve a fresh short loop id: `LP.` + the shortest hex suffix
 * (≥3 chars) that neither equals nor prefixes any existing loop id. The
 * reservation is the loop directory itself, created while holding the loops
 * lock, so concurrent starters cannot receive the same id before loop.json is
 * written. `uuidFactory` is injectable for deterministic tests.
 */
export async function generateLoopId(uuidFactory: () => string = randomUUID): Promise<string> {
  return withFileLock(loopsLockPath(), async () => {
    const existing = await existingLoopIds();
    for (let attempt = 0; attempt < 100_000; attempt += 1) {
      const hex = uuidFactory().replace(/-/g, "").toLowerCase();
      if (!/^[0-9a-f]{3,}$/.test(hex)) continue;
      for (let length = 3; length <= hex.length; length += 1) {
        const id = `${LOOP_ID_PREFIX}${hex.slice(0, length)}`;
        // Reject only if the candidate equals or PREFIXES an existing id (which
        // would make it ambiguously prefix-match). A longer, more-specific id
        // alongside a shorter existing one is fine — the short one stays
        // exact-matchable. Grow the suffix until that holds.
        const clashes = existing.some((other) => other === id || other.startsWith(id));
        if (clashes) continue;
        try {
          await mkdir(loopDir(id));
          return id;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          existing.push(id);
        }
      }
    }
    throw new Error("Could not allocate a unique loop id");
  });
}

/**
 * Resolve a user-supplied loop reference to a full loop id. Accepts the full id
 * (`LP.a3f`), the bare suffix (`a3f`), or any unambiguous prefix of either —
 * and still matches legacy long-form ids exactly. Throws a clear error on an
 * unknown or ambiguous reference (and never touches the filesystem outside the
 * loops dir, so a path-traversal query simply fails to match).
 */
export async function resolveLoopId(query: string): Promise<string> {
  const q = query.trim();
  if (!q) throw new Error("Provide a loop id (LP.xxx or its suffix).");
  const ids = await existingLoopIds();
  if (ids.includes(q)) return q; // exact full id (incl. legacy long form)
  const withPrefix = `${LOOP_ID_PREFIX}${q}`;
  if (ids.includes(withPrefix)) return withPrefix; // bare suffix → LP.<suffix>
  const suffixOf = (id: string) => (id.startsWith(LOOP_ID_PREFIX) ? id.slice(LOOP_ID_PREFIX.length) : id);
  const matches = ids.filter((id) => id.startsWith(q) || suffixOf(id).startsWith(q));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous loop ref "${query}": ${matches.join(", ")}`);
  throw new Error(`Unknown loop: ${query}`);
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
 * Age past which a pid-less "running" loop is presumed dead. The pre-write →
 * pid-patch window in HiveFacade.loop/loopFlow is milliseconds long; a record
 * still pid-less after this long means the driver died before the patch landed.
 */
export const PIDLESS_RUNNING_GRACE_MS = 30_000;

/**
 * Reconcile a loop's persisted status against driver-process liveness: a loop
 * stuck on status "running" whose driver pid is dead (SIGKILLed, crashed,
 * machine rebooted) is shown as "orphaned". The on-disk loop.json is left
 * untouched — this is a view-level downgrade mirroring flow runs (runs.ts).
 * A pid-less "running" loop older than PIDLESS_RUNNING_GRACE_MS is downgraded
 * the same way; it can only mean the driver died before writing its pid.
 */
export function reconcileLoopStatus(
  cfg: LoopConfig,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
  now: number = Date.now(),
): LoopConfig {
  if (cfg.status !== "running") return cfg;
  if (typeof cfg.pid === "number" && cfg.pid > 0) {
    if (isPidAlive(cfg.pid)) return cfg;
    return { ...cfg, status: "orphaned" };
  }

  const age = now - Date.parse(cfg.startedAt);
  if (Number.isFinite(age) && age > PIDLESS_RUNNING_GRACE_MS) {
    return { ...cfg, status: "orphaned" };
  }
  return cfg;
}

export async function listLoops(opts: { isPidAlive?: (pid: number) => boolean; now?: number } = {}): Promise<LoopConfig[]> {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const now = opts.now ?? Date.now();
  const entries = await readdir(loopsRoot(), { withFileTypes: true }).catch(() => []);
  const out: LoopConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cfg = await readLoopConfig(entry.name).catch(() => null);
    if (cfg) out.push(reconcileLoopStatus(cfg, isAlive, now));
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
