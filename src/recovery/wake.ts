/** Shared, lifecycle-serialized lazy wake for direct and queued sends. */

import { randomUUID } from "node:crypto";
import { assertNoUnresolvedHsrAnswerOwnership } from "../answerReceipt.js";
import {
  assertReviveWorkingDirectory,
  reviveRecordInTransaction,
} from "../commands/migrate.js";
import {
  LifecycleConflictError,
  withSessionLifecycleTransaction,
  type SessionLifecycleTransaction,
} from "../lifecycle.js";
import { assertNoUnresolvedBeeNameLaunchReservationInAdmission } from "../nameAdmission.js";
import { assertNoUnresolvedHsrEventIntegrity } from "../hsr/eventIntegrity.js";
import { rebindOpenRequestsToGeneration } from "../requests/store.js";
import {
  legacyStateMachineSeed,
  loadSession,
  markSessionVerified,
  transitionSession,
  type SessionRecord,
} from "../store.js";
import { substrateFor } from "../substrates/index.js";
import type { Substrate } from "../substrates/types.js";
import { isArchivedSessionLifecycle, isRunnableSessionRecord, type ProbeEvidence } from "../stateMachine.js";
import { probeRecoverableRuntime } from "./runtimeProbe.js";

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
  resolveSubstrate?: (record: SessionRecord) => Substrate;
};

export type EnsureLiveRuntimeResult = {
  record: SessionRecord;
  woke: boolean;
  probe?: ProbeEvidence;
};

function axes(record: SessionRecord) {
  return record.stateMachine ?? legacyStateMachineSeed(record);
}

async function markParkedRuntimeResumed(
  record: SessionRecord,
  probe: ProbeEvidence,
  deps: EnsureLiveRuntimeDeps,
): Promise<SessionRecord> {
  const state = axes(record);
  if (state.runtime !== "parked" || (state.work !== "needs-you" && state.work !== "done")) return record;
  const actionId = `parked-runtime-revived:${probe.probeId}`;
  const transitioned = await (deps.transition ?? transitionSession)(record.name, {
    type: "bee.revived",
    eventId: `parked-runtime-revived:${probe.probeId}`,
    at: probe.observedAt,
    cause: "revive",
    resume: state.work,
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
    withSessionLifecycleTransaction(current, async (lifecycle) => {
      let record = await lifecycle.refresh();
      const state = axes(record);
      if (isArchivedSessionLifecycle(record)) {
        throw new Error(`hive send: ${record.name} is archived`);
      }
      await assertNoUnresolvedBeeNameLaunchReservationInAdmission(record, "hive send wake");
      await assertNoUnresolvedHsrEventIntegrity(record.name, "hive send wake");
      await assertNoUnresolvedHsrAnswerOwnership(record, "hive send wake");
      // `kill_failed` means an explicit stop was requested but exact process
      // ownership is unresolved. Positive liveness proves existence, not
      // permission to resume or admit more work; only explicit stop repair or
      // revive may clear this fence.
      if (!isRunnableSessionRecord(record)) {
        throw new Error(`hive send: ${record.name} has unresolved stop state`);
      }

      const resolveRuntimeSubstrate = deps.resolveSubstrate ?? substrateFor;
      const runtimeSubstrate = resolveRuntimeSubstrate(record);
      let earlyProbe: ProbeEvidence | undefined;
      if (state.runtime !== "parked") {
        if (deps.isLive) {
          if (await deps.isLive(record)) return { record, woke: false };
        } else if (runtimeSubstrate.kind === "remote-hsr") {
          earlyProbe = await probeRecoverableRuntime(record, `hive-send:${process.pid}`, {
            resolveSubstrate: resolveRuntimeSubstrate,
          });
          if (earlyProbe.outcome === "alive") return { record, woke: false, probe: earlyProbe };
        } else if (await runtimeSubstrate.hasSession(record.tmuxTarget)) {
          return { record, woke: false };
        }
      }
      if (record.substrate !== "hsr" && runtimeSubstrate.kind !== "remote-hsr") {
        throw new Error(`tmux session is not running: ${record.tmuxTarget}`);
      }

      const probe = earlyProbe ?? await (deps.probe ?? (async (candidate) =>
        probeRecoverableRuntime(candidate, `hive-send:${process.pid}`, {
          resolveSubstrate: resolveRuntimeSubstrate,
        })))(record);
      if (probe.outcome === "unreachable") {
        throw new Error(`hive send: runtime state is unverified for ${record.name}: ${probe.detail ?? "probe unreachable"}`);
      }
      if (probe.outcome === "alive") {
        await (deps.markVerified ?? markSessionVerified)(record.name, probe);
        if (state.runtime === "parked" && state.work === "needs-you") {
          await (deps.rebindRequests ?? rebindOpenRequestsToGeneration)(
            record.name,
            record.runtimeGeneration ?? 0,
          );
        }
        if (state.runtime === "parked") record = await markParkedRuntimeResumed(record, probe, deps);
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
        // The parked classification is already durable; only now may this
        // exact dead proof clear a boot observer marker.
        await (deps.markVerified ?? markSessionVerified)(record.name, probe);
      }

      if (deps.assertCwd) await deps.assertCwd(record);
      else if (runtimeSubstrate.kind !== "remote-hsr") await assertReviveWorkingDirectory(record);
      const revived = await (deps.reviveInTransaction ?? reviveRecordInTransaction)(lifecycle, {
        fresh: false,
        deferRequestClosure: true,
        replacementOperation: "lazy-wake",
      });
      const after = await (deps.probe ?? (async (candidate) =>
        probeRecoverableRuntime(candidate, `hive-send:${process.pid}`, {
          resolveSubstrate: resolveRuntimeSubstrate,
        })))(revived);
      if (after.outcome !== "alive") {
        throw new Error(`hive send: replacement runtime probe returned ${after.outcome} for ${record.name}`);
      }
      await (deps.markVerified ?? markSessionVerified)(record.name, after);
      if (currentAxes.runtime === "parked" && currentAxes.work === "needs-you") {
        await (deps.rebindRequests ?? rebindOpenRequestsToGeneration)(
          record.name,
          revived.runtimeGeneration ?? 0,
        );
      }
      const resumed = currentAxes.runtime === "parked"
        ? await markParkedRuntimeResumed(revived, after, deps)
        : revived;
      return { record: resumed, woke: true, probe: after };
    }));
}

/** Emit the done→working steer edge once, serialized against concurrent sends. */
export async function markLiveRuntimeSteered(
  snapshot: SessionRecord,
  deps: EnsureLiveRuntimeDeps = {},
): Promise<SessionRecord> {
  const loadRecord = deps.loadRecord ?? loadSession;
  return retryLifecycleConflict(snapshot, loadRecord, (current) =>
    withSessionLifecycleTransaction(current, async (lifecycle) => {
      const record = await lifecycle.refresh();
      await assertNoUnresolvedBeeNameLaunchReservationInAdmission(record, "hive send steer");
      await assertNoUnresolvedHsrEventIntegrity(record.name, "hive send steer");
      if (!isRunnableSessionRecord(record)) {
        throw new Error(`hive send: ${record.name} has unresolved stop state`);
      }
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
  const live = await ensureLiveRuntimeForSend(snapshot, deps);
  return markLiveRuntimeSteered(live.record, deps);
}
