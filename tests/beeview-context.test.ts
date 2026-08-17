import assert from "node:assert/strict";
import { test } from "node:test";
import { tick, type TickDeps } from "../src/daemon/run.js";
import type { HsrObservation } from "../src/hsr/observe.js";
import type { NodeRecord } from "../src/node.js";
import { deriveState, liveTargetKey, type BeeState } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import { assembleStateContext, type StateContextAssemblyDeps } from "../src/view/context.js";
import { lifecycleCursor } from "./lifecycle-fixtures.js";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

function bee(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "alpha",
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget: "alpha",
    createdAt: "2026-07-28T11:00:00.000Z",
    updatedAt: "2026-07-28T11:30:00.000Z",
    status: "running",
    ...overrides,
  };
}

const REMOTE_NODE: NodeRecord = {
  name: "mini01",
  kind: "remote-hsr",
  endpoint: "user@mini01",
  capabilities: ["*"],
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
};

type Fixture = {
  records: SessionRecord[];
  nodes?: NodeRecord[];
  liveTargets?: Set<string>;
  unreachableNodes?: Set<string>;
  panes?: Map<string, string>;
  seals?: Set<string>;
  hsrObservations?: (options?: unknown) => Promise<Map<string, HsrObservation>>;
  /** Daemon in-memory previous observations (also layered into the assembler). */
  previousStates?: Map<string, BeeState>;
};

function daemonDeps(fixture: Fixture): TickDeps {
  return {
    listSessions: async () => fixture.records,
    listNodes: async () => fixture.nodes ?? [],
    probeNodes: async () => ({
      liveTargets: fixture.liveTargets ?? new Set<string>(),
      unreachableNodes: fixture.unreachableNodes ?? new Set<string>(),
    }),
    capturePanes: async () => fixture.panes ?? new Map<string, string>(),
    livePanes: async () => new Set<string>(),
    sealedBeeNames: async () => fixture.seals ?? new Set<string>(),
    ...(fixture.hsrObservations ? { hsrObservations: (bees: readonly string[]) => fixture.hsrObservations!(bees) } : {}),
    touchSession: async () => null,
    appendLedger: async () => undefined,
    now: () => NOW,
  };
}

function assemblerDeps(fixture: Fixture): StateContextAssemblyDeps {
  return {
    capturePanes: async () => fixture.panes ?? new Map<string, string>(),
    listPanes: async () => new Set<string>(),
    sealedBeeNames: async () => fixture.seals ?? new Set<string>(),
    ...(fixture.hsrObservations ? { hsrObservations: fixture.hsrObservations } : {}),
    listNodes: async () => fixture.nodes ?? [],
    now: () => NOW,
  };
}

/** Derive each record's state through BOTH assembly paths and assert parity. */
async function assertParity(fixture: Fixture): Promise<void> {
  // A failed observation batch is a recorded (non-fatal) tick error; parity
  // is judged on the observed states, not the error channel.
  const result = await tick(daemonDeps(fixture), fixture.previousStates ?? new Map());
  const context = await assembleStateContext(
    fixture.records,
    { liveTargets: fixture.liveTargets ?? new Set(), unreachableNodes: fixture.unreachableNodes ?? new Set() },
    { previousStates: fixture.previousStates, deps: assemblerDeps(fixture) },
  );
  for (const record of fixture.records) {
    const derived = deriveState(record, context);
    assert.equal(
      derived.state,
      result.observed.get(record.name),
      `${record.name}: assembler derives "${derived.state}" but the daemon observed "${result.observed.get(record.name)}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI/daemon asymmetry regression: identical derivation through both paths.
// ---------------------------------------------------------------------------

test("mirror fixture: a remote-hsr bee with a local mirror derives from run-dir state in both paths", async () => {
  const record = bee({ name: "bravo", tmuxTarget: "bravo", node: "mini01" });
  const fixture: Fixture = {
    records: [record],
    nodes: [REMOTE_NODE],
    hsrObservations: async () =>
      new Map<string, HsrObservation>([
        ["bravo", { live: true, state: "active", snapshot: "mirrored output", mirrorOf: "mini01" }],
      ]),
  };
  await assertParity(fixture);

  // And the assembler threads the mirror facts the CLI used to drop.
  const context = await assembleStateContext(
    fixture.records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    { deps: assemblerDeps(fixture) },
  );
  assert.ok(context.hsrMirrors?.has("bravo"), "mirrorOf threads into hsrMirrors");
  assert.ok(context.hsrLive.has("bravo"));
  assert.equal(context.hsrStates?.get("bravo"), "active");
  assert.equal(deriveState(record, context).state, "active");
});

test("unavailable fixture: a failed HSR batch holds the previous state in both paths", async () => {
  const record = bee({ substrate: "hsr", lastObservedState: "active", lastPromptAt: "2026-07-28T11:40:00.000Z" });
  const fixture: Fixture = {
    records: [record],
    hsrObservations: async () => {
      throw new Error("observer child crashed");
    },
    previousStates: new Map([["alpha", "active" as BeeState]]),
  };
  await assertParity(fixture);

  const context = await assembleStateContext(
    fixture.records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    { deps: assemblerDeps(fixture) },
  );
  assert.ok(context.hsrUnavailable.has("alpha"), "failed batch marks hsrUnavailable");
  const derived = deriveState(record, context);
  assert.equal(derived.state, "active");
  assert.match(derived.detail, /observation unavailable/i);
});

test("held-pane fixture: a missed capture holds the last observed state in both paths", async () => {
  const record = bee({ lastObservedState: "active", lastPromptAt: "2026-07-28T11:00:00.000Z" });
  const fixture: Fixture = {
    records: [record],
    liveTargets: new Set([liveTargetKey(undefined, "alpha")]),
    panes: new Map<string, string>(), // capture unavailable this pass
    previousStates: new Map([["alpha", "active" as BeeState]]),
  };
  await assertParity(fixture);
});

test("dead and sealed fixtures derive identically through both paths", async () => {
  const dead = bee({ name: "dcecil", tmuxTarget: "dcecil", status: "dead" });
  const crashed = bee({ name: "crash", tmuxTarget: "crash" });
  const sealed = bee({ name: "sealed", tmuxTarget: "sealed" });
  await assertParity({
    records: [dead, crashed, sealed],
    liveTargets: new Set([liveTargetKey(undefined, "sealed")]),
    panes: new Map([["sealed", "output"]]),
    seals: new Set(["sealed"]),
  });
});

// ---------------------------------------------------------------------------
// Failure honesty: unknown is never an authoritative empty result.
// ---------------------------------------------------------------------------

test("a failed HSR observation batch marks hsrUnavailable rather than deriving from an empty map", async () => {
  const record = bee({ substrate: "hsr", lastObservedState: "blocked" });
  const failing: Fixture = {
    records: [record],
    hsrObservations: async () => {
      throw new Error("batch failed");
    },
  };
  const heldContext = await assembleStateContext(
    failing.records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    { deps: assemblerDeps(failing) },
  );
  assert.ok(heldContext.hsrUnavailable.has("alpha"));
  assert.equal(deriveState(record, heldContext).state, "blocked", "state held, not fabricated dead");

  // A SUCCESSFUL empty result is authoritative: the run dir is gone.
  const emptyOk: Fixture = { records: [record], hsrObservations: async () => new Map() };
  const emptyContext = await assembleStateContext(
    emptyOk.records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    { deps: assemblerDeps(emptyOk) },
  );
  assert.equal(emptyContext.hsrUnavailable.size, 0);
  assert.equal(deriveState(record, emptyContext).state, "crashed", "genuinely gone run dir derives crashed");
});

test("HSR observation candidates obey canonical lifecycle over stale status scalars", async () => {
  const canonicalActive = bee({
    name: "canonical-active-stale-done",
    tmuxTarget: "canonical-active-stale-done",
    substrate: "hsr",
    status: "done",
    stateMachine: lifecycleCursor("canonical-active-stale-done", "active", "2026-07-28T11:30:00.000Z"),
  });
  const canonicalArchived = bee({
    name: "canonical-archived-stale-running",
    tmuxTarget: "canonical-archived-stale-running",
    substrate: "hsr",
    status: "running",
    stateMachine: lifecycleCursor("canonical-archived-stale-running", "archived", "2026-07-28T11:30:00.000Z"),
  });
  let requested: string[] = [];
  const records = [canonicalActive, canonicalArchived];
  const context = await assembleStateContext(
    records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    {
      deps: {
        ...assemblerDeps({ records }),
        hsrObservations: async ({ bees }) => {
          requested = [...(bees ?? [])];
          return new Map(requested.map((name) => [
            name,
            { live: true, state: "active" as const, snapshot: `${name} output` },
          ]));
        },
      },
    },
  );

  assert.deepEqual(requested, [canonicalActive.name]);
  assert.equal(context.hsrLive.has(canonicalActive.name), true);
  assert.equal(context.hsrLive.has(canonicalArchived.name), false);
});

test("BeeView context quarantines fenced local and remote HSR histories without reopening their event logs", async () => {
  const at = "2026-07-28T11:30:00.000Z";
  const healthy = bee({
    name: "healthy-hsr",
    tmuxTarget: "healthy-hsr",
    substrate: "hsr",
  });
  const fencedLocal = bee({
    name: "fenced-local",
    tmuxTarget: "fenced-local",
    substrate: "hsr",
    status: "kill_failed",
    eventIntegrityDoubt: {
      version: 1,
      integrityId: "local-integrity",
      source: { hostPid: 4242, startedAt: at },
      createdAt: at,
      fenceError: "local event history incomplete",
    },
  });
  const fencedRemote = bee({
    name: "fenced-remote",
    tmuxTarget: "fenced-remote",
    node: REMOTE_NODE.name,
    status: "kill_failed",
    remoteLaunchId: "launch-1",
    remoteIncarnation: "incarnation-1",
    eventIntegrityDoubt: {
      version: 1,
      integrityId: "remote-integrity",
      source: {
        hostPid: 4343,
        startedAt: at,
        remoteLaunchId: "launch-1",
        remoteIncarnation: "incarnation-1",
      },
      createdAt: at,
      fenceError: "remote event history incomplete",
    },
  });
  const records = [healthy, fencedLocal, fencedRemote];
  let requested: string[] = [];
  const context = await assembleStateContext(
    records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    {
      includeEvents: true,
      deps: {
        ...assemblerDeps({ records, nodes: [REMOTE_NODE] }),
        hsrObservations: async ({ bees }) => {
          requested = [...(bees ?? [])];
          // An over-broad/mixed-version observer response must not smuggle a
          // quarantined event snapshot back into BeeView.
          return new Map(records.map((record) => [
            record.name,
            { live: true, state: "active" as const, snapshot: `${record.name} output` },
          ]));
        },
      },
    },
  );

  assert.deepEqual(requested, [healthy.name]);
  assert.equal(context.hsrUnavailable.has(fencedLocal.name), true);
  assert.equal(context.hsrUnavailable.has(fencedRemote.name), true);
  assert.equal(context.hsrObservations.has(fencedLocal.name), false);
  assert.equal(context.hsrObservations.has(fencedRemote.name), false);
  assert.equal(context.hsrLive.has(fencedLocal.name), false);
  assert.equal(context.hsrLive.has(fencedRemote.name), false);
  assert.equal(context.hsrObservations.has(healthy.name), true);
});

test("BeeView context treats a per-Bee unavailable observation row as held evidence", async () => {
  const record = bee({ substrate: "hsr" });
  const context = await assembleStateContext(
    [record],
    { liveTargets: new Set(), unreachableNodes: new Set() },
    {
      deps: {
        ...assemblerDeps({ records: [record] }),
        hsrObservations: async () => new Map([[
          record.name,
          {
            live: false,
            snapshot: "",
            unavailable: { kind: "storage", detail: "run dir temporarily unreadable" },
          },
        ]]),
      },
    },
  );

  assert.equal(context.hsrUnavailable.has(record.name), true);
  assert.equal(context.hsrObservations.has(record.name), false);
  assert.equal(context.hsrLive.has(record.name), false);
});

// ---------------------------------------------------------------------------
// previousStates seeding and layering.
// ---------------------------------------------------------------------------

test("previousStates seed from parseBeeState(lastObservedState), legacy strings normalized", async () => {
  const records = [
    bee({ name: "a1", tmuxTarget: "a1", lastObservedState: "active" }),
    bee({ name: "a2", tmuxTarget: "a2", lastObservedState: "sealed" }),
    bee({ name: "a3", tmuxTarget: "a3", lastObservedState: "definitely-not-a-state" }),
  ];
  const context = await assembleStateContext(
    records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    { deps: assemblerDeps({ records }) },
  );
  assert.equal(context.previousStates?.get("a1"), "active");
  assert.equal(context.previousStates?.get("a2"), "done"); // legacy "sealed" normalizes
  assert.equal(context.previousStates?.get("a3"), undefined); // garbage is dropped, never trusted
});

test("caller-supplied in-memory previousStates layer over the persisted cache", async () => {
  const records = [bee({ lastObservedState: "active" })];
  const context = await assembleStateContext(
    records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    { previousStates: new Map([["alpha", "blocked" as BeeState]]), deps: assemblerDeps({ records }) },
  );
  assert.equal(context.previousStates?.get("alpha"), "blocked");
});

// ---------------------------------------------------------------------------
// Mirror trust rule parity.
// ---------------------------------------------------------------------------

test("a local-hsr record never trusts a mirror observation row", async () => {
  const record = bee({ substrate: "hsr" });
  const fixture: Fixture = {
    records: [record],
    hsrObservations: async () =>
      new Map<string, HsrObservation>([["alpha", { live: true, state: "active", snapshot: "", mirrorOf: "mini01" }]]),
  };
  const context = await assembleStateContext(
    fixture.records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    { deps: assemblerDeps(fixture) },
  );
  assert.equal(context.hsrLive.has("alpha"), false);
  assert.equal(context.hsrStates?.get("alpha"), undefined);
  assert.equal(context.hsrMirrors?.has("alpha"), false);
});

test("unreachable-node override widens the probe's set", async () => {
  const records = [bee({ node: "mini01", name: "rem", tmuxTarget: "rem" })];
  const context = await assembleStateContext(
    records,
    { liveTargets: new Set(), unreachableNodes: new Set() },
    { unreachableNodes: new Set(["mini01"]), deps: assemblerDeps({ records }) },
  );
  assert.equal(deriveState(records[0]!, context).state, "node_unreachable");
});
