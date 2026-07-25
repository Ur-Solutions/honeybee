// Pure unit tests for codex thread-copy mechanics: turn enumeration on
// rollout rows (turn_context-grained), truncation with next-turn prelude
// trimming and dangling function_call trim, and thread-id rewrite.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listCodexTurnAnchors,
  rewriteCodexThreadId,
  truncateCodexThread,
} from "../src/threadCopy.js";

const OLD = "019f958d-8371-7531-8ce5-e8a53f8fc603";

function row(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** Mirrors the observed rollout anatomy: two completed turns. */
function sampleLines(): string[] {
  return [
    row({ type: "session_meta", payload: { id: OLD, session_id: OLD } }),
    row({ type: "event_msg", payload: { type: "task_started" } }),
    row({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "text", text: "<permissions>" }] } }),
    row({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "<recommended_plugins>" }] } }),
    row({ type: "world_state", payload: {} }),
    row({ type: "turn_context", payload: {} }),
    row({ type: "response_item", timestamp: "2026-07-24T19:15:10Z", payload: { type: "message", role: "user", content: [{ type: "text", text: "first question" }] } }),
    row({ type: "event_msg", payload: { type: "user_message" } }),
    row({ type: "response_item", payload: { type: "message", role: "assistant", id: "msg_a1", content: [{ type: "text", text: "answer one" }] } }),
    row({ type: "event_msg", payload: { type: "task_complete" } }),
    row({ type: "event_msg", payload: { type: "thread_settings_applied" } }),
    row({ type: "event_msg", payload: { type: "task_started" } }),
    row({ type: "turn_context", payload: {} }),
    row({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "second question" }] } }),
    row({ type: "response_item", payload: { type: "message", role: "assistant", id: "msg_a2", content: [{ type: "text", text: "answer two" }] } }),
    row({ type: "event_msg", payload: { type: "task_complete" } }),
  ];
}

test("listCodexTurnAnchors: turn_context-grained turns with previews, ts, and assistant end ids", () => {
  const anchors = listCodexTurnAnchors(sampleLines());
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors.map((a) => a.ordinal), [1, 2]);
  assert.equal(anchors[0]!.preview, "first question");
  assert.equal(anchors[0]!.ts, "2026-07-24T19:15:10Z");
  assert.equal(anchors[0]!.endEventId, "msg_a1");
  assert.equal(anchors[0]!.userEventId, undefined);
  assert.ok(anchors.every((a) => a.completed));
});

test("truncate at turn:1 keeps turn 1 and trims the next turn's prelude", () => {
  const { kept, boundaryOrdinal } = truncateCodexThread(sampleLines(), { kind: "turn", ordinal: 1 });
  assert.equal(boundaryOrdinal, 1);
  const types = kept.map((line) => {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const payload = obj.payload as Record<string, unknown> | undefined;
    return `${obj.type}:${payload?.type ?? ""}`;
  });
  // Ends at turn 1's task_complete — the trailing thread_settings_applied /
  // task_started prelude of turn 2 is trimmed.
  assert.equal(types.at(-1), "event_msg:task_complete");
  assert.ok(!types.includes("turn_context:") || types.filter((t) => t === "turn_context:").length === 1);
  assert.ok(!kept.some((line) => line.includes("second question")));
  assert.ok(kept.some((line) => line.includes("answer one")));
});

test("an assistant msg id anchors through the end of its turn", () => {
  const { kept, boundaryOrdinal } = truncateCodexThread(sampleLines(), { kind: "turn", eventId: "msg_a1" });
  assert.equal(boundaryOrdinal, 1);
  assert.ok(!kept.some((line) => line.includes("second question")));
});

test("unknown event id and out-of-range ordinal refuse", () => {
  assert.throws(() => truncateCodexThread(sampleLines(), { kind: "turn", eventId: "msg_nope" }), /no such event/);
  assert.throws(() => truncateCodexThread(sampleLines(), { kind: "turn", ordinal: 5 }), /only 2 turn/);
});

test("a dangling function_call at the cut is trimmed off", () => {
  const lines = [
    ...sampleLines(),
    row({ type: "event_msg", payload: { type: "task_started" } }),
    row({ type: "turn_context", payload: {} }),
    row({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "third question" }] } }),
    row({ type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell" } }),
  ];
  const { kept } = truncateCodexThread(lines, { kind: "turn", ordinal: 3 });
  assert.ok(!kept.some((line) => line.includes("function_call")));
  assert.ok(kept.some((line) => line.includes("third question")));
});

test("rewriteCodexThreadId swaps every occurrence of the thread id", () => {
  const NEW = "22222222-2222-2222-2222-222222222222";
  const rewritten = rewriteCodexThreadId(sampleLines(), OLD, NEW);
  assert.ok(!rewritten.some((line) => line.includes(OLD)));
  const meta = JSON.parse(rewritten[0]!) as { payload: { id: string; session_id: string } };
  assert.equal(meta.payload.id, NEW);
  assert.equal(meta.payload.session_id, NEW);
});

test("tip anchor keeps everything", () => {
  const { kept } = truncateCodexThread(sampleLines(), { kind: "tip" });
  assert.equal(kept.length, sampleLines().length);
});
