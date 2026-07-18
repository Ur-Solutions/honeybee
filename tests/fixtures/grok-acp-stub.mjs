import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const sessionId = process.env.GROK_STUB_SESSION_ID ?? "grok_session_stub";
const logPath = process.env.GROK_STUB_LOG;
let activePrompt;
let pendingInput;

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function update(updateValue, method = "session/update") {
  send({ jsonrpc: "2.0", method, params: { sessionId, update: updateValue } });
}

function usage(seed = 1) {
  return {
    inputTokens: seed * 100,
    outputTokens: seed * 10,
    totalTokens: seed * 110,
    cachedReadTokens: seed * 40,
    reasoningTokens: seed * 3,
    modelCalls: 1,
    numTurns: 1,
  };
}

function finishPrompt(text = "done", seed = 1, includeUsage = true) {
  const prompt = activePrompt;
  if (!prompt) return;
  activePrompt = undefined;
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  response(prompt.id, {
    stopReason: "end_turn",
    _meta: {
      totalTokens: seed * 25,
      ...(includeUsage ? { usage: usage(seed) } : {}),
    },
  });
}

const models = {
  currentModelId: "grok-4.5",
  availableModels: [{
    modelId: "grok-4.5",
    name: "Grok 4.5",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      reasoningEfforts: ["low", "medium", "high"].map((value) => ({ id: value, value })),
    },
  }],
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  log(message);

  if (message.method === "initialize") {
    response(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: {} },
      authMethods: [
        { id: "cached_token", name: "cached_token" },
        { id: "xai.api_key", name: "xai.api_key" },
      ],
      agentInfo: { name: "Grok ACP Stub", version: "0.2.102" },
      _meta: { defaultAuthMethodId: "cached_token", modelState: models },
    });
    return;
  }
  if (message.method === "authenticate") {
    response(message.id, { _meta: { auth_mode: message.params?.methodId } });
    return;
  }
  if (message.method === "session/new" || message.method === "session/load") {
    response(message.id, { sessionId: message.params?.sessionId ?? sessionId, models });
    return;
  }
  if (message.method === "session/set_model") {
    response(message.id, { _meta: { model: { Ok: message.params?.modelId } } });
    return;
  }
  if (message.method === "session/set_mode") {
    update({ sessionUpdate: "current_mode_update", currentModeId: message.params?.modeId });
    response(message.id, {});
    return;
  }
  if (message.method === "_x.ai/interject") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `interjected:${message.params?.text}` } });
    if (message.params?.text === "hang-interject") return;
    response(message.id, {});
    return;
  }
  if (message.method === "session/prompt") {
    const text = message.params?.prompt?.[0]?.text ?? "";
    activePrompt = { id: message.id, text };
    if (text === "rate-limit") {
      activePrompt = undefined;
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32003,
          message: "You've hit the rate limit for your plan",
          data: { code: "usage_limit_reached", resetAt: 1784383200, _meta: { usage: usage(5) } },
        },
      });
      return;
    }
    if (text === "auth-fail") {
      activePrompt = undefined;
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: "Authentication required",
          data: { code: "auth.refresh.permanent_failure", message: "Failed to refresh expired token" },
        },
      });
      return;
    }
    if (text === "prompt-error-usage") {
      activePrompt = undefined;
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "turn failed", data: { _meta: { usage: usage(7) } } },
      });
      return;
    }
    if (text === "permission") {
      update({ sessionUpdate: "tool_call", toolCallId: "tool-permission", title: "Run command", kind: "execute", rawInput: { command: "pwd" } });
      pendingInput = { id: 800, kind: "permission" };
      send({
        jsonrpc: "2.0",
        id: 800,
        method: "session/request_permission",
        params: {
          sessionId,
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
          toolCall: { toolCallId: "tool-permission", title: "Run command", kind: "execute" },
        },
      });
      return;
    }
    if (text === "question") {
      const questions = [
        {
          question: "Which color?",
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Cool", preview: "A blue preview" },
          ],
          multiSelect: false,
        },
        {
          question: "Which checks?",
          options: [
            { label: "Lint", description: "Run lint" },
            { label: "Types", description: "Run typecheck" },
            { label: "Tests", description: "Run tests" },
          ],
          multiSelect: true,
        },
      ];
      update({ sessionUpdate: "tool_call", toolCallId: "tool-question", title: "Ask user questions", kind: "other", rawInput: { questions } });
      pendingInput = { id: 801, kind: "question" };
      send({ jsonrpc: "2.0", id: 801, method: "x.ai/ask_user_question", params: { sessionId, questions } });
      return;
    }
    if (text === "tool-boundary") {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering a tool" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before-tool" } });
      setTimeout(() => {
        update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file", kind: "read", rawInput: { path: "README.md" } });
        update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Read file", status: "completed" });
      }, 30);
      setTimeout(() => finishPrompt("after-tool", 2), 100);
      return;
    }
    if (text === "usage-fallback") {
      update({ sessionUpdate: "turn_completed", usage: usage(9) }, "_x.ai/session/update");
      setTimeout(() => finishPrompt("fallback-done", 9, false), 10);
      return;
    }
    if (text === "wait-for-cancel") return;
    setTimeout(() => finishPrompt(`reply:${text}`, text === "queue-one" ? 3 : 1), text === "queue-one" ? 60 : 10);
    return;
  }
  if (message.method === "session/cancel") {
    const prompt = activePrompt;
    if (prompt) {
      activePrompt = undefined;
      response(prompt.id, { stopReason: "cancelled" });
    }
    return;
  }
  if (pendingInput && message.id === pendingInput.id && "result" in message) {
    const pending = pendingInput;
    pendingInput = undefined;
    if (pending.kind === "permission") {
      finishPrompt(`permission:${message.result?.outcome?.optionId ?? message.result?.outcome?.outcome}`, 2);
    } else {
      finishPrompt(`question:${message.result?.outcome}:${Object.values(message.result?.answers ?? {}).join("|")}`, 4);
    }
  }
});
