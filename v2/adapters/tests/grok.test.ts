/**
 * Grok ACP adapter unit tests (spec 03 test tier 1).
 *
 * Fixture provenance: `fixtures/grok-acp-live.jsonl` is a redacted slice of
 * the 2026-08-20 `v2:smoke -- grok` session log (grok 1.0.5 ACP stdio,
 * grok-4.6, ALL 11 PASS). Handshake / permission cases that the smoke did
 * not hit stay reconstructed from the previous system's adapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grokAdapter, grokAllowPermissionResult } from "../src/grok.ts";
import type { AdapterSignal } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
function liveFixtureLines(): string[] {
  return readFileSync(join(here, "fixtures", "grok-acp-live.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

const adapter = grokAdapter({ cwd: "/tmp/work" });

function onlyRespond(signals: AdapterSignal[]): string[] {
  assert.equal(signals.length, 1);
  const s = signals[0]!;
  assert.equal(s.kind, "respond");
  return s.kind === "respond" ? s.lines : [];
}

test("grok: live smoke fixture — initialize prefers cached_token, session/new boots, prompt ends the turn", () => {
  const [init, , authOk, sessionNew, chunk, promptDone] = liveFixtureLines();
  const auth = onlyRespond(adapter.parseLine(init!));
  assert.deepEqual(JSON.parse(auth[0]!), {
    jsonrpc: "2.0",
    id: 2,
    method: "authenticate",
    params: { methodId: "cached_token" },
  });
  assert.equal(JSON.parse(onlyRespond(adapter.parseLine(authOk!))[0]!).method, "session/new");
  assert.deepEqual(adapter.parseLine(sessionNew!), [
    { kind: "booted", sessionId: "sess-live" },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
  assert.deepEqual(adapter.parseLine(chunk!), [{ kind: "turn_started" }]);
  assert.deepEqual(adapter.parseLine(promptDone!), [
    { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
    { kind: "turn_ended" },
  ]);
});

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

test("grok: session setup passes daemon-supplied MCP servers through ACP", () => {
  const withMcp = grokAdapter({
    cwd: "/tmp/work",
    mcpServers: [{
      name: "apiary",
      command: "/Applications/Apiary.app/Contents/Resources/apiary-mcp",
      args: [],
      env: [{ name: "APIARY_GATEWAY", value: "/tmp/apiary.json" }],
    }],
  });
  const lines = onlyRespond(withMcp.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })));
  const setup = JSON.parse(lines[0]!) as { params: Record<string, unknown> };
  assert.deepEqual(setup.params, {
    cwd: "/tmp/work",
    mcpServers: [{
      name: "apiary",
      command: "/Applications/Apiary.app/Contents/Resources/apiary-mcp",
      args: [],
      env: [{ name: "APIARY_GATEWAY", value: "/tmp/apiary.json" }],
    }],
  });
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
  assert.equal(adapter.encodeMessage("hi", { sessionId: null, messageId: 4, turnActive: false, turnId: null }), null);
  const encoded = JSON.parse(adapter.encodeMessage("hi", {
    sessionId: "sess-abc",
    messageId: 4,
    turnActive: false,
    turnId: null,
  })!) as Record<string, unknown>;
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

test("grok: turn_completed notification ends a self-woken turn", () => {
  const ended = [
    { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
    { kind: "turn_ended" },
  ];
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: { update: { sessionUpdate: "turn_completed", prompt_id: "task-completed-1", stop_reason: "end_turn" } },
    })),
    ended,
  );
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "_x.ai/session/prompt_complete",
      params: { promptId: "task-completed-1", stopReason: "end_turn" },
    })),
    ended,
  );
});

test("grok: replayed turn_completed does not close the live turn", () => {
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        update: { sessionUpdate: "turn_completed", prompt_id: "old" },
        _meta: { isReplay: true },
      },
    })),
    [],
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
