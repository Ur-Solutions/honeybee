import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { identityRecipeForAgent, type IdentityRecipe } from "../drivers.js";
import { keychainAvailable, readClaudeKeychain, writeClaudeKeychainEntry } from "../keychain.js";
import { atomicWriteFile } from "../fsx.js";
import { appendLedger } from "../store.js";
import { accountDir, recipeFor, withAccountLock, type AccountRecord } from "./registry.js";
import {
  claudeProfileEmailCached,
  claudeTokenExpiry,
  evacuateForeignClaudeChain,
  mergeCredentialsJson,
  parseClaudeChain,
  refreshVaultClaudeChainIfStaleLocked,
  syncClaudeChainToVaultLocked,
  type RefreshedClaudeToken,
} from "./claudeChain.js";
import { accountEmail } from "./utils.js";
import { evacuateForeignCodexAuth, syncCodexAuthToVaultLocked } from "./codexAuth.js";
import { grokAuthUnavailableReason, readGrokAuthFile, syncGrokAuthToVaultLocked } from "./grokAuth.js";
import { syncGenericCredentialsToVaultLocked } from "./genericSync.js";
import { seedClaudeHomeAcceptance, seedClaudeHomeDefaults, seedCodexHomeDefaults } from "./homeDefaults.js";

/**
 * Copy the recipe's credential files out of a home into the vault. Files that
 * don't exist in the home are skipped; at least one must be captured.
 */
export async function captureAccountFromHome(account: AccountRecord, homePath: string): Promise<string[]> {
  const recipe = recipeFor(account);
  return withAccountLock(account.id, async () => {
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
  /** Profile lookup override (tests). Defaults to claudeProfileEmailCached. */
  fetchProfileEmail?: (accessToken: string) => Promise<string | null>;
  now?: () => number;
};

// ──────────────────────────────────────────────────────────────────────────
// Activation hooks. activateAccountIntoHome shares one skeleton (primary-cred
// check → copy credential files + mirrors → copy config files → stamp) and
// hangs per-tool behavior off two hooks, keyed by tool with a generic
// fallback. preActivate rescues/syncs the freshest live credential into the
// vault (and may refuse activation); seedHomeDefaults re-seeds a home's
// defaults/acceptances/keychain after the copy. Adding a tool means adding a
// hook entry — not editing an if-chain in the middle of the copy loop.
// ──────────────────────────────────────────────────────────────────────────

export type ActivationContext = {
  account: AccountRecord;
  homePath: string;
  recipe: IdentityRecipe;
  options: ActivateAccountOptions;
  warn: (message: string) => void;
  /** Home-relative paths written so far; hooks append what they stamp. */
  written: string[];
};

type ActivationHooks = {
  /** Runs before the copy: pull the freshest live credential into the vault; may refuse. */
  preActivate?(ctx: ActivationContext): Promise<void>;
  /** Runs after the copy: re-seed home defaults/acceptances/keychain, appending to written. */
  seedHomeDefaults?(ctx: ActivationContext): Promise<void>;
};

async function claudePreActivate({ account, homePath, options, warn }: ActivationContext): Promise<void> {
  // (1) The home may currently hold ANOTHER account's chain (swap). The
  // rotated live link exists only there — rescue it into its own vault
  // before stamping over it, or that account's next activation revives a
  // dead link and logs it out.
  await evacuateForeignClaudeChain(account, homePath).catch(() => undefined);
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

async function codexPreActivate({ account, homePath, warn }: ActivationContext): Promise<void> {
  // Codex rewrites auth.json when it refreshes tokens. Rescue the current
  // occupant before a swap stamp, then pull this account's newest attributed
  // auth into the vault so activation never revives an older refresh token.
  await evacuateForeignCodexAuth(account, homePath).catch((error) => {
    warn(`could not rescue existing Codex auth from ${homePath}: ${error instanceof Error ? error.message : String(error)}`);
  });
  await syncCodexAuthToVaultLocked(account, homePath).catch((error) => {
    warn(`could not sync refreshed Codex auth for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function grokPreActivate({ account, homePath, options, warn }: ActivationContext): Promise<void> {
  await syncGrokAuthToVaultLocked(account, homePath).catch((error) => {
    warn(`could not sync refreshed Grok auth for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const vault = await readGrokAuthFile(join(accountDir(account), "auth.json"), "vault");
  const reason = grokAuthUnavailableReason(vault, options.now?.() ?? Date.now());
  if (reason) {
    throw new Error(`Cannot activate ${account.id}: Grok ${reason}. Re-login with: hive login ${account.id}`);
  }
}

async function genericPreActivate({ account, homePath, warn }: ActivationContext): Promise<void> {
  // Other identity recipes are file-based. Pull back changes only from the
  // account's attributed homes; arbitrary --home paths are not trusted here
  // because their credential files do not carry a common identity claim.
  await syncGenericCredentialsToVaultLocked(account, homePath).catch((error) => {
    warn(`could not sync refreshed credentials for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function codexSeedHomeDefaults({ homePath, written }: ActivationContext): Promise<void> {
  if (await seedCodexHomeDefaults(homePath)) {
    if (!written.includes("config.toml")) written.push("config.toml");
  }
}

async function claudeSeedHomeDefaults(ctx: ActivationContext): Promise<void> {
  const { account, homePath, recipe, warn, written } = ctx;
  if (await seedClaudeHomeDefaults(homePath)) {
    if (!written.includes("settings.json")) written.push("settings.json");
  }
  // Self-heal claude's startup acceptances on EVERY activation. The vault's
  // .claude.json is a copied credential file, so the copy loop just stamped
  // its snapshot — which typically carries stale onboarding/trust state — over
  // the home, resurfacing the bypass-permissions consent and folder-trust
  // dialogs (an unattended bee then sits at them until the boot timeout).
  // Re-merge the acceptances here so every activation path (swarm, flow, login
  // seat, resume) self-heals, not just the primary spawn — which additionally
  // re-seeds the exact spawn cwd afterward. yolo:true is safe regardless of the
  // bee's mode: it only pre-accepts the bypass dialog; bypass mode still only
  // engages when the CLI is launched with the flag.
  await seedClaudeHomeAcceptance(homePath, { yolo: true, trustCwd: process.cwd() });
  if (!written.includes(".claude.json")) written.push(".claude.json");
  // On macOS, claude prefers the per-config-dir Keychain entry over the
  // credentials file — seed it so an activated home doesn't resolve a stale
  // identity from an old entry. Merged, not replaced: home-local sibling
  // keys (mcpOAuth, ...) survive the identity stamp — except when the merged
  // payload overflows the `security -i` line buffer, where the writer falls
  // back to stamping the identity alone rather than leaving the old one.
  if (keychainAvailable()) {
    const credentials = (await readFile(join(accountDir(account), recipe.credentialFiles[0]!), "utf8")).trim();
    const existing = await readClaudeKeychain(homePath);
    const write = await writeClaudeKeychainEntry(homePath, mergeCredentialsJson(existing, credentials));
    if (write.ok) {
      written.push(write.mode === "identity-only" ? "keychain (identity-only)" : "keychain");
      if (write.mode === "identity-only") {
        warn(`keychain entry for ${homePath} was too large to store whole; stamped the identity alone (MCP connectors on this home may need re-auth)`);
      }
    } else if (existing) {
      // A stale entry exists and we could not replace it: claude would keep
      // using the OLD account. Refuse rather than activate a lie.
      throw new Error(`Could not update the macOS Keychain entry for ${homePath}; claude would keep its previous identity`);
    }
  }
  await verifyActivatedClaudeIdentity(ctx);
}

/**
 * Post-stamp identity check — the last line of defense for the whole class
 * of crossed-credential bugs. Resolve the credential claude will actually
 * boot with (keychain entry first, since claude prefers it; else the home
 * file) and refuse the activation when it verifiably belongs to another
 * account. Whatever went wrong upstream — a failed keychain stamp, a running
 * bee re-stamping its in-memory identity, a swap race — a home that would
 * bill another account must never be handed to a bee (observed live
 * 2026-07-03: a home whose keychain kept another account's token billed that
 * account past its limit and into paid usage credits).
 *
 * Network-frugal: when the effective token IS the account's vault link — the
 * normal post-activation state — identity is proven by equality and no
 * lookup runs. Only divergent tokens hit the profile endpoint, and an
 * unverifiable lookup (offline, rate-limited) warns and passes: only a
 * VERIFIED foreign identity refuses.
 */
export async function verifyActivatedClaudeIdentity(
  { account, homePath, options, warn }: ActivationContext,
  deps: { readKeychain?: typeof readClaudeKeychain } = {},
): Promise<void> {
  const expected = accountEmail(account);
  if (!expected) return;
  const readKeychain = deps.readKeychain ?? readClaudeKeychain;
  const effective =
    parseClaudeChain(await readKeychain(homePath), `${homePath}:keychain`) ??
    parseClaudeChain(await readFile(join(homePath, ".credentials.json"), "utf8").catch(() => null), `${homePath}:file`);
  if (!effective) return;
  const vault = parseClaudeChain(await readFile(join(accountDir(account), ".credentials.json"), "utf8").catch(() => null), "vault");
  if (vault && vault.oauth.accessToken === effective.oauth.accessToken) return;
  const profileOf = options.fetchProfileEmail ?? claudeProfileEmailCached;
  let actual: string | null = null;
  try {
    actual = await profileOf(String(effective.oauth.accessToken));
  } catch (error) {
    warn(`could not verify the activated identity of ${homePath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (actual !== null && actual !== expected) {
    await appendLedger({ type: "account.activation-identity-mismatch", account: account.id, home: homePath, expected, actual, source: effective.source }).catch(() => {});
    throw new Error(
      `Activation identity mismatch for ${homePath}: the credential claude would boot with (${effective.source}) belongs to ${actual}, not ${expected} — a bee on this home would bill ${actual}. Repair with: hive login ${account.id}`,
    );
  }
}

const ACTIVATION_HOOKS: Record<string, ActivationHooks> = {
  claude: { preActivate: claudePreActivate, seedHomeDefaults: claudeSeedHomeDefaults },
  codex: { preActivate: codexPreActivate, seedHomeDefaults: codexSeedHomeDefaults },
  grok: { preActivate: grokPreActivate },
};

const GENERIC_ACTIVATION_HOOKS: ActivationHooks = { preActivate: genericPreActivate };

function activationHooksFor(tool: string): ActivationHooks {
  return ACTIVATION_HOOKS[tool] ?? GENERIC_ACTIVATION_HOOKS;
}

/**
 * Activate an account into a home: copy its vaulted credential files (plus any
 * activation mirrors) into the home. This is "fast login" — the mechanical
 * primitive behind activate/spawn --account/swap-account.
 *
 * For claude the vault copy is NOT trusted blindly: refresh tokens rotate, so
 * the live link of the chain is wherever the last refresh happened (usually a
 * running session's home). Activation first rescues a foreign occupant's
 * chain, then pulls the account's own freshest link into the vault, then
 * refreshes a stale chain — only after that does it stamp. The per-tool work
 * lives in the activation hooks (preActivate + seedHomeDefaults).
 */
export async function activateAccountIntoHome(account: AccountRecord, homePath: string, options: ActivateAccountOptions = {}): Promise<string[]> {
  const recipe = recipeFor(account);
  const warn = options.onWarn ?? (() => undefined);
  const hooks = activationHooksFor(account.tool);
  return withAccountLock(account.id, async () => {
    const ctx: ActivationContext = { account, homePath, recipe, options, warn, written: [] };
    await hooks.preActivate?.(ctx);
    // Refuse to activate without the primary credential: copying only the
    // supporting snapshots would clobber the home's settings without a login.
    const primary = join(accountDir(account), recipe.credentialFiles[0]!);
    if (!(await stat(primary).catch(() => null))?.isFile()) {
      throw new Error(`Vault has no credentials for ${account.id}. Capture them first: hive account login ${account.tool} ${account.label}`);
    }
    const written = ctx.written;
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
    await hooks.seedHomeDefaults?.(ctx);
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
