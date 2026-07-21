// The flight reconciler (CL.701 §4.2): level-triggered, disk-derivable, and
// deliberately boring. Each sweep re-derives every slot from evidence (session
// records + observed states + seals), persists transitions, ledgers events,
// and fills vacancies under backpressure with a durable idempotency claim —
// prepare (write attempt+key) → execute (spawn) → confirm (write bee), so a
// crash mid-replacement never double-spawns an attempt. All effects are
// injected: the daemon wires real spawn/nudge/ledger; tests wire fakes.
import type { BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";
import { planSlot, type SlotEvidence } from "./machine.js";
import {
  SLOT_BOOTING_STATES,
  SLOT_TERMINAL_STATES,
  slotBeeName,
  slotIdempotencyKey,
  slotTaskId,
  type FlightMixEntry,
  type FlightRecord,
  type SlotRecord,
  type SlotSealObservation,
} from "./types.js";

export type FlightSweepDeps = {
  listFlights: () => Promise<FlightRecord[]>;
  listSlots: (flightId: string) => Promise<SlotRecord[]>;
  saveSlot: (slot: SlotRecord) => Promise<void>;
  saveFlight: (flight: FlightRecord) => Promise<void>;
  /** Latest seal for a bee, or null. */
  latestSeal: (beeName: string) => Promise<SlotSealObservation | null>;
  /**
   * Spawn a slot bee: agent/model/account from the mix, cwd/brief/colony from
   * the flight, contract carrying taskId + attempt, and deliver the brief.
   */
  spawnSlot: (flight: FlightRecord, slot: SlotRecord, mix: FlightMixEntry) => Promise<{ beeName: string; beeId?: string }>;
  /** Deterministic stall nudge (interrupt-tier buz). */
  nudge: (flight: FlightRecord, slot: SlotRecord, beeName: string) => Promise<void>;
  /**
   * Cross-process mutual exclusion for one flight's sweep (review CR-1). Two
   * live reconcilers (daemon tick + `hive flight sweep`) must never interleave
   * plan/prepare/spawn on the same slots — the idempotency claim is only
   * crash-safe, not concurrency-safe. Absent (tests) → no locking.
   */
  withFlightLock?: <T>(flightId: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Best-effort retire of a live-but-written-off bee (wedged replacement) so
   * replaced attempts don't leak runner hosts/accounts. Absent → skipped.
   */
  retireBee?: (beeName: string) => Promise<void>;
  appendLedger: (event: Record<string, unknown>) => Promise<void>;
  now: () => number;
};

export type FlightSweepOutcome = {
  flight: string;
  slot?: string;
  action: "transition" | "spawn" | "nudge" | "retire" | "complete" | "skipped" | "error";
  detail?: string;
  error?: string;
};

/**
 * One reconcile pass over every non-closed flight. `records`/`observed` come
 * from the caller's already-gathered tick context (the daemon passes this
 * tick's session records and freshly derived states), so the sweep adds no
 * per-slot fs fan-out beyond the seal scans.
 */
export async function sweepFlights(
  deps: FlightSweepDeps,
  records: readonly SessionRecord[],
  observed: ReadonlyMap<string, BeeState>,
): Promise<FlightSweepOutcome[]> {
  const outcomes: FlightSweepOutcome[] = [];
  const flights = await deps.listFlights();
  const recordsByName = new Map(records.map((record) => [record.name, record]));

  for (const flight of flights) {
    if (flight.status === "closed") continue;
    try {
      const sweep = () => sweepOneFlight(deps, flight, recordsByName, observed);
      outcomes.push(...(deps.withFlightLock ? await deps.withFlightLock(flight.id, sweep) : await sweep()));
    } catch (error) {
      outcomes.push({ flight: flight.id, action: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

async function sweepOneFlight(
  deps: FlightSweepDeps,
  flight: FlightRecord,
  recordsByName: ReadonlyMap<string, SessionRecord>,
  observed: ReadonlyMap<string, BeeState>,
): Promise<FlightSweepOutcome[]> {
  const outcomes: FlightSweepOutcome[] = [];
  const nowMs = deps.now();
  let slots = await deps.listSlots(flight.id);

  // Capacity reconciliation (review CR-6): the flight's slot set is DECLARED
  // by target.mix — a missing/corrupt slot file must not silently shrink the
  // flight (or let it "complete" over fewer slots). Re-create any missing
  // slot as vacant; its history is lost but the invariant is not.
  const present = new Set(slots.map((slot) => slot.slotId));
  const nowIso = new Date(nowMs).toISOString();
  let slotIndex = 0;
  for (const mixEntry of flight.target.mix) {
    for (let i = 0; i < mixEntry.count; i += 1) {
      slotIndex += 1;
      const slotId = `s${slotIndex}`;
      if (present.has(slotId)) continue;
      const recreated: SlotRecord = {
        flightId: flight.id,
        slotId,
        mixKey: mixEntry.key,
        attempt: 0,
        state: "vacant",
        since: nowIso,
        evidence: {},
        history: [{ attempt: 0, outcome: "recreated-missing-slot-file", at: nowIso }],
      };
      await deps.saveSlot(recreated);
      await deps.appendLedger({ type: "flight.vacancy", flight: flight.id, slot: slotId, mixKey: mixEntry.key, reason: "slot-file-missing" });
      slots.push(recreated);
      outcomes.push({ flight: flight.id, slot: slotId, action: "transition", detail: "(missing)→vacant" });
    }
  }
  slots = slots.sort((a, b) => a.slotId.localeCompare(b.slotId, undefined, { numeric: true }));

  const nudges: SlotRecord[] = [];
  const spawnQueue: SlotRecord[] = [];

  const applied: SlotRecord[] = [];
  for (const slot of slots) {
    // Crash recovery: a slot claimed for provisioning whose confirm write was
    // lost re-derives its deterministic bee name and adopts the spawned bee
    // instead of burning (or worse, double-spawning) the attempt. Keyed on
    // the flight ID — names are not unique (review CR-4).
    let subject = slot;
    if (!slot.beeName && slot.state === "provisioning") {
      const orphan = recordsByName.get(slotBeeName(flight.id, slot.slotId, slot.attempt));
      if (orphan) {
        subject = { ...slot, beeName: orphan.name, ...(orphan.id ? { beeId: orphan.id } : {}) };
      }
    }
    const adopted = subject !== slot;
    const record = subject.beeName ? recordsByName.get(subject.beeName) : undefined;
    const evidence: SlotEvidence = {
      ...(record ? { beeStatus: record.status } : {}),
      ...(subject.beeName && observed.get(subject.beeName) ? { beeState: observed.get(subject.beeName)! } : {}),
      seal: subject.beeName ? await deps.latestSeal(subject.beeName) : null,
    };
    const plan = planSlot(flight, subject, evidence, nowMs);
    if (plan.changed || adopted) {
      await deps.saveSlot(plan.slot);
      outcomes.push({
        flight: flight.id,
        slot: slot.slotId,
        action: "transition",
        detail: `${slot.state}→${plan.slot.state}${adopted ? " (adopted)" : ""}`,
      });
    }
    for (const event of plan.events) {
      await deps.appendLedger({ type: event.type, flight: flight.id, ...(event.data ?? {}) });
    }
    if (plan.wantsNudge && plan.slot.beeName) nudges.push(plan.slot);
    if (plan.wantsSpawn) spawnQueue.push(plan.slot);
    // A wedged replacement writes off a bee that may still be alive (stuck
    // boot) — retire it so replaced attempts don't leak hosts/accounts.
    if (deps.retireBee) {
      for (const event of plan.events) {
        const bee = event.type === "flight.slot.wedged" && typeof event.data?.bee === "string" ? event.data.bee : undefined;
        if (!bee) continue;
        try {
          await deps.retireBee(bee);
          outcomes.push({ flight: flight.id, slot: slot.slotId, action: "retire", detail: bee });
        } catch (error) {
          outcomes.push({ flight: flight.id, slot: slot.slotId, action: "error", error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    applied.push(plan.slot);
  }

  // Deterministic stall nudges. nudgedAt is stamped ONLY after the send
  // succeeds (review CR-5): a failed nudge is retried next sweep, and the
  // "nudge unanswered" escalation clock never runs on an undelivered nudge.
  for (const slot of nudges) {
    try {
      await deps.nudge(flight, slot, slot.beeName!);
      const nudged: SlotRecord = { ...slot, nudgedAt: new Date(deps.now()).toISOString() };
      await deps.saveSlot(nudged);
      const index = applied.findIndex((entry) => entry.slotId === slot.slotId);
      if (index >= 0) applied[index] = nudged;
      outcomes.push({ flight: flight.id, slot: slot.slotId, action: "nudge" });
    } catch (error) {
      outcomes.push({ flight: flight.id, slot: slot.slotId, action: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Vacancy fill under backpressure: never exceed maxConcurrentBoots
  // simultaneous provisioning/booting slots (mass-crash → no auth stampede).
  let booting = applied.filter((slot) => SLOT_BOOTING_STATES.includes(slot.state)).length;
  for (const slot of spawnQueue) {
    if (flight.status !== "active") break;
    if (booting >= flight.replacement.maxConcurrentBoots) {
      outcomes.push({ flight: flight.id, slot: slot.slotId, action: "spawn", detail: "deferred-backpressure" });
      continue;
    }
    const mix = flight.target.mix.find((entry) => entry.key === slot.mixKey);
    if (!mix) {
      outcomes.push({ flight: flight.id, slot: slot.slotId, action: "error", error: `no mix entry for key ${slot.mixKey}` });
      continue;
    }
    // PREPARE: durably claim the attempt before any side effect.
    const nowIso = new Date(deps.now()).toISOString();
    const prepared: SlotRecord = {
      ...slot,
      attempt: slot.attempt + 1,
      state: "provisioning",
      since: nowIso,
      attemptStartedAt: nowIso,
      idempotencyKey: slotIdempotencyKey(flight.id, slot.slotId, slot.attempt + 1),
      evidence: {},
      history: slot.history,
    };
    delete prepared.beeName;
    delete prepared.beeId;
    delete prepared.nudgedAt;
    await deps.saveSlot(prepared);
    await deps.appendLedger({ type: "flight.slot.provisioning", flight: flight.id, slot: slot.slotId, attempt: prepared.attempt, mixKey: slot.mixKey });
    booting += 1;
    // EXECUTE + CONFIRM.
    try {
      const spawned = await deps.spawnSlot(flight, prepared, mix);
      const confirmed: SlotRecord = {
        ...prepared,
        beeName: spawned.beeName,
        ...(spawned.beeId ? { beeId: spawned.beeId } : {}),
        state: "booting",
        since: new Date(deps.now()).toISOString(),
      };
      await deps.saveSlot(confirmed);
      await deps.appendLedger({ type: "flight.slot.booting", flight: flight.id, slot: slot.slotId, attempt: confirmed.attempt, bee: spawned.beeName });
      outcomes.push({ flight: flight.id, slot: slot.slotId, action: "spawn", detail: spawned.beeName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The attempt stays consumed (idempotency) — record the failure and let
      // the next sweep decide vacant-vs-abandoned via the machine.
      const failed: SlotRecord = {
        ...prepared,
        state: prepared.attempt >= flight.contract.maxAttemptsPerSlot ? "abandoned" : "vacant",
        since: new Date(deps.now()).toISOString(),
        history: [...prepared.history, { attempt: prepared.attempt, outcome: "spawn-failed", at: new Date(deps.now()).toISOString() }],
      };
      delete failed.attemptStartedAt;
      await deps.saveSlot(failed);
      await deps.appendLedger({ type: "flight.slot.spawn_failed", flight: flight.id, slot: slot.slotId, attempt: prepared.attempt, error: message });
      if (failed.state === "abandoned") {
        await deps.appendLedger({ type: "flight.mix.violation", flight: flight.id, slot: slot.slotId, mixKey: slot.mixKey, attempts: prepared.attempt });
      }
      booting -= 1;
      outcomes.push({ flight: flight.id, slot: slot.slotId, action: "error", error: message });
    }
  }

  // Flight completion: the FULL declared slot set terminal → close + one
  // flight.complete. Requiring target.slots files prevents a lost slot file
  // from closing the flight early (CR-6); under `draining`, `vacant` counts
  // as terminal — a drained flight never refills, so an open vacancy would
  // otherwise pin it in draining forever (CR-7c).
  const finalSlots = await deps.listSlots(flight.id);
  const terminalUnderStatus = (slot: SlotRecord) =>
    SLOT_TERMINAL_STATES.includes(slot.state) || (flight.status === "draining" && slot.state === "vacant");
  if (finalSlots.length >= flight.target.slots && finalSlots.every(terminalUnderStatus)) {
    const done = finalSlots.filter((slot) => slot.state === "done").length;
    const closed: FlightRecord = { ...flight, status: "closed", updatedAt: new Date(deps.now()).toISOString() };
    await deps.saveFlight(closed);
    await deps.appendLedger({ type: "flight.complete", flight: flight.id, done, abandoned: finalSlots.length - done });
    outcomes.push({ flight: flight.id, action: "complete", detail: `${done}/${finalSlots.length} done` });
  }
  return outcomes;
}

/** The deterministic nudge text (templated — the controller never prompts an LLM). */
export function stallNudgeText(flight: FlightRecord, slot: SlotRecord): string {
  return [
    `[flight ${flight.id}] Your slot ${slot.slotId} (attempt ${slot.attempt}) has shown no progress past its stall deadline.`,
    flight.contract.completion === "seal"
      ? `If your task is finished or blocked, record your seal NOW with taskId "${slotTaskId(flight.id, slot.slotId)}" and attempt ${slot.attempt} (see the completion contract in your brief). Otherwise continue working — any tool activity resets the stall clock.`
      : "If your task is finished, exit; otherwise continue working — any tool activity resets the stall clock.",
    "No reply is needed. Going quiet again without a seal escalates this slot.",
  ].join(" ");
}
