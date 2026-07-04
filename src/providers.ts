// ──────────────────────────────────────────────────────────────────────────
// Provider adapters. Keyed by provider id (the "who/which quota"), distinct
// from the CLI driver (the "how to launch"). An account is a (cli, provider)
// pair; this registry is the provider half.
//
// S1 SCAFFOLD ONLY. The adapter shape carries OPTIONAL fetchLimits/isExhausted/
// login slots so S3 can move the `account.tool` switch out of limits.ts into
// here without a new-file churn — but none of them are implemented and there
// are NO production callers in S1. Only providerAdapter()/hasProviderAdapter()
// are exercised (by tests).
//
// Heavy types are imported as TYPES ONLY to keep this a leaf module — the
// optional fn signatures must not pull accounts.ts / limits.ts / drivers.ts
// into a runtime import cycle.
// ──────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountDir } from "./accounts.js";
import { storeRoot } from "./fsx.js";
import type { AccountRecord } from "./accounts.js";
import type { AccountLimits, LimitsDeps, WindowUsage } from "./limits.js";
import type { ExhaustionHit } from "./drivers.js";

export type ProviderId =
  | "anthropic"
  | "openai"
  | "xai"
  | "moonshot"
  | "cursor"
  | "minimax-coding-plan"
  | "zai-coding-plan"
  | "kimi-for-coding";

export type ProviderAdapter = {
  id: ProviderId;
  baseURL?: string;
  defaultModel?: string;
  models?: () => Promise<string[]> | string[];
  // ── S3 wires these in; UNIMPLEMENTED in S1 (typed scaffold only) ──────────
  /** Fetch the provider's real 5h/weekly quota windows for an account. */
  fetchLimits?: (account: AccountRecord, deps?: LimitsDeps) => Promise<AccountLimits>;
  /** Optional pane-level exhaustion signal at provider granularity. */
  isExhausted?: (pane: string) => ExhaustionHit | null;
  /** Provider-specific login flow into an account's isolated home. */
  login?: (account: AccountRecord, homePath: string) => Promise<void>;
};

// All 7 provider ids. `moonshot` is the kimi-code single-provider CLI account;
// `kimi-for-coding` is the opencode-hosted Kimi provider — distinct accounts,
// both registered.
const PROVIDERS: Record<string, ProviderAdapter> = {
  anthropic: { id: "anthropic", baseURL: "https://api.anthropic.com" },
  openai: { id: "openai" },
  xai: { id: "xai" },
  moonshot: { id: "moonshot" },
  // Anysphere's subscription behind the cursor CLI. No documented quota
  // endpoint → fetchLimits stays undefined → limits degrade to `unsupported`.
  cursor: { id: "cursor", baseURL: "https://api2.cursor.sh" },
  "minimax-coding-plan": { id: "minimax-coding-plan", fetchLimits: minimaxLimits },
  "zai-coding-plan": { id: "zai-coding-plan", fetchLimits: zaiLimits },
  // kimi-for-coding / moonshot have no documented quota endpoint → fetchLimits
  // stays undefined → the dispatch degrades to `unsupported` (graceful).
  "kimi-for-coding": { id: "kimi-for-coding" },
};

/** The adapter for a provider id, or undefined for an unknown/absent id. */
export function providerAdapter(id: string | undefined): ProviderAdapter | undefined {
  return id ? PROVIDERS[id] : undefined;
}

/** True when a provider id has a registered adapter. */
export function hasProviderAdapter(id: string | undefined): boolean {
  return id ? id in PROVIDERS : false;
}

// ──────────────────────────────────────────────────────────────────────────
// Provider quota fetchers (S3). Self-contained here so providers.ts imports
// NOTHING from limits.ts at runtime (AccountLimits/WindowUsage/LimitsDeps are
// type-only imports). Each fetcher:
//   1. locates the account's opencode auth token (xdg-data/opencode/auth.json,
//      keyed by provider id) across the vault + the account's dedicated homes;
//   2. GETs the provider endpoint via deps.httpGetJson (injectable; tests mock
//      it — NO real network in tests; production passes the global-fetch impl);
//   3. parses the REAL response shape into fiveHour/weekly WindowUsage.
// Live network validation is GATED ON S4 (the user's provider re-logins); the
// token location may need adjustment once each opencode provider is re-logged
// into its isolated store.
// ──────────────────────────────────────────────────────────────────────────

type OpencodeAuthEntry = { type?: string; key?: string; access?: string; token?: string };

/**
 * Read the opencode auth token for an account's provider. opencode keeps a
 * single auth.json under $XDG_DATA_HOME/opencode/ keyed by provider id; the
 * vault mirrors it at <accountDir>/xdg-data/opencode/auth.json and each
 * dedicated home carries its own under <home>/xdg-data/opencode/auth.json.
 * Returns the first token found (vault first, then homes), or null.
 */
async function opencodeProviderToken(account: AccountRecord): Promise<string | null> {
  const rel = join("xdg-data", "opencode", "auth.json");
  const candidates = [
    join(accountDir(account), rel),
    join(storeRoot(), "homes", account.id, rel),
    join(storeRoot(), "login-homes", account.id, rel),
  ];
  for (const path of candidates) {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) continue;
    let parsed: Record<string, OpencodeAuthEntry>;
    try {
      parsed = JSON.parse(raw) as Record<string, OpencodeAuthEntry>;
    } catch {
      continue;
    }
    const entry = account.provider ? parsed[account.provider] : undefined;
    const token = entry?.key ?? entry?.access ?? entry?.token;
    if (typeof token === "string" && token.length > 0) return token;
  }
  return null;
}

const defaultHttpGetJson: NonNullable<LimitsDeps["httpGetJson"]> = async (url, headers) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
};

function unsupported(account: AccountRecord, source: AccountLimits["source"], error: string): AccountLimits {
  return { account: account.id, tool: account.tool, ok: false, source, error };
}

/* ------------------------------------------------------------------ */
/* z.ai (zai-coding-plan) — GET monitor/usage/quota/limit              */
/* ------------------------------------------------------------------ */

type ZaiLimitWindow = {
  type?: string;
  percentage?: number;
  nextResetTime?: number;
};
type ZaiResponse = { data?: { limits?: ZaiLimitWindow[]; level?: string } };

async function zaiLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const token = await opencodeProviderToken(account);
  if (!token) {
    return unsupported(account, "unsupported", "no zai-coding-plan token in opencode auth.json (vault or account home)");
  }
  const get = deps.httpGetJson ?? defaultHttpGetJson;
  const body = (await get("https://api.z.ai/api/monitor/usage/quota/limit", {
    Authorization: `Bearer ${token}`,
  })) as ZaiResponse;
  const limits = body?.data?.limits ?? [];
  // Verified against live data (2026-06-17): TOKENS_LIMIT is the rolling TOKEN
  // cycle — the coding-capacity gate — and is the window that matters; map it
  // to fiveHour. TIME_LIMIT is a SEPARATE MCP web-tools budget (its
  // usageDetails list search-prime/web-reader/zread) on a longer reset; it is
  // NOT a token-weekly quota, so we do not surface it as `weekly` — doing so
  // would mislabel tool-call usage as token usage. `percentage` is USED percent
  // (0-100); nextResetTime is epoch MS.
  const tokens = limits.find((w) => w.type === "TOKENS_LIMIT");
  const result: AccountLimits = {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "oauth-api",
    ...(body?.data?.level ? { plan: body.data.level } : {}),
  };
  if (tokens) result.fiveHour = zaiWindow(tokens, 300);
  if (!result.fiveHour && !result.weekly) {
    result.ok = false;
    result.error = "usage endpoint returned no windows";
  }
  return result;
}

function zaiWindow(window: ZaiLimitWindow, windowMinutes: number): WindowUsage {
  return {
    usedPercent: typeof window.percentage === "number" ? window.percentage : 0,
    windowMinutes,
    ...(typeof window.nextResetTime === "number" ? { resetsAt: new Date(window.nextResetTime).toISOString() } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* minimax (minimax-coding-plan) — GET v1/token_plan/remains           */
/* ------------------------------------------------------------------ */

type MinimaxModelRemains = {
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remaining_percent?: number;
  end_time?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  weekly_end_time?: number;
};
type MinimaxResponse = { model_remains?: MinimaxModelRemains[] };

async function minimaxLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const token = await opencodeProviderToken(account);
  if (!token) {
    return unsupported(account, "unsupported", "no minimax-coding-plan token in opencode auth.json (vault or account home)");
  }
  const get = deps.httpGetJson ?? defaultHttpGetJson;
  // The .io host accepts the coding-plan key (.com rejects it).
  const body = (await get("https://api.minimax.io/v1/token_plan/remains", {
    Authorization: `Bearer ${token}`,
  })) as MinimaxResponse;
  const plan = body?.model_remains?.[0];
  if (!plan) {
    return { account: account.id, tool: account.tool, ok: false, source: "oauth-api", error: "token_plan/remains returned no model_remains" };
  }
  const result: AccountLimits = { account: account.id, tool: account.tool, ok: true, source: "oauth-api" };
  // current_interval_* is the 5-hour window; current_weekly_* the weekly one.
  // Percentages here are REMAINING — derive USED% from usage/total (preferred)
  // and fall back to inverting remaining_percent.
  result.fiveHour = minimaxWindow(
    plan.current_interval_usage_count,
    plan.current_interval_total_count,
    plan.current_interval_remaining_percent,
    plan.end_time,
    300,
  );
  result.weekly = minimaxWindow(
    plan.current_weekly_usage_count,
    plan.current_weekly_total_count,
    undefined,
    plan.weekly_end_time,
    10_080,
  );
  return result;
}

function minimaxWindow(
  usage: number | undefined,
  total: number | undefined,
  remainingPercent: number | undefined,
  endTime: number | undefined,
  windowMinutes: number,
): WindowUsage {
  let usedPercent = 0;
  if (typeof total === "number" && total > 0 && typeof usage === "number") {
    usedPercent = Math.min(100, Math.max(0, (usage / total) * 100));
  } else if (typeof remainingPercent === "number") {
    // remaining_percent may arrive as a fraction (0-1) or a percent (0-100).
    const remaining = remainingPercent <= 1 ? remainingPercent * 100 : remainingPercent;
    usedPercent = Math.min(100, Math.max(0, 100 - remaining));
  }
  return {
    usedPercent,
    windowMinutes,
    ...(typeof endTime === "number" ? { resetsAt: new Date(endTime).toISOString() } : {}),
  };
}
