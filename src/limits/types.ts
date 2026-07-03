// ──────────────────────────────────────────────────────────────────────────
// Shared vocabulary for the limits subsystem: the window/result/deps types the
// provider fetchers (claude, codex, the registry adapters) all speak, plus the
// per-provider response shapes that LimitsDeps' injectable fetchers return.
// Kept dependency-light (types only) so every limits/* module and providers.ts
// can import it without a runtime cycle.
// ──────────────────────────────────────────────────────────────────────────

import type { AccountRecord, RefreshedClaudeToken, readVaultClaudeChain } from "../accounts.js";
import type { readClaudeKeychain } from "../keychain.js";

export type { RefreshedClaudeToken } from "../accounts.js";

export type WindowUsage = {
  usedPercent: number;
  resetsAt?: string;
  /** Window length, when known (claude: implied 300/10080; codex: from the snapshot). */
  windowMinutes?: number;
};

export type AccountLimits = {
  account: string;
  tool: string;
  /**
   * The provider this account's quota belongs to (anthropic/openai/zai-coding-plan/…).
   * Additive: populated from account.provider. `tool` stays populated for the
   * table/back-compat; `provider` is the quota-source key.
   */
  provider?: string;
  ok: boolean;
  error?: string;
  fiveHour?: WindowUsage;
  weekly?: WindowUsage;
  /** Weekly window scoped to Fable — the plan's included Fable usage (claude only). */
  fableWeekly?: WindowUsage;
  plan?: string;
  /** Snapshot time for disk-sourced data; undefined when live. */
  asOf?: string;
  source: "oauth-api" | "app-server" | "session-snapshot" | "unsupported";
  /** True when served from the on-disk limits cache rather than fetched now. */
  cached?: boolean;
};

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

export type CodexLiveWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
export type CodexLiveRateLimits = {
  primary?: CodexLiveWindow | null;
  secondary?: CodexLiveWindow | null;
  planType?: string | null;
};

export type LimitsDeps = {
  fetchClaudeUsage?: (accessToken: string) => Promise<ClaudeUsageResponse>;
  /** Resolve the email a token actually belongs to (OAuth profile endpoint). */
  fetchClaudeProfileEmail?: (accessToken: string) => Promise<string | null>;
  /** Live codex rate limits for a home via the app-server RPC; null on failure. */
  codexLiveRateLimits?: (homePath: string) => Promise<CodexLiveRateLimits | null>;
  /** OAuth refresh; returns the new credential set or null when the refresh token is dead. */
  refreshClaudeToken?: (refreshToken: string) => Promise<RefreshedClaudeToken | null>;
  /** Persist a refreshed credential set (vault + the account's homes). */
  persistRefreshedCredentials?: (account: AccountRecord, oauth: Record<string, unknown>) => Promise<void>;
  /** Re-read the vault chain under the lock (double-checked refresh; tests override). */
  readVaultChain?: typeof readVaultClaudeChain;
  /** Serialize the refresh critical section (tests can pass a passthrough). */
  withAccountLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Mirror a verified fresher credential into the vault file (no rotation). */
  persistVaultCredentials?: (account: AccountRecord, oauth: Record<string, unknown>) => Promise<void>;
  readKeychain?: typeof readClaudeKeychain;
  /**
   * Injectable JSON GET for provider quota endpoints (zai/minimax). Tests pass
   * a mock; production falls back to the provider's own global-fetch impl. NO
   * real network in tests. The provider fetchers read this off deps.
   */
  httpGetJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
  now?: () => number;
};
