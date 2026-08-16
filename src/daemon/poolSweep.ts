// Checkout-pool daemon sweep (CHECKOUT_POOLS_PRD §6.6). Three duties per pool:
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
// Occupancy is safety-critical: the sweep takes the same strict durable-record
// and local-runtime snapshot as allocation. An unreadable observation fails
// the entire discovered sweep closed before any pool state or checkout is
// mutated. Every later per-pool step is try/caught into the outcome — a broken
// pool (or a pool-less pro) must never break the tick.

import { sendBuzMessage } from "../buz.js";
import {
  canonicalizePoolMembers,
  claimExpired,
  deriveMemberOccupancy,
  loadPoolRecord,
  poolsForProject,
  poolLiveBees,
  projectRepresentatives,
  refreshResolvedPool,
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
import { isTerminalState, type BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";
import { envMs } from "./timeouts.js";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;

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
  /** Detached scheduler diagnostic; `pool: "*"` means lane-wide. */
  action?: "started" | "completed";
  durationMs?: number;
  poolsDiscovered?: number;
  skippedWhileInFlight?: number;
  throttledTicks?: number;
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
  /** Strict positive-runtime occupancy observer; injectable for tests. */
  observeLiveBees?: (records: SessionRecord[], currentStates: Map<string, BeeState>) => Promise<LiveBee[]>;
  /** Canonical member identity observer; injectable for tests. */
  canonicalizeMembers?: typeof canonicalizePoolMembers;
  /** Fresh pro roster/config resolver, always called after the pool lock is acquired. */
  refreshPool?: (pool: ResolvedPool) => Promise<ResolvedPool>;
  /** @internal deterministic background-job scheduler for concurrency tests. */
  startBackground?: (job: () => Promise<void>) => void;
  /**
   * Production daemon mode: the tick only starts/collects one shared sweep lane.
   * The full project/pool discovery and checkout work never runs inline with
   * the 5s observation loop.
   */
  detached?: boolean;
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
  const observeLiveBees = deps.observeLiveBees ?? (() => poolLiveBees());
  const canonicalizeMembers = deps.canonicalizeMembers ?? canonicalizePoolMembers;
  const refreshPool = deps.refreshPool ?? ((pool: ResolvedPool) => refreshResolvedPool(pool, deps.listPools ?? listProPools));
  const startBackground = deps.startBackground ?? ((job: () => Promise<void>) => {
    queueMicrotask(() => void job());
  });
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
  type BackgroundExtendResult = { created: number; warned?: string };
  /** poolKey → background pre-extend in flight. */
  const inFlightExtends = new Map<string, Promise<BackgroundExtendResult>>();
  /** poolKey → settled background result awaiting report. */
  const settledExtends = new Map<string, { created?: number; warned?: string; error?: string }>();

  /**
   * The long clone runs outside the daemon tick, but its own job takes the same
   * cross-process lock as allocation/manual extend. Once acquired it discards
   * the scheduling snapshot and re-resolves every capacity input before holding
   * the lock through the complete external mutation.
   */
  const runBackgroundExtend = (
    scheduledPool: ResolvedPool,
    records: SessionRecord[],
    currentStates: Map<string, BeeState>,
  ): Promise<BackgroundExtendResult> => withPoolLock(scheduledPool.key, async () => {
    const current = await refreshPool(scheduledPool);
    const members = await canonicalizeMembers(current.members);
    const liveBees = await observeLiveBees(records, currentStates);
    const record = await loadPoolRecord(current.key);
    const nowMs = now();
    const occupancy = deriveMemberOccupancy({
      members,
      config: current.config,
      claims: record?.claims ?? [],
      parked: record?.parked ?? [],
      liveBees,
      now: nowMs,
    });
    const needed = current.config.minFree === undefined
      ? 0
      : Math.max(0, current.config.minFree - occupancy.reduce((sum, member) => sum + member.free, 0));
    if (needed === 0) return { created: 0 };
    const newSize = members.length + needed;
    const warned = newSize > current.config.maxSize
      ? `pool ${current.pool} pre-extend exceeds maxSize: ${newSize}/${current.config.maxSize} — consider cleaning or raising maxSize`
      : undefined;
    const created = await extend(current.repoPath, current.pool, needed);
    return { created: created.length, ...(warned ? { warned } : {}) };
  });

  const runSweepPass = async (records: SessionRecord[], currentStates: Map<string, BeeState>) => {
    const nowMs = now();

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
    if (pools.length === 0) return { outcomes, poolsDiscovered: 0 };

    // This barrier is deliberately after discovery but before any per-pool
    // mutation. A display-terminal state does not release capacity: only the
    // strict observer's positively absent runtime can create a vacate edge.
    let liveBees: LiveBee[];
    try {
      liveBees = await observeLiveBees(records, currentStates);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        outcomes: pools.map((pool) => ({ pool: pool.key, error: `occupancy observation failed closed: ${detail}` })),
        poolsDiscovered: pools.length,
      };
    }

    for (const pool of pools) {
      const outcome: PoolSweepOutcome = { pool: pool.key };
      let scheduleExtend = false;
      let scheduledPool = pool;
      try {
        // Member canonicalization is another observation barrier: a lexical
        // symlink spelling can hide an occupant whose SessionRecord.cwd is a
        // realpath. Resolve it before claim GC or any checkout mutation.
        // The decision and every checkout mutation share the allocator's pool
        // lock. Otherwise a claim/park could land after this occupancy read but
        // before sync, letting refresh-on-vacate rewrite a newly owned member.
        await withPoolLock(pool.key, async () => {
          const current = await refreshPool(pool);
          scheduledPool = current;
          const canonicalMembers = await canonicalizeMembers(current.members);
          // (a) claim GC.
          const record = await loadPoolRecord(pool.key);
          if (record) {
            const keep = record.claims.filter((claim) => !claimExpired(claim, nowMs));
            if (keep.length !== record.claims.length) {
              outcome.gcExpired = record.claims.length - keep.length;
              record.claims = keep;
              await savePoolRecord(record);
            }
          }

          const occupancy = deriveMemberOccupancy({
            members: canonicalMembers,
            config: current.config,
            claims: record?.claims ?? [],
            parked: record?.parked ?? [],
            liveBees,
            now: nowMs,
          });
          const view = memberSweepView(occupancy, current.config.branch);
          const plan = planPoolSweep({
            members: view,
            previousOccupied: previousOccupied.get(pool.key),
            ...(current.config.minFree !== undefined ? { minFree: current.config.minFree } : {}),
          });

          // (b) refresh-on-vacate.
          if (plan.syncMembers.length > 0) {
            const names = plan.syncMembers.map((n) => `${current.repo}:${current.pool}-${n}`);
            const result = await sync(current.repoPath, names);
            outcome.synced = result.rows.map((row) => ({
              member: memberNumberFromPath(row.path, current.pool),
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
              pool: current,
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
            if (settled.warned !== undefined) outcome.warned = settled.warned;
          }
          if (!settled && plan.extendBy > 0 && !inFlightExtends.has(pool.key)) {
            scheduleExtend = true;
            outcome.extendStarted = plan.extendBy;
          }

          previousOccupied.set(pool.key, plan.occupiedNow);
          previousOccupants.set(
            pool.key,
            new Map(occupancy.map((member) => [member.n, member.occupants])),
          );
        });
        // Start only after the decision lock above has been released. Starting
        // this job from inside it would recursively wait on the same file lock.
        if (scheduleExtend && !inFlightExtends.has(pool.key)) {
          let resolvePending!: (result: BackgroundExtendResult) => void;
          let rejectPending!: (error: unknown) => void;
          const pending = new Promise<BackgroundExtendResult>((resolve, reject) => {
            resolvePending = resolve;
            rejectPending = reject;
          });
          inFlightExtends.set(pool.key, pending);
          void pending
            .then((result) => settledExtends.set(pool.key, result))
            .catch((error: unknown) => settledExtends.set(pool.key, {
              error: error instanceof Error ? error.message : String(error),
            }))
            .finally(() => inFlightExtends.delete(pool.key));
          try {
            startBackground(async () => {
              try {
                resolvePending(await runBackgroundExtend(scheduledPool, records, currentStates));
              } catch (error) {
                rejectPending(error);
              }
            });
          } catch (error) {
            rejectPending(error);
          }
        }
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
    return { outcomes, poolsDiscovered: pools.length };
  };

  const runThrottled = async (records: SessionRecord[], currentStates: Map<string, BeeState>) => {
    const nowMs = now();
    if (nowMs - lastSweepAt < intervalMs) return [];
    lastSweepAt = nowMs;
    return (await runSweepPass(records, currentStates)).outcomes;
  };

  if (!deps.detached) return runThrottled;

  let inFlight: Promise<void> | undefined;
  let startedAtMs = 0;
  let pending: PoolSweepOutcome[] = [];
  let skippedWhileInFlight = 0;
  let throttledTicks = 0;

  const detached = (async (records: SessionRecord[], currentStates: Map<string, BeeState>) => {
    const report = pending;
    pending = [];
    const nowMs = now();
    if (inFlight) {
      skippedWhileInFlight += 1;
      return report;
    }
    if (nowMs - lastSweepAt < intervalMs) {
      throttledTicks += 1;
      return report;
    }

    lastSweepAt = nowMs;
    startedAtMs = nowMs;
    const startSkipped = skippedWhileInFlight;
    const startThrottled = throttledTicks;
    skippedWhileInFlight = 0;
    throttledTicks = 0;
    report.push({
      pool: "*",
      action: "started",
      ...(startSkipped > 0 ? { skippedWhileInFlight: startSkipped } : {}),
      ...(startThrottled > 0 ? { throttledTicks: startThrottled } : {}),
    });

    const job = async () => {
      try {
        const result = await runSweepPass(records, currentStates);
        pending = [
          {
            pool: "*",
            action: "completed",
            durationMs: Math.max(0, now() - startedAtMs),
            poolsDiscovered: result.poolsDiscovered,
            ...(skippedWhileInFlight > 0 ? { skippedWhileInFlight } : {}),
            ...(throttledTicks > 0 ? { throttledTicks } : {}),
          },
          ...result.outcomes,
        ];
      } catch (error) {
        pending = [{
          pool: "*",
          action: "completed",
          durationMs: Math.max(0, now() - startedAtMs),
          ...(skippedWhileInFlight > 0 ? { skippedWhileInFlight } : {}),
          ...(throttledTicks > 0 ? { throttledTicks } : {}),
          error: error instanceof Error ? error.message : String(error),
        }];
      } finally {
        skippedWhileInFlight = 0;
        throttledTicks = 0;
        inFlight = undefined;
      }
    };
    inFlight = new Promise<void>((resolve, reject) => {
      try {
        startBackground(async () => {
          try {
            await job();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    }).catch((error) => {
      pending = [{
        pool: "*",
        action: "completed",
        durationMs: Math.max(0, now() - startedAtMs),
        error: error instanceof Error ? error.message : String(error),
      }];
    }).finally(() => {
      inFlight = undefined;
    });
    return report;
  }) as PoolSweeper & { close: () => Promise<void> };
  detached.close = async () => {
    await inFlight;
  };
  return detached;
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
