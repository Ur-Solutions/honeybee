import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { withCodexHomeBootLock } from "../src/codexBoot.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("codex boot lock serializes one home and reports the waiter", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-codex-boot-"));
  const home = join(root, "same-home");
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let secondEntered = false;
  let secondWaited = false;

  try {
    const first = withCodexHomeBootLock(home, async ({ waited }) => {
      assert.equal(waited, false);
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = withCodexHomeBootLock(home, async ({ waited }) => {
      secondEntered = true;
      secondWaited = waited;
    });

    await sleep(75);
    assert.equal(secondEntered, false, "second fake boot entered the same home concurrently");
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.equal(secondWaited, true);
  } finally {
    releaseFirst.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("codex boot locks for different homes do not serialize", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-codex-boot-"));
  const bothEntered = deferred();
  const releaseBoth = deferred();
  let entered = 0;

  const boot = (home: string) => withCodexHomeBootLock(home, async ({ waited }) => {
    assert.equal(waited, false);
    entered += 1;
    if (entered === 2) bothEntered.resolve();
    await releaseBoth.promise;
  });

  try {
    const boots = [boot(join(root, "home-a")), boot(join(root, "home-b"))];
    await Promise.race([
      bothEntered.promise,
      sleep(1_000).then(() => assert.fail("different homes did not boot concurrently")),
    ]);
    releaseBoth.resolve();
    await Promise.all(boots);
  } finally {
    releaseBoth.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("codex boot lock reclaims a hard-crashed holder before the wait timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeybee-codex-boot-"));
  const home = join(root, "crashed-home");
  try {
    await mkdir(home, { recursive: true });
    const lockPath = join(home, ".hive-app-server-boot.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, token: "dead" }));
    const stale = new Date(Date.now() - 3 * 60_000);
    await utimes(lockPath, stale, stale);

    let waited = false;
    await withCodexHomeBootLock(home, async (state) => {
      waited = state.waited;
    });
    assert.equal(waited, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
