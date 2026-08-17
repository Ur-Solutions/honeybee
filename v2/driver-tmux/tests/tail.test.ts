/**
 * JsonlTail — the polling tailer's disciplines: append/poll, partial-line
 * carry, truncation reset, rotation → EOF jump, skipExisting resume.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTail } from "../src/tail.ts";

function rig(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-tail-"));
  return { dir, file: join(dir, "t.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("tail.basic: appended lines arrive once, in order; missing file is quiet", () => {
  const r = rig();
  try {
    const tail = new JsonlTail(r.file);
    assert.deepEqual(tail.poll(), []); // not there yet
    writeFileSync(r.file, "a\nb\n");
    assert.deepEqual(tail.poll(), ["a", "b"]);
    assert.deepEqual(tail.poll(), []);
    appendFileSync(r.file, "c\n");
    assert.deepEqual(tail.poll(), ["c"]);
  } finally {
    r.cleanup();
  }
});

test("tail.partial: a line still being written is carried, not emitted", () => {
  const r = rig();
  try {
    const tail = new JsonlTail(r.file);
    writeFileSync(r.file, "complete\npart");
    assert.deepEqual(tail.poll(), ["complete"]);
    appendFileSync(r.file, "ial\n");
    assert.deepEqual(tail.poll(), ["partial"]);
  } finally {
    r.cleanup();
  }
});

test("tail.truncate: size shrink resets to the start", () => {
  const r = rig();
  try {
    const tail = new JsonlTail(r.file);
    writeFileSync(r.file, "one long line here\n");
    assert.equal(tail.poll().length, 1);
    writeFileSync(r.file, "x\n"); // same inode, smaller
    assert.deepEqual(tail.poll(), ["x"]);
  } finally {
    r.cleanup();
  }
});

test("tail.rotation: identity change jumps to EOF — history is never replayed", () => {
  const r = rig();
  try {
    const tail = new JsonlTail(r.file);
    writeFileSync(r.file, "old-1\n");
    assert.deepEqual(tail.poll(), ["old-1"]);
    // Rotate: a NEW file (new inode) replaces the path with history inside.
    renameSync(r.file, join(r.dir, "rotated"));
    writeFileSync(join(r.dir, "fresh"), "history-1\nhistory-2\n");
    renameSync(join(r.dir, "fresh"), r.file);
    assert.deepEqual(tail.poll(), [], "rotated-in history must not replay");
    appendFileSync(r.file, "new-1\n");
    assert.deepEqual(tail.poll(), ["new-1"]);
  } finally {
    r.cleanup();
  }
});

test("tail.skipExisting: resume semantics start at EOF of a pre-existing file", () => {
  const r = rig();
  try {
    writeFileSync(r.file, "past-1\npast-2\n");
    const tail = new JsonlTail(r.file, { skipExisting: true });
    assert.deepEqual(tail.poll(), [], "pre-existing content skipped on adopt");
    appendFileSync(r.file, "live-1\n");
    assert.deepEqual(tail.poll(), ["live-1"]);
  } finally {
    r.cleanup();
  }
});
