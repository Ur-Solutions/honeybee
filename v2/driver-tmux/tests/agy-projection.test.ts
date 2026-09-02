/**
 * Trimmed, sanitized agy 1.1.24 stream-json captured on 2026-09-02.
 * Source captures: /tmp/agy-fixtures/two-turn-tooluse.jsonl,
 * /tmp/agy-fixtures/tooluse-skip-perms.jsonl, and auth-error.jsonl.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgyProjector } from "../src/agy-projection.ts";
import type { TranscriptProjectedEvent } from "../src/transcript-projection.ts";
import {
  agyTranscriptRenderer,
  createTranscriptProjector,
  lastAssistantText,
  renderTranscriptLines,
  TRANSCRIPT_RENDERERS,
} from "../src/transcripts.ts";

const SESSION_ID = "agy-recorded-session";
const j = (value: unknown): string => JSON.stringify(value);

const USER_LINE = j({
  event: "user",
  message: { content: [{ type: "text", text: "run the command" }] },
});

const TOOL_TURN_FIXTURE = [
  j({
    event: "init",
    conversation_id: SESSION_ID,
    init: { cwd: "/tmp", tools: ["run_command"], permission_mode: "always-proceed" },
  }),
  USER_LINE,
  j({
    event: "step_update",
    step_update: { conversation_id: SESSION_ID, step_index: 0, state: "DONE", step_type: "user_input" },
  }),
  j({
    event: "step_update",
    step_update: {
      conversation_id: SESSION_ID,
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      usage: {
        input_tokens: 15_372,
        output_tokens: 1_013,
        thinking_tokens: 943,
        cache_read_tokens: 0,
        total_tokens: 16_385,
      },
    },
  }),
  j({
    event: "step_update",
    step_update: {
      conversation_id: SESSION_ID,
      step_index: 2,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "echo hello-agy" } },
    },
  }),
  j({
    event: "step_update",
    step_update: {
      conversation_id: SESSION_ID,
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      duration_seconds: 0.042175,
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "echo hello-agy" },
        output: "hello-agy\n",
      },
    },
  }),
  j({
    event: "step_update",
    step_update: {
      conversation_id: SESSION_ID,
      step_index: 3,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "Hi! Ready to build something great today.\n\n`hello-agy`\n",
      usage: {
        input_tokens: 16_474,
        output_tokens: 87,
        thinking_tokens: 72,
        cache_read_tokens: 0,
        total_tokens: 16_561,
      },
    },
  }),
  j({
    event: "result",
    result: {
      conversation_id: SESSION_ID,
      status: "SUCCESS",
      response: "Hi! Ready to build something great today.\n\n`hello-agy`\n",
      duration_seconds: 5.198275,
      num_turns: 1,
      usage: {
        input_tokens: 31_846,
        output_tokens: 1_100,
        thinking_tokens: 1_015,
        cache_read_tokens: 0,
        total_tokens: 32_946,
      },
    },
  }),
] as const;

function project(lines: readonly string[]): TranscriptProjectedEvent[] {
  const projector = createAgyProjector();
  const events = lines.flatMap((line) => projector.pushLine(line));
  events.push(...projector.flush());
  return events;
}

test("agy projector: captured tool turn maps user, tool pair, reply, usage suffix, and result", () => {
  const events = project(TOOL_TURN_FIXTURE);
  assert.deepEqual(events.map((event) => event.kind), [
    "turn_start",
    "message",
    "tool_call",
    "tool_result",
    "message",
    "token_usage",
    "turn_end",
  ]);
  assert.equal(events.every((event) => event.threadId === SESSION_ID), true);

  const user = events[1] as Extract<typeof events[number], { kind: "message" }>;
  assert.deepEqual({ role: user.role, text: user.text }, { role: "user", text: "run the command" });

  const call = events[2] as Extract<typeof events[number], { kind: "tool_call" }>;
  const result = events[3] as Extract<typeof events[number], { kind: "tool_result" }>;
  assert.equal(call.callId, result.callId);
  assert.equal(call.name, "run_command");
  assert.deepEqual(call.input, { CommandLine: "echo hello-agy" });
  assert.equal(result.output, "hello-agy\n");
  assert.equal(result.isError, false);

  const reply = events[4] as Extract<typeof events[number], { kind: "message" }>;
  assert.equal(reply.role, "assistant");
  assert.equal(reply.text, "Hi! Ready to build something great today.\n\n`hello-agy`\n");

  const usage = events[5] as Extract<typeof events[number], { kind: "token_usage" }>;
  assert.equal(usage.scope, "turn");
  assert.equal(usage.providerTurnId, `${SESSION_ID}:1`);
  assert.deepEqual(usage.usage, {
    input: 31_846,
    output: 1_100,
    cacheRead: 0,
    reasoning: 1_015,
    total: 32_946,
  });

  const end = events[6] as Extract<typeof events[number], { kind: "turn_end" }>;
  assert.equal(end.durationMs, 5_198.275);
  assert.equal(end.finishReason, "SUCCESS");
  assert.equal(end.turnId, `${SESSION_ID}:1`);
});

test("agy projector: failed tool without output projects tool_info error", () => {
  const events = project([
    j({
      event: "step_update",
      step_update: {
        conversation_id: SESSION_ID,
        step_index: 8,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "exit 1" } },
      },
    }),
    j({
      event: "step_update",
      step_update: {
        conversation_id: SESSION_ID,
        step_index: 8,
        state: "ERROR",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", error: "command failed" },
      },
    }),
  ]);

  const result = events[1] as Extract<typeof events[number], { kind: "tool_result" }>;
  assert.equal(result.kind, "tool_result");
  assert.equal(result.isError, true);
  assert.equal(result.output, "command failed");
});

test("agy projector: result response is a fallback and never duplicates text_delta", () => {
  const withDelta = project([
    j({ event: "init", conversation_id: SESSION_ID }),
    USER_LINE,
    j({
      event: "step_update",
      step_update: {
        conversation_id: SESSION_ID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "SECOND\n",
      },
    }),
    j({
      event: "result",
      result: { conversation_id: SESSION_ID, status: "SUCCESS", response: "SECOND\n", num_turns: 1 },
    }),
  ]);
  assert.deepEqual(
    withDelta
      .filter((event): event is Extract<typeof event, { kind: "message" }> =>
        event.kind === "message" && event.role === "assistant")
      .map((event) => event.text),
    ["SECOND\n"],
  );

  const resultOnly = project([
    j({ event: "init", conversation_id: SESSION_ID }),
    USER_LINE,
    j({
      event: "result",
      result: { conversation_id: SESSION_ID, status: "SUCCESS", response: "fallback reply", num_turns: 1 },
    }),
  ]);
  assert.deepEqual(
    resultOnly
      .filter((event): event is Extract<typeof event, { kind: "message" }> =>
        event.kind === "message" && event.role === "assistant")
      .map((event) => event.text),
    ["fallback reply"],
  );
});

test("agy projector: agent response fragments emit once when the step completes", () => {
  const projector = createAgyProjector();
  const active = projector.pushLine(j({
    event: "step_update",
    step_update: {
      conversation_id: SESSION_ID,
      step_index: 4,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "SECOND",
    },
  }));
  const done = projector.pushLine(j({
    event: "step_update",
    step_update: {
      conversation_id: SESSION_ID,
      step_index: 4,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "\n",
    },
  }));
  const duplicateDone = projector.pushLine(j({
    event: "step_update",
    step_update: {
      conversation_id: SESSION_ID,
      step_index: 4,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "\n",
    },
  }));

  assert.deepEqual(active, []);
  assert.deepEqual(done, [{
    kind: "message",
    ts: null,
    threadId: SESSION_ID,
    role: "assistant",
    text: "SECOND\n",
    providerEventId: `agy:${SESSION_ID}:4`,
  }]);
  assert.deepEqual(duplicateDone, []);
});

test("agy projector: captured cumulative result usage becomes per-turn usage", () => {
  const events = project([
    j({ event: "init", conversation_id: SESSION_ID }),
    j({
      event: "result",
      result: {
        conversation_id: SESSION_ID,
        status: "CANCELED",
        response: "",
        duration_seconds: 4.208199,
        num_turns: 1,
        usage: {
          input_tokens: 15_365,
          output_tokens: 1_012,
          thinking_tokens: 956,
          cache_read_tokens: 0,
          total_tokens: 16_377,
        },
      },
    }),
    j({
      event: "result",
      result: {
        conversation_id: SESSION_ID,
        status: "SUCCESS",
        response: "SECOND\n",
        duration_seconds: 12.949869,
        num_turns: 2,
        usage: {
          input_tokens: 31_889,
          output_tokens: 3_092,
          thinking_tokens: 3_035,
          cache_read_tokens: 0,
          total_tokens: 34_981,
        },
      },
    }),
  ]);
  const usage = events.filter((event) => event.kind === "token_usage");
  assert.equal(usage.length, 2);
  assert.deepEqual(usage[1]?.usage, {
    input: 16_524,
    output: 2_080,
    cacheRead: 0,
    reasoning: 2_079,
    total: 18_604,
  });
  const ends = events.filter((event) => event.kind === "turn_end");
  assert.equal(ends[0]?.finishReason, "CANCELED");
  assert.equal(ends[0]?.interrupted, true);
  assert.equal(ends[0]?.durationMs, 4_208.199);
  assert.equal(ends[1]?.durationMs, 8_741.67);
});

test("agy projector: resumed cumulative duration waits for a baseline", () => {
  const events = project([
    j({ event: "init", conversation_id: SESSION_ID }),
    j({
      event: "result",
      result: {
        conversation_id: SESSION_ID,
        status: "SUCCESS",
        response: "resumed",
        duration_seconds: 42,
        num_turns: 3,
      },
    }),
    j({
      event: "result",
      result: {
        conversation_id: SESSION_ID,
        status: "SUCCESS",
        response: "next",
        duration_seconds: 47.25,
        num_turns: 4,
      },
    }),
  ]);
  const ends = events.filter((event) => event.kind === "turn_end");
  assert.equal(ends[0]?.durationMs, undefined);
  assert.equal(ends[1]?.durationMs, 5_250);
});

test("agy projector: captured auth error stays visible as an interrupt and terminal result", () => {
  const events = project([
    j({
      event: "result",
      result: {
        conversation_id: "",
        status: "ERROR",
        response: "",
        error: "authentication failed or timed out",
        duration_seconds: 0,
        num_turns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
      },
    }),
  ]);
  assert.deepEqual(events.map((event) => event.kind), ["token_usage", "interrupt", "turn_end"]);
  assert.equal((events[1] as Extract<typeof events[number], { kind: "interrupt" }>).reason, "authentication failed or timed out");
  assert.equal((events[2] as Extract<typeof events[number], { kind: "turn_end" }>).finishReason, "ERROR");
});

test("agy projector: init and known progress are noise; malformed and future events are safe", () => {
  const projector = createAgyProjector();
  assert.deepEqual(projector.pushLine("not json"), []);
  assert.deepEqual(projector.pushLine(j({ event: "init", conversation_id: SESSION_ID })), []);
  assert.deepEqual(projector.pushLine(j({
    event: "step_update",
    step_update: { conversation_id: SESSION_ID, step_index: 0, state: "DONE", step_type: "user_input" },
  })), []);
  assert.deepEqual(projector.pushLine(j({ event: "future_event" })), [
    { kind: "unknown", ts: null, threadId: SESSION_ID, nativeType: "future_event" },
  ]);
  assert.deepEqual(projector.flush(), []);
});

test("agy renderer and projector factory are registered for CLI transcripts", () => {
  assert.equal(TRANSCRIPT_RENDERERS.agy, agyTranscriptRenderer);
  assert.deepEqual(agyTranscriptRenderer.renderLine(USER_LINE), [
    { role: "user", text: "run the command" },
  ]);
  assert.deepEqual(agyTranscriptRenderer.renderLine(TOOL_TURN_FIXTURE[4]), [
    { role: "tool", text: "[tool_use: run_command]" },
  ]);
  assert.deepEqual(agyTranscriptRenderer.renderLine(TOOL_TURN_FIXTURE[5]), [
    { role: "tool", text: "[tool_result]" },
  ]);
  assert.deepEqual(agyTranscriptRenderer.renderLine(TOOL_TURN_FIXTURE[6]), [
    { role: "assistant", text: "Hi! Ready to build something great today.\n\n`hello-agy`\n" },
  ]);
  assert.deepEqual(agyTranscriptRenderer.renderLine(TOOL_TURN_FIXTURE[7]), []);

  const projector = createTranscriptProjector("agy");
  assert.equal(projector.harness, "agy");
  assert.deepEqual(projector.pushLine(TOOL_TURN_FIXTURE[4]).map((event) => event.kind), ["tool_call"]);
});

test("agy CLI rendering shows the user, tools, and reply once; last returns the reply", () => {
  const turns = renderTranscriptLines("agy", TOOL_TURN_FIXTURE);
  assert.deepEqual(turns.map((turn) => turn.role), ["user", "tool", "tool", "assistant"]);
  assert.equal(turns.filter((turn) => turn.role === "assistant").length, 1);
  assert.equal(lastAssistantText(turns), "Hi! Ready to build something great today.\n\n`hello-agy`\n");
});
