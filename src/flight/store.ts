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
  type FlightMixEntry,
  type FlightRecord,
  type SlotRecord,
  type SlotState,
} from "./types.js";

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
  const evidenceRaw = (object.evidence ?? {}) as Record<string, unknown>;
  const history = Array.isArray(object.history)
    ? (object.history as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.attempt !== "number" || typeof row.outcome !== "string" || typeof row.at !== "string") return [];
        return [{ attempt: row.attempt, outcome: row.outcome, at: row.at, ...(typeof row.beeName === "string" ? { beeName: row.beeName } : {}) }];
      })
    : [];
  return {
    flightId: object.flightId,
    slotId: object.slotId,
    mixKey: object.mixKey,
    attempt,
    ...(typeof object.beeName === "string" ? { beeName: object.beeName } : {}),
    ...(typeof object.beeId === "string" ? { beeId: object.beeId } : {}),
    state: object.state as SlotState,
    since: object.since,
    ...(typeof object.attemptStartedAt === "string" ? { attemptStartedAt: object.attemptStartedAt } : {}),
    evidence: {
      ...(typeof evidenceRaw.firstEvidenceAt === "string" ? { firstEvidenceAt: evidenceRaw.firstEvidenceAt } : {}),
      ...(typeof evidenceRaw.lastActivityAt === "string" ? { lastActivityAt: evidenceRaw.lastActivityAt } : {}),
      ...(typeof evidenceRaw.sealFilename === "string" ? { sealFilename: evidenceRaw.sealFilename } : {}),
    },
    ...(typeof object.idempotencyKey === "string" ? { idempotencyKey: object.idempotencyKey } : {}),
    ...(typeof object.nudgedAt === "string" ? { nudgedAt: object.nudgedAt } : {}),
    history,
  };
}
