import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi } from "../src/format.js";
import { type BeeState, cleanStatePriority, deriveState, formatStateCell, isDoneState, isTerminalState, liveTargetKey, STATE_PRESENTATION, stateLabel } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import { lifecycleCursor } from "./lifecycle-fixtures.js";

function bee(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "alpha",
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget: "alpha-target",
    createdAt: "2026-05-28T11:00:00.000Z",
    updatedAt: "2026-05-28T11:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

const NOW = Date.parse("2026-05-28T12:00:00.000Z");

test("crashed: tmux target is not live and the record was never retired", () => {
  const result = deriveState(bee(), { liveTargets: new Set(), now: NOW });
  assert.equal(result.state, "crashed");
});

test("a durable recovery request projects queued instead of flashing crashed", () => {
  const result = deriveState(bee({
    recoveryRequestedAt: "2026-05-28T11:59:00.000Z",
    recoveryMessageId: "019fe9d1-2dd4-76dc-ba45-a26b675617c9",
  }), { liveTargets: new Set(), now: NOW });
  assert.equal(result.state, "queued");
  assert.match(result.detail, /recovery requested/);
});

test("dead: tmux target is not live and the record is explicitly marked dead", () => {
  const result = deriveState(bee({ status: "dead" }), { liveTargets: new Set(), now: NOW });
  assert.equal(result.state, "dead");
});

test("done (sealed after exit): tmux gone but seal exists", () => {
  const result = deriveState(bee(), { liveTargets: new Set(), seals: new Set(["alpha"]), now: NOW });
  assert.equal(result.state, "done");
  assert.match(result.detail, /sealed/);
});

test("done (sealed while alive): tmux live and seal exists", () => {
  const result = deriveState(bee(), { liveTargets: new Set(["alpha-target"]), seals: new Set(["alpha"]), now: NOW });
  assert.equal(result.state, "done");
  assert.match(result.detail, /seal/);
});

test("kill_failed: record explicitly marked", () => {
  const result = deriveState(bee({ status: "kill_failed", lastError: "tmux refused" }), {
    liveTargets: new Set(["alpha-target"]),
    now: NOW,
  });
  assert.equal(result.state, "kill_failed");
  assert.match(result.detail, /tmux refused/);
});

test("deriveState preserves stop doubt while canonical archive still wins", () => {
  const at = "2026-05-28T11:30:00.000Z";
  const active = bee({
    status: "kill_failed",
    stateMachine: lifecycleCursor("state-active-stale-kill-failed", "active", at),
  });
  assert.equal(deriveState(active, { liveTargets: new Set(), now: NOW }).state, "kill_failed");

  const archived = bee({
    status: "kill_failed",
    stateMachine: lifecycleCursor("state-archived-stale-kill-failed", "archived", at),
  });
  assert.equal(deriveState(archived, { liveTargets: new Set([archived.tmuxTarget]), now: NOW }).state, "done");
});

test("blocked: trust prompt in pane", () => {
  const panes = new Map([["alpha-target", "Do you trust the contents of this directory? (y/n)"]]);
  const result = deriveState(bee(), { liveTargets: new Set(["alpha-target"]), panes, now: NOW });
  assert.equal(result.state, "blocked");
});

test("blocked: MCP warning", () => {
  const panes = new Map([["alpha-target", "MCP server found at unsupported path"]]);
  const result = deriveState(bee(), { liveTargets: new Set(["alpha-target"]), panes, now: NOW });
  assert.equal(result.state, "blocked");
});

test("blocked: awaiting a permission prompt", () => {
  const panes = new Map([["alpha-target", "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently"]]);
  const result = deriveState(bee(), { liveTargets: new Set(["alpha-target"]), panes, now: NOW });
  assert.equal(result.state, "blocked");
  assert.equal(result.detail, "awaiting permission");
});

test("blocked: a permission prompt outranks a recent prompt (not 'active')", () => {
  const recent = new Date(NOW - 5_000).toISOString();
  const panes = new Map([["alpha-target", "Do you want to make this edit to ids.ts?\n❯ 1. Yes"]]);
  const result = deriveState(bee({ lastPromptAt: recent, lastPrompt: "edit ids.ts" }), {
    liveTargets: new Set(["alpha-target"]),
    panes,
    now: NOW,
  });
  assert.equal(result.state, "blocked");
});

test("active: lastPromptAt is recent", () => {
  const recent = new Date(NOW - 5_000).toISOString();
  const result = deriveState(bee({ lastPromptAt: recent, lastPrompt: "Refactor auth flow" }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", "x".repeat(300)]]),
    now: NOW,
  });
  assert.equal(result.state, "active");
  assert.match(result.detail, /Refactor auth/);
});

test("active: old prompted known-agent pane without a ready prompt does not age into idle", () => {
  const oldPrompt = new Date(NOW - 10 * 60_000).toISOString();
  const result = deriveState(bee({ lastPromptAt: oldPrompt, lastPrompt: "go" }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", "some in-progress output"]]),
    now: NOW,
  });
  assert.equal(result.state, "active");
});

test("active: Codex working marker is recognized after the active window", () => {
  const oldPrompt = new Date(NOW - 10 * 60_000).toISOString();
  const result = deriveState(bee({ lastPromptAt: oldPrompt, lastPrompt: "go" }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", "• Working (57s • esc to interrupt)\n\n› go"]]),
    now: NOW,
  });
  assert.equal(result.state, "active");
});

test("active: unknown pane capture holds the previous active state", () => {
  const oldPrompt = new Date(NOW - 10 * 60_000).toISOString();
  const result = deriveState(bee({ lastPromptAt: oldPrompt, lastPrompt: "go", lastObservedState: "active" }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map<string, string | undefined>([["alpha-target", undefined]]),
    now: NOW,
  });
  assert.equal(result.state, "active");
});

test("active: unknown pane capture without prior state does not default to idle_with_output", () => {
  const oldPrompt = new Date(NOW - 10 * 60_000).toISOString();
  const result = deriveState(bee({ lastPromptAt: oldPrompt, lastPrompt: "go" }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map(),
    now: NOW,
  });
  assert.equal(result.state, "active");
});

test("idle_with_output: known agent is ready after a previous prompt", () => {
  const oldPrompt = new Date(NOW - 10 * 60_000).toISOString();
  const result = deriveState(bee({ lastPromptAt: oldPrompt, lastPrompt: "go" }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", "Codex finished\n\n› next task"]]),
    now: NOW,
  });
  assert.equal(result.state, "idle_with_output");
  assert.match(result.detail, /idle 10m/);
});

test("idle_with_output: unknown agents keep timestamp fallback", () => {
  const oldPrompt = new Date(NOW - 10 * 60_000).toISOString();
  const result = deriveState(bee({ agent: "custom", lastPromptAt: oldPrompt, lastPrompt: "go" }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", "x".repeat(500)]]),
    now: NOW,
  });
  assert.equal(result.state, "idle_with_output");
});

test("ready: live with output but no prompt sent yet", () => {
  const result = deriveState(bee(), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", "Codex\n\n› "]]),
    now: NOW,
  });
  assert.equal(result.state, "ready");
});

test("ready (briefed): brief set but no prompt yet", () => {
  const result = deriveState(bee({ brief: "you are reviewer", briefedAt: "2026-05-28T11:30:00.000Z" }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", "Codex\n\n› "]]),
    now: NOW,
  });
  assert.equal(result.state, "ready");
  assert.match(result.detail, /briefed/);
});

test("booting: live tmux but no output yet (freshly spawned)", () => {
  const result = deriveState(bee({ createdAt: new Date(NOW - 5_000).toISOString() }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", ""]]),
    now: NOW,
  });
  assert.equal(result.state, "booting");
});

test("wedged: booting past the wedge threshold (alive but no output)", () => {
  const result = deriveState(bee({ createdAt: new Date(NOW - 20 * 60_000).toISOString() }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", ""]]),
    now: NOW,
  });
  assert.equal(result.state, "wedged");
  assert.match(result.detail, /wedged/);
});

test("active wins over recent briefed-only without a prompt", () => {
  const result = deriveState(bee({ brief: "hi", briefedAt: new Date(NOW - 1_000).toISOString() }), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", "..."]]),
    now: NOW,
  });
  assert.equal(result.state, "active");
});

test("stateLabel returns human-readable forms", () => {
  assert.equal(stateLabel("idle_with_output"), "idle");
  assert.equal(stateLabel("kill_failed"), "kill_failed");
  assert.equal(stateLabel("node_unreachable"), "offline");
  assert.equal(stateLabel("done"), "done");
  assert.equal(stateLabel("auth-needed"), "auth-needed");
});

// The full BeeState union, spelled out so the compiler flags any state that is
// added to the union but forgotten in these coverage assertions.
const ALL_STATES: BeeState[] = [
  "dead",
  "crashed",
  "done",
  "auth-needed",
  "blocked",
  "ready",
  "active",
  "idle_with_output",
  "queued",
  "booting",
  "wedged",
  "error",
  "kill_failed",
  "node_unreachable",
];

test("STATE_PRESENTATION covers every BeeState with a finite clean priority", () => {
  // A missing clean-priority case used to fall through to undefined -> NaN and
  // silently corrupt `hive clean` ordering (HIVE-36).
  assert.equal(Object.keys(STATE_PRESENTATION).length, ALL_STATES.length);
  for (const state of ALL_STATES) {
    const priority = cleanStatePriority(state);
    assert.ok(Number.isFinite(priority), `${state} has a finite clean priority`);
    assert.ok(priority >= 0, `${state} clean priority is non-negative`);
    assert.ok(stateLabel(state).length > 0, `${state} has a non-empty label`);
    assert.ok(STATE_PRESENTATION[state].glyph.length > 0, `${state} has a glyph`);
  }
});

test("cleanStatePriority preserves the original ordering", () => {
  assert.equal(cleanStatePriority("idle_with_output"), 0);
  assert.equal(cleanStatePriority("dead"), 1);
  assert.equal(cleanStatePriority("crashed"), 1);
  assert.equal(cleanStatePriority("done"), 2);
  assert.equal(cleanStatePriority("kill_failed"), 3);
  assert.equal(cleanStatePriority("ready"), 4);
  assert.equal(cleanStatePriority("blocked"), 5);
  assert.equal(cleanStatePriority("error"), 6);
  assert.equal(cleanStatePriority("queued"), 7);
  assert.equal(cleanStatePriority("booting"), 7);
  assert.equal(cleanStatePriority("active"), 8);
  assert.equal(cleanStatePriority("node_unreachable"), 9);
});

test("formatStateCell renders the table's glyph and label", () => {
  // Strip color so the assertion holds whether or not stdout is a TTY.
  assert.equal(stripAnsi(formatStateCell("active")), "● active");
  assert.equal(stripAnsi(formatStateCell("ready")), "● ready");
  assert.equal(stripAnsi(formatStateCell("queued")), "◌ queued");
  assert.equal(stripAnsi(formatStateCell("idle_with_output")), "● idle");
  assert.equal(stripAnsi(formatStateCell("done")), "● done");
  assert.equal(stripAnsi(formatStateCell("dead")), "○ dead");
  assert.equal(stripAnsi(formatStateCell("node_unreachable")), "? offline");
});

test("isTerminalState recognizes end states", () => {
  assert.equal(isTerminalState("dead"), true);
  assert.equal(isTerminalState("done"), true);
  assert.equal(isTerminalState("kill_failed"), true);
  assert.equal(isTerminalState("active"), false);
  assert.equal(isTerminalState("ready"), false);
  assert.equal(isTerminalState("queued"), false);
  // node_unreachable is transient: the node may come back online.
  assert.equal(isTerminalState("node_unreachable"), false);
});

test("isDoneState covers sealed and filed bees (both derive to done)", () => {
  assert.equal(isDoneState("done"), true);
  assert.equal(isDoneState("dead"), false);
  assert.equal(isDoneState("active"), false);
});

test("done: a filed bee is done, NOT dead, even with its tmux target gone", () => {
  const result = deriveState(bee({ status: "done" }), { liveTargets: new Set(), now: NOW });
  assert.equal(result.state, "done", "filed, not dead");
  assert.match(result.detail, /filed/);
});

test("filed done wins over a stray live target (status is the settled fact)", () => {
  const result = deriveState(bee({ status: "done" }), { liveTargets: new Set(["alpha-target"]), now: NOW });
  assert.equal(result.state, "done");
});

test("filed done precedes the node_unreachable check (a filed bee never flips to offline)", () => {
  const result = deriveState(bee({ status: "done", node: "remote" }), {
    liveTargets: new Set(),
    unreachableNodes: new Set(["remote"]),
    now: NOW,
  });
  assert.equal(result.state, "done", "filed guard precedes the node check");
});

test("node_unreachable: bee's node is in unreachableNodes", () => {
  const result = deriveState(bee({ node: "mini01" }), {
    liveTargets: new Set(),
    unreachableNodes: new Set(["mini01"]),
    now: NOW,
  });
  assert.equal(result.state, "node_unreachable");
  assert.match(result.detail, /mini01 offline/);
});

test("node_unreachable takes precedence over done and dead", () => {
  const result = deriveState(bee({ node: "mini01" }), {
    liveTargets: new Set(),
    seals: new Set(["alpha"]),
    unreachableNodes: new Set(["mini01"]),
    now: NOW,
  });
  // We must not lie and call this 'done' when we don't know — the node is offline.
  assert.equal(result.state, "node_unreachable");
});

test("node_unreachable defaults to 'local' when record.node is undefined", () => {
  const result = deriveState(bee(), {
    liveTargets: new Set(),
    unreachableNodes: new Set(["local"]),
    now: NOW,
  });
  assert.equal(result.state, "node_unreachable");
});

test("liveTargetKey namespaces by node and defaults to local", () => {
  assert.equal(liveTargetKey(undefined, "alpha-target"), "local alpha-target");
  assert.equal(liveTargetKey("", "alpha-target"), "local alpha-target");
  assert.equal(liveTargetKey("mini01", "alpha-target"), "mini01 alpha-target");
});

test("liveness honors node-qualified keys", () => {
  const result = deriveState(bee({ node: "mini01" }), {
    liveTargets: new Set([liveTargetKey("mini01", "alpha-target")]),
    panes: new Map([["alpha-target", "Codex\n\n› "]]),
    now: NOW,
  });
  assert.equal(result.state, "ready");
});

test("crashed: a same-named live session on ANOTHER node does not mask a gone bee", () => {
  const result = deriveState(bee(), {
    // The bee is local; only node mini01 has a live "alpha-target" session.
    liveTargets: new Set([liveTargetKey("mini01", "alpha-target")]),
    now: NOW,
  });
  assert.equal(result.state, "crashed");
});

test("dead detail reports the MOST RECENT activity timestamp", () => {
  const result = deriveState(
    bee({
      lastPromptAt: "2026-05-28T10:00:00.000Z",
      briefedAt: "2026-05-28T11:30:00.000Z",
      updatedAt: "2026-05-28T11:00:00.000Z",
    }),
    { liveTargets: new Set(), now: NOW },
  );
  assert.equal(result.state, "crashed");
  assert.ok(result.detail.endsWith("last activity 2026-05-28T11:30:00.000Z"), result.detail);
});

test("kill_failed still wins over node_unreachable", () => {
  const result = deriveState(bee({ node: "mini01", status: "kill_failed", lastError: "tmux refused" }), {
    liveTargets: new Set(),
    unreachableNodes: new Set(["mini01"]),
    now: NOW,
  });
  assert.equal(result.state, "kill_failed");
});

test("HSR structured terminal states do not reuse the last prompt as detail", () => {
  for (const state of ["dead", "error", "kill_failed", "node_unreachable"] as const) {
    const result = deriveState(
      bee({
        substrate: "hsr",
        node: "mini01",
        lastPrompt: "deploy prod",
        lastPromptAt: "2026-05-28T11:30:00.000Z",
        lastError: "runner failed",
      }),
      {
        liveTargets: new Set(),
        hsrLive: new Set(["alpha"]),
        hsrStates: new Map([["alpha", state]]),
        now: NOW,
      },
    );
    // A structured "dead" on a record never retired/killed reports "crashed".
    assert.equal(result.state, state === "dead" ? "crashed" : state);
    assert.notEqual(result.detail, "deploy prod");
  }
});

test("capture failure does not fabricate wedged for a live never-prompted bee (self-sustaining wedge fix)", () => {
  // A live bee whose pane could not be captured this tick, whose prior observed
  // state was a stale non-holdable `wedged`. Must NOT re-derive wedged — that
  // strands healthy idle bees as "failed" (real incident 2026-07-08).
  const record = bee({ createdAt: "2026-05-01T00:00:00.000Z" }); // old bee, well past BOOT_WEDGE_MS
  const context = {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map<string, string | undefined>([["alpha-target", undefined]]), // captured key, no content = capture failed
    previousStates: new Map<string, BeeState>([["alpha", "wedged"]]),
    now: NOW,
  };
  const result = deriveState(record, context);
  assert.equal(result.state, "ready");
  assert.notEqual(result.state, "wedged");
});

test("capture failure leaves a live prompted bee on the active path, never wedged", () => {
  const record = bee({ createdAt: "2026-05-01T00:00:00.000Z", lastPromptAt: "2026-05-28T09:00:00.000Z", lastPrompt: "go" });
  const context = {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map<string, string | undefined>([["alpha-target", undefined]]),
    previousStates: new Map<string, BeeState>([["alpha", "wedged"]]),
    now: NOW,
  };
  assert.notEqual(deriveState(record, context).state, "wedged");
});

test("a genuinely-seen unready pane still derives wedged for an old never-prompted bee", () => {
  // The capture SUCCEEDED (pane present) but the agent never reached ready and
  // there is no output — that is real wedge evidence and must still escalate.
  const record = bee({ createdAt: "2026-05-01T00:00:00.000Z" });
  const context = {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map<string, string | undefined>([["alpha-target", ""]]), // seen, empty
    now: NOW,
  };
  assert.equal(deriveState(record, context).state, "wedged");
});
