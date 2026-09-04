/**
 * Spec 08 test 4 — the GOLDEN selection suite, ported from the old
 * tests/limits.test.ts against src/accountSelect.ts. Each test names the old
 * test it came from. Reinterpretations are called out inline (the commitment
 * weights map old session states onto the v2 four-state model; the cursor
 * rotation is a pure function over a caller-held cursor instead of a json
 * file). Revision 2026-09-02 (the THTO herd): the pace credit is capped, the
 * 5h window is a gradient, weekly/Fable reserve lines are classes regardless
 * of time-to-reset, and windows are projected forward by velocity — three
 * old expectations moved and are annotated where they did. Pure — no store,
 * no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_BEE_BURN_PER_HOUR,
  AUTO_COMMITMENT_BUSY_PERCENT,
  AUTO_COMMITMENT_PARKED_PERCENT,
  AUTO_FIVE_HOUR_SATURATION_PERCENT,
  AUTO_PACE_CREDIT_CAP_PERCENT,
  AUTO_PICK_DEBIT_PERCENT,
  AUTO_PICK_DEBIT_TTL_MS,
  AUTO_WEEKLY_SATURATION_PERCENT,
  accountActiveBees,
  accountCommitments,
  decayedPickDebit,
  effectiveWindowLoad,
  limitsFromRow,
  measureWindowVelocity,
  paceDelta,
  pendingPickDebit,
  projectWindow,
  prunePendingPicks,
  rotateNearTie,
  runtimeCommitmentPercent,
  selectLeastLoadedAccount,
  windowRolledOver,
  windowVelocityPerHour,
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
  // MOVED 2026-09-02: b has the least weekly usage but its 5h window is 50%
  // used with the whole window ahead of it (the shared reset is 6h out, so
  // 0% elapsed) — a hot short window is now a gradient penalty, not a free
  // ride below the old 90% gate. c (40% weekly, 5% 5h) is the sane landing.
  assert.equal(choice?.account.id, "c");
  assert.match(choice?.reason ?? "", /behind pace/);
  assert.match(choice?.reason ?? "", /5h 5 ahead of pace/);
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
  // MOVED 2026-09-02: the pace credit is capped at AUTO_PACE_CREDIT_CAP_PERCENT,
  // so a's 30 expiring points are worth 25 at most and raw usage decides:
  // 70 − 25 = 45 vs 40 − 25 = 15. An imminent reset is a preference, not a
  // magnet (the operator's other threads on a need the headroom more than a
  // fresh bee needs the surplus). golden.5b below keeps the case where the
  // surplus DOES decide — usage nearly equal, reset imminent.
  assert.equal(choice?.account.id, "b");
  assert.match(choice?.reason ?? "", /ahead of pace/);
  assert.equal(effectiveWindowLoad(withWeekly(70, "2026-06-11T12:00:00Z").weekly!, now, { paceCreditCap: AUTO_PACE_CREDIT_CAP_PERCENT }), 45);

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
    // (60, not the old 70: 70 + one Fable bee's expected 7 crosses the 75 reserve → projected-overrun tier, golden.19)
    { account: pickAccount("b", "2026-01-02"), limits: withFable(40, 60) },
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
  // 2026-09-02: the row's fetchedAt and the daemon's measured velocities ride along.
  const measured = limitsFromRow({
    readable: true, error: null, plan: null, fetchedAt: 5_000,
    fiveHourPct: 39, fiveHourResetsAt: 1_000, fiveHourMinutes: 300,
    weeklyPct: 10, weeklyResetsAt: 2_000, weeklyMinutes: 10_080,
    fableWeeklyPct: 20, fableResetsAt: 2_000, fableMinutes: 10_080,
  }, { fiveHour: 40, weekly: null, fableWeekly: 6.5 });
  assert.equal(measured.fetchedAt, 5_000);
  assert.equal(measured.fiveHour?.velocityPerHour, 40);
  assert.equal(measured.weekly?.velocityPerHour, undefined, "null = no measurement (window rolled over between reads)");
  assert.equal(measured.fableWeekly?.velocityPerHour, 6.5);
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

// ---------------------------------------------------------------------------
// 2026-09-02 — the THTO herd. Four Fable picks in one hour all landed on the
// account whose 5h window went 4% → 93%, each one "correct" under the old
// model. These pin the terms that stop it.
// ---------------------------------------------------------------------------

const T = Date.parse("2026-09-02T09:10:00Z");
const hours = (n: number) => new Date(T + n * 60 * 60 * 1000).toISOString();
const claudeLimits = (
  spec: { weekly: number; fable: number; fiveHour: number; weeklyResetsInHours: number; fiveHourResetsInHours: number },
  extra: Partial<AccountLimits> = {},
): AccountLimits => ({
  ok: true,
  fiveHour: { usedPercent: spec.fiveHour, windowMinutes: 300, resetsAt: hours(spec.fiveHourResetsInHours) },
  weekly: { usedPercent: spec.weekly, windowMinutes: 10_080, resetsAt: hours(spec.weeklyResetsInHours) },
  fableWeekly: { usedPercent: spec.fable, windowMinutes: 10_080, resetsAt: hours(spec.weeklyResetsInHours) },
  ...extra,
});

test("herd.1 the 09:10 pick: a hot 5h window loses to an idle account even when its week is about to reset", () => {
  // thto: 94% into its week with 10% used (old score −84 + 16 in-flight),
  // 5h 39% at 20% elapsed. kontrol: mid-week, 0% everywhere.
  const thto = claudeLimits({ weekly: 10, fable: 20, fiveHour: 39, weeklyResetsInHours: 9.5, fiveHourResetsInHours: 4 });
  const kontrol = claudeLimits({ weekly: 0, fable: 0, fiveHour: 0, weeklyResetsInHours: 89, fiveHourResetsInHours: 4.9 });
  const candidates: AutoAccountCandidate[] = [
    { account: pickAccount("thto", "2026-01-01"), limits: thto, commitment: 16, activeBees: 2 },
    { account: pickAccount("kontrol", "2026-01-02"), limits: kontrol },
  ];
  const fable = selectLeastLoadedAccount(candidates, T, { model: "fable" });
  assert.equal(fable?.account.id, "kontrol");
  assert.deepEqual(fable?.nearTieIds, ["kontrol"], "not a near-tie: thto is projected to cross its 5h line within the hour");
  // The 5h window alone (39% at 20% elapsed → +19 ahead of pace) already
  // outweighs the capped weekly credit; the projection makes it a class.
  assert.ok(effectiveWindowLoad(thto.fiveHour!, T) > 18);
  const projected = projectWindow(thto.fiveHour!, "fiveHour", T, { activeBees: 2 });
  assert.ok(projected.projected >= AUTO_FIVE_HOUR_SATURATION_PERCENT, `projected ${projected.projected}`);
  // Same picture without any in-flight knowledge: still kontrol.
  const cold = selectLeastLoadedAccount(candidates.map((c) => ({ account: c.account, limits: c.limits })), T, { model: "fable" });
  assert.equal(cold?.account.id, "kontrol");
});

test("herd.2 the pace credit is capped: late-week surplus is worth at most 25 points, so commitments can outweigh it", () => {
  const late = { ok: true, weekly: { usedPercent: 17, windowMinutes: 10_080, resetsAt: hours(9.5) } };
  const mid = { ok: true, weekly: { usedPercent: 0, windowMinutes: 10_080, resetsAt: hours(89) } };
  // Old model: late −77 vs mid −47 → late by 30, unbeatable. New: −8 vs −25.
  assert.equal(Math.round(effectiveWindowLoad(late.weekly, T, { paceCreditCap: AUTO_PACE_CREDIT_CAP_PERCENT })), -8);
  assert.equal(Math.round(effectiveWindowLoad(mid.weekly, T, { paceCreditCap: AUTO_PACE_CREDIT_CAP_PERCENT })), -25);
  assert.equal(Math.round(effectiveWindowLoad(late.weekly, T)), -77, "the uncapped pace delta is unchanged");
  const idle = selectLeastLoadedAccount(
    [
      { account: pickAccount("late", "2026-01-01"), limits: late },
      { account: pickAccount("mid", "2026-01-02"), limits: mid },
    ],
    T,
  );
  assert.equal(idle?.account.id, "mid");
  // Three busy bees on mid (+24) now flip it back — the credit is a preference of bee-scale.
  const loaded = selectLeastLoadedAccount(
    [
      { account: pickAccount("late", "2026-01-01"), limits: late },
      { account: pickAccount("mid", "2026-01-02"), limits: mid, commitment: 3 * AUTO_COMMITMENT_BUSY_PERCENT, activeBees: 3 },
    ],
    T,
  );
  assert.equal(loaded?.account.id, "late");
});

test("herd.3 the weekly reserve is a class regardless of time-to-reset: 93% with an hour left loses to 84% mid-week", () => {
  const nearlyDone = { ok: true, weekly: { usedPercent: 93, windowMinutes: 10_080, resetsAt: hours(1) } };
  const midWeek = { ok: true, weekly: { usedPercent: 84, windowMinutes: 10_080, resetsAt: hours(84) } };
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("nearly-done", "2026-01-01"), limits: nearlyDone },
      { account: pickAccount("mid-week", "2026-01-02"), limits: midWeek },
    ],
    T,
  );
  assert.equal(choice?.account.id, "mid-week");
  assert.equal(AUTO_WEEKLY_SATURATION_PERCENT, 85);
  // A general-weekly reserve applies to plain picks too (it used to be a Fable-only tier at 90).
  const allPast = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: nearlyDone },
      { account: pickAccount("b", "2026-01-02"), limits: { ok: true, weekly: { usedPercent: 86, windowMinutes: 10_080, resetsAt: hours(84) } } },
    ],
    T,
  );
  assert.equal(allPast?.account.id, "b");
  assert.match(allPast?.reason ?? "", /past its weekly reserve/);
});

test("herd.4 projection: a bee that would push a window over its reserve within the hour is a down-tier class", () => {
  const fiveHour = (usedPercent: number, velocityPerHour?: number): AccountLimits => ({
    ok: true,
    fiveHour: { usedPercent, windowMinutes: 300, resetsAt: hours(2.5), ...(velocityPerHour !== undefined ? { velocityPerHour } : {}) },
    weekly: { usedPercent: 10, windowMinutes: 10_080, resetsAt: hours(84) },
  });
  // Measured velocity: a is emptier (50 vs 55) but burning 35/h → 50 + (35 + 20) = 105.
  const measured = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: fiveHour(50, 35) },
      { account: pickAccount("b", "2026-01-02"), limits: fiveHour(55, 0) },
    ],
    T,
  );
  assert.equal(measured?.account.id, "b");
  assert.deepEqual(measured?.nearTieIds, ["b"]);
  // No measurement: busy bees stand in (3 × 20/h) — a 30% window with three
  // workers on it is projected to 110; a 40% idle window (average 16/h) to 76.
  const estimated = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: fiveHour(30), activeBees: 3 },
      { account: pickAccount("b", "2026-01-02"), limits: fiveHour(40) },
    ],
    T,
  );
  assert.equal(estimated?.account.id, "b");
  assert.equal(windowVelocityPerHour(fiveHour(30).fiveHour!, "fiveHour", T, 3), 3 * AUTO_BEE_BURN_PER_HOUR.fiveHour);
  assert.equal(windowVelocityPerHour(fiveHour(40).fiveHour!, "fiveHour", T, 0), 16, "average rate: 40 points over 2.5 elapsed hours");
  // Everyone projected over → least overshoot, and the reason says so.
  const allOver = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: fiveHour(50, 35) },
      { account: pickAccount("b", "2026-01-02"), limits: fiveHour(70, 0) },
    ],
    T,
  );
  assert.equal(allOver?.account.id, "b", "70 + 20 = 90 overshoots by 10; 105 by 25");
  assert.match(allOver?.reason ?? "", /projected to cross a limit within the hour; least overshoot \(\+10\)/);
  // The horizon is clipped to the reset: 30 minutes left → half an hour of burn.
  const soon = projectWindow({ usedPercent: 60, windowMinutes: 300, resetsAt: hours(0.5), velocityPerHour: 40 }, "fiveHour", T);
  assert.equal(soon.horizonHours, 0.5);
  assert.equal(soon.projected, 60 + (40 + 20) * 0.5);
  // A rolled-over window projects from zero.
  assert.equal(projectWindow({ usedPercent: 99, windowMinutes: 300, resetsAt: hours(-1) }, "fiveHour", T).projected, AUTO_BEE_BURN_PER_HOUR.fiveHour);
});

test("herd.5 a stale snapshot is aged forward by its velocity before saturation and scoring", () => {
  // 39% read 30 minutes ago at 40/h is 59% now; projected 59 + 60 = 119.
  const aged = projectWindow(
    { usedPercent: 39, windowMinutes: 300, resetsAt: hours(3), velocityPerHour: 40 },
    "fiveHour",
    T,
    { fetchedAt: T - 30 * 60_000 },
  );
  assert.equal(aged.usedNow, 59);
  assert.equal(aged.projected, 119);
  // Aging is capped at the horizon and never exceeds 100.
  assert.equal(projectWindow({ usedPercent: 90, windowMinutes: 300, resetsAt: hours(3), velocityPerHour: 40 }, "fiveHour", T, { fetchedAt: T - 3 * 60 * 60_000 }).usedNow, 100);
  // Class order: a's 70% read half an hour ago at 30/h is 85% NOW (saturated);
  // b's fresh 75% is merely projected over (75 + 20 = 95). Saturated is worse.
  const choice = selectLeastLoadedAccount(
    [
      {
        account: pickAccount("a", "2026-01-01"),
        limits: { ok: true, fetchedAt: T - 30 * 60_000, fiveHour: { usedPercent: 70, windowMinutes: 300, resetsAt: hours(3), velocityPerHour: 30 } },
      },
      {
        account: pickAccount("b", "2026-01-02"),
        limits: { ok: true, fetchedAt: T, fiveHour: { usedPercent: 75, windowMinutes: 300, resetsAt: hours(3), velocityPerHour: 0 } },
      },
    ],
    T,
  );
  assert.equal(choice?.account.id, "b");
});

test("herd.6 rate-limit exhaustion evidence is a class below every non-exhausted account", () => {
  const choice = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits(10, 10), exhausted: true },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(60, 10) },
    ],
    Date.parse("2026-06-10T12:00:00Z"),
  );
  assert.equal(choice?.account.id, "b");
  const all = selectLeastLoadedAccount(
    [
      { account: pickAccount("a", "2026-01-01"), limits: okLimits(10, 10), exhausted: true },
      { account: pickAccount("b", "2026-01-02"), limits: okLimits(60, 10), exhausted: true },
    ],
    Date.parse("2026-06-10T12:00:00Z"),
  );
  assert.equal(all?.account.id, "a");
  assert.match(all?.reason ?? "", /exhaustion evidence/);
});

test("herd.7 pick debits decay linearly over the ttl and prune when spent", () => {
  const at = T;
  assert.equal(decayedPickDebit({ at, percent: AUTO_PICK_DEBIT_PERCENT }, at), 10);
  assert.equal(decayedPickDebit({ at, percent: 10 }, at + AUTO_PICK_DEBIT_TTL_MS / 2), 5);
  assert.equal(decayedPickDebit({ at, percent: 10 }, at + AUTO_PICK_DEBIT_TTL_MS), 0);
  assert.equal(decayedPickDebit({ at: at + 60_000, percent: 10 }, at), 10, "a future stamp (skewed clock) counts as fresh");
  assert.equal(decayedPickDebit({ at, percent: 0 }, at), 0);
  const picks = [{ at, percent: 10 }, { at: at - AUTO_PICK_DEBIT_TTL_MS / 2, percent: 10 }, { at: at - AUTO_PICK_DEBIT_TTL_MS, percent: 10 }];
  assert.equal(pendingPickDebit(picks, at), 15);
  assert.deepEqual(prunePendingPicks(picks, at), picks.slice(0, 2));
  // Two same-instant picks over equal accounts: the second sees the first's debit and goes elsewhere.
  const equal = (id: string, i: number, commitment = 0): AutoAccountCandidate => ({ account: pickAccount(id, `2026-01-0${i}`), limits: okLimits(10, 10), commitment });
  const first = selectLeastLoadedAccount([equal("a", 1), equal("b", 2)], at)!;
  assert.equal(first.account.id, "a");
  const second = selectLeastLoadedAccount([equal("a", 1, AUTO_PICK_DEBIT_PERCENT), equal("b", 2)], at)!;
  assert.equal(second.account.id, "b");
  assert.deepEqual(second.nearTieIds, ["b"], "a debit of 10 is outside the 3-point tie band");
});

test("herd.8 velocity is measured only between comparable snapshots of the same window", () => {
  const prev = { usedPercent: 39, resetsAt: T + 3 * 60 * 60_000, fetchedAt: T };
  const later = T + 30 * 60_000;
  assert.equal(measureWindowVelocity(prev, { usedPercent: 59, resetsAt: prev.resetsAt, fetchedAt: later }), 40);
  assert.equal(measureWindowVelocity(prev, { usedPercent: 59, resetsAt: prev.resetsAt + 400, fetchedAt: later }), 40, "providers jitter the boundary by ms");
  assert.equal(measureWindowVelocity(prev, { usedPercent: 2, resetsAt: prev.resetsAt + 5 * 60 * 60_000, fetchedAt: later }), null, "a new window");
  assert.equal(measureWindowVelocity(prev, { usedPercent: 2, resetsAt: prev.resetsAt, fetchedAt: later }), null, "used% fell: rolled over between reads");
  assert.equal(measureWindowVelocity(prev, { usedPercent: 40, resetsAt: prev.resetsAt, fetchedAt: T + 60_000 }), null, "too close to divide by");
  assert.equal(measureWindowVelocity({ ...prev, resetsAt: null }, { usedPercent: 59, resetsAt: null, fetchedAt: later }), null, "no boundary, no window identity");
  assert.equal(measureWindowVelocity(prev, { usedPercent: 39, resetsAt: prev.resetsAt, fetchedAt: later }), 0, "idle is a measurement too");
});

test("herd.9 accountActiveBees counts busy runtimes only", () => {
  const counts = accountActiveBees([
    { account: "a", runtimeState: "running" },
    { account: "a", runtimeState: "booting" },
    { account: "a", runtimeState: "idle" },
    { account: "b", runtimeState: "stopped" },
    { account: null, runtimeState: "running" },
  ]);
  assert.equal(counts.get("a"), 2);
  assert.equal(counts.get("b"), undefined);
});
