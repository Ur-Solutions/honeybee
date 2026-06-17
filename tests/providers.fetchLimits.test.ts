import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountDir, type AccountRecord } from "../src/accounts.js";
import { accountLimits, type AccountLimits, type LimitsDeps } from "../src/limits.js";

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const oldKeychain = process.env.HIVE_NO_KEYCHAIN;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-s3-"));
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

function account(overrides: Partial<AccountRecord> & Pick<AccountRecord, "id" | "tool" | "provider">): AccountRecord {
  return { label: overrides.id, addedAt: "2026-06-10T00:00:00.000Z", ...overrides } as AccountRecord;
}

/** Drop the credential file into the account's vault mirror so the fetcher finds the token. */
async function seedOpencodeAuth(acct: AccountRecord, auth: Record<string, unknown>): Promise<void> {
  const dir = join(accountDir(acct), "xdg-data", "opencode");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify(auth));
}

// REAL captured z.ai response shape (token redacted in fixture; percentage is USED%).
const ZAI_FIXTURE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 0, remaining: 4000, percentage: 0, nextResetTime: 1781889695981, usageDetails: [] },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1781613343588 },
    ],
    level: "max",
  },
  success: true,
};

// REAL captured minimax response shape; percentages here are REMAINING.
const MINIMAX_FIXTURE = {
  model_remains: [
    {
      start_time: 1781586000000,
      end_time: 1781604000000,
      remains_time: 7932739,
      current_interval_total_count: 200,
      current_interval_usage_count: 50,
      model_name: "general",
      current_weekly_total_count: 1000,
      current_weekly_usage_count: 100,
      weekly_start_time: 1781481600000,
      weekly_end_time: 1782086400000,
      weekly_remains_time: 490332739,
      current_interval_status: 1,
      current_interval_remaining_percent: 0.75,
    },
  ],
};

test("zai fetcher parses the real fixture into 5h/weekly used% + resetsAt", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "zai-1", tool: "opencode", provider: "zai-coding-plan" });
    await seedOpencodeAuth(acct, { "zai-coding-plan": { type: "api", key: "tok-zai" } });

    const seen: { url: string; auth?: string }[] = [];
    const deps: LimitsDeps = {
      httpGetJson: async (url, headers) => {
        seen.push({ url, auth: headers.Authorization });
        return ZAI_FIXTURE;
      },
    };
    const [result] = await accountLimits([acct], deps);

    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /api\.z\.ai\/api\/monitor\/usage\/quota\/limit$/);
    assert.equal(seen[0]!.auth, "Bearer tok-zai");

    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "zai-coding-plan");
    assert.equal(result!.tool, "opencode");
    assert.equal(result!.source, "oauth-api");
    assert.equal(result!.plan, "max");
    // TOKENS_LIMIT (the rolling token cycle) -> fiveHour; percentage is USED%.
    assert.equal(result!.fiveHour?.usedPercent, 1);
    assert.equal(result!.fiveHour?.windowMinutes, 300);
    assert.equal(result!.fiveHour?.resetsAt, new Date(1781613343588).toISOString());
    // TIME_LIMIT is the separate MCP web-tools budget — NOT surfaced as a token
    // weekly window (that would mislabel tool-call usage as token usage).
    assert.equal(result!.weekly, undefined);
  });
});

test("minimax fetcher parses the real fixture and inverts remaining -> used%", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "mm-1", tool: "opencode", provider: "minimax-coding-plan" });
    await seedOpencodeAuth(acct, { "minimax-coding-plan": { type: "api", key: "tok-mm" } });

    const seen: string[] = [];
    const deps: LimitsDeps = {
      httpGetJson: async (url, headers) => {
        seen.push(`${url}|${headers.Authorization}`);
        return MINIMAX_FIXTURE;
      },
    };
    const [result] = await accountLimits([acct], deps);

    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /api\.minimax\.io\/v1\/token_plan\/remains\|Bearer tok-mm/);

    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "minimax-coding-plan");
    assert.equal(result!.source, "oauth-api");
    // 5h: usage 50 / total 200 -> 25% used.
    assert.equal(result!.fiveHour?.usedPercent, 25);
    assert.equal(result!.fiveHour?.windowMinutes, 300);
    assert.equal(result!.fiveHour?.resetsAt, new Date(1781604000000).toISOString());
    // weekly: usage 100 / total 1000 -> 10% used.
    assert.equal(result!.weekly?.usedPercent, 10);
    assert.equal(result!.weekly?.windowMinutes, 10_080);
    assert.equal(result!.weekly?.resetsAt, new Date(1782086400000).toISOString());
  });
});

test("minimax falls back to inverting remaining_percent when counts are absent", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "mm-2", tool: "opencode", provider: "minimax-coding-plan" });
    await seedOpencodeAuth(acct, { "minimax-coding-plan": { type: "api", key: "tok-mm" } });
    const deps: LimitsDeps = {
      httpGetJson: async () => ({
        model_remains: [
          { current_interval_remaining_percent: 0.75, end_time: 1781604000000, weekly_end_time: 1782086400000 },
        ],
      }),
    };
    const [result] = await accountLimits([acct], deps);
    // 0.75 remaining (fraction) -> 25% used.
    assert.equal(result!.fiveHour?.usedPercent, 25);
  });
});

test("dispatch: zai/minimax with no vaulted token degrade to unsupported (no network)", async () => {
  await withTempStore(async () => {
    const zai = account({ id: "zai-noauth", tool: "opencode", provider: "zai-coding-plan" });
    const mm = account({ id: "mm-noauth", tool: "opencode", provider: "minimax-coding-plan" });
    const deps: LimitsDeps = {
      httpGetJson: async () => {
        throw new Error("must not hit the network without a token");
      },
    };
    const results = await accountLimits([zai, mm], deps);
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.source, "unsupported");
      assert.match(result.error ?? "", /no .* token in opencode auth\.json/);
    }
  });
});

test("dispatch routes anthropic->claudeLimits and openai->codexLimits by provider", async () => {
  await withTempStore(async () => {
    const claudeAcct = account({ id: "claude-x", tool: "claude", provider: "anthropic", label: "x@a.b", email: "x@a.b" });
    await mkdir(accountDir(claudeAcct), { recursive: true });
    await writeFile(
      join(accountDir(claudeAcct), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-claude", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } }),
    );

    let claudeAsked = 0;
    const [claudeResult] = await accountLimits([claudeAcct], {
      fetchClaudeUsage: async () => {
        claudeAsked += 1;
        return { five_hour: { utilization: 12, resets_at: "2026-06-10T09:30:00Z" } };
      },
      fetchClaudeProfileEmail: async () => "x@a.b",
      readKeychain: async () => null,
    });
    assert.equal(claudeAsked, 1);
    assert.equal(claudeResult!.ok, true);
    assert.equal(claudeResult!.source, "oauth-api");
    assert.equal(claudeResult!.provider, "anthropic");
    assert.equal(claudeResult!.fiveHour?.usedPercent, 12);

    // openai with no homes -> codexLimits' graceful session-snapshot failure.
    const codexAcct = account({ id: "codex-x", tool: "codex", provider: "openai", label: "y@a.b", email: "y@a.b" });
    const [codexResult] = await accountLimits([codexAcct], { codexLiveRateLimits: async () => null });
    assert.equal(codexResult!.ok, false);
    assert.equal(codexResult!.source, "session-snapshot");
    assert.equal(codexResult!.provider, "openai");
  });
});

test("dispatch: kimi/unknown/undefined providers -> unsupported with NO 'undefined' in the message", async () => {
  await withTempStore(async () => {
    const kimi = account({ id: "kimi-x", tool: "kimi", provider: "moonshot" });
    const kimiOpencode = account({ id: "kfc-x", tool: "opencode", provider: "kimi-for-coding" });
    const unknown = account({ id: "weird-x", tool: "opencode", provider: "no-such-provider" });
    // Legacy opencode account whose provider never normalized (undefined).
    const legacy = { id: "legacy-x", tool: "opencode", label: "legacy", addedAt: "2026-06-10T00:00:00.000Z" } as AccountRecord;

    const results = await accountLimits([kimi, kimiOpencode, unknown, legacy]);
    for (const result of results) {
      assert.equal(result.ok, false, `${result.account} unsupported`);
      assert.equal(result.source, "unsupported");
      assert.doesNotMatch(result.error ?? "", /undefined/, `${result.account} error must not print "undefined"`);
    }
    // The provider-less legacy account gets the dedicated message.
    const legacyResult = results.find((r) => r.account === "legacy-x")!;
    assert.equal(legacyResult.provider, undefined);
    assert.match(legacyResult.error ?? "", /account has no provider/);
    // A known-but-unsupported provider names itself.
    const kimiResult = results.find((r) => r.account === "kimi-x")!;
    assert.match(kimiResult.error ?? "", /moonshot has no limits source/);
  });
});

test("claude limits are snapshot-equal pre/post the provider refactor (ignoring additive provider)", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "claude-snap", tool: "claude", provider: "anthropic", label: "s@a.b", email: "s@a.b" });
    await mkdir(accountDir(acct), { recursive: true });
    await writeFile(
      join(accountDir(acct), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } }),
    );
    const [result] = await accountLimits([acct], {
      fetchClaudeUsage: async () => ({
        five_hour: { utilization: 87.5, resets_at: "2026-06-10T09:30:00Z" },
        seven_day: { utilization: 40, resets_at: "2026-06-16T17:00:00Z" },
      }),
      fetchClaudeProfileEmail: async () => "s@a.b",
      readKeychain: async () => null,
    });
    // The additive `provider` field is the ONLY new key; the load-bearing
    // shape is byte-identical to the pre-refactor claude output.
    assert.equal(result!.provider, "anthropic");
    const { provider, ...legacyShape } = result as AccountLimits;
    assert.deepEqual(legacyShape, {
      account: "claude-snap",
      tool: "claude",
      ok: true,
      source: "oauth-api",
      plan: "max",
      fiveHour: { usedPercent: 87.5, windowMinutes: 300, resetsAt: "2026-06-10T09:30:00Z" },
      weekly: { usedPercent: 40, windowMinutes: 10_080, resetsAt: "2026-06-16T17:00:00Z" },
    });
  });
});
