import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingNeedsInputFromEvents, structuredStateFromEvents, type HsrEventSnapshot } from "../src/hsr/observe.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import { deriveState, liveTargetKey, type StateContext } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import { deriveOpenRequests, paneFingerprint } from "../src/view/requests.js";

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

/**
 * Build the snapshot the way the observer does: pendingNeedsInput is DERIVED
 * from the events (not hand-set), so these tests exercise the real closure
 * semantics — a turn_end after a needs_input resolves it.
 */
function snapshotFromEvents(events: RunnerEvent[]): HsrEventSnapshot {
  return {
    events,
    tailEvents: events,
    activity: null,
    usage: { totals: null },
    pendingNeedsInput: pendingNeedsInputFromEvents(events),
  };
}

/** Derive requests for an HSR bee whose state comes from the same events. */
function requestsForHsrEvents(events: RunnerEvent[]) {
  const rec = record({ substrate: "hsr" });
  const structured = structuredStateFromEvents(events);
  const context: StateContext = {
    liveTargets: new Set(),
    hsrLive: new Set(["bee1"]),
    hsrStates: structured ? new Map([["bee1", structured]]) : new Map(),
    now: NOW,
  };
  const derived = deriveState(rec, context);
  return deriveOpenRequests({ record: rec, context, derived, generation: 0, eventSnapshot: snapshotFromEvents(events), now: NOW });
}

// ---------------------------------------------------------------------------
// 1. Structured needs_input round-trip.
// ---------------------------------------------------------------------------

test("structured needs_input round-trips its full payload, including optionDetails/questions/multiSelect", () => {
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 60_000 },
    {
      type: "needs_input",
      ts: NOW - 30_000,
      kind: "question",
      question: "Which environment?",
      requestId: "req_env_1",
      tool: "AskUser",
      options: ["dev", "prod"],
      optionDetails: [
        { label: "dev", description: "the safe one" },
        { label: "prod", description: "the scary one" },
      ],
      questions: [{ id: "q1", question: "Which environment?", options: [{ label: "dev" }, { label: "prod" }], multiSelect: true }],
      multiSelect: true,
      input: { context: "deploy" },
    },
  ];
  const requests = requestsForHsrEvents(events);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.id, "req_env_1");
  assert.equal(request.kind, "question");
  assert.equal(request.status, "open");
  assert.equal(request.scope, "turn");
  assert.equal(request.grade, "structured");
  assert.equal(request.openedAt, iso(NOW - 30_000));
  assert.equal(request.question, "Which environment?");
  assert.equal(request.tool, "AskUser");
  assert.deepEqual(request.options, ["dev", "prod"]);
  assert.deepEqual(request.optionDetails, [
    { label: "dev", description: "the safe one" },
    { label: "prod", description: "the scary one" },
  ]);
  assert.deepEqual(request.questions, [
    { id: "q1", question: "Which environment?", options: [{ label: "dev" }, { label: "prod" }], multiSelect: true },
  ]);
  assert.equal(request.multiSelect, true);
  assert.deepEqual(request.input, { context: "deploy" });
  assert.equal(request.evidence.grade, "structured");
  assert.equal(request.evidence.source, "hsr-events");
});

test("a needs_input without an adapter requestId gets the stable ni:<bee>:<ts> fallback id", () => {
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "needs_input", ts: NOW - 30_000, kind: "permission", question: "Run it?" },
  ];
  const requests = requestsForHsrEvents(events);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.id, `ni:bee1:${NOW - 30_000}`);
  assert.equal(requests[0]!.kind, "permission");
});

// ---------------------------------------------------------------------------
// 2. Scope closure: a later turn_end resolves the request.
// ---------------------------------------------------------------------------

test("a needs_input followed by a turn_end yields no open request", () => {
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "needs_input", ts: NOW - 30_000, kind: "permission", question: "Run it?", requestId: "req_1" },
    { type: "turn_end", ts: NOW - 10_000 },
  ];
  assert.deepEqual(requestsForHsrEvents(events), []);
});

// ---------------------------------------------------------------------------
// 3. Observer fingerprints for pane-detected prompts.
// ---------------------------------------------------------------------------

const PERMISSION_PANE = [
  "tool output scrolls above",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently",
].join("\n");

function requestsForPane(pane: string, over: Partial<SessionRecord> = {}) {
  const rec = record(over);
  const context: StateContext = {
    liveTargets: new Set([liveTargetKey(rec.node, rec.tmuxTarget)]),
    panes: new Map([[rec.agentPaneId ?? rec.tmuxTarget, pane]]),
    now: NOW,
  };
  const derived = deriveState(rec, context);
  assert.equal(derived.state, "blocked", "fixture pane reads as blocked");
  return deriveOpenRequests({ record: rec, context, derived, generation: rec.runtimeGeneration ?? 0, now: NOW });
}

test("identical pane captures produce identical observer request ids", () => {
  const first = requestsForPane(PERMISSION_PANE);
  const second = requestsForPane(PERMISSION_PANE);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0]!.id, second[0]!.id);
  assert.match(first[0]!.id, /^obs:bee1:0:permission:[0-9a-f]{12}$/);
  assert.equal(first[0]!.kind, "permission");
  assert.equal(first[0]!.grade, "observer");
  assert.equal(first[0]!.evidence.source, "pane-capture");
});

test("a different prompt block produces a different observer id; the generation is part of the key", () => {
  const base = requestsForPane(PERMISSION_PANE)[0]!;
  const other = requestsForPane(PERMISSION_PANE.replace("proceed", "make this edit"))[0]!;
  assert.notEqual(base.id, other.id);
  const laterGen = requestsForPane(PERMISSION_PANE, { runtimeGeneration: 4 })[0]!;
  assert.match(laterGen.id, /^obs:bee1:4:permission:/);
  // Same block, same fingerprint — only the generation segment moved.
  assert.equal(laterGen.id.split(":").pop(), base.id.split(":").pop());
});

test("paneFingerprint is stable across identical blocks and scoped to the pane tail", () => {
  assert.equal(paneFingerprint(PERMISSION_PANE), paneFingerprint(PERMISSION_PANE));
  // Scrollback ABOVE the prompt block does not change the fingerprint.
  const withScrollback = Array.from({ length: 40 }, (_, i) => `old line ${i}`).join("\n") + "\n" + PERMISSION_PANE;
  assert.equal(paneFingerprint(PERMISSION_PANE), paneFingerprint(withScrollback.split("\n").slice(-4).join("\n")));
});

// ---------------------------------------------------------------------------
// 4. Auth requests, bounded by auth_resume.
// ---------------------------------------------------------------------------

const AUTH_ERROR = "Not logged in — run /login to authenticate";

test("a structured login failure opens a structured auth request scoped to the generation", () => {
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "error", ts: NOW - 30_000, message: AUTH_ERROR },
  ];
  const requests = requestsForHsrEvents(events);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.kind, "auth");
  assert.equal(request.id, `auth:bee1:${NOW - 30_000}`);
  assert.equal(request.grade, "structured");
  assert.equal(request.scope, "runtime-generation");
  assert.equal(request.openedAt, iso(NOW - 30_000));
});

test("auth_resume closes the auth request", () => {
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "error", ts: NOW - 30_000, message: AUTH_ERROR },
    { type: "auth_resume", ts: NOW - 10_000 },
  ];
  assert.deepEqual(requestsForHsrEvents(events), []);
});

test("a NEW login failure after auth_resume re-opens the request (creds still bad)", () => {
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "error", ts: NOW - 30_000, message: AUTH_ERROR },
    { type: "auth_resume", ts: NOW - 20_000 },
    { type: "error", ts: NOW - 5_000, message: AUTH_ERROR },
  ];
  const requests = requestsForHsrEvents(events);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.id, `auth:bee1:${NOW - 5_000}`);
});

test("auth_expired with requiresLogin also grounds a structured auth request", () => {
  const events: RunnerEvent[] = [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "auth_expired", ts: NOW - 30_000, requiresLogin: true },
  ];
  const requests = requestsForHsrEvents(events);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.kind, "auth");
  assert.equal(requests[0]!.grade, "structured");
  assert.equal(requests[0]!.evidence.detail, "auth_expired");
});

test("auth-needed without structured evidence degrades to an observer-grade held request", () => {
  const rec = record({ substrate: "hsr" });
  const context: StateContext = {
    liveTargets: new Set(),
    hsrLive: new Set(["bee1"]),
    hsrStates: new Map([["bee1", "auth-needed"]]),
    now: NOW,
  };
  const derived = deriveState(rec, context);
  const requests = deriveOpenRequests({ record: rec, context, derived, generation: 2, now: NOW });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.id, "obs:bee1:2:auth:held");
  assert.equal(requests[0]!.grade, "observer");
});
