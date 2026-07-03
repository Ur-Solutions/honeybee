import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import { accountDir, recipeFor, withAccountLock, type AccountRecord } from "./registry.js";
import { dedicatedHomesFor, isDedicatedHomeForAccount } from "./homes.js";
import {
  runCredentialSyncLocked,
  type CredentialSyncStrategy,
  type SyncAccountCredentialsOptions,
} from "./credentialSync.js";

type GenericCredentialFile = {
  relative: string;
  raw: string;
  mtimeMs: number;
};

type GenericCredentialBundle = {
  files: GenericCredentialFile[];
  freshnessMs: number;
  source: string;
};

export type GenericCredentialSyncResult = { credentials: GenericCredentialBundle | null; vaultUpdated: boolean };

async function genericCredentialHomesForAccount(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<string[]> {
  const homes = new Map<string, string>();
  const consider = async (home: string, trusted: boolean) => {
    if (!trusted) return;
    if ((await stat(home).catch(() => null))?.isDirectory()) homes.set(resolve(home), home);
  };
  for (const home of dedicatedHomesFor(account)) await consider(home, true);
  if (extraHome) await consider(extraHome, options.trustExtraHome === true || isDedicatedHomeForAccount(account, extraHome));
  return [...homes.values()];
}

async function readGenericCredentialBundle(account: AccountRecord, rootPath: string, source: string): Promise<GenericCredentialBundle | null> {
  const recipe = recipeFor(account);
  const primary = recipe.credentialFiles[0]!;
  const primaryInfo = await stat(join(rootPath, primary)).catch(() => null);
  if (!primaryInfo?.isFile()) return null;
  const files: GenericCredentialFile[] = [];
  let freshnessMs = primaryInfo.mtimeMs;
  for (const relative of recipe.credentialFiles) {
    const path = join(rootPath, relative);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    files.push({ relative, raw: await readFile(path, "utf8"), mtimeMs: info.mtimeMs });
    freshnessMs = Math.max(freshnessMs, info.mtimeMs);
  }
  return { files, freshnessMs, source };
}

function genericCredentialFingerprint(bundle: GenericCredentialBundle): string {
  return JSON.stringify(bundle.files.map((file) => [file.relative, file.raw]));
}

function isFresherGenericCredentialBundle(candidate: GenericCredentialBundle, current: GenericCredentialBundle | null): boolean {
  if (!current) return true;
  if (genericCredentialFingerprint(candidate) === genericCredentialFingerprint(current)) return false;
  return candidate.freshnessMs > current.freshnessMs;
}

async function saveGenericCredentialBundleToVaultLocked(account: AccountRecord, bundle: GenericCredentialBundle): Promise<void> {
  for (const file of bundle.files) {
    const target = join(accountDir(account), file.relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await atomicWriteFile(target, file.raw.endsWith("\n") ? file.raw : `${file.raw}\n`, { mode: 0o600 });
  }
}

// No belongsToAccount guard: genericCredentialHomesForAccount only ever yields
// dedicated (or explicitly session-trusted) homes, so every candidate is the
// account's by construction — the file bytes carry no common identity claim to
// re-verify against.
const genericSyncStrategy: CredentialSyncStrategy<GenericCredentialBundle, GenericCredentialSyncResult> = {
  readVaultSnapshot: (account) => readGenericCredentialBundle(account, accountDir(account), "vault"),
  homesForAccount: (account, extraHome, options) => genericCredentialHomesForAccount(account, extraHome, options),
  readHomeSnapshot: (account, home) => readGenericCredentialBundle(account, home, home),
  isFresher: isFresherGenericCredentialBundle,
  save: (account, bundle) => saveGenericCredentialBundleToVaultLocked(account, bundle),
  ledger: (account, bundle) => ({
    type: "account.credential-sync",
    account: account.id,
    tool: account.tool,
    from: bundle.source,
    files: bundle.files.map((file) => file.relative),
    refreshedAt: new Date(bundle.freshnessMs).toISOString(),
  }),
  result: (credentials, vaultUpdated) => ({ credentials, vaultUpdated }),
};

export async function syncGenericCredentialsToVault(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<GenericCredentialSyncResult> {
  return withAccountLock(account.id, () => syncGenericCredentialsToVaultLocked(account, extraHome, options));
}

export async function syncGenericCredentialsToVaultLocked(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<GenericCredentialSyncResult> {
  return runCredentialSyncLocked(account, genericSyncStrategy, extraHome, options);
}
