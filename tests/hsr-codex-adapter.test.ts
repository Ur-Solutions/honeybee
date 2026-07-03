/**
 * Hermetic codex tier-S adapter tests (APIA-75) — NO app-server, NO network.
 *
 * Exercises the PURE mappers with fixtures distilled from the generated
 * app-server bindings (codex-cli 0.142.5), using their EXACT field names:
 *   - codexNotificationToEvents: turn/started, item/agentMessage/delta,
 *     turn/completed(+usage), thread/tokenUsage/updated, error, unknown
 *   - encodeCodexUserInput: the UserInput "text" variant shape
 *   - codexServerRequestToNeedsInput: approval → needs_input(kind:"permission")
 *   - encodeCodexApprovalResponse: per-method response shapes
 *   - adapterFor("codex") wiring
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codexAdapter,
  codexNotificationToEvents,
  codexServerRequestToNeedsInput,
  encodeCodexApprovalResponse,
  encodeCodexUserInput,
} from "../src/hsr/adapters/codex.js";
import { adapterFor } from "../src/hsr/adapters/index.js";
import type { RunnerEvent } from "../src/hsr/types.js";

/** Strip the ts field so event shapes assert deterministically. */
function stripTs(events: RunnerEvent[]): unknown[] {
  return events.map((e) => {
    const { ts: _ts, ...rest } = e as RunnerEvent & { ts: number };
    return rest;
  });
}

test("codexNotificationToEvents maps turn/started → [turn_start]", () => {
  // TurnStartedNotification = { threadId, turn }
  const params = { threadId: "t-1", turn: { id: "turn-1", status: "in_progress" } };
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/started", params)), [{ type: "turn_start" }]);
});

test("codexNotificationToEvents maps item/agentMessage/delta → [text]", () => {
  // AgentMessageDeltaNotification = { threadId, turnId, itemId, delta }
  const params = { threadId: "t-1", turnId: "turn-1", itemId: "i-1", delta: "hi there" };
  assert.deepEqual(stripTs(codexNotificationToEvents("item/agentMessage/delta", params)), [
    { type: "text", text: "hi there" },
  ]);
  // An empty delta yields nothing.
  assert.deepEqual(codexNotificationToEvents("item/agentMessage/delta", { delta: "" }), []);
});

test("codexNotificationToEvents maps turn/completed → [turn_end]; +usage when a token breakdown is present", () => {
  // Base TurnCompletedNotification = { threadId, turn } carries no tokens.
  const bare = { threadId: "t-1", turn: { id: "turn-1", status: "completed" } };
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/completed", bare)), [{ type: "turn_end" }]);

  // Defensive: honor a TokenUsageBreakdown-shaped `usage` if a variant supplies it.
  const withUsage = {
    threadId: "t-1",
    turn: { id: "turn-1", status: "completed" },
    usage: { totalTokens: 50, inputTokens: 9, cachedInputTokens: 0, outputTokens: 41, reasoningOutputTokens: 0 },
  };
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/completed", withUsage)), [
    { type: "turn_end" },
    { type: "usage", inputTokens: 9, outputTokens: 41, totalTokens: 50 },
  ]);
});

test("codexNotificationToEvents maps thread/tokenUsage/updated → [usage] from tokenUsage.last", () => {
  // ThreadTokenUsageUpdatedNotification = { threadId, turnId, tokenUsage:{ total, last, modelContextWindow } }
  // TokenUsageBreakdown = { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens }
  const params = {
    threadId: "t-1",
    turnId: "turn-1",
    tokenUsage: {
      total: { totalTokens: 999, inputTokens: 900, cachedInputTokens: 0, outputTokens: 99, reasoningOutputTokens: 0 },
      last: { totalTokens: 50, inputTokens: 9, cachedInputTokens: 0, outputTokens: 41, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    },
  };
  assert.deepEqual(stripTs(codexNotificationToEvents("thread/tokenUsage/updated", params)), [
    { type: "usage", inputTokens: 9, outputTokens: 41, totalTokens: 50 },
  ]);
});

test("codexNotificationToEvents never maps cumulative tokenUsage.total as a usage delta", () => {
  const params = {
    threadId: "t-1",
    turnId: "turn-1",
    tokenUsage: {
      total: { totalTokens: 999, inputTokens: 900, cachedInputTokens: 0, outputTokens: 99, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    },
  };

  assert.deepEqual(codexNotificationToEvents("thread/tokenUsage/updated", params), []);
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/completed", params)), [{ type: "turn_end" }]);
});

test("codexNotificationToEvents maps error → [error] from error.message", () => {
  // ErrorNotification = { error: TurnError{ message, ... }, willRetry, threadId, turnId }
  const params = {
    error: { message: "the model is overloaded", codexErrorInfo: null, additionalDetails: null },
    willRetry: false,
    threadId: "t-1",
    turnId: "turn-1",
  };
  assert.deepEqual(stripTs(codexNotificationToEvents("error", params)), [
    { type: "error", message: "the model is overloaded" },
  ]);
});

test("codexNotificationToEvents drops reasoning + unknown notifications", () => {
  assert.deepEqual(codexNotificationToEvents("item/reasoning/textDelta", { delta: "thinking..." }), []);
  assert.deepEqual(codexNotificationToEvents("item/started", { threadId: "t-1" }), []);
  assert.deepEqual(codexNotificationToEvents("mystery/method", {}), []);
});

test("encodeCodexUserInput produces the UserInput text variant", () => {
  // UserInput text variant = { type:"text", text, text_elements: TextElement[] }
  assert.deepEqual(encodeCodexUserInput("hello"), { type: "text", text: "hello", text_elements: [] });
});

test("codexServerRequestToNeedsInput maps an approval request → needs_input(permission)", () => {
  // PermissionsRequestApprovalParams = { threadId, turnId, itemId, ..., reason, permissions }
  const params = { threadId: "t-1", turnId: "turn-1", itemId: "i-1", startedAtMs: 1, cwd: "/tmp", reason: "needs network", permissions: {} };
  const ev = codexServerRequestToNeedsInput("item/permissions/requestApproval", 7, params);
  assert.ok(ev && ev.type === "needs_input");
  assert.equal(ev.kind, "permission");
  assert.equal(ev.requestId, "7");
  assert.equal(ev.question, "needs network");
  assert.equal(ev.tool, "item/permissions/requestApproval");
  assert.deepEqual(ev.input, params);
});

test("codexServerRequestToNeedsInput handles legacy execCommandApproval + a string id", () => {
  const params = { conversationId: "c-1", callId: "call-1", approvalId: null, command: ["ls"], cwd: "/tmp", reason: null, parsedCmd: [] };
  const ev = codexServerRequestToNeedsInput("execCommandApproval", "req-abc", params);
  assert.ok(ev && ev.type === "needs_input");
  assert.equal(ev.requestId, "req-abc");
  // No reason/command string → a method-derived default question.
  assert.equal(ev.question, "codex requests approval: execCommandApproval");
});

test("codexServerRequestToNeedsInput returns null for unmodeled server requests", () => {
  assert.equal(codexServerRequestToNeedsInput("attestation/generate", 1, {}), null);
  assert.equal(codexServerRequestToNeedsInput("account/chatgptAuthTokens/refresh", 2, {}), null);
});

test("encodeCodexApprovalResponse builds the right per-method response shape", () => {
  // Legacy ReviewDecision.
  assert.deepEqual(encodeCodexApprovalResponse("execCommandApproval", true), { decision: "approved" });
  assert.deepEqual(encodeCodexApprovalResponse("applyPatchApproval", false), { decision: "denied" });
  // CommandExecution / FileChange decisions.
  assert.deepEqual(encodeCodexApprovalResponse("item/commandExecution/requestApproval", true), { decision: "accept" });
  assert.deepEqual(encodeCodexApprovalResponse("item/fileChange/requestApproval", false), { decision: "decline" });
  // Permissions is grant-based (no decision field).
  assert.deepEqual(encodeCodexApprovalResponse("item/permissions/requestApproval", true), { permissions: {}, scope: "turn" });
  // Tool user-input is structural.
  assert.deepEqual(encodeCodexApprovalResponse("item/tool/requestUserInput", true), { answers: {} });
});

test("adapterFor resolves codex; codexAdapter is harness codex, tier server", () => {
  assert.equal(adapterFor("codex"), codexAdapter);
  assert.equal(codexAdapter.harness, "codex");
  assert.equal(codexAdapter.tier(), "server");
});
