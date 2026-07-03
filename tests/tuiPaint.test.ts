import assert from "node:assert/strict";
import { test } from "node:test";
import { createTuiPainter } from "../src/tuiPaint.js";

function fakeOut(): { writes: string[]; write: (chunk: string) => void } {
  const writes: string[] = [];
  return { writes, write: (chunk: string) => writes.push(chunk) };
}

test("tuiPaint: first paint clears the screen and writes the full frame", () => {
  const out = fakeOut();
  const painter = createTuiPainter(out);
  painter.paint(["title", "body", "footer"], 80, 24);
  assert.deepEqual(out.writes, ["\x1b[2J\x1b[Htitle\nbody\nfooter"]);
});

test("tuiPaint: an identical frame writes nothing", () => {
  const out = fakeOut();
  const painter = createTuiPainter(out);
  painter.paint(["title", "body"], 80, 24);
  out.writes.length = 0;
  painter.paint(["title", "body"], 80, 24);
  assert.deepEqual(out.writes, []);
});

test("tuiPaint: only changed lines are rewritten, cleared to end of line", () => {
  const out = fakeOut();
  const painter = createTuiPainter(out);
  painter.paint(["title", "row one", "footer"], 80, 24);
  out.writes.length = 0;
  painter.paint(["title", "row two", "footer"], 80, 24);
  // Row 2 (1-indexed) is repositioned, cleared, rewritten; rows 1 and 3 untouched.
  assert.deepEqual(out.writes, ["\x1b[2;1H\x1b[2Krow two"]);
});

test("tuiPaint: a shrinking frame wipes the rows below it", () => {
  const out = fakeOut();
  const painter = createTuiPainter(out);
  painter.paint(["a", "b", "c", "d"], 80, 24);
  out.writes.length = 0;
  painter.paint(["a", "b"], 80, 24);
  assert.deepEqual(out.writes, ["\x1b[3;1H\x1b[0J"]);
});

test("tuiPaint: a growing frame paints the new rows", () => {
  const out = fakeOut();
  const painter = createTuiPainter(out);
  painter.paint(["a", "b"], 80, 24);
  out.writes.length = 0;
  painter.paint(["a", "b", "c"], 80, 24);
  assert.deepEqual(out.writes, ["\x1b[3;1H\x1b[2Kc"]);
});

test("tuiPaint: a resize forces a full clear + repaint", () => {
  const out = fakeOut();
  const painter = createTuiPainter(out);
  painter.paint(["a", "b"], 80, 24);
  out.writes.length = 0;
  painter.paint(["a", "b"], 80, 25); // height change only
  assert.deepEqual(out.writes, ["\x1b[2J\x1b[Ha\nb"]);
  out.writes.length = 0;
  painter.paint(["a", "b"], 79, 25); // width change only
  assert.deepEqual(out.writes, ["\x1b[2J\x1b[Ha\nb"]);
});

test("tuiPaint: reset forces a full repaint at the same size", () => {
  const out = fakeOut();
  const painter = createTuiPainter(out);
  painter.paint(["a"], 80, 24);
  painter.reset();
  out.writes.length = 0;
  painter.paint(["a"], 80, 24);
  assert.deepEqual(out.writes, ["\x1b[2J\x1b[Ha"]);
});

test("tuiPaint: lines are truncated to the width before diffing", () => {
  const out = fakeOut();
  const painter = createTuiPainter(out);
  painter.paint(["abcdefgh"], 5, 24);
  assert.deepEqual(out.writes, ["\x1b[2J\x1b[Habcd…"]);
  out.writes.length = 0;
  // Different raw line, same truncation → no write.
  painter.paint(["abcdefgz"], 5, 24);
  assert.deepEqual(out.writes, []);
});
