import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addAccount, accountDir } from "../src/accounts.js";
import { accountLimits, emailFromJwt, lastRateLimitsInFile, paceDelta, windowRolledOver } from "../src/limits.js";

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const oldKeychain = process.env.HIVE_NO_KEYCHAIN;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-limits-"));
  process.env.HIVE_STORE_ROOT = dir;
  process.env.HIVE_NO_KEYCHAIN = "1";
  try {
    return await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    if (oldKeychain === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = oldKeychain;
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${body}.sig`;
}

test("paceDelta compares used% against elapsed% of the window", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // 5h window, resets in 2.5h → 50% elapsed. Used 80% → +30 ahead of pace.
  const hot = { usedPercent: 80, windowMinutes: 300, resetsAt: "2026-06-10T14:30:00Z" };
  assert.equal(Math.round(paceDelta(hot, now)!), 30);
  // Used 20% at 50% elapsed → -30 (headroom).
  const cool = { ...hot, usedPercent: 20 };
  assert.equal(Math.round(paceDelta(cool, now)!), -30);
  // Unknown window length or boundary → no pace.
  assert.equal(paceDelta({ usedPercent: 50, resetsAt: "2026-06-10T14:30:00Z" }, now), null);
  assert.equal(paceDelta({ usedPercent: 50, windowMinutes: 300 }, now), null);
  // Boundary already passed → no pace (the snapshot is stale).
  assert.equal(paceDelta({ usedPercent: 50, windowMinutes: 300, resetsAt: "2026-06-10T11:00:00Z" }, now), null);
});

test("windowRolledOver flags snapshots whose reset boundary has passed", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  assert.equal(windowRolledOver({ usedPercent: 14, resetsAt: "2026-06-10T11:59:00Z" }, now), true);
  assert.equal(windowRolledOver({ usedPercent: 14, resetsAt: "2026-06-10T12:01:00Z" }, now), false);
  assert.equal(windowRolledOver({ usedPercent: 14 }, now), false);
});

test("emailFromJwt decodes the email claim without verification", () => {
  assert.equal(emailFromJwt(fakeJwt({ email: "a@b.c", sub: "x" })), "a@b.c");
  assert.equal(emailFromJwt(fakeJwt({ sub: "x" })), null);
  assert.equal(emailFromJwt("not-a-jwt"), null);
});

test("lastRateLimitsInFile returns the newest snapshot and skips torn lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-rl-"));
  try {
    const path = join(dir, "rollout.jsonl");
    const row = (ts: string, used: number) =>
      JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: used, window_minutes: 300, resets_at: 1781037177 },
            secondary: { used_percent: 35, window_minutes: 10080, resets_at: 1781138732 },
            plan_type: "pro",
          },
        },
      });
    await writeFile(path, `${row("2026-06-09T10:00:00Z", 5)}\n${row("2026-06-09T11:00:00Z", 12)}\n{"torn`);
    const snapshot = await lastRateLimitsInFile(path);
    assert.equal(snapshot?.ts, "2026-06-09T11:00:00Z");
    assert.equal(snapshot?.limits.primary?.used_percent, 12);
    assert.equal(snapshot?.limits.plan_type, "pro");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude limits use the freshest unexpired token and map the usage windows", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "lim@a.b");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-vault", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } }),
    );

    const asked: string[] = [];
    const [result] = await accountLimits([account], {
      fetchClaudeUsage: async (token) => {
        asked.push(token);
        return {
          five_hour: { utilization: 87.5, resets_at: "2026-06-10T09:30:00Z" },
          seven_day: { utilization: 40, resets_at: "2026-06-16T17:00:00Z" },
        };
      },
      fetchClaudeProfileEmail: async () => "lim@a.b",
      readKeychain: async () => null,
    });

    assert.deepEqual(asked, ["tok-vault"]);
    assert.equal(result!.ok, true);
    assert.equal(result!.plan, "max");
    assert.equal(result!.fiveHour?.usedPercent, 87.5);
    assert.equal(result!.weekly?.resetsAt, "2026-06-16T17:00:00Z");
  });
});

test("claude limits reject tokens whose profile email belongs to another account", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "right@a.b");
    await mkdir(accountDir(account), { recursive: true });
    // The vault token is fresh — but it's actually some other account's.
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-imposter", expiresAt: Date.now() + 3_600_000 } }),
    );
    const [result] = await accountLimits([account], {
      fetchClaudeUsage: async () => {
        throw new Error("must not query usage with an imposter token");
      },
      fetchClaudeProfileEmail: async () => "wrong@a.b",
      refreshClaudeToken: async () => null,
      readKeychain: async () => null,
    });
    assert.equal(result!.ok, false);
    assert.match(result!.error ?? "", /no token belongs to right@a\.b/);
    assert.match(result!.error ?? "", /wrong@a\.b/);
  });
});

test("an expired chain is refreshed, persisted (rotation!), and then used", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "stale@a.b");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "tok-dead", expiresAt: Date.now() - 1000, refreshToken: "refresh-old", subscriptionType: "max" },
      }),
    );

    const persisted: { account: string; oauth: Record<string, unknown> }[] = [];
    const usageAskedWith: string[] = [];
    const [result] = await accountLimits([account], {
      refreshClaudeToken: async (refreshToken) => {
        assert.equal(refreshToken, "refresh-old");
        return { accessToken: "tok-new", refreshToken: "refresh-rotated", expiresAt: Date.now() + 8 * 3600_000 };
      },
      persistRefreshedCredentials: async (target, oauth) => {
        persisted.push({ account: target.id, oauth });
      },
      fetchClaudeProfileEmail: async () => "stale@a.b",
      fetchClaudeUsage: async (token) => {
        usageAskedWith.push(token);
        return { five_hour: { utilization: 5, resets_at: "2026-06-10T18:00:00Z" } };
      },
      readKeychain: async () => null,
    });

    assert.equal(result!.ok, true);
    assert.equal(result!.plan, "max");
    assert.deepEqual(usageAskedWith, ["tok-new"]);
    // The rotated refresh token MUST be persisted or the chain is orphaned.
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.account, account.id);
    assert.equal(persisted[0]!.oauth.refreshToken, "refresh-rotated");
    assert.equal(persisted[0]!.oauth.subscriptionType, "max");
  });
});

test("refreshing a mislabeled chain parks the rotated tokens with their real owner", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "mine@a.b");
    const owner = await addAccount("claude", "theirs@a.b");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-dead", expiresAt: Date.now() - 1000, refreshToken: "refresh-x" } }),
    );

    const persisted: string[] = [];
    const [result] = await accountLimits([account], {
      refreshClaudeToken: async () => ({ accessToken: "tok-new", refreshToken: "refresh-rotated", expiresAt: Date.now() + 3600_000 }),
      persistRefreshedCredentials: async (target) => {
        persisted.push(target.id);
      },
      fetchClaudeProfileEmail: async () => "theirs@a.b",
      fetchClaudeUsage: async () => {
        throw new Error("must not use the imposter token");
      },
      readKeychain: async () => null,
    });

    assert.equal(result!.ok, false);
    assert.match(result!.error ?? "", /theirs@a\.b/);
    assert.deepEqual(persisted, [owner.id]);
  });
});

test("claude limits report an expired token instead of calling the API", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "old@a.b");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-old", expiresAt: Date.now() - 1000 } }),
    );
    const [result] = await accountLimits([account], {
      fetchClaudeUsage: async () => {
        throw new Error("should not be called");
      },
      readKeychain: async () => null,
    });
    assert.equal(result!.ok, false);
    assert.match(result!.error ?? "", /expired/);
  });
});

test("codex prefers live app-server limits and falls back to disk snapshots", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "live@a.b");
    // A dedicated account home makes codexHomesForAccount match without auth.json.
    await mkdir(join(dir, "homes", account.id), { recursive: true });

    const [live] = await accountLimits([account], {
      codexLiveRateLimits: async () => ({
        primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1781095703 },
        secondary: { usedPercent: 38, windowDurationMins: 10080, resetsAt: 1781138732 },
        planType: "pro",
      }),
    });
    assert.equal(live!.ok, true);
    assert.equal(live!.source, "app-server");
    assert.equal(live!.plan, "pro");
    assert.equal(live!.fiveHour?.usedPercent, 15);
    assert.equal(live!.fiveHour?.windowMinutes, 300);
    assert.equal(live!.weekly?.usedPercent, 38);
    assert.equal(live!.asOf, undefined);

    // Live unavailable → snapshot fallback (none on disk here → factual error).
    const [fallback] = await accountLimits([account], {
      codexLiveRateLimits: async () => null,
    });
    assert.equal(fallback!.ok, false);
    assert.equal(fallback!.source, "session-snapshot");
    assert.match(fallback!.error ?? "", /no rate-limit snapshot/);
  });
});

test("unsupported tools and missing codex homes degrade to errors, not throws", async () => {
  await withTempStore(async () => {
    const opencode = await addAccount("opencode", "oc");
    const codex = await addAccount("codex", "cx@a.b");
    const results = await accountLimits([opencode, codex]);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.source, "unsupported");
    assert.equal(results[1]!.ok, false);
    assert.match(results[1]!.error ?? "", /no home found/);
  });
});
