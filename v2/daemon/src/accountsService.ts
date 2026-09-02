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
import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "../../../src/lock.ts";
import {
  accountCommitments,
  accountIdFor,
  homeEnvFor,
  isAuthFailureLimitsError,
  limitsFromRow,
  parseClaudeCredentials,
  parseClaudeUsage,
  parseCodexRateLimits,
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
  type PutAccountLimitsInput,
  type WindowUsage,
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
  probe: "limits" | "none";
  limits: AccountLimitsRow | null;
}

/** Harnesses with either an authenticated limits read or an explicit credential-file probe. */
const PROBE_CAPABLE_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex", "grok", "kimi", "cursor", "opencode", "agy"]);

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
    return PROBE_CAPABLE_HARNESSES.has(harness);
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
    // Commitments: live bees on each account (this harness only).
    const bees = this.store.listBees().filter((b) => b.agent === harness && b.account);
    const commitments = accountCommitments(
      bees.map((b) => ({ account: b.account, runtimeState: this.store.currentRuntime(b.id)?.state ?? null })),
    );
    const rowsById = new Map<string, AccountLimitsRow>();
    for (const a of eligible) {
      const row = this.store.getAccountLimits(a.id);
      if (row) rowsById.set(a.id, row);
    }
    const scored: AutoAccountCandidate[] = eligible.map((a) => {
      const row = rowsById.get(a.id);
      return {
        account: { id: a.id, addedAt: a.addedAt, penalty: a.penalty },
        ...(row ? { limits: limitsFromRow(row) } : {}),
        commitment: commitments.get(a.id) ?? 0,
      };
    });
    const choice = selectLeastLoadedAccount(scored, now, opts.model ? { model: opts.model } : {});
    if (!choice) return { ok: false, code: "no_credentials", message: `No ${harness} account is selectable` };
    const cursor = this.store.getSelectionCursor(harness);
    const rotated = rotateNearTie(choice, scored, cursor?.lastAccountId ?? null);
    if (rotated.cursor !== null) this.store.setSelectionCursor(harness, rotated.cursor);
    const winner = eligible.find((a) => a.id === rotated.choice.account.id) as AccountRow;
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
      // A transient sampling failure is not evidence that the provider's last
      // readable snapshot became false. Keep its fetchedAt and windows so the
      // mirror and selector honestly expose stale, last-known-good data. Real
      // auth failures still replace the row and drive auth_needed below.
      const row = keepLastGood ? previous! : this.store.putAccountLimits(id, fetched);
      // The probe is the authentication check account health keys on: a REAL
      // auth failure sets auth_needed; a readable answer is contrary evidence.
      if (!fetched.readable && fetched.error && fetched.unreadableReason === "auth_failed") {
        if (this.store.setAccountStatus(id, account.status === "paused" ? "paused" : "auth_needed", `limits probe: ${fetched.error.slice(0, 200)}`).applied) {
          this.log(`account.auth_needed account=${id} by=limits_probe`);
        }
      } else if (fetched.readable && account.status === "auth_needed") {
        this.store.setAccountStatus(id, "ok", "limits probe authenticated");
        this.log(`account.auth_ok account=${id} by=limits_probe`);
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
   * owns its own refresh and is never raced by the daemon.
   */
  private async refreshClaudeCredential(account: AccountRow): Promise<ClaudeRefreshOutcome> {
    const joined = this.claudeRefreshes.get(account.id);
    if (joined) return joined;
    const pending = (async (): Promise<ClaudeRefreshOutcome> => {
      if (this.hasLiveRuntime(account.id)) return { kind: "live_runtime" };
      // Re-read inside the single-flight boundary: another limits caller or
      // harness may have advanced the chain after the first read.
      const credential = await this.freshestClaudeCredential(account);
      if (credential && credential.expiresAt > this.now()) return { kind: "ok", credential };
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
    if (!this.credentialed(account)) return { account, outcome: "absent", probe: "none", limits: null };
    if (!this.hasCredentialProbe(account.harness)) {
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
    return { account: after, outcome, probe: "limits", limits: limits ?? null };
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
  const cell = (label: string, window?: WindowUsage) =>
    window ? `${label} ${Math.round(windowRolledOver(window, now) ? 0 : window.usedPercent)}%` : null;
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
