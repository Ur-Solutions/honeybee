import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readClaudeKeychain, writeClaudeKeychainEntry } from "../keychain.js";
import { atomicWriteFile } from "../fsx.js";
import { appendLedger } from "../store.js";
import { accountDir, withAccountLock, listAccounts, CROSS_ACCOUNT_LOCK_TIMEOUT_MS, type AccountRecord } from "./registry.js";
import { accountEmail } from "./utils.js";
import { candidateHomes, dedicatedHomesFor } from "./homes.js";

function decodeClaudeCredentialsRaw(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return raw;
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(trimmed)) return raw;
  try {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    return decoded.trimStart().startsWith("{") ? decoded : raw;
  } catch {
    return raw;
  }
}

export function claudeTokenExpiry(raw: string): number | null {
  const decoded = decodeClaudeCredentialsRaw(raw);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as { claudeAiOauth?: { expiresAt?: unknown } };
    return typeof parsed.claudeAiOauth?.expiresAt === "number" ? parsed.claudeAiOauth.expiresAt : null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Claude OAuth chain plumbing. Anthropic ROTATES refresh tokens: every
// refresh mints a new refresh token and invalidates the previous one, so
// exactly one link of a chain is alive at any time — and it lives wherever
// the last refresh happened (usually a running claude's home keychain, NOT
// the vault snapshot). Replaying a dead link logs the session out and can
// trip the provider's reuse detection, revoking the live link too — which is
// how "open a second session, both get logged out" happens. Everything below
// keeps the vault tracking the live link instead of stamping dead links over
// live ones.
// ──────────────────────────────────────────────────────────────────────────

export type ClaudeChain = {
  /** Full decoded credentials JSON (preserves sibling keys like mcpOAuth). */
  raw: string;
  oauth: Record<string, unknown>;
  expiresAt: number;
  refreshToken?: string;
  /** Where this link was found — for ledger/debugging. */
  source: string;
};

export type RefreshedClaudeToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
};

/** Narrow slice of ActivateAccountOptions the stale-chain refresh needs. */
export type ClaudeRefreshOptions = {
  refreshClaudeToken?: (refreshToken: string) => Promise<RefreshedClaudeToken | null>;
  now?: () => number;
};

export function parseClaudeChain(raw: string | null, source: string): ClaudeChain | null {
  const decoded = decodeClaudeCredentialsRaw(raw);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || typeof oauth.expiresAt !== "number") return null;
    return {
      raw: decoded,
      oauth,
      expiresAt: oauth.expiresAt,
      ...(typeof oauth.refreshToken === "string" ? { refreshToken: oauth.refreshToken } : {}),
      source,
    };
  } catch {
    return null;
  }
}

function isBetterClaudeChain(candidate: ClaudeChain, current: ClaudeChain | null): boolean {
  if (!current) return true;
  if (candidate.raw === current.raw) return false;
  // Refreshability outranks expiry: a refreshable link can always be renewed,
  // while a link without a refresh token becomes an unrecoverable activation
  // the moment it expires. Trading a refresh token away for a later expiry
  // would strand the whole chain.
  if (candidate.refreshToken && !current.refreshToken) return true;
  if (!candidate.refreshToken && current.refreshToken) return false;
  return candidate.expiresAt > current.expiresAt;
}

/** The freshest chain link present in a home — its keychain entry or credentials file. */
export async function readHomeClaudeChain(homePath: string): Promise<ClaudeChain | null> {
  const fromFile = parseClaudeChain(await readFile(join(homePath, ".credentials.json"), "utf8").catch(() => null), `${homePath}:file`);
  const fromKeychain = parseClaudeChain(await readClaudeKeychain(homePath), `${homePath}:keychain`);
  if (fromFile && fromKeychain) return isBetterClaudeChain(fromKeychain, fromFile) ? fromKeychain : fromFile;
  return fromKeychain ?? fromFile;
}

/** Logged-in email recorded in a home's .claude.json; null when unknown. */
export async function homeClaudeEmail(homePath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(homePath, ".claude.json"), "utf8")) as { oauthAccount?: { emailAddress?: unknown } };
    return typeof parsed.oauthAccount?.emailAddress === "string" ? parsed.oauthAccount.emailAddress : null;
  } catch {
    return null;
  }
}

/** Homes attributable to the account: dedicated slots + email-matched shared homes. */
export async function claudeHomesForAccount(account: AccountRecord): Promise<string[]> {
  const matched: string[] = [];
  // The account's dedicated slots are theirs by construction.
  for (const dir of dedicatedHomesFor(account)) {
    if ((await stat(dir).catch(() => null))?.isDirectory()) matched.push(dir);
  }
  // Shared/legacy homes are claimed by the logged-in email in .claude.json.
  const email = accountEmail(account);
  if (!email) return matched;
  for (const home of await candidateHomes("claude")) {
    if ((await homeClaudeEmail(home)) === email) matched.push(home);
  }
  return matched;
}

/** True when a home is attributable to the account (dedicated slot or matching login email). */
export async function homeBelongsToAccount(homePath: string, account: AccountRecord): Promise<boolean> {
  const target = resolve(homePath);
  if (dedicatedHomesFor(account).some((dir) => resolve(dir) === target)) return true;
  const email = accountEmail(account);
  if (!email) return false;
  return (await homeClaudeEmail(homePath)) === email;
}

/**
 * Overlay the source credentials JSON over the target's, preserving
 * target-only sibling keys (a home's mcpOAuth survives an identity stamp).
 */
export function mergeCredentialsJson(targetRaw: string | null, sourceRaw: string): string {
  const sourceText = decodeClaudeCredentialsRaw(sourceRaw) ?? sourceRaw;
  try {
    const targetText = targetRaw ? decodeClaudeCredentialsRaw(targetRaw) : null;
    const target = targetText ? (JSON.parse(targetText) as unknown) : {};
    const source = JSON.parse(sourceText) as Record<string, unknown>;
    if (!target || typeof target !== "object" || Array.isArray(target)) return sourceText;
    return JSON.stringify({ ...(target as Record<string, unknown>), ...source }, null, 2);
  } catch {
    return sourceText;
  }
}

export async function saveClaudeChainToVaultLocked(account: AccountRecord, sourceRaw: string): Promise<void> {
  const vaultPath = join(accountDir(account), ".credentials.json");
  const existing = await readFile(vaultPath, "utf8").catch(() => null);
  await mkdir(dirname(vaultPath), { recursive: true, mode: 0o700 });
  await atomicWriteFile(vaultPath, `${mergeCredentialsJson(existing, sourceRaw)}\n`, { mode: 0o600 });
}

/** Write a chain's claudeAiOauth into the vault file, preserving sibling keys. */
export async function saveClaudeOauthToVault(account: AccountRecord, oauth: Record<string, unknown>): Promise<void> {
  await withAccountLock(account.id, async () => {
    await saveClaudeChainToVaultLocked(account, JSON.stringify({ claudeAiOauth: oauth }));
    await appendLedger({ type: "account.chain-sync", account: account.id, from: "verified-credential" });
  });
}

export type ChainSyncResult = { chain: ClaudeChain | null; vaultUpdated: boolean };

export type ChainSyncDeps = {
  /** Resolve a fresh token's identity (tests inject; default is the memoized OAuth profile lookup). */
  fetchProfileEmail?: (accessToken: string) => Promise<string | null>;
  now?: () => number;
};

/**
 * Token → verified email via the OAuth profile endpoint, memoized per process:
 * a given access token's identity never changes, so one round-trip per token
 * is enough. Unverifiable lookups (no email, HTTP error) are not cached.
 */
const claudeTokenEmailCache = new Map<string, string>();

export async function claudeProfileEmailCached(accessToken: string): Promise<string | null> {
  const cached = claudeTokenEmailCache.get(accessToken);
  if (cached !== undefined) return cached;
  const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
    headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`/api/oauth/profile: HTTP ${response.status}`);
  const profile = (await response.json()) as { account?: { email?: unknown; email_address?: unknown } };
  const email = profile.account?.email ?? profile.account?.email_address;
  if (typeof email !== "string") return null;
  claudeTokenEmailCache.set(accessToken, email);
  return email;
}

/**
 * Pull the freshest attributed chain link into the vault. Reads the vault
 * snapshot plus every home attributable to the account (and extraHome when
 * attributable); when a home holds a fresher link than the vault — a
 * running or past claude rotated the chain there — the vault catches up, so
 * a later activation does not stamp a dead link over a live one.
 */
export async function syncClaudeChainToVault(account: AccountRecord, extraHome?: string, deps: ChainSyncDeps = {}): Promise<ChainSyncResult> {
  return withAccountLock(account.id, () => syncClaudeChainToVaultLocked(account, extraHome, deps));
}

export async function syncClaudeChainToVaultLocked(account: AccountRecord, extraHome?: string, deps: ChainSyncDeps = {}): Promise<ChainSyncResult> {
  const vaultPath = join(accountDir(account), ".credentials.json");
  const vault = parseClaudeChain(await readFile(vaultPath, "utf8").catch(() => null), "vault");
  const homes = new Map<string, string>();
  for (const home of await claudeHomesForAccount(account)) homes.set(resolve(home), home);
  if (extraHome && !homes.has(resolve(extraHome)) && (await homeBelongsToAccount(extraHome, account))) {
    homes.set(resolve(extraHome), extraHome);
  }
  const expected = accountEmail(account);
  const profileOf = deps.fetchProfileEmail ?? claudeProfileEmailCached;
  const nowMs = (deps.now ?? Date.now)();
  let best = vault;
  for (const home of homes.values()) {
    const chain = await readHomeClaudeChain(home);
    if (!chain || !isBetterClaudeChain(chain, best)) continue;
    // Adopting a home chain rewrites the vault — the one moment a foreign
    // chain can hijack the account. A dedicated home is the account's by
    // construction, but its CONTENTS may not be: racing account swaps stamp
    // another account's chain into it, and the home's .claude.json marker
    // cannot be trusted mid-stamp (seen live: a swap race parked a digitech
    // chain in gmail's vault and orphaned a third account's chain entirely).
    // So verify fresh adoption candidates against the profile endpoint: a
    // VERIFIED imposter is parked with its real owner and skipped. An
    // unverifiable chain (expired, endpoint unreachable) is adopted as
    // before — sync exists to rescue rotated links, and orphaning one on a
    // network blip is worse than the residual risk. Verification only fires
    // when the chain differs from the vault's, so steady-state activations
    // pay no extra round-trips (and lookups are memoized per token).
    if (expected && chain.expiresAt > nowMs) {
      const actual = await profileOf(String(chain.oauth.accessToken)).catch(() => null);
      if (actual && actual !== expected) {
        await parkClaudeChainWithOwnerLocked(chain, actual, account).catch(() => undefined);
        continue;
      }
    }
    best = chain;
  }
  if (!best || best === vault) return { chain: best, vaultUpdated: false };
  await saveClaudeChainToVaultLocked(account, best.raw);
  await appendLedger({
    type: "account.chain-sync",
    account: account.id,
    from: best.source,
    expiresAt: new Date(best.expiresAt).toISOString(),
  });
  return { chain: best, vaultUpdated: true };
}

/**
 * Freshness-guarded write of a verified foreign chain into its owner's vault —
 * the sync-side twin of evacuateForeignClaudeChainLocked. Turning a would-be
 * hijack into a rescue makes the sweep self-healing: an account whose live
 * link is stranded in another account's home gets it back on the next sync.
 */
async function parkClaudeChainWithOwnerLocked(chain: ClaudeChain, email: string, notAccount: AccountRecord): Promise<void> {
  const owner = (await listAccounts()).find(
    (candidate) => candidate.tool === "claude" && candidate.id !== notAccount.id && accountEmail(candidate) === email,
  );
  if (!owner) return;
  const vault = parseClaudeChain(await readFile(join(accountDir(owner), ".credentials.json"), "utf8").catch(() => null), "vault");
  if (vault && vault.expiresAt >= chain.expiresAt) return;
  await saveClaudeChainToVaultLocked(owner, chain.raw);
  await appendLedger({ type: "account.chain-evacuate", account: owner.id, home: chain.source });
}

/**
 * The home being activated may hold ANOTHER account's chain whose live link
 * exists nowhere else. Rescue it into its owner's vault (freshness-guarded)
 * before the stamp destroys it. Called while holding the ACTIVATING account's
 * lock; the rescue itself takes the OWNER's lock so it cannot interleave with
 * the owner's own refresh/persist of the same vault file.
 */
export async function evacuateForeignClaudeChain(account: AccountRecord, homePath: string): Promise<void> {
  const occupant = await readHomeClaudeChain(homePath);
  if (!occupant) return;
  const email = await homeClaudeEmail(homePath);
  if (!email || email === accountEmail(account)) return;
  const owner = (await listAccounts()).find(
    (candidate) => candidate.tool === "claude" && candidate.id !== account.id && accountEmail(candidate) === email,
  );
  if (!owner) return;
  await withAccountLock(owner.id, async () => {
    const vault = parseClaudeChain(await readFile(join(accountDir(owner), ".credentials.json"), "utf8").catch(() => null), "vault");
    if (vault && vault.expiresAt >= occupant.expiresAt) return;
    await saveClaudeChainToVaultLocked(owner, occupant.raw);
    await appendLedger({ type: "account.chain-evacuate", account: owner.id, home: homePath });
  }, { timeoutMs: CROSS_ACCOUNT_LOCK_TIMEOUT_MS });
}

// Claude Code's public OAuth client id (the same one the CLI itself uses).
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Mint a new token set from a refresh token. ROTATES the chain — persist immediately. */
export async function refreshClaudeOauthChain(refreshToken: string): Promise<RefreshedClaudeToken | null> {
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const fresh = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof fresh.access_token !== "string") return null;
  return {
    accessToken: fresh.access_token,
    refreshToken: typeof fresh.refresh_token === "string" ? fresh.refresh_token : refreshToken,
    expiresAt: Date.now() + (typeof fresh.expires_in === "number" ? fresh.expires_in : 3600) * 1000,
    ...(typeof fresh.scope === "string" ? { scopes: fresh.scope.split(" ") } : {}),
  };
}

/**
 * Persist a refreshed (rotated!) chain everywhere it lives: the vault file,
 * plus the keychain entry and credentials file of each attributable home —
 * merged, so sibling keys (mcpOAuth, ...) survive. Skipping any copy would
 * orphan that copy on a dead link.
 *
 * Caller MUST hold the account's withAccountLock (which is not reentrant, so
 * it cannot be taken here): an unlocked refresh+persist races activation's
 * refresh of the same chain, and replaying a rotated refresh token trips the
 * provider's reuse detection — revoking the chain and logging live sessions
 * out (HIVE-2).
 */
export async function persistClaudeChainLocked(account: AccountRecord, oauth: Record<string, unknown>): Promise<void> {
  const sourceRaw = JSON.stringify({ claudeAiOauth: oauth });
  await saveClaudeChainToVaultLocked(account, sourceRaw);
  for (const home of await claudeHomesForAccount(account)) {
    try {
      const existingEntry = await readClaudeKeychain(home);
      const keychainWrite = await writeClaudeKeychainEntry(home, mergeCredentialsJson(existingEntry, sourceRaw));
      // A failed or degraded keychain write MUST be visible: claude prefers
      // the keychain over .credentials.json, so a home whose file is fresh
      // but whose keychain kept a previous identity silently bills every bee
      // on it to the wrong account until someone reads the invoice (HIVE-2
      // territory, observed live 2026-07-03).
      if (!keychainWrite.ok && keychainWrite.reason !== "unavailable") {
        await appendLedger({ type: "account.keychain-write-failed", account: account.id, home, reason: keychainWrite.reason }).catch(() => {});
      } else if (keychainWrite.ok && keychainWrite.mode === "identity-only") {
        await appendLedger({ type: "account.keychain-write-degraded", account: account.id, home, dropped: "sibling-keys" }).catch(() => {});
      }
      // Only update home files that already exist — refresh propagation must
      // not seed credentials into homes that never held them.
      const filePath = join(home, ".credentials.json");
      const existingFile = await readFile(filePath, "utf8").catch(() => null);
      if (existingFile !== null) {
        await atomicWriteFile(filePath, `${mergeCredentialsJson(existingFile, sourceRaw)}\n`, { mode: 0o600 });
      }
    } catch (error) {
      // Best effort per home, but never silently: a swallowed propagation
      // failure leaves this home on a dead link with no trace to debug from.
      const message = error instanceof Error ? error.message : String(error);
      await appendLedger({ type: "account.chain-propagation-failed", account: account.id, home, error: message }).catch(() => {});
    }
  }
  await appendLedger({ type: "account.token-refresh", account: account.id });
}

// Refresh slightly before the deadline so claude never boots onto a token
// that expires mid-handshake.
const CHAIN_EXPIRY_SKEW_MS = 60_000;

export async function refreshVaultClaudeChainIfStaleLocked(account: AccountRecord, options: ClaudeRefreshOptions): Promise<void> {
  const now = (options.now ?? Date.now)();
  const vaultPath = join(accountDir(account), ".credentials.json");
  const chain = parseClaudeChain(await readFile(vaultPath, "utf8").catch(() => null), "vault");
  if (!chain || chain.expiresAt > now + CHAIN_EXPIRY_SKEW_MS) return;
  if (!chain.refreshToken) {
    throw new Error("expired token has no refresh token");
  }
  const refresh = options.refreshClaudeToken ?? refreshClaudeOauthChain;
  const refreshed = await refresh(chain.refreshToken);
  if (!refreshed) {
    throw new Error("provider rejected the refresh token");
  }
  const oauth: Record<string, unknown> = {
    ...chain.oauth,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    ...(refreshed.scopes ? { scopes: refreshed.scopes } : {}),
  };
  await persistClaudeChainLocked(account, oauth);
}

/**
 * Read the account's CURRENT vault Claude chain. Used as a post-lock re-check:
 * a caller that took withAccountLock before rotating a chain re-reads here to
 * see whether another writer already refreshed it while it waited (HIVE-2),
 * avoiding a redundant — and reuse-detection-tripping — refresh-token replay.
 */
export async function readVaultClaudeChain(account: AccountRecord): Promise<ClaudeChain | null> {
  const vaultPath = join(accountDir(account), ".credentials.json");
  return parseClaudeChain(await readFile(vaultPath, "utf8").catch(() => null), "vault");
}
