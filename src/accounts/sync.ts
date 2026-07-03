import { identityRecipeForAgent } from "../drivers.js";
import { listAccounts, type AccountRecord } from "./registry.js";
import { syncClaudeChainToVault, type ChainSyncResult } from "./claudeChain.js";
import { syncCodexAuthToVault, type CodexAuthSyncResult } from "./codexAuth.js";
import { syncGrokAuthToVault, type GrokAuthSyncResult } from "./grokAuth.js";
import { syncGenericCredentialsToVault, type GenericCredentialSyncResult } from "./genericSync.js";
import type { SyncAccountCredentialsOptions } from "./credentialSync.js";

export type AccountCredentialSyncResult =
  | ChainSyncResult
  | CodexAuthSyncResult
  | GrokAuthSyncResult
  | GenericCredentialSyncResult;

/**
 * Per-tool sync dispatch. claude/codex/grok have bespoke syncers; every other
 * identity harness rotates file-backed credentials and takes the generic path.
 * Keyed by tool so adding a bespoke syncer is a one-line registration.
 */
const SYNC_BY_TOOL: Record<
  string,
  (account: AccountRecord, extraHome: string | undefined, options: SyncAccountCredentialsOptions) => Promise<AccountCredentialSyncResult>
> = {
  claude: (account, extraHome) => syncClaudeChainToVault(account, extraHome),
  codex: (account, extraHome) => syncCodexAuthToVault(account, extraHome),
  grok: (account, extraHome, options) => syncGrokAuthToVault(account, extraHome, options),
};

export async function syncAccountCredentialsToVault(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<AccountCredentialSyncResult> {
  const sync = SYNC_BY_TOOL[account.tool];
  return sync ? sync(account, extraHome, options) : syncGenericCredentialsToVault(account, extraHome, options);
}

export type AccountChainSyncOutcome = { account: string; vaultUpdated: boolean; error?: string };

/** Sweep every claude account, pulling rotated chains from homes into the vault. */
export async function syncAllClaudeChainsToVault(): Promise<AccountChainSyncOutcome[]> {
  const accounts = (await listAccounts()).filter((account) => account.tool === "claude");
  const outcomes: AccountChainSyncOutcome[] = [];
  for (const account of accounts) {
    try {
      const result = await syncClaudeChainToVault(account);
      outcomes.push({ account: account.id, vaultUpdated: result.vaultUpdated });
    } catch (error) {
      outcomes.push({ account: account.id, vaultUpdated: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

/** Sweep every codex account, pulling refreshed auth.json copies from homes into the vault. */
export async function syncAllCodexAuthToVault(): Promise<AccountChainSyncOutcome[]> {
  const accounts = (await listAccounts()).filter((account) => account.tool === "codex");
  const outcomes: AccountChainSyncOutcome[] = [];
  for (const account of accounts) {
    try {
      const result = await syncCodexAuthToVault(account);
      outcomes.push({ account: account.id, vaultUpdated: result.vaultUpdated });
    } catch (error) {
      outcomes.push({ account: account.id, vaultUpdated: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

/** Sweep every generic file-backed account into the vault. */
export async function syncAllGenericCredentialsToVault(): Promise<AccountChainSyncOutcome[]> {
  // Generic = every identity harness WITHOUT a bespoke syncer registered in
  // SYNC_BY_TOOL, so registering one automatically drops it from this sweep.
  const accounts = (await listAccounts()).filter((account) => !SYNC_BY_TOOL[account.tool] && identityRecipeForAgent(account.tool));
  const outcomes: AccountChainSyncOutcome[] = [];
  for (const account of accounts) {
    try {
      const result = await syncGenericCredentialsToVault(account);
      outcomes.push({ account: account.id, vaultUpdated: result.vaultUpdated });
    } catch (error) {
      outcomes.push({ account: account.id, vaultUpdated: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

/** Sweep all account types whose credentials rotate locally after launch. */
export async function syncAllAccountCredentialsToVault(): Promise<AccountChainSyncOutcome[]> {
  const outcomes: AccountChainSyncOutcome[] = [];
  for (const account of await listAccounts()) {
    if (!identityRecipeForAgent(account.tool)) continue;
    try {
      const result = await syncAccountCredentialsToVault(account);
      outcomes.push({ account: account.id, vaultUpdated: result.vaultUpdated });
    } catch (error) {
      outcomes.push({ account: account.id, vaultUpdated: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}
