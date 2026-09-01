/**
 * CLI runner — the vendor's own login command inside a Honeybee-owned
 * native worker (loginWorker.ts). The worker's parsed events (URL, device
 * code, prompt, failure cue, exit) drive the flow's phases; typed input is
 * typed back into the worker; success is only ever the credential LANDING
 * (home mtime past the baseline, or the external store's digest drifting),
 * never the process exiting.
 *
 * Events are bound to THIS runner: a superseded worker (cancel → retry,
 * method switch) whose exit lands late is dropped by the host.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recipeFor, resolveSpawnCommand, safeAuthorizationUrl, type LoginCliSpec, type LoginFieldDescriptor, type LoginFlowRow } from "../../../core/src/index.ts";
import { primaryCredentialFile, primaryCredentialMtime } from "../activation.ts";
import { credentialDigest } from "../keychain.ts";
import { LoginWorker, pipeSpawner, type LoginWorkerEvent, type LoginWorkerStatus, type PtySpawner } from "../loginWorker.ts";
import { STATIC_DETAIL, err } from "./common.ts";
import type { LoginRunner, LoginRunnerHost } from "./runner.ts";

/** How often a CLI flow's credential landing is probed (keychain / global-store reads are not free). */
export const LANDING_CHECK_INTERVAL_MS = 1000;

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

type IdlePhase = "starting" | "waiting_browser" | "waiting_device";

export class CliRunner implements LoginRunner {
  readonly kind = "cli" as const;
  private readonly host: LoginRunnerHost;
  private readonly spec: LoginCliSpec;
  private worker: LoginWorker | null = null;
  private baselineMtime: number | null = null;
  private baselineDigest: string | null = null;
  /** Set when a failure cue matched; reported when the process exits. */
  private failureIndex: number | null = null;
  /** Landing check in flight (keychain reads are async). */
  private checking = false;
  /** The phase to return to when a prompt is withdrawn. */
  private idlePhase: IdlePhase = "starting";
  /** Landing checks are throttled (external-store reads are not free). */
  private lastLandingCheckAt = 0;

  constructor(host: LoginRunnerHost, spec: LoginCliSpec) {
    this.host = host;
    this.spec = spec;
  }

  async start(): Promise<LoginFlowRow> {
    const host = this.host;
    const account = host.account;
    const recipe = recipeFor(account.harness);
    if (!recipe) return host.fail(err("unsupported_method", `${account.harness} has no login recipe.`), false);
    const pty = await host.resolveSpawner();
    let spawner: PtySpawner;
    if (pty) spawner = pty;
    else if (this.spec.tty) {
      return host.fail(err("pty_unavailable", `${account.harness}'s login needs a terminal, and this Honeybee node has no PTY backend (node-pty). Install it or use another sign-in method.`), false);
    } else spawner = pipeSpawner();
    // Node config `agents.<harness>.login` overrides every CLI method's
    // command (an operator-level override / the tests' fake CLI); otherwise
    // the method's own command, else the recipe's login command.
    const configured = host.cfg.agents[account.harness]?.login;
    const launch = configured ?? this.spec.command ?? recipe.login;
    // A minimal environment: the daemon's own provider keys / tokens must
    // never reach a vendor login CLI (some would silently use them instead
    // of signing in), and no worker inherits a tmux context.
    const env: Record<string, string> = {
      ...workerBaseEnv(process.env),
      ...(host.cfg.agents[account.harness]?.env ?? {}),
      ...host.accounts.homeEnvOf(account),
      ...(this.spec.env ?? {}),
      TERM: "xterm-256color",
    };
    mkdirSync(account.homePath, { recursive: true, mode: 0o700 });
    this.baselineMtime = primaryCredentialMtime(account.homePath, recipe);
    const externalRaw = this.spec.landing === "external_digest" ? await host.accounts.externalLoginCredential(account) : null;
    this.baselineDigest = externalRaw ? credentialDigest(externalRaw) : null;
    // A cancel / switch that landed during the awaits wins: never spawn a
    // worker nobody owns.
    if (!host.isCurrent(this) || !host.stillActive()) return host.flow() as LoginFlowRow;
    // F8 — same one resolution rule as agent spawns: the worker's minimal
    // env has a minimal PATH, so a bare vendor CLI name must resolve through
    // core (PATH + fallback dirs) or fail with an honest ENOENT.
    const { command } = resolveSpawnCommand(launch.command, { env });
    const worker = new LoginWorker({
      spawner,
      launch: { command, args: [...(launch.args ?? [])], cwd: account.homePath, env },
      cues: this.spec.cues,
      now: host.now,
      killGraceMs: host.workerKillGraceMs,
      ...(host.workerSettleMs !== undefined ? { settleMs: host.workerSettleMs } : {}),
      onEvent: (event) => {
        if (host.isCurrent(this)) this.onWorkerEvent(event);
      },
    });
    this.worker = worker;
    worker.start();
    host.log(`account.login.worker flow=${host.flowId} account=${account.id} method=${host.method.id} backend=${spawner.kind} pid=${worker.pid} baselineMtime=${this.baselineMtime ?? "-"} baselineDigest=${this.baselineDigest ? this.baselineDigest.slice(0, 8) : "-"}`);
    return host.flow() as LoginFlowRow;
  }

  /** Type each requested field into the CLI; it validates, and landing (tick) or exit settles the flow. */
  async submit(values: Record<string, string>, fields: readonly LoginFieldDescriptor[]): Promise<LoginFlowRow> {
    for (const field of fields) {
      const value = values[field.id];
      if (value !== undefined) this.worker?.submit(value, field.secret);
    }
    return this.host.flow() as LoginFlowRow;
  }

  tick(now: number): void {
    if (now - this.lastLandingCheckAt < LANDING_CHECK_INTERVAL_MS) return;
    this.lastLandingCheckAt = now;
    void this.checkLanding();
  }

  async stop(): Promise<void> {
    await this.worker?.kill();
  }

  workerStatus(): LoginWorkerStatus | null {
    return this.worker?.status() ?? null;
  }

  private onWorkerEvent(event: LoginWorkerEvent): void {
    const host = this.host;
    const flow = host.flow();
    if (!flow || !host.stillActive()) return;
    switch (event.kind) {
      case "url": {
        const url = safeAuthorizationUrl(event.url);
        if (!url) return;
        const reissued = flow.authorizationUrl !== null && flow.authorizationUrl !== url;
        const device = host.method.kind === "device_code";
        this.idlePhase = device ? (flow.userCode ? "waiting_device" : "waiting_browser") : "waiting_browser";
        const phase = flow.phase === "waiting_input" || flow.phase === "validating" ? flow.phase : this.idlePhase;
        host.patch(
          { authorizationUrl: url, phase, detail: phase === this.idlePhase ? (this.idlePhase === "waiting_device" ? STATIC_DETAIL.device : STATIC_DETAIL.browser) : flow.detail, ...(reissued ? { revision: flow.revision + 1 } : {}) },
          reissued ? "authorization url reissued" : "authorization url",
        );
        return;
      }
      case "user_code": {
        this.idlePhase = "waiting_device";
        const phase = flow.phase === "waiting_input" || flow.phase === "validating" ? flow.phase : "waiting_device";
        host.patch({ userCode: event.code, phase, detail: phase === "waiting_device" ? STATIC_DETAIL.device : flow.detail }, "user code");
        return;
      }
      case "prompt": {
        if (event.field) {
          host.patch(
            {
              phase: "waiting_input",
              detail: event.field.id === "code" ? STATIC_DETAIL.code : STATIC_DETAIL.input,
              inputFields: [{ ...event.field }],
              ...(this.failureIndex !== null && flow.phase === "validating" ? { error: err("invalid_input", "The CLI did not accept that; try again.") } : {}),
            },
            "prompt",
          );
          this.failureIndex = null;
        } else if (flow.phase === "waiting_input") {
          host.patch(
            { phase: this.idlePhase, detail: this.idlePhase === "waiting_device" ? STATIC_DETAIL.device : this.idlePhase === "waiting_browser" ? STATIC_DETAIL.browser : STATIC_DETAIL.starting, inputFields: [] },
            "prompt withdrawn",
          );
        }
        return;
      }
      case "failure":
        this.failureIndex = event.index;
        return;
      case "spawn_error": {
        host.release(this);
        const missing = /ENOENT|not found|could not start/i.test(event.message);
        host.fail(missing ? err("cli_missing", `The ${flow.harness} CLI could not be started on this node; install it or use another sign-in method.`) : err("worker_died", "The sign-in process could not be started."), !missing);
        return;
      }
      case "exit": {
        // A process exit is never success by itself: one final landing check decides.
        void this.checkLanding(true).then((landed) => {
          if (landed) return;
          if (!host.isCurrent(this) || !host.stillActive()) return;
          host.release(this);
          const failed = this.failureIndex !== null;
          host.fail(
            failed
              ? err("cli_failed", `The ${flow.harness} sign-in reported a failure. Retry to start over.`)
              : err("process_exited", `The ${flow.harness} sign-in ended without saving a credential. Retry to start over.`),
            true,
          );
          host.log(`account.login.exited flow=${host.flowId} code=${event.code ?? "-"} signal=${event.signal ?? "-"} failureCue=${this.failureIndex ?? "-"}`);
        });
        return;
      }
      default:
        return;
    }
  }

  /** Credential landing: mtime past baseline / external-store digest drift → validate → capture → succeeded. */
  private async checkLanding(final = false): Promise<boolean> {
    if (this.checking && !final) return false;
    this.checking = true;
    const host = this.host;
    try {
      if (!host.stillActive()) return false;
      const account = host.store.getAccount(host.account.id);
      if (!account) return false;
      const recipe = recipeFor(account.harness);
      if (!recipe) return false;
      const primaryFile = primaryCredentialFile(recipe);
      let externalRaw: string | null = null;
      let detectedBy: "mtime" | "digest" | null = null;
      if (this.spec.landing === "external_digest") {
        externalRaw = await host.accounts.externalLoginCredential(account);
        if (!host.isCurrent(this)) return false;
        const digest = externalRaw ? credentialDigest(externalRaw) : null;
        if (digest !== null && digest !== this.baselineDigest) detectedBy = "digest";
      }
      const mtime = primaryCredentialMtime(account.homePath, recipe);
      if (!detectedBy && externalRaw === null && mtime !== null && (this.baselineMtime === null || mtime > this.baselineMtime)) detectedBy = "mtime";
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
      if (!host.stillActive()) return false;
      const captured = host.accounts.persistCredentialCapture(account, primaryFile, primaryRaw, overrides);
      if (!captured.ok) {
        // Not a credential yet (partial write / invalid): re-baseline and keep waiting.
        this.baselineMtime = mtime;
        this.baselineDigest = externalRaw ? credentialDigest(externalRaw) : this.baselineDigest;
        host.log(`account.login.rejected flow=${host.flowId} account=${account.id} by=${detectedBy} reason=${captured.reason}`);
        return false;
      }
      host.log(`account.login.captured flow=${host.flowId} account=${account.id} by=${detectedBy} files=${captured.captured.join(",")}`);
      host.succeed();
      return true;
    } finally {
      this.checking = false;
    }
  }
}
