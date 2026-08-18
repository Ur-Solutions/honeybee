/**
 * Spec 08 test 4 — the GOLDEN selection suite, ported from the old
 * tests/limits.test.ts against the verbatim port in src/accountSelect.ts.
 * Same inputs, same picks, same reasons. Each test names the old test it
 * came from. Reinterpretations are called out inline (the commitment
 * weights map old session states onto the v2 four-state model; the cursor
 * rotation is a pure function over a caller-held cursor instead of a json
 * file). Pure — no store, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_COMMITMENT_BUSY_PERCENT,
  AUTO_COMMITMENT_PARKED_PERCENT,
  accountCommitments,
  effectiveWindowLoad,
  limitsFromRow,
  paceDelta,
  rotateNearTie,
  runtimeCommitmentPercent,
  selectLeastLoadedAccount,
  windowRolledOver,
  type AccountLimits,
  type AutoAccountCandidate,
  type SelectableAccount,
} from "../src/index.ts";

function pickAccount(id: string, addedAt: string, penalty?: number): SelectableAccount {
  return { id, addedAt, ...(penalty !== undefined ? { penalty } : {}) };
}

function okLimits(weekly: number, fiveHour: number, resetsAt = "2026-06-10T18:00:00Z"): AccountLimits {
  return {
    ok: true,
    fiveHour: { usedPercent: fiveHour, windowMinutes: 300, resetsAt },
    weekly: { usedPercent: weekly, windowMinutes: 10_080, resetsAt },
  };
}

// old: "paceDelta compares used% against elapsed% of the window"
test("golden.1 paceDelta compares used% against elapsed% of the window", () => {
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
  // v2 addition: epoch-ms boundaries (the store shape) score identically to ISO strings.
  assert.equal(paceDelta({ ...hot, resetsAt: Date.parse(hot.resetsAt) }, now), paceDelta(hot, now));
});

// old: "effectiveWindowLoad adjusts used% by pace with diminishing weight near the wall"
test("golden.2 effectiveWindowLoad adjusts used% by pace with diminishing weight near the wall", () => {
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

// old: "windowRolledOver flags snapshots whose reset boundary has passed"
test("golden.3 windowRolledOver flags snapshots whose reset boundary has passed", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  assert.equal(windowRolledOver({ usedPercent: 14, resetsAt: "2026-06-10T11:59:00Z" }, now), true);
  assert.equal(windowRolledOver({ usedPercent: 14, resetsAt: "2026-06-10T12:01:00Z" }, now), false);
  assert.equal(windowRolledOver({ usedPercent: 14 }, now), false);
});

// old: "selectLeastLoadedAccount picks the least weekly usage"
test("golden.4 selectLeastLoadedAccount picks the least weekly usage", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits(60, 10) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(20, 50) },
      { account: pickAccount("c", "2026-01-03"), limits: okLimits(40, 5) },
    ],
    now,
  );
  assert.equal(choice?.account.id, "b");
  assert.match(choice?.reason ?? "", /behind pace/);
});

// old: "selectLeastLoadedAccount prefers an imminent reset with expiring surplus over lower raw usage"
test("golden.5 selectLeastLoadedAccount prefers an imminent reset with expiring surplus over lower raw usage", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // a: 70% used but its week resets in 1 day (86% elapsed) — 30% expires
  // unused if nobody burns it. b: only 40% used but 5 days from reset and
  // already ahead of pace. Pace says a.
  const withWeekly = (used: number, resetsAt: string): AccountLimits => ({
    ...okLimits(used, 10),
    weekly: { usedPercent: used, windowMinutes: 10_080, resetsAt },
  });
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: withWeekly(70, "2026-06-11T12:00:00Z") },
      { account: pickAccount("b", "2026-01-02"), limits: withWeekly(40, "2026-06-15T12:00:00Z") },
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
      { account: pickAccount("c", "2026-01-01"), limits: withWeekly(98, "2026-06-10T13:00:00Z") },
      { account: pickAccount("d", "2026-01-02"), limits: withWeekly(50, "2026-06-14T00:00:00Z") },
    ],
    now,
  );
  assert.equal(nearWall?.account.id, "d");

  // Boundary-less windows keep the old least-used behavior and reason.
  const noBoundary = (used: number): AccountLimits => ({ ok: true, weekly: { usedPercent: used } });
  const blind = selectLeastLoadedAccount(
    [
      { account: pickAccount("e", "2026-01-01"), limits: noBoundary(60) },
      { account: pickAccount("f", "2026-01-02"), limits: noBoundary(20) },
    ],
    now,
  );
  assert.equal(blind?.account.id, "f");
  assert.equal(blind?.reason, "least weekly usage");
});

// spec 08 §Selection point 3 — the operator's named case (new golden).
test("golden.5b operator's case: 30% weekly with 3h to reset beats 25% with 6 days to reset", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const soon = { ok: true, weekly: { usedPercent: 30, windowMinutes: 10_080, resetsAt: "2026-06-10T15:00:00Z" } };
  const far = { ok: true, weekly: { usedPercent: 25, windowMinutes: 10_080, resetsAt: "2026-06-16T12:00:00Z" } };
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("far", "2026-01-01"), limits: far }, // registered first: wins every tie-break
      { account: pickAccount("soon", "2026-01-02"), limits: soon },
    ],
    now,
  );
  assert.equal(choice?.account.id, "soon", "spend the tokens that are about to be destroyed");
  assert.match(choice?.reason ?? "", /behind pace — surplus expires at reset/);
  // The numbers behind it: soon is ~68 points behind pace (98% elapsed, 30%
  // used); far is ~11 points ahead (14% elapsed, 25% used).
  assert.ok(effectiveWindowLoad(soon.weekly, now) < -60);
  assert.ok(effectiveWindowLoad(far.weekly, now) > 10);
});

// old: "selectLeastLoadedAccount pushes 5h-saturated accounts behind ones with headroom"
test("golden.6 selectLeastLoadedAccount pushes 5h-saturated accounts behind ones with headroom", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // b has the lowest weekly but its 5h window is nearly exhausted.
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits(55, 30) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(10, 95) },
    ],
    now,
  );
  assert.equal(choice?.account.id, "a");

  // All saturated → least weekly among them, and the reason says why.
  const allHot = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits(55, 92) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(10, 95) },
    ],
    now,
  );
  assert.equal(allHot?.account.id, "b");
  assert.match(allHot?.reason ?? "", /5h limit/);
});

// old: "selectLeastLoadedAccount protects an almost-empty Fable allowance for Fable spawns"
test("golden.7 selectLeastLoadedAccount protects an almost-empty Fable allowance for Fable spawns", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const withFable = (weekly: number, fable: number, fableResetsAt?: string): AccountLimits => ({
    ok: true,
    fiveHour: { usedPercent: 10 },
    weekly: { usedPercent: weekly },
    fableWeekly: {
      usedPercent: fable,
      windowMinutes: 10_080,
      ...(fableResetsAt ? { resetsAt: fableResetsAt } : {}),
    },
  });
  const candidates = [
    // Generic auto prefers a. Its Fable allowance, however, has only 5% left
    // and is behind pace because it resets soon — exactly the unsafe case a
    // pure pace score would otherwise be tempted to burn.
    { account: pickAccount("a", "2026-01-01"), limits: withFable(10, 95, "2026-06-10T13:00:00Z") },
    { account: pickAccount("b", "2026-01-02"), limits: withFable(40, 70) },
  ];

  assert.equal(selectLeastLoadedAccount(candidates, now)?.account.id, "a", "non-Fable selection remains generic");
  const fable = selectLeastLoadedAccount(candidates, now, { model: "claude-fable-5" });
  assert.equal(fable?.account.id, "b");
  assert.match(fable?.reason ?? "", /Fable-aware/);

  const threshold = [
    { account: pickAccount("threshold", "2026-01-05"), limits: withFable(5, 75) },
    { account: pickAccount("below", "2026-01-06"), limits: withFable(40, 74) },
  ];
  assert.equal(
    selectLeastLoadedAccount(threshold, now, { model: "claude-fable-5" })?.account.id,
    "below",
    "75% Fable usage enters the protected down-priority tier",
  );

  // The scoped wall is additive, not a replacement for the general week: if
  // both choices are close to one of their two weekly caps, take the account
  // with more usable headroom across the pair.
  const competingWalls = [
    { account: pickAccount("c", "2026-01-03"), limits: withFable(99, 89) },
    { account: pickAccount("d", "2026-01-04"), limits: withFable(10, 91) },
  ];
  assert.equal(selectLeastLoadedAccount(competingWalls, now, { model: "Fable" })?.account.id, "d");
});

// old: "pickLeastLoadedAccount threads the requested Fable model into scoring" (selector-level half;
// the daemon-level half — `spawn --model FABLE` reaching options.model — lives in the daemon suite)
test("golden.8 the requested Fable model (any spelling) is threaded into scoring", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const candidates: AutoAccountCandidate[] = [
    { account: pickAccount("almost-empty", "2026-01-01"), limits: { ...okLimits(10, 10), fableWeekly: { usedPercent: 99 } } },
    { account: pickAccount("headroom", "2026-01-02"), limits: { ...okLimits(40, 10), fableWeekly: { usedPercent: 60 } } },
  ];
  assert.equal(selectLeastLoadedAccount(candidates, now, { model: "FABLE" })?.account.id, "headroom");
  assert.equal(selectLeastLoadedAccount(candidates, now)?.account.id, "almost-empty", "without a Fable model the general week decides");
});

// old: "selectLeastLoadedAccount applies a persistent per-account auto penalty"
test("golden.9 selectLeastLoadedAccount applies a persistent per-account auto penalty", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const preferred = pickAccount("gmail", "2026-01-01");
  const other = pickAccount("work", "2026-01-02");
  const base = [
    { account: preferred, limits: okLimits(10, 10) },
    { account: other, limits: okLimits(30, 10) },
  ];
  assert.equal(selectLeastLoadedAccount(base, now)?.account.id, "gmail");

  const penalized = [
    { ...base[0]!, account: { ...preferred, penalty: 25 } },
    base[1]!,
  ];
  assert.equal(selectLeastLoadedAccount(penalized, now)?.account.id, "work");

  const stillWins = selectLeastLoadedAccount([
    penalized[0]!,
    { account: other, limits: okLimits(80, 10) },
  ], now);
  assert.equal(stillWins?.account.id, "gmail");
  assert.match(stillWins?.reason ?? "", /\+25 account auto penalty/);
});

// old: "selectLeastLoadedAccount treats rolled-over windows as fresh and unreadable limits as last resort"
test("golden.10 selectLeastLoadedAccount treats rolled-over windows as fresh and unreadable limits as last resort", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // a's snapshot says 99% but its windows already reset → counts as 0%.
  // b's week just started (slightly ahead of pace), so fresh-a wins.
  const rolled = okLimits(99, 99, "2026-06-10T11:00:00Z");
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: rolled },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(5, 5, "2026-06-17T11:00:00Z") },
    ],
    now,
  );
  assert.equal(choice?.account.id, "a");

  // Readable-but-high beats unreadable; all unreadable → oldest registration.
  const failed: AccountLimits = { ok: false, error: "boom" };
  const mixed = selectLeastLoadedAccount(
    [
      { account: pickAccount("c", "2026-01-01"), limits: failed },
      { account: pickAccount("d", "2026-01-02"), limits: okLimits(97, 10) },
    ],
    now,
  );
  assert.equal(mixed?.account.id, "d");
  const blind = selectLeastLoadedAccount(
    [
      { account: pickAccount("e", "2026-01-02"), limits: failed },
      { account: pickAccount("c", "2026-01-01"), limits: failed },
    ],
    now,
  );
  assert.equal(blind?.account.id, "c");
  assert.match(blind?.reason ?? "", /unreadable/);
  // A missing limits row (never fetched) ranks with the unreadable ones.
  const missing = selectLeastLoadedAccount(
    [
      { account: pickAccount("g", "2026-01-02") },
      { account: pickAccount("h", "2026-01-03"), limits: okLimits(90, 10) },
    ],
    now,
  );
  assert.equal(missing?.account.id, "h");
});

// old: "sessionCommitmentPercent weighs busy/parked work and explicitly zeros completed or failed turns"
// REINTERPRETED for the v2 four-state model: booting/running = busy (old active/working),
// idle = parked (old ready/waiting/auth-needed/blocked/node_unreachable), stopped/none = 0
// (old dead/crashed/done/sealed/archived/retired/killed/error/kill_failed).
test("golden.11 runtimeCommitmentPercent weighs busy/parked work and zeros stopped runtimes", () => {
  assert.equal(runtimeCommitmentPercent("running"), AUTO_COMMITMENT_BUSY_PERCENT);
  assert.equal(runtimeCommitmentPercent("booting"), AUTO_COMMITMENT_BUSY_PERCENT);
  assert.equal(runtimeCommitmentPercent("idle"), AUTO_COMMITMENT_PARKED_PERCENT);
  assert.equal(runtimeCommitmentPercent("stopped"), 0);
  assert.equal(runtimeCommitmentPercent(null), 0);
  assert.equal(AUTO_COMMITMENT_BUSY_PERCENT, 8);
  assert.equal(AUTO_COMMITMENT_PARKED_PERCENT, 2);
});

// old: "accountCommitments sums per account and filters by tool" (the harness filter is the
// caller's — the daemon passes only this harness's bees; unbound bees contribute nothing)
test("golden.12 accountCommitments sums per account; unbound and stopped bees contribute nothing", () => {
  const totals = accountCommitments([
    { account: "a", runtimeState: "running" },
    { account: "a", runtimeState: "booting" },
    { account: "a", runtimeState: "idle" },
    { account: "b", runtimeState: "running" },
    { account: "b", runtimeState: "stopped" },
    { account: null, runtimeState: "running" },
    { account: "b", runtimeState: null },
  ]);
  assert.equal(totals.get("a"), 2 * AUTO_COMMITMENT_BUSY_PERCENT + AUTO_COMMITMENT_PARKED_PERCENT);
  assert.equal(totals.get("b"), AUTO_COMMITMENT_BUSY_PERCENT);
  assert.equal(totals.get("c"), undefined);
});

// old: "selectLeastLoadedAccount applies commitments to the score and reports near-ties"
test("golden.13 selectLeastLoadedAccount applies commitments to the score and reports near-ties", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  // b is emptier on provider numbers, but carries two busy bees.
  const steered = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits(20, 10) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(10, 10), commitment: 2 * AUTO_COMMITMENT_BUSY_PERCENT },
    ],
    now,
  );
  assert.equal(steered?.account.id, "a");
  // The winner's own commitment is named in the reason.
  const committed = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits(50, 10) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(10, 10), commitment: 5 },
    ],
    now,
  );
  assert.equal(committed?.account.id, "b");
  assert.match(committed?.reason ?? "", /\+5 in-flight/);
  // Equal effective loads are a near-tie group, winner first.
  const tied = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits(10, 10) },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(10, 10) },
      { account: pickAccount("c", "2026-01-03"), limits: okLimits(40, 10) },
    ],
    now,
  );
  assert.deepEqual(tied?.nearTieIds, ["a", "b"]);
});

// old: "pickLeastLoadedAccount spreads a same-instant burst instead of stacking one account (HIVE-80)"
// — the rotation half, as a pure function over the caller-held cursor (the store row in v2).
test("golden.14 near-tie rotation spreads a same-instant burst across the tie group", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");
  const candidates: AutoAccountCandidate[] = ["a", "b", "c"].map((id, i) => ({
    account: pickAccount(id, `2026-01-0${i + 1}`),
    limits: okLimits(10, 10),
  }));
  let cursor: string | null = null;
  const picks: string[] = [];
  // Four picks with identical provider numbers and an identical clock — the
  // burst that used to stack all four on one account.
  for (let i = 0; i < 4; i += 1) {
    const choice = selectLeastLoadedAccount(candidates, now)!;
    assert.deepEqual(choice.nearTieIds, ["a", "b", "c"]);
    const rotated = rotateNearTie(choice, candidates, cursor);
    cursor = rotated.cursor;
    picks.push(rotated.choice.account.id);
  }
  assert.deepEqual(picks, ["a", "b", "c", "a"]);
  assert.equal(new Set(picks.slice(0, 3)).size, 3, "first three picks spread");
  assert.equal(new Set(picks).size, 3, "four picks over three accounts reuse only one");
  // A rotated pick keeps the winner's limits + names the rotation.
  const second = rotateNearTie(selectLeastLoadedAccount(candidates, now)!, candidates, "a");
  assert.equal(second.choice.account.id, "b");
  assert.match(second.choice.reason, /near-tie rotation among 3 accounts/);
  assert.equal(second.choice.limits?.ok, true);
  // No tie group (or a singleton) → the winner stands, cursor untouched.
  const lone = rotateNearTie(
    selectLeastLoadedAccount([{ account: pickAccount("x", "2026-01-01"), limits: okLimits(10, 10) }, { account: pickAccount("y", "2026-01-02"), limits: okLimits(50, 10) }], now)!,
    candidates,
    "y",
  );
  assert.equal(lone.choice.account.id, "x");
  assert.equal(lone.cursor, null);
  // A cursor naming an account that left the group restarts at rank #1.
  assert.equal(rotateNearTie(selectLeastLoadedAccount(candidates, now)!, candidates, "gone").choice.account.id, "a");
});

// v2 glue: a stored limits row round-trips into the selector's window shape.
test("golden.15 limitsFromRow maps the store row onto the selector's AccountLimits", () => {
  const limits = limitsFromRow({
    readable: true,
    error: null,
    plan: "max",
    fiveHourPct: 12,
    fiveHourResetsAt: 1_000,
    fiveHourMinutes: 300,
    weeklyPct: 40,
    weeklyResetsAt: 2_000,
    weeklyMinutes: 10_080,
    fableWeeklyPct: null,
    fableResetsAt: null,
    fableMinutes: null,
  });
  assert.deepEqual(limits, {
    ok: true,
    plan: "max",
    fiveHour: { usedPercent: 12, resetsAt: 1_000, windowMinutes: 300 },
    weekly: { usedPercent: 40, resetsAt: 2_000, windowMinutes: 10_080 },
  });
  const failed = limitsFromRow({
    readable: false, error: "HTTP 401", plan: null,
    fiveHourPct: null, fiveHourResetsAt: null, fiveHourMinutes: null,
    weeklyPct: null, weeklyResetsAt: null, weeklyMinutes: null,
    fableWeeklyPct: null, fableResetsAt: null, fableMinutes: null,
  });
  assert.deepEqual(failed, { ok: false, error: "HTTP 401" });
  // Epoch-ms boundaries score exactly like the old ISO strings.
  const now = Date.parse("2026-06-10T12:00:00Z");
  const iso: AccountLimits = okLimits(70, 10, "2026-06-11T12:00:00Z");
  const ms = limitsFromRow({
    readable: true, error: null, plan: null,
    fiveHourPct: 10, fiveHourResetsAt: Date.parse("2026-06-11T12:00:00Z"), fiveHourMinutes: 300,
    weeklyPct: 70, weeklyResetsAt: Date.parse("2026-06-11T12:00:00Z"), weeklyMinutes: 10_080,
    fableWeeklyPct: null, fableResetsAt: null, fableMinutes: null,
  });
  assert.equal(effectiveWindowLoad(ms.weekly!, now), effectiveWindowLoad(iso.weekly!, now));
});
