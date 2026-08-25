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

test("grok projector: session/prompt suppresses Grok's echoed user chunks once", () => {
  const prompt = "Apiary preamble\n\nPlease inspect the workspace.";
  const events = project([
    j({ method: "session/prompt", params: { prompt: [{ type: "text", text: prompt }] } }),
    j({ method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { text: "Apiary preamble\n\n" } } } }),
    j({ method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { text: "Please inspect the workspace." } } } }),
    j({ method: "session/update", params: { update: { sessionUpdate: "user_message", content: { text: prompt } } } }),
  ]);

  assert.deepEqual(events.filter((event) => event.kind === "message"), [
    { kind: "message", ts: null, role: "user", text: prompt },
    { kind: "message", ts: null, role: "user", text: prompt },
  ]);
});

test("grok projector: a mismatched user chunk is not mistaken for a prompt mirror", () => {
  const events = project([
    j({ method: "session/prompt", params: { prompt: [{ type: "text", text: "first" }] } }),
    j({ method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { text: "second" } } } }),
  ]);

  assert.deepEqual(events.filter((event) => event.kind === "message"), [
    { kind: "message", ts: null, role: "user", text: "first" },
    { kind: "message", ts: null, role: "user", text: "second" },
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

test("grok projector: auto compaction flushes the prior chunk and preserves token counts", () => {
  const projector = createGrokProjector();
  assert.deepEqual(projector.pushLine(j({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before" } } },
  })), []);
  assert.deepEqual(projector.pushLine(j({
    method: "_x.ai/session_notification",
    params: {
      update: {
        sessionUpdate: "auto_compact_started",
        tokens_used: 400_799,
        context_window: 500_000,
      },
    },
  })), []);
  assert.deepEqual(projector.pushLine(j({
    method: "_x.ai/session_notification",
    params: {
      update: {
        sessionUpdate: "auto_compact_completed",
        tokens_before: 400_799,
        tokens_after: 17_202,
      },
      _meta: { agentTimestampMs: 1_000, eventId: "compact-1" },
    },
  })), [
    { kind: "message", ts: null, role: "assistant", text: "before" },
    {
      kind: "compaction",
      ts: "1970-01-01T00:00:01.000Z",
      tokensBefore: 400_799,
      tokensAfter: 17_202,
    },
  ]);
  assert.deepEqual(projector.pushLine(j({
    method: "_x.ai/session/update",
    params: {
      update: {
        sessionUpdate: "auto_compact_completed",
        tokens_before: 400_799,
        tokens_after: 17_202,
      },
      _meta: { agentTimestampMs: 1_000, eventId: "compact-1" },
    },
  })), []);
});

test("grok projector: generated continuation summary is a boundary, not a user message", () => {
  const continuation = [
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
    "",
    "Summary:",
    "1. The user asked to fix Grok compaction rendering.",
  ].join("\n");
  const events = project([
    j({ type: "user", content: [{ type: "text", text: continuation }] }),
    j({ type: "user", content: `Please quote this phrase: ${continuation}` }),
  ]);

  assert.deepEqual(events, [
    { kind: "compaction", ts: null },
    {
      kind: "message",
      ts: null,
      role: "user",
      text: `Please quote this phrase: ${continuation}`,
    },
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

test("grok projector: turn_completed usage is projected turn-scoped with uncached input, prompt id, and model", () => {
  const p = createGrokProjector();
  const events = p.pushLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "_x.ai/session_notification",
    params: {
      sessionId: "s-1",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-9",
        stop_reason: "end_turn",
        usage: {
          inputTokens: 250645, outputTokens: 2196, totalTokens: 252841, cachedReadTokens: 227456,
          cacheCreationTokens: 0, reasoningTokens: 1786, modelCalls: 9,
          modelUsage: { "grok-4.6-build": { totalTokens: 252841 } },
        },
      },
    },
  }));
  assert.deepEqual(events.map((e) => e.kind), ["token_usage", "turn_end"]);
  const usage = events[0] as Extract<typeof events[number], { kind: "token_usage" }>;
  assert.equal(usage.scope, "turn");
  assert.equal(usage.providerTurnId, "prompt-9");
  assert.equal(usage.model, "grok-4.6-build");
  assert.deepEqual(usage.usage, { input: 23189, output: 2196, cacheRead: 227456, cacheWrite: 0, reasoning: 1786, total: 252841 });
});
