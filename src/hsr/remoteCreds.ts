/**
 * Per-node ephemeral credential delivery for remote HSR (APIA-93).
 *
 * SECURITY-SENSITIVE. This module implements the "ephemeral-token" auth policy:
 * it delivers a SINGLE account's SHORT-LIVED login into a remote node's per-bee
 * isolated home at spawn, and shreds it on kill. It NEVER copies the vault to a
 * remote, and NEVER re-implements OAuth — the claude path execs the GENUINE
 * `claude setup-token` binary to mint a real token.
 *
 * Guardrails (non-negotiable — mirrored in code below):
 *  - The local vault is NEVER copied wholesale to a remote; only THIS account's
 *    single primary credential (per the identity recipe) crosses the wire.
 *  - Delivered credentials are DESTROYED on kill (overwrite-then-unlink); they
 *    live only in the remote's per-bee isolated home for the bee's lifetime.
 *  - Credential material is base64/opaque in transit and is NEVER written to
 *    logs, the ledger, or error messages. `kindNote` carries no secret bytes.
 *  - Only the genuine harness runs remotely; nothing here spoofs a provider.
 *
 * Two sides live here:
 *  - MINT side (runs LOCALLY, in cli.ts spawnBee): mintEphemeralCredential —
 *    reads the account's vaulted primary credential / mints a setup-token.
 *  - DELIVER/SHRED side (runs ON THE REMOTE, in remoteHost.ts spawn/kill):
 *    writeDeliveredCredentials / recordDeliveredCredentials / shredDelivered-
 *    Credentials — pure fs, no accounts.ts import, so the runner-host bundle
 *    stays lean (esbuild DCE drops the mint side + its accounts.ts graph).
 *
 * Node builtins + the lightweight drivers/harness/runDir modules only.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { homeEnvForAgent, identityRecipeForAgent } from "../drivers.js";
import { ephemeralHarnesses, ephemeralPolicyFor } from "./harness.js";
import { hsrRunDir } from "./runDir.js";
// accounts.ts is imported ONLY by the mint side; remoteHost.ts imports only the
// deliver/shred functions, so esbuild's tree-shake keeps accounts.ts out of the
// remote runner-host bundle. Keep it that way: no accounts symbol may be used by
// any export remoteHost.ts calls.
import { accountDir, defaultHomeForAccount, ensureFreshCodexVaultToken, expFromJwt, type AccountRecord } from "../accounts.js";

const execFileP = promisify(execFile);

// ── Wire shape (opaque; base64 in transit) ─────────────────────────────────

/** One credential file to write into the remote isolated home. */
export type EphemeralCredentialFile = {
  /** Path RELATIVE to the harness home (e.g. "auth.json", ".credentials.json"). */
  homeRelPath: string;
  /** File bytes, base64-encoded. Opaque — NEVER decode into a log/error. */
  contentB64: string;
  /** POSIX mode for the written file (0600). */
  mode: number;
};

/**
 * The short-lived material to ship to the remote isolated home. `files` are
 * written into the home; `env` is merged into the spawn env (e.g. a minted
 * token). `kindNote` is a secret-free, one-line description for the operator.
 */
export type EphemeralCredential = {
  files: EphemeralCredentialFile[];
  env?: Record<string, string>;
  kindNote: string;
  /**
   * NON-SECRET expiry (unix SECONDS) of the delivered short-lived material, when
   * known — e.g. the shipped codex access token's JWT `exp`. UNIT 2's daemon
   * expiry tracking consumes this to re-deliver before a bee's token dies. Never
   * carries token bytes.
   */
  expiresAt?: number;
};

// ── Per-kind policy ─────────────────────────────────────────────────────────
// The ephemeral-credential policy per harness lives in the harness registry
// (harness.ts HARNESSES.<name>.ephemeral — the single registration point per
// HIVE-20); this module consumes it via ephemeralPolicyFor.

export type MintDeps = {
  /**
   * Injectable `claude setup-token` runner (tests inject a fake so no real token
   * is minted). Returns the token string, or null to trigger the file fallback.
   */
  runClaudeSetupToken?: (homePath: string) => Promise<string | null>;
  /**
   * Injectable central codex token-freshness check (tests inject a fake so no
   * real `codex exec` runs). Defaults to ensureFreshCodexVaultToken.
   */
  ensureFreshCodexToken?: (account: AccountRecord) => Promise<unknown>;
};

// Never ship a codex access token with less than this TTL remaining: below it
// the token could die mid-run on the remote before UNIT 2 re-delivers.
const CODEX_MIN_SHIP_TTL_MS = 15 * 60_000;

/**
 * Mint the SHORT-LIVED credential material for `account` (harness `kind`) to
 * deliver to a remote isolated home. Never returns/ships more than this single
 * account's primary credential (or a purpose-minted token).
 */
export async function mintEphemeralCredential(
  account: AccountRecord,
  kind: string,
  deps: MintDeps = {},
): Promise<EphemeralCredential> {
  const policy = ephemeralPolicyFor(kind);
  if (!policy) {
    throw new Error(`ephemeral-token delivery is not wired for harness "${kind}" (supported: ${ephemeralHarnesses().join(", ")})`);
  }

  if (policy.strategy === "mint-token") {
    const run = deps.runClaudeSetupToken ?? defaultRunClaudeSetupToken;
    // Mint against the account's LOCAL home so the token belongs to this account.
    const token = await run(defaultHomeForAccount(account));
    if (token && policy.tokenEnv) {
      // Token rides in `env` (usable as-is by the child); it is opaque and must
      // never be logged. kindNote deliberately omits the token bytes.
      return {
        files: [],
        env: { [policy.tokenEnv]: token },
        kindNote: `${kind}: minted setup-token, delivered as ${policy.tokenEnv} (no credential file on remote)`,
      };
    }
    // Fallback: ship the primary credential file like codex. WEAKER guarantee —
    // it is the vault snapshot's refresh chain, not a purpose-minted token.
    const file = await requirePrimaryCredential(account, kind);
    return {
      files: [file],
      kindNote: `${kind}: setup-token unavailable; fell back to shipping ${file.homeRelPath} (weaker guarantee)`,
    };
  }

  if (policy.strategy === "ship-access-token") {
    return mintCodexAccessTokenCredential(account, kind, deps);
  }

  if (policy.strategy === "ship-refresh-blanked-file") {
    return mintRefreshBlankedFileCredential(account, kind);
  }

  if (policy.strategy === "ship-provider-file") {
    return mintOpenCodeProviderCredential(account, kind);
  }

  // ship-primary-file
  const file = await requirePrimaryCredential(account, kind);
  return {
    files: [file],
    kindNote: `${kind}: shipped ${file.homeRelPath} into the remote isolated home (0600)`,
  };
}

// OAuth refresh-token field names blanked before a credential file is shipped:
// grok/codex/kimi use `refresh_token`, opencode's oauth entries use `refresh`.
const REFRESH_TOKEN_KEYS = new Set(["refresh_token", "refresh"]);

/**
 * Deep-clone a parsed credential JSON with EVERY OAuth refresh-token field
 * blanked to "" (field kept, so the harness's serde still parses the file).
 * Blanks only string values under keys named exactly `refresh_token`/`refresh`;
 * access tokens, api keys, and expiries are preserved untouched. The vault
 * stays the sole holder of every real refresh token, so no two fleet bees ever
 * present the same one-time-use refresh token (research §2). Opaque — the
 * caller never logs the result.
 */
function blankRefreshTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => blankRefreshTokens(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REFRESH_TOKEN_KEYS.has(key) && typeof inner === "string" ? "" : blankRefreshTokens(inner);
    }
    return out;
  }
  return value;
}

/**
 * ship-refresh-blanked-file (grok, kimi): deliver the account's primary
 * credential file with every OAuth refresh token blanked. Grok's auth.json is
 * keyed by issuer::client (each entry may carry `refresh_token`); kimi's
 * credentials/kimi-code.json is a flat OAuth store whose `refresh_token` ROTATES
 * on every grant. Blanking keeps the vault the sole holder of the real refresh
 * token — a delivered cached OAuth access token / api key is preserved, exactly
 * like codex. An api-key-only file has no refresh field and ships verbatim.
 */
async function mintRefreshBlankedFileCredential(account: AccountRecord, kind: string): Promise<EphemeralCredential> {
  const file = await requirePrimaryCredential(account, kind);
  const raw = Buffer.from(file.contentB64, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${kind} credential file ${file.homeRelPath} for account ${account.id} is not valid JSON; re-login with: hive account login ${account.tool} ${account.label}`);
  }
  const body = `${JSON.stringify(blankRefreshTokens(parsed), null, 2)}\n`;
  return {
    files: [{ homeRelPath: file.homeRelPath, contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
    kindNote: `${kind}: shipped ${file.homeRelPath} with OAuth refresh token(s) blanked into the remote isolated home (0600)`,
  };
}

/**
 * ship-provider-file (opencode): opencode's auth.json multiplexes EVERY
 * provider login in one object keyed by providerID. Ship ONLY the account's
 * single `provider` entry (codex-style single-provider) — every other
 * provider's credential is dropped — with the kept entry's OAuth refresh token
 * blanked. Never ships the whole multi-provider file. Fails closed when the
 * account has no provider or the file has no entry for it.
 */
async function mintOpenCodeProviderCredential(account: AccountRecord, kind: string): Promise<EphemeralCredential> {
  const provider = account.provider;
  if (!provider) {
    throw new Error(`opencode account ${account.id} has no provider; set one so a single-provider auth.json can be shipped (re-add with --provider <id>)`);
  }
  const file = await requirePrimaryCredential(account, kind); // xdg-data/opencode/auth.json
  const raw = Buffer.from(file.contentB64, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`opencode auth.json for account ${account.id} is not valid JSON; re-login with: hive account login opencode ${account.label}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`opencode auth.json for account ${account.id} is not a provider map; re-login with: hive account login opencode ${account.label}`);
  }
  const providers = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(providers, provider)) {
    throw new Error(`opencode auth.json for account ${account.id} has no entry for provider "${provider}"; re-login with: hive account login opencode ${account.label}`);
  }
  // Single-provider filter: a NEW object carrying ONLY this account's provider
  // key, refresh blanked. Every other provider's credential is dropped.
  const filtered = { [provider]: blankRefreshTokens(providers[provider]) };
  const body = `${JSON.stringify(filtered, null, 2)}\n`;
  return {
    files: [{ homeRelPath: file.homeRelPath, contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
    kindNote: `opencode: shipped a single-provider (${provider}) auth.json (refresh blanked, other providers dropped) into the remote isolated home (0600)`,
  };
}

/**
 * ship-access-token (codex): deliver an auth.json carrying a FRESH access token
 * with the refresh token BLANKED (`refresh_token: ""`, field kept — codex serde
 * requires it present; deleting it hard-fails). The vault stays the sole holder
 * of the real refresh token, so no two fleet bees ever present the same
 * one-time-use refresh token. Because the access token lasts ~10 days, bees
 * essentially never refresh mid-run.
 */
async function mintCodexAccessTokenCredential(account: AccountRecord, kind: string, deps: MintDeps): Promise<EphemeralCredential> {
  // Keep the vault access token fresh BEFORE we read it: if it is near/at expiry
  // this triggers a central refresh (codex rotates in place; the vault harvests
  // the rotated token). Never ships a stale token to the remote.
  const ensureFresh = deps.ensureFreshCodexToken ?? ensureFreshCodexVaultToken;
  await ensureFresh(account);

  const file = await requirePrimaryCredential(account, kind); // codex auth.json
  const raw = Buffer.from(file.contentB64, "base64").toString("utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`codex auth.json for account ${account.id} is not valid JSON; re-login with: hive account login codex ${account.label}`);
  }
  const tokens =
    parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
      ? (parsed.tokens as Record<string, unknown>)
      : undefined;
  const accessToken = tokens && typeof tokens.access_token === "string" ? (tokens.access_token as string) : undefined;
  if (!accessToken) {
    throw new Error(`codex auth.json for account ${account.id} has no tokens.access_token; cannot ship an access-token-only credential`);
  }
  const expSeconds = expFromJwt(accessToken);
  if (expSeconds === undefined) {
    throw new Error(`codex access token for account ${account.id} has no decodable expiry; refusing to ship`);
  }
  // Guardrail: never ship a stale token. The central refresh above should have
  // freshened it, but re-check the emitted token (secret-free) so an
  // unrefreshable account fails HERE instead of shipping a dead token.
  if (expSeconds * 1000 - Date.now() <= CODEX_MIN_SHIP_TTL_MS) {
    throw new Error(`codex access token for account ${account.id} is expired or near-expiry after refresh; not shipping a stale token`);
  }

  // Blank the refresh token, preserve everything else (access_token, id_token,
  // account_id, auth_mode, OPENAI_API_KEY, last_refresh).
  const blanked = { ...parsed, tokens: { ...tokens, refresh_token: "" } };
  const body = `${JSON.stringify(blanked, null, 2)}\n`;
  return {
    files: [{ homeRelPath: file.homeRelPath, contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
    expiresAt: expSeconds,
    kindNote: `${kind}: shipped access-token-only auth.json (refresh_token blanked), exp ${new Date(expSeconds * 1000).toISOString()}`,
  };
}

/** Default: exec the GENUINE `claude setup-token` against the account's home. */
async function defaultRunClaudeSetupToken(homePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("claude", ["setup-token"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: homePath },
      timeout: 120_000,
      maxBuffer: 1 << 20,
    });
    return extractSetupToken(stdout);
  } catch {
    // Binary missing / not logged in / non-interactive refusal → fall back.
    return null;
  }
}

/** Pull the token out of `claude setup-token` output (secret-free failure = null). */
function extractSetupToken(raw: string): string | null {
  const explicit = raw.match(/sk-ant-[A-Za-z0-9_-]+/);
  if (explicit) return explicit[0];
  const last = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return last && /^[A-Za-z0-9_.-]{20,}$/.test(last) ? last : null;
}

/**
 * Read THIS account's single primary credential file (recipe.credentialFiles[0])
 * from the vault (preferred) or its dedicated home, base64-encoded. NEVER reads
 * the whole vault or the supporting snapshots — only the one login file.
 */
async function requirePrimaryCredential(account: AccountRecord, kind: string): Promise<EphemeralCredentialFile> {
  const recipe = identityRecipeForAgent(kind);
  if (!recipe || recipe.credentialFiles.length === 0) {
    throw new Error(`harness "${kind}" has no identity recipe; cannot mint an ephemeral credential`);
  }
  const primary = recipe.credentialFiles[0]!;
  const candidates = [join(accountDir(account), primary), join(defaultHomeForAccount(account), primary)];
  for (const path of candidates) {
    const buf = await readFile(path).catch(() => null);
    if (buf) return { homeRelPath: primary, contentB64: buf.toString("base64"), mode: 0o600 };
  }
  throw new Error(`no primary credential (${primary}) found for account ${account.id}; capture it first with: hive account login ${account.tool} ${account.label}`);
}

// ── Deliver / shred side (runs ON THE REMOTE — pure fs, no accounts import) ──

/** The `creds` payload carried over the spawn RPC (deliver side). */
export type DeliveredCredentials = {
  files?: EphemeralCredentialFile[];
  env?: Record<string, string>;
};

/**
 * The harness home dir for a resolved spec, read out of its env (CLAUDE_CONFIG_DIR
 * / CODEX_HOME / …). Undefined when the harness has no home env.
 */
export function homeDirForSpec(kind: string, env: Record<string, string>): string | undefined {
  const homeEnv = homeEnvForAgent(kind);
  return homeEnv ? env[homeEnv] : undefined;
}

const LEGACY_DELIVERED_CREDS_LOCATOR_VERSION = 1 as const;
const DELIVERED_CREDS_LOCATOR_VERSION = 2 as const;
const ZEROED_RECEIPT_VERSION = 1 as const;
const MAX_LOCATOR_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const ZERO_CHUNK_BYTES = 64 * 1024;

type PhysicalIdentity = {
  device: string;
  inode: string;
};

type OwnedHomeIdentity = PhysicalIdentity & {
  canonicalPath: string;
  uid: string;
};

type DeliveredCredentialTarget = PhysicalIdentity & {
  homeRelPath: string;
  parentDirectories: Array<PhysicalIdentity & { homeRelPath: string }>;
  /** Delivery requires one physical name so zeroing cannot mutate a hard-link victim. */
  linkCount: "1";
};

export type DeliveredCredentialsLocator = {
  version: typeof DELIVERED_CREDS_LOCATOR_VERSION;
  /** Random, non-secret identity binding erase receipts to this delivery. */
  generation: string;
  bee: string;
  home: OwnedHomeIdentity;
  files: DeliveredCredentialTarget[];
};

type LocatorDraft = Omit<DeliveredCredentialsLocator, "bee">;
const locatorDraftSymbol = Symbol("delivered-credentials-locator-draft");
type DeliveredCredentialPaths = string[] & { [locatorDraftSymbol]?: LocatorDraft };

type PreparedCredential = {
  handle: FileHandle;
  home: OwnedHomeIdentity;
  target: string;
  content: Buffer;
  identity: DeliveredCredentialTarget;
};

type LegacyDeliveredCredentialsLocator = Omit<DeliveredCredentialsLocator, "version" | "generation"> & {
  version: typeof LEGACY_DELIVERED_CREDS_LOCATOR_VERSION;
};

type ParsedDeliveredCredentialsLocator = DeliveredCredentialsLocator | LegacyDeliveredCredentialsLocator;

type ZeroedTargetIdentity = PhysicalIdentity & {
  size: string;
  ctimeNs: string;
  mtimeNs: string;
  birthtimeNs: string;
};

type ZeroedCredentialReceipt = {
  version: typeof ZEROED_RECEIPT_VERSION;
  bee: string;
  locatorGeneration: string;
  fileIndex: number;
  homeRelPath: string;
  zeroed: ZeroedTargetIdentity;
};

export type DeliveredCredentialEraseOperation =
  | "locator-open"
  | "locator-stat"
  | "home-realpath"
  | "home-lstat"
  | "target-parent-lstat"
  | "target-parent-realpath"
  | "target-lstat"
  | "target-realpath"
  | "target-open"
  | "target-fstat"
  | "target-write"
  | "target-sync"
  | "target-verify-read"
  | "receipt-open"
  | "receipt-commit"
  | "receipt-directory-sync"
  | "target-pre-unlink-lstat"
  | "target-unlink"
  | "target-absence"
  | "locator-pre-unlink-lstat"
  | "locator-unlink"
  | "locator-absence";

/** Deterministic failure hook used by security regressions; production omits it. */
export type DeliveredCredentialEraseOptions = {
  beforeOperation?: (operation: DeliveredCredentialEraseOperation) => void | Promise<void>;
};

export type DeliveredCredentialEraseFailureCode =
  | "locator-unreadable"
  | "locator-invalid"
  | "home-unverified"
  | "target-unverified"
  | "overwrite-failed"
  | "erase-state-invalid"
  | "erase-state-persist-failed"
  | "unlink-failed"
  | "absence-unverified"
  | "locator-remove-failed";

export type DeliveredCredentialEraseResult =
  | { ok: true; status: "erased" | "already-absent"; erasedFiles: number }
  | { ok: false; status: "incomplete"; code: DeliveredCredentialEraseFailureCode; retryable: true };

export class DeliveredCredentialsLocatorError extends Error {
  readonly code: "locator-unreadable" | "locator-invalid";

  constructor(code: "locator-unreadable" | "locator-invalid") {
    super(code === "locator-unreadable" ? "delivered credential locator is unreadable" : "delivered credential locator is invalid");
    this.name = "DeliveredCredentialsLocatorError";
    this.code = code;
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function physicalIdentity(info: BigIntStats): PhysicalIdentity {
  return { device: info.dev.toString(), inode: info.ino.toString() };
}

function samePhysicalIdentity(info: BigIntStats, identity: PhysicalIdentity): boolean {
  return info.dev.toString() === identity.device && info.ino.toString() === identity.inode;
}

function currentUid(): bigint {
  if (typeof process.getuid !== "function") {
    throw new Error("remote credential delivery requires a POSIX uid");
  }
  return BigInt(process.getuid());
}

function requireNoFollowFlag(): number {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw new Error("remote credential delivery requires O_NOFOLLOW");
  }
  return constants.O_NOFOLLOW;
}

function credentialPathComponents(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  if (isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\")) return null;
  const components = value.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) return null;
  return components;
}

function isSafeCredentialRelativePath(value: unknown): value is string {
  return credentialPathComponents(value) !== null;
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function keysExactly(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function decimalIdentity(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function isSafeBeeName(bee: string): boolean {
  return bee.length > 0 && bee.length <= 255 && bee !== "." && bee !== ".." && !bee.includes("/") && !bee.includes("\\") && !bee.includes("\0");
}

async function canonicalOwnedHome(homeDir: string): Promise<OwnedHomeIdentity> {
  if (typeof homeDir !== "string" || homeDir.length === 0 || homeDir.includes("\0")) {
    throw new Error("invalid remote credential home");
  }
  const requested = resolve(homeDir);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const requestedInfo = await lstat(requested, { bigint: true });
  // A final symlink makes the caller-selected home mutable after validation.
  if (requestedInfo.isSymbolicLink()) throw new Error("invalid remote credential home");
  const canonicalPath = await realpath(requested);
  const info = await lstat(canonicalPath, { bigint: true });
  const uid = currentUid();
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (Number(info.mode) & 0o077) !== 0) {
    throw new Error("invalid remote credential home");
  }
  return { canonicalPath, uid: uid.toString(), ...physicalIdentity(info) };
}

function targetFor(home: OwnedHomeIdentity, homeRelPath: string): string {
  const components = credentialPathComponents(homeRelPath);
  if (!components) throw new Error("invalid remote credential target");
  return join(home.canonicalPath, ...components);
}

async function lstatOrAbsent(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function ensureOwnedParentDirectories(
  home: OwnedHomeIdentity,
  homeRelPath: string,
): Promise<DeliveredCredentialTarget["parentDirectories"]> {
  const components = credentialPathComponents(homeRelPath);
  if (!components) throw new Error("invalid remote credential target");
  const parents: DeliveredCredentialTarget["parentDirectories"] = [];
  let current = home.canonicalPath;
  for (let index = 0; index < components.length - 1; index += 1) {
    current = join(current, components[index]!);
    let info = await lstatOrAbsent(current);
    if (!info) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw error;
      }
      info = await lstat(current, { bigint: true });
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== currentUid() ||
      (Number(info.mode) & 0o077) !== 0 ||
      (await realpath(current)) !== current
    ) {
      throw new Error("remote credential parent directory is unsafe");
    }
    parents.push({
      homeRelPath: components.slice(0, index + 1).join("/"),
      ...physicalIdentity(info),
    });
  }
  return parents;
}

async function verifyParentDirectories(
  home: OwnedHomeIdentity,
  file: DeliveredCredentialTarget,
  options?: DeliveredCredentialEraseOptions,
): Promise<boolean> {
  for (const parent of file.parentDirectories) {
    const path = targetFor(home, parent.homeRelPath);
    try {
      if (options) await callBefore(options, "target-parent-lstat");
      const info = await lstat(path, { bigint: true });
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== currentUid() ||
        (Number(info.mode) & 0o077) !== 0 ||
        !samePhysicalIdentity(info, parent)
      ) {
        return false;
      }
      if (options) await callBefore(options, "target-parent-realpath");
      if ((await realpath(path)) !== path) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function prepareDeliveredCredentials(homeDir: string, creds: DeliveredCredentials): Promise<{
  paths: DeliveredCredentialPaths;
  prepared: PreparedCredential[];
}> {
  const home = await canonicalOwnedHome(homeDir);
  const files = creds.files ?? [];
  const seen = new Set<string>();
  const decoded = files.map((file) => {
    if (!isSafeCredentialRelativePath(file.homeRelPath) || seen.has(file.homeRelPath)) {
      throw new Error("invalid remote credential target");
    }
    seen.add(file.homeRelPath);
    if (!isStrictBase64(file.contentB64) || (file.mode ?? 0o600) !== 0o600) {
      throw new Error("invalid remote credential payload");
    }
    return { file, content: Buffer.from(file.contentB64, "base64") };
  });

  const prepared: PreparedCredential[] = [];
  try {
    for (const { file, content } of decoded) {
      const parentDirectories = await ensureOwnedParentDirectories(home, file.homeRelPath);
      const target = targetFor(home, file.homeRelPath);
      if ((await lstatOrAbsent(target)) !== null) throw new Error("remote credential target already exists");
      const handle = await open(
        target,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | requireNoFollowFlag(),
        0o600,
      );
      let createdIdentity: PhysicalIdentity | undefined;
      try {
        const info = await handle.stat({ bigint: true });
        createdIdentity = physicalIdentity(info);
        const canonicalTarget = await realpath(target);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.uid !== currentUid() ||
          info.nlink !== 1n ||
          canonicalTarget !== target
        ) {
          throw new Error("remote credential target identity is unsafe");
        }
        prepared.push({
          handle,
          home,
          target,
          content,
          identity: { homeRelPath: file.homeRelPath, parentDirectories, linkCount: "1", ...physicalIdentity(info) },
        });
      } catch (error) {
        await handle.close().catch(() => undefined);
        const named = await lstatOrAbsent(target).catch(() => null);
        if (createdIdentity && named && named.isFile() && named.nlink === 1n && samePhysicalIdentity(named, createdIdentity)) {
          await unlink(target).catch(() => undefined);
        }
        throw error;
      }
    }
  } catch (error) {
    for (const item of prepared) {
      await item.handle.close().catch(() => undefined);
      const info = await lstatOrAbsent(item.target).catch(() => null);
      if (info && samePhysicalIdentity(info, item.identity) && info.nlink === 1n) {
        await unlink(item.target).catch(() => undefined);
      }
    }
    throw error;
  }

  const paths = prepared.map((item) => item.target) as DeliveredCredentialPaths;
  Object.defineProperty(paths, locatorDraftSymbol, {
    value: {
      version: DELIVERED_CREDS_LOCATOR_VERSION,
      generation: randomBytes(32).toString("hex"),
      home,
      files: prepared.map((item) => item.identity),
    } satisfies LocatorDraft,
  });
  return { paths, prepared };
}

async function writePreparedCredentials(prepared: PreparedCredential[]): Promise<void> {
  try {
    for (const item of prepared) {
      if (!(await verifyParentDirectories(item.home, item.identity))) {
        throw new Error("remote credential parent identity changed");
      }
      await item.handle.writeFile(item.content);
      await item.handle.chmod(0o600);
      await item.handle.sync();
      const info = await item.handle.stat({ bigint: true });
      if (
        !samePhysicalIdentity(info, item.identity) ||
        !info.isFile() ||
        info.nlink !== 1n ||
        info.size !== BigInt(item.content.length)
      ) {
        throw new Error("remote credential write identity changed");
      }
    }
  } finally {
    for (const item of prepared) await item.handle.close().catch(() => undefined);
  }
}

/**
 * Compatibility delivery primitive. It safely creates contained credential
 * targets but cannot make the subsequent locator write crash-atomic; new call
 * sites must use deliverAndRecordCredentials below.
 */
export async function writeDeliveredCredentials(homeDir: string, creds: DeliveredCredentials): Promise<string[]> {
  const { paths, prepared } = await prepareDeliveredCredentials(homeDir, creds);
  try {
    await writePreparedCredentials(prepared);
    return paths;
  } catch (error) {
    // Legacy callers have not recorded a locator yet. Remove only the exact
    // single-link inodes this invocation created; never follow a replacement.
    for (const item of prepared) {
      const info = await lstatOrAbsent(item.target).catch(() => null);
      if (info && samePhysicalIdentity(info, item.identity) && info.isFile() && info.nlink === 1n) {
        await unlink(item.target).catch(() => undefined);
      }
    }
    throw error;
  }
}

function deliveredCredsPath(bee: string): string {
  return join(hsrRunDir(bee), "delivered-creds.json");
}

async function syncDirectory(path: string): Promise<void> {
  const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  const handle = await open(path, constants.O_RDONLY | directoryFlag | requireNoFollowFlag());
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Create the immutable locator without replacing an older delivery. The file
 * and its directory entry are durable before secret bytes are written.
 */
async function writeDurableExclusiveLocator(path: string, data: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollowFlag(),
      0o600,
    );
  } catch {
    throw new Error("delivered credential locator already exists or is unsafe");
  }
  let identity: PhysicalIdentity | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    identity = physicalIdentity(opened);
    if (!opened.isFile() || opened.uid !== currentUid() || opened.nlink !== 1n) {
      throw new Error("delivered credential locator is unsafe");
    }
    await handle.writeFile(data, { encoding: "utf8" });
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (
      !samePhysicalIdentity(written, identity) ||
      !written.isFile() ||
      written.uid !== currentUid() ||
      written.nlink !== 1n ||
      written.size !== BigInt(Buffer.byteLength(data))
    ) {
      throw new Error("delivered credential locator write is unsafe");
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle.close().catch(() => undefined);
    const named = await lstatOrAbsent(path).catch(() => null);
    if (identity && named && named.isFile() && named.nlink === 1n && samePhysicalIdentity(named, identity)) {
      await unlink(path).catch(() => undefined);
      await syncDirectory(dirname(path)).catch(() => undefined);
    }
    throw error;
  }
  await handle.close().catch(() => undefined);
}

/** Record the strict locator carried by paths returned from this module. */
export async function recordDeliveredCredentials(bee: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  if (!isSafeBeeName(bee)) throw new Error("invalid delivered credential owner");
  const draft = (paths as DeliveredCredentialPaths)[locatorDraftSymbol];
  if (!draft) throw new Error("delivered credential paths have no trusted locator identity");
  await mkdir(hsrRunDir(bee), { recursive: true, mode: 0o700 });
  await writeDurableExclusiveLocator(
    deliveredCredsPath(bee),
    `${JSON.stringify({ ...draft, bee } satisfies DeliveredCredentialsLocator, null, 2)}\n`,
  );
}

/**
 * Crash-safe delivery: persist inode identities while targets are still empty,
 * then write secret bytes through the already-open no-follow descriptors.
 */
export async function deliverAndRecordCredentials(
  bee: string,
  homeDir: string,
  creds: DeliveredCredentials,
): Promise<string[]> {
  const { paths, prepared } = await prepareDeliveredCredentials(homeDir, creds);
  try {
    await recordDeliveredCredentials(bee, paths);
  } catch (error) {
    for (const item of prepared) {
      await item.handle.close().catch(() => undefined);
      const info = await lstatOrAbsent(item.target).catch(() => null);
      if (info && samePhysicalIdentity(info, item.identity) && info.isFile() && info.nlink === 1n) {
        await unlink(item.target).catch(() => undefined);
      }
    }
    throw error;
  }
  await writePreparedCredentials(prepared);
  return paths;
}

type LoadedLocator = {
  locator: ParsedDeliveredCredentialsLocator;
  locatorIdentity: PhysicalIdentity;
  locatorGeneration: string;
};

function parseLocator(raw: string, bee: string): ParsedDeliveredCredentialsLocator | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const isLegacy = root.version === LEGACY_DELIVERED_CREDS_LOCATOR_VERSION;
  if (isLegacy) {
    if (!keysExactly(root, ["version", "bee", "home", "files"])) return null;
  } else {
    if (!keysExactly(root, ["version", "generation", "bee", "home", "files"])) return null;
    if (root.version !== DELIVERED_CREDS_LOCATOR_VERSION || typeof root.generation !== "string" || !/^[a-f0-9]{64}$/.test(root.generation)) {
      return null;
    }
  }
  if (root.bee !== bee) return null;
  if (!root.home || typeof root.home !== "object" || Array.isArray(root.home)) return null;
  const home = root.home as Record<string, unknown>;
  if (!keysExactly(home, ["canonicalPath", "device", "inode", "uid"])) return null;
  if (
    typeof home.canonicalPath !== "string" ||
    home.canonicalPath.length === 0 ||
    home.canonicalPath.includes("\0") ||
    !isAbsolute(home.canonicalPath) ||
    resolve(home.canonicalPath) !== home.canonicalPath ||
    !decimalIdentity(home.device) ||
    !decimalIdentity(home.inode) ||
    !decimalIdentity(home.uid)
  ) {
    return null;
  }
  if (!Array.isArray(root.files) || root.files.length === 0) return null;
  const seen = new Set<string>();
  const files: DeliveredCredentialTarget[] = [];
  for (const value of root.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const file = value as Record<string, unknown>;
    if (!keysExactly(file, ["homeRelPath", "parentDirectories", "device", "inode", "linkCount"])) return null;
    if (typeof file.homeRelPath !== "string") return null;
    const homeRelPath = file.homeRelPath;
    const components = credentialPathComponents(homeRelPath);
    if (
      !components ||
      seen.has(homeRelPath) ||
      !decimalIdentity(file.device) ||
      !decimalIdentity(file.inode) ||
      file.linkCount !== "1" ||
      !Array.isArray(file.parentDirectories) ||
      file.parentDirectories.length !== components.length - 1
    ) {
      return null;
    }
    const parentDirectories: DeliveredCredentialTarget["parentDirectories"] = [];
    for (let index = 0; index < file.parentDirectories.length; index += 1) {
      const value = file.parentDirectories[index];
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const parent = value as Record<string, unknown>;
      if (!keysExactly(parent, ["homeRelPath", "device", "inode"])) return null;
      if (
        typeof parent.homeRelPath !== "string" ||
        parent.homeRelPath !== components.slice(0, index + 1).join("/") ||
        !decimalIdentity(parent.device) ||
        !decimalIdentity(parent.inode)
      ) {
        return null;
      }
      parentDirectories.push(parent as PhysicalIdentity & { homeRelPath: string });
    }
    seen.add(homeRelPath);
    files.push({
      homeRelPath,
      device: file.device,
      inode: file.inode,
      linkCount: "1",
      parentDirectories,
    });
  }
  return isLegacy
    ? {
        version: LEGACY_DELIVERED_CREDS_LOCATOR_VERSION,
        bee,
        home: home as OwnedHomeIdentity,
        files,
      }
    : {
        version: DELIVERED_CREDS_LOCATOR_VERSION,
        generation: root.generation as string,
        bee,
        home: home as OwnedHomeIdentity,
        files,
      };
}

async function callBefore(options: DeliveredCredentialEraseOptions, operation: DeliveredCredentialEraseOperation): Promise<void> {
  await options.beforeOperation?.(operation);
}

async function loadLocator(bee: string, options: DeliveredCredentialEraseOptions): Promise<LoadedLocator | null> {
  if (!isSafeBeeName(bee)) throw new DeliveredCredentialsLocatorError("locator-invalid");
  let handle: FileHandle;
  try {
    await callBefore(options, "locator-open");
    handle = await open(deliveredCredsPath(bee), constants.O_RDONLY | requireNoFollowFlag());
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new DeliveredCredentialsLocatorError("locator-unreadable");
  }
  try {
    await callBefore(options, "locator-stat");
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== currentUid() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(MAX_LOCATOR_BYTES)
    ) {
      throw new DeliveredCredentialsLocatorError("locator-invalid");
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat({ bigint: true });
    if (!samePhysicalIdentity(after, physicalIdentity(before)) || after.size !== before.size) {
      throw new DeliveredCredentialsLocatorError("locator-invalid");
    }
    const locator = parseLocator(raw, bee);
    if (!locator) throw new DeliveredCredentialsLocatorError("locator-invalid");
    const locatorGeneration =
      locator.version === DELIVERED_CREDS_LOCATOR_VERSION
        ? locator.generation
        : createHash("sha256").update(raw, "utf8").digest("hex");
    return { locator, locatorIdentity: physicalIdentity(before), locatorGeneration };
  } catch (error) {
    if (error instanceof DeliveredCredentialsLocatorError) throw error;
    throw new DeliveredCredentialsLocatorError("locator-unreadable");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Read only a strictly valid v1/v2 locator. Missing is empty; bad state throws. */
export async function readDeliveredCredentials(bee: string): Promise<string[]> {
  const loaded = await loadLocator(bee, {});
  return loaded ? loaded.locator.files.map((file) => targetFor(loaded.locator.home, file.homeRelPath)) : [];
}

function eraseFailure(code: DeliveredCredentialEraseFailureCode): DeliveredCredentialEraseResult {
  return { ok: false, status: "incomplete", code, retryable: true };
}

async function verifyOwnedHome(
  home: OwnedHomeIdentity,
  options: DeliveredCredentialEraseOptions,
): Promise<boolean> {
  try {
    await callBefore(options, "home-realpath");
    if ((await realpath(home.canonicalPath)) !== home.canonicalPath) return false;
    await callBefore(options, "home-lstat");
    const info = await lstat(home.canonicalPath, { bigint: true });
    return (
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === currentUid() &&
      info.uid.toString() === home.uid &&
      (Number(info.mode) & 0o077) === 0 &&
      samePhysicalIdentity(info, home)
    );
  } catch {
    return false;
  }
}

function zeroedTargetIdentity(info: BigIntStats): ZeroedTargetIdentity {
  return {
    ...physicalIdentity(info),
    size: info.size.toString(),
    ctimeNs: info.ctimeNs.toString(),
    mtimeNs: info.mtimeNs.toString(),
    birthtimeNs: info.birthtimeNs.toString(),
  };
}

function sameZeroedTargetIdentity(info: BigIntStats, identity: ZeroedTargetIdentity): boolean {
  return (
    samePhysicalIdentity(info, identity) &&
    info.size.toString() === identity.size &&
    info.ctimeNs.toString() === identity.ctimeNs &&
    info.mtimeNs.toString() === identity.mtimeNs &&
    info.birthtimeNs.toString() === identity.birthtimeNs
  );
}

function zeroReceiptDirectory(bee: string): string {
  return join(hsrRunDir(bee), "delivered-creds-erasure");
}

function zeroReceiptPath(loaded: LoadedLocator, fileIndex: number): string {
  return join(zeroReceiptDirectory(loaded.locator.bee), `${loaded.locatorGeneration}.${fileIndex}.zeroed.json`);
}

async function verifyZeroReceiptDirectory(bee: string, create: boolean): Promise<string | null> {
  const path = zeroReceiptDirectory(bee);
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
  const info = await lstatOrAbsent(path);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid() || (Number(info.mode) & 0o077) !== 0) {
    throw new Error("delivered credential erase state directory is unsafe");
  }
  return path;
}

function expectedZeroReceipt(
  loaded: LoadedLocator,
  fileIndex: number,
  zeroed: ZeroedTargetIdentity,
): ZeroedCredentialReceipt {
  const file = loaded.locator.files[fileIndex]!;
  return {
    version: ZEROED_RECEIPT_VERSION,
    bee: loaded.locator.bee,
    locatorGeneration: loaded.locatorGeneration,
    fileIndex,
    homeRelPath: file.homeRelPath,
    zeroed,
  };
}

function parseZeroReceipt(raw: string): ZeroedCredentialReceipt | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  if (!keysExactly(root, ["version", "bee", "locatorGeneration", "fileIndex", "homeRelPath", "zeroed"])) return null;
  if (
    root.version !== ZEROED_RECEIPT_VERSION ||
    typeof root.bee !== "string" ||
    typeof root.locatorGeneration !== "string" ||
    !/^[a-f0-9]{64}$/.test(root.locatorGeneration) ||
    typeof root.fileIndex !== "number" ||
    !Number.isSafeInteger(root.fileIndex) ||
    root.fileIndex < 0 ||
    typeof root.homeRelPath !== "string" ||
    !isSafeCredentialRelativePath(root.homeRelPath) ||
    !root.zeroed ||
    typeof root.zeroed !== "object" ||
    Array.isArray(root.zeroed)
  ) {
    return null;
  }
  const zeroed = root.zeroed as Record<string, unknown>;
  if (!keysExactly(zeroed, ["device", "inode", "size", "ctimeNs", "mtimeNs", "birthtimeNs"])) return null;
  if (![zeroed.device, zeroed.inode, zeroed.size, zeroed.ctimeNs, zeroed.mtimeNs, zeroed.birthtimeNs].every(decimalIdentity)) {
    return null;
  }
  return {
    version: ZEROED_RECEIPT_VERSION,
    bee: root.bee,
    locatorGeneration: root.locatorGeneration,
    fileIndex: root.fileIndex,
    homeRelPath: root.homeRelPath,
    zeroed: zeroed as ZeroedTargetIdentity,
  };
}

function sameZeroReceipt(actual: ZeroedCredentialReceipt, expected: ZeroedCredentialReceipt): boolean {
  return (
    actual.version === expected.version &&
    actual.bee === expected.bee &&
    actual.locatorGeneration === expected.locatorGeneration &&
    actual.fileIndex === expected.fileIndex &&
    actual.homeRelPath === expected.homeRelPath &&
    actual.zeroed.device === expected.zeroed.device &&
    actual.zeroed.inode === expected.zeroed.inode &&
    actual.zeroed.size === expected.zeroed.size &&
    actual.zeroed.ctimeNs === expected.zeroed.ctimeNs &&
    actual.zeroed.mtimeNs === expected.zeroed.mtimeNs &&
    actual.zeroed.birthtimeNs === expected.zeroed.birthtimeNs
  );
}

async function loadZeroReceipt(
  loaded: LoadedLocator,
  fileIndex: number,
  options: DeliveredCredentialEraseOptions,
): Promise<ZeroedCredentialReceipt | null> {
  const directory = await verifyZeroReceiptDirectory(loaded.locator.bee, false);
  if (!directory) return null;
  let handle: FileHandle;
  try {
    await callBefore(options, "receipt-open");
    handle = await open(zeroReceiptPath(loaded, fileIndex), constants.O_RDONLY | requireNoFollowFlag());
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new Error("delivered credential erase receipt is unreadable");
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== currentUid() ||
      before.nlink < 1n ||
      before.size <= 0n ||
      before.size > BigInt(MAX_RECEIPT_BYTES)
    ) {
      throw new Error("delivered credential erase receipt is invalid");
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat({ bigint: true });
    if (!samePhysicalIdentity(after, physicalIdentity(before)) || after.size !== before.size) {
      throw new Error("delivered credential erase receipt changed");
    }
    const receipt = parseZeroReceipt(raw);
    if (!receipt) throw new Error("delivered credential erase receipt is invalid");
    const file = loaded.locator.files[fileIndex];
    if (
      !file ||
      receipt.bee !== loaded.locator.bee ||
      receipt.locatorGeneration !== loaded.locatorGeneration ||
      receipt.fileIndex !== fileIndex ||
      receipt.homeRelPath !== file.homeRelPath ||
      receipt.zeroed.device !== file.device ||
      receipt.zeroed.inode !== file.inode
    ) {
      throw new Error("delivered credential erase receipt does not match locator");
    }
    await callBefore(options, "receipt-directory-sync");
    await syncDirectory(directory);
    return receipt;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Commit a fully-written receipt by hard-linking it into its final name. */
async function persistZeroReceipt(
  loaded: LoadedLocator,
  fileIndex: number,
  receipt: ZeroedCredentialReceipt,
  options: DeliveredCredentialEraseOptions,
): Promise<void> {
  const directory = await verifyZeroReceiptDirectory(loaded.locator.bee, true);
  if (!directory) throw new Error("delivered credential erase state directory is absent");
  const finalPath = zeroReceiptPath(loaded, fileIndex);
  const stagedPath = join(directory, `.${loaded.locatorGeneration}.${fileIndex}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
  const raw = `${JSON.stringify(receipt, null, 2)}\n`;
  const handle = await open(
    stagedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollowFlag(),
    0o600,
  );
  try {
    await handle.writeFile(raw, { encoding: "utf8" });
    await handle.sync();
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.uid !== currentUid() || info.nlink !== 1n || info.size !== BigInt(Buffer.byteLength(raw))) {
      throw new Error("delivered credential erase receipt staging is unsafe");
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(stagedPath).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await callBefore(options, "receipt-commit");
    await verifyZeroReceiptDirectory(loaded.locator.bee, false);
    try {
      await link(stagedPath, finalPath);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      const existing = await loadZeroReceipt(loaded, fileIndex, options);
      if (!existing || !sameZeroReceipt(existing, receipt)) {
        throw new Error("delivered credential erase receipt conflicts with existing state");
      }
      return;
    }
    await callBefore(options, "receipt-directory-sync");
    await syncDirectory(directory);
  } finally {
    await unlink(stagedPath).catch(() => undefined);
    await syncDirectory(directory).catch(() => undefined);
  }
}

async function verifyZeroBytes(
  handle: FileHandle,
  size: number,
  options: DeliveredCredentialEraseOptions,
): Promise<boolean> {
  const verify = Buffer.alloc(Math.min(ZERO_CHUNK_BYTES, Math.max(1, size)));
  let position = 0;
  while (position < size) {
    const length = Math.min(verify.length, size - position);
    await callBefore(options, "target-verify-read");
    const { bytesRead } = await handle.read(verify, 0, length, position);
    if (bytesRead !== length) return false;
    for (let index = 0; index < bytesRead; index += 1) {
      if (verify[index] !== 0) return false;
    }
    position += bytesRead;
  }
  return true;
}

async function zeroCredentialTarget(
  loaded: LoadedLocator,
  fileIndex: number,
  options: DeliveredCredentialEraseOptions,
): Promise<{ ok: true; receipt: ZeroedCredentialReceipt } | { ok: false; code: DeliveredCredentialEraseFailureCode }> {
  const home = loaded.locator.home;
  const targetIdentity = loaded.locator.files[fileIndex]!;
  const target = targetFor(home, targetIdentity.homeRelPath);
  if (!(await verifyOwnedHome(home, options))) return { ok: false, code: "home-unverified" };
  if (!(await verifyParentDirectories(home, targetIdentity, options))) {
    return { ok: false, code: "target-unverified" };
  }
  let initial: BigIntStats | null;
  try {
    await callBefore(options, "target-lstat");
    initial = await lstatOrAbsent(target);
  } catch {
    return { ok: false, code: "target-unverified" };
  }
  // An active locator is the sole durable evidence that this inode may still
  // contain a secret. Absence without a committed zero receipt is uncertainty,
  // never success (including a root-level home rename + empty replacement).
  if (!initial) return { ok: false, code: "target-unverified" };
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.uid !== currentUid() ||
    initial.nlink !== 1n ||
    !samePhysicalIdentity(initial, targetIdentity)
  ) {
    return { ok: false, code: "target-unverified" };
  }
  try {
    await callBefore(options, "target-realpath");
    if ((await realpath(target)) !== target) return { ok: false, code: "target-unverified" };
  } catch {
    return { ok: false, code: "target-unverified" };
  }

  let handle: FileHandle;
  try {
    await callBefore(options, "target-open");
    handle = await open(target, constants.O_RDWR | requireNoFollowFlag());
  } catch {
    return { ok: false, code: "target-unverified" };
  }
  try {
    await callBefore(options, "target-fstat");
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.uid !== currentUid() ||
      opened.nlink !== 1n ||
      !samePhysicalIdentity(opened, targetIdentity) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return { ok: false, code: "target-unverified" };
    }
    if (!(await verifyOwnedHome(home, {}))) return { ok: false, code: "home-unverified" };
    if (!(await verifyParentDirectories(home, targetIdentity, options))) {
      return { ok: false, code: "target-unverified" };
    }
    // Re-resolve the pathname after opening. It must still name the fd's inode
    // beneath the canonical home immediately before destructive I/O.
    await callBefore(options, "target-realpath");
    if ((await realpath(target)) !== target) return { ok: false, code: "target-unverified" };
    await callBefore(options, "target-pre-unlink-lstat");
    const named = await lstat(target, { bigint: true });
    if (!samePhysicalIdentity(named, targetIdentity) || named.nlink !== 1n || !named.isFile() || named.isSymbolicLink()) {
      return { ok: false, code: "target-unverified" };
    }

    const size = Number(opened.size);
    const zeroes = Buffer.alloc(Math.min(ZERO_CHUNK_BYTES, Math.max(1, size)), 0);
    let position = 0;
    while (position < size) {
      const length = Math.min(zeroes.length, size - position);
      await callBefore(options, "target-write");
      const { bytesWritten } = await handle.write(zeroes, 0, length, position);
      if (bytesWritten <= 0) return { ok: false, code: "overwrite-failed" };
      position += bytesWritten;
    }
    await callBefore(options, "target-sync");
    await handle.sync();
    if (!(await verifyZeroBytes(handle, size, options))) return { ok: false, code: "overwrite-failed" };
    const after = await handle.stat({ bigint: true });
    if (!samePhysicalIdentity(after, targetIdentity) || after.nlink !== 1n || after.size !== opened.size) {
      return { ok: false, code: "overwrite-failed" };
    }
    const receipt = expectedZeroReceipt(loaded, fileIndex, zeroedTargetIdentity(after));
    try {
      await persistZeroReceipt(loaded, fileIndex, receipt, options);
    } catch {
      return { ok: false, code: "erase-state-persist-failed" };
    }
    return { ok: true, receipt };
  } catch {
    return { ok: false, code: "overwrite-failed" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function unlinkZeroedTarget(
  loaded: LoadedLocator,
  fileIndex: number,
  receipt: ZeroedCredentialReceipt,
  options: DeliveredCredentialEraseOptions,
): Promise<{ ok: true; erased: boolean } | { ok: false; code: DeliveredCredentialEraseFailureCode }> {
  const home = loaded.locator.home;
  const targetIdentity = loaded.locator.files[fileIndex]!;
  const target = targetFor(home, targetIdentity.homeRelPath);
  let initial: BigIntStats | null;
  try {
    await callBefore(options, "target-lstat");
    initial = await lstatOrAbsent(target);
  } catch {
    return { ok: false, code: "target-unverified" };
  }
  // Receipt-backed absence is safe: the exact delivered inode was verified
  // zero and fsynced before the durable receipt became visible.
  if (!initial) return { ok: true, erased: false };
  if (!(await verifyOwnedHome(home, options))) return { ok: false, code: "home-unverified" };
  if (!(await verifyParentDirectories(home, targetIdentity, options))) return { ok: false, code: "target-unverified" };
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.uid !== currentUid() ||
    initial.nlink !== 1n ||
    !sameZeroedTargetIdentity(initial, receipt.zeroed)
  ) {
    return { ok: false, code: "target-unverified" };
  }

  let handle: FileHandle;
  try {
    await callBefore(options, "target-open");
    handle = await open(target, constants.O_RDONLY | requireNoFollowFlag());
  } catch {
    return { ok: false, code: "target-unverified" };
  }
  try {
    await callBefore(options, "target-fstat");
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.uid !== currentUid() ||
      opened.nlink !== 1n ||
      !sameZeroedTargetIdentity(opened, receipt.zeroed) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      !(await verifyZeroBytes(handle, Number(opened.size), options))
    ) {
      return { ok: false, code: "target-unverified" };
    }
  } catch {
    return { ok: false, code: "target-unverified" };
  } finally {
    await handle.close().catch(() => undefined);
  }

  const expectedParent = targetIdentity.parentDirectories.at(-1) ?? home;
  let parentHandle: FileHandle;
  try {
    const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
    parentHandle = await open(dirname(target), constants.O_RDONLY | directoryFlag | requireNoFollowFlag());
    const openedParent = await parentHandle.stat({ bigint: true });
    if (!openedParent.isDirectory() || openedParent.uid !== currentUid() || !samePhysicalIdentity(openedParent, expectedParent)) {
      await parentHandle.close().catch(() => undefined);
      return { ok: false, code: "target-unverified" };
    }
  } catch {
    return { ok: false, code: "target-unverified" };
  }

  try {
    // Run the deterministic race hook before the final identity checks. A home
    // rename or replacement performed here is detected before unlink.
    await callBefore(options, "target-unlink");
  } catch {
    await parentHandle.close().catch(() => undefined);
    return { ok: false, code: "unlink-failed" };
  }
  try {
    if (!(await verifyOwnedHome(home, {}))) return { ok: false, code: "home-unverified" };
    if (!(await verifyParentDirectories(home, targetIdentity))) return { ok: false, code: "target-unverified" };
    await callBefore(options, "target-pre-unlink-lstat");
    const beforeUnlink = await lstat(target, { bigint: true });
    if (
      !beforeUnlink.isFile() ||
      beforeUnlink.isSymbolicLink() ||
      beforeUnlink.uid !== currentUid() ||
      beforeUnlink.nlink !== 1n ||
      !sameZeroedTargetIdentity(beforeUnlink, receipt.zeroed)
    ) {
      return { ok: false, code: "target-unverified" };
    }
    await unlink(target);
    await parentHandle.sync();
  } catch {
    return { ok: false, code: "unlink-failed" };
  } finally {
    await parentHandle.close().catch(() => undefined);
  }
  try {
    await callBefore(options, "target-absence");
    if ((await lstatOrAbsent(target)) !== null) return { ok: false, code: "absence-unverified" };
  } catch {
    return { ok: false, code: "absence-unverified" };
  }
  return { ok: true, erased: true };
}

async function overwriteAndUnlink(
  loaded: LoadedLocator,
  fileIndex: number,
  options: DeliveredCredentialEraseOptions,
): Promise<{ ok: true; erased: boolean } | { ok: false; code: DeliveredCredentialEraseFailureCode }> {
  let receipt: ZeroedCredentialReceipt | null;
  try {
    receipt = await loadZeroReceipt(loaded, fileIndex, options);
  } catch {
    return { ok: false, code: "erase-state-invalid" };
  }
  if (!receipt) {
    const zeroed = await zeroCredentialTarget(loaded, fileIndex, options);
    if (!zeroed.ok) return zeroed;
    receipt = zeroed.receipt;
  }
  return unlinkZeroedTarget(loaded, fileIndex, receipt, options);
}

async function shredDeliveredCredentialsTransaction(
  bee: string,
  options: DeliveredCredentialEraseOptions,
): Promise<DeliveredCredentialEraseResult> {
  let loaded: LoadedLocator | null;
  try {
    loaded = await loadLocator(bee, options);
  } catch (error) {
    if (error instanceof DeliveredCredentialsLocatorError) return eraseFailure(error.code);
    return eraseFailure("locator-unreadable");
  }
  if (!loaded) return { ok: true, status: "already-absent", erasedFiles: 0 };

  let erasedFiles = 0;
  for (let fileIndex = 0; fileIndex < loaded.locator.files.length; fileIndex += 1) {
    const result = await overwriteAndUnlink(loaded, fileIndex, options);
    if (!result.ok) return eraseFailure(result.code);
    if (result.erased) erasedFiles += 1;
  }

  const locatorPath = deliveredCredsPath(bee);
  try {
    await callBefore(options, "locator-pre-unlink-lstat");
    const beforeUnlink = await lstat(locatorPath, { bigint: true });
    if (
      !beforeUnlink.isFile() ||
      beforeUnlink.isSymbolicLink() ||
      beforeUnlink.nlink !== 1n ||
      !samePhysicalIdentity(beforeUnlink, loaded.locatorIdentity)
    ) {
      return eraseFailure("locator-remove-failed");
    }
    await callBefore(options, "locator-unlink");
    const afterHook = await lstat(locatorPath, { bigint: true });
    if (
      !afterHook.isFile() ||
      afterHook.isSymbolicLink() ||
      afterHook.nlink !== 1n ||
      !samePhysicalIdentity(afterHook, loaded.locatorIdentity)
    ) {
      return eraseFailure("locator-remove-failed");
    }
    await unlink(locatorPath);
    await syncDirectory(dirname(locatorPath));
    await callBefore(options, "locator-absence");
    if ((await lstatOrAbsent(locatorPath)) !== null) return eraseFailure("locator-remove-failed");
  } catch {
    return eraseFailure("locator-remove-failed");
  }
  return { ok: true, status: "erased", erasedFiles };
}

// The remote runner-host is a per-node singleton, so same-process serialization
// covers its kill/refresh/close races. Identical callers join one full durable
// transaction instead of independently producing competing zero fingerprints.
// Cross-process mutation remains forbidden by the runner-host singleton
// contract; exclusive locator creation additionally prevents a refresh from
// replacing an active delivery record.
const shredTransactions = new Map<string, Promise<DeliveredCredentialEraseResult>>();

/**
 * Strict, retryable destructive erase. Any malformed/foreign/changed state is
 * a typed non-success and leaves the locator in place for a later restart.
 */
export function shredDeliveredCredentials(
  bee: string,
  options: DeliveredCredentialEraseOptions = {},
): Promise<DeliveredCredentialEraseResult> {
  if (!isSafeBeeName(bee)) return Promise.resolve(eraseFailure("locator-invalid"));
  const key = deliveredCredsPath(bee);
  const existing = shredTransactions.get(key);
  if (existing) return existing;
  const transaction = shredDeliveredCredentialsTransaction(bee, options).finally(() => {
    if (shredTransactions.get(key) === transaction) shredTransactions.delete(key);
  });
  shredTransactions.set(key, transaction);
  return transaction;
}
