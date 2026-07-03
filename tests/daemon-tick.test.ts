import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createThrottledTranscriptMetadataRefresh, tick, type ProbeResult, type TickDeps } from "../src/daemon/run.js";
import type { BeeState, PaneCaptureMap } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-daemon-tick-"));
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

function bee(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "alpha",
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget: "hive:alpha",
    createdAt: "2026-05-28T11:00:00.000Z",
    updatedAt: "2026-05-28T11:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

type Capture = {
  ledger: Record<string, unknown>[];
  touches: Array<{ name: string; fields: Partial<SessionRecord> }>;
};

function buildDeps(args: {
  records: SessionRecord[];
  liveTargets: Set<string>;
  sessionStates?: Map<string, string>;
  panes?: PaneCaptureMap;
  seals?: Set<string>;
  unreachableNodes?: Set<string>;
  now?: number;
  capture: Capture;
  failTouchFor?: Set<string>;
}): TickDeps {
  const probe: ProbeResult = {
    liveTargets: args.liveTargets,
    unreachableNodes: args.unreachableNodes ?? new Set(),
    ...(args.sessionStates ? { sessionStates: args.sessionStates } : {}),
  };
  const panes = args.panes ?? new Map();
  const seals = args.seals ?? new Set<string>();
  const nowFixed = args.now ?? Date.parse("2026-06-03T10:00:00.000Z");
  return {
    listSessions: async () => args.records,
    listNodes: async () => [],
    probeNodes: async () => probe,
    capturePanes: async () => panes,
    sealedBeeNames: async () => seals,
    touchSession: async (name, fields) => {
      if (args.failTouchFor?.has(name)) throw new Error(`touch failed for ${name}`);
      args.capture.touches.push({ name, fields });
      const original = args.records.find((r) => r.name === name);
      return original ? { ...original, ...fields } : null;
    },
    appendLedger: async (event) => {
      args.capture.ledger.push(event);
    },
    now: () => nowFixed,
  };
}

test("tick: no-op on empty sessions", async () => {
  await withTempStore(async () => {
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({ records: [], liveTargets: new Set(), capture });
    const result = await tick(deps, new Map());
    assert.equal(result.transitions.length, 0);
    assert.equal(result.observed.size, 0);
    assert.equal(capture.ledger.length, 0);
    assert.equal(capture.touches.length, 0);
  });
});

test("tick: detects state transition into idle_with_output and emits ledger", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const lastPromptAt = new Date(NOW - 60_000).toISOString(); // 60s ago -> idle
    const record = bee({ lastPromptAt });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set([record.tmuxTarget]),
      panes: new Map([[record.tmuxTarget, "done\n\n› next task"]]),
      now: NOW,
      capture,
    });
    const previous = new Map<string, BeeState>([[record.name, "active"]]);
    const result = await tick(deps, previous);
    assert.equal(result.observed.get(record.name), "idle_with_output");
    assert.equal(result.transitions.length, 1);
    assert.deepEqual(result.transitions[0], { name: record.name, from: "active", to: "idle_with_output" });
    assert.equal(capture.ledger.length, 1);
    assert.equal(capture.ledger[0]!.type, "state.transition");
    assert.equal(capture.touches.length, 1);
    assert.equal(capture.touches[0]!.fields.lastObservedState, "idle_with_output");
    assert.ok(typeof capture.touches[0]!.fields.lastObservedStateAt === "string");
  });
});

test("tick: invokes transcript metadata refresh for observed records", async () => {
  await withTempStore(async () => {
    const record = bee({ lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const refreshed: string[] = [];
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set([record.tmuxTarget]),
      panes: new Map([[record.tmuxTarget, "done\n\n› next task"]]),
      capture,
    });
    deps.refreshTranscriptMetadata = async (candidate) => {
      refreshed.push(candidate.name);
      return candidate;
    };

    await tick(deps, new Map());

    assert.deepEqual(refreshed, ["alpha"]);
  });
});

test("tick: skips transcript metadata refresh for dead/sealed records whose transcript is already captured", async () => {
  await withTempStore(async () => {
    // Captured metadata -> the refresh is skipped for terminal bees.
    const dead = bee({ name: "dead-bee", tmuxTarget: "hive:dead", transcriptPath: "/tmp/dead.jsonl" });
    const sealed = bee({ name: "sealed-bee", tmuxTarget: "hive:sealed", transcriptPath: "/tmp/sealed.jsonl" });
    // A bee that exited before its first refresh (fast finish between ticks)
    // still gets one pass so list/search metadata is not permanently missing.
    const fastExit = bee({ name: "fast-exit-bee", tmuxTarget: "hive:fast" });
    const live = bee({ name: "live-bee", tmuxTarget: "hive:live", lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const refreshed: string[] = [];
    const deps = buildDeps({
      records: [dead, sealed, fastExit, live],
      liveTargets: new Set([live.tmuxTarget]),
      panes: new Map([[live.tmuxTarget, "done\n\n› next task"]]),
      seals: new Set(["sealed-bee"]),
      capture,
    });
    deps.refreshTranscriptMetadata = async (candidate) => {
      refreshed.push(candidate.name);
      return candidate;
    };

    await tick(deps, new Map());

    assert.deepEqual(refreshed, ["fast-exit-bee", "live-bee"]);
  });
});

test("tick: invokes dispatchAutoTitle and surfaces its outcomes on the result", async () => {
  await withTempStore(async () => {
    const record = bee({ lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set([record.tmuxTarget]),
      panes: new Map([[record.tmuxTarget, "done\n\n› next task"]]),
      capture,
    });
    let seen: string[] | null = null;
    deps.dispatchAutoTitle = async (records) => {
      seen = records.map((r) => r.name);
      return [{ bee: record.name, ok: true, title: "Generated title" }];
    };

    const result = await tick(deps, new Map());
    assert.deepEqual(seen, [record.name]);
    assert.deepEqual(result.autoTitles, [{ bee: record.name, ok: true, title: "Generated title" }]);
  });
});

test("tick: a throwing dispatchAutoTitle is captured and the tick still completes", async () => {
  await withTempStore(async () => {
    const record = bee({ lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({ records: [record], liveTargets: new Set([record.tmuxTarget]), capture });
    deps.dispatchAutoTitle = async () => {
      throw new Error("titler boom");
    };

    const result = await tick(deps, new Map());
    assert.deepEqual(result.autoTitles, []);
    assert.ok(result.errors.some((e) => /titler boom/.test(e.message)));
    assert.equal(result.observed.size, 1);
  });
});

test("tick: liveness keys qualified by node do not leak across nodes", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    // Local record whose target name collides with a live session on mini01.
    const record = bee({ tmuxTarget: "hive:alpha" });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set(["mini01 hive:alpha"]),
      now: NOW,
      capture,
    });
    const result = await tick(deps, new Map());
    assert.equal(result.observed.get(record.name), "dead");
  });
});

test("tick: first observation (no prev) does NOT emit state.transition ledger", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const lastPromptAt = new Date(NOW - 60_000).toISOString();
    const record = bee({ lastPromptAt });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set([record.tmuxTarget]),
      panes: new Map([[record.tmuxTarget, "done\n\n› next task"]]),
      now: NOW,
      capture,
    });
    const result = await tick(deps, new Map());
    assert.equal(result.observed.get(record.name), "idle_with_output");
    // First observation must not emit a transition event
    assert.equal(capture.ledger.filter((e) => e.type === "state.transition").length, 0);
  });
});

test("tick: identical state -> no transition recorded", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const record = bee();
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set(),
      now: NOW,
      capture,
    });
    const previous = new Map<string, BeeState>([[record.name, "dead"]]);
    const result = await tick(deps, previous);
    assert.equal(result.observed.get(record.name), "dead");
    assert.equal(result.transitions.length, 0);
  });
});

test("tick: touchSession failure is captured but does not abort tick", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const a = bee({ name: "alpha", tmuxTarget: "hive:alpha" });
    const b = bee({ name: "beta", tmuxTarget: "hive:beta" });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [a, b],
      liveTargets: new Set(),
      now: NOW,
      capture,
      failTouchFor: new Set(["alpha"]),
    });
    const result = await tick(deps, new Map());
    assert.equal(result.observed.size, 2);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /touch failed/);
    // beta should still have been touched.
    assert.ok(capture.touches.some((t) => t.name === "beta"));
  });
});

test("tick: dep failure (probeNodes) is captured and tick still completes", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const record = bee();
    const capture: Capture = { ledger: [], touches: [] };
    const deps: TickDeps = {
      listSessions: async () => [record],
      listNodes: async () => [],
      probeNodes: async () => {
        throw new Error("probe boom");
      },
      capturePanes: async () => new Map(),
      sealedBeeNames: async () => new Set(),
      touchSession: async (name, fields) => {
        capture.touches.push({ name, fields });
        return { ...record, ...fields };
      },
      appendLedger: async (event) => {
        capture.ledger.push(event);
      },
      now: () => NOW,
    };
    const result = await tick(deps, new Map());
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /probe boom/);
    assert.equal(result.observed.size, 1); // tick still derived state
  });
});

test("tick: unreachable node yields node_unreachable state and is reported on result", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const record = bee({ node: "mini01" });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set(),
      unreachableNodes: new Set(["mini01"]),
      now: NOW,
      capture,
    });
    const result = await tick(deps, new Map());
    assert.equal(result.observed.get(record.name), "node_unreachable");
    assert.equal(result.unreachableNodes.has("mini01"), true);
  });
});

test("tick: mirrors hive state onto tmux on transitions", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const record = bee({ lastPromptAt: new Date(NOW - 60_000).toISOString() });
    const capture: Capture = { ledger: [], touches: [] };
    const mirrored: Array<{ name: string; state: BeeState }> = [];
    const deps: TickDeps = {
      ...buildDeps({
        records: [record],
        liveTargets: new Set([record.tmuxTarget]),
        panes: new Map([[record.tmuxTarget, "done\n\n› next task"]]),
        now: NOW,
        capture,
      }),
      mirrorHiveState: async (rec, state) => {
        mirrored.push({ name: rec.name, state });
      },
    };
    // active -> idle_with_output mirrors exactly once...
    await tick(deps, new Map([[record.name, "active"]]));
    assert.deepEqual(mirrored, [{ name: record.name, state: "idle_with_output" }]);
    // ...and a steady-state tick mirrors nothing.
    await tick(deps, new Map([[record.name, "idle_with_output"]]));
    assert.equal(mirrored.length, 1);
  });
});

test("tick: repairs stale live hive state without recording a transition", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const record = bee({ lastPromptAt: new Date(NOW - 60_000).toISOString() });
    const capture: Capture = { ledger: [], touches: [] };
    const mirrored: Array<{ name: string; state: BeeState }> = [];
    const deps: TickDeps = {
      ...buildDeps({
        records: [record],
        liveTargets: new Set([record.tmuxTarget]),
        sessionStates: new Map([[record.tmuxTarget, "waiting"]]),
        panes: new Map([[record.tmuxTarget, "Working... esc to interrupt"]]),
        now: NOW,
        capture,
      }),
      mirrorHiveState: async (rec, state) => {
        mirrored.push({ name: rec.name, state });
      },
    };

    const result = await tick(deps, new Map([[record.name, "active"]]));

    assert.equal(result.observed.get(record.name), "active");
    assert.equal(result.transitions.length, 0);
    assert.deepEqual(mirrored, [{ name: record.name, state: "active" }]);
  });
});

test("tick: does not mirror uncertain booting over an existing live hive state", async () => {
  await withTempStore(async () => {
    const record = bee({ agent: "claude", command: "claude" });
    const capture: Capture = { ledger: [], touches: [] };
    const mirrored: Array<{ name: string; state: BeeState }> = [];
    const deps: TickDeps = {
      ...buildDeps({
        records: [record],
        liveTargets: new Set([record.tmuxTarget]),
        sessionStates: new Map([[record.tmuxTarget, "waiting"]]),
        panes: new Map([[record.tmuxTarget, ""]]),
        capture,
      }),
      mirrorHiveState: async (rec, state) => {
        mirrored.push({ name: rec.name, state });
      },
    };

    const result = await tick(deps, new Map());

    assert.equal(result.observed.get(record.name), "booting");
    assert.deepEqual(result.transitions, [{ name: record.name, from: undefined, to: "booting" }]);
    assert.deepEqual(mirrored, []);
  });
});

test("tick: unknown pane capture preserves active and avoids idle transition side effects", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const record = bee({ lastPromptAt: new Date(NOW - 10 * 60_000).toISOString(), lastPrompt: "keep working" });
    const capture: Capture = { ledger: [], touches: [] };
    let dispatchInput: { transitions: Array<{ from: BeeState | undefined; to: BeeState }>; current: BeeState | undefined } | undefined;
    const deps: TickDeps = {
      ...buildDeps({
        records: [record],
        liveTargets: new Set([record.tmuxTarget]),
        panes: new Map<string, string | undefined>([[record.tmuxTarget, undefined]]),
        now: NOW,
        capture,
      }),
      dispatchBuzDrain: async (_records, transitions, currentStates) => {
        dispatchInput = {
          transitions: transitions.map(({ from, to }) => ({ from, to })),
          current: currentStates.get(record.name),
        };
        return [];
      },
    };

    const result = await tick(deps, new Map([[record.name, "active"]]));

    assert.equal(result.observed.get(record.name), "active");
    assert.equal(result.transitions.length, 0);
    assert.equal(capture.ledger.length, 0);
    assert.equal(capture.touches[0]!.fields.lastObservedState, "active");
    assert.deepEqual(dispatchInput, { transitions: [], current: "active" });
  });
});

// A promise that never settles — the production wedge shape (a lost libuv fs
// completion froze one tick, and therefore the daemon, for 3+ days).
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

async function waitForCondition(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitForCondition timed out: ${label}`);
}

test("transcript metadata refresh throttle skips unchanged transcript cursors", async () => {
  let now = 1_000;
  let fileStat = { mtimeMs: 10, size: 100 };
  const refreshed: string[] = [];
  const refresh = createThrottledTranscriptMetadataRefresh(
    async (record) => {
      refreshed.push(`${record.name}:${record.lastPromptAt ?? ""}`);
      return record;
    },
    {
      intervalMs: 100,
      now: () => now,
      statFile: async () => fileStat,
    },
  );
  const record = bee({ transcriptPath: "/tmp/alpha.jsonl", lastPromptAt: "2026-06-03T09:59:00.000Z" });

  await refresh(record);
  await refresh(record);
  assert.deepEqual(refreshed, ["alpha:2026-06-03T09:59:00.000Z"], "same cursor inside the interval is skipped");

  now += 101;
  await refresh(record);
  assert.equal(refreshed.length, 1, "same transcript mtime/size is skipped after the interval");

  fileStat = { mtimeMs: 11, size: 100 };
  now += 101;
  await refresh(record);
  assert.equal(refreshed.length, 2, "changed transcript mtime refreshes");

  await refresh({ ...record, lastPromptAt: "2026-06-03T10:01:00.000Z" });
  assert.equal(refreshed.length, 3, "changed prompt cursor refreshes immediately");
});

test("tick: a capturePanes that never settles is timed out, recorded, and the tick completes", async () => {
  await withTempStore(async () => {
    const record = bee({ lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const deps: TickDeps = {
      ...buildDeps({ records: [record], liveTargets: new Set([record.tmuxTarget]), capture }),
      capturePanes: () => never(),
      timeouts: { substrateMs: 30 },
    };

    const result = await tick(deps, new Map([[record.name, "active"]]));

    assert.ok(result.errors.some((e) => /capturePanes timed out after 30ms/.test(e.message)));
    // The tick still observed the record, but preserved the previous state
    // because pane content was unknown rather than factually empty.
    assert.equal(result.observed.has(record.name), true);
    assert.equal(result.observed.get(record.name), "active");
    assert.equal(result.transitions.length, 0);
    assert.equal(capture.touches.length, 1);
  });
});

test("tick: a hung per-record transcript refresh is timed out and later records still refresh", async () => {
  await withTempStore(async () => {
    const first = bee({ name: "alpha", tmuxTarget: "hive:alpha", lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const second = bee({ name: "beta", tmuxTarget: "hive:beta", lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const refreshed: string[] = [];
    const deps: TickDeps = {
      ...buildDeps({ records: [first, second], liveTargets: new Set([first.tmuxTarget, second.tmuxTarget]), capture }),
      refreshTranscriptMetadata: (rec) => {
        if (rec.name === "alpha") return never();
        refreshed.push(rec.name);
        return Promise.resolve(rec);
      },
      timeouts: { transcriptMs: 30 },
    };

    const result = await tick(deps, new Map());

    assert.ok(result.errors.some((e) => /refreshTranscriptMetadata\(alpha\) timed out after 30ms/.test(e.message)));
    assert.deepEqual(refreshed, ["beta"]);
    assert.equal(result.observed.size, 2);
  });
});

test("tick: per-record refresh work runs with bounded concurrency", async () => {
  await withTempStore(async () => {
    const previousConcurrency = process.env.HIVE_DAEMON_RECORD_CONCURRENCY;
    process.env.HIVE_DAEMON_RECORD_CONCURRENCY = "2";
    try {
      const first = bee({ name: "alpha", tmuxTarget: "hive:alpha", lastPromptAt: "2026-06-03T09:59:00.000Z" });
      const second = bee({ name: "beta", tmuxTarget: "hive:beta", lastPromptAt: "2026-06-03T09:59:00.000Z" });
      const capture: Capture = { ledger: [], touches: [] };
      let releaseAlpha: (() => void) | undefined;
      const started: string[] = [];
      const deps: TickDeps = {
        ...buildDeps({ records: [first, second], liveTargets: new Set([first.tmuxTarget, second.tmuxTarget]), capture }),
        refreshTranscriptMetadata: async (rec) => {
          started.push(rec.name);
          if (rec.name === "alpha") {
            await new Promise<void>((resolve) => {
              releaseAlpha = resolve;
            });
          }
          return rec;
        },
      };

      const pending = tick(deps, new Map());
      await waitForCondition(() => started.includes("alpha") && started.includes("beta"), "both refreshes started");
      releaseAlpha?.();
      const result = await pending;

      assert.equal(result.observed.size, 2);
      assert.deepEqual(started.sort(), ["alpha", "beta"]);
    } finally {
      if (previousConcurrency === undefined) delete process.env.HIVE_DAEMON_RECORD_CONCURRENCY;
      else process.env.HIVE_DAEMON_RECORD_CONCURRENCY = previousConcurrency;
    }
  });
});

test("tick: a hung syncChains is timed out and does not block the tick result", async () => {
  await withTempStore(async () => {
    const capture: Capture = { ledger: [], touches: [] };
    const deps: TickDeps = {
      ...buildDeps({ records: [], liveTargets: new Set(), capture }),
      syncChains: () => never(),
      timeouts: { chainSyncMs: 30 },
    };

    const result = await tick(deps, new Map());

    assert.ok(result.errors.some((e) => /syncChains timed out after 30ms/.test(e.message)));
  });
});
