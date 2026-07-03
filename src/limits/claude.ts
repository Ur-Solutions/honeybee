// ──────────────────────────────────────────────────────────────────────────
// claude — live OAuth usage endpoint.
//
// The OAuth usage endpoint Claude Code's /usage panel uses
// (GET api.anthropic.com/api/oauth/usage) — live utilization + reset times. We
// query it with the freshest token we can find for the account across the
// vault, home credential files, and keychain, verifying each candidate's
// identity against the account before trusting it, and refreshing an expired
// chain when no fresh matching token exists.
// ──────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccountRecord,
  accountDir,
  candidateHomes,
  claudeHomesForAccount,
  listAccounts,
  persistClaudeChainLocked,
  readVaultClaudeChain,
  refreshClaudeOauthChain,
  saveClaudeOauthToVault,
  CROSS_ACCOUNT_LOCK_TIMEOUT_MS,
  withAccountLock,
} from "../accounts.js";
import { readClaudeKeychain } from "../keychain.js";
import type { AccountLimits, ClaudeUsageResponse, LimitsDeps } from "./types.js";

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

export async function claudeLimits(account: AccountRecord, deps: LimitsDeps): Promise<AccountLimits> {
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
  let unattributedFresh = 0;
  for (const candidate of candidates.filter((entry) => entry.expiresAt > now)) {
    if (!expectedEmail) {
      // No email to verify against, so only account-attributed sources
      // (vault + dedicated homes) can be trusted. An unattributed keychain
      // entry scraped from a shared ~/.claude* home is most likely another
      // account's daily-driver login — using it would misattribute that
      // account's usage here and skew the `auto` least-loaded pick.
      if (candidate.attributed) {
        credential = candidate;
        break;
      }
      unattributedFresh += 1;
      continue;
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
    const persist = deps.persistRefreshedCredentials ?? persistClaudeChainLocked;
    const readVault = deps.readVaultChain ?? readVaultClaudeChain;
    const lock = deps.withAccountLock ?? (<T>(fn: () => Promise<T>) => withAccountLock(account.id, fn));
    // HIVE-2: refresh+persist is a read-modify-write of the account's chain,
    // and refresh tokens rotate — two concurrent refreshes (say, the --live
    // dashboard and an activation both hitting one expired account) replay
    // the same refresh token, which trips the provider's reuse detection and
    // can revoke the whole chain, logging the live session out. Take the same
    // per-account lock as activation's refresh path, and double-check the
    // vault inside it: a writer that beat us to the rotation left a fresh
    // chain to use instead of replaying the now-dead token.
    credential = await lock<ClaudeOauthCredentials | undefined>(async () => {
      const attempted = new Set<string>();
      const vaultNow = await readVault(account).catch(() => null);
      if (vaultNow && vaultNow.expiresAt > now && typeof vaultNow.oauth.accessToken === "string") {
        const accessToken = vaultNow.oauth.accessToken;
        const actualEmail = expectedEmail ? await profileOf(accessToken).catch(() => null) : null;
        if (!expectedEmail || actualEmail === expectedEmail) {
          return {
            accessToken,
            expiresAt: vaultNow.expiresAt,
            ...(typeof vaultNow.oauth.subscriptionType === "string" ? { subscriptionType: vaultNow.oauth.subscriptionType } : {}),
            oauth: vaultNow.oauth,
            ...(vaultNow.refreshToken ? { refreshToken: vaultNow.refreshToken } : {}),
            attributed: true,
            source: "vault",
          };
        }
        if (actualEmail) imposters.add(actualEmail);
      }
      // Even when the rotated-behind-us chain is unusable here (imposter, or
      // itself expired again), never replay the superseded vault token — that
      // replay IS the reuse-detection trip this lock exists to prevent.
      if (vaultNow?.refreshToken) {
        for (const candidate of candidates) {
          if (candidate.source === "vault" && candidate.refreshToken && candidate.refreshToken !== vaultNow.refreshToken) {
            attempted.add(candidate.refreshToken);
          }
        }
      }
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
          // rotated tokens with their real owner so the chain isn't lost —
          // under the OWNER's per-account lock (we hold only this account's),
          // best-effort with the short cross-account timeout.
          imposters.add(actualEmail);
          const owner = (await listAccounts()).find(
            (other) => other.tool === "claude" && (other.email ?? other.label) === actualEmail,
          );
          if (owner) {
            await withAccountLock(owner.id, () => persist(owner, oauth), { timeoutMs: CROSS_ACCOUNT_LOCK_TIMEOUT_MS }).catch(() => undefined);
          }
          continue;
        }
        await persist(account, oauth).catch(() => undefined);
        return {
          accessToken: refreshed.accessToken,
          expiresAt: refreshed.expiresAt,
          ...(typeof candidate.oauth.subscriptionType === "string" ? { subscriptionType: candidate.oauth.subscriptionType } : {}),
          oauth,
          refreshToken: refreshed.refreshToken,
          attributed: true,
          source: "refresh",
        };
      }
      return undefined;
    });
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
          : unattributedFresh > 0
            ? `found ${unattributedFresh} fresh token(s) only in shared homes, but the account has no email to verify them against; log in with: hive login ${account.id}, or re-add with --email`
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
 * endpoints.
 *
 * Access tokens rotate regularly and are secret material, so keep only a
 * bounded recent set. Unverifiable lookups (null/error) are not cached — they
 * retry.
 */
export const CLAUDE_PROFILE_EMAIL_CACHE_MAX = 128;

const profileEmailByToken = new Map<string, string>();

async function fetchClaudeProfileEmailCached(accessToken: string): Promise<string | null> {
  const cached = getCachedClaudeProfileEmail(accessToken);
  if (cached !== undefined) return cached;
  const email = await fetchClaudeProfileEmail(accessToken);
  if (email !== null) rememberClaudeProfileEmail(accessToken, email);
  return email;
}

function getCachedClaudeProfileEmail(accessToken: string): string | undefined {
  const cached = profileEmailByToken.get(accessToken);
  if (cached === undefined) return undefined;
  profileEmailByToken.delete(accessToken);
  profileEmailByToken.set(accessToken, cached);
  return cached;
}

function rememberClaudeProfileEmail(accessToken: string, email: string): void {
  if (profileEmailByToken.has(accessToken)) profileEmailByToken.delete(accessToken);
  profileEmailByToken.set(accessToken, email);
  while (profileEmailByToken.size > CLAUDE_PROFILE_EMAIL_CACHE_MAX) {
    const oldest = profileEmailByToken.keys().next();
    if (oldest.done) return;
    profileEmailByToken.delete(oldest.value);
  }
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
  // filters out the wrong ones, they are never refresh-rotated, and
  // email-less accounts (nothing to verify against) never use them at all.
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
