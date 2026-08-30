/**
 * LoginFlowService — the daemon's account LOGIN plane (tmux-independent
 * login, operator decision 2026-08-28). Owns every login flow end to end:
 *
 *  - the durable, mirrored flow row (`login_flows`; one active per account)
 *  - the provider recipe's advertised methods, each executed by a runner
 *    behind one contract (login/runner.ts):
 *      claude_oauth → direct PKCE + pasted code        (login/claudeOauth.ts)
 *      direct_key   → Codex / OpenCode API keys        (login/directKey.ts)
 *      cli          → the harness's own login CLI in a Honeybee-owned
 *                     native worker whose parsed progress drives phases
 *                                                     (login/cliRunner.ts)
 *  - input routing (typed values only reach the field the flow asked for)
 *  - expiry, cancel, retry (new revision), method switching, runner
 *    cleanup, daemon-restart reconciliation, legacy tmux-seat cleanup
 *
 * The service is the flow row's only writer: runners transition their flow
 * through a scoped host, and a superseded runner's late events are dropped.
 *
 * Secret safety: typed values live in local variables for the duration of
 * one submit; they are never logged, audited, stored on the flow row, or
 * recorded as an idempotency result. Worker output stays inside the worker.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  defaultLoginMethodId,
  loginMethodFor,
  loginMethodsFor,
  recipeFor,
  type AccountRow,
  type CoreStore,
  type LoginFieldDescriptor,
  type LoginFlowError,
  type LoginFlowPatch,
  type LoginFlowRow,
  type LoginMethodDescriptor,
  type LoginMethodRun,
} from "../../core/src/index.ts";
import type { AccountsService } from "./accountsService.ts";
import type { ResolvedNodeConfig } from "./config.ts";
import { ClaudeOauthRunner } from "./login/claudeOauth.ts";
import { CliRunner } from "./login/cliRunner.ts";
import { STATIC_DETAIL, err, isTerminal, safeMessage } from "./login/common.ts";
import { DirectKeyRunner } from "./login/directKey.ts";
import type { LoginRunner, LoginRunnerHost } from "./login/runner.ts";
import { defaultLoginTransports, type LoginTransports } from "./login/transports.ts";
import { loadNodePtySpawner, type LoginWorkerStatus, type PtySpawner } from "./loginWorker.ts";

// Stable public surface: the pieces tests and the daemon reach for by name.
export { claudeAuthorizeUrl, splitClaudeCode } from "./login/claudeOauth.ts";
export { LANDING_CHECK_INTERVAL_MS, WORKER_ENV_ALLOWLIST, workerBaseEnv } from "./login/cliRunner.ts";
export { plausibleApiKey, plausibleOption } from "./login/directKey.ts";
export {
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REDIRECT_URI,
  CLAUDE_OAUTH_SCOPES,
  CLAUDE_OAUTH_TOKEN_URL,
  defaultLoginTransports,
} from "./login/transports.ts";
export type { ClaudeTokenGrant, KeyCheck, LoginTransports } from "./login/transports.ts";
export type { LoginRunner, LoginRunnerHost, LoginRunnerKind } from "./login/runner.ts";
export type { LoginFieldDescriptor };

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export interface LoginFlowServiceOptions {
  store: CoreStore;
  cfg: ResolvedNodeConfig;
  accounts: AccountsService;
  log: (op: string) => void;
  now?: () => number;
  transports?: Partial<LoginTransports>;
  /** PTY backend override (tests inject a fake); undefined = resolve from config at first use. */
  spawner?: PtySpawner | null;
  /** How the PTY backend is loaded when `spawner` is not injected. */
  loadSpawner?: () => Promise<PtySpawner | null>;
  /** Called after a flow succeeded and the account row is updated (the daemon clears bee auth_needed flags). */
  onCompleted?: (accountId: string) => void;
  /** Shell-out for the legacy tmux-seat cleanup (tests inject a recorder). */
  tmuxExec?: (args: string[]) => { status: number | null; stdout: string };
  /** Grace for worker termination. */
  workerKillGraceMs?: number;
  /** Parser settle window for the worker (tests shrink it). */
  workerSettleMs?: number;
}

type RecipeMethod = LoginMethodDescriptor & { run: LoginMethodRun };

export class LoginFlowService {
  private readonly store: CoreStore;
  private readonly cfg: ResolvedNodeConfig;
  private readonly accounts: AccountsService;
  private readonly log: (op: string) => void;
  private readonly now: () => number;
  private readonly transports: LoginTransports;
  private readonly onCompleted: (accountId: string) => void;
  private readonly tmuxExec: (args: string[]) => { status: number | null; stdout: string };
  private readonly runners = new Map<string, LoginRunner>();
  /** Flows whose runner is being replaced (selectMethod / live retry): submits are refused meanwhile. */
  private readonly switching = new Set<string>();
  private spawner: PtySpawner | null | undefined;
  private spawnerLoading: Promise<PtySpawner | null> | null = null;
  private readonly loadSpawner: () => Promise<PtySpawner | null>;
  private readonly workerKillGraceMs: number;
  private readonly workerSettleMs: number | undefined;
  private ticking = false;
  private stopping = false;

  constructor(opts: LoginFlowServiceOptions) {
    this.store = opts.store;
    this.cfg = opts.cfg;
    this.accounts = opts.accounts;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.transports = { ...defaultLoginTransports(opts.cfg.accounts.limitsFetchTimeoutMs), ...opts.transports };
    this.onCompleted = opts.onCompleted ?? (() => undefined);
    this.tmuxExec = opts.tmuxExec ?? ((args) => {
      const r = spawnSync("tmux", args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
      return { status: r.status, stdout: String(r.stdout ?? "") };
    });
    this.spawner = opts.spawner;
    this.loadSpawner = opts.loadSpawner ?? (async () => (this.cfg.accounts.loginWorkerBackend === "pipe" ? null : loadNodePtySpawner()));
    this.workerKillGraceMs = opts.workerKillGraceMs ?? 1500;
    this.workerSettleMs = opts.workerSettleMs;
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  flowOf(flowId: string): LoginFlowRow | null {
    return this.store.getLoginFlow(flowId);
  }

  /** Bounded, redacted worker status for diagnostics (never terminal contents). */
  workerStatus(flowId: string): LoginWorkerStatus | null {
    return this.runners.get(flowId)?.workerStatus() ?? null;
  }

  /** Whether the flow has a live in-memory runner (a daemon restart loses these). */
  hasRunner(flowId: string): boolean {
    return this.runners.has(flowId);
  }

  // -------------------------------------------------------------------------
  // verbs
  // -------------------------------------------------------------------------

  /**
   * Start or rejoin. One active flow per account: a live flow is returned as
   * `rejoined` without spawning a second worker. Terminal predecessors are
   * pruned by the store. Method choice: explicit (validated) → recipe default
   * (remote default when `remote`). A harness with no recipe / no
   * remote-capable method still gets a flow row — failed with a typed
   * refusal — so clients render one honest answer instead of an RPC error.
   */
  async start(account: AccountRow, opts: { methodId?: string | null; remote?: boolean } = {}): Promise<{ flow: LoginFlowRow; rejoined: boolean }> {
    const active = this.store.activeLoginFlow(account.id);
    if (active) {
      if (!this.runners.has(active.id)) {
        // No runner (the daemon restarted under it): settle it as interrupted and start fresh.
        this.patch(active.id, { phase: "interrupted", detail: null, inputFields: [], error: err("daemon_restarted", "Honeybee restarted while this sign-in was running."), retryable: true }, "no runner");
      } else {
        return { flow: active, rejoined: true };
      }
    }
    const remote = opts.remote === true;
    const methods = loginMethodsFor(account.harness);
    const flow = this.store.createLoginFlow({
      id: randomUUID(),
      account: account.id,
      harness: account.harness,
      methods: remote ? methods.filter((m) => m.remoteCapable) : methods,
      phase: "starting",
      detail: STATIC_DETAIL.starting,
      remote,
      expiresAt: this.now() + this.cfg.accounts.loginTimeoutMs,
    });
    this.log(`account.login.start account=${account.id} flow=${flow.id} harness=${account.harness} remote=${remote}`);
    const methodId = defaultLoginMethodId(account.harness, { remote, requested: opts.methodId ?? null });
    if (!methodId) {
      const refusal = !recipeFor(account.harness)
        ? err("unsupported_method", `${account.harness} has no login recipe; add one to Honeybee's account recipes.`)
        : opts.methodId
          ? err("unsupported_method", `${account.harness} does not offer the login method '${opts.methodId}'${remote ? " for a remote node" : ""}.`)
          : err("remote_loopback_unsupported", `${account.harness} can only sign in with a browser on the node itself; run the login on that machine or use an API key where offered.`);
      return { flow: this.fail(flow.id, refusal, false), rejoined: false };
    }
    return { flow: await this.run(flow.id, methodId), rejoined: false };
  }

  /** Switch method on an active flow: stop the current runner, bump the revision, start the new method. */
  async selectMethod(flowId: string, methodId: string): Promise<LoginFlowRow> {
    const flow = this.mustActive(flowId);
    if (!flow.methods.some((m) => m.id === methodId)) throw new LoginFlowRefusal("login_method_unsupported", `login flow ${flowId} does not offer method '${methodId.slice(0, 64)}'`);
    if (flow.methodId === methodId && !flow.error) return flow;
    this.switching.add(flowId);
    try {
      await this.stopRunner(flowId);
      // A cancel (or expiry) that landed while the old worker was dying wins.
      const current = this.mustActive(flowId);
      this.patch(flowId, { revision: current.revision + 1, phase: "starting", detail: STATIC_DETAIL.starting, authorizationUrl: null, userCode: null, inputFields: [], error: null, retryable: false, provider: null, completedAt: null }, "method selected");
    } finally {
      this.switching.delete(flowId);
    }
    return this.run(flowId, methodId);
  }

  /**
   * Deliver requested input. Only the fields in `inputFields` are accepted;
   * required ones must be present. Values are consumed here and dropped.
   */
  async submit(flowId: string, values: Record<string, string>): Promise<LoginFlowRow> {
    const flow = this.mustActive(flowId);
    if (flow.phase !== "waiting_input" || flow.inputFields.length === 0) {
      throw new LoginFlowRefusal("login_flow_refused", `login flow ${flowId} is not waiting for input (phase ${flow.phase})`);
    }
    const requested = new Map(flow.inputFields.map((f) => [f.id, f]));
    for (const key of Object.keys(values)) {
      if (!requested.has(key)) throw new LoginFlowRefusal("login_flow_refused", `login flow ${flowId} is not requesting field '${key.slice(0, 64)}'`);
      if (typeof values[key] !== "string") throw new LoginFlowRefusal("invalid_request", `field '${key}' must be a string`);
    }
    for (const field of flow.inputFields) {
      if (field.required && !(values[field.id] ?? "").trim()) throw new LoginFlowRefusal("invalid_request", `field '${field.id}' is required`);
    }
    if (this.switching.has(flowId)) throw new LoginFlowRefusal("login_flow_refused", `login flow ${flowId} is switching method; wait for the new prompt`);
    const runner = this.runners.get(flowId);
    if (!runner) {
      return this.patch(flowId, { phase: "interrupted", inputFields: [], error: err("daemon_restarted", "Honeybee restarted while this sign-in was waiting; retry to get a fresh sign-in."), retryable: true }, "no runner on submit");
    }
    if (!flow.methodId || !loginMethodFor(flow.harness, flow.methodId)) throw new LoginFlowRefusal("login_flow_refused", `login flow ${flowId} has no method`);
    if (!this.store.getAccount(flow.account)) throw new LoginFlowRefusal("login_flow_not_found", `login flow ${flowId} belongs to a removed account`);
    // The fields the flow asked for, captured before `validating` clears them.
    const fields = flow.inputFields.map((f) => ({ ...f }));
    this.patch(flowId, { phase: "validating", detail: STATIC_DETAIL.validating, inputFields: [], error: null }, "input received");
    try {
      return await runner.submit(values, fields);
    } catch (error) {
      return this.fail(flowId, err("provider_error", `The provider could not be reached: ${safeMessage(error)}`), true);
    }
  }

  /** Retry a terminal (non-succeeded) flow as a new revision with the same method. */
  async retry(flowId: string): Promise<LoginFlowRow> {
    const flow = this.mustFlow(flowId);
    if (flow.phase === "succeeded") throw new LoginFlowRefusal("login_flow_refused", `login flow ${flowId} already succeeded`);
    const account = this.store.getAccount(flow.account);
    if (!account) throw new LoginFlowRefusal("login_flow_not_found", `login flow ${flowId} belongs to a removed account`);
    if (!isTerminal(flow.phase) && this.runners.has(flowId)) {
      // A live flow "retried" = restart its method (fresh URL / worker).
      this.switching.add(flowId);
      try {
        await this.stopRunner(flowId);
        this.mustActive(flowId); // a cancel that landed meanwhile wins
      } finally {
        this.switching.delete(flowId);
      }
    }
    const remote = flow.remote;
    const methodId = flow.methodId ?? defaultLoginMethodId(flow.harness, { remote });
    if (!methodId) {
      return this.fail(
        flowId,
        recipeFor(flow.harness)
          ? err("remote_loopback_unsupported", `${flow.harness} has no login method usable from a remote node.`)
          : err("unsupported_method", `${flow.harness} has no login recipe.`),
        false,
      );
    }
    const latest = this.mustFlow(flowId);
    this.patch(
      flowId,
      {
        revision: latest.revision + 1,
        phase: "starting",
        detail: STATIC_DETAIL.starting,
        authorizationUrl: null,
        userCode: null,
        inputFields: [],
        error: null,
        retryable: false,
        completedAt: null,
        expiresAt: this.now() + this.cfg.accounts.loginTimeoutMs,
      },
      "retry",
    );
    this.log(`account.login.retry flow=${flowId} revision=${flow.revision + 1}`);
    return this.run(flowId, methodId);
  }

  /** Cancel: stop the worker, mark cancelled. Terminal flows are a no-op (a completed login is never un-done). */
  cancel(flowId: string): { flow: LoginFlowRow; applied: boolean } {
    const flow = this.mustFlow(flowId);
    if (isTerminal(flow.phase)) return { flow, applied: false };
    void this.stopRunner(flowId);
    const updated = this.patch(flowId, { phase: "cancelled", detail: null, inputFields: [], error: err("cancelled_by_user", "Sign-in cancelled."), retryable: true }, "cancelled");
    this.log(`account.login.cancel flow=${flowId}`);
    return { flow: updated, applied: true };
  }

  // -------------------------------------------------------------------------
  // lifecycle hooks
  // -------------------------------------------------------------------------

  /**
   * Boot: every flow that was live when the previous daemon died has no
   * worker any more (a PTY cannot be re-adopted across processes). Mark them
   * `interrupted` + retryable — never auto-restart (that would open a browser
   * the operator did not ask for). Then remove legacy tmux login seats this
   * daemon's predecessors created, resolving exact ownership by name.
   */
  reconcileAtBoot(): { interrupted: string[]; legacySeatsKilled: string[] } {
    const interrupted: string[] = [];
    for (const flow of this.store.listLoginFlows()) {
      if (isTerminal(flow.phase) || this.runners.has(flow.id)) continue;
      this.patch(flow.id, { phase: "interrupted", detail: null, inputFields: [], authorizationUrl: null, userCode: null, error: err("daemon_restarted", "Honeybee restarted while this sign-in was running. Retry to get a fresh sign-in."), retryable: true }, "daemon restart");
      interrupted.push(flow.id);
    }
    const legacySeatsKilled = this.cleanupLegacyLoginSeats();
    if (interrupted.length > 0 || legacySeatsKilled.length > 0) {
      this.log(`account.login.boot interrupted=${interrupted.length} legacySeatsKilled=${legacySeatsKilled.length}`);
    }
    return { interrupted, legacySeatsKilled };
  }

  /**
   * Legacy `hive-login-<account>` tmux sessions (the retired login seat) are
   * killed ONLY when their exact name matches an account this store knows
   * (tmux rewrites `.`/`:` to `_`; the same normalization is applied here).
   * Any other session is somebody else's and is never touched.
   */
  cleanupLegacyLoginSeats(): string[] {
    const socket = this.cfg.accounts.tmuxSocket;
    const base = socket ? ["-L", socket] : [];
    const listed = this.tmuxExec([...base, "list-sessions", "-F", "#S"]);
    if (listed.status !== 0) return [];
    const owned = new Set(this.store.listAccounts().map((a) => legacyLoginSeatName(a.id)));
    const killed: string[] = [];
    for (const name of listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (!name.startsWith("hive-login-") || !owned.has(name)) continue;
      const r = this.tmuxExec([...base, "kill-session", "-t", `=${name}:`]);
      if (r.status === 0) {
        killed.push(name);
        this.log(`account.login.legacy_seat_killed session=${name}`);
      }
    }
    return killed;
  }

  /** Tick: expiry, orphaned runners (flow/account removed), and each live runner's periodic work (credential-landing checks). */
  tick(): void {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const [flowId, runner] of [...this.runners.entries()]) {
        const flow = this.store.getLoginFlow(flowId);
        if (!flow || isTerminal(flow.phase)) {
          // Row gone (account removed / superseded) or settled elsewhere: no worker may outlive its flow.
          void this.stopRunner(flowId);
          continue;
        }
        if (!this.store.getAccount(flow.account)) {
          void this.stopRunner(flowId);
          this.store.removeLoginFlow(flowId, "account_removed");
          continue;
        }
        if (now > flow.expiresAt) {
          void this.stopRunner(flowId);
          this.patch(flowId, { phase: "expired", detail: null, inputFields: [], error: err("timeout", "The sign-in took too long and expired. Retry to get a fresh sign-in."), retryable: true }, "expired");
          this.log(`account.login.expired flow=${flowId}`);
          continue;
        }
        runner.tick(now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Shutdown: no login worker may outlive the daemon. Flows stay as they are; boot marks them interrupted. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.runners.keys()].map((flowId) => this.stopRunner(flowId)));
  }

  /** The account is being removed: stop its worker first (the store cascades the rows). */
  async abandonAccount(accountId: string): Promise<void> {
    for (const flow of this.store.listLoginFlows({ account: accountId })) await this.stopRunner(flow.id);
  }

  // -------------------------------------------------------------------------
  // runners
  // -------------------------------------------------------------------------

  /** Register the method's runner for the flow and start it; any throw is a typed provider_error. */
  private async run(flowId: string, methodId: string): Promise<LoginFlowRow> {
    const flow = this.mustFlow(flowId);
    if (isTerminal(flow.phase)) return flow;
    const account = this.store.getAccount(flow.account);
    if (!account) throw new LoginFlowRefusal("login_flow_not_found", `login flow ${flowId} belongs to a removed account`);
    const method = loginMethodFor(flow.harness, methodId);
    if (!method) return this.fail(flowId, err("unsupported_method", `${flow.harness} does not offer '${methodId}'.`), false);
    this.patch(flowId, { methodId }, "method");
    const runner = this.createRunner(this.hostFor(flowId, account, method));
    if (!runner) return this.fail(flowId, err("unsupported_method", `unknown direct runner`), false);
    this.runners.set(flowId, runner);
    try {
      return await runner.start();
    } catch (error) {
      return this.fail(flowId, err("provider_error", safeMessage(error)), true);
    }
  }

  /** One runner per `LoginMethodRun` shape; null for a direct runner this daemon does not know. */
  private createRunner(host: LoginRunnerHost): LoginRunner | null {
    const run = host.method.run;
    if (run.mode === "cli") return new CliRunner(host, run.cli);
    switch (run.runner) {
      case "claude_oauth":
        return new ClaudeOauthRunner(host);
      case "codex_api_key":
      case "opencode_api_key":
        return new DirectKeyRunner(host, run.runner);
      default:
        return null;
    }
  }

  /** The service's write path, scoped to one flow — what a runner is allowed to do. */
  private hostFor(flowId: string, account: AccountRow, method: RecipeMethod): LoginRunnerHost {
    return {
      flowId,
      account,
      method,
      store: this.store,
      accounts: this.accounts,
      cfg: this.cfg,
      transports: this.transports,
      log: this.log,
      now: this.now,
      workerKillGraceMs: this.workerKillGraceMs,
      workerSettleMs: this.workerSettleMs,
      flow: () => this.store.getLoginFlow(flowId),
      stillActive: () => this.stillActive(flowId),
      isCurrent: (runner) => this.runners.get(flowId) === runner,
      release: (runner) => {
        if (this.runners.get(flowId) === runner) this.runners.delete(flowId);
      },
      resolveSpawner: () => this.resolveSpawner(),
      patch: (patch, reason) => this.patch(flowId, patch, reason),
      fail: (error, retryable) => this.fail(flowId, error, retryable),
      reask: (error) => this.reask(flowId, error),
      succeed: (detail) => this.succeed(flowId, account.id, detail),
    };
  }

  private async resolveSpawner(): Promise<PtySpawner | null> {
    if (this.spawner !== undefined) return this.spawner;
    if (!this.spawnerLoading) {
      this.spawnerLoading = this.loadSpawner()
        .then((s) => {
          this.spawner = s;
          return s;
        })
        .catch(() => {
          this.spawner = null;
          return null;
        });
    }
    return this.spawnerLoading;
  }

  // -------------------------------------------------------------------------
  // state helpers
  // -------------------------------------------------------------------------

  private patch(flowId: string, patch: LoginFlowPatch, reason: string): LoginFlowRow {
    return this.store.updateLoginFlow(flowId, patch, reason).flow;
  }

  private fail(flowId: string, error: LoginFlowError, retryable: boolean): LoginFlowRow {
    const flow = this.store.getLoginFlow(flowId);
    if (!flow || isTerminal(flow.phase)) return flow as LoginFlowRow;
    void this.stopRunner(flowId);
    this.log(`account.login.failed flow=${flowId} code=${error.code}`);
    return this.patch(flowId, { phase: "failed", detail: null, inputFields: [], error, retryable }, `failed: ${error.code}`);
  }

  /** Validation failed: back to waiting_input with a typed error; the runner stays so the operator can try again. */
  private reask(flowId: string, error: LoginFlowError): LoginFlowRow {
    const flow = this.store.getLoginFlow(flowId);
    if (!flow || isTerminal(flow.phase)) return flow as LoginFlowRow;
    const method = flow.methodId ? loginMethodFor(flow.harness, flow.methodId) : undefined;
    this.log(`account.login.rejected flow=${flowId} code=${error.code}`);
    return this.patch(flowId, { phase: "waiting_input", detail: method?.kind === "browser_code" ? STATIC_DETAIL.code : STATIC_DETAIL.input, inputFields: (method?.fields ?? []).map((f) => ({ ...f })), error, retryable: true }, `rejected: ${error.code}`);
  }

  private succeed(flowId: string, accountId: string, detail: string = STATIC_DETAIL.succeeded): LoginFlowRow {
    const flow = this.store.getLoginFlow(flowId);
    if (!flow || isTerminal(flow.phase)) return flow as LoginFlowRow;
    const updated = this.patch(flowId, { phase: "succeeded", detail, authorizationUrl: null, userCode: null, inputFields: [], error: null, retryable: false }, "succeeded");
    // The worker (if any) is done: terminate its whole process group so
    // nothing outlives the flow (an orphan would also pin the daemon's exit).
    void this.stopRunner(flowId);
    this.onCompleted(accountId);
    return updated;
  }

  private stillActive(flowId: string): boolean {
    const flow = this.store.getLoginFlow(flowId);
    return flow !== null && !isTerminal(flow.phase);
  }

  private async stopRunner(flowId: string): Promise<void> {
    const runner = this.runners.get(flowId);
    if (!runner) return;
    this.runners.delete(flowId);
    await runner.stop();
  }

  private mustFlow(flowId: string): LoginFlowRow {
    const flow = this.store.getLoginFlow(flowId);
    if (!flow) throw new LoginFlowRefusal("login_flow_not_found", `login flow not found: ${flowId}`);
    return flow;
  }

  private mustActive(flowId: string): LoginFlowRow {
    const flow = this.mustFlow(flowId);
    if (isTerminal(flow.phase)) throw new LoginFlowRefusal("login_flow_refused", `login flow ${flowId} is ${flow.phase}`);
    return flow;
  }
}

/** Typed refusal the daemon maps onto the RPC error list. */
export class LoginFlowRefusal extends Error {
  readonly code: "login_flow_not_found" | "login_flow_refused" | "login_method_unsupported" | "invalid_request";

  constructor(code: LoginFlowRefusal["code"], message: string) {
    super(message);
    this.name = "LoginFlowRefusal";
    this.code = code;
  }
}

/** The name tmux gave the retired login seat for an account (dots/colons → underscores, the rest of the old safe-name rule). */
export function legacyLoginSeatName(accountId: string): string {
  return `hive-login-${accountId}`.replace(/\./g, "_").replace(/[^A-Za-z0-9_-]/g, "-");
}
