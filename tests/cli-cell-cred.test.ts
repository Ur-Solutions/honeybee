import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

async function hiveFailure(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    await hive(dir, ...args);
    throw new Error("expected hive command to fail");
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

async function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-cell-cred-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${body}.sig`;
}

/** Seed an opencode (api-key) account's primary credential into the vault. */
async function seedOpencodeCredential(dir: string, accountId: string, apiKey: string): Promise<void> {
  const credPath = join(dir, "vault", "opencode", accountId, "xdg-data", "opencode", "auth.json");
  await mkdir(join(credPath, ".."), { recursive: true });
  await writeFile(credPath, JSON.stringify({ "minimax-coding-plan": { type: "api", key: apiKey } }));
}

/** Seed a codex (subscription) account's vault auth.json with a FRESH access token. */
async function seedCodexCredential(dir: string, accountId: string, accessSecret: string, refreshSecret: string): Promise<void> {
  const credPath = join(dir, "vault", "codex", accountId, "auth.json");
  await mkdir(join(credPath, ".."), { recursive: true });
  const farFutureExp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  await writeFile(credPath, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ email: "sub@example.com" }),
      // A JWT-shaped access token carrying the far-future exp and a recognizable secret marker.
      access_token: fakeJwt({ exp: farFutureExp, marker: accessSecret }),
      refresh_token: refreshSecret,
      account_id: "acct-cell-cred",
    },
    last_refresh: new Date().toISOString(),
  }));
}

type CredPayload = { files: Array<{ homeRelPath: string; contentB64: string; mode: number }>; env: Record<string, string>; note?: string };

test("cell-cred mint emits pinned {files,env} JSON for an api-key harness (opencode)", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax", "sk-secret-api-key");

    const { stdout, stderr } = await hive(dir, "cell-cred", "mint", "opencode-minimax", "--harness", "opencode");

    // stdout is PURE JSON: exactly one line, JSON.parse-able, pinned keys present.
    assert.equal(stdout.trimEnd().split("\n").length, 1, "stdout must be a single JSON line");
    const payload = JSON.parse(stdout) as CredPayload;
    assert.ok(Array.isArray(payload.files), "files is an array");
    assert.equal(typeof payload.env, "object");
    assert.equal(payload.files.length, 1);
    const file = payload.files[0]!;
    assert.equal(file.homeRelPath, "xdg-data/opencode/auth.json");
    assert.equal(file.mode, 0o600);
    assert.equal(typeof file.contentB64, "string");
    // The delivered material is the real single-provider auth.json (api key preserved).
    const decoded = JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")) as Record<string, { key?: string }>;
    assert.equal(decoded["minimax-coding-plan"]?.key, "sk-secret-api-key");
    assert.deepEqual(Object.keys(decoded), ["minimax-coding-plan"], "only the account's provider is shipped");
    // A named account resolves without any stderr banner — stdout stays pure.
    assert.equal(stderr, "");
  });
});

test("cell-cred mint ships an access-token-only file with refresh blanked for a subscription harness (codex)", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "codex", "sub@example.com");
    await seedCodexCredential(dir, "codex-sub-example.com", "ACCESS-SECRET-MARKER", "REFRESH-SECRET-MARKER");

    const { stdout, stderr } = await hive(dir, "cell-cred", "mint", "codex-sub-example.com", "--harness", "codex");

    const payload = JSON.parse(stdout) as CredPayload;
    assert.equal(payload.files.length, 1);
    const file = payload.files[0]!;
    assert.equal(file.homeRelPath, "auth.json");
    const decoded = JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")) as {
      tokens: { access_token: string; refresh_token: string };
    };
    // Access token preserved (bearer of the secret marker in its JWT payload),
    // refresh token BLANKED.
    const accessPayload = JSON.parse(
      Buffer.from(decoded.tokens.access_token.split(".")[1]!, "base64url").toString("utf8"),
    ) as { marker?: string };
    assert.equal(accessPayload.marker, "ACCESS-SECRET-MARKER", "the real access token is delivered");
    assert.equal(decoded.tokens.refresh_token, "", "refresh_token must be blanked");

    // SECURITY: the delivery is stdout-only — a named account mint writes NOTHING
    // to stderr, and in particular no token bytes (blanked refresh, JWT access).
    assert.equal(stderr, "");
    assert.doesNotMatch(stderr, /REFRESH-SECRET-MARKER/);
    assert.doesNotMatch(stderr, /eyJ/);
  });
});

test("cell-cred mint rejects cursor (remote-hsr local-only) secret-free without minting", async () => {
  await withStore(async (dir) => {
    // No account needed: the harness gate fails closed before any account/vault touch.
    const { stdout, stderr, code } = await hiveFailure(dir, "cell-cred", "mint", "whatever-account", "--harness", "cursor");
    assert.notEqual(code, 0, "must exit non-zero");
    assert.equal(stdout, "", "no partial creds on stdout (fail-closed)");
    assert.match(stderr, /local-only/);
    assert.doesNotMatch(stderr, /sk-|access_token|refresh_token/);
  });
});

test("cell-cred mint exits non-zero on an unknown account with no cred output", async () => {
  await withStore(async (dir) => {
    const { stdout, stderr, code } = await hiveFailure(dir, "cell-cred", "mint", "codex-nope", "--harness", "codex");
    assert.notEqual(code, 0);
    assert.equal(stdout, "", "no partial creds on stdout (fail-closed)");
    assert.match(stderr, /account/i);
  });
});

test("cell-cred mint fails closed (non-zero, no stdout) when the vault has no credential to mint", async () => {
  await withStore(async (dir) => {
    // Account exists but no vault credential file was seeded → mint must fail
    // WITHOUT emitting any partial credential to stdout.
    await hive(dir, "account", "add", "codex", "empty@example.com");
    const { stdout, stderr, code } = await hiveFailure(dir, "cell-cred", "mint", "codex-empty-example.com", "--harness", "codex");
    assert.notEqual(code, 0);
    assert.equal(stdout, "", "no partial creds on stdout (fail-closed)");
    assert.doesNotMatch(stderr, /-----BEGIN|access_token"\s*:\s*"ey/);
  });
});
