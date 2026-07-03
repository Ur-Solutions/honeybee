import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalAgentKind } from "../agents.js";
import { hasAgentDriver, identityRecipeForAgent, type IdentityRecipe } from "../drivers.js";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { appendLedger, safeName } from "../store.js";

// ──────────────────────────────────────────────────────────────────────────
// The credential vault. LOCAL ONLY — never synced. An account is a provider
// identity (the "who"); a home is a slot (the "where"). Activating an account
// copies its credential files into a home under that account's lock.
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

export function accountLockPath(accountId: string): string {
  return join(storeRoot(), "locks", "accounts", `${safeName(accountId)}.lock`);
}

export function accountDir(account: Pick<AccountRecord, "tool" | "id">): string {
  return join(vaultRoot(), account.tool, account.id);
}

/**
 * Machine-wide registry lock: serializes accounts.json read-modify-writes
 * (add/remove). Per-account vault work takes withAccountLock instead, so
 * distinct accounts never queue behind each other (HIVE-64). When both locks
 * are needed the registry lock is acquired FIRST (removeAccount), never the
 * other way around.
 */
export function withAccountsLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(accountsLockPath(), fn, { timeoutMs: 30_000 });
}

/**
 * Per-account lock: guards one account's vault entry and OAuth chain. Sharded
 * by account id so a swarm of N account-bound bees activates in parallel —
 * one account's network refresh no longer stalls every other account's
 * activation past the lock timeout (HIVE-64). Same-account work still
 * serializes, which rotating refresh tokens require (HIVE-2). Not reentrant.
 */
export function withAccountLock<T>(accountId: string, fn: () => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
  // Activation may refresh an OAuth chain over the network (15s cap) while
  // holding the lock; give waiters enough patience to outlive that.
  return withFileLock(accountLockPath(accountId), fn, { timeoutMs: options.timeoutMs ?? 30_000 });
}

// Cross-account writes (chain evacuation, imposter parking) take the OTHER
// account's lock while already holding one. Give up sooner than the normal
// patience: these writes are best-effort at every call site, and the shorter
// timeout breaks the rare A→B/B→A acquisition cycle instead of stalling both
// activations for the full 30s.
export const CROSS_ACCOUNT_LOCK_TIMEOUT_MS = 10_000;

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
    // Nested per-account lock (registry → account, never the reverse): the
    // vault dir must not be deleted under an in-flight activation or sync.
    return withAccountLock(account.id, async () => {
      await writeRegistry(accounts.filter((candidate) => candidate.id !== account.id));
      await rm(accountDir(account), { recursive: true, force: true });
      await appendLedger({ type: "account.remove", account: account.id, tool: account.tool, ...(account.provider ? { provider: account.provider } : {}) });
      return account;
    });
  });
}

/**
 * Match a query against a pool of accounts: exact id/label wins, else a unique
 * substring match. Shared by removeAccount and findAccount.
 */
export function matchAccount(accounts: AccountRecord[], query: string): AccountRecord {
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

export function recipeFor(account: AccountRecord): IdentityRecipe {
  const recipe = identityRecipeForAgent(account.tool);
  if (!recipe) throw new Error(`Tool ${account.tool} has no identity recipe`);
  return recipe;
}
