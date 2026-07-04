// Pure-builder tests for the spend reporting layer: dailyLedger grouping +
// rateResolved AND, leverage proration/portfolio/rolling-avg + excluded seats,
// session orchestrator/subagent split + top-N, blend period/tier grouping, and a
// CSV shape check. All in-memory — no disk, no network. Run directly:
//   npx tsx tests/spend-report.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyProration } from "../src/spend/time.js";
import { zeroTokens, type CostedEvent, type Seat, type TokenCounts } from "../src/spend/types.js";
import { blend, dailyLedger, leverage, sessionRollups } from "../src/spend/report.js";
import { toCsv } from "../src/spend/format.js";

let seq = 0;

function tk(partial: Partial<TokenCounts>): TokenCounts {
  return { ...zeroTokens(), ...partial };
}

function ce(o: Partial<CostedEvent> & { ts: string; seat: string }): CostedEvent {
  seq += 1;
  return {
    id: o.id ?? `e${seq}`,
    ts: o.ts,
    harness: o.harness ?? "claude",
    seat: o.seat,
    sessionId: o.sessionId ?? "sess",
    model: o.model ?? "claude-opus-4-8",
    tokens: o.tokens ?? zeroTokens(),
    sourceFile: o.sourceFile ?? "f.jsonl",
    sourceOffset: o.sourceOffset ?? 0,
    usd: o.usd ?? 0,
    usdByTier: o.usdByTier ?? zeroTokens(),
    rateResolved: o.rateResolved ?? true,
    ...(o.isSubagent !== undefined ? { isSubagent: o.isSubagent } : {}),
    ...(o.unknownModel !== undefined ? { unknownModel: o.unknownModel } : {}),
  };
}

function seat(id: string, monthlyUsd?: number): Seat {
  return { id, harness: "claude", configDir: `/home/${id}`, ...(monthlyUsd !== undefined ? { monthlyUsd } : {}) };
}

test("dailyLedger groups by (day, seat, model), sums tiers, ANDs rateResolved", () => {
  const events = [
    ce({ ts: "2026-07-01T10:00:00Z", seat: "claude:default", model: "claude-opus-4-8", usd: 1.5, tokens: tk({ input: 100, output: 10 }), rateResolved: true }),
    ce({ ts: "2026-07-01T14:00:00Z", seat: "claude:default", model: "claude-opus-4-8", usd: 2.5, tokens: tk({ input: 50, cacheRead: 200 }), rateResolved: false }),
    // Different model on the same day/seat → its own bucket, still resolved.
    ce({ ts: "2026-07-01T15:00:00Z", seat: "claude:default", model: "claude-haiku-4-5", usd: 0.25, tokens: tk({ input: 5 }), rateResolved: true }),
  ];
  const rows = dailyLedger(events);
  assert.equal(rows.length, 2);
  const opus = rows.find((r) => r.model === "claude-opus-4-8")!;
  assert.equal(opus.day, "2026-07-01");
  assert.equal(opus.usd, 4.0);
  assert.equal(opus.tokens.input, 150);
  assert.equal(opus.tokens.output, 10);
  assert.equal(opus.tokens.cacheRead, 200);
  assert.equal(opus.rateResolved, false, "one unresolved event taints the bucket");
  const haiku = rows.find((r) => r.model === "claude-haiku-4-5")!;
  assert.equal(haiku.rateResolved, true);
  // Sorted by day, seat, model → haiku sorts before opus.
  assert.deepEqual(rows.map((r) => r.model), ["claude-haiku-4-5", "claude-opus-4-8"]);
});

test("leverage prorates subscriptions, aggregates a portfolio, and excludes seats without monthlyUsd", () => {
  const a = seat("claude:default", 100);
  const b = seat("codex:default", 50);
  const c = seat("claude:no-cost"); // no monthlyUsd → excluded from leverage
  const events = [
    // seatA: usd (i+1) on 2026-06-01 .. 2026-06-07 (7 consecutive days).
    ...Array.from({ length: 7 }, (_, i) =>
      ce({ ts: `2026-06-0${i + 1}T10:00:00Z`, seat: a.id, usd: i + 1 }),
    ),
    ce({ ts: "2026-06-01T10:00:00Z", seat: b.id, usd: 2 }),
    ce({ ts: "2026-06-01T10:00:00Z", seat: c.id, usd: 999 }),
  ];
  const rows = leverage(events, [a, b, c]);

  // Excluded seat never appears.
  assert.equal(rows.some((r) => r.seat === c.id), false);

  const actualA = dailyProration(100);
  const day1A = rows.find((r) => r.seat === a.id && r.day === "2026-06-01")!;
  assert.ok(Math.abs(day1A.actualUsd - actualA) < 1e-9, "actualUsd is monthlyUsd pro-rated to a day");
  assert.equal(day1A.apiEquivUsd, 1);
  assert.ok(Math.abs(day1A.leverage! - 1 / actualA) < 1e-9);

  // Portfolio aggregates both priced seats on day 1: api = 1 + 2, actual = both prorations.
  const portDay1 = rows.find((r) => r.seat === "portfolio" && r.day === "2026-06-01")!;
  assert.equal(portDay1.apiEquivUsd, 3);
  assert.ok(Math.abs(portDay1.actualUsd - (dailyProration(100) + dailyProration(50))) < 1e-9);

  // Rolling 7-day average on day 7 (index 6) = mean of leverages for days 1..7.
  // seatA leverage_i = (i+1)/actualA, i=0..6 → mean = (28/7)/actualA = 4/actualA.
  const day7A = rows.find((r) => r.seat === a.id && r.day === "2026-06-07")!;
  assert.ok(day7A.avg7 !== null, "avg7 is defined once 7 days have elapsed");
  assert.ok(Math.abs(day7A.avg7! - 4 / actualA) < 1e-9, "avg7 is the trailing 7-day mean leverage");

  // avg7 is null before enough days have accumulated.
  const day3A = rows.find((r) => r.seat === a.id && r.day === "2026-06-03")!;
  assert.equal(day3A.avg7, null);
});

test("sessionRollups split orchestrator vs subagent, flag unknown rates, sort desc, slice top-N", () => {
  const events = [
    ce({ sessionId: "sX", ts: "2026-07-01T10:00:00Z", seat: "claude:default", usd: 3, isSubagent: false }),
    ce({ sessionId: "sX", ts: "2026-07-01T11:00:00Z", seat: "claude:default", usd: 1, isSubagent: true, rateResolved: false }),
    ce({ sessionId: "sY", ts: "2026-07-02T09:00:00Z", seat: "claude:default", usd: 10, isSubagent: false }),
  ];
  const all = sessionRollups(events);
  assert.deepEqual(all.map((r) => r.sessionId), ["sY", "sX"], "sorted by apiEquivUsd desc");

  const sx = all.find((r) => r.sessionId === "sX")!;
  assert.equal(sx.apiEquivUsd, 4);
  assert.equal(sx.orchestratorUsd, 3);
  assert.equal(sx.subagentUsd, 1);
  assert.equal(sx.hasUnknownRate, true);
  assert.equal(sx.startTs, "2026-07-01T10:00:00Z");
  assert.equal(sx.endTs, "2026-07-01T11:00:00Z");
  assert.equal(sx.durationMs, 3_600_000);

  const top1 = sessionRollups(events, { top: 1 });
  assert.deepEqual(top1.map((r) => r.sessionId), ["sY"]);
});

test("blend groups by (period, model) and sums tiers, honoring granularity + model filter", () => {
  const events = [
    ce({ ts: "2026-07-01T10:00:00Z", model: "claude-opus-4-8", seat: "s", usdByTier: { ...zeroTokens(), input: 1.0 }, tokens: tk({ input: 100 }) }),
    ce({ ts: "2026-07-01T12:00:00Z", model: "claude-opus-4-8", seat: "s", usdByTier: { ...zeroTokens(), input: 0.5 }, tokens: tk({ input: 50 }) }),
    ce({ ts: "2026-07-01T13:00:00Z", model: "claude-haiku-4-5", seat: "s", usdByTier: { ...zeroTokens(), input: 0.1 }, tokens: tk({ input: 10 }) }),
    ce({ ts: "2026-07-02T10:00:00Z", model: "claude-opus-4-8", seat: "s", usdByTier: { ...zeroTokens(), input: 2.0 }, tokens: tk({ input: 200 }) }),
  ];
  const daily = blend(events);
  const opusDay1 = daily.find((r) => r.period === "2026-07-01" && r.model === "claude-opus-4-8")!;
  assert.equal(opusDay1.usdByTier.input, 1.5);
  assert.equal(opusDay1.tokensByTier.input, 150);

  // Monthly granularity collapses both days of opus into one 2026-07 bucket.
  const monthly = blend(events, { granularity: "month", model: "opus" });
  assert.equal(monthly.length, 1);
  assert.equal(monthly[0]!.period, "2026-07");
  assert.equal(monthly[0]!.model, "claude-opus-4-8");
  assert.equal(monthly[0]!.tokensByTier.input, 350);
  assert.equal(monthly[0]!.usdByTier.input, 3.5);
});

test("toCsv flattens nested tokens/usd and yields one line per row", () => {
  const rows = dailyLedger([
    ce({ ts: "2026-07-01T10:00:00Z", seat: "claude:default", usd: 1.5, tokens: tk({ input: 100, output: 10 }) }),
  ]);
  const csv = toCsv(rows as unknown as Array<Record<string, unknown>>);
  const lines = csv.split("\n");
  const header = lines[0]!;
  for (const column of ["day", "seat", "model", "tokens.input", "tokens.output", "usd", "rateResolved"]) {
    assert.ok(header.includes(column), `header should carry ${column}`);
  }
  assert.equal(lines.length, rows.length + 1, "one header line + one line per row");
  // The single data row carries the flattened token value.
  assert.ok(lines[1]!.split(",").includes("100"));
});
