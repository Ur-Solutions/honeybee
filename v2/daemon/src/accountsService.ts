/**
 * AccountsService — the daemon's account plane (spec 08 CORE): the calibrated
 * `auto` selection over the store (candidates → ported selector → near-tie
 * rotation through the cursor row → one log line), the bounded in-daemon
 * limits refresh (injected provider transports; claude OAuth usage endpoint,
 * codex app-server), credential validation + capture (home → vault; the
 * login FLOW itself — methods, workers, phases — lives in loginFlows.ts as of
 * the tmux-independent login, 2026-08-28), the empty-home activation hook the
 * driver's spawn resolve calls, and the read-only importer of the OLD
 * ~/.hive/vault registry into rows.
 *
 * Everything that talks to a provider or a keychain is injected; the defaults
 * are the real transports. Tests inject fakes.
 */
import { execFile, spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "../../../src/lock.ts";
import {
  AUTO_PICK_DEBIT_PERCENT,
  accountActiveBees,
  accountCommitments,
  accountIdFor,
  homeEnvFor,
  isAuthFailureLimitsError,
  limitsFromRow,
  measureWindowVelocity,
  parseClaudeCredentials,
  parseClaudeUsage,
  parseCodexRateLimits,
  pendingPickDebit,
  prunePendingPicks,
  recipeEnvFor,
  recipeFor,
  resolveVendorHome,
  rotateNearTie,
  selectLeastLoadedAccount,
  windowRolledOver,
  isFableModel,
  type AccountLimits,
  type AccountLimitsRow,
  type AccountLimitsUnreadableReason,
  type AccountRow,
  type AccountStatus,
  type AutoAccountCandidate,
  type ClaudeUsageResponse,
  type CodexLiveRateLimits,
  type CoreStore,
  type CredentialHealth,
  type MirrorAccountRow,
  type PendingPick,
  type PutAccountLimitsInput,
  type WindowUsage,
  type WindowVelocities,
} from "../../core/src/index.ts";
import {
  activateHomeIfEmpty,
  captureHomeToVault,
  defaultHomeFor,
  dirHasCredentials,
  primaryCredentialFile,
  seedClaudeKeychainFromVault,
  vaultDirFor,
  type ActivationResult,
} from "./activation.ts";
import type { ResolvedNodeConfig } from "./config.ts";
import { readClaudeKeychain, writeClaudeKeychainEntry, type KeychainReader, type KeychainWriter } from "./keychain.ts";
import { atomicWriteFileSync } from "./homeDefaults.ts";
import {
  defaultProviderLimitsHttp,
  fetchSecondaryProviderLimits,
  type ProviderLimitsHttp,
} from "./providerLimits.ts";
import {
  cursorCredentialEnv,
  parseCursorAuth,
  readCursorLiveAuth,
  type CursorAuthReader,
} from "./cursorAuth.ts";
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_TOKEN_URL } from "./login/transports.ts";

// ---------------------------------------------------------------------------
// injected transports
// ---------------------------------------------------------------------------

export interface LimitsFetchers {
  /** GET api.anthropic.com/api/oauth/usage with a bearer token (default: real fetch). */
  claudeUsage?: (accessToken: string) => Promise<ClaudeUsageResponse>;
  /** Rotate an expired Claude OAuth refresh token (default: real OAuth endpoint). */
  claudeRefresh?: (refreshToken: string) => Promise<RefreshedClaudeToken | null>;
  /** `codex app-server` account/rateLimits/read against a home (default: real child process). */
  codexRateLimits?: (homePath: string) => Promise<CodexRateLimitsFetchResult>;
}

export type CodexRateLimitsFetchResult =
  | { ok: true; limits: CodexLiveRateLimits }
  | { ok: false; unreadableReason: AccountLimitsUnreadableReason; error: string };

export interface RefreshedClaudeToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
}

export interface AccountsServiceOptions {
  store: CoreStore;
  cfg: ResolvedNodeConfig;
  log: (op: string) => void;
  now?: () => number;
  keychainReader?: KeychainReader;
  keychainWriter?: KeychainWriter;
  /** Cursor's machine-global credential store, injected so tests never touch a real login. */
  cursorAuthReader?: CursorAuthReader;
  fetchers?: LimitsFetchers;
  /** Injectable HTTP boundary for Grok, Kimi, Cursor, and OpenCode limits. */
  providerHttp?: Partial<ProviderLimitsHttp>;
  /**
   * v19 (account.lease): injectable stale-codex-token rotation — a no-op codex
   * turn against the account home (CODEX_HOME); codex rotates auth.json in
   * place at turn start when the access token is near expiry. Tests inject a
   * fake so no real codex runs. Default: the real `codex exec` runner.
   */
  codexLeaseRefresh?: (homePath: string) => Promise<void>;
}

type ClaudeCredential = {
  accessToken: string;
  expiresAt: number;
  subscriptionType?: string;
  refreshToken?: string;
  document: Record<string, unknown>;
  oauth: Record<string, unknown>;
};

type ClaudeRefreshOutcome =
  | { kind: "ok"; credential: ClaudeCredential }
  | { kind: "live_runtime" }
  | { kind: "no_refresh_token" }
  | { kind: "refresh_failed" };

// ---------------------------------------------------------------------------
// selection results
// ---------------------------------------------------------------------------

export type PickOutcome =
  | { ok: true; account: AccountRow; reason: string; limitsAgeMs: number | null; stale: boolean; candidates: number }
  | { ok: false; code: "no_accounts" | "all_paused" | "no_credentials" | "no_untried"; message: string };

export interface PickOptions {
  /** Accounts already tried / the current one (rotation). */
  excludeAccountIds?: ReadonlySet<string>;
  /** Effective model for the new bee (Fable-scoped allowance). */
  model?: string;
  /** Rotation: exclude accounts with exhaustion evidence younger than the cool-off. */
  excludeRecentlyExhausted?: boolean;
}

export interface CaptureOutcome {
  account: AccountRow;
  captured: string[];
  source: "external" | "home";
  at: number;
}

/** One location `importExistingCredentials` looked at, and what it found. */
export interface ImportCheck {
  path: string;
  state: "present" | "missing" | "invalid";
}

export type ImportOutcome =
  | { ok: true; source: "home" | "vault" | "vendor_home" | "external"; from: string; files: string[]; checked: ImportCheck[] }
  | { ok: false; checked: ImportCheck[] };

export interface VerifyOutcome {
  account: AccountRow;
  outcome: "verified" | "auth_needed" | "unverified" | "absent";
  probe: "limits" | "credential_file" | "none";
  limits: AccountLimitsRow | null;
}

/** Harnesses with either an authenticated limits read or an explicit credential-file probe. */
const PROBE_CAPABLE_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex", "grok", "kimi", "cursor", "opencode", "agy"]);

// ---------------------------------------------------------------------------
// v19: account.lease — the credential-lease mint (RN7a; a port of v1
// src/hsr/remoteCreds.ts's MINT side per credential-leases.md)
// ---------------------------------------------------------------------------

/** One credential file to write into a satellite's isolated home. */
export interface EphemeralCredentialFile {
  /** Path RELATIVE to the harness home (e.g. "auth.json", ".credentials.json"). */
  homeRelPath: string;
  /** File bytes, base64-encoded. Opaque — NEVER decode into a log/error/audit row. */
  contentB64: string;
  /** POSIX mode for the written file (0600). */
  mode: number;
}

/**
 * The short-lived, refresh-blanked material a satellite receives for ONE
 * account. `files` land in the isolated home; `env` merges into the spawn env;
 * `kindNote` is a secret-free one-liner; `expiresAt` (unix SECONDS) is the
 * NON-SECRET expiry of the shipped material when known, which the RN7b lease
 * service uses to renew before a satellite bee's token dies.
 */
export interface EphemeralCredential {
  files: EphemeralCredentialFile[];
  env?: Record<string, string>;
  kindNote: string;
  expiresAt?: number;
}

/**
 * Typed lease refusal (rpc.ts maps it onto the closed error list):
 *  - `lease_unsupported`: the harness/account SHAPE cannot lease (no strategy,
 *    OAuth-only kimi, no coding-plan opencode provider). Durable until the
 *    account changes.
 *  - `lease_unavailable`: leasable in principle but not RIGHT NOW (no/stale
 *    credential, refresher mid-rotation, refresh failed). Retryable.
 */
export class LeaseRefusal extends Error {
  readonly code: "lease_unsupported" | "lease_unavailable";

  constructor(code: "lease_unsupported" | "lease_unavailable", message: string) {
    super(message);
    this.name = "LeaseRefusal";
    this.code = code;
  }
}

// Never ship a codex access token with less than this TTL remaining: below it
// the token could die on the satellite before the RN7b rotation re-delivers.
export const CODEX_MIN_SHIP_TTL_MS = 15 * 60_000;

// The same floor for claude: a lease under 15 minutes of access-token TTL is
// refreshed through the daemon's own OAuth refresher before shipping, never
// re-shipped dying.
export const CLAUDE_MIN_SHIP_TTL_MS = 15 * 60_000;

// OAuth refresh-token field names blanked before a credential file is shipped:
// codex/grok/kimi use `refresh_token`, opencode's oauth entries use `refresh`,
// claude's .credentials.json uses `refreshToken`. Refresh tokens are
// single-use and rotating — the vault must stay their sole holder, so no two
// fleet bees ever present the same one (and a leaked lease cannot take over
// the account's refresh chain).
const REFRESH_TOKEN_KEYS: ReadonlySet<string> = new Set(["refresh_token", "refresh", "refreshToken"]);

/**
 * Deep-clone a parsed credential JSON with EVERY OAuth refresh-token field
 * blanked to "" (field kept — codex serde hard-fails when it is deleted).
 * Blanks only string values under the exact key names; access tokens, api
 * keys, and expiries are preserved untouched. Opaque — callers never log it.
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

/** JWT `exp` claim (unix SECONDS), decoded not verified (a local freshness fact). */
function expFromJwt(token: string): number | undefined {
  const segment = token.split(".")[1];
  if (!segment) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

/** The opencode coding-plan providers a lease may carry (the same closed list the limits probe reads). */
const OPENCODE_LEASE_PROVIDERS = ["minimax-coding-plan", "zai-coding-plan"] as const;

/**
 * Default stale-codex rotation: a minimal read-only `codex exec` turn against
 * the home, serialized under the SAME per-home boot lock runner-host and the
 * limits probe take, so the rotation never races a booting codex in this home.
 */
function defaultCodexLeaseRefresh(command: string): (homePath: string) => Promise<void> {
  return async (homePath) => {
    try {
      await withFileLock(
        join(homePath, CODEX_BOOT_LOCK_FILENAME),
        async () => {
          // codex refreshes auth.json in place at turn start when the token is
          // near expiry; the output is discarded. cwd is a throwaway temp dir.
          await execFileP(command, ["exec", "--skip-git-repo-check", "-s", "read-only", "ok"], {
            cwd: tmpdir(),
            env: { ...process.env, CODEX_HOME: homePath },
            timeout: 120_000,
            maxBuffer: 1 << 20,
          });
        },
        { timeoutMs: 10_000, staleMs: CODEX_BOOT_LOCK_STALE_MS, pollMs: 25 },
      );
    } catch {
      // Secret-free: never surface codex stderr (could echo token-adjacent bytes).
      throw new LeaseRefusal("lease_unavailable", "could not run codex to rotate the stale access token (is codex installed and this account logged in?)");
    }
  };
}

// ---------------------------------------------------------------------------
// default transports
// ---------------------------------------------------------------------------

async function claudeOauthGet(accessToken: string, url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // Keep the provider's own diagnosis: "HTTP 401" alone cannot distinguish
    // an expired token from a REVOKED chain, and the auth-health mapping keys
    // on that distinction.
    const body = await response.text().catch(() => "");
    const detail = body.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`${new URL(url).pathname}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }
  return response.json();
}

function defaultClaudeUsage(timeoutMs: number): NonNullable<LimitsFetchers["claudeUsage"]> {
  return (accessToken) => claudeOauthGet(accessToken, "https://api.anthropic.com/api/oauth/usage", timeoutMs) as Promise<ClaudeUsageResponse>;
}

function defaultClaudeRefresh(timeoutMs: number): NonNullable<LimitsFetchers["claudeRefresh"]> {
  return async (refreshToken) => {
    const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
      signal: AbortSignal.timeout(timeoutMs),
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
  };
}

const execFileP = promisify(execFile);

const CODEX_BOOT_LOCK_FILENAME = ".hive-app-server-boot.lock";
const CODEX_BOOT_LOCK_STALE_MS = 2 * 60_000;
const CODEX_LIMITS_BOOT_LOCK_MAX_MS = 3_000;

function errorDetail(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;
    if (typeof message === "string") return typeof code === "number" || typeof code === "string" ? `${code}: ${message}` : message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function codexFailure(error: unknown, fallback: AccountLimitsUnreadableReason = "provider_error"): CodexRateLimitsFetchResult {
  const detail = errorDetail(error).replace(/\s+/g, " ").trim().slice(0, 500) || "unknown Codex limits probe failure";
  return {
    ok: false,
    unreadableReason: isAuthFailureLimitsError(detail)
      ? "auth_failed"
      : /timed out|timeout/i.test(detail)
        ? "timeout"
        : fallback,
    error: detail,
  };
}

/**
 * Query `codex app-server` (JSON-RPC over stdio) for the account's live rate
 * limits, with CODEX_HOME pointed at the account's home. The same per-home
 * boot lock used by runner-host serializes this short-lived app-server with
 * real Codex runtimes. Every failure remains typed and the total operation is
 * bounded by `timeoutMs`.
 */
export function defaultCodexRateLimits(timeoutMs: number, command = "codex"): NonNullable<LimitsFetchers["codexRateLimits"]> {
  return async (homePath) => {
    const lockTimeoutMs = Math.min(CODEX_LIMITS_BOOT_LOCK_MAX_MS, Math.max(1, Math.floor(timeoutMs / 5)));
    const settleMarginMs = Math.min(250, Math.max(1, Math.floor(timeoutMs / 20)));
    const rpcTimeoutMs = Math.max(1, timeoutMs - lockTimeoutMs - settleMarginMs);
    return withFileLock(join(homePath, CODEX_BOOT_LOCK_FILENAME), () =>
      new Promise<CodexRateLimitsFetchResult>((resolvePromise) => {
        let child: ReturnType<typeof spawnChild>;
        try {
          child = spawnChild(command, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: homePath } });
        } catch (error) {
          resolvePromise(codexFailure(error));
          return;
        }
        let settled = false;
        let stderr = "";
        const finish = (value: CodexRateLimitsFetchResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill();
          resolvePromise(value);
        };
        const timer = setTimeout(
          () => finish(codexFailure(`codex app-server limits probe timed out after ${rpcTimeoutMs}ms`, "timeout")),
          rpcTimeoutMs,
        );
        timer.unref();
        child.on("error", (error) => finish(codexFailure(error)));
        child.on("exit", (code, signal) => finish(codexFailure(
          stderr || `codex app-server exited before answering account/rateLimits/read (code=${code ?? "-"}, signal=${signal ?? "-"})`,
        )));
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < 500) stderr += chunk.toString().slice(0, 500 - stderr.length);
        });
        let buffer = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            let message: { id?: number; result?: Record<string, unknown>; error?: unknown };
            try {
              message = JSON.parse(line) as typeof message;
            } catch {
              continue;
            }
            if (message.id === 1) {
              if (message.error) {
                finish(codexFailure(message.error));
                return;
              }
              child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })}\n`);
            }
            if (message.id === 2) {
              if (message.error) {
                finish(codexFailure(message.error));
                return;
              }
              const rateLimits = message.result?.rateLimits as CodexLiveRateLimits | undefined;
              finish(rateLimits && (rateLimits.primary || rateLimits.secondary)
                ? { ok: true, limits: rateLimits }
                : codexFailure("codex app-server returned no rate-limit windows"));
              return;
            }
          }
        });
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "hive", title: "hive", version: "0.0.1" } } })}\n`,
        );
      }),
    {
      timeoutMs: lockTimeoutMs,
      staleMs: CODEX_BOOT_LOCK_STALE_MS,
      pollMs: 25,
    }).catch((error) => codexFailure(error));
  };
}

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

export class AccountsService {
  private readonly store: CoreStore;
  private readonly cfg: ResolvedNodeConfig;
  private readonly log: (op: string) => void;
  private readonly now: () => number;
  private readonly keychainReader: KeychainReader;
  private readonly keychainWriter: KeychainWriter;
  private readonly cursorAuthReader: CursorAuthReader;
  private readonly fetchers: Required<LimitsFetchers>;
  private readonly providerHttp: ProviderLimitsHttp;
  private lastPeriodicRefreshAt = 0;
  private refreshing: Promise<void> | null = null;
  private readonly queuedRefreshIds = new Set<string>();
  private readonly activeRefreshIds = new Set<string>();
  /** All callers for one Codex home join one bounded app-server probe. */
  private readonly codexFetches = new Map<string, Promise<PutAccountLimitsInput>>();
  /** Refresh tokens rotate on use: at most one refresh may run per account. */
  private readonly claudeRefreshes = new Map<string, Promise<ClaudeRefreshOutcome>>();
  /** Grok/Kimi refresh tokens also rotate; share the whole provider read. */
  private readonly secondaryProviderFetches = new Map<string, Promise<PutAccountLimitsInput>>();
  /**
   * Auto picks not yet visible as runtimes (HIVE-80 reservation): each pick
   * debits its account for AUTO_PICK_DEBIT_TTL_MS so back-to-back spawns
   * spread instead of stacking on one snapshot. In-memory: a daemon restart
   * loses at most 15 minutes of reservations.
   */
  private readonly pendingPicks = new Map<string, PendingPick[]>();
  /**
   * Measured burn per window (points/hour) from consecutive readable
   * snapshots of the same window; null = the window rolled over between
   * reads (fresh, no velocity yet). Feeds the selector's aging + projection.
   */
  private readonly velocities = new Map<string, WindowVelocities>();
  /** v19: at most one lease mint per account; concurrent callers join it. */
  private readonly leaseMints = new Map<string, Promise<EphemeralCredential>>();
  private readonly codexLeaseRefresh: (homePath: string) => Promise<void>;

  constructor(opts: AccountsServiceOptions) {
    this.store = opts.store;
    this.cfg = opts.cfg;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.keychainReader = opts.keychainReader ?? readClaudeKeychain;
    this.keychainWriter = opts.keychainWriter ?? writeClaudeKeychainEntry;
    this.cursorAuthReader = opts.cursorAuthReader ?? readCursorLiveAuth;
    this.fetchers = {
      claudeUsage: opts.fetchers?.claudeUsage ?? defaultClaudeUsage(this.cfg.accounts.limitsFetchTimeoutMs),
      claudeRefresh: opts.fetchers?.claudeRefresh ?? defaultClaudeRefresh(this.cfg.accounts.limitsFetchTimeoutMs),
      codexRateLimits: opts.fetchers?.codexRateLimits ?? defaultCodexRateLimits(this.cfg.accounts.limitsFetchTimeoutMs, this.cfg.agents.codex?.command ?? "codex"),
    };
    this.providerHttp = {
      ...defaultProviderLimitsHttp(this.cfg.accounts.limitsFetchTimeoutMs),
      ...opts.providerHttp,
    };
    this.codexLeaseRefresh = opts.codexLeaseRefresh ?? defaultCodexLeaseRefresh(this.cfg.agents.codex?.command ?? "codex");
  }

  // -------------------------------------------------------------------------
  // paths + predicates
  // -------------------------------------------------------------------------

  vaultDirOf(account: Pick<AccountRow, "harness" | "id">): string {
    return vaultDirFor(this.cfg.accounts.vaultDir, account.harness, account.id);
  }

  defaultHomeOf(accountId: string): string {
    return defaultHomeFor(this.cfg.accounts.homesDir, accountId);
  }

  /** The env the account binding derives: HOME_ENV[harness] = home_path (+ recipe extras). */
  homeEnvOf(account: AccountRow): Record<string, string> {
    const key = homeEnvFor(account.harness);
    return { ...(key ? { [key]: account.homePath } : {}), ...recipeEnvFor(account.harness, account.homePath) };
  }

  /**
   * Runtime-only credential overrides that must never be persisted in bee.env.
   * Cursor's config dir does not relocate its secret store, so the account
   * home's captured auth.json is lifted into the process environment here.
   */
  credentialEnvOf(account: AccountRow): Record<string, string> {
    return account.harness === "cursor" ? cursorCredentialEnv(account.homePath) : {};
  }

  /**
   * "Vault credentials present" (spec 08 candidate rule 1) — in the
   * home-authoritative world the HOME counts too: an account whose home is
   * already logged in is usable even before a capture; an account whose vault
   * is seeded can activate an empty home. Unknown harness (no recipe) = the
   * home is the account (singleton harnesses without a recipe are always
   * candidates).
   */
  credentialed(account: Pick<AccountRow, "harness" | "id" | "homePath">): boolean {
    const recipe = recipeFor(account.harness);
    if (!recipe) return true;
    return dirHasCredentials(this.vaultDirOf(account), recipe) || dirHasCredentials(account.homePath, recipe);
  }

  /**
   * F2 honesty: "a credential file exists" is not account health. Derived,
   * never stored — `absent` (no primary credential anywhere), `unverified`
   * (file present, zero validation evidence: the shape an importExisting
   * add or an adopted pre-existing home starts in), `verified` (a recorded
   * login/capture or a readable limits probe once proved the credential).
   * A later auth failure lives on `status` (`auth_needed`), which clients
   * must render over a historical `verified`.
   */
  credentialHealthOf(account: AccountRow): CredentialHealth {
    if (!this.credentialed(account)) return "absent";
    if (account.lastLoginAt != null) return "verified";
    if (this.store.getAccountLimits(account.id)?.readable === true) return "verified";
    return "unverified";
  }

  /** The mirror shape of an account row: the store row plus the derived health (never stored). */
  mirrorRow(account: AccountRow): MirrorAccountRow {
    return { ...account, credentialHealth: this.credentialHealthOf(account) };
  }

  /**
   * v18 status honesty: `ok` may only be claimed for an account that HAS a
   * credential — with none anywhere the truthful status is `auth_needed`
   * (the closed vocabulary's "log in" state). `paused` / `auth_needed`
   * requests pass through. Harnesses without a recipe (the home is the
   * account) are always credentialed.
   */
  honestStatus(account: Pick<AccountRow, "harness" | "id" | "homePath">, requested: AccountStatus): AccountStatus {
    if (requested !== "ok") return requested;
    return this.credentialed(account) ? "ok" : "auth_needed";
  }

  /** Whether `verifyCredentials` can probe provider authentication or a required credential file. */
  hasCredentialProbe(harness: string): boolean {
    return this.credentialProbeOf(harness) !== "none";
  }

  /** The evidence a harness's credential verification lane can collect. */
  credentialProbeOf(harness: string): VerifyOutcome["probe"] {
    if (!PROBE_CAPABLE_HARNESSES.has(harness)) return "none";
    return harness === "agy" ? "credential_file" : "limits";
  }

  // -------------------------------------------------------------------------
  // selection — the calibrated model over the store
  // -------------------------------------------------------------------------

  /**
   * Resolve `auto` for a harness (spec 08 §Selection). Candidates: this
   * harness's accounts, not paused, credentialed, minus `excludeAccountIds`
   * (and minus recently-exhausted for rotation); accounts with an
   * auth_needed status are skipped while a healthy one exists (last resort
   * otherwise). One candidate short-circuits (no limits read). Otherwise the
   * ported selector ranks limits rows + live-bee commitments + penalty, and a
   * near-tie rotates through the per-harness cursor row. Synchronous: callers
   * may schedule stale sampling, but selection always reads the current row.
   */
  pick(harness: string, opts: PickOptions = {}): PickOutcome {
    const now = this.now();
    const registered = this.store.listAccounts({ harness });
    if (registered.length === 0) {
      return { ok: false, code: "no_accounts", message: `No ${harness} accounts registered; add one with: hive v2 account add ${harness} <label>` };
    }
    const pool = registered.filter((a) => a.status !== "paused");
    if (pool.length === 0) {
      return { ok: false, code: "all_paused", message: `Every ${harness} account is paused; unpause one with: hive v2 account unpause <account>` };
    }
    let credentialed = 0;
    const candidates: AccountRow[] = [];
    for (const account of pool) {
      if (!this.credentialed(account)) continue;
      credentialed += 1;
      if (opts.excludeAccountIds?.has(account.id)) continue;
      if (
        opts.excludeRecentlyExhausted &&
        account.exhaustedAt != null &&
        now - account.exhaustedAt < this.cfg.accounts.exhaustionCoolOffMs
      ) continue;
      candidates.push(account);
    }
    if (candidates.length === 0) {
      if (credentialed > 0 && ((opts.excludeAccountIds?.size ?? 0) > 0 || opts.excludeRecentlyExhausted)) {
        return { ok: false, code: "no_untried", message: `No untried ${harness} account remains` };
      }
      return { ok: false, code: "no_credentials", message: `No ${harness} account has credentials; log in with: hive v2 account login <account>` };
    }
    // A credential FILE existing is not health: an account whose last real
    // authentication attempt failed must not keep winning the pick — every
    // bee placed on it strands at /login. Skip such accounts while any
    // healthy one exists (the historical soft preference incl. its
    // single-account last resort).
    const healthy = candidates.filter((a) => a.status !== "auth_needed");
    const skipped = healthy.length > 0 ? candidates.filter((a) => a.status === "auth_needed") : [];
    const eligible = healthy.length > 0 ? healthy : candidates;
    const healthReason = skipped.length > 0
      ? `; skipped ${skipped.map((a) => `${a.id} for recent auth failure`).join(", ")}`
      : healthy.length === 0
        ? "; every credentialed account has a recent auth failure; using last resort"
        : "";
    // A single candidate wins regardless of usage — skip the limits read and
    // the pick bookkeeping (there is no herd to steer with one account).
    if (eligible.length === 1) {
      const only = eligible[0] as AccountRow;
      const reason = `only ${skipped.length > 0 ? "healthy " : ""}${harness} account with credentials${healthReason}`;
      this.log(`account auto → ${only.id} — ${reason}`);
      return { ok: true, account: only, reason, limitsAgeMs: null, stale: false, candidates: 1 };
    }
    // Commitments: live bees on each account (this harness only) + pending
    // pick debits; busy bees + fresh picks also drive the velocity fallback.
    const bees = this.store.listBees().filter((b) => b.agent === harness && b.account);
    const runtimes = bees.map((b) => ({ account: b.account, runtimeState: this.store.currentRuntime(b.id)?.state ?? null }));
    const commitments = accountCommitments(runtimes);
    const activeBees = accountActiveBees(runtimes);
    const rowsById = new Map<string, AccountLimitsRow>();
    for (const a of eligible) {
      const row = this.store.getAccountLimits(a.id);
      if (row) rowsById.set(a.id, row);
    }
    const scored: AutoAccountCandidate[] = eligible.map((a) => {
      const row = rowsById.get(a.id);
      const pending = prunePendingPicks(this.pendingPicks.get(a.id) ?? [], now);
      if (pending.length > 0) this.pendingPicks.set(a.id, pending);
      else this.pendingPicks.delete(a.id);
      return {
        account: { id: a.id, addedAt: a.addedAt, penalty: a.penalty },
        ...(row ? { limits: limitsFromRow(row, this.velocities.get(a.id) ?? {}) } : {}),
        commitment: (commitments.get(a.id) ?? 0) + pendingPickDebit(pending, now),
        activeBees: (activeBees.get(a.id) ?? 0) + pending.length,
        exhausted: a.exhaustedAt != null && now - a.exhaustedAt < this.cfg.accounts.exhaustionCoolOffMs,
      };
    });
    const choice = selectLeastLoadedAccount(scored, now, opts.model ? { model: opts.model } : {});
    if (!choice) return { ok: false, code: "no_credentials", message: `No ${harness} account is selectable` };
    const cursor = this.store.getSelectionCursor(harness);
    const rotated = rotateNearTie(choice, scored, cursor?.lastAccountId ?? null);
    if (rotated.cursor !== null) this.store.setSelectionCursor(harness, rotated.cursor);
    const winner = eligible.find((a) => a.id === rotated.choice.account.id) as AccountRow;
    // The HIVE-80 reservation: the next concurrent pick sees this one.
    this.pendingPicks.set(winner.id, [...(this.pendingPicks.get(winner.id) ?? []), { at: now, percent: AUTO_PICK_DEBIT_PERCENT }]);
    const reason = `${rotated.choice.reason}${healthReason}`;
    const row = rowsById.get(winner.id);
    const limitsAgeMs = row ? Math.max(0, now - row.fetchedAt) : null;
    const stale = limitsAgeMs !== null && limitsAgeMs > this.cfg.accounts.limitsStaleMs;
    const usage = autoPickUsage(rotated.choice.limits, opts.model, now);
    const freshness = limitsAgeMs === null ? "" : `, limits ${Math.round(limitsAgeMs / 60_000)} min old${stale ? " (stale)" : ""}`;
    this.log(`account auto → ${winner.id}${usage ? ` (${usage}${freshness})` : freshness ? ` (${freshness.slice(2)})` : ""} — ${reason}`);
    return { ok: true, account: winner, reason, limitsAgeMs, stale, candidates: eligible.length };
  }

  /**
   * Resolve `rr` for a harness. This deliberately ignores provider limits and
   * commitments: it walks credentialed accounts in stable registration order,
   * skipping paused/auth-failed accounts while a healthy candidate exists.
   * Its durable cursor is namespaced away from auto's near-tie cursor.
   */
  pickRoundRobin(harness: string): PickOutcome {
    const registered = this.store.listAccounts({ harness });
    if (registered.length === 0) {
      return { ok: false, code: "no_accounts", message: `No ${harness} accounts registered; add one with: hive account add ${harness} <label>` };
    }
    const pool = registered.filter((account) => account.status !== "paused");
    if (pool.length === 0) {
      return { ok: false, code: "all_paused", message: `Every ${harness} account is paused; unpause one with: hive account unpause <account>` };
    }
    const candidates = pool.filter((account) => this.credentialed(account));
    if (candidates.length === 0) {
      return { ok: false, code: "no_credentials", message: `No ${harness} account has credentials; log in with: hive account login <account>` };
    }
    const healthy = candidates.filter((account) => account.status !== "auth_needed");
    const skipped = healthy.length > 0 ? candidates.filter((account) => account.status === "auth_needed") : [];
    const eligible = healthy.length > 0 ? healthy : candidates;
    const cursorKey = `rr:${harness}`;
    const previous = this.store.getSelectionCursor(cursorKey)?.lastAccountId ?? null;
    const previousIndex = previous == null ? -1 : eligible.findIndex((account) => account.id === previous);
    const winner = eligible[(previousIndex + 1) % eligible.length] as AccountRow;
    this.store.setSelectionCursor(cursorKey, winner.id);
    const reason = [
      previousIndex >= 0
        ? `round-robin: next after ${previous}`
        : eligible.length === 1
          ? `only ${harness} account with credentials`
          : "round-robin: first pick",
      ...(skipped.length > 0 ? [`skipped ${skipped.length} account(s) for recent auth failure`] : []),
      ...(healthy.length === 0 && candidates.some((account) => account.status === "auth_needed")
        ? ["every credentialed account has a recent auth failure; using last resort"]
        : []),
    ].join("; ");
    this.log(`account rr → ${winner.id} — ${reason}`);
    return { ok: true, account: winner, reason, limitsAgeMs: null, stale: false, candidates: eligible.length };
  }

  /** The candidate ids a pick would consider (for "refresh stale before pick"). */
  private candidateIdsFor(harness: string, opts: PickOptions): string[] {
    return this.store
      .listAccounts({ harness })
      .filter((a) => a.status !== "paused" && this.credentialed(a) && !opts.excludeAccountIds?.has(a.id))
      .map((a) => a.id);
  }

  /**
   * Freshness policy (spec 08 "Limits"): enqueue rows older than
   * limitsStaleMs (or missing) for the harness's candidates. The spawn path
   * reads the current snapshot immediately; provider sampling stays in the
   * shared background lane and only runs when more than one candidate exists.
   */
  scheduleFreshLimits(harness: string, opts: PickOptions = {}): { scheduled: string[] } {
    const ids = this.candidateIdsFor(harness, opts);
    if (ids.length < 2) return { scheduled: [] };
    const now = this.now();
    const stale = ids.filter((id) => {
      const row = this.store.getAccountLimits(id);
      return !row || now - row.fetchedAt > this.cfg.accounts.limitsStaleMs;
    });
    if (stale.length === 0) return { scheduled: [] };
    this.enqueueLimitsRefresh(stale);
    return { scheduled: stale };
  }

  // -------------------------------------------------------------------------
  // limits — bounded in-daemon fetch
  // -------------------------------------------------------------------------

  /** Refresh limits for the given accounts (all when omitted). */
  async refreshLimits(accountIds?: string[]): Promise<AccountLimitsRow[]> {
    const ids = accountIds ?? this.store.listAccounts().map((a) => a.id);
    const out: AccountLimitsRow[] = [];
    for (const id of ids) {
      const account = this.store.getAccount(id);
      if (!account) continue;
      const healthBefore = this.credentialHealthOf(account);
      const fetched = await this.fetchOne(account);
      if (!this.store.getAccount(id)) continue; // removed mid-fetch
      const previous = this.store.getAccountLimits(id);
      const keepLastGood = previous?.readable === true
        && !fetched.readable
        && (fetched.unreadableReason === "provider_error" || fetched.unreadableReason === "timeout");
      const credentialProbePassed = account.harness === "agy"
        && !fetched.readable
        && fetched.unreadableReason === "unsupported";
      // A transient sampling failure is not evidence that the provider's last
      // readable snapshot became false. Keep its fetchedAt and windows so the
      // mirror and selector honestly expose stale, last-known-good data. Real
      // auth failures still replace the row and drive auth_needed below.
      if (!keepLastGood && previous?.readable === true && fetched.readable) {
        this.velocities.set(id, this.measureVelocities(previous, fetched));
      }
      const row = keepLastGood ? previous! : this.store.putAccountLimits(id, fetched);
      // The probe is the authentication check account health keys on: a REAL
      // auth failure sets auth_needed; a readable answer or agy's successful
      // token-file probe is contrary evidence. The agy limits row stays
      // unsupported and its credential health stays unverified.
      if (!fetched.readable && fetched.error && fetched.unreadableReason === "auth_failed") {
        if (this.store.setAccountStatus(id, account.status === "paused" ? "paused" : "auth_needed", `limits probe: ${fetched.error.slice(0, 200)}`).applied) {
          this.log(`account.auth_needed account=${id} by=limits_probe`);
        }
      } else if ((fetched.readable || credentialProbePassed) && account.status === "auth_needed") {
        const probe = credentialProbePassed ? "credential_probe" : "limits_probe";
        this.store.setAccountStatus(id, "ok", `${probe} authenticated`);
        this.log(`account.auth_ok account=${id} by=${probe}`);
      }
      // v18: the probe is validation evidence the MIRROR must see. A status
      // flip above already re-published the row; otherwise (an `ok`
      // unverified import that just proved itself) re-publish it explicitly
      // so `credentialHealth` is re-derived at emit — no stored health field.
      const after = this.store.getAccount(id);
      if (after) {
        const healthAfter = this.credentialHealthOf(after);
        if (healthAfter !== healthBefore && after.updatedAt === account.updatedAt && after.status === account.status) {
          this.store.touchAccount(id, `credential health ${healthBefore} → ${healthAfter} by limits probe`);
          this.log(`account.credential_health account=${id} ${healthBefore}→${healthAfter} by=limits_probe`);
        }
      }
      if (keepLastGood) {
        this.log(`account.limits.transient_failure account=${id} reason=${fetched.unreadableReason} kept_fetched_at=${row.fetchedAt} error=${JSON.stringify(fetched.error ?? null)}`);
      }
      this.log(`account.limits account=${id} readable=${row.readable}${row.readable ? ` weekly=${row.weeklyPct ?? "-"} 5h=${row.fiveHourPct ?? "-"}` : ` error=${JSON.stringify(row.error)}`}`);
      out.push(row);
    }
    return out;
  }

  /** Per-window velocity between the stored row and the snapshot about to replace it. */
  private measureVelocities(previous: AccountLimitsRow, fetched: PutAccountLimitsInput): WindowVelocities {
    const now = this.now();
    const measure = (prevPct: number | null, prevReset: number | null, next: PutAccountLimitsInput["weekly"]): number | null => {
      if (prevPct === null || !next) return null;
      return measureWindowVelocity(
        { usedPercent: prevPct, resetsAt: prevReset, fetchedAt: previous.fetchedAt },
        { usedPercent: next.usedPercent, resetsAt: next.resetsAt ?? null, fetchedAt: now },
      );
    };
    return {
      fiveHour: measure(previous.fiveHourPct, previous.fiveHourResetsAt, fetched.fiveHour),
      weekly: measure(previous.weeklyPct, previous.weeklyResetsAt, fetched.weekly),
      fableWeekly: measure(previous.fableWeeklyPct, previous.fableResetsAt, fetched.fableWeekly),
    };
  }

  /** Measured window velocities for an account (tests + the mirror), if any. */
  velocitiesOf(accountId: string): WindowVelocities | undefined {
    return this.velocities.get(accountId);
  }

  /** One account's limits via its harness's transport; never throws (an unreadable row instead). */
  private async fetchOne(account: AccountRow): Promise<PutAccountLimitsInput> {
    if (account.harness === "codex") {
      const joined = this.codexFetches.get(account.homePath);
      if (joined) return joined;
      const pending = this.fetchOneBounded(account);
      this.codexFetches.set(account.homePath, pending);
      try {
        return await pending;
      } finally {
        if (this.codexFetches.get(account.homePath) === pending) this.codexFetches.delete(account.homePath);
      }
    }
    return this.fetchOneBounded(account);
  }

  private async fetchOneBounded(account: AccountRow): Promise<PutAccountLimitsInput> {
    const timeout = this.cfg.accounts.limitsFetchTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const attempt = this.fetchByHarness(account);
      const bounded = new Promise<PutAccountLimitsInput>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`limits fetch timed out after ${timeout}ms`)), timeout);
        timer.unref();
      });
      return await Promise.race([attempt, bounded]);
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      return {
        readable: false,
        unreadableReason: /timed out|timeout/i.test(error)
          ? "timeout"
          : isAuthFailureLimitsError(error)
            ? "auth_failed"
            : "provider_error",
        error,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchByHarness(account: AccountRow): Promise<PutAccountLimitsInput> {
    switch (account.harness) {
      case "claude": {
        let credential = await this.freshestClaudeCredential(account);
        if (!credential) {
          return { readable: false, unreadableReason: "auth_expired", error: "no OAuth token found in home, keychain, or vault" };
        }
        if (credential.expiresAt <= this.now()) {
          const refreshed = await this.refreshClaudeCredential(account);
          if (refreshed.kind === "ok") credential = refreshed.credential;
          else if (refreshed.kind === "live_runtime") {
            return { readable: false, unreadableReason: "auth_expired", error: "OAuth token expired; the running Claude owns refresh for this account" };
          } else if (refreshed.kind === "no_refresh_token") {
            return { readable: false, unreadableReason: "auth_expired", error: "OAuth token expired and has no refresh token; log in: hive v2 account login " + account.id };
          } else {
            return { readable: false, unreadableReason: "auth_failed", error: "OAuth refresh failed; log in: hive v2 account login " + account.id };
          }
        }
        const usage = await this.fetchers.claudeUsage(credential.accessToken);
        return parseClaudeUsage(usage, credential.subscriptionType ?? null);
      }
      case "codex": {
        // `codex app-server` reads CODEX_HOME only: an imported credential
        // still sits in the vault until the first spawn activates the home.
        // Activate the EMPTY home now (the identical rule the spawn path
        // applies; a populated home is untouched) so the probe sees it.
        const activated = activateHomeIfEmpty(account.harness, account.homePath, this.vaultDirOf(account), { yolo: true });
        if (activated.activated) this.log(`account.activate account=${account.id} home=${account.homePath} copied=${activated.copied.join(",")} by=limits_probe`);
        const result = await this.fetchers.codexRateLimits(account.homePath);
        if (!result.ok) return { readable: false, unreadableReason: result.unreadableReason, error: result.error };
        return parseCodexRateLimits(result.limits);
      }
      case "grok":
      case "kimi":
      case "cursor":
      case "opencode":
        return this.fetchSecondaryProvider(account);
      case "agy":
        return this.credentialed(account)
          ? { readable: false, unreadableReason: "unsupported", error: "agy has no limits source" }
          : { readable: false, unreadableReason: "auth_failed", error: "agy OAuth token file is missing from the account home and vault" };
      default:
        return { readable: false, unreadableReason: "unsupported", error: `${account.harness} has no limits source` };
    }
  }

  private async fetchSecondaryProvider(account: AccountRow): Promise<PutAccountLimitsInput> {
    const joined = this.secondaryProviderFetches.get(account.id);
    if (joined) return joined;
    const pending = fetchSecondaryProviderLimits({
      account,
      vaultDir: this.vaultDirOf(account),
      now: this.now(),
      allowCredentialRefresh: !this.hasLiveRuntime(account.id),
      http: this.providerHttp,
    });
    this.secondaryProviderFetches.set(account.id, pending);
    try {
      return await pending;
    } finally {
      if (this.secondaryProviderFetches.get(account.id) === pending) this.secondaryProviderFetches.delete(account.id);
    }
  }

  /**
   * The freshest claude OAuth credential for the account: the HOME's
   * .credentials.json and Keychain item (the live chain, refreshed on use)
   * and the vault snapshot, by expiresAt. Location is the account's own home
   * — no cross-home candidate pool, no identity arbitration (one account =
   * one home in v2).
   */
  private async freshestClaudeCredential(account: AccountRow): Promise<ClaudeCredential | null> {
    const candidates: ClaudeCredential[] = [];
    const push = (raw: string | null) => {
      const parsed = parseClaudeCredentials(raw);
      if (!parsed || !raw) return;
      try {
        const document = JSON.parse(raw) as Record<string, unknown>;
        const oauth = document.claudeAiOauth;
        if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return;
        candidates.push({ ...parsed, document, oauth: oauth as Record<string, unknown> });
      } catch {
        // parseClaudeCredentials already rejects malformed documents; defensive only.
      }
    };
    push(readIfFile(join(account.homePath, ".credentials.json")));
    push(await this.keychainReader(account.homePath).catch(() => null));
    push(readIfFile(join(this.vaultDirOf(account), ".credentials.json")));
    candidates.sort((a, b) => b.expiresAt - a.expiresAt);
    return candidates[0] ?? null;
  }

  private hasLiveRuntime(accountId: string): boolean {
    return this.store.listBees().some((bee) => {
      if (bee.account !== accountId) return false;
      const runtime = this.store.currentRuntime(bee.id);
      return runtime !== null && runtime.state !== "stopped";
    });
  }

  /**
   * Rotate one expired Claude chain exactly once and persist the new chain to
   * the account's only home, Keychain item, and vault backup. A live runtime
   * owns its own refresh and is never raced by the daemon. `minTtlMs` is the
   * freshness floor the caller needs (the lease mint's ship floor); the
   * default 0 keeps the limits path's "expired means expired" behavior.
   */
  private async refreshClaudeCredential(account: AccountRow, minTtlMs = 0): Promise<ClaudeRefreshOutcome> {
    const joined = this.claudeRefreshes.get(account.id);
    if (joined) return joined;
    const pending = (async (): Promise<ClaudeRefreshOutcome> => {
      if (this.hasLiveRuntime(account.id)) return { kind: "live_runtime" };
      // Re-read inside the single-flight boundary: another limits caller or
      // harness may have advanced the chain after the first read.
      const credential = await this.freshestClaudeCredential(account);
      if (credential && credential.expiresAt - this.now() > minTtlMs) return { kind: "ok", credential };
      if (!credential?.refreshToken) return { kind: "no_refresh_token" };
      const refreshed = await this.fetchers.claudeRefresh(credential.refreshToken);
      if (!refreshed) return { kind: "refresh_failed" };
      const oauth: Record<string, unknown> = {
        ...credential.oauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        ...(refreshed.scopes ? { scopes: refreshed.scopes } : {}),
      };
      const document = { ...credential.document, claudeAiOauth: oauth };
      const raw = JSON.stringify(document);
      mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
      mkdirSync(this.vaultDirOf(account), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(join(account.homePath, ".credentials.json"), raw);
      atomicWriteFileSync(join(this.vaultDirOf(account), ".credentials.json"), raw);
      const keychainWritten = await this.keychainWriter(account.homePath, raw).catch(() => false);
      if (!keychainWritten) this.log(`account.refresh.keychain_degraded account=${account.id}`);
      this.log(`account.refresh account=${account.id} persisted=home,vault keychain=${keychainWritten}`);
      return {
        kind: "ok",
        credential: {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
          ...(credential.subscriptionType ? { subscriptionType: credential.subscriptionType } : {}),
          document,
          oauth,
        },
      };
    })();
    this.claudeRefreshes.set(account.id, pending);
    try {
      return await pending;
    } finally {
      if (this.claudeRefreshes.get(account.id) === pending) this.claudeRefreshes.delete(account.id);
    }
  }

  /**
   * v18: verify credentials off the caller path through the shared background
   * lane. Provider-backed probes read limits; agy checks its required OAuth
   * token and leaves limits unsupported. The ids actually queued are returned.
   */
  scheduleVerification(accountIds: readonly string[]): string[] {
    const ids = accountIds.filter((id) => {
      const account = this.store.getAccount(id);
      return account !== null && this.hasCredentialProbe(account.harness);
    });
    if (ids.length > 0) this.enqueueLimitsRefresh(ids);
    return ids;
  }

  /**
   * v18: `account.verify` runs the cheapest probe the harness has. A provider
   * limits read can verify a credential. agy's file probe can prove only that
   * its required token is present or absent, so a present imported token stays
   * unverified until login records fresh evidence.
   */
  async verifyCredentials(account: AccountRow): Promise<VerifyOutcome> {
    const probe = this.credentialProbeOf(account.harness);
    if (!this.credentialed(account)) {
      const updated = this.store.setAccountStatus(
        account.id,
        account.status === "paused" ? "paused" : "auth_needed",
        "account verify: primary credential is absent",
      );
      if (updated.applied) this.log(`account.auth_needed account=${account.id} by=account_verify`);
      return {
        account: updated.account,
        outcome: "absent",
        probe: probe === "credential_file" ? probe : "none",
        limits: null,
      };
    }
    if (probe === "none") {
      return { account, outcome: this.credentialHealthOf(account) === "verified" ? "verified" : "unverified", probe: "none", limits: this.store.getAccountLimits(account.id) };
    }
    const [limits] = await this.refreshLimits([account.id]);
    const after = this.store.getAccount(account.id) ?? account;
    const outcome: VerifyOutcome["outcome"] = after.status === "auth_needed"
      ? "auth_needed"
      : this.credentialHealthOf(after) === "verified"
        ? "verified"
        : "unverified";
    this.log(`account.verify account=${account.id} outcome=${outcome} readable=${limits?.readable ?? "-"}${limits && !limits.readable ? ` reason=${limits.unreadableReason}` : ""}`);
    return { account: after, outcome, probe, limits: probe === "credential_file" ? null : limits ?? null };
  }

  // -------------------------------------------------------------------------
  // v19: account.lease — the credential-lease mint (RN7a)
  // -------------------------------------------------------------------------

  /**
   * Whether the account's local refresher is mid-rotation RIGHT NOW: the
   * claude OAuth single-flight, a secondary-provider read (grok/kimi rotate
   * their refresh tokens inside that read), or a codex app-server probe
   * against the account's home (codex may rotate auth.json in place at turn
   * start). A lease minted while the chain is rotating could ship a token the
   * rotation is about to replace — the mint refuses instead (retryable).
   */
  refreshBusy(account: Pick<AccountRow, "id" | "homePath">): boolean {
    return this.claudeRefreshes.has(account.id) || this.secondaryProviderFetches.has(account.id) || this.codexFetches.has(account.homePath);
  }

  /**
   * Mint the SHORT-LIVED, refresh-blanked credential lease for `account`
   * (spec: credential-leases.md; validated by docs/RN7A_EXPERIMENTS.md).
   * Never returns more than this single account's primary credential, always
   * with every OAuth refresh-token field blanked — the vault/home chain stays
   * the sole holder of the real refresh tokens. Single-flight per account
   * (concurrent callers join); refused while the account's refresher is
   * mid-rotation. SENSITIVE: the return value is the ONLY place secret bytes
   * appear — callers must never log, audit, or persist it.
   */
  async mintLease(account: AccountRow): Promise<EphemeralCredential> {
    const joined = this.leaseMints.get(account.id);
    if (joined) return joined;
    const pending = this.mintLeaseFresh(account);
    this.leaseMints.set(account.id, pending);
    try {
      return await pending;
    } finally {
      if (this.leaseMints.get(account.id) === pending) this.leaseMints.delete(account.id);
    }
  }

  private async mintLeaseFresh(account: AccountRow): Promise<EphemeralCredential> {
    if (this.refreshBusy(account)) {
      throw new LeaseRefusal("lease_unavailable", `account ${account.id}'s credential refresher is mid-rotation; retry shortly`);
    }
    const lease = await this.mintLeaseByHarness(account);
    // Secret-free by construction: counts, note, and expiry only.
    this.log(
      `account.lease account=${account.id} harness=${account.harness} files=${lease.files.length}` +
        ` env=${Object.keys(lease.env ?? {}).length} exp=${lease.expiresAt !== undefined ? new Date(lease.expiresAt * 1000).toISOString() : "-"}`,
    );
    return lease;
  }

  private mintLeaseByHarness(account: AccountRow): Promise<EphemeralCredential> {
    switch (account.harness) {
      case "claude":
        return this.mintClaudeLease(account);
      case "codex":
        return this.mintCodexLease(account);
      case "grok":
        return Promise.resolve(this.mintGrokLease(account));
      case "kimi":
        return Promise.resolve(this.mintKimiLease(account));
      case "opencode":
        return Promise.resolve(this.mintOpenCodeLease(account));
      default:
        // cursor's machine-global keychain slot (and every unmodeled harness)
        // has no defensible lease artifact — a durable, typed refusal.
        throw new LeaseRefusal(
          "lease_unsupported",
          `harness "${account.harness}" has no credential-lease strategy (supported: claude, codex, grok, kimi, opencode)`,
        );
    }
  }

  /**
   * claude: ship `.credentials.json` with `claudeAiOauth.refreshToken` blanked
   * and the CURRENT access token preserved. Experiment 2 (RN7A_EXPERIMENTS.md)
   * confirmed the harness runs cleanly to real token expiry with a blanked
   * refresh token and fails typed at a server 401 — the daemon's own OAuth
   * refresh (refreshClaudeCredential, single-flight, live-runtime-guarded)
   * freshens a chain at/near expiry BEFORE the lease is cut; a token under
   * CLAUDE_MIN_SHIP_TTL_MS is never shipped dying.
   */
  private async mintClaudeLease(account: AccountRow): Promise<EphemeralCredential> {
    let credential = await this.freshestClaudeCredential(account);
    if (!credential) {
      throw new LeaseRefusal("lease_unavailable", `no claude OAuth credential for ${account.id}; log in: hive v2 account login ${account.id}`);
    }
    if (credential.expiresAt - this.now() <= CLAUDE_MIN_SHIP_TTL_MS) {
      const refreshed = await this.refreshClaudeCredential(account, CLAUDE_MIN_SHIP_TTL_MS);
      if (refreshed.kind === "ok") credential = refreshed.credential;
      else if (refreshed.kind === "live_runtime") {
        throw new LeaseRefusal("lease_unavailable", `claude OAuth token for ${account.id} is at/near expiry and the running Claude owns refresh; retry shortly`);
      } else if (refreshed.kind === "no_refresh_token") {
        throw new LeaseRefusal("lease_unavailable", `claude OAuth token for ${account.id} is at/near expiry with no refresh chain; log in: hive v2 account login ${account.id}`);
      } else {
        throw new LeaseRefusal("lease_unavailable", `claude OAuth refresh failed for ${account.id}; log in: hive v2 account login ${account.id}`);
      }
    }
    // A joined in-flight refresh (from the limits path, floor 0) may have
    // answered with a token that satisfies "not expired" but not the ship
    // floor — re-check the token actually being shipped.
    if (credential.expiresAt - this.now() <= CLAUDE_MIN_SHIP_TTL_MS) {
      throw new LeaseRefusal("lease_unavailable", `claude OAuth refresh for ${account.id} did not produce a token above the 15-minute ship floor; retry shortly`);
    }
    const body = `${JSON.stringify(blankRefreshTokens(credential.document))}\n`;
    const expSeconds = Math.floor(credential.expiresAt / 1000);
    return {
      files: [{ homeRelPath: ".credentials.json", contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      expiresAt: expSeconds,
      kindNote: `claude: shipped .credentials.json with OAuth refresh token blanked, exp ${new Date(expSeconds * 1000).toISOString()}; scrub ANTHROPIC_API_KEY on subscription spawns`,
    };
  }

  /**
   * codex: ship an auth.json carrying a FRESH access token with the refresh
   * token BLANKED (`refresh_token: ""`, field kept — codex serde requires it
   * present). Re-validated on codex-cli 0.152.0 (Experiment 1). A near-expiry
   * vault/home token triggers the central rotation first: codex itself rotates
   * auth.json in place on a no-op turn in the account's home (never a
   * re-implemented OAuth endpoint), then the home is captured back to the
   * vault. Never ships a token with under CODEX_MIN_SHIP_TTL_MS remaining.
   */
  private async mintCodexLease(account: AccountRow): Promise<EphemeralCredential> {
    let current = this.freshestCodexAuth(account);
    if (!current) {
      throw new LeaseRefusal("lease_unavailable", `no codex auth.json with a decodable access token for ${account.id}; log in: hive v2 account login ${account.id}`);
    }
    if (current.expSeconds * 1000 - this.now() <= CODEX_MIN_SHIP_TTL_MS) {
      if (this.hasLiveRuntime(account.id)) {
        throw new LeaseRefusal("lease_unavailable", `codex access token for ${account.id} is near expiry and a live runtime owns the home; retry after its rotation lands`);
      }
      // An imported credential may still sit vault-only; the rotation turn
      // reads CODEX_HOME, so activate the EMPTY home first (a populated home
      // is untouched — the identical rule the spawn path applies).
      const activated = activateHomeIfEmpty(account.harness, account.homePath, this.vaultDirOf(account), { yolo: true });
      if (activated.activated) this.log(`account.activate account=${account.id} home=${account.homePath} copied=${activated.copied.join(",")} by=lease`);
      await this.codexLeaseRefresh(account.homePath);
      // The rotation turn is long (up to 120 s): a runtime may have started on
      // this account meanwhile and now owns the home — re-check before
      // touching it again (the harvest) or shipping what the rotation wrote.
      if (this.hasLiveRuntime(account.id)) {
        throw new LeaseRefusal("lease_unavailable", `a runtime started on ${account.id} during the token rotation and owns the home; retry after its rotation lands`);
      }
      // Harvest the rotated chain home → vault so the vault stays current.
      captureHomeToVault(account.harness, account.homePath, this.vaultDirOf(account));
      current = this.freshestCodexAuth(account);
      if (!current || current.expSeconds * 1000 - this.now() <= CODEX_MIN_SHIP_TTL_MS) {
        throw new LeaseRefusal("lease_unavailable", `codex token rotation for ${account.id} did not produce a fresh access token; not shipping a stale token`);
      }
      this.log(`account.lease.codex_rotated account=${account.id} exp=${new Date(current.expSeconds * 1000).toISOString()}`);
    }
    // Deep blank covers every refresh key ANYWHERE in the file (not only
    // tokens.refresh_token); the explicit spread then guarantees the field is
    // PRESENT as "" — codex serde hard-fails when it is missing entirely.
    const blankedDoc = blankRefreshTokens(current.parsed) as Record<string, unknown>;
    // A subscription lease must never carry a billable developer API key: the
    // registry scrubs OPENAI_API_KEY from spawn env, and the file must not
    // smuggle one back in. An API-key-mode account keeps it — that billing is
    // the account's intent.
    const apiKeyMode = typeof blankedDoc.auth_mode === "string" && /^api[-_]?key$/i.test(blankedDoc.auth_mode);
    const blanked = {
      ...blankedDoc,
      ...(!apiKeyMode && "OPENAI_API_KEY" in blankedDoc ? { OPENAI_API_KEY: null } : {}),
      tokens: { ...(blankedDoc.tokens as Record<string, unknown>), refresh_token: "" },
    };
    const body = `${JSON.stringify(blanked, null, 2)}\n`;
    return {
      files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      expiresAt: current.expSeconds,
      kindNote: `codex: shipped access-token-only auth.json (refresh_token blanked), exp ${new Date(current.expSeconds * 1000).toISOString()}`,
    };
  }

  /**
   * The freshest codex auth.json between the account's HOME (the live chain —
   * codex rotates in place there) and the vault snapshot, by access-token
   * `exp`. Null when neither holds a decodable access token.
   */
  private freshestCodexAuth(account: AccountRow): { parsed: Record<string, unknown>; expSeconds: number } | null {
    let best: { parsed: Record<string, unknown>; expSeconds: number } | null = null;
    for (const path of [join(account.homePath, "auth.json"), join(this.vaultDirOf(account), "auth.json")]) {
      const raw = readIfFile(path);
      if (raw === null) continue;
      let parsed: Record<string, unknown>;
      try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        parsed = value as Record<string, unknown>;
      } catch {
        continue;
      }
      const tokens = parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
        ? (parsed.tokens as Record<string, unknown>)
        : undefined;
      const accessToken = tokens && typeof tokens.access_token === "string" ? tokens.access_token : undefined;
      const expSeconds = accessToken ? expFromJwt(accessToken) : undefined;
      if (expSeconds === undefined) continue;
      if (!best || expSeconds > best.expSeconds) best = { parsed, expSeconds };
    }
    return best;
  }

  /**
   * grok: ship auth.json (keyed by issuer::client; each entry may carry an
   * OAuth `refresh_token` grok uses to self-refresh) with every refresh token
   * blanked; the cached `key`/`expires_at` are preserved. The spawn side must
   * scrub XAI_API_KEY / GROK_CODE_XAI_API_KEY for subscription bees so the
   * delivered cached OAuth token — not developer API billing — is used.
   */
  private mintGrokLease(account: AccountRow): EphemeralCredential {
    const parsed = this.leasePrimaryJson(account, "auth.json");
    // Non-secret expiry: the soonest-dying entry bounds the whole lease —
    // that is when RN7b must have re-delivered. Live files carry ISO strings;
    // accept epoch numbers (ms or seconds) defensively.
    let expiresAt: number | undefined;
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = (entry as Record<string, unknown>).expires_at;
      const ms = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? (raw > 1e11 ? raw : raw * 1000) : Number.NaN;
      if (!Number.isFinite(ms)) continue;
      const seconds = Math.floor(ms / 1000);
      if (expiresAt === undefined || seconds < expiresAt) expiresAt = seconds;
    }
    const body = `${JSON.stringify(blankRefreshTokens(parsed), null, 2)}\n`;
    return {
      files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      kindNote: "grok: shipped auth.json with OAuth refresh token(s) blanked; scrub XAI_API_KEY and GROK_CODE_XAI_API_KEY on subscription spawns",
    };
  }

  /**
   * kimi: API-key lease per the design ruling — kimi's OAuth access tokens
   * live ~15 minutes and its refresh token rotates on every grant, so an
   * OAuth-only account cannot hold a lease across a satellite turn. A
   * credential carrying an `api_key` ships (refresh blanked); an OAuth-only
   * credential is a durable typed refusal.
   */
  private mintKimiLease(account: AccountRow): EphemeralCredential {
    const parsed = this.leasePrimaryJson(account, "credentials/kimi-code.json");
    const apiKey = (parsed as Record<string, unknown>).api_key;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new LeaseRefusal(
        "lease_unsupported",
        `kimi account ${account.id} is OAuth-only (15-minute rotating tokens cannot survive a lease); log in with a Moonshot API key to lease it`,
      );
    }
    const body = `${JSON.stringify(blankRefreshTokens(parsed), null, 2)}\n`;
    return {
      files: [{ homeRelPath: "credentials/kimi-code.json", contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      kindNote: "kimi: shipped credentials/kimi-code.json as an API-key lease (OAuth refresh token blanked)",
    };
  }

  /**
   * opencode: auth.json multiplexes EVERY provider login in one object keyed
   * by providerID. Ship ONLY the account's single coding-plan entry (the same
   * closed provider list the limits probe reads), refresh blanked, every
   * other provider's credential dropped. Never ships the multi-provider file.
   */
  private mintOpenCodeLease(account: AccountRow): EphemeralCredential {
    const rel = join("xdg-data", "opencode", "auth.json");
    const parsed = this.leasePrimaryJson(account, rel);
    const providers = parsed as Record<string, unknown>;
    const provider = OPENCODE_LEASE_PROVIDERS.find((id) => Object.prototype.hasOwnProperty.call(providers, id));
    if (!provider) {
      throw new LeaseRefusal(
        "lease_unsupported",
        `opencode account ${account.id} has no leasable coding-plan provider entry (${OPENCODE_LEASE_PROVIDERS.join(", ")})`,
      );
    }
    const dropped = Object.keys(providers).length - 1;
    const filtered = { [provider]: blankRefreshTokens(providers[provider]) };
    const body = `${JSON.stringify(filtered, null, 2)}\n`;
    return {
      files: [{ homeRelPath: rel, contentB64: Buffer.from(body, "utf8").toString("base64"), mode: 0o600 }],
      kindNote: `opencode: shipped single-provider (${provider}) auth.json (refresh blanked; ${dropped} other provider entr${dropped === 1 ? "y" : "ies"} dropped)`,
    };
  }

  /**
   * The account's primary credential file for a lease, HOME first (the live
   * chain) then the vault snapshot, parsed as a JSON object. Typed refusals:
   * missing anywhere → `lease_unavailable`; unparseable → `lease_unavailable`
   * with a re-login hint. Never reads any other account's files.
   */
  private leasePrimaryJson(account: AccountRow, rel: string): unknown {
    for (const path of [join(account.homePath, rel), join(this.vaultDirOf(account), rel)]) {
      const raw = readIfFile(path);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to the typed refusal below
      }
      throw new LeaseRefusal("lease_unavailable", `${account.harness} credential ${rel} for ${account.id} is not a JSON object; re-login: hive v2 account login ${account.id}`);
    }
    throw new LeaseRefusal("lease_unavailable", `no ${rel} found for ${account.id}; log in: hive v2 account login ${account.id}`);
  }

  /**
   * v18: `account.add {importExisting:true}` — adopt the machine's existing
   * sign-in for a NEW account (called before the row exists). In order:
   * the account's own home (captured into the vault), a leftover vault
   * entry, then the machine's VENDOR home (the harness's home env var when
   * set in `env`, else the recipe default under `home`; Claude's Keychain
   * item / Cursor's global store as the external primary). The primary must
   * parse as a credential; supporting/config files come along when present.
   * Nothing valid anywhere → `ok:false` with every path checked. Never
   * writes the account home; never records a login (health stays
   * `unverified` until a probe/login proves it).
   */
  async importExistingCredentials(
    account: Pick<AccountRow, "harness" | "id" | "homePath">,
    opts: { env?: Readonly<Record<string, string | undefined>>; home?: string } = {},
  ): Promise<ImportOutcome> {
    const recipe = recipeFor(account.harness);
    const checked: ImportCheck[] = [];
    if (!recipe) return { ok: false, checked };
    const primaryFile = primaryCredentialFile(recipe);
    const vaultDir = this.vaultDirOf(account);
    const check = (path: string, raw: string | null): ImportCheck["state"] =>
      raw === null ? "missing" : this.validPrimaryCredential(account.harness, primaryFile, raw) ? "present" : "invalid";

    // 1. The account's own home (a machine home handed in as homePath).
    const homePrimary = join(account.homePath, primaryFile);
    const homeRaw = readIfFile(homePrimary);
    const homeState = check(homePrimary, homeRaw);
    checked.push({ path: homePrimary, state: homeState });
    if (homeState === "present") {
      const files = captureHomeToVault(account.harness, account.homePath, vaultDir);
      return { ok: true, source: "home", from: account.homePath, files, checked };
    }
    // 2. A leftover vault entry for the id.
    const vaultPrimary = join(vaultDir, primaryFile);
    const vaultRaw = readIfFile(vaultPrimary);
    const vaultState = check(vaultPrimary, vaultRaw);
    checked.push({ path: vaultPrimary, state: vaultState });
    if (vaultState === "present") {
      const files = recipeFilesPresent(vaultDir, recipe);
      return { ok: true, source: "vault", from: vaultDir, files, checked };
    }
    // 3. The machine's vendor home.
    const vendor = resolveVendorHome(account.harness, opts.env ?? process.env, opts.home ?? homedir());
    if (!vendor) return { ok: false, checked };
    const contents = new Map<string, string>();
    for (const file of vendor.files) {
      const raw = readIfFile(file.path);
      if (file.role === "credential" && file.rel === primaryFile) checked.push({ path: file.path, state: check(file.path, raw) });
      if (raw !== null) contents.set(file.rel, raw);
    }
    let source: "vendor_home" | "external" = "vendor_home";
    let from = vendor.vendorHome;
    if (!this.validPrimaryCredential(account.harness, primaryFile, contents.get(primaryFile) ?? null)) {
      contents.delete(primaryFile);
      // The provider's out-of-home store for the VENDOR home.
      const external = account.harness === "claude"
        ? await this.keychainReader(vendor.vendorHome).catch(() => null)
        : account.harness === "cursor"
          ? (await this.cursorAuthReader().catch(() => null))?.raw ?? null
          : null;
      if (account.harness === "claude" || account.harness === "cursor") {
        const store = account.harness === "claude" ? `keychain:${vendor.vendorHome}` : "cursor:global-store";
        const state = check(store, external);
        checked.push({ path: store, state });
        if (state === "present") {
          contents.set(primaryFile, external as string);
          source = "external";
          from = store;
        }
      }
    }
    if (!contents.has(primaryFile)) return { ok: false, checked };
    mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    const files: string[] = [];
    for (const file of vendor.files) {
      const raw = contents.get(file.rel);
      if (raw === undefined) continue;
      const dst = join(vaultDir, file.rel);
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(dst, raw);
      files.push(file.rel);
    }
    return { ok: true, source, from, files, checked };
  }

  private enqueueLimitsRefresh(accountIds: readonly string[]): void {
    for (const id of accountIds) {
      if (!this.activeRefreshIds.has(id)) this.queuedRefreshIds.add(id);
    }
    if (this.refreshing || this.queuedRefreshIds.size === 0) return;
    this.refreshing = (async () => {
      while (this.queuedRefreshIds.size > 0) {
        const batch = [...this.queuedRefreshIds];
        this.queuedRefreshIds.clear();
        for (const id of batch) this.activeRefreshIds.add(id);
        try {
          await this.refreshLimits(batch);
        } finally {
          for (const id of batch) this.activeRefreshIds.delete(id);
        }
      }
    })()
      .catch((err) => this.log(`account.limits.sweep_error ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.refreshing = null;
      });
  }

  /** Tick hook: the periodic refresh (every limitsRefreshMs while the daemon runs; 0 = off). Shares the background lane with spawn-triggered stale sampling. */
  periodicRefreshTick(): void {
    const every = this.cfg.accounts.limitsRefreshMs;
    if (every <= 0) return;
    const now = this.now();
    if (now - this.lastPeriodicRefreshAt < every) return;
    this.lastPeriodicRefreshAt = now;
    const ids = this.store.listAccounts().map((account) => account.id);
    if (ids.length === 0) return;
    this.enqueueLimitsRefresh(ids);
  }

  // -------------------------------------------------------------------------
  // activation hook (spawn resolve)
  // -------------------------------------------------------------------------

  /**
   * Called from the driver's spawn resolve for a bee bound to an account: if
   * the account's home is EMPTY, activate it from the vault (+ home
   * defaults); a populated home is left alone byte for byte. Never writes the
   * vault. Claude on macOS additionally seeds the home's Keychain item from
   * the vault credential (best-effort, async, injected writer).
   */
  activateForSpawn(account: AccountRow, bee: { cwd: string }): ActivationResult {
    const result = activateHomeIfEmpty(account.harness, account.homePath, this.vaultDirOf(account), { trustCwd: bee.cwd, yolo: true });
    if (result.activated) {
      this.log(`account.activate account=${account.id} home=${account.homePath} copied=${result.copied.join(",")}`);
      if (account.harness === "claude") {
        void seedClaudeKeychainFromVault(account.homePath, this.vaultDirOf(account), this.keychainWriter).then((seeded) => {
          if (seeded) this.log(`account.activate.keychain account=${account.id} seeded=true`);
        });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // credential validation + capture (the login flow service drives these)
  // -------------------------------------------------------------------------

  /** The provider's out-of-home credential store (Claude: the home's Keychain item; Cursor: the machine-global store); null elsewhere. */
  async externalLoginCredential(account: AccountRow): Promise<string | null> {
    if (account.harness === "claude") return this.keychainReader(account.homePath).catch(() => null);
    if (account.harness === "cursor") return (await this.cursorAuthReader().catch(() => null))?.raw ?? null;
    return null;
  }

  /** Claude on macOS: seed the home's Keychain item with the credential JSON (false when unavailable/rejected). */
  writeClaudeKeychain(account: AccountRow, credentials: string): Promise<boolean> {
    if (account.harness !== "claude") return Promise.resolve(false);
    return this.keychainWriter(account.homePath, credentials).catch(() => false);
  }

  validPrimaryCredential(harness: string, primaryFile: string, raw: string | null): boolean {
    if (raw === null || raw.trim().length === 0) return false;
    if (harness === "claude") return parseClaudeCredentials(raw) !== null;
    if (harness === "cursor") return parseCursorAuth(raw) !== null;
    if (!primaryFile.endsWith(".json")) return true;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Validate the primary credential, then capture the recipe files home →
   * vault and record the login on the account row (status ok unless paused,
   * last_login_at). Atomic from the caller's view: an invalid primary
   * touches neither the vault nor the row.
   */
  persistCredentialCapture(
    account: AccountRow,
    primaryFile: string,
    primaryRaw: string | null,
    overrides: Record<string, string>,
  ):
    | { ok: true; account: AccountRow; captured: string[]; at: number }
    | { ok: false; reason: "invalid_primary" | "primary_not_captured" } {
    if (!this.validPrimaryCredential(account.harness, primaryFile, primaryRaw)) {
      return { ok: false, reason: "invalid_primary" };
    }
    // Cursor's provider login lands outside CURSOR_CONFIG_DIR. Materialize
    // that explicit credential into the account home before vault backup.
    if (account.harness === "cursor" && overrides[primaryFile] !== undefined) {
      atomicWriteFileSync(join(account.homePath, primaryFile), overrides[primaryFile] as string);
    }
    const captured = captureHomeToVault(account.harness, account.homePath, this.vaultDirOf(account), overrides);
    if (!captured.includes(primaryFile)) return { ok: false, reason: "primary_not_captured" };
    const at = this.now();
    const updated = this.store.recordAccountLogin(account.id, at).account;
    return { ok: true, account: updated, captured, at };
  }

  /**
   * Explicit recovery capture. It snapshots the credential that is valid
   * right now, without requiring a login flow to observe a fresh write.
   * Claude/Cursor use their external provider store when present; file-based
   * harnesses use the account home.
   */
  async captureAccount(account: AccountRow): Promise<CaptureOutcome> {
    const recipe = recipeFor(account.harness);
    if (!recipe) throw new Error(`harness ${account.harness} has no identity recipe; cannot capture credentials`);
    const primaryFile = primaryCredentialFile(recipe);
    const externalRaw = account.harness === "claude" || account.harness === "cursor"
      ? await this.externalLoginCredential(account)
      : null;
    const source: CaptureOutcome["source"] = externalRaw !== null ? "external" : "home";
    let primaryRaw = externalRaw;
    if (primaryRaw === null) {
      try {
        primaryRaw = readFileSync(join(account.homePath, primaryFile), "utf8");
      } catch {
        primaryRaw = null;
      }
    }
    const overrides = externalRaw === null ? {} : { [primaryFile]: externalRaw };
    const result = this.persistCredentialCapture(account, primaryFile, primaryRaw, overrides);
    if (!result.ok) {
      if (result.reason === "invalid_primary") {
        throw new Error(`no valid ${account.harness} credential found for ${account.id}; complete a provider login first`);
      }
      throw new Error(`failed to capture ${primaryFile} for ${account.id}`);
    }
    this.log(`account.capture account=${account.id} source=${source} files=${result.captured.join(",")}`);
    return { account: result.account, captured: result.captured, source, at: result.at };
  }

  // -------------------------------------------------------------------------
  // importer — the OLD ~/.hive/vault/accounts.json + homes layout, read-only
  // -------------------------------------------------------------------------

  /**
   * Plan (and unless dryRun, apply) an import of the old registry into
   * account rows. READ-ONLY on the old tree. Each old record becomes
   * {id, harness: tool, homePath: <homesDir>/<id>, label, penalty:
   * autoPickPenalty, status: paused|ok, addedAt}; existing rows are skipped
   * (idempotent). Also reports whether the vault entry / home dir exist so
   * the operator sees which accounts are usable.
   */
  importRegistry(root: string, opts: { dryRun?: boolean; homesDir?: string } = {}): RegistryImportReport {
    const registryPath = join(root, "vault", "accounts.json");
    const homesDir = opts.homesDir ?? join(root, "homes");
    const report: RegistryImportReport = { root, registryPath, dryRun: opts.dryRun === true, applied: false, entries: [], counts: { import: 0, skip: 0 }, byHarness: {} };
    if (!existsSync(registryPath)) {
      report.refusal = `no old registry at ${registryPath}`;
      return report;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    } catch (err) {
      report.refusal = `invalid JSON in ${registryPath}: ${err instanceof Error ? err.message : String(err)}`;
      return report;
    }
    if (!Array.isArray(parsed)) {
      report.refusal = `${registryPath} is not an array`;
      return report;
    }
    for (const raw of parsed) {
      const r = raw as Record<string, unknown>;
      if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.tool !== "string" || typeof r.label !== "string") {
        report.entries.push({ id: String((r as { id?: unknown })?.id ?? "?"), harness: String((r as { tool?: unknown })?.tool ?? "?"), action: "skip", reason: "unusable_record" });
        report.counts.skip += 1;
        continue;
      }
      const id = r.id;
      const harness = r.tool;
      const homePath = join(homesDir, id);
      const vault = vaultDirFor(join(root, "vault"), harness, id);
      const recipe = recipeFor(harness);
      const vaultHasCredentials = recipe ? dirHasCredentials(vault, recipe) : existsSync(vault);
      const homeHasCredentials = recipe ? dirHasCredentials(homePath, recipe) : existsSync(homePath);
      const entry: RegistryImportEntry = {
        id,
        harness,
        action: "import",
        homePath,
        vaultDir: vault,
        vaultHasCredentials,
        homeExists: existsSync(homePath),
        homeHasCredentials,
        penalty: typeof r.autoPickPenalty === "number" && Number.isFinite(r.autoPickPenalty) && r.autoPickPenalty > 0 && r.autoPickPenalty <= 100 ? r.autoPickPenalty : 0,
        // v18: an old record without any credential is imported logged OUT
        // (auth_needed), never as a usable-looking `ok` row.
        status: typeof r.pausedAt === "string" ? "paused" : vaultHasCredentials || homeHasCredentials ? "ok" : "auth_needed",
        addedAt: typeof r.addedAt === "string" && Number.isFinite(Date.parse(r.addedAt)) ? Date.parse(r.addedAt) : null,
      };
      if (this.store.getAccount(id)) {
        entry.action = "skip";
        entry.reason = "already_imported";
      } else if (id !== accountIdFor(harness, r.label)) {
        // Not a refusal — the old id is the identity (homes/vault dirs are named by it); note it.
        entry.note = `id differs from accountIdFor(${harness}, ${JSON.stringify(r.label)}) = ${accountIdFor(harness, r.label)}; keeping the old id`;
      }
      report.entries.push(entry);
      report.counts[entry.action] += 1;
      const bucket = (report.byHarness[harness] ??= { import: 0, skip: 0 });
      bucket[entry.action] += 1;
      if (entry.action === "import" && !report.dryRun) {
        this.store.createAccount({
          id,
          harness,
          homePath,
          label: r.label,
          penalty: entry.penalty,
          status: entry.status,
          ...(entry.addedAt !== null ? { addedAt: entry.addedAt } : {}),
        });
        this.log(`account.import id=${id} harness=${harness} home=${homePath} vaultCreds=${entry.vaultHasCredentials} homeCreds=${entry.homeHasCredentials}`);
      }
    }
    if (!report.dryRun) report.applied = true;
    return report;
  }

  /**
   * Backfill (spec 08 "a backfill maps known home paths to account ids"):
   * every bee with no account whose env home path (HOME_ENV[agent]) equals
   * an account's home_path (same harness) gets bound. Idempotent.
   */
  backfillBeeAccounts(opts: { dryRun?: boolean } = {}): BackfillReport {
    const report: BackfillReport = { dryRun: opts.dryRun === true, bound: [], unmatched: [] };
    const accounts = this.store.listAccounts();
    for (const bee of this.store.listBees()) {
      if (bee.account) continue;
      const key = homeEnvFor(bee.agent);
      const home = key ? bee.env[key] : undefined;
      if (!home) continue;
      const match = accounts.find((a) => a.harness === bee.agent && resolve(a.homePath) === resolve(home));
      if (!match) {
        report.unmatched.push({ beeId: bee.id, home });
        continue;
      }
      report.bound.push({ beeId: bee.id, account: match.id, home });
      if (!report.dryRun) {
        this.store.setBeeAccount(bee.id, match.id);
        this.log(`account.backfill bee=${bee.id} account=${match.id} home=${home}`);
      }
    }
    return report;
  }
}

export interface RegistryImportEntry {
  id: string;
  harness: string;
  action: "import" | "skip";
  reason?: "unusable_record" | "already_imported";
  note?: string;
  homePath?: string;
  vaultDir?: string;
  vaultHasCredentials?: boolean;
  homeExists?: boolean;
  homeHasCredentials?: boolean;
  penalty?: number;
  status?: AccountStatus;
  addedAt?: number | null;
}

export interface RegistryImportReport {
  root: string;
  registryPath: string;
  dryRun: boolean;
  applied: boolean;
  refusal?: string;
  entries: RegistryImportEntry[];
  counts: { import: number; skip: number };
  byHarness: Record<string, { import: number; skip: number }>;
}

export interface BackfillReport {
  dryRun: boolean;
  bound: Array<{ beeId: string; account: string; home: string }>;
  unmatched: Array<{ beeId: string; home: string }>;
}

/** The recipe files (credential + config) that exist in a dir, relative. */
function recipeFilesPresent(dir: string, recipe: NonNullable<ReturnType<typeof recipeFor>>): string[] {
  return [...recipe.credentialFiles, ...(recipe.configFiles ?? [])].filter((rel) => readIfFile(join(dir, rel)) !== null);
}

function readIfFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The old spawn note's usage cell: `Fable 16%, weekly 40%, 5h 3%` (Fable only for a Fable pick). */
export function autoPickUsage(limits: AccountLimits | undefined, model: string | undefined, now: number): string {
  if (!limits?.ok) return "";
  const cell = (label: string, window?: WindowUsage) => {
    if (!window) return null;
    const rolled = windowRolledOver(window, now);
    const velocity = !rolled && typeof window.velocityPerHour === "number" && window.velocityPerHour >= 0.5
      ? ` +${Math.round(window.velocityPerHour)}/h`
      : "";
    return `${label} ${Math.round(rolled ? 0 : window.usedPercent)}%${velocity}`;
  };
  return [
    ...(isFableModel(model) ? [cell("Fable", limits.fableWeekly)] : []),
    cell("weekly", limits.weekly),
    cell("5h", limits.fiveHour),
  ].filter(Boolean).join(", ");
}

/** Whether a directory listing has anything at all (used by the importer's report). */
export function dirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
