/** Shared, lifecycle-serialized lazy wake for direct and queued sends. */

import { randomUUID } from "node:crypto";
import {
  assertReviveWorkingDirectory,
  reviveRecordInTransaction,
} from "../commands/migrate.js";
import {
  LifecycleConflictError,
  withSessionLifecycleTransaction,
  type SessionLifecycleTransaction,
} from "../lifecycle.js";
import { rebindOpenRequestsToGeneration } from "../requests/store.js";
import {
  legacyStateMachineSeed,
  loadSession,
  markSessionVerified,
  transitionSession,
  type SessionRecord,
} from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { probeHsrReAdoption } from "../daemon/reAdoption.js";
import { loadAdapterFor } from "../hsr/adapter-loader.js";
import type { ProbeEvidence } from "../stateMachine.js";

export type EnsureLiveRuntimeDeps = {
  isLive?: (record: SessionRecord) => Promise<boolean>;
  probe?: (record: SessionRecord) => Promise<ProbeEvidence>;
  reviveInTransaction?: (
    lifecycle: SessionLifecycleTransaction,
    options: Parameters<typeof reviveRecordInTransaction>[1],
  ) => Promise<SessionRecord>;
  transition?: typeof transitionSession;
  markVerified?: typeof markSessionVerified;
  assertCwd?: typeof assertReviveWorkingDirectory;
  loadRecord?: typeof loadSession;
  now?: () => number;
  makeActionId?: () => string;
  rebindRequests?: typeof rebindOpenRequestsToGeneration;
  canReconcilePendingInput?: (record: SessionRecord) => boolean | Promise<boolean>;
};

export type EnsureLiveRuntimeResult = {
  record: SessionRecord;
  woke: boolean;
  probe?: ProbeEvidence;
};

function axes(record: SessionRecord) {
  return record.stateMachine ?? legacyStateMachineSeed(record);
}

export class PendingInputRecoveryError extends Error {
  readonly code = "PENDING_INPUT_LOST_REISSUE_REQUIRED";

  constructor(record: SessionRecord) {
    super(
      `hive send: ${record.name} lost its provider-local pending-input handle; ` +
      `${record.agent} cannot reconcile pending input after resume, so the request must be reissued`,
    );
    this.name = "PendingInputRecoveryError";
  }
}

async function canReconcilePendingInput(record: SessionRecord, deps: EnsureLiveRuntimeDeps): Promise<boolean> {
  return (deps.canReconcilePendingInput ?? (async (candidate) =>
    (await loadAdapterFor(candidate.agent))?.pendingInputRecovery === "resume-reconcile"))(record);
}

async function markNeedsYouRuntimeResumed(
  record: SessionRecord,
  probe: ProbeEvidence,
  deps: EnsureLiveRuntimeDeps,
): Promise<SessionRecord> {
  if (axes(record).work !== "needs-you") return record;
  const actionId = `needs-you-runtime-revived:${probe.probeId}`;
  const transitioned = await (deps.transition ?? transitionSession)(record.name, {
    type: "bee.revived",
    eventId: `needs-you-runtime-revived:${probe.probeId}`,
    at: probe.observedAt,
    cause: "revive",
    resume: "needs-you",
    evidence: { kind: "operator", actionId, observedAt: probe.observedAt, action: "revive" },
    probe,
  });
  return transitioned?.record ?? record;
}

async function retryLifecycleConflict<T>(
  snapshot: SessionRecord,
  loadRecord: typeof loadSession,
  operation: (current: SessionRecord) => Promise<T>,
): Promise<T> {
  let current = snapshot;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation(current);
    } catch (error) {
      if (!(error instanceof LifecycleConflictError)) throw error;
      const latest = await loadRecord(snapshot.name);
      if (!latest) throw error;
      current = latest;
    }
  }
  throw new LifecycleConflictError(`Session ${snapshot.name} kept changing while ensuring a live runtime`);
}

/**
 * Transaction body shared by ensure-only callers and atomic wake+steer. The
 * caller owns the lifecycle lock for the whole operation.
 */
async function ensureLiveRuntimeInTransaction(
  lifecycle: SessionLifecycleTransaction,
  deps: EnsureLiveRuntimeDeps,
): Promise<EnsureLiveRuntimeResult> {
  let record = await lifecycle.refresh();
  const state = axes(record);
  if (state.lifecycle === "archived" || record.status === "done") {
    throw new Error(`hive send: ${record.name} is archived`);
  }

  const isLive = deps.isLive ?? ((candidate: SessionRecord) =>
    substrateFor(candidate).hasSession(candidate.tmuxTarget));
  if (state.runtime !== "parked" && await isLive(record)) {
    return { record, woke: false };
  }
  if (record.substrate !== "hsr") {
    throw new Error(`tmux session is not running: ${record.tmuxTarget}`);
  }

  const probe = await (deps.probe ?? (async (candidate) =>
    (await probeHsrReAdoption(candidate, `hive-send:${process.pid}`)).evidence))(record);
  if (probe.outcome === "unreachable") {
    throw new Error(`hive send: runtime state is unverified for ${record.name}: ${probe.detail ?? "probe unreachable"}`);
  }
  if (probe.outcome === "alive") {
    await (deps.markVerified ?? markSessionVerified)(record.name, probe);
    if (state.work === "needs-you") {
      await (deps.rebindRequests ?? rebindOpenRequestsToGeneration)(
        record.name,
        record.runtimeGeneration ?? 0,
      );
      record = await markNeedsYouRuntimeResumed(record, probe, deps);
    }
    return { record, woke: false, probe };
  }

  const currentAxes = axes(record);
  if (currentAxes.runtime === "lost") {
    await (deps.markVerified ?? markSessionVerified)(record.name, probe);
    throw new Error(`hive send: ${record.name} needs explicit hive revive after failed recovery`);
  }
  if (currentAxes.runtime === "recovering") {
    await (deps.markVerified ?? markSessionVerified)(record.name, probe);
    throw new Error(`hive send: ${record.name} is recovering; the accepted turn will resume automatically`);
  }
  if (currentAxes.runtime !== "parked") {
    if (currentAxes.work === "working" || currentAxes.work === "spawning") {
      throw new Error(`hive send: ${record.name} died mid-turn and must be recovered by the supervisor`);
    }
    // needs-you is idle-shaped for runtime death: the durable question is
    // still open, but no turn is executing. Park it before lazy respawn,
    // preserving the bounded work axis and request identity.
    const parked = await (deps.transition ?? transitionSession)(record.name, {
      type: "runtime.parked",
      eventId: `runtime-parked:${probe.probeId}`,
      at: probe.observedAt,
      cause: "idle-death",
      probe,
    });
    if (!parked) throw new Error(`hive send: session disappeared while parking ${record.name}`);
    record = await lifecycle.refresh();
  } else {
    // The parked classification is already durable; only now may this exact
    // dead proof clear a boot observer marker.
    await (deps.markVerified ?? markSessionVerified)(record.name, probe);
  }

  if (currentAxes.work === "needs-you" && !(await canReconcilePendingInput(record, deps))) {
    // The parked request record remains durable for diagnosis/reissue, but its
    // old answer handle died with the adapter process. Never revive, rebind,
    // and offer that stale handle to a replacement runner.
    throw new PendingInputRecoveryError(record);
  }

  await (deps.assertCwd ?? assertReviveWorkingDirectory)(record);
  const revived = await (deps.reviveInTransaction ?? reviveRecordInTransaction)(lifecycle, {
    fresh: false,
    deferRequestClosure: true,
  });
  const after = await (deps.probe ?? (async (candidate) =>
    (await probeHsrReAdoption(candidate, `hive-send:${process.pid}`)).evidence))(revived);
  if (after.outcome !== "alive") {
    throw new Error(`hive send: replacement runtime probe returned ${after.outcome} for ${record.name}`);
  }
  await (deps.markVerified ?? markSessionVerified)(record.name, after);
  if (currentAxes.work === "needs-you") {
    await (deps.rebindRequests ?? rebindOpenRequestsToGeneration)(
      record.name,
      revived.runtimeGeneration ?? 0,
    );
    return {
      record: await markNeedsYouRuntimeResumed(revived, after, deps),
      woke: true,
      probe: after,
    };
  }
  return { record: revived, woke: true, probe: after };
}

/**
 * Return a live runtime, lazily replacing only a probe-verified parked HSR.
 * The lifecycle lock makes concurrent direct/buz wake requests launch exactly
 * one replacement. A stale generation waits, reloads, and adopts that launch.
 */
export async function ensureLiveRuntimeForSend(
  snapshot: SessionRecord,
  deps: EnsureLiveRuntimeDeps = {},
): Promise<EnsureLiveRuntimeResult> {
  const loadRecord = deps.loadRecord ?? loadSession;
  return retryLifecycleConflict(snapshot, loadRecord, (current) =>
    withSessionLifecycleTransaction(current, (lifecycle) =>
      ensureLiveRuntimeInTransaction(lifecycle, deps)));
}

/** Emit the done→working steer edge once, serialized against concurrent sends. */
export async function markLiveRuntimeSteered(
  snapshot: SessionRecord,
  deps: EnsureLiveRuntimeDeps = {},
): Promise<SessionRecord> {
  const loadRecord = deps.loadRecord ?? loadSession;
  return retryLifecycleConflict(snapshot, loadRecord, (current) =>
    withSessionLifecycleTransaction(current, async (lifecycle) => {
      // Wake and publish working intent under one lifecycle lock. Intentional
      // parking can therefore run only before this transaction (then we wake
      // it) or after it (then work=working cancels the offload).
      const live = await ensureLiveRuntimeInTransaction(lifecycle, deps);
      const record = live.record;
      const state = axes(record);
      if (state.lifecycle !== "active" || state.work !== "done") return record;
      const at = new Date((deps.now ?? Date.now)()).toISOString();
      const actionId = (deps.makeActionId ?? randomUUID)();
      const transitioned = await (deps.transition ?? transitionSession)(record.name, {
        type: "turn.steered",
        eventId: `turn-steered:${actionId}`,
        at,
        cause: "steer",
        evidence: { kind: "operator", actionId, observedAt: at, action: "steer" },
      });
      return transitioned?.record ?? record;
    }));
}

/** The buz queue uses the same wake transaction, then exposes working state. */
export async function wakeRuntimeForQueuedSend(
  snapshot: SessionRecord,
  deps: EnsureLiveRuntimeDeps = {},
): Promise<SessionRecord> {
  return markLiveRuntimeSteered(snapshot, deps);
}
