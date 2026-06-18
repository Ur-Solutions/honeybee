import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionCount, DEFAULT_ATTENTION_STATES, parseStateList, pickNextBee, type BeeStateEntry } from "../src/next.js";

function bees(...pairs: [string, string][]): BeeStateEntry[] {
  return pairs.map(([name, state]) => ({ name, state }));
}

const ATTENTION = DEFAULT_ATTENTION_STATES;

test("picks the first attention bee when current is working", () => {
  const sessions = bees(["CL-c", "working"], ["CL-a", "waiting"], ["CL-b", "done"]);
  assert.equal(pickNextBee(sessions, "CL-c", { states: ATTENTION }), "CL-a");
});

test("skips working bees entirely", () => {
  const sessions = bees(["CL-a", "working"], ["CL-b", "working"]);
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), undefined);
});

test("cycles to the next attention bee, anchored on the current one", () => {
  const sessions = bees(["CL-a", "waiting"], ["CL-b", "done"], ["CL-c", "failed"]);
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), "CL-b");
  assert.equal(pickNextBee(sessions, "CL-b", { states: ATTENTION }), "CL-c");
});

test("wraps around the end of the queue", () => {
  const sessions = bees(["CL-a", "waiting"], ["CL-b", "done"]);
  assert.equal(pickNextBee(sessions, "CL-b", { states: ATTENTION }), "CL-a");
});

test("--prev walks the queue backwards and wraps", () => {
  const sessions = bees(["CL-a", "waiting"], ["CL-b", "done"], ["CL-c", "failed"]);
  assert.equal(pickNextBee(sessions, "CL-b", { states: ATTENTION, prev: true }), "CL-a");
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION, prev: true }), "CL-c");
});

test("--prev from a working bee starts at the back of the queue", () => {
  const sessions = bees(["CL-w", "working"], ["CL-a", "waiting"], ["CL-b", "done"]);
  assert.equal(pickNextBee(sessions, "CL-w", { states: ATTENTION, prev: true }), "CL-b");
});

test("no current (outside tmux) starts at the front", () => {
  const sessions = bees(["CL-b", "done"], ["CL-a", "waiting"]);
  assert.equal(pickNextBee(sessions, undefined, { states: ATTENTION }), "CL-a");
});

test("ordering is by name, independent of tmux's listing order", () => {
  const sessions = bees(["CL-z", "waiting"], ["CL-a", "waiting"], ["CL-m", "done"]);
  assert.equal(pickNextBee(sessions, undefined, { states: ATTENTION }), "CL-a");
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), "CL-m");
});

test("a single attention bee that is the current one returns itself", () => {
  const sessions = bees(["CL-a", "waiting"], ["CL-b", "working"]);
  assert.equal(pickNextBee(sessions, "CL-a", { states: ATTENTION }), "CL-a");
});

test("custom state set narrows the queue", () => {
  const sessions = bees(["CL-a", "waiting"], ["CL-b", "done"], ["CL-c", "failed"]);
  assert.equal(pickNextBee(sessions, undefined, { states: ["done"] }), "CL-b");
  assert.equal(pickNextBee(sessions, "CL-b", { states: ["done"] }), "CL-b");
});

test("unstamped sessions (empty state) are never in the queue", () => {
  const sessions = bees(["view-x", ""], ["CL-a", "waiting"]);
  assert.equal(pickNextBee(sessions, undefined, { states: ATTENTION }), "CL-a");
});

test("attentionCount tallies only the wanted states", () => {
  const sessions = bees(["CL-a", "waiting"], ["CL-b", "done"], ["CL-c", "working"]);
  assert.equal(attentionCount(sessions, ATTENTION), 2);
  assert.equal(attentionCount(sessions, ["working"]), 1);
});

test("parseStateList parses, lowercases, and de-dupes", () => {
  assert.deepEqual(parseStateList("waiting,done"), ["waiting", "done"]);
  assert.deepEqual(parseStateList("Waiting, WAITING ,done"), ["waiting", "done"]);
});

test("parseStateList rejects unknown states", () => {
  assert.throws(() => parseStateList("waiting,bogus"), /Unknown state: bogus/);
});

test("parseStateList rejects an empty list", () => {
  assert.throws(() => parseStateList(" , "), /at least one state/);
});
