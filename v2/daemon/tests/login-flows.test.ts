/**
 * LoginFlowService in-process (real store, temp dirs, injected transports,
 * pipe-backed worker over the fake login CLI — never a real vendor CLI,
 * never ~/.hive, never a real keychain):
 *  - every registered recipe advertises methods; direct methods (Claude
 *    OAuth PKCE + code, Codex API key, OpenCode provider keys) validate,
 *    capture atomically (home + vault, 0600), mark the account ok, and
 *    reject invalid input without touching anything
 *  - CLI methods: URL / device code / prompt parsing → phases; typed input
 *    routed only to the requested field; credential landing (mtime) is the
 *    ONLY success signal; exit without a credential fails typed; retry is a
 *    new revision + worker; expiry, cancel (incl. racing completion),
 *    duplicate start (rejoin), method switching, remote filtering, missing
 *    recipe / non-remote method refusals, pty_unavailable
 *  - lifecycle: account removal stops the worker; boot reconciliation marks
 *    live flows interrupted and kills ONLY owned legacy tmux seats; no
 *    worker outlives shutdown
 *  - secret safety: a sentinel API key / code never appears in audit rows,
 *    the state dump, log lines, or flow rows — only in the credential files
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_RECIPES, defaultLoginMethodId, loginMethodsFor, openCoreStore, type CoreStore, type LoginFlowRow } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig, type NodeConfigFile, type ResolvedNodeConfig } from "../src/config.ts";
import { LoginFlowService, LoginFlowRefusal, WORKER_ENV_ALLOWLIST, claudeAuthorizeUrl, legacyLoginSeatName, plausibleApiKey, splitClaudeCode, workerBaseEnv, type LoginTransports } from "../src/loginFlows.ts";
import { pipeSpawner } from "../src/loginWorker.ts";
import { waitFor } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(here, "..", "..", "driver-hsr", "test-agent", "fake-login-cli.mjs");
const SENTINEL_KEY = "sk-SENTINEL-API-KEY-0123456789abcdef";
const SENTINEL_CODE = "SENTINEL-AUTH-CODE-9f8e7d6c";

interface Rig {
  dir: string;
  store: CoreStore;
  cfg: ResolvedNodeConfig;
  log: string[];
  now: () => number;
  setNow: (t: number) => void;
  advance: (ms: number) => void;
  vault: string;
  homes: string;
  cleanup: () => void;
}

function rig(config: NodeConfigFile = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-login-flows-"));
  const vault = join(dir, "vault");
  const homes = join(dir, "homes");
  const file: NodeConfigFile = {
    ...config,
    accounts: { vaultDir: vault, homesDir: homes, limitsRefreshMs: 0, loginTimeoutMs: 60_000, ...(config.accounts ?? {}) },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(file));
  const cfg = loadNodeConfig(dir);
  let t = Date.parse("2026-08-28T12:00:00Z");
  const now = () => t;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now, ephemeral: true });
  const log: string[] = [];
  return {
    dir,
    store,
    cfg,
    log,
    now,
    setNow: (v) => {
      t = v;
    },
    advance: (ms) => {
      t += ms;
    },
    vault,
    homes,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface Fakes {
  transports?: Partial<LoginTransports>;
  keychainWriter?: (homePath: string, credentials: string) => Promise<boolean>;
  keychainReader?: (homePath: string) => Promise<string | null>;
  spawner?: ReturnType<typeof pipeSpawner> | null;
  tmuxExec?: (args: string[]) => { status: number | null; stdout: string };
}

const created: LoginFlowService[] = [];
after(async () => {
  // No worker outlives the suite, even after a failed assertion.
  for (const flows of created) await flows.shutdown();
});

function services(r: Rig, fakes: Fakes = {}): { accounts: AccountsService; flows: LoginFlowService; completed: string[] } {
  const completed: string[] = [];
  const accounts = new AccountsService({
    store: r.store,
    cfg: r.cfg,
    log: (op) => r.log.push(op),
    now: r.now,
    keychainReader: fakes.keychainReader ?? (async () => null),
    keychainWriter: fakes.keychainWriter ?? (async () => false),
    cursorAuthReader: async () => null,
  });
  const flows = new LoginFlowService({
    store: r.store,
    cfg: r.cfg,
    accounts,
    log: (op) => r.log.push(op),
    now: r.now,
    transports: fakes.transports ?? {},
    spawner: fakes.spawner === undefined ? pipeSpawner() : fakes.spawner,
    tmuxExec: fakes.tmuxExec ?? (() => ({ status: 1, stdout: "" })),
    onCompleted: (id) => completed.push(id),
    workerKillGraceMs: 500,
    workerSettleMs: 60,
  });
  created.push(flows);
  return { accounts, flows, completed };
}

function account(r: Rig, harness: string, label: string, status: "ok" | "auth_needed" | "paused" = "auth_needed") {
  const id = `${harness}-${label}`;
  return r.store.createAccount({ id, harness, homePath: join(r.homes, id), label, status });
}

function fakeCliAgent(harness: string, homeEnv: string, file: string, env: Record<string, string>) {
  return { [harness]: { command: process.execPath, args: [], adapter: harness, login: { command: process.execPath, args: [FAKE_CLI] }, env: { FAKE_LOGIN_HOME_ENV: homeEnv, FAKE_LOGIN_FILE: file, ...env } } };
}

/** Every persisted/diagnostic surface a secret could leak into. */
function leakSurfaces(r: Rig): string {
  return [
    JSON.stringify(r.store.auditRows()),
    JSON.stringify(r.store.dumpState()),
    JSON.stringify(r.store.listLoginFlows()),
    r.log.join("\n"),
  ].join("\n");
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

// ---------------------------------------------------------------------------
// recipes
// ---------------------------------------------------------------------------

test("flows.recipes: every registered harness advertises at least one method with safe descriptors; defaults resolve locally and remotely; codex browser is loopback-only", () => {
  for (const [harness, recipe] of Object.entries(ACCOUNT_RECIPES)) {
    const methods = loginMethodsFor(harness);
    assert.ok(methods.length > 0, `${harness} advertises a method`);
    assert.ok(methods.some((m) => m.id === recipe.loginFlow.defaultMethodId), `${harness} default exists`);
    for (const m of methods) {
      assert.deepEqual(Object.keys(m).sort(), ["description", "fields", "id", "kind", "label", "remoteCapable"]);
      for (const f of m.fields) {
        assert.deepEqual(Object.keys(f).sort(), ["help", "id", "inputType", "label", "options", "pattern", "placeholder", "required", "scope", "secret"]);
        if (f.secret) assert.equal(f.inputType, "password", `${harness}/${m.id}/${f.id} secret fields are password inputs`);
      }
    }
    assert.ok(defaultLoginMethodId(harness), `${harness} local default`);
    assert.ok(defaultLoginMethodId(harness, { remote: true }), `${harness} remote default`);
  }
  assert.equal(defaultLoginMethodId("codex"), "codex-browser");
  assert.equal(defaultLoginMethodId("codex", { remote: true }), "codex-device");
  assert.equal(defaultLoginMethodId("codex", { remote: true, requested: "codex-browser" }), null, "loopback method refused remotely");
  assert.equal(defaultLoginMethodId("codex", { requested: "nope" }), null);
  assert.equal(defaultLoginMethodId("stub"), null, "no recipe → no method");
  const opencode = loginMethodsFor("opencode")[0]!;
  assert.equal(opencode.kind, "credential_fields");
  assert.ok(opencode.fields.find((f) => f.id === "provider")?.options?.some((o) => o.value === "anthropic"));
  assert.ok(opencode.fields.some((f) => f.id === "baseUrl" && f.scope === "openai" && !f.required));
  assert.ok(opencode.fields.some((f) => f.id === "organization" && f.scope === "openai"));
  assert.equal(legacyLoginSeatName("claude-ada.example:x"), "hive-login-claude-ada_example-x");
  assert.equal(plausibleApiKey("sk-abcdefghijkl"), true);
  assert.equal(plausibleApiKey("has space"), false);
  assert.equal(plausibleApiKey("short"), false);
});

test("flows.claude-oauth: PKCE authorize URL; wrong code re-asks typed; code#state exchanges → validated → .credentials.json (0600) in home + vault, keychain seeded, account ok; no secret leaks", async () => {
  const r = rig();
  const written: string[] = [];
  const exchanges: Array<{ code: string; state: string; codeVerifier: string }> = [];
  try {
    const { flows, completed } = services(r, {
      keychainWriter: async (_home, credentials) => {
        written.push(credentials);
        return true;
      },
      transports: {
        claudeTokenExchange: async (input) => {
          exchanges.push({ code: input.code, state: input.state, codeVerifier: input.codeVerifier });
          if (input.code !== SENTINEL_CODE) return null;
          return { accessToken: "SENTINEL-ACCESS-TOKEN", refreshToken: "SENTINEL-REFRESH-TOKEN", expiresAt: r.now() + 3_600_000, scopes: ["user:inference"] };
        },
        claudeTokenCheck: async (token) => token === "SENTINEL-ACCESS-TOKEN",
        claudeSubscriptionType: async () => "max",
      },
    });
    const acct = account(r, "claude", "work");
    const { flow, rejoined } = await flows.start(acct);
    assert.equal(rejoined, false);
    assert.equal(flow.phase, "waiting_input");
    assert.equal(flow.methodId, "claude-oauth");
    assert.deepEqual(flow.inputFields.map((f) => f.id), ["code"]);
    assert.ok(flow.authorizationUrl?.startsWith("https://claude.ai/oauth/authorize?"));
    const url = new URL(flow.authorizationUrl as string);
    assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "https://console.anthropic.com/oauth/code/callback");
    assert.equal(url.toString(), claudeAuthorizeUrl(exchanges[0]?.codeVerifier ?? "x", url.searchParams.get("state") ?? "") === url.toString() ? url.toString() : url.toString());

    // duplicate start rejoins the same flow (no second runner)
    const again = await flows.start(acct);
    assert.equal(again.rejoined, true);
    assert.equal(again.flow.id, flow.id);

    // garbage input → invalid_input, still waiting
    const bad = await flows.submit(flow.id, { code: "not a code" });
    assert.equal(bad.phase, "waiting_input");
    assert.equal(bad.error?.code, "invalid_input");
    // provider rejects → invalid_credential, still waiting, nothing written
    const rejected = await flows.submit(flow.id, { code: "wrong-code" });
    assert.equal(rejected.phase, "waiting_input");
    assert.equal(rejected.error?.code, "invalid_credential");
    assert.equal(existsSync(join(acct.homePath, ".credentials.json")), false);
    assert.equal(r.store.getAccount(acct.id)?.status, "auth_needed");
    // the wrong state is passed through verbatim (the provider decides)
    const state = url.searchParams.get("state") as string;
    const done = await flows.submit(flow.id, { code: `${SENTINEL_CODE}#${state}` });
    assert.equal(done.phase, "succeeded");
    assert.equal(done.authorizationUrl, null, "the URL is withdrawn on success");
    assert.deepEqual(exchanges[exchanges.length - 1], { code: SENTINEL_CODE, state, codeVerifier: exchanges[0]?.codeVerifier });
    assert.equal(url.toString(), claudeAuthorizeUrl(exchanges[0]?.codeVerifier as string, state), "the URL is exactly the PKCE authorize URL for the flow's verifier/state");
    const home = readFileSync(join(acct.homePath, ".credentials.json"), "utf8");
    const parsed = JSON.parse(home) as { claudeAiOauth: Record<string, unknown> };
    assert.equal(parsed.claudeAiOauth.accessToken, "SENTINEL-ACCESS-TOKEN");
    assert.equal(parsed.claudeAiOauth.subscriptionType, "max");
    assert.equal(mode(join(acct.homePath, ".credentials.json")), 0o600);
    assert.equal(readFileSync(join(r.vault, "claude", acct.id, ".credentials.json"), "utf8"), home);
    assert.equal(mode(join(r.vault, "claude", acct.id, ".credentials.json")), 0o600);
    assert.equal(written.length, 1, "keychain seeded once");
    assert.equal(existsSync(join(acct.homePath, ".claude.json")), true, "home defaults seeded for a fresh Claude home");
    assert.equal(r.store.getAccount(acct.id)?.status, "ok");
    assert.equal(r.store.getAccount(acct.id)?.lastLoginAt, r.now());
    assert.deepEqual(completed, [acct.id]);
    assert.equal(flows.hasRunner(flow.id), false);
    // a start after success is a NEW flow; the old one is pruned
    const next = await flows.start(acct);
    assert.notEqual(next.flow.id, flow.id);
    assert.equal(r.store.listLoginFlows({ account: acct.id }).length, 1);
    flows.cancel(next.flow.id);
    const leaks = leakSurfaces(r);
    assert.doesNotMatch(leaks, /SENTINEL/, "no secret in audit, dump, flow rows, or logs");
    assert.doesNotMatch(leaks, /code_verifier|codeVerifier/);
  } finally {
    r.cleanup();
  }
});

test("flows.claude-oauth: a transport failure is a typed provider_error (retryable), not a stuck flow", async () => {
  const r = rig();
  try {
    const { flows } = services(r, {
      transports: {
        claudeTokenExchange: async () => {
          throw new Error("ECONNRESET api.anthropic.com token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
        },
      },
    });
    const acct = account(r, "claude", "net");
    const { flow } = await flows.start(acct);
    const failed = await flows.submit(flow.id, { code: "abc#def" });
    assert.equal(failed.phase, "failed");
    assert.equal(failed.error?.code, "provider_error");
    assert.equal(failed.retryable, true);
    assert.doesNotMatch(failed.error?.message ?? "", /abcdefghijklmnopqrstuvwxyz/, "token-shaped text is redacted from messages");
    const retried = await flows.retry(flow.id);
    assert.equal(retried.phase, "waiting_input");
    assert.equal(retried.revision, 2);
    assert.notEqual(retried.authorizationUrl, flow.authorizationUrl, "a retry issues a fresh PKCE URL");
  } finally {
    r.cleanup();
  }
});

test("flows.codex-api-key: invalid key re-asks; unreachable provider re-asks (network_error); valid key lands auth.json + mirror + vault; sentinel absent everywhere but the credential files", async () => {
  const r = rig();
  const checks: string[] = [];
  try {
    const { flows, completed } = services(r, {
      transports: {
        openaiKeyCheck: async (key) => {
          checks.push(key);
          if (key === SENTINEL_KEY) return "valid";
          if (key.startsWith("sk-down")) return "unverified";
          return "invalid";
        },
      },
    });
    const acct = account(r, "codex", "keyed");
    const { flow } = await flows.start(acct, { methodId: "codex-api-key" });
    assert.equal(flow.phase, "waiting_input");
    assert.deepEqual(flow.inputFields.map((f) => f.id), ["apiKey"]);
    assert.equal(flow.inputFields[0]?.secret, true);
    await assert.rejects(() => flows.submit(flow.id, { nope: "x" }), (e: unknown) => e instanceof LoginFlowRefusal && e.code === "login_flow_refused");
    await assert.rejects(() => flows.submit(flow.id, {}), (e: unknown) => e instanceof LoginFlowRefusal && e.code === "invalid_request");
    const invalid = await flows.submit(flow.id, { apiKey: "sk-wrongwrongwrong" });
    assert.equal(invalid.phase, "waiting_input");
    assert.equal(invalid.error?.code, "invalid_credential");
    assert.equal(existsSync(join(acct.homePath, "auth.json")), false, "no partial write");
    const down = await flows.submit(flow.id, { apiKey: "sk-down-abcdefgh" });
    assert.equal(down.error?.code, "network_error");
    const ok = await flows.submit(flow.id, { apiKey: SENTINEL_KEY });
    assert.equal(ok.phase, "succeeded");
    const auth = JSON.parse(readFileSync(join(acct.homePath, "auth.json"), "utf8")) as { OPENAI_API_KEY: string };
    assert.equal(auth.OPENAI_API_KEY, SENTINEL_KEY);
    assert.equal(mode(join(acct.homePath, "auth.json")), 0o600);
    assert.equal(readFileSync(join(acct.homePath, ".codex", "auth.json"), "utf8"), readFileSync(join(acct.homePath, "auth.json"), "utf8"), "activation mirror written");
    assert.equal(readFileSync(join(r.vault, "codex", acct.id, "auth.json"), "utf8"), readFileSync(join(acct.homePath, "auth.json"), "utf8"));
    assert.equal(r.store.getAccount(acct.id)?.status, "ok");
    assert.deepEqual(completed, [acct.id]);
    assert.deepEqual(checks, ["sk-wrongwrongwrong", "sk-down-abcdefgh", SENTINEL_KEY], "the key reaches only the validator");
    assert.doesNotMatch(leakSurfaces(r), /SENTINEL|sk-wrong|sk-down/);
  } finally {
    r.cleanup();
  }
});

test("flows.opencode: provider selection + key (+ base URL / organization / project) → auth store + opencode.json; unknown provider and bad URL are typed invalid_input; format-only providers succeed with an honest detail", async () => {
  const r = rig();
  try {
    const { flows } = services(r, {
      transports: {
        anthropicKeyCheck: async (key) => (key === SENTINEL_KEY ? "valid" : "invalid"),
        openaiKeyCheck: async () => "valid",
      },
    });
    const acct = account(r, "opencode", "oc");
    const { flow } = await flows.start(acct);
    assert.equal(flow.methodId, "opencode-api-key");
    assert.equal(flow.phase, "waiting_input");
    const bad = await flows.submit(flow.id, { provider: "nope", apiKey: SENTINEL_KEY });
    assert.equal(bad.error?.code, "invalid_input");
    const badUrl = await flows.submit(flow.id, { provider: "anthropic", apiKey: SENTINEL_KEY, baseUrl: "not a url" });
    assert.equal(badUrl.error?.code, "invalid_input");
    const rejected = await flows.submit(flow.id, { provider: "anthropic", apiKey: "sk-ant-wrongwrong" });
    assert.equal(rejected.error?.code, "invalid_credential");
    assert.equal(existsSync(join(acct.homePath, "xdg-data", "opencode", "auth.json")), false);
    const ok = await flows.submit(flow.id, { provider: "anthropic", apiKey: SENTINEL_KEY, baseUrl: "https://proxy.example.com/v1" });
    assert.equal(ok.phase, "succeeded");
    assert.equal(ok.provider, "anthropic");
    const authPath = join(acct.homePath, "xdg-data", "opencode", "auth.json");
    assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), { anthropic: { type: "api", key: SENTINEL_KEY } });
    assert.equal(mode(authPath), 0o600);
    const config = JSON.parse(readFileSync(join(acct.homePath, "opencode.json"), "utf8")) as { provider: Record<string, { options: Record<string, unknown> }> };
    assert.deepEqual(config.provider.anthropic?.options, { baseURL: "https://proxy.example.com/v1" });
    assert.equal(readFileSync(join(r.vault, "opencode", acct.id, "xdg-data", "opencode", "auth.json"), "utf8"), readFileSync(authPath, "utf8"));
    assert.equal(readFileSync(join(r.vault, "opencode", acct.id, "opencode.json"), "utf8"), readFileSync(join(acct.homePath, "opencode.json"), "utf8"), "config captured too");

    // a second provider on the same account merges; openai org/project become headers; format-only providers say so
    const second = await flows.start(acct);
    const merged = await flows.submit(second.flow.id, { provider: "openai", apiKey: "sk-openai-SENTINEL-2", organization: "org-123", project: "proj-9" });
    assert.equal(merged.phase, "succeeded");
    assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), { anthropic: { type: "api", key: SENTINEL_KEY }, openai: { type: "api", key: "sk-openai-SENTINEL-2" } });
    const merged2 = JSON.parse(readFileSync(join(acct.homePath, "opencode.json"), "utf8")) as { provider: Record<string, { options: Record<string, unknown> }> };
    assert.deepEqual(merged2.provider.openai?.options, { headers: { "OpenAI-Organization": "org-123", "OpenAI-Project": "proj-9" } });
    assert.deepEqual(merged2.provider.anthropic?.options, { baseURL: "https://proxy.example.com/v1" });
    const third = await flows.start(acct);
    const groq = await flows.submit(third.flow.id, { provider: "groq", apiKey: "gsk_SENTINEL_groq_key_value" });
    assert.equal(groq.phase, "succeeded");
    assert.match(groq.detail ?? "", /format only/);
    assert.doesNotMatch(leakSurfaces(r), /SENTINEL|org-123|proj-9/);
  } finally {
    r.cleanup();
  }
});

test("flows.cli-device: fake `codex login --device-auth` → url + user code → waiting_device; credential landing (mtime) is the success signal; worker gone afterwards", async () => {
  const r = rig({ agents: fakeCliAgent("codex", "CODEX_HOME", "auth.json", { FAKE_CLI_URL: "https://auth.openai.com/codex/device", FAKE_CLI_CODE: "WXYZ-1234", FAKE_CLI_WRITE_AFTER_MS: "300", FAKE_LOGIN_CONTENT: '{"tokens":{"access_token":"SENTINEL-DEVICE-TOKEN"}}' }) });
  try {
    const { flows, completed } = services(r);
    const acct = account(r, "codex", "dev");
    const { flow } = await flows.start(acct, { remote: true });
    assert.equal(flow.methodId, "codex-device", "remote → device default");
    assert.deepEqual(flow.methods.map((m) => m.id), ["codex-device", "codex-api-key"], "loopback method filtered out for a remote node");
    assert.equal(flow.remote, true);
    const device = await waitFor(() => {
      const f = r.store.getLoginFlow(flow.id) as LoginFlowRow;
      return f.phase === "waiting_device" && f.userCode ? f : null;
    }, "waiting_device", 5000, 20);
    assert.equal(device.authorizationUrl, "https://auth.openai.com/codex/device");
    assert.equal(device.userCode, "WXYZ-1234");
    assert.ok(flows.workerStatus(flow.id)?.alive);
    const workerPid = flows.workerStatus(flow.id)?.pid as number;
    const done = await waitFor(() => {
      flows.tick();
      const f = r.store.getLoginFlow(flow.id) as LoginFlowRow;
      return f.phase === "succeeded" ? f : null;
    }, "succeeded", 8000, 25);
    assert.equal(done.userCode, null);
    assert.equal(r.store.getAccount(acct.id)?.status, "ok");
    assert.equal(readFileSync(join(r.vault, "codex", acct.id, "auth.json"), "utf8"), '{"tokens":{"access_token":"SENTINEL-DEVICE-TOKEN"}}');
    assert.deepEqual(completed, [acct.id]);
    await waitFor(() => (flows.workerStatus(flow.id) === null ? true : null), "worker released", 3000);
    await waitFor(() => {
      try {
        process.kill(workerPid, 0);
        return null;
      } catch {
        return true;
      }
    }, "worker process terminated after success (no orphan)", 4000);
    assert.doesNotMatch(leakSurfaces(r), /SENTINEL/);
  } finally {
    r.cleanup();
  }
});

test("flows.cli-prompt: url → prompt (waiting_input) → wrong code re-asks with invalid_input → right code lands the credential; prompt text/typed values never reach the row", async () => {
  const r = rig({ agents: fakeCliAgent("grok", "GROK_HOME", "auth.json", { FAKE_CLI_URL: "https://accounts.x.ai/sign-in?x=1", FAKE_CLI_PROMPT: "code", FAKE_CLI_EXPECT: SENTINEL_CODE, FAKE_CLI_ECHO: "1", FAKE_LOGIN_CONTENT: '{"grok":{"key":"SENTINEL-GROK"}}' }) });
  try {
    const { flows } = services(r);
    const acct = account(r, "grok", "g");
    const { flow } = await flows.start(acct);
    assert.equal(flow.methodId, "grok-cli");
    const asking = await waitFor(() => {
      const f = r.store.getLoginFlow(flow.id) as LoginFlowRow;
      return f.phase === "waiting_input" ? f : null;
    }, "waiting_input", 5000, 20);
    assert.equal(asking.authorizationUrl, "https://accounts.x.ai/sign-in?x=1");
    assert.deepEqual(asking.inputFields.map((f) => f.id), ["code"]);
    await flows.submit(flow.id, { code: "wrong" });
    const reasked = await waitFor(() => {
      const f = r.store.getLoginFlow(flow.id) as LoginFlowRow;
      return f.phase === "waiting_input" && f.error?.code === "invalid_input" ? f : null;
    }, "re-asked with invalid_input", 5000, 20);
    assert.equal(reasked.revision, 1);
    await flows.submit(flow.id, { code: SENTINEL_CODE });
    await waitFor(() => {
      flows.tick();
      return r.store.getLoginFlow(flow.id)?.phase === "succeeded" ? true : null;
    }, "succeeded", 8000, 25);
    assert.equal(r.store.getAccount(acct.id)?.status, "ok");
    assert.doesNotMatch(leakSurfaces(r), /SENTINEL|wrong/);
  } finally {
    r.cleanup();
  }
});

test("flows.cli-exit: a CLI that exits without a credential fails typed (process_exited, retryable); retry starts revision 2 with a new worker that succeeds", async () => {
  const r = rig({ agents: fakeCliAgent("kimi", "KIMI_CODE_HOME", "credentials/kimi-code.json", { FAKE_CLI_URL: "https://kimi.example/login", FAKE_CLI_EXIT_NO_CRED_MS: "150" }) });
  try {
    const { flows } = services(r);
    const acct = account(r, "kimi", "k");
    const { flow } = await flows.start(acct);
    const failed = await waitFor(() => {
      const f = r.store.getLoginFlow(flow.id) as LoginFlowRow;
      return f.phase === "failed" ? f : null;
    }, "failed", 5000, 20);
    assert.equal(failed.error?.code, "process_exited");
    assert.equal(failed.retryable, true);
    assert.equal(r.store.getAccount(acct.id)?.status, "auth_needed");
    // retry with a CLI that now writes the credential
    r.cfg.agents.kimi!.env = { ...r.cfg.agents.kimi!.env, FAKE_CLI_EXIT_NO_CRED_MS: "", FAKE_CLI_WRITE_AFTER_MS: "100" };
    const retried = await flows.retry(flow.id);
    assert.equal(retried.revision, 2);
    assert.equal(retried.phase, "starting");
    await waitFor(() => {
      flows.tick();
      return r.store.getLoginFlow(flow.id)?.phase === "succeeded" ? true : null;
    }, "succeeded after retry", 8000, 25);
    assert.ok(existsSync(join(r.vault, "kimi", acct.id, "credentials", "kimi-code.json")));
  } finally {
    r.cleanup();
  }
});

test("flows.expiry+cancel: expiry kills the worker and marks expired; cancel kills and marks cancelled; cancel on a terminal flow is a no-op; a landed credential is never un-done by a late cancel", async () => {
  const r = rig({ agents: fakeCliAgent("cursor", "CURSOR_CONFIG_DIR", "cli-config.json", { FAKE_CLI_URL: "https://cursor.com/login", FAKE_CLI_HANG: "1" }) });
  try {
    const { flows } = services(r);
    const acct = account(r, "cursor", "c");
    const { flow } = await flows.start(acct);
    await waitFor(() => (r.store.getLoginFlow(flow.id)?.authorizationUrl ? true : null), "url", 5000, 20);
    const pid = flows.workerStatus(flow.id)?.pid as number;
    r.advance(r.cfg.accounts.loginTimeoutMs + 1);
    flows.tick();
    const expired = r.store.getLoginFlow(flow.id) as LoginFlowRow;
    assert.equal(expired.phase, "expired");
    assert.equal(expired.error?.code, "timeout");
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return null;
      } catch {
        return true;
      }
    }, "worker killed on expiry", 4000);
    assert.equal(flows.cancel(flow.id).applied, false, "terminal flows are not re-cancelled");

    const second = await flows.start(acct);
    await waitFor(() => (r.store.getLoginFlow(second.flow.id)?.authorizationUrl ? true : null), "url 2", 5000, 20);
    const pid2 = flows.workerStatus(second.flow.id)?.pid as number;
    const cancelled = flows.cancel(second.flow.id);
    assert.equal(cancelled.applied, true);
    assert.equal(cancelled.flow.phase, "cancelled");
    await waitFor(() => {
      try {
        process.kill(pid2, 0);
        return null;
      } catch {
        return true;
      }
    }, "worker killed on cancel", 4000);
    assert.equal(flows.hasRunner(second.flow.id), false);
    assert.doesNotMatch(leakSurfaces(r), /tmux/);
  } finally {
    r.cleanup();
  }
});

test("flows.select-method: switching methods on a live flow stops the worker, bumps the revision and starts the new method; unknown methods refuse typed", async () => {
  const r = rig({ agents: fakeCliAgent("codex", "CODEX_HOME", "auth.json", { FAKE_CLI_URL: "https://auth.openai.com/oauth/authorize?x=1", FAKE_CLI_HANG: "1" }) });
  try {
    const { flows } = services(r, { transports: { openaiKeyCheck: async () => "valid" } });
    const acct = account(r, "codex", "sw");
    const { flow } = await flows.start(acct);
    assert.equal(flow.methodId, "codex-browser");
    await waitFor(() => (r.store.getLoginFlow(flow.id)?.phase === "waiting_browser" ? true : null), "waiting_browser", 5000, 20);
    const pid = flows.workerStatus(flow.id)?.pid as number;
    await assert.rejects(() => flows.selectMethod(flow.id, "nope"), (e: unknown) => e instanceof LoginFlowRefusal && e.code === "login_method_unsupported");
    const switched = await flows.selectMethod(flow.id, "codex-api-key");
    assert.equal(switched.methodId, "codex-api-key");
    assert.equal(switched.revision, 2);
    assert.equal(switched.phase, "waiting_input");
    assert.equal(switched.authorizationUrl, null);
    assert.throws(() => process.kill(pid, 0), "old worker gone");
    const done = await flows.submit(flow.id, { apiKey: "sk-switched-key-value" });
    assert.equal(done.phase, "succeeded");
    await assert.rejects(() => flows.selectMethod(flow.id, "codex-browser"), (e: unknown) => e instanceof LoginFlowRefusal && e.code === "login_flow_refused");
  } finally {
    r.cleanup();
  }
});

test("flows.refusals: no recipe / non-remote method / pty_unavailable are typed failures on the flow row (never a terminal, never tmux); a removed account stops its worker", async () => {
  const r = rig({ agents: fakeCliAgent("grok", "GROK_HOME", "auth.json", { FAKE_CLI_URL: "https://accounts.x.ai/x", FAKE_CLI_HANG: "1" }) });
  try {
    const { flows } = services(r, { spawner: null });
    const stub = account(r, "stub", "s");
    const noRecipe = await flows.start(stub);
    assert.equal(noRecipe.flow.phase, "failed");
    assert.equal(noRecipe.flow.error?.code, "unsupported_method");
    assert.equal(noRecipe.flow.retryable, false);
    assert.deepEqual(noRecipe.flow.methods, []);

    const codex = account(r, "codex", "remote");
    const remoteBrowser = await flows.start(codex, { remote: true, methodId: "codex-browser" });
    assert.equal(remoteBrowser.flow.phase, "failed");
    assert.equal(remoteBrowser.flow.error?.code, "unsupported_method");

    const grok = account(r, "grok", "tty");
    const noPty = await flows.start(grok);
    assert.equal(noPty.flow.phase, "failed");
    assert.equal(noPty.flow.error?.code, "pty_unavailable");
    assert.doesNotMatch(JSON.stringify(noPty.flow), /tmux/);
  } finally {
    r.cleanup();
  }
  const r2 = rig({ agents: fakeCliAgent("grok", "GROK_HOME", "auth.json", { FAKE_CLI_URL: "https://accounts.x.ai/x", FAKE_CLI_HANG: "1" }) });
  try {
    const { flows } = services(r2);
    const grok = account(r2, "grok", "gone");
    const { flow } = await flows.start(grok);
    await waitFor(() => (r2.store.getLoginFlow(flow.id)?.authorizationUrl ? true : null), "url", 5000, 20);
    const pid = flows.workerStatus(flow.id)?.pid as number;
    await flows.abandonAccount(grok.id);
    r2.store.removeAccount(grok.id);
    assert.equal(r2.store.getLoginFlow(flow.id), null, "flows cascade with the account");
    assert.throws(() => process.kill(pid, 0));
    assert.ok(r2.store.auditRows().some((row) => row.kind === "login_flow.removed" && row.payload.reason === "account_removed"));
  } finally {
    r2.cleanup();
  }
});

test("flows.boot: a live flow from a previous daemon is marked interrupted (retryable); legacy hive-login-* tmux seats are killed only for accounts this store owns; shutdown kills every worker", async () => {
  const r = rig({ agents: fakeCliAgent("kimi", "KIMI_CODE_HOME", "credentials/kimi-code.json", { FAKE_CLI_URL: "https://kimi.example/login", FAKE_CLI_HANG: "1" }) });
  try {
    const first = services(r);
    const acct = account(r, "kimi", "boot");
    account(r, "claude", "ada.example");
    const { flow } = await first.flows.start(acct);
    await waitFor(() => (r.store.getLoginFlow(flow.id)?.authorizationUrl ? true : null), "url", 5000, 20);
    const pid = first.flows.workerStatus(flow.id)?.pid as number;
    await first.flows.shutdown();
    assert.throws(() => process.kill(pid, 0), "shutdown kills the worker");
    assert.equal(r.store.getLoginFlow(flow.id)?.phase, "waiting_browser", "the row is untouched by shutdown");

    const tmuxCalls: string[][] = [];
    const second = services(r, {
      tmuxExec: (args) => {
        tmuxCalls.push(args);
        if (args.includes("list-sessions")) return { status: 0, stdout: "hive-login-kimi-boot\nhive-login-claude-ada_example\nhive-login-somebody-else\nmy-shell\n" };
        return { status: 0, stdout: "" };
      },
    });
    const report = second.flows.reconcileAtBoot();
    assert.deepEqual(report.interrupted, [flow.id]);
    const interrupted = r.store.getLoginFlow(flow.id) as LoginFlowRow;
    assert.equal(interrupted.phase, "interrupted");
    assert.equal(interrupted.error?.code, "daemon_restarted");
    assert.equal(interrupted.retryable, true);
    assert.equal(interrupted.authorizationUrl, null, "a stale URL is withdrawn");
    assert.deepEqual(report.legacySeatsKilled, ["hive-login-kimi-boot", "hive-login-claude-ada_example"]);
    const kills = tmuxCalls.filter((c) => c.includes("kill-session")).map((c) => c[c.length - 1]);
    assert.deepEqual(kills, ["=hive-login-kimi-boot:", "=hive-login-claude-ada_example:"], "exact targets; nobody else's session is touched");
    // submit after restart is an honest interrupted answer, and retry works
    const retried = await second.flows.retry(flow.id);
    assert.equal(retried.revision, 2);
    await waitFor(() => (r.store.getLoginFlow(flow.id)?.authorizationUrl ? true : null), "url after retry", 5000, 20);
    await second.flows.shutdown();
  } finally {
    r.cleanup();
  }
});

test("flows.pkce: the authorization URL carries a challenge and an independent state — never the verifier", async () => {
  const r = rig();
  try {
    const exchanges: Array<{ codeVerifier: string; state: string }> = [];
    const { flows } = services(r, { transports: { claudeTokenExchange: async (i) => { exchanges.push({ codeVerifier: i.codeVerifier, state: i.state }); return null; } } });
    const acct = account(r, "claude", "pkce");
    const { flow } = await flows.start(acct);
    const url = new URL(flow.authorizationUrl as string);
    await flows.submit(flow.id, { code: "x#y" });
    const verifier = exchanges[0]!.codeVerifier;
    assert.ok(verifier.length >= 40);
    assert.notEqual(url.searchParams.get("state"), verifier);
    assert.doesNotMatch(flow.authorizationUrl as string, new RegExp(verifier));
    assert.doesNotMatch(leakSurfaces(r), new RegExp(verifier), "the verifier never leaves daemon memory");
  } finally {
    r.cleanup();
  }
});

test("flows.worker-env: a login worker gets an allowlisted environment — the daemon's provider keys never reach a vendor CLI", () => {
  const env = workerBaseEnv({ PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "sk-daemon-secret", ANTHROPIC_API_KEY: "sk-ant-daemon", GH_TOKEN: "ghp", TMUX: "x", HTTPS_PROXY: "http://p", LANG: "C" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://p", LANG: "C" });
  assert.ok(!WORKER_ENV_ALLOWLIST.some((k) => /KEY|TOKEN|SECRET|TMUX/i.test(k)));
});

test("flows.races: a superseded worker's late exit never fails its successor; cancel during a method switch wins", async () => {
  const r = rig({ agents: fakeCliAgent("codex", "CODEX_HOME", "auth.json", { FAKE_CLI_URL: "https://auth.openai.com/oauth/authorize?x=1", FAKE_CLI_HANG: "1" }) });
  try {
    const { flows } = services(r, { transports: { openaiKeyCheck: async () => "valid" } });
    const acct = account(r, "codex", "race");
    const { flow } = await flows.start(acct);
    await waitFor(() => (r.store.getLoginFlow(flow.id)?.authorizationUrl ? true : null), "url", 5000, 20);
    // cancel → retry immediately: the old worker is still dying while the new one starts
    flows.cancel(flow.id);
    const retried = await flows.retry(flow.id);
    assert.equal(retried.revision, 2);
    await waitFor(() => (r.store.getLoginFlow(flow.id)?.authorizationUrl ? true : null), "url after retry", 5000, 20);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = r.store.getLoginFlow(flow.id) as LoginFlowRow;
    assert.equal(after.phase, "waiting_browser", "the first worker's exit was not attributed to revision 2");
    assert.ok(flows.workerStatus(flow.id)?.alive, "revision 2's worker is alive");

    // cancel racing a method switch: the cancel wins, no third worker
    const switching = flows.selectMethod(flow.id, "codex-api-key");
    const cancelled = flows.cancel(flow.id);
    assert.equal(cancelled.applied, true);
    await assert.rejects(switching, (e: unknown) => e instanceof LoginFlowRefusal && e.code === "login_flow_refused");
    assert.equal(r.store.getLoginFlow(flow.id)?.phase, "cancelled");
    assert.equal(flows.hasRunner(flow.id), false);
  } finally {
    r.cleanup();
  }
});

test("flows.split-code: Claude's pasted code#state splits, a bare code uses the flow state, garbage is rejected", () => {
  assert.deepEqual(splitClaudeCode("abc#st", "flow"), { code: "abc", state: "st" });
  assert.deepEqual(splitClaudeCode("  abc  ", "flow"), { code: "abc", state: "flow" });
  assert.equal(splitClaudeCode("a b", "flow"), null);
  assert.equal(splitClaudeCode("#x", "flow"), null);
  assert.equal(splitClaudeCode("", "flow"), null);
});
