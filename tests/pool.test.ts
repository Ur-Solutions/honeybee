import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allocatePoolMembers,
  bindPoolClaim,
  canonicalizePoolMembers,
  claimSpecificPoolMember,
  claimExpired,
  deriveMemberOccupancy,
  dropPoolClaimsForBee,
  emptyPoolRecord,
  extendPoolMembers,
  liveBeesFromSessions,
  loadPoolRecord,
  occupantsForPath,
  pickPoolMember,
  planPoolAllocations,
  poolLiveBees,
  poolKeyFor,
  releasePoolClaim,
  releasePoolMemberClaims,
  savePoolRecord,
  setPoolMemberParked,
  validPoolKey,
  withPoolLock,
  type MemberOccupancy,
  type PoolClaim,
  type ResolvedPool,
} from "../src/pool.js";
import { isHsrPoolMutatorLive } from "../src/hsr/observe.js";
import {
  inspectProcessGroupBirth,
  type ProcessBirthFingerprint,
  type ProcessIdentityVerdict,
} from "../src/hsr/processIdentity.js";
import type { HsrMeta } from "../src/hsr/runDir.js";
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

test("canonicalizePoolMembers resolves symlink members and never falls back after EACCES/ENOENT", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-pool-realpath-"));
  try {
    const canonical = join(root, "canonical-member");
    const alias = join(root, "member-alias");
    await mkdir(canonical);
    await symlink(canonical, alias, "dir");
    const aliased = member(1, { path: alias });

    assert.equal((await canonicalizePoolMembers([aliased]))[0]!.path, await realpath(canonical));

    for (const code of ["EACCES", "ENOENT"] as const) {
      const failure = Object.assign(new Error(`${code}: canonicalization denied`), { code });
      await assert.rejects(
        canonicalizePoolMembers([aliased], async () => {
          throw failure;
        }),
        (error: unknown) => error === failure,
        `${code} must be propagated rather than substituting the lexical symlink path`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonicalizePoolMembers rejects two roster numbers that alias one physical checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-pool-duplicate-realpath-"));
  try {
    const physical = join(root, "physical");
    const alias1 = join(root, "core-1");
    const alias2 = join(root, "core-2");
    await mkdir(physical);
    await symlink(physical, alias1, "dir");
    await symlink(physical, alias2, "dir");
    await assert.rejects(
      canonicalizePoolMembers([member(1, { path: alias1 }), member(2, { path: alias2 })]),
      /pool roster aliases one physical checkout.*core-1 and widget:core-2.*repair the pro pool roster/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate physical members preserve claims and block allocation, manual claim, and manual extend", async () => {
  await withTempStore(async (root) => {
    const physical = join(root, "physical");
    const alias1 = join(root, "core-1");
    const alias2 = join(root, "core-2");
    await mkdir(physical);
    await symlink(physical, alias1, "dir");
    await symlink(physical, alias2, "dir");
    const duplicates = [member(1, { path: alias1 }), member(2, { path: alias2 })];
    const resolved: ResolvedPool = {
      key: KEY,
      ...FACETS,
      repoPath: join(root, "repo"),
      config: config(),
      members: duplicates,
    };
    const record = emptyPoolRecord(FACETS);
    record.claims.push({
      ...claim(1, { id: "existing" }),
      pendingUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await savePoolRecord(record);
    let externalMutations = 0;

    await assert.rejects(
      allocatePoolMembers(resolved, 1, { liveBees: [], listMembers: async () => duplicates }),
      /pool roster aliases one physical checkout/,
    );
    await assert.rejects(
      claimSpecificPoolMember(resolved, 2, { liveBees: [], listMembers: async () => duplicates }),
      /pool roster aliases one physical checkout/,
    );
    await assert.rejects(
      extendPoolMembers(resolved, 1, {
        refreshPool: async () => resolved,
        extendPool: async () => {
          externalMutations += 1;
          return [];
        },
      }),
      /pool roster aliases one physical checkout/,
    );

    assert.equal(externalMutations, 0);
    assert.deepEqual((await loadPoolRecord(KEY))!.claims.map((entry) => entry.id), ["existing"]);
  });
});

test("allocation and manual claim create no state when symlink member canonicalization fails", async () => {
  await withTempStore(async (root) => {
    const canonical = join(root, "canonical-member");
    const alias = join(root, "member-alias");
    await mkdir(canonical);
    await symlink(canonical, alias, "dir");
    const aliased = member(1, { path: alias });
    const resolved: ResolvedPool = {
      key: KEY,
      ...FACETS,
      repoPath: join(root, "repo"),
      config: config(),
      members: [aliased],
    };
    const listMembers = async () => [aliased];

    const accessDenied = Object.assign(new Error("EACCES: member realpath failed"), { code: "EACCES" });
    await assert.rejects(
      allocatePoolMembers(resolved, 1, {
        liveBees: [],
        listMembers,
        realpathPath: async () => {
          throw accessDenied;
        },
      }),
      (error: unknown) => error === accessDenied,
    );
    assert.equal(await loadPoolRecord(KEY), null);

    const missing = Object.assign(new Error("ENOENT: member realpath failed"), { code: "ENOENT" });
    await assert.rejects(
      claimSpecificPoolMember(resolved, 1, {
        liveBees: [],
        listMembers,
        realpathPath: async () => {
          throw missing;
        },
      }),
      (error: unknown) => error === missing,
    );
    assert.equal(await loadPoolRecord(KEY), null);
  });
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

test("deriveMemberOccupancy: an arbitrary inhabitant never consumes an unbound claim", () => {
  // The allocator cannot prove the inhabitant owns this claim. If it consumed
  // the reservation and the real owner then appeared, maxOccupancy could be
  // exceeded. Double-count briefly until bind is the safe direction.
  const occupancy = deriveMemberOccupancy({
    members: [member(1)],
    config: config({ maxOccupancy: 2 }),
    claims: [claim(1)],
    parked: [],
    liveBees: [{ name: "just-spawned", cwd: "/p/checkouts/widget/core-1" }],
    now: NOW,
  });
  assert.equal(occupancy[0]!.pendingClaims.length, 1);
  assert.equal(occupancy[0]!.free, 0);
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

test("pool records roundtrip; only a genuinely absent file reads as absent", async () => {
  await withTempStore(async (root) => {
    assert.equal(await loadPoolRecord(KEY), null);
    const record = emptyPoolRecord(FACETS);
    record.rrCursor = 3;
    record.claims.push(claim(3, { beeName: "b3" }));
    record.parked = [5];
    await savePoolRecord(record);
    const loaded = await loadPoolRecord(KEY);
    assert.deepEqual(loaded, record);

    await rm(join(root, "pools", `${KEY}.json`));
    assert.equal(await loadPoolRecord(KEY), null);
  });
});

test("corrupt pool JSON is refused by allocation, claim, release, and park paths without replacement", async () => {
  await withTempStore(async (root) => {
    const path = join(root, "pools", `${KEY}.json`);
    await savePoolRecord(emptyPoolRecord(FACETS));
    const corrupt = "{ not json";
    await writeFile(path, corrupt);
    const resolved: ResolvedPool = { key: KEY, ...FACETS, repoPath: "/p/repos/widget", config: config(), members: [member(1)] };

    await assert.rejects(loadPoolRecord(KEY), /is corrupt .*refusing to treat it as empty/);
    await assert.rejects(allocatePoolMembers(resolved, 1, { liveBees: [] }), /is corrupt/);
    await assert.rejects(claimSpecificPoolMember(resolved, 1, { liveBees: [] }), /is corrupt/);
    await assert.rejects(bindPoolClaim(KEY, "c1", "bee"), /is corrupt/);
    await assert.rejects(releasePoolClaim(KEY, "c1"), /is corrupt/);
    await assert.rejects(releasePoolMemberClaims(KEY, 1), /is corrupt/);
    await assert.rejects(dropPoolClaimsForBee(KEY, "bee"), /is corrupt/);
    await assert.rejects(setPoolMemberParked(resolved, 1, true), /is corrupt/);
    assert.equal(await readFile(path, "utf8"), corrupt, "no adjacent mutation may reconstruct or overwrite corrupt truth");
  });
});

test("malformed claims are refused whole so valid pending claims and parked truth are not partially reconstructed", async () => {
  await withTempStore(async (root) => {
    const path = join(root, "pools", `${KEY}.json`);
    await mkdir(join(root, "pools"), { recursive: true });
    const record = emptyPoolRecord(FACETS);
    record.claims.push(claim(1, { id: "valid-pending" }));
    record.parked = [5];
    const malformed = {
      ...record,
      claims: [...record.claims, { member: 2, path: "/p/checkouts/widget/core-2", claimedAt: new Date(NOW).toISOString(), pendingUntil: new Date(NOW + 60_000).toISOString() }],
    };
    await writeFile(path, `${JSON.stringify(malformed, null, 2)}\n`);
    const before = await readFile(path, "utf8");

    await assert.rejects(loadPoolRecord(KEY), /claims\[1\]\.id/);
    await assert.rejects(releasePoolClaim(KEY, "valid-pending"), /claims\[1\]\.id/);
    assert.equal(await readFile(path, "utf8"), before);
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

const CHILD_FINGERPRINT: ProcessBirthFingerprint = { pgid: 4242, startedAt: "Fri Aug  7 12:00:00 2026" };

function hsrMeta(overrides: Partial<HsrMeta> = {}): HsrMeta {
  return {
    bee: "hsr-child",
    harness: "codex",
    tier: "server",
    hostPid: 3131,
    childPid: 4242,
    childPgid: 4242,
    childFingerprint: CHILD_FINGERPRINT,
    startedAt: new Date(NOW).toISOString(),
    controlSocket: "/tmp/hsr-child.sock",
    status: "running",
    ...overrides,
  };
}

test("liveBeesFromSessions counts every positively live local runtime, including sealed/done display-terminal bees", async () => {
  await withTempStore(async () => {
    const records = [
      session("alive"),
      session("dead-bee"),
      session("sealed-bee", { agentPaneId: "%7" }),
      session("remote-bee", { node: "mini01" }),
      session("hsr-alive", { substrate: "hsr" }),
      session("promoting", { substrate: "hsr" }),
      session("demoting"),
      session("archived-bee", { status: "done" }),
    ];
    const context: StateContext = {
      liveTargets: new Set([liveTargetKey(undefined, "alive"), liveTargetKey(undefined, "archived-bee"), liveTargetKey(undefined, "promoting"), liveTargetKey("mini01", "remote-bee")]),
      livePanes: new Set(["%7"]),
      seals: new Set(["sealed-bee"]),
      hsrLive: new Set(["hsr-alive", "demoting"]),
      now: NOW,
    };
    const bees = liveBeesFromSessions(records, context);
    assert.deepEqual(bees.map((bee) => bee.name).sort(), ["alive", "archived-bee", "demoting", "hsr-alive", "promoting", "sealed-bee"]);
    assert.equal(bees[0]!.cwd, "/p/checkouts/widget/core-1");
  });
});

test("HSR pool occupancy retains host-gone child groups until exact absence is confirmed", async () => {
  const meta = hsrMeta();
  assert.equal(await isHsrPoolMutatorLive(meta, {
    isHostAlive: () => false,
    readProcessIdentity: async () => CHILD_FINGERPRINT,
    readProcessGroupPresence: async () => "present",
  }), true, "birth-matched live child group occupies after host death");

  assert.equal(await isHsrPoolMutatorLive(meta, {
    isHostAlive: () => false,
    readProcessIdentity: async () => {
      throw new Error("ps unavailable");
    },
    readProcessGroupPresence: async () => "unverifiable",
  }), true, "unverifiable child/group identity fails closed as occupied");

  assert.equal(await isHsrPoolMutatorLive(meta, {
    isHostAlive: () => false,
    readProcessIdentity: async () => null,
    readProcessGroupPresence: async () => "absent",
  }), false, "gone leader plus absent exact group releases capacity");

  assert.equal(await isHsrPoolMutatorLive({ ...meta, status: "exited" }, {
    isHostAlive: () => false,
    readProcessIdentity: async () => CHILD_FINGERPRINT,
    readProcessGroupPresence: async () => "present",
  }), true, "an exited status alone cannot release a still-live detached child group");
});

test("poolLiveBees counts local launcher groups independently of absent tmux target/pane", async () => {
  const fingerprint: ProcessBirthFingerprint = { pgid: 5151, startedAt: "Fri Aug  7 12:01:00 2026" };
  const records = [
    session("matching", { agentPaneId: "%51", launcherPgid: 5151, launcherFingerprint: fingerprint }),
    session("uncertain", { agentPaneId: "%52", launcherPgid: 5252 }),
    session("gone", { agentPaneId: "%53", launcherPgid: 5353, launcherFingerprint: { ...fingerprint, pgid: 5353 } }),
    session("replacement", { agentPaneId: "%54", launcherPgid: 5454, launcherFingerprint: { ...fingerprint, pgid: 5454 } }),
  ];
  const verdicts = new Map<string, ProcessIdentityVerdict>([
    ["matching", "match"],
    ["uncertain", "unverifiable"],
    ["gone", "gone"],
    ["replacement", "mismatch"],
  ]);
  const live = await poolLiveBees(records, {
    observeLocal: async () => ({ sessions: new Set(), panes: new Set() }),
    observeHsr: async (names) => new Map([...names].map((name) => [name, false])),
    inspectLauncherGroup: async (record) => verdicts.get(record.name)!,
    realpathCwd: async (cwd) => cwd,
  });
  assert.deepEqual(live.map((entry) => entry.name).sort(), ["matching", "uncertain"]);
});

test("exact process-group observation distinguishes absence/replacement and retains uncertainty", async () => {
  const expected: ProcessBirthFingerprint = { pgid: 6161, startedAt: "Fri Aug  7 12:02:00 2026" };
  assert.equal(await inspectProcessGroupBirth(6161, expected, async () => expected, async () => "present"), "match");
  assert.equal(await inspectProcessGroupBirth(6161, expected, async () => null, async () => "absent"), "gone");
  assert.equal(await inspectProcessGroupBirth(
    6161,
    expected,
    async () => ({ pgid: 6161, startedAt: "replacement birth" }),
    async () => "present",
  ), "mismatch");
  assert.equal(await inspectProcessGroupBirth(6161, undefined, async () => expected, async () => "absent"), "unverifiable");
  assert.equal(await inspectProcessGroupBirth(6161, expected, async () => null, async () => "present"), "unverifiable");
});

test("allocation extends for host-gone live/uncertain HSR children but reuses capacity after confirmed absence", async (t) => {
  for (const scenario of [
    { name: "child-live", identity: CHILD_FINGERPRINT, presence: "present" as const, expectedLive: true },
    { name: "child-uncertain", identity: new Error("identity unavailable"), presence: "unverifiable" as const, expectedLive: true },
    { name: "child-absent", identity: null, presence: "absent" as const, expectedLive: false },
  ]) {
    await t.test(scenario.name, async () => withTempStore(async () => {
      const hsr = session("hsr-child", { substrate: "hsr" });
      const liveBees = await poolLiveBees([hsr], {
        observeLocal: async () => ({ sessions: new Set(), panes: new Set() }),
        observeHsr: async (names) => {
          const live = await isHsrPoolMutatorLive(hsrMeta(), {
            isHostAlive: () => false,
            readProcessIdentity: async () => {
              if (scenario.identity instanceof Error) throw scenario.identity;
              return scenario.identity;
            },
            readProcessGroupPresence: async () => scenario.presence,
          });
          return new Map([...names].map((name) => [name, live]));
        },
        realpathCwd: async (cwd) => cwd,
      });
      assert.equal(liveBees.length > 0, scenario.expectedLive);

      let members = [member(1)];
      const extendCounts: number[] = [];
      const resolved: ResolvedPool = { key: KEY, ...FACETS, repoPath: "/p/repo", config: config(), members };
      const allocations = await allocatePoolMembers(resolved, 1, {
        liveBees,
        listMembers: async () => members,
        realpathPath: async (path) => path,
        extendPool: async (_repoPath, _pool, count) => {
          extendCounts.push(count);
          members = [...members, member(2)];
          return [member(2).path];
        },
      });
      assert.deepEqual(extendCounts, scenario.expectedLive ? [1] : []);
      assert.equal(allocations[0]!.member, scenario.expectedLive ? 2 : 1);
    }));
  }
});

test("poolLiveBees fails closed on local and HSR observation errors", async () => {
  await assert.rejects(
    poolLiveBees([], {
      observeLocal: async () => {
        throw new Error("empty-snapshot tmux observation failed");
      },
    }),
    /empty-snapshot tmux observation failed/,
  );

  await assert.rejects(
    poolLiveBees([session("tmux")], {
      observeLocal: async () => {
        throw new Error("tmux observation failed");
      },
    }),
    /tmux observation failed/,
  );

  await assert.rejects(
    poolLiveBees([session("hsr", { substrate: "hsr" })], {
      observeHsr: async () => {
        throw new Error("HSR observation failed");
      },
    }),
    /HSR observation failed/,
  );

  await assert.rejects(
    poolLiveBees([session("cwd")], {
      observeLocal: async () => ({ sessions: new Set(["cwd"]), panes: new Set<string>() }),
      realpathCwd: async () => {
        throw new Error("cwd realpath failed");
      },
    }),
    /cwd realpath failed/,
  );
});

test("poolLiveBees refuses corrupt HSR runtime metadata instead of observing the runtime as absent", async () => {
  await withTempStore(async (root) => {
    const bee = session("hsr-corrupt", { substrate: "hsr" });
    const runDir = join(root, "hsr", bee.name);
    await assert.rejects(poolLiveBees([bee]), /HSR runtime metadata is missing/);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "meta.json"), "{ bad json");
    await assert.rejects(poolLiveBees([bee]), /Invalid JSON in HSR metadata/);
    await writeFile(join(runDir, "meta.json"), JSON.stringify({
      bee: bee.name,
      hostPid: process.pid,
      status: "running",
      childPid: 4242,
    }));
    await assert.rejects(poolLiveBees([bee]), /childPid and childPgid must be stored together/);
  });
});

test("poolLiveBees completes the strict record scan before starting its runtime observation barrier", async () => {
  let releaseScan!: (records: SessionRecord[]) => void;
  const scan = new Promise<SessionRecord[]>((resolve) => {
    releaseScan = resolve;
  });
  let observed = false;
  const pending = poolLiveBees(undefined, {
    listSessions: () => scan,
    observeLocal: async () => {
      observed = true;
      return { sessions: new Set(["alive"]), panes: new Set<string>() };
    },
    realpathCwd: async (cwd) => cwd,
  });
  await Promise.resolve();
  assert.equal(observed, false, "runtime observation must not race ahead of the durable record snapshot");
  releaseScan([session("alive")]);
  assert.deepEqual(await pending, [{ name: "alive", cwd: "/p/checkouts/widget/core-1" }]);
  assert.equal(observed, true);
});

test("the pool lock is a capacity barrier for concurrent claim decisions", async () => {
  await withTempStore(async () => {
    let announceFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let first = true;
    const reserve = (id: string) => withPoolLock(KEY, async () => {
      const record = (await loadPoolRecord(KEY)) ?? emptyPoolRecord(FACETS);
      const occupancy = deriveMemberOccupancy({ members: [member(1)], config: config(), claims: record.claims, parked: record.parked, liveBees: [], now: NOW });
      if (occupancy[0]!.free < 1) return false;
      if (first) {
        first = false;
        announceFirst();
        await firstGate;
      }
      record.claims.push(claim(1, { id }));
      await savePoolRecord(record);
      return true;
    });

    const a = reserve("concurrent-a");
    await firstEntered;
    const b = reserve("concurrent-b");
    releaseFirst();
    const results = await Promise.all([a, b]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await loadPoolRecord(KEY))!.claims.length, 1, "serialized decisions never exceed maxOccupancy=1");
  });
});

test("concurrent allocators cannot both claim one maxOccupancy=1 member", async () => {
  await withTempStore(async (root) => {
    const memberPath = join(root, "member-1");
    await mkdir(memberPath);
    const onlyMember = member(1, { path: memberPath });
    const resolved: ResolvedPool = {
      key: KEY,
      ...FACETS,
      repoPath: join(root, "repo"),
      config: config({ maxOccupancy: 1 }),
      members: [onlyMember],
    };
    const options = {
      liveBees: [],
      listMembers: async () => [onlyMember],
      extendPool: async () => {
        throw new Error("test capacity exhausted");
      },
    };

    const results = await Promise.allSettled([
      allocatePoolMembers(resolved, 1, options),
      allocatePoolMembers(resolved, 1, options),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.match(String(results.find((result) => result.status === "rejected")?.reason), /test capacity exhausted/);
    assert.equal((await loadPoolRecord(KEY))!.claims.length, 1);
  });
});
