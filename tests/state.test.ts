import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveState, isTerminalState, liveTargetKey, stateLabel } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

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

test("dead: tmux target is not live", () => {
  const result = deriveState(bee(), { liveTargets: new Set(), now: NOW });
  assert.equal(result.state, "dead");
});

test("sealed (after exit): tmux gone but seal exists", () => {
  const result = deriveState(bee(), { liveTargets: new Set(), seals: new Set(["alpha"]), now: NOW });
  assert.equal(result.state, "sealed");
});

test("sealed (while alive): tmux live and seal exists", () => {
  const result = deriveState(bee(), { liveTargets: new Set(["alpha-target"]), seals: new Set(["alpha"]), now: NOW });
  assert.equal(result.state, "sealed");
});

test("kill_failed: record explicitly marked", () => {
  const result = deriveState(bee({ status: "kill_failed", lastError: "tmux refused" }), {
    liveTargets: new Set(["alpha-target"]),
    now: NOW,
  });
  assert.equal(result.state, "kill_failed");
  assert.match(result.detail, /tmux refused/);
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

test("booting: live tmux but no output yet", () => {
  const result = deriveState(bee(), {
    liveTargets: new Set(["alpha-target"]),
    panes: new Map([["alpha-target", ""]]),
    now: NOW,
  });
  assert.equal(result.state, "booting");
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
  assert.equal(stateLabel("archived"), "archived");
});

test("isTerminalState recognizes end states", () => {
  assert.equal(isTerminalState("dead"), true);
  assert.equal(isTerminalState("sealed"), true);
  assert.equal(isTerminalState("kill_failed"), true);
  assert.equal(isTerminalState("archived"), true);
  assert.equal(isTerminalState("active"), false);
  assert.equal(isTerminalState("ready"), false);
  // node_unreachable is transient: the node may come back online.
  assert.equal(isTerminalState("node_unreachable"), false);
});

test("archived: a filed bee is archived, NOT dead, even with its tmux target gone", () => {
  const result = deriveState(bee({ status: "archived" }), { liveTargets: new Set(), now: NOW });
  assert.equal(result.state, "archived", "filed, not dead");
  assert.match(result.detail, /filed/);
});

test("archived wins over a stray live target (status is the settled fact)", () => {
  const result = deriveState(bee({ status: "archived" }), { liveTargets: new Set(["alpha-target"]), now: NOW });
  assert.equal(result.state, "archived");
});

test("archived precedes the node_unreachable check (a filed bee never flips to offline)", () => {
  const result = deriveState(bee({ status: "archived", node: "remote" }), {
    liveTargets: new Set(),
    unreachableNodes: new Set(["remote"]),
    now: NOW,
  });
  assert.equal(result.state, "archived", "archived guard precedes the node check");
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

test("node_unreachable takes precedence over sealed and dead", () => {
  const result = deriveState(bee({ node: "mini01" }), {
    liveTargets: new Set(),
    seals: new Set(["alpha"]),
    unreachableNodes: new Set(["mini01"]),
    now: NOW,
  });
  // We must not lie and call this 'sealed' when we don't know — the node is offline.
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

test("dead: a same-named live session on ANOTHER node does not mask a dead bee", () => {
  const result = deriveState(bee(), {
    // The bee is local; only node mini01 has a live "alpha-target" session.
    liveTargets: new Set([liveTargetKey("mini01", "alpha-target")]),
    now: NOW,
  });
  assert.equal(result.state, "dead");
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
  assert.equal(result.state, "dead");
  assert.equal(result.detail, "last activity 2026-05-28T11:30:00.000Z");
});

test("kill_failed still wins over node_unreachable", () => {
  const result = deriveState(bee({ node: "mini01", status: "kill_failed", lastError: "tmux refused" }), {
    liveTargets: new Set(),
    unreachableNodes: new Set(["mini01"]),
    now: NOW,
  });
  assert.equal(result.state, "kill_failed");
});
