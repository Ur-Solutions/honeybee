// ──────────────────────────────────────────────────────────────────────────
// The credential vault. LOCAL ONLY — never synced. An account is a provider
// identity (the "who"); a home is a slot (the "where"). Activating an account
// copies its credential files into a home under that account's lock.
//
// This is the public barrel. The implementation lives in accounts/*: the
// registry + resolution, per-tool credential sync (claude chain, codex/grok
// auth, generic file-backed), the shared CredentialSyncStrategy engine that
// unifies the file-backed syncers, home enumeration/defaults, and activation.
// Every symbol below kept its original name and signature so existing imports
// of "./accounts.js" are unaffected.
// ──────────────────────────────────────────────────────────────────────────

export {
  type AccountRecord,
  accountCli,
  PROVIDER_BY_CLI,
  normalizeAccountRecord,
  vaultRoot,
  accountsRegistryPath,
  accountsLockPath,
  accountLockPath,
  accountDir,
  withAccountsLock,
  withAccountLock,
  CROSS_ACCOUNT_LOCK_TIMEOUT_MS,
  accountIdFor,
  listAccounts,
  type AddAccountOptions,
  addAccount,
  removeAccount,
  setAccountPaused,
} from "./accounts/registry.js";

export {
  findAccount,
  AUTO_ACCOUNT_QUERY,
  RR_ACCOUNT_QUERY,
  autoAccountTool,
  roundRobinAccountTool,
  type SpawnAgentSpec,
  resolveSpawnAgent,
} from "./accounts/resolve.js";

export { accountEmail, emailFromJwt, expFromJwt } from "./accounts/utils.js";

export { candidateHomes, defaultHomeForAccount } from "./accounts/homes.js";

export { seedClaudeHomeAcceptance } from "./accounts/homeDefaults.js";

export {
  type ClaudeChain,
  type RefreshedClaudeToken,
  parseClaudeChain,
  readHomeClaudeChain,
  homeClaudeEmail,
  claudeHomesForAccount,
  homeBelongsToAccount,
  mergeCredentialsJson,
  claudeCredentialsEquivalent,
  saveClaudeOauthToVault,
  type ChainSyncResult,
  type ChainSyncDeps,
  claudeProfileEmailCached,
  syncClaudeChainToVault,
  refreshClaudeOauthChain,
  persistClaudeChainLocked,
  readVaultClaudeChain,
} from "./accounts/claudeChain.js";

export {
  codexAuthEmail,
  type CodexAuthSnapshot,
  codexHomesForAccount,
  type CodexAuthSyncResult,
  syncCodexAuthToVault,
  codexAccessTokenExp,
  CODEX_TOKEN_MIN_TTL_MS,
  type CodexTokenFreshness,
  type EnsureFreshCodexDeps,
  ensureFreshCodexVaultToken,
} from "./accounts/codexAuth.js";

export {
  type GrokAuthSnapshot,
  assertGrokHomeAuthFresh,
  grokHomesForAccount,
  type GrokAuthSyncResult,
  syncGrokAuthToVault,
} from "./accounts/grokAuth.js";

export {
  type CursorAuthSnapshot,
  assertCursorHomeAuthFresh,
  cursorLiveAuthDigest,
  readCursorLiveAuth,
  type CursorAuthSyncResult,
  syncCursorAuthToVault,
} from "./accounts/cursorAuth.js";

export { type GenericCredentialSyncResult, syncGenericCredentialsToVault } from "./accounts/genericSync.js";

export { type SyncAccountCredentialsOptions } from "./accounts/credentialSync.js";

export {
  type AccountCredentialSyncResult,
  syncAccountCredentialsToVault,
  type AccountChainSyncOutcome,
  syncAllClaudeChainsToVault,
  syncAllCodexAuthToVault,
  syncAllGenericCredentialsToVault,
  syncAllAccountCredentialsToVault,
} from "./accounts/sync.js";

export {
  captureAccountFromHome,
  type ActivateAccountOptions,
  activateAccountIntoHome,
  accountHasCredentials,
} from "./accounts/activation.js";
