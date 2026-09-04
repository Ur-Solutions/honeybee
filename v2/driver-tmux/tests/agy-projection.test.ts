/**
 * Trimmed, sanitized agy 1.1.24 stream-json captured on 2026-09-02.
 * Source captures: /tmp/agy-fixtures/two-turn-tooluse.jsonl,
 * /tmp/agy-fixtures/tooluse-skip-perms.jsonl, and auth-error.jsonl.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgySqliteTail } from "../src/agy-sqlite-tail.ts";
import { createAgyProjector } from "../src/agy-projection.ts";
import type { TranscriptProjectedEvent } from "../src/transcript-projection.ts";
import {
  agyTranscriptRenderer,
  createTranscriptProjector,
  findTranscript,
  lastAssistantText,
  renderTranscriptLines,
  TRANSCRIPT_RENDERERS,
} from "../src/transcripts.ts";

const SESSION_ID = "agy-recorded-session";
const j = (value: unknown): string => JSON.stringify(value);
const AGY_USER_STEP_TYPE = 14;
const AGY_ASSISTANT_STEP_TYPE = 15;
const AGY_ACTIVE_STATUS = 2;
const AGY_DONE_STATUS = 3;

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

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let next = value;
  do {
    let byte = next & 0x7f;
    next = Math.floor(next / 128);
    if (next > 0) byte |= 0x80;
    bytes.push(byte);
  } while (next > 0);
  return Buffer.from(bytes);
}

function messageField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((field * 8) + 2), varint(payload.length), payload]);
}

function stringField(field: number, text: string): Buffer {
  return messageField(field, Buffer.from(text, "utf8"));
}

function userPayload(text: string): Buffer {
  return messageField(19, Buffer.concat([stringField(2, text), messageField(3, stringField(1, text))]));
}

function assistantPayload(text: string): Buffer {
  return messageField(20, Buffer.concat([stringField(1, text), stringField(8, text)]));
}

function makeDb(): { dir: string; path: string; db: DatabaseSync; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hb-agy-sqlite-tail-"));
  const path = join(dir, "conversation-1.db");
  const db = new DatabaseSync(path);
  db.exec(`
    create table trajectory_meta (
      trajectory_id text,
      cascade_id text,
      trajectory_type integer,
      source integer,
      primary key (trajectory_id)
    );
    create table steps (
      idx integer,
      step_type integer not null default 0,
      status integer not null default 0,
      has_subtrajectory numeric not null default false,
      metadata blob,
      error_details blob,
      permissions blob,
      task_details blob,
      render_info blob,
      step_payload blob,
      step_format integer not null default 0,
      primary key (idx)
    );
  `);
  db.prepare("insert into trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) values (?, ?, ?, ?)")
    .run("trajectory-1", "conversation-1", 4, 17);
  return {
    dir,
    path,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function putStep(db: DatabaseSync, idx: number, stepType: number, status: number, payload: Buffer): void {
  db.prepare(`
    insert into steps (idx, step_type, status, step_payload)
    values (?, ?, ?, ?)
    on conflict(idx) do update set
      step_type = excluded.step_type,
      status = excluded.status,
      step_payload = excluded.step_payload
  `).run(idx, stepType, status, payload);
}

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

test("agy projector: flush emits an in-progress assistant response once", () => {
  const projector = createAgyProjector();
  assert.deepEqual(projector.pushLine(j({
    event: "step_update",
    step_update: {
      conversation_id: SESSION_ID,
      step_index: 5,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "reply before crash",
    },
  })), []);
  assert.deepEqual(projector.flush(), [{
    kind: "message",
    ts: null,
    threadId: SESSION_ID,
    role: "assistant",
    text: "reply before crash",
    providerEventId: `agy:${SESSION_ID}:5`,
  }]);
  assert.deepEqual(projector.flush(), []);
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

test("agy projector: missing usage invalidates the cumulative baseline", () => {
  const events = project([
    j({ event: "init", conversation_id: SESSION_ID }),
    j({
      event: "result",
      result: {
        conversation_id: SESSION_ID,
        status: "SUCCESS",
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    }),
    j({
      event: "result",
      result: { conversation_id: SESSION_ID, status: "SUCCESS", num_turns: 2 },
    }),
    j({
      event: "result",
      result: {
        conversation_id: SESSION_ID,
        status: "SUCCESS",
        num_turns: 3,
        usage: { input_tokens: 300, output_tokens: 30, total_tokens: 330 },
      },
    }),
  ]);

  const usage = events.filter((event) => event.kind === "token_usage");
  assert.deepEqual(usage.map((event) => event.usage), [
    { input: 100, output: 10, total: 110 },
    { input: 300, output: 30, total: 330 },
  ]);
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

test("agy sqlite mirror: projects TUI steps into renderable agy stream-json lines", () => {
  const r = makeDb();
  try {
    const tail = new AgySqliteTail(r.path);
    putStep(r.db, 0, AGY_USER_STEP_TYPE, AGY_DONE_STATUS, userPayload("hello tui"));
    putStep(r.db, 1, AGY_ASSISTANT_STEP_TYPE, AGY_ACTIVE_STATUS, assistantPayload("hel"));

    const first = tail.poll();
    assert.equal(JSON.parse(first[0] ?? "{}").event, "init");
    assert.equal(JSON.parse(first[1] ?? "{}").event, "user");
    assert.equal(JSON.parse(first[2] ?? "{}").step_update.text_delta, "hel");

    putStep(r.db, 1, AGY_ASSISTANT_STEP_TYPE, AGY_DONE_STATUS, assistantPayload("hello from sqlite"));
    const second = tail.poll();
    assert.equal(JSON.parse(second[0] ?? "{}").step_update.state, "DONE");
    assert.equal(JSON.parse(second[0] ?? "{}").step_update.text_delta, "lo from sqlite");
    assert.equal(JSON.parse(second[1] ?? "{}").event, "result");
    assert.equal(JSON.parse(second[1] ?? "{}").result.num_turns, 1);

    const turns = renderTranscriptLines("agy", [...first, ...second]);
    assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant"]);
    assert.equal(lastAssistantText(turns), "hello from sqlite");
  } finally {
    r.cleanup();
  }
});

test("agy sqlite mirror: skipExisting suppresses adopted history but emits new steps", () => {
  const r = makeDb();
  try {
    putStep(r.db, 0, AGY_USER_STEP_TYPE, AGY_DONE_STATUS, userPayload("old prompt"));
    putStep(r.db, 1, AGY_ASSISTANT_STEP_TYPE, AGY_DONE_STATUS, assistantPayload("old answer"));
    const tail = new AgySqliteTail(r.path, { skipExisting: true });
    assert.deepEqual(tail.poll(), []);

    putStep(r.db, 2, AGY_USER_STEP_TYPE, AGY_DONE_STATUS, userPayload("new prompt"));
    putStep(r.db, 3, AGY_ASSISTANT_STEP_TYPE, AGY_DONE_STATUS, assistantPayload("new answer"));
    const lines = tail.poll();
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0] ?? "{}").event, "user");
    assert.equal(JSON.parse(lines[1] ?? "{}").event, "step_update");
    assert.equal(JSON.parse(lines[2] ?? "{}").event, "result");
    assert.equal(lastAssistantText(renderTranscriptLines("agy", lines)), "new answer");
  } finally {
    r.cleanup();
  }
});

test("agy sqlite mirror locator: cwd filter checks the WAL sibling before checkpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-agy-sqlite-locator-"));
  try {
    const dbPath = join(dir, "conversation-1.db");
    writeFileSync(dbPath, "sqlite header without workspace yet");
    writeFileSync(`${dbPath}-wal`, "file:///workspaces/agy-project");
    assert.equal(
      findTranscript({
        dir,
        match: /\.db$/,
        depth: 1,
        format: "agy-sqlite",
        containsAny: ["file:///workspaces/agy-project"],
      }, Date.now() - 1_000),
      dbPath,
    );
    assert.equal(
      findTranscript({
        dir,
        match: /\.db$/,
        depth: 1,
        format: "agy-sqlite",
        containsAny: ["file:///other-project"],
      }, Date.now() - 1_000),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
