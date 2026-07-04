import assert from "node:assert/strict";
import { test } from "node:test";
import { matchModelRule, priceEvent, priceEvents, selectRateVersion, unknownModels } from "../src/spend/pricing.js";
import { zeroTokens, type RateTable, type SpendEvent, type TokenCounts } from "../src/spend/types.js";

/** A SpendEvent literal with only the fields pricing cares about spelled out. */
function event(model: string, ts: string, tokens: Partial<TokenCounts>): SpendEvent {
  return {
    id: `claude:${model}:${ts}`,
    ts,
    harness: "claude",
    seat: "claude:default",
    sessionId: "sess-1",
    model,
    tokens: { ...zeroTokens(), ...tokens },
    sourceFile: "/dev/null",
    sourceOffset: 0,
  };
}

// A small hand-built table: haiku prices two dated versions, opus splits cache
// TTL tiers, "todo-model" is a registered-but-unpriced placeholder.
const table: RateTable = {
  rules: [
    {
      modelPattern: "claude-haiku",
      versions: [
        {
          effectiveFrom: "2026-01-01",
          inputPerMTok: 1,
          outputPerMTok: 5,
          cacheReadPerMTok: 0.1,
          cacheWrite5mPerMTok: 1.25,
          cacheWrite1hPerMTok: 2,
        },
        {
          // A price hike lands mid-year; earlier events keep the old rate.
          effectiveFrom: "2026-06-01",
          inputPerMTok: 2,
          outputPerMTok: 10,
          cacheReadPerMTok: 0.2,
          cacheWrite5mPerMTok: 2.5,
          cacheWrite1hPerMTok: 4,
        },
      ],
    },
    {
      modelPattern: "claude-opus-*",
      versions: [
        {
          effectiveFrom: "2026-01-01",
          inputPerMTok: 15,
          outputPerMTok: 75,
          cacheReadPerMTok: 1.5,
          // Anthropic bills 5m and 1h ephemeral writes at different rates.
          cacheWrite5mPerMTok: 18.75,
          cacheWrite1hPerMTok: 30,
        },
      ],
    },
    {
      modelPattern: "claude-sonnet",
      versions: [
        {
          effectiveFrom: "2026-01-01",
          inputPerMTok: 3,
          outputPerMTok: 15,
          // We have not confirmed the cache-write price — explicit unknown.
          cacheReadPerMTok: 0.3,
          cacheWrite5mPerMTok: null,
          cacheWrite1hPerMTok: null,
        },
      ],
    },
    {
      modelPattern: "todo-model",
      todo: true,
      versions: [],
    },
  ],
};

test("matchModelRule picks the most specific matching rule, case-insensitively", () => {
  assert.equal(matchModelRule(table, "CLAUDE-HAIKU-4-5-20251001")?.modelPattern, "claude-haiku");
  assert.equal(matchModelRule(table, "claude-opus-4-8")?.modelPattern, "claude-opus-*");
  assert.equal(matchModelRule(table, "gpt-9")?.modelPattern, undefined);

  // Longest-literal wins over a shorter substring match.
  const specific: RateTable = {
    rules: [
      { modelPattern: "claude", versions: [] },
      { modelPattern: "claude-haiku", versions: [] },
    ],
  };
  assert.equal(matchModelRule(specific, "claude-haiku-4-5")?.modelPattern, "claude-haiku");
});

test("selectRateVersion picks the latest effectiveFrom <= the event date, inclusive boundary", () => {
  const rule = table.rules[0]!; // claude-haiku, two versions
  // Before any version → null.
  assert.equal(selectRateVersion(rule, "2025-12-31T12:00:00Z"), null);
  // Between the two versions → the older one.
  assert.equal(selectRateVersion(rule, "2026-03-15T09:00:00Z")?.effectiveFrom, "2026-01-01");
  // Exactly on the boundary (effectiveFrom day) → the new version takes effect.
  assert.equal(selectRateVersion(rule, "2026-06-01T00:30:00+02:00")?.effectiveFrom, "2026-06-01");
  // After the hike → the new version.
  assert.equal(selectRateVersion(rule, "2026-09-01T00:00:00Z")?.effectiveFrom, "2026-06-01");
});

test("priceEvent applies the date-selected version", () => {
  // 1,000,000 input @ $1/M under the old version = $1.00 exactly.
  const early = priceEvent(event("claude-haiku-4-5", "2026-02-01T10:00:00Z", { input: 1_000_000 }), table);
  assert.equal(early.rateResolved, true);
  assert.equal(early.usd, 1);
  assert.equal(early.usdByTier.input, 1);

  // Same tokens after the hike = $2.00 under the new version.
  const late = priceEvent(event("claude-haiku-4-5", "2026-07-01T10:00:00Z", { input: 1_000_000 }), table);
  assert.equal(late.usd, 2);
});

test("priceEvent prices the 5m and 1h cache-write tiers at different rates", () => {
  const costed = priceEvent(
    event("claude-opus-4-8", "2026-03-01T10:00:00Z", { cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }),
    table,
  );
  assert.equal(costed.rateResolved, true);
  assert.equal(costed.usdByTier.cacheWrite5m, 18.75);
  assert.equal(costed.usdByTier.cacheWrite1h, 30);
  assert.equal(costed.usd, 48.75);
});

test("priceEvent flags an unknown model, prices it at zero, and echoes the id", () => {
  const costed = priceEvent(event("gemini-3-pro", "2026-03-01T10:00:00Z", { input: 5_000_000 }), table);
  assert.equal(costed.rateResolved, false);
  assert.equal(costed.usd, 0);
  assert.equal(costed.usdByTier.input, 0);
  assert.equal(costed.unknownModel, "gemini-3-pro");
});

test("priceEvent leaves a todo-rule event unresolved without an unknownModel", () => {
  const costed = priceEvent(event("todo-model", "2026-03-01T10:00:00Z", { input: 1_000_000 }), table);
  assert.equal(costed.rateResolved, false);
  assert.equal(costed.usd, 0);
  // A todo rule matched, so it is not the unknown-model path.
  assert.equal(costed.unknownModel, undefined);
});

test("a null rate on a NONZERO tier unresolves the whole event (no fabricated price)", () => {
  const costed = priceEvent(
    event("claude-sonnet-4-5", "2026-03-01T10:00:00Z", { input: 1_000_000, cacheWrite5m: 1_000_000 }),
    table,
  );
  assert.equal(costed.rateResolved, false);
  assert.equal(costed.usd, 0);
  // Even the priceable input tier is zeroed — we never emit a partial price.
  assert.equal(costed.usdByTier.input, 0);
});

test("a null rate on a ZERO tier is harmless — the event still resolves", () => {
  const costed = priceEvent(
    event("claude-sonnet-4-5", "2026-03-01T10:00:00Z", { input: 1_000_000, output: 200_000 }),
    table,
  );
  assert.equal(costed.rateResolved, true);
  // 1M input @ $3 + 0.2M output @ $15 = 3 + 3 = 6.
  assert.equal(costed.usd, 6);
  assert.equal(costed.usdByTier.cacheWrite5m, 0);
});

test("priceEvents + unknownModels report the distinct sorted unknown ids", () => {
  const costed = priceEvents(
    [
      event("zeta-model", "2026-03-01T10:00:00Z", { input: 1 }),
      event("alpha-model", "2026-03-01T10:00:00Z", { input: 1 }),
      event("zeta-model", "2026-03-02T10:00:00Z", { input: 1 }),
      event("claude-haiku-4-5", "2026-03-01T10:00:00Z", { input: 1_000_000 }),
    ],
    table,
  );
  assert.equal(costed.length, 4);
  assert.deepEqual(unknownModels(costed), ["alpha-model", "zeta-model"]);
});
