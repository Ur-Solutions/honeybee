/**
 * Cursor accounts: credential parsing/attribution (cursorAuth.ts), the
 * identity-guarded sync against the machine-global live store, capture from a
 * login seat, activation staleness, and the driver's credentialEnv/secret
 * redaction surface. The live store is pointed at a temp file via
 * HIVE_CURSOR_AUTH_PATH and the keychain is disabled via HIVE_NO_KEYCHAIN, so
 * nothing here touches the developer's real cursor login.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountDir,
  activateAccountIntoHome,
  addAccount,
  assertCursorHomeAuthFresh,
  captureAccountFromHome,
  syncCursorAuthToVault,
} from "../src/accounts.js";
import {
  cursorAuthUnavailableReason,
  decodeJwtClaims,
  parseCursorAuth,
} from "../src/accounts/cursorAuth.js";
import { shellCommand, type AgentSpec } from "../src/agents.js";
import { identityEnvForAgent, loginSeatArgsForAgent, modelArgsForAgent, resumeArgsForAgent, secretEnvKeysForAgent } from "../src/drivers.js";

const FUTURE_S = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;
const PAST_S = Math.floor(Date.now() / 1000) - 3600;

function makeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.signature`;
}

function authJson(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

async function withCursorTempStore<T>(fn: (dir: string, livePath: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const oldKeychain = process.env.HIVE_NO_KEYCHAIN;
  const oldLive = process.env.HIVE_CURSOR_AUTH_PATH;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-cursor-"));
  const livePath = join(dir, "live", "auth.json");
  process.env.HIVE_STORE_ROOT = dir;
  process.env.HIVE_NO_KEYCHAIN = "1";
  process.env.HIVE_CURSOR_AUTH_PATH = livePath;
  try {
    await mkdir(join(dir, "live"), { recursive: true });
    return await fn(dir, livePath);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    if (oldKeychain === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = oldKeychain;
    if (oldLive === undefined) delete process.env.HIVE_CURSOR_AUTH_PATH;
    else process.env.HIVE_CURSOR_AUTH_PATH = oldLive;
    await rm(dir, { recursive: true, force: true });
  }
}

// ── parsing / staleness ────────────────────────────────────────────────────

test("parseCursorAuth decodes JWT identity and lifetime claims", () => {
  const token = makeJwt({ sub: "auth0|u1", email: "p@example.com", iat: PAST_S, exp: FUTURE_S });
  const snapshot = parseCursorAuth(authJson({ accessToken: token, refreshToken: makeJwt({ sub: "auth0|u1" }) }), "test", 42);
  assert.ok(snapshot);
  assert.deepEqual([...snapshot!.subs], ["auth0|u1"]);
  assert.deepEqual([...snapshot!.emails], ["p@example.com"]);
  assert.equal(snapshot!.issuedAtMs, PAST_S * 1000);
  assert.equal(snapshot!.expiresAtMs, FUTURE_S * 1000);
  assert.equal(snapshot!.mtimeMs, 42);
});

test("parseCursorAuth accepts api-key-only auth and rejects non-credential shapes", () => {
  assert.ok(parseCursorAuth(authJson({ apiKey: "key_123" }), "test", 0));
  assert.equal(parseCursorAuth(authJson({ token: "not-cursor-shaped" }), "test", 0), null);
  assert.equal(parseCursorAuth("not json", "test", 0), null);
  assert.equal(parseCursorAuth(null, "test", 0), null);
});

test("decodeJwtClaims survives opaque tokens", () => {
  assert.equal(decodeJwtClaims("opaque-token"), null);
  assert.equal(decodeJwtClaims("a.%%%.c"), null);
});

test("cursorAuthUnavailableReason: apiKey never expires, expired OAuth refuses, opaque passes", () => {
  const now = Date.now();
  const expired = parseCursorAuth(authJson({ accessToken: makeJwt({ exp: PAST_S }) }), "t", 0);
  const fresh = parseCursorAuth(authJson({ accessToken: makeJwt({ exp: FUTURE_S }) }), "t", 0);
  const keyed = parseCursorAuth(authJson({ accessToken: makeJwt({ exp: PAST_S }), apiKey: "key" }), "t", 0);
  const opaque = parseCursorAuth(authJson({ accessToken: "opaque" }), "t", 0);
  assert.match(cursorAuthUnavailableReason(expired, now)!, /expired at/);
  assert.equal(cursorAuthUnavailableReason(fresh, now), null);
  assert.equal(cursorAuthUnavailableReason(keyed, now), null, "an apiKey backs the account regardless of the token");
  assert.equal(cursorAuthUnavailableReason(opaque, now), null, "undecodable tokens fail open — the CLI is the authority");
  assert.match(cursorAuthUnavailableReason(null, now)!, /missing auth\.json/);
});

// ── identity-guarded sync against the machine-global live store ────────────

test("cursor sync pulls the live store only when it is attributable to the account", async () => {
  await withCursorTempStore(async (_dir, livePath) => {
    const account = await addAccount("cursor", "person@example.com");
    const vaultToken = makeJwt({ sub: "auth0|u1", iat: PAST_S, exp: FUTURE_S });
    await writeFile(join(accountDir(account), "auth.json"), authJson({ accessToken: vaultToken }), { mode: 0o600 });

    // (1) A FOREIGN login in the live store must never enter this vault.
    const foreign = makeJwt({ sub: "auth0|someone-else", iat: PAST_S + 100, exp: FUTURE_S });
    await writeFile(livePath, authJson({ accessToken: foreign }));
    const refused = await syncCursorAuthToVault(account);
    assert.equal(refused.vaultUpdated, false, "unattributed live tokens are refused");

    // (2) The account's own rotation (same JWT sub, newer iat) is pulled in.
    const rotated = makeJwt({ sub: "auth0|u1", iat: PAST_S + 200, exp: FUTURE_S });
    await writeFile(livePath, authJson({ accessToken: rotated }));
    const pulled = await syncCursorAuthToVault(account);
    assert.equal(pulled.vaultUpdated, true, "the account's own rotation is pulled");
    const vault = JSON.parse(await readFile(join(accountDir(account), "auth.json"), "utf8")) as { accessToken: string };
    assert.equal(vault.accessToken, rotated);

    // (3) An OLDER own token never regresses the vault.
    const stale = makeJwt({ sub: "auth0|u1", iat: PAST_S - 500, exp: FUTURE_S });
    await writeFile(livePath, authJson({ accessToken: stale }));
    const unchanged = await syncCursorAuthToVault(account);
    assert.equal(unchanged.vaultUpdated, false);
  });
});

// ── capture from a login seat ───────────────────────────────────────────────

test("cursor capture synthesizes the vault auth.json from the live store, identity-gated", async () => {
  await withCursorTempStore(async (dir, livePath) => {
    const account = await addAccount("cursor", "person@example.com");
    const seat = join(dir, "login-homes", account.id);
    await mkdir(seat, { recursive: true });
    await writeFile(join(seat, "cli-config.json"), JSON.stringify({ authInfo: { email: "person@example.com", authId: "auth0|u1" } }));
    await writeFile(livePath, authJson({ accessToken: makeJwt({ sub: "auth0|u1", iat: PAST_S, exp: FUTURE_S }) }));

    const captured = await captureAccountFromHome(account, seat);
    assert.ok(captured.includes("auth.json"), "the primary credential was synthesized from the live store");
    assert.ok(captured.includes("cli-config.json"), "the seat's identity config rode along");
    assert.ok((await stat(join(accountDir(account), "auth.json"))).isFile());
  });
});

test("cursor capture refuses a seat whose login belongs to someone else", async () => {
  await withCursorTempStore(async (dir, livePath) => {
    const account = await addAccount("cursor", "person@example.com");
    const seat = join(dir, "login-homes", account.id);
    await mkdir(seat, { recursive: true });
    await writeFile(join(seat, "cli-config.json"), JSON.stringify({ authInfo: { email: "intruder@example.com", authId: "auth0|x" } }));
    await writeFile(livePath, authJson({ accessToken: makeJwt({ sub: "auth0|x", iat: PAST_S, exp: FUTURE_S }) }));
    await assert.rejects(() => captureAccountFromHome(account, seat), /belongs to intruder@example\.com/);
  });
});

test("cursor capture refuses live tokens that contradict the seat's identity", async () => {
  await withCursorTempStore(async (dir, livePath) => {
    const account = await addAccount("cursor", "person@example.com");
    const seat = join(dir, "login-homes", account.id);
    await mkdir(seat, { recursive: true });
    await writeFile(join(seat, "cli-config.json"), JSON.stringify({ authInfo: { email: "person@example.com", authId: "auth0|u1" } }));
    await writeFile(livePath, authJson({ accessToken: makeJwt({ sub: "auth0|someone-else", iat: PAST_S, exp: FUTURE_S }) }));
    await assert.rejects(() => captureAccountFromHome(account, seat), /unattributable credential/);
  });
});

// ── activation: stamping + env derivation + staleness refusal ──────────────

test("cursor activation stamps the home and credentialEnv lifts the token into the spawn env", async () => {
  await withCursorTempStore(async (dir, livePath) => {
    const account = await addAccount("cursor", "person@example.com");
    const token = makeJwt({ sub: "auth0|u1", iat: PAST_S, exp: FUTURE_S });
    await writeFile(livePath, authJson({ accessToken: token }));
    await writeFile(join(accountDir(account), "auth.json"), authJson({ accessToken: token }), { mode: 0o600 });

    const home = join(dir, "homes", account.id);
    const written = await activateAccountIntoHome(account, home);
    assert.ok(written.includes("auth.json"));
    assert.deepEqual(identityEnvForAgent("cursor", home), { CURSOR_AUTH_TOKEN: token });
  });
});

test("cursor activation prefers an apiKey and refuses an expired OAuth-only vault", async () => {
  await withCursorTempStore(async (dir, livePath) => {
    await writeFile(livePath, "");
    const keyed = await addAccount("cursor", "keyed@example.com");
    await writeFile(join(accountDir(keyed), "auth.json"), authJson({ accessToken: makeJwt({ sub: "auth0|k", exp: PAST_S }), apiKey: "key_123" }), { mode: 0o600 });
    const keyedHome = join(dir, "homes", keyed.id);
    await activateAccountIntoHome(keyed, keyedHome);
    assert.deepEqual(identityEnvForAgent("cursor", keyedHome), { CURSOR_API_KEY: "key_123" });

    const stale = await addAccount("cursor", "stale@example.com");
    await writeFile(join(accountDir(stale), "auth.json"), authJson({ accessToken: makeJwt({ sub: "auth0|s", exp: PAST_S }) }), { mode: 0o600 });
    await assert.rejects(() => activateAccountIntoHome(stale, join(dir, "homes", stale.id)), /expired.*Re-login/s);
  });
});

test("assertCursorHomeAuthFresh: absent auth.json passes, an expired one refuses the spawn", async () => {
  await withCursorTempStore(async (dir) => {
    const home = join(dir, "plain-home");
    await mkdir(home, { recursive: true });
    await assertCursorHomeAuthFresh(home); // no auth.json → the global login backs the spawn
    await writeFile(join(home, "auth.json"), authJson({ accessToken: makeJwt({ exp: PAST_S }) }));
    await assert.rejects(() => assertCursorHomeAuthFresh(home, { accountId: "cursor-x" }), /expired.*hive login cursor-x/s);
  });
});

// ── driver surface ──────────────────────────────────────────────────────────

test("cursor driver surface: model/resume/login-seat/secret-env registrations", () => {
  assert.deepEqual(modelArgsForAgent("cursor", "gpt-5.3-codex"), ["--model", "gpt-5.3-codex"]);
  assert.deepEqual(modelArgsForAgent("cursor"), []);
  assert.deepEqual(resumeArgsForAgent("cursor", "chat-1"), ["--resume", "chat-1"]);
  assert.deepEqual(resumeArgsForAgent("cursor", undefined), ["--continue"]);
  assert.deepEqual(loginSeatArgsForAgent("cursor"), ["login"]);
  assert.deepEqual(loginSeatArgsForAgent("claude"), []);
  assert.deepEqual(secretEnvKeysForAgent("cursor"), ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]);
  assert.deepEqual(secretEnvKeysForAgent("claude"), []);
});

test("shellCommand redacts cursor secrets in the stored rendering, not the executable one", () => {
  const spec: AgentSpec = {
    kind: "cursor",
    requestedKind: "cursor",
    command: "cursor-agent",
    args: ["--force"],
    env: { CURSOR_CONFIG_DIR: "/h", CURSOR_AUTH_TOKEN: "sekrit-token" },
  };
  const stored = shellCommand(spec);
  assert.ok(stored.includes("CURSOR_AUTH_TOKEN=<redacted>"), stored);
  assert.ok(!stored.includes("sekrit-token"), "the stored rendering must not leak the token");
  assert.ok(stored.includes("CURSOR_CONFIG_DIR=/h"), "non-secret env stays verbatim");
  const executable = shellCommand(spec, { forExec: true });
  assert.ok(executable.includes("CURSOR_AUTH_TOKEN=sekrit-token"), "the executable rendering carries the real value");
});
