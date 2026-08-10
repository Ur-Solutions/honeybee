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

test("deriveState: a live pane proves the bee live; a missing pane falls back to session liveness", () => {
  const rec = bee({ agentPaneId: "%7" });
  const sessionLive: Pick<StateContext, "liveTargets"> = { liveTargets: new Set(["CL-x"]) };

  // Pane present → alive (some non-dead state), even when the session probe missed it.
  assert.notEqual(deriveState(rec, { ...sessionLive, livePanes: new Set(["%7"]) }).state, "dead");
  const paneOnly = deriveState(rec, { liveTargets: new Set(), livePanes: new Set(["%7"]) });
  assert.notEqual(paneOnly.state, "dead");
  assert.notEqual(paneOnly.state, "crashed");

  // Pane gone but session still alive → NOT crashed. Pane absence alone is not
  // proof of death: mis-stamped ids and partial pane listings from a busy
  // server fail this match for demonstrably live bees (review §1.1/§1.5), so
  // tmux session liveness gets the final word.
  assert.notEqual(deriveState(rec, { ...sessionLive, livePanes: new Set(["%9"]) }).state, "crashed");

  // Pane gone AND session gone → crashed (status "running" = un-commanded death).
  assert.equal(deriveState(rec, { liveTargets: new Set(), livePanes: new Set(["%9"]) }).state, "crashed");
});

test("deriveState: a malformed pane stamp never decides liveness — session rules (review §1.1)", () => {
  // The fused "%pane_pid" mis-stamp can never match a live pane id; before the
  // shape guard it marked live bees permanently crashed.
  const rec = bee({ agentPaneId: "%110_18981" });

  // Session alive → live, regardless of the poisoned stamp.
  const live = deriveState(rec, { liveTargets: new Set(["CL-x"]), livePanes: new Set(["%110"]) });
  assert.notEqual(live.state, "crashed");
  assert.notEqual(live.state, "dead");

  // Session gone → crashed as usual; the stamp adds nothing.
  assert.equal(deriveState(rec, { liveTargets: new Set(), livePanes: new Set(["%110"]) }).state, "crashed");
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
