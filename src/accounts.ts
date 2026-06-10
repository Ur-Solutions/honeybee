import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  return withFileLock(accountsLockPath(), fn);
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
    // than .credentials.json; pull it from there into the (file-based) vault.
    const primary = recipe.credentialFiles[0]!;
    if (account.tool === "claude" && !captured.includes(primary) && keychainAvailable()) {
      const credentials = await readClaudeKeychain(homePath);
      if (credentials) {
        const target = join(accountDir(account), primary);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await atomicWriteFile(target, `${credentials}\n`, { mode: 0o600 });
        captured.push(primary);
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

/**
 * Activate an account into a home: copy its vaulted credential files (plus any
 * activation mirrors) into the home. This is "fast login" — the mechanical
 * primitive behind activate/spawn --account/swap-account.
 */
export async function activateAccountIntoHome(account: AccountRecord, homePath: string): Promise<string[]> {
  const recipe = recipeFor(account);
  return withAccountsLock(async () => {
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
    // identity from an old entry.
    if (account.tool === "claude" && keychainAvailable()) {
      const credentials = (await readFile(join(accountDir(account), recipe.credentialFiles[0]!), "utf8")).trim();
      const ok = await writeClaudeKeychain(homePath, credentials);
      if (ok) {
        written.push("keychain");
      } else if (await readClaudeKeychain(homePath)) {
        // A stale entry exists and we could not replace it: claude would keep
        // using the OLD account. Refuse rather than activate a lie.
        throw new Error(`Could not update the macOS Keychain entry for ${homePath}; claude would keep its previous identity`);
      }
    }
    await appendLedger({ type: "account.activate", account: account.id, tool: account.tool, home: homePath, files: written });
    return written;
  });
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

// ──────────────────────────────────────────────────────────────────────────
// caam migration. caam's vault is ~/.local/share/caam/vault/<tool>/<label>/
// with the credential files at the dir root plus a meta.json. Tools without a
// honeybee identity recipe (e.g. gemini) are reported and skipped.
// ──────────────────────────────────────────────────────────────────────────

export type CaamImportResult = {
  imported: AccountRecord[];
  skipped: { tool: string; label: string; reason: string }[];
};

export function defaultCaamVaultDir(): string {
  return join(homedir(), ".local", "share", "caam", "vault");
}

// caam stores every file at the profile dir root; honeybee's recipes may nest
// them (opencode). Map caam basenames onto recipe-relative paths.
function caamFileTarget(recipe: IdentityRecipe, file: string): string | undefined {
  if (recipe.credentialFiles.includes(file)) return file;
  return recipe.credentialFiles.find((relative) => relative.endsWith(`/${file}`));
}

export async function importCaam(caamVaultDir = defaultCaamVaultDir()): Promise<CaamImportResult> {
  const tools = await readdir(caamVaultDir, { withFileTypes: true }).catch(() => null);
  if (!tools) throw new Error(`No caam vault found at ${caamVaultDir}`);

  const imported: AccountRecord[] = [];
  const skipped: CaamImportResult["skipped"] = [];

  for (const toolEntry of tools.filter((entry) => entry.isDirectory())) {
    const tool = toolEntry.name;
    const recipe = identityRecipeForAgent(tool);
    const labels = await readdir(join(caamVaultDir, tool), { withFileTypes: true }).catch(() => []);
    for (const labelEntry of labels.filter((entry) => entry.isDirectory())) {
      const label = labelEntry.name;
      if (!recipe) {
        skipped.push({ tool, label, reason: `no identity recipe for tool ${tool}` });
        continue;
      }
      const existing = (await listAccounts()).find((account) => account.id === accountIdFor(tool, label));
      const account = existing ?? (await addAccount(tool, label));
      const profileDir = join(caamVaultDir, tool, label);
      const files = await readdir(profileDir).catch(() => []);
      let copied = 0;
      for (const file of files) {
        if (file === "meta.json") continue;
        const targetRelative = caamFileTarget(recipe, file);
        if (!targetRelative) continue;
        const target = join(accountDir(account), targetRelative);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const data = await readFile(join(profileDir, file), "utf8");
        await atomicWriteFile(target, data, { mode: 0o600 });
        copied += 1;
      }
      if (copied === 0 && !existing) {
        skipped.push({ tool, label, reason: "no credential files matched the identity recipe" });
        await removeAccount(account.id).catch(() => undefined);
        continue;
      }
      imported.push(account);
    }
  }

  await appendLedger({
    type: "account.import-caam",
    from: caamVaultDir,
    imported: imported.map((account) => account.id),
    skipped: skipped.length,
  });
  return { imported, skipped };
}
