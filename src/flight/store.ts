// Flight/slot persistence: one dir per flight under <storeRoot>/flights, one
// JSON file per slot, atomic writes. Everything the controller acts on is
// derivable from THIS disk state plus session records + seals — a daemon
// restart recomputes every slot on its first sweep (listener-outage semantics,
// CL.701 §4.4), and `hive flight status` reads it with the daemon down.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import {
  FLIGHT_CONTRACT_DEFAULTS,
  FLIGHT_REPLACEMENT_DEFAULTS,
  SLOT_STATES,
  TASK_BUCKETS,
  type FlightMixEntry,
  type FlightRecord,
  type FlightTaskPacket,
  type SlotRecord,
  type SlotState,
  type TaskBucket,
} from "./types.js";
import { safeName } from "../store.js";

export function flightsRoot(): string {
  return join(storeRoot(), "flights");
}

export function flightDir(flightId: string): string {
  return join(flightsRoot(), flightId);
}

function flightPath(flightId: string): string {
  return join(flightDir(flightId), "flight.json");
}

function slotsDir(flightId: string): string {
  return join(flightDir(flightId), "slots");
}

function slotPath(flightId: string, slotId: string): string {
  return join(slotsDir(flightId), `${slotId}.json`);
}

export function allocateFlightId(): string {
  return `FL.${randomBytes(3).toString("hex")}`;
}

export async function saveFlight(flight: FlightRecord): Promise<void> {
  await mkdir(slotsDir(flight.id), { recursive: true });
  await atomicWriteFile(flightPath(flight.id), `${JSON.stringify(flight, null, 2)}\n`, { mode: 0o600 });
}

export async function saveSlot(slot: SlotRecord): Promise<void> {
  await mkdir(slotsDir(slot.flightId), { recursive: true });
  await atomicWriteFile(slotPath(slot.flightId, slot.slotId), `${JSON.stringify(slot, null, 2)}\n`, { mode: 0o600 });
}

export async function loadFlight(flightId: string): Promise<FlightRecord | null> {
  try {
    return normalizeFlight(JSON.parse(await readFile(flightPath(flightId), "utf8")) as unknown);
  } catch {
    return null;
  }
}

export async function listFlights(): Promise<FlightRecord[]> {
  const entries = await readdir(flightsRoot(), { withFileTypes: true }).catch(() => []);
  const flights: FlightRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const flight = await loadFlight(entry.name);
    if (flight) flights.push(flight);
  }
  return flights.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listSlots(flightId: string): Promise<SlotRecord[]> {
  const files = (await readdir(slotsDir(flightId)).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const slots: SlotRecord[] = [];
  for (const file of files) {
    try {
      const slot = normalizeSlot(JSON.parse(await readFile(join(slotsDir(flightId), file), "utf8")) as unknown);
      if (slot) slots.push(slot);
    } catch {
      // skip corrupt slot files; the controller re-creates missing slots as vacant
    }
  }
  return slots.sort((a, b) => a.slotId.localeCompare(b.slotId, undefined, { numeric: true }));
}

/** Purge a flight's directory (close --purge / tests). */
export async function deleteFlight(flightId: string): Promise<void> {
  await rm(flightDir(flightId), { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Task queue (flight v1.1 — perpetual lane refill)                    */
/*                                                                     */
/* One JSON file per packet, bucketed by lifecycle:                    */
/*   queue/pending/  → authored, unclaimed                             */
/*   queue/leased/   → bound to a lane (slotId+generation)             */
/*   queue/done/     → completed with a contract-matching seal         */
/*   queue/failed/   → attempts exhausted / operator-abandoned         */
/* Moves are write-target-then-remove-source, executed by the          */
/* controller UNDER the per-flight sweep lock, so claims are           */
/* exactly-once across the daemon and CLI sweepers. Enqueue only ever  */
/* CREATES a file in pending/ and needs no lock.                       */
/* ------------------------------------------------------------------ */

function queueDir(flightId: string, bucket: TaskBucket): string {
  return join(flightDir(flightId), "queue", bucket);
}

function taskFilename(taskId: string): string {
  return `${safeName(taskId)}.json`;
}

async function writeTask(flightId: string, bucket: TaskBucket, task: FlightTaskPacket): Promise<void> {
  await mkdir(queueDir(flightId, bucket), { recursive: true });
  await atomicWriteFile(join(queueDir(flightId, bucket), taskFilename(task.taskId)), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
}

/** Enqueue a packet; refuses a taskId already present in ANY bucket. */
export async function enqueueTask(flightId: string, task: Omit<FlightTaskPacket, "enqueuedAt"> & { enqueuedAt?: string }): Promise<FlightTaskPacket> {
  if (!task.taskId || !task.brief) throw new Error("enqueueTask: taskId and brief are required");
  for (const bucket of TASK_BUCKETS) {
    const existing = await readTask(flightId, bucket, task.taskId);
    if (existing) throw new Error(`task ${task.taskId} already exists in ${flightId} (${bucket})`);
  }
  const packet: FlightTaskPacket = { ...task, enqueuedAt: task.enqueuedAt ?? new Date().toISOString() };
  await writeTask(flightId, "pending", packet);
  return packet;
}

export async function readTask(flightId: string, bucket: TaskBucket, taskId: string): Promise<FlightTaskPacket | null> {
  try {
    return normalizeTask(JSON.parse(await readFile(join(queueDir(flightId, bucket), taskFilename(taskId)), "utf8")) as unknown);
  } catch {
    return null;
  }
}

export async function listTasks(flightId: string, bucket: TaskBucket): Promise<FlightTaskPacket[]> {
  const files = (await readdir(queueDir(flightId, bucket)).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const tasks: FlightTaskPacket[] = [];
  for (const file of files) {
    try {
      const task = normalizeTask(JSON.parse(await readFile(join(queueDir(flightId, bucket), file), "utf8")) as unknown);
      if (task) tasks.push(task);
    } catch {
      // skip corrupt packets; they surface via counts drift in status
    }
  }
  return tasks.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || a.taskId.localeCompare(b.taskId));
}

export type TaskCounts = Record<TaskBucket, number>;

export async function taskCounts(flightId: string): Promise<TaskCounts> {
  const counts = { pending: 0, leased: 0, done: 0, failed: 0 } as TaskCounts;
  for (const bucket of TASK_BUCKETS) {
    counts[bucket] = (await readdir(queueDir(flightId, bucket)).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).length;
  }
  return counts;
}

/** True when this flight has EVER been given queue work (any bucket non-empty). */
export async function isQueueBacked(flightId: string): Promise<boolean> {
  const counts = await taskCounts(flightId);
  return counts.pending + counts.leased + counts.done + counts.failed > 0;
}

/**
 * Claim the oldest pending task for a lane: write it into leased/ with the
 * lease stamp, then remove it from pending/. Caller MUST hold the flight
 * sweep lock. Returns null when pending/ is empty.
 */
export async function claimNextTask(
  flightId: string,
  lease: { slotId: string; generation: number },
): Promise<FlightTaskPacket | null> {
  const pending = await listTasks(flightId, "pending");
  const next = pending[0];
  if (!next) return null;
  const leased: FlightTaskPacket = { ...next, lease: { ...lease, leasedAt: new Date().toISOString() } };
  await writeTask(flightId, "leased", leased);
  await rm(join(queueDir(flightId, "pending"), taskFilename(next.taskId)), { force: true });
  return leased;
}

/**
 * The leased task bound to a slot, if any — crash reconciliation: a task
 * claimed for a lane whose slot prepare was lost is re-bound instead of
 * stranded in leased/ forever.
 */
export async function leasedTaskForSlot(flightId: string, slotId: string): Promise<FlightTaskPacket | null> {
  const leased = await listTasks(flightId, "leased");
  return leased.find((task) => task.lease?.slotId === slotId) ?? null;
}

/** Move a leased task to done/ or failed/ with its outcome stamp. */
export async function finishTask(
  flightId: string,
  taskId: string,
  bucket: "done" | "failed",
  outcome: { sealFilename?: string; reason?: string },
): Promise<void> {
  const task = await readTask(flightId, "leased", taskId);
  if (!task) return; // already finished (idempotent under re-sweeps)
  await writeTask(flightId, bucket, { ...task, outcome: { at: new Date().toISOString(), ...outcome } });
  await rm(join(queueDir(flightId, "leased"), taskFilename(taskId)), { force: true });
}

/**
 * Move a failed (or done — operator's call) task back to pending/, stripped of
 * its lease and outcome, so a lane can claim it fresh. Recovery surface for
 * falsely-failed packets (e.g. attempts burned by infrastructure faults, not
 * by the work).
 */
export async function requeueTask(flightId: string, taskId: string): Promise<FlightTaskPacket> {
  for (const bucket of ["failed", "done"] as const) {
    const task = await readTask(flightId, bucket, taskId);
    if (!task) continue;
    const fresh: FlightTaskPacket = { taskId: task.taskId, brief: task.brief, ...(task.cwd ? { cwd: task.cwd } : {}), enqueuedAt: task.enqueuedAt };
    await writeTask(flightId, "pending", fresh);
    await rm(join(queueDir(flightId, bucket), taskFilename(taskId)), { force: true });
    return fresh;
  }
  throw new Error(`no failed/done task ${taskId} in ${flightId} to requeue`);
}

function normalizeTask(value: unknown): FlightTaskPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (typeof object.taskId !== "string" || typeof object.brief !== "string" || typeof object.enqueuedAt !== "string") return null;
  const leaseRaw = object.lease as Record<string, unknown> | undefined;
  const outcomeRaw = object.outcome as Record<string, unknown> | undefined;
  return {
    taskId: object.taskId,
    brief: object.brief,
    ...(typeof object.cwd === "string" ? { cwd: object.cwd } : {}),
    enqueuedAt: object.enqueuedAt,
    ...(leaseRaw && typeof leaseRaw.slotId === "string" && typeof leaseRaw.generation === "number" && typeof leaseRaw.leasedAt === "string"
      ? { lease: { slotId: leaseRaw.slotId, generation: leaseRaw.generation, leasedAt: leaseRaw.leasedAt } }
      : {}),
    ...(outcomeRaw && typeof outcomeRaw.at === "string"
      ? {
          outcome: {
            at: outcomeRaw.at,
            ...(typeof outcomeRaw.sealFilename === "string" ? { sealFilename: outcomeRaw.sealFilename } : {}),
            ...(typeof outcomeRaw.reason === "string" ? { reason: outcomeRaw.reason } : {}),
          },
        }
      : {}),
  };
}

function normalizeFlight(value: unknown): FlightRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  for (const key of ["id", "name", "cwd", "createdAt", "updatedAt"]) {
    if (typeof object[key] !== "string") return null;
  }
  const status = object.status === "active" || object.status === "draining" || object.status === "closed" ? object.status : "closed";
  const target = object.target as { slots?: unknown; mix?: unknown } | undefined;
  const slots = typeof target?.slots === "number" && Number.isSafeInteger(target.slots) && target.slots > 0 ? target.slots : 0;
  const mix: FlightMixEntry[] = Array.isArray(target?.mix)
    ? (target!.mix as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.key !== "string" || typeof row.agent !== "string" || typeof row.count !== "number") return [];
        return [{
          key: row.key,
          agent: row.agent,
          count: row.count,
          ...(typeof row.model === "string" ? { model: row.model } : {}),
          ...(typeof row.account === "string" ? { account: row.account } : {}),
        }];
      })
    : [];
  if (slots === 0 || mix.length === 0) return null;
  const contractRaw = (object.contract ?? {}) as Record<string, unknown>;
  const replacementRaw = (object.replacement ?? {}) as Record<string, unknown>;
  const num = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return {
    id: object.id as string,
    name: object.name as string,
    ...(typeof object.colony === "string" ? { colony: object.colony } : {}),
    ...(typeof object.createdBy === "string" ? { createdBy: object.createdBy } : {}),
    cwd: object.cwd as string,
    ...(typeof object.brief === "string" ? { brief: object.brief } : {}),
    target: { slots, mix },
    contract: {
      completion: contractRaw.completion === "exit" ? "exit" : "seal",
      ...(typeof contractRaw.sealType === "string" ? { sealType: contractRaw.sealType as FlightRecord["contract"]["sealType"] } : {}),
      readinessDeadlineMs: num(contractRaw.readinessDeadlineMs, FLIGHT_CONTRACT_DEFAULTS.readinessDeadlineMs),
      firstEvidenceDeadlineMs: num(contractRaw.firstEvidenceDeadlineMs, FLIGHT_CONTRACT_DEFAULTS.firstEvidenceDeadlineMs),
      stallMs: num(contractRaw.stallMs, FLIGHT_CONTRACT_DEFAULTS.stallMs),
      maxAttemptsPerSlot: num(contractRaw.maxAttemptsPerSlot, FLIGHT_CONTRACT_DEFAULTS.maxAttemptsPerSlot),
    },
    replacement: {
      policy: "replace-before-collect",
      maxConcurrentBoots: num(replacementRaw.maxConcurrentBoots, FLIGHT_REPLACEMENT_DEFAULTS.maxConcurrentBoots),
    },
    status,
    createdAt: object.createdAt as string,
    updatedAt: object.updatedAt as string,
  };
}

const SLOT_STATE_SET = new Set<string>(SLOT_STATES);

function normalizeSlot(value: unknown): SlotRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (typeof object.flightId !== "string" || typeof object.slotId !== "string" || typeof object.mixKey !== "string") return null;
  if (typeof object.state !== "string" || !SLOT_STATE_SET.has(object.state)) return null;
  if (typeof object.since !== "string") return null;
  const attempt = typeof object.attempt === "number" && Number.isSafeInteger(object.attempt) && object.attempt >= 0 ? object.attempt : 0;
  const generation = typeof object.generation === "number" && Number.isSafeInteger(object.generation) && object.generation >= 0 ? object.generation : 0;
  const evidenceRaw = (object.evidence ?? {}) as Record<string, unknown>;
  const history = Array.isArray(object.history)
    ? (object.history as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.attempt !== "number" || typeof row.outcome !== "string" || typeof row.at !== "string") return [];
        return [{
          attempt: row.attempt,
          outcome: row.outcome,
          at: row.at,
          ...(typeof row.generation === "number" ? { generation: row.generation } : {}),
          ...(typeof row.taskId === "string" ? { taskId: row.taskId } : {}),
          ...(typeof row.beeName === "string" ? { beeName: row.beeName } : {}),
        }];
      })
    : [];
  return {
    flightId: object.flightId,
    slotId: object.slotId,
    mixKey: object.mixKey,
    generation,
    ...(typeof object.taskId === "string" ? { taskId: object.taskId } : {}),
    attempt,
    ...(typeof object.beeName === "string" ? { beeName: object.beeName } : {}),
    ...(typeof object.beeId === "string" ? { beeId: object.beeId } : {}),
    state: object.state as SlotState,
    since: object.since,
    ...(typeof object.attemptStartedAt === "string" ? { attemptStartedAt: object.attemptStartedAt } : {}),
    evidence: {
      ...(typeof evidenceRaw.firstEvidenceAt === "string" ? { firstEvidenceAt: evidenceRaw.firstEvidenceAt } : {}),
      ...(typeof evidenceRaw.lastActivityAt === "string" ? { lastActivityAt: evidenceRaw.lastActivityAt } : {}),
      ...(typeof evidenceRaw.lastActivityFingerprint === "string" ? { lastActivityFingerprint: evidenceRaw.lastActivityFingerprint } : {}),
      ...(typeof evidenceRaw.sealFilename === "string" ? { sealFilename: evidenceRaw.sealFilename } : {}),
    },
    ...(typeof object.idempotencyKey === "string" ? { idempotencyKey: object.idempotencyKey } : {}),
    ...(typeof object.nudgedAt === "string" ? { nudgedAt: object.nudgedAt } : {}),
    history,
  };
}
