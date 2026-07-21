import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountDir, type AccountRecord } from "../src/accounts.js";
import { storeRoot } from "../src/fsx.js";
import { accountLimits, type AccountLimits, type LimitsDeps } from "../src/limits.js";
import { appendUsageEvent } from "../src/usage.js";

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

test("dispatch: credential-less kimi/unknown/undefined providers degrade with NO 'undefined' in the message", async () => {
  await withTempStore(async () => {
    const kimi = account({ id: "kimi-x", tool: "kimi", provider: "moonshot" });
    const kimiOpencode = account({ id: "kfc-x", tool: "opencode", provider: "kimi-for-coding" });
    const unknown = account({ id: "weird-x", tool: "opencode", provider: "no-such-provider" });
    // Legacy opencode account whose provider never normalized (undefined).
    const legacy = { id: "legacy-x", tool: "opencode", label: "legacy", addedAt: "2026-06-10T00:00:00.000Z" } as AccountRecord;

    const results = await accountLimits([kimi, kimiOpencode, unknown, legacy], {
      httpGetJson: async () => {
        throw new Error("must not hit the network without a token");
      },
    });
    for (const result of results) {
      assert.equal(result.ok, false, `${result.account} unsupported`);
      assert.equal(result.source, "unsupported");
      assert.doesNotMatch(result.error ?? "", /undefined/, `${result.account} error must not print "undefined"`);
    }
    // The provider-less legacy account gets the dedicated message.
    const legacyResult = results.find((r) => r.account === "legacy-x")!;
    assert.equal(legacyResult.provider, undefined);
    assert.match(legacyResult.error ?? "", /account has no provider/);
    // Credential-less kimi accounts name their missing credential.
    const kimiResult = results.find((r) => r.account === "kimi-x")!;
    assert.match(kimiResult.error ?? "", /no moonshot credential/);
    const kfcResult = results.find((r) => r.account === "kfc-x")!;
    assert.match(kfcResult.error ?? "", /no kimi-for-coding credential/);
    // A provider with no registered adapter names itself.
    const unknownResult = results.find((r) => r.account === "weird-x")!;
    assert.match(unknownResult.error ?? "", /no-such-provider has no limits source/);
  });
});

// REAL captured kimi /usages response shape (ids redacted; counts are STRINGS).
const KIMI_FIXTURE = {
  user: { userId: "u-1", region: "REGION_OVERSEA", membership: { level: "LEVEL_ADVANCED" }, businessId: "" },
  usage: { limit: "100", used: "2", remaining: "98", resetTime: "2026-07-25T10:27:02.269470Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "1", remaining: "99", resetTime: "2026-07-20T12:27:02.269470Z" },
    },
  ],
  parallel: { limit: "30", details: [] },
  totalQuota: {},
  subType: "TYPE_PURCHASE",
};

// REAL captured cursor GetCurrentPeriodUsage response shape (cents; ms strings).
const CURSOR_FIXTURE = {
  billingCycleStart: "1782818048000",
  billingCycleEnd: "1785410048000",
  planUsage: {
    totalSpend: 1662,
    includedSpend: 1662,
    remaining: 38338,
    limit: 40000,
    autoPercentUsed: 0.009,
    apiPercentUsed: 3.288,
    totalPercentUsed: 0.6648,
  },
  spendLimitUsage: { individualLimit: 10000, individualRemaining: 10000, limitType: "user" },
  enabled: true,
};

/** Seed a kimi-code.json credential (kimi's own wire shape) into the vault. */
async function seedKimiCredential(acct: AccountRecord, credential: Record<string, unknown>): Promise<string> {
  const dir = join(accountDir(acct), "credentials");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "kimi-code.json");
  await writeFile(path, JSON.stringify(credential));
  return path;
}

// Far-future epoch-seconds expiry so tests never trip the refresh path by accident.
const KIMI_FRESH_EXPIRY = 4_000_000_000;

test("moonshot fetcher parses the real /usages fixture into 5h/weekly used%", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kimi-1", tool: "kimi", provider: "moonshot" });
    await seedKimiCredential(acct, { access_token: "tok-kimi", refresh_token: "r", expires_at: KIMI_FRESH_EXPIRY });

    const seen: { url: string; auth?: string }[] = [];
    const [result] = await accountLimits([acct], {
      httpGetJson: async (url, headers) => {
        seen.push({ url, auth: headers.Authorization });
        return KIMI_FIXTURE;
      },
    });

    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /api\.kimi\.com\/coding\/v1\/usages$/);
    assert.equal(seen[0]!.auth, "Bearer tok-kimi");

    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "moonshot");
    assert.equal(result!.source, "oauth-api");
    assert.equal(result!.plan, "advanced");
    // limits[] entry with duration 300 TIME_UNIT_MINUTE -> fiveHour: 1/100 used.
    assert.equal(result!.fiveHour?.usedPercent, 1);
    assert.equal(result!.fiveHour?.windowMinutes, 300);
    assert.equal(result!.fiveHour?.resetsAt, new Date("2026-07-20T12:27:02.269470Z").toISOString());
    // top-level usage (the weekly membership quota) -> weekly: 2/100 used.
    assert.equal(result!.weekly?.usedPercent, 2);
    assert.equal(result!.weekly?.windowMinutes, 10_080);
    assert.equal(result!.weekly?.resetsAt, new Date("2026-07-25T10:27:02.269470Z").toISOString());
  });
});

test("moonshot refreshes an expired token and persists the rotated credential", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kimi-refresh", tool: "kimi", provider: "moonshot" });
    const now = Date.parse("2026-07-20T10:00:00.000Z");
    const nowSeconds = Math.floor(now / 1000);
    const path = await seedKimiCredential(acct, {
      access_token: "tok-expired",
      refresh_token: "rt-old",
      expires_at: nowSeconds - 100,
      scope: "kimi-code",
      token_type: "Bearer",
    });

    const grants: Array<{ url: string; form: Record<string, string> }> = [];
    const reads: string[] = [];
    const [result] = await accountLimits([acct], {
      now: () => now,
      httpPostForm: async (url, _headers, form) => {
        grants.push({ url, form });
        return { access_token: "tok-new", refresh_token: "rt-new", expires_in: 900, scope: "kimi-code", token_type: "Bearer" };
      },
      httpGetJson: async (_url, headers) => {
        reads.push(headers.Authorization ?? "");
        return KIMI_FIXTURE;
      },
    });

    assert.equal(grants.length, 1);
    assert.match(grants[0]!.url, /auth\.kimi\.com\/api\/oauth\/token$/);
    assert.equal(grants[0]!.form.grant_type, "refresh_token");
    assert.equal(grants[0]!.form.refresh_token, "rt-old");
    assert.deepEqual(reads, ["Bearer tok-new"]);
    assert.equal(result!.ok, true);
    assert.equal(result!.fiveHour?.usedPercent, 1);

    // The ROTATED credential set is persisted — losing rt-new forces a re-login.
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.access_token, "tok-new");
    assert.equal(persisted.refresh_token, "rt-new");
    assert.equal(persisted.expires_at, nowSeconds + 900);
    assert.equal(persisted.scope, "kimi-code");
  });
});

test("moonshot skips a stale login-homes token and refreshes with the live one", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kimi-mirror", tool: "kimi", provider: "moonshot" });
    const now = Date.parse("2026-07-20T10:00:00.000Z");
    const nowSeconds = Math.floor(now / 1000);
    // login-homes advertises a FUTURE expiry but holds a long-rotated (dead)
    // refresh token; the vault holds the live one at a past expiry.
    const loginHome = join(storeRoot(), "login-homes", acct.id, "credentials", "kimi-code.json");
    await mkdir(join(storeRoot(), "login-homes", acct.id, "credentials"), { recursive: true });
    await writeFile(loginHome, JSON.stringify({ access_token: "tok-old", refresh_token: "rt-dead", expires_at: nowSeconds + 9999 }));
    const vault = await seedKimiCredential(acct, { access_token: "tok-old", refresh_token: "rt-live", expires_at: nowSeconds - 100 });

    const tried: string[] = [];
    const [result] = await accountLimits([acct], {
      now: () => now,
      httpPostForm: async (_url, _headers, form) => {
        tried.push(form.refresh_token!);
        if (form.refresh_token === "rt-dead") throw new Error("/api/oauth/token: HTTP 400");
        return { access_token: "tok-new", refresh_token: "rt-newer", expires_in: 900 };
      },
      httpGetJson: async (_url, headers) => {
        if (headers.Authorization !== "Bearer tok-new") throw new Error("/coding/v1/usages: HTTP 401");
        return KIMI_FIXTURE;
      },
    });

    // The dead token was attempted first (freshest expiry) then the live one.
    assert.deepEqual(tried, ["rt-dead", "rt-live"]);
    assert.equal(result!.ok, true);
    assert.equal(result!.fiveHour?.usedPercent, 1);
    // BOTH mirrors converge on the rotated credential — the stale one is healed.
    for (const path of [vault, loginHome]) {
      const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      assert.equal(persisted.access_token, "tok-new");
      assert.equal(persisted.refresh_token, "rt-newer");
    }
  });
});

test("moonshot retries the usages read once after a 401 by refreshing", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kimi-401", tool: "kimi", provider: "moonshot" });
    // Fresh by expiry, but revoked server-side: the first read 401s.
    await seedKimiCredential(acct, { access_token: "tok-revoked", refresh_token: "rt-old", expires_at: KIMI_FRESH_EXPIRY });

    let grants = 0;
    const reads: string[] = [];
    const [result] = await accountLimits([acct], {
      httpPostForm: async () => {
        grants += 1;
        return { access_token: "tok-new", refresh_token: "rt-new", expires_in: 900 };
      },
      httpGetJson: async (_url, headers) => {
        reads.push(headers.Authorization ?? "");
        if (headers.Authorization === "Bearer tok-revoked") throw new Error("/coding/v1/usages: HTTP 401");
        return KIMI_FIXTURE;
      },
    });

    assert.equal(grants, 1);
    assert.deepEqual(reads, ["Bearer tok-revoked", "Bearer tok-new"]);
    assert.equal(result!.ok, true);
    assert.equal(result!.fiveHour?.usedPercent, 1);
  });
});

test("moonshot with an expired token and a dead refresh token asks for a re-login", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kimi-dead", tool: "kimi", provider: "moonshot" });
    await seedKimiCredential(acct, { access_token: "tok-expired", refresh_token: "rt-dead", expires_at: 1 });
    const [result] = await accountLimits([acct], {
      httpPostForm: async () => {
        throw new Error("/api/oauth/token: HTTP 400");
      },
      httpGetJson: async () => {
        throw new Error("/coding/v1/usages: HTTP 401");
      },
    });
    assert.equal(result!.ok, false);
    assert.equal(result!.source, "unsupported");
    // Actionable, not a bare HTTP 401.
    assert.match(result!.error ?? "", /re-login with: hive login kimi-dead/);
    assert.doesNotMatch(result!.error ?? "", /^\/coding/);
  });
});

test("kimi-for-coding falls back to the opencode auth token", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kfc-1", tool: "opencode", provider: "kimi-for-coding" });
    await seedOpencodeAuth(acct, { "kimi-for-coding": { type: "oauth", access: "tok-kfc" } });

    const seen: string[] = [];
    const [result] = await accountLimits([acct], {
      httpGetJson: async (url, headers) => {
        seen.push(`${url}|${headers.Authorization}`);
        return KIMI_FIXTURE;
      },
    });
    assert.match(seen[0]!, /api\.kimi\.com\/coding\/v1\/usages\|Bearer tok-kfc/);
    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "kimi-for-coding");
    assert.equal(result!.fiveHour?.usedPercent, 1);
  });
});

test("cursor fetcher maps the monthly plan cycle into the weekly slot", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "cursor-1", tool: "cursor", provider: "cursor" });
    await mkdir(accountDir(acct), { recursive: true });
    await writeFile(join(accountDir(acct), "auth.json"), JSON.stringify({ accessToken: "tok-cursor", refreshToken: "r" }));

    const seen: { url: string; auth?: string; body: unknown }[] = [];
    const [result] = await accountLimits([acct], {
      httpPostJson: async (url, headers, body) => {
        seen.push({ url, auth: headers.Authorization, body });
        return CURSOR_FIXTURE;
      },
    });

    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /api2\.cursor\.sh\/aiserver\.v1\.DashboardService\/GetCurrentPeriodUsage$/);
    assert.equal(seen[0]!.auth, "Bearer tok-cursor");
    assert.deepEqual(seen[0]!.body, {});

    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "cursor");
    assert.equal(result!.source, "oauth-api");
    // 1662 cents spent of 40000 included -> 4.155% used of the billing cycle.
    assert.equal(result!.weekly?.usedPercent, (1662 / 40000) * 100);
    assert.equal(result!.weekly?.resetsAt, new Date(1785410048000).toISOString());
    // windowMinutes carries the TRUE cycle length (30 days), not 10080.
    assert.equal(result!.weekly?.windowMinutes, Math.round((1785410048000 - 1782818048000) / 60_000));
    assert.equal(result!.fiveHour, undefined);
  });
});

test("cursor with no vaulted auth.json degrades to unsupported (no network)", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "cursor-noauth", tool: "cursor", provider: "cursor" });
    const [result] = await accountLimits([acct], {
      httpPostJson: async () => {
        throw new Error("must not hit the network without a token");
      },
    });
    assert.equal(result!.ok, false);
    assert.equal(result!.source, "unsupported");
    assert.match(result!.error ?? "", /no cursor auth\.json/);
  });
});

// REAL captured xai billing response (unified-billing account; ids redacted).
const XAI_BILLING_FIXTURE = {
  config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-07-17T06:15:15.645808+00:00", end: "2026-07-24T06:15:15.645808+00:00" },
    creditUsagePercent: 3.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: "GrokBuild", usagePercent: 3.0 }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    billingPeriodStart: "2026-07-17T06:15:15.645808+00:00",
    billingPeriodEnd: "2026-07-24T06:15:15.645808+00:00",
  },
};

/** Seed a grok auth.json (grok's own "<issuer>::<client>" keyed shape) into the vault. */
async function seedGrokAuth(acct: AccountRecord, key: string): Promise<void> {
  await mkdir(accountDir(acct), { recursive: true });
  await writeFile(
    join(accountDir(acct), "auth.json"),
    JSON.stringify({ "https://auth.x.ai::client-1": { key, auth_mode: "oidc", expires_at: "2026-07-20T14:02:00.000Z" } }),
  );
}

test("xai fetcher parses the real billing?format=credits fixture into the weekly window", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "grok-live", tool: "grok", provider: "xai" });
    await seedGrokAuth(acct, "tok-grok");

    const seen: { url: string; auth?: string }[] = [];
    const [result] = await accountLimits([acct], {
      httpGetJson: async (url, headers) => {
        seen.push({ url, auth: headers.Authorization });
        return XAI_BILLING_FIXTURE;
      },
    });

    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /cli-chat-proxy\.grok\.com\/v1\/billing\?format=credits$/);
    assert.equal(seen[0]!.auth, "Bearer tok-grok");

    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "xai");
    assert.equal(result!.source, "oauth-api");
    assert.equal(result!.weekly?.usedPercent, 3);
    assert.equal(result!.weekly?.resetsAt, new Date("2026-07-24T06:15:15.645808+00:00").toISOString());
    assert.equal(result!.weekly?.windowMinutes, 10_080);
    assert.equal(result!.fiveHour, undefined);
  });
});

test("xai fetcher derives used% from legacy monthlyLimit/used credits", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "grok-legacy", tool: "grok", provider: "xai" });
    await seedGrokAuth(acct, "tok-grok");
    const [result] = await accountLimits([acct], {
      httpGetJson: async () => ({
        config: {
          monthlyLimit: { val: 150000 },
          used: { val: 2382 },
          billingPeriodStart: "2026-07-01T00:00:00+00:00",
          billingPeriodEnd: "2026-08-01T00:00:00+00:00",
        },
      }),
    });
    assert.equal(result!.ok, true);
    assert.equal(result!.source, "oauth-api");
    assert.equal(result!.weekly?.usedPercent, (2382 / 150000) * 100);
    // windowMinutes carries the TRUE cycle length (the July billing month).
    assert.equal(result!.weekly?.windowMinutes, 31 * 24 * 60);
  });
});

test("xai fetcher falls back to session facts when the billing read throws", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "grok-stale", tool: "grok", provider: "xai" });
    await seedGrokAuth(acct, "tok-expired");
    const now = Date.parse("2026-07-20T10:00:00.000Z");
    await appendUsageEvent({
      ts: "2026-07-20T09:50:00.000Z",
      kind: "exhausted",
      account: acct.id,
      bee: "bee-1",
      agent: "grok",
    });
    const [result] = await accountLimits([acct], {
      httpGetJson: async () => {
        throw new Error("/v1/billing: HTTP 401");
      },
      now: () => now,
    });
    assert.equal(result!.ok, true);
    assert.equal(result!.source, "session-snapshot");
    assert.equal(result!.fiveHour?.usedPercent, 100);
  });
});

test("xai limits: a recent exhaustion fact reads 100% used with the reset hint", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "grok-1", tool: "grok", provider: "xai" });
    const now = Date.parse("2026-07-20T10:00:00.000Z");
    await appendUsageEvent({
      ts: "2026-07-20T09:50:00.000Z",
      kind: "exhausted",
      account: acct.id,
      bee: "bee-1",
      agent: "grok",
      resetHint: "2026-07-20T14:00:00.000Z",
    });

    const [result] = await accountLimits([acct], { now: () => now });
    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "xai");
    assert.equal(result!.source, "session-snapshot");
    assert.equal(result!.asOf, "2026-07-20T09:50:00.000Z");
    assert.equal(result!.fiveHour?.usedPercent, 100);
    assert.equal(result!.fiveHour?.resetsAt, "2026-07-20T14:00:00.000Z");
  });
});

test("xai limits: samples without a recent exhaustion produce an ok row with empty windows", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "grok-2", tool: "grok", provider: "xai" });
    const now = Date.parse("2026-07-20T10:00:00.000Z");
    await appendUsageEvent({
      ts: "2026-07-19T10:00:00.000Z",
      kind: "sample",
      account: acct.id,
      bee: "bee-1",
      agent: "grok",
      inputTokens: 1000,
      outputTokens: 200,
    });

    const [result] = await accountLimits([acct], { now: () => now });
    assert.equal(result!.ok, true);
    assert.equal(result!.source, "session-snapshot");
    assert.equal(result!.asOf, "2026-07-19T10:00:00.000Z");
    assert.equal(result!.fiveHour, undefined);
    assert.equal(result!.weekly, undefined);
  });
});

test("xai limits: no usage facts at all degrades gracefully", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "grok-3", tool: "grok", provider: "xai" });
    const [result] = await accountLimits([acct], {});
    assert.equal(result!.ok, false);
    assert.equal(result!.source, "session-snapshot");
    assert.match(result!.error ?? "", /no session usage facts yet/);
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
