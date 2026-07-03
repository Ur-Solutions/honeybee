/**
 * Hermetic tests for the shared NDJSON line reader (HIVE-21).
 *
 * makeLineReader was copy-pasted three ways (streamRunner.ts stdout/stderr,
 * adapters/codexRpc.ts, rpc.ts) before this extraction. These lock in the exact
 * framing contract all three now depend on so a future change to one reader
 * can't silently break the others:
 *   - one line per '\n', in order
 *   - a partial trailing line is retained until a later chunk completes it
 *   - a trailing '\r' is stripped (CRLF), leading/interior whitespace kept
 *   - empty AND whitespace-only lines are dropped (never handed to onLine)
 *   - byte-chunk boundaries anywhere (including mid-line) are transparent
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeLineReader } from "../src/hsr/lineReader.js";

/** Feed each chunk through a fresh reader and collect the emitted lines. */
function readAll(chunks: string[]): string[] {
  const out: string[] = [];
  const feed = makeLineReader((line) => out.push(line));
  for (const c of chunks) feed(Buffer.from(c, "utf8"));
  return out;
}

test("emits one line per newline, in order", () => {
  assert.deepEqual(readAll(["a\nb\nc\n"]), ["a", "b", "c"]);
});

test("retains a partial trailing line until a later chunk completes it", () => {
  const out: string[] = [];
  const feed = makeLineReader((line) => out.push(line));
  feed(Buffer.from('{"a":1', "utf8"));
  assert.deepEqual(out, []); // no newline yet → nothing emitted
  feed(Buffer.from('}\n', "utf8"));
  assert.deepEqual(out, ['{"a":1}']);
});

test("a line split across arbitrary byte-chunk boundaries reassembles", () => {
  assert.deepEqual(readAll(["hel", "lo wor", "ld\n"]), ["hello world"]);
});

test("multiple lines in a single chunk all fire", () => {
  assert.deepEqual(readAll(["x\ny\nz\n"]), ["x", "y", "z"]);
});

test("strips a trailing CR (CRLF) but preserves leading/interior whitespace", () => {
  // "\r" stripped; the two leading spaces and interior space are kept verbatim.
  assert.deepEqual(readAll(["  a b\r\n"]), ["  a b"]);
});

test("drops empty and whitespace-only lines", () => {
  assert.deepEqual(readAll(["a\n\n \t \n\r\nb\n"]), ["a", "b"]);
});

test("does not emit a final line that has no trailing newline", () => {
  assert.deepEqual(readAll(["done\npartial"]), ["done"]);
});

test("each reader instance keeps its own buffer", () => {
  const outA: string[] = [];
  const outB: string[] = [];
  const feedA = makeLineReader((l) => outA.push(l));
  const feedB = makeLineReader((l) => outB.push(l));
  feedA(Buffer.from("a-par", "utf8"));
  feedB(Buffer.from("b-par", "utf8"));
  feedA(Buffer.from("tial\n", "utf8"));
  feedB(Buffer.from("tial\n", "utf8"));
  assert.deepEqual(outA, ["a-partial"]);
  assert.deepEqual(outB, ["b-partial"]);
});
