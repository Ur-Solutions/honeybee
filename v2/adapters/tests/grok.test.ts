/**
 * Grok ACP adapter unit tests (spec 03 test tier 1).
 *
 * Fixture provenance: message shapes reconstructed from the previous system's
 * adapter (src/hsr/adapters/grok.ts + acpRpc.ts) — initialize/authenticate/
 * session/new handshake, session/prompt result, permission auto-allow.
 * Reconstructed, not captured — the manual smoke must verify against live
 * `grok agent stdio`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { grokAdapter, grokAllowPermissionResult } from "../src/grok.ts";
import type { AdapterSignal } from "../src/types.ts";

const adapter = grokAdapter({ cwd: "/tmp/work" });

function onlyRespond(signals: AdapterSignal[]): string[] {
  assert.equal(signals.length, 1);
  const s = signals[0]!;
  assert.equal(s.kind, "respond");
  return s.kind === "respond" ? s.lines : [];
}

test("grok: bootLines is a single initialize request", () => {
  const lines = adapter.bootLines();
  assert.equal(lines.length, 1);
  const req = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(req.jsonrpc, "2.0");
  assert.equal(req.id, 1);
  assert.equal(req.method, "initialize");
});

test("grok: initialize response → authenticate with cached_token", () => {
  const lines = onlyRespond(adapter.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }] },
  })));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    jsonrpc: "2.0",
    id: 2,
    method: "authenticate",
    params: { methodId: "cached_token" },
  });
});

test("grok: authenticate response → session/new with cwd", () => {
  const lines = onlyRespond(adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })));
  assert.equal(lines.length, 1);
  const setup = JSON.parse(lines[0]!) as { id: number; method: string; params: Record<string, unknown> };
  assert.equal(setup.method, "session/new");
  assert.equal(setup.id, 3);
  assert.deepEqual(setup.params, { cwd: "/tmp/work", mcpServers: [] });
});

test("grok: session/new response → booted(sessionId) + spawn_failed clear + turn_ended", () => {
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { sessionId: "sess-abc" } })),
    [
      { kind: "booted", sessionId: "sess-abc" },
      { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
      { kind: "turn_ended" },
    ],
  );
});

test("grok: resume handshake uses session/load", () => {
  const resume = grokAdapter({ cwd: "/tmp/work", resumeSessionId: "old-sess" });
  resume.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { authMethods: [{ id: "cached_token" }] },
  }));
  const lines = onlyRespond(resume.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })));
  const setup = JSON.parse(lines[0]!) as { method: string; params: Record<string, unknown> };
  assert.equal(setup.method, "session/load");
  assert.deepEqual(setup.params, { cwd: "/tmp/work", mcpServers: [], sessionId: "old-sess" });
});

test("grok: encodeMessage needs a session id; prompt result ends the turn", () => {
  assert.equal(adapter.encodeMessage("hi", { sessionId: null, messageId: 4 }), null);
  const encoded = JSON.parse(adapter.encodeMessage("hi", { sessionId: "sess-abc", messageId: 4 })!) as Record<string, unknown>;
  assert.equal(encoded.method, "session/prompt");
  assert.equal(encoded.id, 1004);
  assert.deepEqual(encoded.params, { sessionId: "sess-abc", prompt: [{ type: "text", text: "hi" }] });
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1004, result: { stopReason: "end_turn" } })),
    [
      { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
      { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
      { kind: "turn_ended" },
    ],
  );
});

test("grok: authenticate error with login signature → auth_needed", () => {
  const signals = adapter.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    error: { message: "Not logged in · run grok login" },
  }));
  assert.deepEqual(signals, [{ kind: "flag", flag: "auth_needed", action: "set", detail: "Not logged in · run grok login" }]);
});

test("grok: permission request auto-allows allow_once", () => {
  const params = {
    options: [
      { optionId: "reject-once", name: "Deny", kind: "reject_once" },
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    ],
  };
  assert.deepEqual(grokAllowPermissionResult(params), { outcome: { outcome: "selected", optionId: "allow-once" } });
  const lines = onlyRespond(adapter.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "perm-1",
    method: "session/request_permission",
    params,
  })));
  assert.deepEqual(JSON.parse(lines[0]!), {
    jsonrpc: "2.0",
    id: "perm-1",
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
});

test("grok: session/prompt JSON-RPC -32003 → resource_blocked + turn_ended", () => {
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1004,
      error: { code: -32003, message: "quota exhausted" },
    })),
    [
      { kind: "flag", flag: "resource_blocked", action: "set", detail: "quota exhausted" },
      { kind: "turn_ended" },
    ],
  );
});

test("grok: session/update agent output opens a turn (self-woken)", () => {
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    })),
    [{ kind: "turn_started" }],
  );
});

test("grok: encodeInterrupt is a session/cancel notification", () => {
  assert.equal(adapter.encodeInterrupt?.({ sessionId: null, turnId: null }) ?? null, null);
  assert.deepEqual(JSON.parse(adapter.encodeInterrupt!({ sessionId: "sess-abc", turnId: null })!), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "sess-abc" },
  });
});
