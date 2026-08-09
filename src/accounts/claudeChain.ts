import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as keychain from "../keychain.js";
import { atomicWriteFile } from "../fsx.js";
import { appendLedger } from "../store.js";
import { accountDir, withAccountLock, listAccounts, CROSS_ACCOUNT_LOCK_TIMEOUT_MS, type AccountRecord } from "./registry.js";
import { accountEmail } from "./utils.js";
import { candidateHomes, dedicatedHomesFor } from "./homes.js";
import type { CredentialSyncSkip, SyncAccountCredentialsOptions } from "./credentialSync.js";

type RawClaudeKeychainReader = (homePath: string) => Promise<keychain.ClaudeKeychainReadResult>;

function defaultRawClaudeKeychainReader(): RawClaudeKeychainReader {
  // Chain selection must inspect the exact representation Claude receives,
  // never the compatibility-decoded migration view that can hide hex damage.
  return keychain.readClaudeKeychainState;
}

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

/**
 * Consumable JSON view of a keychain rendering: raw JSON passes through and a
 * legacy `security -w` hex rendering of valid credential JSON decodes. Null
 * means the entry's content is genuinely unknown (corrupt/truncated) and must
 * be quarantined — a decodable entry is a readable, usually STALE credential
 * whose rotated-away refresh token can trip the provider's reuse detection
 * (HIVE-2), so it must be repaired in place, never skipped indefinitely.
 */
export function consumableClaudeKeychainPayload(raw: string | null): string | null {
  if (raw === null) return null;
  if (isRawClaudeCredentialPayload(raw)) return raw;
  const decoded = keychain.decodeSecurityPasswordOutput(raw);
  return isRawClaudeCredentialPayload(decoded) ? decoded : null;
}

/** True only for the raw JSON representation Claude itself can consume. */
export function isRawClaudeCredentialPayload(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    return typeof parsed?.claudeAiOauth?.accessToken === "string"
      && typeof parsed.claudeAiOauth.expiresAt === "number";
  } catch {
    return false;
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
  return parseClaudeChainJson(decoded, source);
}

/** Health acceptance: raw JSON only; legacy hex is migration input, not healthy. */
export function parseClaudeChainStrict(raw: string | null, source: string): ClaudeChain | null {
  if (!raw?.trimStart().startsWith("{")) return null;
  return parseClaudeChainJson(raw, source);
}

function parseClaudeChainJson(decoded: string | null, source: string): ClaudeChain | null {
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
  const keychainRead = await keychain.readClaudeKeychainState(homePath);
  if (keychainRead.status === "unreadable") {
    throw new keychain.ClaudeKeychainUnreadableError(homePath, keychainRead.reason);
  }
  if (keychainRead.status === "present") {
    // Rescue/migration callers retain tolerant legacy-hex decoding, but a
    // present malformed item remains authoritative and can never fall through
    // to a stale on-disk credential.
    const fromKeychain = parseClaudeChain(keychainRead.raw, `${homePath}:keychain`);
    if (!fromKeychain) throw new Error(`Unusable authoritative macOS Keychain entry for ${homePath}`);
    return fromKeychain;
  }
  return parseClaudeChain(await readFile(join(homePath, ".credentials.json"), "utf8").catch(() => null), `${homePath}:file`);
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

/**
 * Deep, key-order-independent semantic equality of two credential blobs. Both
 * are decoded (hex keychain payloads too, via decodeClaudeCredentialsRaw) and
 * JSON-parsed; a null/empty value or a parse failure on EITHER side yields
 * false. That asymmetry is the safety contract: this only ever answers "these
 * are provably the same JSON," never "assume equal," so a caller that elides a
 * write on `true` can never skip on unparseable/ambiguous input.
 *
 * Used to prove a keychain entry already holds exactly the merged identity
 * before spending a `security -i` subprocess on activation. It compares the
 * merged TARGET (what we would write) against the existing entry; because the
 * merge always overlays the account's own claudeAiOauth, a stale or foreign
 * existing entry can never test equal — it is always rewritten, never elided.
 */
export function claudeCredentialsEquivalent(a: string | null, b: string | null): boolean {
  const pa = parseCredentialsForCompare(a);
  const pb = parseCredentialsForCompare(b);
  if (pa === undefined || pb === undefined) return false;
  try {
    return canonicalJson(pa) === canonicalJson(pb);
  } catch {
    // Excessive nesting or another canonicalization failure must take the
    // original write path, never turn ambiguous input into a no-op.
    return false;
  }
}

function parseCredentialsForCompare(raw: string | null): unknown {
  const decoded = decodeClaudeCredentialsRaw(raw);
  if (decoded === null) return undefined;
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    return undefined;
  }
}

/** Deterministic stringification: recursively sort object keys, keep array order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    // Null-prototype storage keeps JSON keys such as "__proto__" as ordinary
    // data instead of invoking Object.prototype's legacy setter.
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
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

export type ClaudeChainParkingIntent = {
  ownerId: string;
  ownerEmail: string;
  notAccountId: string;
  chainRaw: string;
  chainExpiresAt: number;
  source: string;
};

export type ChainSyncResult = {
  chain: ClaudeChain | null;
  vaultUpdated: boolean;
  skipped: CredentialSyncSkip[];
  harvested?: boolean;
};
export type LockedChainSyncResult = ChainSyncResult & { parkingIntents: ClaudeChainParkingIntent[] };

export type ClaudeChainIdentityProof = {
  /** Exact decoded bytes read before the network lookup. */
  raw: string;
  /** Exact source locator read before the network lookup. */
  source: string;
  /** Authoritative email returned by Anthropic for this access token. */
  email: string;
};

export type ChainSyncDeps = {
  /** Resolve a fresh token's identity (tests inject; default is the memoized OAuth profile lookup). */
  fetchProfileEmail?: (accessToken: string) => Promise<string | null>;
  /** Read the exact representation Claude receives from Keychain. */
  readKeychainRaw?: RawClaudeKeychainReader;
  now?: () => number;
  /**
   * Automatic two-phase proofs. The wrapper obtains these without holding the
   * account/home lock; the locked phase re-reads and byte-matches the content.
   */
  identityProofs?: readonly ClaudeChainIdentityProof[];
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

async function claudeSyncHomes(
  account: AccountRecord,
  extraHome: string | undefined,
  options: SyncAccountCredentialsOptions,
): Promise<Map<string, string>> {
  const homes = new Map<string, string>();
  if (options.homeScope !== "extra-only" && options.homeScope !== "machine-only") {
    for (const home of await claudeHomesForAccount(account)) homes.set(resolve(home), home);
  }
  if (
    extraHome
    && !homes.has(resolve(extraHome))
    && (options.trustExtraHome === true || await homeBelongsToAccount(extraHome, account))
  ) {
    homes.set(resolve(extraHome), extraHome);
  }
  return homes;
}

async function readClaudeSyncCandidate(
  home: string,
  readKeychainRaw: RawClaudeKeychainReader,
): Promise<ClaudeChain | null> {
  const [keychainRead, fileRaw] = await Promise.all([
    readKeychainRaw(home),
    readFile(join(home, ".credentials.json"), "utf8").catch(() => null),
  ]);
  if (keychainRead.status === "unreadable") return null;
  const keychainRaw = keychainRead.status === "present" ? keychainRead.raw : null;
  if (keychainRaw !== null) {
    const consumable = consumableClaudeKeychainPayload(keychainRaw);
    return consumable !== null ? parseClaudeChain(consumable, `${home}:keychain`) : null;
  }
  return isRawClaudeCredentialPayload(fileRaw)
    ? parseClaudeChain(fileRaw, `${home}:file`)
    : null;
}

/**
 * Phase one of automatic Claude recovery. Resolve provider identity without
 * holding an activation/account lock. The locked importer accepts the proof
 * only when a second authoritative read yields the exact same bytes/source.
 */
export async function prepareClaudeChainIdentityProofs(
  account: AccountRecord,
  extraHome?: string,
  deps: Pick<ChainSyncDeps, "fetchProfileEmail" | "readKeychainRaw" | "now"> = {},
  options: SyncAccountCredentialsOptions = {},
): Promise<ClaudeChainIdentityProof[]> {
  const profileOf = deps.fetchProfileEmail ?? claudeProfileEmailCached;
  const readKeychainRaw = deps.readKeychainRaw ?? defaultRawClaudeKeychainReader();
  const nowMs = (deps.now ?? Date.now)();
  const vaultRaw = await readFile(join(accountDir(account), ".credentials.json"), "utf8").catch(() => null);
  const vault = isRawClaudeCredentialPayload(vaultRaw) ? parseClaudeChain(vaultRaw, "vault") : null;
  const proofs: ClaudeChainIdentityProof[] = [];
  const homes = await claudeSyncHomes(account, extraHome, options);
  await Promise.all([...homes.values()].map(async (home) => {
    const chain = await readClaudeSyncCandidate(home, readKeychainRaw).catch(() => null);
    if (
      !chain ||
      chain.expiresAt <= nowMs ||
      (options.requirePositiveHomeEvidence !== true && !isBetterClaudeChain(chain, vault))
    ) return;
    const email = await profileOf(String(chain.oauth.accessToken)).catch(() => null);
    if (email) proofs.push({ raw: chain.raw, source: chain.source, email });
  }));
  return proofs.sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * Pull the freshest attributed chain link into the vault. Reads the vault
 * snapshot plus every home attributable to the account (and extraHome when
 * attributable); when a home holds a fresher link than the vault — a
 * running or past claude rotated the chain there — the vault catches up, so
 * a later activation does not stamp a dead link over a live one.
 */
export async function syncClaudeChainToVault(
  account: AccountRecord,
  extraHome?: string,
  deps: ChainSyncDeps = {},
  options: SyncAccountCredentialsOptions = {},
): Promise<ChainSyncResult> {
  const identityProofs = options.authorization === "automatic"
    ? (deps.identityProofs ?? await prepareClaudeChainIdentityProofs(account, extraHome, deps, options))
    : deps.identityProofs;
  const locked = await withAccountLock(account.id, () => syncClaudeChainToVaultLocked(
    account,
    extraHome,
    { ...deps, identityProofs },
    options,
  ));
  // Cross-account parking deliberately happens only after the scanned
  // account's lock is gone. The owner write then takes its own lock and
  // revalidates both registry ownership and vault freshness.
  for (const intent of locked.parkingIntents) {
    await fulfillClaudeChainParkingIntent(intent).catch(() => undefined);
  }
  return {
    chain: locked.chain,
    vaultUpdated: locked.vaultUpdated,
    skipped: locked.skipped,
    harvested: locked.harvested,
  };
}

export async function syncClaudeChainToVaultLocked(
  account: AccountRecord,
  extraHome?: string,
  deps: ChainSyncDeps = {},
  options: SyncAccountCredentialsOptions = {},
): Promise<LockedChainSyncResult> {
  const vaultPath = join(accountDir(account), ".credentials.json");
  const vaultRaw = await readFile(vaultPath, "utf8").catch(() => null);
  const vault = isRawClaudeCredentialPayload(vaultRaw) ? parseClaudeChain(vaultRaw, "vault") : null;
  let refusedNonRaw = vaultRaw === null || isRawClaudeCredentialPayload(vaultRaw) ? 0 : 1;
  const homes = await claudeSyncHomes(account, extraHome, options);
  const expected = accountEmail(account);
  const profileOf = deps.fetchProfileEmail ?? claudeProfileEmailCached;
  const readKeychainRaw = deps.readKeychainRaw ?? defaultRawClaudeKeychainReader();
  const nowMs = (deps.now ?? Date.now)();
  let best = vault;
  const quarantinedHomes = new Set<string>();
  const parkingIntents = new Map<string, ClaudeChainParkingIntent>();
  const skipped: CredentialSyncSkip[] = [];
  let harvested = false;
  const recordSkip = async (skip: CredentialSyncSkip): Promise<void> => {
    skipped.push(skip);
    if (options.authorization === "automatic" && options.emitSkipTelemetry !== false) {
      await appendLedger({
        type: "account.credential-sync-skipped",
        account: account.id,
        tool: "claude",
        reason: skip.reason,
        ...(skip.source ? { from: skip.source } : {}),
      });
    }
  };
  for (const home of homes.values()) {
    const [keychainRead, fileRaw] = await Promise.all([
      readKeychainRaw(home),
      readFile(join(home, ".credentials.json"), "utf8").catch(() => null),
    ]);
    if (keychainRead.status === "unreadable") {
      refusedNonRaw += 1;
      quarantinedHomes.add(resolve(home));
      continue;
    }
    const keychainRaw = keychainRead.status === "present" ? keychainRead.raw : null;
    // Claude treats a present keychain item as authoritative. A legacy hex
    // rendering that decodes to valid credential JSON is still readable — use
    // the decoded view so the freshest link is never missed and distribution
    // can repair the entry to raw JSON. Only an entry whose content cannot be
    // decoded at all quarantines the whole home: falling back to its file can
    // select an older chain and then overwrite a fresher but malformed
    // keychain link (the 2026-08-07 production incident shape).
    const keychainConsumable = consumableClaudeKeychainPayload(keychainRaw);
    if (keychainRaw !== null && keychainConsumable === null) {
      refusedNonRaw += 1;
      quarantinedHomes.add(resolve(home));
      if (fileRaw !== null && !isRawClaudeCredentialPayload(fileRaw)) refusedNonRaw += 1;
      continue;
    }
    if (fileRaw !== null && !isRawClaudeCredentialPayload(fileRaw)) refusedNonRaw += 1;
    const fromKeychain = keychainConsumable !== null ? parseClaudeChain(keychainConsumable, `${home}:keychain`) : null;
    // A present, valid keychain entry is equally authoritative: only consult
    // the file when no keychain item exists at all.
    const chain = fromKeychain ?? (isRawClaudeCredentialPayload(fileRaw) ? parseClaudeChain(fileRaw, `${home}:file`) : null);
    if (!chain) continue;
    const better = isBetterClaudeChain(chain, best);
    if (!better && options.requirePositiveHomeEvidence !== true) continue;
    if (options.authorization === "automatic") {
      const proof = deps.identityProofs?.find((candidate) => candidate.source === chain.source && candidate.raw === chain.raw);
      if (!expected || !proof) {
        const sourceWasProved = deps.identityProofs?.some((candidate) => candidate.source === chain.source) === true;
        await recordSkip({
          reason: sourceWasProved ? "content-changed-after-proof" : "identity-unverifiable",
          source: chain.source,
        });
        continue;
      }
      if (proof.email !== expected) {
        const intent = await planClaudeChainParking(chain, proof.email, account).catch(() => null);
        if (intent) parkingIntents.set(`${intent.ownerId}\0${intent.chainRaw}`, intent);
        await recordSkip({ reason: "foreign-identity", source: chain.source });
        continue;
      }
      harvested = true;
      if (better) best = chain;
      continue;
    }
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
        const intent = await planClaudeChainParking(chain, actual, account).catch(() => null);
        if (intent) parkingIntents.set(`${intent.ownerId}\0${intent.chainRaw}`, intent);
        continue;
      }
    }
    harvested = true;
    if (better) best = chain;
  }
  if (refusedNonRaw > 0) {
    await appendLedger({
      type: "account.chain-sync-refused",
      account: account.id,
      reason: "non-raw-json-credential",
      refusedSources: refusedNonRaw,
    }).catch(() => undefined);
  }
  if (!best || best === vault) {
    return { chain: best, vaultUpdated: false, skipped, harvested, parkingIntents: [...parkingIntents.values()] };
  }
  // A rotated link harvested from one home is the only live link in the OAuth
  // chain. Keeping it in the vault alone strands every other active home on
  // the now-dead refresh token: their next turn fails even though the account
  // registry itself looks healthy. Distribute the adopted link just like a
  // Honeybee-owned refresh so all attributable homes advance atomically.
  await distributeClaudeChainLocked(account, best.oauth, { quarantinedHomes, readKeychainRaw });
  await appendLedger({
    type: "account.chain-sync",
    account: account.id,
    from: best.source,
    expiresAt: new Date(best.expiresAt).toISOString(),
  });
  return { chain: best, vaultUpdated: true, skipped, harvested, parkingIntents: [...parkingIntents.values()] };
}

/**
 * Resolve the account for a verified foreign chain without writing its vault.
 * The returned intent is fulfilled only after the scanned account lock exits.
 */
async function planClaudeChainParking(chain: ClaudeChain, email: string, notAccount: AccountRecord): Promise<ClaudeChainParkingIntent | null> {
  const owners = (await listAccounts()).filter(
    (candidate) => candidate.tool === "claude" && candidate.id !== notAccount.id && accountEmail(candidate) === email,
  );
  // Email-only Claude identity cannot distinguish duplicate registrations.
  if (owners.length !== 1) return null;
  const owner = owners[0]!;
  return {
    ownerId: owner.id,
    ownerEmail: email,
    notAccountId: notAccount.id,
    chainRaw: chain.raw,
    chainExpiresAt: chain.expiresAt,
    source: chain.source,
  };
}

/** Fulfil a foreign-chain parking intent under only the real owner's lock. */
export async function fulfillClaudeChainParkingIntent(intent: ClaudeChainParkingIntent): Promise<boolean> {
  let parked = false;
  await withAccountLock(intent.ownerId, async () => {
    // The registry and source payload may have changed while we released the
    // victim's lock and waited for the owner. Re-read/validate both before the
    // write, then compare against the owner's current vault inside the same
    // critical section so an already-fresher rotation always wins.
    const owners = (await listAccounts()).filter(
      (candidate) => candidate.id !== intent.notAccountId
        && candidate.tool === "claude"
        && accountEmail(candidate) === intent.ownerEmail,
    );
    if (owners.length !== 1 || owners[0]?.id !== intent.ownerId) return;
    const owner = owners[0]!;
    const chain = parseClaudeChainStrict(intent.chainRaw, intent.source);
    if (!chain || chain.expiresAt !== intent.chainExpiresAt) return;
    const vault = parseClaudeChainStrict(
      await readFile(join(accountDir(owner), ".credentials.json"), "utf8").catch(() => null),
      "vault",
    );
    if (!isBetterClaudeChain(chain, vault)) return;
    await saveClaudeChainToVaultLocked(owner, chain.raw);
    parked = true;
  }, { timeoutMs: CROSS_ACCOUNT_LOCK_TIMEOUT_MS });
  if (parked) {
    await appendLedger({ type: "account.chain-evacuate", account: intent.ownerId, home: intent.source }).catch(() => undefined);
  }
  return parked;
}

/**
 * The home being activated may hold ANOTHER account's chain whose live link
 * exists nowhere else. Rescue it into its owner's vault (freshness-guarded)
 * before the stamp destroys it. Called while holding the ACTIVATING account's
 * lock; the rescue itself takes the OWNER's lock so it cannot interleave with
 * the owner's own refresh/persist of the same vault file.
 */
export async function evacuateForeignClaudeChain(
  account: AccountRecord,
  homePath: string,
  options: Pick<SyncAccountCredentialsOptions, "authorization"> & Pick<ChainSyncDeps, "identityProofs"> = {},
): Promise<ClaudeChainParkingIntent | null> {
  const occupant = await readHomeClaudeChain(homePath);
  if (!occupant) return null;
  const proof = options.identityProofs?.find(
    (candidate) => candidate.source === occupant.source && candidate.raw === occupant.raw,
  );
  // Automatic activation may only rescue exact bytes whose identity the
  // provider proved before the home/account locks were acquired.
  if (options.authorization === "automatic" && !proof) return null;
  const email = proof?.email ?? await homeClaudeEmail(homePath);
  if (!email || email === accountEmail(account)) return null;
  return planClaudeChainParking(occupant, email, account);
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
type ClaudeDistributionOptions = {
  quarantinedHomes?: ReadonlySet<string>;
  readKeychainRaw?: RawClaudeKeychainReader;
};

async function distributeClaudeChainLocked(
  account: AccountRecord,
  oauth: Record<string, unknown>,
  options: ClaudeDistributionOptions = {},
): Promise<void> {
  const sourceRaw = JSON.stringify({ claudeAiOauth: oauth });
  if (!isRawClaudeCredentialPayload(sourceRaw)) {
    await appendLedger({
      type: "account.chain-distribution-refused",
      account: account.id,
      reason: "non-raw-json-credential",
    }).catch(() => undefined);
    throw new Error("refusing to distribute a non-JSON Claude credential");
  }
  await saveClaudeChainToVaultLocked(account, sourceRaw);
  const readKeychainRaw = options.readKeychainRaw ?? defaultRawClaudeKeychainReader();
  for (const home of await claudeHomesForAccount(account)) {
    if (options.quarantinedHomes?.has(resolve(home))) continue;
    try {
      const existingEntry = await readKeychainRaw(home);
      if (existingEntry.status === "unreadable") {
        await appendLedger({
          type: "account.chain-propagation-refused",
          account: account.id,
          home,
          reason: "unreadable-authoritative-keychain",
        }).catch(() => undefined);
        continue;
      }
      const existingRaw = existingEntry.status === "present" ? existingEntry.raw : null;
      const existingConsumable = consumableClaudeKeychainPayload(existingRaw);
      // Even outside a sweep adoption, do not write through an entry whose
      // content cannot be decoded — its bytes are genuinely unknown. But a
      // legacy hex rendering of valid credential JSON is a READABLE stale
      // credential: leaving it in place keeps a rotated-away refresh token
      // live on the home (replaying it revokes the whole chain — the
      // 2026-08-08 revocation shape), so repair it with the fresh chain
      // instead of skipping it on every refresh forever.
      if (existingRaw !== null && existingConsumable === null) {
        await appendLedger({
          type: "account.chain-propagation-refused",
          account: account.id,
          home,
          reason: "non-raw-json-keychain",
        }).catch(() => undefined);
        continue;
      }
      const repairingLegacyEntry = existingRaw !== null && !isRawClaudeCredentialPayload(existingRaw);
      const keychainWrite = await keychain.writeClaudeKeychainEntry(home, mergeCredentialsJson(existingConsumable, sourceRaw));
      if (repairingLegacyEntry && keychainWrite.ok) {
        await appendLedger({
          type: "account.chain-keychain-repaired",
          account: account.id,
          home,
          reason: "legacy-hex-rendering",
        }).catch(() => undefined);
      }
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
}

export async function persistClaudeChainLocked(account: AccountRecord, oauth: Record<string, unknown>): Promise<void> {
  await distributeClaudeChainLocked(account, oauth);
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
