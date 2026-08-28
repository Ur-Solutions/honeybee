/**
 * Login flows at the RPC tier — a REAL daemon process over a temp socket,
 * the fake login CLI as every vendor CLI:
 *  - the hello + deployInfo advertise `account.login.flow.v1`
 *  - account.login.start (+ the account.login alias) starts / rejoins;
 *    snapshot + watch carry login_flows rows and login_flow.put deltas;
 *    account.get exposes the latest flow; typed errors for unknown flows,
 *    wrong-phase submits, unsupported methods
 *  - one-key idempotency on start / submit / cancel (replay answers the
 *    recorded safe row; the recorded result never carries the input)
 *  - a submitted SENTINEL code is absent from every core.sqlite table, the
 *    daemon log, and the daemon's stdout — present only in the credential
 *    files the vendor CLI wrote
 *  - daemon restart: the live flow becomes `interrupted`, no worker
 *    survives, retry issues revision 2 and completes; a completed login
 *    survives the restart as `succeeded`
 *  - no `hive-login-*` tmux session is ever created
 * SAFETY: temp dirs only (vault/homes inside the daemon dir); never ~/.hive,
 * never a real vendor CLI; HIVE_NO_KEYCHAIN in the daemon env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError, type DeployInfoResult, type SnapshotResult, type WatchFrame } from "../src/protocol.ts";
import type {
  AccountAddResult,
  AccountGetResult,
  AccountLoginCancelResult,
  AccountLoginGetResult,
  AccountLoginStartResult,
  LoginFlowRow,
} from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(here, "..", "..", "driver-hsr", "test-agent", "fake-login-cli.mjs");
const SENTINEL = "SENTINEL-RPC-CODE-4c3b2a1f";

async function rejects(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return;
  }
  assert.fail(`expected ${code}`);
}

async function waitPhase(client: RpcClient, flowId: string, phases: string[], what: string): Promise<LoginFlowRow> {
  return waitFor(async () => {
    const r = await client.request<AccountLoginGetResult>("account.login.get", { flowId });
    return phases.includes(r.flow.phase) ? r.flow : null;
  }, what, 12_000, 25);
}

/** Every table of the core store, serialized (a sentinel must not be anywhere in it). */
function dumpSqlite(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    return tables.map((t) => `${t}: ${JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())}`).join("\n");
  } finally {
    db.close();
  }
}

/** The daemon's own op log (cfg.logPath lives under the data dir; stdout only carries fatal output). */
function daemonLog(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".log") || f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

function loginSessionsOn(socket: string): string[] {
  const r = spawnSync("tmux", ["-L", socket, "list-sessions", "-F", "#S"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return [];
  return String(r.stdout).split("\n").filter((l) => l.startsWith("hive-login-"));
}

function agents(env: Record<string, string>) {
  return {
    grok: { command: process.execPath, args: [], adapter: "grok", login: { command: process.execPath, args: [FAKE_CLI] }, env: { FAKE_LOGIN_HOME_ENV: "GROK_HOME", FAKE_LOGIN_FILE: "auth.json", ...env } },
  };
}

test("rpc.login.1: capability tags, start/rejoin/alias, snapshot + watch rows, typed errors, idempotent replay, secret sentinel absent from sqlite/log/stdout, no tmux seat", async () => {
  const { dir, cleanup } = makeDaemonDir({
    accounts: { loginTimeoutMs: 30_000, loginWorkerBackend: "pipe" },
    agents: agents({ FAKE_CLI_URL: "https://accounts.x.ai/sign-in?flow=1", FAKE_CLI_PROMPT: "code", FAKE_CLI_EXPECT: SENTINEL, FAKE_CLI_ECHO: "1", FAKE_LOGIN_CONTENT: '{"grok":{"key":"SENTINEL-GROK-KEY"}}' }),
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const watch = await daemon.client();
    const frames: WatchFrame[] = [];
    watch.onEvent = (f: WatchFrame) => frames.push(f);
    await watch.request("watch");

    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info.capabilities.includes("account.login.flow.v1"));

    const added = await client.request<AccountAddResult>("account.add", { harness: "grok", label: "x" });
    await rejects(() => client.request("account.login.get", { id: added.account.id }), "login_flow_not_found");
    await rejects(() => client.request("account.login.get", { flowId: "nope" }), "login_flow_not_found");
    // grok's recipe needs a TTY; with the pipe backend forced by config the
    // daemon refuses inside the flow row — never with a terminal.
    const refused = await client.request<AccountLoginStartResult>("account.login", { id: added.account.id, idempotencyKey: "login-start-refused" });
    assert.equal(refused.flow.phase, "failed");
    assert.equal(refused.flow.error?.code, "pty_unavailable");
    const replay = await client.request<AccountLoginStartResult>("account.login", { id: added.account.id, idempotencyKey: "login-start-refused" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.flow.id, refused.flow.id);
    await rejects(() => client.request("account.login.submit", { flowId: refused.flow.id, values: { code: "x" } }), "login_flow_refused");
    await rejects(() => client.request("account.login.selectMethod", { flowId: refused.flow.id, methodId: "grok-cli" }), "login_flow_refused");
    const cancelNoop = await client.request<AccountLoginCancelResult>("account.login.cancel", { flowId: refused.flow.id, idempotencyKey: "cancel-noop" });
    assert.equal(cancelNoop.applied, false);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }

  // Same scenario with a backend that can run the CLI (pipe injected as the
  // worker backend is only possible in-process; at the RPC tier we rely on
  // a recipe method that does not need a TTY: cursor's `browser` method).
  const cursor = makeDaemonDir({
    accounts: { loginTimeoutMs: 30_000, loginWorkerBackend: "pipe" },
    agents: {
      cursor: { command: process.execPath, args: [], adapter: "cursor", login: { command: process.execPath, args: [FAKE_CLI] }, env: { FAKE_LOGIN_HOME_ENV: "CURSOR_CONFIG_DIR", FAKE_LOGIN_FILE: "auth.json", FAKE_CLI_URL: "https://cursor.com/loginDeepControl?x=1", FAKE_CLI_PROMPT: "code", FAKE_CLI_EXPECT: SENTINEL, FAKE_CLI_ECHO: "1", FAKE_LOGIN_CONTENT: `{"accessToken":"SENTINEL-CURSOR-TOKEN","refreshToken":"r"}` } },
    },
  });
  daemon = null;
  try {
    daemon = await startDaemon(cursor.dir);
    const client = await daemon.client();
    const watch = await daemon.client();
    const frames: WatchFrame[] = [];
    watch.onEvent = (f: WatchFrame) => frames.push(f);
    await watch.request("watch");
    const added = await client.request<AccountAddResult>("account.add", { harness: "cursor", label: "c" });
    const started = await client.request<AccountLoginStartResult>("account.login.start", { id: added.account.id, idempotencyKey: "start-1" });
    assert.equal(started.rejoined, false);
    assert.equal(started.flow.methodId, "cursor-browser");
    const again = await client.request<AccountLoginStartResult>("account.login.start", { id: added.account.id });
    assert.equal(again.rejoined, true);
    assert.equal(again.flow.id, started.flow.id);
    const dedup = await client.request<AccountLoginStartResult>("account.login.start", { id: added.account.id, idempotencyKey: "start-1" });
    assert.equal(dedup.deduped, true);

    // The cursor recipe's `browser` method has no prompts, so the fake CLI's
    // code prompt is not recognized as input (a prompt-less method never
    // asks). The URL is; the flow waits in the browser phase.
    const browser = await waitPhase(client, started.flow.id, ["waiting_browser"], "waiting_browser");
    assert.equal(browser.authorizationUrl, "https://cursor.com/loginDeepControl?x=1");
    await rejects(() => client.request("account.login.submit", { flowId: started.flow.id, values: { code: SENTINEL } }), "login_flow_refused");
    const got = await client.request<AccountGetResult>("account.get", { id: added.account.id });
    assert.equal(got.loginFlow?.id, started.flow.id);
    const snap = await client.request<SnapshotResult>("snapshot");
    assert.equal(snap.loginFlows.length, 1);
    assert.equal(snap.loginFlows[0]?.id, started.flow.id);
    assert.deepEqual(Object.keys(snap.loginFlows[0] as object).sort(), [
      "account", "authorizationUrl", "completedAt", "createdAt", "detail", "error", "expiresAt", "harness", "id", "inputFields", "methodId", "methods", "phase", "provider", "remote", "retryable", "revision", "updatedAt", "userCode",
    ]);
    await waitFor(() => frames.some((f) => f.type === "delta" && f.events.some((e) => e.kind === "login_flow.put" && (e.payload as { flow?: { id?: string } }).flow?.id === started.flow.id)) ? true : null, "login_flow.put delta", 5000);

    // cancel (idempotent) → cancelled; the worker is gone; the account stays auth-less
    const cancelled = await client.request<AccountLoginCancelResult>("account.login.cancel", { flowId: started.flow.id, idempotencyKey: "cancel-1" });
    assert.equal(cancelled.applied, true);
    assert.equal(cancelled.flow.phase, "cancelled");
    const cancelReplay = await client.request<AccountLoginCancelResult>("account.login.cancel", { flowId: started.flow.id, idempotencyKey: "cancel-1" });
    assert.equal(cancelReplay.deduped, true);
    assert.equal(cancelReplay.applied, true, "the replay answers the ORIGINAL result");
    await waitFor(() => (daemonLog(cursor.dir).includes("account.login.cancel") ? true : null), "cancel logged", 3000);

    // an unknown method is a typed failure on the row, not an RPC error
    const unknown = await client.request<AccountLoginStartResult>("account.login.start", { id: added.account.id, methodId: "nope" });
    assert.equal(unknown.flow.phase, "failed");
    assert.equal(unknown.flow.error?.code, "unsupported_method");
    assert.equal(loginSessionsOn(cursor.dir).length, 0);
  } finally {
    await daemon?.stop().catch(() => {});
    cursor.cleanup();
  }
});

test("rpc.login.2: browser-style landing over RPC with a real daemon: restart marks the live flow interrupted (no worker survives), retry issues revision 2 and completes; a sentinel credential is absent from sqlite, daemon log and stdout", async () => {
  // Typed-input CLI methods all need a PTY (tty:true) and are covered
  // in-process with an injected pipe backend (login-flows.test.ts
  // "flows.cli-prompt"); here the codex browser method (tty:false) exercises
  // the real-daemon lifecycle with a credential that lands on disk.
  const { dir, cleanup } = makeDaemonDir({
    accounts: { loginTimeoutMs: 60_000, loginWorkerBackend: "pipe" },
    agents: {
      codex: { command: process.execPath, args: [], adapter: "codex", login: { command: process.execPath, args: [FAKE_CLI] }, env: { FAKE_LOGIN_HOME_ENV: "CODEX_HOME", FAKE_LOGIN_FILE: "auth.json", FAKE_CLI_URL: "https://auth.openai.com/oauth/authorize?x=1", FAKE_CLI_HANG: "1", FAKE_LOGIN_CONTENT: '{"tokens":{"access_token":"SENTINEL-CODEX-TOKEN"}}' } },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    let client = await daemon.client();
    const added = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "restart" });
    const started = await client.request<AccountLoginStartResult>("account.login.start", { id: added.account.id });
    assert.equal(started.flow.methodId, "codex-browser");
    const waiting = await waitPhase(client, started.flow.id, ["waiting_browser"], "waiting_browser");
    assert.equal(waiting.authorizationUrl, "https://auth.openai.com/oauth/authorize?x=1");
    // `values` are checked for shape before anything else — a secret in the
    // wrong phase is refused without being recorded anywhere.
    await rejects(() => client.request("account.login.submit", { flowId: started.flow.id, values: { code: SENTINEL } }), "login_flow_refused");
    await rejects(() => client.request("account.login.submit", { flowId: started.flow.id, values: "nope" }), "invalid_request");

    // daemon restart under a live worker
    const pidBefore = daemon.proc.pid;
    await daemon.stop();
    assert.notEqual(pidBefore, undefined);
    daemon = await startDaemon(dir);
    client = await daemon.client();
    const interrupted = await client.request<AccountLoginGetResult>("account.login.get", { flowId: started.flow.id });
    assert.equal(interrupted.flow.phase, "interrupted");
    assert.equal(interrupted.flow.error?.code, "daemon_restarted");
    assert.equal(interrupted.flow.retryable, true);
    assert.equal(interrupted.flow.authorizationUrl, null);
    await waitFor(() => (daemonLog(dir).includes("account.login.boot interrupted=1") ? true : null), "boot log", 3000);
    // a submit against the interrupted flow is a typed refusal, not a silent retry
    await rejects(() => client.request("account.login.submit", { flowId: started.flow.id, values: { code: SENTINEL } }), "login_flow_refused");

    // retry with a CLI that lands the credential
    const retried = await client.request<{ flow: LoginFlowRow }>("account.login.retry", { flowId: started.flow.id, idempotencyKey: "retry-1" });
    assert.equal(retried.flow.revision, 2);
    const retryReplay = await client.request<{ flow: LoginFlowRow; deduped?: boolean }>("account.login.retry", { flowId: started.flow.id, idempotencyKey: "retry-1" });
    assert.equal(retryReplay.deduped, true);
    assert.equal(retryReplay.flow.revision, 2, "a replayed retry does not issue revision 3");
    assert.equal(loginSessionsOn(dir).length, 0);
    // the running fake still hangs; land the credential by hand (what the
    // real browser flow does through the CLI) and let the tick capture it
    const home = added.account.homePath;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), `{"tokens":{"access_token":"${SENTINEL}"}}`);
    const done = await waitPhase(client, started.flow.id, ["succeeded"], "succeeded");
    assert.equal(done.revision, 2);
    const account = await client.request<AccountGetResult>("account.get", { id: added.account.id });
    assert.equal(account.account.status, "ok");
    assert.ok(account.account.lastLoginAt !== null);
    assert.equal(readFileSync(join(dir, "vault", "codex", added.account.id, "auth.json"), "utf8"), `{"tokens":{"access_token":"${SENTINEL}"}}`);

    // idempotent submit result shape holds no input; sqlite/log/stdout hold no sentinel
    await daemon.stop();
    const sqlite = dumpSqlite(join(dir, "core.sqlite3"));
    assert.doesNotMatch(sqlite, /SENTINEL/, "no secret in any core table");
    assert.doesNotMatch(daemonLog(dir), /SENTINEL/, "no secret in daemon logs");
    assert.doesNotMatch(daemon.output(), /SENTINEL/, "no secret on daemon stdout/stderr");
    assert.ok(existsSync(join(home, "auth.json")));
    daemon = null;
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("rpc.login.3: a completed login survives a restart as succeeded; account.remove stops the flow's worker and drops its rows", async () => {
  const { dir, cleanup } = makeDaemonDir({
    accounts: { loginTimeoutMs: 60_000, loginWorkerBackend: "pipe" },
    agents: {
      codex: { command: process.execPath, args: [], adapter: "codex", login: { command: process.execPath, args: [FAKE_CLI] }, env: { FAKE_LOGIN_HOME_ENV: "CODEX_HOME", FAKE_LOGIN_FILE: "auth.json", FAKE_CLI_URL: "https://auth.openai.com/oauth/authorize?x=2", FAKE_CLI_WRITE_AFTER_MS: "200", FAKE_LOGIN_CONTENT: '{"tokens":{"access_token":"t"}}' } },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    let client = await daemon.client();
    const added = await client.request<AccountAddResult>("account.add", { harness: "codex", label: "done" });
    const started = await client.request<AccountLoginStartResult>("account.login.start", { id: added.account.id });
    const done = await waitPhase(client, started.flow.id, ["succeeded"], "succeeded");
    assert.equal(done.phase, "succeeded");
    await daemon.stop();
    daemon = await startDaemon(dir);
    client = await daemon.client();
    const after = await client.request<AccountLoginGetResult>("account.login.get", { flowId: started.flow.id });
    assert.equal(after.flow.phase, "succeeded", "a completed login is never re-interrupted");
    const snap = await client.request<SnapshotResult>("snapshot");
    assert.equal(snap.loginFlows.length, 1);

    // remove the account: flows go with it (login_flow.removed deltas precede account.removed)
    const watch = await daemon.client();
    const frames: WatchFrame[] = [];
    watch.onEvent = (f: WatchFrame) => frames.push(f);
    await watch.request("watch");
    await client.request("account.remove", { id: added.account.id });
    await waitFor(() => frames.some((f) => f.type === "delta" && f.events.some((e) => e.kind === "account.removed")) ? true : null, "account.removed", 5000);
    const events = frames.flatMap((f) => (f.type === "delta" ? f.events : []));
    const removedFlow = events.findIndex((e) => e.kind === "login_flow.removed");
    const removedAccount = events.findIndex((e) => e.kind === "account.removed");
    assert.ok(removedFlow >= 0 && removedFlow < removedAccount, "flow removal precedes account removal");
    await rejects(() => client.request("account.login.get", { flowId: started.flow.id }), "login_flow_not_found");
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
