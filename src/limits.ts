import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccountRecord,
  type RefreshedClaudeToken,
  PROVIDER_BY_CLI,
  accountDir,
  accountHasCredentials,
  candidateHomes,
  claudeHomesForAccount,
  codexHomesForAccount,
  listAccounts,
  persistClaudeChain,
  readVaultClaudeChain,
  refreshClaudeOauthChain,
  saveClaudeOauthToVault,
  withAccountsLock,
} from "./accounts.js";
import { canonicalAgentKind } from "./agents.js";
import { launchEnv } from "./env.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { readClaudeKeychain } from "./keychain.js";
import { withFileLock } from "./lock.js";
import { providerAdapter } from "./providers.js";

export type { RefreshedClaudeToken } from "./accounts.js";
export { codexAuthEmail, emailFromJwt } from "./accounts.js";

// ──────────────────────────────────────────────────────────────────────────
// Provider limit windows (Phase 3 follow-up): remaining 5h/weekly usage
// relative to the REAL limits, per account.
//
//  - claude: the OAuth usage endpoint Claude Code's /usage panel uses
//    (GET api.anthropic.com/api/oauth/usage) — live utilization + reset
//    times. We query it with the freshest token we can find for the
//    account across the vault, home credential files, and keychain.
//  - codex: live via `codex app-server`'s account/rateLimits/read RPC (run
//    against the account's home). When the binary or RPC is unavailable we
//    fall back to the newest rate_limits snapshot codex wrote into its
//    session rollouts — only as fresh as the account's last local activity,
//    stamped asOf.
// ──────────────────────────────────────────────────────────────────────────

export type WindowUsage = {
  usedPercent: number;
  resetsAt?: string;
  /** Window length, when known (claude: implied 300/10080; codex: from the snapshot). */
  windowMinutes?: number;
};

/**
 * Pace: used% minus elapsed% of the window. Positive = burning faster than
 * the window refills (on track to exhaust before reset); negative = headroom.
 * Null when the window boundary is unknown or already passed.
 */
export function paceDelta(window: WindowUsage, now = Date.now()): number | null {
  if (!window.resetsAt || !window.windowMinutes) return null;
  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= now) return null;
  const durationMs = window.windowMinutes * 60_000;
  const elapsedPct = Math.min(100, Math.max(0, ((durationMs - (resetMs - now)) / durationMs) * 100));
  return window.usedPercent - elapsedPct;
}

/** True when the snapshot's window boundary has passed — its used% no longer applies. */
export function windowRolledOver(window: WindowUsage, now = Date.now()): boolean {
  if (!window.resetsAt) return false;
  const resetMs = Date.parse(window.resetsAt);
  return Number.isFinite(resetMs) && resetMs <= now;
}

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
  withAccountsLock?: <T>(fn: () => Promise<T>) => Promise<T>;
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

/**
 * Provider-keyed limits dispatch. A CYCLE-FREE hybrid: self-contained provider
 * fetchers (zai/minimax) live on the registry adapter in providers.ts (which
 * imports limits.ts as TYPES ONLY); the heavyweight anthropic/openai paths stay
 * in this module and are reached by an explicit provider check, so the registry
 * never has to import claudeLimits/codexLimits at runtime. Output for existing
 * claude/codex accounts is identical except for the additive `provider` field,
 * which is stamped uniformly below.
 */
export async function accountLimits(accounts: AccountRecord[], deps: LimitsDeps = {}): Promise<AccountLimits[]> {
  return Promise.all(
    accounts.map(async (account) => {
      // Dispatch on the effective provider: the record's own provider when
      // present, else inferred from its cli. Belt-and-suspenders so the dispatch
      // is robust even for a raw AccountRecord that never flowed through
      // listAccounts' backfill (callers normally pass normalized records). The
      // `provider` field is still STAMPED only from the literal account.provider,
      // so a normalized record's output is byte-identical and an un-normalized
      // one routes correctly without gaining a synthesized field.
      const provider = account.provider ?? PROVIDER_BY_CLI[account.tool];
      const stampProvider = (limits: AccountLimits): AccountLimits =>
        account.provider ? { ...limits, provider: account.provider } : limits;
      try {
        const adapter = providerAdapter(provider);
        if (adapter?.fetchLimits) return stampProvider(await adapter.fetchLimits(account, deps));
        if (provider === "anthropic") return stampProvider(await claudeLimits(account, deps));
        if (provider === "openai") return stampProvider(await codexLimits(account, deps));
        return stampProvider({
          account: account.id,
          tool: account.tool,
          ok: false,
          source: "unsupported" as const,
          // fix #8: never print "undefined …" for a provider-less (legacy
          // opencode) account.
          error: provider ? `${provider} has no limits source` : "account has no provider",
        });
      } catch (error) {
        return stampProvider({
          account: account.id,
          tool: account.tool,
          ok: false,
          source: provider === "anthropic" ? ("oauth-api" as const) : ("session-snapshot" as const),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}

/* ------------------------------------------------------------------ */
/* claude — live OAuth usage endpoint                                  */
/* ------------------------------------------------------------------ */

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

type ClaudeOauthCredentials = {
  accessToken: string;
  expiresAt: number;
  subscriptionType?: string;
  refreshToken?: string;
  /** The full claudeAiOauth object as found, for refresh persistence. */
  oauth: Record<string, unknown>;
  /** True when found in an account-attributed source (vault / email-matched home). */
  attributed: boolean;
  /** Where the candidate was found ("vault" or a home-derived label). */
  source: string;
};

async function claudeLimits(account: AccountRecord, deps: LimitsDeps): Promise<AccountLimits> {
  const now = (deps.now ?? Date.now)();
  const candidates = await claudeCredentialCandidates(account, deps.readKeychain ?? readClaudeKeychain);
  if (candidates.length === 0) {
    return {
      account: account.id,
      tool: account.tool,
      ok: false,
      source: "oauth-api",
      error: "no OAuth token found in vault, homes, or keychain",
    };
  }
  // A token's location does NOT prove its identity: vaults get mislabeled,
  // homes get re-logged-in, refresh keeps a wrong token fresh forever. Ask
  // the profile endpoint who each candidate actually is and use the first
  // (freshest) one that matches the account.
  const profileOf = deps.fetchClaudeProfileEmail ?? fetchClaudeProfileEmailCached;
  const expectedEmail = account.email ?? (account.label.includes("@") ? account.label : undefined);
  let credential: ClaudeOauthCredentials | undefined;
  const imposters = new Set<string>();
  let unverifiableFresh = 0;
  for (const candidate of candidates.filter((entry) => entry.expiresAt > now)) {
    if (!expectedEmail) {
      credential = candidate;
      break;
    }
    const actualEmail = await profileOf(candidate.accessToken).catch(() => null);
    if (actualEmail === expectedEmail) {
      credential = candidate;
      break;
    }
    if (actualEmail) imposters.add(actualEmail);
    else unverifiableFresh += 1;
  }

  // Mirror a verified fresher home token into the vault: claude refreshes on
  // use, so the live link usually sits in a home while the vault snapshot
  // ages. Catching the vault up here means activation never stamps the older
  // (possibly dead) link over the live one.
  if (credential && credential.source !== "vault" && (expectedEmail || credential.attributed)) {
    const vault = candidates.find((entry) => entry.source === "vault");
    if (!vault || credential.expiresAt > vault.expiresAt) {
      const persistVault = deps.persistVaultCredentials ?? saveClaudeOauthToVault;
      await persistVault(account, credential.oauth).catch(() => undefined);
    }
  }

  // No fresh matching token (access tokens live ~1-8h; only an actively
  // running claude keeps them warm). Refresh a stale chain: the long-lived
  // refreshToken mints a new token set. Refresh tokens ROTATE, so every
  // successful refresh is persisted immediately — vault + the account's
  // homes — or the chain would be orphaned. Two hard safety rails:
  //  - a fresh token whose identity could not be verified (profile endpoint
  //    unreachable) blocks ALL refreshing — it may be the live link of the
  //    very chain we'd rotate, and rotating it logs that session out;
  //  - only EXPIRED, account-attributed candidates are ever refreshed —
  //    rotating a fresh token, or one found in an unrelated home's keychain,
  //    would knife a live login.
  if (!credential) {
    if (unverifiableFresh > 0) {
      return {
        account: account.id,
        tool: account.tool,
        ok: false,
        source: "oauth-api",
        error: `found ${unverifiableFresh} fresh token(s) whose identity could not be verified (profile endpoint unreachable?); not refreshing — rotating a live session's chain would log it out`,
      };
    }
    const refresh = deps.refreshClaudeToken ?? refreshClaudeOauthChain;
    const persist = deps.persistRefreshedCredentials ?? persistClaudeChain;
    const attempted = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.expiresAt > now) continue;
      if (!candidate.attributed || !candidate.refreshToken || attempted.has(candidate.refreshToken)) continue;
      attempted.add(candidate.refreshToken);
      const refreshed = await refresh(candidate.refreshToken).catch(() => null);
      if (!refreshed) continue;
      const oauth: Record<string, unknown> = {
        ...candidate.oauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        ...(refreshed.scopes ? { scopes: refreshed.scopes } : {}),
      };
      const actualEmail = expectedEmail ? await profileOf(refreshed.accessToken).catch(() => null) : null;
      if (expectedEmail && actualEmail && actualEmail !== expectedEmail) {
        // The chain belongs to someone else (mislabeled source). Park the
        // rotated tokens with their real owner so the chain isn't lost.
        imposters.add(actualEmail);
        const owner = (await listAccounts()).find(
          (other) => other.tool === "claude" && (other.email ?? other.label) === actualEmail,
        );
        if (owner) await persist(owner, oauth).catch(() => undefined);
        continue;
      }
      await persist(account, oauth).catch(() => undefined);
      credential = {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        ...(typeof candidate.oauth.subscriptionType === "string" ? { subscriptionType: candidate.oauth.subscriptionType } : {}),
        oauth,
        refreshToken: refreshed.refreshToken,
        attributed: true,
        source: "refresh",
      };
      break;
    }
  }

  if (!credential) {
    return {
      account: account.id,
      tool: account.tool,
      ok: false,
      source: "oauth-api",
      error:
        imposters.size > 0
          ? `no token belongs to ${expectedEmail} (found: ${[...imposters].join(", ")}); re-login with: hive login ${account.id}`
          : `all ${candidates.length} token(s) expired and refresh failed; re-login with: hive login ${account.id}`,
    };
  }

  const fetcher = deps.fetchClaudeUsage ?? fetchClaudeUsage;
  const usage = await fetcher(credential.accessToken);
  const result: AccountLimits = {
    account: account.id,
    tool: account.tool,
    ok: true,
    source: "oauth-api",
    ...(credential.subscriptionType ? { plan: credential.subscriptionType } : {}),
  };
  if (typeof usage.five_hour?.utilization === "number") {
    result.fiveHour = { usedPercent: usage.five_hour.utilization, windowMinutes: 300, ...(usage.five_hour.resets_at ? { resetsAt: usage.five_hour.resets_at } : {}) };
  }
  if (typeof usage.seven_day?.utilization === "number") {
    result.weekly = { usedPercent: usage.seven_day.utilization, windowMinutes: 10_080, ...(usage.seven_day.resets_at ? { resetsAt: usage.seven_day.resets_at } : {}) };
  }
  // Fable included usage rides the limits[] array as a model-scoped weekly
  // entry (the legacy seven_day_<model> fields stay null on Claude 5 plans).
  const fable = usage.limits?.find(
    (entry) => entry?.kind === "weekly_scoped" && entry.scope?.model?.display_name === "Fable",
  );
  if (fable && typeof fable.percent === "number") {
    result.fableWeekly = { usedPercent: fable.percent, windowMinutes: 10_080, ...(fable.resets_at ? { resetsAt: fable.resets_at } : {}) };
  }
  if (!result.fiveHour && !result.weekly) {
    result.ok = false;
    result.error = "usage endpoint returned no windows";
  }
  return result;
}

async function fetchClaudeUsage(accessToken: string): Promise<ClaudeUsageResponse> {
  return claudeOauthGet(accessToken, "https://api.anthropic.com/api/oauth/usage") as Promise<ClaudeUsageResponse>;
}

/**
 * Token → verified email, memoized per process. A given access token's
 * identity never changes, so one profile round-trip per token is enough.
 * Without this, every limits sweep re-verifies every candidate — and the
 * freshest candidate (the daily driver's keychain chain) is a candidate for
 * EVERY account, so one `hive usage` costs O(accounts × candidates) profile
 * calls and a polling reader (the --live dashboard) rate-limits the OAuth
 * endpoints. Unverifiable lookups (null/error) are not cached — they retry.
 */
const profileEmailByToken = new Map<string, string>();

async function fetchClaudeProfileEmailCached(accessToken: string): Promise<string | null> {
  const cached = profileEmailByToken.get(accessToken);
  if (cached !== undefined) return cached;
  const email = await fetchClaudeProfileEmail(accessToken);
  if (email !== null) profileEmailByToken.set(accessToken, email);
  return email;
}

async function fetchClaudeProfileEmail(accessToken: string): Promise<string | null> {
  const profile = (await claudeOauthGet(accessToken, "https://api.anthropic.com/api/oauth/profile")) as {
    account?: { email?: unknown; email_address?: unknown };
  };
  const email = profile.account?.email ?? profile.account?.email_address;
  return typeof email === "string" ? email : null;
}

async function claudeOauthGet(accessToken: string, url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

/**
 * The vault copy of a claude token is a snapshot from capture time and may
 * be long expired while the account's active home holds a freshly refreshed
 * one (claude refreshes on use, file or keychain). Gather every candidate —
 * vault file, per-home credential files, per-home keychain entries — for
 * homes whose .claude.json email matches the account, freshest first.
 * Identity is verified separately: location is a heuristic, not proof.
 */
async function claudeCredentialCandidates(
  account: AccountRecord,
  readKeychain: typeof readClaudeKeychain,
): Promise<ClaudeOauthCredentials[]> {
  const candidates: ClaudeOauthCredentials[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null, attributed: boolean, source: string) => {
    const parsed = parseClaudeCredentials(raw, attributed, source);
    if (parsed && !seen.has(parsed.accessToken)) {
      seen.add(parsed.accessToken);
      candidates.push(parsed);
    }
  };

  push(await readFile(join(accountDir(account), ".credentials.json"), "utf8").catch(() => null), true, "vault");

  for (const home of await claudeHomesForAccount(account)) {
    push(await readFile(join(home, ".credentials.json"), "utf8").catch(() => null), true, `${home}:file`);
    push(await readKeychain(home), true, `${home}:keychain`);
  }

  // The account's true login may live in a home we cannot attribute (the
  // default ~/.claude has no in-home .claude.json). Include every claude
  // home's keychain as a last-resort candidate pool — identity verification
  // filters out the wrong ones, and these are never refresh-rotated.
  for (const home of await candidateHomes("claude")) {
    push(await readKeychain(home), false, `${home}:keychain`);
  }

  candidates.sort((a, b) => b.expiresAt - a.expiresAt);
  return candidates;
}

function parseClaudeCredentials(raw: string | null, attributed: boolean, source: string): ClaudeOauthCredentials | null {
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
      oauth,
      attributed,
      source,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* codex — rate_limits snapshots from session rollouts                 */
/* ------------------------------------------------------------------ */

type CodexRateLimits = {
  primary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
  secondary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
  plan_type?: string | null;
};

async function codexLimits(account: AccountRecord, deps: LimitsDeps = {}): Promise<AccountLimits> {
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
    if (limits.primary) result.fiveHour = liveWindow(limits.primary);
    if (limits.secondary) result.weekly = liveWindow(limits.secondary);
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
  if (typeof best.limits.primary?.used_percent === "number") {
    result.fiveHour = {
      usedPercent: best.limits.primary.used_percent,
      ...(best.limits.primary.resets_at ? { resetsAt: new Date(best.limits.primary.resets_at * 1000).toISOString() } : {}),
      ...(typeof best.limits.primary.window_minutes === "number" ? { windowMinutes: best.limits.primary.window_minutes } : {}),
    };
  }
  if (typeof best.limits.secondary?.used_percent === "number") {
    result.weekly = {
      usedPercent: best.limits.secondary.used_percent,
      ...(best.limits.secondary.resets_at ? { resetsAt: new Date(best.limits.secondary.resets_at * 1000).toISOString() } : {}),
      ...(typeof best.limits.secondary.window_minutes === "number" ? { windowMinutes: best.limits.secondary.window_minutes } : {}),
    };
  }
  return result;
}

export type CodexLiveWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
export type CodexLiveRateLimits = {
  primary?: CodexLiveWindow | null;
  secondary?: CodexLiveWindow | null;
  planType?: string | null;
};

function liveWindow(window: CodexLiveWindow): WindowUsage {
  return {
    usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : 0,
    ...(window.resetsAt ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() } : {}),
    ...(typeof window.windowDurationMins === "number" ? { windowMinutes: window.windowDurationMins } : {}),
  };
}

const CODEX_RPC_TIMEOUT_MS = 15_000;

/**
 * Query `codex app-server` (JSON-RPC over stdio) for the account's live rate
 * limits, with CODEX_HOME pointed at the account's home. Returns null on any
 * failure — missing binary, stale auth, protocol drift — so callers fall back
 * to the on-disk snapshot.
 */
async function fetchCodexLiveRateLimits(homePath: string): Promise<CodexLiveRateLimits | null> {
  return new Promise((resolve) => {
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
  });
}

/** Newest rate_limits event across the most recent rollout files. */
async function newestRateLimitSnapshot(sessionsDir: string): Promise<{ limits: CodexRateLimits; ts: string } | null> {
  const files: { path: string; mtimeMs: number }[] = [];
  await walk(sessionsDir, 5, async (path) => {
    if (!path.endsWith(".jsonl")) return;
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) files.push({ path, mtimeMs: info.mtimeMs });
  });
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // A fresh session may not have emitted token_count yet; look back a few files.
  for (const file of files.slice(0, 5)) {
    const snapshot = await lastRateLimitsInFile(file.path);
    if (snapshot) return snapshot;
  }
  return null;
}

export async function lastRateLimitsInFile(path: string): Promise<{ limits: CodexRateLimits; ts: string } | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
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

async function walk(dir: string, maxDepth: number, visit: (path: string) => Promise<void>): Promise<void> {
  if (maxDepth < 0) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, maxDepth - 1, visit);
    else if (entry.isFile()) await visit(path);
  }
}

export async function allAccountLimits(deps: LimitsDeps = {}): Promise<AccountLimits[]> {
  return accountLimits(await listAccounts(), deps);
}

/**
 * Display order for the limits table: claude first, codex next, everything
 * else grouped by tool name; registration order preserved within a group
 * (sort is stable), so accounts of one tool never interleave with another's.
 */
const LIMITS_DISPLAY_RANK: Record<string, number> = { claude: 0, codex: 1 };

export function sortAccountsForLimitsDisplay(accounts: AccountRecord[]): AccountRecord[] {
  return [...accounts].sort(
    (a, b) => (LIMITS_DISPLAY_RANK[a.tool] ?? 2) - (LIMITS_DISPLAY_RANK[b.tool] ?? 2) || a.tool.localeCompare(b.tool),
  );
}

/* ------------------------------------------------------------------ */
/* limits cache — every live read is snapshotted; readers may accept   */
/* an entry younger than their ttl instead of paying the round-trips   */
/* ------------------------------------------------------------------ */

export type LimitsCacheEntry = { fetchedAt: string; limits: AccountLimits };
type LimitsCache = Record<string, LimitsCacheEntry>;

export function limitsCachePath(): string {
  return join(storeRoot(), "limits-cache.json");
}

async function readLimitsCache(): Promise<LimitsCache> {
  const raw = await readFile(limitsCachePath(), "utf8").catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const cache: LimitsCache = {};
    for (const [account, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as LimitsCacheEntry;
      if (typeof candidate.fetchedAt !== "string" || !candidate.limits || typeof candidate.limits !== "object") continue;
      cache[account] = candidate;
    }
    return cache;
  } catch {
    return {};
  }
}

/** Snapshot successful reads into the cache; failures are never cached (they should retry, not stick). */
async function updateLimitsCache(results: AccountLimits[], now: number): Promise<void> {
  const fresh = results.filter((result) => result.ok);
  if (fresh.length === 0) return;
  await withFileLock(`${limitsCachePath()}.lock`, async () => {
    const cache = await readLimitsCache();
    for (const result of fresh) {
      const { cached: _cached, ...limits } = result;
      cache[result.account] = { fetchedAt: new Date(now).toISOString(), limits };
    }
    await atomicWriteFile(limitsCachePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  });
}

export type CachedLimitsOptions = LimitsDeps & {
  /** Serve cache entries younger than this; missing/0 → always fetch live. */
  ttlMs?: number;
  /** Live fetch override (tests). Defaults to accountLimits. */
  fetchLimits?: typeof accountLimits;
};

/**
 * accountLimits behind the on-disk cache. Per account: a cache entry younger
 * than ttlMs is served as-is (flagged `cached`, asOf falling back to fetch
 * time); anything older or missing is fetched live, and every successful live
 * read refreshes the cache — including ttl-less calls, so a plain
 * `hive limits` keeps the cache warm for later cached readers.
 */
export async function cachedAccountLimits(accounts: AccountRecord[], options: CachedLimitsOptions = {}): Promise<AccountLimits[]> {
  const now = (options.now ?? Date.now)();
  const ttlMs = options.ttlMs ?? 0;
  const cache = ttlMs > 0 ? await readLimitsCache() : {};
  const hits = new Map<string, AccountLimits>();
  const misses: AccountRecord[] = [];
  for (const account of accounts) {
    const entry = cache[account.id];
    const age = entry ? now - Date.parse(entry.fetchedAt) : Number.NaN;
    if (entry && Number.isFinite(age) && age >= 0 && age <= ttlMs) {
      hits.set(account.id, { ...entry.limits, cached: true, asOf: entry.limits.asOf ?? entry.fetchedAt });
    } else {
      misses.push(account);
    }
  }
  const fetchLimits = options.fetchLimits ?? accountLimits;
  const fetched = misses.length > 0 ? await fetchLimits(misses, options) : [];
  if (fetched.length > 0) await updateLimitsCache(fetched, now).catch(() => undefined);
  const fetchedById = new Map(fetched.map((result) => [result.account, result]));
  return accounts
    .map((account) => hits.get(account.id) ?? fetchedById.get(account.id))
    .filter((result): result is AccountLimits => result !== undefined);
}

/* ------------------------------------------------------------------ */
/* auto account pick — least-loaded account of a tool                  */
/* ------------------------------------------------------------------ */

/**
 * A 5h window at/above this used% is "really close to the limit": the account
 * is deprioritized even when its weekly usage is the lowest, so a fresh bee
 * does not land on an account about to hit the short-window wall. Matches the
 * red zone of the usage bars.
 */
export const AUTO_FIVE_HOUR_SATURATION_PERCENT = 90;

/**
 * Headroom below which pace stops mattering in the auto pick. An account
 * behind pace but with almost nothing left (98% used, resets in an hour)
 * would win a pure pace contest yet blow through its remaining 2% long
 * before the reset — so pace's weight fades linearly to zero as headroom
 * drops below this threshold, letting raw used% dominate near the wall.
 */
export const AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT = 25;

/**
 * Effective load of a window for the auto pick (lower = better). Raw used%
 * adjusted by pace (used% − elapsed%): an account behind pace holds unused
 * quota that expires at reset, so it scores lower (burn its surplus first);
 * an account ahead of pace is on track to exhaust early, so it scores
 * higher. Pace's influence is weighted by remaining headroom (see
 * AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT) so a nearly-exhausted window
 * never wins on pace alone. Falls back to raw used% when the window
 * boundary is unknown; a rolled-over window is fresh (0).
 */
export function effectiveWindowLoad(window: WindowUsage, now = Date.now()): number {
  if (windowRolledOver(window, now)) return 0;
  const used = window.usedPercent;
  const pace = paceDelta(window, now);
  if (pace === null) return used;
  const headroom = Math.max(0, 100 - used);
  const paceWeight = Math.min(1, headroom / AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT);
  return paceWeight * pace + (1 - paceWeight) * used;
}

export type AutoAccountCandidate = { account: AccountRecord; limits?: AccountLimits };

export type AutoAccountChoice = {
  account: AccountRecord;
  /** The winning account's limits, when they were readable. */
  limits?: AccountLimits;
  /** Why this account won, for display. */
  reason: string;
};

/**
 * Order: readable limits before unreadable; 5h headroom before 5h-saturated;
 * then least pace-adjusted weekly load (see effectiveWindowLoad — an account
 * whose unused quota expires at an imminent reset scores below one that is
 * burning ahead of pace; a rolled-over window counts as 0; a missing weekly
 * window falls back to the 5h one); raw 5h used% and registration order as
 * the deterministic tie-breaks. Null only for an empty candidate list.
 */
export function selectLeastLoadedAccount(candidates: AutoAccountCandidate[], now = Date.now()): AutoAccountChoice | null {
  const rawScore = (window: WindowUsage | undefined): number | null =>
    window ? (windowRolledOver(window, now) ? 0 : window.usedPercent) : null;
  const paceScore = (window: WindowUsage | undefined): number | null =>
    window ? effectiveWindowLoad(window, now) : null;
  const scored = candidates.map(({ account, limits }) => {
    const ok = limits?.ok === true;
    // Saturation and the tie-break stay on RAW 5h used% — a saturated short
    // window is a wall regardless of how favorable its pace looks.
    const fiveHour = ok ? rawScore(limits?.fiveHour) : null;
    const weekly = ok ? (paceScore(limits?.weekly) ?? paceScore(limits?.fiveHour)) : null;
    return {
      account,
      limits,
      ok,
      weekly: weekly ?? 0,
      fiveHour: fiveHour ?? 0,
      saturated: ok && fiveHour !== null && fiveHour >= AUTO_FIVE_HOUR_SATURATION_PERCENT,
    };
  });
  scored.sort(
    (a, b) =>
      Number(!a.ok) - Number(!b.ok) ||
      Number(a.saturated) - Number(b.saturated) ||
      a.weekly - b.weekly ||
      a.fiveHour - b.fiveHour ||
      a.account.addedAt.localeCompare(b.account.addedAt) ||
      a.account.id.localeCompare(b.account.id),
  );
  const best = scored[0];
  if (!best) return null;
  const reason = !best.ok
    ? "limits unreadable for every account; oldest registration"
    : best.saturated
      ? "every account is close to its 5h limit; least effective weekly load"
      : autoPickWeeklyReason(best.limits, now);
  return { account: best.account, ...(best.ok && best.limits ? { limits: best.limits } : {}), reason };
}

/** Why the winner won, pace-aware: names the expiring surplus / overpace when the window boundary is known. */
function autoPickWeeklyReason(limits: AccountLimits | undefined, now: number): string {
  const window = limits?.weekly ?? limits?.fiveHour;
  const pace = window && !windowRolledOver(window, now) ? paceDelta(window, now) : null;
  if (pace === null) return "least weekly usage";
  const rounded = Math.round(Math.abs(pace));
  if (pace <= -3) return `least effective weekly load (${rounded}% behind pace — surplus expires at reset)`;
  if (pace >= 3) return `least effective weekly load (${rounded}% ahead of pace)`;
  return "least effective weekly load (on pace)";
}

/** Default freshness budget for the auto pick: cached limits younger than this are good enough. */
export const AUTO_ACCOUNT_TTL_MS = 60 * 60 * 1000;

export type PickAccountDeps = CachedLimitsOptions & {
  hasCredentials?: typeof accountHasCredentials;
};

/**
 * Resolve the `auto` account query: among the tool's accounts with vaulted
 * credentials, pick the one with the least pace-adjusted weekly load (an
 * imminent reset with unused quota beats a nominally lower used%), pushing
 * accounts whose 5h window is nearly exhausted to the back. Limits come through the
 * cache with a 1h default ttl, so back-to-back auto spawns do not re-pay the
 * provider round-trips; pass ttlMs (0 = always live) to override.
 */
export async function pickLeastLoadedAccount(tool: string, deps: PickAccountDeps = {}): Promise<AutoAccountChoice> {
  const kind = canonicalAgentKind(tool).toLowerCase();
  const registered = (await listAccounts()).filter((account) => account.tool === kind);
  if (registered.length === 0) {
    throw new Error(`No ${kind} accounts registered; add one with: hive account add ${kind} <label>`);
  }
  const hasCredentials = deps.hasCredentials ?? accountHasCredentials;
  const candidates: AccountRecord[] = [];
  for (const account of registered) {
    if (await hasCredentials(account)) candidates.push(account);
  }
  if (candidates.length === 0) {
    throw new Error(`No ${kind} account has vaulted credentials; capture some with: hive login <account>`);
  }
  // A single candidate wins regardless of usage — skip the limits round-trips.
  if (candidates.length === 1) {
    return { account: candidates[0]!, reason: `only ${kind} account with credentials` };
  }
  const results = await cachedAccountLimits(candidates, { ...deps, ttlMs: deps.ttlMs ?? AUTO_ACCOUNT_TTL_MS });
  const byId = new Map(results.map((result) => [result.account, result]));
  const now = (deps.now ?? Date.now)();
  return selectLeastLoadedAccount(candidates.map((account) => ({ account, limits: byId.get(account.id) })), now)!;
}
