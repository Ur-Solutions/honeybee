import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionRecord } from "../src/store.js";
import { waitForIdle } from "../src/wait.js";

function record(dir: string): SessionRecord {
  return {
    name: "test-bee",
    agent: "claude",
    cwd: join(dir, "workspace"),
    command: "claude",
    tmuxTarget: "test-bee-target",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    status: "running",
    homePath: join(dir, "claude-home"),
  };
}

async function withStoreRoot<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = join(dir, "store");
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
  }
}

test("waitForIdle throws when the session dies mid-wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-dead-"));
  try {
    await withStoreRoot(dir, async () => {
      const substrate = {
        capture: async () => {
          throw new Error("can't find pane");
        },
        hasSession: async () => false,
      };

      await assert.rejects(
        waitForIdle({ record: record(dir), idleMs: 100, timeoutMs: 5_000, pollMs: 50, output: "pane", rows: 0, json: false, substrate }),
        /Session died while waiting for idle: test-bee/,
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle reports a stable permission prompt as blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-blocked-"));
  try {
    await withStoreRoot(dir, async () => {
      const pane = "Bash(rm -rf build)\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)";
      const substrate = {
        capture: async () => pane,
        hasSession: async () => true,
      };

      const outcome = await waitForIdle({ record: record(dir), idleMs: 150, timeoutMs: 5_000, pollMs: 50, output: "pane", rows: 0, json: false, substrate });
      assert.deepEqual(outcome, { state: "blocked" });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle reports a settled pane as idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-idle-"));
  try {
    await withStoreRoot(dir, async () => {
      const substrate = {
        capture: async () => "All done.\n❯ ",
        hasSession: async () => true,
      };

      const outcome = await waitForIdle({ record: record(dir), idleMs: 150, timeoutMs: 5_000, pollMs: 50, output: "pane", rows: 0, json: false, substrate });
      assert.deepEqual(outcome, { state: "idle" });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForIdle does not report --last success before a prompted transcript appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-wait-last-no-tx-"));
  try {
    await withStoreRoot(dir, async () => {
      const prompted = {
        ...record(dir),
        lastPrompt: "Reply OK only.",
        lastPromptAt: "2026-06-10T00:00:01.000Z",
      };
      const substrate = {
        capture: async () => "Grok Build\n❯ ",
        hasSession: async () => true,
      };

      await assert.rejects(
        waitForIdle({ record: prompted, idleMs: 50, timeoutMs: 220, pollMs: 50, output: "last", rows: 0, json: false, substrate }),
        /Timed out waiting for idle session/,
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
