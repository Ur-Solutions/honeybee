import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { identityRecipeForAgent, type IdentityRecipe } from "../drivers.js";
import {
  decodeSecurityPasswordOutput,
  keychainAvailable,
  readClaudeKeychainRaw,
  readClaudeKeychainState,
  writeClaudeKeychainEntry,
} from "../keychain.js";
import { kitMaterializeHome, readKitHomeStamp, type KitMaterializeTiming } from "../kit.js";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { type LockOptions, type LockOwnerMetadata, withFileLock } from "../lock.js";
import { appendLedger } from "../store.js";
import { accountDir, recipeFor, withAccountLock, type AccountRecord } from "./registry.js";
import {
  claudeCredentialsEquivalent,
  claudeProfileEmailCached,
  evacuateForeignClaudeChain,
  fulfillClaudeChainParkingIntent,
  mergeCredentialsJson,
  parseClaudeChainStrict,
  refreshVaultClaudeChainIfStaleLocked,
  syncClaudeChainToVaultLocked,
  type ClaudeChainParkingIntent,
  type RefreshedClaudeToken,
} from "./claudeChain.js";
import { accountEmail } from "./utils.js";
import { evacuateForeignCodexAuth, syncCodexAuthToVaultLocked } from "./codexAuth.js";
import {
  cursorAuthUnavailableReason,
  readCursorAuthFile,
  readCursorAuthInfo,
  readCursorLiveAuth,
  syncCursorAuthToVaultLocked,
} from "./cursorAuth.js";
import { grokAuthUnavailableReason, readGrokAuthFile, syncGrokAuthToVaultLocked } from "./grokAuth.js";
import { syncGenericCredentialsToVaultLocked } from "./genericSync.js";
import { seedGatewayMcp } from "./gatewayMcp.js";
import { seedClaudeHomeAcceptance, seedClaudeHomeDefaults, seedCodexHomeDefaults } from "./homeDefaults.js";

/**
 * Copy the recipe's credential files out of a home into the vault. Files that
 * don't exist in the home are skipped; at least one must be captured.
 */
export async function captureAccountFromHome(account: AccountRecord, homePath: string): Promise<string[]> {
  const recipe = recipeFor(account);
  const captured = await withAccountLock(account.id, async () => {
    const captured: string[] = [];
    const capturedCredentials: string[] = [];
    const primary = recipe.credentialFiles[0]!;
    let authoritativeClaudeCredential: string | null = null;
    if (account.tool === "claude" && keychainAvailable()) {
      const keychainRead = await readClaudeKeychainState(homePath);
      if (keychainRead.status === "unreadable") {
        throw new Error(`Cannot capture ${account.id}: the authoritative macOS Keychain entry for ${homePath} is unreadable (${keychainRead.reason})`);
      }
      if (keychainRead.status === "present") {
        const decoded = decodeSecurityPasswordOutput(keychainRead.raw);
        if (!parseClaudeChainStrict(decoded, `${homePath}:keychain`)) {
          throw new Error(`Cannot capture ${account.id}: the authoritative macOS Keychain entry for ${homePath} is malformed`);
        }
        authoritativeClaudeCredential = decoded;
      }
    }
    for (const relative of recipe.credentialFiles) {
      // A present Keychain item is Claude's authoritative credential. Do not
      // transiently copy the fallback file into the vault before replacing it:
      // capture must be fail-closed even if a later write or parse fails.
      if (account.tool === "claude" && relative === primary && authoritativeClaudeCredential !== null) continue;
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
    // cursor logs in to the MACHINE-GLOBAL store (macOS keychain / the global
    // XDG auth.json), never into the seat home — the home only receives the
    // non-secret cli-config.json. Synthesize the primary auth.json from the
    // live store, gated on identity: the home's freshly-written authInfo (who
    // just logged in) must match the account, and the live tokens must not
    // verifiably belong to someone else.
    if (account.tool === "cursor" && !capturedCredentials.includes(primary)) {
      const live = await readCursorLiveAuth();
      if (!live) {
        throw new Error(
          `No live cursor credentials found (keychain or ${primary}); complete \`cursor-agent login\` first`,
        );
      }
      const seatInfo = await readCursorAuthInfo(homePath);
      const expected = accountEmail(account);
      if (expected && seatInfo?.email && seatInfo.email !== expected) {
        throw new Error(
          `The cursor login in ${homePath} belongs to ${seatInfo.email}, not ${expected} — capturing it would bill ${seatInfo.email}. Log in as ${expected} and retry.`,
        );
      }
      if (seatInfo?.authId && live.subs.size > 0 && !live.subs.has(seatInfo.authId)) {
        throw new Error(
          `The live cursor tokens do not match the identity that logged in at ${homePath}; refusing to vault an unattributable credential`,
        );
      }
      const target = join(accountDir(account), primary);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await atomicWriteFile(target, live.raw.endsWith("\n") ? live.raw : `${live.raw}\n`, { mode: 0o600 });
      captured.push(primary);
      capturedCredentials.push(primary);
    }
    // On macOS, claude stores the primary credential in the Keychain rather
    // than .credentials.json — and when both exist, the on-disk file is often
    // a stale relic of an old login. A present Keychain item is authoritative.
    if (authoritativeClaudeCredential !== null) {
      const target = join(accountDir(account), primary);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await atomicWriteFile(target, `${authoritativeClaudeCredential}\n`, { mode: 0o600 });
      if (!captured.includes(primary)) captured.push(primary);
      if (!capturedCredentials.includes(primary)) capturedCredentials.push(primary);
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
    return captured;
  });
  await appendLedger({ type: "account.capture", account: account.id, home: homePath, files: captured });
  return captured;
}

export type ActivationTiming = {
  totalMs: number;
  homeLockWaitMs: number;
  homeLockHeldMs: number;
  accountLockWaitMs: number;
  accountLockHeldMs: number;
  preActivateMs: number;
  preActivateStepsMs: Record<string, number>;
  credentialCopyMs: number;
  credentialFreshHits: number;
  credentialFreshMisses: number;
  identityVerificationMs: number;
  configCopyMs: number;
  defaultsMs: number;
  kit?: KitMaterializeTiming;
  gatewaySeedMs: number;
  accountLockOwner: LockOwnerMetadata | null;
  homeLockOwner: LockOwnerMetadata | null;
  singleFlight: boolean;
};

export type ActivateAccountOptions = {
  /** Surface non-fatal activation warnings (stale chain, failed refresh). */
  onWarn?: (message: string) => void;
  /** OAuth refresh override (tests). Defaults to refreshClaudeOauthChain. */
  refreshClaudeToken?: (refreshToken: string) => Promise<RefreshedClaudeToken | null>;
  /** Profile lookup override (tests). Defaults to claudeProfileEmailCached. */
  fetchProfileEmail?: (accessToken: string) => Promise<string | null>;
  now?: () => number;
  /** Always-on phase observation; receives durations and secret-free lock owners. */
  onTiming?: (timing: ActivationTiming) => void;
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
  /** Deferred so identity diagnostics never extend the credential lock. */
  deferredLedger?: Array<Record<string, unknown>>;
  /** Foreign-owner writes run only after the activating account lock is released. */
  deferredClaudeParking?: ClaudeChainParkingIntent[];
  time?<T>(phase: string, fn: () => Promise<T>): Promise<T>;
};

function timeActivationStep<T>(ctx: ActivationContext, phase: string, fn: () => Promise<T>): Promise<T> {
  return ctx.time ? ctx.time(phase, fn) : fn();
}

type ActivationHooks = {
  /** Runs before the copy: pull the freshest live credential into the vault; may refuse. */
  preActivate?(ctx: ActivationContext): Promise<void>;
  /** Credential-adjacent post-copy work; remains inside the account lock. */
  finalizeCredentials?(ctx: ActivationContext): Promise<void>;
  /** Non-secret home defaults run after releasing the account lock. */
  seedHomeDefaults?(ctx: ActivationContext): Promise<void>;
};

async function claudePreActivate(ctx: ActivationContext): Promise<void> {
  const { account, homePath, options, warn } = ctx;
  // (1) The home may currently hold ANOTHER account's chain (swap). The
  // rotated live link exists only there — rescue it into its own vault
  // before stamping over it, or that account's next activation revives a
  // dead link and logs it out.
  await timeActivationStep(ctx, "rescue-foreign", () => evacuateForeignClaudeChain(account, homePath).catch(() => undefined));
  // (2) Pull the account's own freshest link into the vault so we never
  // stamp a dead link over a live one.
  const synced = await timeActivationStep(ctx, "sync-vault", () => syncClaudeChainToVaultLocked(account, homePath).catch(() => undefined));
  if (synced?.parkingIntents.length) ctx.deferredClaudeParking?.push(...synced.parkingIntents);
  // (3) A stale chain would make claude boot onto an expired access token
  // and replay a possibly-rotated refresh token. Refresh it ourselves and
  // persist the rotation; on failure, refuse to stamp a known-dead chain.
  try {
    await timeActivationStep(ctx, "refresh", () => refreshVaultClaudeChainIfStaleLocked(account, options));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`could not refresh the stale OAuth chain for ${account.id}: ${detail}`);
    throw new Error(`Cannot activate ${account.id}: its OAuth chain is expired and could not be refreshed (${detail}). Re-login with: hive login ${account.id}`);
  }
}

async function codexPreActivate(ctx: ActivationContext): Promise<void> {
  const { account, homePath, warn } = ctx;
  // Codex rewrites auth.json when it refreshes tokens. Rescue the current
  // occupant before a swap stamp, then pull this account's newest attributed
  // auth into the vault so activation never revives an older refresh token.
  await timeActivationStep(ctx, "rescue-foreign", () => evacuateForeignCodexAuth(account, homePath).catch((error) => {
    warn(`could not rescue existing Codex auth from ${homePath}: ${error instanceof Error ? error.message : String(error)}`);
  }));
  await timeActivationStep(ctx, "sync-vault", () => syncCodexAuthToVaultLocked(account, homePath).catch((error) => {
    warn(`could not sync refreshed Codex auth for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
  }));
}

async function grokPreActivate(ctx: ActivationContext): Promise<void> {
  const { account, homePath, options, warn } = ctx;
  await timeActivationStep(ctx, "sync-vault", () => syncGrokAuthToVaultLocked(account, homePath).catch((error) => {
    warn(`could not sync refreshed Grok auth for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
  }));
  const vault = await readGrokAuthFile(join(accountDir(account), "auth.json"), "vault");
  const reason = grokAuthUnavailableReason(vault, options.now?.() ?? Date.now());
  if (reason) {
    throw new Error(`Cannot activate ${account.id}: Grok ${reason}. Re-login with: hive login ${account.id}`);
  }
}

async function cursorPreActivate(ctx: ActivationContext): Promise<void> {
  const { account, options, warn } = ctx;
  // Pull the freshest ATTRIBUTED credential into the vault first: cursor
  // persists whatever token a bee last used into the machine-global store, so
  // the sync's identity guard (JWT sub ↔ recorded authId) decides whether the
  // live store is this account's rotation or another account's session.
  await timeActivationStep(ctx, "sync-vault", () => syncCursorAuthToVaultLocked(account).catch((error) => {
    warn(`could not sync refreshed cursor auth for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
  }));
  const vault = await readCursorAuthFile(join(accountDir(account), "auth.json"), "vault");
  const reason = cursorAuthUnavailableReason(vault, options.now?.() ?? Date.now());
  if (reason) {
    throw new Error(`Cannot activate ${account.id}: cursor ${reason}. Re-login with: hive login ${account.id}`);
  }
}

async function genericPreActivate(ctx: ActivationContext): Promise<void> {
  const { account, homePath, warn } = ctx;
  // Other identity recipes are file-based. Pull back changes only from the
  // account's attributed homes; arbitrary --home paths are not trusted here
  // because their credential files do not carry a common identity claim.
  await timeActivationStep(ctx, "sync-vault", () => syncGenericCredentialsToVaultLocked(account, homePath).catch((error) => {
    warn(`could not sync refreshed credentials for ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
  }));
}

async function codexSeedHomeDefaults({ homePath, written }: ActivationContext): Promise<void> {
  if (await seedCodexHomeDefaults(homePath)) {
    if (!written.includes("config.toml")) written.push("config.toml");
  }
}

async function claudeSeedHomeDefaults(ctx: ActivationContext): Promise<void> {
  const { homePath, written } = ctx;
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
}

/** Keychain is an effective credential store, so stamp + verify it under the account lock. */
async function claudeFinalizeCredentials(ctx: ActivationContext): Promise<void> {
  const { account, homePath, recipe, warn, written } = ctx;
  // On macOS, claude prefers the per-config-dir Keychain entry over the
  // credentials file — seed it so an activated home doesn't resolve a stale
  // identity from an old entry. Merged, not replaced: home-local sibling
  // keys (mcpOAuth, ...) survive the identity stamp — except when the merged
  // payload overflows the `security -i` line buffer, where the writer falls
  // back to stamping the identity alone rather than leaving the old one.
  if (keychainAvailable()) {
    const credentials = (await readFile(join(accountDir(account), recipe.credentialFiles[0]!), "utf8")).trim();
    const existingRaw = await readClaudeKeychainRaw(homePath);
    const existing = existingRaw === null ? null : decodeSecurityPasswordOutput(existingRaw);
    const merged = mergeCredentialsJson(existing, credentials);
    // Elide a provably-redundant keychain write. When the existing entry is
    // already raw JSON and semantically identical to the merged target
    // (order/format aside), the `security -i` subprocess would re-stamp the
    // exact same identity — the dominant cost of re-activating an already-live
    // home. claudeCredentialsEquivalent only reports true on a proven parse of
    // both sides. Crucially, legacy hex text is migration input, never a health
    // hit: accepting it here caused activation to preserve credentials Claude
    // itself rejected as "Not logged in". The independent strict identity
    // reread below still catches any post-read external mutation.
    if (existingRaw?.trimStart().startsWith("{") && claudeCredentialsEquivalent(existingRaw, merged)) {
      written.push("keychain");
    } else {
      const write = await writeClaudeKeychainEntry(homePath, merged);
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
  }
  await timeActivationStep(ctx, "identity-verification", () => verifyActivatedClaudeIdentity(ctx));
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
  ctx: ActivationContext,
  deps: { readKeychain?: typeof readClaudeKeychainRaw } = {},
): Promise<void> {
  const { account, homePath, options, warn } = ctx;
  const expected = accountEmail(account);
  if (!expected) return;
  const readKeychain = deps.readKeychain ?? readClaudeKeychainRaw;
  const rawKeychain = await readKeychain(homePath);
  // Keychain presence is authoritative even when malformed: Claude does not
  // fall back to the file when an unusable keychain item exists. Strictly
  // reject hex/corrupt text rather than proving the identity of a file Claude
  // will never consume.
  const effective = rawKeychain !== null
    ? parseClaudeChainStrict(rawKeychain, `${homePath}:keychain`)
    : parseClaudeChainStrict(
        await readFile(join(homePath, ".credentials.json"), "utf8").catch(() => null),
        `${homePath}:file`,
      );
  if (rawKeychain !== null && !effective) {
    throw new Error(`Activation produced an unusable macOS Keychain entry for ${homePath}; expected raw Claude credential JSON`);
  }
  if (!effective) return;
  const vault = parseClaudeChainStrict(
    await readFile(join(accountDir(account), ".credentials.json"), "utf8").catch(() => null),
    "vault",
  );
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
    // Do not perform the non-secret ledger write while the credential lock is
    // held. The outer activation flushes this after both locks are released.
    const event = { type: "account.activation-identity-mismatch", account: account.id, home: homePath, expected, actual, source: effective.source };
    if (ctx.deferredLedger) ctx.deferredLedger.push(event);
    else await appendLedger(event).catch(() => undefined);
    throw new Error(
      `Activation identity mismatch for ${homePath}: the credential claude would boot with (${effective.source}) belongs to ${actual}, not ${expected} — a bee on this home would bill ${actual}. Repair with: hive login ${account.id}`,
    );
  }
}

const ACTIVATION_HOOKS: Record<string, ActivationHooks> = {
  claude: { preActivate: claudePreActivate, finalizeCredentials: claudeFinalizeCredentials, seedHomeDefaults: claudeSeedHomeDefaults },
  codex: { preActivate: codexPreActivate, seedHomeDefaults: codexSeedHomeDefaults },
  grok: { preActivate: grokPreActivate },
  cursor: { preActivate: cursorPreActivate },
};

const GENERIC_ACTIVATION_HOOKS: ActivationHooks = { preActivate: genericPreActivate };

function activationHooksFor(tool: string): ActivationHooks {
  return ACTIVATION_HOOKS[tool] ?? GENERIC_ACTIVATION_HOOKS;
}

type ActivationOutcome = { written: string[]; timing: ActivationTiming };

const activationFlights = new Map<string, Promise<ActivationOutcome>>();

/**
 * Stable physical identity for a home. Existing aliases collapse through
 * realpath; a not-yet-created home is expressed beneath the nearest real
 * existing ancestor so later operations never follow the caller's alias.
 * Dangling symlink components and permission/I/O ambiguity fail closed.
 */
export async function canonicalActivationHomePath(homePath: string): Promise<string> {
  let cursor = resolve(homePath);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return join(existing, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Could not canonicalize activation home ${resolve(homePath)}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const info = await lstat(cursor);
        // lstat succeeded while realpath failed: normally a dangling symlink.
        throw new Error(
          `Could not canonicalize activation home ${resolve(homePath)}: ` +
          `${cursor} exists but has no stable physical target${info.isSymbolicLink() ? " (dangling symlink)" : ""}`,
        );
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw lstatError;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`Could not find an existing parent for activation home ${resolve(homePath)}`);
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function activationHomeKey(canonicalHomePath: string): string {
  return createHash("sha256").update(canonicalHomePath).digest("hex").slice(0, 32);
}

function activationHomeLockPath(canonicalHomePath: string): string {
  return join(storeRoot(), "locks", "activation-homes", `${activationHomeKey(canonicalHomePath)}.lock`);
}

export type ActivationHomeOwner = {
  version: 1;
  homePath: string;
  accountId: string;
  generation: string;
  state: "activating" | "ready";
  activatedAt: string;
  updatedAt: string;
};

function activationHomeOwnerPathCanonical(canonicalHomePath: string): string {
  return join(storeRoot(), "activation-home-owners", `${activationHomeKey(canonicalHomePath)}.json`);
}

export async function activationHomeOwnerPath(homePath: string): Promise<string> {
  return activationHomeOwnerPathCanonical(await canonicalActivationHomePath(homePath));
}

export async function withActivationHomeLock<T>(
  homePath: string,
  fn: (canonicalHomePath: string) => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const canonicalHomePath = await canonicalActivationHomePath(homePath);
  return withFileLock(activationHomeLockPath(canonicalHomePath), () => fn(canonicalHomePath), options);
}

export async function readActivationHomeOwner(homePath: string): Promise<ActivationHomeOwner | null> {
  const lexicalHomePath = resolve(homePath);
  const canonicalHomePath = await canonicalActivationHomePath(homePath);
  const canonicalPath = activationHomeOwnerPathCanonical(canonicalHomePath);
  // Compatibility for a pre-canonicalization stamp written through an alias.
  // New writes always use canonicalPath; malformed canonical state never falls
  // back to a legacy alias claim.
  const paths = [canonicalPath];
  if (lexicalHomePath !== canonicalHomePath) {
    paths.push(activationHomeOwnerPathCanonical(lexicalHomePath));
  }
  try {
    let raw: string | null = null;
    for (const path of paths) {
      try {
        raw = await readFile(path, "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("owner stamp is not an object");
    const owner = parsed as Partial<ActivationHomeOwner>;
    const ownerCanonicalHomePath = typeof owner.homePath === "string"
      ? await canonicalActivationHomePath(owner.homePath)
      : null;
    if (
      owner.version !== 1 ||
      ownerCanonicalHomePath !== canonicalHomePath ||
      typeof owner.accountId !== "string" || !owner.accountId ||
      typeof owner.generation !== "string" || !owner.generation ||
      (owner.state !== "activating" && owner.state !== "ready") ||
      typeof owner.activatedAt !== "string" ||
      typeof owner.updatedAt !== "string"
    ) throw new Error("owner stamp has invalid fields");
    return { ...(owner as ActivationHomeOwner), homePath: canonicalHomePath };
  } catch (error) {
    throw new Error(
      `Invalid activation-home owner stamp for ${canonicalHomePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeActivationHomeOwner(owner: ActivationHomeOwner): Promise<void> {
  const canonicalHomePath = await canonicalActivationHomePath(owner.homePath);
  const canonicalOwner = { ...owner, homePath: canonicalHomePath };
  await atomicWriteFile(activationHomeOwnerPathCanonical(canonicalHomePath), `${JSON.stringify(canonicalOwner, null, 2)}\n`, { mode: 0o600 });
}

function emptyActivationTiming(): ActivationTiming {
  return {
    totalMs: 0,
    homeLockWaitMs: 0,
    homeLockHeldMs: 0,
    accountLockWaitMs: 0,
    accountLockHeldMs: 0,
    preActivateMs: 0,
    preActivateStepsMs: {},
    credentialCopyMs: 0,
    credentialFreshHits: 0,
    credentialFreshMisses: 0,
    identityVerificationMs: 0,
    configCopyMs: 0,
    defaultsMs: 0,
    gatewaySeedMs: 0,
    accountLockOwner: null,
    homeLockOwner: null,
    singleFlight: false,
  };
}

function notifyActivationTiming(callback: ActivateAccountOptions["onTiming"], timing: ActivationTiming): void {
  try {
    callback?.(timing);
  } catch {
    // Telemetry cannot make a credential activation fail.
  }
}

/** Byte freshness fast path; mode repair still forces an atomic rewrite. */
async function copyFileAtomicallyIfChanged(source: string, target: string): Promise<boolean> {
  const data = await readFile(source, "utf8");
  const [current, targetInfo] = await Promise.all([
    readFile(target, "utf8").catch(() => null),
    stat(target).catch(() => null),
  ]);
  if (current === data && targetInfo?.isFile() && (targetInfo.mode & 0o777) === 0o600) return false;
  await mkdir(dirname(target), { recursive: true });
  await atomicWriteFile(target, data, { mode: 0o600 });
  return true;
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
  const canonicalHomePath = await canonicalActivationHomePath(homePath);
  const flightKey = `${account.id}\0${canonicalHomePath}`;
  const existing = activationFlights.get(flightKey);
  if (existing) {
    const joinedAt = performance.now();
    const outcome = await existing;
    notifyActivationTiming(options.onTiming, {
      ...outcome.timing,
      totalMs: performance.now() - joinedAt,
      singleFlight: true,
    });
    return [...outcome.written];
  }
  const flight = performAccountActivation(account, canonicalHomePath, options);
  activationFlights.set(flightKey, flight);
  try {
    const outcome = await flight;
    return [...outcome.written];
  } finally {
    if (activationFlights.get(flightKey) === flight) activationFlights.delete(flightKey);
  }
}

async function performAccountActivation(
  account: AccountRecord,
  homePath: string,
  options: ActivateAccountOptions,
): Promise<ActivationOutcome> {
  const started = performance.now();
  const recipe = recipeFor(account);
  const warn = options.onWarn ?? (() => undefined);
  const hooks = activationHooksFor(account.tool);
  const timing = emptyActivationTiming();
  const deferredLedger: Array<Record<string, unknown>> = [];
  const deferredClaudeParking: ClaudeChainParkingIntent[] = [];
  const ctx: ActivationContext = {
    account,
    homePath,
    recipe,
    options,
    warn,
    written: [],
    deferredLedger,
    deferredClaudeParking,
    async time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
      const phaseStarted = performance.now();
      try {
        return await fn();
      } finally {
        const duration = performance.now() - phaseStarted;
        timing.preActivateStepsMs[phase] = (timing.preActivateStepsMs[phase] ?? 0) + duration;
        if (phase === "identity-verification") timing.identityVerificationMs += duration;
      }
    },
  };
  let failure: unknown;
  try {
    let homeLockAcquiredAt = 0;
    try {
      await withActivationHomeLock(homePath, async (lockedHomePath) => {
        if (lockedHomePath !== homePath) throw new Error("activation home identity changed before lock acquisition");
        homeLockAcquiredAt = performance.now();
        // Claim the home before touching credentials. A failed activation may
        // conservatively leave an "activating" owner, which is safer than
        // letting a stale session harvest partially replaced bytes into its
        // old account vault. The next activation supersedes this generation.
        const activatedAt = new Date(options.now?.() ?? Date.now()).toISOString();
        const owner: ActivationHomeOwner = {
          version: 1,
          homePath,
          accountId: account.id,
          generation: randomUUID(),
          state: "activating",
          activatedAt,
          updatedAt: activatedAt,
        };
        await writeActivationHomeOwner(owner);
        let accountLockAcquiredAt = 0;
        try {
          await withAccountLock(account.id, async () => {
            accountLockAcquiredAt = performance.now();
            const preStarted = performance.now();
            try {
              await hooks.preActivate?.(ctx);
            } finally {
              timing.preActivateMs = performance.now() - preStarted;
            }
            // Refuse to activate without the primary credential: copying only the
            // supporting snapshots would clobber the home's settings without a login.
            const primary = join(accountDir(account), recipe.credentialFiles[0]!);
            if (!(await stat(primary).catch(() => null))?.isFile()) {
              throw new Error(`Vault has no credentials for ${account.id}. Capture them first: hive account login ${account.tool} ${account.label}`);
            }
            const copyStarted = performance.now();
            try {
              for (const relative of recipe.credentialFiles) {
                const source = join(accountDir(account), relative);
                const info = await stat(source).catch(() => null);
                if (!info?.isFile()) continue;
                const targets = [relative, ...(recipe.activationMirrors?.[relative] ? [recipe.activationMirrors[relative]!] : [])];
                for (const homeRelative of targets) {
                  const changed = await copyFileAtomicallyIfChanged(source, join(homePath, homeRelative));
                  if (changed) timing.credentialFreshMisses += 1;
                  else timing.credentialFreshHits += 1;
                  if (!ctx.written.includes(homeRelative)) ctx.written.push(homeRelative);
                }
              }
            } finally {
              timing.credentialCopyMs = performance.now() - copyStarted;
            }
            if (ctx.written.length === 0) {
              throw new Error(`Vault has no credentials for ${account.id}. Capture them first: hive account login ${account.tool} ${account.label}`);
            }
            await hooks.finalizeCredentials?.(ctx);
            await writeActivationHomeOwner({
              ...owner,
              state: "ready",
              updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
            });
          }, {
            onAcquired: ({ waitMs, owner }) => {
              timing.accountLockWaitMs = waitMs;
              timing.accountLockOwner = owner;
            },
            onTimeout: ({ waitMs, owner }) => {
              timing.accountLockWaitMs = waitMs;
              timing.accountLockOwner = owner;
            },
          });
        } finally {
          timing.accountLockHeldMs = accountLockAcquiredAt > 0 ? performance.now() - accountLockAcquiredAt : 0;
        }

        // Parking a verified foreign chain is a cross-account operation. The
        // scan above only returned intents while A was locked; fulfil them now,
        // after A is released, under each real owner's lock with a fresh vault
        // read. This also prevents A→B/B→A lock-order cycles.
        for (const intent of deferredClaudeParking.splice(0)) {
          await fulfillClaudeChainParkingIntent(intent).catch((error) => {
            warn(`could not park a foreign Claude chain with ${intent.ownerId}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }

        // Config/default/capability convergence is home-scoped, not secret-vault
        // work. It remains serialized for the same home while different homes
        // proceed independently after the account chain is safe.
        const configStarted = performance.now();
        for (const relative of recipe.configFiles ?? []) {
          const source = join(accountDir(account), relative);
          const info = await stat(source).catch(() => null);
          if (!info?.isFile()) continue;
          await copyFileAtomicallyIfChanged(source, join(homePath, relative));
          if (!ctx.written.includes(relative)) ctx.written.push(relative);
        }
        timing.configCopyMs = performance.now() - configStarted;

        const defaultsStarted = performance.now();
        await hooks.seedHomeDefaults?.(ctx);
        timing.defaultsMs = performance.now() - defaultsStarted;

        const kitStamp = await readKitHomeStamp(homePath);
        await kitMaterializeHome(homePath, account.tool, {
          warn,
          profile: kitStamp.kitProfile,
          onTiming: (kitTiming) => { timing.kit = kitTiming; },
        });
        const gatewayStarted = performance.now();
        const gatewaySeed = await seedGatewayMcp(homePath, account.tool);
        timing.gatewaySeedMs = performance.now() - gatewayStarted;
        for (const relative of gatewaySeed.written) {
          if (!ctx.written.includes(relative)) ctx.written.push(relative);
        }
      }, {
        timeoutMs: 3 * 60_000,
        onAcquired: ({ waitMs, owner }) => {
          timing.homeLockWaitMs = waitMs;
          timing.homeLockOwner = owner;
        },
        onTimeout: ({ waitMs, owner }) => {
          timing.homeLockWaitMs = waitMs;
          timing.homeLockOwner = owner;
        },
      });
    } finally {
      timing.homeLockHeldMs = homeLockAcquiredAt > 0 ? performance.now() - homeLockAcquiredAt : 0;
    }
  } catch (error) {
    failure = error;
  }

  // Every filesystem/account lock is released before these non-secret writes.
  for (const event of deferredLedger) await appendLedger(event).catch(() => undefined);
  if (!failure) {
    await appendLedger({ type: "account.activate", account: account.id, tool: account.tool, home: homePath, files: ctx.written });
  }
  timing.totalMs = performance.now() - started;
  await appendLedger({
    type: "account.activation-timing",
    account: account.id,
    tool: account.tool,
    homeKey: activationHomeKey(homePath),
    outcome: failure ? "failed" : "ready",
    ...timing,
  }).catch(() => undefined);
  notifyActivationTiming(options.onTiming, timing);
  if (failure) throw failure;
  return { written: ctx.written, timing };
}

/** True when the vault holds the account's PRIMARY credential file. */
export async function accountHasCredentials(account: AccountRecord): Promise<boolean> {
  const recipe = identityRecipeForAgent(account.tool);
  if (!recipe) return false;
  const info = await stat(join(accountDir(account), recipe.credentialFiles[0]!)).catch(() => null);
  return info?.isFile() === true;
}
