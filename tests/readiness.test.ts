import assert from "node:assert/strict";
import { test } from "node:test";
import { isAgentReadyPane, isMcpWarningPane, isTrustPromptPane, shouldRaiseDroidAutonomy } from "../src/readiness.js";

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

test("generic enter prompts are not treated as trust prompts", () => {
  assert.equal(isTrustPromptPane("Press enter to continue"), false);
  assert.equal(shouldRaiseDroidAutonomy("Auto (Low)"), true);
});
