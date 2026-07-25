// Pure unit tests for the thread-copy fork mechanics (session-fork-and-handoff
// epic): turn-anchor enumeration, truncation semantics (user-anchor cuts
// before, assistant-anchor keeps through turn end, dangling tool_use trim,
// summary leafUuid pruning), session-id rewrite, and anchor-flag parsing.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listClaudeTurnAnchors,
  parseAnchorFlag,
  rewriteClaudeSessionId,
  truncateClaudeThread,
} from "../src/threadCopy.js";

function row(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const OLD = "11111111-1111-1111-1111-111111111111";

/** Three turns; turn 2 contains a tool round-trip. */
function sampleLines(): string[] {
  return [
    row({ type: "mode", sessionId: OLD, mode: "default" }),
    row({ type: "user", sessionId: OLD, uuid: "u1", timestamp: "2026-07-24T10:00:00Z", message: { role: "user", content: "first question" } }),
    row({ type: "assistant", sessionId: OLD, uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "answer one" }] } }),
    row({ type: "user", sessionId: OLD, uuid: "u2", message: { role: "user", content: [{ type: "text", text: "second question" }] } }),
    row({ type: "assistant", sessionId: OLD, uuid: "a2", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
    row({ type: "user", sessionId: OLD, uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    row({ type: "assistant", sessionId: OLD, uuid: "a3", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } }),
    row({ type: "user", sessionId: OLD, uuid: "u3", message: { role: "user", content: "third question" } }),
    row({ type: "assistant", sessionId: OLD, uuid: "a4", message: { role: "assistant", content: [{ type: "text", text: "answer three" }] } }),
  ];
}

function uuidsOf(lines: string[]): string[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((obj) => obj.uuid)
    .filter((uuid): uuid is string => typeof uuid === "string");
}

test("listClaudeTurnAnchors enumerates real user turns with completion and previews", () => {
  const anchors = listClaudeTurnAnchors(sampleLines());
  assert.equal(anchors.length, 3);
  assert.deepEqual(anchors.map((a) => a.ordinal), [1, 2, 3]);
  assert.deepEqual(anchors.map((a) => a.userEventId), ["u1", "u2", "u3"]);
  assert.ok(anchors.every((a) => a.completed));
  assert.equal(anchors[0]!.preview, "first question");
  assert.equal(anchors[0]!.ts, "2026-07-24T10:00:00Z");
  assert.equal(anchors[1]!.endEventId, "a3");
});

test("tool_result carriers, sidechain and meta user rows are not turn starts", () => {
  const lines = [
    ...sampleLines(),
    row({ type: "user", sessionId: OLD, uuid: "s1", isSidechain: true, message: { role: "user", content: "subagent prompt" } }),
    row({ type: "user", sessionId: OLD, uuid: "m1", isMeta: true, message: { role: "user", content: "meta note" } }),
  ];
  const anchors = listClaudeTurnAnchors(lines);
  assert.equal(anchors.length, 3);
});

test("an in-flight last turn reads as not completed", () => {
  const lines = sampleLines().slice(0, 8); // ends right after u3
  const anchors = listClaudeTurnAnchors(lines);
  assert.equal(anchors.length, 3);
  assert.equal(anchors[2]!.completed, false);
});

test("truncate at turn:2 keeps turns 1-2 and reports the boundary", () => {
  const { kept, boundaryOrdinal } = truncateClaudeThread(sampleLines(), { kind: "turn", ordinal: 2 });
  assert.equal(boundaryOrdinal, 2);
  assert.deepEqual(uuidsOf(kept), ["u1", "a1", "u2", "a2", "r1", "a3"]);
});

test("a user-message anchor cuts BEFORE that message", () => {
  const { kept, boundaryOrdinal } = truncateClaudeThread(sampleLines(), { kind: "turn", eventId: "u3" });
  assert.equal(boundaryOrdinal, 2);
  assert.deepEqual(uuidsOf(kept), ["u1", "a1", "u2", "a2", "r1", "a3"]);
});

test("an assistant anchor mid-turn keeps through the END of its turn", () => {
  const { kept, boundaryOrdinal } = truncateClaudeThread(sampleLines(), { kind: "turn", eventId: "a2" });
  assert.equal(boundaryOrdinal, 2);
  assert.deepEqual(uuidsOf(kept), ["u1", "a1", "u2", "a2", "r1", "a3"]);
});

test("anchoring before the first message refuses", () => {
  assert.throws(() => truncateClaudeThread(sampleLines(), { kind: "turn", eventId: "u1" }), /empty thread/);
});

test("an unknown event id refuses", () => {
  assert.throws(() => truncateClaudeThread(sampleLines(), { kind: "turn", eventId: "nope" }), /no such event/);
});

test("a turn ordinal past the end refuses", () => {
  assert.throws(() => truncateClaudeThread(sampleLines(), { kind: "turn", ordinal: 9 }), /only 3 turn/);
});

test("tip anchor keeps everything", () => {
  const { kept } = truncateClaudeThread(sampleLines(), { kind: "tip" });
  assert.equal(kept.length, sampleLines().length);
});

test("a dangling tool_use at the cut is trimmed off", () => {
  const lines = [
    ...sampleLines(),
    row({ type: "user", sessionId: OLD, uuid: "u4", message: { role: "user", content: "fourth question" } }),
    row({ type: "assistant", sessionId: OLD, uuid: "a5", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } }),
  ];
  const { kept } = truncateClaudeThread(lines, { kind: "turn", eventId: "a5" });
  // The in-flight tool_use (no tool_result yet) must not survive the cut.
  const uuids = uuidsOf(kept);
  assert.ok(!uuids.includes("a5"));
  assert.ok(uuids.includes("u4"));
});

test("summary rows pointing past the cut are dropped; in-range ones survive", () => {
  const lines = [
    row({ type: "summary", summary: "early recap", leafUuid: "a1" }),
    row({ type: "summary", summary: "late recap", leafUuid: "a4" }),
    ...sampleLines(),
  ];
  const { kept } = truncateClaudeThread(lines, { kind: "turn", ordinal: 2 });
  const summaries = kept.map((line) => JSON.parse(line) as Record<string, unknown>).filter((obj) => obj.type === "summary");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.leafUuid, "a1");
});

test("rewriteClaudeSessionId rewrites every sessionId field and leaves other rows alone", () => {
  const NEW = "22222222-2222-2222-2222-222222222222";
  const lines = [...sampleLines(), row({ type: "summary", summary: "no session field", leafUuid: "a1" })];
  const rewritten = rewriteClaudeSessionId(lines, NEW);
  for (const line of rewritten) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if ("sessionId" in obj) assert.equal(obj.sessionId, NEW);
  }
  assert.equal((JSON.parse(rewritten.at(-1)!) as Record<string, unknown>).leafUuid, "a1");
});

test("parseAnchorFlag: absent/tip → tip; turn:N → ordinal; uuid → eventId; bad ordinal refuses", () => {
  assert.deepEqual(parseAnchorFlag(undefined), { kind: "tip" });
  assert.deepEqual(parseAnchorFlag("tip"), { kind: "tip" });
  assert.deepEqual(parseAnchorFlag("turn:3"), { kind: "turn", ordinal: 3 });
  assert.deepEqual(parseAnchorFlag("a1b2c3"), { kind: "turn", eventId: "a1b2c3" });
  assert.throws(() => parseAnchorFlag("turn:0"), /must be >= 1/);
});
