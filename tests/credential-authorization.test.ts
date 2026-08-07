import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.HIVE_KIT_DISABLE = "1";

import {
  accountDir,
  addAccount,
  syncAccountCredentialsToVault,
  syncClaudeChainToVault,
} from "../src/accounts.js";
import { runCredentialSweep } from "../src/daemon/credentialSweep.js";
import { transactionalRetire } from "../src/kill.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { KillResult, Substrate } from "../src/substrates/types.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const previousKeychain = process.env.HIVE_NO_KEYCHAIN;
  const dir = await mkdtemp(join(tmpdir(), "hive-content-auth-"));
  process.env.HIVE_STORE_ROOT = dir;
  process.env.HIVE_NO_KEYCHAIN = "1";
  try {
    return await fn(dir);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    if (previousKeychain === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = previousKeychain;
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${body}.signature`;
}

function codexAuth(email: string | undefined, accountId: string | undefined, refreshedAt: string, token: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      ...(email ? { id_token: fakeJwt({ email }) } : {}),
      access_token: `access-${token}`,
      refresh_token: `refresh-${token}`,
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: refreshedAt,
  });
}

function grokAuth(email: string | undefined, createdAt: string, token: string): string {
  return JSON.stringify({
    "https://auth.x.ai::client": {
      ...(email ? { email } : {}),
      key: `key-${token}`,
      refresh_token: `refresh-${token}`,
      create_time: createdAt,
      expires_at: new Date(Date.parse(createdAt) + 6 * 60 * 60_000).toISOString(),
    },
  });
}

function claudeChain(token: string, expiresAt: number, refresh: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt } });
}

function genericAuth(provider: string, key: string): string {
  return JSON.stringify({ [provider]: { type: "api", key } });
}

async function writeDated(path: string, content: string, iso: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
  const date = new Date(iso);
  await utimes(path, date, date);
}

function record(
  name: string,
  agent: string,
  accountId: string,
  homePath: string,
): SessionRecord {
  return {
    name,
    agent,
    accountId,
    homePath,
    cwd: "/tmp",
    command: agent,
    tmuxTarget: name,
    createdAt: "2026-08-07T09:00:00.000Z",
    updatedAt: "2026-08-07T09:00:00.000Z",
    status: "running",
  };
}

test("automatic Codex recovery accepts matching identity and rejects foreign or unknown content", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "a@example.com");
    const vaultPath = join(accountDir(account), "auth.json");
    const homeDir = join(dir, "homes", account.id);
    const homePath = join(homeDir, "auth.json");
    await writeDated(vaultPath, codexAuth("a@example.com", "acct-a", "2026-08-01T00:00:00.000Z", "old"), "2026-08-01T00:00:00.000Z");
    await writeDated(homePath, codexAuth("a@example.com", "acct-a", "2026-08-02T00:00:00.000Z", "own"), "2026-08-02T00:00:00.000Z");

    const matched = await syncAccountCredentialsToVault(account, homeDir, {
      authorization: "automatic",
      trustExtraHome: true,
      homeScope: "extra-only",
      emitSkipTelemetry: false,
    });
    assert.equal(matched.vaultUpdated, true);
    assert.match(await readFile(vaultPath, "utf8"), /access-own/);

    await writeDated(homePath, codexAuth("b@example.com", "acct-b", "2026-08-03T00:00:00.000Z", "foreign"), "2026-08-03T00:00:00.000Z");
    const foreign = await syncAccountCredentialsToVault(account, homeDir, {
      authorization: "automatic",
      trustExtraHome: true,
      homeScope: "extra-only",
      emitSkipTelemetry: false,
    });
    assert.equal(foreign.vaultUpdated, false);
    assert.deepEqual(foreign.skipped.map((skip) => skip.reason), ["foreign-identity"]);
    assert.match(await readFile(vaultPath, "utf8"), /access-own/);

    await writeDated(homePath, codexAuth(undefined, undefined, "2026-08-04T00:00:00.000Z", "opaque"), "2026-08-04T00:00:00.000Z");
    const unknown = await syncAccountCredentialsToVault(account, homeDir, {
      authorization: "automatic",
      trustExtraHome: true,
      homeScope: "extra-only",
      emitSkipTelemetry: false,
    });
    assert.equal(unknown.vaultUpdated, false);
    assert.deepEqual(unknown.skipped.map((skip) => skip.reason), ["identity-unverifiable"]);
    assert.match(await readFile(vaultPath, "utf8"), /access-own/);
  });
});

test("automatic Grok recovery requires a positive email match", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("grok", "a@example.com");
    const vaultPath = join(accountDir(account), "auth.json");
    const homePath = join(dir, "homes", account.id, "auth.json");
    await writeDated(vaultPath, grokAuth("a@example.com", "2026-08-01T00:00:00.000Z", "old"), "2026-08-01T00:00:00.000Z");
    await writeDated(homePath, grokAuth("a@example.com", "2026-08-02T00:00:00.000Z", "own"), "2026-08-02T00:00:00.000Z");

    const matched = await syncAccountCredentialsToVault(account, undefined, {
      authorization: "automatic",
      emitSkipTelemetry: false,
    });
    assert.equal(matched.vaultUpdated, true);
    assert.match(await readFile(vaultPath, "utf8"), /key-own/);

    await writeDated(homePath, grokAuth(undefined, "2026-08-03T00:00:00.000Z", "unknown"), "2026-08-03T00:00:00.000Z");
    const unknown = await syncAccountCredentialsToVault(account, undefined, {
      authorization: "automatic",
      emitSkipTelemetry: false,
    });
    assert.equal(unknown.vaultUpdated, false);
    assert.deepEqual(unknown.skipped.map((skip) => skip.reason), ["identity-unverifiable"]);
    assert.match(await readFile(vaultPath, "utf8"), /key-own/);
  });
});

test("automatic Claude recovery uses an unlocked proof then revalidates exact bytes", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "a@example.com");
    const now = Date.parse("2026-08-07T10:00:00.000Z");
    const vaultPath = join(accountDir(account), ".credentials.json");
    const homePath = join(dir, "homes", account.id, ".credentials.json");
    await writeFile(vaultPath, claudeChain("old-a", now + 60_000, "refresh-old"));
    await writeDated(homePath, claudeChain("new-a", now + 3_600_000, "refresh-a"), "2026-08-07T09:00:00.000Z");

    const matched = await syncClaudeChainToVault(account, undefined, {
      now: () => now,
      fetchProfileEmail: async () => "a@example.com",
    }, { authorization: "automatic", emitSkipTelemetry: false });
    assert.equal(matched.vaultUpdated, true);
    assert.match(await readFile(vaultPath, "utf8"), /new-a/);

    await writeDated(homePath, claudeChain("proof-a", now + 7_200_000, "refresh-proof"), "2026-08-07T09:10:00.000Z");
    const profileEntered = deferred<void>();
    const releaseProfile = deferred<void>();
    const racingSync = syncClaudeChainToVault(account, undefined, {
      now: () => now,
      fetchProfileEmail: async () => {
        profileEntered.resolve(undefined);
        await releaseProfile.promise;
        return "a@example.com";
      },
    }, { authorization: "automatic", emitSkipTelemetry: false });
    await profileEntered.promise;
    // Pre-upgrade writer changes the home after profile validation began.
    await writeDated(homePath, claudeChain("foreign-b", now + 10_800_000, "refresh-b"), "2026-08-07T09:20:00.000Z");
    releaseProfile.resolve(undefined);

    const raced = await racingSync;
    assert.equal(raced.vaultUpdated, false);
    assert.deepEqual(raced.skipped.map((skip) => skip.reason), ["content-changed-after-proof"]);
    assert.match(await readFile(vaultPath, "utf8"), /new-a/);

    const offline = await syncClaudeChainToVault(account, undefined, {
      now: () => now,
      fetchProfileEmail: async () => { throw new Error("offline"); },
    }, { authorization: "automatic", emitSkipTelemetry: false });
    assert.equal(offline.vaultUpdated, false);
    assert.deepEqual(offline.skipped.map((skip) => skip.reason), ["identity-unverifiable"]);
    assert.match(await readFile(vaultPath, "utf8"), /new-a/);
  });
});

test("periodic sweep rejects foreign bytes that arrive after its ownership snapshot", async () => {
  await withTempStore(async (dir) => {
    const accountA = await addAccount("codex", "a@example.com");
    const home = join(dir, "homes", accountA.id);
    const vaultA = join(accountDir(accountA), "auth.json");
    await writeDated(vaultA, codexAuth("a@example.com", "acct-a", "2026-08-01T00:00:00.000Z", "a-vault"), "2026-08-01T00:00:00.000Z");
    await writeDated(join(home, "auth.json"), codexAuth("a@example.com", "acct-a", "2026-08-02T00:00:00.000Z", "a-home"), "2026-08-02T00:00:00.000Z");
    const ownershipSnapshot = [record("new-owner", "codex", accountA.id, home)];
    const snapshotReady = deferred<void>();
    const oldWriterDone = deferred<void>();
    const sweep = runCredentialSweep({
      listAccounts: async () => [accountA],
      listSessions: async () => ownershipSnapshot,
      accountHomes: async () => {
        snapshotReady.resolve(undefined);
        await oldWriterDone.promise;
        return [home];
      },
      concurrency: 1,
    });

    await snapshotReady.promise;
    // A pre-upgrade writer lands foreign bytes after the strict ownership
    // snapshot. Content identity is the final authorization boundary.
    await writeDated(join(home, "auth.json"), codexAuth("b@example.com", "acct-b", "2026-08-03T00:00:00.000Z", "b-home"), "2026-08-03T00:00:00.000Z");
    oldWriterDone.resolve(undefined);
    await sweep;

    const contents = await readFile(vaultA, "utf8");
    assert.match(contents, /access-a-vault/);
    assert.doesNotMatch(contents, /access-b-home/);
  });
});

test("final harvest ownership cannot authorize identity-less replacement bytes", async () => {
  await withTempStore(async (dir) => {
    const provider = "zai-coding-plan";
    const relative = join("xdg-data", "opencode", "auth.json");
    const accountA = await addAccount("opencode", "account-a", { provider });
    const home = join(dir, "shared-home");
    const vaultA = join(accountDir(accountA), relative);
    await writeDated(vaultA, genericAuth(provider, "a-vault"), "2026-08-01T00:00:00.000Z");
    await writeDated(join(home, relative), genericAuth(provider, "a-home"), "2026-08-02T00:00:00.000Z");
    const retiring = record("retiring-a", "opencode", accountA.id, home);
    await saveSession(retiring);

    let stopped = false;
    let oldWriterPublished = false;
    const killResult: KillResult = { ok: true, stdout: "", stderr: "", exitCode: 0 };
    const substrate = {
      kind: "tmux",
      kill: async () => {
        stopped = true;
        return killResult;
      },
      hasSession: async () => {
        if (!stopped) return true;
        if (!oldWriterPublished) {
          // Deterministic barrier: runtime absence was validated, then the old
          // writer lands B bytes before final harvest reads the home.
          await writeDated(join(home, relative), genericAuth(provider, "b-home"), "2026-08-03T00:00:00.000Z");
          oldWriterPublished = true;
        }
        return false;
      },
    } as unknown as Substrate;

    const outcome = await transactionalRetire(retiring, {
      substrate,
      pollIntervalMs: 0,
      finalCredentialSync: async () => {
        await syncAccountCredentialsToVault(accountA, home, {
          authorization: "automatic",
          trustExtraHome: true,
          homeScope: "extra-only",
          emitSkipTelemetry: false,
        });
      },
    });
    assert.equal(outcome.ok, true);
    assert.equal((await loadSession(retiring.name))?.status, "done");
    const contents = await readFile(vaultA, "utf8");
    assert.match(contents, /a-vault/);
    assert.doesNotMatch(contents, /b-home/);
  });
});
