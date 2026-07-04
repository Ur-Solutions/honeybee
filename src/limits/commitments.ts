// ──────────────────────────────────────────────────────────────────────────
// commitments — spawn-time load the provider's numbers can't see yet (HIVE-80).
//
// `--account auto` scores accounts on provider-reported usage, which lags the
// truth by minutes (plus the cache ttl). Concurrent separate spawns therefore
// all read the same snapshot and stack onto the emptiest account — the burst
// herd. Two locally-known signals close the gap:
//  - commitments: live bees already bound to an account (session records). A
//    busy worker is future burn the provider hasn't reported yet; a parked
//    one is a smaller standing claim (it can be re-prompted any time).
//  - pending picks: every auto pick is recorded at decision time as a
//    fixed-size debit that decays linearly to zero. This covers the window
//    between "picked" and "the spawned bee registers a session", and doubles
//    as the HIVE-80 reservation: a just-picked account immediately scores
//    worse for the next concurrent pick. A live bee with a fresh debit is
//    counted by both signals — deliberate conservatism, since the provider
//    snapshot reflects neither.
// ──────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalAgentKind } from "../agents.js";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { listSessions, type SessionRecord } from "../store.js";

/**
 * Effective-load points a busy (active/working) bee adds to its account. The
 * scale is percent-of-window, matching effectiveWindowLoad: four stacked
 * heavy workers ≈ +32 — roughly what the 2026-07-03 gmail incidents showed a
 * burst actually burns before the provider numbers catch up.
 */
export const AUTO_COMMITMENT_BUSY_PERCENT = 8;

/**
 * Points a parked-but-running bee (ready/waiting/idle) adds. Nonzero because
 * a parked bee is one prompt away from burning, but far below busy weight so
 * accounts hosting long-lived idle bees are not starved of new work.
 */
export const AUTO_COMMITMENT_PARKED_PERCENT = 2;

/** Observed states that mean "generating right now" across drivers. */
const BUSY_STATES = new Set(["active", "working"]);

/** Commitment points a single session contributes to its bound account. */
export function sessionCommitmentPercent(session: SessionRecord): number {
  if (session.status !== "running" || !session.accountId) return 0;
  return BUSY_STATES.has(session.lastObservedState ?? "") ? AUTO_COMMITMENT_BUSY_PERCENT : AUTO_COMMITMENT_PARKED_PERCENT;
}

/**
 * Total commitment points per account id for one tool kind, from the session
 * store (or an injected record set in tests). Sessions of other tools, dead
 * sessions, and sessions with no bound account contribute nothing.
 */
export async function accountCommitments(tool: string, sessions?: SessionRecord[]): Promise<Map<string, number>> {
  const kind = canonicalAgentKind(tool).toLowerCase();
  const records = sessions ?? (await listSessions());
  const totals = new Map<string, number>();
  for (const session of records) {
    if (!session.accountId) continue;
    if (canonicalAgentKind(session.agent).toLowerCase() !== kind) continue;
    const percent = sessionCommitmentPercent(session);
    if (percent <= 0) continue;
    totals.set(session.accountId, (totals.get(session.accountId) ?? 0) + percent);
  }
  return totals;
}

/* ------------------------------------------------------------------ */
/* pending picks — decaying pick-time debits (the HIVE-80 reservation) */
/* ------------------------------------------------------------------ */

/** Effective-load points one auto pick debits its account at decision time. */
export const AUTO_PICK_DEBIT_PERCENT = 10;

/**
 * How long a pick debit takes to decay to zero. Long enough to bridge the
 * provider's reporting lag; short enough that an aborted spawn does not
 * shadow an account for a whole window.
 */
export const AUTO_PICK_DEBIT_TTL_MS = 30 * 60 * 1000;

type PendingPick = { at: string; percent: number };
type PendingPicksFile = Record<string, PendingPick[] | undefined>;

export function pendingPicksPath(): string {
  return join(storeRoot(), "pending-picks.json");
}

function pendingPicksLockPath(): string {
  return join(storeRoot(), ".pending-picks.lock");
}

/**
 * Remaining value of one pick debit: full at pick time, linearly down to zero
 * at ttl. An unparseable or future timestamp counts as fresh — over-deterring
 * beats re-herding when a clock is skewed.
 */
export function decayedPickDebit(pick: PendingPick, now: number, ttlMs = AUTO_PICK_DEBIT_TTL_MS): number {
  if (!(pick.percent > 0)) return 0;
  const age = now - Date.parse(pick.at);
  if (!Number.isFinite(age) || age < 0) return pick.percent;
  if (age >= ttlMs) return 0;
  return pick.percent * (1 - age / ttlMs);
}

async function readPendingPicks(): Promise<PendingPicksFile> {
  try {
    const raw = await readFile(pendingPicksPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const file: PendingPicksFile = {};
    for (const [account, picks] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(picks)) continue;
      const valid = picks.filter(
        (pick): pick is PendingPick =>
          !!pick && typeof pick === "object" && typeof (pick as PendingPick).at === "string" && typeof (pick as PendingPick).percent === "number",
      );
      if (valid.length > 0) file[account] = valid;
    }
    return file;
  } catch {
    return {};
  }
}

/** Summed decayed debits per account id; accounts with nothing pending are absent. */
export async function pendingPickDebits(now = Date.now()): Promise<Map<string, number>> {
  const file = await readPendingPicks();
  const totals = new Map<string, number>();
  for (const [account, picks] of Object.entries(file)) {
    let sum = 0;
    for (const pick of picks ?? []) sum += decayedPickDebit(pick, now);
    if (sum > 0) totals.set(account, sum);
  }
  return totals;
}

/**
 * Record an auto pick against an account, pruning fully-decayed entries while
 * holding the lock so the file cannot grow without bound. Serialized the same
 * way as the round-robin cursor: concurrent picks queue on the file lock and
 * each sees the debits of the picks before it.
 */
export async function recordAutoPick(accountId: string, now = Date.now(), percent = AUTO_PICK_DEBIT_PERCENT): Promise<void> {
  await withFileLock(pendingPicksLockPath(), async () => {
    const file = await readPendingPicks();
    const kept: PendingPicksFile = {};
    for (const [account, picks] of Object.entries(file)) {
      const alive = (picks ?? []).filter((pick) => decayedPickDebit(pick, now) > 0);
      if (alive.length > 0) kept[account] = alive;
    }
    kept[accountId] = [...(kept[accountId] ?? []), { at: new Date(now).toISOString(), percent }];
    await atomicWriteFile(pendingPicksPath(), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  });
}
