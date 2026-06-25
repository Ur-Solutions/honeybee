import assert from "node:assert/strict";
import { test } from "node:test";
import { codePointWidth, displayWidth, formatRelativeTime, formatTable, isPretty, stripAnsi, truncate, visibleLength } from "../src/format.js";

const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Lone surrogates do not survive a UTF-8 round trip; well-formed strings do.
function isWellFormedUtf16(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

test("formatRelativeTime walks the unit ladder", () => {
  assert.equal(formatRelativeTime(ago(5 * 1000), NOW), "5s");
  assert.equal(formatRelativeTime(ago(90 * 1000), NOW), "1m");
  assert.equal(formatRelativeTime(ago(3 * 60 * 60 * 1000), NOW), "3h");
  assert.equal(formatRelativeTime(ago(2 * DAY_MS), NOW), "2d");
  assert.equal(formatRelativeTime(ago(7 * DAY_MS), NOW), "1w");
  assert.equal(formatRelativeTime(ago(30 * DAY_MS), NOW), "1mo");
  assert.equal(formatRelativeTime(ago(365 * DAY_MS), NOW), "1y");
});

test("isPretty ignores inherited no-color automation env inside tmux", () => {
  const tty = { isTTY: true };
  withEnv({ NO_COLOR: "1", TERM: "dumb", TMUX: "/tmp/tmux/default,1,0", HIVE_NO_COLOR: undefined }, () => {
    assert.equal(isPretty(tty), true);
  });
  withEnv({ NO_COLOR: "1", TERM: "dumb", TMUX: undefined, HIVE_NO_COLOR: undefined }, () => {
    assert.equal(isPretty(tty), false);
  });
  withEnv({ NO_COLOR: "1", TERM: "tmux-256color", TMUX: "/tmp/tmux/default,1,0", HIVE_NO_COLOR: "1" }, () => {
    assert.equal(isPretty(tty), false);
  });
});

test("formatRelativeTime never reports zero months or years at unit boundaries", () => {
  assert.equal(formatRelativeTime(ago(28 * DAY_MS), NOW), "4w");
  assert.equal(formatRelativeTime(ago(29 * DAY_MS), NOW), "4w");
  assert.equal(formatRelativeTime(ago(360 * DAY_MS), NOW), "12mo");
  assert.equal(formatRelativeTime(ago(364 * DAY_MS), NOW), "12mo");
});

test("formatRelativeTime handles missing and invalid timestamps", () => {
  assert.equal(formatRelativeTime(undefined, NOW), "—");
  assert.equal(formatRelativeTime("not-a-date", NOW), "—");
});

test("codePointWidth classifies narrow, wide, and zero-width code points", () => {
  assert.equal(codePointWidth("a".codePointAt(0)!), 1);
  assert.equal(codePointWidth("漢".codePointAt(0)!), 2);
  assert.equal(codePointWidth("🐝".codePointAt(0)!), 2);
  assert.equal(codePointWidth(0x0301), 0); // combining acute accent
  assert.equal(codePointWidth(0xfe0f), 0); // variation selector-16
});

test("displayWidth counts terminal cells, not code units", () => {
  assert.equal(displayWidth("hello"), 5);
  assert.equal(displayWidth("漢字"), 4);
  assert.equal(displayWidth("🐝🐝"), 4);
  assert.equal(displayWidth("é"), 1);
  assert.equal(displayWidth(""), 0);
});

test("visibleLength ignores ANSI codes and measures display width", () => {
  assert.equal(visibleLength("plain"), 5);
  assert.equal(visibleLength("\x1b[32mok\x1b[0m"), 2);
  assert.equal(visibleLength("\x1b[2m漢字\x1b[0m"), 4);
  assert.equal(visibleLength("\x1b[1m🐝\x1b[0m bee"), 6);
});

test("stripAnsi removes SGR sequences", () => {
  assert.equal(stripAnsi("\x1b[1m\x1b[31mhi\x1b[0m"), "hi");
  assert.equal(stripAnsi("no codes"), "no codes");
});

test("truncate never splits surrogate pairs", () => {
  const result = truncate("🐝🐝🐝🐝", 4);
  assert.ok(isWellFormedUtf16(result), `ill-formed result: ${JSON.stringify(result)}`);
  assert.equal(result, "🐝…");
  assert.ok(visibleLength(result) <= 4);
});

test("truncate measures CJK characters as two columns", () => {
  assert.equal(truncate("漢字テスト", 5), "漢字…");
  assert.equal(truncate("漢字", 4), "漢字");
  // A wide char that would straddle the boundary is dropped, not split.
  assert.equal(truncate("a漢字", 4), "a漢…");
});

test("truncate preserves ANSI styling and appends a reset", () => {
  const result = truncate("\x1b[31mabcdef\x1b[0m", 4);
  assert.equal(result, "\x1b[31mabc\x1b[0m…");
  assert.equal(visibleLength(result), 4);
});

test("truncate returns short and degenerate inputs unchanged", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello", 5), "hello");
  assert.equal(truncate("hello", 1), "…");
  assert.equal(truncate("hello", 0), "");
});

test("formatTable pads CJK and emoji cells to consistent visible widths", () => {
  const table = formatTable(
    [{ header: "NAME" }, { header: "STATE" }],
    [
      ["漢字", "ok"],
      ["bee🐝", "idle"],
      ["plain", "dead"],
    ],
  );
  const lines = table.split("\n");
  const widths = new Set(lines.map((line) => visibleLength(line)));
  assert.equal(widths.size, 1, `misaligned rows: ${JSON.stringify([...widths])}`);
});

test("displayWidth counts grapheme clusters, not code points", () => {
  // Skin-tone modifier: one glyph, width 2 (not 4).
  assert.equal(visibleLength("👍🏽"), 2);
  // ZWJ family sequence: one glyph, width 2 (not 6+).
  assert.equal(visibleLength("👨‍👩‍👧"), 2);
  // Combining mark stays attached to its base.
  assert.equal(visibleLength("é"), 1);
  // Regional-indicator flag pair renders as one wide glyph.
  assert.equal(visibleLength("🇳🇴"), 2);
});

test("truncate never splits a ZWJ sequence or modifier off its base", () => {
  const family = "👨‍👩‍👧";
  const result = truncate(`${family}${family}${family}`, 4);
  assert.ok(isWellFormedUtf16(result), `ill-formed result: ${JSON.stringify(result)}`);
  assert.equal(result, `${family}…`);
  const thumbs = truncate("👍🏽👍🏽👍🏽", 4);
  assert.ok(isWellFormedUtf16(thumbs), `ill-formed result: ${JSON.stringify(thumbs)}`);
  assert.equal(thumbs, "👍🏽…");
});
