import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildCursorTurnConfig,
  cursorAdapter,
  cursorToolName,
  parseCursorLine,
  sessionIdFromCursorEvent,
  stripCursorPrintArgs,
} from "../src/hsr/adapters/cursor.js";
import { adapterFor } from "../src/hsr/adapters/index.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Load the distilled cursor stream-json fixture lines (skip blanks). */
function fixtureLines(): string[] {
  const raw = readFileSync(join(here, "fixtures", "cursor-stream-json.sample.jsonl"), "utf8");
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
function parseStripTs(line: string): unknown[] {
  return parseCursorLine(line).map((e) => {
    const { ts: _ts, ...rest } = e as RunnerEvent & { ts: number };
    return rest;
  });
}

test("parseCursorLine maps each envelope line to the right events", () => {
  const [init, userEcho, textLine, toolStarted, toolCompleted, resultOk, resultErr] = fixtureLines();

  assert.deepEqual(parseStripTs(init!), [], "init carries no user-facing event");
  assert.deepEqual(parseStripTs(userEcho!), [], "the user echo is dropped");
  assert.deepEqual(parseStripTs(textLine!), [{ type: "text", text: "Sure — listing now." }]);
  assert.deepEqual(parseStripTs(toolStarted!), [
    { type: "tool_use", tool: "shellToolCall", input: { shellToolCall: { command: "ls" } } },
  ]);
  assert.deepEqual(parseStripTs(toolCompleted!), [], "tool completion would double-count the call");
  assert.deepEqual(parseStripTs(resultOk!), [
    { type: "turn_end" },
    { type: "usage", inputTokens: 120, outputTokens: 40, totalTokens: 160 },
  ]);
  assert.deepEqual(parseStripTs(resultErr!), [
    { type: "error", message: "You've hit your usage limit. Try again in 4 hours." },
    { type: "exhausted" },
    { type: "turn_end" },
  ]);
});

test("parseCursorLine tolerates garbage and unmodeled lines", () => {
  assert.deepEqual(parseCursorLine("not json"), []);
  assert.deepEqual(parseCursorLine("{}"), []);
  assert.deepEqual(parseCursorLine(JSON.stringify({ type: "retry", subtype: "network" })), []);
  assert.deepEqual(parseCursorLine(JSON.stringify({ type: "assistant", message: { content: "not-an-array" } })), []);
});

test("sessionIdFromCursorEvent learns the chat id from any line that carries one", () => {
  const probe: RunnerEvent = { type: "error", ts: 0, message: "" };
  assert.equal(sessionIdFromCursorEvent(probe, JSON.parse(fixtureLines()[0]!)), "chat-123");
  assert.equal(sessionIdFromCursorEvent(probe, JSON.parse(fixtureLines()[5]!)), "chat-123");
  assert.equal(sessionIdFromCursorEvent(probe, { type: "system" }), undefined);
  assert.equal(sessionIdFromCursorEvent(probe, undefined), undefined);
});

test("cursorToolName prefers explicit names and falls back to the union tag", () => {
  assert.equal(cursorToolName({ case: "readToolCall", value: {} }), "readToolCall");
  assert.equal(cursorToolName({ shellToolCall: { command: "ls" } }), "shellToolCall");
  assert.equal(cursorToolName({}), "tool");
  assert.equal(cursorToolName("not-an-object"), "tool");
});

test("buildCursorTurnConfig: required flags prepend, caller args survive, resume uses the equals form", () => {
  const { config } = buildCursorTurnConfig(optsFor({ command: "cursor-agent", args: ["--force", "--model", "gpt-5.3-codex"] }));
  assert.equal(config.command, "cursor-agent");
  assert.deepEqual(config.baseArgs, ["-p", "--output-format", "stream-json", "--trust", "--force", "--model", "gpt-5.3-codex"]);
  assert.deepEqual(config.turnArgs(undefined), [], "the first fresh turn has no resume selector");
  assert.deepEqual(config.turnArgs("chat-123"), ["--resume=chat-123"]);
});

test("buildCursorTurnConfig never doubles print/stream flags the caller already carries", () => {
  const { config } = buildCursorTurnConfig(optsFor({ args: ["-p", "--output-format", "json", "--trust", "--force"] }));
  assert.deepEqual(config.baseArgs, ["-p", "--output-format", "stream-json", "--trust", "--force"]);
});

test("stripCursorPrintArgs handles both --output-format shapes", () => {
  assert.deepEqual(stripCursorPrintArgs(["--output-format=json", "--force"]), ["--force"]);
  assert.deepEqual(stripCursorPrintArgs(["--print", "-p", "x"]), ["x"]);
});

test("cursor adapter registration: tier turn, reachable via the driver registry", () => {
  assert.equal(cursorAdapter.harness, "cursor");
  assert.equal(cursorAdapter.tier(), "turn");
  assert.equal(adapterFor("cursor"), cursorAdapter);
});

test("buildCursorTurnConfig keeps the identity env intact (no scrub for cursor)", () => {
  const { env } = buildCursorTurnConfig(optsFor({ env: { CURSOR_AUTH_TOKEN: "tok", CURSOR_CONFIG_DIR: "/h" } }));
  assert.deepEqual(env, { CURSOR_AUTH_TOKEN: "tok", CURSOR_CONFIG_DIR: "/h" });
});
