import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tick, type ProbeResult, type TickDeps } from "../src/daemon/run.js";
import type { BeeState } from "../src/state.js";
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
  panes?: Map<string, string>;
  seals?: Set<string>;
  unreachableNodes?: Set<string>;
  now?: number;
  capture: Capture;
  failTouchFor?: Set<string>;
}): TickDeps {
  const probe: ProbeResult = {
    liveTargets: args.liveTargets,
    unreachableNodes: args.unreachableNodes ?? new Set(),
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
