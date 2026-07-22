import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createThrottledTranscriptMetadataRefresh,
  emptyDispatcherOutcomes,
  tick,
  tickDispatchers,
  type DispatcherOutcomes,
  type ProbeResult,
  type TickDeps,
  type TickDispatcher,
} from "../src/daemon/run.js";
import type { BeeState, PaneCaptureMap } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import type { NodeRecord } from "../src/node.js";
import { nextRuntimeIncarnationPatch } from "../src/seal.js";

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
  nodes?: NodeRecord[];
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
    listNodes: async () => args.nodes ?? [],
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

test("tick: skips transcript metadata refresh for archived and captured terminal records", async () => {
  await withTempStore(async () => {
    // Captured metadata -> the refresh is skipped for terminal bees.
    const dead = bee({ name: "dead-bee", tmuxTarget: "hive:dead", transcriptPath: "/tmp/dead.jsonl" });
    const sealed = bee({ name: "sealed-bee", tmuxTarget: "hive:sealed", transcriptPath: "/tmp/sealed.jsonl" });
    // Archived records are immutable and must never be revisited, even when an
    // older record has no transcript path.
    const archived = bee({ name: "archived-bee", tmuxTarget: "hive:archived", status: "archived" });
    // A bee that exited before its first refresh (fast finish between ticks)
    // still gets one pass so list/search metadata is not permanently missing.
    const fastExit = bee({ name: "fast-exit-bee", tmuxTarget: "hive:fast" });
    const live = bee({ name: "live-bee", tmuxTarget: "hive:live", lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const refreshed: string[] = [];
    const deps = buildDeps({
      records: [dead, sealed, archived, fastExit, live],
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

    assert.deepEqual(refreshed.sort(), ["fast-exit-bee", "live-bee"]);
    assert.ok(
      capture.touches.some((touch) =>
        touch.name === fastExit.name && typeof touch.fields.terminalTranscriptDiscoveryAt === "string"),
      "the one terminal discovery pass is durably claimed before scanning",
    );
  });
});

test("tick: a terminal record without transcript metadata is not rediscovered after its durable attempt", async () => {
  await withTempStore(async () => {
    const record = bee({
      name: "dead-without-transcript",
      tmuxTarget: "dead-without-transcript",
      substrate: "hsr",
      status: "dead",
      terminalTranscriptDiscoveryAt: "2026-06-03T09:58:00.000Z",
    });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set(),
      capture,
    });
    const refreshed: string[] = [];
    deps.refreshTranscriptMetadata = async (candidate) => {
      refreshed.push(candidate.name);
      return candidate;
    };

    await tick(deps, new Map());

    assert.deepEqual(refreshed, []);
  });
});

test("tick: a revived runtime clears the old terminal discovery claim and gets one new terminal pass", async () => {
  await withTempStore(async () => {
    const retired = bee({
      name: "revived-terminal",
      tmuxTarget: "revived-terminal",
      status: "archived",
      terminalTranscriptDiscoveryAt: "2026-06-03T09:58:00.000Z",
      lastObservedState: "sealed",
    });
    const incarnation = await nextRuntimeIncarnationPatch(retired);
    const diedAgain = { ...retired, ...incarnation, status: "dead" as const };
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({ records: [diedAgain], liveTargets: new Set(), capture });
    const refreshed: string[] = [];
    deps.refreshTranscriptMetadata = async (candidate) => {
      refreshed.push(candidate.name);
      return candidate;
    };

    await tick(deps, new Map());

    assert.deepEqual(refreshed, [diedAgain.name]);
    assert.ok(capture.touches.some((touch) => typeof touch.fields.terminalTranscriptDiscoveryAt === "string"));
  });
});

test("tick: a sealed HSR record without transcript metadata is neither observed nor rediscovered", async () => {
  await withTempStore(async () => {
    const record = bee({ name: "sealed-hsr", tmuxTarget: "sealed-hsr", substrate: "hsr" });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({ records: [record], liveTargets: new Set(), seals: new Set([record.name]), capture });
    const observedBatches: string[][] = [];
    const refreshed: string[] = [];
    deps.hsrObservations = async (beeNames) => {
      observedBatches.push([...beeNames]);
      return new Map();
    };
    deps.refreshTranscriptMetadata = async (candidate) => {
      refreshed.push(candidate.name);
      return candidate;
    };

    await tick(deps, new Map());

    assert.deepEqual(observedBatches, []);
    assert.deepEqual(refreshed, []);
  });
});

test("tick: 1,200-record HSR fleet excludes sealed bees from the observer batch", async () => {
  await withTempStore(async () => {
    const records = Array.from({ length: 1_200 }, (_, index) => bee({
      name: `hsr-${String(index).padStart(4, "0")}`,
      tmuxTarget: `hsr-${String(index).padStart(4, "0")}`,
      substrate: "hsr",
      terminalTranscriptDiscoveryAt: "2026-06-03T09:58:00.000Z",
    }));
    const live = records.at(-1)!;
    const sealed = new Set(records.slice(0, -1).map((record) => record.name));
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({ records, liveTargets: new Set(), seals: sealed, capture });
    const batches: string[][] = [];
    deps.hsrObservations = async (beeNames) => {
      batches.push([...beeNames]);
      return new Map([[live.name, { live: true, state: "active", snapshot: "working" }]]);
    };

    const result = await tick(deps, new Map());

    assert.deepEqual(batches, [[live.name]]);
    assert.equal(result.observed.size, records.length);
    assert.equal(result.observed.get(live.name), "active");
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

test("tick: failed HSR observation holds trusted state and never persists a crash", async () => {
  await withTempStore(async () => {
    const activeHsr = bee({
      name: "active-hsr",
      tmuxTarget: "active-hsr",
      substrate: "hsr",
      lastObservedState: "idle_with_output",
    });
    const idleHsr = bee({
      name: "idle-hsr",
      tmuxTarget: "idle-hsr",
      substrate: "hsr",
      lastObservedState: "idle_with_output",
    });
    const tmux = bee({
      name: "tmux-bee",
      tmuxTarget: "hive:tmux-bee",
      lastPromptAt: "2026-06-03T09:59:00.000Z",
    });
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({
      records: [activeHsr, idleHsr, tmux],
      liveTargets: new Set([tmux.tmuxTarget]),
      panes: new Map([[tmux.tmuxTarget, "done\n\n› next task"]]),
      capture,
    });
    const requested: string[][] = [];
    deps.hsrObservations = async (beeNames) => {
      requested.push([...beeNames]);
      return new Promise<Map<string, never>>(() => undefined);
    };
    deps.timeouts = { substrateMs: 20 };

    const result = await tick(deps, new Map([[activeHsr.name, "active"]]));

    assert.deepEqual(requested, [[activeHsr.name, idleHsr.name]]);
    assert.match(result.errors.find((error) => /hsrObservations/.test(error.message))?.message ?? "", /timed out/);
    assert.equal(result.observed.get(activeHsr.name), "active", "in-memory observation is held while the observer is unavailable");
    assert.equal(result.observed.get(idleHsr.name), "idle_with_output", "stored observation survives daemon restart");
    assert.equal(result.transitions.some((transition) => transition.name === activeHsr.name || transition.name === idleHsr.name), false);
    assert.deepEqual(capture.touches.map((touch) => touch.name), [tmux.name], "unrelated tmux state still persists");
    assert.equal(capture.touches.some((touch) => touch.fields.lastObservedState === "crashed"), false);
  });
});

test("tick: passes HSR, remote-HSR, and tmux-pane activity signals to flight sweeps", async () => {
  await withTempStore(async () => {
    const NOW = Date.parse("2026-06-03T10:00:00.000Z");
    const localHsr = bee({ name: "local-hsr", tmuxTarget: "local-hsr", substrate: "hsr" });
    const remoteHsr = bee({ name: "remote-hsr", tmuxTarget: "remote-hsr", node: "runner01" });
    const tmuxBee = bee({ name: "tmux-bee", tmuxTarget: "hive:tmux-bee", lastPromptAt: new Date(NOW - 1_000).toISOString() });
    const capture: Capture = { ledger: [], touches: [] };
    const remoteNode: NodeRecord = {
      name: "runner01",
      kind: "remote-hsr",
      endpoint: "me@runner01",
      capabilities: ["*"],
      status: "unknown",
      createdAt: "2026-06-03T09:00:00.000Z",
      updatedAt: "2026-06-03T09:00:00.000Z",
    };
    const deps = buildDeps({
      records: [localHsr, remoteHsr, tmuxBee],
      nodes: [remoteNode],
      liveTargets: new Set([tmuxBee.tmuxTarget]),
      panes: new Map([[tmuxBee.tmuxTarget, "Working... esc to interrupt\nstep 1"]]),
      now: NOW,
      capture,
    });
    deps.hsrObservations = async (beeNames) => {
      assert.deepEqual(beeNames, [localHsr.name, remoteHsr.name]);
      return new Map([
        [localHsr.name, { live: true, state: "active" as BeeState, snapshot: "", activity: { at: NOW - 2_000, fingerprint: "hsr-local-fp", eventType: "text" } }],
        [remoteHsr.name, { live: true, state: "active" as BeeState, snapshot: "", mirrorOf: "runner01", activity: { at: NOW - 1_000, fingerprint: "hsr-remote-fp", eventType: "tool_use" } }],
      ]);
    };
    let seenActivity: ReadonlyMap<string, { at: string; fingerprint?: string }> | undefined;
    deps.sweepFlights = async (_records, _observed, activity) => {
      seenActivity = activity;
      return [];
    };

    const result = await tick(deps, new Map());
    const { logTickResult } = await import("../src/daemon/tick.js");

    assert.equal(seenActivity?.get(localHsr.name)?.at, new Date(NOW - 2_000).toISOString());
    assert.equal(seenActivity?.get(localHsr.name)?.fingerprint, "hsr-local-fp");
    assert.equal(seenActivity?.get(remoteHsr.name)?.at, new Date(NOW - 1_000).toISOString());
    assert.equal(seenActivity?.get(remoteHsr.name)?.fingerprint, "hsr-remote-fp");
    assert.equal(seenActivity?.get(tmuxBee.name)?.at, new Date(NOW).toISOString());
    assert.match(seenActivity?.get(tmuxBee.name)?.fingerprint ?? "", /^pane:tmux-bee:/);
    assert.equal(logTickResult(result).some((entry) => entry.msg === "flight.transition"), false);
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
    assert.equal(result.observed.get(record.name), "crashed");
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
    const previous = new Map<string, BeeState>([[record.name, "crashed"]]);
    const result = await tick(deps, previous);
    assert.equal(result.observed.get(record.name), "crashed");
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
    // A fresh createdAt keeps the no-output state at "booting" — an old record
    // would legitimately derive "wedged" (BOOT_WEDGE_MS) and dodge the point.
    const record = bee({ agent: "claude", command: "claude", createdAt: new Date().toISOString() });
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

function dispatcherFor<K extends keyof DispatcherOutcomes>(key: K): TickDispatcher<K> {
  const dispatcher = tickDispatchers.find((candidate) => candidate.key === key);
  assert.ok(dispatcher, `registry has no dispatcher for ${key}`);
  return dispatcher as TickDispatcher<K>;
}

test("dispatcher registry: covers every DispatcherOutcomes key exactly once", () => {
  const expected = Object.keys(emptyDispatcherOutcomes()).sort();
  const keys = tickDispatchers.map((dispatcher) => dispatcher.key);
  assert.deepEqual([...keys].sort(), expected);
  const names = tickDispatchers.map((dispatcher) => dispatcher.name);
  assert.equal(new Set(names).size, names.length, "withTimeout labels must be unique");
});

test("tick: usage exhaustion gates dispatchAutoswap through the registry", async () => {
  await withTempStore(async () => {
    const record = bee();
    const capture: Capture = { ledger: [], touches: [] };
    const exhausted = { bee: record.name, account: "CL.a", sampled: true, exhausted: true };
    let swapInput: unknown;
    const deps: TickDeps = {
      ...buildDeps({ records: [record], liveTargets: new Set(), capture }),
      sampleUsage: async () => [exhausted],
      dispatchAutoswap: async (_records, usageOutcomes) => {
        swapInput = usageOutcomes;
        return [{ bee: record.name, from: "CL.a", to: "CL.b", ok: true }];
      },
    };

    const result = await tick(deps, new Map());

    assert.deepEqual(result.usage, [exhausted]);
    assert.deepEqual(swapInput, [exhausted]);
    assert.deepEqual(result.autoswaps, [{ bee: record.name, from: "CL.a", to: "CL.b", ok: true }]);
  });
});

test("tick: dispatchAutoswap is skipped when no usage outcome is exhausted", async () => {
  await withTempStore(async () => {
    const record = bee();
    const capture: Capture = { ledger: [], touches: [] };
    let swapped = false;
    const deps: TickDeps = {
      ...buildDeps({ records: [record], liveTargets: new Set(), capture }),
      sampleUsage: async () => [{ bee: record.name, account: "CL.a", sampled: true, exhausted: false }],
      dispatchAutoswap: async () => {
        swapped = true;
        return [];
      },
    };

    const result = await tick(deps, new Map());

    assert.equal(swapped, false);
    assert.deepEqual(result.autoswaps, []);
  });
});

test("tick: a timed-out dispatcher stage is captured and later stages still run", async () => {
  await withTempStore(async () => {
    const record = bee();
    const capture: Capture = { ledger: [], touches: [] };
    const deps: TickDeps = {
      ...buildDeps({ records: [record], liveTargets: new Set(), capture }),
      sampleUsage: () => never(),
      dispatchAutoTitle: async () => [{ bee: record.name, ok: true, title: "Still titled" }],
      timeouts: { dispatchMs: 30 },
    };

    const result = await tick(deps, new Map());

    // Budget timeouts are policy: recorded as truncation, never as errors.
    assert.ok(result.truncated.some((name) => name.startsWith("sampleUsage@")));
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.usage, []);
    assert.deepEqual(result.autoTitles, [{ bee: record.name, ok: true, title: "Still titled" }]);
  });
});

test("dispatcher registry: log mappings preserve the daemon log formats", () => {
  const buz = dispatcherFor("buzDrains");
  assert.equal(buz.log({ recipient: "alpha", result: { delivered: [], quarantined: [], errors: [] } }), null);
  assert.deepEqual(buz.log({ recipient: "alpha", result: { delivered: ["m-1"], quarantined: [], errors: [] } }), {
    level: "info",
    msg: "buz.drain",
    recipient: "alpha",
    delivered: 1,
    quarantined: 0,
    errors: 0,
  });
  assert.equal(buz.log({ recipient: "alpha", result: { delivered: [], quarantined: [], errors: [{ id: "m-2", message: "boom" }] } })?.level, "warn");

  const usage = dispatcherFor("usage");
  assert.equal(usage.log({ bee: "alpha", account: "CL.a", sampled: true, exhausted: false }), null);
  assert.deepEqual(usage.log({ bee: "alpha", account: "CL.a", sampled: true, exhausted: true, resetHint: "3pm" }), {
    level: "warn",
    msg: "account.exhausted",
    session: "alpha",
    account: "CL.a",
    resetHint: "3pm",
  });

  const reachability = dispatcherFor("nodeReachability");
  assert.deepEqual(reachability.log({ node: "mini01", transition: "offline" }), { level: "warn", msg: "node.offline", node: "mini01" });
  assert.deepEqual(reachability.log({ node: "mini01", transition: "online" }), { level: "info", msg: "node.online", node: "mini01" });

  const needsInput = dispatcherFor("needsInput");
  assert.deepEqual(needsInput.log({ bee: "alpha", requestId: "r-1", routedTo: "queen" }), {
    level: "info",
    msg: "needs_input.route",
    session: "alpha",
    requestId: "r-1",
    routedTo: "queen",
  });
  assert.equal(needsInput.log({ bee: "alpha", requestId: "r-1", escalated: true, error: "no parent" })?.level, "warn");

  const autoswaps = dispatcherFor("autoswaps");
  assert.deepEqual(autoswaps.log({ bee: "alpha", from: "CL.a", to: "CL.b", ok: true }), {
    level: "info",
    msg: "account.autoswap",
    session: "alpha",
    from: "CL.a",
    to: "CL.b",
    ok: true,
  });
  assert.equal(autoswaps.log({ bee: "alpha", from: "CL.a", ok: false, skipped: "no candidate" })?.level, "warn");

  const autoTitles = dispatcherFor("autoTitles");
  assert.deepEqual(autoTitles.log({ bee: "alpha", ok: true, title: "T" }), {
    level: "info",
    msg: "title.auto",
    session: "alpha",
    ok: true,
    title: "T",
  });
  assert.equal(autoTitles.log({ bee: "alpha", ok: false, error: "boom" })?.level, "warn");
});

test("tick: never calls syncChains — chain sync runs on runDaemon's own track", async () => {
  await withTempStore(async () => {
    const capture: Capture = { ledger: [], touches: [] };
    let called = 0;
    const deps: TickDeps = {
      ...buildDeps({ records: [], liveTargets: new Set(), capture }),
      syncChains: async () => {
        called += 1;
      },
    };

    const result = await tick(deps, new Map());

    assert.equal(called, 0);
    assert.equal(result.errors.length, 0);
  });
});

test("tick: reports per-stage timings for the fixed stages", async () => {
  await withTempStore(async () => {
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({ records: [bee()], liveTargets: new Set(), capture });
    const result = await tick(deps, new Map());
    for (const stage of ["listSessions", "listNodes", "probeNodes", "capturePanes", "sealedBeeNames", "records", "ledger"]) {
      assert.ok(stage in result.stageMs, `missing stage timing: ${stage}`);
      assert.ok(typeof result.stageMs[stage] === "number" && result.stageMs[stage]! >= 0);
    }
  });
});

test("tick: a large archived registry's first observation floods neither the ledger nor the daemon log", async () => {
  await withTempStore(async () => {
    const { logTickResult } = await import("../src/daemon/tick.js");
    // 400 archived sessions + one live bee, fresh daemon (empty previousObserved).
    const records = Array.from({ length: 400 }, (_, i) => bee({ name: `old-${i}`, tmuxTarget: `hive:old-${i}`, status: "archived" }));
    records.push(bee({ name: "live-1", tmuxTarget: "hive:live-1" }));
    const capture: Capture = { ledger: [], touches: [] };
    const deps = buildDeps({ records, liveTargets: new Set(["hive:live-1"]), capture });
    const result = await tick(deps, new Map());

    // Every record is a first observation — real state for consumers...
    assert.equal(result.observed.size, 401);
    // ...but ZERO ledger events and ZERO daemon-log rows (2026-07-21 canary:
    // hundreds of sequential from:null→archived appends per restart).
    assert.equal(capture.ledger.filter((e) => e.type === "state.transition").length, 0);
    const logged = logTickResult(result).filter((entry) => entry.msg === "state.transition");
    assert.equal(logged.length, 0);

    // A REAL transition on the next tick (live-1's tmux target vanishes) still
    // logs and ledgers.
    const secondDeps = buildDeps({ records, liveTargets: new Set(), capture });
    const second = await tick(secondDeps, result.observed);
    const realRows = logTickResult(second).filter((entry) => entry.msg === "state.transition");
    assert.equal(realRows.length, 1);
    assert.equal(realRows[0]!.session, "live-1");
    assert.equal(capture.ledger.filter((e) => e.type === "state.transition").length, 1);
  });
});

test("canary round 2: cold-cache samplers skip the first tick, run on the second", async () => {
  await withTempStore(async () => {
    const record = bee({ lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const invoked: string[] = [];
    const deps = buildDeps({
      records: [record],
      liveTargets: new Set([record.tmuxTarget]),
      panes: new Map([[record.tmuxTarget, "done\n\n› next task"]]),
      capture,
    });
    deps.sampleUsage = async () => {
      invoked.push("sampleUsage");
      return [];
    };
    deps.dispatchAutoTitle = async () => {
      invoked.push("dispatchAutoTitle");
      return [];
    };
    deps.sweepPools = async () => {
      invoked.push("sweepPools");
      return [];
    };
    deps.dispatchBuzDrain = async () => {
      invoked.push("dispatchBuzDrain");
      return [];
    };

    const first = await tick(deps, new Map(), { firstTick: true });
    // Heavy periodic samplers sit the boot tick out; event-driven stages run.
    assert.ok(!invoked.includes("sampleUsage"));
    assert.ok(!invoked.includes("dispatchAutoTitle"));
    assert.ok(!invoked.includes("sweepPools"));
    assert.ok(invoked.includes("dispatchBuzDrain"));
    assert.equal(first.errors.length, 0);

    invoked.length = 0;
    await tick(deps, first.observed, { firstTick: false });
    assert.ok(invoked.includes("sampleUsage"));
    assert.ok(invoked.includes("dispatchAutoTitle"));
    assert.ok(invoked.includes("sweepPools"));
  });
});

test("canary round 3: the shared dispatch pool bounds the registry — stages cannot sum past it", async () => {
  await withTempStore(async () => {
    const record = bee({ lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const deps: TickDeps = {
      ...buildDeps({
        records: [record],
        liveTargets: new Set([record.tmuxTarget]),
        panes: new Map([[record.tmuxTarget, "done\n\n› next task"]]),
        capture,
      }),
      // Real clock: this test measures wall-time bounding.
      now: () => Date.now(),
      timeouts: { dispatchMs: 10_000, dispatchTotalMs: 120 },
    };
    const slow = (ms: number) => new Promise<never[]>((resolve) => setTimeout(() => resolve([]), ms));
    let poolRan = false;
    deps.sampleUsage = () => slow(500) as never; // eats the whole 120ms pool (timed out at ~120ms)
    deps.dispatchAutoTitle = () => slow(500) as never; // pool dry → skipped or truncated
    deps.sweepPools = async () => {
      poolRan = true;
      return [];
    };

    const start = Date.now();
    const result = await tick(deps, new Map(), { firstTick: false });
    const elapsed = Date.now() - start;

    // Without the shared pool this would take >=1000ms (two 500ms stages) —
    // with it, the dispatcher phase is bounded near dispatchTotalMs.
    assert.ok(elapsed < 700, `dispatcher phase took ${elapsed}ms — pool did not bound it`);
    // The starved stages are recorded as TRUNCATED (policy), never as errors.
    assert.ok(result.truncated.some((name) => name.startsWith("sampleUsage@")));
    assert.ok(result.truncated.some((name) => name.startsWith("dispatchAutoTitle@")) || poolRan === false);
    assert.equal(result.errors.length, 0, "budget enforcement must not manufacture errors");
  });
});

test("canary round 4: a slow usage sampler starves itself, never the flight stage", async () => {
  await withTempStore(async () => {
    const record = bee({ lastPromptAt: "2026-06-03T09:59:00.000Z" });
    const capture: Capture = { ledger: [], touches: [] };
    const ran: string[] = [];
    const deps: TickDeps = {
      ...buildDeps({
        records: [record],
        liveTargets: new Set([record.tmuxTarget]),
        panes: new Map([[record.tmuxTarget, "done\n\n› next task"]]),
        capture,
      }),
      now: () => Date.now(),
      timeouts: { dispatchMs: 10_000, dispatchTotalMs: 150 },
    };
    deps.sweepFlights = async () => {
      ran.push("sweepFlights");
      return [];
    };
    // Would previously run BEFORE flights and drain the whole pool.
    deps.sampleUsage = () => new Promise((resolve) => setTimeout(() => resolve([]), 400)) as never;
    deps.dispatchAutoTitle = async () => {
      ran.push("dispatchAutoTitle");
      return [];
    };

    const result = await tick(deps, new Map(), { firstTick: false });

    // The safety-critical flight stage ran; the sampler consumed the pool and
    // was bounded; whatever followed it was starved instead of the flights.
    assert.deepEqual(ran.filter((name) => name === "sweepFlights"), ["sweepFlights"]);
    assert.ok(result.stageMs.sweepFlights !== undefined, "flight stage executed and was timed");
    assert.ok(result.truncated.some((name) => name.startsWith("sampleUsage@")));
    assert.equal(result.errors.length, 0, "budget enforcement must not manufacture errors");
  });
});

test("PROD INCIDENT 2026-07-21: the flight sweep never runs against a failed listSessions snapshot", async () => {
  await withTempStore(async () => {
    const capture: Capture = { ledger: [], touches: [] };
    let sweeps = 0;
    const good = buildDeps({ records: [bee()], liveTargets: new Set(), capture });
    const deps: TickDeps = {
      ...good,
      listSessions: async () => {
        throw new Error("listSessions timed out after 15000ms");
      },
      sweepFlights: async () => {
        sweeps += 1;
        return [];
      },
    };

    const result = await tick(deps, new Map());
    assert.equal(sweeps, 0, "sweepFlights must not act on the guard's empty fallback snapshot");
    assert.ok(result.errors.some((e) => /listSessions timed out/.test(e.message)));

    // With a healthy snapshot the stage runs normally.
    good.sweepFlights = async () => {
      sweeps += 1;
      return [];
    };
    await tick(good, new Map());
    assert.equal(sweeps, 1);
  });
});
