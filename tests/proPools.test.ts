import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  extendProPool,
  invalidateProPoolCache,
  listProPools,
  parseProCheckoutSync,
  parseProPoolPorcelain,
  ProPoolsUnavailableError,
} from "../src/proProjects.js";

test("parseProPoolPorcelain parses pool and member records", () => {
  const out = [
    "pool\twidget\tcore\tmain\t2\t4",
    "member\twidget\tcore\t1\t/p/checkouts/widget/core-1\tmain\t0\t0\t0",
    "member\twidget\tcore\t2\t/p/checkouts/widget/core-2\tfeature-x\t1\t3\t1",
  ].join("\n");
  assert.deepEqual(parseProPoolPorcelain(out), {
    pools: [{ repo: "widget", name: "core", branch: "main", maxOccupancy: 2, maxSize: 4 }],
    members: [
      { repo: "widget", pool: "core", n: 1, path: "/p/checkouts/widget/core-1", branch: "main", dirty: false, ahead: 0, behind: 0 },
      { repo: "widget", pool: "core", n: 2, path: "/p/checkouts/widget/core-2", branch: "feature-x", dirty: true, ahead: 3, behind: 1 },
    ],
  });
});

test('parseProPoolPorcelain maps "-" ahead/behind (missing origin ref) to undefined', () => {
  const out = "member\twidget\tcore\t3\t/p/checkouts/widget/core-3\tmain\t0\t-\t-";
  const { members } = parseProPoolPorcelain(out);
  assert.equal(members.length, 1);
  assert.equal(members[0]!.ahead, undefined);
  assert.equal(members[0]!.behind, undefined);
});

test("parseProPoolPorcelain skips malformed lines and defaults broken config numbers", () => {
  const out = [
    "",
    "garbage line",
    "member\twidget\tcore\tNaN\t/p/x\tmain\t0\t0\t0", // non-integer n
    "member\twidget\tcore\t1\trelative/path\tmain\t0\t0\t0", // non-absolute path
    "pool\twidget\tcore\tmain\tbogus\tbogus", // broken numbers → defaults
  ].join("\n");
  const listing = parseProPoolPorcelain(out);
  assert.equal(listing.members.length, 0);
  assert.deepEqual(listing.pools, [{ repo: "widget", name: "core", branch: "main", maxOccupancy: 1, maxSize: 32 }]);
});

test("parseProCheckoutSync handles multi-target TSV rows and the single-target space form", () => {
  const out = [
    "skipped-dirty\t/p/checkouts/widget/core-1",
    "synced-rebase\t/p/checkouts/widget/core-2\tmain (a1b2..c3d4, 2 commits replayed)",
    "unchanged /p/checkouts/widget/core-3\tmain",
    "Already up to date.", // git chatter → skipped
  ].join("\n");
  assert.deepEqual(parseProCheckoutSync(out), [
    { status: "skipped-dirty", path: "/p/checkouts/widget/core-1" },
    { status: "synced-rebase", path: "/p/checkouts/widget/core-2", detail: "main (a1b2..c3d4, 2 commits replayed)" },
    { status: "unchanged", path: "/p/checkouts/widget/core-3", detail: "main" },
  ]);
});

// ── stubbed `pro` shell-outs ──────────────────────────────────────────────────

async function withStubPro(
  script: string,
  fn: (ctx: { root: string; repo: string; log: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-pro-pool-stub-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const log = join(root, "pro.log");
  await mkdir(bin, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(log, "");
  await writeFile(join(bin, "pro"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$PRO_STUB_LOG"
${script}
`, { mode: 0o755 });

  const old = { PATH: process.env.PATH, PRO_STUB_LOG: process.env.PRO_STUB_LOG };
  process.env.PATH = `${bin}:${old.PATH ?? ""}`;
  process.env.PRO_STUB_LOG = log;
  try {
    await fn({ root, repo, log });
  } finally {
    if (old.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = old.PATH;
    if (old.PRO_STUB_LOG === undefined) delete process.env.PRO_STUB_LOG;
    else process.env.PRO_STUB_LOG = old.PRO_STUB_LOG;
    invalidateProPoolCache();
    await rm(root, { recursive: true, force: true });
  }
}

test("listProPools parses the porcelain and caches per repoPath until invalidated", async () => {
  await withStubPro(
    `printf 'pool\\twidget\\tcore\\tmain\\t1\\t32\\nmember\\twidget\\tcore\\t1\\t/p/core-1\\tmain\\t0\\t-\\t-\\n'`,
    async ({ repo, log }) => {
      const first = await listProPools(repo);
      assert.equal(first.pools[0]?.name, "core");
      assert.equal(first.members[0]?.ahead, undefined);
      await listProPools(repo); // served from cache — no second shell-out
      const { readFile } = await import("node:fs/promises");
      assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
      invalidateProPoolCache(repo);
      await listProPools(repo);
      assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
    },
  );
});

test("listProPools surfaces a pool-less pro as ProPoolsUnavailableError (actionable, typed)", async () => {
  await withStubPro(`printf 'pro: unknown command: pool\\n' >&2; exit 1`, async ({ repo }) => {
    await assert.rejects(listProPools(repo), (error: unknown) => {
      assert.ok(error instanceof ProPoolsUnavailableError);
      assert.match((error as Error).message, /unknown command: pool/);
      assert.match((error as Error).message, /pool-enabled pro/);
      return true;
    });
  });
});

test("extendProPool returns created paths from stdout and busts the porcelain cache", async () => {
  await withStubPro(
    `case "$1:$2" in
  pool:ls) printf 'pool\\twidget\\tcore\\tmain\\t1\\t32\\n' ;;
  pool:extend) printf 'Cloning...\\n' >&2; printf '/p/checkouts/widget/core-4\\n/p/checkouts/widget/core-5\\n' ;;
esac`,
    async ({ repo, log }) => {
      await listProPools(repo); // prime the cache
      const created = await extendProPool(repo, "core", 2);
      assert.deepEqual(created, ["/p/checkouts/widget/core-4", "/p/checkouts/widget/core-5"]);
      await listProPools(repo); // must re-shell after the extend invalidation
      const { readFile } = await import("node:fs/promises");
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      assert.deepEqual(lines, ["pool ls --porcelain", "pool extend core 2", "pool ls --porcelain"]);
    },
  );
});

test("extendProPool rejects a non-positive count without shelling out", async () => {
  await assert.rejects(extendProPool("/nowhere", "core", 0), /positive integer/);
});
