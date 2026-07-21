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
  buildCodexSpawn,
  buildCodexThreadRequestParams,
  codexAdapter,
  codexModelFromArgs,
  codexNotificationToEvents,
  codexServerRequestToNeedsInput,
  codexTurnLifecycleAfterNotification,
  encodeCodexApprovalResponse,
  encodeCodexUserInput,
  retryCodexThreadHandshake,
} from "../src/hsr/adapters/codex.js";
import { CodexRpcRequestTimeoutError } from "../src/hsr/adapters/codexRpc.js";
import { adapterFor } from "../src/hsr/adapters/index.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

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
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/started", params)), [
    { type: "turn_start", threadId: "t-1" },
  ]);
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
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/completed", bare)), [
    { type: "turn_end", threadId: "t-1" },
  ]);

  // Defensive: honor a TokenUsageBreakdown-shaped `usage` if a variant supplies it.
  const withUsage = {
    threadId: "t-1",
    turn: { id: "turn-1", status: "completed" },
    usage: { totalTokens: 50, inputTokens: 9, cachedInputTokens: 0, outputTokens: 41, reasoningOutputTokens: 0 },
  };
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/completed", withUsage)), [
    { type: "turn_end", threadId: "t-1" },
    { type: "usage", inputTokens: 9, outputTokens: 41, totalTokens: 50 },
  ]);
});

test("codex interrupt lifecycle clears the completed turn instead of retaining a stale id", () => {
  const idle = { active: false, turnId: "" };
  const active = codexTurnLifecycleAfterNotification(idle, "turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "in_progress" },
  });
  assert.deepEqual(active, { active: true, turnId: "turn-1" });

  const afterUsage = codexTurnLifecycleAfterNotification(active, "thread/tokenUsage/updated", {
    turnId: "turn-1",
  });
  assert.equal(afterUsage, active, "non-lifecycle notifications must not retarget interrupt");

  assert.deepEqual(
    codexTurnLifecycleAfterNotification(active, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    }),
    idle,
  );
});

test("codexNotificationToEvents leaves unscoped lifecycle events backward-compatible", () => {
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/started", { turn: { id: "turn-1" } })), [
    { type: "turn_start" },
  ]);
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/completed", { turn: { id: "turn-1" } })), [
    { type: "turn_end" },
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
  assert.deepEqual(stripTs(codexNotificationToEvents("turn/completed", params)), [
    { type: "turn_end", threadId: "t-1" },
  ]);
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

test("codex requestUserInput preserves question ids, descriptions, and answer response shape", () => {
  const params = {
    threadId: "t-1",
    turnId: "turn-1",
    itemId: "i-1",
    questions: [{
      id: "environment",
      header: "Deploy",
      question: "Where should this ship?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "Staging", description: "Use staging." },
        { label: "Production", description: "Use production." },
      ],
    }],
    autoResolutionMs: null,
  };
  const ev = codexServerRequestToNeedsInput("item/tool/requestUserInput", 8, params);
  assert.ok(ev && ev.type === "needs_input");
  assert.equal(ev.kind, "question");
  assert.equal(ev.question, "Where should this ship?");
  assert.deepEqual(ev.options, ["Staging", "Production"]);
  assert.deepEqual(ev.optionDetails, params.questions[0]!.options);
  assert.deepEqual(ev.questions, [{
    id: "environment",
    header: "Deploy",
    question: "Where should this ship?",
    options: params.questions[0]!.options,
  }]);
  assert.deepEqual(encodeCodexApprovalResponse("item/tool/requestUserInput", true, "Production", params), {
    answers: { environment: { answers: ["Production"] } },
  });
  assert.deepEqual(
    encodeCodexApprovalResponse("item/tool/requestUserInput", true, JSON.stringify({ environment: ["Staging", "Production"] }), params),
    { answers: { environment: { answers: ["Staging", "Production"] } } },
  );
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

test("codexModelFromArgs recovers the effective CLI model for HSR thread/start", () => {
  assert.equal(codexModelFromArgs(["-m", "gpt-5.6-sol"]), "gpt-5.6-sol");
  assert.equal(codexModelFromArgs(["--model", "gpt-5.5", "-m", "gpt-5.6-terra"]), "gpt-5.6-terra");
  assert.equal(codexModelFromArgs(["--model=gpt-5.6-luna"]), "gpt-5.6-luna");
  assert.equal(codexModelFromArgs(["-c", 'model_reasoning_effort="xhigh"']), undefined);
});

test("buildCodexSpawn re-applies -c config overrides to the app-server child", () => {
  const opts: RunnerOpts = {
    bee: "CO.test",
    cwd: "/repo",
    env: {},
    runDir: "/tmp/run",
    args: ["--model", "gpt-5.5", "-c", 'model_reasoning_effort="high"', "--config=sandbox_mode=read-only"],
  };
  const { args } = buildCodexSpawn(opts);
  assert.deepEqual(args, [
    "app-server",
    "-c", 'model_reasoning_effort="high"',
    "-c", "sandbox_mode=read-only",
  ]);
  // Model flags stay OUT of the child argv — they travel per-thread instead.
  assert.ok(!args.includes("--model"));
  assert.deepEqual(buildCodexSpawn({ ...opts, args: [] }).args, ["app-server"]);
});

test("buildCodexThreadRequestParams passes the argv model out-of-band to codex app-server", () => {
  const opts: RunnerOpts = {
    bee: "CO.test",
    cwd: "/repo",
    env: {},
    runDir: "/tmp/run",
    args: ["--model", "gpt-5.5", "-m", "gpt-5.6-sol"],
    model: "gpt-5.4",
  };

  assert.deepEqual(buildCodexThreadRequestParams(opts, "thread/start"), {
    model: "gpt-5.6-sol",
    cwd: "/repo",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(buildCodexThreadRequestParams({ ...opts, sessionId: "thread-1" }, "thread/resume"), {
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    cwd: "/repo",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
});

test("thread handshake timeout discards the wedged child and retries on a fresh attempt with backoff", async () => {
  const runs: Array<{ attempt: number; delayMs: number; timeoutMs: number }> = [];
  const discarded: number[] = [];
  const retries: Array<{ attempt: number; nextDelayMs: number }> = [];
  let created = 0;

  const outcome = await retryCodexThreadHandshake(
    async () => {
      const attempt = ++created;
      return {
        async run(delayMs: number, timeoutMs: number): Promise<string> {
          runs.push({ attempt, delayMs, timeoutMs });
          if (attempt < 3) throw new CodexRpcRequestTimeoutError("thread/start", timeoutMs);
          return "thread-ok";
        },
        async discard(): Promise<void> {
          discarded.push(attempt);
        },
      };
    },
    {
      delaysMs: [0, 20, 50],
      requestTimeoutMs: 7,
      onRetry: ({ attempt, nextDelayMs }) => retries.push({ attempt, nextDelayMs }),
    },
  );

  assert.equal(outcome.result, "thread-ok");
  assert.equal(created, 3, "each retry must create a new app-server attempt");
  assert.deepEqual(runs, [
    { attempt: 1, delayMs: 0, timeoutMs: 7 },
    { attempt: 2, delayMs: 20, timeoutMs: 7 },
    { attempt: 3, delayMs: 50, timeoutMs: 7 },
  ]);
  assert.deepEqual(discarded, [1, 2], "only wedged attempts are killed");
  assert.deepEqual(retries, [
    { attempt: 1, nextDelayMs: 20 },
    { attempt: 2, nextDelayMs: 50 },
  ]);
});

test("thread handshake does not hide non-timeout protocol failures", async () => {
  let created = 0;
  let discarded = 0;
  await assert.rejects(
    retryCodexThreadHandshake(
      async () => {
        created++;
        return {
          async run(): Promise<never> {
            throw new Error("authentication rejected");
          },
          async discard(): Promise<void> {
            discarded++;
          },
        };
      },
      { delaysMs: [0, 1, 2], requestTimeoutMs: 1 },
    ),
    /authentication rejected/,
  );
  assert.equal(created, 1);
  assert.equal(discarded, 1);
});
