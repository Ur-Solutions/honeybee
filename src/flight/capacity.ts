// FlightCapacityProvider — the shared activation/flight boundary from
// COMBS_ENGINE_DESIGN §9 contract 1. The comb engine leases worker capacity
// from a flight WITHOUT ever touching FlightRecord/SlotRecord files: this
// module is the flight-side implementation of that boundary, and every
// mutation it makes runs under the same per-flight sweep lock the daemon and
// CLI sweepers use, so a lease can never race the lane-keeper.
//
// Semantics:
// - `acquire` is atomic and idempotency-keyed: the lease record is persisted
//   BEFORE any side effect (prepare → execute → confirm, same discipline as
//   slot replacement), so a crash at any boundary is recovered by re-calling
//   acquire with the same key — never by double-spawning.
// - A leased lane carries the comb's OWN taskId/attempt as its completion
//   contract, so the existing machine (strict seal matching, deadlines,
//   node_unreachable clock hold) drives the leased bee exactly like a queue
//   lane. The synthetic packet never enters the queue buckets: the
//   controller's queue.finish is a no-op for it by design.
// - `release` returns the lane to the flight's pool (generation bump →
//   vacant) and best-effort retires the leased bee; the comb engine collects
//   evidence BEFORE releasing.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { transactionalRetire } from "../kill.js";
import { appendLedger, loadSession, safeName, type SessionRecord } from "../store.js";
import { spawnSlotBee } from "./spawnSlotBee.js";
import { flightDir, listSlots, loadFlight, saveSlot } from "./store.js";
import {
  SLOT_BOOTING_STATES,
  slotBeeName,
  type FlightMixEntry,
  type FlightRecord,
  type FlightTaskPacket,
  type SlotRecord,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Contract shapes (COMBS_ENGINE_DESIGN §2/§9)                         */
/* ------------------------------------------------------------------ */

export type ActivationAddress = {
  runId: string;
  nodeId: string;
  /** 1-based. */
  attempt: number;
  /** 0 for non-fan-out. */
  itemIndex: number;
};

export type ResolvedSubject = {
  kind: string;
  key: string;
  revision: string;
};

export type FlightCapacityAcquireRequest = {
  flightId: string;
  mixKey?: string;
  activation: ActivationAddress;
  taskId: string;
  attempt: number;
  subject: ResolvedSubject;
  brief: string;
  idempotencyKey: string;
};

export type FlightCapacityAcquired = { kind: "acquired"; leaseId: string; beeName: string; beeId?: string };
export type FlightCapacityUnavailable = { kind: "unavailable"; retryAfterMs: number };

export type FlightCapacityProvider = {
  acquire(request: FlightCapacityAcquireRequest): Promise<FlightCapacityAcquired | FlightCapacityUnavailable>;
  lookup(idempotencyKey: string): Promise<{ leaseId: string; beeName: string; beeId?: string } | null>;
  release(leaseId: string, reason: "done" | "failed" | "cancelled"): Promise<void>;
};

/* ------------------------------------------------------------------ */
/* Lease store: flights/<id>/leases/<safe(idempotencyKey)>.json        */
/* ------------------------------------------------------------------ */

export type FlightLeaseRecord = {
  leaseId: string;
  idempotencyKey: string;
  flightId: string;
  slotId: string;
  generation: number;
  taskId: string;
  attempt: number;
  activation: ActivationAddress;
  subject: ResolvedSubject;
  status: "acquiring" | "acquired" | "released";
  beeName?: string;
  beeId?: string;
  createdAt: string;
  releasedAt?: string;
  releaseReason?: "done" | "failed" | "cancelled";
  lastError?: string;
};

function leasesDir(flightId: string): string {
  return join(flightDir(flightId), "leases");
}

function leasePath(flightId: string, idempotencyKey: string): string {
  return join(leasesDir(flightId), `${safeName(idempotencyKey)}.json`);
}

async function writeLease(lease: FlightLeaseRecord): Promise<void> {
  await mkdir(leasesDir(lease.flightId), { recursive: true });
  await atomicWriteFile(leasePath(lease.flightId, lease.idempotencyKey), `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
}

export async function readLease(flightId: string, idempotencyKey: string): Promise<FlightLeaseRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(leasePath(flightId, idempotencyKey), "utf8")) as FlightLeaseRecord;
    return parsed && typeof parsed === "object" && typeof parsed.leaseId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function listLeases(flightId: string): Promise<FlightLeaseRecord[]> {
  const files = (await readdir(leasesDir(flightId)).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const leases: FlightLeaseRecord[] = [];
  for (const file of files) {
    try {
      const lease = JSON.parse(await readFile(join(leasesDir(flightId), file), "utf8")) as FlightLeaseRecord;
      if (lease && typeof lease.leaseId === "string") leases.push(lease);
    } catch {
      // corrupt lease files are skipped; the idempotent acquire path re-creates
    }
  }
  return leases;
}

/** leaseId → lease, scanning every flight (release addresses by leaseId only). */
async function findLeaseById(leaseId: string, listFlightIds: () => Promise<string[]>): Promise<FlightLeaseRecord | null> {
  for (const flightId of await listFlightIds()) {
    const match = (await listLeases(flightId)).find((lease) => lease.leaseId === leaseId);
    if (match) return match;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export type FlightCapacityDeps = {
  loadFlight: (flightId: string) => Promise<FlightRecord | null>;
  listSlots: (flightId: string) => Promise<SlotRecord[]>;
  saveSlot: (slot: SlotRecord) => Promise<void>;
  /** Same lock the sweepers hold — a lease never races the lane-keeper. */
  withFlightLock: <T>(flightId: string, fn: () => Promise<T>) => Promise<T>;
  spawnSlot: (flight: FlightRecord, slot: SlotRecord, mix: FlightMixEntry, task?: FlightTaskPacket) => Promise<{ beeName: string; beeId?: string }>;
  /** Crash re-acquire adoption: is the deterministically-named bee registered? */
  loadSession: (name: string) => Promise<SessionRecord | null>;
  retireBee?: (beeName: string) => Promise<void>;
  /** Flight ids to scan for release-by-leaseId. */
  listFlightIds: () => Promise<string[]>;
  appendLedger: (event: Record<string, unknown>) => Promise<void>;
  now: () => number;
};

const RETRY_INACTIVE_MS = 30_000;
const RETRY_NO_LANE_MS = 15_000;
const RETRY_BACKPRESSURE_MS = 10_000;
const RETRY_SPAWN_FAILED_MS = 15_000;

export function createFlightCapacityProvider(overrides: Partial<FlightCapacityDeps> = {}): FlightCapacityProvider {
  const deps: FlightCapacityDeps = {
    loadFlight,
    listSlots,
    saveSlot,
    withFlightLock: (flightId, fn) =>
      withFileLock(join(flightDir(flightId), ".sweep.lock"), fn, { timeoutMs: 5_000, staleMs: 10 * 60_000 }),
    spawnSlot: spawnSlotBee,
    loadSession,
    retireBee: async (beeName) => {
      const record = await loadSession(beeName);
      if (!record || record.status !== "running") return;
      await transactionalRetire(record);
    },
    listFlightIds: async () => {
      const { listFlights } = await import("./store.js");
      return (await listFlights()).map((flight) => flight.id);
    },
    appendLedger,
    now: () => Date.now(),
    ...overrides,
  };

  const acquire = async (request: FlightCapacityAcquireRequest): Promise<FlightCapacityAcquired | FlightCapacityUnavailable> =>
    deps.withFlightLock(request.flightId, async () => {
      const nowIso = new Date(deps.now()).toISOString();

      // Idempotent replay: the lease record is the durable answer.
      const existing = await readLease(request.flightId, request.idempotencyKey);
      if (existing && (existing.status === "acquired" || existing.status === "released") && existing.beeName) {
        return { kind: "acquired", leaseId: existing.leaseId, beeName: existing.beeName, ...(existing.beeId ? { beeId: existing.beeId } : {}) };
      }

      const flight = await deps.loadFlight(request.flightId);
      if (!flight || flight.status !== "active") {
        return { kind: "unavailable", retryAfterMs: RETRY_INACTIVE_MS };
      }

      const slots = await deps.listSlots(request.flightId);

      // Crash recovery for an "acquiring" lease: if its slot claim landed,
      // adopt the deterministically-named bee (or re-execute the spawn);
      // if the claim never landed (or the lane has moved on), fall through
      // and select a fresh lane under the same idempotency key.
      let claimed: SlotRecord | undefined;
      if (existing) {
        const slot = slots.find((entry) => entry.slotId === existing.slotId);
        if (
          slot &&
          slot.idempotencyKey === request.idempotencyKey &&
          slot.generation === existing.generation &&
          slot.taskId === request.taskId
        ) {
          claimed = slot;
        }
      }

      if (!claimed) {
        // Fresh selection: drained lanes first (idle capacity the queue is not
        // waiting on), then vacant; never a lane already bound to a task.
        const candidates = slots
          .filter((slot) => (slot.state === "drained" || slot.state === "vacant") && !slot.taskId)
          .filter((slot) => (request.mixKey ? slot.mixKey === request.mixKey : true))
          .sort((a, b) => (a.state === b.state ? a.slotId.localeCompare(b.slotId, undefined, { numeric: true }) : a.state === "drained" ? -1 : 1));
        const candidate = candidates[0];
        if (!candidate) return { kind: "unavailable", retryAfterMs: RETRY_NO_LANE_MS };

        const booting = slots.filter((slot) => SLOT_BOOTING_STATES.includes(slot.state)).length;
        if (booting >= flight.replacement.maxConcurrentBoots) {
          return { kind: "unavailable", retryAfterMs: RETRY_BACKPRESSURE_MS };
        }

        // PREPARE: lease first, then the slot claim — both durable before the
        // spawn executes.
        const lease: FlightLeaseRecord = existing ?? {
          leaseId: `LS.${randomBytes(4).toString("hex")}`,
          idempotencyKey: request.idempotencyKey,
          flightId: request.flightId,
          slotId: candidate.slotId,
          generation: candidate.generation + 1,
          taskId: request.taskId,
          attempt: request.attempt,
          activation: request.activation,
          subject: request.subject,
          status: "acquiring",
          createdAt: nowIso,
        };
        lease.slotId = candidate.slotId;
        lease.generation = candidate.generation + 1;
        await writeLease(lease);

        claimed = {
          ...candidate,
          generation: candidate.generation + 1,
          attempt: request.attempt,
          taskId: request.taskId,
          state: "provisioning",
          since: nowIso,
          attemptStartedAt: nowIso,
          idempotencyKey: request.idempotencyKey,
          evidence: {},
          history: [
            ...candidate.history,
            { attempt: request.attempt, generation: candidate.generation + 1, taskId: request.taskId, outcome: "comb-lease-claimed", at: nowIso },
          ],
        };
        delete claimed.beeName;
        delete claimed.beeId;
        delete claimed.nudgedAt;
        await deps.saveSlot(claimed);
      }

      const lease = (await readLease(request.flightId, request.idempotencyKey))!;

      // Adoption: a previous acquire may have spawned before crashing.
      const expectedName = slotBeeName(request.flightId, claimed.slotId, claimed.generation, claimed.attempt);
      const orphan = await deps.loadSession(expectedName);
      let spawned: { beeName: string; beeId?: string };
      if (orphan && orphan.status === "running") {
        spawned = { beeName: orphan.name, ...(orphan.id ? { beeId: orphan.id } : {}) };
      } else {
        const mix = flight.target.mix.find((entry) => entry.key === claimed!.mixKey);
        if (!mix) return { kind: "unavailable", retryAfterMs: RETRY_INACTIVE_MS };
        try {
          // EXECUTE — the synthetic packet carries the comb's brief; the slot
          // already carries the comb taskId/attempt, so the contract
          // postscript demands exactly the keys the engine will judge.
          spawned = await deps.spawnSlot(flight, claimed, mix, {
            taskId: request.taskId,
            brief: request.brief,
            enqueuedAt: nowIso,
          });
        } catch (error) {
          // The lane must not stay bound to a spawn that never happened: clear
          // the binding so neither the sweeper nor a re-acquire trips on it.
          const restored: SlotRecord = { ...claimed, state: "vacant", since: new Date(deps.now()).toISOString() };
          delete restored.taskId;
          delete restored.idempotencyKey;
          delete restored.attemptStartedAt;
          restored.history = [...claimed.history, { attempt: claimed.attempt, generation: claimed.generation, outcome: "comb-lease-spawn-failed", at: new Date(deps.now()).toISOString() }];
          await deps.saveSlot(restored);
          await writeLease({ ...lease, lastError: error instanceof Error ? error.message : String(error) });
          await deps.appendLedger({ type: "flight.lease.spawn_failed", flight: request.flightId, slot: claimed.slotId, lease: lease.leaseId, error: error instanceof Error ? error.message : String(error) });
          return { kind: "unavailable", retryAfterMs: RETRY_SPAWN_FAILED_MS };
        }
      }

      // CONFIRM.
      const confirmed: SlotRecord = {
        ...claimed,
        beeName: spawned.beeName,
        ...(spawned.beeId ? { beeId: spawned.beeId } : {}),
        state: "booting",
        since: new Date(deps.now()).toISOString(),
      };
      await deps.saveSlot(confirmed);
      await writeLease({ ...lease, status: "acquired", beeName: spawned.beeName, ...(spawned.beeId ? { beeId: spawned.beeId } : {}) });
      await deps.appendLedger({
        type: "flight.lease.acquired",
        flight: request.flightId,
        slot: claimed.slotId,
        lease: lease.leaseId,
        task: request.taskId,
        attempt: request.attempt,
        bee: spawned.beeName,
        run: request.activation.runId,
        node: request.activation.nodeId,
      });
      return { kind: "acquired", leaseId: lease.leaseId, beeName: spawned.beeName, ...(spawned.beeId ? { beeId: spawned.beeId } : {}) };
    });

  const lookup = async (idempotencyKey: string): Promise<{ leaseId: string; beeName: string; beeId?: string } | null> => {
    for (const flightId of await deps.listFlightIds()) {
      const lease = await readLease(flightId, idempotencyKey);
      if (lease && lease.status === "acquired" && lease.beeName) {
        return { leaseId: lease.leaseId, beeName: lease.beeName, ...(lease.beeId ? { beeId: lease.beeId } : {}) };
      }
    }
    return null;
  };

  const release = async (leaseId: string, reason: "done" | "failed" | "cancelled"): Promise<void> => {
    const lease = await findLeaseById(leaseId, deps.listFlightIds);
    if (!lease) throw new Error(`unknown flight capacity lease: ${leaseId}`);
    if (lease.status === "released") return; // idempotent
    await deps.withFlightLock(lease.flightId, async () => {
      const nowIso = new Date(deps.now()).toISOString();
      const slots = await deps.listSlots(lease.flightId);
      const slot = slots.find((entry) => entry.slotId === lease.slotId);
      // Recycle only if the lane is still bound to THIS lease — the sweeper
      // may already have recycled it (seal-driven done on a queue-backed
      // flight), in which case the lane moved on and we only file the lease.
      if (slot && slot.generation === lease.generation && (slot.idempotencyKey === lease.idempotencyKey || slot.taskId === lease.taskId)) {
        const recycled: SlotRecord = {
          ...slot,
          generation: slot.generation + 1,
          attempt: 0,
          state: "vacant",
          since: nowIso,
          evidence: {},
          history: [
            ...slot.history,
            { attempt: slot.attempt, generation: slot.generation, taskId: lease.taskId, ...(slot.beeName ? { beeName: slot.beeName } : {}), outcome: `comb-lease-${reason}`, at: nowIso },
          ],
        };
        delete recycled.taskId;
        delete recycled.beeName;
        delete recycled.beeId;
        delete recycled.nudgedAt;
        delete recycled.attemptStartedAt;
        delete recycled.idempotencyKey;
        await deps.saveSlot(recycled);
      }
      // The engine collects evidence BEFORE releasing; the leased bee is done
      // serving and is retired so leases never leak hosts/accounts.
      if (lease.beeName && deps.retireBee) {
        await deps.retireBee(lease.beeName).catch(() => undefined);
      }
      await writeLease({ ...lease, status: "released", releasedAt: nowIso, releaseReason: reason });
      await deps.appendLedger({
        type: "flight.lease.released",
        flight: lease.flightId,
        slot: lease.slotId,
        lease: lease.leaseId,
        task: lease.taskId,
        reason,
        ...(lease.beeName ? { bee: lease.beeName } : {}),
      });
    });
  };

  return { acquire, lookup, release };
}
