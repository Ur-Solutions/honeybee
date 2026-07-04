import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnArgvPrompt } from "../src/commands/spawn.js";
import { parse } from "../src/parse.js";

// The HSR wedge regression (2026-07): HSR adapters build their own child argv,
// so a prompt handed to `hive spawn <bee> "…"` or `… -- "…"` was silently
// dropped — codex app-server never received a turn, stream-json claude waited
// on stdin forever, and the bee sat in "booting" with no error. spawnArgvPrompt
// is the pure extraction spawnSingleBee routes through deliverHsrPrompt; these
// pin its shapes so the drop cannot silently return.

test("positional prompt after the bee kind is the prompt", () => {
  const parsed = parse(["spawn", "codex", "Review the TAN-4 diff and report verdicts."]);
  assert.equal(spawnArgvPrompt(parsed), "Review the TAN-4 diff and report verdicts.");
});

test("prose rest (-- \"…\") is the prompt — the shape the wedged fleet used", () => {
  const parsed = parse(["spawn", "codex", "--name", "TAN-103", "--", "You are the implementor for TAN-103."]);
  assert.equal(spawnArgvPrompt(parsed), "You are the implementor for TAN-103.");
});

test("flag-like rest is bee-args, not a prompt", () => {
  const parsed = parse(["spawn", "codex", "--", "-m", "gpt-5.5"]);
  assert.equal(spawnArgvPrompt(parsed), "");
});

test("positional prompt survives alongside flag-like rest", () => {
  const parsed = parse(["spawn", "codex", "do the thing", "--", "-m", "gpt-5.5"]);
  assert.equal(spawnArgvPrompt(parsed), "do the thing");
});

test("bare spawn has no prompt", () => {
  const parsed = parse(["spawn", "codex", "--name", "worker-1", "--yolo"]);
  assert.equal(spawnArgvPrompt(parsed), "");
});

test("multiple positionals join into one prompt", () => {
  const parsed = parse(["spawn", "claude", "review", "the", "diff"]);
  assert.equal(spawnArgvPrompt(parsed), "review the diff");
});

test("the x/run delegation shape (prompt already stripped, flag rest) stays inert", () => {
  // cmdX/cmdRun build spawnParsed as args:[agent] with the caller's rest passed
  // through — auto-delivery must not fire, or the bee would get a garbage first
  // turn before the real prompt.
  const parsed = parse(["spawn", "codex", "--no-wait", "--", "-c", "service_tier=default"]);
  assert.equal(spawnArgvPrompt(parsed), "");
});
