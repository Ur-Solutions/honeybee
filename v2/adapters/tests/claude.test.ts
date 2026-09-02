/**
 * Claude adapter unit tests (spec 03 test tier 1): recorded fixture stream →
 * expected normalized signals, including flag evidence and clearing.
 *
 * Fixture provenance: lines 1–6 of fixtures/claude-stream.jsonl are the
 * previous system's live-captured stream-json sample (claude_code_version
 * 2.1.198); lines 7–8 reconstruct the rate_limit_event envelope from that
 * system's verified-capture documentation; line 9 reconstructs an auth-failure
 * result from its observed message signature. Reconstructive lines must be
 * re-verified in the manual smoke (v2/driver-hsr/SMOKE.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { claudeAdapter, encodeClaudeMessage, parseClaudeLine } from "../src/claude.ts";

const here = dirname(fileURLToPath(import.meta.url));

function fixtureLines(): string[] {
  const raw = readFileSync(join(here, "fixtures", "claude-stream.jsonl"), "utf8");
  return raw.split("\n").filter((l) => l.trim().length > 0);
}

test("claude: system/init → booted(sessionId) + spawn_failed clear + turn_ended (boots to idle)", () => {
  const [init] = fixtureLines();
  assert.deepEqual(parseClaudeLine(init!), [
    { kind: "booted", sessionId: "816376d3-816d-4e7d-b02e-1332f1d441a5" },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
});

test("claude: progress pings carry no state edge; assistant output OPENS a turn (self-woken turns — driver dedupes mid-turn)", () => {
  const [, thinking, textLine, toolLine] = fixtureLines();
  assert.deepEqual(parseClaudeLine(thinking!), []);
  // A self-woken turn (background-task notification inside the harness) has
  // no delivery and no user message: assistant output is its only opening
  // edge. The driver's phase check makes this a no-op while already running.
  assert.deepEqual(parseClaudeLine(textLine!), [{ kind: "turn_started" }]);
  assert.deepEqual(parseClaudeLine(toolLine!), [{ kind: "turn_started" }]);
});

test("claude: successful result → contrary-evidence clears + turn_ended", () => {
  const resultOk = fixtureLines()[4]!;
  assert.deepEqual(parseClaudeLine(resultOk), [
    { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
    { kind: "turn_ended" },
  ]);
});

test("claude: overloaded error result → resource_blocked set + turn_ended, no clears", () => {
  const resultErr = fixtureLines()[5]!;
  assert.deepEqual(parseClaudeLine(resultErr), [
    { kind: "flag", flag: "resource_blocked", action: "set", detail: "the model is overloaded" },
    { kind: "turn_ended" },
  ]);
});

test("claude: rejected rate_limit_event → resource_blocked set with reset hint", () => {
  const rejected = fixtureLines()[6]!;
  const signals = parseClaudeLine(rejected);
  assert.equal(signals.length, 1);
  const flag = signals[0]!;
  assert.equal(flag.kind, "flag");
  assert.deepEqual(
    { flag: flag.flag, action: flag.action },
    { flag: "resource_blocked", action: "set" },
  );
  assert.match(flag.detail, /rejected/);
  assert.match(flag.detail, /resets 2026-/); // resetsAt is unix seconds → ISO hint
  // The same instant rides structurally so the daemon can enact the expiry.
  assert.equal(flag.kind === "flag" ? flag.resetsAt : undefined, 1783034400 * 1000);
});

test("claude: allowed rate_limit_event → resource_blocked clear (contrary evidence)", () => {
  const allowed = fixtureLines()[7]!;
  assert.deepEqual(parseClaudeLine(allowed), [
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "claude rate limit allowed" },
  ]);
});

test("claude: login-required error result → auth_needed set + turn_ended, no clears", () => {
  const authErr = fixtureLines()[8]!;
  assert.deepEqual(parseClaudeLine(authErr), [
    { kind: "flag", flag: "auth_needed", action: "set", detail: "Not logged in · Please run /login" },
    { kind: "turn_ended" },
  ]);
});

test("claude: non-JSON, unknown types and control messages → []", () => {
  assert.deepEqual(parseClaudeLine("not json {"), []);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "mystery" })), []);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "control_request", request_id: "r1" })), []);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ no: "type" })), []);
});

test("claude: encodeMessage emits one stream-json user line", () => {
  assert.deepEqual(JSON.parse(encodeClaudeMessage("hello bee")), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hello bee" }] },
  });
  assert.ok(!encodeClaudeMessage("multi\nline").includes("\n"), "encoded message must be a single line");
});

test("claude: adapter surface — mid-turn accept, no boot lines, stable parse identity", () => {
  assert.equal(claudeAdapter.harness, "claude");
  assert.equal(claudeAdapter.acceptsMidTurn, true);
  assert.deepEqual(claudeAdapter.bootLines(), []);
  const line = fixtureLines()[0]!;
  // Stateless: same line always yields the same signals (normalization is re-derivable, Q1).
  assert.deepEqual(claudeAdapter.parseLine(line), claudeAdapter.parseLine(line));
  assert.equal(
    claudeAdapter.encodeMessage("x", { sessionId: null, messageId: 1, turnActive: false, turnId: null }),
    encodeClaudeMessage("x"),
  );
});

test("claude: resumeArgs (spec 07 §F) — `--resume <id>`; init after resume echoes the same session id → booted carries it", () => {
  assert.deepEqual(claudeAdapter.resumeArgs?.("9aa1f08d-1446-4d78-981f-bbec462ba87b"), ["--resume", "9aa1f08d-1446-4d78-981f-bbec462ba87b"]);
  const signals = claudeAdapter.parseLine(JSON.stringify({ type: "system", subtype: "init", session_id: "9aa1f08d-1446-4d78-981f-bbec462ba87b", cwd: "/w" }));
  assert.equal(signals[0]?.kind, "booted");
  if (signals[0]?.kind === "booted") assert.equal(signals[0].sessionId, "9aa1f08d-1446-4d78-981f-bbec462ba87b");
});

test("claude v6: forkArgs = `--resume <src> --fork-session` (never --session-id); encodeInterrupt = control_request interrupt with unique request ids; the ack parses to []", () => {
  assert.deepEqual(claudeAdapter.forkArgs?.("src-1"), ["--resume", "src-1", "--fork-session"]);
  const a = JSON.parse(claudeAdapter.encodeInterrupt!({ sessionId: "s", turnId: null })!) as Record<string, unknown>;
  const b = JSON.parse(claudeAdapter.encodeInterrupt!({ sessionId: null, turnId: null })!) as Record<string, unknown>;
  assert.equal(a.type, "control_request");
  assert.deepEqual(a.request, { subtype: "interrupt" });
  assert.ok(String(a.request_id).startsWith("hive-interrupt-"));
  assert.notEqual(a.request_id, b.request_id, "request ids are unique per interrupt");
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: a.request_id } })), []);
  // the interrupted turn still ends with a result line → turn_ended (the ordinary edge)
  assert.ok(parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "[interrupted]" })).some((s) => s.kind === "turn_ended"));
});
