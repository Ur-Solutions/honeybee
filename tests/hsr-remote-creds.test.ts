/**
 * Per-node ephemeral credential delivery for remote HSR (APIA-93).
 *
 * SECURITY-SENSITIVE. Exercised with FAKE credentials only — no real
 * `claude setup-token` is minted (the exec is injected) and no real auth.json is
 * shipped. Real token minting + real ssh delivery are covered at APIA-98.
 *
 * Covers:
 *  - mintEphemeralCredential: codex ships the vaulted auth.json; claude mints a
 *    token via the (injected) setup-token exec, and falls back to shipping
 *    .credentials.json when the exec is unavailable. Secrets never leak into the
 *    (secret-free) kindNote.
 *  - end-to-end delivery over a locally-run remote serve (the APIA-92 harness):
 *    spawnRemote with `creds` writes the fake credential into the remote isolated
 *    home at 0600; `kill` shreds it (the file is GONE). A write failure surfaces
 *    a generic, secret-free error.
 *  - authPolicy gating in `hive spawn`: a local-only remote-hsr account spawn
 *    throws; an ephemeral-token node gets PAST the gate (into minting).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "../src/hsr/remoteHost.js";
import { createRemoteHsrSubstrate } from "../src/substrates/remote-hsr.js";
import { clearSubstrateCache } from "../src/substrates/index.js";
import { mintEphemeralCredential } from "../src/hsr/remoteCreds.js";
import { identityEnvForAgent } from "../src/drivers.js";
import { accountDir, type AccountRecord } from "../src/accounts.js";
import type { NodeRecord } from "../src/node.js";
import type { TunnelChild, TunnelSpawnHook, SshExecHook } from "../src/hsr/remoteTransport.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-rc-");
  process.env.HIVE_STORE_ROOT = dir;
  clearSubstrateCache();
  try {
    await fn(dir);
  } finally {
    clearSubstrateCache();
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function fakeAccount(overrides: Partial<AccountRecord> & Pick<AccountRecord, "id" | "tool" | "label">): AccountRecord {
  return { provider: "openai", addedAt: "2026-07-03T00:00:00.000Z", ...overrides };
}

async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

// ── mint side (local) ──────────────────────────────────────────────────────

// A minimal, UNVERIFIED codex-style JWT: header.payload.sig with a chosen `exp`
// (unix seconds). Not signed — remoteCreds only DECODES exp, never verifies.
function fakeJwt(expSeconds: number): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds })}.sig`;
}

function codexAuthJson(fields: { accessExpSeconds: number; refresh: string; idEmail?: string }): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt(fields.accessExpSeconds), // stand-in id_token JWT
      access_token: fakeJwt(fields.accessExpSeconds),
      refresh_token: fields.refresh,
      account_id: "acct-123",
    },
    last_refresh: "2026-07-05T00:00:00.000Z",
  });
}

test("mintEphemeralCredential: codex ships an access-token-only auth.json (refresh_token blanked), preserving the other tokens, never leaking", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "codex-fake", tool: "codex", label: "fake", provider: "openai" });
    const REFRESH_SECRET = "SECRET-refresh-token-DO-NOT-SHIP-abc123";
    const freshExp = Math.floor(Date.now() / 1000) + 240 * 3600; // 10 days out
    const raw = codexAuthJson({ accessExpSeconds: freshExp, refresh: REFRESH_SECRET });
    const accessToken = (JSON.parse(raw) as { tokens: { access_token: string } }).tokens.access_token;
    const idToken = (JSON.parse(raw) as { tokens: { id_token: string } }).tokens.id_token;
    await mkdir(accountDir(account), { recursive: true, mode: 0o700 });
    await writeFile(join(accountDir(account), "auth.json"), raw, { mode: 0o600 });

    // Fresh token → the injected central refresh is still called but is a no-op.
    let ensureCalled = false;
    const cred = await mintEphemeralCredential(account, "codex", {
      ensureFreshCodexToken: async () => {
        ensureCalled = true;
      },
    });
    assert.ok(ensureCalled, "central freshness check runs before shipping");
    assert.equal(cred.files.length, 1);
    assert.equal(cred.files[0]!.homeRelPath, "auth.json");
    assert.equal(cred.files[0]!.mode, 0o600);
    assert.equal(cred.env, undefined);
    assert.equal(cred.expiresAt, freshExp, "expiresAt carries the access token's exp (non-secret)");

    const shipped = JSON.parse(Buffer.from(cred.files[0]!.contentB64, "base64").toString("utf8")) as {
      tokens: { access_token: string; id_token: string; refresh_token: string; account_id: string };
      auth_mode: string;
    };
    assert.equal(shipped.tokens.refresh_token, "", "refresh_token is blanked (field kept)");
    assert.ok("refresh_token" in shipped.tokens, "refresh_token field is present (deleting it breaks codex serde)");
    assert.equal(shipped.tokens.access_token, accessToken, "access_token preserved");
    assert.equal(shipped.tokens.id_token, idToken, "id_token preserved");
    assert.equal(shipped.tokens.account_id, "acct-123", "account_id preserved");
    assert.equal(shipped.auth_mode, "chatgpt", "auth_mode preserved");

    // Guardrails: neither the shipped bytes nor the note carry the refresh token.
    assert.ok(!Buffer.from(cred.files[0]!.contentB64, "base64").toString("utf8").includes(REFRESH_SECRET), "refresh token never shipped");
    assert.ok(!cred.kindNote.includes(REFRESH_SECRET), "kindNote must not leak the refresh token");
    assert.match(cred.kindNote, /refresh_token blanked/);
  });
});

test("mintEphemeralCredential: codex triggers the central refresh when the vaulted token is stale, then ships the refreshed token", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "codex-stale", tool: "codex", label: "stale", provider: "openai" });
    const authPath = join(accountDir(account), "auth.json");
    await mkdir(accountDir(account), { recursive: true, mode: 0o700 });
    // Start with a token that already expired.
    const staleExp = Math.floor(Date.now() / 1000) - 60;
    await writeFile(authPath, codexAuthJson({ accessExpSeconds: staleExp, refresh: "real-refresh" }), { mode: 0o600 });

    // The injected refresh simulates codex rotating the vault token in place.
    const freshExp = Math.floor(Date.now() / 1000) + 240 * 3600;
    let refreshRan = false;
    const cred = await mintEphemeralCredential(account, "codex", {
      ensureFreshCodexToken: async () => {
        refreshRan = true;
        await writeFile(authPath, codexAuthJson({ accessExpSeconds: freshExp, refresh: "rotated-refresh" }), { mode: 0o600 });
      },
    });
    assert.ok(refreshRan, "central refresh was triggered for the stale token");
    assert.equal(cred.expiresAt, freshExp, "ships the refreshed token's exp");
    const shipped = JSON.parse(Buffer.from(cred.files[0]!.contentB64, "base64").toString("utf8")) as { tokens: { refresh_token: string } };
    assert.equal(shipped.tokens.refresh_token, "");
  });
});

test("mintEphemeralCredential: codex auth.json with no access_token is refused", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "codex-noat", tool: "codex", label: "noat", provider: "openai" });
    await mkdir(accountDir(account), { recursive: true, mode: 0o700 });
    await writeFile(join(accountDir(account), "auth.json"), JSON.stringify({ tokens: { refresh_token: "x" } }), { mode: 0o600 });
    await assert.rejects(
      () => mintEphemeralCredential(account, "codex", { ensureFreshCodexToken: async () => undefined }),
      /no tokens\.access_token/,
    );
  });
});

test("mintEphemeralCredential: claude mints a setup-token (injected) delivered as env, no file, no leak", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "claude-fake", tool: "claude", label: "fake", provider: "anthropic" });
    const TOKEN = "sk-ant-oat01-FAKE-setup-token-never-real-xyz";
    let mintedFor: string | undefined;
    const cred = await mintEphemeralCredential(account, "claude", {
      runClaudeSetupToken: async (home) => {
        mintedFor = home;
        return TOKEN;
      },
    });
    assert.deepEqual(cred.files, []);
    assert.equal(cred.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.ok(mintedFor && mintedFor.includes("claude-fake"), "minted against the account's local home");
    assert.ok(!cred.kindNote.includes(TOKEN), "kindNote must not leak the token");
  });
});

test("mintEphemeralCredential: claude falls back to shipping .credentials.json when setup-token is unavailable", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "claude-fb", tool: "claude", label: "fb", provider: "anthropic" });
    const SECRET = "SECRET-claude-credentials-fallback-000";
    await mkdir(accountDir(account), { recursive: true, mode: 0o700 });
    await writeFile(join(accountDir(account), ".credentials.json"), SECRET, { mode: 0o600 });

    const cred = await mintEphemeralCredential(account, "claude", { runClaudeSetupToken: async () => null });
    assert.equal(cred.files.length, 1);
    assert.equal(cred.files[0]!.homeRelPath, ".credentials.json");
    assert.match(cred.kindNote, /weaker guarantee/);
    assert.ok(!cred.kindNote.includes(SECRET));
  });
});

test("mintEphemeralCredential: unsupported harness (cursor) is refused", async () => {
  await withTempStore(async () => {
    // cursor stays local-only (machine-global keychain) — no ephemeral policy.
    const account = fakeAccount({ id: "cursor-x", tool: "cursor", label: "x", provider: "cursor" });
    await assert.rejects(() => mintEphemeralCredential(account, "cursor"), /not wired for harness "cursor"/);
  });
});

// ── grok / kimi / opencode ephemeral delivery (APIA-93 flip) ─────────────────

async function seedVaultFile(account: AccountRecord, relPath: string, contents: string): Promise<void> {
  const abs = join(accountDir(account), relPath);
  await mkdir(join(abs, ".."), { recursive: true, mode: 0o700 });
  await writeFile(abs, contents, { mode: 0o600 });
}

function decodeShipped(cred: { files: { contentB64: string }[] }): string {
  return Buffer.from(cred.files[0]!.contentB64, "base64").toString("utf8");
}

test("mintEphemeralCredential: grok ships auth.json with the OAuth refresh_token blanked, key/expiry preserved, no leak", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "grok-sub", tool: "grok", label: "sub", provider: "xai" });
    const REFRESH_SECRET = "SECRET-grok-refresh-DO-NOT-SHIP-77aa";
    const KEY = "grok-access-key-KEEP-me";
    // grok's real shape: keyed by "<issuer>::<client>", entry carries key + refresh_token.
    const authJson = JSON.stringify({
      "https://auth.x.ai::client-1": {
        auth_mode: "oidc",
        email: "grok@example.com",
        key: KEY,
        refresh_token: REFRESH_SECRET,
        create_time: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-08-30T00:00:00.000Z",
        principal_type: "User",
      },
    });
    await seedVaultFile(account, "auth.json", authJson);

    const cred = await mintEphemeralCredential(account, "grok");
    assert.equal(cred.files.length, 1);
    assert.equal(cred.files[0]!.homeRelPath, "auth.json");
    assert.equal(cred.files[0]!.mode, 0o600);
    assert.equal(cred.env, undefined, "grok delivers a file, not env (XAI_API_KEY scrub is the adapter's job)");

    const shipped = JSON.parse(decodeShipped(cred)) as Record<string, { key: string; refresh_token: string; expires_at: string }>;
    const entry = shipped["https://auth.x.ai::client-1"]!;
    assert.equal(entry.refresh_token, "", "refresh_token blanked (field kept)");
    assert.ok("refresh_token" in entry, "refresh_token field is preserved");
    assert.equal(entry.key, KEY, "access key preserved");
    assert.equal(entry.expires_at, "2026-08-30T00:00:00.000Z", "expiry preserved");
    assert.ok(!decodeShipped(cred).includes(REFRESH_SECRET), "refresh token never shipped");
    assert.ok(!cred.kindNote.includes(REFRESH_SECRET), "kindNote never leaks the refresh token");
    assert.ok(!cred.kindNote.includes(KEY), "kindNote never leaks the access key");
    assert.match(cred.kindNote, /refresh token\(s\) blanked/);
  });
});

test("mintEphemeralCredential: kimi ships credentials/kimi-code.json with the rotating refresh_token blanked, access token preserved", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "kimi-sub", tool: "kimi", label: "sub", provider: "moonshot" });
    const REFRESH_SECRET = "SECRET-kimi-rotating-refresh-9911";
    const ACCESS = "kimi-access-token-KEEP";
    // kimi's real shape: FLAT object; refresh_token rotates on every grant.
    const flat = JSON.stringify({
      access_token: ACCESS,
      refresh_token: REFRESH_SECRET,
      expires_at: Math.floor(Date.now() / 1000) + 900,
      scope: "read",
      token_type: "Bearer",
    });
    await seedVaultFile(account, "credentials/kimi-code.json", flat);

    const cred = await mintEphemeralCredential(account, "kimi");
    assert.equal(cred.files.length, 1);
    assert.equal(cred.files[0]!.homeRelPath, "credentials/kimi-code.json");
    assert.equal(cred.files[0]!.mode, 0o600);

    const shipped = JSON.parse(decodeShipped(cred)) as { access_token: string; refresh_token: string; token_type: string };
    assert.equal(shipped.refresh_token, "", "rotating refresh_token blanked");
    assert.equal(shipped.access_token, ACCESS, "access token preserved");
    assert.equal(shipped.token_type, "Bearer", "other fields preserved");
    assert.ok(!decodeShipped(cred).includes(REFRESH_SECRET), "refresh token never shipped");
    assert.ok(!cred.kindNote.includes(REFRESH_SECRET));
  });
});

test("mintEphemeralCredential: opencode ships ONLY the account's provider entry (others dropped), oauth refresh blanked", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "oc-oauth", tool: "opencode", label: "oauth", provider: "anthropic" });
    const KEPT_ACCESS = "anthropic-access-KEEP";
    const KEPT_REFRESH = "SECRET-anthropic-refresh-DROP-me";
    const FOREIGN_KEY = "SECRET-openai-key-of-another-provider-DROP";
    // Multi-provider auth.json: the account owns "anthropic" only.
    const authJson = JSON.stringify({
      anthropic: { type: "oauth", access: KEPT_ACCESS, refresh: KEPT_REFRESH, expires: 1_900_000_000_000 },
      openai: { type: "api", key: FOREIGN_KEY },
      "zai-coding-plan": { type: "api", key: "SECRET-zai-key-DROP" },
    });
    await seedVaultFile(account, "xdg-data/opencode/auth.json", authJson);

    const cred = await mintEphemeralCredential(account, "opencode");
    assert.equal(cred.files.length, 1);
    assert.equal(cred.files[0]!.homeRelPath, "xdg-data/opencode/auth.json");
    assert.equal(cred.files[0]!.mode, 0o600);

    const shipped = JSON.parse(decodeShipped(cred)) as Record<string, { type: string; access?: string; refresh?: string; key?: string }>;
    assert.deepEqual(Object.keys(shipped), ["anthropic"], "only the account's provider entry is shipped");
    assert.equal(shipped.anthropic!.access, KEPT_ACCESS, "kept provider access token preserved");
    assert.equal(shipped.anthropic!.refresh, "", "kept provider OAuth refresh blanked");
    const bytes = decodeShipped(cred);
    assert.ok(!bytes.includes(FOREIGN_KEY), "a foreign provider's api key is NEVER shipped");
    assert.ok(!bytes.includes("SECRET-zai-key-DROP"), "no other provider's credential is shipped");
    assert.ok(!bytes.includes(KEPT_REFRESH), "the kept provider's refresh token is never shipped");
    assert.ok(!cred.kindNote.includes(KEPT_REFRESH) && !cred.kindNote.includes(FOREIGN_KEY), "kindNote leaks no secrets");
    assert.match(cred.kindNote, /single-provider \(anthropic\)/);
  });
});

test("mintEphemeralCredential: opencode api-key provider ships its key verbatim (single provider), other providers dropped", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "oc-glm", tool: "opencode", label: "glm", provider: "zai-coding-plan" });
    const GLM_KEY = "zai-coding-plan-api-key-KEEP-billing";
    const FOREIGN = "SECRET-anthropic-oauth-refresh-DROP";
    const authJson = JSON.stringify({
      "zai-coding-plan": { type: "api", key: GLM_KEY },
      anthropic: { type: "oauth", access: "x", refresh: FOREIGN, expires: 1 },
    });
    await seedVaultFile(account, "xdg-data/opencode/auth.json", authJson);

    const cred = await mintEphemeralCredential(account, "opencode");
    const shipped = JSON.parse(decodeShipped(cred)) as Record<string, { type: string; key?: string }>;
    assert.deepEqual(Object.keys(shipped), ["zai-coding-plan"]);
    assert.equal(shipped["zai-coding-plan"]!.key, GLM_KEY, "the intended provider billing key ships verbatim");
    assert.ok(!decodeShipped(cred).includes(FOREIGN), "the dropped provider's refresh token is never shipped");
  });
});

test("mintEphemeralCredential: opencode fails closed when the account has no provider", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "oc-noprov", tool: "opencode", label: "noprov", provider: undefined });
    await seedVaultFile(account, "xdg-data/opencode/auth.json", JSON.stringify({ anthropic: { type: "api", key: "x" } }));
    await assert.rejects(() => mintEphemeralCredential(account, "opencode"), /has no provider/);
  });
});

test("mintEphemeralCredential: opencode fails closed when auth.json has no entry for the account's provider", async () => {
  await withTempStore(async () => {
    const account = fakeAccount({ id: "oc-missing", tool: "opencode", label: "missing", provider: "anthropic" });
    await seedVaultFile(account, "xdg-data/opencode/auth.json", JSON.stringify({ openai: { type: "api", key: "x" } }));
    await assert.rejects(() => mintEphemeralCredential(account, "opencode"), /no entry for provider "anthropic"/);
  });
});

test("opencode delivery: the remote re-derives XDG_DATA_HOME against its OWN home so the delivered auth.json is found", () => {
  // The delivered file lands at <remoteHome>/xdg-data/opencode/auth.json; the
  // child discovers it via XDG_DATA_HOME. remoteHost re-templates this identity
  // env against the REMOTE home (startRunner), overriding the local path baked
  // into spec.env. grok/kimi/codex/claude have no home-relative extraEnv → {}.
  assert.deepEqual(identityEnvForAgent("opencode", "/remote/store/hsr/bee/home"), {
    XDG_DATA_HOME: "/remote/store/hsr/bee/home/xdg-data",
  });
  assert.deepEqual(identityEnvForAgent("grok", "/remote/store/hsr/bee/home"), {});
  assert.deepEqual(identityEnvForAgent("kimi", "/remote/store/hsr/bee/home"), {});
});

test("mintEphemeralCredential: grok/opencode fail closed on a malformed credential file (no partial ship)", async () => {
  await withTempStore(async () => {
    const grok = fakeAccount({ id: "grok-bad", tool: "grok", label: "bad", provider: "xai" });
    await seedVaultFile(grok, "auth.json", "{not json");
    await assert.rejects(() => mintEphemeralCredential(grok, "grok"), /not valid JSON/);

    const oc = fakeAccount({ id: "oc-bad", tool: "opencode", label: "bad", provider: "anthropic" });
    await seedVaultFile(oc, "xdg-data/opencode/auth.json", "[\"array-not-map\"]");
    await assert.rejects(() => mintEphemeralCredential(oc, "opencode"), /not a provider map/);
  });
});

// ── delivery / shred over a locally-run remote serve (APIA-92 harness) ──────

function makeNode(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name: "loopcred",
    kind: "remote-hsr",
    endpoint: "me@remote-host",
    capabilities: ["*"],
    runnerHostVersion: "0.0.1+deadbeef1234",
    status: "unknown",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

function parseForward(argv: string[]): { local: string; remote: string } {
  const i = argv.indexOf("-L");
  assert.ok(i >= 0 && argv[i + 1], "forward argv must contain -L <local>:<remote>");
  const spec = argv[i + 1]!;
  const cut = spec.indexOf(":");
  return { local: spec.slice(0, cut), remote: spec.slice(cut + 1) };
}

function makeRelayTunnel(): { hook: TunnelSpawnHook; killAll: () => void } {
  const servers: Server[] = [];
  const hook: TunnelSpawnHook = (argv) => {
    const { local, remote } = parseForward(argv);
    const conns = new Set<Socket>();
    const relay: Server = createServer((down) => {
      conns.add(down);
      const up = createConnection(remote);
      conns.add(up);
      down.pipe(up);
      up.pipe(down);
      const bail = (): void => {
        down.destroy();
        up.destroy();
      };
      down.on("error", bail);
      up.on("error", bail);
      down.on("close", () => up.destroy());
      up.on("close", () => down.destroy());
    });
    servers.push(relay);
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    relay.listen(local);
    const child: TunnelChild = {
      argv,
      kill: () => {
        for (const c of conns) c.destroy();
        relay.close(() => resolveExit());
        resolveExit();
      },
      exited,
    };
    return child;
  };
  return { hook, killAll: () => servers.forEach((s) => s.close()) };
}

const serveUpExecHook: SshExecHook = async () => ({ stdout: "", stderr: "", exitCode: 0 });

test("remote HSR delivery: spawnRemote writes the fake credential into the isolated home (0600) and kill shreds it", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const tunnel = makeRelayTunnel();
    const sub = createRemoteHsrSubstrate(makeNode(), {
      transport: {
        execHook: serveUpExecHook,
        spawnTunnel: tunnel.hook,
        remoteSocket: remoteSock,
        forward: { waitAttempts: 100, waitIntervalMs: 10 },
      },
    });

    const SECRET = "SECRET-delivered-auth-bytes-9f8e7d";
    const home = join(dir, "iso-home");
    const credPath = join(home, "auth.json");

    try {
      const bee = "credbee";
      const res = await sub.spawnRemote({
        bee,
        kind: "stub",
        cwd: process.cwd(),
        home,
        creds: { files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(SECRET).toString("base64"), mode: 0o600 }] },
        spec: { command: process.execPath, args: [], env: {} },
      });
      assert.equal(res.bee, bee);

      // The credential landed in the freshly-created isolated home at 0600.
      await waitFor(() => fileExists(credPath), "credential file written into remote home");
      const info = await stat(credPath);
      assert.equal(info.mode & 0o777, 0o600, "credential file is mode 0600");
      assert.equal(await readFile(credPath, "utf8"), SECRET);

      // kill shreds the delivered credential — nothing persists remotely.
      const kr = await sub.kill(bee);
      assert.equal(kr.ok, true);
      await waitFor(async () => !(await fileExists(credPath)), "credential file GONE after kill");
    } finally {
      await sub.close();
      await server.close();
      tunnel.killAll();
    }
  });
});

test("remote HSR delivery: a write failure surfaces a generic, secret-free error", async () => {
  await withTempStore(async (dir) => {
    const remoteSock = join(dir, "remote-control.sock");
    const server = await serve(remoteSock);
    const tunnel = makeRelayTunnel();
    const sub = createRemoteHsrSubstrate(makeNode(), {
      transport: {
        execHook: serveUpExecHook,
        spawnTunnel: tunnel.hook,
        remoteSocket: remoteSock,
        forward: { waitAttempts: 100, waitIntervalMs: 10 },
      },
    });

    const SECRET = "SECRET-must-not-appear-in-error-4b3c2a";
    // Home path is an existing FILE, so creating the isolated dir fails.
    const homeAsFile = join(dir, "home-is-a-file");
    await writeFile(homeAsFile, "x");

    try {
      await assert.rejects(
        () =>
          sub.spawnRemote({
            bee: "failbee",
            kind: "stub",
            cwd: process.cwd(),
            home: homeAsFile,
            creds: { files: [{ homeRelPath: "auth.json", contentB64: Buffer.from(SECRET).toString("base64"), mode: 0o600 }] },
            spec: { command: process.execPath, args: [], env: {} },
          }),
        (error: Error) => {
          assert.ok(!error.message.includes(SECRET), "error must not leak the credential bytes");
          assert.match(error.message, /failed to write delivered credentials/);
          return true;
        },
      );
    } finally {
      await sub.close();
      await server.close();
      tunnel.killAll();
    }
  });
});

// ── authPolicy gating in `hive spawn` (subprocess, no network) ──────────────

const CLI_ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: CLI_ENV(dir) });
}

async function hiveExpectFail(dir: string, ...args: string[]): Promise<string> {
  try {
    await hive(dir, ...args);
    throw new Error("expected command to fail");
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    return err.stderr ?? "";
  }
}

test("hive spawn --account gating: local-only remote-hsr throws; ephemeral-token gets past the gate into minting", async () => {
  const dir = await mkdtemp("/tmp/hb-rc-cli-");
  try {
    // A codex account in the registry (no vaulted credential — so the ephemeral
    // path reaches minting and fails THERE, proving the gate let it through).
    await mkdir(join(dir, "vault"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, "vault", "accounts.json"),
      JSON.stringify([{ id: "codex-fake", tool: "codex", label: "fake", provider: "openai", addedAt: "2026-07-03T00:00:00.000Z" }], null, 2),
      { mode: 0o600 },
    );

    await hive(dir, "node", "register", "lonode", "--kind", "remote-hsr", "--endpoint", "me@x");
    await hive(dir, "node", "register", "epnode", "--kind", "remote-hsr", "--endpoint", "me@x", "--auth-policy", "ephemeral-token");

    // inspect surfaces the policy: default local-only vs the set ephemeral-token.
    const loInspect = await hive(dir, "node", "inspect", "lonode");
    assert.equal(JSON.parse(loInspect.stdout).authPolicy, undefined, "local-only stays lean (no field)");
    assert.match(loInspect.stderr, /auth-policy: local-only/);
    const epInspect = await hive(dir, "node", "inspect", "epnode");
    assert.equal(JSON.parse(epInspect.stdout).authPolicy, "ephemeral-token");
    assert.match(epInspect.stderr, /auth-policy: ephemeral-token/);

    // local-only: the gate refuses the account-bound remote spawn.
    const loFail = await hiveExpectFail(dir, "spawn", "codex-fake", "--node", "lonode");
    assert.match(loFail, /auth-policy local-only/);
    assert.match(loFail, /--auth-policy ephemeral-token/);

    // ephemeral-token: PAST the gate — fails at minting (no vaulted credential),
    // NOT at the policy gate. That difference is the proof the gate allowed it.
    const epFail = await hiveExpectFail(dir, "spawn", "codex-fake", "--node", "epnode");
    assert.doesNotMatch(epFail, /auth-policy local-only/);
    assert.match(epFail, /could not mint an ephemeral credential|no primary credential|no vaulted codex auth/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
