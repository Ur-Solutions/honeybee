import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileLockMutationGuardPath, readFileLockIdentity, removeFileLockIfOwner, withFileLock, withGuardedFileLockOwner } from "../src/lock.js";

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

test("heartbeat refresh and stale removal serialize under exact-generation revalidation", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "heartbeat-stale-barrier.lock");
    let holderEntered!: () => void;
    const holderWasEntered = new Promise<void>((resolve) => { holderEntered = resolve; });
    let releaseHolder!: () => void;
    const holderMayRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withFileLock(path, async () => {
      holderEntered();
      await holderMayRelease;
    }, { staleMs: 60_000 });
    await holderWasEntered;

    const staleAt = new Date(Date.now() - 10_000);
    await utimes(path, staleAt, staleAt);
    const observed = await readFileLockIdentity(path);
    assert.ok(observed);

    // Hold the shared generation guard at the exact point a heartbeat owns it,
    // then queue a remover that already observed the stale mtime. Once the
    // heartbeat refreshes and releases, the remover must re-read fresh state
    // and abort instead of renaming the live holder.
    let heartbeatGuarded!: () => void;
    const heartbeatHasGuard = new Promise<void>((resolve) => { heartbeatGuarded = resolve; });
    let refreshNow!: () => void;
    const heartbeatMayRefresh = new Promise<void>((resolve) => { refreshNow = resolve; });
    const heartbeat = withGuardedFileLockOwner(path, observed!, async () => {
      heartbeatGuarded();
      await heartbeatMayRefresh;
      const now = new Date();
      await utimes(path, now, now);
    });
    await heartbeatHasGuard;
    const staleRemoval = removeFileLockIfOwner(path, observed!, {
      suffix: "stale-race",
      guardTimeoutMs: 2_000,
      validate: (current) => Date.now() - current.mtimeMs > 1_000,
    });

    refreshNow();
    assert.deepEqual(await heartbeat, { matched: true, value: undefined });
    assert.equal(await staleRemoval, false);
    const stillOwned = await readFileLockIdentity(path);
    assert.equal(stillOwned?.fingerprint, observed?.fingerprint);

    releaseHolder();
    await holder;
  });
});

test("heartbeat recovers a generation guard abandoned by a dead stale stealer", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "heartbeat-dead-mutator.lock");
    let holderEntered!: () => void;
    const holderWasEntered = new Promise<void>((resolve) => { holderEntered = resolve; });
    let releaseHolder!: () => void;
    const holderMayRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withFileLock(path, async () => {
      holderEntered();
      await holderMayRelease;
    }, { staleMs: 150 });
    await holderWasEntered;

    const identity = await readFileLockIdentity(path);
    assert.ok(identity);
    const guardPath = fileLockMutationGuardPath(path, identity!);
    await writeFile(guardPath, JSON.stringify({
      pid: 818_181,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "dead-stealer",
      lockFingerprint: identity!.fingerprint,
    }));
    const staleAt = new Date(Date.now() - 10_000);
    await utimes(path, staleAt, staleAt);

    await sleep(120);
    const refreshed = await stat(path);
    assert.ok(Date.now() - refreshed.mtimeMs < 500, "the live holder's heartbeat resumed after dead-guard recovery");
    await assert.rejects(readFile(guardPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    releaseHolder();
    await holder;
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

test("dead local owner is reclaimed immediately and callbacks expose only sanitized prior-owner metadata", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "dead-owner.lock");
    await writeFile(path, JSON.stringify({
      pid: 999_999,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "must-not-leak",
      secret: "also-must-not-leak",
    }));
    let waited: unknown;
    let acquired: unknown;
    await withFileLock(path, async () => undefined, {
      timeoutMs: 1_000,
      pollMs: 5,
      onWait: (info) => { waited = info; },
      onAcquired: (info) => { acquired = info; },
    });
    assert.deepEqual((waited as { owner: unknown }).owner, {
      pid: 999_999,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
    });
    assert.equal((acquired as { waited: boolean }).waited, true);
    assert.ok((acquired as { waitMs: number }).waitMs >= 0);
    assert.doesNotMatch(JSON.stringify(acquired), /must-not-leak|also-must-not-leak/);
  });
});

test("ordinary dead owner is reclaimed even when it died while holding its generation guard", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "dead-owner-guarded.lock");
    const deadPid = 717_171;
    await writeFile(path, JSON.stringify({
      pid: deadPid,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "dead-lock-token",
    }));
    const identity = await readFileLockIdentity(path);
    assert.ok(identity);
    const guardPath = fileLockMutationGuardPath(path, identity!);
    await writeFile(guardPath, JSON.stringify({
      pid: deadPid,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:01.000Z",
      token: "dead-guard-token",
      lockFingerprint: identity!.fingerprint,
    }));

    let acquired = false;
    await withFileLock(path, async () => { acquired = true; }, { timeoutMs: 1_000, pollMs: 5 });
    assert.equal(acquired, true);
    await assert.rejects(readFile(guardPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
});
