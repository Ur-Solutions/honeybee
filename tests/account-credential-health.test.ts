import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountCredentialUnavailableReason,
  accountDir,
  addAccount,
  captureAccountFromHome,
  recentAccountBootFailures,
  recordAccountBootFailure,
} from "../src/accounts.js";
import { AccountActivationError, spawnBee } from "../src/commands/spawn.js";

async function withTempStore(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-account-health-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const previousKeychain = process.env.HIVE_NO_KEYCHAIN;
  process.env.HIVE_STORE_ROOT = root;
  process.env.HIVE_NO_KEYCHAIN = "1";
  try {
    await fn(root);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    if (previousKeychain === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = previousKeychain;
    await rm(root, { recursive: true, force: true });
  }
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("credential preflight rejects provably expired OAuth but keeps refreshable chains", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-15T06:00:00.000Z");
    const stale = await addAccount("claude", "stale@example.com");
    const refreshable = await addAccount("claude", "refreshable@example.com");
    for (const account of [stale, refreshable]) await mkdir(accountDir(account), { recursive: true });
    const credential = (refreshToken?: string) => JSON.stringify({
      claudeAiOauth: {
        accessToken: "expired-access",
        expiresAt: now - 60_000,
        ...(refreshToken ? { refreshToken } : {}),
      },
    });
    await writeFile(join(accountDir(stale), ".credentials.json"), credential());
    await writeFile(join(accountDir(refreshable), ".credentials.json"), credential("rotating-refresh"));

    assert.match((await accountCredentialUnavailableReason(stale, now)) ?? "", /no refresh token/);
    assert.equal(
      await accountCredentialUnavailableReason(refreshable, now),
      null,
      "the picker must not consume or reject a potentially refreshable rotating chain",
    );
  });
});

test("credential preflight handles Cursor, Grok, and Codex without rejecting refreshable tokens", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-08-15T06:00:00.000Z");
    const cursor = await addAccount("cursor", "cursor@example.com");
    const grok = await addAccount("grok", "grok@example.com");
    const codex = await addAccount("codex", "codex@example.com");
    for (const account of [cursor, grok, codex]) await mkdir(accountDir(account), { recursive: true });

    await writeFile(join(accountDir(cursor), "auth.json"), JSON.stringify({
      accessToken: jwt({ exp: Math.floor(now / 1000) - 60 }),
    }));
    await writeFile(join(accountDir(grok), "auth.json"), JSON.stringify({
      issuer: {
        key: "expired-access",
        refresh_token: "still-refreshable",
        expires_at: new Date(now - 60_000).toISOString(),
      },
    }));
    await writeFile(join(accountDir(codex), "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt({ exp: Math.floor(now / 1000) - 60 }),
        refresh_token: "still-refreshable",
      },
    }));

    assert.match((await accountCredentialUnavailableReason(cursor, now)) ?? "", /expired/);
    assert.equal(await accountCredentialUnavailableReason(grok, now), null);
    assert.equal(await accountCredentialUnavailableReason(codex, now), null);
  });
});

test("a pre-fork activation failure opens the durable account breaker", async () => {
  await withTempStore(async (root) => {
    const account = await addAccount("claude", "dead@example.com");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(join(accountDir(account), ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "expired-access",
        expiresAt: Date.now() - 60_000,
      },
    }));
    let forked = false;
    await assert.rejects(
      spawnBee({
        agent: "claude",
        account,
        extraArgs: [],
        cwd: root,
        yolo: false,
        name: "activation-breaker",
        substrate: "hsr",
      }, {
        spawnHsrHost: async () => {
          forked = true;
          return 99_991;
        },
      }),
      (error: unknown) => error instanceof AccountActivationError,
    );
    assert.equal(forked, false, "credential activation fails before a harness fork");
    assert.equal((await recentAccountBootFailures()).get(account.id)?.stage, "activation");
  });
});

test("a fresh credential capture clears an older activation quarantine", async () => {
  await withTempStore(async (root) => {
    const account = await addAccount("claude", "repaired@example.com");
    const loginHome = join(root, "login-home");
    await mkdir(loginHome, { recursive: true });
    await writeFile(join(loginHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt: Date.now() + 60 * 60_000,
      },
    }));
    await recordAccountBootFailure(account.id, Date.now() - 1_000, "activation");

    await captureAccountFromHome(account, loginHome);

    assert.equal((await recentAccountBootFailures()).has(account.id), false);
  });
});
