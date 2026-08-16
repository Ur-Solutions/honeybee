/** Finalize an explicit `hive revive` against bounded recovery state. */

import { randomUUID } from "node:crypto";
import { probeHsrReAdoption } from "../daemon/reAdoption.js";
import { drainStagedPendingHsrTurns } from "../hsr/pendingTurns.js";
import { withSessionLifecycleTransaction } from "../lifecycle.js";
import { readBeeRequests, rebindOpenRequestsToGeneration, resolveRequest } from "../requests/store.js";
import {
  legacyStateMachineSeed,
  loadSession,
  markSessionVerified,
  transitionSession,
  type SessionRecord,
} from "../store.js";
import { readRuntimeRecovery, resetRuntimeRecovery } from "./store.js";
import { isRunnableSessionRecord, type ProbeEvidence } from "../stateMachine.js";
import { substrateFor } from "../substrates/index.js";
import type { Substrate } from "../substrates/types.js";
import type { RuntimeRecoveryRecord } from "./store.js";
import { probeRecoverableRuntime } from "./runtimeProbe.js";

export type ManualRuntimeReviveDeps = {
  probe?: (record: SessionRecord) => Promise<ProbeEvidence>;
  drainStaged?: typeof drainStagedPendingHsrTurns;
  readRecovery?: typeof readRuntimeRecovery;
  readRequests?: typeof readBeeRequests;
  resolveRequest?: typeof resolveRequest;
  rebindRequests?: typeof rebindOpenRequestsToGeneration;
  transition?: typeof transitionSession;
  markVerified?: typeof markSessionVerified;
  resetRecovery?: typeof resetRuntimeRecovery;
  loadRecord?: typeof loadSession;
  now?: () => number;
  makeActionId?: () => string;
  resolveSubstrate?: (record: SessionRecord) => Substrate;
};

/**
 * Manual revive is the only operator edge out of recovery-failed/lost. It also
 * consumes any replay stage, resolves the one durable request, and resets the
 * persisted attempt cap for a future independent episode.
 */
export async function finalizeManualRuntimeRevive(
  record: SessionRecord,
  deps: ManualRuntimeReviveDeps = {},
): Promise<SessionRecord> {
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    if (!isRunnableSessionRecord(current)) {
      throw new Error(`hive revive: ${current.name} has unresolved stop ownership during finalization`);
    }
    const resolveRuntimeSubstrate = deps.resolveSubstrate ?? substrateFor;
    const substrate = resolveRuntimeSubstrate(current);
    const localHsr = current.substrate === "hsr";
    if (!localHsr && substrate.kind !== "remote-hsr") return current;
    // Proof and every work-releasing mutation stay under the same lifecycle
    // admission. A later kill either waits for this completed finalization or
    // wins first and causes zero drain/request/transition effects.
    const evidence = await (deps.probe ?? (async (candidate) =>
      localHsr
        ? (await probeHsrReAdoption(candidate, `hive-revive:${process.pid}`)).evidence
        : probeRecoverableRuntime(candidate, `hive-revive:${process.pid}`, {
            resolveSubstrate: resolveRuntimeSubstrate,
          })))(current);
    if (evidence.outcome !== "alive") {
      throw new Error(`hive revive: replacement runtime probe returned ${evidence.outcome} for ${current.name}`);
    }
    await (deps.markVerified ?? markSessionVerified)(current.name, evidence);
    if (localHsr) await (deps.drainStaged ?? drainStagedPendingHsrTurns)(current.name);

    const recovery: RuntimeRecoveryRecord | null = await (deps.readRecovery ?? readRuntimeRecovery)(current.name);
    const refreshed = await lifecycle.refresh();
    const state = refreshed.stateMachine ?? legacyStateMachineSeed(refreshed);
    const at = new Date((deps.now ?? Date.now)()).toISOString();

    if (state.lifecycle === "archived") {
      throw new Error(`hive revive: ${current.name} became archived during finalization`);
    } else if (state.runtime === "lost") {
      const requestId = recovery?.recoveryFailedRequestId ?? (await (deps.readRequests ?? readBeeRequests)(current.name)).find((request) =>
        request.status === "open" && request.kind === "manual-action" &&
        request.evidence.source === "runtime-recovery-supervisor")?.id;
      if (!requestId) throw new Error(`hive revive: ${current.name} is recovery-failed but has no durable recovery request`);
      await (deps.transition ?? transitionSession)(current.name, {
        type: "request.resolved",
        eventId: `request-resolved:${requestId}:revive`,
        at,
        cause: "revive",
        requestId,
        evidence: { kind: "request", requestId, observedAt: at, action: "answered" },
      });
      await (deps.resolveRequest ?? resolveRequest)(current.name, requestId, {
        by: "hive-revive",
        resolution: "runtime manually revived",
      });
    } else if (state.runtime === "recovering") {
      const latest = recovery?.attempts.at(-1);
      const attemptId = latest?.attemptId ?? recovery?.episodeId ?? randomUUID();
      await (deps.transition ?? transitionSession)(current.name, {
        type: "recovery.succeeded",
        eventId: `recovery-succeeded:${attemptId}:manual`,
        at,
        cause: "revive-ok",
        probe: evidence,
        evidence: {
          kind: "recovery",
          attemptId,
          observedAt: at,
          attempt: latest?.attempt ?? Math.max(1, recovery?.attempts.length ?? 0),
          budget: recovery?.maxAttempts ?? 10,
          outcome: "succeeded",
          detail: "explicit hive revive",
        },
      });
    } else if (state.runtime === "parked" && (state.work === "done" || state.work === "needs-you")) {
      if (state.work === "needs-you") {
        await (deps.rebindRequests ?? rebindOpenRequestsToGeneration)(
          current.name,
          refreshed.runtimeGeneration ?? 0,
        );
      }
      const actionId = (deps.makeActionId ?? randomUUID)();
      await (deps.transition ?? transitionSession)(current.name, {
        type: "bee.revived",
        eventId: `bee-revived:${actionId}`,
        at,
        cause: "revive",
        resume: state.work,
        probe: evidence,
        evidence: { kind: "operator", actionId, observedAt: at, action: "revive" },
      });
    }

    await (deps.resetRecovery ?? resetRuntimeRecovery)(current.name);
    return await (deps.loadRecord ?? loadSession)(current.name) ?? current;
  });
}
