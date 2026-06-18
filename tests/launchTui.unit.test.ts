// Pure-logic coverage for the `hive launch` frame/flow launcher form
// (src/launchTui.ts): which args are required, how the editable buffers seed
// from defaults, and the launch gate (missing required args). The interactive
// render loop is not unit-tested (it needs a TTY); these are the load-bearing
// decisions the wizard makes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beeSlotLabel, missingRequiredArgs, requiredArgNames, seedArgValues, seedBeeMessages, type LaunchTemplate } from "../src/launchTui.js";

const frame: LaunchTemplate = { kind: "frame", name: "deep-review", beeCount: 4 };
const flow: LaunchTemplate = {
  kind: "flow",
  name: "loop",
  args: [
    { name: "bee" }, // required (no default)
    { name: "cwd" }, // required
    { name: "prompt" }, // required
    { name: "until", default: "" }, // optional (has a default, even if empty)
    { name: "max", default: "10" }, // optional
  ],
};

test("requiredArgNames: only args without a default; frames have none", () => {
  assert.deepEqual(requiredArgNames(flow), ["bee", "cwd", "prompt"]);
  assert.deepEqual(requiredArgNames(frame), []);
});

test("seedArgValues: every arg gets a starting buffer (default, or '' when required)", () => {
  assert.deepEqual(seedArgValues(flow), { bee: "", cwd: "", prompt: "", until: "", max: "10" });
  assert.deepEqual(seedArgValues(frame), {}, "a frame seeds no arg buffers");
});

test("missingRequiredArgs: blank/whitespace required args block launch; optionals never do", () => {
  // Nothing filled → all three required are missing, in declaration order.
  assert.deepEqual(missingRequiredArgs(flow, seedArgValues(flow)), ["bee", "cwd", "prompt"]);
  // Fill two, leave one whitespace-only → still missing.
  assert.deepEqual(
    missingRequiredArgs(flow, { bee: "CL.1", cwd: "/tmp", prompt: "   ", until: "", max: "10" }),
    ["prompt"],
  );
  // All required filled (optionals empty) → launch is unblocked.
  assert.deepEqual(
    missingRequiredArgs(flow, { bee: "CL.1", cwd: "/tmp", prompt: "go", until: "", max: "" }),
    [],
  );
  // A frame is always launchable.
  assert.deepEqual(missingRequiredArgs(frame, {}), []);
});

const briefedFrame: LaunchTemplate = {
  kind: "frame",
  name: "review",
  beeCount: 3,
  beeSlots: [
    { caste: "lead", bee: "claude", index: 1, count: 1, brief: "drive the review" },
    { caste: "worker", bee: "claude", index: 1, count: 2 },
    { caste: "worker", bee: "claude", index: 2, count: 2 },
  ],
};

test("seedBeeMessages: each bee field seeds from its caste brief ('' when none)", () => {
  assert.deepEqual(seedBeeMessages(briefedFrame), ["drive the review", "", ""]);
  // A frame with no slots (e.g. a flow-shaped template) seeds nothing.
  assert.deepEqual(seedBeeMessages(frame), []);
});

test("beeSlotLabel: bare caste name for singletons, 'i/n' when the caste fans out", () => {
  assert.equal(beeSlotLabel(briefedFrame.beeSlots![0]!), "lead");
  assert.equal(beeSlotLabel(briefedFrame.beeSlots![1]!), "worker 1/2");
  assert.equal(beeSlotLabel(briefedFrame.beeSlots![2]!), "worker 2/2");
});
