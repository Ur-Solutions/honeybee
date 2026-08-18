/**
 * Account selection — the calibrated `auto` model (spec 08 "Selection — the
 * calibrated model, kept"), ported VERBATIM from the old
 * src/limits/autoPick.ts + src/limits/window.ts + the commitment weights of
 * src/limits/commitments.ts. Pure: no I/O, no clock of its own (callers pass
 * `now`), no store. The daemon feeds it account rows + limits rows + live-bee
 * commitments and enacts the pick; the golden tests in
 * tests/account-select.test.ts are the old suite re-run against this file so
 * the same inputs yield the same picks.
 *
 * What was cut around the score (ceremony, not model — spec 08): decaying
 * pick-debits, the `rr` policy, the boot-health breaker file, the
 * stale-while-revalidate cache with detached refresh forks, and the three
 * distinct skip-reason strings. Everything that scores or orders is here,
 * unchanged.
 */

/** A provider usage window: used% plus the boundary/length pace needs. */
export type WindowUsage = {
  usedPercent: number;
  /** Reset boundary — ISO string (old shape) or epoch ms (store shape). */
  resetsAt?: string | number | null;
  /** Window length, when known (claude: implied 300/10080; codex: from the snapshot). */
  windowMinutes?: number | null;
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
};

/** The account facts the selector needs (a subset of the store's AccountRow). */
export type SelectableAccount = {
  id: string;
  /** Registration time — ISO string (old shape) or epoch ms (store shape); the deterministic tie-break. */
  addedAt: string | number;
  /** Persistent operator penalty in effective-load points (the old `autoPickPenalty`). */
  penalty?: number;
};

function resetMsOf(window: WindowUsage): number | null {
  if (window.resetsAt === undefined || window.resetsAt === null) return null;
  const ms = typeof window.resetsAt === "number" ? window.resetsAt : Date.parse(window.resetsAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pace: used% minus elapsed% of the window. Positive = burning faster than
 * the window refills (on track to exhaust before reset); negative = headroom.
 * Null when the window boundary is unknown or already passed.
 */
export function paceDelta(window: WindowUsage, now = Date.now()): number | null {
  if (!window.resetsAt || !window.windowMinutes) return null;
  const resetMs = resetMsOf(window);
  if (resetMs === null || resetMs <= now) return null;
  const durationMs = window.windowMinutes * 60_000;
  const elapsedPct = Math.min(100, Math.max(0, ((durationMs - (resetMs - now)) / durationMs) * 100));
  return window.usedPercent - elapsedPct;
}

/** True when the snapshot's window boundary has passed — its used% no longer applies. */
export function windowRolledOver(window: WindowUsage, now = Date.now()): boolean {
  if (!window.resetsAt) return false;
  const resetMs = resetMsOf(window);
  return resetMs !== null && resetMs <= now;
}

/**
 * A 5h window at/above this used% is "really close to the limit": the account
 * is deprioritized even when its weekly usage is the lowest, so a fresh bee
 * does not land on an account about to hit the short-window wall.
 */
export const AUTO_FIVE_HOUR_SATURATION_PERCENT = 90;

/**
 * Fable is deliberately protected earlier than the general weekly allowance:
 * at/above 75% used, an account with scoped headroom wins even when pace says
 * the Fable allowance is behind pace and about to reset.
 */
export const AUTO_FABLE_WEEKLY_SATURATION_PERCENT = 75;

/** General weekly wall retained for model-aware selection. */
export const AUTO_GENERAL_WEEKLY_SATURATION_PERCENT = 90;

/**
 * Headroom below which pace stops mattering in the auto pick. An account
 * behind pace but with almost nothing left (98% used, resets in an hour)
 * would win a pure pace contest yet blow through its remaining 2% long
 * before the reset — so pace's weight fades linearly to zero as headroom
 * drops below this threshold, letting raw used% dominate near the wall.
 */
export const AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT = 25;

/**
 * Effective load of a window for the auto pick (lower = better). Raw used%
 * adjusted by pace (used% − elapsed%): an account behind pace holds unused
 * quota that expires at reset, so it scores lower (burn its surplus first);
 * an account ahead of pace is on track to exhaust early, so it scores
 * higher. Pace's influence is weighted by remaining headroom (see
 * AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT) so a nearly-exhausted window
 * never wins on pace alone. Falls back to raw used% when the window
 * boundary is unknown; a rolled-over window is fresh (0).
 */
export function effectiveWindowLoad(window: WindowUsage, now = Date.now()): number {
  if (windowRolledOver(window, now)) return 0;
  const used = window.usedPercent;
  const pace = paceDelta(window, now);
  if (pace === null) return used;
  const headroom = Math.max(0, 100 - used);
  const paceWeight = Math.min(1, headroom / AUTO_PACE_FULL_WEIGHT_HEADROOM_PERCENT);
  return paceWeight * pace + (1 - paceWeight) * used;
}

/**
 * Candidates whose effective weekly load lands within this many points of the
 * winner's are near-ties: provider-reported usage is too coarse to prefer one
 * over the other, so the pick rotates among them (HIVE-80) instead of always
 * hammering rank #1.
 */
export const AUTO_TIE_EPSILON_PERCENT = 3;

export type AutoAccountCandidate = {
  account: SelectableAccount;
  limits?: AccountLimits;
  /**
   * Locally-known load the provider can't see yet, in effective-load points:
   * commitment penalty for live bees. Added to the weekly score — including
   * for limits-unreadable accounts, where it is the only signal separating
   * them.
   */
  commitment?: number;
};

export type AutoAccountChoice = {
  account: SelectableAccount;
  /** The winning account's limits, when they were readable. */
  limits?: AccountLimits;
  /** Why this account won, for display. */
  reason: string;
  /**
   * Winner-first account ids scoring within AUTO_TIE_EPSILON_PERCENT of the
   * winner (same readable/saturated class). Length > 1 means the caller may
   * rotate among them without meaningfully worsening the pick.
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

/**
 * Order: readable limits before unreadable; 5h headroom before 5h-saturated;
 * for a model-aware pick, scoped/general weekly headroom before a nearly empty
 * constraint; then least pace-adjusted weekly load plus the account's operator
 * penalty (see effectiveWindowLoad —
 * an account whose unused quota expires at an imminent reset scores below one
 * that is burning ahead of pace; a rolled-over window counts as 0; a missing
 * weekly window falls back to the 5h one); raw scoped/5h used% and registration
 * order as the deterministic tie-breaks. Null only for an empty candidate list.
 */
export function selectLeastLoadedAccount(
  candidates: AutoAccountCandidate[],
  now = Date.now(),
  options: AutoAccountSelectionOptions = {},
): AutoAccountChoice | null {
  const fableAware = isFableModel(options.model);
  const rawScore = (window: WindowUsage | undefined): number | null =>
    window ? (windowRolledOver(window, now) ? 0 : window.usedPercent) : null;
  const paceScore = (window: WindowUsage | undefined): number | null =>
    window ? effectiveWindowLoad(window, now) : null;
  const scored = candidates.map(({ account, limits, commitment }) => {
    const ok = limits?.ok === true;
    // Saturation and the tie-break stay on RAW 5h used% — a saturated short
    // window is a wall regardless of how favorable its pace looks.
    const fiveHour = ok ? rawScore(limits?.fiveHour) : null;
    const generalWeeklyUsed = ok ? rawScore(limits?.weekly) : null;
    const generalWeekly = ok ? (paceScore(limits?.weekly) ?? paceScore(limits?.fiveHour)) : null;
    const modelWindow = fableAware && ok ? limits?.fableWeekly : undefined;
    const modelWeekly = paceScore(modelWindow);
    // A Fable bee consumes both the general allowance and its scoped included
    // allowance. Rank by the tighter effective window so improving sensitivity
    // to Fable never makes the picker ignore an almost-empty general week.
    const weekly = fableAware && modelWeekly !== null
      ? Math.max(generalWeekly ?? 0, modelWeekly)
      : generalWeekly;
    const modelUsed = rawScore(modelWindow);
    const accountPenalty = account.penalty ?? 0;
    return {
      account,
      limits,
      ok,
      // Commitments apply to unreadable accounts too — live bees are known
      // locally regardless of whether the provider's limits endpoint answers.
      weekly: (weekly ?? 0) + (commitment ?? 0) + accountPenalty,
      fiveHour: fiveHour ?? 0,
      modelUsed: modelUsed ?? 0,
      commitment: commitment ?? 0,
      accountPenalty,
      fiveHourSaturated: ok && fiveHour !== null && fiveHour >= AUTO_FIVE_HOUR_SATURATION_PERCENT,
      modelSaturated: ok && fableAware && (
        (modelUsed !== null && modelUsed >= AUTO_FABLE_WEEKLY_SATURATION_PERCENT) ||
        (generalWeeklyUsed !== null && generalWeeklyUsed >= AUTO_GENERAL_WEEKLY_SATURATION_PERCENT)
      ),
    };
  });
  scored.sort(
    (a, b) =>
      Number(!a.ok) - Number(!b.ok) ||
      Number(a.fiveHourSaturated) - Number(b.fiveHourSaturated) ||
      Number(a.modelSaturated) - Number(b.modelSaturated) ||
      a.weekly - b.weekly ||
      a.modelUsed - b.modelUsed ||
      a.fiveHour - b.fiveHour ||
      compareAddedAt(a.account, b.account) ||
      a.account.id.localeCompare(b.account.id),
  );
  const best = scored[0];
  if (!best) return null;
  const base = !best.ok
    ? "limits unreadable for every account; oldest registration"
    : best.fiveHourSaturated
      ? "every account is close to its 5h limit; least effective weekly load"
      : best.modelSaturated
        ? "every account is close to its Fable or general weekly limit; least effective Fable-aware weekly load"
        : autoPickWeeklyReason(best.limits, now, fableAware);
  const reason = [
    base,
    ...(best.commitment > 0 ? [`+${Math.round(best.commitment)} in-flight`] : []),
    ...(best.accountPenalty > 0 ? [`+${best.accountPenalty} account auto penalty`] : []),
  ].join("; ");
  const nearTieIds = scored
    .filter((s) =>
      s.ok === best.ok &&
      s.fiveHourSaturated === best.fiveHourSaturated &&
      s.modelSaturated === best.modelSaturated &&
      s.weekly - best.weekly <= AUTO_TIE_EPSILON_PERCENT
    )
    .map((s) => s.account.id);
  return { account: best.account, ...(best.ok && best.limits ? { limits: best.limits } : {}), reason, nearTieIds };
}

/** Why the winner won, pace-aware: names the expiring surplus / overpace when the window boundary is known. */
function autoPickWeeklyReason(limits: AccountLimits | undefined, now: number, fableAware: boolean): string {
  const fableWindow = fableAware ? limits?.fableWeekly : undefined;
  const generalWindow = limits?.weekly ?? limits?.fiveHour;
  const fableConstrains = fableWindow !== undefined &&
    (generalWindow === undefined || effectiveWindowLoad(fableWindow, now) >= effectiveWindowLoad(generalWindow, now));
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

/**
 * Commitment points one live runtime contributes to its bee's account, by
 * the v2 four-state model: booting/running = busy (the old active/working),
 * idle = parked (the old ready/waiting/idle/auth-needed/blocked), stopped =
 * none (the old dead/crashed/done/… terminal spellings). No runtime = none.
 */
export function runtimeCommitmentPercent(state: "booting" | "running" | "idle" | "stopped" | null | undefined): number {
  if (state === "booting" || state === "running") return AUTO_COMMITMENT_BUSY_PERCENT;
  if (state === "idle") return AUTO_COMMITMENT_PARKED_PERCENT;
  return 0;
}

/**
 * Total commitment points per account id from live bees (the old
 * accountCommitments over session records). Bees with no account, and
 * stopped runtimes, contribute nothing.
 */
export function accountCommitments(
  bees: Array<{ account: string | null; runtimeState: "booting" | "running" | "idle" | "stopped" | null | undefined }>,
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

// ---------------------------------------------------------------------------
// Store row → selector input
// ---------------------------------------------------------------------------

/** The window shape the store keeps → the selector's WindowUsage (null pct = no window). */
function windowOf(pct: number | null, resetsAt: number | null, minutes: number | null): WindowUsage | undefined {
  if (pct === null) return undefined;
  return {
    usedPercent: pct,
    ...(resetsAt !== null ? { resetsAt } : {}),
    ...(minutes !== null ? { windowMinutes: minutes } : {}),
  };
}

/** Convert a stored limits row into the selector's AccountLimits. */
export function limitsFromRow(row: {
  readable: boolean;
  error: string | null;
  plan: string | null;
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null;
  fiveHourMinutes: number | null;
  weeklyPct: number | null;
  weeklyResetsAt: number | null;
  weeklyMinutes: number | null;
  fableWeeklyPct: number | null;
  fableResetsAt: number | null;
  fableMinutes: number | null;
}): AccountLimits {
  const fiveHour = windowOf(row.fiveHourPct, row.fiveHourResetsAt, row.fiveHourMinutes);
  const weekly = windowOf(row.weeklyPct, row.weeklyResetsAt, row.weeklyMinutes);
  const fableWeekly = windowOf(row.fableWeeklyPct, row.fableResetsAt, row.fableMinutes);
  return {
    ok: row.readable,
    ...(row.error ? { error: row.error } : {}),
    ...(row.plan ? { plan: row.plan } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(fableWeekly ? { fableWeekly } : {}),
  };
}
