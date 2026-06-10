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

test("appendedPaneText emits only the new tail for a sliding capture window", () => {
  // The pane scrolled: the capture window slid down by two lines, so `next`
  // no longer starts with `previous` but they overlap heavily.
  const previous = ["line 1", "line 2", "line 3", "line 4"].join("\n");
  const next = ["line 3", "line 4", "line 5", "line 6"].join("\n");
  assert.equal(appendedPaneText(previous, next), "line 5\nline 6");
});

test("appendedPaneText handles overlap that starts mid-window", () => {
  const previous = "❯ build\ncompiling...\n[1/3] parse";
  const next = "[1/3] parse\n[2/3] check\n[3/3] emit";
  assert.equal(appendedPaneText(previous, next), "[2/3] check\n[3/3] emit");
});

test("appendedPaneText still detects pure appends and no-ops", () => {
  assert.equal(appendedPaneText("a\nb", "a\nb"), "");
  assert.equal(appendedPaneText("", "anything"), "anything");
});
