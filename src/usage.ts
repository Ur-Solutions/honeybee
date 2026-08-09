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

/**
 * A REAL authentication failure observed against the provider (401/revoked
 * token, rejected refresh) — not a missing credential file. Recorded by the
 * limits probe and the HSR event pump so account health reflects whether the
 * credential actually authenticates, not merely whether it exists.
 */
export type AuthFailureEvent = {
  ts: string;
  kind: "auth_failed";
  account: string;
  /** Where the failure was observed: "limits-probe", a bee name, ... */
  source?: string;
  detail?: string;
};

/** Positive authentication evidence: a successful probe or a fresh capture. */
export type AuthOkEvent = {
  ts: string;
  kind: "auth_ok";
  account: string;
  source?: string;
};

export type UsageEvent = UsageSample | ExhaustionEvent | AuthFailureEvent | AuthOkEvent;

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
      if (parsed && (parsed.kind === "sample" || parsed.kind === "exhausted" || parsed.kind === "auth_failed" || parsed.kind === "auth_ok")) events.push(parsed);
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
  /**
   * True when some bee produced two consecutive growing samples after the last
   * exhaustion — actual token movement. A single post-exhaustion sample is NOT
   * recovery: sample ts is append time, and the sampler's throttle routinely
   * flushes pre-limit spend with a timestamp after the exhaustion event.
   */
  recoveredAfterExhaustion?: boolean;
  /** Last observed REAL provider auth failure (401/revoked/refresh rejected). */
  lastAuthFailureAt?: string;
  lastAuthFailureDetail?: string;
  /**
   * True when positive auth evidence (auth_ok: successful probe or fresh
   * capture) landed after the last failure. Samples deliberately do NOT
   * recover auth: the sampler's throttle can flush pre-failure spend with a
   * post-failure timestamp.
   */
  recoveredAfterAuthFailure?: boolean;
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
      summary.recoveredAfterExhaustion = false;
      if (event.resetHint) summary.lastResetHint = event.resetHint;
      continue;
    }
    if (event.kind === "auth_failed") {
      summary.lastAuthFailureAt = event.ts;
      summary.recoveredAfterAuthFailure = false;
      if (event.detail) summary.lastAuthFailureDetail = event.detail;
      continue;
    }
    if (event.kind === "auth_ok") {
      if (summary.lastAuthFailureAt) summary.recoveredAfterAuthFailure = true;
      continue;
    }
    summary.sampleCount += 1;
    summary.lastSample = event;
    const previous = lastByBee.get(event.bee);
    lastByBee.set(event.bee, event);
    const ts = Date.parse(event.ts);
    if (summary.lastExhaustedAt && previous) {
      const exhaustedTs = Date.parse(summary.lastExhaustedAt);
      const previousTs = Date.parse(previous.ts);
      if (
        Number.isFinite(exhaustedTs) && previousTs > exhaustedTs && ts > exhaustedTs &&
        (event.inputTokens > previous.inputTokens || event.outputTokens > previous.outputTokens)
      ) {
        summary.recoveredAfterExhaustion = true;
      }
    }
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
/**
 * Auth failures do not self-heal — a revoked/rejected token stays dead until
 * a re-login or successful probe records auth_ok — but a bounded cool-off
 * keeps a transient provider blip from stranding an account forever.
 */
export const AUTH_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the account's credential is currently known NOT to authenticate:
 * a real provider auth failure with no later positive auth evidence inside
 * the cool-off window. Used by `hive account list` (state column) and both
 * account pickers (auto excludes such accounts while any healthy one exists).
 */
export function isRecentlyAuthFailed(summary: UsageSummary, now = Date.now(), coolOffMs = AUTH_FAILURE_COOLDOWN_MS): boolean {
  if (!summary.lastAuthFailureAt) return false;
  const ts = Date.parse(summary.lastAuthFailureAt);
  if (!Number.isFinite(ts)) return false;
  if (summary.recoveredAfterAuthFailure) return false;
  return now - ts < coolOffMs;
}

export function isRecentlyExhausted(summary: UsageSummary, now = Date.now(), coolOffMs = DEFAULT_WINDOW_MS): boolean {
  if (!summary.lastExhaustedAt) return false;
  const ts = Date.parse(summary.lastExhaustedAt);
  if (!Number.isFinite(ts)) return false;
  if (summary.recoveredAfterExhaustion) return false;
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
