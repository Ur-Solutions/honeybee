/**
 * Delivery validation (spec 05 tmux point 3): assume-best send-keys,
 * observer confirmation within grace, the visible retryable NOTE for
 * unconfirmed deliveries (an annotation, never a state/fence), and the
 * pane-activity fallback (source (c)) for a file-less harness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drainUntil, kinds, makeRig, settle, waitForStubReady } from "./helpers.ts";

test("delivery.unconfirmed: no observed turn start within grace → retryable note, no state change", async () => {
  const rig = makeRig();
  try {
    // A deaf runtime: reads input, never reacts — nothing for any observer
    // to see. Short grace so the note surfaces quickly.
    rig.configure("bee-1", "transcript", { TMUX_STUB_DEAF: "1" });
    rig.driver.start("bee-1", 1);
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended"));

    // Shorten the grace via a second bee? No — reconfigure is per-bee env;
    // grace lives in the observation spec. Use the driver's default spec
    // (800ms in this fixture) — the note must appear after it.
    const outcome = rig.driver.deliver("bee-1", 1, 7, "hello?");
    assert.equal(outcome.accepted, true, "assume-best: the send itself is accepted");
    assert.deepEqual(rig.driver.observeDeliveryNotes(), [], "no note before the grace elapses");

    const t0 = Date.now();
    let notes: ReturnType<typeof rig.driver.observeDeliveryNotes> = [];
    while (notes.length === 0) {
      if (Date.now() - t0 > 8000) throw new Error("no delivery note within 8s");
      rig.driver.observe();
      notes = rig.driver.observeDeliveryNotes();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.kind, "unconfirmed");
    assert.equal(notes[0]?.messageId, 7);
    assert.match(notes[0]?.detail ?? "", /retry/);
    // NOT a fence: the runtime is still live and deliverable; the note never
    // produced a state observation (no turn_started/exited events).
    assert.equal(rig.driver.hasProcess("bee-1", 1), true);
    assert.deepEqual(kinds(rig.driver.observe()).filter((k) => k !== "turn_ended"), []);
    assert.equal(rig.driver.deliver("bee-1", 1, 8, "retry").accepted, true);
  } finally {
    rig.cleanup();
  }
});

test("delivery.pane-fallback: a file-less harness still yields activity/quiescence automation (source c)", async () => {
  const rig = makeRig();
  try {
    rig.configure("bee-1", "silent"); // no transcript, no hooks — pane only
    rig.driver.start("bee-1", 1);
    await waitForStubReady(rig, "bee-1");
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended"));
    // Pane mode reports BOOT output as activity too (all it can know); let
    // that phantom activity open+quiesce before delivering.
    await settle(rig.driver, 700);

    assert.equal(rig.driver.deliver("bee-1", 1, 1, "make some output").accepted, true);
    // Pane content change (the echoed output) → activity → turn_started;
    // pane quiescence afterwards → turn_ended. No string parsing anywhere.
    const turn = await drainUntil(
      rig.driver,
      (e) => e.some((x) => x.kind === "turn_started") && e.some((x) => x.kind === "turn_ended"),
      8000,
    );
    assert.deepEqual(kinds(turn), ["turn_started", "turn_ended"]);
    assert.deepEqual(rig.driver.observeDeliveryNotes(), [], "pane activity confirmed the delivery");
  } finally {
    rig.cleanup();
  }
});
