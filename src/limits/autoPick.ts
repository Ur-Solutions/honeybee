// ──────────────────────────────────────────────────────────────────────────
// account selection — the two pickers behind `<tool>-auto` and `<tool>-rr`.
//
//  - auto: least-loaded account of a tool. Ranks by pace-adjusted weekly load,
//    deprioritizing an account whose 5h window is nearly exhausted, reading
//    limits through the cache with a 1h default ttl.
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
import { type CachedLimitsOptions, cachedAccountLimits } from "./cache.js";
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

export type AutoAccountCandidate = { account: AccountRecord; limits?: AccountLimits };

export type AutoAccountChoice = {
  account: AccountRecord;
  /** The winning account's limits, when they were readable. */
  limits?: AccountLimits;
  /** Why this account won, for display. */
  reason: string;
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
  const scored = candidates.map(({ account, limits }) => {
    const ok = limits?.ok === true;
    // Saturation and the tie-break stay on RAW 5h used% — a saturated short
    // window is a wall regardless of how favorable its pace looks.
    const fiveHour = ok ? rawScore(limits?.fiveHour) : null;
    const weekly = ok ? (paceScore(limits?.weekly) ?? paceScore(limits?.fiveHour)) : null;
    return {
      account,
      limits,
      ok,
      weekly: weekly ?? 0,
      fiveHour: fiveHour ?? 0,
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
  const reason = !best.ok
    ? "limits unreadable for every account; oldest registration"
    : best.saturated
      ? "every account is close to its 5h limit; least effective weekly load"
      : autoPickWeeklyReason(best.limits, now);
  return { account: best.account, ...(best.ok && best.limits ? { limits: best.limits } : {}), reason };
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
  // A single candidate wins regardless of usage — skip the limits round-trips.
  if (candidates.length === 1) {
    return { account: candidates[0]!, reason: `only ${kind} account with credentials` };
  }
  const results = await cachedAccountLimits(candidates, { ...deps, ttlMs: deps.ttlMs ?? AUTO_ACCOUNT_TTL_MS });
  const byId = new Map(results.map((result) => [result.account, result]));
  const now = (deps.now ?? Date.now)();
  return selectLeastLoadedAccount(candidates.map((account) => ({ account, limits: byId.get(account.id) })), now)!;
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
