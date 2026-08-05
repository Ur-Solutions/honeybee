// Durable per-run operation ledger for the H3 effect methods (run.command,
// run.cancel, run.collect, run.retain, run.release — RFC §7, §10.6-10.10).
//
// Layout under `<executionRoot()>/`:
//   runs/<runKey(runId)>/ops/<effectKeyHash>.json — one durable record per
//     admitted operation effect: receipt, method-specific state, and result
//   effects/<hash>.json — the SAME global effect index run.start uses, so an
//     effect key can never be reused across methods/runs/digests
//
// Invariants (mirror runStore admission):
//   - the operation record is written BEFORE any side effect (dispatch, stop,
//     collection, cleanup) — fail-before-mutation;
//   - identical retries (same effectKey + requestDigest) replay the recorded
//     receipt; the same key with a different digest, method, or runId is
//     IDEMPOTENCY_CONFLICT with no new effect;
//   - corrupt records fail closed (AUTHORITY_UNAVAILABLE), never re-admit.
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { canonicalDigest } from "../comb/canonical.js";
import type { JsonValue } from "../comb/types.js";
import type { JsonObject } from "./contract.js";
import { executionError } from "./errors.js";
import { ensureExecutionRoot } from "./nodeState.js";
import {
  admissionLockPath,
  effectKeyHash,
  readEffectIndex,
  receiptIdFor,
  runDir,
  writeEffectIndex,
  type EffectReceipt,
} from "./runStore.js";

export type OperationMethod = "run.command" | "run.cancel" | "run.collect" | "run.retain" | "run.release";

/** Corpus command state machine: accepted -> dispatching -> terminal. */
export type CommandState = "accepted" | "dispatching" | "completed" | "failed" | "indeterminate";

export type ReleaseStepId = "harness-stop" | "occupancy-release" | "environment-seal" | "environment-release";

export type ReleaseStep = {
  step: ReleaseStepId;
  status: "pending" | "completed" | "unrecoverable";
  /** Human-readable outcome fact ("no live harness", "clean stop unconfirmed"). */
  detail?: string;
  completedAt?: string;
};

export type OperationRecord = {
  version: 1;
  method: OperationMethod;
  runId: string;
  effectKey: string;
  requestDigest: string;
  receipt: EffectReceipt;
  protocolVersion: string;
  schemaDigest: string;
  /** run.command only. */
  commandKind?: string;
  commandState?: CommandState;
  /** Stable driver-level operation/delivery id derived from the effect key. */
  deliveryId?: string;
  cause?: string;
  /** run.collect only. */
  collectionId?: string;
  collectionState?: "collecting" | "complete" | "failed";
  manifest?: JsonObject;
  /** run.retain only. */
  retainUntil?: string;
  /** run.release only: the durable cleanup step ledger. */
  releaseSteps?: ReleaseStep[];
  /** Replay-stable method result (the response envelope's `result`). */
  result?: JsonObject;
  createdAt: string;
  updatedAt: string;
};

function opsDir(runId: string): string {
  return join(runDir(runId), "ops");
}

function opPath(runId: string, effectKey: string): string {
  return join(opsDir(runId), `${effectKeyHash(effectKey)}.json`);
}

function parseOperation(raw: string, subject: string): OperationRecord {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw executionError("AUTHORITY_UNAVAILABLE", `${subject} is corrupt; refusing to re-admit the effect`);
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.method !== "string" ||
    typeof parsed.effectKey !== "string" ||
    typeof parsed.requestDigest !== "string" ||
    typeof parsed.runId !== "string"
  ) {
    throw executionError("AUTHORITY_UNAVAILABLE", `${subject} has an unknown version or missing fields`);
  }
  return parsed as unknown as OperationRecord;
}

/** Absent (ENOENT) -> null; anything unreadable or malformed fails closed. */
export async function readOperation(runId: string, effectKey: string): Promise<OperationRecord | null> {
  let raw: string;
  try {
    raw = await readFile(opPath(runId, effectKey), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw executionError("AUTHORITY_UNAVAILABLE", `operation record for ${effectKey} is unreadable: ${String(error)}`);
  }
  const record = parseOperation(raw, `operation record for ${effectKey}`);
  if (record.effectKey !== effectKey || record.runId !== runId) {
    throw executionError("AUTHORITY_UNAVAILABLE", `operation record for ${effectKey} names a different effect/run`);
  }
  return record;
}

/** Every durable operation record for a Run (crash-recovery sweeps use this). */
export async function listOperations(runId: string): Promise<OperationRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(opsDir(runId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw executionError("AUTHORITY_UNAVAILABLE", `operation ledger for ${runId} is unreadable: ${String(error)}`);
  }
  const records: OperationRecord[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    let raw: string;
    try {
      raw = await readFile(join(opsDir(runId), entry), "utf8");
    } catch (error) {
      throw executionError("AUTHORITY_UNAVAILABLE", `operation record ${entry} is unreadable: ${String(error)}`);
    }
    records.push(parseOperation(raw, `operation record ${entry}`));
  }
  return records;
}

async function writeOperation(record: OperationRecord): Promise<void> {
  await mkdir(opsDir(record.runId), { recursive: true, mode: 0o700 });
  record.updatedAt = new Date().toISOString();
  await atomicWriteFile(opPath(record.runId, record.effectKey), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export type OperationAdmissionInput = {
  runId: string;
  method: OperationMethod;
  effectKey: string;
  requestDigest: string;
  protocolVersion: string;
  schemaDigest: string;
  /** Method-specific initial fields merged into a NEW record. */
  init?: Partial<OperationRecord>;
  /**
   * Pre-effect guard evaluated under the admission lock ONLY when a new record
   * would be created. Must be read-only (the admission lock is not reentrant);
   * throws a typed error to refuse admission with no durable effect.
   */
  guard?: () => Promise<void>;
};

export type OperationAdmission = { record: OperationRecord; created: boolean };

/**
 * Durably admit (effectKey, requestDigest) for one per-run operation BEFORE
 * any side effect, sharing run.start's admission lock and global effect
 * index. Identical retries replay; key reuse with different digest/method/run
 * conflicts with no new effect. A crash between the record write and the
 * index write is repaired on the next identical retry.
 */
export async function admitOperation(input: OperationAdmissionInput): Promise<OperationAdmission> {
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
      throw executionError("IDEMPOTENCY_CONFLICT", `effect key ${input.effectKey} is bound to run ${indexed.runId}`, {
        effectKey: input.effectKey,
        runId: indexed.runId,
      });
    }
    if (indexed && (indexed.method ?? "run.start") !== input.method) {
      throw executionError(
        "IDEMPOTENCY_CONFLICT",
        `effect key ${input.effectKey} is bound to method ${indexed.method ?? "run.start"}`,
        { effectKey: input.effectKey },
      );
    }
    const existing = await readOperation(input.runId, input.effectKey);
    if (indexed && (indexed.phase ?? "committed") === "committed" && !existing) {
      // A committed index entry without its record cannot arise from any
      // legitimate crash order — only from a lost or deleted record.
      // Recreating it would re-execute an effect that may already have run
      // (e.g. redeliver a command). Fail closed.
      throw executionError(
        "AUTHORITY_UNAVAILABLE",
        `effect ${input.effectKey} is committed in the index but its durable record is missing; refusing to re-admit a possibly executed effect`,
        { effectKey: input.effectKey },
      );
    }
    if (existing) {
      if (existing.requestDigest !== input.requestDigest || existing.method !== input.method) {
        throw executionError(
          "IDEMPOTENCY_CONFLICT",
          `effect key ${input.effectKey} is already admitted with different content`,
          { effectKey: input.effectKey },
        );
      }
      if (!indexed || indexed.phase === "pending") {
        await writeEffectIndex({
          effectKey: input.effectKey,
          requestDigest: input.requestDigest,
          runId: input.runId,
          method: input.method,
          phase: "committed",
        });
      }
      return { record: existing, created: false };
    }
    if (input.guard) await input.guard();
    // Phase 1: pending index intent BEFORE the record. A crash here leaves a
    // pending entry that only a SAME-FACT retry may repair; the effect key can
    // never be admitted for another run/method/digest.
    await writeEffectIndex({
      effectKey: input.effectKey,
      requestDigest: input.requestDigest,
      runId: input.runId,
      method: input.method,
      phase: "pending",
    });
    const now = new Date().toISOString();
    const record: OperationRecord = {
      version: 1,
      method: input.method,
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
      ...input.init,
      createdAt: now,
      updatedAt: now,
    };
    await writeOperation(record);
    // Phase 2: commit only after the record durably exists.
    await writeEffectIndex({
      effectKey: input.effectKey,
      requestDigest: input.requestDigest,
      runId: input.runId,
      method: input.method,
      phase: "committed",
    });
    return { record, created: true };
  });
}

/** Persist an operation mutation under the shared admission lock. */
export async function mutateOperation(
  runId: string,
  effectKey: string,
  mutate: (record: OperationRecord) => OperationRecord | Promise<OperationRecord>,
): Promise<OperationRecord> {
  return withFileLock(admissionLockPath(), async () => {
    const current = await readOperation(runId, effectKey);
    if (!current) throw executionError("AUTHORITY_UNAVAILABLE", `operation ${effectKey} has no durable record`);
    const next = await mutate(current);
    await writeOperation(next);
    return next;
  });
}

/**
 * Record the replay-stable result of an operation. resultVersion bumps only
 * when the result content actually changes (e.g. a desired-state release
 * progressing from partial to terminal), so a byte-identical replay keeps a
 * byte-identical receipt.
 */
export async function setOperationResult(
  runId: string,
  effectKey: string,
  result: JsonObject,
  extra?: Partial<OperationRecord>,
): Promise<OperationRecord> {
  return mutateOperation(runId, effectKey, (record) => {
    const changed = record.result === undefined || canonicalDigest(record.result as JsonValue) !== canonicalDigest(result as JsonValue);
    return {
      ...record,
      ...extra,
      result,
      receipt: {
        ...record.receipt,
        resultVersion: changed && record.result !== undefined ? record.receipt.resultVersion + 1 : record.receipt.resultVersion,
      },
    };
  });
}
