/**
 * Stub adapter unit tests (spec 03 test tier 1). The stub protocol is defined
 * by v2/driver-hsr/test-agent/agent.mjs — no provenance caveats here; this
 * pair is fully under our control.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStubLine, stubAdapter } from "../src/stub.ts";

test("stub: ready → booted(sessionId) + spawn_failed clear + turn_ended", () => {
  assert.deepEqual(parseStubLine(JSON.stringify({ event: "ready", sessionId: "stub-1" })), [
    { kind: "booted", sessionId: "stub-1" },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
});

test("stub: turn markers map 1:1; ok turn ends with contrary-evidence clears", () => {
  assert.deepEqual(parseStubLine(JSON.stringify({ event: "turn_started", messageId: 4 })), [
    { kind: "turn_started" },
  ]);
  assert.deepEqual(parseStubLine(JSON.stringify({ event: "turn_ended", messageId: 4, ok: true })), [
    { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
    { kind: "turn_ended" },
  ]);
});

test("stub: ok:false turn end is a turn end WITHOUT clears (the turn hit a boundary)", () => {
  assert.deepEqual(parseStubLine(JSON.stringify({ event: "turn_ended", messageId: 4, ok: false })), [
    { kind: "turn_ended" },
  ]);
});

test("stub: auth error → auth_needed set; rate_limited → resource_blocked set/clear by status", () => {
  const auth = parseStubLine(JSON.stringify({ event: "error", message: "Not logged in · Please run /login" }));
  assert.deepEqual(auth.map((s) => (s.kind === "flag" ? [s.flag, s.action] : s.kind)), [["auth_needed", "set"]]);

  const blocked = parseStubLine(JSON.stringify({ event: "rate_limited", status: "rejected", resetsAt: 1783034400 }));
  assert.equal(blocked.length, 1);
  if (blocked[0]!.kind === "flag") {
    assert.equal(blocked[0]!.flag, "resource_blocked");
    assert.equal(blocked[0]!.action, "set");
    assert.match(blocked[0]!.detail, /resets 2026-/);
  } else assert.fail("expected flag evidence");

  assert.deepEqual(parseStubLine(JSON.stringify({ event: "rate_limited", status: "allowed" })), [
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "stub rate limit allowed" },
  ]);
});

test("stub: text, unknown events and non-JSON → []", () => {
  assert.deepEqual(parseStubLine(JSON.stringify({ event: "text", text: "echo:hi" })), []);
  assert.deepEqual(parseStubLine(JSON.stringify({ event: "mystery" })), []);
  assert.deepEqual(parseStubLine("garbage"), []);
});

test("stub: encodeMessage carries the mailbox message id verbatim", () => {
  assert.deepEqual(JSON.parse(stubAdapter.encodeMessage("do the thing", { sessionId: "s", messageId: 42 })!), {
    type: "message",
    id: 42,
    body: "do the thing",
  });
  assert.equal(stubAdapter.acceptsMidTurn, true);
  assert.deepEqual(stubAdapter.bootLines(), []);
});

test("stub v6: encodeInterrupt is the {type:\"interrupt\"} line; an interrupted turn_ended is a normal successful turn end", () => {
  assert.deepEqual(JSON.parse(stubAdapter.encodeInterrupt!({ sessionId: "s", turnId: null })!), { type: "interrupt" });
  const ended = parseStubLine(JSON.stringify({ event: "turn_ended", messageId: 1, ok: true, interrupted: true }));
  assert.ok(ended.some((s) => s.kind === "turn_ended"));
});
