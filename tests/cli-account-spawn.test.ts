import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

async function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-acct-spawn-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Seed an opencode account's primary credential into the vault so activation succeeds. */
async function seedOpencodeCredential(dir: string, accountId: string): Promise<void> {
  const credPath = join(dir, "vault", "opencode", accountId, "xdg-data", "opencode", "auth.json");
  await mkdir(join(credPath, ".."), { recursive: true });
  await writeFile(credPath, JSON.stringify({ "minimax-coding-plan": { type: "api", key: "test-key" } }));
}

async function writeDatedFile(path: string, data: string, iso: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, data);
  const date = new Date(iso);
  await utimes(path, date, date);
}

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${body}.sig`;
}

function codexAuthJson(email: string, lastRefresh: string, token: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ email }),
      access_token: `access-${token}`,
      refresh_token: `refresh-${token}`,
      account_id: "acct-cli-sync",
    },
    last_refresh: lastRefresh,
  });
}

function grokAuthJson(email: string, createTime: string, token: string): string {
  const created = new Date(createTime);
  return JSON.stringify({
    "https://auth.x.ai::test-client": {
      auth_mode: "oidc",
      email,
      key: `key-${token}`,
      refresh_token: `refresh-${token}`,
      create_time: createTime,
      expires_at: new Date(created.getTime() + 6 * 60 * 60 * 1000).toISOString(),
      principal_type: "User",
    },
  });
}

async function seedGrokCredential(dir: string, accountId: string): Promise<void> {
  const credPath = join(dir, "vault", "grok", accountId, "auth.json");
  await mkdir(join(credPath, ".."), { recursive: true });
  await writeFile(credPath, grokAuthJson("solo@example.com", "2030-01-01T00:00:00.000Z", "solo"));
}

test("account-first open embeds the opencode --model <provider>/<model> selector", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax");
    // Account-first: the bare account id resolves CLI + provider + model.
    const { stdout } = await hive(dir, "open", "opencode-minimax", "--raw", "--print");
    assert.match(stdout, /--model minimax-coding-plan\/MiniMax-M3/);
  });
});

test("bare grok defaults to the single Grok account with credentials", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "grok", "solo@example.com");
    await seedGrokCredential(dir, "grok-solo-example.com");

    const { stdout, stderr } = await hive(dir, "open", "grok", "--raw", "--print");

    assert.match(stderr, /account default → grok-solo-example\.com/);
    assert.match(stdout, /GROK_HOME=.*\/homes\/grok-solo-example\.com grok\b/);
    assert.match(stdout, /--tools=/);
  });
});

test("bare grok does not default an account when an explicit home is requested", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "grok", "solo@example.com");
    await seedGrokCredential(dir, "grok-solo-example.com");

    const { stdout, stderr } = await hive(dir, "open", "grok", "--raw", "--print", "--home", "1");

    assert.doesNotMatch(stderr, /account default/);
    assert.match(stdout, /GROK_HOME=.*\.grok-1 grok\b/);
    assert.match(stdout, /--tools=/);
  });
});

test("account sync accepts codex accounts and pulls newer login-home auth", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "codex", "sync@a.b");
    const accountId = "codex-sync-a.b";
    const vaultPath = join(dir, "vault", "codex", accountId, "auth.json");
    const loginPath = join(dir, "login-homes", accountId, "auth.json");
    await mkdir(join(vaultPath, ".."), { recursive: true });
    await mkdir(join(loginPath, ".."), { recursive: true });
    await writeFile(vaultPath, codexAuthJson("sync@a.b", "2026-06-01T00:00:00.000Z", "old"));
    await writeFile(loginPath, codexAuthJson("sync@a.b", "2026-06-02T00:00:00.000Z", "fresh"));

    const { stdout } = await hive(dir, "account", "sync", accountId);

    assert.match(stdout, /synced\tcodex-sync-a\.b\tupdated/);
    const vault = JSON.parse(await readFile(vaultPath, "utf8"));
    assert.equal(vault.tokens.refresh_token, "refresh-fresh");
  });
});

test("account sync accepts generic file-backed accounts", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "zai", "--provider", "zai-coding-plan");
    const accountId = "opencode-zai";
    const rel = join("xdg-data", "opencode", "auth.json");
    const vaultPath = join(dir, "vault", "opencode", accountId, rel);
    const loginPath = join(dir, "login-homes", accountId, rel);
    await writeDatedFile(vaultPath, JSON.stringify({ "zai-coding-plan": { type: "api", key: "old-key" } }), "2026-06-01T00:00:00.000Z");
    await writeDatedFile(loginPath, JSON.stringify({ "zai-coding-plan": { type: "api", key: "fresh-key" } }), "2026-06-02T00:00:00.000Z");

    const { stdout } = await hive(dir, "account", "sync", accountId);

    assert.match(stdout, /synced\topencode-zai\tupdated/);
    const vault = JSON.parse(await readFile(vaultPath, "utf8"));
    assert.equal(vault["zai-coding-plan"].key, "fresh-key");
  });
});

test("a thin profile referencing an account overlays its model (flag > profile > account)", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax");
    // Profile names the account and overrides the model → PROFILE wins over the
    // account default (MiniMax-M3).
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ bees: { mm: { account: "opencode-minimax", model: "MiniMax-M3-pro" } } }),
    );
    const { stdout } = await hive(dir, "open", "mm", "--raw", "--print");
    assert.match(stdout, /--model minimax-coding-plan\/MiniMax-M3-pro/);
    assert.doesNotMatch(stdout, /MiniMax-M3\b(?!-pro)/);
  });
});

test("a thin profile with NO model override falls back to the account default model (account precedence)", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax");
    await writeFile(join(dir, "config.json"), JSON.stringify({ bees: { mm: { account: "opencode-minimax" } } }));
    const { stdout } = await hive(dir, "open", "mm", "--raw", "--print");
    assert.match(stdout, /--model minimax-coding-plan\/MiniMax-M3/);
  });
});

test("a thin profile appends its extra args", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax");
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ bees: { mm: { account: "opencode-minimax", args: ["--share"] } } }),
    );
    const { stdout } = await hive(dir, "open", "mm", "--raw", "--print");
    assert.match(stdout, /--share/);
  });
});

test("a thin profile referencing a missing account errors clearly", async () => {
  await withStore(async (dir) => {
    await writeFile(join(dir, "config.json"), JSON.stringify({ bees: { mm: { account: "opencode-nope" } } }));
    await assert.rejects(
      () => hive(dir, "open", "mm", "--raw", "--print"),
      (error: unknown) => {
        const message = error instanceof Error ? `${error.message}${(error as { stderr?: string }).stderr ?? ""}` : String(error);
        assert.match(message, /Unknown account: opencode-nope/);
        return true;
      },
    );
  });
});
