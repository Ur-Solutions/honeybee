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
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import type { ProcessBirthFingerprint } from "../hsr/processIdentity.js";
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

/** Shared admission lock: every effect admission decision serializes on it. */
export function admissionLockPath(): string {
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

/**
 * Durable identity of the coordinator process that owns one launch attempt.
 * A PID is only a locator: takeover requires this persisted OS-birth identity
 * to prove that the exact owner incarnation is gone.
 */
export type RunLaunchOwner = {
  ownerId: string;
  pid: number;
  /** Stable machine identity; absent only on pre-machine-id reservations. */
  machineId?: string;
  /** Display/debug fact only when machineId is present. */
  hostname: string;
  processFingerprint: ProcessBirthFingerprint;
};

/** One non-expiring launch lease. Age is diagnostic only, never authority. */
export type RunLaunchAttempt = {
  attemptId: string;
  owner: RunLaunchOwner;
  claimedAt: string;
  /**
   * `preparing` proves the launcher side effect has not been invoked yet.
   * Missing is a legacy/active attempt and is treated as already launching.
   */
  stage?: "preparing" | "launching";
  takeoverOf?: string;
};

export type RunEnvironmentFacts = {
  providerId: string;
  environmentId: string;
  isolation: JsonObject;
  workingCopy?: JsonObject;
};

export type RunTerminalOutcome = "completed" | "failed" | "cancelled";

export type RunTerminalResult = {
  outcome: RunTerminalOutcome;
  cause?: string;
  harnessExitCode?: number;
  finishedAt: string;
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
  /**
   * Parent capability lease from the admitting envelope's authority claims.
   * REQUIRED: every per-run operation must present the same capabilityLeaseId;
   * a record without one fails closed on read (no pre-H3 fail-open).
   */
  capabilityLeaseId: string;
  /** Full RunIntent as admitted (conflict checks + relaunch use it verbatim). */
  intent: JsonObject;
  /**
   * Immutable initiator fact from the admitting envelope's validated
   * ActorContext (minimal: kind + id). Captured once at admission; an agent
   * initiator becomes the spawned harness's parent edge (spawnedById) unless
   * a same-scope parentRunId supplies the actual parent bee. Human/root
   * initiators carry the fact but never manufacture a parent.
   */
  initiator?: { kind: string; id: string };
  /** Deterministic HSR bee name this Run is bound to (derived from runId). */
  beeName: string;
  phase: RunReservationPhase;
  /** Durable, birth-fenced ownership of the only process launch allowed now. */
  launchAttempt?: RunLaunchAttempt;
  /** Diagnostic compatibility stamp; elapsed time never authorizes takeover. */
  launchAttemptedAt?: string;
  startedAt?: string;
  /** Provider session reference (bee id / provider session id) once known. */
  sessionRef?: string;
  environment?: RunEnvironmentFacts;
  failedAt?: string;
  failureCause?: string;
  /** Terminal projection facts, appended once by the terminal reconciler. */
  result?: RunTerminalResult;
  /** Set when recovery declared the start outcome unknowable. */
  indeterminateAt?: string;
  /** Machine-readable reason reconciliation uses to retry/resolve lost state. */
  indeterminateCause?: string;
  /** Stable idempotency member for one lost -> recovering episode. */
  lossEpisodeId?: string;
  /** Durable cancellation intent (run.cancel is desired state, not an RPC race). */
  cancel?: { requestedAt: string; reason?: string };
  /** Debug-retention window (run.retain); extends retention only, never authority. */
  retainUntil?: string;
  /**
   * Durable proof that a particular retain effect persisted before release.
   * The operation result is written separately, so this provenance lets a
   * replay after a crash distinguish "retain won, result write was pending"
   * from "release won before the reservation mutation".
   */
  retentionEffects?: Record<string, { retainUntil: string; persistedAt: string }>;
  /** Environment lifecycle stamps written by run.release's step ledger. */
  sealedAt?: string;
  releasedAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** Enter (or backfill) one durable liveness-loss episode. */
export function enterLossEpisode(record: RunReservation, cause: string, observedAt: string): RunReservation {
  const indeterminateAt = record.indeterminateAt ?? observedAt;
  return {
    ...record,
    indeterminateAt,
    indeterminateCause: record.indeterminateCause ?? cause,
    // Legacy reservations already carrying indeterminateAt predate this field;
    // their timestamp is a stable backfill. A genuinely NEW episode gets a
    // random durable identity: two episodes may occur within the same clock
    // tick (or under a fixed test clock) and must never deduplicate together.
    lossEpisodeId: record.lossEpisodeId ?? (record.indeterminateAt ? record.indeterminateAt : randomUUID()),
  };
}

/** Resolve one episode completely so a later independent loss gets a new key. */
export function clearLossEpisode(record: RunReservation): RunReservation {
  const {
    indeterminateAt: _indeterminateAt,
    indeterminateCause: _indeterminateCause,
    lossEpisodeId: _lossEpisodeId,
    ...rest
  } = record;
  return rest as RunReservation;
}

/** Add the persisted episode member to run.lost/run.recovering payloads. */
export function lossEpisodePayload(record: RunReservation, payload: JsonObject): JsonObject {
  const lossEpisodeId = record.lossEpisodeId ?? record.indeterminateAt;
  if (!lossEpisodeId) throw executionError("AUTHORITY_UNAVAILABLE", `run ${record.runId} has no durable loss episode id`);
  return { ...payload, lossEpisodeId };
}

export type EffectIndexEntry = {
  effectKey: string;
  requestDigest: string;
  runId: string;
  /** Owning method; absent on H1 records, which are implicitly run.start. */
  method?: string;
  /**
   * Two-phase admission marker. "pending" is written under the admission lock
   * BEFORE the durable record, "committed" after it. Only a SAME-FACT retry
   * may repair a pending entry; a committed entry without its record is a
   * lost record and fails closed. Entries written before this field existed
   * are treated as committed.
   */
  phase?: "pending" | "committed";
};

/** Deterministic bee name for a Run: retries re-derive the same binding. */
export function beeNameForRun(runId: string): string {
  return `xr-${sha256hex(runId).slice(0, 12)}`;
}

/** Deterministic receipt id: a replayed crash-window admission mints identical bytes. */
export function receiptIdFor(effectKey: string, requestDigest: string): string {
  return `rcpt-${sha256hex(`${effectKey}\n${requestDigest}`).slice(0, 16)}`;
}

/** Stable per-effect key for filenames/ids derived from an effect key. */
export function effectKeyHash(effectKey: string): string {
  return sha256hex(effectKey).slice(0, 32);
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
  if (
    parsed.version !== 1 ||
    typeof parsed.effectKey !== "string" ||
    typeof parsed.requestDigest !== "string" ||
    typeof parsed.phase !== "string" ||
    typeof parsed.capabilityLeaseId !== "string"
  ) {
    throw executionError("AUTHORITY_UNAVAILABLE", `run reservation for ${runId} has an unknown version or missing fields`);
  }
  if (parsed.runId !== runId) {
    throw executionError("AUTHORITY_UNAVAILABLE", `run reservation directory for ${runId} names a different run (${String(parsed.runId)})`);
  }
  if (parsed.initiator !== undefined && !isValidInitiator(parsed.initiator)) {
    // A malformed initiator would silently corrupt parent authorship on
    // relaunch (a fake or empty parent edge). Fail closed like every other
    // corrupt reservation fact — never cast it through.
    throw executionError("AUTHORITY_UNAVAILABLE", `run reservation for ${runId} carries a malformed initiator fact`);
  }
  if (parsed.launchAttempt !== undefined && !isValidLaunchAttempt(parsed.launchAttempt)) {
    throw executionError("AUTHORITY_UNAVAILABLE", `run reservation for ${runId} carries a malformed launch owner`);
  }
  return parsed as unknown as RunReservation;
}

/** ActorContext initiator kinds admitted by the corpus (actor-context.schema.json). */
const INITIATOR_KINDS = new Set(["user", "agent", "pollinate-activation", "parent-comb"]);

function isValidInitiator(value: unknown): value is { kind: string; id: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { kind, id } = value as Record<string, unknown>;
  return typeof kind === "string" && INITIATOR_KINDS.has(kind) && typeof id === "string" && id.length > 0;
}

function isValidLaunchAttempt(value: unknown): value is RunLaunchAttempt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  if (typeof attempt.attemptId !== "string" || attempt.attemptId.length === 0) return false;
  if (typeof attempt.claimedAt !== "string" || !Number.isFinite(Date.parse(attempt.claimedAt))) return false;
  if (attempt.stage !== undefined && attempt.stage !== "preparing" && attempt.stage !== "launching") return false;
  if (attempt.takeoverOf !== undefined && (typeof attempt.takeoverOf !== "string" || attempt.takeoverOf.length === 0)) return false;
  if (attempt.owner === null || typeof attempt.owner !== "object" || Array.isArray(attempt.owner)) return false;
  const owner = attempt.owner as Record<string, unknown>;
  if (typeof owner.ownerId !== "string" || owner.ownerId.length === 0) return false;
  if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) return false;
  if (owner.machineId !== undefined && (typeof owner.machineId !== "string" || owner.machineId.length === 0)) return false;
  if (typeof owner.hostname !== "string" || owner.hostname.length === 0) return false;
  if (owner.processFingerprint === null || typeof owner.processFingerprint !== "object" || Array.isArray(owner.processFingerprint)) return false;
  const fingerprint = owner.processFingerprint as Record<string, unknown>;
  return Number.isSafeInteger(fingerprint.pgid) && Number(fingerprint.pgid) > 0 &&
    typeof fingerprint.startedAt === "string" && fingerprint.startedAt.length > 0;
}

async function writeReservation(reservation: RunReservation): Promise<void> {
  await mkdir(runDir(reservation.runId), { recursive: true, mode: 0o700 });
  reservation.updatedAt = new Date().toISOString();
  await atomicWriteFile(reservationPath(reservation.runId), `${JSON.stringify(reservation, null, 2)}\n`, { mode: 0o600 });
}

/** Absent (ENOENT) -> null; corrupt fails closed like readReservation. */
export async function readEffectIndex(effectKey: string): Promise<EffectIndexEntry | null> {
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

export async function writeEffectIndex(entry: EffectIndexEntry): Promise<void> {
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
  capabilityLeaseId: string;
  intent: JsonObject;
  initiator?: { kind: string; id: string };
};

export type AdmissionOutcome = {
  reservation: RunReservation;
  /** True when this call created the reservation (vs replayed an existing one). */
  created: boolean;
};

/**
 * Durably reserve (runId, effectKey, requestDigest) BEFORE any launch, with a
 * TWO-PHASE global effect index:
 *
 *   pending index (under lock) -> reservation record -> committed index
 *
 * - identical retry (same effectKey + digest, any transport requestId) replays
 *   the original reservation and receipt;
 * - the same effectKey with a different digest, or the same runId under a
 *   different effect, is IDEMPOTENCY_CONFLICT with no new effect — including
 *   against a PENDING entry, so a crash between the phases can never let the
 *   same effect key be admitted for a different run;
 * - only a same-fact retry may repair a pending entry; a COMMITTED entry
 *   whose record is missing is a lost record and fails closed.
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
    if (indexed && (indexed.method ?? "run.start") !== "run.start") {
      throw executionError(
        "IDEMPOTENCY_CONFLICT",
        `effect key ${input.effectKey} is bound to method ${indexed.method}`,
        { effectKey: input.effectKey },
      );
    }
    const existing = await readReservation(input.runId);
    if (indexed && (indexed.phase ?? "committed") === "committed" && !existing) {
      // A committed index entry without its reservation cannot arise from any
      // legitimate crash order — only from a lost/deleted reservation.
      // Re-admitting would launch a second harness under an effect that may
      // already have run. Fail closed.
      throw executionError(
        "AUTHORITY_UNAVAILABLE",
        `effect ${input.effectKey} is committed in the index but run ${input.runId} has no reservation; refusing to re-admit a possibly launched effect`,
        { effectKey: input.effectKey, runId: input.runId },
      );
    }
    if (existing) {
      if (existing.effectKey !== input.effectKey || existing.requestDigest !== input.requestDigest) {
        throw executionError(
          "IDEMPOTENCY_CONFLICT",
          `run ${input.runId} is already reserved under a different effect`,
          { runId: input.runId, effectKey: existing.effectKey },
        );
      }
      if (!indexed || indexed.phase === "pending") {
        await writeEffectIndex({
          effectKey: input.effectKey,
          requestDigest: input.requestDigest,
          runId: input.runId,
          method: "run.start",
          phase: "committed",
        });
      }
      return { reservation: existing, created: false };
    }
    // Phase 1: pending intent BEFORE the record (same-fact repair only).
    await writeEffectIndex({
      effectKey: input.effectKey,
      requestDigest: input.requestDigest,
      runId: input.runId,
      method: "run.start",
      phase: "pending",
    });
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
      capabilityLeaseId: input.capabilityLeaseId,
      intent: input.intent,
      ...(input.initiator ? { initiator: input.initiator } : {}),
      beeName: beeNameForRun(input.runId),
      phase: "reserved",
      createdAt: now,
      updatedAt: now,
    };
    await writeReservation(reservation);
    // Phase 2: commit the index only after the record durably exists.
    await writeEffectIndex({
      effectKey: input.effectKey,
      requestDigest: input.requestDigest,
      runId: input.runId,
      method: "run.start",
      phase: "committed",
    });
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

export type RunLaunchOwnerStatus = "alive" | "dead" | "unverifiable";

export type RunLaunchClaim = {
  reservation: RunReservation;
  /** True only for the caller that atomically installed this exact attempt. */
  claimed: boolean;
  disposition: "claimed" | "owned" | "busy" | "positive-evidence" | "settled";
  attemptId?: string;
};

/**
 * Atomically claim the launch side effect, or take it over only after BOTH:
 * the previous owner incarnation is proven dead and no positive launch
 * evidence exists while the reservation lock is held. A live/unverifiable
 * owner is never stolen, regardless of claim age.
 */
export async function claimRunLaunchAttempt(
  runId: string,
  owner: RunLaunchOwner,
  options: {
    now?: () => Date;
    inspectOwner: (owner: RunLaunchOwner) => Promise<RunLaunchOwnerStatus>;
    evidence: () => Promise<LaunchEvidence>;
  },
): Promise<RunLaunchClaim> {
  const clock = options.now ?? (() => new Date());
  return withFileLock(admissionLockPath(), async () => {
    const current = await readReservation(runId);
    if (!current) throw executionError("RUN_UNKNOWN", `runId ${runId} names no Run reserved on this node`);
    if (current.result || current.cancel || current.phase === "started" || current.phase === "failed") {
      return { reservation: current, claimed: false, disposition: "settled" };
    }

    if (current.phase === "reserved") {
      const attemptId = randomUUID();
      const claimedAt = clock().toISOString();
      const next: RunReservation = {
        ...current,
        phase: "launching",
        launchAttempt: { attemptId, owner, claimedAt, stage: "preparing" },
        launchAttemptedAt: claimedAt,
      };
      await writeReservation(next);
      return { reservation: next, claimed: true, disposition: "claimed", attemptId };
    }

    const existing = current.launchAttempt;
    // A pre-ownership `launching` record is an unknowable legacy crash window.
    // Age cannot prove spawn absence, so fail closed instead of manufacturing
    // an owner and potentially launching a duplicate.
    if (!existing) return { reservation: current, claimed: false, disposition: "busy" };
    if (existing.owner.ownerId === owner.ownerId) {
      return { reservation: current, claimed: false, disposition: "owned", attemptId: existing.attemptId };
    }
    if (current.indeterminateAt || await options.inspectOwner(existing.owner) !== "dead") {
      return { reservation: current, claimed: false, disposition: "busy" };
    }
    const evidence = await options.evidence();
    if (evidence.sessionExists) {
      return { reservation: current, claimed: false, disposition: "positive-evidence" };
    }

    const attemptId = randomUUID();
    const claimedAt = clock().toISOString();
    const next: RunReservation = {
      ...current,
      launchAttempt: { attemptId, owner, claimedAt, stage: "preparing", takeoverOf: existing.attemptId },
      launchAttemptedAt: claimedAt,
    };
    await writeReservation(next);
    return { reservation: next, claimed: true, disposition: "claimed", attemptId };
  });
}

/**
 * Cross the last durable fence immediately before invoking the launcher.
 * Only a `preparing` attempt can activate; a legacy/missing stage is already
 * ambiguous and must never be resumed by this path.
 */
export async function activateRunLaunchAttempt(
  runId: string,
  attemptId: string,
): Promise<{ reservation: RunReservation; activated: boolean }> {
  let activated = false;
  const reservation = await mutateReservation(runId, (current) => {
    if (
      current.phase !== "launching" ||
      current.result ||
      current.cancel ||
      current.launchAttempt?.attemptId !== attemptId ||
      current.launchAttempt.stage !== "preparing"
    ) return current;
    activated = true;
    return {
      ...current,
      launchAttempt: { ...current.launchAttempt, stage: "launching" },
    };
  });
  return { reservation, activated };
}

/** Commit readiness only if this exact attempt still owns an unsettled Run. */
export async function commitRunLaunchStarted(
  runId: string,
  attemptId: string,
  result: { sessionRef: string; environment: RunEnvironmentFacts },
  options: { now?: () => Date } = {},
): Promise<{ reservation: RunReservation; committed: boolean }> {
  const clock = options.now ?? (() => new Date());
  let committed = false;
  const reservation = await mutateReservation(runId, (current) => {
    if (
      current.phase !== "launching" ||
      current.result ||
      current.cancel ||
      current.launchAttempt?.attemptId !== attemptId ||
      current.launchAttempt.stage === "preparing"
    ) return current;
    committed = true;
    return {
      ...current,
      phase: "started",
      startedAt: clock().toISOString(),
      sessionRef: result.sessionRef,
      environment: result.environment,
    };
  });
  return { reservation, committed };
}

/** Fresh-record predicate shared by conditional failure/cancellation commits. */
export function launchAttemptOwns(record: RunReservation, attemptId: string): boolean {
  return record.phase === "launching" && record.launchAttempt?.attemptId === attemptId;
}

export type RunTerminalDecision = {
  outcome: RunTerminalOutcome;
  cause?: string;
  harnessExitCode?: number;
  /** Launch/admission failures also advance the internal launch phase. */
  failureCause?: string;
};

/**
 * Decide a Run's one durable terminal result while holding the reservation
 * lock. The freshest record wins: an already-committed result is immutable,
 * and cancellation intent present before this mutation converts any stale
 * completion/failure candidate into `cancelled`.
 */
export async function commitRunTerminalResult(
  runId: string,
  decision: RunTerminalDecision,
  options: {
    now?: () => Date;
    clearIndeterminate?: boolean;
    /** Additional fresh-record fence for path-specific terminal decisions. */
    canCommit?: (reservation: RunReservation) => boolean;
  } = {},
): Promise<RunReservation> {
  const clock = options.now ?? (() => new Date());
  return mutateReservation(runId, (current) => {
    if (current.result) return options.clearIndeterminate ? clearLossEpisode(current) : current;
    if (options.canCommit && !options.canCommit(current)) return current;
    const base = options.clearIndeterminate ? clearLossEpisode(current) : current;

    const outcome: RunTerminalOutcome = current.cancel ? "cancelled" : decision.outcome;
    const cause =
      outcome === "cancelled"
        ? current.cancel?.reason ?? (decision.outcome === "cancelled" ? decision.cause : undefined) ?? "cancel_requested"
        : decision.cause;
    const finishedAt = clock().toISOString();
    const result: RunTerminalResult = {
      outcome,
      ...(cause ? { cause } : {}),
      ...(decision.harnessExitCode !== undefined ? { harnessExitCode: decision.harnessExitCode } : {}),
      finishedAt,
    };
    return {
      ...base,
      ...(outcome === "failed" && decision.failureCause
        ? { phase: "failed" as const, failedAt: finishedAt, failureCause: decision.failureCause }
        : {}),
      result,
    };
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

/**
 * Idempotency key for one member of a repeated event family. Type-only dedup
 * is wrong for families that legitimately repeat (command.*, needs_input.*,
 * collection.completed): each member is keyed by its identifying payload
 * field, so replaying one command's lifecycle never suppresses another's.
 */
export function eventFamilyKey(type: string, payload: JsonValue): string {
  const doc = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as JsonObject) : {};
  const member = doc.effectKey ?? doc.collectionId ?? doc.inputRequestId ?? doc.lossEpisodeId ?? "";
  return `${type}#${typeof member === "string" ? member : JSON.stringify(member)}`;
}

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

export const RUN_TERMINAL_EVENT_TYPES = ["run.completed", "run.failed", "run.cancelled"] as const;
export type RunTerminalEventType = (typeof RUN_TERMINAL_EVENT_TYPES)[number];
const RUN_TERMINAL_EVENT_TYPE_SET = new Set<string>(RUN_TERMINAL_EVENT_TYPES);

function terminalEventType(outcome: RunTerminalOutcome): RunTerminalEventType {
  return `run.${outcome}` as RunTerminalEventType;
}

function terminalEventPayload(result: RunTerminalResult): JsonObject {
  return {
    ...(result.cause ? { cause: result.cause } : {}),
    ...(result.harnessExitCode !== undefined ? { harnessExitCode: result.harnessExitCode } : {}),
  };
}

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
 * Repair the admission/event crash window without leaving an illegal prefix.
 *
 * Older coordinators could write materializing/starting/terminal events before
 * a retry finally appended run.accepted. Apiary cannot project that log at all,
 * so appending yet another accepted event at the tail is not a repair. Under
 * the same per-run event lock used by append, migrate a validated log to one
 * canonical accepted prefix and preserve every other event (including its
 * eventId) in order. Existing seq cursors necessarily name the pre-migration
 * generation; the accepted receipt carries the old head so run.events can
 * issue the protocol's explicit CURSOR_EXPIRED/reset handoff. A torn tail is
 * discarded exactly like appendRunEvents does before the rewrite.
 */
const ACCEPTED_CURSOR_RESET_FIELD = "cursorResetThroughSeq";
const HISTORY_REBASE_EVENT_TYPE = "surface.intent.proposed";
const HISTORY_REBASE_INTENT = "execution-history-rebased";

function acceptedSemanticPayload(payload: JsonValue): JsonValue {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const { [ACCEPTED_CURSOR_RESET_FIELD]: _reset, ...semantic } = payload as JsonObject;
  return semantic;
}

/** Old cursor head invalidated by an accepted-prefix migration, if any. */
export function acceptedCursorResetThroughSeq(events: StoredRunEvent[]): number | null {
  const accepted = events[0];
  if (!accepted || accepted.type !== "run.accepted" || accepted.payload === null ||
      typeof accepted.payload !== "object" || Array.isArray(accepted.payload)) return null;
  const value = (accepted.payload as JsonObject)[ACCEPTED_CURSOR_RESET_FIELD];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Finish one rewritten numeric-cursor generation without inventing a Run
 * state transition. `surface.intent.proposed` is already optional protocol
 * vocabulary and projection-neutral in Apiary; here it truthfully notifies a
 * consumer that the execution history was rebased. The markers are durable,
 * deterministic, and have no execution side effect.
 *
 * A v1 cursor has no generation token, so the repaired physical head itself
 * must be strictly greater than every cursor invalidated by the rewrite. One
 * marker normally suffices; a terminal-family repair can remove several stale
 * members, so append the minimum number required to restore that invariant.
 */
function finishRewrittenEventGeneration(
  runId: string,
  protocolVersion: string,
  candidate: StoredRunEvent[],
  resetThroughSeq: number,
  markerOrigin: RunEventInput["origin"],
  ingestedAt: string,
): { events: StoredRunEvent[]; markers: StoredRunEvent[] } {
  const accepted = candidate[0];
  if (
    !accepted ||
    accepted.type !== "run.accepted" ||
    accepted.payload === null ||
    typeof accepted.payload !== "object" ||
    Array.isArray(accepted.payload)
  ) {
    throw executionError(
      "AUTHORITY_UNAVAILABLE",
      `run ${runId} cannot reset a rewritten event generation without its canonical accepted prefix`,
    );
  }
  if (!Number.isSafeInteger(resetThroughSeq) || resetThroughSeq < 1) {
    throw executionError("AUTHORITY_UNAVAILABLE", `run ${runId} carries an invalid event-generation reset watermark`);
  }

  const rewritten: StoredRunEvent[] = [
    {
      ...accepted,
      payload: {
        ...(accepted.payload as JsonObject),
        [ACCEPTED_CURSOR_RESET_FIELD]: resetThroughSeq,
      },
    },
    ...candidate.slice(1),
  ];
  const markerCount = Math.max(0, resetThroughSeq + 1 - rewritten.length);
  const occupiedIds = new Set(rewritten.map((event) => event.eventId));
  const markers: StoredRunEvent[] = [];
  for (let ordinal = 1; ordinal <= markerCount; ordinal += 1) {
    const eventId = `evt-${runKey(runId)}-history-rebased-${resetThroughSeq}-${ordinal}`;
    if (occupiedIds.has(eventId)) {
      throw executionError("AUTHORITY_UNAVAILABLE", `run ${runId} event-history repair marker identity collides with durable history`);
    }
    occupiedIds.add(eventId);
    markers.push({
      protocolVersion,
      runId,
      seq: 0,
      eventId,
      type: HISTORY_REBASE_EVENT_TYPE,
      occurredAt: ingestedAt,
      ingestedAt,
      origin: markerOrigin,
      payload: {
        intent: HISTORY_REBASE_INTENT,
        key: `${HISTORY_REBASE_INTENT}:${resetThroughSeq}:${ordinal}`,
        [ACCEPTED_CURSOR_RESET_FIELD]: resetThroughSeq,
        ordinal,
        count: markerCount,
      },
    });
  }
  const events = [...rewritten, ...markers].map((event, index) => ({ ...event, seq: index + 1 }));
  if (events.at(-1)!.seq <= resetThroughSeq) {
    throw executionError(
      "AUTHORITY_UNAVAILABLE",
      `run ${runId} rewritten event generation did not advance beyond cursor ${resetThroughSeq}`,
    );
  }
  return { events, markers };
}

export async function ensureRunAcceptedFirst(
  runId: string,
  protocolVersion: string,
  input: RunEventInput,
): Promise<StoredRunEvent[]> {
  if (input.type !== "run.accepted") {
    throw executionError("AUTHORITY_UNAVAILABLE", "ensureRunAcceptedFirst requires a run.accepted input");
  }
  await mkdir(runDir(runId), { recursive: true, mode: 0o700 });
  return withFileLock(eventsLockPath(runId), async () => {
    const log = await readEventLog(runId);
    const accepted = log.events.filter((event) => event.type === "run.accepted");
    const canonicalPayload = JSON.stringify(input.payload);
    if (accepted.some((event) => JSON.stringify(acceptedSemanticPayload(event.payload)) !== canonicalPayload)) {
      throw executionError("AUTHORITY_UNAVAILABLE", `run ${runId} carries a conflicting run.accepted receipt`);
    }
    const alreadyCanonical = accepted.length === 1 && log.events[0]?.type === "run.accepted";
    if (alreadyCanonical) {
      const resetThroughSeq = acceptedCursorResetThroughSeq(log.events);
      if (resetThroughSeq !== null && (log.events.at(-1)?.seq ?? 0) <= resetThroughSeq) {
        // Self-heal generations written by the first reset implementation:
        // moving a late accepted receipt to seq 1 did not grow the log, so a
        // reset replay returned the same numeric cursor it then expired.
        const repaired = finishRewrittenEventGeneration(
          runId,
          protocolVersion,
          log.events,
          resetThroughSeq,
          input.origin,
          new Date().toISOString(),
        );
        await atomicWriteFile(
          eventsPath(runId),
          repaired.events.map((event) => `${JSON.stringify(event)}\n`).join(""),
          { mode: 0o600 },
        );
        // Match the established contract for an actual rewrite: callers get
        // the complete repaired generation, while a no-op canonical replay
        // still returns []. The service intentionally ignores this detail.
        return repaired.events;
      }
      if (log.tornTail) {
        // Preserve the byte-stable accepted receipt and every complete event;
        // only discard the torn suffix. Re-minting seq-1 here would change its
        // ingestedAt on an otherwise valid replay prefix.
        await atomicWriteFile(eventsPath(runId), log.events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
      }
      return [];
    }

    const ingestedAt = new Date().toISOString();
    const oldHead = log.events.length > 0 ? log.events[log.events.length - 1]!.seq : 0;
    const previousAccepted = accepted[0];
    const previousReset = previousAccepted ? acceptedCursorResetThroughSeq([previousAccepted]) : null;
    const resetThroughSeq = Math.max(oldHead, previousReset ?? 0);
    const resetPayload = resetThroughSeq > 0 && input.payload !== null && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? { ...(input.payload as JsonObject), [ACCEPTED_CURSOR_RESET_FIELD]: resetThroughSeq }
      : input.payload;
    const prefix: StoredRunEvent = {
      protocolVersion,
      runId,
      seq: 1,
      eventId: previousAccepted?.eventId ?? (oldHead > 0 ? `evt-${runKey(runId)}-accepted-prefix` : `evt-${runKey(runId)}-1`),
      occurredAt: previousAccepted?.occurredAt ?? input.occurredAt ?? ingestedAt,
      ingestedAt: previousAccepted?.ingestedAt ?? ingestedAt,
      origin: input.origin,
      payload: resetPayload,
      type: "run.accepted",
    };
    const candidate = [prefix, ...log.events.filter((event) => event.type !== "run.accepted")].map((event, index) => ({
      ...event,
      seq: index + 1,
    }));
    const migrated = resetThroughSeq > 0
      ? finishRewrittenEventGeneration(runId, protocolVersion, candidate, resetThroughSeq, input.origin, ingestedAt).events
      : candidate;
    await atomicWriteFile(eventsPath(runId), migrated.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
    return migrated;
  });
}

/**
 * Append control events with the next monotonic seq, under the per-run lock.
 * `onlyIfAbsentTypes` makes state-changing appends idempotent across restart
 * reconciliation: an event type listed there is skipped when it already
 * exists (singleton lifecycle families only). `onlyIfAbsentKeys` is the
 * per-member form for REPEATED families: an input is skipped only when an
 * event with the same eventFamilyKey (type + identifying payload member)
 * already exists — never type-only. A torn trailing record from a crashed
 * append is truncated (still under the lock) before new bytes go in, so
 * partial bytes can never be concatenated into a hybrid record. The Run
 * terminal family (completed/failed/cancelled) is always mutually exclusive:
 * a same-type retry is a no-op and a different-type contender fails closed.
 */
export async function appendRunEvents(
  runId: string,
  protocolVersion: string,
  inputs: RunEventInput[],
  options: {
    onlyIfAbsentTypes?: boolean;
    onlyIfAbsentKeys?: boolean;
    /** Under the same event lock, omit selected inputs once markerType exists. */
    skipTypesWhenMarkerPresent?: { markerType: string; types: string[] };
    /** Internal guard used by appendRunTerminalEvents. */
    terminalFamilyType?: RunTerminalEventType;
  } = {},
): Promise<StoredRunEvent[]> {
  await mkdir(runDir(runId), { recursive: true, mode: 0o700 });
  return withFileLock(eventsLockPath(runId), async () => {
    const log = await readEventLog(runId);
    if (log.tornTail) {
      const valid = log.events.map((event) => `${JSON.stringify(event)}\n`).join("");
      await atomicWriteFile(eventsPath(runId), valid, { mode: 0o600 });
    }
    const terminalInputs = inputs.filter((input) => RUN_TERMINAL_EVENT_TYPE_SET.has(input.type));
    if (terminalInputs.length > 0 && !options.terminalFamilyType) {
      throw executionError(
        "AUTHORITY_UNAVAILABLE",
        `run ${runId} terminal events must be derived from its committed reservation result`,
      );
    }
    if (terminalInputs.length > 0 || options.terminalFamilyType) {
      const requestedTerminalType = options.terminalFamilyType ?? (terminalInputs[0]?.type as RunTerminalEventType | undefined);
      if (terminalInputs.length !== 1 || !requestedTerminalType || terminalInputs[0]!.type !== requestedTerminalType) {
        throw executionError(
          "AUTHORITY_UNAVAILABLE",
          `run ${runId} terminal append must contain exactly one matching terminal-family member`,
        );
      }
      const existingTerminal = log.events.filter((event) => RUN_TERMINAL_EVENT_TYPE_SET.has(event.type));
      if (existingTerminal.length > 0) {
        if (existingTerminal.length === 1 && existingTerminal[0]!.type === requestedTerminalType) {
          // Idempotent replay. Skip the whole batch: any precursor (notably
          // harness.exited) must never be appended after the terminal event.
          return [];
        }
        throw executionError(
          "AUTHORITY_UNAVAILABLE",
          `run ${runId} event log terminal family conflicts with requested result ${requestedTerminalType}`,
        );
      }
    }
    const present = new Set(log.events.map((event) => event.type));
    const presentKeys = new Set(log.events.map((event) => eventFamilyKey(event.type, event.payload)));
    let seq = log.events.length > 0 ? log.events[log.events.length - 1]!.seq : 0;
    const appended: StoredRunEvent[] = [];
    let lines = "";
    for (const input of inputs) {
      if (
        options.skipTypesWhenMarkerPresent &&
        present.has(options.skipTypesWhenMarkerPresent.markerType) &&
        options.skipTypesWhenMarkerPresent.types.includes(input.type)
      ) continue;
      if (options.onlyIfAbsentTypes && present.has(input.type)) continue;
      if (options.onlyIfAbsentKeys && presentKeys.has(eventFamilyKey(input.type, input.payload))) continue;
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
      presentKeys.add(eventFamilyKey(event.type, event.payload));
      appended.push(event);
      lines += `${JSON.stringify(event)}\n`;
    }
    if (lines.length > 0) await appendFile(eventsPath(runId), lines, { mode: 0o600 });
    return appended;
  });
}

/**
 * Append (or repair after a reservation-write crash gap) the one terminal
 * Run event derived from a durable reservation result. Admission + event
 * serialization treats completed/failed/cancelled as one mutually-exclusive
 * family, so concurrent reconciliation cannot append two terminal types and
 * pre-serialization conflicts can be rewritten to the durable winner.
 *
 * `precursors` are appended in the same locked batch before the terminal
 * member. If the terminal member already exists, the entire batch is a no-op
 * to preserve legal ordering.
 */
export async function appendRunTerminalEvents(
  reservation: RunReservation,
  protocolVersion: string,
  eventOrigin: RunEventInput["origin"],
  precursors: RunEventInput[] = [],
): Promise<StoredRunEvent[]> {
  // Hold admission serialization THROUGH event serialization. A caller may
  // carry a stale projection and a pre-upgrade log may already contain the
  // losing side of an old terminal race; neither may race a fresh terminal
  // decision or a second repair while we publish the durable winner.
  return withFileLock(admissionLockPath(), async () => {
    const current = await readReservation(reservation.runId);
    if (!current) throw executionError("RUN_UNKNOWN", `runId ${reservation.runId} names no Run reserved on this node`);
    const result = current.result;
    if (!result) return [];

    await mkdir(runDir(current.runId), { recursive: true, mode: 0o700 });
    return withFileLock(eventsLockPath(current.runId), async () => {
      const log = await readEventLog(current.runId);
      const validLines = log.events.map((event) => `${JSON.stringify(event)}\n`).join("");
      if (log.tornTail) await atomicWriteFile(eventsPath(current.runId), validLines, { mode: 0o600 });

      if (precursors.some((input) => RUN_TERMINAL_EVENT_TYPE_SET.has(input.type))) {
        throw executionError(
          "AUTHORITY_UNAVAILABLE",
          `run ${current.runId} terminal precursors cannot contain another terminal-family member`,
        );
      }

      const type = terminalEventType(result.outcome);
      const payload = terminalEventPayload(result);
      const existingTerminal = log.events.filter((event) => RUN_TERMINAL_EVENT_TYPE_SET.has(event.type));
      const canonicalTerminal = existingTerminal.find((event) => event.type === type);

      if (existingTerminal.length === 1 && canonicalTerminal) {
        // Idempotent replay. Skip the whole batch: ordinary exit precursors
        // belong before the terminal. Post-terminal loss recovery publishes
        // its episode-keyed exit explicitly instead.
        return [];
      }

      if (existingTerminal.length > 0) {
        // A pre-serialization coordinator could persist the wrong terminal or
        // a canonical winner followed by a stale extra. Replace the whole
        // family with the reservation's durable winner, but retain every
        // non-terminal event in order (notably legal retain/release events).
        // Re-sequencing invalidates numeric v1 cursors, so advance the existing
        // accepted-prefix generation reset through the old head.
        const oldHead = log.events.at(-1)?.seq ?? 0;
        const terminalIndex = canonicalTerminal
          ? log.events.indexOf(canonicalTerminal)
          : log.events.findIndex((event) => RUN_TERMINAL_EVENT_TYPE_SET.has(event.type));
        const nonTerminal = log.events.filter((event) => !RUN_TERMINAL_EVENT_TYPE_SET.has(event.type));
        const insertionIndex = log.events
          .slice(0, terminalIndex)
          .filter((event) => !RUN_TERMINAL_EVENT_TYPE_SET.has(event.type)).length;
        const ingestedAt = new Date().toISOString();
        const presentTypes = new Set(nonTerminal.map((event) => event.type));
        const insertedPrecursors: StoredRunEvent[] = precursors
          .filter((input) => !presentTypes.has(input.type))
          .map((input) => ({
            protocolVersion,
            runId: current.runId,
            seq: 0,
            eventId: `evt-${runKey(current.runId)}-terminal-repair-${randomUUID()}`,
            type: input.type,
            occurredAt: input.occurredAt ?? ingestedAt,
            ingestedAt,
            origin: input.origin,
            payload: input.payload,
          }));
        const canonical = canonicalTerminal ?? {
          protocolVersion,
          runId: current.runId,
          seq: 0,
          eventId: `evt-${runKey(current.runId)}-terminal-repair-${randomUUID()}`,
          type,
          occurredAt: result.finishedAt,
          ingestedAt,
          origin: eventOrigin,
          payload,
        };
        const migrated = [
          ...nonTerminal.slice(0, insertionIndex),
          ...insertedPrecursors,
          canonical,
          ...nonTerminal.slice(insertionIndex),
        ];
        const previousReset = acceptedCursorResetThroughSeq(migrated);
        const resetThroughSeq = Math.max(oldHead, previousReset ?? 0);
        const repaired = finishRewrittenEventGeneration(
          current.runId,
          protocolVersion,
          migrated,
          resetThroughSeq,
          eventOrigin,
          ingestedAt,
        );
        await atomicWriteFile(
          eventsPath(current.runId),
          repaired.events.map((event) => `${JSON.stringify(event)}\n`).join(""),
          { mode: 0o600 },
        );
        const repairedIds = new Set([...insertedPrecursors, canonical, ...repaired.markers].map((event) => event.eventId));
        return repaired.events.filter((event) => repairedIds.has(event.eventId));
      }

      const present = new Set(log.events.map((event) => event.type));
      let seq = log.events.at(-1)?.seq ?? 0;
      const appended: StoredRunEvent[] = [];
      let lines = "";
      for (const input of [...precursors, { type, payload, origin: eventOrigin }]) {
        if (present.has(input.type)) continue;
        const ingestedAt = new Date().toISOString();
        const event: StoredRunEvent = {
          protocolVersion,
          runId: current.runId,
          seq: ++seq,
          eventId: `evt-${runKey(current.runId)}-${seq}`,
          type: input.type,
          occurredAt: input.occurredAt ?? ingestedAt,
          ingestedAt,
          origin: input.origin,
          payload: input.payload,
        };
        present.add(event.type);
        appended.push(event);
        lines += `${JSON.stringify(event)}\n`;
      }
      if (lines.length > 0) await appendFile(eventsPath(current.runId), lines, { mode: 0o600 });
      return appended;
    });
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
  | "booting-receipt-lost"
  | "indeterminate";

/** @deprecated Elapsed time no longer authorizes a launch takeover. */
export const LAUNCH_EVIDENCE_GRACE_MS = 15_000;

export type LaunchEvidence = {
  /** A session record or HSR meta exists for the reservation's bee name. */
  sessionExists: boolean;
  /** The executionRunId stamped on that session record, when present. */
  stampedRunId?: string;
  /** Canonical SessionRecord.id (CO.* / provider-stable ref), never beeName. */
  sessionRef?: string;
  /** True only when durable HSR meta is running and carries runningAt. */
  ready?: boolean;
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
  // These lost states name receipt facts that can legitimately appear on a
  // later reconciliation pass (positive HSR readiness, SessionRecord.id
  // publication, or a recovered working-copy claim). Keep inspecting evidence
  // so the Run can converge;
  // every other indeterminate launch remains sticky and is never relaunched.
  if (reservation.indeterminateAt) {
    const receiptFactCanAppearLater =
      reservation.indeterminateCause === "readiness_evidence_missing" ||
      reservation.indeterminateCause === "session_ref_missing" ||
      reservation.indeterminateCause === "environment_receipt_missing";
    // Losing the evidence that originally put the Run into a recoverable lost
    // state is never proof that spawn did not happen. Stay sticky rather than
    // falling through to reserved-not-started and launching a duplicate.
    if (!receiptFactCanAppearLater || !evidence.sessionExists) return "indeterminate";
  }
  if (evidence.sessionExists) {
    if (evidence.stampedRunId !== undefined && evidence.stampedRunId !== reservation.runId) return "indeterminate";
    // Identity evidence is not readiness evidence. Only a running HSR meta
    // carrying runningAt can repair the public harness.running receipt.
    if (evidence.ready !== true) return "booting-receipt-lost";
    return "started-receipt-lost";
  }
  // Durable launch ownership is non-expiring. Another service may inspect the
  // owner's exact process birth and CAS a takeover, but elapsed wall time alone
  // never reopens the launch side effect. Legacy launching records have no
  // birth-safe owner and therefore remain indeterminate forever.
  if (reservation.launchAttempt?.stage === "preparing") {
    // The durable side-effect fence has not been crossed. Another local
    // in-flight continuation may still be publishing launch events; without
    // one, cancellation may safely fold this as provably not started.
    return options.inFlight ? "launch-in-flight" : "reserved-not-started";
  }
  return reservation.launchAttempt ? "launch-in-flight" : "indeterminate";
}
