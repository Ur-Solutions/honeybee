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
    nodeReachability: [],
    poolSweeps: [],
    usage: [],
    autoswaps: [],
    autoTitles: [],
    tokenRefreshes: [],
    flightSweeps: [],
    durationMs: 0,
    stageMs: {},
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

test("runDaemon: a budget-abandoned tick never overlaps the next — the loop skips until it settles, then adopts its observed map", async () => {
  await withTempStore(async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const observedArgs: Array<Map<string, string>> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The wedged tick eventually resolves with an observed map of its own; the
    // loop must adopt it so the next tick doesn't re-fire the same transitions.
    const lateResult: TickResult = { ...emptyTickResult(), observed: new Map([["wedged-bee", "active"]]) };

    const tickImpl: typeof import("../src/daemon/run.js").tick = async (_deps, previousObserved) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      observedArgs.push(new Map(previousObserved));
      try {
        if (calls === 1) {
          await gate; // wedges well past the budget (the production failure shape), then settles
          return lateResult;
        }
        return emptyTickResult();
      } finally {
        active -= 1;
      }
    };
    setTimeout(release, 150);

    await runDaemon({
      config: { tickMs: 20, tickBudgetMs: 50, watchdogMs: 60_000, maxConsecutiveFailures: 1_000, maxTicks: 2 },
      tickImpl,
    });

    const state = await readDaemonState();
    assert.ok(state, "daemon state was written");
    assert.equal(maxActive, 1, "no two ticks ever ran concurrently");
    assert.equal(state!.tickCount, 2, "healthy ticks after the abandoned one still count");
    assert.ok(
      state!.recentErrors.some((e) => /tick timed out after 50ms/.test(e.msg)),
      `recentErrors records the abandoned tick (got: ${JSON.stringify(state!.recentErrors)})`,
    );
    assert.ok(
      state!.recentErrors.some((e) => /tick skipped: previous tick still running/.test(e.msg)),
      `recentErrors records the skipped iterations (got: ${JSON.stringify(state!.recentErrors)})`,
    );
    assert.equal(
      observedArgs[1]?.get("wedged-bee"),
      "active",
      "the tick after late settlement starts from the abandoned tick's observed map",
    );
    assert.ok(state!.lastTickAt, "lastTickAt is stamped");
  });
});

test("runDaemon: a never-settling abandoned tick escalates via maxConsecutiveFailures instead of spawning overlapping ticks", async () => {
  await withTempStore(async () => {
    let calls = 0;
    const breaches: Array<{ stalledMs: number; reason: string }> = [];
    const controller = new AbortController();

    const done = runDaemon({
      config: { tickMs: 5, tickBudgetMs: 30, watchdogMs: 60_000, maxConsecutiveFailures: 3 },
      tickImpl: () => {
        calls += 1;
        return never<TickResult>();
      },
      shutdownSignal: controller.signal,
      onWatchdogBreach: (info) => {
        breaches.push(info);
        controller.abort();
      },
    });

    await done;

    assert.equal(calls, 1, "the wedged tick was started exactly once — no overlapping tick was launched");
    assert.equal(breaches.length, 1, "breach fired exactly once");
    assert.match(breaches[0]!.reason, /consecutive failed loop iterations/);
    const state = await readDaemonState();
    assert.ok(
      state!.recentErrors.some((e) => /tick skipped: previous tick still running/.test(e.msg)),
      `recentErrors records the skips (got: ${JSON.stringify(state!.recentErrors)})`,
    );
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

test("runDaemon: consecutive failed iterations escalate to a breach (poisoned-runtime guard)", async () => {
  await withTempStore(async () => {
    const breaches: Array<{ stalledMs: number; reason: string }> = [];
    const controller = new AbortController();

    // Every tick rejects fast — the shape of a poisoned threadpool where the
    // per-call timeouts contain each tick but nothing ever succeeds again.
    // The beat watchdog can't fire (the loop keeps beating), so the
    // consecutive-failure escalation must.
    const done = runDaemon({
      config: { tickMs: 5, tickBudgetMs: 5_000, watchdogMs: 60_000, maxConsecutiveFailures: 3 },
      tickImpl: () => Promise.reject(new Error("threadpool poisoned")),
      shutdownSignal: controller.signal,
      onWatchdogBreach: (info) => {
        breaches.push(info);
        controller.abort();
      },
    });

    await done;

    assert.equal(breaches.length, 1, "breach fired exactly once");
    assert.match(breaches[0]!.reason, /3 consecutive failed loop iterations/);
    const state = await readDaemonState();
    assert.ok(
      state!.recentErrors.some((e) => /consecutive failed loop iterations/.test(e.msg)),
      `recentErrors records the escalation (got: ${JSON.stringify(state!.recentErrors)})`,
    );
  });
});

test("sentinel: heartbeatStale judges by mtime with sentinel start as fallback", async () => {
  const { heartbeatStale } = await import("../src/daemon/sentinel.js");
  const t0 = Date.parse("2026-07-03T00:00:00.000Z");
  assert.equal(heartbeatStale(t0, t0, t0 + 60_000, 300_000), false, "fresh heartbeat");
  assert.equal(heartbeatStale(t0, t0, t0 + 301_000, 300_000), true, "stale heartbeat");
  assert.equal(heartbeatStale(null, t0, t0 + 60_000, 300_000), false, "missing file within grace");
  assert.equal(heartbeatStale(null, t0, t0 + 301_000, 300_000), true, "missing file past grace");
});

test("sentinel: SIGKILLs a live parent whose heartbeat stalls, then stops", async () => {
  const { runSentinel } = await import("../src/daemon/sentinel.js");
  const killed: number[] = [];
  let nowMs = 1_000_000;
  const heartbeat = nowMs; // frozen: the parent never writes state again
  const outcome = await runSentinel(
    { parentPid: 4242, statePath: "/nonexistent/state.json", staleMs: 100, checkMs: 1 },
    {
      isAlive: () => true,
      mtimeMs: () => heartbeat,
      kill: (pid) => killed.push(pid),
      now: () => nowMs,
      sleep: async () => {
        nowMs += 50; // virtual clock; no real waiting
      },
    },
  );
  assert.equal(outcome, "killed");
  assert.deepEqual(killed, [4242]);
});

test("sentinel: exits without killing when the parent is already gone", async () => {
  const { runSentinel } = await import("../src/daemon/sentinel.js");
  const killed: number[] = [];
  const outcome = await runSentinel(
    { parentPid: 4242, statePath: "/nonexistent/state.json", staleMs: 100, checkMs: 1 },
    {
      isAlive: () => false,
      mtimeMs: () => null,
      kill: (pid) => killed.push(pid),
    },
  );
  assert.equal(outcome, "parent-exited");
  assert.deepEqual(killed, []);
});

test("sentinel: stays quiet while the heartbeat keeps advancing", async () => {
  const { runSentinel } = await import("../src/daemon/sentinel.js");
  const killed: number[] = [];
  let nowMs = 0;
  let checks = 0;
  const outcome = await runSentinel(
    { parentPid: 4242, statePath: "/state.json", staleMs: 100, checkMs: 1 },
    {
      isAlive: () => checks < 20, // parent exits cleanly after a while
      mtimeMs: () => nowMs - 10, // heartbeat always fresh
      kill: (pid) => killed.push(pid),
      now: () => nowMs,
      sleep: async () => {
        nowMs += 50;
        checks += 1;
      },
    },
  );
  assert.equal(outcome, "parent-exited");
  assert.deepEqual(killed, []);
});
