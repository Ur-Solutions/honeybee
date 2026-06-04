import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../src/parse.js";
import { appendedPaneText, parseTailOptions } from "../src/tail.js";

test("parseTailOptions recognizes -f and poll interval", () => {
  const parsed = parse(["tail", "CO.abc", "-f", "--poll-ms", "250", "-n", "40"]);

  assert.deepEqual(parseTailOptions(parsed), {
    follow: true,
    lines: 40,
    pollMs: 250,
  });
});

test("parseTailOptions recognizes --follow and defaults", () => {
  const parsed = parse(["tail", "CO.abc", "--follow"]);

  assert.deepEqual(parseTailOptions(parsed), {
    follow: true,
    lines: 80,
    pollMs: 1000,
  });
});

test("appendedPaneText returns only appended text when possible", () => {
  assert.equal(appendedPaneText("first\nsecond", "first\nsecond\nthird"), "third");
});

test("appendedPaneText returns full pane after screen rewrite", () => {
  assert.equal(appendedPaneText("first\nsecond", "fresh screen"), "fresh screen");
});
