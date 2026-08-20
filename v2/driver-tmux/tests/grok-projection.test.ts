import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGrokProjector } from "../src/grok-projection.ts";
import type { TranscriptProjectedEvent } from "../src/transcript-projection.ts";
import { lastAssistantText, type TranscriptTurn } from "../src/transcripts.ts";

const fixtureLines = readFileSync(new URL("./fixtures/grok-acp-chunks.jsonl", import.meta.url), "utf8")
  .trimEnd()
  .split("\n");

const j = (value: unknown): string => JSON.stringify(value);

function project(lines: readonly string[]): TranscriptProjectedEvent[] {
  const projector = createGrokProjector();
  const events = lines.flatMap((line) => projector.pushLine(line));
  events.push(...projector.flush());
  return events;
}

function flatten(events: readonly TranscriptProjectedEvent[]): TranscriptTurn[] {
  return events.flatMap((event): TranscriptTurn[] => {
    if (event.kind === "message") {
      return [{ role: event.role === "developer" ? "system" : event.role, text: event.text }];
    }
    if (event.kind === "tool_call") return [{ role: "tool", text: `[tool_use: ${event.name}]` }];
    if (event.kind === "tool_result") return [{ role: "tool", text: "[tool_result]" }];
    return [];
  });
}

test("grok projector: captured ACP chunks assemble into one assistant message", () => {
  const events = project(fixtureLines);
  const messages = events.filter((event) => event.kind === "message");
  const assistant = messages.filter((event) => event.role === "assistant");
  const user = messages.filter((event) => event.role === "user");

  assert.deepEqual(user.map((event) => event.text), ["(truncated operator prompt)"]);
  assert.deepEqual(assistant.map((event) => event.text), [
    "I'll start by loading the Apiary architecture contract and calling live",
  ]);
  assert.equal(events.filter((event) => event.kind === "tool_call").length, 1);
  const starts = events.filter((event) => event.kind === "turn_start");
  assert.equal(starts.length, 1);
  assert.equal(events.findIndex((event) => event.kind === "turn_start")
    < events.findIndex((event) => event.kind === "message" && event.role === "user"), true);
});

test("grok projector: user message chunks coalesce into one message", () => {
  const events = project([
    j({ method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { text: "hello" } } } }),
    j({ method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { text: " world" } } } }),
  ]);
  assert.deepEqual(events, [
    { kind: "message", ts: null, role: "user", text: "hello world" },
  ]);
});

test("grok projector: tool updates fold into one call and completion uses the same callId", () => {
  const callId = "call-1";
  const events = project([
    j({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: "read_file",
          rawInput: { path: "README.md" },
          status: "pending",
        },
      },
    }),
    j({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          title: "Read README.md",
          rawInput: { path: "README.md" },
          status: "completed",
          result: { content: [{ type: "text", text: "contents" }] },
        },
      },
    }),
  ]);

  const calls = events.filter((event) => event.kind === "tool_call");
  const results = events.filter((event) => event.kind === "tool_result");
  assert.equal(calls.length, 1, "tool_call_update must not create a second call");
  assert.equal(calls[0]?.callId, callId);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.callId, callId);
  assert.equal(results[0]?.output, "contents");
  assert.equal(results[0]?.isError, false);
});

test("grok projector: flush emits an otherwise-open chunk buffer", () => {
  const projector = createGrokProjector();
  assert.deepEqual(projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still" } } },
  })), []);
  assert.deepEqual(projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " open" } } },
  })), []);
  assert.deepEqual(projector.flush(), [
    { kind: "message", ts: null, role: "assistant", text: "still open" },
  ]);
  assert.deepEqual(projector.flush(), []);
});

test("grok projector: prompt_complete flushes the open assistant message", () => {
  const projector = createGrokProjector();
  assert.deepEqual(projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } },
  })), []);
  assert.deepEqual(projector.pushLine(j({
    method: "_x.ai/session/prompt_complete",
    params: { sessionId: "s" },
  })), [
    { kind: "message", ts: null, role: "assistant", text: "done" },
    { kind: "turn_end", ts: null },
  ]);
  assert.deepEqual(projector.flush(), []);
});

test("grok projector: session/prompt emits turn_start before the user message", () => {
  assert.deepEqual(project([
    j({ method: "session/prompt", params: { prompt: [{ type: "text", text: "do the thing" }] } }),
  ]), [
    { kind: "turn_start", ts: null },
    { kind: "message", ts: null, role: "user", text: "do the thing" },
  ]);
});

test("grok projector: session/update turn_completed ends the turn after flushing", () => {
  const projector = createGrokProjector();
  projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } } },
  }));
  assert.deepEqual(projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "turn_completed" } },
  })), [
    { kind: "message", ts: null, role: "assistant", text: "ok" },
    { kind: "turn_end", ts: null },
  ]);
});

test("grok projector: unrecognized methods and non-boundary updates do not flush open chunks", () => {
  const projector = createGrokProjector();
  assert.deepEqual(projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } },
  })), []);
  assert.deepEqual(projector.pushLine(j({
    jsonrpc: "2.0",
    id: 9,
    method: "fs/read_text_file",
    params: { path: "/tmp/x" },
  })), []);
  assert.deepEqual(projector.pushLine(j({
    jsonrpc: "2.0",
    method: "initialize",
    params: {},
  })), []);
  assert.deepEqual(projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "available_commands_update", availableCommands: [] } },
  })), []);
  assert.deepEqual(projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } } },
  })), []);
  assert.deepEqual(projector.flush(), [
    { kind: "message", ts: null, role: "assistant", text: "Hello world" },
  ]);
});

test("grok projector: thinking chunks coalesce and native chat_history shapes remain supported", () => {
  const events = project([
    j({ method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "think" } } } }),
    j({ method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "ing" } } } }),
    j({ type: "assistant", uuid: "native-1", timestamp: "2026-08-20T10:00:00Z", content: [{ type: "text", text: "native" }] }),
    j({ type: "user", content: "hidden", synthetic_reason: "system_reminder" }),
  ]);

  assert.deepEqual(events.filter((event) => event.kind === "thinking"), [
    { kind: "thinking", ts: null, redacted: false, text: "thinking" },
  ]);
  assert.deepEqual(events.filter((event) => event.kind === "message"), [
    {
      kind: "message",
      ts: "2026-08-20T10:00:00.000Z",
      role: "assistant",
      text: "native",
      providerEventId: "native-1",
    },
  ]);
});

test("grok projector: redacted thinking requires redacted=true and omits text", () => {
  const events = project([
    j({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          redacted: true,
          content: { type: "text", text: "must not leak" },
        },
      },
    }),
  ]);

  assert.deepEqual(events, [{ kind: "thinking", ts: null, redacted: true }]);
  assert.equal("text" in (events[0] ?? {}), false);
});

test("grok projector: project-then-flatten preserves the full last assistant text", () => {
  const turns = flatten(project(fixtureLines));
  assert.equal(
    lastAssistantText(turns),
    "I'll start by loading the Apiary architecture contract and calling live",
  );
});
