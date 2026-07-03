// Behavioral coverage for the shared repo/cwd picker (src/projectPicker.ts):
// menu navigation, the fuzzy repo browser, the live path completer (drill +
// submit), the transient error line, and the two config modes — menu-owning
// (loop/launch) vs. menu-external (spawnTui), including the busy guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as readline from "node:readline";
import { stripAnsi } from "../src/format.js";
import { createProjectPicker, type ProjectPickerConfig } from "../src/projectPicker.js";

const key = (name: string, extra: Partial<readline.Key> = {}): readline.Key => ({ sequence: "", name, ctrl: false, meta: false, shift: false, ...extra });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const TEXT: ProjectPickerConfig["text"] = {
  browseMenuLabel: "browse repos…",
  pathMenuLabel: "type a path…",
  menuMessage: "MENU",
  browseMessage: "BROWSE",
  pathMessage: "PATH",
  browseLoading: "loading repos…",
  browseEmptyNone: "no repos found",
  pathFallback: "enter uses the typed path",
};

function makePicker(overrides: Partial<ProjectPickerConfig> = {}) {
  const chosen: Array<{ path: string; source: string }> = [];
  const messages: string[] = [];
  const busy: boolean[] = [];
  const writes: string[] = [];
  let done = false;
  const config: ProjectPickerConfig = {
    hooks: {
      defaultCwd: "/home/u/proj",
      defaultCwdLabel: "~/proj",
      loadProjects: async () => [
        { label: "honeybee", path: "/repos/honeybee" },
        { label: "forge", path: "/repos/forge" },
      ],
      validatePath: async (input) => (input === "/valid" ? { ok: true, path: "/valid" } : { ok: false, error: "path does not exist" }),
      listSubdirs: async (base) => ({ ok: true, base, dirs: [`${base}/aardvark`, `${base}/badger`] }),
    },
    text: TEXT,
    ownsMenu: true,
    onChosen: (path, source) => chosen.push({ path, source }),
    onBack: () => {},
    onQuit: () => {},
    setMessage: (m) => messages.push(m),
    render: () => {},
    isDone: () => done,
    stdout: { write: (c) => { writes.push(c); } },
    ...overrides,
  };
  const picker = createProjectPicker(config);
  return { picker, chosen, messages, busy, writes, finish: () => { done = true; } };
}

test("menu (ownsMenu): renders here + labels, navigates, and 'here' chooses the default cwd", () => {
  const { picker, chosen, messages } = makePicker();
  assert.equal(picker.view(), "menu");
  const rows = picker.render(80, 20).map(stripAnsi);
  assert.match(rows[0]!, /^› here  ~\/proj/); // focused row carries the › pointer
  assert.equal(rows[1], "  browse repos…");
  assert.equal(rows[2], "  type a path…");

  // Enter on the first row (here) finalizes the default cwd.
  assert.equal(picker.onKey("", key("return")), true);
  assert.deepEqual(chosen, [{ path: "/home/u/proj", source: "here" }]);

  // Down then enter activates "browse repos…" → enters the browser.
  assert.equal(picker.onKey("", key("down")), true);
  assert.equal(picker.onKey("", key("enter")), true);
  assert.equal(picker.view(), "browse");
  assert.ok(messages.includes("BROWSE"));
});

test("browse: loads repos, filters by query, and enter chooses the repo path", async () => {
  const { picker, chosen } = makePicker();
  picker.enterBrowse();
  await flush();
  assert.equal(picker.view(), "browse");
  let body = picker.render(80, 20).map(stripAnsi);
  assert.equal(body[0], "> ");
  assert.equal(body[1], "2/2 repos");
  assert.ok(body.some((l) => l.includes("honeybee")) && body.some((l) => l.includes("forge")));

  // Type "for" → only forge survives; enter picks it.
  for (const ch of "for") assert.equal(picker.onKey(ch, key(ch)), true);
  body = picker.render(80, 20).map(stripAnsi);
  assert.equal(body[0], "> for");
  assert.equal(body[1], "1/2 repos");
  assert.equal(picker.onKey("", key("return")), true);
  assert.deepEqual(chosen, [{ path: "/repos/forge", source: "browse" }]);
});

test("browse: escape returns to the menu (ownsMenu)", async () => {
  const { picker, messages } = makePicker();
  picker.enterBrowse();
  await flush();
  assert.equal(picker.onKey("", key("escape")), true);
  assert.equal(picker.view(), "menu");
  assert.equal(messages.at(-1), "MENU");
});

test("path: completes subdirs, tab drills in, and enter on a match chooses it", async () => {
  const { picker, chosen } = makePicker();
  picker.enterPath();
  await flush();
  assert.equal(picker.view(), "path");
  let body = picker.render(80, 20).map(stripAnsi);
  assert.equal(body[0], "> /home/u/proj/");
  assert.match(body[1]!, /2 folders · tab drills in/);
  assert.ok(body.some((l) => l.trim().endsWith("aardvark")));

  // Tab drills into the highlighted folder (aardvark).
  assert.equal(picker.onKey("", key("tab")), true);
  await flush();
  body = picker.render(80, 20).map(stripAnsi);
  assert.equal(body[0], "> /home/u/proj/aardvark/");

  // Enter on the first completion picks its absolute path.
  assert.equal(picker.onKey("", key("return")), true);
  assert.deepEqual(chosen, [{ path: "/home/u/proj/aardvark/aardvark", source: "path" }]);
});

test("path: a typed non-matching path validates, and an invalid one surfaces via errorLine", async () => {
  const { picker, chosen } = makePicker();
  picker.enterPath();
  await flush();
  // Filter to no completion match, then submit the literal (invalid) buffer.
  for (const ch of "zzz") assert.equal(picker.onKey(ch, key(ch)), true);
  assert.equal(picker.render(80, 20).map(stripAnsi)[1], "no subfolders match — enter uses the typed path");
  assert.equal(picker.onKey("", key("return")), true);
  await flush();
  assert.equal(chosen.length, 0);
  assert.equal(picker.errorLine(), "path does not exist");
});

test("menu-external (spawnTui): onKey is ignored on the menu, but drives browse/path", () => {
  const { picker } = makePicker({ ownsMenu: false });
  // The host owns the menu column, so the picker declines menu keys.
  assert.equal(picker.onKey("", key("down")), false);
  assert.equal(picker.onKey("", key("return")), false);
  // Once the host enters a sub-mode, the picker consumes keys again.
  picker.enterBrowse();
  assert.equal(picker.active(), true);
  assert.equal(picker.onKey("", key("down")), true);
});

test("path: the busy guard brackets validation when guardValidate is set (spawnTui)", async () => {
  const busy: boolean[] = [];
  const { picker } = makePicker({ ownsMenu: false, guardValidate: true, setBusy: (b) => busy.push(b) });
  picker.enterPath();
  await flush();
  for (const ch of "zzz") picker.onKey(ch, key(ch));
  picker.onKey("", key("return"));
  await flush();
  assert.deepEqual(busy, [true, false], "validation is wrapped in a busy set/clear");
});

test("cursor: browse/path park on the first body line; menu hides the cursor", async () => {
  const { picker } = makePicker();
  assert.equal(picker.cursor(), null); // menu → hidden
  picker.enterBrowse();
  await flush();
  for (const ch of "ho") picker.onKey(ch, key(ch));
  assert.deepEqual(picker.cursor(), { line: 0, col: 2 + "ho".length + 1 });
});
