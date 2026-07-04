import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPoolSweeper, memberNumberFromPath, memberSweepView, planPoolSweep, type MemberSweepView } from "../src/daemon/poolSweep.js";
import { emptyPoolRecord, poolKeyFor, loadPoolRecord, savePoolRecord, type PoolClaim, type ResolvedPool } from "../src/pool.js";
import type { ProRepoEntry } from "../src/proProjects.js";
import type { BeeState } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

const NOW = Date.parse("2026-07-04T12:00:00Z");

function view(n: number, overrides: Partial<MemberSweepView> = {}): MemberSweepView {
  return { n, occupied: false, parked: false, dirty: false, onBaseBranch: true, free: 1, ...overrides };
}

// ── pure planner ─────────────────────────────────────────────────────────────

test("planPoolSweep: first observation is a baseline — no vacate edges, no syncs", () => {
  const plan = planPoolSweep({ members: [view(1), view(2, { occupied: true })], previousOccupied: undefined });
  assert.deepEqual(plan.syncMembers, []);
  assert.deepEqual(plan.flags, []);
  assert.deepEqual([...plan.occupiedNow], [2]);
});

test("planPoolSweep: inhabited→free edge syncs clean on-base members only", () => {
  const plan = planPoolSweep({
    members: [
      view(1), // vacated, clean → sync
      view(2, { dirty: true }), // vacated dirty → flag
      view(3, { onBaseBranch: false }), // vacated off-base → flag
      view(4, { parked: true }), // vacated but parked → withheld entirely
      view(5, { occupied: true }), // still busy → untouched
      view(6), // was free before → no edge, no sync
    ],
    previousOccupied: new Set([1, 2, 3, 4, 5]),
  });
  assert.deepEqual(plan.syncMembers, [1]);
  assert.deepEqual(plan.flags, [
    { member: 2, reason: "dirty" },
    { member: 3, reason: "parked-branch" },
  ]);
  assert.deepEqual([...plan.occupiedNow], [5]);
});

test("planPoolSweep: minFree shortfall over total free capacity (0 when unset/satisfied)", () => {
  const members = [view(1, { free: 1 }), view(2, { free: 0, occupied: true })];
  assert.equal(planPoolSweep({ members, previousOccupied: new Set() }).extendBy, 0);
  assert.equal(planPoolSweep({ members, previousOccupied: new Set(), minFree: 1 }).extendBy, 0);
  assert.equal(planPoolSweep({ members, previousOccupied: new Set(), minFree: 3 }).extendBy, 2);
});

test("memberSweepView: occupied = live inhabitants OR unconsumed claims; on-base from config branch", () => {
  const claim: PoolClaim = { id: "c", member: 2, path: "/p/2", claimedAt: "x", pendingUntil: "y" };
  const views = memberSweepView(
    [
      { n: 1, path: "/p/1", branch: "main", dirty: false, parked: false, occupants: ["b1"], pendingClaims: [], free: 0 },
      { n: 2, path: "/p/2", branch: "feature-x", dirty: true, parked: false, occupants: [], pendingClaims: [claim], free: 0 },
      { n: 3, path: "/p/3", branch: "main", dirty: false, parked: true, occupants: [], pendingClaims: [], free: 0 },
    ],
    "main",
  );
  assert.deepEqual(views.map((v) => v.occupied), [true, true, false]);
  assert.deepEqual(views.map((v) => v.onBaseBranch), [true, false, true]);
  assert.deepEqual(views.map((v) => v.parked), [false, false, true]);
});

test("memberNumberFromPath parses …/<pool>-<n>, -1 otherwise", () => {
  assert.equal(memberNumberFromPath("/p/checkouts/widget/core-12", "core"), 12);
  assert.equal(memberNumberFromPath("/p/checkouts/widget/other-1", "core"), -1);
  assert.equal(memberNumberFromPath("/p/checkouts/widget/core-x", "core"), -1);
});

// ── stateful sweeper (injected deps, scratch HIVE_STORE_ROOT) ────────────────

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-sweep-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const FACETS = { area: "lab", project: "demo", repo: "widget", pool: "core" };
const KEY = poolKeyFor(FACETS);
const ENTRY: ProRepoEntry = { area: "lab", project: "demo", repo: "widget", path: "/p/lab/demo/repos/widget" };

function resolvedPool(overrides: { minFree?: number; dirty?: boolean; branch?: string } = {}): ResolvedPool {
  return {
    key: KEY,
    ...FACETS,
    repoPath: ENTRY.path,
    config: { repo: "widget", name: "core", branch: "main", maxOccupancy: 1, maxSize: 2, ...(overrides.minFree !== undefined ? { minFree: overrides.minFree } : {}) },
    members: [
      {
        repo: "widget",
        pool: "core",
        n: 1,
        path: "/p/lab/demo/checkouts/widget/core-1",
        branch: overrides.branch ?? "main",
        dirty: overrides.dirty ?? false,
      },
    ],
  };
}

function bee(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "claude",
    cwd: "/p/lab/demo/checkouts/widget/core-1",
    command: "claude",
    tmuxTarget: name,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    status: "running",
    ...overrides,
  };
}

type SweeperHarness = {
  sweep: ReturnType<typeof createPoolSweeper>;
  advance: (ms: number) => void;
  syncCalls: Array<{ repoPath: string; names: string[] }>;
  extendCalls: Array<{ pool: string; count: number }>;
  nudges: Array<{ to: string; from: string; body: string }>;
  ledger: Array<Record<string, unknown>>;
};

function buildSweeper(pool: () => ResolvedPool): SweeperHarness {
  let clock = NOW;
  const harness: SweeperHarness = {
    advance: (ms) => {
      clock += ms;
    },
    syncCalls: [],
    extendCalls: [],
    nudges: [],
    ledger: [],
    sweep: createPoolSweeper({
      intervalMs: 1000,
      now: () => clock,
      listRepoEntries: async () => [ENTRY],
      discoverPools: async () => [pool()],
      sync: async (repoPath, names) => {
        harness.syncCalls.push({ repoPath, names });
        return { ok: true, rows: names.map((name) => ({ status: "synced-ff", path: `/p/lab/demo/checkouts/widget/${name.split(":")[1]}` })), detail: "" };
      },
      extend: async (_repoPath, poolName, count) => {
        harness.extendCalls.push({ pool: poolName, count });
        return Array.from({ length: count }, (_, i) => `/p/new-${i + 1}`);
      },
      sendNudge: async (recipient, senderBee, body) => {
        harness.nudges.push({ to: recipient.name, from: senderBee.name, body });
      },
      appendLedger: async (event) => {
        harness.ledger.push(event);
      },
    }),
  };
  return harness;
}

test("sweeper: throttles to its interval (second call within it returns [])", async () => {
  await withTempStore(async () => {
    const h = buildSweeper(() => resolvedPool());
    await h.sweep([], new Map());
    const again = await h.sweep([], new Map());
    assert.deepEqual(again, []);
  });
});

test("sweeper: GCs expired claims under the lock", async () => {
  await withTempStore(async () => {
    const record = emptyPoolRecord(FACETS);
    record.claims.push(
      { id: "old", member: 1, path: "/p/1", claimedAt: "x", pendingUntil: new Date(NOW - 1).toISOString() },
      { id: "live", member: 1, path: "/p/1", claimedAt: "x", pendingUntil: new Date(NOW + 60_000).toISOString() },
    );
    await savePoolRecord(record);
    const h = buildSweeper(() => resolvedPool());
    const outcomes = await h.sweep([], new Map());
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.gcExpired, 1);
    assert.deepEqual((await loadPoolRecord(KEY))!.claims.map((c) => c.id), ["live"]);
  });
});

test("sweeper: refresh-on-vacate syncs a member the tick observed going terminal", async () => {
  await withTempStore(async () => {
    const h = buildSweeper(() => resolvedPool());
    const records = [bee("b1")];
    // Sweep 1: b1 occupies core-1 (baseline; nothing synced).
    let outcomes = await h.sweep(records, new Map<string, BeeState>([["b1", "active"]]));
    assert.deepEqual(outcomes, []);
    assert.equal(h.syncCalls.length, 0);
    // Sweep 2: b1 is dead → vacate edge → sync exactly that member.
    h.advance(1500);
    outcomes = await h.sweep(records, new Map<string, BeeState>([["b1", "dead"]]));
    assert.deepEqual(h.syncCalls, [{ repoPath: ENTRY.path, names: ["widget:core-1"] }]);
    assert.deepEqual(outcomes[0]!.synced, [{ member: 1, status: "synced-ff" }]);
  });
});

test("sweeper: a member left dirty is flagged once (nudge to the departed bee's parent), never synced", async () => {
  await withTempStore(async () => {
    const h = buildSweeper(() => resolvedPool({ dirty: true }));
    const records = [
      bee("queen", { id: "Q1", cwd: "/elsewhere" }),
      bee("b1", { spawnedById: "Q1" }),
    ];
    await h.sweep(records, new Map<string, BeeState>([["queen", "active"], ["b1", "active"]]));
    h.advance(1500);
    const outcomes = await h.sweep(records, new Map<string, BeeState>([["queen", "active"], ["b1", "dead"]]));
    assert.equal(h.syncCalls.length, 0, "dirty member is never auto-reset/synced");
    assert.deepEqual(outcomes[0]!.flagged, [{ member: 1, reason: "dirty", nudged: "queen" }]);
    assert.equal(h.nudges.length, 1);
    assert.equal(h.nudges[0]!.to, "queen");
    assert.match(h.nudges[0]!.body, /core-1/);
    assert.deepEqual(h.ledger, [{ type: "pool.member.flagged", pool: KEY, member: 1, reason: "dirty" }]);
    // Still dirty on the next vacate cycle → de-duped, no second nudge.
    h.advance(1500);
    await h.sweep(records, new Map<string, BeeState>([["queen", "active"], ["b1", "active"]]));
    h.advance(1500);
    const again = await h.sweep(records, new Map<string, BeeState>([["queen", "active"], ["b1", "dead"]]));
    assert.equal(h.nudges.length, 1);
    assert.equal(again[0]?.flagged, undefined);
  });
});

test("sweeper: minFree pre-extends in the background and reports completion next sweep", async () => {
  await withTempStore(async () => {
    // 1 member, occ 1, free 1, minFree 3 → shortfall 2; maxSize 2 → loud warning.
    const h = buildSweeper(() => resolvedPool({ minFree: 3 }));
    const first = await h.sweep([], new Map());
    assert.deepEqual(h.extendCalls, [{ pool: "core", count: 2 }]);
    assert.equal(first[0]!.extendStarted, 2);
    assert.match(first[0]!.warned ?? "", /exceeds maxSize: 3\/2/);
    // Let the background extend settle, then the next sweep reports it. The
    // roster still shows free 1 < minFree, but the in-flight/settled bookkeeping
    // prevents a duplicate extend within the same settle cycle.
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.advance(1500);
    const second = await h.sweep([], new Map());
    assert.equal(second[0]!.extended, 2);
  });
});

test("sweeper: a broken pool discovery or sync never throws out of the sweep", async () => {
  await withTempStore(async () => {
    let clock = NOW;
    const sweep = createPoolSweeper({
      intervalMs: 1000,
      now: () => clock,
      listRepoEntries: async () => [ENTRY],
      discoverPools: async () => {
        throw new Error("pro exploded");
      },
    });
    assert.deepEqual(await sweep([], new Map()), []);
    clock += 1500;
    // Sync failure path: discovery works, sync throws → outcome.error, no throw.
    const h = buildSweeper(() => resolvedPool());
    const failing = createPoolSweeper({
      intervalMs: 1000,
      now: () => clock,
      listRepoEntries: async () => [ENTRY],
      discoverPools: async () => [resolvedPool()],
      sync: async () => {
        throw new Error("sync exploded");
      },
      sendNudge: async () => undefined,
      appendLedger: async () => undefined,
    });
    const records = [bee("b1")];
    await failing(records, new Map<string, BeeState>([["b1", "active"]]));
    clock += 1500;
    const outcomes = await failing(records, new Map<string, BeeState>([["b1", "dead"]]));
    assert.match(outcomes[0]!.error ?? "", /sync exploded/);
    void h;
  });
});
