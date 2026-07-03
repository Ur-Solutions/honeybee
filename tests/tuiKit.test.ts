import assert from "node:assert/strict";
import { test } from "node:test";
import type * as readline from "node:readline";
import { clamp, expandTilde, isPrintable, padRight, relTilde, reverse } from "../src/tuiKit.js";
import { isPretty } from "../src/format.js";

test("tuiKit clamp: bounds a cursor into [0, length)", () => {
  assert.equal(clamp(-1, 5), 0);
  assert.equal(clamp(0, 5), 0);
  assert.equal(clamp(4, 5), 4);
  assert.equal(clamp(5, 5), 4);
  assert.equal(clamp(3, 0), 0); // empty list parks at 0
  assert.equal(clamp(-2, -1), 0);
});

test("tuiKit padRight: pads to width, ANSI-aware, never truncates", () => {
  assert.equal(padRight("ab", 4), "ab  ");
  assert.equal(padRight("abcd", 4), "abcd");
  assert.equal(padRight("abcdef", 4), "abcdef"); // too long → unchanged
  // ANSI codes take no visible width, so they don't eat padding.
  assert.equal(padRight("\x1b[31mab\x1b[0m", 4), "\x1b[31mab\x1b[0m  ");
});

test("tuiKit isPrintable: single visible chars only, no ctrl/meta chords", () => {
  const key = (extra: Partial<readline.Key> = {}): readline.Key => ({ sequence: "", name: "", ctrl: false, meta: false, shift: false, ...extra });
  assert.equal(isPrintable("a", key()), true);
  assert.equal(isPrintable(" ", key()), true);
  assert.equal(isPrintable("~", key()), true);
  assert.equal(isPrintable("", key()), false);
  assert.equal(isPrintable("ab", key()), false);
  assert.equal(isPrintable("\x1b", key()), false); // below " "
  assert.equal(isPrintable("a", key({ ctrl: true })), false);
  assert.equal(isPrintable("a", key({ meta: true })), false);
});

test("tuiKit expandTilde: expands a leading ~ only when it is the home segment", () => {
  const home = process.env.HOME ?? "~";
  assert.equal(expandTilde("~"), home);
  assert.equal(expandTilde("~/x"), `${home}/x`);
  assert.equal(expandTilde("~user/x"), "~user/x"); // named-user form is untouched
  assert.equal(expandTilde("/a/~"), "/a/~");
});

test("tuiKit relTilde: abbreviates $HOME to ~ and leaves other paths alone", () => {
  const home = process.env.HOME;
  if (home) {
    assert.equal(relTilde(`${home}/proj`), "~/proj");
    assert.equal(relTilde(home), "~");
  }
  assert.equal(relTilde("/opt/other"), "/opt/other");
});

test("tuiKit reverse: wraps in SGR reverse video only when output is pretty", () => {
  const value = "row";
  assert.equal(reverse(value), isPretty() ? `\x1b[7m${value}\x1b[0m` : value);
});
