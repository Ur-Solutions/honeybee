import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildClaudeStreamConfig, claudeAdapter } from "../src/hsr/adapters/claude.js";
import { adapterFor } from "../src/hsr/adapters/index.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Load the distilled claude stream-json fixture lines (skip blanks). */
function fixtureLines(): string[] {
  const raw = readFileSync(join(here, "fixtures", "claude-stream-json.sample.jsonl"), "utf8");
  return raw.split("\n").filter((l) => l.trim().length > 0);
}

/** A minimal RunnerOpts; individual tests override command/args/env/authKind. */
function optsFor(over: Partial<RunnerOpts> = {}): RunnerOpts {
  return {
    bee: "test",
    cwd: "/tmp",
    env: {},
    runDir: "/tmp/run",
    ...over,
  };
}

/** parseLine with ts fields stripped, so we can assert the shape deterministically. */
function parseStripTs(parseLine: (line: string) => RunnerEvent[], line: string): unknown[] {
  return parseLine(line).map((e) => {
    const { ts: _ts, ...rest } = e as RunnerEvent & { ts: number };
    return rest;
  });
}

test("parseLine maps each envelope line to the right events", () => {
  const { config } = buildClaudeStreamConfig(optsFor());
  const [init, thinking, textLine, toolLine, resultOk, resultErr] = fixtureLines();

  // system/init → [] (session id learned separately)
  assert.deepEqual(config.parseLine(init), []);
  // system/thinking_tokens → []
  assert.deepEqual(config.parseLine(thinking), []);

  // assistant/text → one text event
  assert.deepEqual(parseStripTs(config.parseLine, textLine), [{ type: "text", text: "hi there" }]);

  // assistant/tool_use → one tool_use event with tool name + input
  assert.deepEqual(parseStripTs(config.parseLine, toolLine), [
    { type: "tool_use", tool: "Bash", input: { command: "ls -la" } },
  ]);

  // result/success → [turn_end, usage] with correct token numbers
  assert.deepEqual(parseStripTs(config.parseLine, resultOk), [
    { type: "turn_end" },
    { type: "usage", inputTokens: 9, outputTokens: 41, totalTokens: 50 },
  ]);

  // result is_error → [error, turn_end, usage]; error carries the result text
  assert.deepEqual(parseStripTs(config.parseLine, resultErr), [
    { type: "error", message: "the model is overloaded" },
    { type: "turn_end" },
    { type: "usage", inputTokens: 5, outputTokens: 0, totalTokens: 5 },
  ]);
});

test("parseLine returns [] on non-JSON and unknown types", () => {
  const { config } = buildClaudeStreamConfig(optsFor());
  assert.deepEqual(config.parseLine("not json {"), []);
  assert.deepEqual(config.parseLine(JSON.stringify({ type: "mystery" })), []);
});

test("sessionIdFromEvent returns the init line's session_id", () => {
  const { config } = buildClaudeStreamConfig(optsFor());
  const [init, thinking] = fixtureLines();
  const probe: RunnerEvent = { type: "error", ts: 0, message: "" };
  assert.equal(
    config.sessionIdFromEvent?.(probe, JSON.parse(init)),
    "816376d3-816d-4e7d-b02e-1332f1d441a5",
  );
  // A non-init line yields no session id.
  assert.equal(config.sessionIdFromEvent?.(probe, JSON.parse(thinking)), undefined);
});

test("encodeUserTurn round-trips to the documented stream-json user shape", () => {
  const { config } = buildClaudeStreamConfig(optsFor());
  const encoded = config.encodeUserTurn("hi");
  assert.ok(encoded.endsWith("\n"), "encoded turn ends with a newline");
  const parsed = JSON.parse(encoded);
  assert.deepEqual(parsed, {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
});

test("env scrub drops ANTHROPIC_API_KEY on subscription, keeps it on api-key", () => {
  const sub = buildClaudeStreamConfig(
    optsFor({ env: { ANTHROPIC_API_KEY: "sk-x", CLAUDE_CONFIG_DIR: "/tmp/x" }, authKind: "subscription" }),
  );
  assert.equal(sub.env.ANTHROPIC_API_KEY, undefined, "subscription scrubs the key");
  assert.equal(sub.env.CLAUDE_CONFIG_DIR, "/tmp/x", "other env preserved");

  const api = buildClaudeStreamConfig(
    optsFor({ env: { ANTHROPIC_API_KEY: "sk-x", CLAUDE_CONFIG_DIR: "/tmp/x" }, authKind: "api-key" }),
  );
  assert.equal(api.env.ANTHROPIC_API_KEY, "sk-x", "api-key keeps the key (billing intentional)");
  assert.equal(api.env.CLAUDE_CONFIG_DIR, "/tmp/x");

  // Default authKind is subscription.
  const def = buildClaudeStreamConfig(optsFor({ env: { ANTHROPIC_API_KEY: "sk-x" } }));
  assert.equal(def.env.ANTHROPIC_API_KEY, undefined, "default authKind scrubs like subscription");
});

test("command/args prepends stream-json flags then preserves caller args, no duplicate -p", () => {
  const { config } = buildClaudeStreamConfig(
    optsFor({
      command: "claude",
      args: ["--model", "haiku", "--session-id", "abc", "--dangerously-skip-permissions"],
    }),
  );
  assert.equal(config.command, "claude");
  assert.deepEqual(config.args, [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "haiku",
    "--session-id",
    "abc",
    "--dangerously-skip-permissions",
  ]);

  // command defaults to "claude".
  assert.equal(buildClaudeStreamConfig(optsFor()).config.command, "claude");

  // Defensive: a caller that already carries -p does not get it twice.
  const dup = buildClaudeStreamConfig(optsFor({ args: ["-p", "--model", "haiku"] }));
  assert.equal(dup.config.args.filter((a) => a === "-p").length, 1);
  // Stream flags still present; -p appears once (from the caller's args).
  assert.deepEqual(dup.config.args, [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "-p",
    "--model",
    "haiku",
  ]);
});

test("adapterFor resolves stub and claude, undefined otherwise", () => {
  assert.equal(adapterFor("stub"), stubAdapter);
  assert.equal(adapterFor("claude"), claudeAdapter);
  assert.equal(adapterFor("nonexistent-harness"), undefined);
  assert.equal(claudeAdapter.harness, "claude");
  assert.equal(claudeAdapter.tier(), "stream");
});

test("encodeInterrupt emits stream-json control_request interrupt lines with unique ids", () => {
  const { config } = buildClaudeStreamConfig(optsFor());
  assert.ok(config.encodeInterrupt, "claude config provides an in-band interrupt");
  const first = JSON.parse(config.encodeInterrupt!().trim());
  const second = JSON.parse(config.encodeInterrupt!().trim());
  assert.equal(first.type, "control_request");
  assert.deepEqual(first.request, { subtype: "interrupt" });
  assert.ok(typeof first.request_id === "string" && first.request_id.length > 0);
  assert.notEqual(first.request_id, second.request_id);
  // The ack line claude sends back must parse to no events (unknown type).
  assert.deepEqual(config.parseLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: first.request_id } })), []);
});
