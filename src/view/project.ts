/**
 * BeeView V1 pure projection (docs/BEEVIEW_READ_API.md §1-§2).
 *
 * projectBeeView folds one SessionRecord plus this pass's gathered evidence
 * (StateContext, latest seal of the current incarnation, HSR event snapshot,
 * live @hive_state) into a BeeViewV1. Pure: no IO, no writes, deterministic
 * given its sources — view/context.ts owns the gathering.
 *
 * displayState is RECOMPOSED from facts per the ADR 001 precedence — it is not
 * a rename of BeeState. Deliberate divergences from deriveState:
 *   - sealed-but-live projects as `ready` + latestContractResult (completion
 *     never changes display state — ADR invariant 7);
 *   - idle_with_output projects as `ready` + latestTurnResult;
 *   - wedged/error project as `needs-action` with a synthesized observer-grade
 *     manual-action request; kill_failed → `stop-failed`; node_unreachable →
 *     `unreachable` (observer-grade: today's node probe is not a heartbeat
 *     contract).
 */

import { effectiveHiveState } from "../hiveState.js";
import { structuredStateFromEvents, type HsrEventSnapshot } from "../hsr/observe.js";
import type { RunnerEvent } from "../hsr/types.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { isWellFormedPaneId } from "../paneId.js";
import type { InterventionRequestRecord } from "../requests/store.js";
import type { SealRecord } from "../seal.js";
import { deriveState, liveTargetKey, parseBeeState, type BeeState, type DerivedState, type StateContext } from "../state.js";
import { isActiveSessionLifecycle, isArchivedSessionLifecycle, type BeeWorkState } from "../stateMachine.js";
import { legacyStateMachineSeed, type SessionRecord } from "../store.js";
import { deriveOpenRequests, storedRequestView } from "./requests.js";
import {
  BEE_VIEW_SCHEMA_VERSION,
  type BeeDisplayState,
  type BeeViewBee,
  type BeeViewContractResult,
  type BeeViewEvidence,
  type BeeViewObservationFreshness,
  type BeeViewRequest,
  type BeeViewRuntime,
  type BeeViewTurnResult,
  type BeeViewV1,
  type ObservationSourceFreshness,
} from "./types.js";

/** Everything projectBeeView needs, gathered by one observation pass. */
export type BeeViewProjectionSources = {
  record: SessionRecord;
  /** The StateContext this pass derived from (view/context.ts assembles it). */
  context: StateContext;
  /** Latest seal of the CURRENT incarnation (sealHighWaterFilename-gated). */
  latestSeal?: SealRecord | null;
  /** Filename that contained latestSeal, for evidence detail. */
  latestSealFilename?: string | null;
  /** Structured HSR event snapshot, when the bee's run dir was read this pass. */
  eventSnapshot?: HsrEventSnapshot;
  /** Raw live @hive_state for the bee's session; undefined/"" when unset. */
  hiveStateOption?: string;
  /** Provider root thread id (HSR meta.sessionId) scoping turn lifecycle events. */
  rootThreadId?: string;
  /**
   * Durable request records for this bee (src/requests/store.ts), when its
   * store file was read this pass. Store-open records are authoritative for
   * openRequests; closed ones feed recentClosedRequests. view/* only READS
   * the store — the daemon and CLI verbs own every mutation.
   */
  storedRequests?: InterventionRequestRecord[];
  now?: number;
};

/** How old a daemon lastObservedStateAt stamp may be and still read "fresh". */
const DAEMON_OBSERVATION_FRESH_MS = 120_000;

export function projectBeeView(sources: BeeViewProjectionSources): BeeViewV1 {
  const { record, context } = sources;
  const nowMs = sources.now ?? context.now ?? Date.now();
  const derived = deriveState(record, context);
  const generation = record.runtimeGeneration ?? 0;
  const nodeName = record.node && record.node.length > 0 ? record.node : LOCAL_NODE_NAME;
  const unreachable = context.unreachableNodes?.has(nodeName) === true;
  const held = context.hsrUnavailable?.has(record.name) === true;
  const hiveStateOption = sources.hiveStateOption && sources.hiveStateOption.length > 0 ? sources.hiveStateOption : undefined;
  // Once present, the proof-carrying cursor is authoritative. Legacy
  // status:done is retirement only for records with no canonical cursor; a
  // stale mixed-version scalar must not archive an explicitly active bee.
  const machine = record.stateMachine ?? legacyStateMachineSeed(record);

  const bee = projectBee(record, nodeName, machine.lifecycle);
  const latestRuntime = projectRuntime(record, context, derived, machine.runtime, { generation, unreachable, held });
  // Runtime-generation and turn requests close with an exited generation.
  // Bee-scoped manual actions (for example an undeliverable accepted message)
  // deliberately survive runtime exit and remain renderable until resolved.
  const derivedRequests = bee.lifecycleState === "archived"
    ? []
    : deriveOpenRequests({
        record,
        context,
        derived,
        generation,
        ...(sources.eventSnapshot ? { eventSnapshot: sources.eventSnapshot } : {}),
        ...(sources.storedRequests ? { storedRequests: sources.storedRequests } : {}),
        now: nowMs,
      });
  const transitionRequest = transitionRequestFallback(record);
  const requestsWithRecovery = transitionRequest && !derivedRequests.some((request) => request.id === transitionRequest.id)
    ? [...derivedRequests, transitionRequest]
    : derivedRequests;
  const openRequests = latestRuntime.state === "exited"
    ? requestsWithRecovery.filter((request) => request.scope === "bee")
    : requestsWithRecovery;
  // Closed history (resolved/cancelled), newest first, capped at 5 — shown
  // for retired bees too (retire keeps the request file on purpose).
  const recentClosedRequests = (sources.storedRequests ?? [])
    .filter((request) => request.status !== "open")
    .sort((a, b) => closedRequestAt(b) - closedRequestAt(a))
    .slice(0, 5)
    .map(storedRequestView);
  const latestTurnResult = projectTurnResult(sources, derived, latestRuntime, hiveStateOption, nowMs);
  const latestContractResult = projectContractResult(sources);
  const { displayState, displayStateReason } = chooseDisplayState({
    bee,
    derived,
    latestRuntime,
    openRequests,
    boundedWork: record.stateMachine?.work,
    nodeName,
    unreachable,
  });

  const resultTimes = [latestContractResult?.sealedAt, latestTurnResult?.endedAt]
    .filter((value): value is string => typeof value === "string")
    .sort();
  const inboxSummary = {
    openRequestCounts: {
      needsReply: openRequests.filter((request) => request.kind === "question" || request.kind === "permission").length,
      needsAuth: openRequests.filter((request) => request.kind === "auth").length,
      needsAction: openRequests.filter((request) => request.kind === "manual-action").length,
    },
    hasUnretiredResult: bee.lifecycleState !== "archived" && (latestContractResult !== undefined || latestTurnResult !== undefined),
    ...(resultTimes.length > 0 ? { latestResultAt: resultTimes[resultTimes.length - 1] } : {}),
  };

  return {
    schemaVersion: BEE_VIEW_SCHEMA_VERSION,
    bee,
    latestRuntime,
    // currentTurn stays absent until Turn ids land (schemaVersion 1, reserved).
    openRequests,
    ...(recentClosedRequests.length > 0 ? { recentClosedRequests } : {}),
    ...(latestTurnResult ? { latestTurnResult } : {}),
    ...(latestContractResult ? { latestContractResult } : {}),
    inboxSummary,
    interactionState: interactionStateFor(record, derived, latestRuntime),
    displayState,
    displayStateReason,
    observationFreshness: projectFreshness(sources, derived, { unreachable, held, hiveStateOption, nowMs }),
    verification: projectVerification(record),
    lastProjectedAt: new Date(nowMs).toISOString(),
    compatibilityFields: {
      beeState: derived.state,
      beeStateDetail: derived.detail,
      sessionStatus: record.status,
      ...(hiveStateOption !== undefined ? { hiveStateOption } : {}),
      ...(effectiveHiveState(hiveStateOption, derived.state) !== undefined
        ? { effectiveHiveState: effectiveHiveState(hiveStateOption, derived.state) }
        : {}),
      ...(record.lastObservedState !== undefined ? { lastObservedState: record.lastObservedState } : {}),
      ...(record.lastObservedStateAt !== undefined ? { lastObservedStateAt: record.lastObservedStateAt } : {}),
    },
  };
}

function projectBee(record: SessionRecord, nodeName: string, lifecycleState: BeeViewBee["lifecycleState"]): BeeViewBee {
  const taskAttribution = record.runId !== undefined || record.flowName !== undefined
    ? { ...(record.runId !== undefined ? { runId: record.runId } : {}), ...(record.flowName !== undefined ? { flowName: record.flowName } : {}) }
    : undefined;
  return {
    id: record.id ?? record.name,
    name: record.name,
    ...(record.uuid !== undefined ? { uuid: record.uuid } : {}),
    ...(record.title !== undefined ? { title: record.title } : {}),
    agent: record.agent,
    cwd: record.cwd,
    ...(record.colony !== undefined ? { colony: record.colony } : {}),
    ...(record.swarmId !== undefined ? { swarmId: record.swarmId } : {}),
    tags: record.tags ?? [],
    node: nodeName,
    lifecycle: lifecycleState === "archived" ? "retired" : "active",
    lifecycleState,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.contract !== undefined ? { contract: record.contract } : {}),
    ...(record.spawnedById !== undefined ? { spawnedById: record.spawnedById } : {}),
    ...(taskAttribution ? { taskAttribution } : {}),
  };
}

/** Liveness probe result + the evidence it was concluded from. */
function runtimeLiveness(record: SessionRecord, context: StateContext): { live: boolean; evidence: BeeViewEvidence } {
  if (record.substrate === "hsr" || context.hsrMirrors?.has(record.name)) {
    const live = context.hsrLive?.has(record.name) ?? false;
    return {
      live,
      evidence: { grade: "observer", source: "hsr-meta", detail: live ? "runner host pid alive" : "no live runner host" },
    };
  }
  // Mirror deriveState: a live pane proves the bee live, but a pane id absent
  // from livePanes is not proof of death (mis-stamped ids, partial listings) —
  // tmux session liveness gets the final word before rendering crashed.
  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  const sessionLive = context.liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)) || context.liveTargets.has(record.tmuxTarget);
  const pinnedPaneId = record.agentPaneId && isWellFormedPaneId(record.agentPaneId) ? record.agentPaneId : undefined;
  if (pinnedPaneId && context.livePanes && isLocal && context.livePanes.has(pinnedPaneId)) {
    return {
      live: true,
      evidence: { grade: "observer", source: "node-probe", detail: `agent pane ${pinnedPaneId} present` },
    };
  }
  return {
    live: sessionLive,
    evidence: { grade: "observer", source: "node-probe", detail: `tmux session ${sessionLive ? "live" : "gone"}` },
  };
}

function projectRuntime(
  record: SessionRecord,
  context: StateContext,
  derived: DerivedState,
  runtimeState: BeeViewRuntime["runtimeState"],
  facts: { generation: number; unreachable: boolean; held: boolean },
): BeeViewRuntime {
  const base = {
    generation: facts.generation,
    runtimeState,
    substrate: record.substrate === "hsr" ? ("hsr" as const) : ("local-tmux" as const),
    tmuxTarget: record.tmuxTarget,
    ...(record.agentPaneId !== undefined ? { agentPaneId: record.agentPaneId } : {}),
    ...(record.runnerPid !== undefined ? { runnerPid: record.runnerPid } : {}),
    ...(record.runnerTier !== undefined ? { runnerTier: record.runnerTier } : {}),
    ...(record.providerSessionId !== undefined ? { providerSessionId: record.providerSessionId } : {}),
  };

  if (isArchivedSessionLifecycle(record)) {
    // A filed bee's runtime was torn down by retire/quest done: recorded intent.
    return {
      ...base,
      state: "exited",
      exitClass: "stopped",
      evidence: { grade: "legacy", source: "session-record", detail: 'record filed (status "done")' },
    };
  }
  // `kill_failed` is orthogonal stop-doubt evidence, not a legacy lifecycle
  // scalar. Keep it visible through every active-runtime projection (including
  // recovering/parked/lost/unreachable/held) so the view cannot accidentally
  // present an ownership-held Bee as ready or merely crashed.
  const activeBase = record.status === "kill_failed" ? { ...base, stopFailed: true as const } : base;
  if (runtimeState === "recovering") {
    return {
      ...activeBase,
      state: "starting",
      evidence: {
        grade: "structured",
        source: "state-transition",
        observedAt: record.stateMachine?.transitionedAt,
        detail: "probe-verified mid-turn death; recovery in progress",
      },
    };
  }
  if (runtimeState === "parked") {
    return {
      ...activeBase,
      state: "exited",
      exitClass: "stopped",
      evidence: {
        grade: "structured",
        source: "state-transition",
        observedAt: record.stateMachine?.transitionedAt,
        detail: "idle runtime parked after a negative liveness probe",
      },
    };
  }
  if (runtimeState === "lost") {
    return {
      ...activeBase,
      state: "exited",
      exitClass: "crashed",
      evidence: {
        grade: "structured",
        source: "state-transition",
        observedAt: record.stateMachine?.transitionedAt,
        detail: "runtime loss persisted with probe evidence",
      },
    };
  }
  if (facts.unreachable) {
    return {
      ...activeBase,
      state: "unknown",
      evidence: { grade: "observer", source: "node-probe", detail: `node ${record.node ?? LOCAL_NODE_NAME} did not respond this pass` },
    };
  }
  if (facts.held) {
    return {
      ...activeBase,
      state: "unknown",
      evidence: { grade: "legacy", source: "session-record", detail: "HSR observation batch failed this pass — state held" },
    };
  }

  const { live, evidence } = runtimeLiveness(record, context);
  if (record.status === "kill_failed") {
    // The stop failed; the runtime may still be alive (ADR: a failed stop
    // leaves the generation online). A negative probe means it finally exited
    // under the recorded stop intent.
    if (live) return { ...activeBase, state: "online", evidence };
    return { ...activeBase, state: "exited", exitClass: "stopped", evidence };
  }
  if (!live && record.recoveryRequestedAt) {
    return {
      ...base,
      state: "starting",
      evidence: {
        grade: "structured",
        source: "session-record",
        observedAt: record.recoveryRequestedAt,
        detail: "durable message recovery requested",
      },
    };
  }
  if (!live) {
    return {
      ...base,
      state: "exited",
      exitClass: isActiveSessionLifecycle(record) ? "crashed" : "stopped",
      evidence,
    };
  }
  if (derived.state === "booting" || derived.state === "queued") {
    return { ...base, state: "starting", evidence };
  }
  return { ...base, state: "online", evidence };
}

function isoFromEpochMs(ts: number): string | undefined {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : undefined;
}

/** When a stored request closed (for newest-first history ordering). */
function closedRequestAt(record: InterventionRequestRecord): number {
  const parsed = Date.parse(record.resolvedAt ?? record.cancelledAt ?? record.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Store-backed requests win; the proof-carrying transition is the daemon-down fallback. */
function transitionRequestFallback(record: SessionRecord): BeeViewRequest | undefined {
  const transition = record.stateMachine?.lastTransition;
  if (record.stateMachine?.work !== "needs-you" || !transition?.requestId) {
    return undefined;
  }
  if (transition.type === "request.opened") {
    const kind = transition.cause === "auth" ? "auth" : transition.cause === "question" ? "question" : "permission";
    return {
      id: transition.requestId,
      kind,
      status: "open",
      scope: "turn",
      grade: "structured",
      openedAt: transition.at,
      question: transition.cause === "auth" ? "Authentication is required." : "The bee is waiting for your response.",
      evidence: {
        grade: "structured",
        source: "state-transition",
        observedAt: transition.at,
        detail: `request.opened (${transition.cause})`,
      },
    };
  }
  if (transition.type !== "recovery.failed") return undefined;
  return {
    id: transition.requestId,
    kind: "manual-action",
    status: "open",
    scope: "bee",
    grade: "structured",
    openedAt: transition.at,
    question: "Automatic recovery failed after its retry budget was exhausted.",
    input: { evidence: transition.evidence },
    evidence: {
      grade: "structured",
      source: "state-transition",
      observedAt: transition.at,
      detail: `recovery.failed (${transition.cause})`,
    },
  };
}

function projectVerification(record: SessionRecord): BeeViewV1["verification"] {
  const marker = record.stateUnverified;
  if (!marker) return { unverified: false };
  return {
    unverified: true,
    unverifiedSince: marker.since,
    reason: marker.reason,
    probeScheduledAt: marker.probeScheduledAt,
    ...(marker.lastVerifiedAt ? { lastVerifiedAt: marker.lastVerifiedAt } : {}),
    ...(marker.observer ? { observerOffline: marker.observer } : {}),
  };
}

/** Last lifecycle event of `type`, honoring the root-thread scoping rule. */
function lastLifecycleEvent(
  events: RunnerEvent[],
  type: "turn_start" | "turn_end",
  rootThreadId: string | undefined,
): RunnerEvent | undefined {
  let found: RunnerEvent | undefined;
  for (const event of events) {
    if (event.type !== type) continue;
    const threadId = "threadId" in event && typeof event.threadId === "string" && event.threadId.length > 0 ? event.threadId : undefined;
    // Legacy events predate lifecycle thread ids; keep treating them as root.
    if (rootThreadId && threadId !== undefined && threadId !== rootThreadId) continue;
    found = event;
  }
  return found;
}

function projectTurnResult(
  sources: BeeViewProjectionSources,
  derived: DerivedState,
  runtime: BeeViewRuntime,
  hiveStateOption: string | undefined,
  nowMs: number,
): BeeViewTurnResult | undefined {
  const { record, eventSnapshot, rootThreadId } = sources;
  const events = eventSnapshot?.events ?? [];
  const structuredState = eventSnapshot ? structuredStateFromEvents(events, { rootThreadId }) : undefined;

  // A crashed runtime interrupts a still-running turn (ADR TurnEndEvidence
  // "runtime-exit"). The mid-turn fact comes from structured events when we
  // have them, else from the persisted lastObservedState cache (legacy grade).
  if (runtime.state === "exited" && runtime.exitClass === "crashed") {
    if (structuredState === "active") {
      return {
        outcome: "interrupted",
        evidence: { grade: "observer", source: "hsr-meta", detail: "runtime exited with an open turn (turn_start without turn_end)" },
      };
    }
    if (parseBeeState(record.lastObservedState) === "active") {
      return {
        outcome: "interrupted",
        evidence: {
          grade: "legacy",
          source: "session-record",
          ...(record.lastObservedStateAt !== undefined ? { observedAt: record.lastObservedStateAt } : {}),
          detail: "runtime exited while last observed active",
        },
      };
    }
    if (structuredState === "idle_with_output") {
      const end = lastLifecycleEvent(events, "turn_end", rootThreadId);
      const endedAt = end ? isoFromEpochMs(end.ts) : undefined;
      return {
        outcome: "responded",
        ...(endedAt !== undefined ? { endedAt } : {}),
        evidence: { grade: "structured", source: "hsr-events", ...(endedAt !== undefined ? { observedAt: endedAt } : {}), detail: "turn_end before exit" },
      };
    }
    return undefined;
  }

  // A runner error is a failed latest response.
  if (derived.state === "error") {
    const errorEvent = [...events].reverse().find((event) => event.type === "error");
    if (errorEvent) {
      const at = isoFromEpochMs(errorEvent.ts);
      return {
        outcome: "failed",
        ...(at !== undefined ? { endedAt: at } : {}),
        evidence: { grade: "structured", source: "hsr-events", ...(at !== undefined ? { observedAt: at } : {}), detail: "error event" },
      };
    }
    return {
      outcome: "failed",
      evidence: { grade: "legacy", source: "session-record", detail: record.lastError ?? "runner error" },
    };
  }

  // Structured turn_end closed the latest turn: responded, regardless of
  // whether output has since settled on a pane.
  if (structuredState === "idle_with_output") {
    const end = lastLifecycleEvent(events, "turn_end", rootThreadId);
    const endedAt = end ? isoFromEpochMs(end.ts) : undefined;
    return {
      outcome: "responded",
      ...(endedAt !== undefined ? { endedAt } : {}),
      evidence: { grade: "structured", source: "hsr-events", ...(endedAt !== undefined ? { observedAt: endedAt } : {}), detail: "turn_end" },
    };
  }

  if (derived.state === "idle_with_output") {
    // Hook evidence: an agent Stop hook stamped @hive_state=done.
    if (hiveStateOption === "done") {
      return {
        outcome: "responded",
        evidence: { grade: "hook", source: "hive-state-option", detail: "@hive_state=done (Stop hook)" },
      };
    }
    // Observer-only settling: an honest terminal outcome for unstructured
    // agents — pane idleness must never be translated into success.
    const source = record.substrate === "hsr" || sources.context.hsrMirrors?.has(record.name) ? "hsr-ring" : "pane-capture";
    return {
      outcome: "settled-unverified",
      evidence: {
        grade: "observer",
        source,
        observedAt: new Date(nowMs).toISOString(),
        detail: "output settled without structured turn evidence",
      },
    };
  }

  return undefined;
}

function projectContractResult(sources: BeeViewProjectionSources): BeeViewContractResult | undefined {
  const seal = sources.latestSeal;
  if (!seal) return undefined;
  const contract = sources.record.contract;
  let matchesContract: boolean | undefined;
  if (contract) {
    // Every key the contract demands must be carried VERBATIM by the seal. A
    // keyless seal against a keyed contract is a reviewable artifact, not
    // contract completion (ADR ContractResult rule).
    matchesContract =
      (contract.taskId === undefined || seal.taskId === contract.taskId) &&
      (contract.attempt === undefined || seal.attempt === contract.attempt) &&
      (contract.sealType === undefined || seal.type === contract.sealType);
  }
  return {
    verdict: seal.status === "done" ? "success" : seal.status === "failed" ? "failed" : "blocked",
    sealStatus: seal.status,
    sealType: seal.type ?? "implementation",
    sealedAt: seal.sealedAt,
    ...(seal.taskId !== undefined ? { taskId: seal.taskId } : {}),
    ...(seal.attempt !== undefined ? { attempt: seal.attempt } : {}),
    ...(matchesContract !== undefined ? { matchesContract } : {}),
    evidence: {
      grade: "structured",
      source: "seal",
      observedAt: seal.sealedAt,
      ...(sources.latestSealFilename ? { detail: sources.latestSealFilename } : {}),
    },
  };
}

function chooseDisplayState(facts: {
  bee: BeeViewBee;
  derived: DerivedState;
  latestRuntime: BeeViewRuntime;
  openRequests: BeeViewRequest[];
  boundedWork?: BeeWorkState;
  nodeName: string;
  unreachable: boolean;
}): { displayState: BeeDisplayState; displayStateReason: string } {
  const { bee, derived, latestRuntime, openRequests } = facts;

  // ADR 001 precedence, top to bottom. Each rule names itself in the reason.
  if (bee.lifecycleState === "archived") {
    return { displayState: "retired", displayStateReason: 'retired — bee lifecycle is retired (record filed as "done")' };
  }
  const auth = openRequests.find((request) => request.kind === "auth");
  if (auth) {
    return { displayState: "needs-auth", displayStateReason: `needs-auth — open auth request (${auth.grade}, id=${auth.id})` };
  }
  const reply = openRequests.find((request) => request.kind === "question" || request.kind === "permission");
  if (reply) {
    return { displayState: "needs-reply", displayStateReason: `needs-reply — open ${reply.kind} request (${reply.grade}, id=${reply.id})` };
  }
  const action = openRequests.find((request) => request.kind === "manual-action");
  if (action) {
    return { displayState: "needs-action", displayStateReason: `needs-action — open manual-action request (${action.grade}, id=${action.id})` };
  }
  if (latestRuntime.stopFailed) {
    return { displayState: "stop-failed", displayStateReason: "stop-failed — the latest stop request failed (status kill_failed); the runtime may still be alive" };
  }
  if (latestRuntime.runtimeState === "recovering") {
    return { displayState: "recovering", displayStateReason: "recovering — probe-verified mid-turn runtime loss is being revived" };
  }
  if (latestRuntime.runtimeState === "parked") {
    return { displayState: "ready", displayStateReason: "ready — no running turn" };
  }
  if (latestRuntime.state === "exited" && latestRuntime.exitClass === "crashed") {
    return { displayState: "crashed", displayStateReason: "crashed — the latest generation exited without stop intent" };
  }
  if (facts.unreachable) {
    return {
      displayState: "unreachable",
      displayStateReason: `unreachable — node ${facts.nodeName} did not respond this pass (observer-grade; not a heartbeat contract)`,
    };
  }
  if (latestRuntime.state === "starting") {
    return { displayState: "starting", displayStateReason: `starting — the latest generation is ${derived.state}` };
  }
  if (facts.boundedWork === "working") {
    return { displayState: "working", displayStateReason: "working — bounded state cursor has a running turn" };
  }
  if (facts.boundedWork === "done") {
    return { displayState: "ready", displayStateReason: "ready — bounded state cursor has a settled turn" };
  }
  if (derivedMeansRunningTurn(derived.state)) {
    return { displayState: "working", displayStateReason: "working — the latest generation is online with a running turn" };
  }
  if (latestRuntime.state === "online" || latestRuntime.state === "unknown") {
    // ready covers idle_with_output (see latestTurnResult) and sealed-but-live
    // (see latestContractResult): completion never changes display state.
    if (derived.state === "done") {
      return { displayState: "ready", displayStateReason: "ready — sealed but live; completion never changes display state (see latestContractResult)" };
    }
    if (derived.state === "idle_with_output") {
      return { displayState: "ready", displayStateReason: "ready — output settled, no running turn (see latestTurnResult)" };
    }
    return { displayState: "ready", displayStateReason: "ready — the latest generation is online without a running turn" };
  }
  return { displayState: "offline", displayStateReason: "offline — no online generation; the bee is revivable" };
}

function derivedMeansRunningTurn(state: BeeState): boolean {
  return state === "active";
}

function interactionStateFor(
  record: SessionRecord,
  derived: DerivedState,
  runtime: BeeViewRuntime,
): BeeViewV1["interactionState"] {
  if (isArchivedSessionLifecycle(record)) return "archived";
  // Stop doubt is orthogonal to runtime liveness. A positive probe proves
  // identity/existence, not permission to resume work after an explicit stop;
  // expose a distinct active-but-non-interactive state on every runtime axis.
  if (record.status === "kill_failed") return "blocked";
  if (runtime.runtimeState === "recovering") return "working";
  return derivedMeansRunningTurn(derived.state) ? "working" : "idle";
}

function projectFreshness(
  sources: BeeViewProjectionSources,
  derived: DerivedState,
  facts: { unreachable: boolean; held: boolean; hiveStateOption: string | undefined; nowMs: number },
): BeeViewObservationFreshness {
  const { record, context, eventSnapshot } = sources;
  const nowIso = new Date(facts.nowMs).toISOString();
  const entries: ObservationSourceFreshness[] = [];

  // node-probe: this pass either heard from the bee's node or it didn't.
  entries.push(
    facts.unreachable
      ? {
          source: "node-probe",
          status: "missing",
          caveat: `node ${record.node ?? LOCAL_NODE_NAME} did not respond this pass; today's node probe is not a heartbeat contract`,
        }
      : { source: "node-probe", status: "fresh", observedAt: nowIso, ageMs: 0 },
  );

  const isHsrObserved = record.substrate === "hsr" || context.hsrMirrors?.has(record.name) === true;
  if (isHsrObserved) {
    if (facts.held) {
      entries.push({
        source: "hsr-events",
        status: "missing",
        caveat: "HSR observation batch failed this pass — state held",
      });
    } else if (eventSnapshot) {
      const lastTs = [...eventSnapshot.events].reverse().find((event) => Number.isFinite(event.ts))?.ts;
      const observedAt = lastTs !== undefined ? isoFromEpochMs(lastTs) : undefined;
      entries.push({
        source: "hsr-events",
        status: "fresh",
        ...(observedAt !== undefined ? { observedAt } : {}),
        ...(lastTs !== undefined && Number.isFinite(lastTs) ? { ageMs: Math.max(0, facts.nowMs - lastTs) } : {}),
      });
    } else {
      entries.push({ source: "hsr-events", status: "missing", caveat: "no event snapshot read this pass" });
    }
  } else {
    const paneKey = record.agentPaneId ?? record.tmuxTarget;
    const pane = context.panes?.get(paneKey);
    if (pane !== undefined) {
      entries.push({ source: "pane-capture", status: "fresh", observedAt: nowIso, ageMs: 0 });
    } else if (!facts.unreachable && derived.state !== "dead" && derived.state !== "done" && isActiveSessionLifecycle(record)) {
      entries.push({ source: "pane-capture", status: "missing", caveat: "pane capture unavailable this pass" });
    }
  }

  if (facts.hiveStateOption !== undefined) {
    entries.push({
      source: "hive-state-option",
      status: "untimed",
      caveat: "@hive_state carries no timestamp",
    });
  }

  if (record.lastObservedState !== undefined) {
    const at = record.lastObservedStateAt !== undefined ? Date.parse(record.lastObservedStateAt) : NaN;
    if (Number.isFinite(at)) {
      const ageMs = Math.max(0, facts.nowMs - at);
      entries.push({
        source: "daemon-observation",
        status: ageMs <= DAEMON_OBSERVATION_FRESH_MS ? "fresh" : "stale",
        observedAt: record.lastObservedStateAt,
        ageMs,
        caveat: "lastObservedStateAt is a fleet-wide sweep stamp; do not use for turn timing",
      });
    } else {
      entries.push({
        source: "daemon-observation",
        status: "untimed",
        caveat: "lastObservedState persisted without a parseable timestamp",
      });
    }
  }

  return {
    observedLive: !facts.unreachable && !facts.held,
    sources: entries,
  };
}
