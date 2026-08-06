import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { recordSeal, sealedBeeNames, validateSealArtifact } from "../src/seal.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import { setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function withStoreEnv<T>(store: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
  }
}

async function hive(store: string, socket: string, ...args: string[]): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: store,
      HIVE_TMUX_SOCKET: socket,
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });
}

test("hive send starts a new turn above the previous seal", { skip: !tmuxAvailable(), timeout: 30_000 }, async () => {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-send-tmux-"));
  const store = await mkdtemp(join(tmpdir(), "hive-send-store-"));
  const socket = join(socketDir, "sock");
  const name = "CO.sealed-follow-up";
  const target = "sealed-follow-up";
  setTmuxSocket(socket);
  try {
    await tmux(["new-session", "-d", "-s", target, "sh"]);
    await withStoreEnv(store, async () => {
      const record: SessionRecord = {
        name,
        id: name,
        agent: "codex",
        cwd: store,
        command: "sh",
        tmuxTarget: target,
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:01:00.000Z",
        status: "running",
        runtimeGeneration: 4,
        lastPrompt: "first turn",
        lastPromptAt: "2026-08-04T00:00:30.000Z",
        lastObservedState: "done",
        lastObservedStateAt: "2026-08-04T00:01:00.000Z",
      };
      await saveSession(record);
      await recordSeal(name, validateSealArtifact({ status: "done", summary: "first turn complete" }));
      assert.equal((await sealedBeeNames([record])).has(name), true);
    });

    await hive(store, socket, "send", name, "follow-up turn");

    await withStoreEnv(store, async () => {
      const stored = await loadSession(name);
      assert.ok(stored);
      assert.equal(stored.status, "running");
      assert.equal(stored.lastPrompt, "follow-up turn");
      assert.equal(stored.runtimeGeneration, 4, "the live runtime generation is unchanged");
      assert.equal(stored.lastObservedState, undefined, "the previous turn's done observation is cleared");
      assert.equal(stored.lastObservedStateAt, undefined);
      assert.equal(typeof stored.sealHighWaterFilename, "string");
      assert.equal((await sealedBeeNames([stored])).has(name), false, "the old seal no longer pins state to done");
    });
  } finally {
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});
