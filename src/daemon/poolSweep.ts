// Checkout-pool daemon sweep (CHECKOUT_POOLS_PRD §6.6), piggybacking the tick's
// dispatcher registry. Three cheap, failure-tolerant duties per pool:
//
//   - claim GC: prune claims past pendingUntil (the allocator prunes under its
//     own lock too; the sweep is the backstop for pools nobody allocates from).
//   - refresh-on-vacate: when a member transitions inhabited→free, drive the
//     §5.3 sync for that member (clean + on-base only) so the next claim lands
//     on fresh origin/<branch>. Members left dirty or off-base by a departed
//     bee are FLAGGED (ledger + a buz nudge to the departed bee's living
//     parent when known), never auto-reset — a human decides.
//   - minFree pre-extend: when a pool's free count dips below its advisory
//     floor, clone replacements IN THE BACKGROUND (a clone can outlive the
//     dispatch budget; the outcome surfaces on a later sweep).
//
// The sweep NEVER probes tmux itself: liveness comes from the tick's freshly
// derived state map. Every per-pool step is try/caught into the outcome — a
// broken pool (or a pool-less pro) must never break the tick.

import { sendBuzMessage } from "../buz.js";
import {
  claimExpired,
  deriveMemberOccupancy,
  loadPoolRecord,
  poolsForProject,
  projectRepresentatives,
  savePoolRecord,
  withPoolLock,
  type LiveBee,
  type MemberOccupancy,
  type ResolvedPool,
} from "../pool.js";
import {
  extendProPool,
  listProPools,
  listProRepoEntries,
  syncProCheckouts,
  type ProCheckoutSyncResult,
  type ProRepoEntry,
} from "../proProjects.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { isTerminalState, type BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";
import { envMs } from "./timeouts.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export type PoolFlagReason = "dirty" | "parked-branch";

export type PoolSweepOutcome = {
  /** Pool key (<area>-<project>-<repo>-<pool>). */
  pool: string;
  /** Expired claims pruned this sweep. */
  gcExpired?: number;
  /** Refresh-on-vacate sync rows (pro's §5.3 status per member). */
  synced?: Array<{ member: number; status: string }>;
  /** Members left dirty/off-base by departed bees (nudged = parent bee name). */
  flagged?: Array<{ member: number; reason: PoolFlagReason; nudged?: string }>;
  /** minFree pre-extend kicked off in the background this sweep. */
  extendStarted?: number;
  /** A previously started background pre-extend finished (member count). */
  extended?: number;
  /** Loud soft-cap warning text (pre-extend pushing past maxSize). */
  warned?: string;
  error?: string;
};

// ── pure planner ─────────────────────────────────────────────────────────────

export type MemberSweepView = {
  n: number;
  occupied: boolean;
  parked: boolean;
  dirty: boolean;
  onBaseBranch: boolean;
  free: number;
};

export type PoolSweepPlan = {
  /** Members to §5.3-sync now: vacated this sweep, clean, on-base, unparked. */
  syncMembers: number[];
  /** Vacated members left dirty/off-base — flag, never touch. */
  flags: Array<{ member: number; reason: PoolFlagReason }>;
  /** minFree shortfall to pre-extend by (0 when unset/satisfied). */
  extendBy: number;
  /** This sweep's occupied set (becomes previousOccupied next sweep). */
  occupiedNow: Set<number>;
};

/**
 * Decide one pool's sweep actions from an occupancy snapshot and the previous
 * sweep's occupied set. Pure. `previousOccupied` undefined = first observation
 * of this pool: record the baseline, detect no vacate edges (a daemon restart
 * must not re-sync every idle member at once).
 */
export function planPoolSweep(input: {
  members: MemberSweepView[];
  previousOccupied: ReadonlySet<number> | undefined;
  minFree?: number;
}): PoolSweepPlan {
  const occupiedNow = new Set(input.members.filter((m) => m.occupied).map((m) => m.n));
  const syncMembers: number[] = [];
  const flags: Array<{ member: number; reason: PoolFlagReason }> = [];
  if (input.previousOccupied) {
    for (const member of input.members) {
      if (member.occupied || !input.previousOccupied.has(member.n)) continue;
      // Vacated since the last sweep. Parked members are withheld entirely.
      if (member.parked) continue;
      if (member.dirty) flags.push({ member: member.n, reason: "dirty" });
      else if (!member.onBaseBranch) flags.push({ member: member.n, reason: "parked-branch" });
      else syncMembers.push(member.n);
    }
  }
  const totalFree = input.members.reduce((sum, m) => sum + m.free, 0);
  const extendBy = input.minFree !== undefined ? Math.max(0, input.minFree - totalFree) : 0;
  return { syncMembers, flags, extendBy, occupiedNow };
}

/** Occupancy → planner view (occupied = live inhabitants OR unconsumed claims). */
export function memberSweepView(members: MemberOccupancy[], baseBranch: string): MemberSweepView[] {
  return members.map((member) => ({
    n: member.n,
    occupied: member.occupants.length > 0 || member.pendingClaims.length > 0,
    parked: member.parked,
    dirty: member.dirty,
    onBaseBranch: member.branch === baseBranch,
    free: member.free,
  }));
}

// ── stateful sweeper ─────────────────────────────────────────────────────────

export type PoolSweeper = (records: SessionRecord[], currentStates: Map<string, BeeState>) => Promise<PoolSweepOutcome[]>;

export type PoolSweeperDeps = {
  intervalMs?: number;
  now?: () => number;
  listRepoEntries?: () => Promise<ProRepoEntry[]>;
  discoverPools?: (entry: ProRepoEntry, entries: ProRepoEntry[]) => Promise<ResolvedPool[]>;
  listPools?: typeof listProPools;
  sync?: (repoPath: string, names: string[]) => Promise<ProCheckoutSyncResult>;
  extend?: (repoPath: string, pool: string, count: number) => Promise<string[]>;
  sendNudge?: (recipient: SessionRecord, senderBee: SessionRecord, body: string) => Promise<void>;
  appendLedger?: (event: Record<string, unknown>) => Promise<void>;
};

/**
 * Build the stateful pool sweeper (one per daemon run): it keeps the previous
 * occupied/occupant sets for vacate-edge detection, a flag de-dupe set so a
 * dirty member nudges once (re-armed when it comes clean), and the in-flight
 * background pre-extends. Self-throttled — most ticks return [] immediately.
 */
export function createPoolSweeper(deps: PoolSweeperDeps = {}): PoolSweeper {
  const intervalMs = deps.intervalMs ?? envMs("HIVE_POOL_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);
  const now = deps.now ?? (() => Date.now());
  const listRepoEntries = deps.listRepoEntries ?? listProRepoEntries;
  const discoverPools = deps.discoverPools ?? poolsForProject;
  const sync = deps.sync ?? ((repoPath: string, names: string[]) => syncProCheckouts(repoPath, names, { rebase: true }));
  const extend = deps.extend ?? extendProPool;
  const sendNudge =
    deps.sendNudge ??
    (async (recipient: SessionRecord, senderBee: SessionRecord, body: string) => {
      // queue tier: worth seeing, not worth interrupting a mid-task parent —
      // the daemon drains it when the parent next goes idle.
      await sendBuzMessage({
        recipient,
        sender: { kind: "bee", id: senderBee.id ?? senderBee.name },
        tier: "queue",
        subject: "pool member needs attention",
        body,
      });
    });

  let lastSweepAt = 0;
  /** poolKey → member numbers occupied at the previous sweep. */
  const previousOccupied = new Map<string, Set<number>>();
  /** poolKey → member n → occupant bee names at the previous sweep (departed-bee attribution). */
  const previousOccupants = new Map<string, Map<number, string[]>>();
  /** "key:n:reason" — flags already nudged; re-armed when the condition clears. */
  const nudged = new Set<string>();
  /** poolKey → background pre-extend in flight. */
  const inFlightExtends = new Map<string, Promise<string[]>>();
  /** poolKey → settled background result awaiting report. */
  const settledExtends = new Map<string, { created?: number; error?: string }>();

  return async (records, currentStates) => {
    const nowMs = now();
    if (nowMs - lastSweepAt < intervalMs) return [];
    lastSweepAt = nowMs;

    // Liveness straight from the tick's derived states — no extra probing.
    // A record missing from the map is treated as live (conservative: never
    // fabricate a vacate edge from a partial observation).
    const liveBees: LiveBee[] = records
      .filter((record) => !record.node || record.node === LOCAL_NODE_NAME)
      .filter((record) => {
        const state = currentStates.get(record.name);
        return state === undefined || !isTerminalState(state);
      })
      .map((record) => ({ name: record.name, cwd: record.cwd }));
    const recordByName = new Map(records.map((record) => [record.name, record]));

    const outcomes: PoolSweepOutcome[] = [];
    let pools: ResolvedPool[] = [];
    try {
      const entries = await listRepoEntries();
      for (const scope of projectRepresentatives(entries)) {
        try {
          pools.push(...(await discoverPools(scope, entries)));
        } catch {
          // A single unreadable project (or a pool-less pro) is not sweepable —
          // skip silently; `hive pool` surfaces the actionable error on demand.
        }
      }
    } catch {
      pools = [];
    }

    for (const pool of pools) {
      const outcome: PoolSweepOutcome = { pool: pool.key };
      try {
        // (a) claim GC, only locking when there is something to prune.
        const record = await loadPoolRecord(pool.key);
        const expiredCount = record?.claims.filter((claim) => claimExpired(claim, nowMs)).length ?? 0;
        if (expiredCount > 0) {
          await withPoolLock(pool.key, async () => {
            const fresh = await loadPoolRecord(pool.key);
            if (!fresh) return;
            const keep = fresh.claims.filter((claim) => !claimExpired(claim, nowMs));
            if (keep.length === fresh.claims.length) return;
            outcome.gcExpired = fresh.claims.length - keep.length;
            fresh.claims = keep;
            await savePoolRecord(fresh);
          });
        }

        const occupancy = deriveMemberOccupancy({
          members: pool.members,
          config: pool.config,
          claims: (await loadPoolRecord(pool.key))?.claims ?? [],
          parked: record?.parked ?? [],
          liveBees,
          now: nowMs,
        });
        const view = memberSweepView(occupancy, pool.config.branch);
        const plan = planPoolSweep({
          members: view,
          previousOccupied: previousOccupied.get(pool.key),
          ...(pool.config.minFree !== undefined ? { minFree: pool.config.minFree } : {}),
        });

        // (b) refresh-on-vacate.
        if (plan.syncMembers.length > 0) {
          const names = plan.syncMembers.map((n) => `${pool.repo}:${pool.pool}-${n}`);
          const result = await sync(pool.repoPath, names);
          outcome.synced = result.rows.map((row) => ({
            member: memberNumberFromPath(row.path, pool.pool),
            status: row.status,
          }));
        }

        // Flags: nudge once per (member, reason) until the condition clears.
        const prevOccupants = previousOccupants.get(pool.key);
        const flagged: PoolSweepOutcome["flagged"] = [];
        for (const flag of plan.flags) {
          const dedupe = `${pool.key}:${flag.member}:${flag.reason}`;
          if (nudged.has(dedupe)) continue;
          nudged.add(dedupe);
          const nudgedParent = await nudgeDepartedBeeParent({
            pool,
            member: flag.member,
            reason: flag.reason,
            departedNames: (prevOccupants?.get(flag.member) ?? []).filter(
              (name) => !occupancy.find((m) => m.n === flag.member)?.occupants.includes(name),
            ),
            recordByName,
            currentStates,
            sendNudge,
          });
          flagged.push({ member: flag.member, reason: flag.reason, ...(nudgedParent ? { nudged: nudgedParent } : {}) });
          await (deps.appendLedger ?? (async () => undefined))({
            type: "pool.member.flagged",
            pool: pool.key,
            member: flag.member,
            reason: flag.reason,
          });
        }
        if (flagged.length > 0) outcome.flagged = flagged;
        // Re-arm cleared flags so a future recurrence nudges again.
        for (const member of view) {
          if (!member.dirty) nudged.delete(`${pool.key}:${member.n}:dirty`);
          if (member.onBaseBranch) nudged.delete(`${pool.key}:${member.n}:parked-branch`);
        }

        // (c) minFree pre-extend — background; report started/finished.
        const settled = settledExtends.get(pool.key);
        if (settled) {
          settledExtends.delete(pool.key);
          if (settled.error !== undefined) outcome.error = `pre-extend failed: ${settled.error}`;
          else if (settled.created !== undefined) outcome.extended = settled.created;
        }
        if (plan.extendBy > 0 && !inFlightExtends.has(pool.key)) {
          const newSize = pool.members.length + plan.extendBy;
          if (newSize > pool.config.maxSize) {
            outcome.warned = `pool ${pool.pool} pre-extend exceeds maxSize: ${newSize}/${pool.config.maxSize} — consider cleaning or raising maxSize`;
          }
          const pending = extend(pool.repoPath, pool.pool, plan.extendBy);
          inFlightExtends.set(pool.key, pending);
          void pending
            .then((created) => settledExtends.set(pool.key, { created: created.length }))
            .catch((error: unknown) => settledExtends.set(pool.key, { error: error instanceof Error ? error.message : String(error) }))
            .finally(() => inFlightExtends.delete(pool.key));
          outcome.extendStarted = plan.extendBy;
        }

        previousOccupied.set(pool.key, plan.occupiedNow);
        previousOccupants.set(
          pool.key,
          new Map(occupancy.map((member) => [member.n, member.occupants])),
        );
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error);
      }
      if (
        outcome.gcExpired !== undefined ||
        outcome.synced !== undefined ||
        outcome.flagged !== undefined ||
        outcome.extendStarted !== undefined ||
        outcome.extended !== undefined ||
        outcome.warned !== undefined ||
        outcome.error !== undefined
      ) {
        outcomes.push(outcome);
      }
    }
    return outcomes;
  };
}

/** Back out the member number from a sync row's path (`…/<pool>-<n>`), -1 when unparseable. */
export function memberNumberFromPath(path: string, pool: string): number {
  const base = path.split("/").pop() ?? "";
  if (!base.startsWith(`${pool}-`)) return -1;
  const n = Number(base.slice(pool.length + 1));
  return Number.isInteger(n) ? n : -1;
}

/**
 * Best-effort "buz nudge" for a flagged member: delivered to the departed
 * bee's living parent (spawnedById) — the orchestrator that owns the cleanup
 * decision. There is no operator-addressed buz channel; when no living parent
 * exists the flag still reaches the operator via the ledger event, the daemon
 * warn log, and `hive pool status`. Returns the nudged parent's name.
 */
async function nudgeDepartedBeeParent(input: {
  pool: ResolvedPool;
  member: number;
  reason: PoolFlagReason;
  departedNames: string[];
  recordByName: Map<string, SessionRecord>;
  currentStates: Map<string, BeeState>;
  sendNudge: (recipient: SessionRecord, senderBee: SessionRecord, body: string) => Promise<void>;
}): Promise<string | undefined> {
  for (const name of input.departedNames) {
    const departed = input.recordByName.get(name);
    if (!departed?.spawnedById) continue;
    const parent = [...input.recordByName.values()].find(
      (candidate) => candidate.id === departed.spawnedById || candidate.name === departed.spawnedById,
    );
    if (!parent) continue;
    const parentState = input.currentStates.get(parent.name);
    if (parentState !== undefined && isTerminalState(parentState)) continue;
    const memberName = `${input.pool.pool}-${input.member}`;
    const why = input.reason === "dirty" ? "a dirty worktree" : `a non-base branch`;
    try {
      await input.sendNudge(
        parent,
        departed,
        [
          `Pool member ${memberName} (${input.pool.repo}) was left with ${why} by "${name}".`,
          `It is withheld from refresh until a human (or you) resolves it — never auto-reset.`,
          `Inspect with: hive pool status ${input.pool.pool}`,
        ].join("\n"),
      );
      return parent.name;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
