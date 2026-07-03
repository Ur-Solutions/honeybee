import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi, visibleLength } from "../src/format.js";
import type { AccountLimits } from "../src/limits.js";
import {
  USAGE_TUI_DEFAULT_INTERVAL_MS,
  USAGE_TUI_MIN_INTERVAL_MS,
  buildUsageFooter,
  buildUsageRows,
  clampUsageInterval,
  formatHeaderStatus,
  nextUsageFetchDelayMs,
  usageBar,
  usageResultsRateLimited,
  usageRow,
} from "../src/usageTui.js";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const in1h = new Date(NOW + 60 * 60 * 1000).toISOString();
const in5d = new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString();

function okAccount(overrides: Partial<AccountLimits> = {}): AccountLimits {
  return {
    account: "tormod",
    tool: "claude",
    ok: true,
    source: "oauth-api",
    plan: "max",
    fiveHour: { usedPercent: 52, windowMinutes: 300, resetsAt: in1h },
    weekly: { usedPercent: 13, windowMinutes: 10_080, resetsAt: in5d },
    fableWeekly: { usedPercent: 42, windowMinutes: 10_080, resetsAt: in5d },
    ...overrides,
  };
}

test("usageBar: fill scales with percent and clamps out-of-range", () => {
  assert.equal(usageBar(0, 16), "░".repeat(16));
  assert.equal(usageBar(100, 16), "█".repeat(16));
  assert.equal(usageBar(52, 16), `${"█".repeat(8)}${"░".repeat(8)}`);
  // >100 clamps to full, <0 clamps to empty.
  assert.equal(usageBar(150, 10), "█".repeat(10));
  assert.equal(usageBar(-20, 10), "░".repeat(10));
  // width scaling: same percent, different widths.
  assert.equal(usageBar(50, 10).length, 10);
  assert.equal(usageBar(50, 20).length, 20);
});

test("buildUsageRows: an ok row renders all three windows", () => {
  const rows = buildUsageRows([okAccount()], NOW, 120);
  const body = stripAnsi(rows[1]!);
  assert.match(body, /tormod/);
  assert.match(body, /max/);
  assert.match(body, /52%/);
  assert.match(body, /13%/);
  assert.match(body, /42%/); // Fable terse cell
  assert.match(body, /█/); // bars present
});

test("buildUsageRows: an unreadable account renders its error inline", () => {
  const rows = buildUsageRows(
    [okAccount({ ok: false, error: "HTTP 401", fiveHour: undefined, weekly: undefined, fableWeekly: undefined })],
    NOW,
    120,
  );
  const body = stripAnsi(rows[1]!);
  assert.match(body, /HTTP 401/);
  assert.doesNotMatch(body, /█/); // no bars for a failed account
});

test("buildUsageRows: a rolled-over window renders 0%", () => {
  const past = new Date(NOW - 60 * 1000).toISOString();
  const rows = buildUsageRows(
    [okAccount({ fiveHour: { usedPercent: 88, windowMinutes: 300, resetsAt: past } })],
    NOW,
    120,
  );
  const body = stripAnsi(rows[1]!);
  assert.match(body, /0%/);
  assert.doesNotMatch(body, /88%/);
});

test("buildUsageRows: cached results show the cache age", () => {
  const rows = buildUsageRows(
    [okAccount({ cached: true, asOf: new Date(NOW - 3 * 60 * 1000).toISOString() })],
    NOW,
    120,
  );
  const body = stripAnsi(rows[1]!);
  assert.match(body, /cache 3m/);
});

test("buildUsageRows: no row exceeds the column budget", () => {
  const accounts = [
    okAccount({ account: "tormod" }),
    okAccount({ account: "work", plan: "pro" }),
    okAccount({ account: "a-very-long-account-name-that-overflows", plan: "plus" }),
    okAccount({ ok: false, error: "some very long error message ".repeat(6) }),
  ];
  for (const columns of [40, 80, 120, 200]) {
    for (const row of buildUsageRows(accounts, NOW, columns)) {
      assert.ok(visibleLength(stripAnsi(row)) <= columns, `row overflows at columns=${columns}: ${JSON.stringify(row)}`);
    }
  }
});

test("usageRow: bar width is honored", () => {
  const wide = stripAnsi(usageRow(okAccount(), NOW, 30));
  const narrow = stripAnsi(usageRow(okAccount(), NOW, 10));
  // A wider bar means more glyph cells for the same data.
  const count = (s: string) => (s.match(/[█░]/g) ?? []).length;
  assert.ok(count(wide) > count(narrow));
});

test("formatHeaderStatus: loading, idle countdown, and fetching states", () => {
  // Before the first result: loading.
  assert.match(formatHeaderStatus(undefined, undefined, false, NOW), /loading/);
  // Idle with a scheduled next fetch: shows the countdown.
  const idle = formatHeaderStatus(NOW - 12_000, NOW + 48_000, false, NOW);
  assert.match(idle, /refreshed 12s ago/);
  assert.match(idle, /next in 48s/);
  assert.match(idle, /\[r\]efresh \[q\]uit/);
  // Fetching: swaps the countdown for a refreshing indicator.
  const busy = formatHeaderStatus(NOW - 5_000, NOW + 55_000, true, NOW);
  assert.match(busy, /refreshing/);
  assert.doesNotMatch(busy, /next in/);
});

test("buildUsageFooter: refresh error banner, per-account errors, and pace legend", () => {
  const footer = buildUsageFooter(
    [okAccount(), okAccount({ account: "work", ok: false, error: "HTTP 401" })],
    "network down",
  ).map(stripAnsi);
  assert.ok(footer.some((line) => /refresh failed: network down/.test(line)));
  assert.ok(footer.some((line) => /work: HTTP 401/.test(line)));
  assert.ok(footer.some((line) => /pace:/.test(line)));
});

test("clampUsageInterval: default, floor, and pass-through", () => {
  assert.equal(clampUsageInterval(undefined), USAGE_TUI_DEFAULT_INTERVAL_MS);
  assert.equal(clampUsageInterval(0), USAGE_TUI_DEFAULT_INTERVAL_MS);
  assert.equal(clampUsageInterval(-5), USAGE_TUI_DEFAULT_INTERVAL_MS);
  assert.equal(clampUsageInterval(5_000), USAGE_TUI_MIN_INTERVAL_MS); // below the floor
  assert.equal(clampUsageInterval(30_000), 30_000);
});

test("buildUsageRows: the account column widens to fit long account ids", () => {
  const long = "claude-tormod.haugland-gmail.com";
  const rows = buildUsageRows([okAccount({ account: long }), okAccount({ account: "short" })], NOW, 220);
  // The full id survives untruncated, and the short row is padded to match.
  assert.match(stripAnsi(rows[1]!), new RegExp(long.replace(/\./g, "\\.")));
  const longPrefix = stripAnsi(rows[1]!).indexOf("max");
  const shortPrefix = stripAnsi(rows[2]!).indexOf("max");
  assert.equal(longPrefix, shortPrefix);
});

test("usageResultsRateLimited: detects 429/rate-limit errors only", () => {
  assert.equal(usageResultsRateLimited([okAccount()]), false);
  assert.equal(
    usageResultsRateLimited([okAccount({ ok: false, error: "/api/oauth/usage: HTTP 429" })]),
    true,
  );
  assert.equal(
    usageResultsRateLimited([okAccount({ ok: false, error: "rate limited, try later" })]),
    true,
  );
  assert.equal(
    usageResultsRateLimited([okAccount({ ok: false, error: "HTTP 401" })]),
    false,
  );
});

test("nextUsageFetchDelayMs: doubles per rate-limited sweep, capped at 8x", () => {
  assert.equal(nextUsageFetchDelayMs(120_000, 0), 120_000);
  assert.equal(nextUsageFetchDelayMs(120_000, 1), 240_000);
  assert.equal(nextUsageFetchDelayMs(120_000, 2), 480_000);
  assert.equal(nextUsageFetchDelayMs(120_000, 3), 960_000);
  assert.equal(nextUsageFetchDelayMs(120_000, 10), 960_000); // capped
  assert.equal(nextUsageFetchDelayMs(120_000, -1), 120_000); // clamped low
});

test("formatHeaderStatus: surfaces the rate-limited backoff state", () => {
  const status = formatHeaderStatus(NOW - 5_000, NOW + 55_000, false, NOW, true);
  assert.match(status, /rate-limited, backing off/);
  assert.doesNotMatch(formatHeaderStatus(NOW - 5_000, NOW + 55_000, false, NOW), /rate-limited/);
});

test("buildUsageFooter: standing warnings are pinned between refresh error and account notes", () => {
  const lines = buildUsageFooter(
    [okAccount({ ok: false, error: "HTTP 401" })],
    "boom",
    ["⚠ claude-x: no email on record"],
  ).map(stripAnsi);
  assert.equal(lines[0], "refresh failed: boom");
  assert.equal(lines[1], "⚠ claude-x: no email on record");
  assert.match(lines[2]!, /HTTP 401/);
});

test("usageResultsRateLimited: a stale-cache fallback row stamped rateLimited triggers backoff", () => {
  assert.equal(usageResultsRateLimited([okAccount({ cached: true, rateLimited: true })]), true);
  assert.equal(usageResultsRateLimited([okAccount({ cached: true })]), false);
});
