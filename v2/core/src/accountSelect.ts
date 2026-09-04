/**
 * Account selection — the `auto` model (spec 08 "Selection"), pure: no I/O,
 * no clock of its own (callers pass `now`), no store. The daemon feeds it
 * account rows + limits rows (+ measured burn velocities) + live-bee
 * commitments + pending pick debits and enacts the pick; the golden tests in
 * tests/account-select.test.ts pin the picks.
 *
 * Revision 2026-09-02 (the THTO herd): the original model ranked almost
 * entirely on pace-adjusted WEEKLY load, and the 5h window only mattered as a
 * binary "≥90% saturated" gate. An account late in its weekly cycle with low
 * usage scored −60…−85 ("surplus expires at reset"), which no +8-per-bee
 * commitment could offset, so every Fable spawn stacked onto it until its 5h
 * window hit the wall (4% → 93% in one hour, four picks, all "correct").
 * The model now:
 *  - caps the pace credit (an imminent reset is a preference, not a magnet);
 *  - scores the 5h window as a gradient (ahead-of-pace 5h burn is a penalty);
 *  - treats a weekly/Fable window past its RESERVE line as a down-tier class
 *    regardless of time-to-reset — the operator has other threads on that
 *    account and would rather wait for nothing than for the reset;
 *  - projects each window forward: measured (or estimated) burn velocity plus
 *    the new bee's expected burn over the next hour. A spawn projected to push
 *    any window over its reserve is a down-tier class too;
 *  - ages a stale snapshot forward by the measured velocity before all of the
 *    above, so a 15-minute-old 39% is scored as what it is now.
 */

/** A provider usage window: used% plus the boundary/length pace needs. */
export type WindowUsage = {
  usedPercent: number;
  /** Reset boundary — ISO string (old shape) or epoch ms (store shape). */
  resetsAt?: string | number | null;
  /** Window length, when known (claude: implied 300/10080; codex: from the snapshot). */
  windowMinutes?: number | null;
  /**
   * Measured burn in window points per hour (≥0), when the daemon has two
   * comparable snapshots of this window. Absent/null → estimated from the
   * account's active bees and the window's average rate.
   */
  velocityPerHour?: number | null;
};

/** The limits snapshot the selector ranks on (the old AccountLimits, minus transport fields). */
export type AccountLimits = {
  ok: boolean;
  error?: string;
  fiveHour?: WindowUsage;
  weekly?: WindowUsage;
  /** Weekly window scoped to Fable — the plan's included Fable usage (claude only). */
  fableWeekly?: WindowUsage;
  plan?: string;
  /** Snapshot time (epoch ms). Lets the selector age used% forward by velocity. */
  fetchedAt?: number | null;
};

/** The account facts the selector needs (a subset of the store's AccountRow). */
export type SelectableAccount = {
  id: string;
  /** Registration time — ISO string (old shape) or epoch ms (store shape); the deterministic tie-break. */
  addedAt: string | number;
  /** Persistent operator penalty in effective-load points (the old `autoPickPenalty`). */
  penalty?: number;
};

export type WindowKind = "fiveHour" | "weekly" | "fableWeekly";

const HOUR_MS = 60 * 60 * 1000;

function resetMsOf(window: WindowUsage): number | null {
  if (window.resetsAt === undefined || window.resetsAt === null) return null;
  const ms = typeof window.resetsAt === "number" ? window.resetsAt : Date.parse(window.resetsAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Elapsed share of the window in percent, or null when the boundary/length is unknown or passed. */
export function elapsedPercent(window: WindowUsage, now = Date.now()): number | null {
  if (!window.resetsAt || !window.windowMinutes) return null;
  const resetMs = resetMsOf(window);
  if (resetMs === null || resetMs <= now) return null;
  const durationMs = window.windowMinutes * 60_000;
  return Math.min(100, Math.max(0, ((durationMs - (resetMs - now)) / durationMs) * 100));
}

/** Hours until the window resets, or null when the boundary is unknown or passed. */
export function remainingHours(window: WindowUsage, now = Date.now()): number | null {
  const resetMs = resetMsOf(window);
  if (resetMs === null || resetMs <= now) return null;
  return (resetMs - now) / HOUR_MS;
}

/**
 * Pace: used% minus elapsed% of the window. Positive = burning faster than
 * the window refills (on track to exhaust before reset); negative = headroom.
 * Null when the window boundary is unknown or already passed.
 */
export function paceDelta(window: WindowUsage, now = Date.now()): number | null {
  const elapsed = elapsedPercent(window, now);
  return elapsed === null ? null : window.usedPercent - elapsed;
}

/** True when the snapshot's window boundary has passed — its used% no longer applies. */
export function windowRolledOver(window: WindowUsage, now = Date.now()): boolean {
  if (!window.resetsAt) return false;
  const resetMs = resetMsOf(window);
  return resetMs !== null && resetMs <= now;
}

// ---------------------------------------------------------------------------
// thresholds
// ---------------------------------------------------------------------------

/**
 * A 5h window at/above this used% (after aging the snapshot forward) is a
 * wall for scheduling purposes: the account sorts behind every account with
 * 5h headroom, whatever its weekly picture. Was 90; a Fable burst moves a 5h
 * window ~20 points per bee-hour, so 90 left no room to steer.
 */
export const AUTO_FIVE_HOUR_SATURATION_PERCENT = 80;

/**
 * The weekly RESERVE line. At/above this used% the account is a down-tier
 * class regardless of how soon the window resets: the operator has other
 * threads on the account that must keep working, and 93% with an hour left
 * is exactly where an extra bee turns into 99% and a 45-minute wait.
 */
export const AUTO_WEEKLY_SATURATION_PERCENT = 85;

/**
 * Fable is protected earlier than the general weekly allowance: at/above 75%
 * used, an account with scoped headroom wins even when pace says the Fable
 * allowance is behind pace and about to reset.
 */
export const AUTO_FABLE_WEEKLY_SATURATION_PERCENT = 75;

/**
 * Headroom below which pace stops mattering. An account behind pace but with
 * almost nothing left (98% used, resets in an hour) would win a pure pace
 * contest yet blow through its remaining 2% long before the reset — so
 * pace's weight fades linearly to zero as headroom drops below this
 * threshold, letting raw used% dominate near the wall.
 */
export const AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT = 25;

/**
 * Cap on the pace CREDIT a weekly window earns for being behind pace. Pace
 * credit is elapsed% of the window (an account 94% into its week with 17%
 * used has 77 points of "surplus that expires"). Uncapped, that dwarfed the
 * +8-per-bee commitments and made the account a magnet. Capped at 25, an
 * imminent reset is worth about three busy bees — a preference, not a wall.
 */
export const AUTO_PACE_CREDIT_CAP_PERCENT = 25;

/** How far ahead the projection looks: the near future we can actually predict. */
export const AUTO_PROJECTION_HORIZON_MS = HOUR_MS;

/**
 * Expected burn of ONE newly spawned bee over the projection horizon, in
 * window points per hour, per window. Calibrated on the 2026-09-02 THTO
 * incident (3–4 Fable bees, one hour: 5h +77, weekly +12, Fable +23) with a
 * conservative round-up; the operator wants headroom protected, not spent.
 */
export const AUTO_BEE_BURN_PER_HOUR: Readonly<Record<WindowKind, number>> = {
  fiveHour: 20,
  weekly: 4,
  fableWeekly: 7,
};

/** A window's average rate (used% / elapsed hours) is meaningless in its first minutes. */
export const AUTO_AVERAGE_RATE_MIN_ELAPSED_HOURS = 0.25;

/**
 * Candidates whose score lands within this many points of the winner's are
 * near-ties: provider-reported usage is too coarse to prefer one over the
 * other, so the pick rotates among them (HIVE-80) instead of always
 * hammering rank #1.
 */
export const AUTO_TIE_EPSILON_PERCENT = 3;

// ---------------------------------------------------------------------------
// window math
// ---------------------------------------------------------------------------

export type EffectiveLoadOptions = {
  /** Cap the pace credit (elapsed%) at this many points; undefined = uncapped. */
  paceCreditCap?: number;
};

/**
 * Effective load of a window (lower = better). Raw used% minus a pace credit
 * for how far into the window we are: an account behind pace holds unused
 * quota that expires at reset, so it scores lower (burn its surplus first);
 * an account ahead of pace is on track to exhaust early, so it scores
 * higher. Uncapped, the result is exactly the pace delta (used% − elapsed%).
 * With `paceCreditCap` the credit is bounded, so raw usage dominates once the
 * window is well under way. Pace's influence is weighted by remaining
 * headroom (see AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT) so a nearly-exhausted
 * window never wins on pace alone. Falls back to raw used% when the window
 * boundary is unknown; a rolled-over window is fresh (0).
 */
export function effectiveWindowLoad(window: WindowUsage, now = Date.now(), options: EffectiveLoadOptions = {}): number {
  if (windowRolledOver(window, now)) return 0;
  const used = window.usedPercent;
  const elapsed = elapsedPercent(window, now);
  if (elapsed === null) return used;
  const credit = options.paceCreditCap === undefined ? elapsed : Math.min(elapsed, options.paceCreditCap);
  const adjusted = used - credit;
  const headroom = Math.max(0, 100 - used);
  const paceWeight = Math.min(1, headroom / AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT);
  return paceWeight * adjusted + (1 - paceWeight) * used;
}

/**
 * The window's burn velocity in points per hour: the measured value when the
 * daemon has one, else the larger of (a) what `activeBees` busy bees are
 * expected to burn and (b) the window's own average rate so far. (b) is what
 * catches a hot 5h window before the bee count does; (a) is what catches a
 * fresh window the bees have not shown up in yet.
 */
export function windowVelocityPerHour(window: WindowUsage, kind: WindowKind, now = Date.now(), activeBees = 0): number {
  const measured = window.velocityPerHour;
  if (typeof measured === "number" && Number.isFinite(measured) && measured >= 0) return measured;
  const beeRate = Math.max(0, activeBees) * AUTO_BEE_BURN_PER_HOUR[kind];
  const elapsed = elapsedPercent(window, now);
  let average = 0;
  if (elapsed !== null && window.windowMinutes) {
    const elapsedHours = (elapsed / 100) * (window.windowMinutes / 60);
    if (elapsedHours >= AUTO_AVERAGE_RATE_MIN_ELAPSED_HOURS) average = Math.max(0, window.usedPercent) / elapsedHours;
  }
  return Math.max(beeRate, average);
}

export type WindowProjection = {
  /** The snapshot aged forward to `now` by its velocity (0 for a rolled-over window). */
  usedNow: number;
  /** used% expected at the end of the horizon if this bee lands here. */
  projected: number;
  /** The velocity used (points per hour, before the new bee). */
  velocityPerHour: number;
  /** Hours the projection actually covered (the horizon, or less when the reset is sooner). */
  horizonHours: number;
};

export type ProjectionOptions = {
  /** Busy bees already bound to the account (velocity estimate fallback). */
  activeBees?: number;
  /** Snapshot time; used% is aged forward by velocity × age (age capped at the horizon). */
  fetchedAt?: number | null;
};

/**
 * Project a window forward: age the snapshot to `now`, then add the current
 * velocity plus one new bee's expected burn over the projection horizon
 * (clipped to the time left before the reset). Pure.
 */
export function projectWindow(window: WindowUsage, kind: WindowKind, now = Date.now(), options: ProjectionOptions = {}): WindowProjection {
  const remaining = remainingHours(window, now);
  const horizonHours = remaining === null ? AUTO_PROJECTION_HORIZON_MS / HOUR_MS : Math.min(AUTO_PROJECTION_HORIZON_MS / HOUR_MS, Math.max(0, remaining));
  if (windowRolledOver(window, now)) {
    return { usedNow: 0, projected: AUTO_BEE_BURN_PER_HOUR[kind] * horizonHours, velocityPerHour: 0, horizonHours };
  }
  const velocityPerHour = windowVelocityPerHour(window, kind, now, options.activeBees ?? 0);
  const fetchedAt = options.fetchedAt;
  const ageHours = typeof fetchedAt === "number" && Number.isFinite(fetchedAt)
    ? Math.min(AUTO_PROJECTION_HORIZON_MS / HOUR_MS, Math.max(0, (now - fetchedAt) / HOUR_MS))
    : 0;
  const usedNow = Math.min(100, Math.max(0, window.usedPercent) + velocityPerHour * ageHours);
  const projected = usedNow + (velocityPerHour + AUTO_BEE_BURN_PER_HOUR[kind]) * horizonHours;
  return { usedNow, projected, velocityPerHour, horizonHours };
}

/**
 * Measure a window's velocity from two snapshots of the SAME window (reset
 * boundaries within five minutes of each other — providers jitter the
 * boundary by milliseconds between reads). Null when the window rolled over
 * between the snapshots, the snapshots are too close to divide by, or either
 * lacks a boundary. Never negative.
 */
export function measureWindowVelocity(
  previous: { usedPercent: number; resetsAt: number | null; fetchedAt: number },
  next: { usedPercent: number; resetsAt: number | null; fetchedAt: number },
  minIntervalMs = 2 * 60_000,
): number | null {
  if (previous.resetsAt === null || next.resetsAt === null) return null;
  if (Math.abs(previous.resetsAt - next.resetsAt) > 5 * 60_000) return null;
  const dtMs = next.fetchedAt - previous.fetchedAt;
  if (!(dtMs >= minIntervalMs)) return null;
  const delta = next.usedPercent - previous.usedPercent;
  if (delta < 0) return null; // the window rolled over between reads
  return delta / (dtMs / HOUR_MS);
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

export type AutoAccountCandidate = {
  account: SelectableAccount;
  limits?: AccountLimits;
  /**
   * Locally-known load the provider can't see yet, in effective-load points:
   * commitment penalty for live bees + decaying pick debits. Added to the
   * score — including for limits-unreadable accounts, where it is the only
   * signal separating them.
   */
  commitment?: number;
  /** Busy bees (running/booting, plus fresh picks not yet booted) bound to the account — velocity fallback. */
  activeBees?: number;
  /** The provider rejected a turn on this account for rate-limit reasons within the cool-off. */
  exhausted?: boolean;
};

export type AutoAccountChoice = {
  account: SelectableAccount;
  /** The winning account's limits, when they were readable. */
  limits?: AccountLimits;
  /** Why this account won, for display. */
  reason: string;
  /**
   * Winner-first account ids scoring within AUTO_TIE_EPSILON_PERCENT of the
   * winner (same readable/saturated/projection class). Length > 1 means the
   * caller may rotate among them without meaningfully worsening the pick.
   */
  nearTieIds: string[];
};

export type AutoAccountSelectionOptions = {
  /** Effective model for the bee being spawned (for model-scoped limits). */
  model?: string;
};

/** Claude's provider model ids currently spell the scoped allowance as Fable. */
export function isFableModel(model: string | undefined): boolean {
  return typeof model === "string" && /(?:^|[-_/])fable(?:[-_/]|$)/i.test(model);
}

function compareAddedAt(a: SelectableAccount, b: SelectableAccount): number {
  if (typeof a.addedAt === "number" && typeof b.addedAt === "number") return a.addedAt - b.addedAt;
  return String(a.addedAt).localeCompare(String(b.addedAt));
}

/** The reserve line each window is measured against. */
function reserveOf(kind: WindowKind): number {
  return kind === "fiveHour"
    ? AUTO_FIVE_HOUR_SATURATION_PERCENT
    : kind === "weekly"
      ? AUTO_WEEKLY_SATURATION_PERCENT
      : AUTO_FABLE_WEEKLY_SATURATION_PERCENT;
}

type ScoredWindow = {
  /** The window aged to `now` (usedPercent = usedNow). */
  aged: WindowUsage;
  projection: WindowProjection;
  /** Points the projection lands past the reserve line (≥0). */
  overshoot: number;
  saturated: boolean;
};

function scoreWindow(window: WindowUsage | undefined, kind: WindowKind, now: number, options: ProjectionOptions): ScoredWindow | null {
  if (!window) return null;
  const projection = projectWindow(window, kind, now, options);
  const reserve = reserveOf(kind);
  return {
    aged: { ...window, usedPercent: projection.usedNow },
    projection,
    overshoot: Math.max(0, projection.projected - reserve),
    saturated: projection.usedNow >= reserve,
  };
}

/**
 * Order (each key a class, worst last):
 *  1. readable limits before unreadable;
 *  2. no rate-limit exhaustion evidence before exhausted;
 *  3. weekly/Fable below the reserve line before at/above it (regardless of
 *     time-to-reset — the operator's other threads need that headroom);
 *  4. 5h below its line before at/above it;
 *  5. not projected to cross any line within the hour before projected to
 *     (and, among the projected, the smallest overshoot);
 *  6. then the score: capped pace-adjusted weekly load (the tighter of
 *     general and Fable for a Fable pick; the 5h window stands in when no
 *     weekly window exists) + the 5h window's ahead-of-pace load (≥0) +
 *     projected overshoot + local commitments + the operator penalty;
 *  7. raw Fable used%, raw 5h used%, registration order, id as the
 *     deterministic tie-breaks.
 * Saturation and projection run on the snapshot AGED to `now` by velocity.
 * Null only for an empty candidate list.
 */
export function selectLeastLoadedAccount(
  candidates: AutoAccountCandidate[],
  now = Date.now(),
  options: AutoAccountSelectionOptions = {},
): AutoAccountChoice | null {
  const fableAware = isFableModel(options.model);
  const capped: EffectiveLoadOptions = { paceCreditCap: AUTO_PACE_CREDIT_CAP_PERCENT };
  const scored = candidates.map(({ account, limits, commitment, activeBees, exhausted }) => {
    const ok = limits?.ok === true;
    const projection: ProjectionOptions = { activeBees: activeBees ?? 0, fetchedAt: limits?.fetchedAt ?? null };
    const fiveHour = ok ? scoreWindow(limits?.fiveHour, "fiveHour", now, projection) : null;
    const weekly = ok ? scoreWindow(limits?.weekly, "weekly", now, projection) : null;
    const fable = ok && fableAware ? scoreWindow(limits?.fableWeekly, "fableWeekly", now, projection) : null;
    // Weekly score: capped pace credit; the 5h window stands in when the
    // provider reports no weekly window (codex-style single window).
    const generalWeekly = weekly
      ? effectiveWindowLoad(weekly.aged, now, capped)
      : fiveHour
        ? effectiveWindowLoad(fiveHour.aged, now, capped)
        : null;
    const fableWeekly = fable ? effectiveWindowLoad(fable.aged, now, capped) : null;
    // A Fable bee consumes both the general allowance and its scoped included
    // allowance. Rank by the tighter effective window so improving sensitivity
    // to Fable never makes the picker ignore an almost-empty general week.
    const weeklyLoad = fableWeekly !== null ? Math.max(generalWeekly ?? 0, fableWeekly) : generalWeekly;
    // 5h gradient: only ever a penalty. Behind pace / idle → 0; a hot window
    // (81% used at 28% elapsed → +59) outranks any weekly preference.
    const fiveHourAhead = fiveHour ? Math.max(0, effectiveWindowLoad(fiveHour.aged, now)) : 0;
    const overshoot = Math.max(fiveHour?.overshoot ?? 0, weekly?.overshoot ?? 0, fable?.overshoot ?? 0);
    const accountPenalty = account.penalty ?? 0;
    const weeklySaturatedFlag = (weekly?.saturated ?? false) || (fable?.saturated ?? false);
    const fiveHourSaturatedFlag = fiveHour?.saturated ?? false;
    return {
      account,
      limits,
      ok,
      exhausted: exhausted === true,
      weeklySaturated: weeklySaturatedFlag,
      fiveHourSaturated: fiveHourSaturatedFlag,
      projectedOverrun: overshoot > 0,
      overshootRank: overshoot > 0 && !weeklySaturatedFlag && !fiveHourSaturatedFlag ? overshoot : 0,
      score: (weeklyLoad ?? 0) + fiveHourAhead + overshoot + (commitment ?? 0) + accountPenalty,
      fiveHourAhead,
      overshoot,
      modelUsed: fable?.projection.usedNow ?? 0,
      fiveHourUsed: fiveHour?.projection.usedNow ?? 0,
      commitment: commitment ?? 0,
      accountPenalty,
      windows: { fiveHour, weekly, fable },
    };
  });
  scored.sort(
    (a, b) =>
      Number(!a.ok) - Number(!b.ok) ||
      Number(a.exhausted) - Number(b.exhausted) ||
      Number(a.weeklySaturated) - Number(b.weeklySaturated) ||
      Number(a.fiveHourSaturated) - Number(b.fiveHourSaturated) ||
      Number(a.projectedOverrun) - Number(b.projectedOverrun) ||
      // Within the projected-overrun class (nobody saturated yet), how badly
      // the hour ends decides before anything else — "least overshoot" is what
      // the reason promises. Saturated classes rank on load as usual.
      a.overshootRank - b.overshootRank ||
      a.score - b.score ||
      a.modelUsed - b.modelUsed ||
      a.fiveHourUsed - b.fiveHourUsed ||
      compareAddedAt(a.account, b.account) ||
      a.account.id.localeCompare(b.account.id),
  );
  const best = scored[0];
  if (!best) return null;
  const base = !best.ok
    ? "limits unreadable for every account; oldest registration"
    : best.exhausted
      ? "every account has recent rate-limit exhaustion evidence; least effective weekly load"
      : best.weeklySaturated
        ? `every account is past its ${fableAware ? "weekly or Fable" : "weekly"} reserve; least effective weekly load`
        : best.fiveHourSaturated
          ? "every account is close to its 5h limit; least effective weekly load"
          : best.projectedOverrun
            ? `every account is projected to cross a limit within the hour; least overshoot (+${Math.round(best.overshoot)})`
            : autoPickWeeklyReason(best.windows, now, fableAware);
  const reason = [
    base,
    ...(best.ok && !best.projectedOverrun && best.fiveHourAhead > 0 ? [`5h ${Math.round(best.fiveHourAhead)} ahead of pace`] : []),
    ...(best.commitment > 0 ? [`+${Math.round(best.commitment)} in-flight`] : []),
    ...(best.accountPenalty > 0 ? [`+${best.accountPenalty} account auto penalty`] : []),
  ].join("; ");
  const nearTieIds = scored
    .filter((s) =>
      s.ok === best.ok &&
      s.exhausted === best.exhausted &&
      s.weeklySaturated === best.weeklySaturated &&
      s.fiveHourSaturated === best.fiveHourSaturated &&
      s.projectedOverrun === best.projectedOverrun &&
      s.score - best.score <= AUTO_TIE_EPSILON_PERCENT
    )
    .map((s) => s.account.id);
  return { account: best.account, ...(best.ok && best.limits ? { limits: best.limits } : {}), reason, nearTieIds };
}

/** Why the winner won, pace-aware: names the expiring surplus / overpace when the window boundary is known. */
function autoPickWeeklyReason(
  windows: { fiveHour: ScoredWindow | null; weekly: ScoredWindow | null; fable: ScoredWindow | null },
  now: number,
  fableAware: boolean,
): string {
  const capped: EffectiveLoadOptions = { paceCreditCap: AUTO_PACE_CREDIT_CAP_PERCENT };
  const fableWindow = fableAware ? windows.fable?.aged : undefined;
  const generalWindow = windows.weekly?.aged ?? windows.fiveHour?.aged;
  const fableConstrains = fableWindow !== undefined &&
    (generalWindow === undefined || effectiveWindowLoad(fableWindow, now, capped) >= effectiveWindowLoad(generalWindow, now, capped));
  const window = fableConstrains ? fableWindow : generalWindow;
  const label = fableWindow ? "Fable-aware weekly" : "weekly";
  const pace = window && !windowRolledOver(window, now) ? paceDelta(window, now) : null;
  if (pace === null) return `least ${label} usage`;
  const rounded = Math.round(Math.abs(pace));
  if (pace <= -3) return `least effective ${label} load (${rounded}% behind pace — surplus expires at reset)`;
  if (pace >= 3) return `least effective ${label} load (${rounded}% ahead of pace)`;
  return `least effective ${label} load (on pace)`;
}

/**
 * Rotate a near-tie group (winner-first order): the pick after `lastAccountId`
 * in the group, so identical concurrent bursts spread across the tie group
 * instead of all landing on rank #1. Scores within the group differ by at
 * most AUTO_TIE_EPSILON_PERCENT, so the rotation never meaningfully worsens
 * the pick. Pure: the caller reads/writes the per-harness cursor row.
 * Returns the choice to enact plus the cursor value to persist (null = the
 * group had fewer than two members; nothing to rotate, cursor untouched).
 */
export function rotateNearTie(
  choice: AutoAccountChoice,
  candidates: AutoAccountCandidate[],
  lastAccountId: string | null,
): { choice: AutoAccountChoice; cursor: string | null } {
  const byId = new Map(candidates.map((c) => [c.account.id, c]));
  const tie = choice.nearTieIds.filter((id) => byId.has(id));
  if (tie.length < 2) return { choice, cursor: null };
  const prevIndex = lastAccountId ? tie.indexOf(lastAccountId) : -1;
  const nextId = tie[(prevIndex + 1) % tie.length] as string;
  if (nextId === choice.account.id) return { choice, cursor: nextId };
  const next = byId.get(nextId) as AutoAccountCandidate;
  return {
    choice: {
      account: next.account,
      ...(next.limits?.ok === true ? { limits: next.limits } : {}),
      reason: `near-tie rotation among ${tie.length} accounts (${choice.reason})`,
      nearTieIds: choice.nearTieIds,
    },
    cursor: nextId,
  };
}

// ---------------------------------------------------------------------------
// Commitments — spawn-time load the provider's numbers can't see yet (HIVE-80)
// ---------------------------------------------------------------------------

/**
 * Effective-load points a busy (working) bee adds to its account. The scale
 * is percent-of-window, matching effectiveWindowLoad: four stacked heavy
 * workers ≈ +32 — roughly what the 2026-07-03 gmail incidents showed a burst
 * actually burns before the provider numbers catch up.
 */
export const AUTO_COMMITMENT_BUSY_PERCENT = 8;

/**
 * Points a parked-but-running bee (idle) adds. Nonzero because a parked bee
 * is one prompt away from burning, but far below busy weight so accounts
 * hosting long-lived idle bees are not starved of new work.
 */
export const AUTO_COMMITMENT_PARKED_PERCENT = 2;

export type CommitmentRuntimeState = "booting" | "running" | "idle" | "stopped" | null | undefined;

/**
 * Commitment points one live runtime contributes to its bee's account, by
 * the v2 four-state model: booting/running = busy (the old active/working),
 * idle = parked (the old ready/waiting/idle/auth-needed/blocked), stopped =
 * none (the old dead/crashed/done/… terminal spellings). No runtime = none.
 */
export function runtimeCommitmentPercent(state: CommitmentRuntimeState): number {
  if (state === "booting" || state === "running") return AUTO_COMMITMENT_BUSY_PERCENT;
  if (state === "idle") return AUTO_COMMITMENT_PARKED_PERCENT;
  return 0;
}

/** Whether a runtime state counts as a busy bee for the velocity estimate. */
export function isBusyRuntimeState(state: CommitmentRuntimeState): boolean {
  return state === "booting" || state === "running";
}

/**
 * Total commitment points per account id from live bees (the old
 * accountCommitments over session records). Bees with no account, and
 * stopped runtimes, contribute nothing.
 */
export function accountCommitments(
  bees: Array<{ account: string | null; runtimeState: CommitmentRuntimeState }>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const bee of bees) {
    if (!bee.account) continue;
    const percent = runtimeCommitmentPercent(bee.runtimeState);
    if (percent <= 0) continue;
    totals.set(bee.account, (totals.get(bee.account) ?? 0) + percent);
  }
  return totals;
}

/** Busy-bee count per account id (the velocity estimate's fallback input). */
export function accountActiveBees(
  bees: Array<{ account: string | null; runtimeState: CommitmentRuntimeState }>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const bee of bees) {
    if (!bee.account || !isBusyRuntimeState(bee.runtimeState)) continue;
    totals.set(bee.account, (totals.get(bee.account) ?? 0) + 1);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Pending picks — decaying pick-time debits (the HIVE-80 reservation)
// ---------------------------------------------------------------------------

/**
 * Effective-load points one auto pick debits its account at decision time.
 * Covers the window between "picked" and "the bee's runtime is booting" —
 * concurrent spawns otherwise read identical snapshots and stack.
 */
export const AUTO_PICK_DEBIT_PERCENT = 10;

/**
 * How long a pick debit takes to decay to zero. Long enough to bridge the
 * provider's reporting lag (the periodic refresh is 15 min); short enough
 * that an aborted spawn does not shadow an account for a whole window.
 */
export const AUTO_PICK_DEBIT_TTL_MS = 15 * 60 * 1000;

export type PendingPick = { at: number; percent: number };

/**
 * Remaining value of one pick debit: full at pick time, linearly down to zero
 * at ttl. A future timestamp counts as fresh — over-deterring beats
 * re-herding when a clock is skewed.
 */
export function decayedPickDebit(pick: PendingPick, now: number, ttlMs = AUTO_PICK_DEBIT_TTL_MS): number {
  if (!(pick.percent > 0)) return 0;
  const age = now - pick.at;
  if (!Number.isFinite(age) || age < 0) return pick.percent;
  if (age >= ttlMs) return 0;
  return pick.percent * (1 - age / ttlMs);
}

/** Summed decayed debit of an account's pending picks. */
export function pendingPickDebit(picks: readonly PendingPick[], now: number, ttlMs = AUTO_PICK_DEBIT_TTL_MS): number {
  let sum = 0;
  for (const pick of picks) sum += decayedPickDebit(pick, now, ttlMs);
  return sum;
}

/** The picks still carrying a debit (drop the fully decayed ones). */
export function prunePendingPicks(picks: readonly PendingPick[], now: number, ttlMs = AUTO_PICK_DEBIT_TTL_MS): PendingPick[] {
  return picks.filter((pick) => decayedPickDebit(pick, now, ttlMs) > 0);
}

// ---------------------------------------------------------------------------
// Store row → selector input
// ---------------------------------------------------------------------------

/** Measured per-window velocities the daemon keeps beside the limits row. */
export type WindowVelocities = Partial<Record<WindowKind, number | null>>;

/** The window shape the store keeps → the selector's WindowUsage (null pct = no window). */
function windowOf(pct: number | null, resetsAt: number | null, minutes: number | null, velocity: number | null | undefined): WindowUsage | undefined {
  if (pct === null) return undefined;
  return {
    usedPercent: pct,
    ...(resetsAt !== null ? { resetsAt } : {}),
    ...(minutes !== null ? { windowMinutes: minutes } : {}),
    ...(typeof velocity === "number" ? { velocityPerHour: velocity } : {}),
  };
}

/** Convert a stored limits row (+ optional measured velocities) into the selector's AccountLimits. */
export function limitsFromRow(
  row: {
    readable: boolean;
    error: string | null;
    plan: string | null;
    fetchedAt?: number;
    fiveHourPct: number | null;
    fiveHourResetsAt: number | null;
    fiveHourMinutes: number | null;
    weeklyPct: number | null;
    weeklyResetsAt: number | null;
    weeklyMinutes: number | null;
    fableWeeklyPct: number | null;
    fableResetsAt: number | null;
    fableMinutes: number | null;
  },
  velocities: WindowVelocities = {},
): AccountLimits {
  const fiveHour = windowOf(row.fiveHourPct, row.fiveHourResetsAt, row.fiveHourMinutes, velocities.fiveHour);
  const weekly = windowOf(row.weeklyPct, row.weeklyResetsAt, row.weeklyMinutes, velocities.weekly);
  const fableWeekly = windowOf(row.fableWeeklyPct, row.fableResetsAt, row.fableMinutes, velocities.fableWeekly);
  return {
    ok: row.readable,
    ...(row.error ? { error: row.error } : {}),
    ...(row.plan ? { plan: row.plan } : {}),
    ...(typeof row.fetchedAt === "number" ? { fetchedAt: row.fetchedAt } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(fableWeekly ? { fableWeekly } : {}),
  };
}
