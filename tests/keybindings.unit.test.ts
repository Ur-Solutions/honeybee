// Pure unit coverage for the keybinding layer (KEYBINDINGS_PRD Phase 1):
//   - extractUrls: multiple urls, trailing-punctuation strip, dedupe-preserving
//     order, none.
//   - byte-identity: `hive keys print --tmux` (CANONICAL_TMUX_CONF) === the
//     shipped docs/honeybee.tmux.conf, so the doc and the command never drift.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";
import { CANONICAL_TMUX_CONF, extractUrls } from "../src/keybindings.js";

test("extractUrls returns multiple URLs in first-seen order", () => {
  const text = "see https://a.example.com and then http://b.example.org/path?q=1 next";
  assert.deepEqual(extractUrls(text), [
    "https://a.example.com",
    "http://b.example.org/path?q=1",
  ]);
});

test("extractUrls strips trailing sentence punctuation", () => {
  const text =
    "go to https://example.com. (or https://example.com/docs), maybe https://example.com/x;";
  assert.deepEqual(extractUrls(text), [
    "https://example.com",
    "https://example.com/docs",
    "https://example.com/x",
  ]);
});

test("extractUrls dedupes preserving first-seen order", () => {
  const text = [
    "https://z.example.com/last",
    "https://a.example.com/first",
    "https://z.example.com/last", // dupe — dropped
    "https://a.example.com/first", // dupe — dropped
  ].join("\n");
  assert.deepEqual(extractUrls(text), [
    "https://z.example.com/last",
    "https://a.example.com/first",
  ]);
});

test("extractUrls returns [] when there are no URLs", () => {
  assert.deepEqual(extractUrls("just some plain text, no links here"), []);
  assert.deepEqual(extractUrls(""), []);
  // A bare ftp:// / mailto: is not an http(s) website URL — not matched.
  assert.deepEqual(extractUrls("ftp://nope.example.com mailto:a@b.com"), []);
});

test("extractUrls does not swallow following text across whitespace/quotes", () => {
  assert.deepEqual(extractUrls('open "https://example.com/a" then stop'), [
    "https://example.com/a",
  ]);
});


test("docs/honeybee.tmux.conf contains CANONICAL_TMUX_CONF (the affordances block)", async () => {
  // The doc is the operator's curated conf (bees/new/next/rename) with this
  // layer's affordances block appended; `hive keys print --tmux` emits just the
  // block. The drift guard is containment, not equality.
  const docPath = resolve(fileURLToPath(new URL("..", import.meta.url)), "docs", "honeybee.tmux.conf");
  const onDisk = await readFile(docPath, "utf8");
  assert.ok(onDisk.includes(CANONICAL_TMUX_CONF), "docs/honeybee.tmux.conf drifted from CANONICAL_TMUX_CONF — regenerate it (append `hive keys print --tmux`)");
});
