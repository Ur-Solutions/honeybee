/**
 * Bounded bee-state machine.
 *
 * These are internal facts, not another consumer vocabulary. BeeView is the
 * sole public projection and maps this cursor to displayState/openRequests in
 * src/view/project.ts.
 */

export type BeeLifecycleState = "active" | "archived";
export type BeeRuntimeState = "live" | "parked" | "recovering" | "lost";
export type BeeWorkState = "spawning" | "working" | "needs-you" | "done";

export type ProbeEvidence = {
  kind: "probe";
  probeId: string;
  observerId: string;
  observedAt: string;
  outcome: "alive" | "dead" | "unreachable";
  target: {
    substrate: "local-tmux" | "hsr" | "remote-hsr";
    node?: string;
    tmuxTarget?: string;
    agentPaneId?: string;
    runnerPid?: number;
    remoteLaunchId?: string;
    remoteIncarnation?: string;
  };
  detail?: string;
};

export type HookEvidence = {
  kind: "hook";
  hookId: string;
  observedAt: string;
  hook: "turn-start" | "turn-end" | "needs-input" | "auth-needed";
  detail?: string;
};

export type RequestEvidence = {
  kind: "request";
  requestId: string;
  observedAt: string;
  action: "opened" | "answered" | "login" | "cancelled";
};

export type OperatorEvidence = {
  kind: "operator";
  actionId: string;
  observedAt: string;
  action: "steer" | "retire" | "seal" | "revive";
};

export type RecoveryEvidence = {
  kind: "recovery";
  attemptId: string;
  observedAt: string;
  attempt: number;
  budget: number;
  outcome: "started" | "succeeded" | "failed";
  detail?: string;
};

/** Exact audit proof for correcting the historical lease-expiry archive bug. */
export type ArchiveCorrectionEvidence = {
  kind: "repair";
  repairId: string;
  observedAt: string;
  action: "lease-expiry-archive-correction";
  runId: string;
  sessionRef: string;
  providerSessionId: string;
  leaseExpiresAt: string;
  archivedEventId: string;
  runtimeGeneration: number;
  runnerPid: number;
  runnerFingerprint: { pgid: number; startedAt: string };
  closureLastSeq: number;
  closureClosedAt: string;
};

/**
 * Exact audit proof for undoing the one mixed-version daemon overwrite that
 * could follow a historical lease-archive correction before the fixed daemon
 * was deployed. This is not a second general unarchive/revive primitive: it
 * binds both the accepted correction and the compatibility writer's exact
 * runtime.lost edge, plus an optional zero-replay successor that was strictly
 * stopped before the cursor was restored.
 */
export type ArchiveCorrectionRestoreEvidence = {
  kind: "repair";
  repairId: string;
  observedAt: string;
  action: "lease-expiry-archive-correction-restore";
  runId: string;
  sessionRef: string;
  providerSessionId: string;
  leaseExpiresAt: string;
  archivedEventId: string;
  correctionEventId: string;
  overwrittenEventId: string;
  originalRuntimeGeneration: number;
  originalRunnerPid: number;
  originalRunnerFingerprint: { pgid: number; startedAt: string };
  closureLastSeq: number;
  closureClosedAt: string;
  currentRuntimeGeneration: number;
  currentRunnerPid: number;
  currentRunnerFingerprint: { pgid: number; startedAt: string };
  recoveryEpisodeId?: string;
  recoveryAttemptId?: string;
  recoveryEventId?: string;
};

/** Durable policy proof for an intentional idle runtime offload. */
export type ParkingEvidence = {
  kind: "parking";
  parkingId: string;
  observedAt: string;
  policy: "idle-grace";
  idleSince: string;
  graceMs: number;
  runtimeGeneration: number;
  work: "done" | "needs-you";
};

export type TransitionEvidence =
  | ProbeEvidence
  | HookEvidence
  | RequestEvidence
  | OperatorEvidence
  | RecoveryEvidence
  | ArchiveCorrectionEvidence
  | ArchiveCorrectionRestoreEvidence
  | ParkingEvidence;

export type ObserverOfflineMarker = {
  observerId: string;
  offlineSince: string;
  lastSeenAt?: string;
  reason: string;
};

export type UnverifiedCursorMarker = {
  since: string;
  reason: "stale-cursor" | "observer-offline";
  probeScheduledAt: string;
  lastVerifiedAt?: string;
  observer?: ObserverOfflineMarker;
};

export type BeeTransitionReceipt = {
  eventId: string;
  type: BeeTransitionEvent["type"];
  cause: BeeTransitionEvent["cause"];
  at: string;
  evidence: TransitionEvidence[];
  requestId?: string;
  resume?: "working" | "needs-you" | "done";
};

export type BeeStateMachineCursor = {
  lifecycle: BeeLifecycleState;
  runtime: BeeRuntimeState;
  work: BeeWorkState;
  revision: number;
  transitionedAt: string;
  lastEventId: string;
  /** Carries the proof for the cursor even after ledger rotation. */
  lastTransition: BeeTransitionReceipt;
};

/**
 * One canonical retirement predicate for every Honeybee control/read path.
 * Once a proof-carrying cursor exists its lifecycle axis outranks stale
 * mixed-version scalars in both directions. Legacy `status:done` remains the
 * archive spelling only when no canonical cursor exists.
 */
export function isArchivedSessionLifecycle(record: {
  status: string;
  stateMachine?: Pick<BeeStateMachineCursor, "lifecycle">;
}): boolean {
  return record.stateMachine !== undefined
    ? record.stateMachine.lifecycle === "archived"
    : record.status === "done";
}

/**
 * Canonical-active eligibility with an exact legacy fallback. Once a bounded
 * cursor exists its lifecycle axis wins in both directions; cursor-less
 * records retain the historical `status:running` gate.
 */
export function isActiveSessionLifecycle(record: {
  status: string;
  stateMachine?: Pick<BeeStateMachineCursor, "lifecycle">;
}): boolean {
  return record.stateMachine !== undefined
    ? record.stateMachine.lifecycle === "active"
    : record.status === "running";
}

/**
 * Whether event-derived observation/usage may consume this record's current
 * history. An integrity marker means the source bytes are quarantined and
 * cannot produce new trusted state until the exact receipt is reconciled.
 * Stop recovery still receives the full record set through its own lane.
 */
export function isEventHistoryObservationAdmissible(record: {
  eventIntegrityDoubt?: unknown;
}): boolean {
  return record.eventIntegrityDoubt === undefined;
}

/**
 * Whether a session may accept newly launched, recovered, or adopted work.
 * Lifecycle remains cursor-first, but `kill_failed` is an independent durable
 * stop-doubt fence: until teardown is resolved, no second runtime may be
 * started or attached to the same record.
 */
export function isRunnableSessionRecord(record: {
  status: string;
  stateMachine?: Pick<BeeStateMachineCursor, "lifecycle">;
  deliveryStopDoubt?: unknown;
  eventIntegrityDoubt?: unknown;
}): boolean {
  return isActiveSessionLifecycle(record)
    && record.status !== "kill_failed"
    && record.deliveryStopDoubt === undefined
    && record.eventIntegrityDoubt === undefined;
}

type EventBase = { eventId: string; at: string };

export type BeeTransitionEvent =
  | (EventBase & {
      type: "turn.started";
      cause: "first-turn";
      evidence: HookEvidence;
    })
  | (EventBase & {
      type: "turn.settled";
      cause: "turn-settled";
      evidence: HookEvidence;
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "request.opened";
      cause: "question" | "permission" | "auth";
      requestId: string;
      evidence: RequestEvidence;
    })
  | (EventBase & {
      type: "runtime.lost";
      cause: "mid-turn-death";
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "recovery.succeeded";
      cause: "revive-ok";
      evidence: RecoveryEvidence;
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "recovery.failed";
      cause: "budget-exhausted";
      requestId: string;
      evidence: RecoveryEvidence;
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "request.resolved";
      cause: "answer" | "login" | "revive";
      requestId: string;
      evidence: RequestEvidence;
    })
  | (EventBase & {
      type: "turn.steered";
      cause: "steer";
      evidence: OperatorEvidence;
    })
  | (EventBase & {
      type: "runtime.parked";
      cause: "idle-death";
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "runtime.parked";
      cause: "intentional-idle-offload";
      evidence: ParkingEvidence;
      /** Exact generation was alive immediately before the intentional stop. */
      liveProbe: ProbeEvidence;
      /** Exact generation was dead after the stop completed. */
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "bee.archived";
      cause: "retire" | "seal";
      evidence: OperatorEvidence;
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "bee.archive-corrected";
      cause: "lease-expiry-offload-repair";
      evidence: ArchiveCorrectionEvidence;
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "bee.archive-correction-restored";
      cause: "legacy-daemon-overwrite-repair";
      evidence: ArchiveCorrectionRestoreEvidence;
      probe: ProbeEvidence;
    })
  | (EventBase & {
      type: "bee.revived";
      cause: "revive";
      resume: "working" | "needs-you" | "done";
      evidence: OperatorEvidence;
      probe: ProbeEvidence;
    });

export type StateMachineSeed = {
  lifecycle: BeeLifecycleState;
  runtime: BeeRuntimeState;
  work: BeeWorkState;
};

export type TransitionReduction = {
  from: StateMachineSeed;
  to: StateMachineSeed;
  receipt: BeeTransitionReceipt;
};

export class IllegalBeeTransitionError extends Error {
  readonly code = "ILLEGAL_BEE_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "IllegalBeeTransitionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isProbeEvidence(value: unknown): value is ProbeEvidence {
  if (!isRecord(value) || value.kind !== "probe") return false;
  if (!isNonEmptyString(value.probeId) || !isNonEmptyString(value.observerId) || !isIsoTimestamp(value.observedAt)) return false;
  if (value.outcome !== "alive" && value.outcome !== "dead" && value.outcome !== "unreachable") return false;
  if (
    !isRecord(value.target)
    || (
      value.target.substrate !== "local-tmux"
      && value.target.substrate !== "hsr"
      && value.target.substrate !== "remote-hsr"
    )
  ) return false;
  if (value.target.runnerPid !== undefined && (!Number.isSafeInteger(value.target.runnerPid) || Number(value.target.runnerPid) <= 0)) return false;
  for (const key of ["node", "tmuxTarget", "agentPaneId", "remoteLaunchId", "remoteIncarnation"] as const) {
    if (value.target[key] !== undefined && !isNonEmptyString(value.target[key])) return false;
  }
  return value.detail === undefined || typeof value.detail === "string";
}

export function isObserverOfflineMarker(value: unknown): value is ObserverOfflineMarker {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.observerId) && isIsoTimestamp(value.offlineSince) &&
    (value.lastSeenAt === undefined || isIsoTimestamp(value.lastSeenAt)) && isNonEmptyString(value.reason);
}

export function isUnverifiedCursorMarker(value: unknown): value is UnverifiedCursorMarker {
  if (!isRecord(value)) return false;
  if (!isIsoTimestamp(value.since) || !isIsoTimestamp(value.probeScheduledAt)) return false;
  if (value.reason !== "stale-cursor" && value.reason !== "observer-offline") return false;
  if (value.lastVerifiedAt !== undefined && !isIsoTimestamp(value.lastVerifiedAt)) return false;
  if (value.observer !== undefined && !isObserverOfflineMarker(value.observer)) return false;
  return value.reason !== "observer-offline" || value.observer !== undefined;
}

function isTransitionEvidence(value: unknown): value is TransitionEvidence {
  if (isProbeEvidence(value)) return true;
  if (!isRecord(value) || !isIsoTimestamp(value.observedAt)) return false;
  switch (value.kind) {
    case "hook":
      return isNonEmptyString(value.hookId) &&
        (value.hook === "turn-start" || value.hook === "turn-end" || value.hook === "needs-input" || value.hook === "auth-needed");
    case "request":
      return isNonEmptyString(value.requestId) &&
        (value.action === "opened" || value.action === "answered" || value.action === "login" || value.action === "cancelled");
    case "operator":
      return isNonEmptyString(value.actionId) &&
        (value.action === "steer" || value.action === "retire" || value.action === "seal" || value.action === "revive");
    case "recovery":
      return isNonEmptyString(value.attemptId) && Number.isSafeInteger(value.attempt) && Number(value.attempt) > 0 &&
        Number.isSafeInteger(value.budget) && Number(value.budget) > 0 &&
        (value.outcome === "started" || value.outcome === "succeeded" || value.outcome === "failed");
    case "repair":
      if (value.action === "lease-expiry-archive-correction-restore") {
        const recoveryFields = [value.recoveryEpisodeId, value.recoveryAttemptId, value.recoveryEventId];
        const hasRecovery = recoveryFields.every(isNonEmptyString);
        const hasNoRecovery = recoveryFields.every((field) => field === undefined);
        return isNonEmptyString(value.repairId) && isNonEmptyString(value.runId) &&
          isNonEmptyString(value.sessionRef) && isNonEmptyString(value.providerSessionId) &&
          isIsoTimestamp(value.leaseExpiresAt) && isNonEmptyString(value.archivedEventId) &&
          isNonEmptyString(value.correctionEventId) && isNonEmptyString(value.overwrittenEventId) &&
          Number.isSafeInteger(value.originalRuntimeGeneration) && Number(value.originalRuntimeGeneration) >= 0 &&
          Number.isSafeInteger(value.originalRunnerPid) && Number(value.originalRunnerPid) > 0 &&
          isRecord(value.originalRunnerFingerprint) &&
          Number.isSafeInteger(value.originalRunnerFingerprint.pgid) && Number(value.originalRunnerFingerprint.pgid) > 0 &&
          isNonEmptyString(value.originalRunnerFingerprint.startedAt) &&
          Number.isSafeInteger(value.closureLastSeq) && Number(value.closureLastSeq) > 0 &&
          isIsoTimestamp(value.closureClosedAt) &&
          Number.isSafeInteger(value.currentRuntimeGeneration) && Number(value.currentRuntimeGeneration) >= 0 &&
          Number.isSafeInteger(value.currentRunnerPid) && Number(value.currentRunnerPid) > 0 &&
          isRecord(value.currentRunnerFingerprint) &&
          Number.isSafeInteger(value.currentRunnerFingerprint.pgid) && Number(value.currentRunnerFingerprint.pgid) > 0 &&
          isNonEmptyString(value.currentRunnerFingerprint.startedAt) &&
          (hasRecovery || hasNoRecovery);
      }
      return isNonEmptyString(value.repairId) && value.action === "lease-expiry-archive-correction" &&
        isNonEmptyString(value.runId) && isNonEmptyString(value.sessionRef) &&
        isNonEmptyString(value.providerSessionId) && isIsoTimestamp(value.leaseExpiresAt) &&
        isNonEmptyString(value.archivedEventId) && Number.isSafeInteger(value.runtimeGeneration) &&
        Number(value.runtimeGeneration) >= 0 && Number.isSafeInteger(value.runnerPid) && Number(value.runnerPid) > 0 &&
        isRecord(value.runnerFingerprint) && Number.isSafeInteger(value.runnerFingerprint.pgid) &&
        Number(value.runnerFingerprint.pgid) > 0 && isNonEmptyString(value.runnerFingerprint.startedAt) &&
        Number.isSafeInteger(value.closureLastSeq) &&
        Number(value.closureLastSeq) > 0 && isIsoTimestamp(value.closureClosedAt);
    case "parking":
      return isNonEmptyString(value.parkingId) && value.policy === "idle-grace" &&
        isIsoTimestamp(value.observedAt) && isIsoTimestamp(value.idleSince) &&
        Number.isFinite(value.graceMs) && Number(value.graceMs) >= 0 &&
        Number.isSafeInteger(value.runtimeGeneration) && Number(value.runtimeGeneration) >= 0 &&
        (value.work === "done" || value.work === "needs-you");
    default:
      return false;
  }
}

function evidenceFor(event: BeeTransitionEvent): TransitionEvidence[] {
  const evidence: TransitionEvidence[] = [];
  if ("evidence" in event) evidence.push(event.evidence);
  if ("liveProbe" in event) evidence.push(event.liveProbe);
  if ("probe" in event) evidence.push(event.probe);
  return evidence;
}

function assertEventShape(event: BeeTransitionEvent): void {
  if (!isNonEmptyString(event.eventId)) throw new IllegalBeeTransitionError("transition eventId must be a non-empty string");
  if (!isIsoTimestamp(event.at)) throw new IllegalBeeTransitionError("transition at must be an ISO timestamp");
  if ("probe" in event && !isProbeEvidence(event.probe)) {
    throw new IllegalBeeTransitionError(`${event.type} requires well-formed probe evidence`);
  }
  if ("liveProbe" in event && !isProbeEvidence(event.liveProbe)) {
    throw new IllegalBeeTransitionError(`${event.type} requires well-formed pre-stop probe evidence`);
  }
  if ("requestId" in event && !isNonEmptyString(event.requestId)) {
    throw new IllegalBeeTransitionError(`${event.type} requires a requestId`);
  }
  if (event.type === "request.opened" || event.type === "request.resolved") {
    if (!isRecord(event.evidence) || event.evidence.kind !== "request" || event.evidence.requestId !== event.requestId ||
        !isIsoTimestamp(event.evidence.observedAt)) {
      throw new IllegalBeeTransitionError(`${event.type} requires matching request evidence`);
    }
  }
  if (event.type === "turn.started" || event.type === "turn.settled") {
    if (!isRecord(event.evidence) || event.evidence.kind !== "hook" || !isNonEmptyString(event.evidence.hookId) ||
        !isIsoTimestamp(event.evidence.observedAt)) {
      throw new IllegalBeeTransitionError(`${event.type} requires hook evidence`);
    }
  }
  if (event.type === "recovery.succeeded" || event.type === "recovery.failed") {
    const expected = event.type === "recovery.succeeded" ? "succeeded" : "failed";
    if (!isRecord(event.evidence) || event.evidence.kind !== "recovery" || event.evidence.outcome !== expected ||
        !isNonEmptyString(event.evidence.attemptId) || !isIsoTimestamp(event.evidence.observedAt) ||
        !Number.isSafeInteger(event.evidence.attempt) || Number(event.evidence.attempt) < 1 ||
        !Number.isSafeInteger(event.evidence.budget) || Number(event.evidence.budget) < 1) {
      throw new IllegalBeeTransitionError(`${event.type} requires ${expected} recovery evidence`);
    }
  }
  if (event.type === "turn.steered" || event.type === "bee.archived" || event.type === "bee.revived") {
    if (!isRecord(event.evidence) || event.evidence.kind !== "operator" || !isNonEmptyString(event.evidence.actionId) ||
        !isIsoTimestamp(event.evidence.observedAt)) {
      throw new IllegalBeeTransitionError(`${event.type} requires operator evidence`);
    }
  }
  if (event.type === "bee.archive-corrected") {
    if (!isRecord(event.evidence) || event.evidence.kind !== "repair" ||
        event.evidence.action !== "lease-expiry-archive-correction" ||
        !isNonEmptyString(event.evidence.repairId) || !isNonEmptyString(event.evidence.runId) ||
        !isNonEmptyString(event.evidence.sessionRef) || !isNonEmptyString(event.evidence.providerSessionId) ||
        !isIsoTimestamp(event.evidence.observedAt) || !isIsoTimestamp(event.evidence.leaseExpiresAt) ||
        !isNonEmptyString(event.evidence.archivedEventId) ||
        !Number.isSafeInteger(event.evidence.runtimeGeneration) || event.evidence.runtimeGeneration < 0 ||
        !Number.isSafeInteger(event.evidence.runnerPid) || event.evidence.runnerPid <= 0 ||
        !isRecord(event.evidence.runnerFingerprint) ||
        !Number.isSafeInteger(event.evidence.runnerFingerprint.pgid) || event.evidence.runnerFingerprint.pgid <= 0 ||
        !isNonEmptyString(event.evidence.runnerFingerprint.startedAt) ||
        !Number.isSafeInteger(event.evidence.closureLastSeq) || Number(event.evidence.closureLastSeq) <= 0 ||
        !isIsoTimestamp(event.evidence.closureClosedAt)) {
      throw new IllegalBeeTransitionError("bee.archive-corrected requires exact lease-expiry repair evidence");
    }
  }
  if (event.type === "bee.archive-correction-restored") {
    if (!isRecord(event.evidence) || event.evidence.kind !== "repair" ||
        event.evidence.action !== "lease-expiry-archive-correction-restore" ||
        !isTransitionEvidence(event.evidence)) {
      throw new IllegalBeeTransitionError("bee.archive-correction-restored requires exact overwrite-repair evidence");
    }
  }
  if (event.type === "runtime.parked" && event.cause === "intentional-idle-offload") {
    if (!isRecord(event.evidence) || event.evidence.kind !== "parking" ||
        !isNonEmptyString(event.evidence.parkingId) || event.evidence.policy !== "idle-grace" ||
        !isIsoTimestamp(event.evidence.observedAt) || !isIsoTimestamp(event.evidence.idleSince) ||
        !Number.isFinite(event.evidence.graceMs) || Number(event.evidence.graceMs) < 0 ||
        !Number.isSafeInteger(event.evidence.runtimeGeneration) || Number(event.evidence.runtimeGeneration) < 0 ||
        (event.evidence.work !== "done" && event.evidence.work !== "needs-you")) {
      throw new IllegalBeeTransitionError("intentional runtime.parked requires idle-grace parking evidence");
    }
    if (event.liveProbe.outcome !== "alive") {
      throw new IllegalBeeTransitionError("intentional runtime.parked requires an alive pre-stop probe");
    }
  }
  if (event.type === "runtime.lost" || event.type === "runtime.parked" ||
      event.type === "bee.archive-corrected" ||
      event.type === "bee.archive-correction-restored" ||
      event.type === "recovery.failed") {
    if (event.probe.outcome !== "dead") {
      throw new IllegalBeeTransitionError(`${event.type} requires a probe whose outcome is dead`);
    }
  }
  if ((event.type === "recovery.succeeded" || event.type === "bee.revived") && event.probe.outcome !== "alive") {
    throw new IllegalBeeTransitionError(`${event.type} requires a probe whose outcome is alive`);
  }
}

function sameAxes(a: StateMachineSeed, b: StateMachineSeed): boolean {
  return a.lifecycle === b.lifecycle && a.runtime === b.runtime && a.work === b.work;
}

/**
 * Exhaustive reducer for the ADR transition table. It returns a new axes
 * snapshot or throws; callers must audit the rejection before surfacing it.
 */
export function reduceBeeTransition(current: StateMachineSeed, event: BeeTransitionEvent): TransitionReduction {
  assertEventShape(event);
  let to: StateMachineSeed | undefined;

  if (current.lifecycle === "archived") {
    if (event.type === "bee.archive-corrected") {
      to = { lifecycle: "active", runtime: "parked", work: "done" };
    } else if (event.type === "bee.revived" && event.resume !== "needs-you") {
      to = { lifecycle: "active", runtime: "live", work: event.resume };
    }
  } else if (event.type === "bee.archived") {
    to = { lifecycle: "archived", runtime: "parked", work: "done" };
  } else if (
    event.type === "bee.archive-correction-restored" &&
    current.lifecycle === "active" && current.work === "working" &&
    (current.runtime === "recovering" || current.runtime === "live")
  ) {
    to = { lifecycle: "active", runtime: "parked", work: "done" };
  } else {
    switch (event.type) {
      case "turn.started":
        if (current.work === "spawning") to = { ...current, runtime: "live", work: "working" };
        break;
      case "turn.settled":
        if (current.work === "working") to = { ...current, runtime: "live", work: "done" };
        break;
      case "request.opened":
        if (current.work === "working" || current.work === "spawning") {
          to = { ...current, runtime: "live", work: "needs-you" };
        }
        break;
      case "runtime.lost":
        if (current.work === "working") to = { ...current, runtime: "recovering", work: "working" };
        break;
      case "recovery.succeeded":
        if (current.runtime === "recovering" && current.work === "working") {
          to = { ...current, runtime: "live", work: "working" };
        }
        break;
      case "recovery.failed":
        if (current.runtime === "recovering" && current.work === "working") {
          to = { ...current, runtime: "lost", work: "needs-you" };
        }
        break;
      case "request.resolved":
        if (current.work === "needs-you") to = { ...current, runtime: "live", work: "working" };
        break;
      case "turn.steered":
        if (current.work === "done") to = { ...current, runtime: "live", work: "working" };
        break;
      case "runtime.parked":
        // ADR: a needs-you turn has already stopped executing. Its open
        // intervention is durable state, not runner-owned in-flight work, so
        // verified runner death is idle-shaped: park without closing or
        // recovering the question. runtime.lost intentionally remains legal
        // only for working turns above.
        if ((current.work === "done" || current.work === "needs-you") &&
            (event.cause !== "intentional-idle-offload" || event.evidence.work === current.work)) {
          to = { ...current, runtime: "parked", work: current.work };
        }
        break;
      case "bee.revived":
        // A lazy replacement for an idle-shaped needs-you death restores only
        // runtime availability. The suspended work/request axis is unchanged.
        if (current.runtime === "parked" && current.work === "needs-you" && event.resume === "needs-you") {
          to = { ...current, runtime: "live", work: "needs-you" };
        } else if (current.runtime === "parked" && current.work === "done" && event.resume === "done") {
          to = { ...current, runtime: "live", work: "done" };
        }
        break;
    }
  }

  if (!to || sameAxes(current, to)) {
    throw new IllegalBeeTransitionError(
      `illegal ${event.type} transition from ${current.lifecycle}/${current.runtime}/${current.work}`,
    );
  }

  return {
    from: { ...current },
    to,
    receipt: {
      eventId: event.eventId,
      type: event.type,
      cause: event.cause,
      at: event.at,
      evidence: evidenceFor(event),
      ...("requestId" in event ? { requestId: event.requestId } : {}),
      ...(event.type === "bee.revived" ? { resume: event.resume } : {}),
    },
  };
}

export function makeStateMachineCursor(
  reduction: TransitionReduction,
  previousRevision = 0,
): BeeStateMachineCursor {
  return {
    ...reduction.to,
    revision: previousRevision + 1,
    transitionedAt: reduction.receipt.at,
    lastEventId: reduction.receipt.eventId,
    lastTransition: reduction.receipt,
  };
}

export function isBeeStateMachineCursor(value: unknown): value is BeeStateMachineCursor {
  if (!isRecord(value)) return false;
  if (value.lifecycle !== "active" && value.lifecycle !== "archived") return false;
  if (value.runtime !== "live" && value.runtime !== "parked" && value.runtime !== "recovering" && value.runtime !== "lost") return false;
  if (value.work !== "spawning" && value.work !== "working" && value.work !== "needs-you" && value.work !== "done") return false;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return false;
  if (!isIsoTimestamp(value.transitionedAt) || !isNonEmptyString(value.lastEventId)) return false;
  if (!isRecord(value.lastTransition) || value.lastTransition.eventId !== value.lastEventId ||
      value.lastTransition.at !== value.transitionedAt || !isNonEmptyString(value.lastTransition.type) ||
      !isNonEmptyString(value.lastTransition.cause) || !Array.isArray(value.lastTransition.evidence) ||
      !value.lastTransition.evidence.every(isTransitionEvidence)) return false;
  const terminalClaim = value.lifecycle === "archived" || value.runtime !== "live" || value.work === "done";
  if (terminalClaim && !value.lastTransition.evidence.some(isProbeEvidence)) return false;
  return true;
}
