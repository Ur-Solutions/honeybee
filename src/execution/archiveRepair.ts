import { readdir } from "node:fs/promises";
import { beeMailboxDir } from "../buz.js";
import { collectLedgerEvents, type LedgerEvent } from "../events.js";
import { withFileLock } from "../lock.js";
import { probeHsrReAdoption } from "../daemon/reAdoption.js";
import { isHsrPoolMutatorLive, readCurrentHsrEventTail } from "../hsr/observe.js";
import {
  hasPendingHsrTurns,
  readStagedPendingHsrTurns,
  type StagedPendingHsrTurns,
} from "../hsr/pendingTurns.js";
import { readProcessBirthFingerprint, sameProcessBirthFingerprint } from "../hsr/processIdentity.js";
import {
  readHsrMetaStrict,
  verifyHsrEventStreamClosure,
  type HsrMeta,
} from "../hsr/runDir.js";
import { stopHsrIncarnation } from "../hsr/substrate.js";
import type { RunnerEvent } from "../hsr/types.js";
import { withSessionLifecycleTransaction } from "../lifecycle.js";
import { readRuntimeRecovery, type RuntimeRecoveryRecord } from "../recovery/store.js";
import type { KillResult } from "../substrates/types.js";
import {
  loadSession,
  markSessionVerified,
  transitionSession,
  type SessionRecord,
  type SessionTransitionResult,
} from "../store.js";
import {
  isProbeEvidence,
  type ArchiveCorrectionEvidence,
  type BeeTransitionReceipt,
  type ProbeEvidence,
} from "../stateMachine.js";
import { listOperations, type OperationRecord } from "./opsStore.js";
import {
  readReservation,
  readRunEvents,
  admissionLockPath,
  type RunReservation,
  type StoredRunEvent,
} from "./runStore.js";

const EXPIRY_TO_ARCHIVE_MAX_MS = 5 * 60_000;
const ARCHIVE_TO_RESULT_MAX_MS = 10_000;
const TERMINAL_EVENT_LAG_MAX_MS = 60_000;
const COMPATIBILITY_OVERWRITE_MAX_MS = 60_000;

export type LeaseArchiveRepairRefusal =
  | "session-missing"
  | "run-missing"
  | "run-binding-mismatch"
  | "already-active"
  | "not-current-legacy-archive"
  | "unsafe-session-fence"
  | "not-historical-lease-expiry"
  | "explicit-lifecycle-operation"
  | "execution-chronology-mismatch"
  | "archive-audit-missing"
  | "correction-overwrite-proof-mismatch"
  | "newer-user-work"
  | "recovery-proof-mismatch"
  | "runtime-proof-mismatch"
  | "runtime-still-live"
  | "runtime-stop-unconfirmed"
  | "event-closure-unconfirmed"
  | "archive-changed"
  | "proof-unavailable";

export type LeaseArchiveRepairResult =
  | { status: "eligible"; beeName: string; runId: string; detail: string }
  | { status: "repaired"; beeName: string; runId: string; detail: string; record: SessionRecord }
  | { status: "already-repaired"; beeName: string; runId: string; detail: string; record: SessionRecord }
  | { status: "refused"; beeName: string; runId: string; reason: LeaseArchiveRepairRefusal; detail: string };

export type LeaseArchiveRepairDependencies = {
  loadSession?: typeof loadSession;
  readReservation?: typeof readReservation;
  readRunEvents?: typeof readRunEvents;
  listOperations?: typeof listOperations;
  readHsrMeta?: typeof readHsrMetaStrict;
  verifyEventClosure?: typeof verifyHsrEventStreamClosure;
  isRuntimeLive?: typeof isHsrPoolMutatorLive;
  readProcessIdentity?: typeof readProcessBirthFingerprint;
  readCurrentEvents?: typeof readCurrentHsrEventTail;
  hasPendingTurns?: typeof hasPendingHsrTurns;
  readStagedTurns?: typeof readStagedPendingHsrTurns;
  hasQueuedMessages?: (beeName: string) => Promise<boolean>;
  readRecovery?: typeof readRuntimeRecovery;
  probeRuntime?: (record: SessionRecord, observerId: string) => Promise<ProbeEvidence>;
  markVerified?: typeof markSessionVerified;
  stopRuntime?: (beeName: string, meta: HsrMeta) => Promise<KillResult>;
  readLedgerEvents?: (beeName: string, sinceMs: number) => Promise<LedgerEvent[]>;
  transition?: typeof transitionSession;
  /** Deterministic race seam after proof inspection, before the store CAS. */
  beforeTransition?: () => void | Promise<void>;
  /** Deterministic race seam after the stop fence, before exact teardown. */
  afterStopFence?: () => void | Promise<void>;
  now?: () => Date;
};

type LeaseArchiveRepairProof = {
  kind: "legacy-archive";
  record: SessionRecord;
  reservation: RunReservation;
  meta: HsrMeta;
  archivedEventId: string;
  archivedAt: string;
  leaseExpiresAt: string;
  closureLastSeq: number;
  closureClosedAt: string;
};

type CompatibilityOverwriteProof = {
  kind: "compatibility-overwrite";
  record: SessionRecord;
  reservation: RunReservation;
  meta: HsrMeta;
  correction: ArchiveCorrectionEvidence;
  correctionEventId: string;
  overwrittenEventId: string;
  recoveryEventId?: string;
  recoveryEpisodeId?: string;
  recoveryAttemptId?: string;
  originalArchiveAt: string;
  recovery: RuntimeRecoveryRecord;
};

type RepairProof = LeaseArchiveRepairProof | CompatibilityOverwriteProof;

type Inspection =
  | { status: "eligible"; proof: RepairProof }
  | { status: "already-repaired"; record: SessionRecord }
  | { status: "refused"; reason: LeaseArchiveRepairRefusal; detail: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function refused(
  beeName: string,
  runId: string,
  reason: LeaseArchiveRepairRefusal,
  detail: string,
): LeaseArchiveRepairResult {
  return { status: "refused", beeName, runId, reason, detail };
}

function isMatchingArchiveAudit(event: LedgerEvent, beeName: string, archivedEventId: string): boolean {
  const receipt = object(event.event);
  return event.type === "state.transition.accepted"
    && event.session === beeName
    && receipt?.eventId === archivedEventId
    && receipt.type === "bee.archived"
    && receipt.cause === "retire";
}

function explicitLifecycleOperation(operations: OperationRecord[]): OperationRecord | undefined {
  return operations.find((operation) => operation.method === "run.cancel" || operation.method === "run.release");
}

function legacyLeaseCancelEvent(events: StoredRunEvent[]): StoredRunEvent | undefined {
  const cancelEvents = events.filter((event) => event.type === "cancel.requested");
  if (cancelEvents.length !== 1) return undefined;
  const payload = object(cancelEvents[0]!.payload);
  if (payload?.reason !== "lease_expired" || payload.effectKey !== undefined) return undefined;
  return cancelEvents[0];
}

function matchingLeaseTerminalEvent(events: StoredRunEvent[]): StoredRunEvent | undefined {
  const terminal = events.filter((event) =>
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled");
  if (terminal.length !== 1 || terminal[0]!.type !== "run.cancelled") return undefined;
  return object(terminal[0]!.payload)?.cause === "lease_expired" ? terminal[0] : undefined;
}

type AcceptedTransition = {
  ledger: LedgerEvent;
  receipt: BeeTransitionReceipt;
  from: { lifecycle: string; runtime: string; work: string };
  to: { lifecycle: string; runtime: string; work: string };
  revision: number;
};

function axes(value: unknown): AcceptedTransition["from"] | undefined {
  const candidate = object(value);
  return typeof candidate?.lifecycle === "string" && typeof candidate.runtime === "string" &&
    typeof candidate.work === "string"
    ? { lifecycle: candidate.lifecycle, runtime: candidate.runtime, work: candidate.work }
    : undefined;
}

function acceptedTransition(event: LedgerEvent, beeName: string): AcceptedTransition | undefined {
  if (event.type !== "state.transition.accepted" || event.session !== beeName) return undefined;
  const receipt = object(event.event);
  const from = axes(event.from);
  const to = axes(event.to);
  if (
    !receipt || typeof receipt.eventId !== "string" || receipt.eventId.length === 0 ||
    typeof receipt.type !== "string" || typeof receipt.cause !== "string" ||
    typeof receipt.at !== "string" || timestamp(receipt.at) === undefined ||
    !Array.isArray(receipt.evidence) || !from || !to ||
    !Number.isSafeInteger(event.revision) || Number(event.revision) < 1
  ) return undefined;
  return {
    ledger: event,
    receipt: receipt as unknown as BeeTransitionReceipt,
    from,
    to,
    revision: Number(event.revision),
  };
}

function archiveCorrectionEvidence(value: unknown): ArchiveCorrectionEvidence | undefined {
  const evidence = object(value);
  const fingerprint = object(evidence?.runnerFingerprint);
  if (
    evidence?.kind !== "repair" || evidence.action !== "lease-expiry-archive-correction" ||
    typeof evidence.repairId !== "string" || evidence.repairId.length === 0 ||
    typeof evidence.runId !== "string" || typeof evidence.sessionRef !== "string" ||
    typeof evidence.providerSessionId !== "string" || timestamp(evidence.leaseExpiresAt) === undefined ||
    typeof evidence.archivedEventId !== "string" ||
    !Number.isSafeInteger(evidence.runtimeGeneration) || Number(evidence.runtimeGeneration) < 0 ||
    !Number.isSafeInteger(evidence.runnerPid) || Number(evidence.runnerPid) <= 0 ||
    !fingerprint || !Number.isSafeInteger(fingerprint.pgid) || Number(fingerprint.pgid) <= 0 ||
    typeof fingerprint.startedAt !== "string" || fingerprint.startedAt.length === 0 ||
    !Number.isSafeInteger(evidence.closureLastSeq) || Number(evidence.closureLastSeq) <= 0 ||
    timestamp(evidence.closureClosedAt) === undefined || timestamp(evidence.observedAt) === undefined
  ) return undefined;
  return evidence as unknown as ArchiveCorrectionEvidence;
}

function exactAxes(
  actual: AcceptedTransition["from"],
  expected: AcceptedTransition["from"],
): boolean {
  return actual.lifecycle === expected.lifecycle && actual.runtime === expected.runtime && actual.work === expected.work;
}

function currentReceiptMatches(record: SessionRecord, receipt: BeeTransitionReceipt): boolean {
  return record.stateMachine?.lastEventId === receipt.eventId &&
    JSON.stringify(record.stateMachine.lastTransition) === JSON.stringify(receipt);
}

function exactProbe(
  value: unknown,
  outcome: "alive" | "dead",
  runnerPid: number,
): ProbeEvidence | undefined {
  if (!isProbeEvidence(value) || value.outcome !== outcome || value.target.substrate !== "hsr" ||
      value.target.runnerPid !== runnerPid) return undefined;
  return value;
}

function exactRecoveryEvidence(
  value: unknown,
  attemptId: string,
  budget: number,
): boolean {
  const evidence = object(value);
  return evidence?.kind === "recovery" && evidence.attemptId === attemptId &&
    evidence.attempt === 1 && evidence.budget === budget && evidence.outcome === "succeeded" &&
    evidence.detail === "replayed 0 pending turns" && timestamp(evidence.observedAt) !== undefined;
}

function exactHostEpochOnly(events: RunnerEvent[], meta: HsrMeta): boolean {
  if (events.length !== 1 || events[0]?.type !== "host_epoch") return false;
  const epoch = events[0];
  return epoch.host.hostPid === meta.hostPid && epoch.host.startedAt === meta.startedAt &&
    sameProcessBirthFingerprint(epoch.host.hostFingerprint, meta.hostFingerprint);
}

function exactStoppedSuccessorTail(events: RunnerEvent[], meta: HsrMeta): boolean {
  if (events.length !== 2 || events[0]?.type !== "host_epoch" || events[1]?.type !== "exit") return false;
  const epoch = events[0];
  const exit = events[1];
  return epoch.host.hostPid === meta.hostPid && epoch.host.startedAt === meta.startedAt &&
    sameProcessBirthFingerprint(epoch.host.hostFingerprint, meta.hostFingerprint) &&
    (exit.code === 0 || exit.code === null);
}

async function defaultHasQueuedMessages(beeName: string): Promise<boolean> {
  const entries = await readdir(beeMailboxDir(beeName, "queue")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  return entries.some((entry) => entry.endsWith(".md"));
}

function exactRecoveryRecord(
  recovery: RuntimeRecoveryRecord | null,
  correction: ArchiveCorrectionEvidence,
  lostProbe: ProbeEvidence,
  attemptId: string,
): recovery is RuntimeRecoveryRecord {
  if (!recovery || recovery.status !== "recovered" || recovery.generation !== correction.runtimeGeneration ||
      recovery.probeId !== lostProbe.probeId || recovery.attempts.length !== 1 ||
      recovery.recoveryFailedRequestId !== undefined) return false;
  const attempt = recovery.attempts[0]!;
  return attempt.attemptId === attemptId && attempt.attempt === 1 && attempt.outcome === "succeeded" &&
    typeof attempt.endedAt === "string" && recovery.nextAttemptAt === undefined;
}

async function isExactStoppedDaemonMarker(
  marker: SessionRecord["stateUnverified"],
  dependencies: LeaseArchiveRepairDependencies,
): Promise<boolean> {
  const since = timestamp(marker?.since);
  const lastSeen = timestamp(marker?.observer?.lastSeenAt);
  if (
    !marker || marker.reason !== "observer-offline" ||
    since === undefined || lastSeen === undefined ||
    marker.since !== marker.probeScheduledAt || !marker.observer ||
    marker.observer.offlineSince !== marker.since ||
    marker.observer.reason !== "signal:SIGTERM" ||
    lastSeen > since
  ) return false;
  const match = /^daemon:(\d+):(.+)$/.exec(marker.observer.observerId);
  if (!match || timestamp(match[2]) === undefined) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    return await (dependencies.readProcessIdentity ?? readProcessBirthFingerprint)(pid) === null;
  } catch {
    return false;
  }
}

async function inspectCompatibilityOverwrite(
  beeName: string,
  runId: string,
  record: SessionRecord,
  reservation: RunReservation,
  dependencies: LeaseArchiveRepairDependencies,
): Promise<Inspection> {
  const cursor = record.stateMachine;
  if (
    record.status !== "running" || !cursor || cursor.lifecycle !== "active" ||
    cursor.runtime !== "live" || cursor.work !== "working" ||
    cursor.lastTransition.type !== "recovery.succeeded" || cursor.lastTransition.cause !== "revive-ok"
  ) {
    return {
      status: "refused",
      reason: "already-active",
      detail: "the active Bee is not the exact zero-replay compatibility recovery successor",
    };
  }
  const compatibleOfflineMarker = record.stateUnverified
    ? await isExactStoppedDaemonMarker(record.stateUnverified, dependencies)
    : false;
  if (
    record.lastError || record.stopIntent || record.deliveryStopDoubt ||
    record.eventIntegrityDoubt || record.runtimeReplacement ||
    (record.stateUnverified && !compatibleOfflineMarker)
  ) {
    return {
      status: "refused",
      reason: "unsafe-session-fence",
      detail: "the compatibility successor carries unresolved lifecycle, delivery, replacement, or event-integrity doubt",
    };
  }
  if (!record.providerSessionId || record.substrate !== "hsr" || !record.runnerPid || !record.runnerFingerprint) {
    return {
      status: "refused",
      reason: "runtime-proof-mismatch",
      detail: "the compatibility successor lacks exact local-HSR/provider birth identity",
    };
  }
  if (
    reservation.phase !== "started" || reservation.cancel?.reason !== "lease_expired" ||
    reservation.result?.outcome !== "cancelled" || reservation.result.cause !== "lease_expired" ||
    reservation.releasedAt !== undefined
  ) {
    return {
      status: "refused",
      reason: "not-historical-lease-expiry",
      detail: "the Run no longer has the exact historical lease-expired terminal shape",
    };
  }

  const leaseAt = timestamp(reservation.leaseExpiresAt);
  if (leaseAt === undefined) {
    return { status: "refused", reason: "not-historical-lease-expiry", detail: "the lease timestamp is invalid" };
  }

  let events: StoredRunEvent[];
  let operations: OperationRecord[];
  let ledger: LedgerEvent[];
  let recovery: RuntimeRecoveryRecord | null;
  let meta: HsrMeta | null;
  let currentEvents: RunnerEvent[];
  let pending: boolean;
  let staged: StagedPendingHsrTurns | null;
  let queued: boolean;
  try {
    [events, operations, ledger, recovery, meta, currentEvents, pending, staged, queued] = await Promise.all([
      (dependencies.readRunEvents ?? readRunEvents)(runId),
      (dependencies.listOperations ?? listOperations)(runId),
      (dependencies.readLedgerEvents ?? (async (name, sinceMs) =>
        collectLedgerEvents({ filter: { sessions: [name], sinceMs } })))(beeName, leaseAt),
      (dependencies.readRecovery ?? readRuntimeRecovery)(beeName),
      (dependencies.readHsrMeta ?? readHsrMetaStrict)(beeName),
      (dependencies.readCurrentEvents ?? readCurrentHsrEventTail)(beeName),
      (dependencies.hasPendingTurns ?? hasPendingHsrTurns)(beeName),
      (dependencies.readStagedTurns ?? readStagedPendingHsrTurns)(beeName),
      (dependencies.hasQueuedMessages ?? defaultHasQueuedMessages)(beeName),
    ]);
  } catch (error) {
    return {
      status: "refused",
      reason: "proof-unavailable",
      detail: `compatibility-overwrite proof could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const explicit = explicitLifecycleOperation(operations);
  if (explicit) {
    return {
      status: "refused",
      reason: "explicit-lifecycle-operation",
      detail: `${explicit.method} effect ${explicit.effectKey} records a later explicit lifecycle decision`,
    };
  }
  const cancelEvent = legacyLeaseCancelEvent(events);
  const terminalEvent = matchingLeaseTerminalEvent(events);
  if (!cancelEvent || !terminalEvent) {
    return {
      status: "refused",
      reason: "execution-chronology-mismatch",
      detail: "the exact historical lease cancel/terminal event pair is no longer unique",
    };
  }

  const transitions = ledger
    .map((event) => acceptedTransition(event, beeName))
    .filter((event): event is AcceptedTransition => event !== undefined);
  const correctionCandidates = transitions.flatMap((transition, index) => {
    if (
      transition.receipt.type !== "bee.archive-corrected" ||
      transition.receipt.cause !== "lease-expiry-offload-repair" ||
      transition.receipt.evidence.length !== 2
    ) return [];
    const correction = archiveCorrectionEvidence(transition.receipt.evidence[0]);
    const probe = correction ? exactProbe(transition.receipt.evidence[1], "dead", correction.runnerPid) : undefined;
    return correction && probe && correction.runId === runId ? [{ transition, correction, index }] : [];
  });
  if (correctionCandidates.length !== 1) {
    return {
      status: "refused",
      reason: "correction-overwrite-proof-mismatch",
      detail: "the ledger does not contain one unique accepted lease-archive correction",
    };
  }
  const acceptedCorrection = correctionCandidates[0]!;
  const correction = acceptedCorrection.correction;
  const correctionAt = timestamp(acceptedCorrection.transition.receipt.at)!;
  if (
    acceptedCorrection.transition.receipt.eventId !== correction.repairId ||
    !exactAxes(acceptedCorrection.transition.from, { lifecycle: "archived", runtime: "parked", work: "done" }) ||
    !exactAxes(acceptedCorrection.transition.to, { lifecycle: "active", runtime: "parked", work: "done" }) ||
    correction.runId !== runId || correction.sessionRef !== record.id ||
    correction.providerSessionId !== record.providerSessionId ||
    correction.leaseExpiresAt !== reservation.leaseExpiresAt ||
    correction.runtimeGeneration + 1 !== (record.runtimeGeneration ?? 0)
  ) {
    return {
      status: "refused",
      reason: "correction-overwrite-proof-mismatch",
      detail: "the accepted correction does not bind this Run, session, provider, or predecessor generation",
    };
  }

  const suffix = transitions.slice(acceptedCorrection.index + 1);
  if (suffix.length !== 2) {
    return {
      status: "refused",
      reason: "correction-overwrite-proof-mismatch",
      detail: "the correction is not followed by exactly one runtime loss and one zero-replay recovery success",
    };
  }
  const [lost, succeeded] = suffix;
  const lostProbe = lost!.receipt.evidence.length === 1
    ? exactProbe(lost!.receipt.evidence[0], "dead", correction.runnerPid)
    : undefined;
  if (
    lost!.receipt.type !== "runtime.lost" || lost!.receipt.cause !== "mid-turn-death" ||
    !lostProbe || lost!.receipt.eventId !== `runtime-lost:${lostProbe.probeId}` || lost!.revision !== 1 ||
    !exactAxes(lost!.from, { lifecycle: "active", runtime: "live", work: "working" }) ||
    !exactAxes(lost!.to, { lifecycle: "active", runtime: "recovering", work: "working" }) ||
    timestamp(lost!.receipt.at)! < correctionAt ||
    timestamp(lost!.receipt.at)! - correctionAt > COMPATIBILITY_OVERWRITE_MAX_MS
  ) {
    return {
      status: "refused",
      reason: "correction-overwrite-proof-mismatch",
      detail: "the first post-correction edge is not the exact revision-reset dead-probe overwrite",
    };
  }

  const recoveryEvidence = succeeded!.receipt.evidence[0];
  const recoveryObject = object(recoveryEvidence);
  const attemptId = typeof recoveryObject?.attemptId === "string" ? recoveryObject.attemptId : "";
  const recoveryProbe = succeeded!.receipt.evidence.length === 2
    ? exactProbe(succeeded!.receipt.evidence[1], "alive", record.runnerPid)
    : undefined;
  if (
    succeeded!.receipt.type !== "recovery.succeeded" || succeeded!.receipt.cause !== "revive-ok" ||
    succeeded!.receipt.eventId !== `recovery-succeeded:${attemptId}` || succeeded!.revision !== 2 ||
    !exactRecoveryEvidence(recoveryEvidence, attemptId, recovery?.maxAttempts ?? -1) || !recoveryProbe ||
    !exactAxes(succeeded!.from, { lifecycle: "active", runtime: "recovering", work: "working" }) ||
    !exactAxes(succeeded!.to, { lifecycle: "active", runtime: "live", work: "working" }) ||
    !currentReceiptMatches(record, succeeded!.receipt) ||
    timestamp(succeeded!.receipt.at)! < timestamp(lost!.receipt.at)!
  ) {
    return {
      status: "refused",
      reason: "recovery-proof-mismatch",
      detail: "the current cursor is not the exact one-attempt, zero-replay recovery successor",
    };
  }
  if (!exactRecoveryRecord(recovery, correction, lostProbe, attemptId)) {
    return {
      status: "refused",
      reason: "recovery-proof-mismatch",
      detail: "the durable recovery episode is not one succeeded attempt for the overwritten generation",
    };
  }
  const recoveryAttempt = recovery.attempts[0]!;
  const detectedAt = timestamp(recovery.detectedAt);
  const attemptStartedAt = timestamp(recoveryAttempt.startedAt);
  const attemptEndedAt = timestamp(recoveryAttempt.endedAt);
  const successorStartedAt = timestamp(meta?.startedAt);
  const succeededAt = timestamp(succeeded!.receipt.at);
  const lostAt = timestamp(lost!.receipt.at)!;
  if (
    detectedAt === undefined || attemptStartedAt === undefined || attemptEndedAt === undefined ||
    successorStartedAt === undefined || succeededAt === undefined || detectedAt < lostAt ||
    attemptStartedAt < detectedAt || successorStartedAt < attemptStartedAt ||
    succeededAt < successorStartedAt || attemptEndedAt < succeededAt ||
    succeededAt - lostAt > COMPATIBILITY_OVERWRITE_MAX_MS
  ) {
    return {
      status: "refused",
      reason: "recovery-proof-mismatch",
      detail: "the sole recovery episode does not form the bounded loss -> launch -> zero-replay success chronology",
    };
  }
  const attemptRows = ledger.filter((event) =>
    event.type === "runtime.recovery.attempt" && event.session === beeName);
  if (
    attemptRows.length !== 1 || attemptRows[0]!.episodeId !== recovery.episodeId ||
    attemptRows[0]!.attemptId !== attemptId || attemptRows[0]!.attempt !== 1 ||
    attemptRows[0]!.budget !== recovery.maxAttempts || attemptRows[0]!.outcome !== "started"
    || attemptRows[0]!.ts !== recoveryAttempt.startedAt
  ) {
    return {
      status: "refused",
      reason: "recovery-proof-mismatch",
      detail: "the recovery attempt ledger does not match the sole durable succeeded attempt",
    };
  }

  const originalArchive = transitions.find((transition) =>
    transition.receipt.eventId === correction.archivedEventId &&
    transition.receipt.type === "bee.archived" && transition.receipt.cause === "retire");
  const archivedAt = timestamp(originalArchive?.receipt.at);
  const cancelRequestedAt = timestamp(reservation.cancel!.requestedAt);
  const cancelEventAt = timestamp(cancelEvent.occurredAt);
  const finishedAt = timestamp(reservation.result!.finishedAt);
  const terminalEventAt = timestamp(terminalEvent.occurredAt);
  const originalArchiveOperator = object(originalArchive?.receipt.evidence[0]);
  if (
    !originalArchive || archivedAt === undefined || cancelRequestedAt === undefined || cancelEventAt === undefined ||
    finishedAt === undefined || terminalEventAt === undefined || cancelRequestedAt < leaseAt ||
    cancelRequestedAt > archivedAt || cancelEventAt < leaseAt || cancelEventAt > archivedAt ||
    archivedAt < leaseAt || archivedAt - leaseAt > EXPIRY_TO_ARCHIVE_MAX_MS ||
    finishedAt < archivedAt || finishedAt - archivedAt > ARCHIVE_TO_RESULT_MAX_MS ||
    terminalEventAt < archivedAt || terminalEventAt - archivedAt > TERMINAL_EVENT_LAG_MAX_MS ||
    originalArchive.receipt.evidence.length !== 2 ||
    originalArchiveOperator?.kind !== "operator" || originalArchiveOperator.action !== "retire" ||
    !exactProbe(originalArchive.receipt.evidence[1], "dead", correction.runnerPid)
  ) {
    return {
      status: "refused",
      reason: "execution-chronology-mismatch",
      detail: "the correction no longer links to the exact bounded historical archive chronology",
    };
  }

  const promptAt = record.lastPromptAt === undefined ? undefined : timestamp(record.lastPromptAt);
  if (pending || staged !== null || queued || promptAt === undefined && record.lastPromptAt !== undefined ||
      promptAt !== undefined && promptAt >= correctionAt) {
    return {
      status: "refused",
      reason: "newer-user-work",
      detail: "a prompt, pending/staged turn, or queued message exists at or after the accepted correction",
    };
  }
  if (
    !meta || meta.bee !== beeName || meta.mirrorOfNode || meta.status !== "running" ||
    meta.startupFailure || meta.eventIntegrityFailure || meta.hostPid !== record.runnerPid ||
    !sameProcessBirthFingerprint(meta.hostFingerprint, record.runnerFingerprint) ||
    meta.sessionId !== record.providerSessionId || meta.childAdmission !== "admitted" ||
    !meta.childPid || !meta.childPgid || !meta.childFingerprint ||
    !exactHostEpochOnly(currentEvents, meta)
  ) {
    return {
      status: "refused",
      reason: "runtime-proof-mismatch",
      detail: "the current local-HSR successor is not the exact no-work host epoch bound to the SessionRecord",
    };
  }
  let runtimeLive: boolean;
  try {
    runtimeLive = await (dependencies.isRuntimeLive ?? isHsrPoolMutatorLive)(meta);
  } catch (error) {
    return {
      status: "refused",
      reason: "proof-unavailable",
      detail: `successor liveness could not be proved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!runtimeLive) {
    return {
      status: "refused",
      reason: "runtime-proof-mismatch",
      detail: "the zero-replay successor is no longer the exact live runtime described by its metadata",
    };
  }
  return {
    status: "eligible",
    proof: {
      kind: "compatibility-overwrite",
      record,
      reservation,
      meta,
      correction,
      correctionEventId: acceptedCorrection.transition.receipt.eventId,
      overwrittenEventId: lost!.receipt.eventId,
      recoveryEventId: succeeded!.receipt.eventId,
      recoveryEpisodeId: recovery.episodeId,
      recoveryAttemptId: attemptId,
      originalArchiveAt: originalArchive.receipt.at,
      recovery,
    },
  };
}

async function inspectLegacyLeaseExpiryArchive(
  beeName: string,
  runId: string,
  dependencies: LeaseArchiveRepairDependencies,
): Promise<Inspection> {
  const load = dependencies.loadSession ?? loadSession;
  const readRun = dependencies.readReservation ?? readReservation;
  let record: SessionRecord | null;
  let reservation: RunReservation | null;
  try {
    [record, reservation] = await Promise.all([load(beeName), readRun(runId)]);
  } catch (error) {
    return {
      status: "refused",
      reason: "proof-unavailable",
      detail: `canonical session/run evidence could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!record) return { status: "refused", reason: "session-missing", detail: `no exact SessionRecord named ${beeName}` };
  if (!reservation) return { status: "refused", reason: "run-missing", detail: `no execution reservation named ${runId}` };
  if (
    reservation.runId !== runId || reservation.beeName !== beeName ||
    reservation.sessionRef === undefined || record.id !== reservation.sessionRef ||
    record.executionRunId !== runId
  ) {
    return {
      status: "refused",
      reason: "run-binding-mismatch",
      detail: "the Bee, execution Run, and provider session reference do not name one exact generation",
    };
  }

  if (
    (
      record.stateMachine?.lastTransition.type === "bee.archive-corrected" &&
      record.stateMachine.lastTransition.cause === "lease-expiry-offload-repair"
      || record.stateMachine?.lastTransition.type === "bee.archive-correction-restored" &&
      record.stateMachine.lastTransition.cause === "legacy-daemon-overwrite-repair"
    ) &&
    record.stateMachine.lastTransition.evidence.some((evidence) =>
      evidence.kind === "repair" && evidence.runId === runId)
  ) {
    return { status: "already-repaired", record };
  }
  if (record.stateMachine?.lifecycle === "active") {
    return inspectCompatibilityOverwrite(beeName, runId, record, reservation, dependencies);
  }
  const cursor = record.stateMachine;
  if (
    record.status !== "done" || !cursor || cursor.lifecycle !== "archived" ||
    cursor.runtime !== "parked" || cursor.work !== "done" ||
    cursor.lastTransition.type !== "bee.archived" || cursor.lastTransition.cause !== "retire"
  ) {
    return {
      status: "refused",
      reason: "not-current-legacy-archive",
      detail: "the current canonical cursor is not the exact archived/parked/done retire shape",
    };
  }
  const archiveOperator = cursor.lastTransition.evidence.find((evidence) =>
    evidence.kind === "operator" && evidence.action === "retire");
  const archiveProbe = cursor.lastTransition.evidence.find((evidence) => evidence.kind === "probe");
  if (
    !archiveOperator || !archiveProbe || archiveProbe.outcome !== "dead" ||
    archiveProbe.target.substrate !== "hsr" || archiveProbe.target.runnerPid !== record.runnerPid
  ) {
    return {
      status: "refused",
      reason: "not-current-legacy-archive",
      detail: "the current retire receipt lacks exact dead-HSR evidence for this recorded runner",
    };
  }
  if (
    record.lastError || record.stopIntent || record.deliveryStopDoubt ||
    record.eventIntegrityDoubt || record.runtimeReplacement || record.stateUnverified
  ) {
    return {
      status: "refused",
      reason: "unsafe-session-fence",
      detail: "the archived generation carries unresolved lifecycle, delivery, replacement, or event-integrity doubt",
    };
  }
  if (!record.providerSessionId || record.substrate !== "hsr" || !record.runnerPid || !record.runnerFingerprint) {
    return {
      status: "refused",
      reason: "runtime-proof-mismatch",
      detail: "the archived record lacks resumable provider context or exact local-HSR birth identity",
    };
  }
  if (
    reservation.phase !== "started" || reservation.cancel?.reason !== "lease_expired" ||
    reservation.result?.outcome !== "cancelled" || reservation.result.cause !== "lease_expired" ||
    reservation.releasedAt !== undefined
  ) {
    return {
      status: "refused",
      reason: "not-historical-lease-expiry",
      detail: "the Run is not the historical started -> lease-expired cancel terminal shape",
    };
  }

  let events: StoredRunEvent[];
  let operations: OperationRecord[];
  try {
    [events, operations] = await Promise.all([
      (dependencies.readRunEvents ?? readRunEvents)(runId),
      (dependencies.listOperations ?? listOperations)(runId),
    ]);
  } catch (error) {
    return {
      status: "refused",
      reason: "proof-unavailable",
      detail: `execution event/operation evidence could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const explicit = explicitLifecycleOperation(operations);
  if (explicit) {
    return {
      status: "refused",
      reason: "explicit-lifecycle-operation",
      detail: `${explicit.method} effect ${explicit.effectKey} records an explicit lifecycle decision for this Run`,
    };
  }
  const cancelEvent = legacyLeaseCancelEvent(events);
  const terminalEvent = matchingLeaseTerminalEvent(events);
  const leaseAt = timestamp(reservation.leaseExpiresAt);
  const cancelRequestedAt = timestamp(reservation.cancel.requestedAt);
  const cancelEventAt = timestamp(cancelEvent?.occurredAt);
  const archivedAt = timestamp(cursor.lastTransition.at);
  const finishedAt = timestamp(reservation.result.finishedAt);
  const terminalEventAt = timestamp(terminalEvent?.occurredAt);
  if (
    !cancelEvent || !terminalEvent || leaseAt === undefined || cancelRequestedAt === undefined ||
    cancelEventAt === undefined || archivedAt === undefined || finishedAt === undefined || terminalEventAt === undefined ||
    cancelRequestedAt < leaseAt || cancelRequestedAt > archivedAt ||
    cancelEventAt < leaseAt || cancelEventAt > archivedAt ||
    archivedAt < leaseAt || archivedAt - leaseAt > EXPIRY_TO_ARCHIVE_MAX_MS ||
    finishedAt < archivedAt || finishedAt - archivedAt > ARCHIVE_TO_RESULT_MAX_MS ||
    terminalEventAt < archivedAt || terminalEventAt - archivedAt > TERMINAL_EVENT_LAG_MAX_MS
  ) {
    return {
      status: "refused",
      reason: "execution-chronology-mismatch",
      detail: "lease cancel, exact retire, and terminal Run evidence do not form the bounded historical chronology",
    };
  }

  let ledger: LedgerEvent[];
  try {
    ledger = await (dependencies.readLedgerEvents ?? (async (name, sinceMs) =>
      collectLedgerEvents({ filter: { sessions: [name], sinceMs } })))(beeName, leaseAt);
  } catch (error) {
    return {
      status: "refused",
      reason: "proof-unavailable",
      detail: `state-transition audit evidence could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!ledger.some((event) => isMatchingArchiveAudit(event, beeName, cursor.lastEventId))) {
    return {
      status: "refused",
      reason: "archive-audit-missing",
      detail: "the durable ledger does not contain the exact current retire transition receipt",
    };
  }
  let meta: HsrMeta | null;
  try {
    meta = await (dependencies.readHsrMeta ?? readHsrMetaStrict)(beeName);
  } catch (error) {
    return {
      status: "refused",
      reason: "proof-unavailable",
      detail: `strict HSR metadata could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const closure = meta?.eventStreamClosure;
  const endedAt = timestamp(meta?.endedAt);
  const closureAt = timestamp(closure?.closedAt);
  if (
    !meta || meta.bee !== beeName || meta.mirrorOfNode || meta.status !== "exited" || meta.exitCode !== 0 ||
    meta.startupFailure || meta.eventIntegrityFailure || meta.hostPid !== record.runnerPid ||
    !sameProcessBirthFingerprint(meta.hostFingerprint, record.runnerFingerprint) ||
    (meta.sessionId !== undefined && meta.sessionId !== record.providerSessionId) ||
    !closure || closure.lastSeq <= 0 || endedAt === undefined || closureAt === undefined ||
    endedAt < leaseAt || endedAt > archivedAt || closureAt < leaseAt || closureAt > archivedAt
  ) {
    return {
      status: "refused",
      reason: "runtime-proof-mismatch",
      detail: "strict HSR metadata does not prove the same cleanly exited generation and provider context",
    };
  }
  let closureVerified: boolean;
  let runtimeLive: boolean;
  try {
    [closureVerified, runtimeLive] = await Promise.all([
      (dependencies.verifyEventClosure ?? verifyHsrEventStreamClosure)(beeName, meta),
      (dependencies.isRuntimeLive ?? isHsrPoolMutatorLive)(meta),
    ]);
  } catch (error) {
    return {
      status: "refused",
      reason: "proof-unavailable",
      detail: `exact runtime/closure proof could not be revalidated: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!closureVerified) {
    return {
      status: "refused",
      reason: "event-closure-unconfirmed",
      detail: "the recorded HSR event-stream closure does not match the current durable source log",
    };
  }
  if (runtimeLive) {
    return {
      status: "refused",
      reason: "runtime-still-live",
      detail: "the exact host or detached child process group is still live",
    };
  }
  return {
    status: "eligible",
    proof: {
      kind: "legacy-archive",
      record,
      reservation,
      meta,
      archivedEventId: cursor.lastEventId,
      archivedAt: cursor.lastTransition.at,
      leaseExpiresAt: reservation.leaseExpiresAt,
      closureLastSeq: closure.lastSeq,
      closureClosedAt: closure.closedAt,
    },
  };
}

function sameCompatibilityProof(left: CompatibilityOverwriteProof, right: CompatibilityOverwriteProof): boolean {
  return left.correctionEventId === right.correctionEventId &&
    left.overwrittenEventId === right.overwrittenEventId &&
    left.recoveryEventId === right.recoveryEventId &&
    left.recoveryEpisodeId === right.recoveryEpisodeId &&
    left.recoveryAttemptId === right.recoveryAttemptId &&
    left.record.runtimeGeneration === right.record.runtimeGeneration &&
    left.record.runnerPid === right.record.runnerPid &&
    sameProcessBirthFingerprint(left.record.runnerFingerprint, right.record.runnerFingerprint);
}

async function applyCompatibilityOverwriteRepair(
  beeName: string,
  runId: string,
  inspectedProof: CompatibilityOverwriteProof,
  dependencies: LeaseArchiveRepairDependencies,
): Promise<LeaseArchiveRepairResult> {
  await dependencies.beforeTransition?.();
  return withFileLock(admissionLockPath(), async () =>
    withSessionLifecycleTransaction(inspectedProof.record, async (lifecycle) => {
      const reinspected = await inspectLegacyLeaseExpiryArchive(beeName, runId, dependencies);
      if (reinspected.status === "refused") {
        return refused(beeName, runId, reinspected.reason, `apply-time proof refused: ${reinspected.detail}`);
      }
      if (reinspected.status !== "eligible" || reinspected.proof.kind !== "compatibility-overwrite" ||
          !sameCompatibilityProof(inspectedProof, reinspected.proof)) {
        return refused(
          beeName,
          runId,
          "correction-overwrite-proof-mismatch",
          "the accepted correction/overwrite chain changed before cleanup admission",
        );
      }
      const proof = reinspected.proof;
      let current = await lifecycle.refresh();
      const freshProbe = await (dependencies.probeRuntime ?? (async (record, observerId) =>
        (await probeHsrReAdoption(record, observerId)).evidence))(
        current,
        `lease-archive-overwrite-repair:${process.pid}`,
      );
      if (!exactProbe(freshProbe, "alive", proof.record.runnerPid!)) {
        return refused(
          beeName,
          runId,
          "runtime-proof-mismatch",
          "a fresh lifecycle-locked probe did not prove the exact zero-replay successor alive",
        );
      }
      if (current.stateUnverified) {
        if (!await isExactStoppedDaemonMarker(current.stateUnverified, dependencies)) {
          return refused(beeName, runId, "unsafe-session-fence", "runtime uncertainty changed before cleanup admission");
        }
        await (dependencies.markVerified ?? markSessionVerified)(beeName, freshProbe);
        current = await lifecycle.refresh();
        if (current.stateUnverified) {
          return refused(beeName, runId, "unsafe-session-fence", "fresh exact liveness proof did not clear uncertainty");
        }
      }

      const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();
      const repairId = `lease-expiry-archive-correction-restore:${runId}:${proof.correctionEventId}:${proof.recoveryEventId}`;
      const pendingReplacement = {
        version: 1 as const,
        reservationId: repairId,
        operation: "lease-expiry-archive-correction-restore",
        sourceGeneration: current.runtimeGeneration ?? 0,
        state: "pending" as const,
        startedAt: observedAt,
        updatedAt: observedAt,
        detail: "strictly stopping the exact zero-replay mixed-version recovery successor",
      };
      const ownsPristineRepairFence = (candidate: SessionRecord | null): candidate is SessionRecord => {
        const state = candidate?.stateMachine;
        return candidate !== null && state !== undefined && candidate.status === "kill_failed" &&
          candidate.lastError === undefined && candidate.stopIntent === undefined &&
          candidate.deliveryStopDoubt === undefined && candidate.eventIntegrityDoubt === undefined &&
          candidate.stateUnverified === undefined &&
          JSON.stringify(candidate.runtimeReplacement) === JSON.stringify(pendingReplacement) &&
          candidate.runtimeGeneration === proof.record.runtimeGeneration &&
          candidate.runnerPid === proof.record.runnerPid &&
          sameProcessBirthFingerprint(candidate.runnerFingerprint, proof.record.runnerFingerprint) &&
          candidate.executionRunId === runId && candidate.providerSessionId === proof.record.providerSessionId &&
          state.lastEventId === proof.recoveryEventId && state.lifecycle === "active" && state.runtime === "live" &&
          state.work === "working" && candidate.lastPromptAt === proof.record.lastPromptAt;
      };
      const publishStoppedDoubt = async (detail: string): Promise<void> => {
        const latest = await lifecycle.refresh();
        if (
          latest.runtimeReplacement?.reservationId !== repairId ||
          latest.runtimeReplacement.operation !== "lease-expiry-archive-correction-restore" ||
          latest.runtimeReplacement.sourceGeneration !== (proof.record.runtimeGeneration ?? 0)
        ) return;
        const updatedAt = new Date().toISOString();
        await lifecycle.commit({
          status: "kill_failed",
          lastError: latest.lastError ?? `lease archive overwrite repair: ${detail}`,
          runtimeReplacement: {
            ...latest.runtimeReplacement,
            state: "stop-failed",
            updatedAt,
            detail,
          },
          updatedAt,
        });
      };
      current = await lifecycle.commit({
        status: "kill_failed",
        lastError: undefined,
        runtimeReplacement: pendingReplacement,
        updatedAt: observedAt,
      });
      await dependencies.afterStopFence?.();

      const load = dependencies.loadSession ?? loadSession;
      const [fenced, latestMeta, latestEvents, pending, staged, queued] = await Promise.all([
        load(beeName),
        (dependencies.readHsrMeta ?? readHsrMetaStrict)(beeName),
        (dependencies.readCurrentEvents ?? readCurrentHsrEventTail)(beeName),
        (dependencies.hasPendingTurns ?? hasPendingHsrTurns)(beeName),
        (dependencies.readStagedTurns ?? readStagedPendingHsrTurns)(beeName),
        (dependencies.hasQueuedMessages ?? defaultHasQueuedMessages)(beeName),
      ]);
      const fenceStillOwns = ownsPristineRepairFence(fenced);
      const metaStillOwns = latestMeta !== null && latestMeta.status === "running" &&
        latestMeta.hostPid === proof.record.runnerPid &&
        sameProcessBirthFingerprint(latestMeta.hostFingerprint, proof.record.runnerFingerprint) &&
        latestMeta.sessionId === proof.record.providerSessionId &&
        !latestMeta.eventIntegrityFailure && !latestMeta.startupFailure;
      if (!fenceStillOwns || !metaStillOwns || !exactHostEpochOnly(latestEvents, latestMeta!) || pending || staged || queued) {
        // No runtime side effect has happened yet, so release only our own
        // temporary fence. Any concurrent authority remains visible in the
        // refusal and is never silently demoted to done.
        const stillCurrent = await lifecycle.refresh();
        if (ownsPristineRepairFence(stillCurrent)) {
          await lifecycle.commit({ status: "running", runtimeReplacement: undefined, updatedAt: new Date().toISOString() });
        }
        return refused(
          beeName,
          runId,
          "newer-user-work",
          "the successor gained work, delivery, or a different runtime identity before strict stop",
        );
      }

      let stopped: KillResult;
      try {
        stopped = await (dependencies.stopRuntime ?? stopHsrIncarnation)(beeName, latestMeta!);
      } catch (error) {
        stopped = {
          ok: false,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        };
      }
      if (!stopped.ok) {
        const detail = stopped.stderr || "strict HSR stop was not positively confirmed";
        await publishStoppedDoubt(detail);
        return refused(beeName, runId, "runtime-stop-unconfirmed", detail);
      }

      const deadProbe = await (dependencies.probeRuntime ?? (async (record, observerId) =>
        (await probeHsrReAdoption(record, observerId)).evidence))(
        current,
        `lease-archive-overwrite-repair-stopped:${process.pid}`,
      );
      const [stoppedMeta, stoppedEvents, closureVerified, pendingAfter, stagedAfter, queuedAfter] = await Promise.all([
        (dependencies.readHsrMeta ?? readHsrMetaStrict)(beeName),
        (dependencies.readCurrentEvents ?? readCurrentHsrEventTail)(beeName),
        (async () => {
          const meta = await (dependencies.readHsrMeta ?? readHsrMetaStrict)(beeName);
          return meta ? (dependencies.verifyEventClosure ?? verifyHsrEventStreamClosure)(beeName, meta) : false;
        })(),
        (dependencies.hasPendingTurns ?? hasPendingHsrTurns)(beeName),
        (dependencies.readStagedTurns ?? readStagedPendingHsrTurns)(beeName),
        (dependencies.hasQueuedMessages ?? defaultHasQueuedMessages)(beeName),
      ]);
      if (
        !exactProbe(deadProbe, "dead", proof.record.runnerPid!) || !stoppedMeta ||
        stoppedMeta.status !== "exited" || stoppedMeta.hostPid !== proof.record.runnerPid ||
        !sameProcessBirthFingerprint(stoppedMeta.hostFingerprint, proof.record.runnerFingerprint) ||
        stoppedMeta.eventIntegrityFailure || !stoppedMeta.eventStreamClosure || !closureVerified ||
        !exactStoppedSuccessorTail(stoppedEvents, stoppedMeta) || pendingAfter || stagedAfter || queuedAfter
      ) {
        const detail = "runtime stopped, but exact dead/clean-closure/no-work proof was not preserved";
        await publishStoppedDoubt(detail);
        return refused(beeName, runId, "runtime-stop-unconfirmed", detail);
      }

      let transitioned: SessionTransitionResult | null;
      try {
        transitioned = await (dependencies.transition ?? transitionSession)(beeName, {
          type: "bee.archive-correction-restored",
          eventId: repairId,
          at: deadProbe.observedAt,
          cause: "legacy-daemon-overwrite-repair",
          evidence: {
            kind: "repair",
            repairId,
            observedAt: deadProbe.observedAt,
            action: "lease-expiry-archive-correction-restore",
            runId,
            sessionRef: proof.correction.sessionRef,
            providerSessionId: proof.correction.providerSessionId,
            leaseExpiresAt: proof.correction.leaseExpiresAt,
            archivedEventId: proof.correction.archivedEventId,
            correctionEventId: proof.correctionEventId,
            overwrittenEventId: proof.overwrittenEventId,
            originalRuntimeGeneration: proof.correction.runtimeGeneration,
            originalRunnerPid: proof.correction.runnerPid,
            originalRunnerFingerprint: proof.correction.runnerFingerprint,
            closureLastSeq: proof.correction.closureLastSeq,
            closureClosedAt: proof.correction.closureClosedAt,
            currentRuntimeGeneration: proof.record.runtimeGeneration ?? 0,
            currentRunnerPid: proof.record.runnerPid!,
            currentRunnerFingerprint: proof.record.runnerFingerprint!,
            recoveryEpisodeId: proof.recoveryEpisodeId,
            recoveryAttemptId: proof.recoveryAttemptId,
            recoveryEventId: proof.recoveryEventId,
          },
          probe: deadProbe,
        });
      } catch (error) {
        const detail = `runtime stopped but correction restore CAS failed: ${error instanceof Error ? error.message : String(error)}`;
        await publishStoppedDoubt(detail);
        return refused(beeName, runId, "archive-changed", detail);
      }
      if (!transitioned) return refused(beeName, runId, "session-missing", "the exact SessionRecord vanished during cleanup");
      return {
        status: "repaired",
        beeName,
        runId,
        detail: "mixed-version zero-replay successor strictly stopped; active Bee restored to parked/done",
        record: transitioned.record,
      };
    }));
}

/**
 * Inspect or explicitly correct one pre-fix lease-expiry archive.
 *
 * This is intentionally operator-invoked. Historical storage used the same
 * generic `operator/retire` evidence for an execution-initiated expiry stop
 * and a human `hive retire`, so automatic inventory reconciliation cannot
 * prove user intent. The exact Bee + Run arguments supply that missing intent;
 * every remaining process, event, binding, chronology, and current-receipt
 * proof still fails closed before this bounded state-machine edge is allowed.
 */
export async function repairLegacyLeaseExpiryArchive(
  beeName: string,
  runId: string,
  options: { apply?: boolean; dependencies?: LeaseArchiveRepairDependencies } = {},
): Promise<LeaseArchiveRepairResult> {
  const dependencies = options.dependencies ?? {};
  const inspected = await inspectLegacyLeaseExpiryArchive(beeName, runId, dependencies);
  if (inspected.status === "refused") return refused(beeName, runId, inspected.reason, inspected.detail);
  if (inspected.status === "already-repaired") {
    return {
      status: "already-repaired",
      beeName,
      runId,
      detail: "the exact bounded lease-expiry archive correction is already current",
      record: inspected.record,
    };
  }
  if (!options.apply) {
    return {
      status: "eligible",
      beeName,
      runId,
      detail: "all durable proofs match; rerun with explicit apply authority to correct the historical archive",
    };
  }
  const proof = inspected.proof;
  if (proof.kind === "compatibility-overwrite") {
    try {
      return await applyCompatibilityOverwriteRepair(beeName, runId, proof, dependencies);
    } catch (error) {
      return refused(
        beeName,
        runId,
        "archive-changed",
        `compatibility-overwrite cleanup lost its bounded proof: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const eventId = `lease-expiry-archive-correction:${runId}:${proof.archivedEventId}:${proof.closureLastSeq}`;
  try {
    // The proof-heavy inspection above is read-only and deliberately does not
    // hold a global execution lock across HSR/ledger IO. Immediately before
    // the write, let tests model a winner and then acquire the same admission
    // lock used by operation admission and reservation mutation. Re-read only
    // the Run/operation facts that can acquire new explicit lifecycle intent;
    // hold that lock through the SessionRecord CAS so cancel/release cannot
    // land in the gap.
    await dependencies.beforeTransition?.();
    return await withFileLock(admissionLockPath(), async () => {
      const [currentRun, currentOperations] = await Promise.all([
        (dependencies.readReservation ?? readReservation)(runId),
        (dependencies.listOperations ?? listOperations)(runId),
      ]);
      const explicit = explicitLifecycleOperation(currentOperations);
      if (explicit) {
        return refused(
          beeName,
          runId,
          "explicit-lifecycle-operation",
          `${explicit.method} effect ${explicit.effectKey} won before the correction write`,
        );
      }
      if (
        !currentRun || currentRun.beeName !== proof.reservation.beeName ||
        currentRun.sessionRef !== proof.reservation.sessionRef ||
        currentRun.phase !== "started" || currentRun.leaseExpiresAt !== proof.leaseExpiresAt ||
        currentRun.cancel?.reason !== "lease_expired" ||
        currentRun.cancel.requestedAt !== proof.reservation.cancel!.requestedAt ||
        currentRun.result?.outcome !== "cancelled" || currentRun.result.cause !== "lease_expired" ||
        currentRun.result.finishedAt !== proof.reservation.result!.finishedAt ||
        currentRun.releasedAt !== undefined
      ) {
        return refused(
          beeName,
          runId,
          "archive-changed",
          "the execution Run gained or changed lifecycle authority before correction",
        );
      }
      const transitioned: SessionTransitionResult | null = await (dependencies.transition ?? transitionSession)(beeName, {
        type: "bee.archive-corrected",
        eventId,
        at: observedAt,
        cause: "lease-expiry-offload-repair",
        evidence: {
          kind: "repair",
          repairId: eventId,
          observedAt,
          action: "lease-expiry-archive-correction",
          runId,
          sessionRef: proof.reservation.sessionRef!,
          providerSessionId: proof.record.providerSessionId!,
          leaseExpiresAt: proof.leaseExpiresAt,
          archivedEventId: proof.archivedEventId,
          runtimeGeneration: proof.record.runtimeGeneration ?? 0,
          runnerPid: proof.record.runnerPid!,
          runnerFingerprint: proof.record.runnerFingerprint!,
          closureLastSeq: proof.closureLastSeq,
          closureClosedAt: proof.closureClosedAt,
        },
        probe: {
          kind: "probe",
          probeId: `${eventId}:probe`,
          observerId: "hive-execution-repair",
          observedAt,
          outcome: "dead",
          target: { substrate: "hsr", runnerPid: proof.meta.hostPid },
          detail: "strict matching HSR birth is absent and its terminal source-event closure was revalidated",
        },
      });
      if (!transitioned) return refused(beeName, runId, "session-missing", "the exact SessionRecord vanished before correction");
      return {
        status: "repaired" as const,
        beeName,
        runId,
        detail: "historical lease-expiry archive corrected to an active parked Bee; provider context was preserved",
        record: transitioned.record,
      };
    });
  } catch (error) {
    return refused(
      beeName,
      runId,
      "archive-changed",
      `the current archive receipt changed before correction: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
