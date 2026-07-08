// Phase B §6.4 content panes-map re-keying. Two sub-bees sharing one comb
// (same tmuxTarget) must derive state from THEIR OWN pane, keyed by agentPaneId.
// Without re-keying both would read the same tmuxTarget-keyed content and
// collide. Legacy solo bees (no agentPaneId) keep the tmuxTarget fallback.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveState, type StateContext } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

const COMB = "CL-comb";
// A trust prompt forces the "blocked" state; ordinary output does not.
const TRUST_PANE = "Do you trust the contents of this directory? Enter to confirm";
const PLAIN_PANE = "ready ⏎ for input"; // no trust/permission/MCP markers

function subbee(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    name: "sub",
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: COMB,
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

test("two sub-bees in one comb derive state from their own pane, not colliding", () => {
  const parent = subbee({ name: "parent", agentPaneId: "%1", combId: COMB });
  const child = subbee({ name: "child", agentPaneId: "%2", combId: COMB, parentId: "parent" });

  const context: StateContext = {
    liveTargets: new Set([`local ${COMB}`]),
    livePanes: new Set(["%1", "%2"]),
    // Content keyed by agentPaneId — the parent is blocked at a trust prompt,
    // the child is at a clean prompt.
    panes: new Map([
      ["%1", TRUST_PANE],
      ["%2", PLAIN_PANE],
    ]),
    now: Date.parse("2026-06-15T11:00:00.000Z"),
  };

  assert.equal(deriveState(parent, context).state, "blocked", "parent reads %1 (trust prompt)");
  assert.notEqual(deriveState(child, context).state, "blocked", "child reads %2, not the parent's pane");
});

test("sub-bee liveness is its own pane: a dead pane reports dead though the comb lives", () => {
  const child = subbee({ name: "child", agentPaneId: "%2", combId: COMB, parentId: "parent" });
  const context: StateContext = {
    liveTargets: new Set([`local ${COMB}`]), // session still alive (sibling holds it)
    livePanes: new Set(["%1"]), // %2 is gone
    panes: new Map(),
    now: Date.parse("2026-06-15T11:00:00.000Z"),
  };
  assert.equal(deriveState(child, context).state, "crashed");
});

test("legacy solo bee (no agentPaneId) still reads the tmuxTarget-keyed pane", () => {
  const legacy = subbee({ name: "legacy", tmuxTarget: "legacy-session" });
  delete (legacy as Partial<SessionRecord>).agentPaneId;

  const context: StateContext = {
    liveTargets: new Set(["local legacy-session", "legacy-session"]),
    panes: new Map([["legacy-session", TRUST_PANE]]),
    now: Date.parse("2026-06-15T11:00:00.000Z"),
  };
  // The fallback (`agentPaneId ?? tmuxTarget`) keeps today's behavior: it reads
  // the tmuxTarget-keyed content and sees the trust prompt.
  assert.equal(deriveState(legacy, context).state, "blocked");
});
