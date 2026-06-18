import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentReadinessError, isAgentReadyPane, isBypassPermissionsPane, isMcpWarningPane, isPermissionPromptPane, isStartupConfirmationPane, isTrustPromptPane, shouldRaiseDroidAutonomy, waitForAgentReady } from "../src/readiness.js";
import type { SessionRecord } from "../src/store.js";

function record(agent: string): SessionRecord {
  return {
    name: "test-bee",
    agent,
    cwd: "/tmp",
    command: agent,
    tmuxTarget: "test-bee-target",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    status: "running",
  };
}

test("agent readiness rejects trust and MCP blocker panes", () => {
  const trustPane = "Do you trust the contents of this directory?\nEnter to confirm";
  const mcpPane = "MCP server found in this project";

  assert.equal(isTrustPromptPane(trustPane), true);
  assert.equal(isMcpWarningPane(mcpPane), true);
  assert.equal(isAgentReadyPane("claude", `${trustPane}\n❯ `), false);
  assert.equal(isAgentReadyPane("codex", `${mcpPane}\n› `), false);
});

test("agent readiness recognizes known provider prompts", () => {
  assert.equal(isAgentReadyPane("claude", "\n❯ "), true);
  assert.equal(isAgentReadyPane("codex", "What can I help with?"), true);
  assert.equal(isAgentReadyPane("opencode", "Ask anything"), true);
  assert.equal(isAgentReadyPane("grok", "Grok Build\n❯ "), true);
});

test("mid-task permission prompts are detected and block readiness", () => {
  const proceed = "Bash(rm -rf build)\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)";
  const edit = "Do you want to make this edit to ids.ts?\n❯ 1. Yes\n  2. Yes, allow all edits this session";

  assert.equal(isPermissionPromptPane(proceed), true);
  assert.equal(isPermissionPromptPane(edit), true);
  // A plain ready prompt or composer is not an approval prompt.
  assert.equal(isPermissionPromptPane("\n❯ "), false);
  assert.equal(isPermissionPromptPane("What can I help with?"), false);
  // A bee sitting on a permission prompt must not be reported ready.
  assert.equal(isAgentReadyPane("claude", `${proceed}\n❯ `), false);
});

test("claude bypass-permissions dialog is an auto-accepted startup confirmation", () => {
  // Verbatim capture of a fresh account-home claude launched with
  // --dangerously-skip-permissions: the "Yes, I accept" option is pre-selected.
  const dialog = [
    "  WARNING: Claude Code running in Bypass Permissions mode",
    "  In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.",
    "  This mode should only be used in a sandboxed container/VM that has restricted internet access.",
    "  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.",
    "  https://code.claude.com/docs/en/security",
    "  ❯ 1. No, exit",
    "    2. Yes, I accept",
    "  Enter to confirm · Esc to cancel",
  ].join("\n");

  assert.equal(isBypassPermissionsPane(dialog), true);
  // Folded into the auto-accept path so the readiness loop presses Enter.
  assert.equal(isStartupConfirmationPane(dialog), true);
  // A bee sitting on the dialog must not be reported ready.
  assert.equal(isAgentReadyPane("claude", dialog), false);

  // The steady-state "bypass permissions on" footer of an already-ready pane
  // must NOT be mistaken for the dialog, or every ready bee looks blocked.
  const readyFooter = [
    "❯ Try \"write a test for flow.ts\"",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  assert.equal(isBypassPermissionsPane(readyFooter), false);
  assert.equal(isAgentReadyPane("claude", readyFooter), true);
});

test("generic enter prompts are not treated as trust prompts", () => {
  assert.equal(isTrustPromptPane("Press enter to continue"), false);
  assert.equal(shouldRaiseDroidAutonomy("Auto (Low)"), true);
});

test("stale trust text in scrollback does not mask a ready agent", () => {
  // codex prints the trust prompt in the normal buffer, then switches to an
  // alternate screen for its main UI — the accepted prompt lingers up in
  // scrollback while the composer prompt sits at the bottom. The agent is ready.
  const pane = [
    "> You are in /tmp/project",
    "  Do you trust the contents of this directory? Trusting allows config to load.",
    "› 1. Yes, continue",
    "  Press enter to continue",
    ...Array.from({ length: 16 }, (_, i) => `  banner line ${i}`),
    "› Improve documentation in @filename",
  ].join("\n");
  // The detectors are tail-scoped by construction, so every caller (state
  // derivation included) sees the answered prompt as resolved.
  assert.equal(isTrustPromptPane(pane), false);
  assert.equal(isAgentReadyPane("codex", pane), true);
});

test("stale MCP warning text in scrollback does not block the agent", () => {
  const pane = [
    "MCP server found in this project",
    ...Array.from({ length: 16 }, (_, i) => `  banner line ${i}`),
    "❯ ",
  ].join("\n");
  assert.equal(isMcpWarningPane(pane), false);
  assert.equal(isAgentReadyPane("claude", pane), true);
});

test("assistant questions without a numbered option list are not permission prompts", () => {
  const pane = "I reviewed the plan. Do you want to proceed with approach A, or should I run the tests first?\n\n❯ ";
  assert.equal(isPermissionPromptPane(pane), false);
  assert.equal(isAgentReadyPane("claude", pane), true);

  const wouldYou = "Would you like to proceed? I can also split this into two PRs.\n\n❯ ";
  assert.equal(isPermissionPromptPane(wouldYou), false);
});

test("waitForAgentReady reports an unclearable trust prompt as reason=trust", async () => {
  const trustPane = "Do you trust the contents of this directory?\n❯ 1. Yes, continue\n  2. No, exit\nEnter to confirm";
  let enters = 0;
  const substrate = {
    capture: async () => trustPane,
    sendEnter: async () => {
      enters += 1;
    },
    sendKey: async () => {},
  };

  await assert.rejects(
    waitForAgentReady(record("claude"), { timeoutMs: 100, trustGraceMs: 0, substrate }),
    (error: unknown) => error instanceof AgentReadinessError && error.reason === "trust" && /hive attach/.test(error.message),
  );
  assert.ok(enters >= 1, "should have tried to confirm the trust prompt");
});

test("waitForAgentReady accepts the bypass-permissions dialog with the '2' key, never Enter", async () => {
  // The dialog defaults its selector to "1. No, exit", so a bare Enter would
  // kill the bee — acceptance MUST go through the "2. Yes, I accept" digit key.
  const dialog = "WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm";
  let enters = 0;
  const keys: string[] = [];
  const substrate = {
    // Show the dialog until the first accept key, then render the ready prompt.
    capture: async () => (keys.length === 0 ? dialog : "\n❯ "),
    sendEnter: async () => {
      enters += 1;
    },
    sendKey: async (_target: string, key: string) => {
      keys.push(key);
    },
  };

  await waitForAgentReady(record("claude"), { timeoutMs: 2000, trustGraceMs: 0, substrate });
  assert.deepEqual(keys, ["2"], "should confirm via the '2' key exactly once");
  assert.equal(enters, 0, "must never press Enter on the bypass dialog (Enter = 'No, exit')");
});

test("waitForAgentReady honors --no-accept-trust on the bypass dialog", async () => {
  const dialog = "WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm";
  const keys: string[] = [];
  const substrate = {
    capture: async () => dialog,
    sendEnter: async () => {},
    sendKey: async (_target: string, key: string) => {
      keys.push(key);
    },
  };

  await assert.rejects(
    waitForAgentReady(record("claude"), { timeoutMs: 100, acceptTrust: false, substrate }),
    (error: unknown) => error instanceof AgentReadinessError && error.reason === "trust",
  );
  assert.deepEqual(keys, [], "must not send any accept key when acceptance is opted out");
});

test("waitForAgentReady still reports timeout when no trust prompt is visible", async () => {
  const substrate = {
    capture: async () => "still booting...",
    sendEnter: async () => {},
    sendKey: async () => {},
  };

  await assert.rejects(
    waitForAgentReady(record("claude"), { timeoutMs: 50, substrate }),
    (error: unknown) => error instanceof AgentReadinessError && error.reason === "timeout",
  );
});
