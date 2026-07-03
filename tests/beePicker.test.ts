// Behavioral coverage for the shared bee-picker overlay (src/beePicker.ts):
// lazy loading, fuzzy filtering, choosing an option, escape, and the loading /
// error / empty render states.
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as readline from "node:readline";
import { stripAnsi } from "../src/format.js";
import { createBeePicker, type BeeOption } from "../src/beePicker.js";

const key = (name: string, extra: Partial<readline.Key> = {}): readline.Key => ({ sequence: "", name, ctrl: false, meta: false, shift: false, ...extra });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const OPTIONS: BeeOption[] = [
  { value: "claude-auto", label: "claude · auto", detail: "least-loaded" },
  { value: "codex-rr", label: "codex · rr" },
  { value: "codex-thto", label: "codex · thto.no" },
];

function makeBeePicker(load: () => Promise<BeeOption[]> = async () => OPTIONS) {
  const chosen: string[] = [];
  let done = false;
  const picker = createBeePicker({
    title: () => "pick the agent",
    load,
    onChosen: (value) => chosen.push(value),
    render: () => {},
    isDone: () => done,
  });
  return { picker, chosen, finish: () => { done = true; } };
}

test("open loads options once and renders the title, prompt, and rows", async () => {
  let loads = 0;
  const { picker } = makeBeePicker(async () => { loads += 1; return OPTIONS; });
  assert.equal(picker.active, false);
  await picker.open();
  assert.equal(picker.active, true);
  const body = picker.render(80, 20).map(stripAnsi);
  assert.equal(body[0], "pick the agent");
  assert.equal(body[1], "> ");
  assert.ok(body.some((l) => l.includes("claude · auto")));
  assert.ok(body.some((l) => l.includes("least-loaded")), "detail is rendered");

  // Reopening reuses the cached options (no second load).
  await picker.open();
  assert.equal(loads, 1);
});

test("typing filters options; enter writes the chosen value and closes", async () => {
  const { picker, chosen } = makeBeePicker();
  await picker.open();
  for (const ch of "thto") assert.equal(picker.onKey(ch, key(ch)), true);
  const body = picker.render(80, 20).map(stripAnsi);
  assert.ok(body.some((l) => l.includes("codex · thto.no")));
  assert.ok(!body.some((l) => l.includes("claude · auto")), "non-matches are filtered out");

  assert.equal(picker.onKey("", key("return")), true);
  assert.deepEqual(chosen, ["codex-thto"]);
  assert.equal(picker.active, false);
});

test("escape closes the overlay without choosing", async () => {
  const { picker, chosen } = makeBeePicker();
  await picker.open();
  assert.equal(picker.onKey("", key("escape")), true);
  assert.equal(picker.active, false);
  assert.deepEqual(chosen, []);
});

test("onKey is inert until the overlay is open", () => {
  const { picker } = makeBeePicker();
  assert.equal(picker.onKey("", key("down")), false);
});

test("cursor parks on the query line (2nd body row); null when closed", async () => {
  const { picker } = makeBeePicker();
  assert.equal(picker.cursor(), null);
  await picker.open();
  for (const ch of "cl") picker.onKey(ch, key(ch));
  assert.deepEqual(picker.cursor(), { line: 1, col: 2 + "cl".length + 1 });
});

test("render surfaces loading, error, and empty states", async () => {
  // Error: load rejects.
  const errPicker = makeBeePicker(async () => { throw new Error("no accounts"); });
  await errPicker.picker.open();
  assert.ok(errPicker.picker.render(80, 20).map(stripAnsi).some((l) => l.includes("no accounts")));

  // Empty: a query that matches nothing.
  const { picker } = makeBeePicker();
  await picker.open();
  for (const ch of "zzzz") picker.onKey(ch, key(ch));
  assert.ok(picker.render(80, 20).map(stripAnsi).includes("no match"));
});
