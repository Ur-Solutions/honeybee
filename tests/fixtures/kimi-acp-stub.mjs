import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const sessionId = process.env.KIMI_STUB_SESSION_ID ?? "session_stub";
const logPath = process.env.KIMI_STUB_LOG;
let activePrompt;
let pendingPermission;

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function update(updateValue) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: updateValue } });
}

function finishPrompt(text = "done") {
  const prompt = activePrompt;
  if (!prompt) return;
  activePrompt = undefined;
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  response(prompt.id, { stopReason: "end_turn" });
}

const configOptions = [
  {
    id: "model",
    currentValue: "kimi-code/k3",
    options: [
      { value: "kimi-code/k3", name: "K3" },
      { value: "kimi-code/kimi-for-coding", name: "Kimi for Coding" },
      { value: "kimi-code/kimi-for-coding-highspeed", name: "Kimi for Coding Highspeed" },
    ],
  },
  {
    id: "mode",
    currentValue: "default",
    options: ["default", "plan", "auto", "yolo"].map((value) => ({ value, name: value })),
  },
];

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
      agentCapabilities: { loadSession: true },
      sessionCapabilities: { resume: {} },
      agentInfo: { name: "Kimi ACP Stub", version: "1" },
    });
    return;
  }
  if (message.method === "session/new" || message.method === "session/resume") {
    response(message.id, { sessionId: message.params?.sessionId ?? sessionId, configOptions });
    return;
  }
  if (message.method === "session/set_config_option") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: configOptions.map((option) => option.id === message.params?.configId
            ? { ...option, currentValue: message.params?.value }
            : option),
        },
      },
    });
    response(message.id, {});
    return;
  }
  if (message.method === "session/prompt") {
    const text = message.params?.prompt?.[0]?.text ?? "";
    activePrompt = { id: message.id, text };
    if (text === "auth-fail") {
      activePrompt = undefined;
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Login required", data: { code: "auth.login_required", message: "Login required" } } });
      return;
    }
    if (text === "permission") {
      update({ sessionUpdate: "tool_call", toolCallId: "tool-permission", title: "Bash", kind: "execute", status: "pending", rawInput: { command: "pwd" } });
      pendingPermission = { id: 700, kind: "permission" };
      send({
        jsonrpc: "2.0",
        id: 700,
        method: "session/request_permission",
        params: {
          sessionId,
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
          toolCall: { toolCallId: "tool-permission", title: "Bash" },
        },
      });
      return;
    }
    if (text === "question") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-question",
        title: "AskUserQuestion",
        status: "pending",
        rawInput: {
          questions: [{
            question: "Which color?",
            header: "Color",
            options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }],
          }],
        },
      });
      pendingPermission = { id: 701, kind: "question" };
      send({
        jsonrpc: "2.0",
        id: 701,
        method: "session/request_permission",
        params: {
          sessionId,
          options: [
            { optionId: "q0_opt_0", name: "Red", kind: "allow_once" },
            { optionId: "q0_opt_1", name: "Blue", kind: "allow_once" },
            { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
          ],
          toolCall: { toolCallId: "tool-question", title: "AskUserQuestion" },
        },
      });
      return;
    }
    if (text === "tool-boundary") {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before-tool" } });
      setTimeout(() => update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", status: "pending", rawInput: { path: "README.md" } }), 30);
      setTimeout(() => finishPrompt("after-tool"), 70);
      return;
    }
    if (text === "wait-for-cancel") return;
    setTimeout(() => finishPrompt(`reply:${text}`), text === "queue-one" ? 60 : 10);
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
  if (pendingPermission && message.id === pendingPermission.id && "result" in message) {
    const selected = message.result?.outcome?.optionId ?? message.result?.outcome?.outcome;
    pendingPermission = undefined;
    finishPrompt(`answered:${selected}`);
  }
});
