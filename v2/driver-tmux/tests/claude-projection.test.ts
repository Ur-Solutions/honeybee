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

test("claude projector: assistant message.usage becomes turn-scoped token_usage with providerTurnId", () => {
  const p = createClaudeProjector();
  // Interactive sessions write one line per content block, repeating the SAME
  // message id + usage — every line projects usage; the shared providerTurnId
  // is the consumer's dedupe key.
  const first = p.pushLine(line({
    type: "assistant",
    uuid: "a-10",
    message: {
      id: "msg_01",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_5", name: "Bash", input: {} }],
      usage: { input_tokens: 4, output_tokens: 120, cache_read_input_tokens: 8000, cache_creation_input_tokens: 30 },
    },
  }));
  assert.deepEqual(first.map((e) => e.kind), ["tool_call", "token_usage"]);
  const usage = first[1] as Extract<typeof first[number], { kind: "token_usage" }>;
  assert.equal(usage.scope, "turn");
  assert.equal(usage.providerTurnId, "msg_01");
  assert.deepEqual(usage.usage, { input: 4, output: 120, cacheRead: 8000, cacheWrite: 30 });

  const second = p.pushLine(line({
    type: "assistant",
    uuid: "a-11",
    message: {
      id: "msg_01",
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 4, output_tokens: 120, cache_read_input_tokens: 8000, cache_creation_input_tokens: 30 },
    },
  }));
  assert.deepEqual(second.map((e) => e.kind), ["message", "token_usage"]);
  assert.equal((second[1] as Extract<typeof second[number], { kind: "token_usage" }>).providerTurnId, "msg_01");

  // Usage-only lines (no projectable blocks) still surface the usage.
  const bare = p.pushLine(line({
    type: "assistant",
    uuid: "a-12",
    message: { id: "msg_02", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 2 } },
  }));
  assert.deepEqual(bare.map((e) => e.kind), ["token_usage"]);
});

test("claude projector: usage carries the billed model; result rows carry the harness cost + dominant model", () => {
  const p = createClaudeProjector();
  const assistant = p.pushLine(line({
    type: "assistant",
    message: { id: "msg_7", model: "claude-fable-5", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 2 } },
  }));
  assert.equal((assistant[0] as Extract<typeof assistant[number], { kind: "token_usage" }>).model, "claude-fable-5");
  const result = p.pushLine(line({
    type: "result", subtype: "success", stop_reason: "end_turn", duration_ms: 10, total_cost_usd: 6.25,
    usage: { input_tokens: 1256, output_tokens: 31152, cache_read_input_tokens: 2651307, cache_creation_input_tokens: 101819 },
    modelUsage: {
      "claude-haiku-4-5-20251001": { costUSD: 0.0014, canonicalModel: "claude-haiku-4-5" },
      "claude-fable-5": { costUSD: 6.2486, canonicalModel: "claude-fable-5" },
    },
  }));
  const usage = result[0] as Extract<typeof result[number], { kind: "token_usage" }>;
  assert.equal(usage.kind, "token_usage");
  assert.equal(usage.costUsd, 6.25);
  assert.equal(usage.model, "claude-fable-5");
  assert.equal(usage.providerTurnId, undefined);
});
