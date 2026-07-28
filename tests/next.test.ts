import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionCount, DEFAULT_ATTENTION_STATES, parseStateList, pickNextBee, type BeeStateEntry } from "../src/next.js";

function bees(...pairs: [string, string][]): BeeStateEntry[] {
  return pairs.map(([name, state]) => ({ name, state }));
}

const ATTENTION = DEFAULT_ATTENTION_STATES;

test("picks the first attention bee when current is working", () => {
  const sessions = bees(["CL-c", "working"], ["CL-a", "needs-reply"], ["CL-b", "ready"]);
  assert.equal(pickNextBee(sessions, "CL-c", { states: ATTENTION }), "CL-a");
});

test("skips working bees entirely", () => {
  const sessions = bees(["CL-a", "working"], ["CL-b", "working"]);
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), undefined);
});

test("needs-auth/needs-reply/needs-action rank above ready, regardless of name order", () => {
  const sessions = bees(["CL-a", "ready"], ["CL-x", "needs-reply"], ["CL-y", "needs-auth"], ["CL-z", "needs-action"]);
  // Entry from a non-queue bee lands on the highest-priority group first.
  assert.equal(pickNextBee(sessions, undefined, { states: ATTENTION }), "CL-y");
  // The walk visits the request-holding bees before any ready one.
  assert.equal(pickNextBee(sessions, "CL-y", { states: ATTENTION }), "CL-x");
  assert.equal(pickNextBee(sessions, "CL-x", { states: ATTENTION }), "CL-z");
  assert.equal(pickNextBee(sessions, "CL-z", { states: ATTENTION }), "CL-a");
});

test("cycles through the queue, anchored on the current bee, and wraps", () => {
  const sessions = bees(["CL-a", "needs-reply"], ["CL-b", "ready"], ["CL-c", "ready"]);
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), "CL-b");
  assert.equal(pickNextBee(sessions, "CL-b", { states: ATTENTION }), "CL-c");
  assert.equal(pickNextBee(sessions, "CL-c", { states: ATTENTION }), "CL-a");
});

test("--prev walks the queue backwards and wraps", () => {
  const sessions = bees(["CL-a", "needs-reply"], ["CL-b", "ready"], ["CL-c", "stop-failed"]);
  // Priority order: CL-a (needs-reply), CL-c (stop-failed), CL-b (ready).
  assert.equal(pickNextBee(sessions, "CL-c", { states: ATTENTION, prev: true }), "CL-a");
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION, prev: true }), "CL-b");
});

test("--prev from a working bee starts at the back of the queue", () => {
  const sessions = bees(["CL-w", "working"], ["CL-a", "needs-reply"], ["CL-b", "ready"]);
  assert.equal(pickNextBee(sessions, "CL-w", { states: ATTENTION, prev: true }), "CL-b");
});

test("no current (outside tmux) starts at the front", () => {
  const sessions = bees(["CL-b", "ready"], ["CL-a", "needs-reply"]);
  assert.equal(pickNextBee(sessions, undefined, { states: ATTENTION }), "CL-a");
});

test("within a priority group ordering is by name, independent of listing order", () => {
  const sessions = bees(["CL-z", "needs-reply"], ["CL-a", "needs-reply"], ["CL-m", "ready"]);
  assert.equal(pickNextBee(sessions, undefined, { states: ATTENTION }), "CL-a");
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), "CL-z");
  assert.equal(pickNextBee(sessions, "CL-z", { states: ATTENTION }), "CL-m");
});

test("a single attention bee that is the current one returns itself", () => {
  const sessions = bees(["CL-a", "needs-reply"], ["CL-b", "working"]);
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), "CL-a");
});

test("custom state set narrows the queue and its order is the visiting order", () => {
  const sessions = bees(["CL-a", "needs-reply"], ["CL-b", "ready"], ["CL-c", "stop-failed"]);
  assert.equal(pickNextBee(sessions, undefined, { states: ["ready"] }), "CL-b");
  assert.equal(pickNextBee(sessions, "CL-b", { states: ["ready"] }), "CL-b");
  // A custom order ranks ready above needs-reply when asked to.
  assert.equal(pickNextBee(sessions, undefined, { states: ["ready", "needs-reply"] }), "CL-b");
});

test("states outside the wanted set are never in the queue", () => {
  const sessions = bees(["view-x", "offline"], ["CL-a", "needs-reply"], ["CL-b", "crashed"]);
  assert.equal(pickNextBee(sessions, undefined, { states: ATTENTION }), "CL-a");
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), "CL-a");
});

test("attentionCount tallies only the wanted states", () => {
  const sessions = bees(["CL-a", "needs-reply"], ["CL-b", "ready"], ["CL-c", "working"]);
  assert.equal(attentionCount(sessions, ATTENTION), 2);
  assert.equal(attentionCount(sessions, ["working"]), 1);
});

test("parseStateList parses, lowercases, and de-dupes display states", () => {
  assert.deepEqual(parseStateList("needs-reply,ready"), ["needs-reply", "ready"]);
  assert.deepEqual(parseStateList("Needs-Reply, NEEDS-REPLY ,ready"), ["needs-reply", "ready"]);
  // The whole display vocabulary is accepted, including working.
  assert.deepEqual(parseStateList("working"), ["working"]);
});

test("parseStateList rejects unknown states, including the retired @hive_state vocabulary", () => {
  assert.throws(() => parseStateList("needs-reply,bogus"), /Unknown display state: bogus/);
  assert.throws(() => parseStateList("waiting"), /Unknown display state: waiting/);
});

test("parseStateList rejects an empty list", () => {
  assert.throws(() => parseStateList(" , "), /at least one state/);
});
