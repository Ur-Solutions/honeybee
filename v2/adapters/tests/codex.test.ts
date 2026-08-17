/**
 * Codex adapter unit tests (spec 03 test tier 1).
 *
 * Fixture provenance: message shapes reconstructed from the previous system's
 * adapter (protocol names verbatim from the generated app-server bindings,
 * codex-cli 0.142.5): initialize/initialized handshake, thread/start response
 * `{thread:{id}}`, TurnCompletedNotification `{threadId,turn}`,
 * RateLimitSnapshot `{rateLimitReachedType, primary:{resetsAt}, …}`,
 * ErrorNotification `{error:{message}}`. Reconstructed, not captured — the
 * manual smoke (v2/driver-hsr/SMOKE.md) must verify against a live app-server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codexAdapter, codexRateLimitSignals } from "../src/codex.ts";
import type { AdapterSignal } from "../src/types.ts";

const adapter = codexAdapter({ cwd: "/tmp/work", model: "gpt-5.2" });

function onlyRespond(signals: AdapterSignal[]): string[] {
  assert.equal(signals.length, 1);
  const s = signals[0]!;
  assert.equal(s.kind, "respond");
  return s.kind === "respond" ? s.lines : [];
}

test("codex: bootLines is a single initialize request", () => {
  const lines = adapter.bootLines();
  assert.equal(lines.length, 1);
  const req = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(req.jsonrpc, "2.0");
  assert.equal(req.id, 1);
  assert.equal(req.method, "initialize");
});

test("codex: initialize response → respond with initialized + thread/start (ack-ordered handshake)", () => {
  const lines = onlyRespond(adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { jsonrpc: "2.0", method: "initialized" });
  const threadStart = JSON.parse(lines[1]!) as { id: number; method: string; params: Record<string, unknown> };
  assert.equal(threadStart.method, "thread/start");
  assert.equal(threadStart.id, 2);
  assert.deepEqual(threadStart.params, {
    model: "gpt-5.2",
    cwd: "/tmp/work",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
});

test("codex: thread/start response → booted(threadId) + spawn_failed clear + turn_ended", () => {
  const line = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "thread-abc" } } });
  assert.deepEqual(adapter.parseLine(line), [
    { kind: "booted", sessionId: "thread-abc" },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
});

test("codex: turn/started → turn_started; turn/completed → clears + turn_ended", () => {
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t", turn: { id: "turn-1" } } })),
    [{ kind: "turn_started" }],
  );
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { id: "turn-1" } } })),
    [
      { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
      { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
      { kind: "turn_ended" },
    ],
  );
});

test("codex: error notification with auth-expiry signature → auth_needed set", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "error",
    params: { error: { message: "Failed to refresh token: 400 Bad Request: Invalid 'refresh_token': empty string" } },
  });
  const signals = adapter.parseLine(line);
  assert.equal(signals.length, 1);
  const s = signals[0]!;
  assert.equal(s.kind, "flag");
  if (s.kind === "flag") {
    assert.equal(s.flag, "auth_needed");
    assert.equal(s.action, "set");
  }
});

test("codex: error notification with rate-limit text → resource_blocked set; generic error → []", () => {
  const rl = adapter.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "error",
    params: { error: { message: "429 Too Many Requests: rate limit exceeded" } },
  }));
  assert.equal(rl.length, 1);
  assert.equal(rl[0]!.kind, "flag");
  if (rl[0]!.kind === "flag") assert.equal(rl[0]!.flag, "resource_blocked");
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "error", params: { error: { message: "model exploded" } } })),
    [],
  );
});

test("codex: rateLimits reached → resource_blocked set with primary-window reset hint", () => {
  const signals = codexRateLimitSignals({
    limitId: "l1",
    rateLimitReachedType: "rate_limit_reached",
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1783034400 },
    secondary: null,
  });
  assert.equal(signals.length, 1);
  const s = signals[0]!;
  assert.equal(s.kind, "flag");
  if (s.kind === "flag") {
    assert.equal(s.flag, "resource_blocked");
    assert.equal(s.action, "set");
    assert.match(s.detail, /rate_limit_reached/);
    assert.match(s.detail, /resets 2026-/);
  }
});

test("codex: benign rolling rateLimits update (reached null) → []", () => {
  assert.deepEqual(codexRateLimitSignals({ rateLimitReachedType: null, primary: { resetsAt: 1783034400 } }), []);
  assert.deepEqual(codexRateLimitSignals(undefined), []);
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: { rateLimits: { rateLimitReachedType: null } },
    })),
    [],
  );
});

test("codex: mid-turn deltas, reasoning and usage notifications carry no state edge", () => {
  for (const method of ["item/agentMessage/delta", "item/reasoning/delta", "thread/tokenUsage/updated", "item/started"]) {
    assert.deepEqual(adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", method, params: { delta: "x" } })), []);
  }
  assert.deepEqual(adapter.parseLine("not json"), []);
});

test("codex: inbound server request is refused (method-not-found), never left hanging", () => {
  const lines = onlyRespond(adapter.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: { command: "rm -rf /" },
  })));
  assert.deepEqual(JSON.parse(lines[0]!), {
    jsonrpc: "2.0",
    id: 77,
    error: { code: -32601, message: "unsupported server request: item/commandExecution/requestApproval" },
  });
});

test("codex: encodeMessage requires the learned thread id; encodes a turn/start request", () => {
  assert.equal(adapter.encodeMessage("hi", { sessionId: null, messageId: 3 }), null);
  const encoded = adapter.encodeMessage("hi", { sessionId: "thread-abc", messageId: 3 });
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(encoded), {
    jsonrpc: "2.0",
    id: 1003,
    method: "turn/start",
    params: { threadId: "thread-abc", input: [{ type: "text", text: "hi", text_elements: [] }] },
  });
  assert.equal(adapter.acceptsMidTurn, false); // turn/start collides with an active turn
});

test("codex: turn/start error response with auth signature → auth_needed set", () => {
  const signals = adapter.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 1003,
    error: { code: -32000, message: "401 unauthorized" },
  }));
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "flag");
  if (signals[0]!.kind === "flag") assert.equal(signals[0]!.flag, "auth_needed");
});
