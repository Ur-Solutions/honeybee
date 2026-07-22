import assert from "node:assert/strict";
import { test } from "node:test";
import { paneActivitySignal, sweepFlights, type FlightSweepDeps } from "../src/flight/controller.js";
import {
  FLIGHT_CONTRACT_DEFAULTS,
  FLIGHT_REPLACEMENT_DEFAULTS,
  slotBeeName,
  slotIdempotencyKey,
  slotTaskId,
  type FlightRecord,
  type SlotRecord,
  type SlotSealObservation,
} from "../src/flight/types.js";
import type { BeeState } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

const T0 = Date.parse("2026-07-20T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function flight(overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "FL.abc",
    name: "parity-07",
    cwd: "/tmp",
    target: { slots: 4, mix: [{ key: "fable", agent: "claude", count: 4 }] },
    contract: { ...FLIGHT_CONTRACT_DEFAULTS },
    replacement: { ...FLIGHT_REPLACEMENT_DEFAULTS },
    status: "active",
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

function vacantSlot(slotId: string): SlotRecord {
  return { flightId: "FL.abc", slotId, mixKey: "fable", generation: 0, attempt: 0, state: "vacant", since: iso(T0), evidence: {}, history: [] };
}

function bee(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: name,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    status: "running",
    ...overrides,
  };
}

type Harness = {
  deps: FlightSweepDeps;
  slots: Map<string, SlotRecord>;
  flights: Map<string, FlightRecord>;
  ledger: Array<Record<string, unknown>>;
  saved: SlotRecord[];
  spawned: string[];
  nudged: string[];
  seals: Map<string, SlotSealObservation>;
  spawnImpl: (flightRecord: FlightRecord, slot: SlotRecord) => Promise<{ beeName: string }>;
};

function harness(flightRecord: FlightRecord, initialSlots: SlotRecord[], nowMs: number): Harness {
  const slots = new Map(initialSlots.map((slot) => [slot.slotId, slot]));
  const flights = new Map([[flightRecord.id, flightRecord]]);
  const ledger: Array<Record<string, unknown>> = [];
  const saved: SlotRecord[] = [];
  const spawned: string[] = [];
  const nudged: string[] = [];
  const seals = new Map<string, SlotSealObservation>();
  const h: Harness = {
    slots,
    flights,
    ledger,
    saved,
    spawned,
    nudged,
    seals,
    spawnImpl: async (f, slot) => {
      const name = slotBeeName(f.id, slot.slotId, slot.generation, slot.attempt);
      spawned.push(name);
      return { beeName: name };
    },
    deps: {
      listFlights: async () => [...flights.values()],
      listSlots: async () => [...slots.values()].sort((a, b) => a.slotId.localeCompare(b.slotId, undefined, { numeric: true })),
      saveSlot: async (slot) => {
        saved.push(slot);
        slots.set(slot.slotId, slot);
      },
      saveFlight: async (f) => {
        flights.set(f.id, f);
      },
      latestSeal: async (beeName) => seals.get(beeName) ?? null,
      spawnSlot: (f, slot) => h.spawnImpl(f, slot),
      nudge: async (_f, _slot, beeName) => {
        nudged.push(beeName);
      },
      appendLedger: async (event) => {
        ledger.push(event);
      },
      now: () => nowMs,
    },
  };
  return h;
}

test("vacancy fill: durable idempotency claim before spawn, confirm after, backpressure respected", async () => {
  const f = flight();
  const h = harness(f, ["s1", "s2", "s3", "s4"].map(vacantSlot), T0);
  const outcomes = await sweepFlights(h.deps, [], new Map());

  // maxConcurrentBoots=3: only 3 of 4 vacancies spawn this sweep.
  assert.equal(h.spawned.length, 3);
  assert.equal(outcomes.filter((o) => o.action === "spawn" && o.detail === "deferred-backpressure").length, 1);
  const s1 = h.slots.get("s1")!;
  assert.equal(s1.state, "booting");
  assert.equal(s1.attempt, 1);
  assert.equal(s1.idempotencyKey, slotIdempotencyKey(f.id, "s1", 0, 1));
  assert.equal(s1.beeName, slotBeeName(f.id, "s1", 0, 1));
  assert.ok(h.ledger.some((e) => e.type === "flight.slot.provisioning" && e.slot === "s1"));
  assert.ok(h.ledger.some((e) => e.type === "flight.slot.booting" && e.slot === "s1"));

  // While the three are still booting, backpressure keeps the valve closed.
  const records = h.spawned.map((name) => bee(name));
  await sweepFlights(h.deps, records, new Map<string, BeeState>(records.map((r) => [r.name, "booting"])));
  assert.equal(h.spawned.length, 3);

  // Once they turn active (working), the deferred slot fills; no double-spawns.
  await sweepFlights(h.deps, records, new Map<string, BeeState>(records.map((r) => [r.name, "active"])));
  assert.equal(h.spawned.length, 4);
  assert.equal(new Set(h.spawned).size, 4, "no attempt was spawned twice");
});

test("crash between spawn and confirm: the next sweep ADOPTS the orphan instead of double-spawning", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  // Simulate the crash: slot durably claimed (provisioning, attempt 1, no bee).
  const claimed: SlotRecord = {
    ...vacantSlot("s1"),
    attempt: 1,
    state: "provisioning",
    attemptStartedAt: iso(T0),
    idempotencyKey: slotIdempotencyKey(f.id, "s1", 0, 1),
  };
  const h = harness(f, [claimed], T0 + 1_000);
  const orphanName = slotBeeName(f.id, "s1", 0, 1);
  const outcomes = await sweepFlights(h.deps, [bee(orphanName)], new Map([[orphanName, "booting" as BeeState]]));

  assert.equal(h.spawned.length, 0, "no duplicate spawn for a claimed attempt");
  const s1 = h.slots.get("s1")!;
  assert.equal(s1.beeName, orphanName);
  assert.equal(s1.state, "booting");
  assert.ok(outcomes.some((o) => o.detail?.includes("adopted")));
});

test("spawn failure burns the attempt and abandons at maxAttempts with a mix violation", async () => {
  const f = flight({
    target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] },
    contract: { ...FLIGHT_CONTRACT_DEFAULTS, maxAttemptsPerSlot: 2 },
  });
  const h = harness(f, [vacantSlot("s1")], T0);
  h.spawnImpl = async () => {
    throw new Error("no accounts available");
  };
  await sweepFlights(h.deps, [], new Map());
  assert.equal(h.slots.get("s1")!.state, "vacant");
  assert.equal(h.slots.get("s1")!.attempt, 1);
  assert.ok(h.ledger.some((e) => e.type === "flight.slot.spawn_failed"));

  await sweepFlights(h.deps, [], new Map());
  assert.equal(h.slots.get("s1")!.state, "abandoned");
  assert.equal(h.slots.get("s1")!.attempt, 2);
  assert.ok(h.ledger.some((e) => e.type === "flight.mix.violation"));
});

test("simultaneous batch completion: all slots seal in one sweep → all done + flight.complete + closed", async () => {
  const f = flight({ target: { slots: 3, mix: [{ key: "fable", agent: "claude", count: 3 }] } });
  const names = ["s1", "s2", "s3"].map((slotId) => slotBeeName(f.id, slotId, 0, 1));
  const slots = ["s1", "s2", "s3"].map((slotId, index): SlotRecord => ({
    ...vacantSlot(slotId),
    attempt: 1,
    state: "working",
    beeName: names[index]!,
    attemptStartedAt: iso(T0),
    evidence: { firstEvidenceAt: iso(T0), lastActivityAt: iso(T0 + 60_000) },
  }));
  const h = harness(f, slots, T0 + 2 * 60_000);
  for (const [index, slotId] of (["s1", "s2", "s3"] as const).entries()) {
    h.seals.set(names[index]!, {
      filename: `seal-${slotId}.json`,
      sealedAt: iso(T0 + 90_000),
      status: "done",
      taskId: slotTaskId(f.id, slotId),
      attempt: 1,
    });
  }
  const records = names.map((name) => bee(name));
  const observed = new Map<string, BeeState>(names.map((name) => [name, "sealed" as BeeState]));
  const outcomes = await sweepFlights(h.deps, records, observed);

  for (const slotId of ["s1", "s2", "s3"]) assert.equal(h.slots.get(slotId)!.state, "done");
  assert.equal(h.ledger.filter((e) => e.type === "flight.slot.done").length, 3);
  assert.ok(h.ledger.some((e) => e.type === "flight.complete" && e.done === 3));
  assert.equal(h.flights.get(f.id)!.status, "closed");
  assert.ok(outcomes.some((o) => o.action === "complete" && o.detail === "3/3 done"));
});

test("stalled slots get exactly one deterministic nudge", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const name = slotBeeName(f.id, "s1", 0, 1);
  const working: SlotRecord = {
    ...vacantSlot("s1"),
    attempt: 1,
    state: "working",
    beeName: name,
    attemptStartedAt: iso(T0),
    evidence: { firstEvidenceAt: iso(T0), lastActivityAt: iso(T0) },
  };
  const past = T0 + f.contract.stallMs + 1_000;
  const h = harness(f, [working], past);
  await sweepFlights(h.deps, [bee(name)], new Map([[name, "idle_with_output" as BeeState]]));
  assert.deepEqual(h.nudged, [name]);
  assert.equal(h.slots.get("s1")!.state, "stalled");

  // Second sweep shortly after: no repeat nudge.
  await sweepFlights(h.deps, [bee(name)], new Map([[name, "idle_with_output" as BeeState]]));
  assert.equal(h.nudged.length, 1);
});

test("active slots with unchanged activity do not save or emit working-to-working outcomes", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const name = slotBeeName(f.id, "s1", 0, 1);
  const working: SlotRecord = {
    ...vacantSlot("s1"),
    attempt: 1,
    state: "working",
    beeName: name,
    attemptStartedAt: iso(T0),
    evidence: { firstEvidenceAt: iso(T0), lastActivityAt: iso(T0 + 1_000), lastActivityFingerprint: "fp-1" },
  };
  const h = harness(f, [working], T0 + 5_000);
  const outcomes = await sweepFlights(
    h.deps,
    [bee(name)],
    new Map([[name, "active" as BeeState]]),
    new Map([[name, { at: iso(T0 + 5_000), fingerprint: "fp-1" }]]),
  );

  assert.equal(h.saved.length, 0);
  assert.deepEqual(outcomes, []);
});

test("newer active activity saves evidence without a no-op transition outcome", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const name = slotBeeName(f.id, "s1", 0, 1);
  const working: SlotRecord = {
    ...vacantSlot("s1"),
    attempt: 1,
    state: "working",
    beeName: name,
    attemptStartedAt: iso(T0),
    evidence: { firstEvidenceAt: iso(T0), lastActivityAt: iso(T0), lastActivityFingerprint: "fp-1" },
  };
  const h = harness(f, [working], T0 + 5_000);
  const outcomes = await sweepFlights(
    h.deps,
    [bee(name)],
    new Map([[name, "active" as BeeState]]),
    new Map([[name, { at: iso(T0 + 2_000), fingerprint: "fp-2" }]]),
  );

  assert.equal(h.saved.length, 1);
  assert.equal(h.slots.get("s1")!.evidence.lastActivityAt, iso(T0 + 2_000));
  assert.equal(h.slots.get("s1")!.evidence.lastActivityFingerprint, "fp-2");
  assert.equal(outcomes.some((o) => o.action === "transition" && o.detail === "working→working"), false);
});

test("shared activity timestamps across two slots persist once, then stop churning", async () => {
  const f = flight({ target: { slots: 2, mix: [{ key: "fable", agent: "claude", count: 2 }] } });
  const names = ["s1", "s2"].map((slotId) => slotBeeName(f.id, slotId, 0, 1));
  const slots = (["s1", "s2"] as const).map((slotId, index): SlotRecord => ({
    ...vacantSlot(slotId),
    attempt: 1,
    state: "working",
    beeName: names[index]!,
    attemptStartedAt: iso(T0),
    evidence: { firstEvidenceAt: iso(T0), lastActivityAt: iso(T0), lastActivityFingerprint: `old-${slotId}` },
  }));
  const h = harness(f, slots, T0 + 60_000);
  const observed = new Map<string, BeeState>(names.map((name) => [name, "active" as BeeState]));
  const activity = new Map(names.map((name, index) => [name, { at: iso(T0 + 10_000), fingerprint: `same-ts-${index}` }]));

  const first = await sweepFlights(h.deps, names.map((name) => bee(name)), observed, activity);
  assert.equal(h.saved.length, 2);
  assert.equal(h.slots.get("s1")!.evidence.lastActivityAt, iso(T0 + 10_000));
  assert.equal(h.slots.get("s2")!.evidence.lastActivityAt, iso(T0 + 10_000));
  assert.equal(first.some((o) => o.detail === "working→working"), false);

  h.saved.length = 0;
  const second = await sweepFlights(h.deps, names.map((name) => bee(name)), observed, activity);
  assert.equal(h.saved.length, 0);
  assert.deepEqual(second, []);
});

test("pane fallback fingerprints are stable for unchanged tmux output and change with new output", () => {
  const record = bee("legacy-tmux");
  const first = paneActivitySignal(record, "working\nstep 1", T0);
  const unchanged = paneActivitySignal(record, "working\nstep 1", T0 + 60_000);
  const changed = paneActivitySignal(record, "working\nstep 2", T0 + 60_000);

  assert.equal(first.fingerprint, unchanged.fingerprint);
  assert.notEqual(first.at, unchanged.at);
  assert.notEqual(first.fingerprint, changed.fingerprint);
});

test("closed flights are left alone entirely", async () => {
  const f = flight({ status: "closed" });
  const h = harness(f, [vacantSlot("s1")], T0);
  const outcomes = await sweepFlights(h.deps, [], new Map());
  assert.equal(outcomes.length, 0);
  assert.equal(h.spawned.length, 0);
});

test("CR-5: nudgedAt is stamped only after delivery succeeds; failures retry next sweep", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const name = slotBeeName(f.id, "s1", 0, 1);
  const working: SlotRecord = {
    ...vacantSlot("s1"),
    attempt: 1,
    state: "working",
    beeName: name,
    attemptStartedAt: iso(T0),
    evidence: { firstEvidenceAt: iso(T0), lastActivityAt: iso(T0) },
  };
  const past = T0 + f.contract.stallMs + 1_000;
  const h = harness(f, [working], past);
  let failNudge = true;
  h.deps.nudge = async (_f, _slot, beeName) => {
    if (failNudge) throw new Error("buz outage");
    h.nudged.push(beeName);
  };
  // Failed delivery: no nudgedAt persisted, error surfaced.
  const first = await sweepFlights(h.deps, [bee(name)], new Map([[name, "idle_with_output" as BeeState]]));
  assert.equal(h.slots.get("s1")!.nudgedAt, undefined);
  assert.ok(first.some((o) => o.action === "error" && /buz outage/.test(o.error ?? "")));
  // Next sweep retries; success stamps nudgedAt.
  failNudge = false;
  await sweepFlights(h.deps, [bee(name)], new Map([[name, "idle_with_output" as BeeState]]));
  assert.deepEqual(h.nudged, [name]);
  assert.ok(h.slots.get("s1")!.nudgedAt);
});

test("CR-6: missing slot files are re-created as vacant and completion honors target.slots", async () => {
  const f = flight({ target: { slots: 2, mix: [{ key: "fable", agent: "claude", count: 2 }] } });
  const name1 = slotBeeName(f.id, "s1", 0, 1);
  const doneSlot: SlotRecord = {
    ...vacantSlot("s1"),
    attempt: 1,
    state: "done",
    beeName: name1,
    attemptStartedAt: iso(T0),
    evidence: { sealFilename: "seal.json" },
  };
  // s2's file is lost — only s1 exists on disk.
  const h = harness(f, [doneSlot], T0 + 60_000);
  const outcomes = await sweepFlights(h.deps, [], new Map());
  const s2 = h.slots.get("s2")!;
  assert.ok(s2, "s2 was re-created");
  assert.equal(s2.state, "booting"); // vacant → immediately filled by the spawn phase
  assert.equal(s2.mixKey, "fable");
  assert.ok(h.ledger.some((e) => e.type === "flight.vacancy" && e.reason === "slot-file-missing"));
  // The flight did NOT complete over the shrunken slot set.
  assert.ok(!h.ledger.some((e) => e.type === "flight.complete"));
  assert.ok(!outcomes.some((o) => o.action === "complete"));
});

test("CR-7c: a draining flight completes once live slots finish, counting vacancies as terminal", async () => {
  const f = flight({ status: "draining", target: { slots: 2, mix: [{ key: "fable", agent: "claude", count: 2 }] } });
  const doneSlot: SlotRecord = { ...vacantSlot("s1"), attempt: 1, state: "done" };
  const vacated: SlotRecord = { ...vacantSlot("s2"), attempt: 1 };
  const h = harness(f, [doneSlot, vacated], T0 + 60_000);
  const outcomes = await sweepFlights(h.deps, [], new Map());
  assert.equal(h.spawned.length, 0, "draining never spawns");
  assert.ok(outcomes.some((o) => o.action === "complete"));
  assert.equal(h.flights.get(f.id)!.status, "closed");
});

test("grok M2: a wedged replacement retires the written-off live bee", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const name = slotBeeName(f.id, "s1", 0, 1);
  const stuck: SlotRecord = {
    ...vacantSlot("s1"),
    attempt: 1,
    state: "booting",
    beeName: name,
    attemptStartedAt: iso(T0),
  };
  const h = harness(f, [stuck], T0 + f.contract.readinessDeadlineMs + 1_000);
  const retired: string[] = [];
  h.deps.retireBee = async (beeName) => {
    retired.push(beeName);
  };
  await sweepFlights(h.deps, [bee(name)], new Map([[name, "booting" as BeeState]]));
  assert.deepEqual(retired, [name]);
});

test("CR-1: sweeps run under the flight lock when provided", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const h = harness(f, [vacantSlot("s1")], T0);
  const lockLog: string[] = [];
  h.deps.withFlightLock = async (flightId, fn) => {
    lockLog.push(`lock:${flightId}`);
    try {
      return await fn();
    } finally {
      lockLog.push(`unlock:${flightId}`);
    }
  };
  await sweepFlights(h.deps, [], new Map());
  assert.deepEqual(lockLog, [`lock:${f.id}`, `unlock:${f.id}`]);
});
