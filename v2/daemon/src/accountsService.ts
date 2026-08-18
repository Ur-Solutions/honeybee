/**
 * AccountsService — the daemon's account plane (spec 08 CORE): the calibrated
 * `auto` selection over the store (candidates → ported selector → near-tie
 * rotation through the cursor row → one log line), the bounded in-daemon
 * limits refresh (injected provider transports; claude OAuth usage endpoint,
 * codex app-server), the login seat (detached tmux running the harness's own
 * login against the account's home; credential change detected by mtime
 * past baseline or Keychain digest drift → recipe files captured into the
 * vault → status ok), the empty-home activation hook the driver's spawn
 * resolve calls, and the read-only importer of the OLD ~/.hive/vault
 * registry into rows.
 *
 * Everything that talks to a provider or a keychain is injected; the defaults
 * are the real transports. Tests inject fakes and a fake login harness.
 */
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
  rotateNearTie,
  selectLeastLoadedAccount,
  windowRolledOver,
  isFableModel,
  type AccountLimits,
  type AccountLimitsRow,
  type AccountRow,
  type AutoAccountCandidate,
  type ClaudeUsageResponse,
  type CodexLiveRateLimits,
  type CoreStore,
  type PutAccountLimitsInput,
  type WindowUsage,
} from "../../core/src/index.ts";
import {
  activateHomeIfEmpty,
  captureHomeToVault,
  defaultHomeFor,
  dirHasCredentials,
  primaryCredentialFile,
  primaryCredentialMtime,
  seedClaudeKeychainFromVault,
  vaultDirFor,
  type ActivationResult,
} from "./activation.ts";
import type { ResolvedNodeConfig } from "./config.ts";
import { credentialDigest, readClaudeKeychain, writeClaudeKeychainEntry, type KeychainReader, type KeychainWriter } from "./keychain.ts";

// ---------------------------------------------------------------------------
// injected transports
// ---------------------------------------------------------------------------

export interface LimitsFetchers {
  /** GET api.anthropic.com/api/oauth/usage with a bearer token (default: real fetch). */
  claudeUsage?: (accessToken: string) => Promise<ClaudeUsageResponse>;
  /** `codex app-server` account/rateLimits/read against a home (default: real child process). Null = unavailable. */
  codexRateLimits?: (homePath: string) => Promise<CodexLiveRateLimits | null>;
}

export interface AccountsServiceOptions {
  store: CoreStore;
  cfg: ResolvedNodeConfig;
  log: (op: string) => void;
  now?: () => number;
  keychainReader?: KeychainReader;
  keychainWriter?: KeychainWriter;
  fetchers?: LimitsFetchers;
}

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

/** `account.login` seat handle. */
export interface LoginSeat {
  accountId: string;
  session: string;
  socket: string | null;
  attach: string;
  startedAt: number;
  deadline: number;
  primaryFile: string;
  baselineMtime: number | null;
  baselineDigest: string | null;
}

export interface LoginOutcome {
  accountId: string;
  captured: string[];
  detectedBy: "mtime" | "digest";
  at: number;
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

/**
 * Query `codex app-server` (JSON-RPC over stdio) for the account's live rate
 * limits, with CODEX_HOME pointed at the account's home. Null on any failure
 * — missing binary, stale auth, protocol drift. Bounded by `timeoutMs`.
 */
function defaultCodexRateLimits(timeoutMs: number, command = "codex"): NonNullable<LimitsFetchers["codexRateLimits"]> {
  return (homePath) =>
    new Promise<CodexLiveRateLimits | null>((resolvePromise) => {
      let child: ReturnType<typeof spawnChild>;
      try {
        child = spawnChild(command, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CODEX_HOME: homePath } });
      } catch {
        resolvePromise(null);
        return;
      }
      let settled = false;
      const finish = (value: CodexLiveRateLimits | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolvePromise(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      child.on("error", () => finish(null));
      child.on("exit", () => finish(null));
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
              finish(null);
              return;
            }
            child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })}\n`);
          }
          if (message.id === 2) {
            const rateLimits = message.result?.rateLimits as CodexLiveRateLimits | undefined;
            finish(rateLimits && (rateLimits.primary || rateLimits.secondary) ? rateLimits : null);
            return;
          }
        }
      });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "hive", title: "hive", version: "0.0.1" } } })}\n`,
      );
    });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  private readonly fetchers: Required<LimitsFetchers>;
  private readonly seats = new Map<string, LoginSeat>();
  private pollingSeats = false;
  private lastPeriodicRefreshAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(opts: AccountsServiceOptions) {
    this.store = opts.store;
    this.cfg = opts.cfg;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.keychainReader = opts.keychainReader ?? readClaudeKeychain;
    this.keychainWriter = opts.keychainWriter ?? writeClaudeKeychainEntry;
    this.fetchers = {
      claudeUsage: opts.fetchers?.claudeUsage ?? defaultClaudeUsage(this.cfg.accounts.limitsFetchTimeoutMs),
      codexRateLimits: opts.fetchers?.codexRateLimits ?? defaultCodexRateLimits(this.cfg.accounts.limitsFetchTimeoutMs, this.cfg.agents.codex?.command ?? "codex"),
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
   * "Vault credentials present" (spec 08 candidate rule 1) — in the
   * home-authoritative world the HOME counts too: an account whose home is
   * already logged in is usable even before a capture; an account whose vault
   * is seeded can activate an empty home. Unknown harness (no recipe) = the
   * home is the account (singleton harnesses without a recipe are always
   * candidates).
   */
  credentialed(account: AccountRow): boolean {
    const recipe = recipeFor(account.harness);
    if (!recipe) return true;
    return dirHasCredentials(this.vaultDirOf(account), recipe) || dirHasCredentials(account.homePath, recipe);
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
   * near-tie rotates through the per-harness cursor row. Synchronous — the
   * caller refreshes stale limits first (ensureFreshLimits) when it can.
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

  /** The candidate ids a pick would consider (for "refresh stale before pick"). */
  private candidateIdsFor(harness: string, opts: PickOptions): string[] {
    return this.store
      .listAccounts({ harness })
      .filter((a) => a.status !== "paused" && this.credentialed(a) && !opts.excludeAccountIds?.has(a.id))
      .map((a) => a.id);
  }

  /**
   * Freshness policy (spec 08 "Limits"): before an `auto` pick, refresh the
   * rows older than limitsStaleMs (or missing) for the harness's candidates —
   * bounded, in-daemon, and only when more than one candidate exists (a lone
   * candidate never pays a provider round-trip). Failures are recorded as
   * unreadable rows and never block the pick.
   */
  async ensureFreshLimits(harness: string, opts: PickOptions = {}): Promise<{ refreshed: string[] }> {
    const ids = this.candidateIdsFor(harness, opts);
    if (ids.length < 2) return { refreshed: [] };
    const now = this.now();
    const stale = ids.filter((id) => {
      const row = this.store.getAccountLimits(id);
      return !row || now - row.fetchedAt > this.cfg.accounts.limitsStaleMs;
    });
    if (stale.length === 0) return { refreshed: [] };
    await this.refreshLimits(stale);
    return { refreshed: stale };
  }

  // -------------------------------------------------------------------------
  // limits — bounded in-daemon fetch
  // -------------------------------------------------------------------------

  /** Refresh limits for the given accounts (all when omitted). Serialized: a concurrent call joins the in-flight sweep. */
  async refreshLimits(accountIds?: string[]): Promise<AccountLimitsRow[]> {
    const ids = accountIds ?? this.store.listAccounts().map((a) => a.id);
    const out: AccountLimitsRow[] = [];
    for (const id of ids) {
      const account = this.store.getAccount(id);
      if (!account) continue;
      const fetched = await this.fetchOne(account);
      if (!this.store.getAccount(id)) continue; // removed mid-fetch
      const row = this.store.putAccountLimits(id, fetched);
      // The probe is the authentication check account health keys on: a REAL
      // auth failure sets auth_needed; a readable answer is contrary evidence.
      if (!fetched.readable && fetched.error && isAuthFailureLimitsError(fetched.error)) {
        if (this.store.setAccountStatus(id, account.status === "paused" ? "paused" : "auth_needed", `limits probe: ${fetched.error.slice(0, 200)}`).applied) {
          this.log(`account.auth_needed account=${id} by=limits_probe`);
        }
      } else if (fetched.readable && account.status === "auth_needed") {
        this.store.setAccountStatus(id, "ok", "limits probe authenticated");
        this.log(`account.auth_ok account=${id} by=limits_probe`);
      }
      this.log(`account.limits account=${id} readable=${row.readable}${row.readable ? ` weekly=${row.weeklyPct ?? "-"} 5h=${row.fiveHourPct ?? "-"}` : ` error=${JSON.stringify(row.error)}`}`);
      out.push(row);
    }
    return out;
  }

  /** One account's limits via its harness's transport; never throws (an unreadable row instead). */
  private async fetchOne(account: AccountRow): Promise<PutAccountLimitsInput> {
    const timeout = this.cfg.accounts.limitsFetchTimeoutMs;
    try {
      const attempt = this.fetchByHarness(account);
      const bounded = new Promise<PutAccountLimitsInput>((_, reject) => setTimeout(() => reject(new Error(`limits fetch timed out after ${timeout}ms`)), timeout).unref());
      return await Promise.race([attempt, bounded]);
    } catch (err) {
      return { readable: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
    }
  }

  private async fetchByHarness(account: AccountRow): Promise<PutAccountLimitsInput> {
    switch (account.harness) {
      case "claude": {
        const credential = await this.freshestClaudeCredential(account);
        if (!credential) return { readable: false, error: "no OAuth token found in home, keychain, or vault" };
        if (credential.expiresAt <= this.now()) {
          return { readable: false, error: "OAuth token expired; a running claude refreshes it, or log in: hive v2 account login " + account.id };
        }
        const usage = await this.fetchers.claudeUsage(credential.accessToken);
        return parseClaudeUsage(usage, credential.subscriptionType ?? null);
      }
      case "codex": {
        const limits = await this.fetchers.codexRateLimits(account.homePath);
        if (!limits) return { readable: false, error: "codex app-server did not answer account/rateLimits/read" };
        return parseCodexRateLimits(limits);
      }
      default:
        return { readable: false, error: `${account.harness} has no limits source` };
    }
  }

  /**
   * The freshest claude OAuth credential for the account: the HOME's
   * .credentials.json and Keychain item (the live chain, refreshed on use)
   * and the vault snapshot, by expiresAt. Location is the account's own home
   * — no cross-home candidate pool, no identity arbitration (one account =
   * one home in v2).
   */
  private async freshestClaudeCredential(account: AccountRow): Promise<{ accessToken: string; expiresAt: number; subscriptionType?: string } | null> {
    const candidates: Array<{ accessToken: string; expiresAt: number; subscriptionType?: string }> = [];
    const push = (raw: string | null) => {
      const parsed = parseClaudeCredentials(raw);
      if (parsed) candidates.push(parsed);
    };
    push(readIfFile(join(account.homePath, ".credentials.json")));
    push(await this.keychainReader(account.homePath).catch(() => null));
    push(readIfFile(join(this.vaultDirOf(account), ".credentials.json")));
    candidates.sort((a, b) => b.expiresAt - a.expiresAt);
    return candidates[0] ?? null;
  }

  /** Tick hook: the periodic refresh (every limitsRefreshMs while the daemon runs; 0 = off). Never overlaps itself. */
  periodicRefreshTick(): void {
    const every = this.cfg.accounts.limitsRefreshMs;
    if (every <= 0 || this.refreshing) return;
    const now = this.now();
    if (now - this.lastPeriodicRefreshAt < every) return;
    this.lastPeriodicRefreshAt = now;
    if (this.store.listAccounts().length === 0) return;
    this.refreshing = this.refreshLimits()
      .then(() => undefined)
      .catch((err) => this.log(`account.limits.sweep_error ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.refreshing = null;
      });
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
  // login seat
  // -------------------------------------------------------------------------

  seatOf(accountId: string): LoginSeat | null {
    return this.seats.get(accountId) ?? null;
  }

  private tmuxArgs(...args: string[]): string[] {
    const socket = this.cfg.accounts.tmuxSocket;
    return socket ? ["-L", socket, ...args] : args;
  }

  private tmuxHasSession(session: string): boolean {
    const r = spawnSync("tmux", this.tmuxArgs("has-session", "-t", `=${session}`), { stdio: "ignore" });
    return r.status === 0;
  }

  private tmuxKill(session: string): void {
    spawnSync("tmux", this.tmuxArgs("kill-session", "-t", `=${session}`), { stdio: "ignore" });
  }

  /**
   * Start (or rejoin) the login seat for an account: a detached tmux session
   * running the harness's own login against the account's home, with the
   * home env set. Records the freshness baseline (primary credential mtime;
   * for claude also the Keychain digest) and registers a watch the tick loop
   * polls. Returns the seat handle (attach hint) immediately — the login is
   * interactive; the operator completes it in the seat.
   */
  async startLogin(account: AccountRow): Promise<{ seat: LoginSeat; rejoined: boolean }> {
    const recipe = recipeFor(account.harness);
    if (!recipe) throw new Error(`harness ${account.harness} has no identity recipe; cannot run a login seat`);
    const existing = this.seats.get(account.id);
    const session = `hive-login-${account.id}`.replace(/[^A-Za-z0-9_.-]/g, "-");
    if (existing && this.tmuxHasSession(session)) return { seat: existing, rejoined: true };
    mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
    const login = this.cfg.agents[account.harness]?.login ?? recipe.login;
    const env = { ...(this.cfg.agents[account.harness]?.env ?? {}), ...this.homeEnvOf(account) };
    const baselineMtime = primaryCredentialMtime(account.homePath, recipe);
    const keychainRaw = account.harness === "claude" ? await this.keychainReader(account.homePath).catch(() => null) : null;
    const baselineDigest = keychainRaw ? credentialDigest(keychainRaw) : null;
    if (this.tmuxHasSession(session)) this.tmuxKill(session);
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const command = [login.command, ...(login.args ?? [])].map(shellQuote).join(" ");
    const r = spawnSync("tmux", this.tmuxArgs("new-session", "-d", "-s", session, "-c", account.homePath, ...envArgs, command), { stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) {
      throw new Error(`could not start the login seat (tmux exited ${r.status}): ${String(r.stderr ?? "").trim() || String(r.stdout ?? "").trim()}`);
    }
    const now = this.now();
    const socket = this.cfg.accounts.tmuxSocket;
    const seat: LoginSeat = {
      accountId: account.id,
      session,
      socket,
      attach: `tmux ${socket ? `-L ${socket} ` : ""}attach -t ${session}`,
      startedAt: now,
      deadline: now + this.cfg.accounts.loginTimeoutMs,
      primaryFile: primaryCredentialFile(recipe),
      baselineMtime,
      baselineDigest,
    };
    this.seats.set(account.id, seat);
    this.log(`account.login.seat account=${account.id} session=${session} home=${account.homePath} baselineMtime=${baselineMtime ?? "-"} baselineDigest=${baselineDigest ? baselineDigest.slice(0, 8) : "-"}`);
    return { seat, rejoined: false };
  }

  /**
   * Tick hook: poll every open seat for the credential change (mtime past
   * the baseline, or Keychain digest drift for claude); on detection capture
   * the recipe files into the vault (claude: the Keychain item as the vault's
   * .credentials.json — the authoritative credential), mark the account ok +
   * last_login_at, tear the seat down. Returns the completed logins so the
   * daemon can clear bee flags. Bounded by the seat deadline.
   */
  async pollLoginSeats(): Promise<LoginOutcome[]> {
    if (this.pollingSeats || this.seats.size === 0) return [];
    this.pollingSeats = true;
    const done: LoginOutcome[] = [];
    try {
      for (const seat of [...this.seats.values()]) {
        const account = this.store.getAccount(seat.accountId);
        if (!account) {
          this.seats.delete(seat.accountId);
          this.tmuxKill(seat.session);
          continue;
        }
        const now = this.now();
        const recipe = recipeFor(account.harness);
        if (!recipe) {
          this.seats.delete(seat.accountId);
          continue;
        }
        const mtime = primaryCredentialMtime(account.homePath, recipe);
        let detectedBy: LoginOutcome["detectedBy"] | null = null;
        let keychainRaw: string | null = null;
        if (mtime !== null && (seat.baselineMtime === null || mtime > seat.baselineMtime)) detectedBy = "mtime";
        if (!detectedBy && account.harness === "claude") {
          keychainRaw = await this.keychainReader(account.homePath).catch(() => null);
          const digest = keychainRaw ? credentialDigest(keychainRaw) : null;
          if (digest !== null && digest !== seat.baselineDigest) detectedBy = "digest";
        }
        if (detectedBy) {
          if (account.harness === "claude" && !keychainRaw) keychainRaw = await this.keychainReader(account.homePath).catch(() => null);
          const overrides: Record<string, string> = {};
          if (account.harness === "claude" && keychainRaw && parseClaudeCredentials(keychainRaw)) overrides[".credentials.json"] = keychainRaw;
          const captured = captureHomeToVault(account.harness, account.homePath, this.vaultDirOf(account), overrides);
          this.store.recordAccountLogin(account.id, now);
          this.seats.delete(seat.accountId);
          this.tmuxKill(seat.session);
          this.log(`account.login.captured account=${account.id} by=${detectedBy} files=${captured.join(",")}`);
          done.push({ accountId: account.id, captured, detectedBy, at: now });
          continue;
        }
        if (now > seat.deadline) {
          this.seats.delete(seat.accountId);
          this.log(`account.login.timeout account=${account.id} session=${seat.session} (seat left running: ${seat.attach})`);
          continue;
        }
        if (!this.tmuxHasSession(seat.session)) {
          this.seats.delete(seat.accountId);
          this.log(`account.login.exited account=${account.id} session=${seat.session} without a credential change`);
        }
      }
    } finally {
      this.pollingSeats = false;
    }
    return done;
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
      const entry: RegistryImportEntry = {
        id,
        harness,
        action: "import",
        homePath,
        vaultDir: vault,
        vaultHasCredentials: recipe ? dirHasCredentials(vault, recipe) : existsSync(vault),
        homeExists: existsSync(homePath),
        homeHasCredentials: recipe ? dirHasCredentials(homePath, recipe) : existsSync(homePath),
        penalty: typeof r.autoPickPenalty === "number" && Number.isFinite(r.autoPickPenalty) && r.autoPickPenalty > 0 && r.autoPickPenalty <= 100 ? r.autoPickPenalty : 0,
        status: typeof r.pausedAt === "string" ? "paused" : "ok",
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
  status?: "ok" | "paused";
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
