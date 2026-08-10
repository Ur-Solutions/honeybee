// Deploy settling (scripts/deploy-settle.mjs): the daemon must never restart
// over a half-copied or mid-rebuild global module tree. The settle barrier
// proves content equality between the local build and the installed tree —
// stamp AND re-hash — with bounded retries.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUILD_STAMP_FILENAME,
  hashDirectoryTree,
  readBuildStamp,
  waitForSettledInstall,
  writeBuildStamp,
} from "../src/deploySettle.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hive-deploy-settle-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedTree(dir: string): Promise<void> {
  await mkdir(join(dir, "hsr"), { recursive: true });
  await writeFile(join(dir, "cli.js"), "console.log('hive')\n");
  await writeFile(join(dir, "hsr", "host.js"), "export const host = 1\n");
}

test("hashDirectoryTree digests path + content and ignores the stamp file", async () => {
  await withTempDir(async (root) => {
    const left = join(root, "left");
    const right = join(root, "right");
    await seedTree(left);
    await seedTree(right);
    await writeFile(join(right, BUILD_STAMP_FILENAME), '{"hash":"decoy"}\n');
    assert.equal(await hashDirectoryTree(left), await hashDirectoryTree(right), "the stamp never feeds its own digest");

    await writeFile(join(right, "hsr", "host.js"), "export const host = 2\n");
    assert.notEqual(await hashDirectoryTree(left), await hashDirectoryTree(right), "content changes the digest");

    await writeFile(join(right, "hsr", "host.js"), "export const host = 1\n");
    await writeFile(join(right, "straggler.js"), "");
    assert.notEqual(await hashDirectoryTree(left), await hashDirectoryTree(right), "an extra file changes the digest");
  });
});

test("writeBuildStamp records the tree digest and readBuildStamp tolerates garbage", async () => {
  await withTempDir(async (root) => {
    const dist = join(root, "dist");
    await seedTree(dist);
    const stamp = await writeBuildStamp(dist);
    assert.equal(stamp.hash, await hashDirectoryTree(dist), "stamping does not perturb the digest it records");
    assert.deepEqual(await readBuildStamp(dist), stamp);

    await writeFile(join(dist, BUILD_STAMP_FILENAME), '{"hash":');
    assert.equal(await readBuildStamp(dist), null, "a torn stamp reads as absent, not as an error");
    assert.equal(await readBuildStamp(join(root, "missing")), null);
  });
});

test("a settled install (stamp and tree both matching the local build) resolves first probe", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local-dist");
    await seedTree(local);
    const stamp = await writeBuildStamp(local);
    const installed = join(root, "installed-dist");
    await cp(local, installed, { recursive: true });

    const settled = await waitForSettledInstall(local, installed, { timeoutMs: 1_000, pollIntervalMs: 1 });
    assert.equal(settled.hash, stamp.hash);
    assert.equal(settled.attempts, 1);
  });
});

test("a mid-copy install settles only once the tree catches up to its stamp", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local-dist");
    await seedTree(local);
    await writeBuildStamp(local);
    // The stamp arrived but hsr/host.js has not: the exact stale-mix window
    // that false-reaped 8 live runners must NOT settle.
    const installed = join(root, "installed-dist");
    await cp(local, installed, { recursive: true });
    await rm(join(installed, "hsr", "host.js"));

    let probes = 0;
    const settled = await waitForSettledInstall(local, installed, {
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      sleep: async () => {
        probes += 1;
        // The copy completes while the settle loop is waiting.
        if (probes === 2) await cp(join(local, "hsr", "host.js"), join(installed, "hsr", "host.js"));
      },
    });
    assert.ok(settled.attempts > 1, "the incomplete tree was observed and retried");
    assert.equal(settled.hash, (await readBuildStamp(local))!.hash);
  });
});

test("an install that never settles throws after the timeout with the disagreement", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local-dist");
    await seedTree(local);
    await writeBuildStamp(local);
    // A stale worktree: complete, self-consistent, but NOT the local build.
    const installed = join(root, "installed-dist");
    await seedTree(installed);
    await writeFile(join(installed, "cli.js"), "console.log('stale hive')\n");
    await writeBuildStamp(installed);

    let clock = 0;
    await assert.rejects(
      waitForSettledInstall(local, installed, {
        timeoutMs: 50,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
      }),
      /did not settle within 50ms.*!=/s,
    );
  });
});

test("settling without a local stamp is a caller error, not a wait", async () => {
  await withTempDir(async (root) => {
    const local = join(root, "local-dist");
    await seedTree(local);
    await assert.rejects(
      waitForSettledInstall(local, join(root, "installed"), { timeoutMs: 10 }),
      /no build stamp/,
    );
  });
});
