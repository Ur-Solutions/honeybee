import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { atomicWriteFile } from "../fsx.js";
import { credentialDigest, keychainAvailable } from "../keychain.js";
import { accountDir, withAccountLock, type AccountRecord } from "./registry.js";
import { accountEmail } from "./utils.js";
import { dedicatedHomesFor, isDedicatedHomeForAccount } from "./homes.js";
import {
  runCredentialSyncLocked,
  type CredentialSyncStrategy,
  type SyncAccountCredentialsOptions,
} from "./credentialSync.js";

const execFileAsync = promisify(execFile);

// Mirrors keychain.ts: `security` can block on an unlock/consent dialog; fail
// closed after a minute rather than wedging a headless caller.
const SECURITY_EXEC_TIMEOUT_MS = 60_000;

// ──────────────────────────────────────────────────────────────────────────
// Cursor CLI credentials.
//
// cursor-agent's live credential store is MACHINE-GLOBAL, not home-relative:
//   - macOS: login-keychain generic passwords, account "cursor-user",
//     services "cursor-access-token" / "cursor-refresh-token" /
//     "cursor-api-key" (file fallback ~/.cursor/auth.json when the keychain
//     is unusable).
//   - Linux: $XDG_CONFIG_HOME/cursor/auth.json (default ~/.config/cursor/).
//   - The file shape (cursor's own): {accessToken, refreshToken, apiKey}.
//
// CURSOR_CONFIG_DIR relocates only cli-config.json (which carries the
// non-secret authInfo identity: email/userId/authId), so per-home isolation
// of the SECRET is impossible on cursor's side. The vault therefore keeps a
// canonical auth.json per account; activation stamps it into the home and the
// driver's credentialEnv (drivers.ts) lifts it into CURSOR_AUTH_TOKEN /
// CURSOR_API_KEY, which cursor-agent honors OVER the global store for API
// requests (verified against the 2026.06.24 CLI).
//
// CAUTION: cursor-agent PERSISTS an env-provided token into the global
// keychain on its first API call (observed live). The global slot therefore
// reflects "whichever cursor bee ran last" — which is why every vault write
// here is gated on a positive identity match (JWT sub ↔ the account's
// recorded authId / vaulted-token sub), never on freshness alone.
// ──────────────────────────────────────────────────────────────────────────

export type CursorAuthSnapshot = {
  /** Canonical auth.json content (cursor's own file shape). */
  raw: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  /** JWT `sub` claims of the tokens (auth0 ids — match cli-config authInfo.authId). */
  subs: Set<string>;
  /** JWT `email` claims when present. */
  emails: Set<string>;
  /** JWT iat of the freshest token (ms). */
  issuedAtMs?: number;
  /** JWT exp of the access token (ms). */
  expiresAtMs?: number;
  mtimeMs: number;
  source: string;
};

type JwtClaims = { sub?: string; email?: string; iat?: number; exp?: number };

export function decodeJwtClaims(token: string): JwtClaims | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      ...(typeof decoded.sub === "string" ? { sub: decoded.sub } : {}),
      ...(typeof decoded.email === "string" ? { email: decoded.email } : {}),
      ...(typeof decoded.iat === "number" ? { iat: decoded.iat } : {}),
      ...(typeof decoded.exp === "number" ? { exp: decoded.exp } : {}),
    };
  } catch {
    return null;
  }
}

export function parseCursorAuth(raw: string | null, source: string, mtimeMs: number): CursorAuthSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const object = parsed as Record<string, unknown>;
  const accessToken = typeof object.accessToken === "string" && object.accessToken.length > 0 ? object.accessToken : undefined;
  const refreshToken = typeof object.refreshToken === "string" && object.refreshToken.length > 0 ? object.refreshToken : undefined;
  const apiKey = typeof object.apiKey === "string" && object.apiKey.length > 0 ? object.apiKey : undefined;
  if (!accessToken && !apiKey) return null;
  const subs = new Set<string>();
  const emails = new Set<string>();
  let issuedAtMs: number | undefined;
  let expiresAtMs: number | undefined;
  for (const token of [accessToken, refreshToken]) {
    if (!token) continue;
    const claims = decodeJwtClaims(token);
    if (!claims) continue;
    if (claims.sub) subs.add(claims.sub);
    if (claims.email) emails.add(claims.email);
    if (claims.iat !== undefined) issuedAtMs = Math.max(issuedAtMs ?? 0, claims.iat * 1000);
    if (token === accessToken && claims.exp !== undefined) expiresAtMs = claims.exp * 1000;
  }
  return {
    raw,
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(apiKey ? { apiKey } : {}),
    subs,
    emails,
    ...(issuedAtMs !== undefined ? { issuedAtMs } : {}),
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    mtimeMs,
    source,
  };
}

export async function readCursorAuthFile(path: string, source: string): Promise<CursorAuthSnapshot | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const raw = await readFile(path, "utf8").catch(() => null);
  return parseCursorAuth(raw, source, info.mtimeMs);
}

/** The machine-global auth.json path cursor-agent itself reads/writes. */
export function cursorGlobalAuthPath(): string {
  // HIVE_CURSOR_AUTH_PATH lets tests point live-store reads at a temp file
  // instead of the developer's real ~/.cursor (mirrors HIVE_NO_KEYCHAIN).
  const override = process.env.HIVE_CURSOR_AUTH_PATH?.trim();
  if (override) return override;
  if (process.platform === "darwin") return join(homedir(), ".cursor", "auth.json");
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "cursor", "auth.json");
}

async function readCursorKeychainSecret(service: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-a", "cursor-user", "-s", service, "-w"],
      { timeout: SECURITY_EXEC_TIMEOUT_MS },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read cursor's live machine-global credential store: the keychain slot on
 * macOS (synthesized into the canonical auth.json shape), else the global
 * auth.json file. Null when the machine has no cursor login at all.
 */
export async function readCursorLiveAuth(): Promise<CursorAuthSnapshot | null> {
  if (keychainAvailable()) {
    const [accessToken, refreshToken, apiKey] = await Promise.all([
      readCursorKeychainSecret("cursor-access-token"),
      readCursorKeychainSecret("cursor-refresh-token"),
      readCursorKeychainSecret("cursor-api-key"),
    ]);
    if (accessToken || apiKey) {
      const raw = `${JSON.stringify({
        ...(accessToken ? { accessToken } : {}),
        ...(refreshToken ? { refreshToken } : {}),
        ...(apiKey ? { apiKey } : {}),
      }, null, 2)}\n`;
      const snapshot = parseCursorAuth(raw, "keychain", 0);
      if (snapshot) return snapshot;
    }
  }
  return readCursorAuthFile(cursorGlobalAuthPath(), cursorGlobalAuthPath());
}

/** Digest of the live store — the login seat's freshness baseline. */
export async function cursorLiveAuthDigest(): Promise<string | null> {
  const live = await readCursorLiveAuth();
  return live ? credentialDigest(live.raw) : null;
}

/** The non-secret identity cli-config.json records for the logged-in user. */
export type CursorAuthInfo = { email?: string; authId?: string };

export async function readCursorAuthInfo(configDir: string): Promise<CursorAuthInfo | null> {
  const raw = await readFile(join(configDir, "cli-config.json"), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { authInfo?: { email?: unknown; authId?: unknown } };
    const info = parsed?.authInfo;
    if (!info || typeof info !== "object") return null;
    return {
      ...(typeof info.email === "string" ? { email: info.email } : {}),
      ...(typeof info.authId === "string" ? { authId: info.authId } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Every identity claim we know for the account: its explicit email, plus the
 * subs/emails recoverable from the vaulted auth.json and cli-config.json.
 */
export async function cursorAccountIdentity(
  account: AccountRecord,
  vault?: CursorAuthSnapshot | null,
): Promise<{ emails: Set<string>; subs: Set<string> }> {
  const emails = new Set<string>();
  const subs = new Set<string>();
  const explicit = accountEmail(account);
  if (explicit) emails.add(explicit);
  const snapshot = vault ?? (await readCursorAuthFile(join(accountDir(account), "auth.json"), "vault"));
  for (const email of snapshot?.emails ?? []) emails.add(email);
  for (const sub of snapshot?.subs ?? []) subs.add(sub);
  const info = await readCursorAuthInfo(accountDir(account));
  if (info?.email) emails.add(info.email);
  if (info?.authId) subs.add(info.authId);
  return { emails, subs };
}

/**
 * Positive identity match between a snapshot and the account. The live store
 * is machine-global — after any cursor bee's first API call it holds THAT
 * bee's account — so an unattributable snapshot (opaque tokens, no overlap)
 * must never enter the vault: return false, not "benefit of the doubt".
 */
export async function cursorAuthBelongsToAccount(
  snapshot: CursorAuthSnapshot,
  account: AccountRecord,
  vault?: CursorAuthSnapshot | null,
): Promise<boolean> {
  const resolvedVault = vault === undefined ? await readCursorAuthFile(join(accountDir(account), "auth.json"), "vault") : vault;
  // The vault's own bytes (or a home copy of them) are the account's by definition.
  if (resolvedVault && snapshot.raw === resolvedVault.raw) return true;
  const identity = await cursorAccountIdentity(account, resolvedVault);
  if ([...snapshot.subs].some((sub) => identity.subs.has(sub))) return true;
  if ([...snapshot.emails].some((email) => identity.emails.has(email))) return true;
  return false;
}

function cursorAuthFreshnessMs(snapshot: CursorAuthSnapshot): number {
  return snapshot.issuedAtMs ?? snapshot.expiresAtMs ?? snapshot.mtimeMs;
}

function isFresherCursorAuth(candidate: CursorAuthSnapshot, current: CursorAuthSnapshot | null): boolean {
  if (!current) return true;
  if (candidate.raw === current.raw) return false;
  return cursorAuthFreshnessMs(candidate) > cursorAuthFreshnessMs(current);
}

const CURSOR_AUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * Why the vaulted credential cannot back a spawn right now, or null when it
 * can. An apiKey never expires; an OAuth access token is judged by its JWT
 * exp (undecodable/claim-less tokens pass — fail open on format drift, the
 * spawned CLI is the final authority).
 */
export function cursorAuthUnavailableReason(snapshot: CursorAuthSnapshot | null, now: number, skewMs = CURSOR_AUTH_EXPIRY_SKEW_MS): string | null {
  if (!snapshot) return "missing auth.json";
  if (snapshot.apiKey) return null;
  if (snapshot.expiresAtMs === undefined) return null;
  const expiresAt = new Date(snapshot.expiresAtMs).toISOString();
  if (snapshot.expiresAtMs <= now) return `OAuth access token expired at ${expiresAt}`;
  if (snapshot.expiresAtMs <= now + skewMs) return `OAuth access token expires soon at ${expiresAt}`;
  return null;
}

/**
 * Spawn preflight: a PRESENT home auth.json must be usable (an apiKey, or an
 * unexpired access token). A home without one passes — such a spawn
 * legitimately rides the machine-global cursor login instead.
 */
export async function assertCursorHomeAuthFresh(
  homePath: string,
  options: { accountId?: string; now?: () => number } = {},
): Promise<void> {
  const snapshot = await readCursorAuthFile(join(homePath, "auth.json"), `${homePath}:auth.json`);
  if (!snapshot) return;
  const reason = cursorAuthUnavailableReason(snapshot, options.now?.() ?? Date.now());
  if (!reason) return;
  const relogin = options.accountId ? `hive login ${options.accountId}` : "hive login <cursor-account>";
  throw new Error(`Cannot start cursor from ${homePath}: ${reason}. Re-login with: ${relogin}`);
}

export async function saveCursorAuthToVaultLocked(account: AccountRecord, sourceRaw: string): Promise<void> {
  const vaultPath = join(accountDir(account), "auth.json");
  await mkdir(dirname(vaultPath), { recursive: true, mode: 0o700 });
  await atomicWriteFile(vaultPath, sourceRaw.endsWith("\n") ? sourceRaw : `${sourceRaw}\n`, { mode: 0o600 });
}

// The live machine-global store rides the sync engine as a pseudo-home: the
// sentinel is mapped to readCursorLiveAuth() by readHomeSnapshot below.
const LIVE_STORE = " cursor-live-store";

/** Candidate sources: the live global store + the account's dedicated homes. */
async function cursorHomesForAccount(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<string[]> {
  const homes = new Map<string, string>([[LIVE_STORE, LIVE_STORE]]);
  const consider = async (home: string, trusted: boolean) => {
    if (!trusted) return;
    if ((await stat(home).catch(() => null))?.isDirectory()) homes.set(home, home);
  };
  for (const home of dedicatedHomesFor(account)) await consider(home, true);
  if (extraHome) await consider(extraHome, options.trustExtraHome === true || isDedicatedHomeForAccount(account, extraHome));
  return [...homes.values()];
}

export type CursorAuthSyncResult = { auth: CursorAuthSnapshot | null; vaultUpdated: boolean };

const cursorSyncStrategy: CredentialSyncStrategy<CursorAuthSnapshot, CursorAuthSyncResult> = {
  readVaultSnapshot: (account) => readCursorAuthFile(join(accountDir(account), "auth.json"), "vault"),
  homesForAccount: (account, extraHome, options) => cursorHomesForAccount(account, extraHome, options),
  readHomeSnapshot: (_account, home) => (home === LIVE_STORE ? readCursorLiveAuth() : readCursorAuthFile(join(home, "auth.json"), `${home}:auth.json`)),
  // The identity guard is what keeps the machine-global live store — which may
  // hold ANY account's tokens — from poisoning this account's vault.
  belongsToAccount: (snapshot, account, vault) => cursorAuthBelongsToAccount(snapshot, account, vault),
  isFresher: isFresherCursorAuth,
  save: (account, snapshot) => saveCursorAuthToVaultLocked(account, snapshot.raw),
  ledger: (account, snapshot) => ({
    type: "account.auth-sync",
    account: account.id,
    tool: "cursor",
    from: snapshot.source,
    ...(snapshot.issuedAtMs ? { refreshedAt: new Date(snapshot.issuedAtMs).toISOString() } : {}),
  }),
  result: (auth, vaultUpdated) => ({ auth, vaultUpdated }),
};

export async function syncCursorAuthToVault(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<CursorAuthSyncResult> {
  return withAccountLock(account.id, () => syncCursorAuthToVaultLocked(account, extraHome, options));
}

export async function syncCursorAuthToVaultLocked(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<CursorAuthSyncResult> {
  return runCredentialSyncLocked(account, cursorSyncStrategy, extraHome, options);
}
