// The flight reconciler (CL.701 §4.2): level-triggered, disk-derivable, and
// deliberately boring. Each sweep re-derives every slot from evidence (session
// records + observed states + seals), persists transitions, ledgers events,
// and fills vacancies under backpressure with a durable idempotency claim —
// prepare (write attempt+key) → execute (spawn) → confirm (write bee), so a
// crash mid-replacement never double-spawns an attempt. All effects are
// injected: the daemon wires real spawn/nudge/ledger; tests wire fakes.
import { createHash } from "node:crypto";
import type { BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";
import { planSlot, type SlotEvidence } from "./machine.js";
import {
  SLOT_BOOTING_STATES,
  SLOT_COMPLETION_STATES,
  slotBeeName,
  slotContractTaskId,
  slotIdempotencyKey,
  type FlightMixEntry,
  type FlightRecord,
  type FlightTaskPacket,
  type SlotRecord,
  type SlotSealObservation,
  type TaskBucket,
} from "./types.js";

/** Queue operations the reconciler drives (flight v1.1). Absent → v1 fixed batch. */
export type FlightQueueOps = {
  counts: (flightId: string) => Promise<Record<TaskBucket, number>>;
  /** Claim the oldest pending task for a lane (caller holds the flight lock). */
  claimNext: (flightId: string, lease: { slotId: string; generation: number }) => Promise<FlightTaskPacket | null>;
  /** The leased task already bound to a slot (crash/retry reconciliation). */
  leasedForSlot: (flightId: string, slotId: string) => Promise<FlightTaskPacket | null>;
  /** Move a leased task to done/ or failed/ with its outcome. */
  finish: (flightId: string, taskId: string, bucket: "done" | "failed", outcome: { sealFilename?: string; reason?: string }) => Promise<void>;
};

export type FlightSweepDeps = {
  listFlights: () => Promise<FlightRecord[]>;
  loadFlight: (flightId: string) => Promise<FlightRecord | null>;
  listSlots: (flightId: string) => Promise<SlotRecord[]>;
  saveSlot: (slot: SlotRecord) => Promise<void>;
  saveFlight: (flight: FlightRecord) => Promise<void>;
  /** Latest seal for a bee, or null. */
  latestSeal: (beeName: string) => Promise<SlotSealObservation | null>;
  /**
   * Spawn a slot bee: agent/model/account from the mix, cwd/brief/colony from
   * the flight — overridden by the task packet's cwd/brief when the lane is
   * working queue work — contract carrying the lane's contract taskId +
   * attempt, and deliver the brief.
   */
  spawnSlot: (flight: FlightRecord, slot: SlotRecord, mix: FlightMixEntry, task?: FlightTaskPacket) => Promise<{ beeName: string; beeId?: string }>;
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
  /**
   * Durable task queue (v1.1): with queue work present, lanes RECYCLE — a
   * completed/failed task moves to its bucket, the lane bumps its generation
   * and claims the next packet, keeping N lanes productive until the queue is
   * exhausted (the chronic-underpopulation goal from the CL.701 incident).
   * Absent, or with no queue work ever enqueued, flights behave as v1 fixed
   * batches.
   */
  queue?: FlightQueueOps;
  appendLedger: (event: Record<string, unknown>) => Promise<void>;
  now: () => number;
};

export type BeeActivitySignal = {
  at: string;
  fingerprint?: string;
};

export type HsrObservationTrustSource = "local-hsr" | "remote-hsr-mirror";

const DATE_MIN_MS = -8_640_000_000_000_000;
const DATE_MAX_MS = 8_640_000_000_000_000;

function validDateMs(value: number): boolean {
  return Number.isFinite(value) && value >= DATE_MIN_MS && value <= DATE_MAX_MS && !Number.isNaN(new Date(value).getTime());
}

export function hsrActivitySignal(
  activity: { at: number; fingerprint?: string },
  observedAtMs: number,
): BeeActivitySignal | null {
  if (!validDateMs(activity.at) || !validDateMs(observedAtMs)) return null;
  const at = Math.min(activity.at, observedAtMs);
  return {
    at: new Date(at).toISOString(),
    ...(activity.fingerprint ? { fingerprint: activity.fingerprint } : {}),
  };
}

export function trustedHsrObservationSource(
  record: Pick<SessionRecord, "node" | "substrate">,
  observation: { live: boolean; mirrorOf?: string },
  remoteHsrNodes: ReadonlySet<string>,
): HsrObservationTrustSource | null {
  if (record.substrate === "hsr") {
    return observation.mirrorOf ? null : "local-hsr";
  }
  if (!record.node || !remoteHsrNodes.has(record.node)) return null;
  if (!observation.live || observation.mirrorOf !== record.node) return null;
  return "remote-hsr-mirror";
}

export function paneActivitySignal(record: Pick<SessionRecord, "name">, pane: string, atMs: number): BeeActivitySignal {
  const digest = createHash("sha256").update(pane).digest("hex").slice(0, 16);
  return { at: new Date(atMs).toISOString(), fingerprint: `pane:${record.name}:${digest}` };
}

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
  activity: ReadonlyMap<string, BeeActivitySignal> = new Map(),
): Promise<FlightSweepOutcome[]> {
  const outcomes: FlightSweepOutcome[] = [];
  const snapshots = await deps.listFlights();
  const recordsByName = new Map(records.map((record) => [record.name, record]));

  for (const snapshot of snapshots) {
    try {
      const sweep = async () => {
        const flight = await deps.loadFlight(snapshot.id);
        if (!flight || flight.status === "closed") return [];
        return sweepOneFlight(deps, flight, recordsByName, observed, activity);
      };
      outcomes.push(...(deps.withFlightLock ? await deps.withFlightLock(snapshot.id, sweep) : await sweep()));
    } catch (error) {
      outcomes.push({ flight: snapshot.id, action: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

async function sweepOneFlight(
  deps: FlightSweepDeps,
  flight: FlightRecord,
  recordsByName: ReadonlyMap<string, SessionRecord>,
  observed: ReadonlyMap<string, BeeState>,
  activityByName: ReadonlyMap<string, BeeActivitySignal>,
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
        generation: 0,
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

  // Queue mode (v1.1): a flight that has EVER been given queue work runs as a
  // lane-keeper — completed tasks recycle their lane onto the next packet
  // until pending/ is empty. A flight never enqueued behaves exactly as v1.
  const counts = deps.queue ? await deps.queue.counts(flight.id) : null;
  const queueBacked = counts !== null && counts.pending + counts.leased + counts.done + counts.failed > 0;

  const nudges: SlotRecord[] = [];
  const spawnQueue: SlotRecord[] = [];

  const applied: SlotRecord[] = [];
  for (const slot of slots) {
    // Crash recovery: a slot claimed for provisioning whose confirm write was
    // lost re-derives its deterministic bee name and adopts the spawned bee
    // instead of burning (or worse, double-spawning) the attempt. Keyed on
    // the flight ID — names are not unique (review CR-4).
    let subject = slot;
    let adopted = false;
    let revived = false;
    if (!slot.beeName && slot.state === "provisioning") {
      const orphan = recordsByName.get(slotBeeName(flight.id, slot.slotId, slot.generation, slot.attempt));
      if (orphan) {
        subject = { ...slot, beeName: orphan.name, ...(orphan.id ? { beeId: orphan.id } : {}) };
        adopted = true;
      }
    }
    // Revive: a drained lane wakes up the moment new queue work appears.
    if (slot.state === "drained" && queueBacked && counts!.pending > 0 && flight.status === "active") {
      subject = { ...subject, state: "vacant", since: new Date(nowMs).toISOString() };
      revived = true;
      await deps.appendLedger({ type: "flight.vacancy", flight: flight.id, slot: slot.slotId, mixKey: slot.mixKey, reason: "task-available" });
    }
    const adjusted = adopted || revived;
    const record = subject.beeName ? recordsByName.get(subject.beeName) : undefined;
    const activity = subject.beeName ? activityByName.get(subject.beeName) : undefined;
    const evidence: SlotEvidence = {
      ...(record ? { beeStatus: record.status } : {}),
      ...(subject.beeName && observed.get(subject.beeName) ? { beeState: observed.get(subject.beeName)! } : {}),
      ...(activity ? { beeActivityAt: activity.at, ...(activity.fingerprint ? { beeActivityFingerprint: activity.fingerprint } : {}) } : {}),
      seal: subject.beeName ? await deps.latestSeal(subject.beeName) : null,
    };
    const plan = planSlot(flight, subject, evidence, nowMs);
    let planned = plan.slot;

    // Lane recycling (v1.1): a finished TASK is not a finished LANE. Move the
    // packet to its outcome bucket, bump the generation, and reopen the
    // vacancy so the spawn phase can claim the next packet. Attempt
    // exhaustion fails the TASK (queue's failed/) but recycles the lane —
    // one poisoned packet must not kill lane capacity. The completed bee is
    // deliberately NOT retired: replace-before-collect leaves collection to
    // the manager at its leisure; retire after collecting.
    if (queueBacked && planned.taskId && (planned.state === "done" || planned.state === "abandoned")) {
      const bucket = planned.state === "done" ? "done" : "failed";
      await deps.queue!.finish(flight.id, planned.taskId, bucket, bucket === "done"
        ? { ...(planned.evidence.sealFilename ? { sealFilename: planned.evidence.sealFilename } : {}) }
        : { reason: "attempts-exhausted" });
      await deps.appendLedger({
        type: `flight.task.${bucket}`,
        flight: flight.id,
        slot: slot.slotId,
        task: planned.taskId,
        generation: planned.generation,
        ...(planned.beeName ? { bee: planned.beeName } : {}),
        ...(planned.evidence.sealFilename ? { seal: planned.evidence.sealFilename } : {}),
      });
      const recycleIso = new Date(deps.now()).toISOString();
      const recycled: SlotRecord = {
        ...planned,
        generation: planned.generation + 1,
        attempt: 0,
        state: "vacant",
        since: recycleIso,
        evidence: {},
        history: [
          ...planned.history,
          { attempt: planned.attempt, generation: planned.generation, taskId: planned.taskId, outcome: `task-${bucket}`, at: recycleIso },
        ],
      };
      delete recycled.taskId;
      delete recycled.beeName;
      delete recycled.beeId;
      delete recycled.nudgedAt;
      delete recycled.attemptStartedAt;
      delete recycled.idempotencyKey;
      planned = recycled;
    }

    if (plan.changed || adjusted || planned !== plan.slot) {
      await deps.saveSlot(planned);
      if (slot.state !== planned.state || adjusted || planned !== plan.slot) {
        outcomes.push({
          flight: flight.id,
          slot: slot.slotId,
          action: "transition",
          detail: `${slot.state}→${planned.state}${adopted ? " (adopted)" : ""}${revived ? " (revived)" : ""}${planned !== plan.slot ? " (recycled)" : ""}`,
        });
      }
    }
    for (const event of plan.events) {
      await deps.appendLedger({ type: event.type, flight: flight.id, ...(event.data ?? {}) });
    }
    if (plan.wantsNudge && planned.beeName) nudges.push(planned);
    if (planned.state === "vacant" && flight.status === "active") spawnQueue.push(planned);
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
    applied.push(planned);
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

    // Task binding (v1.1): a lane in a queue-backed flight works a PACKET.
    // Order of precedence — the lease already bound to this slot (retry of an
    // in-flight task, or a claim whose slot prepare was lost to a crash),
    // else the oldest pending packet (claimed durably BEFORE the slot
    // prepare, under the flight lock). No packet → the lane parks as drained
    // until someone enqueues more work.
    let task: FlightTaskPacket | null = null;
    if (queueBacked) {
      task = await deps.queue!.leasedForSlot(flight.id, slot.slotId);
      if (!task) {
        task = await deps.queue!.claimNext(flight.id, { slotId: slot.slotId, generation: slot.generation });
        if (task) {
          await deps.appendLedger({ type: "flight.task.claimed", flight: flight.id, slot: slot.slotId, task: task.taskId, generation: slot.generation });
        }
      }
      if (!task) {
        const drainedIso = new Date(deps.now()).toISOString();
        const drained: SlotRecord = { ...slot, state: "drained", since: drainedIso };
        delete drained.taskId;
        await deps.saveSlot(drained);
        await deps.appendLedger({ type: "flight.slot.drained", flight: flight.id, slot: slot.slotId, mixKey: slot.mixKey });
        const index = applied.findIndex((entry) => entry.slotId === slot.slotId);
        if (index >= 0) applied[index] = drained;
        outcomes.push({ flight: flight.id, slot: slot.slotId, action: "transition", detail: "vacant→drained" });
        continue;
      }
    }

    // PREPARE: durably claim the attempt before any side effect.
    const nowIso = new Date(deps.now()).toISOString();
    const prepared: SlotRecord = {
      ...slot,
      ...(task ? { taskId: task.taskId } : {}),
      attempt: slot.attempt + 1,
      state: "provisioning",
      since: nowIso,
      attemptStartedAt: nowIso,
      idempotencyKey: slotIdempotencyKey(flight.id, slot.slotId, slot.generation, slot.attempt + 1),
      evidence: {},
      history: slot.history,
    };
    delete prepared.beeName;
    delete prepared.beeId;
    delete prepared.nudgedAt;
    await deps.saveSlot(prepared);
    await deps.appendLedger({ type: "flight.slot.provisioning", flight: flight.id, slot: slot.slotId, generation: prepared.generation, attempt: prepared.attempt, mixKey: slot.mixKey, ...(task ? { task: task.taskId } : {}) });
    booting += 1;
    // EXECUTE + CONFIRM.
    try {
      const spawned = await deps.spawnSlot(flight, prepared, mix, task ?? undefined);
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

  // Flight completion: the FULL declared slot set finished → close + one
  // flight.complete. Requiring target.slots files prevents a lost slot file
  // from closing the flight early (CR-6). Drained lanes count as finished —
  // that IS the queue-exhausted end state. Under `draining`, `vacant` counts
  // too (a drained flight never refills — CR-7c), and pending/leased tasks
  // are deliberately ignored: draining means "finish current work, run
  // nothing new", so frozen queue work must not pin the flight open (the
  // complete event reports what was left behind). An ACTIVE queue-backed
  // flight only completes once pending AND leased are both empty.
  const finalSlots = await deps.listSlots(flight.id);
  const finalCounts = queueBacked ? await deps.queue!.counts(flight.id) : null;
  const queueOpen = flight.status === "active" && finalCounts !== null && finalCounts.pending + finalCounts.leased > 0;
  const terminalUnderStatus = (slot: SlotRecord) =>
    SLOT_COMPLETION_STATES.includes(slot.state) || (flight.status === "draining" && slot.state === "vacant");
  if (finalSlots.length >= flight.target.slots && finalSlots.every(terminalUnderStatus) && !queueOpen) {
    const done = finalSlots.filter((slot) => slot.state === "done").length;
    const closed: FlightRecord = { ...flight, status: "closed", updatedAt: new Date(deps.now()).toISOString() };
    await deps.saveFlight(closed);
    await deps.appendLedger({
      type: "flight.complete",
      flight: flight.id,
      done,
      abandoned: finalSlots.filter((slot) => slot.state === "abandoned").length,
      ...(finalCounts
        ? { tasksDone: finalCounts.done, tasksFailed: finalCounts.failed, tasksLeft: finalCounts.pending + finalCounts.leased }
        : {}),
    });
    outcomes.push({
      flight: flight.id,
      action: "complete",
      detail: finalCounts ? `tasks ${finalCounts.done} done, ${finalCounts.failed} failed` : `${done}/${finalSlots.length} done`,
    });
  }
  return outcomes;
}

/** The deterministic nudge text (templated — the controller never prompts an LLM). */
export function stallNudgeText(flight: FlightRecord, slot: SlotRecord): string {
  return [
    `[flight ${flight.id}] Your slot ${slot.slotId} (attempt ${slot.attempt}) has shown no progress past its stall deadline.`,
    flight.contract.completion === "seal"
      ? `If your task is finished or blocked, record your seal NOW with taskId "${slotContractTaskId(slot)}" and attempt ${slot.attempt} (see the completion contract in your brief). Otherwise continue working — any tool activity resets the stall clock.`
      : "If your task is finished, exit; otherwise continue working — any tool activity resets the stall clock.",
    "No reply is needed. Going quiet again without a seal escalates this slot.",
  ].join(" ");
}
