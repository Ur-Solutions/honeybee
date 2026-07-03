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
  tool: string; // == cli; kept under the name `tool` on disk for back-compat (see `accountCli`)
  label: string;
  provider?: string; // NEW: required after normalization; legacy entries backfill on read
  model?: string; // NEW: optional default model for spawns
  email?: string;
  addedAt: string;
};

/**
 * Read the account's CLI (driver kind). On disk the field is still named
 * `tool`; new code should read intent through this accessor so a later rename
 * is a one-line change.
 */
export function accountCli(a: Pick<AccountRecord, "tool">): string {
  return a.tool;
}

/**
 * Canonical provider for each single-provider CLI. opencode is intentionally
 * absent — it multiplexes several provider logins, so its provider is
 * ambiguous and must be supplied explicitly (`--provider`).
 */
export const PROVIDER_BY_CLI: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  grok: "xai",
  kimi: "moonshot",
};

/**
 * Read-time backfill: a legacy record with no `provider` gets the canonical
 * provider inferred from its CLI. Non-mutating (returns a copy only when it
 * adds a field) and a no-op when `provider` is already set or the CLI is not
 * inferable (opencode) — those records come back provider-less and are
 * excluded from provider-keyed features until set explicitly.
 */
export function normalizeAccountRecord(a: AccountRecord): AccountRecord {
  if (a.provider) return a;
  const inferred = PROVIDER_BY_CLI[a.tool];
  return inferred ? { ...a, provider: inferred } : a;
}

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
  // Read-time provider backfill. listAccounts is the SOLE registry reader, so
  // every account flows through normalizeAccountRecord exactly once. It is
  // non-destructive — nothing is written back here; the on-disk file keeps its
  // legacy (provider-less) shape until addAccount/removeAccount rewrite it.
  return parsed.filter(isAccountRecord).map(normalizeAccountRecord);
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
  provider?: string;
  model?: string;
};

export async function addAccount(tool: string, label: string, options: AddAccountOptions = {}): Promise<AccountRecord> {
  const kind = canonicalAgentKind(tool).toLowerCase();
  if (!hasAgentDriver(kind)) throw new Error(`Unknown tool: ${tool}. Accounts need an agent driver.`);
  if (!identityRecipeForAgent(kind)) throw new Error(`Tool ${kind} has no identity recipe; cannot vault its credentials.`);
  if (!label.trim()) throw new Error("Account label must not be empty");

  // Resolve the provider: explicit flag wins, else the CLI's canonical
  // provider. A CLI with no canonical provider (opencode multiplexes several)
  // must be told which one — refuse rather than write a provider-less record.
  const provider = options.provider ?? PROVIDER_BY_CLI[kind];
  if (!provider) {
    throw new Error(`Cannot infer a provider for CLI ${kind}; pass --provider <id> (e.g. minimax-coding-plan, zai-coding-plan, kimi-for-coding).`);
  }

  return withAccountsLock(async () => {
    const accounts = await listAccounts();
    const id = accountIdFor(kind, label.trim());
    if (accounts.some((account) => account.id === id)) throw new Error(`Account already exists: ${id}`);
    const email = options.email ?? (label.includes("@") ? label.trim() : undefined);
    const record: AccountRecord = {
      id,
      tool: kind,
      label: label.trim(),
      provider,
      ...(options.model ? { model: options.model } : {}),
      ...(email ? { email } : {}),
      addedAt: new Date().toISOString(),
    };
    await writeRegistry([...accounts, record]);
    await mkdir(accountDir(record), { recursive: true, mode: 0o700 });
    await appendLedger({ type: "account.add", account: record.id, tool: record.tool, provider: record.provider, label: record.label });
    return record;
  });
}

export async function removeAccount(idOrLabel: string): Promise<AccountRecord> {
  return withAccountsLock(async () => {
    const accounts = await listAccounts();
    const account = matchAccount(accounts, idOrLabel);
    await writeRegistry(accounts.filter((candidate) => candidate.id !== account.id));
    await rm(accountDir(account), { recursive: true, force: true });
    await appendLedger({ type: "account.remove", account: account.id, tool: account.tool, ...(account.provider ? { provider: account.provider } : {}) });
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

/**
 * Reserved account query: `--account rr` / `<tool>-rr` ask for the next account
 * in a persistent round-robin order. Unlike `auto`, the pick ignores live
 * limits and just advances a cursor through the tool's credentialed accounts —
 * useful when the operator wants to drain workload evenly across accounts
 * regardless of remaining quota. Cursor lives in `<storeRoot>/round-robin.json`.
 */
export const RR_ACCOUNT_QUERY = "rr";

/** `<tool>-auto` spawn alias → the tool whose least-loaded account to pick, else undefined. */
export function autoAccountTool(value: string): string | undefined {
  const shorthand = splitToolShorthand(value);
  return shorthand?.query === AUTO_ACCOUNT_QUERY ? shorthand.tool : undefined;
}

/** `<tool>-rr` spawn alias → the tool whose next round-robin account to pick, else undefined. */
export function roundRobinAccountTool(value: string): string | undefined {
  const shorthand = splitToolShorthand(value);
  return shorthand?.query === RR_ACCOUNT_QUERY ? shorthand.tool : undefined;
}

export type SpawnAgentSpec = {
  agent: string;
  account?: AccountRecord;
};

/**
 * Resolve a spawn-spec token into an agent plus an optional vault account.
 * An exact account id binds the account directly (`minimax`,
 * `claude-ursolutions`) — the account-first keystone. Plain tools and home
 * aliases pass through (`claude`, `cc1`, `codex2`); `<tool>-<query>` binds an
 * account by tool-scoped fuzzy match (`codex-ur`, `claude-thto`). Unknown
 * tokens pass through unchanged so arbitrary executables (`my-agent`) still
 * spawn.
 */
export async function resolveSpawnAgent(kind: string): Promise<SpawnAgentSpec> {
  // 1. Account-first (the keystone): an exact account-id match resolves the
  //    spawn to that account's CLI + account record, so every account-spawned
  //    bee is account-bound by construction. Matched on `id` ONLY — never on
  //    the free-form `label` (adversarial review fix #2). A label may legally
  //    be "claude"/"cc1"/"codex2"; matching it here would hijack the bare
  //    driver-kind token away from branch 2. Account ids are always
  //    `<tool>-<label>`, so a bare driver kind ("claude") is never an id and
  //    correctly falls through to branch 2.
  const exact = (await listAccounts()).find((account) => account.id === kind.trim());
  if (exact) return { agent: exact.tool, account: exact };
  // 2. Plain driver kind passthrough (claude, cc1, codex2) — unchanged.
  if (hasAgentDriver(canonicalAgentKind(kind).toLowerCase())) return { agent: kind };
  // 3. `<tool>-<query>` shorthand — tool-scoped fuzzy account bind — unchanged.
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
    const capturedCredentials: string[] = [];
    for (const relative of recipe.credentialFiles) {
      const source = join(homePath, relative);
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) continue;
      const target = join(accountDir(account), relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const data = await readFile(source, "utf8");
      await atomicWriteFile(target, data, { mode: 0o600 });
      captured.push(relative);
      capturedCredentials.push(relative);
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
          if (!capturedCredentials.includes(primary)) capturedCredentials.push(primary);
        }
      }
    }
    for (const relative of recipe.configFiles ?? []) {
      const source = join(homePath, relative);
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) continue;
      const target = join(accountDir(account), relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const data = await readFile(source, "utf8");
      await atomicWriteFile(target, data, { mode: 0o600 });
      captured.push(relative);
    }
    if (capturedCredentials.length === 0) {
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
      // persist the rotation; on failure, refuse to stamp a known-dead chain.
      try {
        await refreshVaultClaudeChainIfStaleLocked(account, options);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warn(`could not refresh the stale OAuth chain for ${account.id}: ${detail}`);
        throw new Error(`Cannot activate ${account.id}: its OAuth chain is expired and could not be refreshed (${detail}). Re-login with: hive login ${account.id}`);
      }
    }
    if (account.tool === "codex") {
      // Codex rewrites auth.json when it refreshes tokens. Rescue the current
      // occupant before a swap stamp, then pull this account's newest attributed
      // auth into the vault so activation never revives an older refresh token.
      await evacuateForeignCodexAuthLocked(account, homePath).catch((error) => {
        warn(`could not rescue existing Codex auth from ${homePath}: ${error instanceof Error ? error.message : String(error)}`);
      });
      await syncCodexAuthToVaultLocked(account, homePath).catch((error) => {
        warn(`could not sync refreshed Codex auth for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (account.tool === "grok") {
      await syncGrokAuthToVaultLocked(account, homePath).catch((error) => {
        warn(`could not sync refreshed Grok auth for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
      const vault = await readGrokAuthFile(join(accountDir(account), "auth.json"), "vault");
      const reason = grokAuthUnavailableReason(vault, options.now?.() ?? Date.now());
      if (reason) {
        throw new Error(`Cannot activate ${account.id}: Grok ${reason}. Re-login with: hive login ${account.id}`);
      }
    }
    if (account.tool !== "claude" && account.tool !== "codex" && account.tool !== "grok") {
      // Other identity recipes are file-based. Pull back changes only from the
      // account's attributed homes; arbitrary --home paths are not trusted here
      // because their credential files do not carry a common identity claim.
      await syncGenericCredentialsToVaultLocked(account, homePath).catch((error) => {
        warn(`could not sync refreshed credentials for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
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
    for (const relative of recipe.configFiles ?? []) {
      const source = join(accountDir(account), relative);
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) continue;
      const target = join(homePath, relative);
      await mkdir(dirname(target), { recursive: true });
      const data = await readFile(source, "utf8");
      await atomicWriteFile(target, data, { mode: 0o600 });
      written.push(relative);
    }
    if (account.tool === "codex" && await seedCodexHomeDefaults(homePath)) {
      if (!written.includes("config.toml")) written.push("config.toml");
    }
    if (account.tool === "claude" && await seedClaudeHomeDefaults(homePath)) {
      if (!written.includes("settings.json")) written.push("settings.json");
    }
    // Self-heal claude's startup acceptances on EVERY activation. The vault's
    // .claude.json is a copied credential file, so the loop above just stamped
    // its snapshot — which typically carries stale onboarding/trust state — over
    // the home, resurfacing the bypass-permissions consent and folder-trust
    // dialogs (an unattended bee then sits at them until the boot timeout).
    // Re-merge the acceptances here so every activation path (swarm, flow, login
    // seat, resume) self-heals, not just the primary spawn — which additionally
    // re-seeds the exact spawn cwd afterward. yolo:true is safe regardless of the
    // bee's mode: it only pre-accepts the bypass dialog; bypass mode still only
    // engages when the CLI is launched with the flag.
    if (account.tool === "claude") {
      await seedClaudeHomeAcceptance(homePath, { yolo: true, trustCwd: process.cwd() });
      if (!written.includes(".claude.json")) written.push(".claude.json");
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

// Default spawn model for hive-managed claude homes (alias for the latest Opus =
// Opus 4.8, 1M-context). Seeded into settings.json only when no model is set.
const CLAUDE_HOME_DEFAULT_MODEL = "opus[1m]";

const CODEX_HOME_DEFAULTS: Record<string, string> = {
  model: `"gpt-5.5"`,
  model_reasoning_effort: `"xhigh"`,
  service_tier: `"fast"`,
};

const CODEX_NOTICE_DEFAULTS: Record<string, string> = {
  hide_full_access_warning: "true",
};

// claude persists its one-time "Bypass Permissions mode" acceptance as
// `skipDangerousModePermissionPrompt: true` in settings.json. settings.json is
// a recipe credential file, so activation re-stamps the vault's copy over the
// home on EVERY spawn — wiping the flag and resurfacing the dialog on every
// launch (a bee then sits at it until the boot-ms timeout). Re-assert the flag
// into the activated home so honeybee's bypass-mode bees never see the dialog.
// Merged, not replaced: model/theme and any other keys the vault carries
// survive. A malformed settings.json is left untouched rather than clobbered.
async function seedClaudeHomeDefaults(homePath: string): Promise<boolean> {
  const path = join(homePath, "settings.json");
  const existing = await readFile(path, "utf8").catch(() => "");
  const next = withClaudeSettingsDefaults(existing);
  if (next === existing) return false;
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, next, { mode: 0o600 });
  return true;
}

function withClaudeSettingsDefaults(input: string): string {
  let parsed: Record<string, unknown> = {};
  if (input.trim()) {
    try {
      const value = JSON.parse(input);
      if (!value || typeof value !== "object" || Array.isArray(value)) return input;
      parsed = value as Record<string, unknown>;
    } catch {
      return input;
    }
  }
  let changed = false;
  if (parsed.skipDangerousModePermissionPrompt !== true) {
    parsed.skipDangerousModePermissionPrompt = true;
    changed = true;
  }
  // Default the spawn model to Opus so a hive-managed claude home never falls
  // back to the CLI's built-in default (which has pointed at retired models like
  // Fable, hard-failing every spawn). Seeded only when ABSENT — an explicit
  // model the operator/vault set is left untouched. Mirrors CODEX_HOME_DEFAULTS.
  if (typeof parsed.model !== "string" || parsed.model.trim().length === 0) {
    parsed.model = CLAUDE_HOME_DEFAULT_MODEL;
    changed = true;
  }
  if (!changed) return input;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function seedCodexHomeDefaults(homePath: string): Promise<boolean> {
  const path = join(homePath, "config.toml");
  const existing = await readFile(path, "utf8").catch(() => "");
  const next = mergeCodexConfigDefaults(existing);
  if (next === existing) return false;
  await mkdir(homePath, { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, next, { mode: 0o600 });
  return true;
}

function mergeCodexConfigDefaults(input: string): string {
  let lines = tomlLines(input);
  lines = withTopLevelTomlDefaults(lines, CODEX_HOME_DEFAULTS);
  lines = withTomlSectionDefaults(lines, "notice", CODEX_NOTICE_DEFAULTS);
  return `${lines.join("\n")}\n`;
}

function tomlLines(input: string): string[] {
  const trimmed = input.replace(/\s+$/u, "");
  return trimmed.length === 0 ? [] : trimmed.split(/\r?\n/u);
}

function withTopLevelTomlDefaults(lines: string[], defaults: Record<string, string>): string[] {
  const insertAt = firstTomlSectionIndex(lines);
  const topLevel = lines.slice(0, insertAt === -1 ? lines.length : insertAt);
  const existing = new Set<string>();
  for (const line of topLevel) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/u);
    if (match) existing.add(match[1]!);
  }
  const missing = Object.entries(defaults)
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => `${key} = ${value}`);
  if (missing.length === 0) return lines;
  if (insertAt === -1) return [...lines, ...missing];
  return [...lines.slice(0, insertAt), ...missing, ...lines.slice(insertAt)];
}

function withTomlSectionDefaults(lines: string[], section: string, defaults: Record<string, string>): string[] {
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return [...lines, ...(lines.length > 0 && lines[lines.length - 1] !== "" ? [""] : []), header, ...formatTomlDefaults(defaults)];
  }
  const nextSection = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  const end = nextSection === -1 ? lines.length : nextSection;
  const existing = new Set<string>();
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/u);
    if (match) existing.add(match[1]!);
  }
  const missing = Object.entries(defaults)
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => `${key} = ${value}`);
  if (missing.length === 0) return lines;
  return [...lines.slice(0, start + 1), ...missing, ...lines.slice(start + 1)];
}

function firstTomlSectionIndex(lines: string[]): number {
  return lines.findIndex((line) => /^\s*\[/.test(line));
}

function formatTomlDefaults(defaults: Record<string, string>): string[] {
  return Object.entries(defaults).map(([key, value]) => `${key} = ${value}`);
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

function claudeTokenExpiry(raw: string): number | null {
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
  if (candidate.expiresAt !== current.expiresAt) return candidate.expiresAt > current.expiresAt;
  if (candidate.refreshToken && !current.refreshToken) return true;
  if (!candidate.refreshToken && current.refreshToken) return false;
  return false;
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

export function accountEmail(account: Pick<AccountRecord, "email" | "label">): string | undefined {
  return account.email ?? (account.label.includes("@") ? account.label : undefined);
}

export function emailFromJwt(jwt: string): string | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof decoded.email === "string" ? decoded.email : null;
  } catch {
    return null;
  }
}

/** Email claim from auth.json's id_token JWT — decoded, not verified (local fact). */
export async function codexAuthEmail(authPath: string): Promise<string | null> {
  const auth = await readCodexAuthFile(authPath, authPath);
  return auth?.email ?? null;
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
  const emails = await codexAccountEmails(account, vault);
  return emails.size === 0 || emails.has(snapshot.email);
}

async function homeBelongsToCodexAccount(homePath: string, account: AccountRecord, vault?: CodexAuthSnapshot | null): Promise<boolean> {
  const target = resolve(homePath);
  const dedicated = dedicatedHomesFor(account).some((dir) => resolve(dir) === target);
  const snapshot = await readHomeCodexAuth(homePath);
  if (snapshot?.email) return codexAuthBelongsToAccount(snapshot, account, vault);
  return dedicated;
}

/** Homes attributable to the Codex account: dedicated slots + email-matched shared homes. */
export async function codexHomesForAccount(account: AccountRecord, extraHome?: string): Promise<string[]> {
  const vault = await readCodexAuthFile(join(accountDir(account), "auth.json"), "vault");
  const matched = new Map<string, string>();
  const consider = async (home: string) => {
    if ((await stat(home).catch(() => null))?.isDirectory() && await homeBelongsToCodexAccount(home, account, vault)) {
      matched.set(resolve(home), home);
    }
  };
  for (const dir of dedicatedHomesFor(account)) await consider(dir);
  if (extraHome) await consider(extraHome);
  if ((await codexAccountEmails(account, vault)).size > 0) {
    for (const home of await candidateHomes("codex")) await consider(home);
  }
  return [...matched.values()];
}

async function saveCodexAuthToVaultLocked(account: AccountRecord, sourceRaw: string): Promise<void> {
  const vaultPath = join(accountDir(account), "auth.json");
  await mkdir(dirname(vaultPath), { recursive: true, mode: 0o700 });
  await atomicWriteFile(vaultPath, sourceRaw.endsWith("\n") ? sourceRaw : `${sourceRaw}\n`, { mode: 0o600 });
}

export type CodexAuthSyncResult = { auth: CodexAuthSnapshot | null; vaultUpdated: boolean };

/**
 * Pull the freshest attributed Codex auth.json into the vault. Codex refreshes
 * auth.json in-place; if the vault keeps stamping an older refresh token over
 * account homes, later launches can force sign-in again. Identity checks keep
 * swapped/shared homes from poisoning a different account's vault entry.
 */
export async function syncCodexAuthToVault(account: AccountRecord, extraHome?: string): Promise<CodexAuthSyncResult> {
  return withAccountsLock(() => syncCodexAuthToVaultLocked(account, extraHome));
}

async function syncCodexAuthToVaultLocked(account: AccountRecord, extraHome?: string): Promise<CodexAuthSyncResult> {
  const vault = await readCodexAuthFile(join(accountDir(account), "auth.json"), "vault");
  let best = vault;
  for (const home of await codexHomesForAccount(account, extraHome)) {
    const snapshot = await readHomeCodexAuth(home);
    if (!snapshot || !(await codexAuthBelongsToAccount(snapshot, account, vault))) continue;
    if (isFresherCodexAuth(snapshot, best)) best = snapshot;
  }
  if (!best || best === vault) return { auth: best, vaultUpdated: false };
  await saveCodexAuthToVaultLocked(account, best.raw);
  await appendLedger({
    type: "account.auth-sync",
    account: account.id,
    tool: "codex",
    from: best.source,
    ...(best.lastRefreshMs ? { lastRefreshAt: new Date(best.lastRefreshMs).toISOString() } : {}),
  });
  return { auth: best, vaultUpdated: true };
}

async function evacuateForeignCodexAuthLocked(account: AccountRecord, homePath: string): Promise<void> {
  const occupant = await readHomeCodexAuth(homePath);
  if (!occupant?.email) return;
  if (await codexAuthBelongsToAccount(occupant, account)) return;
  const owner = await findCodexAccountByEmailLocked(occupant.email, account.id);
  if (!owner) return;
  const vault = await readCodexAuthFile(join(accountDir(owner), "auth.json"), "vault");
  if (!isFresherCodexAuth(occupant, vault)) return;
  await saveCodexAuthToVaultLocked(owner, occupant.raw);
  await appendLedger({
    type: "account.auth-evacuate",
    account: owner.id,
    tool: "codex",
    home: homePath,
    ...(occupant.lastRefreshMs ? { lastRefreshAt: new Date(occupant.lastRefreshMs).toISOString() } : {}),
  });
}

async function findCodexAccountByEmailLocked(email: string, excludeId?: string): Promise<AccountRecord | null> {
  for (const candidate of (await listAccounts()).filter((account) => account.tool === "codex" && account.id !== excludeId)) {
    if ((await codexAccountEmails(candidate)).has(email)) return candidate;
  }
  return null;
}

export type GrokAuthSnapshot = {
  raw: string;
  emails: Set<string>;
  createTimeMs?: number;
  expiresAtMs?: number;
  mtimeMs: number;
  source: string;
};

const GROK_AUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

async function readGrokAuthFile(path: string, source: string): Promise<GrokAuthSnapshot | null> {
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

function parseTimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function grokAuthUnavailableReason(snapshot: GrokAuthSnapshot | null, now: number, skewMs = GROK_AUTH_EXPIRY_SKEW_MS): string | null {
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

export async function syncGrokAuthToVault(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<GrokAuthSyncResult> {
  return withAccountsLock(() => syncGrokAuthToVaultLocked(account, extraHome, options));
}

async function syncGrokAuthToVaultLocked(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<GrokAuthSyncResult> {
  const vault = await readGrokAuthFile(join(accountDir(account), "auth.json"), "vault");
  let best = vault;
  for (const home of await grokHomesForAccount(account, extraHome, options)) {
    const snapshot = await readHomeGrokAuth(home);
    if (!snapshot || !(await grokAuthBelongsToAccount(snapshot, account, vault))) continue;
    if (isFresherGrokAuth(snapshot, best)) best = snapshot;
  }
  if (!best || best === vault) return { auth: best, vaultUpdated: false };
  await saveGrokAuthToVaultLocked(account, best.raw);
  await appendLedger({
    type: "account.auth-sync",
    account: account.id,
    tool: "grok",
    from: best.source,
    ...(best.createTimeMs ? { refreshedAt: new Date(best.createTimeMs).toISOString() } : {}),
  });
  return { auth: best, vaultUpdated: true };
}

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

export type SyncAccountCredentialsOptions = {
  /**
   * Trust `extraHome` even when it is not the account's dedicated home. Use
   * only when a live SessionRecord binds that home to the account.
   */
  trustExtraHome?: boolean;
};

function isDedicatedHomeForAccount(account: AccountRecord, homePath: string): boolean {
  const target = resolve(homePath);
  return dedicatedHomesFor(account).some((dir) => resolve(dir) === target);
}

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

export async function syncGenericCredentialsToVault(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<GenericCredentialSyncResult> {
  return withAccountsLock(() => syncGenericCredentialsToVaultLocked(account, extraHome, options));
}

async function syncGenericCredentialsToVaultLocked(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<GenericCredentialSyncResult> {
  const vault = await readGenericCredentialBundle(account, accountDir(account), "vault");
  let best = vault;
  for (const home of await genericCredentialHomesForAccount(account, extraHome, options)) {
    const bundle = await readGenericCredentialBundle(account, home, home);
    if (bundle && isFresherGenericCredentialBundle(bundle, best)) best = bundle;
  }
  if (!best || best === vault) return { credentials: best, vaultUpdated: false };
  await saveGenericCredentialBundleToVaultLocked(account, best);
  await appendLedger({
    type: "account.credential-sync",
    account: account.id,
    tool: account.tool,
    from: best.source,
    files: best.files.map((file) => file.relative),
    refreshedAt: new Date(best.freshnessMs).toISOString(),
  });
  return { credentials: best, vaultUpdated: true };
}

export type AccountCredentialSyncResult =
  | ChainSyncResult
  | CodexAuthSyncResult
  | GrokAuthSyncResult
  | GenericCredentialSyncResult;

export async function syncAccountCredentialsToVault(
  account: AccountRecord,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<AccountCredentialSyncResult> {
  if (account.tool === "claude") return syncClaudeChainToVault(account, extraHome);
  if (account.tool === "codex") return syncCodexAuthToVault(account, extraHome);
  if (account.tool === "grok") return syncGrokAuthToVault(account, extraHome, options);
  return syncGenericCredentialsToVault(account, extraHome, options);
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
    if (chain && isBetterClaudeChain(chain, best)) best = chain;
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
  const accounts = (await listAccounts()).filter((account) => account.tool !== "claude" && account.tool !== "codex" && account.tool !== "grok" && identityRecipeForAgent(account.tool));
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
  await persistClaudeChain(account, oauth);
}

/**
 * Read the account's CURRENT vault Claude chain. Used as a post-lock re-check:
 * a caller that took withAccountsLock before rotating a chain re-reads here to
 * see whether another writer already refreshed it while it waited (HIVE-2),
 * avoiding a redundant — and reuse-detection-tripping — refresh-token replay.
 */
export async function readVaultClaudeChain(account: AccountRecord): Promise<ClaudeChain | null> {
  const vaultPath = join(accountDir(account), ".credentials.json");
  return parseClaudeChain(await readFile(vaultPath, "utf8").catch(() => null), "vault");
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
