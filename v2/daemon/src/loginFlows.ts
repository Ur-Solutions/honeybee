/**
 * LoginFlowService — the daemon's account LOGIN plane (tmux-independent
 * login, operator decision 2026-08-28). Owns every login flow end to end:
 *
 *  - the durable, mirrored flow row (`login_flows`; one active per account)
 *  - the provider recipe's advertised methods and their runners:
 *      direct  → typed provider integrations in this file (Claude OAuth
 *                PKCE + code, Codex API key, OpenCode provider API keys)
 *      cli     → the harness's own login CLI in a Honeybee-owned native
 *                worker (loginWorker.ts) whose parsed progress drives phases
 *  - input routing (typed values only reach the field the flow asked for)
 *  - credential validation + atomic capture (home is authoritative; vault
 *    is the backup; restrictive modes) — a process exit is never success
 *  - expiry, cancel, retry (new revision), method switching, worker
 *    cleanup, daemon-restart reconciliation, legacy tmux-seat cleanup
 *
 * Secret safety: typed values live in local variables for the duration of
 * one submit; they are never logged, audited, stored on the flow row, or
 * recorded as an idempotency result. Worker output stays inside the worker.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultLoginMethodId,
  loginMethodFor,
  loginMethodsFor,
  parseClaudeCredentials,
  recipeFor,
  safeAuthorizationUrl,
  OPENCODE_API_KEY_PROVIDERS,
  type AccountRow,
  type CoreStore,
  type IdentityRecipe,
  type LoginCliSpec,
  type LoginFieldDescriptor,
  type LoginFlowError,
  type LoginFlowErrorCode,
  type LoginFlowPatch,
  type LoginFlowRow,
  type LoginMethodDescriptor,
  type LoginMethodRun,
} from "../../core/src/index.ts";
import type { AccountsService } from "./accountsService.ts";
import { primaryCredentialFile, primaryCredentialMtime } from "./activation.ts";
import type { ResolvedNodeConfig } from "./config.ts";
import { seedClaudeHomeAcceptance, seedClaudeHomeDefaults, atomicWriteFileSync } from "./homeDefaults.ts";
import { credentialDigest } from "./keychain.ts";
import { LoginWorker, loadNodePtySpawner, pipeSpawner, type LoginWorkerEvent, type LoginWorkerStatus, type PtySpawner } from "./loginWorker.ts";

// ---------------------------------------------------------------------------
// injected transports (defaults are the real providers)
// ---------------------------------------------------------------------------

export interface ClaudeTokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export type KeyCheck = "valid" | "invalid" | "unverified";

export interface LoginTransports {
  /** Exchange a pasted `code#state` for tokens (PKCE). null = the provider rejected it. Throws on transport failure. */
  claudeTokenExchange: (input: { code: string; state: string; codeVerifier: string; redirectUri: string; clientId: string }) => Promise<ClaudeTokenGrant | null>;
  /** Prove the access token authenticates (the usage endpoint) — the validation step. Throws on transport failure; false on 401/403. */
  claudeTokenCheck: (accessToken: string) => Promise<boolean>;
  /** Best-effort subscription type for the credential document (Claude Code reads it); null when unknown. */
  claudeSubscriptionType: (accessToken: string) => Promise<string | null>;
  /** OpenAI API key check (`GET /v1/models`). */
  openaiKeyCheck: (apiKey: string, baseUrl?: string) => Promise<KeyCheck>;
  /** Anthropic API key check (`GET /v1/models`). */
  anthropicKeyCheck: (apiKey: string, baseUrl?: string) => Promise<KeyCheck>;
}

// Claude Code's public OAuth client id (the one the CLI itself uses).
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const CLAUDE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const CLAUDE_OAUTH_SCOPES = ["org:create_api_key", "user:profile", "user:inference"];

async function checkedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function keyCheckFromStatus(status: number): KeyCheck {
  if (status === 401 || status === 403) return "invalid";
  if (status >= 200 && status < 300) return "valid";
  return "unverified";
}

export function defaultLoginTransports(timeoutMs: number): LoginTransports {
  return {
    claudeTokenExchange: async ({ code, state, codeVerifier, redirectUri, clientId }) => {
      const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, state, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 400 || response.status === 401 || response.status === 403) return null;
      const body = (await checkedJson(response)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
      if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") return null;
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
        scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : CLAUDE_OAUTH_SCOPES,
      };
    },
    claudeTokenCheck: async (accessToken) => {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    },
    claudeSubscriptionType: async (accessToken) => {
      try {
        const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
          headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { organization?: { organization_type?: unknown }; account?: { has_claude_max?: unknown; has_claude_pro?: unknown } };
        const type = body.organization?.organization_type;
        if (typeof type === "string" && type.startsWith("claude_")) return type.slice("claude_".length);
        if (body.account?.has_claude_max === true) return "max";
        if (body.account?.has_claude_pro === true) return "pro";
        return null;
      } catch {
        return null;
      }
    },
    openaiKeyCheck: async (apiKey, baseUrl) => {
      const response = await fetch(`${(baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return keyCheckFromStatus(response.status);
    },
    anthropicKeyCheck: async (apiKey, baseUrl) => {
      const response = await fetch(`${(baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "")}/models`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return keyCheckFromStatus(response.status);
    },
  };
}

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

type Runner =
  | { kind: "claude_oauth"; codeVerifier: string; state: string }
  | { kind: "direct_key" }
  | {
      kind: "cli";
      worker: LoginWorker;
      spec: LoginCliSpec;
      baselineMtime: number | null;
      baselineDigest: string | null;
      /** Set when a failure cue matched; reported when the process exits. */
      failureIndex: number | null;
      /** Landing check in flight (keychain reads are async). */
      checking: boolean;
      /** The phase to return to when a prompt is withdrawn. */
      idlePhase: "starting" | "waiting_browser" | "waiting_device";
      /** Landing checks are throttled (external-store reads are not free). */
      lastLandingCheckAt: number;
    };

/** How often a CLI flow's credential landing is probed (keychain / global-store reads are not free). */
const LANDING_CHECK_INTERVAL_MS = 1000;

const STATIC_DETAIL = {
  starting: "Starting the sign-in…",
  browser: "Finish signing in in your browser.",
  device: "Enter the code on the sign-in page.",
  code: "Paste the code from the sign-in page.",
  input: "Enter the requested details.",
  validating: "Checking the credential…",
  succeeded: "Signed in.",
} as const;

function err(code: LoginFlowErrorCode, message: string): LoginFlowError {
  return { code, message };
}

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Build the Claude authorize URL for a verifier/state pair (pure; unit-tested). */
export function claudeAuthorizeUrl(codeVerifier: string, state: string): string {
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

/** The pasted Claude code is `code#state`; a bare code uses the flow's own state. */
export function splitClaudeCode(pasted: string, flowState: string): { code: string; state: string } | null {
  const trimmed = pasted.trim();
  if (trimmed.length === 0 || trimmed.length > 4096 || /\s/.test(trimmed)) return null;
  const hash = trimmed.indexOf("#");
  if (hash < 0) return { code: trimmed, state: flowState };
  const code = trimmed.slice(0, hash);
  const state = trimmed.slice(hash + 1);
  if (!code || !state) return null;
  return { code, state };
}

/** Reject keys that are obviously not keys (whitespace, control chars, absurd length). Never logs the value. */
export function plausibleApiKey(value: string): boolean {
  return value.length >= 8 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

/** Non-secret, bounded field values (base URL / organization / project). */
function plausibleOption(value: string, kind: "url" | "text"): boolean {
  if (value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (kind !== "url") return true;
  try {
    const url = new URL(value);
    // A key is sent to this host during the check: https, or loopback http (local proxies).
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export class LoginFlowService {
  private readonly store: CoreStore;
  private readonly cfg: ResolvedNodeConfig;
  private readonly accounts: AccountsService;
  private readonly log: (op: string) => void;
  private readonly now: () => number;
  private readonly transports: LoginTransports;
  private readonly onCompleted: (accountId: string) => void;
  private readonly tmuxExec: (args: string[]) => { status: number | null; stdout: string };
  private readonly runners = new Map<string, Runner>();
  /** Flows whose runner is being replaced (selectMethod / retry await a kill): submits refuse, cancels win. */
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
    const runner = this.runners.get(flowId);
    return runner?.kind === "cli" ? runner.worker.status() : null;
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
    const method = flow.methodId ? loginMethodFor(flow.harness, flow.methodId) : undefined;
    if (!method) throw new LoginFlowRefusal("login_flow_refused", `login flow ${flowId} has no method`);
    this.patch(flowId, { phase: "validating", detail: STATIC_DETAIL.validating, inputFields: [], error: null }, "input received");
    try {
      switch (runner.kind) {
        case "claude_oauth":
          return await this.completeClaudeOauth(flowId, runner, values.code ?? "");
        case "direct_key":
          return await this.completeDirectKey(flowId, method.run, values);
        case "cli": {
          for (const field of flow.inputFields) {
            const value = values[field.id];
            if (value !== undefined) runner.worker.submit(value, field.secret);
          }
          // The CLI validates; landing (tick) or exit settles the flow.
          return this.flowOf(flowId) as LoginFlowRow;
        }
        default:
          return this.flowOf(flowId) as LoginFlowRow;
      }
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

  /** Tick: expiry, orphaned runners (flow/account removed), and credential-landing checks for CLI flows. */
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
        if (runner.kind === "cli" && now - runner.lastLandingCheckAt >= LANDING_CHECK_INTERVAL_MS) {
          runner.lastLandingCheckAt = now;
          void this.checkLanding(flowId, runner);
        }
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

  private async run(flowId: string, methodId: string): Promise<LoginFlowRow> {
    const flow = this.mustFlow(flowId);
    if (isTerminal(flow.phase)) return flow;
    const account = this.store.getAccount(flow.account);
    if (!account) throw new LoginFlowRefusal("login_flow_not_found", `login flow ${flowId} belongs to a removed account`);
    const method = loginMethodFor(flow.harness, methodId);
    if (!method) return this.fail(flowId, err("unsupported_method", `${flow.harness} does not offer '${methodId}'.`), false);
    this.patch(flowId, { methodId }, "method");
    try {
      if (method.run.mode === "direct") {
        switch (method.run.runner) {
          case "claude_oauth":
            return this.startClaudeOauth(flowId, method);
          case "codex_api_key":
          case "opencode_api_key":
            this.runners.set(flowId, { kind: "direct_key" });
            return this.patch(flowId, { phase: "waiting_input", detail: STATIC_DETAIL.input, inputFields: method.fields.map((f) => ({ ...f })) }, "fields requested");
          default:
            return this.fail(flowId, err("unsupported_method", `unknown direct runner`), false);
        }
      }
      return await this.startCli(flowId, account, method, method.run.cli);
    } catch (error) {
      return this.fail(flowId, err("provider_error", safeMessage(error)), true);
    }
  }

  private startClaudeOauth(flowId: string, method: LoginMethodDescriptor): LoginFlowRow {
    // The verifier never leaves this process; `state` is an independent
    // nonce (the authorization URL — and thus the mirrored row — carries
    // only the challenge and the state).
    const codeVerifier = pkceVerifier();
    const state = randomBytes(16).toString("base64url");
    this.runners.set(flowId, { kind: "claude_oauth", codeVerifier, state });
    const url = safeAuthorizationUrl(claudeAuthorizeUrl(codeVerifier, state));
    return this.patch(
      flowId,
      { phase: "waiting_input", detail: STATIC_DETAIL.code, authorizationUrl: url, inputFields: method.fields.map((f) => ({ ...f })) },
      "authorization url issued",
    );
  }

  private async completeClaudeOauth(flowId: string, runner: Extract<Runner, { kind: "claude_oauth" }>, pasted: string): Promise<LoginFlowRow> {
    const flow = this.mustFlow(flowId);
    const account = this.store.getAccount(flow.account);
    if (!account) throw new LoginFlowRefusal("login_flow_not_found", `login flow ${flowId} belongs to a removed account`);
    const split = splitClaudeCode(pasted, runner.state);
    if (!split) return this.reask(flowId, err("invalid_input", "That does not look like an authorization code. Paste the whole code shown on the sign-in page."));
    const grant = await this.transports.claudeTokenExchange({ code: split.code, state: split.state, codeVerifier: runner.codeVerifier, redirectUri: CLAUDE_OAUTH_REDIRECT_URI, clientId: CLAUDE_OAUTH_CLIENT_ID });
    if (!grant) return this.reask(flowId, err("invalid_credential", "The sign-in page rejected that code. Open the sign-in page again and paste a fresh code."));
    const ok = await this.transports.claudeTokenCheck(grant.accessToken);
    if (!ok) return this.reask(flowId, err("invalid_credential", "The credential did not authenticate. Open the sign-in page again and paste a fresh code."));
    if (!this.stillActive(flowId)) return this.flowOf(flowId) as LoginFlowRow;
    const subscriptionType = await this.transports.claudeSubscriptionType(grant.accessToken);
    const document = {
      claudeAiOauth: {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt,
        scopes: grant.scopes,
        ...(subscriptionType ? { subscriptionType } : {}),
      },
    };
    const raw = JSON.stringify(document);
    if (!parseClaudeCredentials(raw)) return this.reask(flowId, err("invalid_credential", "The provider returned an unusable credential."));
    // Home is authoritative: land the credential there (0600), seed the
    // home defaults a fresh Claude home needs, then capture into the vault.
    mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(account.homePath, ".credentials.json"), raw, 0o600);
    seedClaudeHomeDefaults(account.homePath);
    seedClaudeHomeAcceptance(account.homePath, { yolo: true });
    const keychainWritten = await this.accounts.writeClaudeKeychain(account, raw).catch(() => false);
    const captured = this.accounts.persistCredentialCapture(account, ".credentials.json", raw, { ".credentials.json": raw });
    if (!captured.ok) return this.fail(flowId, err("capture_failed", "The credential could not be saved into the account's vault."), true);
    this.log(`account.login.captured flow=${flowId} account=${account.id} by=claude_oauth keychain=${keychainWritten} files=${captured.captured.join(",")}`);
    return this.succeed(flowId, account.id);
  }

  private async completeDirectKey(flowId: string, run: LoginMethodRun, values: Record<string, string>): Promise<LoginFlowRow> {
    const flow = this.mustFlow(flowId);
    const account = this.store.getAccount(flow.account);
    if (!account) throw new LoginFlowRefusal("login_flow_not_found", `login flow ${flowId} belongs to a removed account`);
    const apiKey = (values.apiKey ?? "").trim();
    if (!plausibleApiKey(apiKey)) return this.reask(flowId, err("invalid_input", "That does not look like an API key."));
    if (run.mode !== "direct") return this.flowOf(flowId) as LoginFlowRow;
    if (run.runner === "codex_api_key") {
      const check = await this.transports.openaiKeyCheck(apiKey);
      if (check === "invalid") return this.reask(flowId, err("invalid_credential", "OpenAI rejected that API key."));
      if (check === "unverified") return this.reask(flowId, err("network_error", "OpenAI could not be reached to check the key. Try again."));
      if (!this.stillActive(flowId)) return this.flowOf(flowId) as LoginFlowRow;
      const raw = `${JSON.stringify({ OPENAI_API_KEY: apiKey, tokens: null, last_refresh: null }, null, 2)}\n`;
      mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(join(account.homePath, "auth.json"), raw, 0o600);
      const recipe = recipeFor("codex") as IdentityRecipe;
      for (const [canonical, mirror] of Object.entries(recipe.activationMirrors ?? {})) {
        if (canonical === "auth.json") writePrivateRaw(join(account.homePath, mirror), raw);
      }
      const captured = this.accounts.persistCredentialCapture(account, "auth.json", raw, {});
      if (!captured.ok) return this.fail(flowId, err("capture_failed", "The credential could not be saved into the account's vault."), true);
      this.log(`account.login.captured flow=${flowId} account=${account.id} by=codex_api_key files=${captured.captured.join(",")}`);
      return this.succeed(flowId, account.id);
    }
    // opencode_api_key
    const provider = (values.provider ?? "").trim();
    const known = OPENCODE_API_KEY_PROVIDERS.find((p) => p.id === provider);
    if (!known) return this.reask(flowId, err("invalid_input", "Pick a provider."));
    const options: Record<string, unknown> = {};
    const headers: Record<string, string> = {};
    const baseUrl = (values.baseUrl ?? "").trim();
    if (baseUrl) {
      if (!known.baseUrl || !plausibleOption(baseUrl, "url")) return this.reask(flowId, err("invalid_input", "The base URL must be an http(s) URL."));
      options.baseURL = baseUrl;
    }
    const organization = (values.organization ?? "").trim();
    if (organization) {
      if (!known.organization || !plausibleOption(organization, "text")) return this.reask(flowId, err("invalid_input", "Invalid organization id."));
      headers["OpenAI-Organization"] = organization;
    }
    const project = (values.project ?? "").trim();
    if (project) {
      if (!known.project || !plausibleOption(project, "text")) return this.reask(flowId, err("invalid_input", "Invalid project id."));
      headers["OpenAI-Project"] = project;
    }
    let check: KeyCheck = "unverified";
    if (provider === "openai") check = await this.transports.openaiKeyCheck(apiKey, baseUrl || undefined);
    else if (provider === "anthropic") check = await this.transports.anthropicKeyCheck(apiKey, baseUrl || undefined);
    if (check === "invalid") return this.reask(flowId, err("invalid_credential", `${known.label} rejected that API key.`));
    if (!this.stillActive(flowId)) return this.flowOf(flowId) as LoginFlowRow;
    this.patch(flowId, { provider }, "provider");
    const authPath = join(account.homePath, "xdg-data", "opencode", "auth.json");
    const auth = readJsonObject(authPath);
    auth[provider] = { type: "api", key: apiKey };
    writePrivateJson(authPath, auth);
    if (Object.keys(options).length > 0 || Object.keys(headers).length > 0) {
      const configPath = join(account.homePath, "opencode.json");
      const config = readJsonObject(configPath);
      const providers = (config.provider && typeof config.provider === "object" && !Array.isArray(config.provider) ? config.provider : {}) as Record<string, unknown>;
      const entry = (providers[provider] && typeof providers[provider] === "object" ? providers[provider] : {}) as Record<string, unknown>;
      const existingOptions = (entry.options && typeof entry.options === "object" ? entry.options : {}) as Record<string, unknown>;
      const existingHeaders = (existingOptions.headers && typeof existingOptions.headers === "object" ? existingOptions.headers : {}) as Record<string, unknown>;
      entry.options = { ...existingOptions, ...options, ...(Object.keys(headers).length > 0 ? { headers: { ...existingHeaders, ...headers } } : {}) };
      providers[provider] = entry;
      config.provider = providers;
      writePrivateJson(configPath, config);
    }
    const raw = readFileSync(authPath, "utf8");
    const captured = this.accounts.persistCredentialCapture(account, "xdg-data/opencode/auth.json", raw, {});
    if (!captured.ok) return this.fail(flowId, err("capture_failed", "The credential could not be saved into the account's vault."), true);
    this.log(`account.login.captured flow=${flowId} account=${account.id} by=opencode_api_key provider=${provider} verified=${check === "valid"} files=${captured.captured.join(",")}`);
    return this.succeed(flowId, account.id, check === "valid" ? undefined : `Saved. ${known.label} keys are checked by format only; OpenCode verifies them on first use.`);
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

  private async startCli(flowId: string, account: AccountRow, method: LoginMethodDescriptor, spec: LoginCliSpec): Promise<LoginFlowRow> {
    const recipe = recipeFor(account.harness);
    if (!recipe) return this.fail(flowId, err("unsupported_method", `${account.harness} has no login recipe.`), false);
    const pty = await this.resolveSpawner();
    let spawner: PtySpawner;
    if (pty) spawner = pty;
    else if (spec.tty) {
      return this.fail(flowId, err("pty_unavailable", `${account.harness}'s login needs a terminal, and this Honeybee node has no PTY backend (node-pty). Install it or use another sign-in method.`), false);
    } else spawner = pipeSpawner();
    // Node config `agents.<harness>.login` overrides every CLI method's
    // command (an operator-level override / the tests' fake CLI); otherwise
    // the method's own command, else the recipe's login command.
    const configured = this.cfg.agents[account.harness]?.login;
    const launch = configured ?? spec.command ?? recipe.login;
    // A minimal environment: the daemon's own provider keys / tokens must
    // never reach a vendor login CLI (some would silently use them instead
    // of signing in), and no worker inherits a tmux context.
    const env: Record<string, string> = {
      ...workerBaseEnv(process.env),
      ...(this.cfg.agents[account.harness]?.env ?? {}),
      ...this.accounts.homeEnvOf(account),
      ...(spec.env ?? {}),
      TERM: "xterm-256color",
    };
    mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
    const baselineMtime = primaryCredentialMtime(account.homePath, recipe);
    const externalRaw = spec.landing === "external_digest" ? await this.accounts.externalLoginCredential(account) : null;
    const baselineDigest = externalRaw ? credentialDigest(externalRaw) : null;
    if (!this.stillActive(flowId)) return this.flowOf(flowId) as LoginFlowRow;
    // Events are bound to THIS runner: a superseded worker (cancel → retry,
    // method switch) whose exit lands late must never be attributed to its
    // successor.
    let runner: Runner | null = null;
    const worker = new LoginWorker({
      spawner,
      launch: { command: launch.command, args: [...(launch.args ?? [])], cwd: account.homePath, env },
      cues: spec.cues,
      now: this.now,
      killGraceMs: this.workerKillGraceMs,
      ...(this.workerSettleMs !== undefined ? { settleMs: this.workerSettleMs } : {}),
      onEvent: (event) => {
        if (runner && this.runners.get(flowId) === runner) this.onWorkerEvent(flowId, runner, event);
      },
    });
    runner = { kind: "cli", worker, spec, baselineMtime, baselineDigest, failureIndex: null, checking: false, idlePhase: "starting", lastLandingCheckAt: 0 };
    this.runners.set(flowId, runner);
    worker.start();
    this.log(`account.login.worker flow=${flowId} account=${account.id} method=${method.id} backend=${spawner.kind} pid=${worker.pid} baselineMtime=${baselineMtime ?? "-"} baselineDigest=${baselineDigest ? baselineDigest.slice(0, 8) : "-"}`);
    return this.flowOf(flowId) as LoginFlowRow;
  }

  private onWorkerEvent(flowId: string, runner: Runner, event: LoginWorkerEvent): void {
    if (runner.kind !== "cli") return;
    const flow = this.store.getLoginFlow(flowId);
    if (!flow || isTerminal(flow.phase)) return;
    const method = flow.methodId ? loginMethodFor(flow.harness, flow.methodId) : undefined;
    switch (event.kind) {
      case "url": {
        const url = safeAuthorizationUrl(event.url);
        if (!url) return;
        const reissued = flow.authorizationUrl !== null && flow.authorizationUrl !== url;
        const device = method?.kind === "device_code";
        runner.idlePhase = device ? (flow.userCode ? "waiting_device" : "waiting_browser") : "waiting_browser";
        const phase = flow.phase === "waiting_input" || flow.phase === "validating" ? flow.phase : runner.idlePhase;
        this.patch(flowId, { authorizationUrl: url, phase, detail: phase === runner.idlePhase ? (runner.idlePhase === "waiting_device" ? STATIC_DETAIL.device : STATIC_DETAIL.browser) : flow.detail, ...(reissued ? { revision: flow.revision + 1 } : {}) }, reissued ? "authorization url reissued" : "authorization url");
        return;
      }
      case "user_code": {
        runner.idlePhase = "waiting_device";
        const phase = flow.phase === "waiting_input" || flow.phase === "validating" ? flow.phase : "waiting_device";
        this.patch(flowId, { userCode: event.code, phase, detail: phase === "waiting_device" ? STATIC_DETAIL.device : flow.detail }, "user code");
        return;
      }
      case "prompt": {
        if (event.field) {
          this.patch(flowId, { phase: "waiting_input", detail: event.field.id === "code" ? STATIC_DETAIL.code : STATIC_DETAIL.input, inputFields: [{ ...event.field }], ...(runner.failureIndex !== null && flow.phase === "validating" ? { error: err("invalid_input", "The CLI did not accept that; try again.") } : {}) }, "prompt");
          runner.failureIndex = null;
        } else if (flow.phase === "waiting_input") {
          this.patch(flowId, { phase: runner.idlePhase, detail: runner.idlePhase === "waiting_device" ? STATIC_DETAIL.device : runner.idlePhase === "waiting_browser" ? STATIC_DETAIL.browser : STATIC_DETAIL.starting, inputFields: [] }, "prompt withdrawn");
        }
        return;
      }
      case "failure":
        runner.failureIndex = event.index;
        return;
      case "spawn_error": {
        this.runners.delete(flowId);
        const missing = /ENOENT|not found|could not start/i.test(event.message);
        this.fail(flowId, missing ? err("cli_missing", `The ${flow.harness} CLI could not be started on this node; install it or use another sign-in method.`) : err("worker_died", "The sign-in process could not be started."), !missing);
        return;
      }
      case "exit": {
        // A process exit is never success by itself: one final landing check decides.
        void this.checkLanding(flowId, runner, true).then((landed) => {
          if (landed) return;
          const current = this.store.getLoginFlow(flowId);
          if (!current || isTerminal(current.phase)) return;
          this.runners.delete(flowId);
          const failed = runner.failureIndex !== null;
          this.fail(
            flowId,
            failed
              ? err("cli_failed", `The ${flow.harness} sign-in reported a failure. Retry to start over.`)
              : err("process_exited", `The ${flow.harness} sign-in ended without saving a credential. Retry to start over.`),
            true,
          );
          this.log(`account.login.exited flow=${flowId} code=${event.code ?? "-"} signal=${event.signal ?? "-"} failureCue=${runner.failureIndex ?? "-"}`);
        });
        return;
      }
      default:
        return;
    }
  }

  /** Credential landing for CLI flows: mtime past baseline / external-store digest drift → validate → capture → succeeded. */
  private async checkLanding(flowId: string, runner: Extract<Runner, { kind: "cli" }>, final = false): Promise<boolean> {
    if (runner.checking && !final) return false;
    runner.checking = true;
    try {
      const flow = this.store.getLoginFlow(flowId);
      if (!flow || isTerminal(flow.phase)) return false;
      const account = this.store.getAccount(flow.account);
      if (!account) return false;
      const recipe = recipeFor(account.harness);
      if (!recipe) return false;
      const primaryFile = primaryCredentialFile(recipe);
      let externalRaw: string | null = null;
      let detectedBy: "mtime" | "digest" | null = null;
      if (runner.spec.landing === "external_digest") {
        externalRaw = await this.accounts.externalLoginCredential(account);
        if (this.runners.get(flowId) !== runner) return false;
        const digest = externalRaw ? credentialDigest(externalRaw) : null;
        if (digest !== null && digest !== runner.baselineDigest) detectedBy = "digest";
      }
      const mtime = primaryCredentialMtime(account.homePath, recipe);
      if (!detectedBy && externalRaw === null && mtime !== null && (runner.baselineMtime === null || mtime > runner.baselineMtime)) detectedBy = "mtime";
      if (!detectedBy) return false;
      const overrides: Record<string, string> = externalRaw ? { [primaryFile]: externalRaw } : {};
      let primaryRaw = overrides[primaryFile] ?? null;
      if (primaryRaw === null) {
        try {
          primaryRaw = readFileSync(join(account.homePath, primaryFile), "utf8");
        } catch {
          primaryRaw = null;
        }
      }
      if (!this.stillActive(flowId)) return false;
      const captured = this.accounts.persistCredentialCapture(account, primaryFile, primaryRaw, overrides);
      if (!captured.ok) {
        // Not a credential yet (partial write / invalid): re-baseline and keep waiting.
        runner.baselineMtime = mtime;
        runner.baselineDigest = externalRaw ? credentialDigest(externalRaw) : runner.baselineDigest;
        this.log(`account.login.rejected flow=${flowId} account=${account.id} by=${detectedBy} reason=${captured.reason}`);
        return false;
      }
      this.log(`account.login.captured flow=${flowId} account=${account.id} by=${detectedBy} files=${captured.captured.join(",")}`);
      this.succeed(flowId, account.id);
      return true;
    } finally {
      runner.checking = false;
    }
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
    if (runner.kind === "cli") await runner.worker.kill();
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

function isTerminal(phase: LoginFlowRow["phase"]): boolean {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled" || phase === "expired" || phase === "interrupted";
}

/** Env keys a login worker inherits from the daemon (everything else — provider keys, tokens — is withheld). */
export const WORKER_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
] as const;

export function workerBaseEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/** The name tmux gave the retired login seat for an account (dots/colons → underscores, the rest of the old safe-name rule). */
export function legacyLoginSeatName(accountId: string): string {
  return `hive-login-${accountId}`.replace(/\./g, "_").replace(/[^A-Za-z0-9_-]/g, "-");
}

function writePrivateRaw(path: string, raw: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, raw, 0o600);
}

/** Bounded error text with anything token-shaped removed. */
function safeMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return text.replace(/[A-Za-z0-9_\-]{32,}/g, "…").slice(0, 200);
}

export type { LoginFieldDescriptor };
