import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bindPoolClaim,
  claimExpired,
  deriveMemberOccupancy,
  dropPoolClaimsForBee,
  emptyPoolRecord,
  liveBeesFromSessions,
  loadPoolRecord,
  occupantsForPath,
  pickPoolMember,
  planPoolAllocations,
  poolKeyFor,
  releasePoolClaim,
  releasePoolMemberClaims,
  savePoolRecord,
  setPoolMemberParked,
  validPoolKey,
  type MemberOccupancy,
  type PoolClaim,
  type ResolvedPool,
} from "../src/pool.js";
import type { ProPoolConfig, ProPoolMember } from "../src/proProjects.js";
import { liveTargetKey, type StateContext } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

const NOW = Date.parse("2026-07-04T12:00:00Z");

function member(n: number, overrides: Partial<ProPoolMember> = {}): ProPoolMember {
  return { repo: "widget", pool: "core", n, path: `/p/checkouts/widget/core-${n}`, branch: "main", dirty: false, ...overrides };
}

function config(overrides: Partial<ProPoolConfig> = {}): ProPoolConfig {
  return { repo: "widget", name: "core", branch: "main", maxOccupancy: 1, maxSize: 32, ...overrides };
}

function claim(n: number, overrides: Partial<PoolClaim> = {}): PoolClaim {
  return {
    id: `claim-${n}-${overrides.beeName ?? "unbound"}`,
    member: n,
    path: `/p/checkouts/widget/core-${n}`,
    claimedAt: new Date(NOW - 1000).toISOString(),
    pendingUntil: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

// ── occupancy derivation (§6.2) ───────────────────────────────────────────────

test("deriveMemberOccupancy counts inhabitants by realpath prefix (cwd may be a subdir)", () => {
  const occupancy = deriveMemberOccupancy({
    members: [member(1), member(2)],
    config: config(),
    claims: [],
    parked: [],
    liveBees: [
      { name: "deep", cwd: "/p/checkouts/widget/core-1/src/nested" },
      { name: "exact", cwd: "/p/checkouts/widget/core-2" },
      { name: "cousin", cwd: "/p/checkouts/widget/core-22" }, // sibling dir — must NOT match core-2
      { name: "elsewhere", cwd: "/somewhere/else" },
    ],
    now: NOW,
  });
  assert.deepEqual(occupancy.map((m) => m.occupants), [["deep"], ["exact"]]);
  assert.deepEqual(occupancy.map((m) => m.free), [0, 0]);
});

test("deriveMemberOccupancy: unconsumed claims count toward occupancy, expired claims never do", () => {
  const occupancy = deriveMemberOccupancy({
    members: [member(1), member(2)],
    config: config(),
    claims: [
      claim(1), // pending, unbound, no bee → counts
      claim(2, { id: "expired", pendingUntil: new Date(NOW - 1).toISOString() }), // expired → ignored
    ],
    parked: [],
    liveBees: [],
    now: NOW,
  });
  assert.equal(occupancy[0]!.pendingClaims.length, 1);
  assert.equal(occupancy[0]!.free, 0);
  assert.equal(occupancy[1]!.pendingClaims.length, 0);
  assert.equal(occupancy[1]!.free, 1);
});

test("deriveMemberOccupancy: a claim bound to a live bee is consumed (no double count)", () => {
  const occupancy = deriveMemberOccupancy({
    members: [member(1)],
    config: config({ maxOccupancy: 2 }),
    claims: [claim(1, { beeName: "b1" })],
    parked: [],
    liveBees: [{ name: "b1", cwd: "/p/checkouts/widget/core-1" }],
    now: NOW,
  });
  assert.deepEqual(occupancy[0]!.occupants, ["b1"]);
  assert.equal(occupancy[0]!.pendingClaims.length, 0);
  assert.equal(occupancy[0]!.free, 1); // 2 − 1 inhabitant − 0 pending
});

test("deriveMemberOccupancy: an unbound claim is consumed by an inhabitant beyond bound-claim coverage", () => {
  // The seconds-wide window where the spawned bee's record exists but its
  // claim has not been bound yet: bee + its own claim must count once, not twice.
  const occupancy = deriveMemberOccupancy({
    members: [member(1)],
    config: config({ maxOccupancy: 2 }),
    claims: [claim(1)],
    parked: [],
    liveBees: [{ name: "just-spawned", cwd: "/p/checkouts/widget/core-1" }],
    now: NOW,
  });
  assert.equal(occupancy[0]!.pendingClaims.length, 0);
  assert.equal(occupancy[0]!.free, 1);
});

test("deriveMemberOccupancy: a claim bound to a DEAD bee stays pending until expiry", () => {
  const occupancy = deriveMemberOccupancy({
    members: [member(1)],
    config: config(),
    claims: [claim(1, { beeName: "vanished" })],
    parked: [],
    liveBees: [],
    now: NOW,
  });
  assert.equal(occupancy[0]!.pendingClaims.length, 1);
  assert.equal(occupancy[0]!.free, 0);
});

test("deriveMemberOccupancy: parked members report free 0 regardless of capacity", () => {
  const occupancy = deriveMemberOccupancy({
    members: [member(1), member(2)],
    config: config({ maxOccupancy: 3 }),
    claims: [],
    parked: [2],
    liveBees: [],
    now: NOW,
  });
  assert.equal(occupancy[0]!.free, 3);
  assert.equal(occupancy[1]!.parked, true);
  assert.equal(occupancy[1]!.free, 0);
});

test("occupantsForPath is a plain prefix matcher (ad-hoc checkout occupancy)", () => {
  const bees = [
    { name: "a", cwd: "/p/checkouts/widget/wip/sub" },
    { name: "b", cwd: "/p/checkouts/widget/wip-2" },
  ];
  assert.deepEqual(occupantsForPath("/p/checkouts/widget/wip", bees).map((bee) => bee.name), ["a"]);
});

test("claimExpired treats an unparseable pendingUntil as expired", () => {
  assert.equal(claimExpired(claim(1, { pendingUntil: "not-a-date" }), NOW), true);
});

// ── allocation policy (§6.3) ─────────────────────────────────────────────────

function occ(n: number, free: number, overrides: Partial<MemberOccupancy> = {}): MemberOccupancy {
  return {
    n,
    path: `/p/checkouts/widget/core-${n}`,
    branch: "main",
    dirty: false,
    parked: false,
    occupants: [],
    pendingClaims: [],
    free,
    ...overrides,
  };
}

test("pickPoolMember picks the EMPTIEST free member below cap", () => {
  const picked = pickPoolMember([occ(1, 1), occ(2, 3), occ(3, 2)], 0);
  assert.equal(picked?.n, 2);
});

test("pickPoolMember breaks ties round-robin: first member number > rrCursor, wrapping", () => {
  const members = [occ(1, 1), occ(2, 1), occ(3, 1)];
  assert.equal(pickPoolMember(members, 0)?.n, 1);
  assert.equal(pickPoolMember(members, 1)?.n, 2);
  assert.equal(pickPoolMember(members, 2)?.n, 3);
  assert.equal(pickPoolMember(members, 3)?.n, 1); // wrap
  assert.equal(pickPoolMember(members, 99)?.n, 1); // cursor beyond roster wraps too
});

test("pickPoolMember skips parked and full members; undefined when none free", () => {
  assert.equal(pickPoolMember([occ(1, 0), occ(2, 1, { parked: true, free: 0 })], 0), undefined);
  assert.equal(pickPoolMember([occ(1, 0), occ(2, 1)], 0)?.n, 2);
});

test("planPoolAllocations walks the rotation, decrementing simulated capacity", () => {
  const plan = planPoolAllocations([occ(1, 1), occ(2, 1), occ(3, 1)], 1, 2);
  assert.deepEqual(plan.picks.map((pick) => pick.n), [2, 3]);
  assert.equal(plan.rrCursor, 3);
  assert.equal(plan.shortfall, 0);
});

test("planPoolAllocations reuses the emptiest member when maxOccupancy allows it", () => {
  const plan = planPoolAllocations([occ(1, 2), occ(2, 1)], 0, 3);
  // free 2 beats free 1 → pick 1; then all tie at free 1 → rr from cursor 1 → 2; then 1 again.
  assert.deepEqual(plan.picks.map((pick) => pick.n), [1, 2, 1]);
  assert.equal(plan.shortfall, 0);
});

test("planPoolAllocations reports shortfall when capacity runs out (auto-extend covers it)", () => {
  const plan = planPoolAllocations([occ(1, 1)], 0, 3);
  assert.deepEqual(plan.picks.map((pick) => pick.n), [1]);
  assert.equal(plan.shortfall, 2);
});

// ── pool records + claim lifecycle (scratch HIVE_STORE_ROOT) ─────────────────

async function withTempStore(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-pool-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const FACETS = { area: "lab", project: "demo", repo: "widget", pool: "core" };
const KEY = poolKeyFor(FACETS);

test("poolKeyFor slugs the facets; validPoolKey rejects traversal-ish keys", () => {
  assert.equal(KEY, "lab-demo-widget-core");
  assert.equal(validPoolKey(KEY), true);
  assert.equal(validPoolKey("../escape"), false);
  assert.equal(validPoolKey(""), false);
});

test("pool records roundtrip; a deleted or garbled file reads as absent (state rebuilds)", async () => {
  await withTempStore(async (root) => {
    assert.equal(await loadPoolRecord(KEY), null);
    const record = emptyPoolRecord(FACETS);
    record.rrCursor = 3;
    record.claims.push(claim(3, { beeName: "b3" }));
    record.parked = [5];
    await savePoolRecord(record);
    const loaded = await loadPoolRecord(KEY);
    assert.deepEqual(loaded, record);

    await writeFile(join(root, "pools", `${KEY}.json`), "{ not json");
    assert.equal(await loadPoolRecord(KEY), null);
  });
});

test("emptyPoolRecord persists ONLY non-derivable state even when handed a full ResolvedPool", async () => {
  await withTempStore(async () => {
    const resolved: ResolvedPool = { key: KEY, ...FACETS, repoPath: "/p/repos/widget", config: config(), members: [member(1)] };
    await savePoolRecord(emptyPoolRecord(resolved));
    const raw = JSON.parse(await readFile(join(process.env.HIVE_STORE_ROOT!, "pools", `${KEY}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(raw.repoPath, undefined);
    assert.equal(raw.config, undefined);
    assert.equal(raw.members, undefined);
  });
});

test("bind/release/drop claim lifecycle under the pool lock", async () => {
  await withTempStore(async () => {
    const record = emptyPoolRecord(FACETS);
    record.claims.push(claim(1, { id: "c1" }), claim(1, { id: "c1b" }), claim(2, { id: "c2" }));
    await savePoolRecord(record);

    // Concurrent binds both persist — a lockless read-modify-write would lose one.
    await Promise.all([bindPoolClaim(KEY, "c1", "bee-a"), bindPoolClaim(KEY, "c2", "bee-b")]);
    let loaded = await loadPoolRecord(KEY);
    assert.deepEqual(loaded!.claims.map((c) => c.beeName), ["bee-a", undefined, "bee-b"]);

    await releasePoolClaim(KEY, "c1b");
    await dropPoolClaimsForBee(KEY, "bee-b");
    loaded = await loadPoolRecord(KEY);
    assert.deepEqual(loaded!.claims.map((c) => c.id), ["c1"]);

    assert.equal(await releasePoolMemberClaims(KEY, 1), 1);
    loaded = await loadPoolRecord(KEY);
    assert.equal(loaded!.claims.length, 0);

    // All idempotent on missing claims/records.
    await releasePoolClaim(KEY, "ghost");
    await dropPoolClaimsForBee("lab-demo-widget-nope", "bee-a");
  });
});

test("setPoolMemberParked adds/removes members and validates against the roster", async () => {
  await withTempStore(async () => {
    const resolved: ResolvedPool = { key: KEY, ...FACETS, repoPath: "/p/repos/widget", config: config(), members: [member(1), member(2)] };
    await setPoolMemberParked(resolved, 2, true);
    assert.deepEqual((await loadPoolRecord(KEY))!.parked, [2]);
    await setPoolMemberParked(resolved, 2, true); // idempotent
    assert.deepEqual((await loadPoolRecord(KEY))!.parked, [2]);
    await setPoolMemberParked(resolved, 2, false);
    assert.deepEqual((await loadPoolRecord(KEY))!.parked, []);
    await assert.rejects(setPoolMemberParked(resolved, 9, true), /no member 9/);
  });
});

// ── liveBeesFromSessions (occupancy input from fabricated SessionRecords) ────

function session(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "claude",
    cwd: `/p/checkouts/widget/core-1`,
    command: "claude",
    tmuxTarget: name,
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    status: "running",
    ...overrides,
  };
}

test("liveBeesFromSessions keeps non-terminal local bees and drops dead/sealed/remote ones", async () => {
  await withTempStore(async () => {
    // Seals are read from disk by deriveState context builders; here the context
    // is fabricated directly, so no store I/O happens.
    const records = [
      session("alive"),
      session("dead-bee"),
      session("sealed-bee"),
      session("remote-bee", { node: "mini01" }),
      session("hsr-alive", { substrate: "hsr" }),
      session("archived-bee", { status: "archived" }),
    ];
    const context: StateContext = {
      liveTargets: new Set([liveTargetKey(undefined, "alive"), liveTargetKey(undefined, "sealed-bee"), liveTargetKey("mini01", "remote-bee")]),
      seals: new Set(["sealed-bee"]),
      hsrLive: new Set(["hsr-alive"]),
      now: NOW,
    };
    const bees = liveBeesFromSessions(records, context);
    assert.deepEqual(bees.map((bee) => bee.name).sort(), ["alive", "hsr-alive"]);
    assert.equal(bees[0]!.cwd, "/p/checkouts/widget/core-1");
  });
});
