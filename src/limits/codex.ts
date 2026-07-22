// ──────────────────────────────────────────────────────────────────────────
// codex — rate limits, live then from disk.
//
// Live via `codex app-server`'s account/rateLimits/read RPC (run against the
// account's home). When the binary or RPC is unavailable we fall back to the
// newest rate_limits snapshot codex wrote into its session rollouts — only as
// fresh as the account's last local activity, stamped asOf.
// ──────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type AccountRecord, codexHomesForAccount } from "../accounts.js";
import { withCodexHomeBootLock } from "../codexBoot.js";
import { launchEnv } from "../env.js";
import type { AccountLimits, CodexLiveRateLimits, CodexLiveWindow, LimitsDeps, WindowUsage } from "./types.js";

type CodexRateLimits = {
  primary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
  secondary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
  plan_type?: string | null;
};

type CodexWindowSlot = "fiveHour" | "weekly";

const CODEX_FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export async function codexLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const homes = await codexHomesForAccount(account);
  if (homes.length === 0) {
    return { account: account.id, tool: account.tool, ok: false, source: "session-snapshot", error: "no home found with this account's auth.json" };
  }

  // Live first: the app-server RPC answers with the server's current window
  // state. Try each matched home until one authenticates.
  const live = deps.codexLiveRateLimits ?? fetchCodexLiveRateLimits;
  for (const home of homes) {
    const limits = await live(home).catch(() => null);
    if (!limits) continue;
    const result: AccountLimits = {
      account: account.id,
      tool: account.tool,
      ok: true,
      source: "app-server",
      ...(limits.planType ? { plan: limits.planType } : {}),
    };
    assignCodexWindows(
      result,
      limits.primary,
      limits.secondary,
      (window) => window.windowDurationMins,
      liveWindow,
    );
    if (result.fiveHour || result.weekly) return result;
  }

  let best: { limits: CodexRateLimits; ts: string } | null = null;
  for (const home of homes) {
    const snapshot = await newestRateLimitSnapshot(join(home, "sessions"));
    if (snapshot && (!best || snapshot.ts > best.ts)) best = snapshot;
  }
  if (!best) {
    return { account: account.id, tool: account.tool, ok: false, source: "session-snapshot", error: "no rate-limit snapshot on disk yet (run codex on this account once)" };
  }

  const result: AccountLimits = {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "session-snapshot",
    asOf: best.ts,
    ...(best.limits.plan_type ? { plan: best.limits.plan_type } : {}),
  };
  assignCodexWindows(
    result,
    best.limits.primary,
    best.limits.secondary,
    (window) => window.window_minutes,
    snapshotWindow,
  );
  return result;
}

/**
 * Codex normally calls the 5h window `primary` and the weekly window
 * `secondary`, but it promotes the weekly window to `primary` when the 5h
 * limit is disabled. Prefer the explicit duration so that temporary provider
 * changes do not shift a weekly value into the 5h column. Positional fallback
 * keeps older snapshots/responses without duration metadata compatible.
 */
function assignCodexWindows<T>(
  result: AccountLimits,
  primary: T | null | undefined,
  secondary: T | null | undefined,
  windowMinutes: (window: T) => number | undefined,
  toUsage: (window: T) => WindowUsage | null,
): void {
  const candidates: Array<{ usage: WindowUsage; duration: number | undefined; fallback: CodexWindowSlot }> = [];
  const add = (window: T | null | undefined, fallback: CodexWindowSlot) => {
    if (!window) return;
    const usage = toUsage(window);
    if (usage) candidates.push({ usage, duration: windowMinutes(window), fallback });
  };
  add(primary, "fiveHour");
  add(secondary, "weekly");

  // Duration-classified windows win over positional guesses.
  for (const candidate of candidates) {
    const slot = codexWindowSlot(candidate.duration);
    if (slot && !result[slot]) result[slot] = candidate.usage;
  }

  for (const candidate of candidates) {
    if (codexWindowSlot(candidate.duration)) continue;
    const alternate: CodexWindowSlot = candidate.fallback === "fiveHour" ? "weekly" : "fiveHour";
    const slot = !result[candidate.fallback] ? candidate.fallback : !result[alternate] ? alternate : null;
    if (slot) result[slot] = candidate.usage;
  }
}

function codexWindowSlot(windowMinutes: number | undefined): CodexWindowSlot | null {
  if (windowMinutes === CODEX_FIVE_HOUR_WINDOW_MINUTES) return "fiveHour";
  if (windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES) return "weekly";
  return null;
}

function liveWindow(window: CodexLiveWindow): WindowUsage {
  return {
    usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : 0,
    ...(window.resetsAt ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() } : {}),
    ...(typeof window.windowDurationMins === "number" ? { windowMinutes: window.windowDurationMins } : {}),
  };
}

function snapshotWindow(window: NonNullable<CodexRateLimits["primary"]>): WindowUsage | null {
  if (typeof window.used_percent !== "number") return null;
  return {
    usedPercent: window.used_percent,
    ...(window.resets_at ? { resetsAt: new Date(window.resets_at * 1000).toISOString() } : {}),
    ...(typeof window.window_minutes === "number" ? { windowMinutes: window.window_minutes } : {}),
  };
}

const CODEX_RPC_TIMEOUT_MS = 15_000;
const CODEX_LIMITS_BOOT_LOCK_TIMEOUT_MS = 3_000;

/**
 * Query `codex app-server` (JSON-RPC over stdio) for the account's live rate
 * limits, with CODEX_HOME pointed at the account's home. Returns null on any
 * failure — missing binary, stale auth, protocol drift — so callers fall back
 * to the on-disk snapshot.
 */
async function fetchCodexLiveRateLimits(homePath: string): Promise<CodexLiveRateLimits | null> {
  return withCodexHomeBootLock(homePath, () => new Promise<CodexLiveRateLimits | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: launchEnv({ CODEX_HOME: homePath }),
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: CodexLiveRateLimits | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), CODEX_RPC_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: { id?: number; result?: Record<string, unknown>; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(null);
            return;
          }
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })}\n`);
        }
        if (message.id === 2) {
          const rateLimits = message.result?.rateLimits as CodexLiveRateLimits | undefined;
          finish(rateLimits && (rateLimits.primary || rateLimits.secondary) ? rateLimits : null);
          return;
        }
      }
    });

    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "hive", title: "hive", version: "0.0.1" } } })}\n`,
    );
  }), { timeoutMs: CODEX_LIMITS_BOOT_LOCK_TIMEOUT_MS }).catch(() => null);
}

// How many recent rollout files to inspect — a fresh session may not have
// emitted token_count yet, so look back a few files.
const MAX_ROLLOUT_CANDIDATES = 5;
// Codex partitions sessions/ by date (YYYY/MM/DD). Walk partitions
// newest-first and stop once enough recent file-bearing partitions have been
// scanned: a full depth-5 sweep stats every rollout ever written, which is
// thousands of files on a busy machine (HIVE-64). Two partitions cover "today
// plus the previous active day", so a still-running session that started
// yesterday is not missed.
const MIN_ROLLOUT_LEAF_DIRS = 2;
// Directory-visit budget: bounds the walk even when the newest partitions are
// sparse or empty (or the tree is not date-shaped).
const MAX_ROLLOUT_DIR_VISITS = 64;

/** Newest rate_limits event across the most recent rollout files. */
async function newestRateLimitSnapshot(sessionsDir: string): Promise<{ limits: CodexRateLimits; ts: string } | null> {
  for (const file of await newestRolloutFiles(sessionsDir)) {
    const snapshot = await lastRateLimitsInFile(file);
    if (snapshot) return snapshot;
  }
  return null;
}

/**
 * The newest rollout files, walking date partitions newest-first (descending
 * directory-name order = descending date) and stopping once enough recent
 * partitions have been scanned instead of statting the whole tree.
 */
async function newestRolloutFiles(sessionsDir: string): Promise<string[]> {
  const files: { path: string; mtimeMs: number }[] = [];
  let leafDirs = 0;
  let dirVisits = 0;
  const done = () => leafDirs >= MIN_ROLLOUT_LEAF_DIRS && files.length >= MAX_ROLLOUT_CANDIDATES;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5 || dirVisits >= MAX_ROLLOUT_DIR_VISITS || done()) return;
    dirVisits += 1;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    let sawFile = false;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      files.push({ path, mtimeMs: info.mtimeMs });
      sawFile = true;
    }
    if (sawFile) leafDirs += 1;
    const subdirs = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const sub of subdirs) await visit(join(dir, sub.name), depth + 1);
  };
  await visit(sessionsDir, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_ROLLOUT_CANDIDATES).map((file) => file.path);
}

// Rollout files grow to many MB over a long session; rate_limits rides the
// per-turn token_count events, so the latest one sits near the end. Read only
// the tail instead of slurping the whole file (HIVE-64).
const ROLLOUT_TAIL_BYTES = 256 * 1024;

export async function lastRateLimitsInFile(path: string): Promise<{ limits: CodexRateLimits; ts: string } | null> {
  const raw = await readFileTail(path, ROLLOUT_TAIL_BYTES);
  if (!raw) return null;
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    try {
      const row = JSON.parse(line) as { timestamp?: string; payload?: { rate_limits?: CodexRateLimits } };
      const limits = row.payload?.rate_limits;
      if (limits && (limits.primary || limits.secondary)) {
        return { limits, ts: row.timestamp ?? new Date((await stat(path)).mtimeMs).toISOString() };
      }
    } catch {
      // torn line — keep scanning
    }
  }
  return null;
}

/** The file's last maxBytes as utf8, minus the leading torn line; null on any error. */
async function readFileTail(path: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(path);
    if (info.size <= maxBytes) return await readFile(path, "utf8");
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, info.size - maxBytes);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = text.indexOf("\n");
      return newline >= 0 ? text.slice(newline + 1) : text;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
