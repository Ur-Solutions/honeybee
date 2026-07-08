import assert from "node:assert/strict";
import { test } from "node:test";
import { paneArg } from "../src/substrates/local-tmux.js";
import { deriveState, type StateContext } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

function bee(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CL.x",
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: "CL-x",
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

test("paneArg targets the exact pane when pinned, else the session's active pane", () => {
  assert.equal(paneArg("CL-x", "%7"), "%7");
  assert.equal(paneArg("CL-x", ""), "=CL-x:");
  assert.equal(paneArg("CL-x", undefined), "=CL-x:");
});

test("deriveState: a pinned bee is dead when its pane is gone, even if the session lives", () => {
  const rec = bee({ agentPaneId: "%7" });
  const sessionLive: Pick<StateContext, "liveTargets"> = { liveTargets: new Set(["CL-x"]) };

  // Pane present → alive (some non-dead state).
  assert.notEqual(deriveState(rec, { ...sessionLive, livePanes: new Set(["%7"]) }).state, "dead");

  // Pane gone but session still alive → DEAD. This is the problem (c) fix:
  // killing the agent pane no longer reports the bee falsely alive.
  assert.equal(deriveState(rec, { ...sessionLive, livePanes: new Set(["%9"]) }).state, "crashed");
});

test("deriveState: legacy (unpinned) bees and missing livePanes fall back to session liveness", () => {
  const sessionLive: StateContext = { liveTargets: new Set(["CL-x"]) };

  // No agentPaneId → session liveness regardless of livePanes.
  assert.notEqual(deriveState(bee(), { ...sessionLive, livePanes: new Set() }).state, "dead");

  // Pinned but no livePanes provided → don't guess pane death; use the session.
  assert.notEqual(deriveState(bee({ agentPaneId: "%7" }), sessionLive).state, "dead");
});

test("deriveState: remote pinned bees use session liveness (livePanes is the local server only)", () => {
  const rec = bee({ agentPaneId: "%7", node: "studio" });
  // The remote pane id is not in the local livePanes set; the bee must not be
  // judged dead by it. Session liveness (node-qualified) governs instead.
  const live = deriveState(rec, { liveTargets: new Set(["studio CL-x"]), livePanes: new Set() });
  assert.notEqual(live.state, "dead");
});
