/** Finalize an explicit `hive revive` against bounded recovery state. */

import { randomUUID } from "node:crypto";
import { probeHsrReAdoption } from "../daemon/reAdoption.js";
import { drainStagedPendingHsrTurns } from "../hsr/pendingTurns.js";
import { readBeeRequests, resolveRequest } from "../requests/store.js";
import {
  legacyStateMachineSeed,
  loadSession,
  markSessionVerified,
  transitionSession,
  type SessionRecord,
} from "../store.js";
import { readRuntimeRecovery, resetRuntimeRecovery } from "./store.js";
import type { ProbeEvidence } from "../stateMachine.js";
import type { RuntimeRecoveryRecord } from "./store.js";

export type ManualRuntimeReviveDeps = {
  probe?: (record: SessionRecord) => Promise<ProbeEvidence>;
  drainStaged?: typeof drainStagedPendingHsrTurns;
  readRecovery?: typeof readRuntimeRecovery;
  readRequests?: typeof readBeeRequests;
  resolveRequest?: typeof resolveRequest;
  transition?: typeof transitionSession;
  markVerified?: typeof markSessionVerified;
  resetRecovery?: typeof resetRuntimeRecovery;
  loadRecord?: typeof loadSession;
  now?: () => number;
  makeActionId?: () => string;
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
  if (record.substrate !== "hsr") return record;
  const evidence = await (deps.probe ?? (async (candidate) =>
    (await probeHsrReAdoption(candidate, `hive-revive:${process.pid}`)).evidence))(record);
  if (evidence.outcome !== "alive") {
    throw new Error(`hive revive: replacement runtime probe returned ${evidence.outcome} for ${record.name}`);
  }
  await (deps.markVerified ?? markSessionVerified)(record.name, evidence);
  await (deps.drainStaged ?? drainStagedPendingHsrTurns)(record.name);

  const recovery: RuntimeRecoveryRecord | null = await (deps.readRecovery ?? readRuntimeRecovery)(record.name);
  const current = await (deps.loadRecord ?? loadSession)(record.name) ?? record;
  const state = current.stateMachine ?? legacyStateMachineSeed(current);
  const at = new Date((deps.now ?? Date.now)()).toISOString();

  if (state.lifecycle === "archived") {
    const actionId = (deps.makeActionId ?? randomUUID)();
    await (deps.transition ?? transitionSession)(record.name, {
      type: "bee.revived",
      eventId: `bee-revived:${actionId}`,
      at,
      cause: "revive",
      resume: "done",
      probe: evidence,
      evidence: { kind: "operator", actionId, observedAt: at, action: "revive" },
    });
  } else if (state.runtime === "lost") {
    const requestId = recovery?.recoveryFailedRequestId ?? (await (deps.readRequests ?? readBeeRequests)(record.name)).find((request) =>
      request.status === "open" && request.kind === "manual-action" &&
      request.evidence.source === "runtime-recovery-supervisor")?.id;
    if (!requestId) throw new Error(`hive revive: ${record.name} is recovery-failed but has no durable recovery request`);
    await (deps.transition ?? transitionSession)(record.name, {
      type: "request.resolved",
      eventId: `request-resolved:${requestId}:revive`,
      at,
      cause: "revive",
      requestId,
      evidence: { kind: "request", requestId, observedAt: at, action: "answered" },
    });
    await (deps.resolveRequest ?? resolveRequest)(record.name, requestId, {
      by: "hive-revive",
      resolution: "runtime manually revived",
    });
  } else if (state.runtime === "recovering") {
    const latest = recovery?.attempts.at(-1);
    const attemptId = latest?.attemptId ?? recovery?.episodeId ?? randomUUID();
    await (deps.transition ?? transitionSession)(record.name, {
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
  }

  await (deps.resetRecovery ?? resetRuntimeRecovery)(record.name);
  return await (deps.loadRecord ?? loadSession)(record.name) ?? record;
}
