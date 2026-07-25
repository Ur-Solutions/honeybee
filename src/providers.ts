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

import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { accountDir, withAccountLock } from "./accounts.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";
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
  // None of xai/cursor/moonshot DOCUMENT a quota endpoint, but each CLI's own
  // usage surface calls one; the fetchers below speak those private endpoints
  // (shapes verified live 2026-07-08) and degrade gracefully when they drift.
  xai: { id: "xai", fetchLimits: grokLimits },
  moonshot: { id: "moonshot", fetchLimits: kimiCodeLimits },
  cursor: { id: "cursor", baseURL: "https://api2.cursor.sh", fetchLimits: cursorLimits },
  "minimax-coding-plan": { id: "minimax-coding-plan", fetchLimits: minimaxLimits },
  "zai-coding-plan": { id: "zai-coding-plan", fetchLimits: zaiLimits },
  // The opencode-hosted Kimi provider bills the same kimi.com quota; its
  // opencode key works on the same usages endpoint as the kimi-code CLI JWT.
  "kimi-for-coding": { id: "kimi-for-coding", fetchLimits: kimiForCodingLimits },
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

const defaultHttpPostJson: NonNullable<LimitsDeps["httpPostJson"]> = async (url, headers, body) => {
  const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
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

/* ------------------------------------------------------------------ */
/* Shared: per-CLI credential locations (vault mirror + account homes) */
/* ------------------------------------------------------------------ */

/** The vault-first candidate paths for a CLI-relative credential file. */
function credentialCandidates(account: AccountRecord, relPath: string): string[] {
  return [
    join(accountDir(account), relPath),
    join(storeRoot(), "homes", account.id, relPath),
    join(storeRoot(), "login-homes", account.id, relPath),
  ];
}

function decodeJwtExpMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* xai (grok CLI) — GET cli-chat-proxy.grok.com/v1/billing             */
/* ------------------------------------------------------------------ */

type GrokBillingResponse = {
  config?: {
    monthlyLimit?: { val?: number };
    used?: { val?: number };
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
  };
};

/**
 * The freshest grok OAuth key across the vault + the account's homes. The
 * CLI's auth.json is keyed by "<issuer>::<client-id>"; each entry carries
 * key/expires_at (the grok CLI rotates the ~6h token as it runs and the
 * credential sync mirrors it into the vault).
 */
async function grokCliToken(account: AccountRecord): Promise<{ token: string; expiresMs: number } | null> {
  let best: { token: string; expiresMs: number } | null = null;
  for (const path of credentialCandidates(account, "auth.json")) {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) continue;
    let parsed: Record<string, { key?: unknown; expires_at?: unknown }>;
    try {
      parsed = JSON.parse(raw) as Record<string, { key?: unknown; expires_at?: unknown }>;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const entry of Object.values(parsed)) {
      if (!entry || typeof entry !== "object" || typeof entry.key !== "string" || entry.key.length === 0) continue;
      const expiresParsed = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : Number.NaN;
      const expiresMs = Number.isFinite(expiresParsed) ? expiresParsed : Number.POSITIVE_INFINITY;
      if (!best || expiresMs > best.expiresMs) best = { token: entry.key, expiresMs };
    }
  }
  return best;
}

async function grokLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const auth = await grokCliToken(account);
  if (!auth) return unsupported(account, "unsupported", "no grok auth.json (vault or account home)");
  const now = deps.now?.() ?? Date.now();
  if (auth.expiresMs <= now) {
    return unsupported(
      account,
      "oauth-api",
      `grok OAuth token expired at ${new Date(auth.expiresMs).toISOString()} — re-login with: hive login ${account.id}`,
    );
  }
  const get = deps.httpGetJson ?? defaultHttpGetJson;
  // The endpoint the grok CLI's own billing extension (billing.rs) calls with
  // this same bearer. Grok's quota is a MONTHLY credit budget (verified live
  // 2026-07-08: used/monthlyLimit against a calendar-month period); it lands
  // in the `weekly` slot — the table's coarse-window column — with the REAL
  // windowMinutes/resetsAt so the pace math stays honest.
  const body = (await get("https://cli-chat-proxy.grok.com/v1/billing", {
    Authorization: `Bearer ${auth.token}`,
  })) as GrokBillingResponse;
  const config = body?.config;
  // proto3-JSON omits zero-valued fields: an untouched account has no `used`.
  const limit = config?.monthlyLimit?.val;
  const used = config?.used?.val ?? 0;
  if (typeof limit !== "number" || limit <= 0) {
    return { account: account.id, tool: account.tool, ok: false, source: "oauth-api", error: "billing returned no monthly limit" };
  }
  const startMs = config?.billingPeriodStart ? Date.parse(config.billingPeriodStart) : Number.NaN;
  const endMs = config?.billingPeriodEnd ? Date.parse(config.billingPeriodEnd) : Number.NaN;
  return {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "oauth-api",
    weekly: {
      usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
      ...(Number.isFinite(endMs) ? { resetsAt: new Date(endMs).toISOString() } : {}),
      ...(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
        ? { windowMinutes: Math.round((endMs - startMs) / 60_000) }
        : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* cursor — POST api2.cursor.sh aiserver.v1.DashboardService (Connect) */
/* ------------------------------------------------------------------ */

type CursorPeriodUsage = {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  planUsage?: { totalPercentUsed?: number };
};
type CursorPlanInfo = { planInfo?: { planName?: string } };

/**
 * The account's cursor bearer: an apiKey when vaulted (never expires), else
 * the OAuth accessToken judged by its JWT exp. Vault first, then homes —
 * activation/sync keep the vault copy the freshest attributed one.
 */
async function cursorCliToken(account: AccountRecord): Promise<{ token: string; expiresMs: number } | null> {
  let best: { token: string; expiresMs: number } | null = null;
  for (const path of credentialCandidates(account, "auth.json")) {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) continue;
    let parsed: { accessToken?: unknown; apiKey?: unknown };
    try {
      parsed = JSON.parse(raw) as { accessToken?: unknown; apiKey?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed?.apiKey === "string" && parsed.apiKey.length > 0) {
      return { token: parsed.apiKey, expiresMs: Number.POSITIVE_INFINITY };
    }
    if (typeof parsed?.accessToken === "string" && parsed.accessToken.length > 0) {
      const expiresMs = decodeJwtExpMs(parsed.accessToken) ?? Number.POSITIVE_INFINITY;
      if (!best || expiresMs > best.expiresMs) best = { token: parsed.accessToken, expiresMs };
    }
  }
  return best;
}

async function cursorLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const auth = await cursorCliToken(account);
  if (!auth) return unsupported(account, "unsupported", "no cursor auth.json (vault or account home)");
  const now = deps.now?.() ?? Date.now();
  if (auth.expiresMs <= now) {
    return unsupported(
      account,
      "oauth-api",
      `cursor OAuth token expired at ${new Date(auth.expiresMs).toISOString()} — re-login with: hive login ${account.id}`,
    );
  }
  const post = deps.httpPostJson ?? defaultHttpPostJson;
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
  // The dashboard RPC behind cursor.com's own usage page (verified live
  // 2026-07-08). totalPercentUsed is cursor's headline "% of included usage";
  // billingCycle* are unix-ms STRINGS. The plan's cycle is monthly — like
  // grok it rides the coarse-window `weekly` slot with real windowMinutes.
  const usage = (await post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", headers, "{}")) as CursorPeriodUsage;
  const percent = usage?.planUsage?.totalPercentUsed;
  if (typeof percent !== "number") {
    return { account: account.id, tool: account.tool, ok: false, source: "oauth-api", error: "GetCurrentPeriodUsage returned no planUsage" };
  }
  const startMs = Number(usage?.billingCycleStart);
  const endMs = Number(usage?.billingCycleEnd);
  const result: AccountLimits = {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "oauth-api",
    weekly: {
      usedPercent: Math.min(100, Math.max(0, percent)),
      ...(Number.isFinite(endMs) && endMs > 0 ? { resetsAt: new Date(endMs).toISOString() } : {}),
      ...(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
        ? { windowMinutes: Math.round((endMs - startMs) / 60_000) }
        : {}),
    },
  };
  // Plan name is garnish — never fail the usage read over it.
  const plan = (await post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo", headers, "{}").catch(() => null)) as CursorPlanInfo | null;
  const planName = plan?.planInfo?.planName;
  if (typeof planName === "string" && planName.length > 0) result.plan = planName.toLowerCase();
  return result;
}

/* ------------------------------------------------------------------ */
/* moonshot (kimi-code CLI) + kimi-for-coding — GET coding/v1/usages   */
/* ------------------------------------------------------------------ */

const KIMI_CODE_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_AUTH_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
/** The kimi-code CLI's public OAuth client id (device flow). */
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_TOKEN_SKEW_MS = 60_000;
const KIMI_CREDENTIALS_REL = join("credentials", "kimi-code.json");

type KimiCredentials = {
  access_token?: string;
  refresh_token?: string;
  /** Epoch SECONDS. */
  expires_at?: number;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

async function readKimiCredentials(path: string): Promise<KimiCredentials | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as KimiCredentials;
    if (!parsed || typeof parsed !== "object") return null;
    const hasAccess = typeof parsed.access_token === "string" && parsed.access_token.length > 0;
    const hasRefresh = typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0;
    return hasAccess || hasRefresh ? parsed : null;
  } catch {
    return null;
  }
}

async function freshestKimiCredentials(account: AccountRecord): Promise<KimiCredentials | null> {
  let best: KimiCredentials | null = null;
  for (const path of credentialCandidates(account, KIMI_CREDENTIALS_REL)) {
    const creds = await readKimiCredentials(path);
    if (creds && (!best || (creds.expires_at ?? 0) > (best.expires_at ?? 0))) best = creds;
  }
  return best;
}

/** Persist a refreshed credential set to the vault + every existing home copy. */
async function persistKimiCredentials(account: AccountRecord, creds: KimiCredentials): Promise<void> {
  const payload = `${JSON.stringify(creds, null, 2)}\n`;
  const [vaultPath, ...homePaths] = credentialCandidates(account, KIMI_CREDENTIALS_REL);
  await mkdir(dirname(vaultPath!), { recursive: true, mode: 0o700 });
  await atomicWriteFile(vaultPath!, payload, { mode: 0o600 });
  for (const path of homePaths) {
    if ((await stat(path).catch(() => null))?.isFile()) await atomicWriteFile(path, payload, { mode: 0o600 });
  }
}

/**
 * A currently-valid kimi-code access token, refreshing when needed. kimi-code
 * access tokens live 15 MINUTES and the refresh token ROTATES on use, so the
 * refresh runs under the account lock with a double-check (the CLI or a
 * concurrent sweep may have refreshed first) and the rotated pair is written
 * back everywhere a copy lives — a stale refresh token strands the CLI's
 * session at its next refresh.
 */
async function kimiAccessToken(account: AccountRecord, deps: LimitsDeps = {}): Promise<{ token: string } | { error: string; missing?: boolean }> {
  const creds = await freshestKimiCredentials(account);
  if (!creds) return { error: "no kimi-code credentials (vault or account home)", missing: true };
  const now = deps.now?.() ?? Date.now();
  if (creds.access_token && (creds.expires_at ?? 0) * 1000 > now + KIMI_TOKEN_SKEW_MS) return { token: creds.access_token };
  if (!creds.refresh_token) {
    return { error: `kimi-code access token expired with no refresh token — re-login with: hive login ${account.id}` };
  }
  return withAccountLock(account.id, async () => {
    const again = (await freshestKimiCredentials(account)) ?? creds;
    const lockedNow = deps.now?.() ?? Date.now();
    if (again.access_token && (again.expires_at ?? 0) * 1000 > lockedNow + KIMI_TOKEN_SKEW_MS) return { token: again.access_token };
    const post = deps.httpPostJson ?? defaultHttpPostJson;
    let refreshed: KimiCredentials;
    try {
      refreshed = (await post(
        KIMI_AUTH_TOKEN_URL,
        { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: again.refresh_token ?? creds.refresh_token!,
          client_id: KIMI_CODE_CLIENT_ID,
        }).toString(),
      )) as KimiCredentials;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `kimi-code token refresh failed (${message}) — re-login with: hive login ${account.id}` };
    }
    if (typeof refreshed?.access_token !== "string" || refreshed.access_token.length === 0) {
      return { error: "kimi-code token refresh returned no access_token" };
    }
    const merged: KimiCredentials = {
      ...again,
      ...refreshed,
      expires_at:
        typeof refreshed.expires_at === "number"
          ? refreshed.expires_at
          : Math.floor(lockedNow / 1000) + (typeof refreshed.expires_in === "number" ? refreshed.expires_in : 900),
    };
    await persistKimiCredentials(account, merged);
    return { token: merged.access_token! };
  });
}

type KimiUsageDetail = {
  limit?: string | number;
  remaining?: string | number;
  used?: string | number;
  resetTime?: string;
  reset_time?: string;
  resetAt?: string;
  reset_at?: string;
};
type KimiUsagesResponse = {
  usage?: KimiUsageDetail;
  limits?: Array<{ window?: { duration?: number; timeUnit?: string }; detail?: KimiUsageDetail } | null> | null;
  user?: { membership?: { level?: string } };
};

/** Numbers arrive as JSON strings ("100") in the kimi usages payload. */
function kimiNumber(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Field spellings drift across kimi-code versions; accept every known reset key. */
function kimiResetIso(detail: KimiUsageDetail): string | undefined {
  for (const value of [detail.resetTime, detail.reset_time, detail.resetAt, detail.reset_at]) {
    if (typeof value !== "string") continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

function kimiWindow(detail: KimiUsageDetail, windowMinutes: number | undefined): WindowUsage | null {
  const limit = kimiNumber(detail.limit);
  if (limit === undefined || limit <= 0) return null;
  const used = kimiNumber(detail.used);
  const remaining = kimiNumber(detail.remaining);
  const usedCount = used ?? (remaining !== undefined ? limit - remaining : undefined);
  if (usedCount === undefined) return null;
  const reset = kimiResetIso(detail);
  return {
    usedPercent: Math.min(100, Math.max(0, (usedCount / limit) * 100)),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(reset ? { resetsAt: reset } : {}),
  };
}

/** Window length in minutes from kimi's {duration, timeUnit} (TIME_UNIT_MINUTE etc.). */
function kimiWindowMinutes(window: { duration?: number; timeUnit?: string } | undefined): number | undefined {
  if (!window || typeof window.duration !== "number" || window.duration <= 0) return undefined;
  const unit = window.timeUnit ?? "";
  if (unit.endsWith("MINUTE")) return window.duration;
  if (unit.endsWith("HOUR")) return window.duration * 60;
  if (unit.endsWith("DAY")) return window.duration * 1440;
  return undefined;
}

function kimiUsagesToLimits(account: AccountRecord, body: KimiUsagesResponse): AccountLimits {
  const result: AccountLimits = { account: account.id, tool: account.tool, ok: true, source: "oauth-api" };
  // Top-level `usage` is the plan's weekly quota (docs: refreshes every 7
  // days); `limits[]` carries the rolling short windows — the shortest one is
  // the 5h-analog gate.
  if (body?.usage) {
    const weekly = kimiWindow(body.usage, 10_080);
    if (weekly) result.weekly = weekly;
  }
  let shortest: { minutes: number; window: WindowUsage } | null = null;
  for (const entry of body?.limits ?? []) {
    if (!entry?.detail) continue;
    const minutes = kimiWindowMinutes(entry.window);
    const window = kimiWindow(entry.detail, minutes);
    if (!window) continue;
    const rank = minutes ?? Number.POSITIVE_INFINITY;
    if (!shortest || rank < shortest.minutes) shortest = { minutes: rank, window };
  }
  if (shortest) result.fiveHour = shortest.window;
  const level = body?.user?.membership?.level;
  if (typeof level === "string" && level.length > 0) result.plan = level.replace(/^LEVEL_/, "").toLowerCase();
  if (!result.fiveHour && !result.weekly) {
    result.ok = false;
    result.error = "usages endpoint returned no windows";
  }
  return result;
}

async function kimiCodeLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const auth = await kimiAccessToken(account, deps);
  if ("error" in auth) return unsupported(account, auth.missing ? "unsupported" : "oauth-api", auth.error);
  const get = deps.httpGetJson ?? defaultHttpGetJson;
  const body = (await get(KIMI_CODE_USAGES_URL, {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
  })) as KimiUsagesResponse;
  return kimiUsagesToLimits(account, body);
}

async function kimiForCodingLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const token = await opencodeProviderToken(account);
  if (!token) {
    return unsupported(account, "unsupported", "no kimi-for-coding token in opencode auth.json (vault or account home)");
  }
  const get = deps.httpGetJson ?? defaultHttpGetJson;
  const body = (await get(KIMI_CODE_USAGES_URL, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  })) as KimiUsagesResponse;
  return kimiUsagesToLimits(account, body);
}
