import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("readLockMeta returns null for missing or malformed files", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readLockMeta(join(dir, "missing.lock")), null);
    await writeFile(join(dir, "bad.lock"), "not json");
    assert.equal(await readLockMeta(join(dir, "bad.lock")), null);
    await writeFile(join(dir, "shape.lock"), '{"foo":"bar"}');
    assert.equal(await readLockMeta(join(dir, "shape.lock")), null);
  });
});
