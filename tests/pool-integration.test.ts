// Integration: a REAL throwaway pro project under a tmpdir, driven by the
// pool-enabled `pro` (PATH-prefixed; the globally installed pro predates
// pools). Skips cleanly when the pool-enabled binary is absent so the suite
// stays green on machines without the pro checkout-pools worktree.
// Override the location with HIVE_TEST_PRO_BIN_DIR.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  allocatePoolMembers,
  bindPoolClaim,
  claimSpecificPoolMember,
  loadPoolRecord,
  poolStatus,
  resolvePoolRef,
} from "../src/pool.js";
import { invalidateProPoolCache, invalidateProReposCache, listProPools } from "../src/proProjects.js";

const execFileAsync = promisify(execFile);

const PRO_BIN_DIR = process.env.HIVE_TEST_PRO_BIN_DIR ?? "/Users/trmd/Projects/oss/pro/worktrees/pro/checkout-pools/bin";

function poolEnabledProAvailable(): boolean {
  try {
    accessSync(join(PRO_BIN_DIR, "pro"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

type Fixture = {
  proRoot: string;
  storeRoot: string;
  repoPath: string;
};

async function withPoolFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const proRoot = await mkdtemp(join(tmpdir(), "hive-pool-pro-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "hive-pool-store-"));
  const previous = {
    PATH: process.env.PATH,
    PRO_ROOT: process.env.PRO_ROOT,
    HIVE_STORE_ROOT: process.env.HIVE_STORE_ROOT,
    HIVE_POOL_CLAIM_TTL_MS: process.env.HIVE_POOL_CLAIM_TTL_MS,
  };
  // The pool-enabled pro FIRST on PATH (production shells plain `pro`).
  process.env.PATH = `${PRO_BIN_DIR}:${previous.PATH ?? ""}`;
  process.env.PRO_ROOT = proRoot;
  process.env.HIVE_STORE_ROOT = storeRoot;
  // Module-level 30s caches would leak the previous fixture's repo paths.
  invalidateProReposCache();
  invalidateProPoolCache();
  try {
    const pro = (args: string[], cwd: string) => execFileAsync("pro", args, { cwd, timeout: 60_000 });
    const git = (args: string[], cwd: string) => execFileAsync("git", args, { cwd, timeout: 60_000 });
    await pro(["mk", "area", "lab"], proRoot);
    await pro(["mk", "project", "demo"], join(proRoot, "lab"));
    await pro(["mk", "repo", "widget"], join(proRoot, "lab", "demo"));
    const repoPath = join(proRoot, "lab", "demo", "repos", "widget");
    await git(["-c", "user.email=t@e", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], repoPath);
    await pro(["pool", "create", "core", "--occupancy", "1", "--max-size", "2"], repoPath);
    await pro(["pool", "extend", "core", "1"], repoPath);
    await fn({ proRoot, storeRoot, repoPath });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(proRoot, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  }
}

test("pool allocation against a real pro project: claim, rr cursor, auto-extend, soft maxSize", { skip: !poolEnabledProAvailable() && `pool-enabled pro not found at ${PRO_BIN_DIR}` }, async () => {
  await withPoolFixture(async ({ repoPath, proRoot }) => {
    const listing = await listProPools(repoPath);
    assert.equal(listing.pools.length, 1);
    assert.equal(listing.members.length, 1);

    // Name resolution from inside the repo cwd; exact key resolves too.
    const pool = await resolvePoolRef("core", repoPath);
    assert.equal(pool.key, "lab-demo-widget-core");
    const byKey = await resolvePoolRef("lab-demo-widget-core", tmpdir());
    assert.equal(byKey.key, pool.key);

    // First allocation takes the existing member 1 (no clone).
    const warnings: string[] = [];
    const onWarn = (message: string) => warnings.push(message);
    const [first] = await allocatePoolMembers(pool, 1, { liveBees: [], onWarn });
    assert.equal(first!.member, 1);
    assert.equal(first!.created, false);
    let record = await loadPoolRecord(pool.key);
    assert.equal(record!.rrCursor, 1);
    assert.equal(record!.claims.length, 1);
    assert.equal(warnings.length, 0);

    // Member 1 is claimed (unconsumed) → the next allocation AUTO-EXTENDS.
    const freshPool = await resolvePoolRef("core", repoPath);
    const [second] = await allocatePoolMembers(freshPool, 1, { liveBees: [], onWarn });
    assert.equal(second!.member, 2);
    assert.equal(second!.created, true);
    const memberDir = join(proRoot, "lab", "demo", "checkouts", "widget", "core-2");
    assert.ok((await stat(memberDir)).isDirectory(), "auto-extend cloned core-2 on disk");
    assert.equal(warnings.length, 0, "size 2 is within maxSize 2 — no warning yet");

    // Bind the second claim to a live bee: its member stays busy, so the next
    // allocation extends PAST maxSize 2 with the loud (soft-limit) warning.
    await bindPoolClaim(freshPool.key, second!.claim.id, "bee-2");
    const pool3 = await resolvePoolRef("core", repoPath);
    const [third] = await allocatePoolMembers(pool3, 1, {
      liveBees: [{ name: "bee-2", cwd: second!.path }],
      onWarn,
    });
    assert.equal(third!.member, 3);
    assert.equal(third!.created, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /exceeds maxSize: 3\/2/);

    record = await loadPoolRecord(pool.key);
    assert.equal(record!.rrCursor, 3);
    assert.equal(record!.claims.length, 3);
    assert.deepEqual(record!.claims.map((c) => c.beeName), [undefined, "bee-2", undefined]);
  });
});

test("expired claims free their member; --count fan-out claims N in one pass", { skip: !poolEnabledProAvailable() && `pool-enabled pro not found at ${PRO_BIN_DIR}` }, async () => {
  await withPoolFixture(async ({ repoPath }) => {
    process.env.HIVE_POOL_CLAIM_TTL_MS = "1";
    const pool = await resolvePoolRef("core", repoPath);
    const [first] = await allocatePoolMembers(pool, 1, { liveBees: [] });
    assert.equal(first!.member, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The 1ms claim has expired → member 1 is free again; no extend happens.
    delete process.env.HIVE_POOL_CLAIM_TTL_MS;
    const again = await resolvePoolRef("core", repoPath);
    const [reused] = await allocatePoolMembers(again, 1, { liveBees: [] });
    assert.equal(reused!.member, 1);
    assert.equal(reused!.created, false);
    let record = await loadPoolRecord(pool.key);
    assert.equal(record!.claims.length, 1, "expired claim was pruned under the lock");

    // Fan-out: 3 slots against 1 member with 1 unconsumed claim → extends by 3.
    const fanout = await resolvePoolRef("core", repoPath);
    const warnings: string[] = [];
    const allocations = await allocatePoolMembers(fanout, 3, { liveBees: [], onWarn: (m) => warnings.push(m) });
    assert.deepEqual(allocations.map((a) => a.member), [2, 3, 4]);
    assert.deepEqual(allocations.map((a) => a.created), [true, true, true]);
    assert.equal(warnings.length, 1, "4/2 breaches the soft cap loudly");
    record = await loadPoolRecord(pool.key);
    assert.equal(record!.claims.length, 4);
    assert.equal(record!.rrCursor, 4);
  });
});

test("claimSpecificPoolMember refuses busy members; poolStatus reflects the derived model", { skip: !poolEnabledProAvailable() && `pool-enabled pro not found at ${PRO_BIN_DIR}` }, async () => {
  await withPoolFixture(async ({ repoPath }) => {
    const pool = await resolvePoolRef("core", repoPath);
    const bee = { name: "resident", cwd: pool.members[0]!.path };
    await assert.rejects(claimSpecificPoolMember(pool, 1, { liveBees: [bee] }), /full/);
    await assert.rejects(claimSpecificPoolMember(pool, 7, { liveBees: [] }), /no member 7/);

    const manual = await claimSpecificPoolMember(pool, 1, { liveBees: [], ttlMs: 60_000 });
    assert.equal(manual.member, 1);
    const record = await loadPoolRecord(pool.key);
    assert.equal(record!.rrCursor, 0, "a hand-picked member is not a rotation step");

    const status = await poolStatus(await resolvePoolRef("core", repoPath), { liveBees: [] });
    assert.equal(status.size, 1);
    assert.equal(status.busy, 1);
    assert.equal(status.free, 0);
    assert.equal(status.members[0]!.pendingClaims.length, 1);
  });
});
