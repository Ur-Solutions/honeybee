// ──────────────────────────────────────────────────────────────────────────
// account selection — the two pickers behind `<tool>-auto` and `<tool>-rr`.
//
//  - auto: least-loaded account of a tool. Ranks by pace-adjusted weekly load
//    plus locally-known commitments (live bees + decaying pick debits — see
//    commitments.ts and HIVE-80), deprioritizing an account whose 5h window
//    is nearly exhausted, reading limits through the cache with a 1h default
//    ttl. Near-tie candidates rotate via a persistent cursor so concurrent
//    bursts spread instead of stacking on the emptiest account.
//  - rr: the next account in a persistent round-robin order, advancing a
//    cursor on disk. Explicitly NOT limits-aware — the operator wants the
//    workload spread evenly regardless of remaining quota.
// ──────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AccountRecord, accountHasCredentials, listAccounts } from "../accounts.js";
import { canonicalAgentKind } from "../agents.js";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import type { SessionRecord } from "../store.js";
import { type CachedLimitsOptions, agePickedLimitsCacheEntry, cachedAccountLimits } from "./cache.js";
import { accountCommitments, pendingPickDebits, recordAutoPick } from "./commitments.js";
import type { AccountLimits, WindowUsage } from "./types.js";
import { paceDelta, windowRolledOver } from "./window.js";

/**
 * A 5h window at/above this used% is "really close to the limit": the account
 * is deprioritized even when its weekly usage is the lowest, so a fresh bee
 * does not land on an account about to hit the short-window wall. Matches the
 * red zone of the usage bars.
 */
export const AUTO_FIVE_HOUR_SATURATION_PERCENT = 90;

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
  account: AccountRecord;
  limits?: AccountLimits;
  /**
   * Locally-known load the provider can't see yet, in effective-load points:
   * commitment penalty for live bees + decayed pick debits (HIVE-80). Added
   * to the weekly score — including for limits-unreadable accounts, where it
   * is the only signal separating them.
   */
  commitment?: number;
};

export type AutoAccountChoice = {
  account: AccountRecord;
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

/**
 * Order: readable limits before unreadable; 5h headroom before 5h-saturated;
 * then least pace-adjusted weekly load (see effectiveWindowLoad — an account
 * whose unused quota expires at an imminent reset scores below one that is
 * burning ahead of pace; a rolled-over window counts as 0; a missing weekly
 * window falls back to the 5h one); raw 5h used% and registration order as
 * the deterministic tie-breaks. Null only for an empty candidate list.
 */
export function selectLeastLoadedAccount(candidates: AutoAccountCandidate[], now = Date.now()): AutoAccountChoice | null {
  const rawScore = (window: WindowUsage | undefined): number | null =>
    window ? (windowRolledOver(window, now) ? 0 : window.usedPercent) : null;
  const paceScore = (window: WindowUsage | undefined): number | null =>
    window ? effectiveWindowLoad(window, now) : null;
  const scored = candidates.map(({ account, limits, commitment }) => {
    const ok = limits?.ok === true;
    // Saturation and the tie-break stay on RAW 5h used% — a saturated short
    // window is a wall regardless of how favorable its pace looks.
    const fiveHour = ok ? rawScore(limits?.fiveHour) : null;
    const weekly = ok ? (paceScore(limits?.weekly) ?? paceScore(limits?.fiveHour)) : null;
    return {
      account,
      limits,
      ok,
      // Commitments apply to unreadable accounts too — live bees are known
      // locally regardless of whether the provider's limits endpoint answers.
      weekly: (weekly ?? 0) + (commitment ?? 0),
      fiveHour: fiveHour ?? 0,
      commitment: commitment ?? 0,
      saturated: ok && fiveHour !== null && fiveHour >= AUTO_FIVE_HOUR_SATURATION_PERCENT,
    };
  });
  scored.sort(
    (a, b) =>
      Number(!a.ok) - Number(!b.ok) ||
      Number(a.saturated) - Number(b.saturated) ||
      a.weekly - b.weekly ||
      a.fiveHour - b.fiveHour ||
      a.account.addedAt.localeCompare(b.account.addedAt) ||
      a.account.id.localeCompare(b.account.id),
  );
  const best = scored[0];
  if (!best) return null;
  const base = !best.ok
    ? "limits unreadable for every account; oldest registration"
    : best.saturated
      ? "every account is close to its 5h limit; least effective weekly load"
      : autoPickWeeklyReason(best.limits, now);
  const reason = best.commitment > 0 ? `${base}; +${Math.round(best.commitment)} in-flight` : base;
  const nearTieIds = scored
    .filter((s) => s.ok === best.ok && s.saturated === best.saturated && s.weekly - best.weekly <= AUTO_TIE_EPSILON_PERCENT)
    .map((s) => s.account.id);
  return { account: best.account, ...(best.ok && best.limits ? { limits: best.limits } : {}), reason, nearTieIds };
}

/** Why the winner won, pace-aware: names the expiring surplus / overpace when the window boundary is known. */
function autoPickWeeklyReason(limits: AccountLimits | undefined, now: number): string {
  const window = limits?.weekly ?? limits?.fiveHour;
  const pace = window && !windowRolledOver(window, now) ? paceDelta(window, now) : null;
  if (pace === null) return "least weekly usage";
  const rounded = Math.round(Math.abs(pace));
  if (pace <= -3) return `least effective weekly load (${rounded}% behind pace — surplus expires at reset)`;
  if (pace >= 3) return `least effective weekly load (${rounded}% ahead of pace)`;
  return "least effective weekly load (on pace)";
}

/** Default freshness budget for the auto pick: cached limits younger than this are good enough. */
export const AUTO_ACCOUNT_TTL_MS = 60 * 60 * 1000;

export type PickAccountDeps = CachedLimitsOptions & {
  hasCredentials?: typeof accountHasCredentials;
  /** Session records for the commitment penalty; defaults to the live store. */
  sessions?: SessionRecord[];
};

/**
 * Resolve the `auto` account query: among the tool's accounts with vaulted
 * credentials, pick the one with the least pace-adjusted weekly load (an
 * imminent reset with unused quota beats a nominally lower used%), pushing
 * accounts whose 5h window is nearly exhausted to the back. Limits come through the
 * cache with a 1h default ttl, so back-to-back auto spawns do not re-pay the
 * provider round-trips; pass ttlMs (0 = always live) to override.
 */
export async function pickLeastLoadedAccount(tool: string, deps: PickAccountDeps = {}): Promise<AutoAccountChoice> {
  const kind = canonicalAgentKind(tool).toLowerCase();
  const registered = (await listAccounts()).filter((account) => account.tool === kind);
  if (registered.length === 0) {
    throw new Error(`No ${kind} accounts registered; add one with: hive account add ${kind} <label>`);
  }
  const hasCredentials = deps.hasCredentials ?? accountHasCredentials;
  const candidates: AccountRecord[] = [];
  for (const account of registered) {
    if (await hasCredentials(account)) candidates.push(account);
  }
  if (candidates.length === 0) {
    throw new Error(`No ${kind} account has vaulted credentials; capture some with: hive login <account>`);
  }
  // A single candidate wins regardless of usage — skip the limits round-trips
  // and the pick bookkeeping (there is no herd to steer with one account).
  if (candidates.length === 1) {
    return { account: candidates[0]!, reason: `only ${kind} account with credentials`, nearTieIds: [candidates[0]!.id] };
  }
  const ttlMs = deps.ttlMs ?? AUTO_ACCOUNT_TTL_MS;
  const results = await cachedAccountLimits(candidates, { ...deps, ttlMs });
  const byId = new Map(results.map((result) => [result.account, result]));
  const now = (deps.now ?? Date.now)();
  const [commitments, debits] = await Promise.all([accountCommitments(kind, deps.sessions), pendingPickDebits(now)]);
  const choice = selectLeastLoadedAccount(
    candidates.map((account) => ({
      account,
      limits: byId.get(account.id),
      commitment: (commitments.get(account.id) ?? 0) + (debits.get(account.id) ?? 0),
    })),
    now,
  )!;
  const rotated = choice.nearTieIds.length > 1 ? await rotateNearTie(kind, choice, candidates, byId) : choice;
  // Pick bookkeeping (HIVE-80): debit the winner so the next concurrent pick
  // sees this one, and age its cache entry so the picker re-reads live once
  // the provider's numbers can actually reflect the newly placed load.
  await recordAutoPick(rotated.account.id, now).catch(() => undefined);
  if (ttlMs > 0) await agePickedLimitsCacheEntry(rotated.account.id, { now, ttlMs }).catch(() => undefined);
  return rotated;
}

/**
 * Rotate a near-tie group through the persistent cursor (stored beside the rr
 * cursor under an `auto-tie:` key, same lock): the pick after `lastAccountId`
 * in winner-first order, so identical concurrent bursts spread across the tie
 * group instead of all landing on rank #1. Scores within the group differ by
 * at most AUTO_TIE_EPSILON_PERCENT, so the rotation never meaningfully
 * worsens the pick.
 */
async function rotateNearTie(
  kind: string,
  choice: AutoAccountChoice,
  candidates: AccountRecord[],
  limitsById: Map<string, AccountLimits>,
): Promise<AutoAccountChoice> {
  const accountsById = new Map(candidates.map((account) => [account.id, account]));
  const tie = choice.nearTieIds.filter((id) => accountsById.has(id));
  if (tie.length < 2) return choice;
  const cursorKey = `auto-tie:${kind}`;
  return withFileLock(cursorLockPath(), async () => {
    const cursor = await readCursor();
    const prevId = cursor[cursorKey]?.lastAccountId;
    const prevIndex = prevId ? tie.indexOf(prevId) : -1;
    const nextId = tie[(prevIndex + 1) % tie.length]!;
    await writeCursor({ ...cursor, [cursorKey]: { lastAccountId: nextId } });
    if (nextId === choice.account.id) return choice;
    const account = accountsById.get(nextId)!;
    const limits = limitsById.get(nextId);
    return {
      account,
      ...(limits?.ok === true ? { limits } : {}),
      reason: `near-tie rotation among ${tie.length} accounts (${choice.reason})`,
      nearTieIds: choice.nearTieIds,
    };
  });
}

/* ------------------------------------------------------------------ */
/* round-robin — even spread, NOT limits-aware                         */
/* ------------------------------------------------------------------ */

export type RoundRobinChoice = {
  account: AccountRecord;
  reason: string;
};

// The cursor lives in `<storeRoot>/round-robin.json` as
// `{ [tool]: { lastAccountId } }`, serialized by a file lock so two concurrent
// spawns can't pick the same account or skip one.
type CursorFile = Record<string, { lastAccountId?: string } | undefined>;

function cursorPath(): string {
  return join(storeRoot(), "round-robin.json");
}

function cursorLockPath(): string {
  return join(storeRoot(), ".round-robin.lock");
}

async function readCursor(): Promise<CursorFile> {
  try {
    const raw = await readFile(cursorPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CursorFile;
  } catch {
    return {};
  }
}

async function writeCursor(cursor: CursorFile): Promise<void> {
  await atomicWriteFile(cursorPath(), `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Pick the next account in round-robin order for `tool`, advancing and
 * persisting the cursor. Candidate set mirrors {@link pickLeastLoadedAccount}:
 * registered + credentialed accounts only, sorted stably by `addedAt` (then
 * `id`) so the cycle order is deterministic across hosts and registrations.
 *
 * Throws with the same error shapes as the auto picker when no candidates
 * exist / no candidate has credentials.
 */
export async function pickRoundRobinAccount(tool: string): Promise<RoundRobinChoice> {
  const kind = canonicalAgentKind(tool).toLowerCase();
  const registered = (await listAccounts()).filter((account) => account.tool === kind);
  if (registered.length === 0) {
    throw new Error(`No ${kind} accounts registered; add one with: hive account add ${kind} <label>`);
  }
  const candidates: AccountRecord[] = [];
  for (const account of registered) {
    if (await accountHasCredentials(account)) candidates.push(account);
  }
  if (candidates.length === 0) {
    throw new Error(`No ${kind} account has vaulted credentials; capture some with: hive login <account>`);
  }
  candidates.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id));
  // A single candidate cycle is a no-op; still update the cursor so a later
  // registration starts cleanly from a known anchor.
  return withFileLock(cursorLockPath(), async () => {
    const cursor = await readCursor();
    const prevId = cursor[kind]?.lastAccountId;
    const prevIndex = prevId ? candidates.findIndex((a) => a.id === prevId) : -1;
    const nextIndex = (prevIndex + 1) % candidates.length;
    const chosen = candidates[nextIndex]!;
    const next: CursorFile = { ...cursor, [kind]: { lastAccountId: chosen.id } };
    await writeCursor(next);
    const reason = prevId
      ? `round-robin: next after ${prevId}`
      : candidates.length === 1
        ? `only ${kind} account with credentials`
        : "round-robin: first pick";
    return { account: chosen, reason };
  });
}
