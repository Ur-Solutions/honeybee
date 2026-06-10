import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireLongLivedLock,
  atomicWriteFile,
  LockBusyError,
  readLockMeta,
  storeRoot,
} from "../src/fsx.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-fsx-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("storeRoot honors HIVE_STORE_ROOT and falls back to ~/.hive", () => {
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = "/tmp/honeybee-test";
  try {
    assert.equal(storeRoot(), "/tmp/honeybee-test");
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
  }
});

test("atomicWriteFile writes and creates parent dirs", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "nested/deeper/file.json");
    await atomicWriteFile(target, '{"hello":"world"}\n');
    const raw = await readFile(target, "utf8");
    assert.equal(raw, '{"hello":"world"}\n');
  });
});

test("atomicWriteFile honors mode option", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "secret.json");
    await atomicWriteFile(target, "{}", { mode: 0o600 });
    const { stat } = await import("node:fs/promises");
    const info = await stat(target);
    assert.equal(info.mode & 0o777, 0o600);
  });
});

test("atomicWriteFile tolerates concurrent same-destination writes without temp collisions", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "contended.json");
    const payloads = Array.from({ length: 20 }, (_, i) => `{"write":${i}}`);
    await Promise.all(payloads.map((data) => atomicWriteFile(target, data)));

    const final = await readFile(target, "utf8");
    assert.ok(payloads.includes(final), `unexpected final content: ${final}`);
    const leftovers = (await readdir(dir)).filter((entry) => entry.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

test("acquireLongLivedLock acquires and releases", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    const lock = await acquireLongLivedLock(lockPath, { label: "daemon" });
    assert.equal(lock.meta.pid, process.pid);
    assert.equal(lock.meta.label, "daemon");
    assert.ok(lock.meta.startedAt);
    assert.ok(lock.meta.hostname.length > 0);
    await lock.release();

    const meta = await readLockMeta(lockPath);
    assert.equal(meta, null);
  });
});

test("acquireLongLivedLock refuses when same-host PID is alive", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    const first = await acquireLongLivedLock(lockPath, { label: "first" });
    try {
      await assert.rejects(
        () => acquireLongLivedLock(lockPath, { label: "second" }),
        (error) => error instanceof LockBusyError && error.existing?.pid === process.pid,
      );
    } finally {
      await first.release();
    }
  });
});

test("acquireLongLivedLock steals a lock whose PID is dead", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    const { hostname } = await import("node:os");
    const stale = {
      pid: 999999,
      hostname: hostname(),
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(lockPath, JSON.stringify(stale));

    const lock = await acquireLongLivedLock(lockPath, {
      isPidAlive: () => false,
    });
    try {
      assert.equal(lock.meta.pid, process.pid);
    } finally {
      await lock.release();
    }
  });
});

test("acquireLongLivedLock refuses to steal a lock from a different host", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    const otherHost = {
      pid: 4242,
      hostname: "some-other-machine",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(lockPath, JSON.stringify(otherHost));

    await assert.rejects(
      () => acquireLongLivedLock(lockPath, { isPidAlive: () => false }),
      (error) => error instanceof LockBusyError && /some-other-machine/.test(error.message),
    );
  });
});

test("acquireLongLivedLock with force overrides existing lock", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    const first = await acquireLongLivedLock(lockPath);
    const firstToken = first.token;
    const second = await acquireLongLivedLock(lockPath, { force: true });
    try {
      assert.equal(second.meta.pid, process.pid);
      assert.notEqual(second.token, firstToken);
    } finally {
      await second.release();
    }
    // first.release should not throw even though its file is gone
    await first.release();
  });
});

test("release() does not delete a lock owned by another token", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    const first = await acquireLongLivedLock(lockPath);
    const second = await acquireLongLivedLock(lockPath, { force: true });
    // First's view of the lockfile is stale after force-steal.
    // Calling first.release() must NOT remove second's lock.
    await first.release();
    const meta = await readLockMeta(lockPath);
    assert.ok(meta !== null);
    assert.equal(meta!.token, second.token);
    await second.release();
  });
});

test("acquireLongLivedLock refuses to steal a lock with empty hostname", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 4242, hostname: "", startedAt: "2026-01-01T00:00:00.000Z" }));
    await assert.rejects(
      () => acquireLongLivedLock(lockPath, { isPidAlive: () => false }),
      (error) => error instanceof LockBusyError && /<unknown>/.test(error.message),
    );
  });
});

test("acquireLongLivedLock steals an old empty lock file left by a crashed writer", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    await writeFile(lockPath, "");
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    const lock = await acquireLongLivedLock(lockPath, { label: "recovered" });
    try {
      assert.equal(lock.meta.pid, process.pid);
      const meta = await readLockMeta(lockPath);
      assert.equal(meta?.token, lock.token);
    } finally {
      await lock.release();
    }
  });
});

test("acquireLongLivedLock refuses a fresh unreadable lock file", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    await writeFile(lockPath, "");
    await assert.rejects(
      () => acquireLongLivedLock(lockPath),
      (error) => error instanceof LockBusyError && error.existing === null,
    );
  });
});

test("acquireLongLivedLock sweeps orphaned staged files from older versions", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    const orphan = join(dir, ".daemon.lock.12345.1700000000000.staged");
    await writeFile(orphan, "{}");
    const past = new Date(Date.now() - 60_000);
    await utimes(orphan, past, past);
    const fresh = join(dir, ".daemon.lock.12346.1700000000001.staged");
    await writeFile(fresh, "{}");

    const lock = await acquireLongLivedLock(lockPath);
    try {
      const entries = await readdir(dir);
      assert.ok(!entries.includes(".daemon.lock.12345.1700000000000.staged"), "old orphaned staged file should be removed");
      assert.ok(entries.includes(".daemon.lock.12346.1700000000001.staged"), "recent staged file should be left alone");
    } finally {
      await lock.release();
    }
  });
});

test("lock meta is readable immediately after acquisition", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, "daemon.lock");
    const lock = await acquireLongLivedLock(lockPath, { label: "direct-write" });
    try {
      const meta = await readLockMeta(lockPath);
      assert.equal(meta?.pid, process.pid);
      assert.equal(meta?.token, lock.token);
      assert.equal(meta?.label, "direct-write");
    } finally {
      await lock.release();
    }
  });
});

test("readLockMeta returns null for missing or malformed files", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readLockMeta(join(dir, "missing.lock")), null);
    await writeFile(join(dir, "bad.lock"), "not json");
    assert.equal(await readLockMeta(join(dir, "bad.lock")), null);
    await writeFile(join(dir, "shape.lock"), '{"foo":"bar"}');
    assert.equal(await readLockMeta(join(dir, "shape.lock")), null);
  });
});
