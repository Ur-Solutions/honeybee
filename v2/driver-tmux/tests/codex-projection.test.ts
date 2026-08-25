import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createCodexProjector } from "../src/codex-projection.ts";
import { renderTranscriptLines } from "../src/transcripts.ts";
import type { TranscriptProjectedEvent } from "../src/transcript-projection.ts";

const j = (value: unknown): string => JSON.stringify(value);

function project(lines: readonly string[]): TranscriptProjectedEvent[] {
  const projector = createCodexProjector();
  const events = lines.flatMap((line) => projector.pushLine(line));
  events.push(...projector.flush());
  return events;
}

test("codex projector: captured HSR sequence projects one native turn and folded shell events", () => {
  const lines = readFileSync(new URL("./fixtures/codex-hsr-min.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const events = project(lines);

  const starts = events.filter((event) => event.kind === "turn_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.turnId, "01a01f10-70ae-7f03-b1d4-396d8978012a");
  assert.equal(starts[0]?.threadId, "01a01f10-6ea3-7390-a404-116f01372b71");

  const messages = events.filter((event) => event.kind === "message");
  assert.ok(messages.some((event) => event.role === "user" && event.text.includes("the transcript of the codex agent")));
  const assistant = messages.find((event) => event.role === "assistant" && event.text.startsWith("I’ll trace those three bees"));
  assert.ok(assistant);
  assert.equal(assistant.providerEventId, "msg_0c5e5e6009141f68016a86edb7158c8191b91915e2832d962d");

  const shells = events.filter((event) => event.kind === "shell");
  assert.equal(shells.length, 2);
  assert.deepEqual(shells.map((event) => event.status), ["started", "completed"]);
  assert.equal(shells[0]?.callId, shells[1]?.callId);
  assert.equal(shells[1]?.exitCode, 0);
  assert.equal(shells[1]?.durationMs, 55);
  assert.match(shells[1]?.stdout ?? "", /name: apiary-core-work/);
  assert.equal(events.some((event) => event.kind === "tool_call" && event.callId === shells[0]?.callId), false);

  assert.ok(events.length > 0);
  assert.equal(events.every((event) => event.ts != null), true);
  const end = events.find((event) => event.kind === "turn_end");
  assert.ok(end);
  assert.equal(end.turnId, "01a01f10-70ae-7f03-b1d4-396d8978012a");
  assert.equal(end.durationMs, 675392);

  const turns = renderTranscriptLines("codex", lines);
  assert.ok(turns.some((turn) => turn.role === "user" && turn.text.includes("the transcript of the codex agent")));
  assert.ok(turns.some((turn) => turn.role === "assistant" && turn.text.startsWith("I’ll trace those three bees")));
  assert.ok(turns.some((turn) => turn.role === "tool" && turn.text.startsWith("[command:")));
});

test("codex projector: command completion folds fields retained from item/started", () => {
  const projector = createCodexProjector();
  assert.deepEqual(projector.pushLine(j({
    method: "item/started",
    params: {
      item: { type: "commandExecution", id: "exec-partial", command: "npm test", cwd: "/repo" },
      startedAtMs: 1_787_227_578_000,
    },
  })), [{
    kind: "shell",
    ts: new Date(1_787_227_578_000).toISOString(),
    callId: "exec-partial",
    command: "npm test",
    cwd: "/repo",
    status: "started",
  }]);
  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: {
      item: { type: "commandExecution", id: "exec-partial", aggregatedOutput: "ok", exitCode: 0, durationMs: 12 },
      completedAtMs: 1_787_227_578_012,
    },
  })), [{
    kind: "shell",
    ts: new Date(1_787_227_578_012).toISOString(),
    callId: "exec-partial",
    command: "npm test",
    cwd: "/repo",
    stdout: "ok",
    exitCode: 0,
    durationMs: 12,
    status: "completed",
  }]);
});

test("codex projector: item folding covers MCP, files, thinking, compaction, web, and unknown types", () => {
  const projector = createCodexProjector();
  const started = projector.pushLine(j({
    method: "item/started",
    params: {
      item: { type: "mcpToolCall", id: "call-1", invocation: { tool: "self", arguments: { detail: true } } },
      startedAtMs: 1_787_227_578_043,
    },
    emittedAtMs: 1_787_227_578_046,
  }));
  assert.deepEqual(started, [{
    kind: "tool_call",
    ts: new Date(1_787_227_578_043).toISOString(),
    callId: "call-1",
    name: "self",
    input: { detail: true },
  }]);
  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: {
      item: { type: "mcpToolCall", id: "call-1", status: "completed", result: { ok: true } },
      completedAtMs: 1_787_227_578_099,
    },
    emittedAtMs: 1_787_227_578_100,
  })), [{
    kind: "tool_result",
    ts: new Date(1_787_227_578_099).toISOString(),
    callId: "call-1",
    isError: false,
    output: '{"ok":true}',
  }]);

  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: { item: {
      type: "fileChange",
      id: "edit-1",
      changes: [
        { path: "src/a.ts", kind: { type: "update" }, diff: "@@ diff" },
        { path: "src/b.ts", kind: { type: "move" }, move: "src/c.ts" },
      ],
    } },
    emittedAtMs: 1_787_227_578_110,
  })), [{
    kind: "file_edit",
    ts: new Date(1_787_227_578_110).toISOString(),
    callId: "edit-1",
    files: [
      { path: "src/a.ts", changeKind: "update", diff: "@@ diff" },
      { path: "src/b.ts", changeKind: "move", oldPath: "src/c.ts" },
    ],
  }]);

  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: { item: { type: "reasoning", id: "r1", summary: [] } },
    emittedAtMs: 1_787_227_578_120,
  })), [{ kind: "thinking", ts: new Date(1_787_227_578_120).toISOString(), redacted: true }]);
  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: { item: { type: "reasoning", id: "r2", summary: [{ type: "summary_text", text: "Checked the state" }] } },
    emittedAtMs: 1_787_227_578_130,
  })), [{ kind: "thinking", ts: new Date(1_787_227_578_130).toISOString(), redacted: false, text: "Checked the state" }]);
  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: { item: { type: "contextCompaction", id: "compact-1", trigger: "auto" } },
    emittedAtMs: 1_787_227_578_140,
  })), [{ kind: "compaction", ts: new Date(1_787_227_578_140).toISOString(), trigger: "auto" }]);
  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: { item: { type: "webSearch", id: "web-1", query: "Honeybee" } },
    emittedAtMs: 1_787_227_578_150,
  })), [{
    kind: "web_search",
    ts: new Date(1_787_227_578_150).toISOString(),
    itemId: "web-1",
    providerEventId: "web-1",
    query: "Honeybee",
  }]);
  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: { item: { type: "futureCodexItem", id: "future-1" } },
    emittedAtMs: 1_787_227_578_160,
  })), [{
    kind: "unknown",
    ts: new Date(1_787_227_578_160).toISOString(),
    nativeType: "futureCodexItem",
  }]);
});

test("codex projector: MCP completion without a start emits call then result", () => {
  const projector = createCodexProjector();
  assert.deepEqual(projector.pushLine(j({
    method: "item/completed",
    params: {
      item: { type: "mcpToolCall", id: "orphan-1", tool: "lookup", arguments: { q: "x" }, result: "hit" },
      completedAtMs: 1_787_227_578_180,
    },
  })), [
    {
      kind: "tool_call",
      ts: new Date(1_787_227_578_180).toISOString(),
      callId: "orphan-1",
      name: "lookup",
      input: { q: "x" },
    },
    {
      kind: "tool_result",
      ts: new Date(1_787_227_578_180).toISOString(),
      callId: "orphan-1",
      isError: false,
      output: "hit",
    },
  ]);
});

test("codex projector: empty commentary and app-server protocol noise emit nothing", () => {
  const projector = createCodexProjector();
  const noise = [
    { method: "account/rateLimits/updated", params: { rateLimits: {} }, emittedAtMs: 1 },
    { method: "item/agentMessage/delta", params: { delta: "partial" }, emittedAtMs: 2 },
    { method: "item/completed", params: { item: { type: "agentMessage", id: "empty", text: "   ", phase: "commentary" } }, emittedAtMs: 4 },
  ];
  for (const row of noise) assert.deepEqual(projector.pushLine(j(row)), []);
});

test("codex projector: thread/fork response replays inherited turns once", () => {
  const projector = createCodexProjector();
  assert.deepEqual(projector.pushLine(j({
    jsonrpc: "2.0",
    id: 9,
    method: "thread/fork",
    params: { threadId: "thread-parent" },
  })), []);

  const events = projector.pushLine(j({
    id: 9,
    result: {
      thread: {
        id: "thread-child",
        turns: [{
          id: "turn-parent-1",
          startedAt: 1_787_227_578,
          completedAt: 1_787_227_580,
          durationMs: 2_000,
          status: "completed",
          items: [
            { type: "userMessage", id: "user-1", content: [{ type: "text", text: "before the fork" }] },
            { type: "agentMessage", id: "assistant-1", text: "inherited answer" },
            { type: "mcpToolCall", id: "tool-1", tool: "self", arguments: {}, result: "ok", status: "completed" },
          ],
        }],
      },
    },
  }));

  assert.deepEqual(events.map((event) => event.kind), [
    "turn_start",
    "message",
    "message",
    "tool_call",
    "tool_result",
    "turn_end",
  ]);
  assert.equal(events.every((event) => event.threadId === "thread-child"), true);
  assert.equal(events[0]?.ts, new Date(1_787_227_578_000).toISOString());
  const end = events.at(-1);
  assert.equal(end?.ts, new Date(1_787_227_580_000).toISOString());
  assert.equal(end?.kind === "turn_end" && end.durationMs, 2_000);
  const inherited = events.filter((event) => event.kind === "message");
  assert.deepEqual(inherited.map((event) => [event.role, event.text, event.providerEventId]), [
    ["user", "before the fork", "user-1"],
    ["assistant", "inherited answer", "assistant-1"],
  ]);

  // The request correlation is consumed: a duplicate/unrelated response
  // cannot replay the inherited prefix a second time.
  assert.deepEqual(projector.pushLine(j({ id: 9, result: { thread: { turns: [] } } })), []);
  assert.deepEqual(projector.pushLine(j({
    id: 10,
    result: { thread: { id: "resumed", turns: [{ id: "old", items: [] }] } },
  })), []);
});

test("codex projector: interrupted turn completion is an end only and never re-renders nested items", () => {
  const projector = createCodexProjector();
  assert.deepEqual(projector.pushLine(j({
    method: "turn/completed",
    params: {
      turn: {
        id: "turn-interrupted",
        status: "interrupted",
        durationMs: 42,
        items: [{ type: "agentMessage", id: "nested", text: "do not replay" }],
      },
    },
    emittedAtMs: 1_787_227_578_200,
  })), [{
    kind: "turn_end",
    ts: new Date(1_787_227_578_200).toISOString(),
    turnId: "turn-interrupted",
    durationMs: 42,
    finishReason: "interrupted",
    interrupted: true,
  }]);
});

test("codex projector: native rollout messages and tools remain projected without duplicate copies", () => {
  const events = project([
    j({ timestamp: "2026-08-20T10:00:00Z", type: "event_msg", payload: { type: "task_started" } }),
    j({ timestamp: "2026-08-20T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "do it" }] } }),
    j({ timestamp: "2026-08-20T10:00:02Z", type: "event_msg", payload: { type: "user_message", message: "do it" } }),
    j({ timestamp: "2026-08-20T10:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", id: "msg-1", content: [{ type: "output_text", text: "done" }] } }),
    j({ timestamp: "2026-08-20T10:00:04Z", type: "event_msg", payload: { type: "agent_message", message: "done" } }),
    j({ timestamp: "2026-08-20T10:00:05Z", type: "response_item", payload: { type: "function_call", call_id: "tool-1", name: "shell", arguments: "{}" } }),
    j({ timestamp: "2026-08-20T10:00:06Z", type: "response_item", payload: { type: "function_call_output", call_id: "tool-1", output: "ok" } }),
    j({ timestamp: "2026-08-20T10:00:07Z", type: "event_msg", payload: { type: "task_complete" } }),
  ]);
  assert.equal(events.filter((event) => event.kind === "turn_start").length, 1);
  assert.deepEqual(
    events.filter((event) => event.kind === "message").map((event) => [event.role, event.text]),
    [["user", "do it"], ["assistant", "done"]],
  );
  assert.ok(events.some((event) => event.kind === "tool_call" && event.callId === "tool-1"));
  assert.ok(events.some((event) => event.kind === "tool_result" && event.callId === "tool-1"));
  assert.equal(events.filter((event) => event.kind === "turn_end").length, 1);
});

test("codex projector: app-server tokenUsage.total becomes cumulative usage with uncached input and the thread model", () => {
  const p = createCodexProjector();
  assert.deepEqual(p.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { model: "gpt-5.6-luna", cwd: "/w" } })), []);
  const events = p.pushLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "t-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 17894, inputTokens: 17699, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 195, reasoningOutputTokens: 24 },
        last: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
      },
    },
  }));
  assert.equal(events.length, 1);
  const usage = events[0] as Extract<typeof events[number], { kind: "token_usage" }>;
  assert.equal(usage.scope, "cumulative");
  assert.equal(usage.threadId, "t-1");
  assert.equal(usage.model, "gpt-5.6-luna");
  assert.deepEqual(usage.usage, { input: 16699, output: 195, cacheRead: 1000, cacheWrite: 0, reasoning: 24, total: 17894 });
});
