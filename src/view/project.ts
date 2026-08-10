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
import type { InterventionRequestRecord } from "../requests/store.js";
import type { SealRecord } from "../seal.js";
import { deriveState, liveTargetKey, parseBeeState, type BeeState, type DerivedState, type StateContext } from "../state.js";
import type { SessionRecord } from "../store.js";
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

  const bee = projectBee(record, nodeName);
  const latestRuntime = projectRuntime(record, context, derived, { generation, unreachable, held });
  // Scope closure is inherent: a retired bee or an exited runtime has no open
  // requests — re-derivation from current evidence closes them naturally.
  const openRequests = bee.lifecycle === "retired" || latestRuntime.state === "exited"
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
    hasUnretiredResult: bee.lifecycle !== "retired" && (latestContractResult !== undefined || latestTurnResult !== undefined),
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
    interactionState: interactionStateFor(record, context, derived, latestRuntime),
    displayState,
    displayStateReason,
    observationFreshness: projectFreshness(sources, derived, { unreachable, held, hiveStateOption, nowMs }),
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

function projectBee(record: SessionRecord, nodeName: string): BeeViewBee {
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
    lifecycle: record.status === "done" ? "retired" : "active",
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
  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  if (record.agentPaneId && context.livePanes && isLocal) {
    const live = context.livePanes.has(record.agentPaneId);
    return {
      live,
      evidence: { grade: "observer", source: "node-probe", detail: `agent pane ${record.agentPaneId} ${live ? "present" : "gone"}` },
    };
  }
  const live = context.liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)) || context.liveTargets.has(record.tmuxTarget);
  return {
    live,
    evidence: { grade: "observer", source: "node-probe", detail: `tmux session ${live ? "live" : "gone"}` },
  };
}

function projectRuntime(
  record: SessionRecord,
  context: StateContext,
  derived: DerivedState,
  facts: { generation: number; unreachable: boolean; held: boolean },
): BeeViewRuntime {
  const base = {
    generation: facts.generation,
    substrate: record.substrate === "hsr" ? ("hsr" as const) : ("local-tmux" as const),
    tmuxTarget: record.tmuxTarget,
    ...(record.agentPaneId !== undefined ? { agentPaneId: record.agentPaneId } : {}),
    ...(record.runnerPid !== undefined ? { runnerPid: record.runnerPid } : {}),
    ...(record.runnerTier !== undefined ? { runnerTier: record.runnerTier } : {}),
    ...(record.providerSessionId !== undefined ? { providerSessionId: record.providerSessionId } : {}),
  };

  if (record.status === "done") {
    // A filed bee's runtime was torn down by retire/quest done: recorded intent.
    return {
      ...base,
      state: "exited",
      exitClass: "stopped",
      evidence: { grade: "legacy", source: "session-record", detail: 'record filed (status "done")' },
    };
  }
  if (facts.unreachable) {
    return {
      ...base,
      state: "unknown",
      evidence: { grade: "observer", source: "node-probe", detail: `node ${record.node ?? LOCAL_NODE_NAME} did not respond this pass` },
    };
  }
  if (facts.held) {
    return {
      ...base,
      state: "unknown",
      evidence: { grade: "legacy", source: "session-record", detail: "HSR observation batch failed this pass — state held" },
    };
  }

  const { live, evidence } = runtimeLiveness(record, context);
  if (record.status === "kill_failed") {
    // The stop failed; the runtime may still be alive (ADR: a failed stop
    // leaves the generation online). A negative probe means it finally exited
    // under the recorded stop intent.
    if (live) return { ...base, state: "online", stopFailed: true, evidence };
    return { ...base, state: "exited", exitClass: "stopped", stopFailed: true, evidence };
  }
  if (!live) {
    return {
      ...base,
      state: "exited",
      exitClass: record.status === "running" ? "crashed" : "stopped",
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
  nodeName: string;
  unreachable: boolean;
}): { displayState: BeeDisplayState; displayStateReason: string } {
  const { bee, derived, latestRuntime, openRequests } = facts;

  // ADR 001 precedence, top to bottom. Each rule names itself in the reason.
  if (bee.lifecycle === "retired") {
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
  context: StateContext,
  derived: DerivedState,
  runtime: BeeViewRuntime,
): BeeViewV1["interactionState"] {
  if (record.status === "done") return "archived";
  if (record.status !== "kill_failed") {
    return derivedMeansRunningTurn(derived.state) ? "working" : "idle";
  }

  // kill_failed records encode unresolved stop intent, not runtime death. A
  // positive liveness probe keeps the bee interactive; re-derive without the
  // diagnostic status override so a still-running turn remains `working`.
  if (runtime.state === "exited") return "archived";
  const liveState = deriveState({ ...record, status: "running" }, context);
  return derivedMeansRunningTurn(liveState.state) ? "working" : "idle";
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
    } else if (!facts.unreachable && derived.state !== "dead" && derived.state !== "done" && record.status === "running") {
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
