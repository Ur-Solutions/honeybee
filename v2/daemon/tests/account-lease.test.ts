/**
 * v19 account.lease — the credential-lease mint (RN7a; credential-leases.md,
 * validated by docs/RN7A_EXPERIMENTS.md):
 *  - refresh-token blanking is DEEP and EXACT: every `refresh_token` /
 *    `refresh` / `refreshToken` string anywhere in the document becomes "",
 *    field kept; near-miss keys and non-secret fields ship untouched
 *  - claude: current access token shipped; an expired chain is refreshed
 *    through the daemon's own single-flight refresher first; typed refusals
 *    when the chain cannot be freshened (live runtime / no refresh / failed)
 *  - codex: access+id token with `refresh_token: ""`; a near-expiry token
 *    triggers the central rotation (injected runner) + home→vault harvest;
 *    under-15-min TTL after rotation is a typed refusal, never a stale ship
 *  - grok: every entry's refresh blanked, cached keys preserved, kindNote
 *    carries the XAI_API_KEY scrub rule
 *  - kimi: API-key lease per the design ruling; OAuth-only → lease_unsupported
 *  - opencode: single coding-plan provider filtered out of the multi-provider
 *    auth.json; every other provider dropped; none → lease_unsupported
 *  - single-flight per account (concurrent mints join); refused while the
 *    account's refresher is mid-rotation
 *  - NO fixture refresh token ever appears in a lease, the service log, or
 *    (RPC tier) the daemon output / audit stream
 * SAFETY: temp dirs only (vault/homes inside the rig dir); keychain readers
 * injected as null; no real codex/claude ever runs (rotation is injected;
 * the RPC-tier fixture token is fresh so the default runner is never hit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService, CODEX_MIN_SHIP_TTL_MS, LeaseRefusal, type EphemeralCredential } from "../src/accountsService.ts";
import { loadNodeConfig, type NodeConfigFile, type ResolvedNodeConfig } from "../src/config.ts";
import { RpcError, type AccountAddResult, type AccountLeaseResult, type AuditTailResult, type DeployInfoResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const HOUR = 60 * 60 * 1000;

// Fixture refresh tokens: distinctive strings the assertions hunt for. They
// must NEVER appear in a lease, a log line, daemon output, or an audit row.
const CLAUDE_REFRESH = "FIXTURE-CLAUDE-REFRESH-TOKEN-a1b2c3";
const CLAUDE_NESTED_REFRESH = "FIXTURE-CLAUDE-NESTED-REFRESH-x9y8";
const CODEX_REFRESH = "FIXTURE-CODEX-REFRESH-TOKEN-d4e5f6";
const CODEX_ROTATED_REFRESH = "FIXTURE-CODEX-ROTATED-REFRESH-g7h8";
const GROK_REFRESH = "FIXTURE-GROK-REFRESH-TOKEN-i9j0";
const KIMI_REFRESH = "FIXTURE-KIMI-REFRESH-TOKEN-k1l2";
const OPENCODE_REFRESH = "FIXTURE-OPENCODE-REFRESH-TOKEN-m3n4";
const OTHER_PROVIDER_REFRESH = "FIXTURE-OTHER-PROVIDER-REFRESH-o5p6";
const CODEX_STRAY_REFRESH = "FIXTURE-CODEX-STRAY-REFRESH-q7r8";
const CODEX_OPENAI_KEY = "FIXTURE-OPENAI-DEVELOPER-KEY-s9t0";
const ALL_FIXTURE_REFRESHES = [
  CLAUDE_REFRESH,
  CLAUDE_NESTED_REFRESH,
  CODEX_REFRESH,
  CODEX_ROTATED_REFRESH,
  CODEX_STRAY_REFRESH,
  GROK_REFRESH,
  KIMI_REFRESH,
  OPENCODE_REFRESH,
  OTHER_PROVIDER_REFRESH,
];

interface Rig {
  dir: string;
  store: CoreStore;
  cfg: ResolvedNodeConfig;
  log: string[];
  now: () => number;
  setNow: (t: number) => void;
  vault: string;
  homes: string;
  cleanup: () => void;
}

function rig(config: NodeConfigFile = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-lease-"));
  const vault = join(dir, "vault");
  const homes = join(dir, "homes");
  const file: NodeConfigFile = {
    ...config,
    accounts: {
      vaultDir: vault,
      homesDir: homes,
      tmuxSocket: `hb-v2-lease-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      limitsRefreshMs: 0,
      loginTimeoutMs: 15_000,
      ...(config.accounts ?? {}),
    },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(file));
  const cfg = loadNodeConfig(dir);
  let t = Date.parse("2026-09-03T12:00:00Z");
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
    vault,
    homes,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function addAccount(r: Rig, harness: string, label: string, opts: { status?: "ok" | "paused" | "auth_needed"; home?: Record<string, string>; vault?: Record<string, string> } = {}) {
  const id = `${harness}-${label}`;
  const account = r.store.createAccount({ id, harness, homePath: join(r.homes, id), label, penalty: 0, status: opts.status ?? "ok" });
  for (const [root, files] of [
    [join(r.homes, id), opts.home ?? {}],
    [join(r.vault, harness, id), opts.vault ?? {}],
  ] as const) {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
  }
  return account;
}

function service(r: Rig, extra: Partial<ConstructorParameters<typeof AccountsService>[0]> = {}): AccountsService {
  return new AccountsService({ store: r.store, cfg: r.cfg, log: (op) => r.log.push(op), now: r.now, keychainReader: async () => null, keychainWriter: async () => false, ...extra });
}

/** An unsigned but structurally valid JWT whose `exp` claim decodes locally. */
function fakeJwt(expSeconds: number): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, sub: "fixture" })}.FIXTURESIG`;
}

function decodeFile(lease: EphemeralCredential, index = 0): Record<string, unknown> {
  const file = lease.files[index];
  assert.ok(file, `lease has a file at index ${index}`);
  return JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")) as Record<string, unknown>;
}

/** The one non-negotiable: no fixture refresh token in the payload or the log. */
function assertNoFixtureSecrets(r: Rig, lease: EphemeralCredential): void {
  const wire = JSON.stringify(lease) + Buffer.from(lease.files.map((f) => f.contentB64).join(), "base64").toString("utf8");
  for (const secret of ALL_FIXTURE_REFRESHES) {
    assert.ok(!wire.includes(secret), `lease payload must not carry ${secret}`);
    assert.ok(!r.log.join("\n").includes(secret), `service log must not carry ${secret}`);
  }
}

async function refuses(fn: () => Promise<unknown>, code: "lease_unsupported" | "lease_unavailable", pattern?: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof LeaseRefusal, `expected LeaseRefusal, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return;
  }
  assert.fail(`expected ${code}`);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

test("lease.claude.1: ships .credentials.json with DEEP, EXACT refresh blanking; access token, near-miss keys, and expiry preserved; log secret-free", async () => {
  const r = rig();
  try {
    const expiresAt = r.now() + 3 * HOUR;
    const document = {
      claudeAiOauth: {
        accessToken: "fixture-access-token",
        refreshToken: CLAUDE_REFRESH,
        expiresAt,
        refreshTokenExpiresAt: r.now() + 24 * HOUR, // near-miss KEY: a number, and not in the closed blank list — must survive
        refresher: "keep-me", // near-miss key: must survive
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
      oauthHistory: [{ refresh_token: CLAUDE_NESTED_REFRESH }], // deep: nested arrays/objects blank too
    };
    const account = addAccount(r, "claude", "a", { home: { ".credentials.json": JSON.stringify(document) } });
    const svc = service(r);
    const lease = await svc.mintLease(account);

    assert.equal(lease.files.length, 1);
    assert.equal(lease.files[0]!.homeRelPath, ".credentials.json");
    assert.equal(lease.files[0]!.mode, 0o600);
    assert.equal(lease.expiresAt, Math.floor(expiresAt / 1000));
    const shipped = decodeFile(lease);
    const oauth = shipped.claudeAiOauth as Record<string, unknown>;
    assert.equal(oauth.refreshToken, "", "refreshToken blanked to empty string, field kept");
    assert.equal(oauth.accessToken, "fixture-access-token");
    assert.equal(oauth.refreshTokenExpiresAt, document.claudeAiOauth.refreshTokenExpiresAt);
    assert.equal(oauth.refresher, "keep-me");
    assert.deepEqual(oauth.scopes, ["user:inference"]);
    assert.deepEqual((shipped.oauthHistory as Array<Record<string, unknown>>)[0], { refresh_token: "" });
    assert.match(lease.kindNote, /refresh token blanked/);
    assert.match(lease.kindNote, /ANTHROPIC_API_KEY/);
    assert.ok(r.log.some((op) => op.startsWith("account.lease account=claude-a harness=claude files=1")));
    assertNoFixtureSecrets(r, lease);
  } finally {
    r.cleanup();
  }
});

test("lease.claude.2: an expired chain is refreshed through the daemon's own refresher first; the NEW refresh token also never ships", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "stale", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() - 1 } }) },
    });
    const freshExpiry = r.now() + HOUR;
    const svc = service(r, {
      fetchers: {
        claudeRefresh: async () => ({ accessToken: "fresh-access", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: freshExpiry }),
      },
    });
    const lease = await svc.mintLease(account);
    const oauth = decodeFile(lease).claudeAiOauth as Record<string, unknown>;
    assert.equal(oauth.accessToken, "fresh-access");
    assert.equal(oauth.refreshToken, "");
    assert.equal(lease.expiresAt, Math.floor(freshExpiry / 1000));
    // The refreshed REAL chain landed in the home + vault (the refresher's
    // existing contract) — only the LEASE is blanked.
    const homeChain = JSON.parse(readFileSync(join(account.homePath, ".credentials.json"), "utf8")) as { claudeAiOauth: { refreshToken: string } };
    assert.equal(homeChain.claudeAiOauth.refreshToken, CLAUDE_NESTED_REFRESH);
    assertNoFixtureSecrets(r, lease);
  } finally {
    r.cleanup();
  }
});

test("lease.claude.4: the 15-minute ship floor — a dying-but-not-expired token is refreshed, never re-shipped; a refresh that stays under the floor refuses", async () => {
  const r = rig();
  try {
    const dying = addAccount(r, "claude", "dying", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "dying-access", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + 5 * 60_000 } }) },
    });
    const freshExpiry = r.now() + 2 * HOUR;
    let refreshes = 0;
    const svc = service(r, {
      fetchers: {
        claudeRefresh: async () => {
          refreshes += 1;
          return { accessToken: "floor-fresh-access", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: freshExpiry };
        },
      },
    });
    const lease = await svc.mintLease(dying);
    assert.equal(refreshes, 1, "a token under the floor triggers the refresher even though it is not yet expired");
    const oauth = decodeFile(lease).claudeAiOauth as Record<string, unknown>;
    assert.equal(oauth.accessToken, "floor-fresh-access");
    assert.equal(oauth.refreshToken, "");
    assert.equal(lease.expiresAt, Math.floor(freshExpiry / 1000));
    assertNoFixtureSecrets(r, lease);

    // A refresh whose product is STILL under the floor refuses — never ship dying.
    const stuck = addAccount(r, "claude", "floorstuck", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + 5 * 60_000 } }) },
    });
    const stuckSvc = service(r, {
      fetchers: { claudeRefresh: async () => ({ accessToken: "still-dying", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + 10 * 60_000 }) },
    });
    await refuses(() => stuckSvc.mintLease(stuck), "lease_unavailable", /15-minute ship floor/);
  } finally {
    r.cleanup();
  }
});

test("lease.claude.3: typed refusals — no credential; expired chain owned by a live runtime; failed refresh", async () => {
  const r = rig();
  try {
    const bare = addAccount(r, "claude", "bare");
    const svc = service(r);
    await refuses(() => svc.mintLease(bare), "lease_unavailable", /no claude OAuth credential/);

    const live = addAccount(r, "claude", "live", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() - 1 } }) },
    });
    const { bee } = r.store.createBee({ name: "owner", agent: "claude", substrate: "hsr", cwd: "/tmp", account: live.id });
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 99, pidStartedAt: 1 });
    let raced = 0;
    const liveSvc = service(r, { fetchers: { claudeRefresh: async () => { raced += 1; return null; } } });
    await refuses(() => liveSvc.mintLease(live), "lease_unavailable", /running Claude owns refresh/);
    assert.equal(raced, 0, "a live runtime's rotating refresh token is never raced");

    const failing = addAccount(r, "claude", "failing", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() - 1 } }) },
    });
    const failSvc = service(r, { fetchers: { claudeRefresh: async () => null } });
    await refuses(() => failSvc.mintLease(failing), "lease_unavailable", /refresh failed/);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

test("lease.codex.1: ships access+id token with refresh_token blanked (field KEPT); blanking is DEEP (stray refresh keys outside tokens too); a subscription lease's OPENAI_API_KEY is blanked", async () => {
  const r = rig();
  try {
    const exp = Math.floor(r.now() / 1000) + 8 * 24 * 3600;
    const account = addAccount(r, "codex", "cx", {
      vault: {
        "auth.json": JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: CODEX_OPENAI_KEY,
          tokens: { id_token: "fixture-id-token", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct-1" },
          last_refresh: "2026-09-01T00:00:00Z",
          // A refresh key OUTSIDE tokens: the deep blank must catch it — the
          // old hand-blank of tokens.refresh_token alone would ship it.
          backup: { refresh_token: CODEX_STRAY_REFRESH },
        }),
      },
    });
    const svc = service(r, { codexLeaseRefresh: async () => assert.fail("a fresh token must not trigger rotation") });
    const lease = await svc.mintLease(account);
    assert.equal(lease.files[0]!.homeRelPath, "auth.json");
    assert.equal(lease.files[0]!.mode, 0o600);
    assert.equal(lease.expiresAt, exp);
    const shipped = decodeFile(lease);
    const tokens = shipped.tokens as Record<string, unknown>;
    assert.equal(tokens.refresh_token, "", "refresh_token blanked, field kept (codex serde requires it present)");
    assert.equal(tokens.id_token, "fixture-id-token");
    assert.equal(tokens.access_token, fakeJwt(exp));
    assert.equal(tokens.account_id, "acct-1");
    assert.equal(shipped.auth_mode, "chatgpt");
    assert.equal(shipped.last_refresh, "2026-09-01T00:00:00Z");
    assert.deepEqual(shipped.backup, { refresh_token: "" }, "deep blank reaches refresh keys outside tokens");
    assert.equal(shipped.OPENAI_API_KEY, null, "a ChatGPT-mode lease never smuggles a billable developer key");
    const wire = Buffer.from(lease.files[0]!.contentB64, "base64").toString("utf8");
    assert.ok(!wire.includes(CODEX_OPENAI_KEY));
    assertNoFixtureSecrets(r, lease);

    // API-key mode: that billing is the account's intent — the key ships.
    const keyed = addAccount(r, "codex", "keyed", {
      vault: {
        "auth.json": JSON.stringify({
          auth_mode: "apikey",
          OPENAI_API_KEY: CODEX_OPENAI_KEY,
          tokens: { id_token: "id", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct-2" },
        }),
      },
    });
    const keyedLease = await service(r).mintLease(keyed);
    assert.equal(decodeFile(keyedLease).OPENAI_API_KEY, CODEX_OPENAI_KEY, "an API-key-mode lease keeps its key");
  } finally {
    r.cleanup();
  }
});

test("lease.codex.3: a shipped file always carries refresh_token — present as \"\" even when the source file lacks the field (codex serde hard-fails without it)", async () => {
  const r = rig();
  try {
    const exp = Math.floor(r.now() / 1000) + 8 * 24 * 3600;
    const account = addAccount(r, "codex", "nofield", {
      vault: { "auth.json": JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(exp), account_id: "a" } }) },
    });
    const lease = await service(r).mintLease(account);
    const tokens = decodeFile(lease).tokens as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(tokens, "refresh_token"));
    assert.equal(tokens.refresh_token, "");
  } finally {
    r.cleanup();
  }
});

test("lease.codex.2: a near-expiry token triggers the central rotation and harvests home → vault; a rotation that stays stale is a typed TTL refusal", async () => {
  const r = rig();
  try {
    const staleExp = Math.floor((r.now() + CODEX_MIN_SHIP_TTL_MS / 2) / 1000); // 7.5 min left — under the ship floor
    const staleAuth = JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(staleExp), refresh_token: CODEX_REFRESH, account_id: "a" } });

    // 2a. rotation succeeds: the injected runner plays codex rotating auth.json in place in the HOME.
    const account = addAccount(r, "codex", "rot", { home: { "auth.json": staleAuth } });
    const rotatedExp = Math.floor(r.now() / 1000) + 10 * 24 * 3600;
    let rotations = 0;
    const svc = service(r, {
      codexLeaseRefresh: async (homePath) => {
        rotations += 1;
        assert.equal(homePath, account.homePath, "rotation runs against the account's OWN home");
        writeFileSync(join(homePath, "auth.json"), JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(rotatedExp), refresh_token: CODEX_ROTATED_REFRESH, account_id: "a" } }));
      },
    });
    const lease = await svc.mintLease(account);
    assert.equal(rotations, 1);
    assert.equal(lease.expiresAt, rotatedExp);
    assert.equal((decodeFile(lease).tokens as Record<string, unknown>).refresh_token, "");
    // The rotated REAL chain was harvested into the vault (the vault stays current).
    const vaultAuth = JSON.parse(readFileSync(join(r.vault, "codex", account.id, "auth.json"), "utf8")) as { tokens: { access_token: string } };
    assert.equal(vaultAuth.tokens.access_token, fakeJwt(rotatedExp));
    assertNoFixtureSecrets(r, lease);

    // 2b. rotation that does NOT freshen: refuse — never ship a stale token.
    const stuck = addAccount(r, "codex", "stuck", { home: { "auth.json": staleAuth } });
    let stuckRotations = 0;
    const stuckSvc = service(r, { codexLeaseRefresh: async () => { stuckRotations += 1; } });
    await refuses(() => stuckSvc.mintLease(stuck), "lease_unavailable", /did not produce a fresh access token/);
    assert.equal(stuckRotations, 1, "the rotation was attempted before refusing");

    // 2c. near-expiry with a LIVE runtime: the home is owned — typed refusal, no rotation attempt.
    const owned = addAccount(r, "codex", "owned", { home: { "auth.json": staleAuth } });
    const { bee } = r.store.createBee({ name: "codex-owner", agent: "codex", substrate: "hsr", cwd: "/tmp", account: owned.id });
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 42, pidStartedAt: 1 });
    const ownedSvc = service(r, { codexLeaseRefresh: async () => assert.fail("a live runtime's home is never raced") });
    await refuses(() => ownedSvc.mintLease(owned), "lease_unavailable", /live runtime owns the home/);

    // 2d. no decodable token anywhere.
    const bare = addAccount(r, "codex", "bare", { home: { "auth.json": JSON.stringify({ tokens: { access_token: "not-a-jwt", refresh_token: CODEX_REFRESH } }) } });
    await refuses(() => service(r).mintLease(bare), "lease_unavailable", /no codex auth\.json with a decodable access token/);

    // 2e. TOCTOU: a runtime that starts DURING the (long) rotation turn owns
    // the home — the mint refuses after the turn and never harvests.
    const raced = addAccount(r, "codex", "raced", { home: { "auth.json": staleAuth } });
    const racedSvc = service(r, {
      codexLeaseRefresh: async () => {
        const { bee } = r.store.createBee({ name: "raced-owner", agent: "codex", substrate: "hsr", cwd: "/tmp", account: raced.id });
        r.store.updateRuntimeState(bee.id, 1, "running", { pid: 77, pidStartedAt: 1 });
        writeFileSync(join(raced.homePath, "auth.json"), JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(rotatedExp), refresh_token: CODEX_ROTATED_REFRESH, account_id: "a" } }));
      },
    });
    await refuses(() => racedSvc.mintLease(raced), "lease_unavailable", /during the token rotation/);
    assert.ok(!existsSync(join(r.vault, "codex", raced.id, "auth.json")), "the owned home is never harvested");
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// grok / kimi / opencode
// ---------------------------------------------------------------------------

test("lease.grok.1: every issuer::client entry's refresh_token blanked; cached keys preserved; expiresAt = the soonest entry expiry; kindNote carries the XAI_API_KEY scrub rule", async () => {
  const r = rig();
  try {
    const soonest = r.now() + 6 * HOUR;
    const account = addAccount(r, "grok", "g", {
      home: {
        "auth.json": JSON.stringify({
          // Live grok files carry ISO-string expiries.
          "https://auth.x.ai::client-1": { key: "cached-oauth-key-1", refresh_token: GROK_REFRESH, expires_at: new Date(r.now() + 12 * HOUR).toISOString() },
          "https://auth.x.ai::client-2": { key: "cached-oauth-key-2", refresh_token: GROK_REFRESH, expires_at: new Date(soonest).toISOString() },
          "https://auth.x.ai::client-3": { key: "cached-oauth-key-3", refresh_token: GROK_REFRESH },
        }),
      },
    });
    const lease = await service(r).mintLease(account);
    const shipped = decodeFile(lease);
    for (const entry of Object.values(shipped) as Array<Record<string, unknown>>) {
      assert.equal(entry.refresh_token, "");
      assert.match(String(entry.key), /^cached-oauth-key-/);
    }
    assert.equal(lease.expiresAt, Math.floor(soonest / 1000), "the soonest-dying entry bounds the lease");
    assert.match(lease.kindNote, /XAI_API_KEY/);
    assertNoFixtureSecrets(r, lease);
  } finally {
    r.cleanup();
  }
});

test("lease.kimi.1: API-key lease ships (refresh blanked); an OAuth-only account is a durable lease_unsupported refusal", async () => {
  const r = rig();
  try {
    const keyed = addAccount(r, "kimi", "key", {
      home: { "credentials/kimi-code.json": JSON.stringify({ api_key: "sk-kimi-fixture", access_token: "short-lived", refresh_token: KIMI_REFRESH, expires_at: 1 }) },
    });
    const lease = await service(r).mintLease(keyed);
    assert.equal(lease.files[0]!.homeRelPath, "credentials/kimi-code.json");
    const shipped = decodeFile(lease);
    assert.equal(shipped.api_key, "sk-kimi-fixture");
    assert.equal(shipped.refresh_token, "");
    assert.match(lease.kindNote, /API-key lease/);
    assertNoFixtureSecrets(r, lease);

    const oauthOnly = addAccount(r, "kimi", "oauth", {
      home: { "credentials/kimi-code.json": JSON.stringify({ access_token: "short-lived", refresh_token: KIMI_REFRESH, expires_at: 1 }) },
    });
    await refuses(() => service(r).mintLease(oauthOnly), "lease_unsupported", /OAuth-only/);
  } finally {
    r.cleanup();
  }
});

test("lease.opencode.1: single coding-plan provider filtered out of the multi-provider auth.json; other providers DROPPED, not blanked; none → lease_unsupported", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "opencode", "glm", {
      home: {
        "xdg-data/opencode/auth.json": JSON.stringify({
          "zai-coding-plan": { type: "api", key: "glm-coding-key", refresh: OPENCODE_REFRESH },
          anthropic: { type: "oauth", access: "other-access", refresh: OTHER_PROVIDER_REFRESH },
        }),
      },
    });
    const lease = await service(r).mintLease(account);
    assert.equal(lease.files[0]!.homeRelPath, "xdg-data/opencode/auth.json");
    const shipped = decodeFile(lease);
    assert.deepEqual(Object.keys(shipped), ["zai-coding-plan"], "every other provider's credential is dropped");
    assert.deepEqual(shipped["zai-coding-plan"], { type: "api", key: "glm-coding-key", refresh: "" });
    assert.match(lease.kindNote, /zai-coding-plan/);
    assertNoFixtureSecrets(r, lease);

    const noPlan = addAccount(r, "opencode", "noplan", {
      home: { "xdg-data/opencode/auth.json": JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: OTHER_PROVIDER_REFRESH } }) },
    });
    await refuses(() => service(r).mintLease(noPlan), "lease_unsupported", /no leasable coding-plan provider/);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// concurrency + strategy gaps
// ---------------------------------------------------------------------------

test("lease.flight.1: concurrent mints for one account JOIN a single mint (the rotation runs once)", async () => {
  const r = rig();
  try {
    const staleExp = Math.floor((r.now() + CODEX_MIN_SHIP_TTL_MS / 2) / 1000);
    const account = addAccount(r, "codex", "join", {
      home: { "auth.json": JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(staleExp), refresh_token: CODEX_REFRESH, account_id: "a" } }) },
    });
    const gate = deferred<void>();
    const rotatedExp = Math.floor(r.now() / 1000) + 10 * 24 * 3600;
    let rotations = 0;
    const svc = service(r, {
      codexLeaseRefresh: async (homePath) => {
        rotations += 1;
        await gate.promise;
        writeFileSync(join(homePath, "auth.json"), JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(rotatedExp), refresh_token: CODEX_ROTATED_REFRESH, account_id: "a" } }));
      },
    });
    const first = svc.mintLease(account);
    const second = svc.mintLease(account);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(rotations, 1, "concurrent callers join one mint");
    assert.deepEqual(a, b);
    assertNoFixtureSecrets(r, a);
  } finally {
    r.cleanup();
  }
});

test("lease.flight.2: refused while the account's refresher is mid-rotation", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "busy", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() - 1 } }) },
    });
    const gate = deferred<null>();
    const svc = service(r, {
      fetchers: {
        claudeUsage: async () => ({}) as never,
        claudeRefresh: () => gate.promise,
      },
    });
    // The limits probe finds the chain expired and enters the single-flight
    // refresher, which now hangs on the gate — the mint must refuse, not join.
    const probing = svc.refreshLimits([account.id]);
    await waitFor(() => svc.refreshBusy(account), "claude refresher mid-rotation");
    await refuses(() => svc.mintLease(account), "lease_unavailable", /mid-rotation/);
    gate.resolve(null);
    await probing;

    // A codex app-server probe may rotate auth.json in place — an in-flight
    // codex limits fetch is mid-rotation too (keyed by the account's HOME).
    const exp = Math.floor(r.now() / 1000) + 8 * 24 * 3600;
    const codex = addAccount(r, "codex", "probing", {
      home: { "auth.json": JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "a" } }) },
    });
    const codexGate = deferred<{ ok: false; unreadableReason: "timeout"; error: string }>();
    const codexSvc = service(r, { fetchers: { codexRateLimits: () => codexGate.promise } });
    const codexProbing = codexSvc.refreshLimits([codex.id]);
    await waitFor(() => codexSvc.refreshBusy(codex), "codex probe mid-flight");
    await refuses(() => codexSvc.mintLease(codex), "lease_unavailable", /mid-rotation/);
    codexGate.resolve({ ok: false, unreadableReason: "timeout", error: "test gate" });
    await codexProbing;
  } finally {
    r.cleanup();
  }
});

test("lease.strategy.1: harnesses without a lease strategy are a durable typed refusal", async () => {
  const r = rig();
  try {
    const cursor = addAccount(r, "cursor", "c");
    await refuses(() => service(r).mintLease(cursor), "lease_unsupported", /no credential-lease strategy/);
    const stub = addAccount(r, "stub", "s");
    await refuses(() => service(r).mintLease(stub), "lease_unsupported", /no credential-lease strategy/);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// RPC tier — a real daemon over a temp socket
// ---------------------------------------------------------------------------

test("rpc.lease.1: account.lease verb — result shape, typed errors, capability tag, and no secret bytes in daemon output or the audit stream", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();

    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info.capabilities.includes("account.lease.v1"), "the hello/deployInfo capability list gates the verb");

    // No lease strategy (stub) → lease_unsupported over the wire.
    await client.request<AccountAddResult>("account.add", { harness: "stub", label: "s" });
    await assert.rejects(client.request("account.lease", { account: "stub-s" }), (err: unknown) => err instanceof RpcError && err.code === "lease_unsupported");

    // A codex account whose vault holds the fixture credential (fresh token —
    // the daemon's REAL rotation runner is never triggered).
    await client.request<AccountAddResult>("account.add", { harness: "codex", label: "lx" });
    const exp = Math.floor(Date.now() / 1000) + 8 * 24 * 3600;
    const vaultDir = join(dir, "vault", "codex", "codex-lx");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "auth.json"), JSON.stringify({ tokens: { id_token: "id-fixture", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct" } }));

    const lease = await client.request<AccountLeaseResult>("account.lease", { account: "codex-lx" });
    assert.equal(lease.account, "codex-lx");
    assert.equal(lease.harness, "codex");
    assert.equal(lease.files.length, 1);
    assert.equal(lease.files[0]!.homeRelPath, "auth.json");
    assert.equal(lease.files[0]!.mode, 0o600);
    assert.equal(lease.expiresAt, exp);
    const shipped = JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString("utf8")) as { tokens: Record<string, unknown> };
    assert.equal(shipped.tokens.refresh_token, "");
    assert.equal(shipped.tokens.access_token, fakeJwt(exp));

    // Typed errors: unknown selector, harness mismatch, paused account.
    await assert.rejects(client.request("account.lease", { account: "nope" }), (err: unknown) => err instanceof RpcError && err.code === "account_not_found");
    await assert.rejects(client.request("account.lease", { account: "codex-lx", harness: "claude" }), (err: unknown) => err instanceof RpcError && err.code === "harness_mismatch");
    await client.request("account.pause", { id: "codex-lx" });
    await assert.rejects(client.request("account.lease", { account: "codex-lx" }), (err: unknown) => err instanceof RpcError && err.code === "account_paused");

    // The verb result is the ONLY place secret bytes appear: neither the
    // fixture refresh token nor the shipped access token may reach the
    // daemon's output/log or the audit stream.
    const audit = await client.request<AuditTailResult>("audit.tail", { limit: 1000 });
    for (const haystack of [JSON.stringify(audit.rows), daemon.output()]) {
      assert.ok(!haystack.includes(CODEX_REFRESH), "refresh token never leaves the mint");
      assert.ok(!haystack.includes(fakeJwt(exp)), "access token appears only in the verb result");
    }
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});
