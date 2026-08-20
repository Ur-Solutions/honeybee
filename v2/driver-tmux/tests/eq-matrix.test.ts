/**
 * spec05.eq — the A3 equal-treatment gate (spec 05 test tier 2).
 *
 * Hooks-based (claude-style), notify-based (codex-style) and transcript-only
 * (grok/opencode-style) fixtures must produce IDENTICAL automation outcomes:
 * turn boundaries observed, delivery confirmed by the observer, idle
 * detectable. "Supporting a harness" MEANS its observer produces this exact
 * outcome — there is no degraded tier.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drainUntil, kinds, makeRig, settle, type StubStyle } from "./helpers.ts";

interface Outcome {
  /** Observation kinds for spawn → delivery → idle, in order. */
  observed: string[];
  /** Observer-confirmed delivery (no unconfirmed note). */
  deliveryConfirmed: boolean;
  /** The runtime is detectably idle at the end (idle detection works). */
  idleDetectable: boolean;
  /** Message ground truth: consumed by generation 1. */
  consumedGeneration: number | undefined;
}

async function runScenario(style: StubStyle): Promise<Outcome> {
  const rig = makeRig();
  try {
    const beeId = `bee-${style}`;
    rig.configure(beeId, style);
    rig.driver.start(beeId, 1);
    const boot = await drainUntil(rig.driver, (e) => e.filter((x) => x.kind === "turn_ended").length >= 1);
    // Boot settling (transcript binding) before the first delivery — the
    // shape a real delivery loop has (it delivers after real boot, seconds
    // in). Nothing may drain here in any style.
    boot.push(...(await settle(rig.driver, 80)));

    const outcome = rig.driver.deliver(beeId, 1, 1, `work please (${style})`);
    assert.equal(outcome.accepted, true, `${style}: delivery accepted`);
    const turn = await drainUntil(
      rig.driver,
      (e) => e.some((x) => x.kind === "turn_started") && e.some((x) => x.kind === "turn_ended"),
    );
    const notes = rig.driver.observeDeliveryNotes();
    return {
      observed: [...kinds(boot), ...kinds(turn)],
      deliveryConfirmed: notes.length === 0,
      idleDetectable: kinds(turn).at(-1) === "turn_ended",
      consumedGeneration: rig.driver.consumedGeneration(1),
    };
  } finally {
    rig.cleanup();
  }
}

const EXPECTED: Omit<Outcome, "consumedGeneration"> & { consumedGeneration: number } = {
  observed: ["booted", "turn_ended", "turn_started", "turn_ended"],
  deliveryConfirmed: true,
  idleDetectable: true,
  consumedGeneration: 1,
};

const outcomes = new Map<StubStyle, Outcome>();

test("spec05.eq.hooks: claude-style hook events drive full automation", async () => {
  const o = await runScenario("hooks");
  outcomes.set("hooks", o);
  assert.deepEqual(o, EXPECTED);
});

test("spec05.eq.notify: codex-style notify events drive full automation", async () => {
  const o = await runScenario("notify");
  outcomes.set("notify", o);
  assert.deepEqual(o, EXPECTED);
});

test("spec05.eq.transcript-only: a files-only harness drives full automation (no hooks at all)", async () => {
  const o = await runScenario("transcript");
  outcomes.set("transcript", o);
  assert.deepEqual(o, EXPECTED);
});

test("spec05.eq.identical: all three observation styles produced the SAME outcome", () => {
  const [hooks, notify, transcript] = [outcomes.get("hooks"), outcomes.get("notify"), outcomes.get("transcript")];
  assert.ok(hooks && notify && transcript, "all scenarios ran");
  assert.deepEqual(notify, hooks, "notify-based ≠ hooks-based");
  assert.deepEqual(transcript, hooks, "transcript-only ≠ hooks-based — the A3 ruling is violated");
});
