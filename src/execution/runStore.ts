// Durable Run reservations, the effect-key ledger, and the per-Run
// sequence-addressed control-event log (H1: RFC §7, §10.3-10.5, §12).
//
// Layout under `<executionRoot()>/`:
//   runs/<runKey(runId)>/reservation.json — the durable admission record: the
//     (runId, effectKey, requestDigest) reservation, its receipt, the launch
//     phase, and the bound bee/session facts
//   runs/<runKey(runId)>/events.jsonl     — one corpus RunEvent per line,
//     seq-monotonic, appended under a per-run lock
//   effects/<hash>.json                   — effectKey -> (runId, digest) index
//   .admission.lock                       — serializes every admission decision
//
// Invariants:
//   - the reservation is written BEFORE any process launch (fail-before-
//     mutation); if it cannot be recorded, nothing starts;
//   - reservation.json is the single writer-owned record whose `phase` field
//     distinguishes reserved-not-started, launching (crash window), started,
//     and failed — recovery classification lives in classifyLaunch();
//   - events are append-only, seq starts at 1, and replay after restart reads
//     the same bytes (no in-memory-only control history).
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { safeName } from "../store.js";
import type { JsonValue } from "../comb/types.js";
import type { JsonObject } from "./contract.js";
import { executionError } from "./errors.js";
import { ensureExecutionRoot, executionRoot } from "./nodeState.js";

/* ---------------------------------------------------------------- */
/* Paths                                                             */
/* ---------------------------------------------------------------- */

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Collision-free directory key for a runId (safeName alone can alias ids). */
export function runKey(runId: string): string {
  return `${safeName(runId).slice(0, 40)}-${sha256hex(runId).slice(0, 8)}`;
}

export function runDir(runId: string): string {
  return join(executionRoot(), "runs", runKey(runId));
}

function reservationPath(runId: string): string {
  return join(runDir(runId), "reservation.json");
}

function eventsPath(runId: string): string {
  return join(runDir(runId), "events.jsonl");
}

function eventsLockPath(runId: string): string {
  return join(runDir(runId), ".events.lock");
}

function effectIndexPath(effectKey: string): string {
  return join(executionRoot(), "effects", `${sha256hex(effectKey).slice(0, 32)}.json`);
}

function admissionLockPath(): string {
  return join(executionRoot(), ".admission.lock");
}

/* ---------------------------------------------------------------- */
/* Reservation record                                                */
/* ---------------------------------------------------------------- */

export type EffectReceipt = {
  receiptId: string;
  effectKey: string;
  requestDigest: string;
  outcome: "created" | "replayed";
  resultVersion: number;
  recordedAt: string;
};

export type RunReservationPhase = "reserved" | "launching" | "started" | "failed";

export type RunEnvironmentFacts = {
  providerId: string;
  environmentId: string;
  isolation: JsonObject;
  workingCopy?: JsonObject;
};

export type RunReservation = {
  version: 1;
  runId: string;
  effectKey: string;
  requestDigest: string;
  /** Original acceptance receipt; identical retries replay it byte-stably. */
  receipt: EffectReceipt;
  /** Every durable record stores the negotiated version + digest (RFC §6). */
  protocolVersion: string;
  schemaDigest: string;
  ownerScopeId: string;
  workspaceId: string;
  jobId: string;
  leaseId: string;
  leaseExpiresAt: string;
  /** Full RunIntent as admitted (conflict checks + relaunch use it verbatim). */
  intent: JsonObject;
  /** Deterministic HSR bee name this Run is bound to (derived from runId). */
  beeName: string;
  phase: RunReservationPhase;
  /** Set when a launch attempt begins; the crash-window classifier keys off it. */
  launchAttemptedAt?: string;
  startedAt?: string;
  /** Provider session reference (bee id / provider session id) once known. */
  sessionRef?: string;
  environment?: RunEnvironmentFacts;
  failedAt?: string;
  failureCause?: string;
  /** Terminal projection facts, appended once by the terminal reconciler. */
  result?: { outcome: "completed" | "failed" | "cancelled"; cause?: string; harnessExitCode?: number; finishedAt: string };
  /** Set when recovery declared the start outcome unknowable. */
  indeterminateAt?: string;
  createdAt: string;
  updatedAt: string;
};

type EffectIndexEntry = { effectKey: string; requestDigest: string; runId: string };

/** Deterministic bee name for a Run: retries re-derive the same binding. */
export function beeNameForRun(runId: string): string {
  return `xr-${sha256hex(runId).slice(0, 12)}`;
}

/** Deterministic receipt id: a replayed crash-window admission mints identical bytes. */
function receiptIdFor(effectKey: string, requestDigest: string): string {
  return `rcpt-${sha256hex(`${effectKey}\n${requestDigest}`).slice(0, 16)}`;
}

/**
 * Read a Run's reservation. Absent (ENOENT) -> null; anything unreadable,
 * unparseable, version-unknown, or naming a different runId fails closed —
 * treating corruption as absence would let a retry admit a duplicate effect.
 */
export async function readReservation(runId: string): Promise<RunReservation | null> {
  let raw: string;
  try {
    raw = await readFile(reservationPath(runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw executionError("AUTHORITY_UNAVAILABLE", `run reservation for ${runId} is unreadable: ${String(error)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw executionError("AUTHORITY_UNAVAILABLE", `run reservation for ${runId} is corrupt; refusing to re-admit the effect`);
  }
  if (parsed.version !== 1 || typeof parsed.effectKey !== "string" || typeof parsed.requestDigest !== "string" || typeof parsed.phase !== "string") {
    throw executionError("AUTHORITY_UNAVAILABLE", `run reservation for ${runId} has an unknown version or missing fields`);
  }
  if (parsed.runId !== runId) {
    throw executionError("AUTHORITY_UNAVAILABLE", `run reservation directory for ${runId} names a different run (${String(parsed.runId)})`);
  }
  return parsed as unknown as RunReservation;
}

async function writeReservation(reservation: RunReservation): Promise<void> {
  await mkdir(runDir(reservation.runId), { recursive: true, mode: 0o700 });
  reservation.updatedAt = new Date().toISOString();
  await atomicWriteFile(reservationPath(reservation.runId), `${JSON.stringify(reservation, null, 2)}\n`, { mode: 0o600 });
}

/** Absent (ENOENT) -> null; corrupt fails closed like readReservation. */
async function readEffectIndex(effectKey: string): Promise<EffectIndexEntry | null> {
  let raw: string;
  try {
    raw = await readFile(effectIndexPath(effectKey), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw executionError("AUTHORITY_UNAVAILABLE", `effect index for ${effectKey} is unreadable: ${String(error)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw executionError("AUTHORITY_UNAVAILABLE", `effect index for ${effectKey} is corrupt; refusing to re-admit the effect`);
  }
  if (typeof parsed.effectKey !== "string" || typeof parsed.runId !== "string" || typeof parsed.requestDigest !== "string") {
    throw executionError("AUTHORITY_UNAVAILABLE", `effect index for ${effectKey} is malformed; refusing to re-admit the effect`);
  }
  return parsed as unknown as EffectIndexEntry;
}

async function writeEffectIndex(entry: EffectIndexEntry): Promise<void> {
  await mkdir(join(executionRoot(), "effects"), { recursive: true, mode: 0o700 });
  await atomicWriteFile(effectIndexPath(entry.effectKey), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
}

/* ---------------------------------------------------------------- */
/* Admission                                                         */
/* ---------------------------------------------------------------- */

export type AdmissionInput = {
  runId: string;
  effectKey: string;
  requestDigest: string;
  protocolVersion: string;
  schemaDigest: string;
  ownerScopeId: string;
  workspaceId: string;
  jobId: string;
  leaseId: string;
  leaseExpiresAt: string;
  intent: JsonObject;
};

export type AdmissionOutcome = {
  reservation: RunReservation;
  /** True when this call created the reservation (vs replayed an existing one). */
  created: boolean;
};

/**
 * Durably reserve (runId, effectKey, requestDigest) BEFORE any launch.
 *
 * - identical retry (same effectKey + digest, any transport requestId) replays
 *   the original reservation and receipt;
 * - the same effectKey with a different digest, or the same runId under a
 *   different effect, is IDEMPOTENCY_CONFLICT with no new effect;
 * - a crash between the reservation write and the effect-index write is
 *   repaired here on the next identical retry (the reservation is the record
 *   of truth; the index only accelerates cross-run conflict checks).
 */
export async function admitRunStart(input: AdmissionInput): Promise<AdmissionOutcome> {
  await ensureExecutionRoot();
  return withFileLock(admissionLockPath(), async () => {
    const indexed = await readEffectIndex(input.effectKey);
    if (indexed && indexed.requestDigest !== input.requestDigest) {
      throw executionError(
        "IDEMPOTENCY_CONFLICT",
        `effect key ${input.effectKey} is bound to a different request digest`,
        { effectKey: input.effectKey },
      );
    }
    if (indexed && indexed.runId !== input.runId) {
      throw executionError(
        "IDEMPOTENCY_CONFLICT",
        `effect key ${input.effectKey} is bound to run ${indexed.runId}`,
        { effectKey: input.effectKey, runId: indexed.runId },
      );
    }
    const existing = await readReservation(input.runId);
    if (existing) {
      if (existing.effectKey !== input.effectKey || existing.requestDigest !== input.requestDigest) {
        throw executionError(
          "IDEMPOTENCY_CONFLICT",
          `run ${input.runId} is already reserved under a different effect`,
          { runId: input.runId, effectKey: existing.effectKey },
        );
      }
      if (!indexed) await writeEffectIndex({ effectKey: input.effectKey, requestDigest: input.requestDigest, runId: input.runId });
      return { reservation: existing, created: false };
    }
    const now = new Date().toISOString();
    const reservation: RunReservation = {
      version: 1,
      runId: input.runId,
      effectKey: input.effectKey,
      requestDigest: input.requestDigest,
      receipt: {
        receiptId: receiptIdFor(input.effectKey, input.requestDigest),
        effectKey: input.effectKey,
        requestDigest: input.requestDigest,
        outcome: "created",
        resultVersion: 1,
        recordedAt: now,
      },
      protocolVersion: input.protocolVersion,
      schemaDigest: input.schemaDigest,
      ownerScopeId: input.ownerScopeId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      leaseId: input.leaseId,
      leaseExpiresAt: input.leaseExpiresAt,
      intent: input.intent,
      beeName: beeNameForRun(input.runId),
      phase: "reserved",
      createdAt: now,
      updatedAt: now,
    };
    await writeReservation(reservation);
    await writeEffectIndex({ effectKey: input.effectKey, requestDigest: input.requestDigest, runId: input.runId });
    return { reservation, created: true };
  });
}

/**
 * Persist a reservation mutation under the admission lock (single-writer
 * daemon, but retries/tests may run interleaved instances). The mutator
 * receives the freshest record and returns the mutated one.
 */
export async function mutateReservation(
  runId: string,
  mutate: (reservation: RunReservation) => RunReservation | Promise<RunReservation>,
): Promise<RunReservation> {
  return withFileLock(admissionLockPath(), async () => {
    const current = await readReservation(runId);
    if (!current) throw executionError("RUN_UNKNOWN", `runId ${runId} names no Run reserved on this node`);
    const next = await mutate(current);
    await writeReservation(next);
    return next;
  });
}

/* ---------------------------------------------------------------- */
/* Sequence-addressed control events                                 */
/* ---------------------------------------------------------------- */

export type RunEventInput = {
  type: string;
  payload: JsonValue;
  origin: { nodeId: string; driverId?: string; providerId?: string };
  occurredAt?: string;
};

export type StoredRunEvent = {
  protocolVersion: string;
  runId: string;
  seq: number;
  eventId: string;
  type: string;
  occurredAt: string;
  ingestedAt: string;
  origin: { nodeId: string; driverId?: string; providerId?: string };
  payload: JsonValue;
};

type ParsedEventLog = {
  events: StoredRunEvent[];
  /** Byte length of the valid prefix; bytes past it are a torn trailing record. */
  validPrefixBytes: number;
  tornTail: boolean;
};

/**
 * Parse the event log. A torn TRAILING record (crash mid-append: unterminated
 * or unparseable final line) is recoverable — it is excluded and reported so
 * the writer can truncate before the next append. Any interior corruption,
 * seq reuse, or reordering fails closed: silently skipping a control interval
 * would turn a damaged history into a "successful" replay.
 */
function parseEventLog(runId: string, raw: string): ParsedEventLog {
  const events: StoredRunEvent[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf("\n", offset);
    if (newline === -1) {
      // Unterminated final record — torn append.
      return { events, validPrefixBytes: offset, tornTail: true };
    }
    const line = raw.slice(offset, newline);
    if (line.trim().length > 0) {
      let parsed: StoredRunEvent | null = null;
      try {
        const value = JSON.parse(line) as StoredRunEvent;
        if (typeof value.seq === "number" && typeof value.type === "string") parsed = value;
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        if (raw.indexOf("\n", newline + 1) === -1 && raw.slice(newline + 1).trim().length === 0) {
          // Unparseable FINAL line — also a torn append (e.g. partial write that
          // happened to include the newline of a concatenated next write).
          return { events, validPrefixBytes: offset, tornTail: true };
        }
        throw executionError("AUTHORITY_UNAVAILABLE", `run ${runId} event log is corrupt (unparseable interior record); refusing replay`);
      }
      const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
      if (parsed.seq !== lastSeq + 1) {
        throw executionError(
          "AUTHORITY_UNAVAILABLE",
          `run ${runId} event log is corrupt (seq ${parsed.seq} after ${lastSeq}); refusing replay`,
        );
      }
      events.push(parsed);
    }
    offset = newline + 1;
  }
  return { events, validPrefixBytes: offset, tornTail: false };
}

async function readEventLog(runId: string): Promise<ParsedEventLog> {
  let raw: string;
  try {
    raw = await readFile(eventsPath(runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], validPrefixBytes: 0, tornTail: false };
    throw executionError("AUTHORITY_UNAVAILABLE", `run ${runId} event log is unreadable: ${String(error)}`);
  }
  return parseEventLog(runId, raw);
}

export async function readRunEvents(runId: string): Promise<StoredRunEvent[]> {
  return (await readEventLog(runId)).events;
}

/**
 * Append control events with the next monotonic seq, under the per-run lock.
 * `onlyIfAbsentTypes` makes state-changing appends idempotent across restart
 * reconciliation: an event type listed there is skipped when it already
 * exists. A torn trailing record from a crashed append is truncated (still
 * under the lock) before new bytes go in, so partial bytes can never be
 * concatenated into a hybrid record.
 */
export async function appendRunEvents(
  runId: string,
  protocolVersion: string,
  inputs: RunEventInput[],
  options: { onlyIfAbsentTypes?: boolean } = {},
): Promise<StoredRunEvent[]> {
  await mkdir(runDir(runId), { recursive: true, mode: 0o700 });
  return withFileLock(eventsLockPath(runId), async () => {
    const log = await readEventLog(runId);
    if (log.tornTail) {
      const valid = log.events.map((event) => `${JSON.stringify(event)}\n`).join("");
      await atomicWriteFile(eventsPath(runId), valid, { mode: 0o600 });
    }
    const present = new Set(log.events.map((event) => event.type));
    let seq = log.events.length > 0 ? log.events[log.events.length - 1]!.seq : 0;
    const appended: StoredRunEvent[] = [];
    let lines = "";
    for (const input of inputs) {
      if (options.onlyIfAbsentTypes && present.has(input.type)) continue;
      seq += 1;
      const now = new Date().toISOString();
      const event: StoredRunEvent = {
        protocolVersion,
        runId,
        seq,
        eventId: `evt-${runKey(runId)}-${seq}`,
        type: input.type,
        occurredAt: input.occurredAt ?? now,
        ingestedAt: now,
        origin: input.origin,
        payload: input.payload,
      };
      present.add(event.type);
      appended.push(event);
      lines += `${JSON.stringify(event)}\n`;
    }
    if (lines.length > 0) await appendFile(eventsPath(runId), lines, { mode: 0o600 });
    return appended;
  });
}

/** Last durable seq for a Run (0 when no events yet). */
export async function lastEventSeq(runId: string): Promise<number> {
  const events = await readRunEvents(runId);
  return events.length > 0 ? events[events.length - 1]!.seq : 0;
}

/* ---------------------------------------------------------------- */
/* Launch-outcome classification (crash recovery)                    */
/* ---------------------------------------------------------------- */

export type LaunchClassification =
  | "started"
  | "failed"
  | "launch-in-flight"
  | "reserved-not-started"
  | "started-receipt-lost"
  | "indeterminate";

/**
 * How long a crashed `launching` reservation waits before the absence of any
 * session/HSR evidence proves the spawn never persisted anything. The HSR
 * host is detached and writes its meta within a couple of seconds; until this
 * grace elapses the outcome is honestly indeterminate, never a relaunch.
 */
export const LAUNCH_EVIDENCE_GRACE_MS = 15_000;

export type LaunchEvidence = {
  /** A session record or HSR meta exists for the reservation's bee name. */
  sessionExists: boolean;
  /** The executionRunId stamped on that session record, when present. */
  stampedRunId?: string;
};

/**
 * Classify a reservation's start outcome (RFC §14 reconcile-before-restart;
 * plan H1: distinguish "reserved but never started", "process started but
 * receipt not returned", and "unknown/indeterminate").
 */
export function classifyLaunch(
  reservation: RunReservation,
  evidence: LaunchEvidence,
  options: { inFlight: boolean; nowMs?: number; graceMs?: number } = { inFlight: false },
): LaunchClassification {
  if (reservation.phase === "started") return "started";
  if (reservation.phase === "failed") return "failed";
  if (reservation.phase === "reserved") return options.inFlight ? "launch-in-flight" : "reserved-not-started";
  // phase === "launching"
  if (options.inFlight) return "launch-in-flight";
  if (reservation.indeterminateAt) return "indeterminate";
  if (evidence.sessionExists) {
    if (evidence.stampedRunId !== undefined && evidence.stampedRunId !== reservation.runId) return "indeterminate";
    return "started-receipt-lost";
  }
  const attempted = Date.parse(reservation.launchAttemptedAt ?? reservation.updatedAt);
  const now = options.nowMs ?? Date.now();
  const grace = options.graceMs ?? LAUNCH_EVIDENCE_GRACE_MS;
  if (Number.isFinite(attempted) && now - attempted < grace) return "indeterminate";
  return "reserved-not-started";
}
