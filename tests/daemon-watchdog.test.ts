import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDaemonState } from "../src/daemon/index.js";
import { runDaemon, type TickResult } from "../src/daemon/run.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-daemon-watchdog-"));
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

function emptyTickResult(): TickResult {
  return {
    transitions: [],
    observed: new Map(),
    unreachableNodes: new Set(),
    errors: [],
    buzDrains: [],
    needsInput: [],
    usage: [],
    autoswaps: [],
    autoTitles: [],
    durationMs: 0,
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

test("runDaemon: a tick exceeding tickBudgetMs is abandoned, recorded, and the loop keeps ticking", async () => {
  await withTempStore(async () => {
    let calls = 0;
    const tickImpl = () => {
      calls += 1;
      // First tick wedges forever (the production failure shape); the rest are healthy.
      if (calls === 1) return never<TickResult>();
      return Promise.resolve(emptyTickResult());
    };

    await runDaemon({
      config: { tickMs: 10, tickBudgetMs: 100, watchdogMs: 60_000, maxTicks: 2 },
      tickImpl,
    });

    const state = await readDaemonState();
    assert.ok(state, "daemon state was written");
    assert.equal(state!.tickCount, 2, "healthy ticks after the abandoned one still count");
    assert.ok(
      state!.recentErrors.some((e) => /tick timed out after 100ms/.test(e.msg)),
      `recentErrors records the abandoned tick (got: ${JSON.stringify(state!.recentErrors)})`,
    );
    assert.ok(state!.lastTickAt, "lastTickAt is stamped");
  });
});

test("runDaemon: the watchdog fires when the loop stalls past watchdogMs", async () => {
  await withTempStore(async () => {
    const breaches: Array<{ stalledMs: number }> = [];
    const controller = new AbortController();

    // Every tick wedges; the budget (2s) is far above the watchdog threshold
    // (50ms), so the watchdog must catch the stall first. Its breach handler
    // aborts the daemon; once the budget abandons the wedged tick the loop
    // observes `stopping` and shuts down cleanly.
    const done = runDaemon({
      config: { tickMs: 10, tickBudgetMs: 2_000, watchdogMs: 50 },
      tickImpl: () => never<TickResult>(),
      shutdownSignal: controller.signal,
      onWatchdogBreach: (info) => {
        breaches.push(info);
        controller.abort();
      },
    });

    await done;

    assert.ok(breaches.length >= 1, "watchdog breach handler was invoked");
    assert.ok(breaches[0]!.stalledMs > 50, "reported stall exceeds the threshold");
    const state = await readDaemonState();
    assert.ok(
      state!.recentErrors.some((e) => /watchdog: tick loop stalled/.test(e.msg)),
      `recentErrors records the watchdog breach (got: ${JSON.stringify(state!.recentErrors)})`,
    );
  });
});
