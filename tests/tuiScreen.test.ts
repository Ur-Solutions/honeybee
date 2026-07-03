// Coverage for the composable list primitive behind the pickers
// (src/tuiScreen.ts): the pure scroll-window math and the fuzzy FilterList's
// query editing, cursor clamping, and windowing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as readline from "node:readline";
import { createFilterList, visibleWindow } from "../src/tuiScreen.js";

const key = (extra: Partial<readline.Key> = {}): readline.Key => ({ sequence: "", name: "", ctrl: false, meta: false, shift: false, ...extra });

test("visibleWindow: no scroll when the cursor fits the window", () => {
  assert.deepEqual(visibleWindow(0, 0, 3, 5), { scroll: 0, indices: [0, 1, 2] });
  assert.deepEqual(visibleWindow(2, 0, 3, 5), { scroll: 0, indices: [0, 1, 2] });
});

test("visibleWindow: scrolls down to keep the cursor in view, up when it leaves the top", () => {
  assert.deepEqual(visibleWindow(3, 0, 3, 5), { scroll: 1, indices: [1, 2, 3] });
  assert.deepEqual(visibleWindow(4, 0, 3, 5), { scroll: 2, indices: [2, 3, 4] });
  assert.deepEqual(visibleWindow(1, 2, 3, 5), { scroll: 1, indices: [1, 2, 3] });
});

test("visibleWindow: a short list never asks for rows past the end", () => {
  assert.deepEqual(visibleWindow(0, 0, 5, 2), { scroll: 0, indices: [0, 1] });
  assert.deepEqual(visibleWindow(0, 0, 5, 0), { scroll: 0, indices: [] });
});

test("createFilterList: empty query keeps source order; typing filters and resets the cursor", () => {
  const items = ["alpha", "beta", "gamma"];
  const list = createFilterList<string>(() => items, (x) => x);
  assert.deepEqual(list.filtered(), items);

  list.cursor = 2;
  assert.equal(list.handleNavKey("b", key({ name: "b" })), true);
  assert.equal(list.query, "b");
  assert.equal(list.cursor, 0, "editing the query re-homes the cursor");
  assert.deepEqual(list.filtered(), ["beta"]);
  assert.equal(list.selected(), "beta");
});

test("createFilterList: up/down move and clamp; backspace and ctrl-u edit the query", () => {
  const items = ["a", "b", "c"];
  const list = createFilterList<string>(() => items, (x) => x);

  assert.equal(list.handleNavKey("", key({ name: "down" })), true);
  assert.equal(list.cursor, 1);
  assert.equal(list.handleNavKey("", key({ name: "down" })), true);
  assert.equal(list.handleNavKey("", key({ name: "down" })), true);
  assert.equal(list.cursor, 2, "clamped to the last row");
  assert.equal(list.handleNavKey("", key({ name: "up" })), true);
  assert.equal(list.cursor, 1);

  list.query = "xy";
  list.cursor = 1;
  assert.equal(list.handleNavKey("", key({ name: "backspace" })), true);
  assert.equal(list.query, "x");
  assert.equal(list.cursor, 0);
  assert.equal(list.handleNavKey("u", key({ name: "u", ctrl: true })), true);
  assert.equal(list.query, "");

  // Non-editing keys (enter/escape/tab) are the host's to interpret.
  assert.equal(list.handleNavKey("", key({ name: "return" })), false);
  assert.equal(list.handleNavKey("", key({ name: "escape" })), false);
});

test("createFilterList: visible() windows the filtered list and flags the focused row", () => {
  const items = Array.from({ length: 10 }, (_, i) => `row${i}`);
  const list = createFilterList<string>(() => items, (x) => x);
  list.cursor = 6;
  const rows = list.visible(3);
  assert.deepEqual(rows.map((r) => r.idx), [4, 5, 6]);
  assert.deepEqual(rows.map((r) => r.item), ["row4", "row5", "row6"]);
  assert.deepEqual(rows.map((r) => r.focused), [false, false, true]);

  list.reset();
  assert.equal(list.query, "");
  assert.equal(list.cursor, 0);
  assert.deepEqual(list.visible(3).map((r) => r.idx), [0, 1, 2], "reset re-homes the scroll offset");
});
