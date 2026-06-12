import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalAgentKind } from "./agents.js";
import { hasAgentDriver, identityRecipeForAgent, type IdentityRecipe } from "./drivers.js";
import { keychainAvailable, readClaudeKeychain, writeClaudeKeychain } from "./keychain.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger, safeName } from "./store.js";

// ──────────────────────────────────────────────────────────────────────────
// The credential vault. LOCAL ONLY — never synced. An account is a provider
// identity (the "who"); a home is a slot (the "where"). Activating an account
// copies its credential files into a home under the accounts lock.
// ──────────────────────────────────────────────────────────────────────────

export type AccountRecord = {
  id: string;
  tool: string;
  label: string;
  email?: string;
  addedAt: string;
};

export function vaultRoot(): string {
  return join(storeRoot(), "vault");
}

export function accountsRegistryPath(): string {
  return join(vaultRoot(), "accounts.json");
}

export function accountsLockPath(): string {
  return join(storeRoot(), "accounts.lock");
}

export function accountDir(account: Pick<AccountRecord, "tool" | "id">): string {
  return join(vaultRoot(), account.tool, account.id);
}

export function withAccountsLock<T>(fn: () => Promise<T>): Promise<T> {
  // Activation may refresh an OAuth chain over the network (15s cap) while
  // holding the lock; give waiters enough patience to outlive that.
  return withFileLock(accountsLockPath(), fn, { timeoutMs: 30_000 });
}

export function accountIdFor(tool: string, label: string): string {
  return safeName(`${tool}-${label}`).toLowerCase();
}

async function ensureVault(): Promise<void> {
  await mkdir(vaultRoot(), { recursive: true, mode: 0o700 });
}

export async function listAccounts(): Promise<AccountRecord[]> {
  let raw: string;
  try {
    raw = await readFile(accountsRegistryPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in account registry: ${accountsRegistryPath()}`);
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isAccountRecord);
}

function isAccountRecord(value: unknown): value is AccountRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    typeof object.id === "string" &&
    typeof object.tool === "string" &&
    typeof object.label === "string" &&
    typeof object.addedAt === "string"
  );
}

async function writeRegistry(accounts: AccountRecord[]): Promise<void> {
  await ensureVault();
  await atomicWriteFile(accountsRegistryPath(), `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
}

export type AddAccountOptions = {
  email?: string;
};

export async function addAccount(tool: string, label: string, options: AddAccountOptions = {}): Promise<AccountRecord> {
  const kind = canonicalAgentKind(tool).toLowerCase();
  if (!hasAgentDriver(kind)) throw new Error(`Unknown tool: ${tool}. Accounts need an agent driver.`);
  if (!identityRecipeForAgent(kind)) throw new Error(`Tool ${kind} has no identity recipe; cannot vault its credentials.`);
  if (!label.trim()) throw new Error("Account label must not be empty");

  return withAccountsLock(async () => {
    const accounts = await listAccounts();
    const id = accountIdFor(kind, label.trim());
    if (accounts.some((account) => account.id === id)) throw new Error(`Account already exists: ${id}`);
    const email = options.email ?? (label.includes("@") ? label.trim() : undefined);
    const record: AccountRecord = {
      id,
      tool: kind,
      label: label.trim(),
      ...(email ? { email } : {}),
      addedAt: new Date().toISOString(),
    };
    await writeRegistry([...accounts, record]);
    await mkdir(accountDir(record), { recursive: true, mode: 0o700 });
    await appendLedger({ type: "account.add", account: record.id, tool: record.tool, label: record.label });
    return record;
  });
}

export async function removeAccount(idOrLabel: string): Promise<AccountRecord> {
  return withAccountsLock(async () => {
    const accounts = await listAccounts();
    const account = matchAccount(accounts, idOrLabel);
    await writeRegistry(accounts.filter((candidate) => candidate.id !== account.id));
    await rm(accountDir(account), { recursive: true, force: true });
    await appendLedger({ type: "account.remove", account: account.id, tool: account.tool });
    return account;
  });
}

export async function findAccount(idOrLabel: string, tool?: string): Promise<AccountRecord> {
  const accounts = await listAccounts();
  const pool = tool ? accounts.filter((account) => account.tool === canonicalAgentKind(tool).toLowerCase()) : accounts;
  try {
    return matchAccount(pool, idOrLabel);
  } catch (error) {
    // `<tool>-<query>` shorthand (codex-ur, claude-thto): scope the fuzzy
    // match to the tool named by the prefix. Only a fallback — a verbatim
    // id/label match above always wins.
    if (!tool) {
      const shorthand = splitToolShorthand(idOrLabel);
      if (shorthand) {
        const scoped = accounts.filter((account) => account.tool === shorthand.tool);
        try {
          return matchAccount(scoped, shorthand.query);
        } catch {
          // fall through to the original error
        }
      }
    }
    throw error;
  }
}

function splitToolShorthand(value: string): { tool: string; query: string } | undefined {
  const dash = value.indexOf("-");
  if (dash <= 0 || dash === value.length - 1) return undefined;
  const tool = canonicalAgentKind(value.slice(0, dash)).toLowerCase();
  if (!hasAgentDriver(tool) || !identityRecipeForAgent(tool)) return undefined;
  return { tool, query: value.slice(dash + 1) };
}

/**
 * Reserved account query: `--account auto` / `<tool>-auto` ask for the tool's
 * least-loaded account instead of naming one. The pick itself lives in
 * limits.ts (it needs the provider windows); this module only reserves the
 * word so it never falls through to fuzzy matching.
 */
export const AUTO_ACCOUNT_QUERY = "auto";

/** `<tool>-auto` spawn alias → the tool whose least-loaded account to pick, else undefined. */
export function autoAccountTool(value: string): string | undefined {
  const shorthand = splitToolShorthand(value);
  return shorthand?.query === AUTO_ACCOUNT_QUERY ? shorthand.tool : undefined;
}

export type SpawnAgentSpec = {
  agent: string;
  account?: AccountRecord;
};

/**
 * Resolve a spawn-spec token into an agent plus an optional vault account.
 * Plain tools and home aliases pass through (`claude`, `cc1`, `codex2`);
 * `<tool>-<query>` binds an account by tool-scoped fuzzy match (`codex-ur`,
 * `claude-thto`). Unknown tokens pass through unchanged so arbitrary
 * executables (`my-agent`) still spawn.
 */
export async function resolveSpawnAgent(kind: string): Promise<SpawnAgentSpec> {
  if (hasAgentDriver(canonicalAgentKind(kind).toLowerCase())) return { agent: kind };
  const shorthand = splitToolShorthand(kind);
  if (shorthand) {
    try {
      return { agent: shorthand.tool, account: await findAccount(shorthand.query, shorthand.tool) };
    } catch {
      // not an account shorthand — treat as an arbitrary executable
    }
  }
  return { agent: kind };
}

function matchAccount(accounts: AccountRecord[], query: string): AccountRecord {
  const trimmed = query.trim();
  const exact = accounts.find((account) => account.id === trimmed || account.label === trimmed);
  if (exact) return exact;
  const partial = accounts.filter((account) => account.id.includes(trimmed) || account.label.includes(trimmed));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`Ambiguous account ${query}: ${partial.map((account) => account.id).join(", ")}`);
  }
  throw new Error(`Unknown account: ${query}. Register one with: hive account add <tool> <label>`);
}

function recipeFor(account: AccountRecord): IdentityRecipe {
  const recipe = identityRecipeForAgent(account.tool);
  if (!recipe) throw new Error(`Tool ${account.tool} has no identity recipe`);
  return recipe;
}

/**
 * Copy the recipe's credential files out of a home into the vault. Files that
 * don't exist in the home are skipped; at least one must be captured.
 */
export async function captureAccountFromHome(account: AccountRecord, homePath: string): Promise<string[]> {
  const recipe = recipeFor(account);
  return withAccountsLock(async () => {
    const captured: string[] = [];
    for (const relative of recipe.credentialFiles) {
      const source = join(homePath, relative);
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) continue;
      const target = join(accountDir(account), relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const data = await readFile(source, "utf8");
      await atomicWriteFile(target, data, { mode: 0o600 });
      captured.push(relative);
    }
    // On macOS, claude stores the primary credential in the Keychain rather
    // than .credentials.json — and when both exist, the on-disk file is often
    // a stale relic of an old login. Vault whichever is fresher.
    const primary = recipe.credentialFiles[0]!;
    if (account.tool === "claude" && keychainAvailable()) {
      const keychainRaw = await readClaudeKeychain(homePath);
      if (keychainRaw) {
        const fileRaw = await readFile(join(homePath, primary), "utf8").catch(() => null);
        if (!fileRaw || (claudeTokenExpiry(keychainRaw) ?? 0) > (claudeTokenExpiry(fileRaw) ?? 0)) {
          const target = join(accountDir(account), primary);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await atomicWriteFile(target, `${keychainRaw}\n`, { mode: 0o600 });
          if (!captured.includes(primary)) captured.push(primary);
        }
      }
    }
    if (captured.length === 0) {
      throw new Error(
        `No credential files found in ${homePath} for ${account.id} (looked for: ${recipe.credentialFiles.join(", ")})`,
      );
    }
    await appendLedger({ type: "account.capture", account: account.id, home: homePath, files: captured });
    return captured;
  });
}

export type ActivateAccountOptions = {
  /** Surface non-fatal activation warnings (stale chain, failed refresh). */
  onWarn?: (message: string) => void;
  /** OAuth refresh override (tests). Defaults to refreshClaudeOauthChain. */
  refreshClaudeToken?: (refreshToken: string) => Promise<RefreshedClaudeToken | null>;
  now?: () => number;
};

/**
 * Activate an account into a home: copy its vaulted credential files (plus any
 * activation mirrors) into the home. This is "fast login" — the mechanical
 * primitive behind activate/spawn --account/swap-account.
 *
 * For claude the vault copy is NOT trusted blindly: refresh tokens rotate, so
 * the live link of the chain is wherever the last refresh happened (usually a
 * running session's home). Activation first rescues a foreign occupant's
 * chain, then pulls the account's own freshest link into the vault, then
 * refreshes a stale chain — only after that does it stamp.
 */
export async function activateAccountIntoHome(account: AccountRecord, homePath: string, options: ActivateAccountOptions = {}): Promise<string[]> {
  const recipe = recipeFor(account);
  const warn = options.onWarn ?? (() => undefined);
  return withAccountsLock(async () => {
    if (account.tool === "claude") {
      // (1) The home may currently hold ANOTHER account's chain (swap). The
      // rotated live link exists only there — rescue it into its own vault
      // before stamping over it, or that account's next activation revives a
      // dead link and logs it out.
      await evacuateForeignClaudeChainLocked(account, homePath).catch(() => undefined);
      // (2) Pull the account's own freshest link into the vault so we never
      // stamp a dead link over a live one.
      await syncClaudeChainToVaultLocked(account, homePath).catch(() => undefined);
      // (3) A stale chain would make claude boot onto an expired access token
      // and replay a possibly-rotated refresh token. Refresh it ourselves and
      // persist the rotation; on failure, warn and stamp anyway (the chain
      // may still recover, e.g. when we are merely offline).
      try {
        await refreshVaultClaudeChainIfStaleLocked(account, options);
      } catch (error) {
        warn(`could not refresh the stale OAuth chain for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Refuse to activate without the primary credential: copying only the
    // supporting snapshots would clobber the home's settings without a login.
    const primary = join(accountDir(account), recipe.credentialFiles[0]!);
    if (!(await stat(primary).catch(() => null))?.isFile()) {
      throw new Error(`Vault has no credentials for ${account.id}. Capture them first: hive account login ${account.tool} ${account.label}`);
    }
    const written: string[] = [];
    for (const relative of recipe.credentialFiles) {
      const source = join(accountDir(account), relative);
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) continue;
      const targets = [relative, ...(recipe.activationMirrors?.[relative] ? [recipe.activationMirrors[relative]!] : [])];
      for (const homeRelative of targets) {
        const target = join(homePath, homeRelative);
        await mkdir(dirname(target), { recursive: true });
        const data = await readFile(source, "utf8");
        await atomicWriteFile(target, data, { mode: 0o600 });
        written.push(homeRelative);
      }
    }
    if (written.length === 0) {
      throw new Error(`Vault has no credentials for ${account.id}. Capture them first: hive account login ${account.tool} ${account.label}`);
    }
    // On macOS, claude prefers the per-config-dir Keychain entry over the
    // credentials file — seed it so an activated home doesn't resolve a stale
    // identity from an old entry. Merged, not replaced: home-local sibling
    // keys (mcpOAuth, ...) survive the identity stamp.
    if (account.tool === "claude" && keychainAvailable()) {
      const credentials = (await readFile(join(accountDir(account), recipe.credentialFiles[0]!), "utf8")).trim();
      const existing = await readClaudeKeychain(homePath);
      const ok = await writeClaudeKeychain(homePath, mergeCredentialsJson(existing, credentials));
      if (ok) {
        written.push("keychain");
      } else if (existing) {
        // A stale entry exists and we could not replace it: claude would keep
        // using the OLD account. Refuse rather than activate a lie.
        throw new Error(`Could not update the macOS Keychain entry for ${homePath}; claude would keep its previous identity`);
      }
    }
    await appendLedger({ type: "account.activate", account: account.id, tool: account.tool, home: homePath, files: written });
    return written;
  });
}

/**
 * Seed claude's per-home acceptance state so opening a hive home does not
 * re-ask the startup questions (bypass-permissions consent, folder trust,
 * onboarding) every single time. Activation copies the vaulted .claude.json
 * snapshot over the home's copy, wiping whatever was answered last session —
 * so the acceptances must be re-merged after every activation, not just once.
 */
export async function seedClaudeHomeAcceptance(homePath: string, opts: { yolo?: boolean; trustCwd?: string } = {}): Promise<void> {
  const path = join(homePath, ".claude.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable: start from the acceptances alone.
  }
  config.hasCompletedOnboarding = true;
  if (opts.yolo) config.bypassPermissionsModeAccepted = true;
  if (opts.trustCwd) {
    const rawProjects = config.projects;
    const projects = rawProjects && typeof rawProjects === "object" && !Array.isArray(rawProjects) ? (rawProjects as Record<string, unknown>) : {};
    const rawEntry = projects[opts.trustCwd];
    const entry = rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry) ? (rawEntry as Record<string, unknown>) : {};
    entry.hasTrustDialogAccepted = true;
    entry.hasCompletedProjectOnboarding = true;
    projects[opts.trustCwd] = entry;
    config.projects = projects;
  }
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function claudeTokenExpiry(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown } };
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
  /** Full credentials JSON as found (preserves sibling keys like mcpOAuth). */
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

export function parseClaudeChain(raw: string | null, source: string): ClaudeChain | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || typeof oauth.expiresAt !== "number") return null;
    return {
      raw,
      oauth,
      expiresAt: oauth.expiresAt,
      ...(typeof oauth.refreshToken === "string" ? { refreshToken: oauth.refreshToken } : {}),
      source,
    };
  } catch {
    return null;
  }
}

/** The freshest chain link present in a home — its keychain entry or credentials file. */
export async function readHomeClaudeChain(homePath: string): Promise<ClaudeChain | null> {
  const fromFile = parseClaudeChain(await readFile(join(homePath, ".credentials.json"), "utf8").catch(() => null), `${homePath}:file`);
  const fromKeychain = parseClaudeChain(await readClaudeKeychain(homePath), `${homePath}:keychain`);
  if (fromFile && fromKeychain) return fromKeychain.expiresAt >= fromFile.expiresAt ? fromKeychain : fromFile;
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

export function accountEmail(account: Pick<AccountRecord, "email" | "label">): string | undefined {
  return account.email ?? (account.label.includes("@") ? account.label : undefined);
}

/** All `~/.{tool}` / `~/.{tool}-N` style shared homes present on this machine. */
export async function candidateHomes(tool: string): Promise<string[]> {
  const homes: string[] = [];
  const candidates = [join(homedir(), `.${tool}`)];
  for (let slot = 1; slot <= 9; slot += 1) candidates.push(join(homedir(), `.${tool}-${slot}`));
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) homes.push(candidate);
  }
  return homes;
}

function dedicatedHomesFor(account: AccountRecord): string[] {
  return [join(storeRoot(), "homes", account.id), join(storeRoot(), "login-homes", account.id)];
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
  try {
    const target = targetRaw ? (JSON.parse(targetRaw) as unknown) : {};
    const source = JSON.parse(sourceRaw) as Record<string, unknown>;
    if (!target || typeof target !== "object" || Array.isArray(target)) return sourceRaw;
    return JSON.stringify({ ...(target as Record<string, unknown>), ...source }, null, 2);
  } catch {
    return sourceRaw;
  }
}

async function saveClaudeChainToVaultLocked(account: AccountRecord, sourceRaw: string): Promise<void> {
  const vaultPath = join(accountDir(account), ".credentials.json");
  const existing = await readFile(vaultPath, "utf8").catch(() => null);
  await mkdir(dirname(vaultPath), { recursive: true, mode: 0o700 });
  await atomicWriteFile(vaultPath, `${mergeCredentialsJson(existing, sourceRaw)}\n`, { mode: 0o600 });
}

/** Write a chain's claudeAiOauth into the vault file, preserving sibling keys. */
export async function saveClaudeOauthToVault(account: AccountRecord, oauth: Record<string, unknown>): Promise<void> {
  await withAccountsLock(async () => {
    await saveClaudeChainToVaultLocked(account, JSON.stringify({ claudeAiOauth: oauth }));
    await appendLedger({ type: "account.chain-sync", account: account.id, from: "verified-credential" });
  });
}

export type ChainSyncResult = { chain: ClaudeChain | null; vaultUpdated: boolean };

/**
 * Pull the freshest attributed chain link into the vault. Reads the vault
 * snapshot plus every home attributable to the account (and extraHome when
 * attributable); when a home holds a fresher link than the vault — a
 * running or past claude rotated the chain there — the vault catches up, so
 * a later activation does not stamp a dead link over a live one.
 */
export async function syncClaudeChainToVault(account: AccountRecord, extraHome?: string): Promise<ChainSyncResult> {
  return withAccountsLock(() => syncClaudeChainToVaultLocked(account, extraHome));
}

async function syncClaudeChainToVaultLocked(account: AccountRecord, extraHome?: string): Promise<ChainSyncResult> {
  const vaultPath = join(accountDir(account), ".credentials.json");
  const vault = parseClaudeChain(await readFile(vaultPath, "utf8").catch(() => null), "vault");
  const homes = new Map<string, string>();
  for (const home of await claudeHomesForAccount(account)) homes.set(resolve(home), home);
  if (extraHome && !homes.has(resolve(extraHome)) && (await homeBelongsToAccount(extraHome, account))) {
    homes.set(resolve(extraHome), extraHome);
  }
  let best = vault;
  for (const home of homes.values()) {
    const chain = await readHomeClaudeChain(home);
    if (chain && (!best || chain.expiresAt > best.expiresAt)) best = chain;
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

/**
 * The home being activated may hold ANOTHER account's chain whose live link
 * exists nowhere else. Rescue it into its owner's vault (freshness-guarded)
 * before the stamp destroys it.
 */
async function evacuateForeignClaudeChainLocked(account: AccountRecord, homePath: string): Promise<void> {
  const occupant = await readHomeClaudeChain(homePath);
  if (!occupant) return;
  const email = await homeClaudeEmail(homePath);
  if (!email || email === accountEmail(account)) return;
  const owner = (await listAccounts()).find(
    (candidate) => candidate.tool === "claude" && candidate.id !== account.id && accountEmail(candidate) === email,
  );
  if (!owner) return;
  const vault = parseClaudeChain(await readFile(join(accountDir(owner), ".credentials.json"), "utf8").catch(() => null), "vault");
  if (vault && vault.expiresAt >= occupant.expiresAt) return;
  await saveClaudeChainToVaultLocked(owner, occupant.raw);
  await appendLedger({ type: "account.chain-evacuate", account: owner.id, home: homePath });
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
 */
export async function persistClaudeChain(account: AccountRecord, oauth: Record<string, unknown>): Promise<void> {
  const sourceRaw = JSON.stringify({ claudeAiOauth: oauth });
  await saveClaudeChainToVaultLocked(account, sourceRaw);
  for (const home of await claudeHomesForAccount(account)) {
    try {
      const existingEntry = await readClaudeKeychain(home);
      await writeClaudeKeychain(home, mergeCredentialsJson(existingEntry, sourceRaw));
      // Only update home files that already exist — refresh propagation must
      // not seed credentials into homes that never held them.
      const filePath = join(home, ".credentials.json");
      const existingFile = await readFile(filePath, "utf8").catch(() => null);
      if (existingFile !== null) {
        await atomicWriteFile(filePath, `${mergeCredentialsJson(existingFile, sourceRaw)}\n`, { mode: 0o600 });
      }
    } catch {
      // best effort per home
    }
  }
  await appendLedger({ type: "account.token-refresh", account: account.id });
}

// Refresh slightly before the deadline so claude never boots onto a token
// that expires mid-handshake.
const CHAIN_EXPIRY_SKEW_MS = 60_000;

async function refreshVaultClaudeChainIfStaleLocked(account: AccountRecord, options: ActivateAccountOptions): Promise<void> {
  const now = (options.now ?? Date.now)();
  const vaultPath = join(accountDir(account), ".credentials.json");
  const chain = parseClaudeChain(await readFile(vaultPath, "utf8").catch(() => null), "vault");
  if (!chain || chain.expiresAt > now + CHAIN_EXPIRY_SKEW_MS) return;
  if (!chain.refreshToken) {
    options.onWarn?.(`the vaulted OAuth token for ${account.id} is expired and has no refresh token; claude may ask for a fresh login (hive login ${account.id})`);
    return;
  }
  const refresh = options.refreshClaudeToken ?? refreshClaudeOauthChain;
  const refreshed = await refresh(chain.refreshToken);
  if (!refreshed) {
    options.onWarn?.(`the OAuth chain for ${account.id} is expired and could not be refreshed; claude may ask for a fresh login (hive login ${account.id})`);
    return;
  }
  const oauth: Record<string, unknown> = {
    ...chain.oauth,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    ...(refreshed.scopes ? { scopes: refreshed.scopes } : {}),
  };
  await persistClaudeChain(account, oauth);
}

/** True when the vault holds the account's PRIMARY credential file. */
export async function accountHasCredentials(account: AccountRecord): Promise<boolean> {
  const recipe = identityRecipeForAgent(account.tool);
  if (!recipe) return false;
  const info = await stat(join(accountDir(account), recipe.credentialFiles[0]!)).catch(() => null);
  return info?.isFile() === true;
}

/** Default dedicated home slot for an account when no --home is given. */
export function defaultHomeForAccount(account: AccountRecord): string {
  return join(storeRoot(), "homes", account.id);
}

