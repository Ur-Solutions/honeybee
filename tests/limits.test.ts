import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { addAccount, accountDir, setAccountPaused } from "../src/accounts.js";
import { AUTO_COMMITMENT_BUSY_PERCENT, AUTO_COMMITMENT_PARKED_PERCENT, AUTO_PICK_DEBIT_PERCENT, AUTO_PICK_DEBIT_TTL_MS, CLAUDE_PROFILE_EMAIL_CACHE_MAX, accountCommitments, accountLimits, cachedAccountLimits, decayedPickDebit, effectiveWindowLoad, emailFromJwt, lastRateLimitsInFile, paceDelta, pendingPickDebits, pendingPicksPath, pickLeastLoadedAccount, recordAutoPick, selectLeastLoadedAccount, sessionCommitmentPercent, sortAccountsForLimitsDisplay, windowRolledOver } from "../src/limits.js";

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
      withAccountLock: async (fn) => {
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
      withAccountLock: async (fn) => {
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
      withAccountLock: async (fn) => {
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

test("pickLeastLoadedAccount excludes paused accounts unless includePaused", async () => {
  await withTempStore(async () => {
    const one = await addAccount("claude", "one@a.b");
    const two = await addAccount("claude", "two@a.b");
    await setAccountPaused(two.id, true);

    // `two` is out of the pool: `one` wins as the lone candidate, no limits fetch.
    const choice = await pickLeastLoadedAccount("claude", {
      hasCredentials: async () => true,
      fetchLimits: async () => {
        throw new Error("should not fetch limits for a lone candidate");
      },
    });
    assert.equal(choice.account.id, one.id);

    // includePaused puts `two` back in the pool — and it wins on lower usage.
    const inclusive = await pickLeastLoadedAccount("claude", {
      includePaused: true,
      hasCredentials: async () => true,
      fetchLimits: async () => [okLimits(one.id, 70, 10), okLimits(two.id, 30, 10)],
      now: () => Date.parse("2026-06-10T12:00:00Z"),
    });
    assert.equal(inclusive.account.id, two.id);

    // Everything paused: a dedicated error, distinct from the no-creds one.
    await setAccountPaused(one.id, true);
    await assert.rejects(() => pickLeastLoadedAccount("claude"), /Every claude account is paused/);
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

test("cachedAccountLimits serves the last snapshot on a rate-limited live read", async () => {
  await withTempStore(async () => {
    const one = await addAccount("claude", "rl@a.b");
    const t0 = Date.parse("2026-06-10T12:00:00Z");

    // Warm the cache with a good live read.
    await cachedAccountLimits([one], {
      fetchLimits: async () => [okLimits(one.id, 40, 10)],
      now: () => t0,
    });

    // A 429 later serves the stale snapshot, flagged cached + rateLimited so
    // pollers still see the push-back signal and back off.
    const rateLimited: import("../src/limits.js").AccountLimits = {
      account: one.id, tool: "claude", ok: false, source: "oauth-api", error: "/api/oauth/usage: HTTP 429",
    };
    const [served] = await cachedAccountLimits([one], {
      fetchLimits: async () => [rateLimited],
      now: () => t0 + 10 * 60 * 1000,
    });
    assert.equal(served!.ok, true);
    assert.equal(served!.cached, true);
    assert.equal(served!.rateLimited, true);
    assert.equal(served!.asOf, new Date(t0).toISOString());
    assert.equal(served!.fiveHour?.usedPercent, 10);
    assert.equal(served!.weekly?.usedPercent, 40);

    // A non-rate-limit failure still surfaces as an error row.
    const broken: import("../src/limits.js").AccountLimits = {
      account: one.id, tool: "claude", ok: false, source: "oauth-api", error: "HTTP 401",
    };
    const [error] = await cachedAccountLimits([one], {
      fetchLimits: async () => [broken],
      now: () => t0 + 11 * 60 * 1000,
    });
    assert.equal(error!.ok, false);
    assert.equal(error!.rateLimited, undefined);

    // A 429 with no cache entry keeps the error row but stamps the signal.
    const other = await addAccount("claude", "rl2@a.b");
    const [bare] = await cachedAccountLimits([other], {
      fetchLimits: async () => [{ ...rateLimited, account: other.id }],
      now: () => t0 + 12 * 60 * 1000,
    });
    assert.equal(bare!.ok, false);
    assert.equal(bare!.rateLimited, true);
  });
});

test("pickLeastLoadedAccount reuses cached limits inside the default 1h ttl, re-reading a picked account after its grace", async () => {
  await withTempStore(async () => {
    const one = await addAccount("claude", "one@a.b");
    const two = await addAccount("claude", "two@a.b");
    const t0 = Date.parse("2026-06-10T12:00:00Z");
    const fetched: string[][] = [];
    const deps = (now: number) => ({
      hasCredentials: async () => true,
      fetchLimits: async (accounts: import("../src/accounts.js").AccountRecord[]) => {
        fetched.push(accounts.map((account) => account.id));
        return accounts.map((account) => okLimits(account.id, account.id === two.id ? 10 : 50, 5));
      },
      now: () => now,
    });

    const first = await pickLeastLoadedAccount("claude", deps(t0));
    assert.equal(first.account.id, two.id);
    assert.equal(fetched.length, 1);

    // A pick 2 minutes later rides the cache entirely: the picked account
    // keeps PICKED_ENTRY_GRACE_MS of freshness, so spawn bursts stay cheap.
    const second = await pickLeastLoadedAccount("claude", deps(t0 + 2 * 60 * 1000));
    assert.equal(second.account.id, two.id);
    assert.equal(second.limits?.cached, true);
    assert.equal(fetched.length, 1);

    // Past the grace, ONLY the picked (aged) account re-reads live; the
    // untouched account still rides the cache (HIVE-80 pick bookkeeping).
    const third = await pickLeastLoadedAccount("claude", deps(t0 + 10 * 60 * 1000));
    assert.equal(third.account.id, two.id);
    assert.equal(fetched.length, 2);
    assert.deepEqual(fetched[1], [two.id]);

    // ttlMs 0 forces a live read of everything.
    await pickLeastLoadedAccount("claude", { ...deps(t0 + 20 * 60 * 1000), ttlMs: 0 });
    assert.equal(fetched.length, 3);
    assert.deepEqual(fetched[2], [one.id, two.id]);

    // Past the default 1h ttl the pick refetches on its own.
    await pickLeastLoadedAccount("claude", deps(t0 + 90 * 60 * 1000));
    assert.equal(fetched.length, 4);
  });
});

test("lastRateLimitsInFile tail-reads huge rollout files instead of slurping them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-rl-tail-"));
  try {
    const row = (ts: string, used: number) =>
      JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: { type: "token_count", rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1781037177 }, plan_type: "pro" } },
      });
    const filler = `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(1024) } })}\n`;

    // The latest rate_limits row sits in the final tail of a multi-MB file.
    const tailHit = join(dir, "tail-hit.jsonl");
    await writeFile(tailHit, `${row("2026-07-01T10:00:00Z", 5)}\n${filler.repeat(2048)}${row("2026-07-01T11:00:00Z", 12)}\n`);
    const snapshot = await lastRateLimitsInFile(tailHit);
    assert.equal(snapshot?.ts, "2026-07-01T11:00:00Z");
    assert.equal(snapshot?.limits.primary?.used_percent, 12);

    // A rate_limits row buried before the tail window is deliberately out of
    // reach — the walk is capped, not exhaustive (HIVE-64).
    const tailMiss = join(dir, "tail-miss.jsonl");
    await writeFile(tailMiss, `${row("2026-07-01T10:00:00Z", 5)}\n${filler.repeat(2048)}`);
    assert.equal(await lastRateLimitsInFile(tailMiss), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("codex snapshot fallback reads the newest date partitions, not the whole sessions tree", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "part@a.b");
    const sessions = join(dir, "homes", account.id, "sessions");
    const row = (ts: string, used: number) =>
      JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: { type: "token_count", rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1781037177 }, plan_type: "pro" } },
      });
    // An old partition holds a stale snapshot; the newest partition holds the
    // current one. Descending date order must surface the newest partition's
    // rollout first even though both are on disk.
    await mkdir(join(sessions, "2026", "06", "20"), { recursive: true });
    const oldRollout = join(sessions, "2026", "06", "20", "rollout-old.jsonl");
    await writeFile(oldRollout, `${row("2026-06-20T09:00:00Z", 50)}\n`);
    await utimes(oldRollout, new Date("2026-06-20T09:00:00Z"), new Date("2026-06-20T09:00:00Z"));
    await mkdir(join(sessions, "2026", "07", "03"), { recursive: true });
    await writeFile(join(sessions, "2026", "07", "03", "rollout-new.jsonl"), `${row("2026-07-03T09:00:00Z", 77)}\n`);

    const [result] = await accountLimits([account], { codexLiveRateLimits: async () => null });
    assert.equal(result!.ok, true);
    assert.equal(result!.source, "session-snapshot");
    assert.equal(result!.asOf, "2026-07-03T09:00:00Z");
    assert.equal(result!.fiveHour?.usedPercent, 77);
  });
});

/* ------------------------------------------------------------------ */
/* HIVE-80 — commitments, pick debits, near-tie rotation               */
/* ------------------------------------------------------------------ */

function liveSession(name: string, accountId: string, state: string, agent = "claude"): import("../src/store.js").SessionRecord {
  return {
    name,
    agent,
    cwd: "/tmp",
    command: agent,
    tmuxTarget: name,
    createdAt: "2026-06-10T10:00:00Z",
    updatedAt: "2026-06-10T10:00:00Z",
    status: "running",
    accountId,
    lastObservedState: state,
  };
}

test("sessionCommitmentPercent weighs busy over parked and ignores dead/unbound sessions", () => {
  assert.equal(sessionCommitmentPercent(liveSession("s1", "a", "active")), AUTO_COMMITMENT_BUSY_PERCENT);
  assert.equal(sessionCommitmentPercent(liveSession("s2", "a", "working")), AUTO_COMMITMENT_BUSY_PERCENT);
  assert.equal(sessionCommitmentPercent(liveSession("s3", "a", "ready")), AUTO_COMMITMENT_PARKED_PERCENT);
  assert.equal(sessionCommitmentPercent({ ...liveSession("s4", "a", "active"), status: "dead" }), 0);
  assert.equal(sessionCommitmentPercent({ ...liveSession("s5", "a", "active"), accountId: undefined }), 0);
});

test("accountCommitments sums per account and filters by tool", async () => {
  const sessions = [
    liveSession("s1", "a", "active"),
    liveSession("s2", "a", "working"),
    liveSession("s3", "a", "ready"),
    liveSession("s4", "b", "active"),
    liveSession("s5", "b", "active", "codex"),
    { ...liveSession("s6", "b", "active"), status: "dead" as const },
  ];
  const claude = await accountCommitments("claude", sessions);
  assert.equal(claude.get("a"), 2 * AUTO_COMMITMENT_BUSY_PERCENT + AUTO_COMMITMENT_PARKED_PERCENT);
  assert.equal(claude.get("b"), AUTO_COMMITMENT_BUSY_PERCENT);
  const codex = await accountCommitments("codex", sessions);
  assert.equal(codex.get("b"), AUTO_COMMITMENT_BUSY_PERCENT);
  assert.equal(codex.get("a"), undefined);
});

test("decayedPickDebit decays linearly and treats clock skew as fresh", () => {
  const t0 = Date.parse("2026-06-10T12:00:00Z");
  const pick = { at: "2026-06-10T12:00:00Z", percent: AUTO_PICK_DEBIT_PERCENT };
  assert.equal(decayedPickDebit(pick, t0), AUTO_PICK_DEBIT_PERCENT);
  assert.equal(decayedPickDebit(pick, t0 + AUTO_PICK_DEBIT_TTL_MS / 2), AUTO_PICK_DEBIT_PERCENT / 2);
  assert.equal(decayedPickDebit(pick, t0 + AUTO_PICK_DEBIT_TTL_MS), 0);
  assert.equal(decayedPickDebit({ ...pick, at: "garbage" }, t0), AUTO_PICK_DEBIT_PERCENT);
  assert.equal(decayedPickDebit({ ...pick, at: "2026-06-10T13:00:00Z" }, t0), AUTO_PICK_DEBIT_PERCENT);
});

test("recordAutoPick accumulates decaying debits and prunes expired ones", async () => {
  await withTempStore(async () => {
    const t0 = Date.parse("2026-06-10T12:00:00Z");
    await recordAutoPick("a", t0);
    await recordAutoPick("a", t0);
    await recordAutoPick("b", t0);
    const fresh = await pendingPickDebits(t0);
    assert.equal(fresh.get("a"), 2 * AUTO_PICK_DEBIT_PERCENT);
    assert.equal(fresh.get("b"), AUTO_PICK_DEBIT_PERCENT);
    // Fully decayed debits read as absent...
    const later = await pendingPickDebits(t0 + AUTO_PICK_DEBIT_TTL_MS);
    assert.equal(later.size, 0);
    // ...and are pruned from the file by the next write.
    await recordAutoPick("c", t0 + AUTO_PICK_DEBIT_TTL_MS);
    const raw = JSON.parse(await readFile(pendingPicksPath(), "utf8")) as Record<string, unknown[]>;
    assert.deepEqual(Object.keys(raw), ["c"]);
  });
});

test("selectLeastLoadedAccount applies commitments to the score and reports near-ties", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // b is emptier on provider numbers, but carries two busy bees.
  const steered = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits("a", 20, 10) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits("b", 10, 10), commitment: 2 * AUTO_COMMITMENT_BUSY_PERCENT },
    ],
    now,
  );
  assert.equal(steered?.account.id, "a");
  // The winner's own commitment is named in the reason.
  const committed = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits("a", 50, 10) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits("b", 10, 10), commitment: 5 },
    ],
    now,
  );
  assert.equal(committed?.account.id, "b");
  assert.match(committed?.reason ?? "", /\+5 in-flight/);
  // Equal effective loads are a near-tie group, winner first.
  const tied = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits("a", 10, 10) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits("b", 10, 10) },
      { account: pickAccount("c", "2026-01-03"), limits: okLimits("c", 40, 10) },
    ],
    now,
  );
  assert.deepEqual(tied?.nearTieIds, ["a", "b"]);
});

test("pickLeastLoadedAccount spreads a same-instant burst instead of stacking one account (HIVE-80)", async () => {
  await withTempStore(async () => {
    const a = await addAccount("claude", "a@a.b");
    const b = await addAccount("claude", "b@a.b");
    const c = await addAccount("claude", "c@a.b");
    const t0 = Date.parse("2026-06-10T12:00:00Z");
    const deps = {
      hasCredentials: async () => true,
      fetchLimits: async (accounts: import("../src/accounts.js").AccountRecord[]) =>
        accounts.map((account) => okLimits(account.id, 10, 10)),
      now: () => t0,
    };
    // Four sequential picks with identical provider numbers and an identical
    // clock — exactly the burst that used to stack all four on one account.
    const picks: string[] = [];
    for (let i = 0; i < 4; i += 1) picks.push((await pickLeastLoadedAccount("claude", deps)).account.id);
    assert.equal(new Set(picks.slice(0, 3)).size, 3, `first three picks should spread, got ${picks.join(",")}`);
    assert.equal(new Set(picks).size, 3, `four picks over three accounts should reuse only one, got ${picks.join(",")}`);
    assert.ok([a.id, b.id, c.id].every((id) => picks.includes(id)));
  });
});

test("pickLeastLoadedAccount steers around an account with live bees", async () => {
  await withTempStore(async () => {
    const busy = await addAccount("claude", "busy@a.b");
    const quiet = await addAccount("claude", "quiet@a.b");
    const t0 = Date.parse("2026-06-10T12:00:00Z");
    const choice = await pickLeastLoadedAccount("claude", {
      hasCredentials: async () => true,
      // busy is emptier on provider numbers (10 vs 20) but hosts two workers.
      fetchLimits: async (accounts: import("../src/accounts.js").AccountRecord[]) =>
        accounts.map((account) => okLimits(account.id, account.id === busy.id ? 10 : 20, 10)),
      now: () => t0,
      sessions: [liveSession("w1", busy.id, "active"), liveSession("w2", busy.id, "working")],
    });
    assert.equal(choice.account.id, quiet.id);
  });
});
