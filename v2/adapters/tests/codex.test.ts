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
import { codexAdapter, codexRateLimitSignals, codexThreadRequest } from "../src/codex.ts";
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
    [{ kind: "turn_started", turnId: "turn-1", threadId: "t" }], // v6: the turn id rides along (turn/interrupt needs it)
  );
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { id: "turn-1" } } })),
    [
      { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
      { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
      { kind: "turn_ended", threadId: "t" },
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

test("codex: encodeMessage requires the learned thread id; idle encodes turn/start", () => {
  assert.equal(adapter.encodeMessage("hi", { sessionId: null, messageId: 3, turnActive: false, turnId: null }), null);
  const encoded = adapter.encodeMessage("hi", { sessionId: "thread-abc", messageId: 3, turnActive: false, turnId: null });
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(encoded), {
    jsonrpc: "2.0",
    id: 1003,
    method: "turn/start",
    params: { threadId: "thread-abc", input: [{ type: "text", text: "hi", text_elements: [] }] },
  });
  assert.equal(adapter.acceptsMidTurn, true);
  assert.equal(adapter.midTurnMessageNeedsTurnId, true);
  assert.equal(adapter.confirmsDelivery, true);
});

test("codex: a running turn encodes turn/steer with its native id and refuses safely before that id is known", () => {
  assert.equal(
    adapter.encodeMessage("steer me", { sessionId: "thread-abc", messageId: 4, turnActive: true, turnId: null }),
    null,
  );
  const encoded = adapter.encodeMessage("steer me", {
    sessionId: "thread-abc",
    messageId: 4,
    turnActive: true,
    turnId: "turn-live",
  });
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(encoded), {
    jsonrpc: "2.0",
    id: 1004,
    method: "turn/steer",
    params: {
      threadId: "thread-abc",
      input: [{ type: "text", text: "steer me", text_elements: [] }],
      expectedTurnId: "turn-live",
    },
  });
});

test("codex: turn delivery responses confirm or refuse the mailbox message; errors still surface flags", () => {
  assert.deepEqual(adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1003, result: { turnId: "turn-1" } })), [
    { kind: "delivery_confirmed", messageId: 3 },
  ]);
  const signals = adapter.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 1003,
    error: { code: -32000, message: "401 unauthorized" },
  }));
  assert.deepEqual(signals[0], { kind: "delivery_refused", messageId: 3 });
  assert.equal(signals[1]!.kind, "flag");
  if (signals[1]!.kind === "flag") assert.equal(signals[1]!.flag, "auth_needed");
});

test("codex: resumeThreadId (spec 07 §F) — handshake sends thread/resume {threadId,…} instead of thread/start; the response's thread.id → booted; no argv resume", () => {
  const resumed = codexAdapter({ cwd: "/tmp/work", resumeThreadId: "01a00e69-6ee4-7cd1-955c-befcbe8d9540" });
  assert.equal(resumed.resumeArgs, undefined, "codex resumes through its protocol, not argv");
  const lines = onlyRespond(resumed.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "codex" } })));
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]!), {
    jsonrpc: "2.0",
    id: 2,
    method: "thread/resume",
    params: { threadId: "01a00e69-6ee4-7cd1-955c-befcbe8d9540", cwd: "/tmp/work", approvalPolicy: "never", sandbox: "danger-full-access" },
  });
  // fresh (no resumeThreadId) still starts a thread
  const fresh = codexAdapter({ cwd: "/tmp/work" });
  const freshLines = onlyRespond(fresh.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
  assert.equal((JSON.parse(freshLines[1]!) as { method: string }).method, "thread/start");
  // resume ack with the thread echoed → booted with the SAME id
  const booted = resumed.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "01a00e69-6ee4-7cd1-955c-befcbe8d9540" } } }));
  assert.equal(booted[0]?.kind, "booted");
  if (booted[0]?.kind === "booted") assert.equal(booted[0].sessionId, "01a00e69-6ee4-7cd1-955c-befcbe8d9540");
  // resume ack without a thread body → falls back to the requested id (old adapter behavior)
  const bare = resumed.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }));
  assert.equal(bare[0]?.kind, "booted");
  if (bare[0]?.kind === "booted") assert.equal(bare[0].sessionId, "01a00e69-6ee4-7cd1-955c-befcbe8d9540");
  // resume error (rollout gone / wrong CODEX_HOME) → no booted; error evidence surfaces only when classifiable
  const err = resumed.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "thread not found" } }));
  assert.equal(err.length, 0);
});

test("codex v6: turn/started carries the turn id; encodeInterrupt = turn/interrupt {threadId, turnId} (null before a turn id is known); the ack parses to []", () => {
  const started = adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t-1", turn: { id: "turn-9" } } }));
  assert.deepEqual(started, [{ kind: "turn_started", turnId: "turn-9", threadId: "t-1" }]);
  assert.deepEqual(adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t-1" } })), [{ kind: "turn_started", threadId: "t-1" }]);
  assert.equal(adapter.encodeInterrupt!({ sessionId: "t-1", turnId: null }), null);
  assert.equal(adapter.encodeInterrupt!({ sessionId: null, turnId: "turn-9" }), null);
  const req = JSON.parse(adapter.encodeInterrupt!({ sessionId: "t-1", turnId: "turn-9" })!) as Record<string, unknown>;
  assert.equal(req.method, "turn/interrupt");
  assert.deepEqual(req.params, { threadId: "t-1", turnId: "turn-9" });
  assert.equal(typeof req.id, "number");
  assert.deepEqual(adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} })), []);
  // the interrupted turn completes like any turn (turn/completed → turn_ended)
  assert.ok(adapter.parseLine(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-9" } } })).some((s) => s.kind === "turn_ended"));
});

test("codex v6: forkThreadId → the handshake sends thread/fork {threadId: source}; the response's NEW thread.id lands as booted; resume wins over fork", () => {
  const forked = codexAdapter({ cwd: "/tmp/w", forkThreadId: "src-thread" });
  const lines = onlyRespond(forked.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "codex" } })));
  const req = JSON.parse(lines[1]!) as { method: string; params: Record<string, unknown> };
  assert.equal(req.method, "thread/fork");
  assert.equal(req.params.threadId, "src-thread");
  assert.equal(req.params.cwd, "/tmp/w");
  const booted = forked.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "new-thread" } } }));
  assert.deepEqual(booted[0], { kind: "booted", sessionId: "new-thread" });
  // no fallback to the source id when the fork response carries no thread (we must never adopt the source's id)
  assert.deepEqual(forked.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })), []);
  // a method-not-found error (older app-server) surfaces no booted
  assert.deepEqual(forked.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "method not found: thread/fork" } })), []);
  const both = codexThreadRequest({ cwd: "/tmp/w", resumeThreadId: "own", forkThreadId: "src" });
  assert.equal(both.method, "thread/resume", "a recorded session always wins over a fork seed");
});
