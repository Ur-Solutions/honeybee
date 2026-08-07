import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { identityRecipeForAgent } from "../drivers.js";
import { atomicWriteFile } from "../fsx.js";
import { appendLedger } from "../store.js";
import { accountDir, withAccountLock, listAccounts, CROSS_ACCOUNT_LOCK_TIMEOUT_MS, type AccountRecord } from "./registry.js";
import { accountEmail, emailFromJwt, expFromJwt } from "./utils.js";
import { candidateHomes, dedicatedHomesFor, defaultHomeForAccount } from "./homes.js";
import {
  runCredentialSyncLocked,
  type CredentialImportAuthorization,
  type CredentialSyncSkip,
  type CredentialSyncStrategy,
  type SyncAccountCredentialsOptions,
} from "./credentialSync.js";

const execFileP = promisify(execFile);

export type CodexAuthSnapshot = {
  /** Full auth.json as found. Contains secrets; never log raw. */
  raw: string;
  /** Decoded id_token email when present. */
  email?: string;
  /** OpenAI account id when present. */
  accountId?: string;
  /** Parsed `last_refresh`; preferred freshness signal over file mtime. */
  lastRefreshMs?: number;
  /** File mtime fallback for older auth.json shapes. */
  mtimeMs: number;
  /** Where this snapshot was found — for ledger/debugging. */
  source: string;
};

async function readCodexAuthFile(path: string, source: string): Promise<CodexAuthSnapshot | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const raw = await readFile(path, "utf8").catch(() => null);
  return parseCodexAuth(raw, source, info.mtimeMs);
}

function parseCodexAuth(raw: string | null, source: string, mtimeMs: number): CodexAuthSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    const tokens = object.tokens && typeof object.tokens === "object" && !Array.isArray(object.tokens)
      ? object.tokens as Record<string, unknown>
      : {};
    const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
    const lastRefreshRaw = typeof object.last_refresh === "string" ? Date.parse(object.last_refresh) : NaN;
    return {
      raw,
      ...(idToken ? { email: emailFromJwt(idToken) ?? undefined } : {}),
      ...(typeof tokens.account_id === "string" ? { accountId: tokens.account_id } : {}),
      ...(Number.isFinite(lastRefreshRaw) ? { lastRefreshMs: lastRefreshRaw } : {}),
      mtimeMs,
      source,
    };
  } catch {
    return null;
  }
}

async function readHomeCodexAuth(homePath: string): Promise<CodexAuthSnapshot | null> {
  const recipe = identityRecipeForAgent("codex");
  const relatives = [
    ...(recipe?.credentialFiles ?? ["auth.json"]),
    ...Object.values(recipe?.activationMirrors ?? {}),
  ];
  let best: CodexAuthSnapshot | null = null;
  for (const relative of relatives) {
    const snapshot = await readCodexAuthFile(join(homePath, relative), `${homePath}:${relative}`);
    if (snapshot && (!best || codexAuthFreshnessMs(snapshot) > codexAuthFreshnessMs(best))) best = snapshot;
  }
  return best;
}

function codexAuthFreshnessMs(snapshot: CodexAuthSnapshot): number {
  return snapshot.lastRefreshMs ?? snapshot.mtimeMs;
}

function isFresherCodexAuth(candidate: CodexAuthSnapshot, current: CodexAuthSnapshot | null): boolean {
  if (!current) return true;
  if (candidate.raw === current.raw) return false;
  return codexAuthFreshnessMs(candidate) > codexAuthFreshnessMs(current);
}

async function codexAccountEmails(account: AccountRecord, vault?: CodexAuthSnapshot | null): Promise<Set<string>> {
  const emails = new Set<string>();
  const explicit = accountEmail(account);
  if (explicit) emails.add(explicit);
  const snapshot = vault ?? await readCodexAuthFile(join(accountDir(account), "auth.json"), "vault");
  if (snapshot?.email) emails.add(snapshot.email);
  return emails;
}

async function codexAuthBelongsToAccount(snapshot: CodexAuthSnapshot | null, account: AccountRecord, vault?: CodexAuthSnapshot | null): Promise<boolean> {
  if (!snapshot?.email) return true;
  const explicitEmail = accountEmail(account);
  const emails = explicitEmail ? new Set([explicitEmail]) : await codexAccountEmails(account, vault);
  return emails.size === 0 || emails.has(snapshot.email);
}

async function authorizeCodexAuthImport(
  snapshot: CodexAuthSnapshot,
  account: AccountRecord,
  vault: CodexAuthSnapshot | null,
  options: SyncAccountCredentialsOptions,
): Promise<CredentialImportAuthorization> {
  if (options.authorization !== "automatic") {
    return await codexAuthBelongsToAccount(snapshot, account, vault)
      ? { authorized: true }
      : { authorized: false, reason: "foreign-identity", source: snapshot.source };
  }

  // Automatic recovery requires positive continuity with provider-issued
  // identity in the vault/account record. Path ownership and a SessionRecord
  // are never evidence about these bytes. When both dimensions exist, either
  // one contradicting the account rejects the whole bundle.
  let matched = false;
  if (vault?.accountId) {
    if (!snapshot.accountId) {
      return { authorized: false, reason: "identity-unverifiable", source: snapshot.source };
    }
    if (snapshot.accountId !== vault.accountId) {
      return { authorized: false, reason: "foreign-identity", source: snapshot.source };
    }
    matched = true;
  }
  const explicitEmail = accountEmail(account);
  const emails = explicitEmail ? new Set([explicitEmail]) : await codexAccountEmails(account, vault);
  if (emails.size > 0) {
    if (!snapshot.email) {
      return { authorized: false, reason: "identity-unverifiable", source: snapshot.source };
    }
    if (!emails.has(snapshot.email)) {
      return { authorized: false, reason: "foreign-identity", source: snapshot.source };
    }
    matched = true;
  }
  return matched
    ? { authorized: true }
    : { authorized: false, reason: "identity-unverifiable", source: snapshot.source };
}

async function homeBelongsToCodexAccount(homePath: string, account: AccountRecord, vault?: CodexAuthSnapshot | null): Promise<boolean> {
  const target = resolve(homePath);
  const dedicated = dedicatedHomesFor(account).some((dir) => resolve(dir) === target);
  const snapshot = await readHomeCodexAuth(homePath);
  if (snapshot?.email) return codexAuthBelongsToAccount(snapshot, account, vault);
  return dedicated;
}

/** Homes attributable to the Codex account: dedicated slots + email-matched shared homes. */
export async function codexHomesForAccount(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<string[]> {
  const vault = await readCodexAuthFile(join(accountDir(account), "auth.json"), "vault");
  const matched = new Map<string, string>();
  const consider = async (home: string, trusted = false) => {
    if ((await stat(home).catch(() => null))?.isDirectory() && (trusted || await homeBelongsToCodexAccount(home, account, vault))) {
      matched.set(resolve(home), home);
    }
  };
  if (options.homeScope === "machine-only") return [];
  if (options.homeScope !== "extra-only") {
    for (const dir of dedicatedHomesFor(account)) await consider(dir);
  }
  if (extraHome) await consider(extraHome, options.trustExtraHome === true);
  if (options.homeScope !== "extra-only" && (await codexAccountEmails(account, vault)).size > 0) {
    for (const home of await candidateHomes("codex")) await consider(home);
  }
  return [...matched.values()];
}

async function saveCodexAuthToVaultLocked(account: AccountRecord, sourceRaw: string): Promise<void> {
  const vaultPath = join(accountDir(account), "auth.json");
  await mkdir(dirname(vaultPath), { recursive: true, mode: 0o700 });
  await atomicWriteFile(vaultPath, sourceRaw.endsWith("\n") ? sourceRaw : `${sourceRaw}\n`, { mode: 0o600 });
}

export type CodexAuthSyncResult = {
  auth: CodexAuthSnapshot | null;
  vaultUpdated: boolean;
  skipped: CredentialSyncSkip[];
  harvested?: boolean;
};

const codexSyncStrategy: CredentialSyncStrategy<CodexAuthSnapshot, CodexAuthSyncResult> = {
  readVaultSnapshot: (account) => readCodexAuthFile(join(accountDir(account), "auth.json"), "vault"),
  homesForAccount: (account, extraHome, options) => codexHomesForAccount(account, extraHome, options),
  readHomeSnapshot: (_account, home) => readHomeCodexAuth(home),
  authorizeImport: authorizeCodexAuthImport,
  isFresher: isFresherCodexAuth,
  save: (account, snapshot) => saveCodexAuthToVaultLocked(account, snapshot.raw),
  ledger: (account, snapshot) => ({
    type: "account.auth-sync",
    account: account.id,
    tool: "codex",
    from: snapshot.source,
    ...(snapshot.lastRefreshMs ? { lastRefreshAt: new Date(snapshot.lastRefreshMs).toISOString() } : {}),
  }),
  result: (auth, vaultUpdated, skipped, harvested) => ({ auth, vaultUpdated, skipped, harvested }),
};

/**
 * Pull the freshest attributed Codex auth.json into the vault. Codex refreshes
 * auth.json in-place; if the vault keeps stamping an older refresh token over
 * account homes, later launches can force sign-in again. Identity checks keep
 * swapped/shared homes from poisoning a different account's vault entry.
 */
export async function syncCodexAuthToVault(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<CodexAuthSyncResult> {
  return withAccountLock(account.id, () => syncCodexAuthToVaultLocked(account, extraHome, options));
}

export async function syncCodexAuthToVaultLocked(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<CodexAuthSyncResult> {
  return runCredentialSyncLocked(account, codexSyncStrategy, extraHome, options);
}

export type CodexAuthParkingIntent = {
  ownerId: string;
  notAccountId: string;
  homePath: string;
  authRaw: string;
  authDigest: string;
  authEmail?: string;
  authAccountId?: string;
  authLastRefreshMs?: number;
  authMtimeMs: number;
  authFreshnessMs: number;
  source: string;
};

function codexAuthDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function snapshotFromCodexParkingIntent(intent: CodexAuthParkingIntent): CodexAuthSnapshot | null {
  if (codexAuthDigest(intent.authRaw) !== intent.authDigest) return null;
  const snapshot = parseCodexAuth(intent.authRaw, intent.source, intent.authMtimeMs);
  if (
    !snapshot
    || snapshot.email !== intent.authEmail
    || snapshot.accountId !== intent.authAccountId
    || snapshot.lastRefreshMs !== intent.authLastRefreshMs
    || codexAuthFreshnessMs(snapshot) !== intent.authFreshnessMs
  ) return null;
  return snapshot;
}

/**
 * Scan a home while holding only the ACTIVATING account's lock. A verified
 * foreign occupant is returned as an exact-content/identity/freshness intent;
 * no foreign-owner vault is written here.
 */
export async function evacuateForeignCodexAuth(account: AccountRecord, homePath: string): Promise<CodexAuthParkingIntent | null> {
  const occupant = await readHomeCodexAuth(homePath);
  if (!occupant) return null;
  const currentVault = await readCodexAuthFile(join(accountDir(account), "auth.json"), "vault");
  if ((await authorizeCodexAuthImport(occupant, account, currentVault, { authorization: "automatic" })).authorized) return null;
  const owner = await findCodexAccountForSnapshot(occupant, account.id);
  if (!owner) return null;
  return {
    ownerId: owner.id,
    notAccountId: account.id,
    homePath,
    authRaw: occupant.raw,
    authDigest: codexAuthDigest(occupant.raw),
    ...(occupant.email ? { authEmail: occupant.email } : {}),
    ...(occupant.accountId ? { authAccountId: occupant.accountId } : {}),
    ...(occupant.lastRefreshMs !== undefined ? { authLastRefreshMs: occupant.lastRefreshMs } : {}),
    authMtimeMs: occupant.mtimeMs,
    authFreshnessMs: codexAuthFreshnessMs(occupant),
    source: occupant.source,
  };
}

/** Fulfil a foreign-auth intent while holding only its real owner's lock. */
export async function fulfillCodexAuthParkingIntent(intent: CodexAuthParkingIntent): Promise<boolean> {
  const occupant = snapshotFromCodexParkingIntent(intent);
  if (!occupant) return false;
  let parked = false;
  await withAccountLock(intent.ownerId, async () => {
    // Registry ownership and provider identity may have changed while the
    // activating account released its lock. The same exact snapshot must
    // still resolve uniquely to the intended owner.
    const owner = await findCodexAccountForSnapshot(occupant, intent.notAccountId);
    if (!owner || owner.id !== intent.ownerId) return;

    // A newer owner rotation may now live in B's vault OR one of B's homes.
    // Harvest that evidence first under B's lock, then compare the intent to
    // the resulting vault snapshot so the delayed park can never overwrite it.
    await syncCodexAuthToVaultLocked(owner, undefined, {
      authorization: "automatic",
      emitSkipTelemetry: false,
    });
    const vault = await readCodexAuthFile(join(accountDir(owner), "auth.json"), "vault");
    if (!(await authorizeCodexAuthImport(occupant, owner, vault, { authorization: "automatic" })).authorized) return;
    if (!isFresherCodexAuth(occupant, vault)) return;
    await saveCodexAuthToVaultLocked(owner, occupant.raw);
    parked = true;
  }, { timeoutMs: CROSS_ACCOUNT_LOCK_TIMEOUT_MS });
  if (parked) {
    await appendLedger({
      type: "account.auth-evacuate",
      account: intent.ownerId,
      tool: "codex",
      home: intent.homePath,
      ...(occupant.lastRefreshMs ? { lastRefreshAt: new Date(occupant.lastRefreshMs).toISOString() } : {}),
    }).catch(() => undefined);
  }
  return parked;
}

async function findCodexAccountForSnapshot(snapshot: CodexAuthSnapshot, excludeId?: string): Promise<AccountRecord | null> {
  const matches: AccountRecord[] = [];
  for (const candidate of (await listAccounts()).filter((account) => account.tool === "codex" && account.id !== excludeId)) {
    const vault = await readCodexAuthFile(join(accountDir(candidate), "auth.json"), "vault");
    if ((await authorizeCodexAuthImport(snapshot, candidate, vault, { authorization: "automatic" })).authorized) {
      matches.push(candidate);
    }
  }
  // Duplicate/ambiguous identities cannot prove which vault owns the bytes.
  return matches.length === 1 ? matches[0]! : null;
}

/** Email claim from auth.json's id_token JWT — decoded, not verified (local fact). */
export async function codexAuthEmail(authPath: string): Promise<string | null> {
  const auth = await readCodexAuthFile(authPath, authPath);
  return auth?.email ?? null;
}

// ── Central access-token freshness (remote-HSR ship-access-token, APIA-93) ──
//
// Remote-HSR ships codex a REFRESH-TOKEN-BLANKED auth.json (see remoteCreds.ts):
// a fresh, long-lived (~10-day) access token with `refresh_token: ""`. The bee
// therefore cannot refresh on its own, so the VAULT must be the thing that keeps
// a fresh access token. codex refreshes its access token IN PLACE when it starts
// a turn and sees the token near expiry — we never re-implement the OAuth token
// endpoint. These helpers decode the token's expiry and, when near/at expiry,
// trigger codex to rotate it against the account's OWN dedicated home, then
// harvest the rotated token back into the vault with the existing sync path.

/** How long before real expiry we consider the vault access token "stale". */
export const CODEX_TOKEN_MIN_TTL_MS = 15 * 60_000; // 15 minutes

/** `tokens.access_token` from a raw codex auth.json, or undefined. */
function codexAccessToken(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } };
    const token = parsed.tokens?.access_token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** access_token `exp` (unix SECONDS) for a raw codex auth.json, or undefined. */
export function codexAccessTokenExp(raw: string): number | undefined {
  const token = codexAccessToken(raw);
  return token ? expFromJwt(token) : undefined;
}

export type CodexTokenFreshness = {
  /** Whether a codex refresh was actually triggered by this call. */
  refreshed: boolean;
  /** The vault access token's `exp` (unix SECONDS) after this call. */
  expSeconds: number;
};

export type EnsureFreshCodexDeps = {
  /** Remaining-TTL threshold (ms) below which we refresh. Default 15 min. */
  minTtlMs?: number;
  now?: () => number;
  /**
   * Injectable codex-refresh runner (tests inject a fake so no real codex runs).
   * Runs a no-op codex turn against `homePath` (as CODEX_HOME); codex rotates
   * auth.json in place only when the access token is near expiry.
   */
  runCodexRefresh?: (homePath: string) => Promise<void>;
};

/** Copy the current vault auth.json into a home's auth.json (0600). */
async function stampCodexAuthIntoHome(homePath: string, raw: string): Promise<void> {
  const target = join(homePath, "auth.json");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await atomicWriteFile(target, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
}

/** Default: run a minimal read-only `codex exec` turn to rotate a stale token. */
async function defaultRunCodexRefresh(homePath: string): Promise<void> {
  try {
    // Mirror the naming-generator invocation: read-only sandbox + tiny prompt.
    // codex refreshes auth.json in place at turn start when the token is near
    // expiry; the output is discarded. cwd is a throwaway temp dir.
    await execFileP("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "ok"], {
      cwd: tmpdir(),
      env: { ...process.env, CODEX_HOME: homePath },
      timeout: 120_000,
      maxBuffer: 1 << 20,
    });
  } catch {
    // Secret-free: never surface codex stderr (could echo token-adjacent bytes).
    throw new Error("could not run `codex exec` to refresh the vault token (is codex installed and this account logged in locally?)");
  }
}

/**
 * Ensure the vault's codex access token is FRESH, refreshing it centrally when
 * it is near/at expiry. On the fresh path this is a cheap decode-and-return.
 * On the stale path it stamps the vault credential into the account's OWN
 * dedicated home, triggers codex to rotate the token in place there, then pulls
 * the rotated auth.json back into the vault (freshness by `last_refresh`). The
 * vault stays the sole holder of the real refresh token; nothing here re-implements
 * OAuth. UNIT 2 will schedule this proactively so ship-access-token never blocks.
 *
 * Throws a secret-free error if the vault has no decodable token, or if a
 * triggered refresh fails to produce a fresh one (codex missing / not logged in).
 */
export async function ensureFreshCodexVaultToken(account: AccountRecord, deps: EnsureFreshCodexDeps = {}): Promise<CodexTokenFreshness> {
  const now = deps.now ?? (() => Date.now());
  const minTtlMs = deps.minTtlMs ?? CODEX_TOKEN_MIN_TTL_MS;
  const vaultPath = join(accountDir(account), "auth.json");

  const before = await readCodexAuthFile(vaultPath, "vault");
  if (!before) {
    throw new Error(`no vaulted codex auth for ${account.id}; capture it first with: hive account login codex ${account.label}`);
  }
  const beforeExp = codexAccessTokenExp(before.raw);
  if (beforeExp === undefined) {
    throw new Error(`vaulted codex auth for ${account.id} has no decodable access token; re-login with: hive account login codex ${account.label}`);
  }
  if (beforeExp * 1000 - now() > minTtlMs) {
    return { refreshed: false, expSeconds: beforeExp };
  }

  // Stale: stamp vault → dedicated home (so codex has the REAL refresh token to
  // rotate), trigger the rotation, then harvest the rotated token back.
  const home = defaultHomeForAccount(account);
  await withAccountLock(account.id, () => stampCodexAuthIntoHome(home, before.raw));
  await (deps.runCodexRefresh ?? defaultRunCodexRefresh)(home);
  await syncCodexAuthToVault(account, home);

  const after = await readCodexAuthFile(vaultPath, "vault");
  const afterExp = after ? codexAccessTokenExp(after.raw) : undefined;
  if (afterExp === undefined || afterExp * 1000 - now() <= minTtlMs) {
    throw new Error(`codex token refresh for ${account.id} did not produce a fresh access token`);
  }
  return { refreshed: true, expSeconds: afterExp };
}
