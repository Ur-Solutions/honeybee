import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import { accountDir, withAccountLock, type AccountRecord } from "./registry.js";
import { accountEmail, parseTimeMs } from "./utils.js";
import { candidateHomes, dedicatedHomesFor, isDedicatedHomeForAccount } from "./homes.js";
import {
  runCredentialSyncLocked,
  type CredentialSyncStrategy,
  type SyncAccountCredentialsOptions,
} from "./credentialSync.js";

export type GrokAuthSnapshot = {
  raw: string;
  emails: Set<string>;
  createTimeMs?: number;
  expiresAtMs?: number;
  mtimeMs: number;
  source: string;
};

const GROK_AUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

export async function readGrokAuthFile(path: string, source: string): Promise<GrokAuthSnapshot | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const raw = await readFile(path, "utf8").catch(() => null);
  return parseGrokAuth(raw, source, info.mtimeMs);
}

function parseGrokAuth(raw: string | null, source: string, mtimeMs: number): GrokAuthSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.values(parsed as Record<string, unknown>);
    const emails = new Set<string>();
    let createTimeMs: number | undefined;
    let expiresAtMs: number | undefined;
    let hasCredentialEntry = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const object = entry as Record<string, unknown>;
      if (typeof object.key === "string" || typeof object.refresh_token === "string") hasCredentialEntry = true;
      if (typeof object.email === "string") emails.add(object.email);
      const create = parseTimeMs(object.create_time);
      const expires = parseTimeMs(object.expires_at);
      if (create !== undefined) createTimeMs = Math.max(createTimeMs ?? create, create);
      if (expires !== undefined) expiresAtMs = Math.max(expiresAtMs ?? expires, expires);
    }
    if (!hasCredentialEntry) return null;
    return { raw, emails, ...(createTimeMs !== undefined ? { createTimeMs } : {}), ...(expiresAtMs !== undefined ? { expiresAtMs } : {}), mtimeMs, source };
  } catch {
    return null;
  }
}

async function readHomeGrokAuth(homePath: string): Promise<GrokAuthSnapshot | null> {
  return readGrokAuthFile(join(homePath, "auth.json"), `${homePath}:auth.json`);
}

function grokAuthFreshnessMs(snapshot: GrokAuthSnapshot): number {
  return snapshot.createTimeMs ?? snapshot.expiresAtMs ?? snapshot.mtimeMs;
}

function isFresherGrokAuth(candidate: GrokAuthSnapshot, current: GrokAuthSnapshot | null): boolean {
  if (!current) return true;
  if (candidate.raw === current.raw) return false;
  return grokAuthFreshnessMs(candidate) > grokAuthFreshnessMs(current);
}

export function grokAuthUnavailableReason(snapshot: GrokAuthSnapshot | null, now: number, skewMs = GROK_AUTH_EXPIRY_SKEW_MS): string | null {
  if (!snapshot) return "missing auth.json";
  if (snapshot.expiresAtMs === undefined) return null;
  const expiresAt = new Date(snapshot.expiresAtMs).toISOString();
  if (snapshot.expiresAtMs <= now) return `OAuth token expired at ${expiresAt}`;
  if (snapshot.expiresAtMs <= now + skewMs) return `OAuth token expires soon at ${expiresAt}`;
  return null;
}

export async function assertGrokHomeAuthFresh(
  homePath: string,
  options: { accountId?: string; now?: () => number; skewMs?: number } = {},
): Promise<void> {
  const reason = grokAuthUnavailableReason(
    await readHomeGrokAuth(homePath),
    options.now?.() ?? Date.now(),
    options.skewMs ?? GROK_AUTH_EXPIRY_SKEW_MS,
  );
  if (!reason) return;
  const relogin = options.accountId ? `hive login ${options.accountId}` : "hive login <grok-account>";
  throw new Error(`Cannot start Grok from ${homePath}: ${reason}. Re-login with: ${relogin}`);
}

async function grokAccountEmails(account: AccountRecord, vault?: GrokAuthSnapshot | null): Promise<Set<string>> {
  const emails = new Set<string>();
  const explicit = accountEmail(account);
  if (explicit) emails.add(explicit);
  const snapshot = vault ?? await readGrokAuthFile(join(accountDir(account), "auth.json"), "vault");
  for (const email of snapshot?.emails ?? []) emails.add(email);
  return emails;
}

async function grokAuthBelongsToAccount(snapshot: GrokAuthSnapshot | null, account: AccountRecord, vault?: GrokAuthSnapshot | null): Promise<boolean> {
  if (!snapshot || snapshot.emails.size === 0) return true;
  const emails = await grokAccountEmails(account, vault);
  return emails.size === 0 || [...snapshot.emails].some((email) => emails.has(email));
}

async function homeBelongsToGrokAccount(homePath: string, account: AccountRecord, vault?: GrokAuthSnapshot | null): Promise<boolean> {
  const target = resolve(homePath);
  const dedicated = dedicatedHomesFor(account).some((dir) => resolve(dir) === target);
  const snapshot = await readHomeGrokAuth(homePath);
  if (snapshot?.emails.size) return grokAuthBelongsToAccount(snapshot, account, vault);
  return dedicated;
}

/** Homes attributable to the Grok account: dedicated slots + email-matched shared homes. */
export async function grokHomesForAccount(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<string[]> {
  const vault = await readGrokAuthFile(join(accountDir(account), "auth.json"), "vault");
  const matched = new Map<string, string>();
  const consider = async (home: string, trusted: boolean) => {
    if ((await stat(home).catch(() => null))?.isDirectory() && (trusted || await homeBelongsToGrokAccount(home, account, vault))) {
      matched.set(resolve(home), home);
    }
  };
  for (const dir of dedicatedHomesFor(account)) await consider(dir, true);
  if (extraHome) await consider(extraHome, options.trustExtraHome === true || isDedicatedHomeForAccount(account, extraHome));
  if ((await grokAccountEmails(account, vault)).size > 0) {
    for (const home of await candidateHomes("grok")) await consider(home, false);
  }
  return [...matched.values()];
}

async function saveGrokAuthToVaultLocked(account: AccountRecord, sourceRaw: string): Promise<void> {
  const vaultPath = join(accountDir(account), "auth.json");
  await mkdir(dirname(vaultPath), { recursive: true, mode: 0o700 });
  await atomicWriteFile(vaultPath, sourceRaw.endsWith("\n") ? sourceRaw : `${sourceRaw}\n`, { mode: 0o600 });
}

export type GrokAuthSyncResult = { auth: GrokAuthSnapshot | null; vaultUpdated: boolean };

const grokSyncStrategy: CredentialSyncStrategy<GrokAuthSnapshot, GrokAuthSyncResult> = {
  readVaultSnapshot: (account) => readGrokAuthFile(join(accountDir(account), "auth.json"), "vault"),
  homesForAccount: (account, extraHome, options) => grokHomesForAccount(account, extraHome, options),
  readHomeSnapshot: (_account, home) => readHomeGrokAuth(home),
  belongsToAccount: (snapshot, account, vault) => grokAuthBelongsToAccount(snapshot, account, vault),
  isFresher: isFresherGrokAuth,
  save: (account, snapshot) => saveGrokAuthToVaultLocked(account, snapshot.raw),
  ledger: (account, snapshot) => ({
    type: "account.auth-sync",
    account: account.id,
    tool: "grok",
    from: snapshot.source,
    ...(snapshot.createTimeMs ? { refreshedAt: new Date(snapshot.createTimeMs).toISOString() } : {}),
  }),
  result: (auth, vaultUpdated) => ({ auth, vaultUpdated }),
};

export async function syncGrokAuthToVault(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<GrokAuthSyncResult> {
  return withAccountLock(account.id, () => syncGrokAuthToVaultLocked(account, extraHome, options));
}

export async function syncGrokAuthToVaultLocked(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<GrokAuthSyncResult> {
  return runCredentialSyncLocked(account, grokSyncStrategy, extraHome, options);
}
