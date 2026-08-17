/**
 * Echo-verified delivery (spec 05 tmux point 3, hardened after the live
 * 2026-08-17 smokes). Live evidence encoded here via stub knobs:
 *  - grok takes NOTHING from the tmux paste buffer (TMUX_STUB_DROP_PASTE),
 *  - grok ate the first ~2 chars of an unpaced burst (TMUX_STUB_EAT_FIRST),
 *  - codex silently swallowed the paste after a completed turn
 *    (TMUX_STUB_SWALLOW_PASTE_AFTER_TURN),
 *  - and the honest-failure path when NOTHING ever lands (TMUX_STUB_EAT_ALL).
 * Contract: text is PROVEN visible in the input line before Enter; one
 * typed reinjection on mismatch; still nothing → immediate `echo_mismatch`
 * unconfirmed note, never a submitted-blind message, never a state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drainUntil, kinds, makeRig, settle } from "./helpers.ts";

async function bootIdle(rig: ReturnType<typeof makeRig>, bee: string): Promise<void> {
  rig.driver.start(bee, 1);
  await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended"));
  await settle(rig.driver, 300);
}

async function turnCompletes(rig: ReturnType<typeof makeRig>, timeoutMs = 8000): Promise<boolean> {
  const t0 = Date.now();
  let seen: string[] = [];
  while (Date.now() - t0 < timeoutMs) {
    seen = seen.concat(kinds(rig.driver.observe()));
    if (seen.includes("turn_ended")) return seen.includes("turn_started");
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("spec05.deliver.type-mode: a TUI that drops pastes still receives typed delivery", async () => {
  const rig = makeRig();
  try {
    rig.configure("grokish", "transcript", { TMUX_STUB_DROP_PASTE: "1" }, "type");
    await bootIdle(rig, "grokish");
    const out = rig.driver.deliver("grokish", 1, 1, "Reply with exactly SMOKE_1");
    assert.equal(out.accepted, true);
    assert.equal(await turnCompletes(rig), true, "typed delivery produced a full turn");
    assert.deepEqual(rig.driver.observeDeliveryNotes(), [], "no unconfirmed note — delivery was verified");
  } finally {
    rig.cleanup();
  }
});

test("spec05.deliver.eat-first: an input that eats leading chars is caught by echo-verify and retyped", async () => {
  const rig = makeRig();
  try {
    // paste mode + first bytes vanish once → echo tail mismatch → C-u + typed retry.
    rig.configure("eater", "transcript", { TMUX_STUB_EAT_FIRST: "3" });
    await bootIdle(rig, "eater");
    const out = rig.driver.deliver("eater", 1, 1, "Reply with exactly SMOKE_2");
    assert.equal(out.accepted, true);
    assert.equal(await turnCompletes(rig), true, "retyped delivery produced a full turn");
    assert.deepEqual(rig.driver.observeDeliveryNotes(), []);
  } finally {
    rig.cleanup();
  }
});

test("spec05.deliver.post-turn-swallow: the paste swallowed after a completed turn is re-injected, not lost", async () => {
  const rig = makeRig();
  try {
    rig.configure("codexish", "transcript", { TMUX_STUB_SWALLOW_PASTE_AFTER_TURN: "1" });
    await bootIdle(rig, "codexish");
    assert.equal(rig.driver.deliver("codexish", 1, 1, "first").accepted, true);
    assert.equal(await turnCompletes(rig), true, "first turn ran");
    await settle(rig.driver, 300);
    // The stub now swallows the next paste (the live codex failure).
    assert.equal(rig.driver.deliver("codexish", 1, 2, "second message please").accepted, true);
    assert.equal(await turnCompletes(rig), true, "second turn ran — echo-verify caught the swallow and retyped");
    assert.deepEqual(rig.driver.observeDeliveryNotes(), [], "no unconfirmed note for the follow-up");
  } finally {
    rig.cleanup();
  }
});

test("spec05.deliver.honest-failure: nothing ever lands → immediate echo_mismatch note, Enter never pressed", async () => {
  const rig = makeRig();
  try {
    rig.configure("void", "transcript", { TMUX_STUB_EAT_ALL: "1" });
    await bootIdle(rig, "void");
    const t0 = Date.now();
    const out = rig.driver.deliver("void", 1, 9, "into the void");
    assert.equal(out.accepted, true, "assume-best: accepted; the mailbox is durable truth");
    const notes = rig.driver.observeDeliveryNotes();
    assert.equal(notes.length, 1, "note surfaces IMMEDIATELY, not after a grace");
    assert.ok(Date.now() - t0 < 6000, "no long grace wait on a known-failed injection");
    assert.equal(notes[0]?.kind, "unconfirmed");
    assert.equal(notes[0]?.messageId, 9);
    assert.match(notes[0]?.detail ?? "", /echo_mismatch/);
    assert.match(notes[0]?.detail ?? "", /retry/);
    // Not a fence, not a state: still live, still deliverable, no turn events.
    assert.equal(rig.driver.hasProcess("void", 1), true);
    assert.deepEqual(kinds(rig.driver.observe()).filter((k) => k !== "turn_ended"), []);
  } finally {
    rig.cleanup();
  }
});

test("spec05.deliver.multiline-type: typed-mode refuses multiline with a routable reason", async () => {
  const rig = makeRig();
  try {
    rig.configure("typed", "transcript", {}, "type");
    await bootIdle(rig, "typed");
    const out = rig.driver.deliver("typed", 1, 1, "line one\nline two");
    assert.equal(out.accepted, false);
    assert.equal(out.reason, "not_ready");
    assert.equal(out.detail, "multiline_type_mode");
    assert.equal(rig.driver.hasProcess("typed", 1), true);
  } finally {
    rig.cleanup();
  }
});
