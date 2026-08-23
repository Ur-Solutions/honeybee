import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeProjector } from "../src/claude-projection.ts";
import { createTranscriptProjector } from "../src/transcripts.ts";

const line = (value: unknown): string => JSON.stringify(value);

test("claude projector: a full turn — prompt, thinking, tool pair, reply, result", () => {
  const p = createClaudeProjector();
  const events = [
    ...p.pushLine(line({ type: "user", uuid: "u-1", message: { role: "user", content: "run the tests" } })),
    ...p.pushLine(line({
      type: "assistant",
      uuid: "a-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should run vitest.", signature: "sig" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm vitest run" } },
        ],
      },
    })),
    ...p.pushLine(line({
      type: "user",
      uuid: "u-2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "5 passed" }] }] },
    })),
    ...p.pushLine(line({
      type: "assistant",
      uuid: "a-2",
      message: { role: "assistant", content: [{ type: "text", text: "All green." }] },
    })),
    ...p.pushLine(line({
      type: "result", subtype: "success", stop_reason: "end_turn", duration_ms: 4200,
      usage: { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 9000 },
    })),
    ...p.flush(),
  ];
  assert.deepEqual(events.map((e) => e.kind), [
    "turn_start", "message", "thinking", "tool_call", "tool_result", "message", "token_usage", "turn_end",
  ]);
  const call = events[3] as Extract<typeof events[number], { kind: "tool_call" }>;
  assert.equal(call.callId, "toolu_1");
  assert.equal(call.name, "Bash");
  const result = events[4] as Extract<typeof events[number], { kind: "tool_result" }>;
  assert.equal(result.callId, "toolu_1");
  assert.equal(result.isError, false);
  assert.equal(result.output, "5 passed");
  const usage = events[6] as Extract<typeof events[number], { kind: "token_usage" }>;
  assert.deepEqual(usage.usage, { input: 12, output: 340, cacheRead: 9000 });
  const end = events[7] as Extract<typeof events[number], { kind: "turn_end" }>;
  assert.equal(end.durationMs, 4200);
  assert.equal(end.finishReason, "end_turn");
});

test("claude projector: redacted thinking, meta users, and protocol noise", () => {
  const p = createClaudeProjector();
  assert.deepEqual(
    p.pushLine(line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "opaque" }] },
    })),
    [{ kind: "thinking", ts: null, redacted: true }],
  );
  // Meta user lines never open a turn; noise projects to nothing.
  assert.deepEqual(p.pushLine(line({ type: "user", isMeta: true, message: { content: "injected" } })), []);
  assert.deepEqual(p.pushLine(line({ type: "system", subtype: "task_progress", task_id: "t" })), []);
  assert.deepEqual(p.pushLine(line({ type: "rate_limit_event", rate_limit_info: {} })), []);
  assert.deepEqual(p.pushLine(line({ type: "tool_progress", tool_use_id: "x" })), []);
  // Genuinely unrecognized record types stay visible as unknown.
  assert.deepEqual(p.pushLine(line({ type: "mystery_record" })), [
    { kind: "unknown", ts: null, nativeType: "mystery_record" },
  ]);
  // Error tool results carry the flag.
  const errored = p.pushLine(line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", is_error: true, content: "boom" }] },
  }));
  assert.deepEqual(errored, [
    { kind: "tool_result", ts: null, callId: "toolu_9", isError: true, output: "boom" },
  ]);
});

test("claude projector: image results stay typed and their synthetic dimensions echo stays hidden", () => {
  const p = createClaudeProjector();
  const imageData = "iVBORw0KGgo=";
  const result = p.pushLine(line({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_image",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: imageData },
        }],
      }],
    },
  }));
  assert.deepEqual(result, [{
    kind: "tool_result",
    ts: null,
    callId: "toolu_image",
    isError: false,
    images: [{ data: imageData, mimeType: "image/png" }],
  }]);

  assert.deepEqual(p.pushLine(line({
    type: "user",
    isSynthetic: true,
    message: {
      role: "user",
      content: [{
        type: "text",
        text: "[Image: original 2240x1880, displayed at 2000x1679. Multiply coordinates by 1.12 to map to original image.]",
      }],
    },
  })), []);
});

test("claude projector: registered in the factory (no renderer fallback)", () => {
  const p = createTranscriptProjector("claude");
  const events = p.pushLine(line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Edit", input: { file_path: "a.ts" } }] },
  }));
  assert.deepEqual(events.map((e) => e.kind), ["tool_call"]); // was unknown('rendered_tool')
});
