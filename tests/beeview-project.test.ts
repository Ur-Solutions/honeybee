import assert from "node:assert/strict";
import { test } from "node:test";
import type { HsrEventSnapshot } from "../src/hsr/observe.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import type { SealRecord } from "../src/seal.js";
import { liveTargetKey, type BeeState, type StateContext } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import { projectBeeView, type BeeViewProjectionSources } from "../src/view/project.js";
import type { BeeDisplayState } from "../src/view/types.js";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "bee1",
    agent: "custom-agent",
    cwd: "/tmp/work",
    command: "custom-agent",
    tmuxTarget: "bee1",
    createdAt: iso(NOW - 60_000),
    updatedAt: iso(NOW - 30_000),
    status: "running",
    ...over,
  };
}

function ctx(over: Partial<StateContext> = {}): StateContext {
  return { liveTargets: new Set<string>(), now: NOW, ...over };
}

function liveCtx(rec: SessionRecord, over: Partial<StateContext> = {}): StateContext {
  return ctx({ liveTargets: new Set([liveTargetKey(rec.node, rec.tmuxTarget)]), ...over });
}

function snapshot(events: RunnerEvent[], over: Partial<HsrEventSnapshot> = {}): HsrEventSnapshot {
  return { events, tailEvents: events, activity: null, usage: { totals: null }, pendingNeedsInput: null, ...over };
}

function seal(over: Partial<SealRecord> = {}): SealRecord {
  return {
    beeName: "bee1",
    sealedAt: iso(NOW - 10_000),
    status: "done",
    summary: "did the thing",
    type: "implementation",
    ...over,
  };
}

function project(sources: BeeViewProjectionSources) {
  return projectBeeView({ now: NOW, ...sources });
}

const PERMISSION_PANE = [
  "some earlier output",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently",
].join("\n");

// ---------------------------------------------------------------------------
// Display-state precedence table: one fixture per ADR precedence row.
// ---------------------------------------------------------------------------

type PrecedenceRow = {
  label: string;
  sources: () => BeeViewProjectionSources;
  displayState: BeeDisplayState;
  beeState: BeeState;
};

const rows: PrecedenceRow[] = [
  {
    label: "retired — filed record",
    sources: () => {
      const rec = record({ status: "done" });
      return { record: rec, context: ctx() };
    },
    displayState: "retired",
    beeState: "done",
  },
  {
    label: "needs-auth — hsr structured auth-needed",
    sources: () => {
      const rec = record({ substrate: "hsr" });
      return {
        record: rec,
        context: ctx({ hsrLive: new Set(["bee1"]), hsrStates: new Map([["bee1", "auth-needed" as BeeState]]) }),
      };
    },
    displayState: "needs-auth",
    beeState: "auth-needed",
  },
  {
    label: "needs-reply — pane permission prompt",
    sources: () => {
      const rec = record();
      return { record: rec, context: liveCtx(rec, { panes: new Map([["bee1", PERMISSION_PANE]]) }) };
    },
    displayState: "needs-reply",
    beeState: "blocked",
  },
  {
    label: "needs-action — wedged boot",
    sources: () => {
      const rec = record({ createdAt: iso(NOW - 10 * 60_000) });
      return { record: rec, context: liveCtx(rec, { panes: new Map([["bee1", ""]]) }) };
    },
    displayState: "needs-action",
    beeState: "wedged",
  },
  {
    label: "stop-failed — kill_failed record",
    sources: () => {
      const rec = record({ status: "kill_failed", lastError: "tmux kill failed" });
      return { record: rec, context: liveCtx(rec) };
    },
    displayState: "stop-failed",
    beeState: "kill_failed",
  },
  {
    label: "crashed — exited without stop intent",
    sources: () => ({ record: record(), context: ctx() }),
    displayState: "crashed",
    beeState: "crashed",
  },
  {
    label: "unreachable — node probe failed",
    sources: () => {
      const rec = record({ node: "mini01" });
      return { record: rec, context: ctx({ unreachableNodes: new Set(["mini01"]) }) };
    },
    displayState: "unreachable",
    beeState: "node_unreachable",
  },
  {
    label: "starting — booting tmux bee",
    sources: () => {
      const rec = record();
      return { record: rec, context: liveCtx(rec, { panes: new Map([["bee1", ""]]) }) };
    },
    displayState: "starting",
    beeState: "booting",
  },
  {
    label: "starting — queued hsr bee",
    sources: () => {
      const rec = record({ substrate: "hsr" });
      return {
        record: rec,
        context: ctx({ hsrLive: new Set(["bee1"]), hsrStates: new Map([["bee1", "queued" as BeeState]]) }),
      };
    },
    displayState: "starting",
    beeState: "queued",
  },
  {
    label: "working — recently prompted",
    sources: () => {
      const rec = record({ lastPromptAt: iso(NOW - 5_000), lastPrompt: "do the thing" });
      return { record: rec, context: liveCtx(rec) };
    },
    displayState: "working",
    beeState: "active",
  },
  {
    label: "ready — live at the composer",
    sources: () => {
      const rec = record();
      return { record: rec, context: liveCtx(rec) };
    },
    displayState: "ready",
    beeState: "ready",
  },
  {
    label: "offline — deliberately stopped record",
    sources: () => ({ record: record({ status: "dead" }), context: ctx() }),
    displayState: "offline",
    beeState: "dead",
  },
];

for (const row of rows) {
  test(`displayState precedence: ${row.label}`, () => {
    const view = project(row.sources());
    assert.equal(view.displayState, row.displayState);
    assert.equal(
      view.interactionState,
      row.displayState === "retired"
        ? "archived"
        : row.displayState === "working"
          ? "working"
          : "idle",
    );
    assert.equal(view.compatibilityFields.beeState, row.beeState);
    // The reason names the precedence rule that fired.
    assert.ok(view.displayStateReason.startsWith(row.displayState), `reason "${view.displayStateReason}" names ${row.displayState}`);
    assert.equal(view.schemaVersion, 1);
    assert.equal(view.currentTurn, undefined);
    // Every projected fact carries evidence.
    assert.ok(view.latestRuntime.evidence.grade, "runtime evidence present");
    for (const request of view.openRequests) assert.ok(request.evidence.grade, "request evidence present");
    if (view.latestTurnResult) assert.ok(view.latestTurnResult.evidence.grade);
    if (view.latestContractResult) assert.ok(view.latestContractResult.evidence.grade);
  });
}

test("a live kill_failed bee stays idle when no turn is running", () => {
  const rec = record({ status: "kill_failed", lastError: "tmux kill failed" });
  const view = project({ record: rec, context: liveCtx(rec) });
  assert.equal(view.displayState, "stop-failed");
  assert.equal(view.interactionState, "idle");
});

test("a live kill_failed bee stays working while its turn is running", () => {
  const rec = record({
    status: "kill_failed",
    lastError: "tmux kill failed",
    lastPrompt: "keep going",
    lastPromptAt: iso(NOW - 5_000),
  });
  const view = project({ record: rec, context: liveCtx(rec) });
  assert.equal(view.displayState, "stop-failed");
  assert.equal(view.interactionState, "working");
});

test("an exited kill_failed bee maps to archived by liveness", () => {
  const rec = record({ status: "kill_failed", lastError: "tmux kill failed" });
  const view = project({ record: rec, context: ctx() });
  assert.equal(view.displayState, "stop-failed");
  assert.equal(view.interactionState, "archived");
});

// ---------------------------------------------------------------------------
// Deliberate divergences from deriveState.
// ---------------------------------------------------------------------------

test("sealed-but-live projects as ready with latestContractResult (completion never changes display state)", () => {
  const rec = record();
  const view = project({
    record: rec,
    context: liveCtx(rec, { seals: new Set(["bee1"]) }),
    latestSeal: seal(),
    latestSealFilename: "2026-07-28T11-59-50-000Z-0000-abc123.json",
  });
  assert.equal(view.compatibilityFields.beeState, "done"); // deriveState says done ("seal recorded")
  assert.equal(view.displayState, "ready");
  assert.match(view.displayStateReason, /completion never changes display state/);
  assert.equal(view.latestRuntime.state, "online");
  assert.equal(view.bee.lifecycle, "active"); // sealed-but-un-filed is NOT retired
  const contract = view.latestContractResult!;
  assert.equal(contract.verdict, "success");
  assert.equal(contract.sealStatus, "done");
  assert.equal(contract.matchesContract, undefined); // no contract to correlate against
  assert.equal(contract.evidence.grade, "structured");
  assert.equal(contract.evidence.source, "seal");
  assert.equal(contract.evidence.detail, "2026-07-28T11-59-50-000Z-0000-abc123.json");
  assert.equal(view.inboxSummary.hasUnretiredResult, true);
  assert.equal(view.inboxSummary.latestResultAt, seal().sealedAt);
});

test("seal-to-contract correlation: demanded keys must be carried verbatim", () => {
  const rec = record({ contract: { completion: "seal", taskId: "FL.1/s1", attempt: 2 } });
  const context = liveCtx(rec, { seals: new Set(["bee1"]) });
  const keyless = project({ record: rec, context, latestSeal: seal() });
  assert.equal(keyless.latestContractResult!.matchesContract, false); // keyless seal: reviewable artifact, not completion
  const matching = project({ record: rec, context, latestSeal: seal({ taskId: "FL.1/s1", attempt: 2 }) });
  assert.equal(matching.latestContractResult!.matchesContract, true);
  const mismatched = project({ record: rec, context, latestSeal: seal({ taskId: "FL.1/s9", attempt: 2 }) });
  assert.equal(mismatched.latestContractResult!.matchesContract, false);
});

test("needs_input seal verdict projects as blocked", () => {
  const rec = record();
  const view = project({
    record: rec,
    context: liveCtx(rec, { seals: new Set(["bee1"]) }),
    latestSeal: seal({ status: "needs_input" }),
  });
  assert.equal(view.latestContractResult!.verdict, "blocked");
});

test("idle_with_output projects as ready with an observer settled-unverified turn result", () => {
  const rec = record({ lastPromptAt: iso(NOW - 600_000) });
  const view = project({
    record: rec,
    context: liveCtx(rec, { panes: new Map([["bee1", "plenty of assistant output text here"]]) }),
  });
  assert.equal(view.compatibilityFields.beeState, "idle_with_output");
  assert.equal(view.displayState, "ready");
  const result = view.latestTurnResult!;
  assert.equal(result.outcome, "settled-unverified");
  assert.equal(result.evidence.grade, "observer");
  assert.equal(result.evidence.source, "pane-capture");
});

test("idle_with_output with a hook-stamped @hive_state=done projects responded (hook grade)", () => {
  const rec = record({ lastPromptAt: iso(NOW - 600_000) });
  const view = project({
    record: rec,
    context: liveCtx(rec, { panes: new Map([["bee1", "plenty of assistant output text here"]]) }),
    hiveStateOption: "done",
  });
  assert.equal(view.displayState, "ready");
  assert.equal(view.latestTurnResult!.outcome, "responded");
  assert.equal(view.latestTurnResult!.evidence.grade, "hook");
  assert.equal(view.latestTurnResult!.evidence.source, "hive-state-option");
});

test("structured turn_end projects responded (structured grade) with endedAt", () => {
  const rec = record({ substrate: "hsr" });
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 90_000 },
    { type: "text", ts: NOW - 80_000, text: "working on it" },
    { type: "turn_end", ts: NOW - 70_000 },
  ];
  const view = project({
    record: rec,
    context: ctx({ hsrLive: new Set(["bee1"]), hsrStates: new Map([["bee1", "idle_with_output" as BeeState]]) }),
    eventSnapshot: snapshot(events),
  });
  assert.equal(view.displayState, "ready");
  const result = view.latestTurnResult!;
  assert.equal(result.outcome, "responded");
  assert.equal(result.endedAt, iso(NOW - 70_000));
  assert.equal(result.evidence.grade, "structured");
  assert.equal(result.evidence.source, "hsr-events");
});

// ---------------------------------------------------------------------------
// Crash / interruption honesty.
// ---------------------------------------------------------------------------

test("crashed mid-turn (structured open turn) projects interrupted", () => {
  const rec = record({ substrate: "hsr" });
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 90_000 },
    { type: "text", ts: NOW - 80_000, text: "half way" },
  ];
  const view = project({
    record: rec,
    context: ctx({ hsrLive: new Set<string>() }),
    eventSnapshot: snapshot(events),
  });
  assert.equal(view.displayState, "crashed");
  assert.equal(view.latestRuntime.state, "exited");
  assert.equal(view.latestRuntime.exitClass, "crashed");
  assert.equal(view.latestTurnResult!.outcome, "interrupted");
});

test("crashed while last observed active (legacy cache) projects interrupted, legacy grade", () => {
  const rec = record({ lastObservedState: "active", lastObservedStateAt: iso(NOW - 120_000) });
  const view = project({ record: rec, context: ctx() });
  assert.equal(view.displayState, "crashed");
  assert.equal(view.latestTurnResult!.outcome, "interrupted");
  assert.equal(view.latestTurnResult!.evidence.grade, "legacy");
  assert.equal(view.latestTurnResult!.evidence.source, "session-record");
});

test("crashed without mid-turn evidence has no fabricated turn result", () => {
  const view = project({ record: record({ lastObservedState: "idle_with_output" }), context: ctx() });
  assert.equal(view.displayState, "crashed");
  assert.equal(view.latestTurnResult, undefined);
});

// ---------------------------------------------------------------------------
// Requests: synthesized manual-action, structured needs_input, auth.
// ---------------------------------------------------------------------------

test("wedged synthesizes an observer manual-action request with the documented id", () => {
  const rec = record({ createdAt: iso(NOW - 10 * 60_000), runtimeGeneration: 3 });
  const view = project({ record: rec, context: liveCtx(rec, { panes: new Map([["bee1", ""]]) }) });
  assert.equal(view.displayState, "needs-action");
  assert.equal(view.openRequests.length, 1);
  const request = view.openRequests[0]!;
  assert.equal(request.id, "manual:bee1:3:wedged");
  assert.equal(request.kind, "manual-action");
  assert.equal(request.grade, "observer");
  assert.equal(request.scope, "runtime-generation");
  assert.deepEqual(view.inboxSummary.openRequestCounts, { needsReply: 0, needsAuth: 0, needsAction: 1 });
});

test("structured needs_input passes its payload through and drives needs-reply", () => {
  const rec = record({ substrate: "hsr" });
  const pending = {
    requestId: "req_abc",
    ts: NOW - 15_000,
    kind: "permission" as const,
    question: "Run `rm -rf`?",
    tool: "Bash",
    options: ["yes", "no"],
    optionDetails: [{ label: "yes" }, { label: "no" }],
    questions: [{ question: "Run `rm -rf`?" }],
    multiSelect: false,
    input: { command: "rm -rf" },
  };
  const view = project({
    record: rec,
    context: ctx({ hsrLive: new Set(["bee1"]), hsrStates: new Map([["bee1", "blocked" as BeeState]]) }),
    eventSnapshot: snapshot([], { pendingNeedsInput: pending }),
  });
  assert.equal(view.displayState, "needs-reply");
  const request = view.openRequests[0]!;
  assert.equal(request.id, "req_abc");
  assert.equal(request.kind, "permission");
  assert.equal(request.grade, "structured");
  assert.equal(request.openedAt, iso(NOW - 15_000));
  assert.equal(request.question, "Run `rm -rf`?");
  assert.equal(request.tool, "Bash");
  assert.deepEqual(request.options, ["yes", "no"]);
  assert.deepEqual(request.optionDetails, [{ label: "yes" }, { label: "no" }]);
  assert.deepEqual(request.questions, [{ question: "Run `rm -rf`?" }]);
  assert.equal(request.multiSelect, false);
  assert.deepEqual(request.input, { command: "rm -rf" });
  assert.deepEqual(view.inboxSummary.openRequestCounts, { needsReply: 1, needsAuth: 0, needsAction: 0 });
});

test("auth-needed with a structured login failure yields a structured auth request", () => {
  const rec = record({ substrate: "hsr" });
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "error", ts: NOW - 50_000, message: "Not logged in — run /login" },
  ];
  const view = project({
    record: rec,
    context: ctx({ hsrLive: new Set(["bee1"]), hsrStates: new Map([["bee1", "auth-needed" as BeeState]]) }),
    eventSnapshot: snapshot(events),
  });
  assert.equal(view.displayState, "needs-auth");
  const request = view.openRequests[0]!;
  assert.equal(request.id, `auth:bee1:${NOW - 50_000}`);
  assert.equal(request.grade, "structured");
  assert.equal(request.scope, "runtime-generation");
});

test("auth-needed from held state yields an observer-grade auth request", () => {
  const rec = record({ substrate: "hsr" });
  const view = project({
    record: rec,
    context: ctx({ hsrLive: new Set(["bee1"]), hsrStates: new Map([["bee1", "auth-needed" as BeeState]]) }),
  });
  assert.equal(view.displayState, "needs-auth");
  const request = view.openRequests[0]!;
  assert.equal(request.id, "obs:bee1:0:auth:held");
  assert.equal(request.grade, "observer");
});

test("a retired bee derives no open requests", () => {
  const view = project({ record: record({ status: "done" }), context: ctx() });
  assert.deepEqual(view.openRequests, []);
});

// ---------------------------------------------------------------------------
// Legacy persisted-state strings.
// ---------------------------------------------------------------------------

test('legacy lastObservedState "sealed" held through an HSR outage projects ready, never crashes the projection', () => {
  const rec = record({ substrate: "hsr", lastObservedState: "sealed" });
  const view = project({ record: rec, context: ctx({ hsrUnavailable: new Set(["bee1"]) }) });
  assert.equal(view.compatibilityFields.beeState, "done"); // sealed → done via parseBeeState
  assert.equal(view.compatibilityFields.lastObservedState, "sealed"); // compat field stays unnormalized
  assert.equal(view.displayState, "ready");
  assert.equal(view.latestRuntime.state, "unknown");
  assert.equal(view.observationFreshness.observedLive, false);
  const hsrSource = view.observationFreshness.sources.find((s) => s.source === "hsr-events")!;
  assert.equal(hsrSource.status, "missing");
  assert.match(hsrSource.caveat ?? "", /state held/);
});

test('legacy lastObservedState "archived" is normalized to done, not treated as an open turn', () => {
  const view = project({ record: record({ lastObservedState: "archived" }), context: ctx() });
  assert.equal(view.displayState, "crashed"); // exited without stop intent
  assert.equal(view.latestTurnResult, undefined); // "archived" is done, never mid-turn
});

// ---------------------------------------------------------------------------
// Freshness and compatibility surfaces.
// ---------------------------------------------------------------------------

test("freshness reports the daemon cache with its sweep-stamp caveat", () => {
  const rec = record({ lastObservedState: "active", lastObservedStateAt: iso(NOW - 3 * 86_400_000), lastPromptAt: iso(NOW - 5_000) });
  const view = project({ record: rec, context: liveCtx(rec) });
  const daemon = view.observationFreshness.sources.find((s) => s.source === "daemon-observation")!;
  assert.equal(daemon.status, "stale");
  assert.equal(daemon.ageMs, 3 * 86_400_000);
  assert.match(daemon.caveat ?? "", /fleet-wide sweep stamp/);
  const probe = view.observationFreshness.sources.find((s) => s.source === "node-probe")!;
  assert.equal(probe.status, "fresh");
  assert.equal(view.observationFreshness.observedLive, true);
});

test("@hive_state is surfaced untimed and verbatim in compatibilityFields", () => {
  const rec = record({ lastPromptAt: iso(NOW - 5_000) });
  const view = project({ record: rec, context: liveCtx(rec), hiveStateOption: "working" });
  assert.equal(view.compatibilityFields.hiveStateOption, "working");
  assert.equal(view.compatibilityFields.effectiveHiveState, "working");
  const hiveSource = view.observationFreshness.sources.find((s) => s.source === "hive-state-option")!;
  assert.equal(hiveSource.status, "untimed");
  assert.match(hiveSource.caveat ?? "", /no timestamp/);
});

test("unreachable node marks the probe missing and observedLive false", () => {
  const rec = record({ node: "mini01" });
  const view = project({ record: rec, context: ctx({ unreachableNodes: new Set(["mini01"]) }) });
  assert.equal(view.observationFreshness.observedLive, false);
  const probe = view.observationFreshness.sources.find((s) => s.source === "node-probe")!;
  assert.equal(probe.status, "missing");
  assert.match(probe.caveat ?? "", /not a heartbeat contract/);
});
