import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { addAccount, accountDir } from "../src/accounts.js";
import { CLAUDE_PROFILE_EMAIL_CACHE_MAX, accountLimits, cachedAccountLimits, effectiveWindowLoad, emailFromJwt, lastRateLimitsInFile, paceDelta, pickLeastLoadedAccount, selectLeastLoadedAccount, sortAccountsForLimitsDisplay, windowRolledOver } from "../src/limits.js";

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

test("effectiveWindowLoad adjusts used% by pace with diminishing weight near the wall", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const weekly = (usedPercent: number, resetsAt: string) => ({ usedPercent, windowMinutes: 10_080, resetsAt });
  // 70% used, resets in a day (85.7% elapsed): behind pace, full weight →
  // score is the pace delta itself.
  assert.equal(Math.round(effectiveWindowLoad(weekly(70, "2026-06-11T12:00:00Z"), now)), -16);
  // Ahead of pace pushes the score above raw used%.
  assert.ok(effectiveWindowLoad(weekly(40, "2026-06-15T12:00:00Z"), now) > 11);
  // 98% used with 1h left is behind pace too, but headroom 2 fades the pace
  // weight to ~0.08 — the score stays close to raw usage.
  assert.ok(effectiveWindowLoad(weekly(98, "2026-06-10T13:00:00Z"), now) > 85);
  // No boundary → raw used%; rolled over → fresh.
  assert.equal(effectiveWindowLoad({ usedPercent: 55 }, now), 55);
  assert.equal(effectiveWindowLoad(weekly(99, "2026-06-10T11:00:00Z"), now), 0);
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

test("sortAccountsForLimitsDisplay groups claude, then codex, then the rest by tool, keeping in-group order", async () => {
  await withTempStore(async () => {
    const grok = await addAccount("grok", "g@a.b");
    const codex = await addAccount("codex", "c@a.b");
    const claudeLate = await addAccount("claude", "digitech");
    const opencode = await addAccount("opencode", "o@a.b", { provider: "zai-coding-plan" });
    const claudeEarly = await addAccount("claude", "first@a.b");

    const sorted = sortAccountsForLimitsDisplay([grok, codex, claudeLate, opencode, claudeEarly]);
    assert.deepEqual(
      sorted.map((account) => account.id),
      [claudeLate.id, claudeEarly.id, codex.id, grok.id, opencode.id],
    );
  });
});

test("claude limits map the Fable-scoped weekly entry to fableWeekly", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "fab@a.b");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-vault", expiresAt: Date.now() + 3_600_000 } }),
    );

    const [result] = await accountLimits([account], {
      fetchClaudeUsage: async () => ({
        five_hour: { utilization: 12, resets_at: "2026-06-10T09:30:00Z" },
        seven_day: { utilization: 30, resets_at: "2026-06-16T17:00:00Z" },
        limits: [
          { kind: "session", percent: 12, resets_at: "2026-06-10T09:30:00Z", scope: null },
          { kind: "weekly_all", percent: 30, resets_at: "2026-06-16T17:00:00Z", scope: null },
          // Surface-scoped entries must not be mistaken for the model window.
          { kind: "weekly_scoped", percent: 99, resets_at: "2026-06-16T17:00:00Z", scope: { model: null } },
          { kind: "weekly_scoped", percent: 55, resets_at: "2026-06-16T17:00:00Z", scope: { model: { display_name: "Fable" } } },
        ],
      }),
      fetchClaudeProfileEmail: async () => "fab@a.b",
      readKeychain: async () => null,
    });

    assert.equal(result!.ok, true);
    assert.equal(result!.fableWeekly?.usedPercent, 55);
    assert.equal(result!.fableWeekly?.resetsAt, "2026-06-16T17:00:00Z");
    assert.equal(result!.fableWeekly?.windowMinutes, 10_080);
    // Unscoped windows stay sourced from five_hour/seven_day.
    assert.equal(result!.weekly?.usedPercent, 30);
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

test("claude profile email cache is bounded and evicts least-recently-used tokens", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "cache@a.b");
    const credentialPath = join(accountDir(account), ".credentials.json");
    const oldFetch = globalThis.fetch;
    const profileCallsByToken = new Map<string, number>();

    const writeToken = (accessToken: string) =>
      writeFile(
        credentialPath,
        JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: Date.now() + 3_600_000 } }),
      );
    const checkLimits = async () => {
      const [result] = await accountLimits([account], {
        fetchClaudeUsage: async () => ({ five_hour: { utilization: 1 } }),
        readKeychain: async () => null,
      });
      assert.equal(result!.ok, true);
    };

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization =
        init?.headers && !Array.isArray(init.headers) && !(init.headers instanceof Headers)
          ? (init.headers as Record<string, string>).Authorization
          : undefined;
      const accessToken = authorization?.replace(/^Bearer\s+/, "");
      assert.ok(accessToken, "profile request must include a bearer token");
      profileCallsByToken.set(accessToken, (profileCallsByToken.get(accessToken) ?? 0) + 1);
      return new Response(JSON.stringify({ account: { email: "cache@a.b" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await writeToken("tok-0");
      await checkLimits();

      for (let index = 1; index < CLAUDE_PROFILE_EMAIL_CACHE_MAX; index += 1) {
        await writeToken(`tok-${index}`);
        await checkLimits();
      }

      await writeToken("tok-0");
      await checkLimits();
      assert.equal(profileCallsByToken.get("tok-0"), 1);

      await writeToken(`tok-${CLAUDE_PROFILE_EMAIL_CACHE_MAX}`);
      await checkLimits();

      await writeToken("tok-0");
      await checkLimits();
      assert.equal(profileCallsByToken.get("tok-0"), 1);

      await writeToken("tok-1");
      await checkLimits();
      assert.equal(profileCallsByToken.get("tok-1"), 2);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

test("an email-less account never trusts unattributed shared-home keychain tokens", async () => {
  await withTempStore(async (dir) => {
    // candidateHomes scans os.homedir(); point HOME at the temp dir so the
    // "shared ~/.claude" below is the only unattributed home on the machine.
    const oldHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const sharedHome = join(dir, ".claude");
      await mkdir(sharedHome, { recursive: true });
      // No email and no @ in the label → nothing to verify identity against.
      const account = await addAccount("claude", "work");
      // No vault credentials and no dedicated home: the only candidate is a
      // FRESH keychain token in the shared home — someone else's daily driver.
      const [result] = await accountLimits([account], {
        readKeychain: async (home) =>
          home === sharedHome
            ? JSON.stringify({ claudeAiOauth: { accessToken: "tok-daily-driver", expiresAt: Date.now() + 3_600_000 } })
            : null,
        fetchClaudeUsage: async () => {
          throw new Error("must not report another account's usage");
        },
        fetchClaudeProfileEmail: async () => {
          throw new Error("must not be called — there is no email to match");
        },
        refreshClaudeToken: async () => null,
      });
      assert.equal(result!.ok, false);
      assert.match(result!.error ?? "", /no email to verify/);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

test("accountLimits memoizes claude keychain reads per home for one sweep", async () => {
  await withTempStore(async (dir) => {
    const oldHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const sharedHome = join(dir, ".claude");
      await mkdir(sharedHome, { recursive: true });
      const accounts = [];
      for (let index = 0; index < 6; index += 1) {
        accounts.push(await addAccount("claude", `memo-${index}@a.b`));
      }

      const callsByHome = new Map<string, number>();
      const results = await accountLimits(accounts, {
        readKeychain: async (home) => {
          const key = resolve(home);
          callsByHome.set(key, (callsByHome.get(key) ?? 0) + 1);
          await sleep(5);
          return null;
        },
        fetchClaudeUsage: async () => {
          throw new Error("no keychain token should reach usage");
        },
        fetchClaudeProfileEmail: async () => {
          throw new Error("no keychain token should reach profile verification");
        },
      });

      assert.deepEqual(results.map((result) => result.ok), [false, false, false, false, false, false]);
      assert.equal(callsByHome.get(resolve(sharedHome)), 1);
      assert.equal([...callsByHome.values()].reduce((sum, count) => sum + count, 0), 1);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

test("an email-less account uses its attributed vault token without profile verification", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "work");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-vault", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } }),
    );

    const asked: string[] = [];
    const [result] = await accountLimits([account], {
      fetchClaudeUsage: async (token) => {
        asked.push(token);
        return { five_hour: { utilization: 42, resets_at: "2026-06-10T09:30:00Z" } };
      },
      fetchClaudeProfileEmail: async () => {
        throw new Error("no email to verify against — must not be called");
      },
      readKeychain: async () => null,
    });

    assert.deepEqual(asked, ["tok-vault"]);
    assert.equal(result!.ok, true);
    assert.equal(result!.plan, "max");
    assert.equal(result!.fiveHour?.usedPercent, 42);
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

test("chain refresh and persist run inside the accounts lock (HIVE-2)", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "lock@a.b");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-dead", expiresAt: Date.now() - 1000, refreshToken: "r-old" } }),
    );

    let depth = 0;
    const events: string[] = [];
    const [result] = await accountLimits([account], {
      withAccountsLock: async (fn) => {
        depth += 1;
        try {
          return await fn();
        } finally {
          depth -= 1;
        }
      },
      refreshClaudeToken: async () => {
        events.push(`refresh@${depth}`);
        return { accessToken: "tok-new", refreshToken: "r-rotated", expiresAt: Date.now() + 3_600_000 };
      },
      persistRefreshedCredentials: async () => {
        events.push(`persist@${depth}`);
      },
      fetchClaudeProfileEmail: async () => "lock@a.b",
      fetchClaudeUsage: async () => ({ five_hour: { utilization: 1, resets_at: "2026-06-10T18:00:00Z" } }),
      readKeychain: async () => null,
    });

    assert.equal(result!.ok, true);
    // Both the rotation and its persistence happened while the lock was held.
    assert.deepEqual(events, ["refresh@1", "persist@1"]);
  });
});

test("refresh double-checks the vault under the lock and reuses a chain rotated by a concurrent writer (HIVE-2)", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "race@a.b");
    await mkdir(accountDir(account), { recursive: true });
    const vaultPath = join(accountDir(account), ".credentials.json");
    await writeFile(
      vaultPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-dead", expiresAt: Date.now() - 1000, refreshToken: "r-old" } }),
    );

    const usageAskedWith: string[] = [];
    const [result] = await accountLimits([account], {
      // Simulate a concurrent writer (activation) winning the lock first and
      // rotating the chain while we waited: by the time our critical section
      // runs, the vault already holds the rotated fresh chain.
      withAccountsLock: async (fn) => {
        await writeFile(
          vaultPath,
          JSON.stringify({
            claudeAiOauth: { accessToken: "tok-rotated", expiresAt: Date.now() + 3_600_000, refreshToken: "r-rotated", subscriptionType: "max" },
          }),
        );
        return fn();
      },
      refreshClaudeToken: async () => {
        throw new Error("must not replay a refresh token another writer already rotated");
      },
      fetchClaudeProfileEmail: async () => "race@a.b",
      fetchClaudeUsage: async (token) => {
        usageAskedWith.push(token);
        return { five_hour: { utilization: 1, resets_at: "2026-06-10T18:00:00Z" } };
      },
      readKeychain: async () => null,
    });

    assert.equal(result!.ok, true);
    assert.equal(result!.plan, "max");
    assert.deepEqual(usageAskedWith, ["tok-rotated"]);
  });
});

test("a vault chain rotated behind us to another identity is never replayed (HIVE-2)", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "super@a.b");
    await mkdir(accountDir(account), { recursive: true });
    const vaultPath = join(accountDir(account), ".credentials.json");
    await writeFile(
      vaultPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-dead", expiresAt: Date.now() - 1000, refreshToken: "r-old" } }),
    );

    const [result] = await accountLimits([account], {
      // The chain moved on while we waited for the lock — and the rotated
      // link belongs to someone else. The superseded r-old token must not be
      // replayed (that replay is what trips reuse detection).
      withAccountsLock: async (fn) => {
        await writeFile(
          vaultPath,
          JSON.stringify({ claudeAiOauth: { accessToken: "tok-other", expiresAt: Date.now() + 3_600_000, refreshToken: "r-other" } }),
        );
        return fn();
      },
      refreshClaudeToken: async () => {
        throw new Error("must not replay the superseded refresh token");
      },
      fetchClaudeProfileEmail: async (token) => (token === "tok-other" ? "wrong@a.b" : null),
      fetchClaudeUsage: async () => {
        throw new Error("must not query usage with another identity's token");
      },
      readKeychain: async () => null,
    });

    assert.equal(result!.ok, false);
    assert.match(result!.error ?? "", /no token belongs to super@a\.b/);
    assert.match(result!.error ?? "", /wrong@a\.b/);
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

test("a fresh token with unverifiable identity blocks chain refresh (live-session protection)", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "live@a.b");
    await mkdir(accountDir(account), { recursive: true });
    // The vault holds an expired link with a refresh token — tempting to rotate.
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-dead", expiresAt: Date.now() - 1000, refreshToken: "r-old" } }),
    );
    // The dedicated home holds a FRESH link (a live session), but the profile
    // endpoint is unreachable so its identity cannot be confirmed.
    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-live", expiresAt: Date.now() + 3_600_000, refreshToken: "r-live" } }),
    );

    const [result] = await accountLimits([account], {
      fetchClaudeProfileEmail: async () => null,
      refreshClaudeToken: async () => {
        throw new Error("must not rotate a chain while an unverifiable fresh token exists");
      },
      fetchClaudeUsage: async () => {
        throw new Error("must not query usage with an unverified token");
      },
      readKeychain: async () => null,
    });

    assert.equal(result!.ok, false);
    assert.match(result!.error ?? "", /could not be verified/);
    assert.match(result!.error ?? "", /not refreshing/);
  });
});

test("a verified fresher home token is mirrored into the vault", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "mirror@a.b");
    await mkdir(accountDir(account), { recursive: true });
    await writeFile(
      join(accountDir(account), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-old", expiresAt: Date.now() + 1_000 } }),
    );
    // The live link sits in the dedicated home (claude refreshes on use).
    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-live", expiresAt: Date.now() + 8 * 3_600_000, refreshToken: "r-live" } }),
    );

    const [result] = await accountLimits([account], {
      fetchClaudeProfileEmail: async () => "mirror@a.b",
      fetchClaudeUsage: async () => ({ five_hour: { utilization: 10, resets_at: "2026-06-11T18:00:00Z" } }),
      readKeychain: async () => null,
    });

    assert.equal(result!.ok, true);
    // The vault caught up with the live link, so a later activation cannot
    // stamp the older (possibly dead) link over it.
    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-live");
    assert.equal(vault.claudeAiOauth.refreshToken, "r-live");
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

test("accountLimits caps codex live app-server fan-out", async () => {
  await withTempStore(async (dir) => {
    const accounts = [];
    for (let index = 0; index < 8; index += 1) {
      const account = await addAccount("codex", `fanout-${index}@a.b`);
      await mkdir(join(dir, "homes", account.id), { recursive: true });
      accounts.push(account);
    }

    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const results = await accountLimits(accounts, {
      codexLiveRateLimits: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active -= 1;
        return { primary: { usedPercent: 1 } };
      },
    });

    assert.equal(calls, accounts.length);
    assert.ok(maxActive <= 4, `expected at most 4 concurrent live Codex reads, saw ${maxActive}`);
    assert.deepEqual(results.map((result) => result.account), accounts.map((account) => account.id));
    assert.deepEqual(results.map((result) => result.source), accounts.map(() => "app-server"));
  });
});

test("unsupported tools and missing codex homes degrade to errors, not throws", async () => {
  await withTempStore(async () => {
    const opencode = await addAccount("opencode", "oc", { provider: "minimax-coding-plan" });
    const codex = await addAccount("codex", "cx@a.b");
    const results = await accountLimits([opencode, codex]);
    assert.equal(results[0]!.ok, false);
    assert.equal(results[0]!.source, "unsupported");
    assert.equal(results[1]!.ok, false);
    assert.match(results[1]!.error ?? "", /no home found/);
  });
});

function pickAccount(id: string, addedAt: string): import("../src/accounts.js").AccountRecord {
  return { id, tool: "claude", label: id, addedAt };
}

function okLimits(id: string, weekly: number, fiveHour: number, resetsAt = "2026-06-10T18:00:00Z"): import("../src/limits.js").AccountLimits {
  return {
    account: id,
    tool: "claude",
    ok: true,
    source: "oauth-api",
    fiveHour: { usedPercent: fiveHour, windowMinutes: 300, resetsAt },
    weekly: { usedPercent: weekly, windowMinutes: 10_080, resetsAt },
  };
}

test("selectLeastLoadedAccount picks the least weekly usage", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits("a", 60, 10) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits("b", 20, 50) },
      { account: pickAccount("c", "2026-01-03"), limits: okLimits("c", 40, 5) },
    ],
    now,
  );
  assert.equal(choice?.account.id, "b");
  assert.match(choice?.reason ?? "", /behind pace/);
});

test("selectLeastLoadedAccount prefers an imminent reset with expiring surplus over lower raw usage", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // a: 70% used but its week resets in 1 day (86% elapsed) — 30% expires
  // unused if nobody burns it. b: only 40% used but 5 days from reset and
  // already ahead of pace. Pace says a.
  const withWeekly = (id: string, used: number, resetsAt: string): import("../src/limits.js").AccountLimits => ({
    ...okLimits(id, used, 10),
    weekly: { usedPercent: used, windowMinutes: 10_080, resetsAt },
  });
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: withWeekly("a", 70, "2026-06-11T12:00:00Z") },
      { account: pickAccount("b", "2026-01-02"), limits: withWeekly("b", 40, "2026-06-15T12:00:00Z") },
    ],
    now,
  );
  assert.equal(choice?.account.id, "a");
  assert.match(choice?.reason ?? "", /behind pace — surplus expires at reset/);

  // Diminishing returns near 100%: c is behind pace too (98% used, resets in
  // 1h) but its remaining 2% is not worth landing a fresh bee on — the
  // on-pace account with real headroom wins.
  const nearWall = selectLeastLoadedAccount(
    [
      { account: pickAccount("c", "2026-01-01"), limits: withWeekly("c", 98, "2026-06-10T13:00:00Z") },
      { account: pickAccount("d", "2026-01-02"), limits: withWeekly("d", 50, "2026-06-14T00:00:00Z") },
    ],
    now,
  );
  assert.equal(nearWall?.account.id, "d");

  // Boundary-less windows keep the old least-used behavior and reason.
  const noBoundary = (id: string, used: number): import("../src/limits.js").AccountLimits => ({
    account: id,
    tool: "claude",
    ok: true,
    source: "oauth-api",
    weekly: { usedPercent: used },
  });
  const blind = selectLeastLoadedAccount(
    [
      { account: pickAccount("e", "2026-01-01"), limits: noBoundary("e", 60) },
      { account: pickAccount("f", "2026-01-02"), limits: noBoundary("f", 20) },
    ],
    now,
  );
  assert.equal(blind?.account.id, "f");
  assert.equal(blind?.reason, "least weekly usage");
});

test("selectLeastLoadedAccount pushes 5h-saturated accounts behind ones with headroom", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // b has the lowest weekly but its 5h window is nearly exhausted.
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits("a", 55, 30) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits("b", 10, 95) },
    ],
    now,
  );
  assert.equal(choice?.account.id, "a");

  // All saturated → least weekly among them, and the reason says why.
  const allHot = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits("a", 55, 92) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits("b", 10, 95) },
    ],
    now,
  );
  assert.equal(allHot?.account.id, "b");
  assert.match(allHot?.reason ?? "", /5h limit/);
});

test("selectLeastLoadedAccount treats rolled-over windows as fresh and unreadable limits as last resort", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // a's snapshot says 99% but its windows already reset → counts as 0%.
  // b's week just started (slightly ahead of pace), so fresh-a wins.
  const rolled = okLimits("a", 99, 99, "2026-06-10T11:00:00Z");
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: rolled },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits("b", 5, 5, "2026-06-17T11:00:00Z") },
    ],
    now,
  );
  assert.equal(choice?.account.id, "a");

  // Readable-but-high beats unreadable; all unreadable → oldest registration.
  const failed: import("../src/limits.js").AccountLimits = { account: "c", tool: "claude", ok: false, source: "oauth-api", error: "boom" };
  const mixed = selectLeastLoadedAccount(
    [
      { account: pickAccount("c", "2026-01-01"), limits: failed },
      { account: pickAccount("d", "2026-01-02"), limits: okLimits("d", 97, 10) },
    ],
    now,
  );
  assert.equal(mixed?.account.id, "d");
  const blind = selectLeastLoadedAccount(
    [
      { account: pickAccount("e", "2026-01-02"), limits: { ...failed, account: "e" } },
      { account: pickAccount("c", "2026-01-01"), limits: failed },
    ],
    now,
  );
  assert.equal(blind?.account.id, "c");
  assert.match(blind?.reason ?? "", /unreadable/);
});

test("pickLeastLoadedAccount filters to credentialed accounts of the tool and shortcuts a lone candidate", async () => {
  await withTempStore(async () => {
    const one = await addAccount("claude", "one@a.b");
    const two = await addAccount("claude", "two@a.b");
    const dry = await addAccount("claude", "dry@a.b");
    await addAccount("codex", "cx@a.b");

    let fetched: string[] = [];
    const choice = await pickLeastLoadedAccount("claude", {
      hasCredentials: async (account) => account.id !== dry.id,
      fetchLimits: async (accounts) => {
        fetched = accounts.map((account) => account.id);
        return [okLimits(one.id, 70, 10), okLimits(two.id, 30, 10)];
      },
      now: () => Date.parse("2026-06-10T12:00:00Z"),
    });
    assert.deepEqual(fetched, [one.id, two.id]);
    assert.equal(choice.account.id, two.id);
    assert.equal(choice.limits?.account, two.id);

    // A single credentialed account wins without any limits round-trip.
    const lone = await pickLeastLoadedAccount("claude", {
      hasCredentials: async (account) => account.id === one.id,
      fetchLimits: async () => {
        throw new Error("should not fetch limits for a lone candidate");
      },
    });
    assert.equal(lone.account.id, one.id);
    assert.match(lone.reason, /only claude account/);

    await assert.rejects(() => pickLeastLoadedAccount("grok"), /No grok accounts registered/);
    await assert.rejects(
      () => pickLeastLoadedAccount("claude", { hasCredentials: async () => false }),
      /vaulted credentials/,
    );
  });
});

test("cachedAccountLimits serves fresh cache entries and refetches stale or failed ones", async () => {
  await withTempStore(async (dir) => {
    const one = await addAccount("claude", "c1@a.b");
    const two = await addAccount("claude", "c2@a.b");
    const t0 = Date.parse("2026-06-10T12:00:00Z");
    let calls: string[][] = [];
    const fetchLimits = (results: Record<string, import("../src/limits.js").AccountLimits>) =>
      async (accounts: import("../src/accounts.js").AccountRecord[]) => {
        calls.push(accounts.map((account) => account.id));
        return accounts.map((account) => results[account.id]!);
      };

    // First read: empty cache → both fetched live; only the ok result is cached.
    const failed: import("../src/limits.js").AccountLimits = { account: two.id, tool: "claude", ok: false, source: "oauth-api", error: "boom" };
    const first = await cachedAccountLimits([one, two], {
      ttlMs: 60 * 60 * 1000,
      fetchLimits: fetchLimits({ [one.id]: okLimits(one.id, 40, 10), [two.id]: failed }),
      now: () => t0,
    });
    assert.deepEqual(calls, [[one.id, two.id]]);
    assert.equal(first[0]!.cached, undefined);
    const cacheRaw = JSON.parse(await readFile(join(dir, "limits-cache.json"), "utf8"));
    assert.ok(cacheRaw[one.id]);
    assert.equal(cacheRaw[two.id], undefined);

    // Within ttl: the ok entry is served cached (asOf = fetch time), the
    // failed one is refetched.
    calls = [];
    const second = await cachedAccountLimits([one, two], {
      ttlMs: 60 * 60 * 1000,
      fetchLimits: fetchLimits({ [two.id]: okLimits(two.id, 20, 5) }),
      now: () => t0 + 30 * 60 * 1000,
    });
    assert.deepEqual(calls, [[two.id]]);
    assert.equal(second[0]!.account, one.id);
    assert.equal(second[0]!.cached, true);
    assert.equal(second[0]!.asOf, new Date(t0).toISOString());
    assert.equal(second[1]!.cached, undefined);

    // Past ttl (now - ttl > fetchedAt): everything is fetched live again.
    calls = [];
    await cachedAccountLimits([one, two], {
      ttlMs: 60 * 60 * 1000,
      fetchLimits: fetchLimits({ [one.id]: okLimits(one.id, 41, 11), [two.id]: okLimits(two.id, 21, 6) }),
      now: () => t0 + 2 * 60 * 60 * 1000,
    });
    assert.deepEqual(calls, [[one.id, two.id]]);

    // No ttl → always live, but the cache still gets refreshed.
    calls = [];
    await cachedAccountLimits([one], {
      fetchLimits: fetchLimits({ [one.id]: okLimits(one.id, 42, 12) }),
      now: () => t0 + 2 * 60 * 60 * 1000 + 1000,
    });
    assert.deepEqual(calls, [[one.id]]);
  });
});

test("pickLeastLoadedAccount reuses cached limits inside the default 1h ttl", async () => {
  await withTempStore(async () => {
    const one = await addAccount("claude", "one@a.b");
    const two = await addAccount("claude", "two@a.b");
    const t0 = Date.parse("2026-06-10T12:00:00Z");
    let fetchCount = 0;
    const deps = (now: number) => ({
      hasCredentials: async () => true,
      fetchLimits: async (accounts: import("../src/accounts.js").AccountRecord[]) => {
        fetchCount += 1;
        return accounts.map((account) => okLimits(account.id, account.id === two.id ? 10 : 50, 5));
      },
      now: () => now,
    });

    const first = await pickLeastLoadedAccount("claude", deps(t0));
    assert.equal(first.account.id, two.id);
    assert.equal(fetchCount, 1);

    // Second pick 10 minutes later rides the cache.
    const second = await pickLeastLoadedAccount("claude", deps(t0 + 10 * 60 * 1000));
    assert.equal(second.account.id, two.id);
    assert.equal(second.limits?.cached, true);
    assert.equal(fetchCount, 1);

    // ttlMs 0 forces a live read.
    await pickLeastLoadedAccount("claude", { ...deps(t0 + 20 * 60 * 1000), ttlMs: 0 });
    assert.equal(fetchCount, 2);

    // Past the default 1h ttl the pick refetches on its own.
    await pickLeastLoadedAccount("claude", deps(t0 + 90 * 60 * 1000));
    assert.equal(fetchCount, 3);
  });
});
