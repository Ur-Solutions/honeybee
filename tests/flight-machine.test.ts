import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeSeal, planSlot, type SlotEvidence } from "../src/flight/machine.js";
import {
  FLIGHT_CONTRACT_DEFAULTS,
  FLIGHT_REPLACEMENT_DEFAULTS,
  slotTaskId,
  type FlightRecord,
  type SlotRecord,
  type SlotSealObservation,
} from "../src/flight/types.js";

const T0 = Date.parse("2026-07-20T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function flight(overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "FL.abc",
    name: "parity-07",
    cwd: "/tmp",
    target: { slots: 2, mix: [{ key: "fable", agent: "claude", count: 2 }] },
    contract: { ...FLIGHT_CONTRACT_DEFAULTS },
    replacement: { ...FLIGHT_REPLACEMENT_DEFAULTS },
    status: "active",
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

function slot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    flightId: "FL.abc",
    slotId: "s1",
    mixKey: "fable",
    generation: 0,
    attempt: 1,
    beeName: "parity-07-s1-a1",
    state: "working",
    since: iso(T0),
    attemptStartedAt: iso(T0),
    evidence: { firstEvidenceAt: iso(T0), lastActivityAt: iso(T0) },
    history: [],
    ...overrides,
  };
}

function seal(overrides: Partial<SlotSealObservation> = {}): SlotSealObservation {
  return {
    filename: "2026-07-20T10-30-00-000Z-0000-abcdef.json",
    sealedAt: iso(T0 + 30 * 60_000),
    status: "done",
    taskId: slotTaskId("FL.abc", "s1"),
    attempt: 1,
    ...overrides,
  };
}

const RUNNING: SlotEvidence = { beeStatus: "running" };

test("done requires a current-attempt matching seal — a matching done seal completes", () => {
  const plan = planSlot(flight(), slot(), { ...RUNNING, beeState: "sealed", seal: seal() }, T0 + 31 * 60_000);
  assert.equal(plan.slot.state, "done");
  assert.ok(plan.events.some((e) => e.type === "flight.slot.done"));
  assert.equal(plan.slot.evidence.sealFilename, seal().filename);
});

test("a stale seal from a previous attempt NEVER satisfies the current one", () => {
  const staleSeal = seal({ sealedAt: iso(T0 - 60_000), attempt: 1, taskId: slotTaskId("FL.abc", "s1") });
  const current = slot({ attempt: 2, attemptStartedAt: iso(T0), evidence: {} });
  assert.equal(judgeSeal(current, staleSeal), "none");
  const plan = planSlot(flight(), current, { ...RUNNING, beeState: "booting", seal: staleSeal }, T0 + 1_000);
  assert.notEqual(plan.slot.state, "done");
});

test("a fresh seal with mismatched correlation keys escalates, never completes", () => {
  const wrongTask = seal({ taskId: "FL.other/s9" });
  const plan = planSlot(flight(), slot(), { ...RUNNING, seal: wrongTask }, T0 + 31 * 60_000);
  assert.equal(plan.slot.state, "escalated");
  assert.ok(plan.events.some((e) => e.type === "flight.slot.escalated" && e.data?.reason === "seal-mismatch"));

  const wrongAttempt = seal({ attempt: 3 });
  const plan2 = planSlot(flight(), slot(), { ...RUNNING, seal: wrongAttempt }, T0 + 31 * 60_000);
  assert.equal(plan2.slot.state, "escalated");
});

test("a matching seal with status=blocked escalates as a judgment call", () => {
  const plan = planSlot(flight(), slot(), { ...RUNNING, seal: seal({ status: "blocked" }) }, T0 + 31 * 60_000);
  assert.equal(plan.slot.state, "escalated");
  assert.ok(plan.events.some((e) => e.data?.sealStatus === "blocked"));
});

test("idle-without-seal is NEVER done: within stall budget it stays working", () => {
  const plan = planSlot(flight(), slot(), { ...RUNNING, beeState: "idle_with_output", seal: null }, T0 + 5 * 60_000);
  assert.equal(plan.slot.state, "working");
});

test("idle-without-seal past the stall deadline → stalled + delivery-confirmed nudge → escalated after unanswered nudge", () => {
  const f = flight();
  const start = slot();
  // 1) stall fires; the machine REQUESTS the nudge but does not stamp
  // nudgedAt — only the controller does, after the send succeeds (CR-5).
  const atStall = T0 + f.contract.stallMs + 1_000;
  const p1 = planSlot(f, start, { ...RUNNING, beeState: "idle_with_output", seal: null }, atStall);
  assert.equal(p1.slot.state, "stalled");
  assert.equal(p1.wantsNudge, true);
  assert.equal(p1.slot.nudgedAt, undefined);
  assert.ok(p1.events.some((e) => e.type === "flight.slot.stalled"));
  // 1b) an UNDELIVERED nudge is re-requested and never escalates as unanswered
  const p1b = planSlot(f, p1.slot, { ...RUNNING, beeState: "idle_with_output", seal: null }, atStall + 2 * f.contract.stallMs);
  assert.equal(p1b.slot.state, "stalled");
  assert.equal(p1b.wantsNudge, true);
  // 2) controller stamps nudgedAt after successful delivery; shortly after:
  // no re-nudge, no escalation yet
  const nudged = { ...p1.slot, nudgedAt: iso(atStall) };
  const p2 = planSlot(f, nudged, { ...RUNNING, beeState: "idle_with_output", seal: null }, atStall + 1_000);
  assert.equal(p2.slot.state, "stalled");
  assert.equal(p2.wantsNudge, false);
  // 3) delivered nudge unanswered past another stall budget → escalated
  const p3 = planSlot(f, p2.slot, { ...RUNNING, beeState: "idle_with_output", seal: null }, atStall + f.contract.stallMs + 2_000);
  assert.equal(p3.slot.state, "escalated");
  // 4) escalated is stable — no event flapping on further sweeps
  const p4 = planSlot(f, p3.slot, { ...RUNNING, beeState: "idle_with_output", seal: null }, atStall + 2 * f.contract.stallMs);
  assert.equal(p4.slot.state, "escalated");
  assert.equal(p4.events.length, 0);
});

test("activity resets the stall clock and recovers a stalled slot to working", () => {
  const f = flight();
  const stalled = planSlot(f, slot(), { ...RUNNING, beeState: "idle_with_output", seal: null }, T0 + f.contract.stallMs + 1_000).slot;
  const recovered = planSlot(f, stalled, { ...RUNNING, beeState: "active", seal: null }, T0 + f.contract.stallMs + 60_000);
  assert.equal(recovered.slot.state, "working");
  assert.equal(recovered.slot.nudgedAt, undefined);
});

test("booting past the readiness deadline → wedged → vacancy with the attempt burned", () => {
  const f = flight();
  const booting = slot({ state: "booting", evidence: {} });
  const plan = planSlot(f, booting, { ...RUNNING, beeState: "booting", seal: null }, T0 + f.contract.readinessDeadlineMs + 1_000);
  assert.equal(plan.slot.state, "vacant");
  assert.equal(plan.wantsSpawn, true);
  assert.deepEqual(plan.slot.history.at(-1)?.outcome, "wedged");
  assert.ok(plan.events.some((e) => e.type === "flight.slot.wedged"));
  assert.ok(plan.events.some((e) => e.type === "flight.vacancy"));
});

test("a live bee that never produces first evidence hits the first-evidence deadline as a stall", () => {
  const f = flight();
  const briefed = slot({ state: "booting", evidence: {} });
  const plan = planSlot(f, briefed, { ...RUNNING, beeState: "idle_with_output", seal: null }, T0 + f.contract.firstEvidenceDeadlineMs + 1_000);
  assert.equal(plan.slot.state, "stalled");
  assert.equal(plan.wantsNudge, true);
});

test("a crashed bee vacates the slot; attempts exhausted → abandoned + mix violation", () => {
  const f = flight();
  const crashed = planSlot(f, slot(), { beeStatus: "dead", seal: null }, T0 + 60_000);
  assert.equal(crashed.slot.state, "vacant");
  assert.ok(crashed.events.some((e) => e.type === "flight.slot.crashed"));

  const lastAttempt = slot({ attempt: f.contract.maxAttemptsPerSlot });
  const exhausted = planSlot(f, lastAttempt, { beeStatus: "dead", seal: null }, T0 + 60_000);
  assert.equal(exhausted.slot.state, "abandoned");
  assert.ok(exhausted.events.some((e) => e.type === "flight.mix.violation"));
  assert.equal(exhausted.wantsSpawn, false);
});

test("a missing session record reads as death, not as idleness", () => {
  const plan = planSlot(flight(), slot(), { seal: null }, T0 + 1_000);
  assert.equal(plan.slot.state, "vacant");
  assert.ok(plan.events.some((e) => e.type === "flight.slot.crashed"));
});

test("node_unreachable holds every clock — no transition, no stall", () => {
  const f = flight();
  const wayPast = T0 + 10 * f.contract.stallMs;
  const plan = planSlot(f, slot(), { ...RUNNING, beeState: "node_unreachable", seal: null }, wayPast);
  assert.equal(plan.slot.state, "working");
  assert.equal(plan.changed, false);
  assert.equal(plan.events.length, 0);
});

test("exit contracts: clean exit is completion (even sweep-invisible fast ones); crashes never are", () => {
  const f = flight({ contract: { ...FLIGHT_CONTRACT_DEFAULTS, completion: "exit" } });
  const worked = planSlot(f, slot(), { beeStatus: "dead", seal: null }, T0 + 60_000);
  assert.equal(worked.slot.state, "done");

  // A fast worker can boot, work, and exit cleanly between two sweeps — a
  // clean dead record completes even without an observed active tick (CR-10b).
  const fastClean = planSlot(f, slot({ evidence: {} }), { beeStatus: "dead", seal: null }, T0 + 60_000);
  assert.equal(fastClean.slot.state, "done");

  // Crash-flavored evidence is never completion, evidence or not (CR-10a).
  const crashed = planSlot(f, slot(), { beeStatus: "dead", beeState: "crashed", seal: null }, T0 + 60_000);
  assert.equal(crashed.slot.state, "vacant");
  assert.ok(crashed.events.some((e) => e.type === "flight.slot.crashed"));
  const killFailed = planSlot(f, slot(), { beeStatus: "kill_failed", seal: null }, T0 + 60_000);
  assert.equal(killFailed.slot.state, "vacant");
});

test("draining flights never ask for replacement spawns", () => {
  const f = flight({ status: "draining" });
  const plan = planSlot(f, slot(), { beeStatus: "dead", seal: null }, T0 + 60_000);
  assert.equal(plan.slot.state, "vacant");
  assert.equal(plan.wantsSpawn, false);
});

test("blocked bees surface as blocked, then escalate past the stall budget", () => {
  const f = flight();
  const p1 = planSlot(f, slot(), { ...RUNNING, beeState: "blocked", seal: null }, T0 + 1_000);
  assert.equal(p1.slot.state, "blocked");
  const p2 = planSlot(f, p1.slot, { ...RUNNING, beeState: "blocked", seal: null }, T0 + 1_000 + f.contract.stallMs + 1_000);
  assert.equal(p2.slot.state, "escalated");
});

test("property: across random evidence sequences a slot never reaches done without current-attempt completion evidence", () => {
  const f = flight();
  const states: Array<SlotEvidence["beeState"]> = ["active", "idle_with_output", "booting", "ready", "blocked", undefined];
  // deterministic pseudo-random walk (no Math.random — reproducible)
  let x = 42;
  const rand = (n: number) => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x % n;
  };
  for (let run = 0; run < 200; run += 1) {
    let current = slot({ evidence: {}, state: "booting" });
    let nowMs = T0;
    for (let step = 0; step < 30; step += 1) {
      nowMs += rand(10) * 60_000;
      const beeState = states[rand(states.length)];
      const evidence: SlotEvidence = { beeStatus: "running", ...(beeState ? { beeState } : {}), seal: null };
      const plan = planSlot(f, current, evidence, nowMs);
      assert.notEqual(plan.slot.state, "done", `run ${run} step ${step}: reached done without a seal`);
      current = plan.slot;
      if (current.state === "vacant" || current.state === "abandoned") break;
    }
  }
});

test("CR-2: a keyless fresh seal never completes a seal-contract slot", () => {
  const keyless = seal({ taskId: undefined as unknown as string, attempt: undefined as unknown as number });
  delete (keyless as Record<string, unknown>).taskId;
  delete (keyless as Record<string, unknown>).attempt;
  assert.equal(judgeSeal(slot(), keyless), "none");
  const plan = planSlot(flight(), slot(), { ...RUNNING, beeState: "idle_with_output", seal: keyless }, T0 + 60_000);
  assert.notEqual(plan.slot.state, "done");
  // a seal carrying only one of the demanded keys is also not completion
  const half = seal();
  delete (half as Record<string, unknown>).attempt;
  assert.equal(judgeSeal(slot(), half), "none");
});

test("CR-2: a matching seal of the wrong demanded type escalates", () => {
  const f = flight({ contract: { ...FLIGHT_CONTRACT_DEFAULTS, sealType: "implementation" } });
  const wrongType = seal({ type: "review" });
  const plan = planSlot(f, slot(), { ...RUNNING, seal: wrongType }, T0 + 31 * 60_000);
  assert.equal(plan.slot.state, "escalated");
  assert.ok(plan.events.some((e) => e.data?.reason === "seal-type-mismatch"));
  const rightType = seal({ type: "implementation" });
  const done = planSlot(f, slot(), { ...RUNNING, seal: rightType }, T0 + 31 * 60_000);
  assert.equal(done.slot.state, "done");
});

test("CR-1: a claimed slot with no session record is held until the readiness deadline, then wedged", () => {
  const f = flight();
  const claimed = slot({ state: "provisioning", evidence: {}, beeName: undefined });
  delete (claimed as Record<string, unknown>).beeName;
  const early = planSlot(f, claimed, { seal: null }, T0 + 30_000);
  assert.equal(early.slot.state, "provisioning");
  assert.equal(early.changed, false);
  assert.equal(early.events.length, 0);

  const late = planSlot(f, claimed, { seal: null }, T0 + f.contract.readinessDeadlineMs + 1_000);
  assert.equal(late.slot.state, "vacant");
  assert.deepEqual(late.slot.history.at(-1)?.outcome, "wedged");
  assert.ok(late.events.some((e) => e.type === "flight.slot.wedged" && e.data?.reason === "no-session-record"));
});

test("CR-7a: an escalated slot whose bee stays blocked does not flap back to blocked", () => {
  const f = flight();
  const escalated = slot({ state: "escalated" });
  const plan = planSlot(f, escalated, { ...RUNNING, beeState: "blocked", seal: null }, T0 + 60_000);
  assert.equal(plan.slot.state, "escalated");
  assert.equal(plan.events.length, 0);
});
