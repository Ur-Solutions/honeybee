/**
 * Observation-source parsers: per-harness transcript formats (fixture lines
 * matching the v1 tree's recorded shapes) + the driver-owned events-file
 * contract (claude-hook / codex-notify / generic shapes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventsFileLine } from "../src/events-file.ts";
import {
  claudeProjectKey,
  claudeTranscriptParser,
  codexTranscriptParser,
  codexTranscriptRenderer,
  grokTranscriptParser,
  grokTranscriptRenderer,
} from "../src/transcripts.ts";

const j = (o: unknown): string => JSON.stringify(o);

test("parsers.claude: user rows start turns; sidechain/meta/tool rows do not; assistant rows are output", () => {
  const p = claudeTranscriptParser;
  assert.equal(p.explicitTurnEnd, false); // no end record exists in the file format
  assert.deepEqual(
    p.parseLine(j({ type: "user", timestamp: "2026-08-17T10:00:00Z", sessionId: "s1", message: { role: "user", content: "do the thing" } })),
    [{ kind: "turn_started" }],
  );
  assert.deepEqual(
    p.parseLine(j({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } })),
    [{ kind: "turn_started" }],
  );
  // Tool-result carrier user rows (no text block) do NOT start a turn.
  assert.deepEqual(
    p.parseLine(j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } })),
    [],
  );
  // Sidechain (sub-agent) and meta rows never count.
  assert.deepEqual(p.parseLine(j({ type: "user", isSidechain: true, message: { role: "user", content: "x" } })), []);
  assert.deepEqual(p.parseLine(j({ type: "user", isMeta: true, message: { role: "user", content: "x" } })), []);
  assert.deepEqual(
    p.parseLine(j({ type: "assistant", message: { role: "assistant", model: "c", content: [{ type: "text", text: "done" }] } })),
    [{ kind: "output" }],
  );
  assert.deepEqual(p.parseLine(j({ type: "summary", summary: "s" })), []);
  assert.deepEqual(p.parseLine("not json {"), []);
});

test("parsers.claude: project key derivation matches the v1 rule", () => {
  assert.equal(claudeProjectKey("/Users/u/Code/my.app"), "-Users-u-Code-my-app");
});

test("renderer.codex: hsr app-server envelope (item/completed) renders alongside the rollout shape", () => {
  const r = codexTranscriptRenderer;
  // hsr session logs record jsonrpc notifications, not rollout rows
  // (2026-08-19 soak: `last`/`transcript` were blind to hsr codex output).
  assert.deepEqual(
    r.renderLine(j({ method: "item/completed", params: { item: { type: "agentMessage", id: "m1", text: "NECTAR" } } })),
    [{ role: "assistant", text: "NECTAR" }],
  );
  assert.deepEqual(
    r.renderLine(
      j({
        method: "item/completed",
        params: { item: { type: "userMessage", content: [{ type: "text", text: "do it" }] } },
      }),
    ),
    [{ role: "user", text: "do it" }],
  );
  assert.deepEqual(
    r.renderLine(j({ method: "item/completed", params: { item: { type: "commandExecution", command: "ls -la" } } })),
    [{ role: "tool", text: "[command: ls -la]" }],
  );
  assert.deepEqual(
    r.renderLine(j({ method: "item/completed", params: { item: { type: "mcpToolCall", invocation: { tool: "self" } } } })),
    [{ role: "tool", text: "[tool_use: self]" }],
  );
  // reasoning elided; turn/completed re-lists items and must NOT duplicate
  assert.deepEqual(r.renderLine(j({ method: "item/completed", params: { item: { type: "reasoning", content: [] } } })), []);
  assert.deepEqual(
    r.renderLine(j({ method: "turn/completed", params: { turn: { items: [{ type: "agentMessage", text: "NECTAR" }] } } })),
    [],
  );
  // rollout shape still renders
  assert.deepEqual(
    r.renderLine(j({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } })),
    [{ role: "assistant", text: "hi" }],
  );
});

test("parsers.codex: turn_context/task_started start, task_complete ends explicitly, messages are output", () => {
  const p = codexTranscriptParser;
  assert.equal(p.explicitTurnEnd, true);
  assert.deepEqual(p.parseLine(j({ timestamp: "t", type: "turn_context", payload: { model: "o3" } })), [
    { kind: "turn_started" },
  ]);
  assert.deepEqual(p.parseLine(j({ type: "event_msg", payload: { type: "task_started" } })), [
    { kind: "turn_started" },
  ]);
  assert.deepEqual(p.parseLine(j({ type: "event_msg", payload: { type: "task_complete" } })), [
    { kind: "turn_ended" },
  ]);
  assert.deepEqual(p.parseLine(j({ type: "event_msg", payload: { type: "agent_message", message: "hi" } })), [
    { kind: "output" },
  ]);
  assert.deepEqual(
    p.parseLine(j({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] } })),
    [{ kind: "output" }],
  );
  // user response_items are the turn's own input, not a second start.
  assert.deepEqual(
    p.parseLine(j({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x" }] } })),
    [],
  );
  assert.deepEqual(p.parseLine(j({ type: "session_meta", payload: { id: "s" } })), []);
});

test("parsers.grok: chat_history rows (v1 fixture shapes) — user starts, assistant is output", () => {
  const p = grokTranscriptParser;
  assert.equal(p.explicitTurnEnd, false);
  assert.deepEqual(p.parseLine(j({ type: "user", content: [{ type: "text", text: "hello" }] })), [
    { kind: "turn_started" },
  ]);
  assert.deepEqual(p.parseLine(j({ type: "assistant", content: "answer" })), [{ kind: "output" }]);
  // message.role variant
  assert.deepEqual(p.parseLine(j({ message: { role: "user", content: "hello" } })), [{ kind: "turn_started" }]);
  assert.deepEqual(p.parseLine(j({ message: { role: "assistant", content: "x" } })), [{ kind: "output" }]);
  assert.deepEqual(p.parseLine(j({ type: "system", content: "boot" })), []);
  // Live-file shapes (2026-08-17): synthetic user rows (injected reminders /
  // task notifications) must NOT start a turn — they can arrive while idle
  // with no response following, which would open a turn that never ends.
  assert.deepEqual(
    p.parseLine(
      j({ type: "user", content: [{ type: "text", text: "<system-reminder>…</system-reminder>" }], synthetic_reason: "system_reminder" }),
    ),
    [],
  );
  assert.deepEqual(
    p.parseLine(j({ type: "user", content: [{ type: "text", text: "task done" }], synthetic_reason: "task_completed" })),
    [],
  );
  // reasoning rows (live shape) are neither user nor assistant — ignored.
  assert.deepEqual(p.parseLine(j({ type: "reasoning", summary: [{ type: "summary_text", text: "…" }] })), []);
});

test("renderers.grok: hsr ACP session/update chunks render as assistant text", () => {
  const r = grokTranscriptRenderer;
  assert.deepEqual(
    r.renderLine(j({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } },
    })),
    [{ role: "assistant", text: "hello" }],
  );
  assert.deepEqual(
    r.renderLine(j({
      jsonrpc: "2.0",
      method: "session/prompt",
      params: { sessionId: "s", prompt: [{ type: "text", text: "do the thing" }] },
    })),
    [{ role: "user", text: "do the thing" }],
  );
  assert.deepEqual(r.renderLine(j({ type: "assistant", content: "from chat_history" })), [
    { role: "assistant", text: "from chat_history" },
  ]);
});

test("parsers.events-file: claude-hook, codex-notify and generic shapes normalize identically", () => {
  // claude hook payload shapes (hook stdin JSON, appended verbatim)
  assert.deepEqual(parseEventsFileLine(j({ hook_event_name: "UserPromptSubmit", session_id: "s" })), [
    { kind: "turn_started" },
  ]);
  assert.deepEqual(parseEventsFileLine(j({ hook_event_name: "Stop", session_id: "s" })), [{ kind: "turn_ended" }]);
  assert.deepEqual(parseEventsFileLine(j({ hook_event_name: "Notification", message: "needs permission" })), [
    { kind: "output" },
  ]);
  assert.deepEqual(parseEventsFileLine(j({ hook_event_name: "PreToolUse" })), []);
  // codex notify payload
  assert.deepEqual(parseEventsFileLine(j({ type: "agent-turn-complete", "turn-id": "t1" })), [
    { kind: "turn_ended" },
  ]);
  // generic v2 shape
  assert.deepEqual(parseEventsFileLine(j({ event: "turn_started" })), [{ kind: "turn_started" }]);
  assert.deepEqual(parseEventsFileLine(j({ event: "turn_ended" })), [{ kind: "turn_ended" }]);
  assert.deepEqual(parseEventsFileLine("garbage"), []);
});
