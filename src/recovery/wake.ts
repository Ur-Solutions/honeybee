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
import {
  legacyStateMachineSeed,
  loadSession,
  markSessionVerified,
  transitionSession,
  type SessionRecord,
} from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { probeHsrReAdoption } from "../daemon/reAdoption.js";
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
};

export type EnsureLiveRuntimeResult = {
  record: SessionRecord;
  woke: boolean;
  probe?: ProbeEvidence;
};

function axes(record: SessionRecord) {
  return record.stateMachine ?? legacyStateMachineSeed(record);
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
        if (currentAxes.work !== "done") {
          throw new Error(`hive send: ${record.name} died mid-turn and must be recovered by the supervisor`);
        }
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
      return { record: revived, woke: true, probe: after };
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
