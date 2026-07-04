import { test } from "node:test";
import assert from "node:assert/strict";
import { periodOf, daysInPeriod } from "../src/spend/time.js";
import { dailyLedger, sessionDetail, usageSummary } from "../src/spend/report.js";
import type { CostedEvent } from "../src/spend/types.js";
import { zeroTokens } from "../src/spend/types.js";

test("periodOf: day granularity is the identity", () => {
  assert.equal(periodOf("2026-07-03", "day"), "2026-07-03");
});

test("periodOf: month granularity is the YYYY-MM prefix", () => {
  assert.equal(periodOf("2026-07-03", "month"), "2026-07");
  assert.equal(periodOf("2026-01-31", "month"), "2026-01");
});

test("periodOf: ISO week labels (incl. year-boundary edge cases)", () => {
  // 2026-07-03 is a Friday in ISO week 27.
  assert.equal(periodOf("2026-07-03", "week"), "2026-W27");
  // Mon..Sun of the same ISO week all map to W27.
  assert.equal(periodOf("2026-06-29", "week"), "2026-W27"); // Monday
  assert.equal(periodOf("2026-07-05", "week"), "2026-W27"); // Sunday
  assert.equal(periodOf("2026-07-06", "week"), "2026-W28"); // next Monday
  // 2026-01-01 (Thursday) belongs to ISO week 1 of 2026.
  assert.equal(periodOf("2026-01-01", "week"), "2026-W01");
  // 2025-12-29 (Monday) is already ISO week 1 of 2026 (Thursday falls in Jan).
  assert.equal(periodOf("2025-12-29", "week"), "2026-W01");
  // 2027-01-01 (Friday) is ISO week 53 of 2026.
  assert.equal(periodOf("2027-01-01", "week"), "2026-W53");
});

test("periodOf: unparseable input is returned unchanged", () => {
  assert.equal(periodOf("not-a-date", "week"), "not-a-date");
});

function ev(ts: string, usd: number): CostedEvent {
  return {
    id: `id-${ts}-${usd}`,
    ts,
    harness: "claude",
    seat: "claude:default",
    sessionId: "s1",
    model: "claude-opus-4-8",
    tokens: { ...zeroTokens(), input: 1 },
    usd,
    usdByTier: { ...zeroTokens(), input: usd },
    rateResolved: true,
    sourceFile: "/x.jsonl",
    sourceOffset: 0,
  };
}

test("dailyLedger: month granularity collapses days in the same month into one bucket", () => {
  const costed = [ev("2026-07-01T10:00:00Z", 2), ev("2026-07-20T10:00:00Z", 3), ev("2026-08-02T10:00:00Z", 5)];
  const rows = dailyLedger(costed, { granularity: "month" });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.day, r.usd]),
    [
      ["2026-07", 5],
      ["2026-08", 5],
    ],
  );
});

test("dailyLedger: week granularity buckets by ISO week", () => {
  // Both days are in ISO week 27; a third is in week 28.
  const costed = [ev("2026-06-29T10:00:00Z", 1), ev("2026-07-05T10:00:00Z", 4), ev("2026-07-06T10:00:00Z", 9)];
  const rows = dailyLedger(costed, { granularity: "week" });
  assert.deepEqual(
    rows.map((r) => [r.day, r.usd]),
    [
      ["2026-W27", 5],
      ["2026-W28", 9],
    ],
  );
});

test("daysInPeriod: month enumerates every calendar day", () => {
  const days = daysInPeriod("2026-02", "month"); // 2026 is not a leap year
  assert.equal(days.length, 28);
  assert.equal(days[0], "2026-02-01");
  assert.equal(days.at(-1), "2026-02-28");
});

test("daysInPeriod: week is Monday..Sunday of the ISO week", () => {
  const days = daysInPeriod("2026-W27", "week");
  assert.deepEqual(days, [
    "2026-06-29",
    "2026-06-30",
    "2026-07-01",
    "2026-07-02",
    "2026-07-03",
    "2026-07-04",
    "2026-07-05",
  ]);
});

test("usageSummary: aggregates one month by model with shares, blend, and dense daily series", () => {
  const costed = [
    ev("2026-06-05T10:00:00Z", 30), // opus
    ev("2026-06-20T10:00:00Z", 10), // opus
    { ...ev("2026-06-10T10:00:00Z", 60), model: "claude-fable-5" },
    ev("2026-07-01T10:00:00Z", 999), // different month — excluded
  ];
  const s = usageSummary(costed, { granularity: "month", period: "2026-06" });
  assert.equal(s.totalUsd, 100);
  assert.equal(s.seat, "all");
  // Sorted by usd desc: fable (60) then opus (40).
  assert.deepEqual(
    s.models.map((m) => [m.model, m.usd, Math.round(m.share * 100)]),
    [
      ["claude-fable-5", 60, 60],
      ["claude-opus-4-8", 40, 40],
    ],
  );
  // tierUsd blend: every ev() puts its usd in the input tier.
  assert.equal(s.tierUsd.input, 100);
  // Dense daily series spans all 30 June days; spend lands on the 5th/10th/20th.
  assert.equal(s.daily.length, 30);
  const byDay = Object.fromEntries(s.daily.map((d) => [d.day, d.usd]));
  assert.equal(byDay["2026-06-05"], 30);
  assert.equal(byDay["2026-06-10"], 60);
  assert.equal(byDay["2026-06-20"], 10);
  assert.equal(byDay["2026-06-01"], 0);
});

test("usageSummary: to-date view clamps the daily series to today and flags partial", () => {
  const costed = [ev("2026-07-01T10:00:00Z", 5), ev("2026-07-03T10:00:00Z", 8)];
  const s = usageSummary(costed, { granularity: "month", period: "2026-07", today: "2026-07-04" });
  assert.equal(s.partial, true); // July has days after the 4th
  assert.equal(s.daily.length, 4); // only 07-01..07-04, not the full 31
  assert.equal(s.daily.at(-1)!.day, "2026-07-04");
  assert.equal(s.totalUsd, 13); // totals are unaffected by the sparkline clamp
});

test("usageSummary: a past period is not partial and keeps its full day span", () => {
  const costed = [ev("2026-06-10T10:00:00Z", 5)];
  const s = usageSummary(costed, { granularity: "month", period: "2026-06", today: "2026-07-04" });
  assert.equal(s.partial, false);
  assert.equal(s.daily.length, 30);
});

test("sessionDetail: aggregates one session with model mix, ratios, and context deciles", () => {
  const mk = (ts: string, model: string, input: number, output: number, cacheRead: number, cacheWrite5m = 0): CostedEvent => {
    const usdByTier = { ...zeroTokens(), output: output * 0.00005 };
    return {
      id: `id-${ts}`,
      ts,
      harness: "claude",
      seat: "claude:acct",
      sessionId: "S",
      model,
      tokens: { ...zeroTokens(), input, output, cacheRead, cacheWrite5m },
      usd: output * 0.00005,
      usdByTier,
      rateResolved: true,
      sourceFile: "/x.jsonl",
      sourceOffset: 0,
    };
  };
  const costed = [
    mk("2026-07-03T10:00:00Z", "claude-fable-5", 10, 100, 1_000, 20),
    mk("2026-07-03T11:00:00Z", "claude-opus-4-8", 10, 100, 5_000, 20),
    mk("2026-07-03T12:00:00Z", "claude-fable-5", 10, 200, 9_000, 20),
    mk("2026-08-01T10:00:00Z", "claude-opus-4-8", 1, 1, 1, 1), // different session excluded below
  ];
  costed[3]!.sessionId = "OTHER";
  const d = sessionDetail(costed, "S");
  assert.equal(d.turns, 3);
  assert.equal(d.models[0]!.model, "claude-fable-5"); // 2 fable turns > 1 opus
  assert.equal(d.models[0]!.turns, 2);
  assert.equal(d.totalTokens.output, 400);
  assert.equal(d.totalTokens.cacheRead, 15_000);
  // cache-write/read = 60 / 15000; cache-read/output = 15000/400 = 37.5 -> 38 rounded in view
  assert.ok(Math.abs(d.cacheWriteOverRead - 60 / 15_000) < 1e-9);
  assert.ok(Math.abs(d.cacheReadOverOutput - 37.5) < 1e-9);
  assert.equal(d.contextDeciles.length, 10);
  assert.equal(d.peakContext, 9_010); // last turn: input 10 + cacheRead 9000
});

test("usageSummary: seat filter restricts the period", () => {
  const costed = [ev("2026-06-05T10:00:00Z", 30), { ...ev("2026-06-06T10:00:00Z", 7), seat: "codex:default" }];
  const s = usageSummary(costed, { granularity: "month", period: "2026-06", seat: "claude:default" });
  assert.equal(s.totalUsd, 30);
  assert.equal(s.seat, "claude:default");
  assert.equal(s.models.length, 1);
});
