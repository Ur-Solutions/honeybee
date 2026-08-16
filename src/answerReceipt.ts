/** Durable, generation-bound receipts for HSR needs-input answers. */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import type { ProcessBirthFingerprint } from "./hsr/processIdentity.js";
import type { RunnerInputAnswer } from "./hsr/types.js";
import type { SessionRecord } from "./store.js";

const HSR_ANSWER_RECEIPT_VERSION = 1 as const;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export type HsrAnswerSource = {
  createdAt: string;
  runtimeGeneration: number;
  id?: string;
  uuid?: string;
  node?: string;
  remoteLaunchId?: string;
  remoteIncarnation?: string;
};

/**
 * Non-authorizing source identity exposed with a pending-input question.
 * Remote launch/incarnation tokens deliberately never cross this UI/client
 * boundary; the controller adds them only after current-record validation.
 */
export type HsrAnswerExpectedSource = Pick<
  HsrAnswerSource,
  "createdAt" | "runtimeGeneration" | "id" | "uuid" | "node"
>;

/** Stable logical provider effect. The durable receipt never stores answer text. */
export type HsrAnswerOperation = {
  source: HsrAnswerSource;
  requestId: string;
  answerDigest: string;
  /** Exact runner-host birth that exposed this provider request. */
  host: HsrAnswerHostIdentity;
};

export type HsrAnswerHostIdentity = {
  hostPid: number;
  startedAt: string;
  hostFingerprint: ProcessBirthFingerprint;
};

export type HsrAnswerReceipt = {
  version: typeof HSR_ANSWER_RECEIPT_VERSION;
  bee: string;
  operation: HsrAnswerOperation;
  phase: "offered" | "sending" | "dispatching" | "settled" | "ambiguous" | "discarded";
  createdAt: string;
  updatedAt: string;
  host?: HsrAnswerHostIdentity;
  sendingAuthority?: HsrAnswerSendingAuthority;
  reason?: string;
};

export type HsrAnswerSendingAuthority = "controller" | "node";

export type HsrAnswerRpcParams = {
  operation: HsrAnswerOperation;
  answer: RunnerInputAnswer;
};

/** Public aggregate-control answer wire; all authority fields are mandatory. */
export type HsrAnswerControlParams = {
  bee: string;
  requestId: string;
  source: HsrAnswerExpectedSource;
  host: HsrAnswerHostIdentity;
  answer: RunnerInputAnswer;
};

export type HsrAnswerRpcResult =
  | { status: "settled"; replayed: boolean; host?: HsrAnswerHostIdentity }
  | { status: "in-flight" }
  | { status: "ambiguous"; reason: string; host?: HsrAnswerHostIdentity }
  | { status: "discarded" }
  | { status: "conflict"; reason: string };

export type HsrAnswerReconciliationVerdict = "delivered" | "discard";

export type HsrAnswerHostCapabilities = {
  answerReceipt: 1;
};

export class HsrAnswerAmbiguousError extends Error {
  readonly code = "HIVE_HSR_ANSWER_AMBIGUOUS";

  constructor(readonly operation: HsrAnswerOperation, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HsrAnswerAmbiguousError";
  }
}

export class HsrAnswerConflictError extends Error {
  readonly code = "HIVE_HSR_ANSWER_CONFLICT";

  constructor(readonly operation: HsrAnswerOperation, message: string) {
    super(message);
    this.name = "HsrAnswerConflictError";
  }
}

export class HsrAnswerDiscardedError extends Error {
  readonly code = "HIVE_HSR_ANSWER_DISCARDED";

  constructor(readonly operation: HsrAnswerOperation, message: string) {
    super(message);
    this.name = "HsrAnswerDiscardedError";
  }
}

export class HsrAnswerInFlightError extends Error {
  readonly code = "HIVE_HSR_ANSWER_IN_FLIGHT";

  constructor(readonly operation: HsrAnswerOperation, message: string) {
    super(message);
    this.name = "HsrAnswerInFlightError";
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key)) &&
    allowed.filter((key) => value[key] !== undefined).length === Object.keys(value).length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validSource(value: unknown): value is HsrAnswerSource {
  if (!isObject(value) || !exactKeys(value, [
    "createdAt",
    "runtimeGeneration",
    "id",
    "uuid",
    "node",
    "remoteLaunchId",
    "remoteIncarnation",
  ])) return false;
  const hasRemote = value.remoteLaunchId !== undefined || value.remoteIncarnation !== undefined;
  return typeof value.createdAt === "string" && value.createdAt.length > 0 &&
    Number.isSafeInteger(value.runtimeGeneration) && Number(value.runtimeGeneration) >= 0 &&
    (value.id === undefined || (typeof value.id === "string" && value.id.length > 0)) &&
    (value.uuid === undefined || (typeof value.uuid === "string" && value.uuid.length > 0)) &&
    (value.node === undefined || (typeof value.node === "string" && value.node.length > 0)) &&
    (!hasRemote || (
      typeof value.node === "string" && value.node.length > 0 &&
      typeof value.remoteLaunchId === "string" && value.remoteLaunchId.length > 0 &&
      typeof value.remoteIncarnation === "string" && value.remoteIncarnation.length > 0
    ));
}

export function parseHsrAnswerSource(value: unknown): HsrAnswerSource {
  if (!validSource(value)) throw new Error("malformed HSR answer source");
  return value;
}

function validExpectedSource(value: unknown): value is HsrAnswerExpectedSource {
  if (!isObject(value) || !exactKeys(value, ["createdAt", "runtimeGeneration", "id", "uuid", "node"])) return false;
  return typeof value.createdAt === "string" && value.createdAt.length > 0 &&
    Number.isSafeInteger(value.runtimeGeneration) && Number(value.runtimeGeneration) >= 0 &&
    (value.id === undefined || (typeof value.id === "string" && value.id.length > 0)) &&
    (value.uuid === undefined || (typeof value.uuid === "string" && value.uuid.length > 0)) &&
    (value.node === undefined || (typeof value.node === "string" && value.node.length > 0));
}

/** Strict parser for the non-authorizing daemon/UI answer identity. */
export function parseHsrAnswerExpectedSource(value: unknown): HsrAnswerExpectedSource {
  if (!validExpectedSource(value)) throw new Error("malformed HSR answer expected source");
  return value;
}

function validOperation(value: unknown): value is HsrAnswerOperation {
  if (!isObject(value) || !exactKeys(value, ["source", "requestId", "answerDigest", "host"])) return false;
  return validSource(value.source) &&
    typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 1_024 &&
    typeof value.answerDigest === "string" && DIGEST_PATTERN.test(value.answerDigest) && validHost(value.host);
}

function validFingerprint(value: unknown): value is ProcessBirthFingerprint {
  if (!isObject(value) || !exactKeys(value, ["pgid", "startedAt"])) return false;
  return Number.isSafeInteger(value.pgid) && Number(value.pgid) > 0 &&
    typeof value.startedAt === "string" && value.startedAt.length > 0;
}

function validHost(value: unknown): value is HsrAnswerHostIdentity {
  if (!isObject(value) || !exactKeys(value, ["hostPid", "startedAt", "hostFingerprint"])) return false;
  return Number.isSafeInteger(value.hostPid) && Number(value.hostPid) > 0 &&
    typeof value.startedAt === "string" && value.startedAt.length > 0 &&
    validFingerprint(value.hostFingerprint);
}

function validAnswer(value: unknown): value is RunnerInputAnswer {
  return typeof value === "string" ||
    (Array.isArray(value) && value.every((row) =>
      Array.isArray(row) && row.every((item) => typeof item === "string")));
}

/** Parse answer RPC bytes without the legacy String(value) coercion. */
export function parseHsrAnswerRpcParams(value: unknown): HsrAnswerRpcParams {
  if (!isObject(value) || !exactKeys(value, ["operation", "answer"]) ||
      !validOperation(value.operation) || !validAnswer(value.answer)) {
    throw new Error("malformed HSR answer RPC params");
  }
  if (canonicalHsrAnswerDigest(value.answer) !== value.operation.answerDigest) {
    throw new HsrAnswerConflictError(value.operation, "HSR answer payload does not match its operation digest");
  }
  return { operation: value.operation, answer: value.answer };
}

export function parseHsrAnswerRpcResult(value: unknown): HsrAnswerRpcResult {
  if (!isObject(value) || typeof value.status !== "string") throw new Error("malformed HSR answer RPC result");
  if (value.status === "settled") {
    if (!exactKeys(value, ["status", "replayed", "host"]) || typeof value.replayed !== "boolean" ||
        (value.host !== undefined && !validHost(value.host))) throw new Error("malformed HSR answer RPC result");
    return value as HsrAnswerRpcResult;
  }
  if (value.status === "ambiguous") {
    if (!exactKeys(value, ["status", "reason", "host"]) || typeof value.reason !== "string" || !value.reason ||
        (value.host !== undefined && !validHost(value.host))) throw new Error("malformed HSR answer RPC result");
    return value as HsrAnswerRpcResult;
  }
  if (value.status === "conflict") {
    if (!exactKeys(value, ["status", "reason"]) || typeof value.reason !== "string" || !value.reason) {
      throw new Error("malformed HSR answer RPC result");
    }
    return value as HsrAnswerRpcResult;
  }
  if ((value.status === "in-flight" || value.status === "discarded") && exactKeys(value, ["status"])) {
    return value as HsrAnswerRpcResult;
  }
  throw new Error("malformed HSR answer RPC result");
}

/** No-side-effect proof required before a new controller may offer/send. */
export function parseHsrAnswerHostCapabilities(value: unknown): HsrAnswerHostCapabilities {
  if (!isObject(value) || !exactKeys(value, ["answerReceipt"]) || value.answerReceipt !== 1) {
    throw new Error("HSR host does not support durable answer receipts; revive it before answering");
  }
  return { answerReceipt: 1 };
}

export function parseHsrAnswerHostIdentity(value: unknown): HsrAnswerHostIdentity {
  if (!validHost(value)) throw new Error("malformed HSR answer host identity");
  return value;
}

export function sameHsrAnswerHostIdentity(
  left: HsrAnswerHostIdentity | undefined,
  right: HsrAnswerHostIdentity,
): boolean {
  return sameHost(left, right);
}

export function hsrAnswerSource(record: SessionRecord): HsrAnswerSource {
  return {
    createdAt: record.createdAt,
    runtimeGeneration: record.runtimeGeneration ?? 0,
    ...(record.id ? { id: record.id } : {}),
    ...(record.uuid ? { uuid: record.uuid } : {}),
    ...(record.node ? { node: record.node } : {}),
    ...(record.remoteLaunchId ? { remoteLaunchId: record.remoteLaunchId } : {}),
    ...(record.remoteIncarnation ? { remoteIncarnation: record.remoteIncarnation } : {}),
  };
}

export function hsrAnswerExpectedSource(record: SessionRecord): HsrAnswerExpectedSource {
  return {
    createdAt: record.createdAt,
    runtimeGeneration: record.runtimeGeneration ?? 0,
    ...(record.id ? { id: record.id } : {}),
    ...(record.uuid ? { uuid: record.uuid } : {}),
    ...(record.node ? { node: record.node } : {}),
  };
}

export function hsrAnswerExpectedSourceOwnsRecord(
  source: HsrAnswerExpectedSource,
  record: SessionRecord,
): boolean {
  const current = hsrAnswerExpectedSource(record);
  return validExpectedSource(source) && source.createdAt === current.createdAt &&
    source.runtimeGeneration === current.runtimeGeneration && source.id === current.id &&
    source.uuid === current.uuid && source.node === current.node;
}

export function hsrAnswerOperationOwnsRecord(
  operation: HsrAnswerOperation,
  record: SessionRecord,
): boolean {
  return validOperation(operation) && sameSource(operation.source, hsrAnswerSource(record));
}

export function hsrAnswerSourceOwnsRecord(source: HsrAnswerSource, record: SessionRecord): boolean {
  return validSource(source) && sameSource(source, hsrAnswerSource(record));
}

export function assertHsrAnswerOperationOwnsRecord(
  operation: HsrAnswerOperation,
  record: SessionRecord,
): void {
  if (!hsrAnswerOperationOwnsRecord(operation, record)) {
    throw new HsrAnswerConflictError(
      operation,
      `HSR answer request ${operation.requestId} does not own ${record.name}'s runtime generation`,
    );
  }
}

export function canonicalHsrAnswerDigest(answer: RunnerInputAnswer): string {
  if (!validAnswer(answer)) throw new Error("HSR answer must be text or a string matrix");
  return createHash("sha256").update(JSON.stringify(answer)).digest("hex");
}

export function createHsrAnswerOperation(
  record: SessionRecord,
  requestId: string,
  answer: RunnerInputAnswer,
  host: HsrAnswerHostIdentity,
): HsrAnswerOperation {
  const operation = { source: hsrAnswerSource(record), requestId, answerDigest: canonicalHsrAnswerDigest(answer), host };
  if (!validOperation(operation)) throw new Error("invalid HSR answer operation");
  return operation;
}

function beeKey(bee: string): string {
  return createHash("sha256").update(bee).digest("hex");
}

function operationKey(operation: HsrAnswerOperation): string {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}

function receiptDir(bee: string): string {
  return join(storeRoot(), "hsr-answer-receipts", beeKey(bee));
}

function receiptPath(bee: string, operation: HsrAnswerOperation): string {
  return join(receiptDir(bee), `answer-${operationKey(operation)}.json`);
}

function receiptLockPath(bee: string): string {
  return join(storeRoot(), "locks", "hsr-answer-receipts", `${beeKey(bee)}.lock`);
}

function sameSource(left: HsrAnswerSource, right: HsrAnswerSource): boolean {
  return left.createdAt === right.createdAt && left.runtimeGeneration === right.runtimeGeneration &&
    left.id === right.id && left.uuid === right.uuid && left.node === right.node &&
    left.remoteLaunchId === right.remoteLaunchId && left.remoteIncarnation === right.remoteIncarnation;
}

function sameOperation(left: HsrAnswerOperation, right: HsrAnswerOperation): boolean {
  return sameSource(left.source, right.source) && left.requestId === right.requestId &&
    left.answerDigest === right.answerDigest && sameHost(left.host, right.host);
}

function sameHost(left: HsrAnswerHostIdentity | undefined, right: HsrAnswerHostIdentity): boolean {
  return !!left && left.hostPid === right.hostPid && left.startedAt === right.startedAt &&
    left.hostFingerprint.pgid === right.hostFingerprint.pgid &&
    left.hostFingerprint.startedAt === right.hostFingerprint.startedAt;
}

function parseReceipt(raw: string, expectedBee: string, expectedFilename: string): HsrAnswerReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`malformed HSR answer receipt for ${expectedBee}`, { cause: error });
  }
  if (!isObject(value) || !exactKeys(value, ["version", "bee", "operation", "phase", "createdAt", "updatedAt", "host", "sendingAuthority", "reason"]) ||
      value.version !== HSR_ANSWER_RECEIPT_VERSION || value.bee !== expectedBee || !validOperation(value.operation) ||
      !["offered", "sending", "dispatching", "settled", "ambiguous", "discarded"].includes(String(value.phase)) ||
      typeof value.createdAt !== "string" || !value.createdAt || typeof value.updatedAt !== "string" || !value.updatedAt ||
      (value.host !== undefined && !validHost(value.host)) ||
      (value.sendingAuthority !== undefined && value.sendingAuthority !== "controller" && value.sendingAuthority !== "node") ||
      (value.reason !== undefined && (typeof value.reason !== "string" || !value.reason)) ||
      (value.phase === "sending" && value.sendingAuthority !== "controller" && value.sendingAuthority !== "node") ||
      (value.phase !== "sending" && value.sendingAuthority !== undefined) ||
      (value.phase === "dispatching" && !validHost(value.host)) ||
      (value.phase === "ambiguous" && typeof value.reason !== "string") ||
      basename(receiptPath(expectedBee, value.operation)) !== expectedFilename) {
    throw new Error(`malformed HSR answer receipt for ${expectedBee}`);
  }
  return value as HsrAnswerReceipt;
}

async function readReceiptsUnlocked(bee: string): Promise<HsrAnswerReceipt[]> {
  let entries: string[];
  try {
    entries = await readdir(receiptDir(bee));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`could not enumerate HSR answer receipts for ${bee}`, { cause: error });
  }
  const receipts: HsrAnswerReceipt[] = [];
  for (const entry of entries.sort()) {
    if (!/^answer-[a-f0-9]{64}\.json$/.test(entry)) {
      throw new Error(`unexpected HSR answer receipt entry for ${bee}: ${entry}`);
    }
    let raw: string;
    try {
      raw = await readFile(join(receiptDir(bee), entry), "utf8");
    } catch (error) {
      throw new Error(`could not read HSR answer receipt for ${bee}`, { cause: error });
    }
    receipts.push(parseReceipt(raw, bee, entry));
  }
  return receipts;
}

async function writeReceipt(receipt: HsrAnswerReceipt): Promise<void> {
  await mkdir(receiptDir(receipt.bee), { recursive: true, mode: 0o700 });
  await atomicWriteFile(receiptPath(receipt.bee, receipt.operation), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

function exactReceipt(receipts: HsrAnswerReceipt[], operation: HsrAnswerOperation): HsrAnswerReceipt | undefined {
  return receipts.find((receipt) => sameOperation(receipt.operation, operation));
}

/** Strict, lock-free read of one exact durable operation. */
export async function readHsrAnswerReceipt(
  bee: string,
  operation: HsrAnswerOperation,
): Promise<HsrAnswerReceipt | null> {
  if (!validOperation(operation)) throw new Error("invalid HSR answer operation");
  return exactReceipt(await readReceiptsUnlocked(bee), operation) ?? null;
}

export async function readHsrAnswerReceipts(bee: string): Promise<HsrAnswerReceipt[]> {
  return readReceiptsUnlocked(bee);
}

/** Exact, provider-I/O-free receipt selection used by operator reconciliation. */
export function hsrAnswerReconciliationCandidates(params: {
  receipts: HsrAnswerReceipt[];
  requestId: string;
  runtimeGeneration: number;
  answerDigest: string;
  current?: SessionRecord | null;
}): HsrAnswerReceipt[] {
  const tupleMatches = params.receipts.filter((receipt) =>
    receipt.operation.requestId === params.requestId &&
    receipt.operation.source.runtimeGeneration === params.runtimeGeneration &&
    receipt.operation.answerDigest === params.answerDigest);
  const sourceMatches = params.current
    ? tupleMatches.filter((receipt) => hsrAnswerOperationOwnsRecord(receipt.operation, params.current!))
    : tupleMatches;
  const unresolvedMatches = sourceMatches.filter((receipt) =>
    receipt.phase === "sending" || receipt.phase === "dispatching" || receipt.phase === "ambiguous");
  // A provider may reuse request ids after a host refresh without advancing
  // SessionRecord generation. The one unresolved host epoch outranks older
  // terminal epochs; terminal matches are only idempotent fallbacks while the
  // canonical source row still exists.
  return unresolvedMatches.length > 0 ? unresolvedMatches : params.current ? sourceMatches : [];
}

/** Caller-side durable offer. Replaying the exact operation returns the same receipt. */
export async function offerHsrAnswerOperation(
  bee: string,
  operation: HsrAnswerOperation,
): Promise<HsrAnswerReceipt> {
  if (!validOperation(operation)) throw new Error("invalid HSR answer operation");
  return withFileLock(receiptLockPath(bee), async () => {
    const receipts = await readReceiptsUnlocked(bee);
    const exact = exactReceipt(receipts, operation);
    if (exact) return exact;
    const unresolved = receipts.find((receipt) =>
      sameSource(receipt.operation.source, operation.source) &&
      (receipt.phase === "sending" || receipt.phase === "dispatching" || receipt.phase === "ambiguous"));
    if (unresolved) {
      throw new HsrAnswerConflictError(
        operation,
        `HSR answer request ${unresolved.operation.requestId} has unresolved provider ownership at ${unresolved.phase}`,
      );
    }
    const sameRequest = receipts.filter((receipt) =>
      sameSource(receipt.operation.source, operation.source) &&
      sameHost(receipt.operation.host, operation.host) &&
      receipt.operation.requestId === operation.requestId);
    const blocker = sameRequest.find((receipt) =>
      receipt.phase === "sending" || receipt.phase === "dispatching" || receipt.phase === "ambiguous" || receipt.phase === "settled");
    if (blocker) {
      throw new HsrAnswerConflictError(
        operation,
        `HSR answer request ${operation.requestId} is already bound to a different answer digest at ${blocker.phase}`,
      );
    }
    const now = new Date().toISOString();
    // An unclaimed answer may be corrected. Preserve the old digest as a
    // discarded audit receipt before publishing its replacement offer.
    for (const prior of sameRequest.filter((receipt) => receipt.phase === "offered")) {
      await writeReceipt({ ...prior, phase: "discarded", updatedAt: now });
    }
    const receipt: HsrAnswerReceipt = {
      version: HSR_ANSWER_RECEIPT_VERSION,
      bee,
      operation,
      phase: "offered",
      createdAt: now,
      updatedAt: now,
    };
    await writeReceipt(receipt);
    return receipt;
  }, { timeoutMs: 30_000 });
}

/**
 * Publish the caller's last correction-safe point immediately before request
 * bytes may leave for the host authority. A process death after this write is
 * unresolved ownership even if the host has not claimed provider dispatch yet.
 */
export async function markHsrAnswerOperationSending(
  bee: string,
  operation: HsrAnswerOperation,
  authority: HsrAnswerSendingAuthority = "node",
): Promise<HsrAnswerReceipt> {
  if (!validOperation(operation) || (authority !== "controller" && authority !== "node")) {
    throw new Error("invalid HSR answer sending publication");
  }
  return withFileLock(receiptLockPath(bee), async () => {
    const receipt = exactReceipt(await readReceiptsUnlocked(bee), operation);
    if (!receipt) throw new Error(`HSR answer ${operation.requestId} has no durable offer`);
    if (receipt.phase === "sending") {
      if (receipt.sendingAuthority === authority) return receipt;
      if (receipt.sendingAuthority === "controller" && authority === "node") {
        const promoted: HsrAnswerReceipt = {
          ...receipt,
          sendingAuthority: "node",
          updatedAt: new Date().toISOString(),
        };
        await writeReceipt(promoted);
        return promoted;
      }
      // A loopback remote controller shares the node's store. Its exact retry
      // may observe the already-promoted node hop; never downgrade it, but let
      // the same operation reach the node authority for terminal replay.
      if (receipt.sendingAuthority === "node" && authority === "controller") return receipt;
      throw new HsrAnswerConflictError(operation, `HSR answer ${operation.requestId} has incompatible transport ownership`);
    }
    if (receipt.phase !== "offered") return receipt;
    const sending: HsrAnswerReceipt = {
      ...receipt,
      phase: "sending",
      sendingAuthority: authority,
      updatedAt: new Date().toISOString(),
    };
    await writeReceipt(sending);
    return sending;
  }, { timeoutMs: 30_000 });
}

/** Definite no-request/no-provider proof for the same transport authority. */
export async function returnHsrAnswerOperationToOffer(
  bee: string,
  operation: HsrAnswerOperation,
  authority: HsrAnswerSendingAuthority,
): Promise<HsrAnswerReceipt> {
  if (!validOperation(operation) || (authority !== "controller" && authority !== "node")) {
    throw new Error("invalid HSR answer retryable publication");
  }
  return withFileLock(receiptLockPath(bee), async () => {
    const receipt = exactReceipt(await readReceiptsUnlocked(bee), operation);
    if (!receipt) throw new Error(`HSR answer ${operation.requestId} has no durable receipt`);
    if (receipt.phase === "offered") return receipt;
    if (receipt.phase !== "sending" || receipt.sendingAuthority !== authority) return receipt;
    const offered: HsrAnswerReceipt = { ...receipt, phase: "offered", updatedAt: new Date().toISOString() };
    delete offered.sendingAuthority;
    await writeReceipt(offered);
    return offered;
  }, { timeoutMs: 30_000 });
}

function resultForReceipt(receipt: HsrAnswerReceipt): HsrAnswerRpcResult | null {
  if (receipt.phase === "settled") return { status: "settled", replayed: true, ...(receipt.host ? { host: receipt.host } : {}) };
  if (receipt.phase === "ambiguous") return { status: "ambiguous", reason: receipt.reason!, ...(receipt.host ? { host: receipt.host } : {}) };
  if (receipt.phase === "discarded") return { status: "discarded" };
  return null;
}

const activeHostAnswers = new Set<string>();

/**
 * Host-only coordinator. `prepare` performs validation but no provider I/O;
 * its returned dispatch is invoked only after dispatching is durable. The
 * per-Bee receipt lock remains held until write/HTTP proof is persisted.
 */
export async function coordinateHsrAnswerOnHost(params: {
  bee: string;
  operation: HsrAnswerOperation;
  host: HsrAnswerHostIdentity;
  prepare: () => Promise<() => Promise<void>>;
}): Promise<HsrAnswerRpcResult> {
  const { bee, operation, host } = params;
  if (!validOperation(operation) || !validHost(host)) throw new Error("invalid HSR answer host coordination input");
  if (!sameHost(operation.host, host)) {
    return withFileLock(receiptLockPath(bee), async (): Promise<HsrAnswerRpcResult> => {
      const receipt = exactReceipt(await readReceiptsUnlocked(bee), operation);
      if (!receipt) return { status: "conflict", reason: "HSR answer operation was not durably offered" };
      const terminal = resultForReceipt(receipt);
      if (terminal) return terminal;
      if (receipt.phase === "sending" || receipt.phase === "dispatching") {
        const reason = receipt.phase === "sending"
          ? `HSR answer ${operation.requestId} was sent toward a prior host incarnation without a terminal reply`
          : `HSR answer ${operation.requestId} crossed dispatch on a prior host incarnation`;
        const ambiguous: HsrAnswerReceipt = { ...receipt, phase: "ambiguous", reason, updatedAt: new Date().toISOString() };
        delete ambiguous.sendingAuthority;
        await writeReceipt(ambiguous);
        return { status: "ambiguous", reason, ...(receipt.host ? { host: receipt.host } : {}) };
      }
      return { status: "conflict", reason: `HSR answer ${operation.requestId} belongs to a different host incarnation` };
    }, { timeoutMs: 30_000 });
  }
  const activeKey = `${bee}:${operationKey(operation)}`;
  if (activeHostAnswers.has(activeKey)) return { status: "in-flight" };
  activeHostAnswers.add(activeKey);
  try {
    const before = await withFileLock(receiptLockPath(bee), async (): Promise<HsrAnswerRpcResult | "prepare"> => {
      const receipts = await readReceiptsUnlocked(bee);
      const receipt = exactReceipt(receipts, operation);
      if (!receipt) return { status: "conflict", reason: "HSR answer operation was not durably offered" };
      const otherUnresolved = receipts.find((candidate) =>
        sameSource(candidate.operation.source, operation.source) &&
        !sameOperation(candidate.operation, operation) &&
        (candidate.phase === "sending" || candidate.phase === "dispatching" || candidate.phase === "ambiguous"));
      if (otherUnresolved) {
        return {
          status: "conflict",
          reason: `HSR answer request ${otherUnresolved.operation.requestId} has unresolved provider ownership`,
        };
      }
      const terminal = resultForReceipt(receipt);
      if (terminal) return terminal;
      if (receipt.phase === "dispatching") {
        const reason = sameHost(receipt.host, host)
          ? `HSR answer ${operation.requestId} was abandoned after dispatch on this host incarnation`
          : `HSR answer ${operation.requestId} crossed dispatch on a prior host incarnation`;
        const ambiguous: HsrAnswerReceipt = { ...receipt, phase: "ambiguous", reason, updatedAt: new Date().toISOString() };
        await writeReceipt(ambiguous);
        return { status: "ambiguous", reason, host: receipt.host };
      }
      if (receipt.phase !== "sending" || receipt.sendingAuthority !== "node") {
        return {
          status: "conflict",
          reason: `HSR answer ${operation.requestId} was not durably published by node transport`,
        };
      }
      return "prepare";
    }, { timeoutMs: 30_000 });
    if (before !== "prepare") return before;

    // Missing pending input, malformed provider data, or an already-unwritable
    // transport fails here and leaves the durable receipt offered/retryable.
    let dispatch: () => Promise<void>;
    try {
      dispatch = await params.prepare();
    } catch (error) {
      await withFileLock(receiptLockPath(bee), async () => {
        const receipt = exactReceipt(await readReceiptsUnlocked(bee), operation);
        if (receipt?.phase !== "sending") return;
        const offered: HsrAnswerReceipt = { ...receipt, phase: "offered", updatedAt: new Date().toISOString() };
        delete offered.sendingAuthority;
        await writeReceipt(offered);
      }, { timeoutMs: 30_000 });
      throw error;
    }

    return await withFileLock(receiptLockPath(bee), async (): Promise<HsrAnswerRpcResult> => {
      const receipts = await readReceiptsUnlocked(bee);
      const receipt = exactReceipt(receipts, operation);
      if (!receipt) return { status: "conflict", reason: "HSR answer operation disappeared before dispatch" };
      const otherUnresolved = receipts.find((candidate) =>
        sameSource(candidate.operation.source, operation.source) &&
        !sameOperation(candidate.operation, operation) &&
        (candidate.phase === "sending" || candidate.phase === "dispatching" || candidate.phase === "ambiguous"));
      if (otherUnresolved) {
        return {
          status: "conflict",
          reason: `HSR answer request ${otherUnresolved.operation.requestId} has unresolved provider ownership`,
        };
      }
      const terminal = resultForReceipt(receipt);
      if (terminal) return terminal;
      if (receipt.phase === "dispatching") {
        const reason = sameHost(receipt.host, host)
          ? `HSR answer ${operation.requestId} was abandoned after dispatch on this host incarnation`
          : `HSR answer ${operation.requestId} crossed dispatch on a prior host incarnation`;
        const ambiguous: HsrAnswerReceipt = { ...receipt, phase: "ambiguous", reason, updatedAt: new Date().toISOString() };
        await writeReceipt(ambiguous);
        return { status: "ambiguous", reason, host: receipt.host };
      }
      if (receipt.phase !== "sending" || receipt.sendingAuthority !== "node") {
        return {
          status: "conflict",
          reason: `HSR answer ${operation.requestId} lost caller transport ownership before dispatch`,
        };
      }
      const dispatching: HsrAnswerReceipt = {
        ...receipt,
        phase: "dispatching",
        host,
        updatedAt: new Date().toISOString(),
      };
      delete dispatching.sendingAuthority;
      await writeReceipt(dispatching);
      try {
        await dispatch();
      } catch (error) {
        const reason = `provider answer handoff is ambiguous: ${error instanceof Error ? error.message : String(error)}`;
        await writeReceipt({ ...dispatching, phase: "ambiguous", reason, updatedAt: new Date().toISOString() });
        return { status: "ambiguous", reason, host };
      }
      const settled: HsrAnswerReceipt = {
        ...dispatching,
        phase: "settled",
        updatedAt: new Date().toISOString(),
      };
      await writeReceipt(settled);
      return { status: "settled", replayed: false, host };
    }, { timeoutMs: 30_000 });
  } finally {
    activeHostAnswers.delete(activeKey);
  }
}

/** Operator/caller proof; this performs no provider I/O. */
export async function reconcileHsrAnswerOperation(
  bee: string,
  operation: HsrAnswerOperation,
  verdict: HsrAnswerReconciliationVerdict,
): Promise<HsrAnswerReceipt> {
  if (!validOperation(operation)) throw new Error("invalid HSR answer operation");
  return withFileLock(receiptLockPath(bee), async () => {
    const receipt = exactReceipt(await readReceiptsUnlocked(bee), operation);
    if (!receipt) throw new Error(`HSR answer ${operation.requestId} has no durable receipt`);
    const phase = verdict === "delivered" ? "settled" as const : "discarded" as const;
    if (receipt.phase === phase) return receipt;
    if (receipt.phase === "settled" || receipt.phase === "discarded") {
      throw new Error(`HSR answer ${operation.requestId} is already ${receipt.phase}`);
    }
    const next: HsrAnswerReceipt = { ...receipt, phase, updatedAt: new Date().toISOString() };
    delete next.reason;
    delete next.sendingAuthority;
    await writeReceipt(next);
    return next;
  }, { timeoutMs: 30_000 });
}

/** Publish caller-side ambiguity learned from a remote authority result. */
export async function markHsrAnswerOperationAmbiguous(
  bee: string,
  operation: HsrAnswerOperation,
  reason: string,
  host?: HsrAnswerHostIdentity,
): Promise<HsrAnswerReceipt> {
  if (!validOperation(operation) || !reason) throw new Error("invalid HSR answer ambiguity publication");
  if (host !== undefined && !validHost(host)) throw new Error("invalid HSR answer ambiguity host");
  return withFileLock(receiptLockPath(bee), async () => {
    const receipt = exactReceipt(await readReceiptsUnlocked(bee), operation);
    if (!receipt) throw new Error(`HSR answer ${operation.requestId} has no durable receipt`);
    if (receipt.phase === "ambiguous") return receipt;
    if (receipt.phase === "settled" || receipt.phase === "discarded") {
      throw new Error(`HSR answer ${operation.requestId} is already ${receipt.phase}`);
    }
    const next: HsrAnswerReceipt = {
      ...receipt,
      phase: "ambiguous",
      reason,
      updatedAt: new Date().toISOString(),
      ...(host ? { host } : {}),
    };
    delete next.sendingAuthority;
    await writeReceipt(next);
    return next;
  }, { timeoutMs: 30_000 });
}

/** Fence lifecycle replacement/revive while provider answer ownership is unresolved. */
export async function assertNoUnresolvedHsrAnswerOwnership(
  record: SessionRecord,
  operation = "runtime lifecycle replacement",
  allowedOperation?: HsrAnswerOperation,
): Promise<void> {
  const source = hsrAnswerSource(record);
  const unresolved = (await readReceiptsUnlocked(record.name)).find((receipt) =>
    sameSource(receipt.operation.source, source) &&
    (receipt.phase === "sending" || receipt.phase === "dispatching" || receipt.phase === "ambiguous") &&
    (!allowedOperation || !sameOperation(receipt.operation, allowedOperation)));
  if (unresolved) {
    throw new HsrAnswerAmbiguousError(
      unresolved.operation,
      `${operation}: ${record.name} has unresolved answer ownership for request ${unresolved.operation.requestId}`,
    );
  }
}

/** Same-name admission fence retained even after the canonical row is purged. */
export async function assertNoUnresolvedHsrAnswerReceiptsForBee(
  bee: string,
  operation = "fresh name admission",
): Promise<void> {
  const unresolved = (await readReceiptsUnlocked(bee)).find((receipt) =>
    receipt.phase === "sending" || receipt.phase === "dispatching" || receipt.phase === "ambiguous");
  if (unresolved) {
    throw new HsrAnswerAmbiguousError(
      unresolved.operation,
      `${operation}: ${bee} retains unresolved answer ownership for request ${unresolved.operation.requestId}`,
    );
  }
}
