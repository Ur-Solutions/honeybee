/**
 * Provider limits responses → the store's limits snapshot (spec 08 "Limits").
 * PURE response parsing, ported from the old src/limits/claude.ts (usage
 * endpoint mapping incl. the Fable-scoped weekly entry) and
 * src/limits/codex.ts (assignCodexWindows: duration-classified windows win
 * over positional guesses). The transport (OAuth GET, `codex app-server`
 * JSON-RPC) is injected by the daemon and never runs here.
 */
import type { PutAccountLimitsInput } from "./store.ts";

/** GET api.anthropic.com/api/oauth/usage — the shape Claude Code's /usage panel reads. */
export type ClaudeUsageResponse = {
  five_hour?: { utilization?: number | null; resets_at?: string | null } | null;
  seven_day?: { utilization?: number | null; resets_at?: string | null } | null;
  /**
   * Modern limits array. Model-scoped weekly entries carry the plan's
   * included usage per model (e.g. Fable on Claude 5 plans); the unscoped
   * session/weekly entries duplicate five_hour/seven_day.
   */
  limits?: Array<{
    kind?: string | null;
    percent?: number | null;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
  } | null> | null;
};

/** `codex app-server` → `account/rateLimits/read` result.rateLimits. */
export type CodexLiveWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
export type CodexLiveRateLimits = {
  primary?: CodexLiveWindow | null;
  secondary?: CodexLiveWindow | null;
  planType?: string | null;
};

type Window = NonNullable<PutAccountLimitsInput["weekly"]>;

const CLAUDE_FIVE_HOUR_MINUTES = 300;
const CLAUDE_WEEKLY_MINUTES = 10_080;

function isoToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Claude: five_hour → fiveHour (300 min), seven_day → weekly (10080 min), and
 * the `weekly_scoped` limits[] entry whose model display name is Fable →
 * fableWeekly. No windows at all = unreadable ("usage endpoint returned no
 * windows"), exactly as before.
 */
export function parseClaudeUsage(usage: ClaudeUsageResponse, plan?: string | null): PutAccountLimitsInput {
  const out: PutAccountLimitsInput = { readable: true, ...(plan ? { plan } : {}) };
  if (typeof usage.five_hour?.utilization === "number") {
    out.fiveHour = { usedPercent: usage.five_hour.utilization, windowMinutes: CLAUDE_FIVE_HOUR_MINUTES, resetsAt: isoToMs(usage.five_hour.resets_at) };
  }
  if (typeof usage.seven_day?.utilization === "number") {
    out.weekly = { usedPercent: usage.seven_day.utilization, windowMinutes: CLAUDE_WEEKLY_MINUTES, resetsAt: isoToMs(usage.seven_day.resets_at) };
  }
  // Fable included usage rides the limits[] array as a model-scoped weekly
  // entry (the legacy seven_day_<model> fields stay null on Claude 5 plans).
  const fable = usage.limits?.find(
    (entry) => entry?.kind === "weekly_scoped" && /^fable\b/i.test(entry.scope?.model?.display_name ?? ""),
  );
  if (fable && typeof fable.percent === "number") {
    out.fableWeekly = { usedPercent: fable.percent, windowMinutes: CLAUDE_WEEKLY_MINUTES, resetsAt: isoToMs(fable.resets_at) };
  }
  if (!out.fiveHour && !out.weekly) {
    out.readable = false;
    out.error = "usage endpoint returned no windows";
  }
  return out;
}

const CODEX_FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

type CodexWindowSlot = "fiveHour" | "weekly";

function codexWindowSlot(windowMinutes: number | undefined): CodexWindowSlot | null {
  if (windowMinutes === CODEX_FIVE_HOUR_WINDOW_MINUTES) return "fiveHour";
  if (windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES) return "weekly";
  return null;
}

function liveWindow(window: CodexLiveWindow): Window {
  return {
    usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : 0,
    resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
    windowMinutes: typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
  };
}

/**
 * Codex normally calls the 5h window `primary` and the weekly window
 * `secondary`, but it promotes the weekly window to `primary` when the 5h
 * limit is disabled. Prefer the explicit duration so that temporary provider
 * changes do not shift a weekly value into the 5h column. Positional fallback
 * keeps older responses without duration metadata compatible.
 */
export function parseCodexRateLimits(limits: CodexLiveRateLimits): PutAccountLimitsInput {
  const out: PutAccountLimitsInput = { readable: true, ...(limits.planType ? { plan: limits.planType } : {}) };
  const candidates: Array<{ usage: Window; duration: number | undefined; fallback: CodexWindowSlot }> = [];
  const add = (window: CodexLiveWindow | null | undefined, fallback: CodexWindowSlot) => {
    if (!window) return;
    candidates.push({ usage: liveWindow(window), duration: window.windowDurationMins, fallback });
  };
  add(limits.primary, "fiveHour");
  add(limits.secondary, "weekly");
  // Duration-classified windows win over positional guesses.
  for (const candidate of candidates) {
    const slot = codexWindowSlot(candidate.duration);
    if (slot && !out[slot]) out[slot] = candidate.usage;
  }
  for (const candidate of candidates) {
    if (codexWindowSlot(candidate.duration)) continue;
    const alternate: CodexWindowSlot = candidate.fallback === "fiveHour" ? "weekly" : "fiveHour";
    const slot = !out[candidate.fallback] ? candidate.fallback : !out[alternate] ? alternate : null;
    if (slot) out[slot] = candidate.usage;
  }
  if (!out.fiveHour && !out.weekly) {
    out.readable = false;
    out.error = "app-server returned no rate-limit windows";
  }
  return out;
}

/**
 * The claude `.credentials.json` / Keychain payload → the fields the limits
 * fetch needs (access token, expiry, plan). Null when the shape is not a
 * claudeAiOauth credential.
 */
export function parseClaudeCredentials(raw: string | null): { accessToken: string; expiresAt: number; subscriptionType?: string; refreshToken?: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || typeof oauth.expiresAt !== "number") return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt,
      ...(typeof oauth.subscriptionType === "string" ? { subscriptionType: oauth.subscriptionType } : {}),
      ...(typeof oauth.refreshToken === "string" ? { refreshToken: oauth.refreshToken } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * A REAL provider auth failure, as opposed to a missing credential or a
 * transport error (old src/limits/dispatch.ts isAuthFailureLimitsError):
 * these mean "this credential does not authenticate" — the account goes
 * auth_needed and drops out of auto selection until positive evidence lands.
 */
export function isAuthFailureLimitsError(message: string): boolean {
  const m = message.toLowerCase();
  return /\bhttp 401\b/.test(m)
    || m.includes("revoked")
    || m.includes("unauthorized")
    || m.includes("invalid_grant")
    || m.includes("refresh failed");
}
