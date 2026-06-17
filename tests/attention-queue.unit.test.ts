import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ATTENTION_STATES,
  type AttentionCandidate,
  orderAttentionQueue,
  parseAttentionStates,
  pickNextAttentionTarget,
} from "../src/attentionQueue.js";

// Pure ordering/cycling core of `hive next` (PRD §9, Tier 1). No tmux, no store
// — every branch of the attention-queue selection logic is exercised here.

function cand(session: string, state: string, stateSince?: string): AttentionCandidate {
  return { session, state, ...(stateSince ? { stateSince } : {}) };
}

const T = (n: number) => `2026-06-17T00:0${n}:00.000Z`;

test("filters to attention states (working/unknown excluded)", () => {
  const candidates = [
    cand("a", "waiting", T(1)),
    cand("b", "working", T(2)),
    cand("c", "done", T(3)),
    cand("d", "ready", T(4)), // not in the default attention set
  ];
  const ordered = orderAttentionQueue(candidates, DEFAULT_ATTENTION_STATES);
  assert.deepEqual(ordered.map((c) => c.session), ["a", "c"]);
});

test("orders by state priority then oldest-first within a group", () => {
  // waiting before done before failed; within waiting, the older one first.
  const candidates = [
    cand("w-new", "waiting", T(5)),
    cand("f-old", "failed", T(1)),
    cand("w-old", "waiting", T(2)),
    cand("d-mid", "done", T(3)),
  ];
  const ordered = orderAttentionQueue(candidates, DEFAULT_ATTENTION_STATES);
  // Group order waiting→done→failed; w-old (T2) before w-new (T5).
  assert.deepEqual(ordered.map((c) => c.session), ["w-old", "w-new", "d-mid", "f-old"]);
});

test("--state order overrides the default group priority", () => {
  const candidates = [
    cand("w", "waiting", T(2)),
    cand("d", "done", T(1)),
  ];
  // Explicit order done→waiting flips the groups.
  const ordered = orderAttentionQueue(candidates, ["done", "waiting"]);
  assert.deepEqual(ordered.map((c) => c.session), ["d", "w"]);
});

test("missing/unparseable stateSince sorts last (newest) within its group", () => {
  const candidates = [
    cand("has-time", "waiting", T(2)),
    cand("no-time", "waiting"),
    cand("bad-time", "waiting", "not-a-date"),
  ];
  const ordered = orderAttentionQueue(candidates, DEFAULT_ATTENTION_STATES);
  // has-time is oldest; the two Infinity-time entries tie and break by session.
  assert.deepEqual(ordered.map((c) => c.session), ["has-time", "bad-time", "no-time"]);
});

test("next cycles forward with wraparound", () => {
  const candidates = [
    cand("a", "waiting", T(1)),
    cand("b", "waiting", T(2)),
    cand("c", "waiting", T(3)),
  ];
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "a")?.target.session, "b");
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "b")?.target.session, "c");
  // Wraparound: from the last entry back to the first.
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "c")?.target.session, "a");
});

test("prev cycles backward with wraparound", () => {
  const candidates = [
    cand("a", "waiting", T(1)),
    cand("b", "waiting", T(2)),
    cand("c", "waiting", T(3)),
  ];
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "c", { prev: true })?.target.session, "b");
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "b", { prev: true })?.target.session, "a");
  // Wraparound: from the first entry to the last.
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "a", { prev: true })?.target.session, "c");
});

test("current session not in the queue → next enters at front, prev at back", () => {
  const candidates = [
    cand("a", "waiting", T(1)),
    cand("b", "waiting", T(2)),
  ];
  // current is a working bee (not in the attention set) or unknown.
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "elsewhere")?.target.session, "a");
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, undefined)?.target.session, "a");
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "elsewhere", { prev: true })?.target.session, "b");
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, undefined, { prev: true })?.target.session, "b");
});

test("empty attention set → null", () => {
  assert.equal(pickNextAttentionTarget([], DEFAULT_ATTENTION_STATES, "a"), null);
  // A populated candidate list that is all working also yields an empty set.
  const allWorking = [cand("a", "working", T(1)), cand("b", "working", T(2))];
  assert.equal(pickNextAttentionTarget(allWorking, DEFAULT_ATTENTION_STATES, "a"), null);
});

test("single-element queue → next and prev both land on it", () => {
  const candidates = [cand("only", "waiting", T(1))];
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "only")?.target.session, "only");
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "only", { prev: true })?.target.session, "only");
  // Current not in the (single) queue still resolves to it.
  assert.equal(pickNextAttentionTarget(candidates, DEFAULT_ATTENTION_STATES, "elsewhere")?.target.session, "only");
});

test("parseAttentionStates: default, comma-list, blanks, dedupe", () => {
  assert.deepEqual(parseAttentionStates(undefined), ["waiting", "done", "failed"]);
  assert.deepEqual(parseAttentionStates("waiting"), ["waiting"]);
  assert.deepEqual(parseAttentionStates("waiting,blocked"), ["waiting", "blocked"]);
  assert.deepEqual(parseAttentionStates(" waiting , done ,"), ["waiting", "done"]);
  assert.deepEqual(parseAttentionStates("waiting,waiting,done"), ["waiting", "done"]);
  // An all-blank list falls back to the default.
  assert.deepEqual(parseAttentionStates(" , "), ["waiting", "done", "failed"]);
});
