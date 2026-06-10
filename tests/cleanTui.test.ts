import assert from "node:assert/strict";
import { test } from "node:test";
import { wrapPreview } from "../src/cleanTui.js";

// Lone surrogates do not survive a UTF-8 round trip; well-formed strings do.
function isWellFormedUtf16(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

test("wrapPreview wraps long lines at the requested width", () => {
  assert.deepEqual(wrapPreview("abcdef", 3, 5), ["abc", "def"]);
  assert.deepEqual(wrapPreview("abc", 3, 5), ["abc"]);
});

test("wrapPreview keeps blank lines and strips trailing whitespace", () => {
  assert.deepEqual(wrapPreview("a\n\nb  ", 10, 5), ["a", "", "b"]);
});

test("wrapPreview never splits surrogate pairs when wrapping", () => {
  const lines = wrapPreview("🐝🐝🐝", 4, 5);
  assert.deepEqual(lines, ["🐝🐝", "🐝"]);
  for (const line of lines) {
    assert.ok(isWellFormedUtf16(line), `ill-formed line: ${JSON.stringify(line)}`);
  }
});

test("wrapPreview counts CJK characters as two columns", () => {
  assert.deepEqual(wrapPreview("漢字漢字", 4, 5), ["漢字", "漢字"]);
  assert.deepEqual(wrapPreview("a漢字", 4, 5), ["a漢", "字"]);
});

test("wrapPreview marks truncation when more lines remain", () => {
  assert.deepEqual(wrapPreview("a\nb\nc\nd", 10, 2), ["a", "b ..."]);
});

test("wrapPreview caps output at maxRows even for one long line", () => {
  assert.deepEqual(wrapPreview("abcdefghij", 2, 3), ["ab", "cd", "ef"]);
});
