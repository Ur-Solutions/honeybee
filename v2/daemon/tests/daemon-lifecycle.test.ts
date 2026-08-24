import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTickDelayMs } from "../src/daemon.ts";
import type { SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("tick scheduling always leaves a completion-relative poll window", () => {
  assert.equal(nextTickDelayMs(200), 200);
  assert.equal(nextTickDelayMs(20), 20);
  assert.equal(nextTickDelayMs(0), 1);
});

test("test daemon graceful shutdown reaps its detached runner-host group", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "owned", agent: "stub", cwd: "/tmp" });
    const hostPid = await waitFor(async () => {
      const view = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return view.runtime?.pid && view.view.runtimeState === "idle" ? view.runtime.pid : null;
    }, "stub runner idle");
    assert.equal(pidAlive(hostPid), true);
    client.close();

    await daemon.stop();
    daemon = null;
    assert.equal(pidAlive(hostPid), false, "test-owned host and agent must be gone");
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
