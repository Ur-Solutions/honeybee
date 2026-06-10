import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  appendDaemonLog,
  daemonLaunchdErrPath,
  daemonLaunchdOutPath,
  daemonLogPath,
  rotateDaemonLogIfNeeded,
  rotateLaunchdLogsIfNeeded,
} from "../src/daemon/log.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-daemon-log-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("appendDaemonLog writes a single JSONL line per call", async () => {
  await withTempStore(async () => {
    await appendDaemonLog({ level: "info", msg: "hello" });
    await appendDaemonLog({ level: "warn", msg: "world", extra: 7 });
    const raw = await readFile(daemonLogPath(), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as { level: string; msg: string; ts: string };
    assert.equal(first.level, "info");
    assert.equal(first.msg, "hello");
    assert.ok(typeof first.ts === "string");
    const second = JSON.parse(lines[1]!) as { level: string; msg: string; extra: number };
    assert.equal(second.extra, 7);
  });
});

test("rotateDaemonLogIfNeeded does nothing when below threshold", async () => {
  await withTempStore(async () => {
    const prev = process.env.HIVE_DAEMON_LOG_MAX_BYTES;
    process.env.HIVE_DAEMON_LOG_MAX_BYTES = "1024";
    try {
      await appendDaemonLog({ level: "info", msg: "small" });
      const rotated = await rotateDaemonLogIfNeeded();
      assert.equal(rotated, false);
      const exists = await stat(daemonLogPath()).then(() => true).catch(() => false);
      assert.equal(exists, true);
    } finally {
      if (prev === undefined) delete process.env.HIVE_DAEMON_LOG_MAX_BYTES;
      else process.env.HIVE_DAEMON_LOG_MAX_BYTES = prev;
    }
  });
});

test("rotateDaemonLogIfNeeded rotates when size exceeds threshold", async () => {
  await withTempStore(async () => {
    const prev = process.env.HIVE_DAEMON_LOG_MAX_BYTES;
    process.env.HIVE_DAEMON_LOG_MAX_BYTES = "64";
    try {
      const path = daemonLogPath();
      // appendDaemonLog materialises the parent dir for us.
      await appendDaemonLog({ level: "info", msg: "x".repeat(200) });
      const beforeSize = (await stat(path)).size;
      assert.ok(beforeSize >= 64, `expected at least 64 bytes, got ${beforeSize}`);
      const rotated = await rotateDaemonLogIfNeeded();
      assert.equal(rotated, true);
      const stillThere = await stat(path).then(() => true).catch(() => false);
      assert.equal(stillThere, false, "main log should be moved aside");
      const entries = await readdir(dirname(path));
      const rotatedFiles = entries.filter((f) => f.startsWith(`${basename(path)}.`));
      assert.ok(rotatedFiles.length >= 1, "expected at least one rotated file");
    } finally {
      if (prev === undefined) delete process.env.HIVE_DAEMON_LOG_MAX_BYTES;
      else process.env.HIVE_DAEMON_LOG_MAX_BYTES = prev;
    }
  });
});

test("launchd stream paths are distinct from the daemon log path", () => {
  assert.notEqual(daemonLaunchdOutPath(), daemonLogPath());
  assert.notEqual(daemonLaunchdErrPath(), daemonLogPath());
  assert.notEqual(daemonLaunchdOutPath(), daemonLaunchdErrPath());
  assert.ok(daemonLaunchdOutPath().endsWith("launchd.out.txt"));
  assert.ok(daemonLaunchdErrPath().endsWith("launchd.err.txt"));
});

test("rotateLaunchdLogsIfNeeded rotates oversized launchd stream files", async () => {
  await withTempStore(async () => {
    const prev = process.env.HIVE_DAEMON_LOG_MAX_BYTES;
    process.env.HIVE_DAEMON_LOG_MAX_BYTES = "64";
    try {
      const outPath = daemonLaunchdOutPath();
      const errPath = daemonLaunchdErrPath();
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, "o".repeat(200));
      await writeFile(errPath, "e".repeat(200));
      await rotateLaunchdLogsIfNeeded();
      for (const path of [outPath, errPath]) {
        const stillThere = await stat(path).then(() => true).catch(() => false);
        assert.equal(stillThere, false, `${basename(path)} should be moved aside`);
      }
      const entries = await readdir(dirname(outPath));
      assert.ok(entries.some((f) => f.startsWith("launchd.out.txt.")), "expected rotated launchd.out.txt");
      assert.ok(entries.some((f) => f.startsWith("launchd.err.txt.")), "expected rotated launchd.err.txt");
    } finally {
      if (prev === undefined) delete process.env.HIVE_DAEMON_LOG_MAX_BYTES;
      else process.env.HIVE_DAEMON_LOG_MAX_BYTES = prev;
    }
  });
});

test("appendDaemonLog also rotates oversized launchd stream files", async () => {
  await withTempStore(async () => {
    const prev = process.env.HIVE_DAEMON_LOG_MAX_BYTES;
    process.env.HIVE_DAEMON_LOG_MAX_BYTES = "64";
    try {
      const errPath = daemonLaunchdErrPath();
      await mkdir(dirname(errPath), { recursive: true });
      await writeFile(errPath, "e".repeat(200));
      await appendDaemonLog({ level: "info", msg: "tick" });
      const stillThere = await stat(errPath).then(() => true).catch(() => false);
      assert.equal(stillThere, false, "launchd.err.txt should be rotated on append");
    } finally {
      if (prev === undefined) delete process.env.HIVE_DAEMON_LOG_MAX_BYTES;
      else process.env.HIVE_DAEMON_LOG_MAX_BYTES = prev;
    }
  });
});

test("rotation prunes oldest rotated files beyond HIVE_DAEMON_LOG_KEEP", async () => {
  await withTempStore(async () => {
    const prev = process.env.HIVE_DAEMON_LOG_KEEP;
    process.env.HIVE_DAEMON_LOG_KEEP = "2";
    try {
      const path = daemonLogPath();
      const dir = dirname(path);
      const baseName = basename(path);
      await mkdir(dir, { recursive: true });
      // Make a stale main log over the threshold + 4 already-rotated siblings
      // so the prune step trims to 2.
      await writeFile(path, "x".repeat(200));
      // Use lexicographic-sortable suffixes; the prune step keeps the highest-sorted.
      const oldRotated = ["a", "b", "c", "d"].map((s) => `${baseName}.${s}`);
      for (const name of oldRotated) await writeFile(join(dir, name), "old");
      process.env.HIVE_DAEMON_LOG_MAX_BYTES = "64";
      await rotateDaemonLogIfNeeded();
      const after = await readdir(dir);
      const surviving = after.filter((f) => f.startsWith(`${baseName}.`));
      // We had 4 old ones + the newly rotated. Keep=2 means we should now see 2 total.
      assert.equal(surviving.length, 2, `expected 2 rotated files, saw ${surviving.length}: ${surviving.join(",")}`);
    } finally {
      if (prev === undefined) delete process.env.HIVE_DAEMON_LOG_KEEP;
      else process.env.HIVE_DAEMON_LOG_KEEP = prev;
      delete process.env.HIVE_DAEMON_LOG_MAX_BYTES;
    }
  });
});
