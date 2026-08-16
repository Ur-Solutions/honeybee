import assert from "node:assert/strict";
import { test } from "node:test";
import { cmdBees, createBeesTuiRefreshItems, loadBeesJsonRows } from "../src/commands/observe.js";
import { parse } from "../src/parse.js";
import { liveTargetKey, type StateContext } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import type { BeesTuiItem } from "../src/beesTui.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CO.active",
    agent: "codex",
    cwd: "/tmp/hive-active",
    command: "codex",
    tmuxTarget: "CO.active",
    id: "CO.active",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    status: "running",
    lastObservedState: "ready",
    ...overrides,
  };
}

function contextFor(records: SessionRecord[]): StateContext & { hsrLive: Set<string>; now: number } {
  const liveTargets = new Set(records.filter((r) => r.status !== "dead").map((r) => liveTargetKey(r.node, r.tmuxTarget)));
  const previousStates = new Map(records.map((r) => [r.name, "ready" as const]));
  return {
    liveTargets,
    livePanes: new Set(),
    panes: new Map(),
    previousStates,
    seals: new Set(),
    unreachableNodes: new Set(),
    hsrLive: new Set(),
    now: Date.parse("2026-08-16T00:00:05.000Z"),
  };
}

function probeFor(records: SessionRecord[]) {
  return {
    liveTargets: new Set(records.filter((r) => r.status !== "dead").map((r) => liveTargetKey(r.node, r.tmuxTarget))),
    unreachableNodes: new Set<string>(),
    perNode: new Map<string, string[]>(),
    states: new Map(records.map((r) => [liveTargetKey(r.node, r.tmuxTarget), "waiting"])),
  };
}

async function captureConsoleLog(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("hive bees --json is a one-shot active projection and never enters the raw-mode TUI", async () => {
  const active = record();
  let hotLoads = 0;
  let activeLoads = 0;
  let historyLoads = 0;
  let nodeLoads = 0;
  let probeCalls = 0;
  let contextCalls = 0;
  let tuiCalls = 0;

  const stdout = await captureConsoleLog(() => cmdBees(parse(["bees", "--json"]), {
    listActiveSessionsHot: async () => { hotLoads += 1; return [active]; },
    listActiveSessions: async () => { activeLoads += 1; return [active]; },
    listSessions: async () => { historyLoads += 1; return []; },
    listNodes: async () => { nodeLoads += 1; return []; },
    liveTargetsAcrossNodes: async () => { probeCalls += 1; return probeFor([active]); },
    buildStateContext: async (records) => { contextCalls += 1; return contextFor(records); },
    runBeesTui: async () => { tuiCalls += 1; throw new Error("raw-mode TUI must not start for --json"); },
  }));

  const rows = JSON.parse(stdout) as Array<{ name: string; state: string; beeState: string }>;
  assert.deepEqual(rows, [{ ...rows[0], name: "CO.active", state: "waiting", beeState: "ready" }]);
  assert.equal(hotLoads, 1);
  assert.equal(activeLoads, 0);
  assert.equal(historyLoads, 0);
  assert.equal(nodeLoads, 0);
  assert.equal(probeCalls, 0);
  assert.equal(contextCalls, 0);
  assert.equal(tuiCalls, 0);
});

test("bees/list JSON defaults to active records and --history opts into canonical history", async () => {
  const active = record({ name: "CO.active" });
  const dead = record({ name: "CO.dead", status: "dead", lastObservedState: "dead" });
  let hotLoads = 0;
  let historyLoads = 0;
  const deps = {
    listActiveSessionsHot: async () => { hotLoads += 1; return [active]; },
    listSessions: async () => { historyLoads += 1; return [active, dead]; },
    listNodes: async () => [],
    liveTargetsAcrossNodes: async () => probeFor([active]),
    buildStateContext: async (records: SessionRecord[]) => contextFor(records),
  };

  assert.deepEqual((await loadBeesJsonRows(parse(["bees", "--json"]), deps, { mode: "cheap" })).map((row) => row.name), ["CO.active"]);
  assert.equal(hotLoads, 1);
  assert.equal(historyLoads, 0);

  assert.deepEqual((await loadBeesJsonRows(parse(["bees", "--history", "--json"]), deps, { mode: "cheap" })).map((row) => row.name), ["CO.active", "CO.dead"]);
  assert.equal(hotLoads, 1);
  assert.equal(historyLoads, 1);
});

test("bees TUI refresh uses cheap active snapshots until the bounded full fallback is due", async () => {
  const active = record();
  const initial: BeesTuiItem[] = [{
    name: active.name,
    ref: active.name,
    displayName: active.name,
    colony: "",
    swarmId: "",
    agent: active.agent,
    cwd: active.cwd,
    stateLabel: "ready",
    stateHeadline: "waiting",
    detail: "awaiting prompt",
    age: "5s",
    tmuxTarget: active.tmuxTarget,
    live: true,
    searchText: active.name,
  }];
  let now = 1_000;
  const calls = {
    hot: 0,
    fullActive: 0,
    nodes: 0,
    probes: 0,
    contexts: 0,
    pro: 0,
    pools: 0,
  };

  const refresh = createBeesTuiRefreshItems(parse(["bees"]), {
    initialItems: initial,
    fullRefreshMs: 60_000,
    now: () => now,
    deps: {
      now: () => now,
      listActiveSessionsHot: async () => { calls.hot += 1; return [active]; },
      listActiveSessions: async () => { calls.fullActive += 1; return [active]; },
      listNodes: async () => { calls.nodes += 1; return []; },
      liveTargetsAcrossNodes: async () => { calls.probes += 1; return probeFor([active]); },
      buildStateContext: async (records) => { calls.contexts += 1; return contextFor(records); },
      listProRepoEntries: async () => { calls.pro += 1; return []; },
      poolsForProject: async () => { calls.pools += 1; return []; },
    },
  });

  await refresh();
  now += 3_000;
  await refresh();
  assert.deepEqual(calls, { hot: 2, fullActive: 0, nodes: 0, probes: 0, contexts: 0, pro: 0, pools: 0 });

  now = 61_000;
  await refresh();
  assert.deepEqual(calls, { hot: 2, fullActive: 1, nodes: 1, probes: 1, contexts: 1, pro: 1, pools: 0 });
});
