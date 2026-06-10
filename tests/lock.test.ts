import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileLock } from "../src/lock.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-lock-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("withFileLock serializes critical sections", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "test.lock");
    let inside = 0;
    let maxInside = 0;
    const worker = () =>
      withFileLock(path, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(20);
        inside -= 1;
      });
    await Promise.all([worker(), worker(), worker(), worker()]);
    assert.equal(maxInside, 1);
  });
});

test("stale-lock steal admits exactly one waiter at a time", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "stale.lock");
    // Plant a lock whose mtime is far in the past so every waiter sees it stale.
    await writeFile(path, JSON.stringify({ pid: 999999, createdAt: "2026-01-01T00:00:00.000Z", token: "dead" }));
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(path, past, past);

    let inside = 0;
    let maxInside = 0;
    const worker = () =>
      withFileLock(
        path,
        async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(15);
          inside -= 1;
        },
        { staleMs: 1_000, pollMs: 5 },
      );
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    assert.equal(maxInside, 1, "two waiters stole the same stale lock and overlapped");
  });
});

test("release leaves a lock owned by a different token in place", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "owned.lock");
    const foreign = JSON.stringify({ pid: 4242, createdAt: new Date().toISOString(), token: "someone-else" });
    await withFileLock(path, async () => {
      // Simulate a steal mid-critical-section: another process now owns the path.
      await writeFile(path, foreign);
    });
    // Our release must not have deleted the new holder's lock file.
    const raw = await readFile(path, "utf8");
    assert.equal(raw, foreign);
  });
});

test("heartbeat keeps a long critical section from being declared stale", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "heartbeat.lock");
    const events: string[] = [];

    const holder = withFileLock(
      path,
      async () => {
        events.push("holder-start");
        // Hold well past staleMs; the mtime heartbeat must keep waiters out.
        await sleep(700);
        events.push("holder-end");
      },
      { staleMs: 200, pollMs: 10 },
    );
    await sleep(50); // let the holder acquire first
    const waiter = withFileLock(
      path,
      async () => {
        events.push("waiter-start");
      },
      { staleMs: 200, pollMs: 10, timeoutMs: 5_000 },
    );

    await Promise.all([holder, waiter]);
    assert.deepEqual(events, ["holder-start", "holder-end", "waiter-start"]);
  });
});

test("heartbeat stops refreshing after release", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "released.lock");
    await withFileLock(path, async () => undefined, { staleMs: 90 });
    await sleep(150); // longer than the heartbeat interval (staleMs / 3)
    await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
});
