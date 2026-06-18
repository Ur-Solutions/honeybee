// Pure-logic coverage for the `hive loop launch` dialog (src/loopTui.ts): how
// the form seeds from a template (or "blank"), the flag map handed to
// the detached loop runner, the launch gate, and the focusable-row model behind
// the advanced toggle. The interactive render loop is not unit-tested (it needs
// a TTY); these are the load-bearing decisions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLoopConfig } from "../src/loop/context.js";
import { formRows, loopStartArgs, missingForLaunch, seedFormFromTemplate, type LoopFormValues } from "../src/loopTui.js";
import type { LoopTemplate } from "../src/loopTemplate.js";

const template: LoopTemplate = {
  name: "nightly",
  prompt: "keep the build green",
  bee: "claude-auto",
  context: "ralph",
  max: "10",
  forever: true,
  yolo: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("seedFormFromTemplate(null): blank loop seeds empty fields with persistent default", () => {
  const v = seedFormFromTemplate(null);
  assert.equal(v.context, "persistent");
  assert.equal(v.bee, "");
  assert.equal(v.prompt, "");
  assert.equal(v.until, "");
  assert.equal(v.max, "100");
  assert.equal(v.maxDuration, "");
  assert.equal(v.forever, false);
  assert.equal(v.yolo, false);
  assert.equal(v.summarizer, "");
});

test("seedFormFromTemplate copies every loop-config field across", () => {
  const v = seedFormFromTemplate(template);
  assert.equal(v.context, "ralph");
  assert.equal(v.bee, "claude-auto");
  assert.equal(v.prompt, "keep the build green");
  assert.equal(v.max, "10");
  assert.equal(v.forever, true);
  assert.equal(v.yolo, true);
  // Fields the template omits fall back to the blank defaults.
  assert.equal(v.until, "");
  assert.equal(v.summarizer, "");

  const legacy = seedFormFromTemplate({ name: "legacy", prompt: "go", createdAt: template.createdAt, updatedAt: template.updatedAt });
  assert.equal(legacy.max, "100", "templates that omit max inherit the dialog's default cap");
});

test("loopStartArgs emits only non-empty/truthy fields for the detached runner", () => {
  const v = seedFormFromTemplate(template);
  v.prompt = "  trim me  ";
  v.until = "";
  const args = loopStartArgs(v);
  assert.deepEqual(args, {
    context: "ralph",
    bee: "claude-auto",
    prompt: "trim me", // trimmed
    max: "10",
    forever: true,
    yolo: true,
  });
  assert.equal("until" in args, false, "empty fields are omitted");
  assert.equal("cwd" in args, false, "cwd is chosen per launch, not part of the form map");
});

test("loopStartArgs maps advanced fields to buildLoopConfig's runtime keys", () => {
  const v: LoopFormValues = {
    ...seedFormFromTemplate(null),
    bee: "claude",
    prompt: "go",
    maxDuration: "30m",
    stopOnSeal: "done,blocked",
    stopOnSentinel: "ALL DONE",
    judge: "claude",
    summarizer: "bee",
  };
  const args = loopStartArgs(v);
  assert.equal(args.maxDuration, "30m");
  assert.equal(args.stopOnSeal, "done,blocked");
  assert.equal(args.stopOnSentinel, "ALL DONE");
  assert.equal(args.judge, "claude");
  assert.equal(args.summarizer, "bee");
  assert.equal(args.forever, undefined, "false booleans are omitted");

  const cfg = buildLoopConfig({ ...args, cwd: "/tmp", loopId: "L1" });
  assert.equal(cfg.stop.maxDurationMs, 1_800_000);
  assert.deepEqual(cfg.stop.stopOnSeal, ["done", "blocked"]);
  assert.equal(cfg.stop.stopOnSentinel, "ALL DONE");
  assert.equal(cfg.summarizer, "bee");
});

test("missingForLaunch mirrors the detached runner's required fields", () => {
  assert.deepEqual(missingForLaunch(seedFormFromTemplate(null)), ["bee", "prompt"]);
  assert.deepEqual(missingForLaunch({ ...seedFormFromTemplate(null), prompt: "   " }), ["bee", "prompt"], "whitespace-only prompt is blank");
  assert.deepEqual(missingForLaunch({ ...seedFormFromTemplate(null), prompt: "go" }), ["bee"], "a prompt alone is not enough");
  assert.deepEqual(missingForLaunch({ ...seedFormFromTemplate(null), bee: "claude", prompt: "go" }), []);
  assert.deepEqual(missingForLaunch({ ...seedFormFromTemplate(null), bee: "claude", prompt: "go", max: "" }), ["max"]);
  assert.deepEqual(missingForLaunch({ ...seedFormFromTemplate(null), bee: "claude", prompt: "go", max: "", forever: true }), [], "forever loops do not need max");
});

test("formRows: advanced fields hide when collapsed, reveal when expanded; actions always last", () => {
  const collapsed = formRows(false);
  const expanded = formRows(true);

  // Essentials in order, then the toggle.
  assert.deepEqual(
    collapsed.slice(0, 4).map((r) => (r.kind === "field" ? r.key : r.kind)),
    ["context", "bee", "prompt", "toggle"],
  );
  // Collapsed: toggle is followed directly by the two action rows.
  const collapsedTail = collapsed.slice(4);
  assert.deepEqual(collapsedTail.map((r) => (r.kind === "action" ? r.action : r.kind)), ["save", "launch"]);

  // Expanded reveals the advanced fields between the toggle and the actions.
  assert.ok(expanded.length > collapsed.length, "expanding adds rows");
  const advancedKeys = expanded
    .filter((r) => r.kind === "field" && ["until", "max", "maxDuration", "forever", "stopOnSeal", "stopOnSentinel", "judge", "summarizer", "yolo"].includes(r.key))
    .map((r) => (r.kind === "field" ? r.key : ""));
  assert.deepEqual(advancedKeys, ["until", "max", "maxDuration", "forever", "stopOnSeal", "stopOnSentinel", "judge", "summarizer", "yolo"]);

  // The last two rows are always the actions, in both states.
  for (const list of [collapsed, expanded]) {
    const last2 = list.slice(-2);
    assert.deepEqual(last2.map((r) => (r.kind === "action" ? r.action : r.kind)), ["save", "launch"]);
  }
});

test("formRows: every field row carries a non-empty description", () => {
  for (const row of formRows(true)) {
    assert.ok(row.description.length > 0, `${JSON.stringify(row)} should have help text`);
  }
});
