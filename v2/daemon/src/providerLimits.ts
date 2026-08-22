/**
 * Limits transports for the non-Claude/Codex account homes. These are the
 * v2 ports of the provider adapters that shipped in the frozen v1 tree:
 * Grok/xAI billing, Kimi membership usage, Cursor's dashboard period, and
 * the MiniMax/z.ai OpenCode coding plans.
 *
 * Credential refresh is allowed only when AccountsService proves that no
 * live runtime owns the account. Grok and Kimi both rotate refresh tokens,
 * so a successful grant is written atomically to the account home and vault.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountRow, PutAccountLimitsInput } from "../../core/src/index.ts";
import { atomicWriteFileSync } from "./homeDefaults.ts";

export interface ProviderLimitsHttp {
  getJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
  postJson: (url: string, headers: Record<string, string>, body: unknown) => Promise<unknown>;
  postForm: (url: string, headers: Record<string, string>, form: Record<string, string>) => Promise<unknown>;
}

export interface ProviderLimitsOptions {
  account: AccountRow;
  vaultDir: string;
  now: number;
  allowCredentialRefresh: boolean;
  http: ProviderLimitsHttp;
}

type ProviderWindow = NonNullable<PutAccountLimitsInput["weekly"]>;

export function defaultProviderLimitsHttp(timeoutMs: number): ProviderLimitsHttp {
  const checked = async (response: Response, url: string): Promise<unknown> => {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = body.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new Error(`${new URL(url).pathname}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }
    return response.json();
  };
  return {
    getJson: async (url, headers) => checked(await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }), url),
    postJson: async (url, headers, body) => checked(await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }), url),
    postForm: async (url, headers, form) => checked(await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    }), url),
  };
}

function readObject(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writePrivateJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(value));
}

function unreadable(reason: PutAccountLimitsInput["unreadableReason"], error: string): PutAccountLimitsInput {
  return { readable: false, unreadableReason: reason, error };
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function percentWindow(used: number, resetsAt?: number, windowMinutes?: number): ProviderWindow {
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    ...(resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {}),
    ...(windowMinutes !== undefined && windowMinutes > 0 ? { windowMinutes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Grok / xAI
// ---------------------------------------------------------------------------

const GROK_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

type GrokAuthEntry = Record<string, unknown> & {
  key?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  oidc_client_id?: unknown;
};

function grokCredential(options: ProviderLimitsOptions): { document: Record<string, unknown>; entryKey: string; entry: GrokAuthEntry } | null {
  let best: { document: Record<string, unknown>; entryKey: string; entry: GrokAuthEntry; expiresAt: number } | null = null;
  for (const path of [join(options.account.homePath, "auth.json"), join(options.vaultDir, "auth.json")]) {
    const document = readObject(path);
    if (!document) continue;
    for (const [entryKey, raw] of Object.entries(document)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as GrokAuthEntry;
      if (typeof entry.key !== "string" && typeof entry.refresh_token !== "string") continue;
      const expiresAt = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : 0;
      if (!best || (Number.isFinite(expiresAt) ? expiresAt : 0) > best.expiresAt) {
        best = { document, entryKey, entry, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 };
      }
    }
  }
  return best;
}

async function grokAccessToken(options: ProviderLimitsOptions): Promise<string | PutAccountLimitsInput> {
  const credential = grokCredential(options);
  if (!credential) return unreadable("auth_expired", `no Grok OAuth credential; log in: hive account login ${options.account.id}`);
  const current = typeof credential.entry.key === "string" ? credential.entry.key : null;
  const expiresAt = typeof credential.entry.expires_at === "string" ? Date.parse(credential.entry.expires_at) : 0;
  if (current && Number.isFinite(expiresAt) && expiresAt > options.now + 30_000) return current;
  if (!options.allowCredentialRefresh) {
    return unreadable("auth_expired", "Grok OAuth token expired; the running Grok owns refresh for this account");
  }
  const refreshToken = credential.entry.refresh_token;
  const clientId = credential.entry.oidc_client_id;
  if (typeof refreshToken !== "string" || typeof clientId !== "string") {
    return unreadable("auth_expired", `Grok OAuth token expired without a refresh chain; log in: hive account login ${options.account.id}`);
  }
  let wire: Record<string, unknown>;
  try {
    wire = await options.http.postForm(GROK_TOKEN_URL, {}, {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = /HTTP (400|401)|invalid_grant|revoked/i.test(detail) ? "auth_failed" : "provider_error";
    return unreadable(reason, `Grok OAuth refresh failed: ${detail}`);
  }
  if (typeof wire.access_token !== "string" || !wire.access_token) {
    return unreadable("auth_failed", "Grok OAuth refresh returned no access token");
  }
  const expiresIn = numberField(wire.expires_in) ?? 3600;
  const entry: GrokAuthEntry = {
    ...credential.entry,
    key: wire.access_token,
    refresh_token: typeof wire.refresh_token === "string" && wire.refresh_token ? wire.refresh_token : refreshToken,
    expires_at: new Date(options.now + expiresIn * 1000).toISOString(),
  };
  const document = { ...credential.document, [credential.entryKey]: entry };
  writePrivateJson(join(options.account.homePath, "auth.json"), document);
  writePrivateJson(join(options.vaultDir, "auth.json"), document);
  return wire.access_token;
}

type XaiValue = number | { val?: number };
type XaiBilling = {
  config?: {
    creditUsagePercent?: number;
    currentPeriod?: { start?: string; end?: string };
    productUsage?: Array<{ usagePercent?: number } | null> | null;
    monthlyLimit?: XaiValue;
    used?: XaiValue;
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
  };
};

function xaiValue(value: XaiValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && typeof value.val === "number" && Number.isFinite(value.val)) return value.val;
  return undefined;
}

function grokBillingWindow(config: XaiBilling["config"]): ProviderWindow | null {
  if (!config) return null;
  const usedPercent = typeof config.creditUsagePercent === "number"
    ? config.creditUsagePercent
    : config.productUsage?.find((entry) => typeof entry?.usagePercent === "number")?.usagePercent;
  const limit = xaiValue(config.monthlyLimit);
  const used = xaiValue(config.used);
  const percent = usedPercent ?? (limit !== undefined && limit > 0 && used !== undefined ? (used / limit) * 100 : undefined);
  if (percent === undefined) return null;
  const startText = config.currentPeriod?.start ?? config.billingPeriodStart;
  const endText = config.currentPeriod?.end ?? config.billingPeriodEnd;
  const start = startText ? Date.parse(startText) : Number.NaN;
  const end = endText ? Date.parse(endText) : Number.NaN;
  return percentWindow(
    percent,
    Number.isFinite(end) ? end : undefined,
    Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / 60_000) : undefined,
  );
}

async function grokLimits(options: ProviderLimitsOptions): Promise<PutAccountLimitsInput> {
  const access = await grokAccessToken(options);
  if (typeof access !== "string") return access;
  const body = await options.http.getJson(GROK_BILLING_URL, { Authorization: `Bearer ${access}` }) as XaiBilling;
  const weekly = grokBillingWindow(body.config);
  return weekly ? { readable: true, weekly } : unreadable("provider_error", "Grok billing endpoint returned no usage window");
}

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------

const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

type KimiCredential = Record<string, unknown> & { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown };

function kimiCredential(options: ProviderLimitsOptions): KimiCredential | null {
  const candidates = [
    readObject(join(options.account.homePath, "credentials", "kimi-code.json")),
    readObject(join(options.vaultDir, "credentials", "kimi-code.json")),
  ].filter((value): value is KimiCredential => value !== null);
  candidates.sort((a, b) => (numberField(b.expires_at) ?? 0) - (numberField(a.expires_at) ?? 0));
  return candidates[0] ?? null;
}

async function kimiAccessToken(options: ProviderLimitsOptions): Promise<string | PutAccountLimitsInput> {
  const credential = kimiCredential(options);
  if (!credential) return unreadable("auth_expired", `no Kimi OAuth credential; log in: hive account login ${options.account.id}`);
  const access = typeof credential.access_token === "string" ? credential.access_token : null;
  const expiresAtMs = (numberField(credential.expires_at) ?? 0) * 1000;
  if (access && expiresAtMs > options.now + 30_000) return access;
  if (!options.allowCredentialRefresh) {
    return unreadable("auth_expired", "Kimi OAuth token expired; the running Kimi owns refresh for this account");
  }
  const refreshToken = credential.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) {
    return unreadable("auth_expired", `Kimi OAuth token expired without a refresh chain; log in: hive account login ${options.account.id}`);
  }
  let wire: Record<string, unknown>;
  try {
    wire = await options.http.postForm(KIMI_TOKEN_URL, {}, {
      client_id: KIMI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = /HTTP (400|401)|invalid_grant|revoked/i.test(detail) ? "auth_failed" : "provider_error";
    return unreadable(reason, `Kimi OAuth refresh failed: ${detail}`);
  }
  if (typeof wire.access_token !== "string" || !wire.access_token) {
    return unreadable("auth_failed", "Kimi OAuth refresh returned no access token");
  }
  const expiresIn = numberField(wire.expires_in) ?? 900;
  const update: KimiCredential = {
    ...credential,
    ...wire,
    access_token: wire.access_token,
    refresh_token: typeof wire.refresh_token === "string" && wire.refresh_token ? wire.refresh_token : refreshToken,
    expires_at: Math.floor(options.now / 1000) + expiresIn,
  };
  writePrivateJson(join(options.account.homePath, "credentials", "kimi-code.json"), update);
  writePrivateJson(join(options.vaultDir, "credentials", "kimi-code.json"), update);
  return wire.access_token;
}

type KimiUsage = { limit?: number | string; used?: number | string; resetTime?: string };
type KimiResponse = {
  user?: { membership?: { level?: string } };
  usage?: KimiUsage;
  limits?: Array<{ window?: { duration?: number; timeUnit?: string }; detail?: KimiUsage } | null> | null;
};

function kimiMinutes(window: { duration?: number; timeUnit?: string } | undefined): number | undefined {
  if (typeof window?.duration !== "number" || window.duration <= 0) return undefined;
  if (window.timeUnit === "TIME_UNIT_MINUTE") return window.duration;
  if (window.timeUnit === "TIME_UNIT_HOUR") return window.duration * 60;
  if (window.timeUnit === "TIME_UNIT_DAY") return window.duration * 1440;
  if (window.timeUnit === "TIME_UNIT_WEEK") return window.duration * 10_080;
  return undefined;
}

function kimiWindow(usage: KimiUsage | undefined, minutes: number): ProviderWindow | null {
  const limit = numberField(usage?.limit);
  const used = numberField(usage?.used);
  if (limit === undefined || limit <= 0 || used === undefined) return null;
  const reset = usage?.resetTime ? Date.parse(usage.resetTime) : Number.NaN;
  return percentWindow((used / limit) * 100, Number.isFinite(reset) ? reset : undefined, minutes);
}

async function kimiLimits(options: ProviderLimitsOptions): Promise<PutAccountLimitsInput> {
  const access = await kimiAccessToken(options);
  if (typeof access !== "string") return access;
  const body = await options.http.getJson(KIMI_USAGE_URL, { Authorization: `Bearer ${access}` }) as KimiResponse;
  let fiveHour: ProviderWindow | undefined;
  let weekly: ProviderWindow | undefined;
  for (const entry of body.limits ?? []) {
    const minutes = kimiMinutes(entry?.window);
    if (minutes === undefined) continue;
    const window = kimiWindow(entry?.detail, minutes);
    if (minutes === 300 && window && !fiveHour) fiveHour = window;
    if (minutes === 10_080 && window && !weekly) weekly = window;
  }
  weekly ??= kimiWindow(body.usage, 10_080) ?? undefined;
  if (!fiveHour && !weekly) return unreadable("provider_error", "Kimi usage endpoint returned no windows");
  const level = body.user?.membership?.level;
  return {
    readable: true,
    ...(typeof level === "string" && level ? { plan: level.replace(/^LEVEL_/, "").toLowerCase() } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

async function cursorLimits(options: ProviderLimitsOptions): Promise<PutAccountLimitsInput> {
  const auth = readObject(join(options.vaultDir, "auth.json")) ?? readObject(join(options.account.homePath, "auth.json"));
  const token = auth?.accessToken;
  if (typeof token !== "string" || !token) return unreadable("auth_expired", `no Cursor access token; log in: hive account login ${options.account.id}`);
  const body = await options.http.postJson(
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    { Authorization: `Bearer ${token}` },
    {},
  ) as {
    billingCycleStart?: unknown;
    billingCycleEnd?: unknown;
    planUsage?: {
      totalSpend?: unknown;
      limit?: unknown;
      apiPercentUsed?: unknown;
      totalPercentUsed?: unknown;
    } | null;
  };
  const spend = numberField(body.planUsage?.totalSpend);
  const limit = numberField(body.planUsage?.limit);
  const fallbackPercent = spend !== undefined && limit !== undefined && limit > 0
    ? (spend / limit) * 100
    : undefined;
  // Cursor's current plan has two independently exhausted pools. These
  // provider-authored percentages also drive Cursor's own display messages;
  // raw totalSpend/limit are not one coherent denominator when bonus capacity
  // is present, so use them only for older endpoint shapes.
  const cursorModels = numberField(body.planUsage?.totalPercentUsed);
  const otherModels = numberField(body.planUsage?.apiPercentUsed);
  const percents = [cursorModels, otherModels].filter((value): value is number => value !== undefined);
  const routingPercent = percents.length > 0 ? Math.max(...percents) : fallbackPercent;
  if (routingPercent === undefined) return unreadable("provider_error", "Cursor dashboard returned no plan usage");
  const start = numberField(body.billingCycleStart);
  const end = numberField(body.billingCycleEnd);
  const resetsAt = end !== undefined && end > 0 ? end : undefined;
  const windowMinutes = start !== undefined && end !== undefined && end > start
    ? Math.round((end - start) / 60_000)
    : undefined;
  const displayWindows = [
    ...(cursorModels !== undefined ? [{
      key: "cursor-models",
      label: "cursor models",
      ...percentWindow(cursorModels, resetsAt, windowMinutes),
    }] : []),
    ...(otherModels !== undefined ? [{
      key: "other-models",
      label: "third-party",
      ...percentWindow(otherModels, resetsAt, windowMinutes),
    }] : []),
  ];
  return {
    readable: true,
    weekly: percentWindow(routingPercent, resetsAt, windowMinutes),
    ...(displayWindows.length > 0 ? { displayWindows } : {}),
  };
}

// ---------------------------------------------------------------------------
// OpenCode coding-plan providers
// ---------------------------------------------------------------------------

type OpenCodeAuth = { type?: unknown; key?: unknown; access?: unknown; token?: unknown };

function openCodeCredential(options: ProviderLimitsOptions): { provider: "minimax-coding-plan" | "zai-coding-plan"; token: string } | null {
  for (const path of [
    join(options.account.homePath, "xdg-data", "opencode", "auth.json"),
    join(options.vaultDir, "xdg-data", "opencode", "auth.json"),
  ]) {
    const auth = readObject(path);
    if (!auth) continue;
    for (const provider of ["minimax-coding-plan", "zai-coding-plan"] as const) {
      const entry = auth[provider] as OpenCodeAuth | undefined;
      const token = entry?.key ?? entry?.access ?? entry?.token;
      if (typeof token === "string" && token) return { provider, token };
    }
  }
  return null;
}

async function miniMaxLimits(options: ProviderLimitsOptions, token: string): Promise<PutAccountLimitsInput> {
  const body = await options.http.getJson("https://api.minimax.io/v1/token_plan/remains", { Authorization: `Bearer ${token}` }) as {
    model_remains?: Array<{
      current_interval_total_count?: number;
      current_interval_usage_count?: number;
      current_interval_remaining_percent?: number;
      end_time?: number;
      current_weekly_total_count?: number;
      current_weekly_usage_count?: number;
      weekly_end_time?: number;
    }>;
  };
  const plan = body.model_remains?.[0];
  if (!plan) return unreadable("provider_error", "MiniMax token-plan endpoint returned no model remains");
  const make = (used: number | undefined, total: number | undefined, remaining: number | undefined, end: number | undefined, minutes: number): ProviderWindow => {
    const percent = total && total > 0 && used !== undefined
      ? (used / total) * 100
      : remaining !== undefined
        ? 100 - (remaining <= 1 ? remaining * 100 : remaining)
        : 0;
    return percentWindow(percent, end, minutes);
  };
  return {
    readable: true,
    fiveHour: make(plan.current_interval_usage_count, plan.current_interval_total_count, plan.current_interval_remaining_percent, plan.end_time, 300),
    weekly: make(plan.current_weekly_usage_count, plan.current_weekly_total_count, undefined, plan.weekly_end_time, 10_080),
  };
}

async function zaiLimits(options: ProviderLimitsOptions, token: string): Promise<PutAccountLimitsInput> {
  const body = await options.http.getJson("https://api.z.ai/api/monitor/usage/quota/limit", { Authorization: `Bearer ${token}` }) as {
    data?: { level?: string; limits?: Array<{ type?: string; percentage?: number; nextResetTime?: number }> };
  };
  const tokens = body.data?.limits?.find((entry) => entry.type === "TOKENS_LIMIT");
  if (!tokens) return unreadable("provider_error", "z.ai usage endpoint returned no token window");
  return {
    readable: true,
    ...(body.data?.level ? { plan: body.data.level } : {}),
    fiveHour: percentWindow(tokens.percentage ?? 0, tokens.nextResetTime, 300),
  };
}

async function openCodeLimits(options: ProviderLimitsOptions): Promise<PutAccountLimitsInput> {
  const credential = openCodeCredential(options);
  if (!credential) return unreadable("auth_expired", `no supported OpenCode coding-plan credential; log in: hive account login ${options.account.id}`);
  return credential.provider === "minimax-coding-plan"
    ? miniMaxLimits(options, credential.token)
    : zaiLimits(options, credential.token);
}

export async function fetchSecondaryProviderLimits(options: ProviderLimitsOptions): Promise<PutAccountLimitsInput> {
  switch (options.account.harness) {
    case "grok":
      return grokLimits(options);
    case "kimi":
      return kimiLimits(options);
    case "cursor":
      return cursorLimits(options);
    case "opencode":
      return openCodeLimits(options);
    default:
      return unreadable("unsupported", `${options.account.harness} has no limits source`);
  }
}
