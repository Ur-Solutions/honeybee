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
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { isRecentlyExhausted, usageSummary } from "./usage.js";
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
// both registered (same quota backend, different credential location).
const PROVIDERS: Record<string, ProviderAdapter> = {
  anthropic: { id: "anthropic", baseURL: "https://api.anthropic.com" },
  openai: { id: "openai" },
  // xAI's UNDOCUMENTED billing endpoint (the CLI's /usage command, captured
  // 2026-07-20): GET cli-chat-proxy.grok.com/v1/billing?format=credits with
  // the grok OAuth key. Falls back to session exhaustion facts (see xaiLimits).
  xai: { id: "xai", baseURL: "https://cli-chat-proxy.grok.com", fetchLimits: xaiLimits },
  moonshot: { id: "moonshot", fetchLimits: moonshotLimits },
  // Anysphere's subscription behind the cursor CLI: the CLI access token
  // authenticates the dashboard RPCs, so plan usage comes from there.
  cursor: { id: "cursor", baseURL: "https://api2.cursor.sh", fetchLimits: cursorLimits },
  "minimax-coding-plan": { id: "minimax-coding-plan", fetchLimits: minimaxLimits },
  "zai-coding-plan": { id: "zai-coding-plan", fetchLimits: zaiLimits },
  "kimi-for-coding": { id: "kimi-for-coding", fetchLimits: moonshotLimits },
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
// Provider quota fetchers. Self-contained here so providers.ts imports
// NOTHING from limits.ts at runtime (AccountLimits/WindowUsage/LimitsDeps are
// type-only imports). Each fetcher:
//   1. locates the account's credential (opencode auth.json for the
//      opencode-hosted providers, the CLI's own credential file for
//      kimi/cursor) across the vault + the account's dedicated homes;
//   2. hits the provider endpoint via deps.httpGetJson/httpPostJson
//      (injectable; tests mock them — NO real network in tests; production
//      falls back to the global-fetch impls);
//   3. parses the REAL response shape into fiveHour/weekly WindowUsage.
// xai's endpoint is undocumented (captured from the CLI's /usage command); it
// additionally falls back to the session exhaustion facts recorded under
// ~/.hive/usage/ when the billing read is unavailable.
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
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
};

const defaultHttpPostForm: NonNullable<LimitsDeps["httpPostForm"]> = async (url, headers, form) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
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
/* kimi (moonshot + kimi-for-coding) — GET coding/v1/usages            */
/* ------------------------------------------------------------------ */

type KimiUsageWindow = { limit?: number | string; used?: number | string; resetTime?: string };
type KimiUsagesResponse = {
  user?: { membership?: { level?: string } };
  /** The membership quota — resets on the weekly cycle. */
  usage?: KimiUsageWindow;
  /** Rolling short windows; the 5h window arrives as duration 300 TIME_UNIT_MINUTE. */
  limits?: Array<{ window?: { duration?: number; timeUnit?: string }; detail?: KimiUsageWindow } | null> | null;
};

// Kimi's OAuth refresh flow, reversed from the kimi-code CLI bundle
// (2026-07-20): a public-client refresh_token grant against auth.kimi.com.
// Access tokens live only ~15 minutes and the REFRESH TOKEN ROTATES on every
// grant, so a minted credential set must be persisted back to every file
// holding the old one — losing the rotated refresh token forces a re-login.
const KIMI_OAUTH_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_TOKEN_EXPIRY_SKEW_SECONDS = 30;

type KimiWireCredential = Record<string, unknown> & {
  access_token?: unknown;
  refresh_token?: unknown;
  /** Epoch SECONDS (kimi's own on-disk convention). */
  expires_at?: unknown;
};

function kimiCredentialPaths(account: AccountRecord): string[] {
  const rel = join("credentials", "kimi-code.json");
  return [
    join(accountDir(account), rel),
    join(storeRoot(), "homes", account.id, rel),
    join(storeRoot(), "login-homes", account.id, rel),
  ];
}

/** Every parseable kimi-code.json for the account (vault mirror + dedicated homes). */
async function readKimiCredentials(account: AccountRecord): Promise<Array<{ path: string; parsed: KimiWireCredential }>> {
  const files: Array<{ path: string; parsed: KimiWireCredential }> = [];
  for (const path of kimiCredentialPaths(account)) {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as KimiWireCredential;
      if (typeof parsed.access_token === "string" || typeof parsed.refresh_token === "string") files.push({ path, parsed });
    } catch {
      // torn/foreign file — try the next candidate
    }
  }
  return files;
}

function kimiExpirySeconds(credential: KimiWireCredential): number {
  return typeof credential.expires_at === "number" && Number.isFinite(credential.expires_at) ? credential.expires_at : 0;
}

function bestKimiCredential(files: Array<{ path: string; parsed: KimiWireCredential }>): { path: string; parsed: KimiWireCredential } | null {
  const usable = files.filter((file) => typeof file.parsed.access_token === "string" || typeof file.parsed.refresh_token === "string");
  if (usable.length === 0) return null;
  return usable.reduce((a, b) => (kimiExpirySeconds(b.parsed) > kimiExpirySeconds(a.parsed) ? b : a));
}

/**
 * Distinct refresh tokens across the account's credential files, freshest
 * first (by the holding file's expires_at). A stale mirror — e.g. a
 * login-homes snapshot with a future expires_at but a long-rotated refresh
 * token — must not shadow a live one; trying each in turn is robust because a
 * dead refresh token fails with `invalid_grant` WITHOUT consuming the valid
 * one (the grant is only single-use on success).
 */
function kimiRefreshTokens(files: Array<{ path: string; parsed: KimiWireCredential }>): string[] {
  const byToken = new Map<string, number>();
  for (const file of files) {
    const token = file.parsed.refresh_token;
    if (typeof token !== "string" || token.length === 0) continue;
    const expiry = kimiExpirySeconds(file.parsed);
    byToken.set(token, Math.max(byToken.get(token) ?? 0, expiry));
  }
  return [...byToken.entries()].sort((a, b) => b[1] - a[1]).map(([token]) => token);
}

/**
 * The kimi-code access token for an account, refreshed through the rotation
 * flow when the on-disk one is expired. Returns the stale token when no
 * refresh is possible (the usages read then reports the 401 honestly).
 */
async function kimiAccessToken(account: AccountRecord, deps: LimitsDeps): Promise<string | null> {
  const best = bestKimiCredential(await readKimiCredentials(account));
  if (!best) return null;
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const token = typeof best.parsed.access_token === "string" ? best.parsed.access_token : null;
  if (token && kimiExpirySeconds(best.parsed) > nowSeconds + KIMI_TOKEN_EXPIRY_SKEW_SECONDS) return token;
  return (await refreshKimiToken(account, deps, token)) ?? token;
}

/**
 * Mint a fresh kimi access token via the refresh grant, serialized on a file
 * lock next to the credential so concurrent sweeps cannot both consume a
 * single-use refresh token. `staleToken` is the access token the caller just
 * found (or watched 401): inside the lock the files are re-read, and a
 * different fresh access token means another process already refreshed — use
 * it. Otherwise each distinct refresh token is tried freshest-first until a
 * grant succeeds, and the rotated credential is written back to EVERY file so
 * stale mirrors converge. Returns null when nothing yields a fresh token.
 */
async function refreshKimiToken(account: AccountRecord, deps: LimitsDeps, staleToken: string | null): Promise<string | null> {
  const files = await readKimiCredentials(account);
  const anchor = bestKimiCredential(files);
  if (!anchor) return null;
  return withFileLock(`${anchor.path}.lock`, async () => {
    // Double-checked: another process may have rotated while we queued.
    const current = await readKimiCredentials(account);
    const best = bestKimiCredential(current);
    if (!best) return null;
    const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const currentToken = typeof best.parsed.access_token === "string" ? best.parsed.access_token : null;
    if (
      currentToken &&
      currentToken !== staleToken &&
      kimiExpirySeconds(best.parsed) > nowSeconds + KIMI_TOKEN_EXPIRY_SKEW_SECONDS
    ) {
      return currentToken;
    }
    const post = deps.httpPostForm ?? defaultHttpPostForm;
    for (const refreshToken of kimiRefreshTokens(current)) {
      let wire: { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown };
      try {
        wire = (await post(KIMI_OAUTH_TOKEN_URL, {}, {
          client_id: KIMI_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        })) as typeof wire;
      } catch {
        // invalid_grant / network — try the next candidate token
        continue;
      }
      if (typeof wire?.access_token !== "string" || wire.access_token.length === 0) continue;
      const expiresAt = typeof wire.expires_at === "number"
        ? wire.expires_at
        : typeof wire.expires_in === "number"
          ? nowSeconds + wire.expires_in
          : undefined;
      const update: KimiWireCredential = {
        access_token: wire.access_token,
        // The grant ROTATES the refresh token; keep the old one only if the
        // response omitted a replacement.
        refresh_token: typeof wire.refresh_token === "string" && wire.refresh_token ? wire.refresh_token : refreshToken,
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
        ...(typeof wire.expires_in === "number" ? { expires_in: wire.expires_in } : {}),
        ...(typeof wire.scope === "string" ? { scope: wire.scope } : {}),
        ...(typeof wire.token_type === "string" ? { token_type: wire.token_type } : {}),
      };
      for (const file of current) {
        await atomicWriteFile(file.path, JSON.stringify({ ...file.parsed, ...update }), { mode: 0o600 });
      }
      return wire.access_token;
    }
    return null;
  });
}

async function moonshotLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  // moonshot (kimi-code CLI) keeps its credential in credentials/kimi-code.json
  // (auto-refreshed here — see refreshKimiToken); kimi-for-coding
  // (opencode-hosted) keeps it in opencode auth.json, whose rotation opencode
  // owns. Same quota backend, so one fetcher serves both provider ids.
  const kimiToken = await kimiAccessToken(account, deps);
  const token = kimiToken ?? (await opencodeProviderToken(account));
  if (!token) {
    return unsupported(account, "unsupported", `no ${account.provider ?? "kimi"} credential (kimi-code.json or opencode auth.json) in vault or account homes`);
  }
  const get = deps.httpGetJson ?? defaultHttpGetJson;
  // Verified against live data (2026-07-20): `limits[]` carries the rolling
  // 5h window (duration 300, TIME_UNIT_MINUTE) and top-level `usage` is the
  // membership quota on the weekly reset cycle. Counts arrive as STRINGS
  // ("100"), percentages must be derived from used/limit.
  const read = (bearer: string) =>
    get("https://api.kimi.com/coding/v1/usages", { Authorization: `Bearer ${bearer}` }) as Promise<KimiUsagesResponse>;
  let body: KimiUsagesResponse;
  try {
    body = await read(token);
  } catch (error) {
    const is401 = /HTTP 401/.test(error instanceof Error ? error.message : String(error));
    // A 401 despite the freshness check means clock skew or a revocation the
    // expiry never saw — refresh once and retry before reporting the failure.
    const retryToken = kimiToken && is401 ? await refreshKimiToken(account, deps, kimiToken) : null;
    if (!retryToken) {
      // A kimi-owned credential that 401s and cannot be refreshed has a
      // rotated-away or revoked refresh token: only an interactive re-login
      // recovers it. Say so instead of surfacing a bare HTTP 401.
      if (kimiToken && is401) {
        return unsupported(account, "unsupported", `kimi token expired and refresh was rejected — re-login with: hive login ${account.id}`);
      }
      throw error;
    }
    body = await read(retryToken);
  }
  const level = body?.user?.membership?.level;
  const plan = typeof level === "string" && level ? level.replace(/^LEVEL_/, "").toLowerCase() : undefined;
  const result: AccountLimits = {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "oauth-api",
    ...(plan ? { plan } : {}),
  };
  for (const entry of body?.limits ?? []) {
    const minutes = kimiWindowMinutes(entry?.window);
    if (minutes === undefined) continue;
    const usage = kimiWindow(entry?.detail, minutes);
    if (!usage) continue;
    if (minutes === 300 && !result.fiveHour) result.fiveHour = usage;
    else if (minutes === 10_080 && !result.weekly) result.weekly = usage;
  }
  if (!result.weekly) {
    const weekly = kimiWindow(body?.usage, 10_080);
    if (weekly) result.weekly = weekly;
  }
  if (!result.fiveHour && !result.weekly) {
    result.ok = false;
    result.error = "usages endpoint returned no windows";
  }
  return result;
}

function kimiWindowMinutes(window: { duration?: number; timeUnit?: string } | null | undefined): number | undefined {
  const duration = window?.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return undefined;
  switch (window?.timeUnit) {
    case "TIME_UNIT_MINUTE":
      return duration;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 1440;
    case "TIME_UNIT_WEEK":
      return duration * 10_080;
    default:
      return undefined;
  }
}

function kimiWindow(window: KimiUsageWindow | null | undefined, windowMinutes: number): WindowUsage | null {
  const limit = numericField(window?.limit);
  const used = numericField(window?.used);
  if (limit === undefined || limit <= 0 || used === undefined) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    windowMinutes,
    ...(typeof window?.resetTime === "string" && window.resetTime ? { resetsAt: new Date(window.resetTime).toISOString() } : {}),
  };
}

/** Kimi/cursor numbers arrive as numbers OR numeric strings; undefined otherwise. */
function numericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* cursor — POST DashboardService/GetCurrentPeriodUsage                */
/* ------------------------------------------------------------------ */

type CursorPeriodUsage = {
  billingCycleStart?: number | string;
  billingCycleEnd?: number | string;
  planUsage?: { totalSpend?: number | string; limit?: number | string } | null;
};

/**
 * The cursor CLI access token for an account. cursor-agent's live store is
 * machine-global (keychain), so the vault's canonical auth.json — written by
 * `hive login` — is the per-account truth (see accounts/cursorAuth.ts).
 */
async function cursorAccessToken(account: AccountRecord): Promise<string | null> {
  const raw = await readFile(join(accountDir(account), "auth.json"), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { accessToken?: unknown };
    return typeof parsed.accessToken === "string" && parsed.accessToken.length > 0 ? parsed.accessToken : null;
  } catch {
    return null;
  }
}

async function cursorLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const token = await cursorAccessToken(account);
  if (!token) {
    return unsupported(account, "unsupported", "no cursor auth.json in the vault (log in with: hive login <account>)");
  }
  const post = deps.httpPostJson ?? defaultHttpPostJson;
  // Verified against live data (2026-07-20): planUsage.totalSpend/limit are
  // cents spent vs included cents for the CURRENT BILLING CYCLE (monthly).
  // That cycle lands in the weekly slot — the long-window column — with the
  // true cycle length in windowMinutes so the pace math stays honest.
  const body = (await post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
    Authorization: `Bearer ${token}`,
  }, {})) as CursorPeriodUsage;
  const spend = numericField(body?.planUsage?.totalSpend);
  const limit = numericField(body?.planUsage?.limit);
  if (spend === undefined || limit === undefined || limit <= 0) {
    return { account: account.id, tool: account.tool, ok: false, source: "oauth-api", error: "GetCurrentPeriodUsage returned no plan usage" };
  }
  const start = numericField(body?.billingCycleStart);
  const end = numericField(body?.billingCycleEnd);
  return {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "oauth-api",
    weekly: {
      usedPercent: Math.min(100, Math.max(0, (spend / limit) * 100)),
      ...(end !== undefined && end > 0 ? { resetsAt: new Date(end).toISOString() } : {}),
      ...(start !== undefined && end !== undefined && end > start ? { windowMinutes: Math.round((end - start) / 60_000) } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* xai — GET v1/billing?format=credits, else session exhaustion facts  */
/* ------------------------------------------------------------------ */

/** xAI wraps scalar amounts as {val: n}; accept the wrapper or a bare number. */
type XaiVal = { val?: number } | number;
type XaiBillingResponse = {
  config?: {
    /** Unified-billing shape: the current usage period's used percent (0-100). */
    creditUsagePercent?: number;
    currentPeriod?: { type?: string; start?: string; end?: string };
    productUsage?: Array<{ product?: string; usagePercent?: number } | null> | null;
    /** Legacy credits shape (non-unified accounts): raw credits used vs cap. */
    monthlyLimit?: XaiVal;
    used?: XaiVal;
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
  };
};

/**
 * The grok CLI's OAuth access token for an account. auth.json (vault mirror
 * first, then the dedicated homes) maps "<issuer>::<client-id>" to a
 * credential entry whose `key` is the bearer token; pick the one expiring
 * last so a freshly-rotated chain wins over a stale sibling.
 */
async function grokAccessToken(account: AccountRecord): Promise<string | null> {
  const candidates = [
    join(accountDir(account), "auth.json"),
    join(storeRoot(), "homes", account.id, "auth.json"),
    join(storeRoot(), "login-homes", account.id, "auth.json"),
  ];
  let best: { key: string; expiresAtMs: number } | null = null;
  for (const path of candidates) {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const entry of Object.values(parsed)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { key, expires_at } = entry as { key?: unknown; expires_at?: unknown };
      if (typeof key !== "string" || key.length === 0) continue;
      const expiresAtMs = typeof expires_at === "string" ? Date.parse(expires_at) : Number.NaN;
      const normalized = Number.isFinite(expiresAtMs) ? expiresAtMs : 0;
      if (!best || normalized > best.expiresAtMs) best = { key, expiresAtMs: normalized };
    }
  }
  return best?.key ?? null;
}

/**
 * xAI's quota endpoint for grok subscriptions is UNDOCUMENTED — captured from
 * the CLI's /usage command (2026-07-20) via a logging reverse proxy:
 * GET cli-chat-proxy.grok.com/v1/billing?format=credits with the OAuth key.
 * Unified-billing accounts answer creditUsagePercent + a weekly currentPeriod;
 * legacy accounts answer raw monthlyLimit/used credits. When no token is on
 * disk or the endpoint fails, fall back to the session exhaustion facts the
 * runners record into ~/.hive/usage/ (a recently-exhausted account reads 100%
 * used until the reset hint or cool-off passes).
 */
async function xaiLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const token = await grokAccessToken(account);
  if (token) {
    const get = deps.httpGetJson ?? defaultHttpGetJson;
    try {
      const body = (await get("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
        Authorization: `Bearer ${token}`,
      })) as XaiBillingResponse;
      const weekly = xaiBillingWindow(body?.config);
      if (weekly) {
        return { account: account.id, tool: account.tool, ok: true, source: "oauth-api", weekly };
      }
    } catch {
      // stale token / endpoint drift — fall through to the session facts
    }
  }
  return xaiSessionFacts(account, deps);
}

function xaiBillingWindow(config: XaiBillingResponse["config"]): WindowUsage | null {
  if (!config) return null;
  // Unified billing: the percent is authoritative; the period bounds it.
  const unifiedPercent = typeof config.creditUsagePercent === "number"
    ? config.creditUsagePercent
    : config.productUsage?.find((entry) => typeof entry?.usagePercent === "number")?.usagePercent;
  const period = config.currentPeriod;
  if (typeof unifiedPercent === "number") {
    return xaiWindow(unifiedPercent, period?.start ?? config.billingPeriodStart, period?.end ?? config.billingPeriodEnd);
  }
  // Legacy credits: derive the percent from used/monthlyLimit.
  const limit = xaiVal(config.monthlyLimit);
  const used = xaiVal(config.used);
  if (limit === undefined || limit <= 0 || used === undefined) return null;
  return xaiWindow((used / limit) * 100, config.billingPeriodStart, config.billingPeriodEnd);
}

function xaiWindow(usedPercent: number, start: string | undefined, end: string | undefined): WindowUsage {
  const startMs = typeof start === "string" ? Date.parse(start) : Number.NaN;
  const endMs = typeof end === "string" ? Date.parse(end) : Number.NaN;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    ...(Number.isFinite(endMs) ? { resetsAt: new Date(endMs).toISOString() } : {}),
    ...(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? { windowMinutes: Math.round((endMs - startMs) / 60_000) }
      : {}),
  };
}

function xaiVal(value: XaiVal | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && typeof value.val === "number" && Number.isFinite(value.val)) return value.val;
  return undefined;
}

/**
 * Session-facts fallback: the runners record provider 429s into ~/.hive/usage/
 * (usage.ts). A recently-exhausted account reads 100% used until the provider's
 * reset hint (or the cool-off) passes; an account with samples but no usable
 * billing read is an ok row with empty windows.
 */
async function xaiSessionFacts(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
  const now = deps.now?.() ?? Date.now();
  const summary = await usageSummary(account.id, now);
  if (summary.sampleCount === 0 && !summary.lastExhaustedAt) {
    return {
      account: account.id,
      tool: account.tool,
      ok: false,
      source: "session-snapshot",
      error: "billing endpoint unreadable (no fresh grok token?) and no session usage facts yet",
    };
  }
  const sampleTs = summary.lastSample?.ts;
  const asOf = sampleTs && (!summary.lastExhaustedAt || sampleTs > summary.lastExhaustedAt) ? sampleTs : summary.lastExhaustedAt;
  const result: AccountLimits = {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "session-snapshot",
    ...(asOf ? { asOf } : {}),
  };
  if (isRecentlyExhausted(summary, now)) {
    // Reset hints are best-effort ISO timestamps (hsr/adapters/grok.ts); a
    // non-parseable hint just drops the reset tag, never the 100% signal.
    const reset = summary.lastResetHint !== undefined ? Date.parse(summary.lastResetHint) : Number.NaN;
    result.fiveHour = {
      usedPercent: 100,
      ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
    };
  }
  return result;
}
