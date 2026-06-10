import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { safeName } from "./store.js";
import type { TranscriptRow } from "./transcripts.js";

// ──────────────────────────────────────────────────────────────────────────
// Usage facts. Append-only per-account JSONL under ~/.hive/usage/. Samples
// are cumulative token totals read from provider transcripts — directional,
// not an authoritative quota (subscription windows are opaque). Exhaustion
// events are provider rate-limit messages observed on a pane, verbatim.
// ──────────────────────────────────────────────────────────────────────────

export type UsageSample = {
  ts: string;
  kind: "sample";
  account: string;
  bee: string;
  agent: string;
  /** Cumulative totals for the bee's current transcript at sample time. */
  inputTokens: number;
  outputTokens: number;
};

export type ExhaustionEvent = {
  ts: string;
  kind: "exhausted";
  account: string;
  bee: string;
  agent: string;
  resetHint?: string;
};

export type UsageEvent = UsageSample | ExhaustionEvent;

export function usageDir(): string {
  return join(storeRoot(), "usage");
}

export function usagePath(accountId: string): string {
  return join(usageDir(), `${safeName(accountId)}.jsonl`);
}

export async function appendUsageEvent(event: UsageEvent): Promise<void> {
  const path = usagePath(event.account);
  await mkdir(usageDir(), { recursive: true });
  await withFileLock(`${path}.lock`, async () => {
    await writeFile(path, `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
  });
}

export async function readUsageEvents(accountId: string): Promise<UsageEvent[]> {
  let raw: string;
  try {
    raw = await readFile(usagePath(accountId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: UsageEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as UsageEvent;
      if (parsed && (parsed.kind === "sample" || parsed.kind === "exhausted")) events.push(parsed);
    } catch {
      // skip torn final line
    }
  }
  return events;
}

export async function listUsageAccounts(): Promise<string[]> {
  const files = await readdir(usageDir()).catch(() => []);
  return files.filter((file) => file.endsWith(".jsonl")).map((file) => file.replace(/\.jsonl$/, ""));
}

export type UsageSummary = {
  account: string;
  sampleCount: number;
  lastSample?: UsageSample;
  lastExhaustedAt?: string;
  lastResetHint?: string;
  /** Sum of token deltas across samples in the trailing window. */
  windowInputTokens: number;
  windowOutputTokens: number;
};

const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000; // mirror the providers' 5h windows

export async function usageSummary(accountId: string, now = Date.now(), windowMs = DEFAULT_WINDOW_MS): Promise<UsageSummary> {
  const events = await readUsageEvents(accountId);
  const summary: UsageSummary = {
    account: accountId,
    sampleCount: 0,
    windowInputTokens: 0,
    windowOutputTokens: 0,
  };

  // Window deltas accumulate per bee: samples are cumulative per transcript,
  // so the delta between consecutive samples of the same bee is the spend.
  const lastByBee = new Map<string, UsageSample>();
  for (const event of events) {
    if (event.kind === "exhausted") {
      summary.lastExhaustedAt = event.ts;
      if (event.resetHint) summary.lastResetHint = event.resetHint;
      continue;
    }
    summary.sampleCount += 1;
    summary.lastSample = event;
    const previous = lastByBee.get(event.bee);
    lastByBee.set(event.bee, event);
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || now - ts > windowMs) continue;
    const inputDelta = previous ? Math.max(0, event.inputTokens - previous.inputTokens) : event.inputTokens;
    const outputDelta = previous ? Math.max(0, event.outputTokens - previous.outputTokens) : event.outputTokens;
    summary.windowInputTokens += inputDelta;
    summary.windowOutputTokens += outputDelta;
  }
  return summary;
}

/**
 * Whether the account looks exhausted right now: an exhaustion event with no
 * later activity evidence inside the cool-off window. Factual heuristic for
 * display and the deterministic autoswap selector — never a quota judgment.
 */
export function isRecentlyExhausted(summary: UsageSummary, now = Date.now(), coolOffMs = DEFAULT_WINDOW_MS): boolean {
  if (!summary.lastExhaustedAt) return false;
  const ts = Date.parse(summary.lastExhaustedAt);
  if (!Number.isFinite(ts)) return false;
  return now - ts < coolOffMs;
}

// ──────────────────────────────────────────────────────────────────────────
// Transcript token extraction (per provider).
// ──────────────────────────────────────────────────────────────────────────

export type TokenTotals = { inputTokens: number; outputTokens: number };

export function transcriptTokenTotals(provider: string, rows: TranscriptRow[]): TokenTotals | null {
  if (provider === "claude") return claudeTokenTotals(rows);
  if (provider === "codex") return codexTokenTotals(rows);
  return null;
}

// Claude transcripts carry message.usage on every assistant row; the session
// total is the sum (cache reads counted as input).
function claudeTokenTotals(rows: TranscriptRow[]): TokenTotals | null {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const row of rows) {
    const usage = (row.message as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (!usage || typeof usage !== "object") continue;
    seen = true;
    input += numberField(usage, "input_tokens") + numberField(usage, "cache_read_input_tokens") + numberField(usage, "cache_creation_input_tokens");
    output += numberField(usage, "output_tokens");
  }
  return seen ? { inputTokens: input, outputTokens: output } : null;
}

// Codex emits cumulative token_count events; the last one wins.
function codexTokenTotals(rows: TranscriptRow[]): TokenTotals | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "token_count") continue;
    const info = payload.info as Record<string, unknown> | undefined;
    const totals = (info?.total_token_usage ?? info?.last_token_usage) as Record<string, unknown> | undefined;
    if (!totals) continue;
    return {
      inputTokens: numberField(totals, "input_tokens") + numberField(totals, "cached_input_tokens"),
      outputTokens: numberField(totals, "output_tokens"),
    };
  }
  return null;
}

function numberField(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
