import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSessions, loadSession, saveSession, type SessionRecord } from "../src/store.js";

test("store root is read at call time and session files are private", async () => {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-store-"));
  process.env.HIVE_STORE_ROOT = dir;

  try {
    const record: SessionRecord = {
      name: "CO.abc",
      agent: "codex",
      cwd: dir,
      command: "codex",
      tmuxTarget: "CO-abc",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
      status: "running",
    };

    await saveSession(record);
    assert.deepEqual(await loadSession(record.name), record);
    assert.equal((await stat(join(dir, "sessions", "CO.abc.json"))).mode & 0o777, 0o600);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("listSessions skips malformed session files", async () => {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-store-"));
  process.env.HIVE_STORE_ROOT = dir;

  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", "bad.json"), "{not json");
    assert.deepEqual(await listSessions(), []);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
});
