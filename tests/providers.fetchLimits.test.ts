import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("dispatch: credential-less/unknown/undefined providers -> unsupported with NO 'undefined' in the message", async () => {
  await withTempStore(async () => {
    const kimi = account({ id: "kimi-x", tool: "kimi", provider: "moonshot" });
    const kimiOpencode = account({ id: "kfc-x", tool: "opencode", provider: "kimi-for-coding" });
    const grok = account({ id: "grok-x", tool: "grok", provider: "xai" });
    const cursor = account({ id: "cursor-x", tool: "cursor", provider: "cursor" });
    const unknown = account({ id: "weird-x", tool: "opencode", provider: "no-such-provider" });
    // Legacy opencode account whose provider never normalized (undefined).
    const legacy = { id: "legacy-x", tool: "opencode", label: "legacy", addedAt: "2026-06-10T00:00:00.000Z" } as AccountRecord;

    const deps: LimitsDeps = {
      httpGetJson: async () => {
        throw new Error("must not hit the network without credentials");
      },
      httpPostJson: async () => {
        throw new Error("must not hit the network without credentials");
      },
    };
    const results = await accountLimits([kimi, kimiOpencode, grok, cursor, unknown, legacy], deps);
    for (const result of results) {
      assert.equal(result.ok, false, `${result.account} unsupported`);
      assert.equal(result.source, "unsupported");
      assert.doesNotMatch(result.error ?? "", /undefined/, `${result.account} error must not print "undefined"`);
    }
    // The provider-less legacy account gets the dedicated message.
    const legacyResult = results.find((r) => r.account === "legacy-x")!;
    assert.equal(legacyResult.provider, undefined);
    assert.match(legacyResult.error ?? "", /account has no provider/);
    // Fetcher-backed providers with nothing vaulted name what's missing.
    assert.match(results.find((r) => r.account === "kimi-x")!.error ?? "", /no kimi-code credentials/);
    assert.match(results.find((r) => r.account === "kfc-x")!.error ?? "", /no kimi-for-coding token in opencode auth\.json/);
    assert.match(results.find((r) => r.account === "grok-x")!.error ?? "", /no grok auth\.json/);
    assert.match(results.find((r) => r.account === "cursor-x")!.error ?? "", /no cursor auth\.json/);
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

/* ------------------------------------------------------------------ */
/* grok / cursor / kimi fetchers (endpoints verified live 2026-07-08)  */
/* ------------------------------------------------------------------ */

function jwt(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
}

async function seedVaultFile(acct: AccountRecord, relPath: string, content: string): Promise<void> {
  const path = join(accountDir(acct), relPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// REAL captured /v1/billing response shape (grok CLI billing extension).
// proto3-JSON omits zero-valued fields, so `used` may be absent entirely.
const GROK_BILLING_FIXTURE = {
  config: {
    monthlyLimit: { val: 150_000 },
    used: { val: 37_500 },
    onDemandCap: { val: 0 },
    billingPeriodStart: "2026-07-01T00:00:00+00:00",
    billingPeriodEnd: "2026-08-01T00:00:00+00:00",
    history: [],
  },
};

test("grok fetcher reads the CLI auth.json and maps the monthly credit budget", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "grok-1", tool: "grok", provider: "xai" });
    await seedVaultFile(
      acct,
      "auth.json",
      JSON.stringify({
        "https://auth.x.ai::client-1": { key: "tok-grok", auth_mode: "oidc", expires_at: "2099-01-01T00:00:00.000Z", refresh_token: "r1" },
      }),
    );

    const seen: { url: string; auth?: string }[] = [];
    const deps: LimitsDeps = {
      httpGetJson: async (url, headers) => {
        seen.push({ url, auth: headers.Authorization });
        return GROK_BILLING_FIXTURE;
      },
    };
    const [result] = await accountLimits([acct], deps);

    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /cli-chat-proxy\.grok\.com\/v1\/billing$/);
    assert.equal(seen[0]!.auth, "Bearer tok-grok");

    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "xai");
    assert.equal(result!.source, "oauth-api");
    // Monthly budget rides the coarse-window slot: 37500/150000 -> 25% used,
    // windowMinutes covering the real July period so pace math stays honest.
    assert.equal(result!.weekly?.usedPercent, 25);
    assert.equal(result!.weekly?.resetsAt, new Date("2026-08-01T00:00:00+00:00").toISOString());
    assert.equal(result!.weekly?.windowMinutes, 31 * 24 * 60);
    assert.equal(result!.fiveHour, undefined);
  });
});

test("grok fetcher defaults an omitted `used` to 0 and fails on an expired token without network", async () => {
  await withTempStore(async () => {
    const fresh = account({ id: "grok-2", tool: "grok", provider: "xai" });
    await seedVaultFile(
      fresh,
      "auth.json",
      JSON.stringify({ "https://auth.x.ai::c": { key: "tok", expires_at: "2099-01-01T00:00:00.000Z" } }),
    );
    const [zeroUsed] = await accountLimits([fresh], {
      httpGetJson: async () => ({ config: { monthlyLimit: { val: 150_000 }, billingPeriodEnd: "2026-08-01T00:00:00+00:00" } }),
    });
    assert.equal(zeroUsed!.ok, true);
    assert.equal(zeroUsed!.weekly?.usedPercent, 0);

    const expired = account({ id: "grok-3", tool: "grok", provider: "xai" });
    await seedVaultFile(
      expired,
      "auth.json",
      JSON.stringify({ "https://auth.x.ai::c": { key: "tok", expires_at: "2020-01-01T00:00:00.000Z" } }),
    );
    const [result] = await accountLimits([expired], {
      httpGetJson: async () => {
        throw new Error("must not hit the network with an expired token");
      },
    });
    assert.equal(result!.ok, false);
    assert.equal(result!.source, "oauth-api");
    assert.match(result!.error ?? "", /expired at 2020-01-01/);
    assert.match(result!.error ?? "", /hive login grok-3/);
  });
});

// REAL captured GetCurrentPeriodUsage/GetPlanInfo shapes (unix-ms strings, cents).
const CURSOR_USAGE_FIXTURE = {
  billingCycleStart: "1782818048000",
  billingCycleEnd: "1785410048000",
  planUsage: { totalSpend: 1662, includedSpend: 1662, remaining: 38338, limit: 40000, totalPercentUsed: 1.108 },
  enabled: true,
};
const CURSOR_PLAN_FIXTURE = { planInfo: { planName: "Ultra", includedAmountCents: 40000, price: "$200/mo" } };

test("cursor fetcher POSTs the dashboard RPCs with the CLI bearer and maps plan usage", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "cursor-1", tool: "cursor", provider: "cursor" });
    await seedVaultFile(acct, "auth.json", JSON.stringify({ accessToken: jwt({ exp: 9_999_999_999, sub: "auth0|u1" }), refreshToken: "r" }));

    const seen: { url: string; auth?: string; protocol?: string; body: string }[] = [];
    const deps: LimitsDeps = {
      httpPostJson: async (url, headers, body) => {
        seen.push({ url, auth: headers.Authorization, protocol: headers["Connect-Protocol-Version"], body });
        return url.endsWith("GetPlanInfo") ? CURSOR_PLAN_FIXTURE : CURSOR_USAGE_FIXTURE;
      },
    };
    const [result] = await accountLimits([acct], deps);

    assert.equal(seen.length, 2);
    assert.match(seen[0]!.url, /api2\.cursor\.sh\/aiserver\.v1\.DashboardService\/GetCurrentPeriodUsage$/);
    assert.match(seen[1]!.url, /GetPlanInfo$/);
    for (const call of seen) {
      assert.match(call.auth ?? "", /^Bearer x\./);
      assert.equal(call.protocol, "1");
      assert.equal(call.body, "{}");
    }

    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "cursor");
    assert.equal(result!.source, "oauth-api");
    assert.equal(result!.plan, "ultra");
    assert.equal(result!.weekly?.usedPercent, 1.108);
    assert.equal(result!.weekly?.resetsAt, new Date(1_785_410_048_000).toISOString());
    assert.equal(result!.weekly?.windowMinutes, Math.round((1_785_410_048_000 - 1_782_818_048_000) / 60_000));
  });
});

test("cursor fetcher fails an expired access token without network; GetPlanInfo failure is non-fatal", async () => {
  await withTempStore(async () => {
    const expired = account({ id: "cursor-2", tool: "cursor", provider: "cursor" });
    await seedVaultFile(expired, "auth.json", JSON.stringify({ accessToken: jwt({ exp: 1_000_000_000 }) }));
    const [expiredResult] = await accountLimits([expired], {
      httpPostJson: async () => {
        throw new Error("must not hit the network with an expired token");
      },
    });
    assert.equal(expiredResult!.ok, false);
    assert.match(expiredResult!.error ?? "", /expired at 2001-09-09/);

    const planless = account({ id: "cursor-3", tool: "cursor", provider: "cursor" });
    await seedVaultFile(planless, "auth.json", JSON.stringify({ accessToken: jwt({ exp: 9_999_999_999 }) }));
    const [result] = await accountLimits([planless], {
      httpPostJson: async (url) => {
        if (url.endsWith("GetPlanInfo")) throw new Error("plan RPC down");
        return CURSOR_USAGE_FIXTURE;
      },
    });
    assert.equal(result!.ok, true);
    assert.equal(result!.plan, undefined);
    assert.equal(result!.weekly?.usedPercent, 1.108);
  });
});

// REAL captured coding/v1/usages response (numbers are STRINGS; `usage` is the
// weekly plan quota, `limits[]` the rolling 5h window).
const KIMI_USAGES_FIXTURE = {
  user: { userId: "u1", region: "REGION_OVERSEA", membership: { level: "LEVEL_ADVANCED" } },
  usage: { limit: "100", remaining: "80", resetTime: "2026-07-11T10:27:02.269470Z" },
  limits: [
    { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "95", resetTime: "2026-07-08T20:27:02.269470Z" } },
  ],
  parallel: { limit: "30" },
  totalQuota: { limit: "100", remaining: "99" },
  subType: "TYPE_PURCHASE",
};

test("kimi fetcher uses a valid vaulted token and parses weekly + 5h windows", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kimi-1", tool: "kimi", provider: "moonshot" });
    const nowSec = Math.floor(Date.now() / 1000);
    await seedVaultFile(
      acct,
      join("credentials", "kimi-code.json"),
      JSON.stringify({ access_token: "tok-kimi", refresh_token: "r0", expires_at: nowSec + 3600, scope: "kimi-code", token_type: "Bearer" }),
    );

    const seen: { url: string; auth?: string }[] = [];
    const deps: LimitsDeps = {
      httpGetJson: async (url, headers) => {
        seen.push({ url, auth: headers.Authorization });
        return KIMI_USAGES_FIXTURE;
      },
      httpPostJson: async () => {
        throw new Error("valid token must not trigger a refresh");
      },
    };
    const [result] = await accountLimits([acct], deps);

    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /api\.kimi\.com\/coding\/v1\/usages$/);
    assert.equal(seen[0]!.auth, "Bearer tok-kimi");

    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "moonshot");
    assert.equal(result!.source, "oauth-api");
    assert.equal(result!.plan, "advanced");
    // weekly: (100-80)/100 -> 20% used.
    assert.equal(result!.weekly?.usedPercent, 20);
    assert.equal(result!.weekly?.windowMinutes, 10_080);
    assert.equal(result!.weekly?.resetsAt, "2026-07-11T10:27:02.269Z");
    // 5h: 300-minute window, (100-95)/100 -> 5% used.
    assert.equal(result!.fiveHour?.usedPercent, 5);
    assert.equal(result!.fiveHour?.windowMinutes, 300);
    assert.equal(result!.fiveHour?.resetsAt, "2026-07-08T20:27:02.269Z");
  });
});

test("kimi fetcher refreshes an expired token (rotating pair persisted to the vault) then reads usage", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kimi-2", tool: "kimi", provider: "moonshot" });
    const credsRel = join("credentials", "kimi-code.json");
    const nowSec = Math.floor(Date.now() / 1000);
    await seedVaultFile(
      acct,
      credsRel,
      JSON.stringify({ access_token: "tok-old", refresh_token: "r0", expires_at: nowSec - 60, scope: "kimi-code", token_type: "Bearer" }),
    );

    const posts: { url: string; contentType?: string; body: string }[] = [];
    const gets: { auth?: string }[] = [];
    const deps: LimitsDeps = {
      httpPostJson: async (url, headers, body) => {
        posts.push({ url, contentType: headers["Content-Type"], body });
        return { access_token: "tok-new", refresh_token: "r1", expires_in: 900, token_type: "Bearer" };
      },
      httpGetJson: async (_url, headers) => {
        gets.push({ auth: headers.Authorization });
        return KIMI_USAGES_FIXTURE;
      },
    };
    const [result] = await accountLimits([acct], deps);

    // The refresh hit the kimi-auth token endpoint with the ROTATING grant.
    assert.equal(posts.length, 1);
    assert.match(posts[0]!.url, /auth\.kimi\.com\/api\/oauth\/token$/);
    assert.equal(posts[0]!.contentType, "application/x-www-form-urlencoded");
    const form = new URLSearchParams(posts[0]!.body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "r0");
    assert.equal(form.get("client_id"), "17e5f671-d194-4dfb-9706-5516cb48c098");

    // The usage read used the refreshed token and parsed normally.
    assert.equal(gets[0]!.auth, "Bearer tok-new");
    assert.equal(result!.ok, true);
    assert.equal(result!.weekly?.usedPercent, 20);

    // The rotated pair landed back in the vault — a stale refresh token would
    // strand the CLI's session at its next refresh.
    const persisted = JSON.parse(await readFile(join(accountDir(acct), credsRel), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.access_token, "tok-new");
    assert.equal(persisted.refresh_token, "r1");
    assert.equal(persisted.scope, "kimi-code");
    const expiresAt = persisted.expires_at as number;
    assert.ok(expiresAt >= nowSec + 890 && expiresAt <= nowSec + 910, `expires_at ${expiresAt} ~ now+900`);
  });
});

test("kimi-for-coding (opencode) fetcher hits the same usages endpoint with the opencode key", async () => {
  await withTempStore(async () => {
    const acct = account({ id: "kfc-1", tool: "opencode", provider: "kimi-for-coding" });
    await seedOpencodeAuth(acct, { "kimi-for-coding": { type: "api", key: "sk-kimi-abc" } });

    const seen: { url: string; auth?: string }[] = [];
    const [result] = await accountLimits([acct], {
      httpGetJson: async (url, headers) => {
        seen.push({ url, auth: headers.Authorization });
        return KIMI_USAGES_FIXTURE;
      },
    });

    assert.match(seen[0]!.url, /api\.kimi\.com\/coding\/v1\/usages$/);
    assert.equal(seen[0]!.auth, "Bearer sk-kimi-abc");
    assert.equal(result!.ok, true);
    assert.equal(result!.provider, "kimi-for-coding");
    assert.equal(result!.weekly?.usedPercent, 20);
    assert.equal(result!.fiveHour?.usedPercent, 5);
  });
});
