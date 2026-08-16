import { join } from "node:path";
import { sendBuzMessage } from "../buz.js";
import { deliverPromptText } from "../cli/shared.js";
import { deliverSessionTextInAdmission, withRunnableSessionAdmission } from "../delivery.js";
import { pickAutoAccount, resolveAccountFlag, spawnBee } from "../commands/spawn.js";
import { releaseClaim } from "../comb/claims.js";
import {
  executeForumPacketEffect,
  forumPacketDigest,
  listForumPackets,
} from "../comb/forum.js";
import { combRunDir } from "../comb/store.js";
import {
  sweepCombs,
  AgentActivationAmbiguousError,
  type AgentAdoptRequest,
  type AgentSpawnRequest,
  type CombSweepDeps,
  type CombSweepOutcome,
  type HumanPacketQuarantineNotice,
} from "../comb/controller.js";
import { listSweepableRuns, loadRun } from "../comb/store.js";
import { retireSessionByNameExactly } from "../kill.js";
import {
  assertNoCanonicalHsrEventIntegrityDoubt,
  assertNoUnresolvedHsrEventIntegrity,
} from "../hsr/eventIntegrity.js";
import { withSessionLifecycleTransaction } from "../lifecycle.js";
import { withFileLock } from "../lock.js";
import { scanLatestSeal } from "../seal.js";
import type { BeeState } from "../state.js";
import { isArchivedSessionLifecycle, isRunnableSessionRecord } from "../stateMachine.js";
import { loadSession, type SessionRecord } from "../store.js";

export type CombSweeper = (
  records: SessionRecord[],
  observed: Map<string, BeeState>,
) => Promise<CombSweepOutcome[]>;

export type CombSweeperOptions = {
  detached?: boolean;
};

/** Exact source gate shared by the production sweeper and integrity tests. */
export async function withCombAutomaticSourceAdmission<T>(
  sources: SessionRecord[],
  fn: (current: SessionRecord[]) => Promise<T>,
): Promise<T> {
  const ordered = [...new Map(sources.map((source) => [source.name, source])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  const enter = async (index: number, current: SessionRecord[]): Promise<T> => {
    const source = ordered[index];
    if (!source) return fn(current);
    return withSessionLifecycleTransaction(source, async (lifecycle) => {
      const fresh = await lifecycle.refresh();
      assertNoCanonicalHsrEventIntegrityDoubt(fresh, "comb automatic retry");
      await assertNoUnresolvedHsrEventIntegrity(fresh.name, "comb automatic retry");
      // Frozen terminal/stall evidence cannot authorize a successor while the
      // canonical source is runnable, retired, or otherwise unresolved.
      if (fresh.status === "kill_failed" || isArchivedSessionLifecycle(fresh) || isRunnableSessionRecord(fresh)) {
        throw new Error(`comb automatic retry: ${fresh.name} still owns runnable, unresolved, or retired source work`);
      }
      return enter(index + 1, [...current, fresh]);
    });
  };
  return enter(0, []);
}

export function createCombSweeper(
  overrides: Partial<CombSweepDeps> = {},
  options: CombSweeperOptions = {},
): CombSweeper {
  const deps: CombSweepDeps = {
    listRuns: listSweepableRuns,
    latestSeal: async (beeName) => {
      const scan = await scanLatestSeal(beeName);
      return scan.filename && scan.seal ? { filename: scan.filename, seal: scan.seal } : null;
    },
    spawnAgent: spawnCombAgent,
    adoptAgent: adoptCombAgent,
    lookupAgent: loadSession,
    retireAgent: (beeName) => retireSessionByNameExactly(beeName, "comb automatic cleanup"),
    listHumanPackets: listForumPackets,
    executeHumanEffect: executeForumPacketEffect,
    packetDigest: forumPacketDigest,
    notifyOperator: async (notice) => {
      const recipientName = notice.recipient ?? process.env.HIVE_COMB_OPERATOR_BEE;
      if (!recipientName) {
        throw new Error(
          `human review ${notice.packetId} stalled but no operator bee could be resolved; set HIVE_COMB_OPERATOR_BEE`,
        );
      }
      const recipient = await loadSession(recipientName);
      if (!recipient) throw new Error(`operator bee is not registered: ${recipientName}`);
      await sendBuzMessage({
        recipient,
        sender: { kind: "bee", id: `comb:${notice.runId}` },
        tier: "queue",
        subject: `comb human stall ${notice.runId}`,
        body: notice.message,
      });
    },
    notifyPacketQuarantine: notifyPacketQuarantine,
    releaseClaim,
    withRunSweepLock: (runId, fn) =>
      withFileLock(join(combRunDir(runId), ".sweep.lock"), fn, { timeoutMs: 5_000, staleMs: 10 * 60_000 }),
    withAgentSourceAdmission: withCombAutomaticSourceAdmission,
    now: () => Date.now(),
    ...overrides,
  };
  if (options.detached === false) {
    return (records, observed) => sweepCombs(deps, records, observed);
  }
  let inFlight = false;
  let startedAt = 0;
  let pending: CombSweepOutcome[] = [];
  return async (records, observed) => {
    const report = pending;
    pending = [];
    if (inFlight) {
      report.push({ run: "*", action: "noop", detail: `sweep still running (${Math.round((Date.now() - startedAt) / 1000)}s)` });
      return report;
    }
    inFlight = true;
    startedAt = Date.now();
    void sweepCombs(deps, records, observed)
      .then((outcomes) => {
        pending = outcomes;
      })
      .catch((error: unknown) => {
        pending = [{ run: "*", action: "error", error: error instanceof Error ? error.message : String(error) }];
      })
      .finally(() => {
        inFlight = false;
      });
    return report;
  };
}

async function notifyPacketQuarantine(notice: HumanPacketQuarantineNotice): Promise<void> {
  const run = notice.runId ? await loadRun(notice.runId) : null;
  const recipientName = run?.origin.kind === "attached"
    ? run.origin.beeName
    : process.env.HIVE_COMB_OPERATOR_BEE;
  if (!recipientName) {
    throw new Error(
      "malformed Forum packet was quarantined but no operator bee could be resolved; set HIVE_COMB_OPERATOR_BEE",
    );
  }
  const recipient = await loadSession(recipientName);
  if (!recipient) throw new Error(`operator bee is not registered: ${recipientName}`);
  await sendBuzMessage({
    recipient,
    sender: { kind: "bee", id: notice.runId ? `comb:${notice.runId}` : "comb:forum" },
    tier: "queue",
    subject: `comb Forum packet quarantined${notice.packetId ? ` ${notice.packetId}` : ""}`,
    body: notice.message,
  });
}

async function spawnCombAgent(request: AgentSpawnRequest): Promise<{ name: string; id?: string }> {
  const account = request.account === "auto"
    ? await pickAutoAccount(request.agent, undefined, false, request.model)
    : request.account
      ? await resolveAccountFlag(request.account, request.agent, undefined, false, request.model)
      : undefined;
  const record = await spawnBee({
    agent: request.agent,
    extraArgs: [],
    cwd: request.cwd,
    yolo: true,
    name: request.name,
    substrate: request.substrate,
    ...(account ? { account } : {}),
    ...(request.model ?? account?.model ? { model: request.model ?? account?.model } : {}),
    brief: request.brief,
    contract: {
      completion: "seal",
      taskId: request.taskId,
      attempt: request.attempt,
    },
  });
  let bound: SessionRecord;
  try {
    bound = await bindAndDeliverCombAgent(record, request);
  } catch (error) {
    // The deterministic Bee name is already durably published. Preserve that
    // ownership in the Comb effect instead of flattening a binding/delivery
    // failure into a retryable spawn failure.
    throw new AgentActivationAmbiguousError(
      { name: record.name, ...(record.id ? { id: record.id } : {}) },
      error,
    );
  }
  return { name: bound.name, ...(bound.id ? { id: bound.id } : {}) };
}

export async function adoptCombAgent(
  request: AgentAdoptRequest,
  hooks: {
    beforeSessionAdmission?: () => Promise<void>;
    deliver?: typeof deliverPromptText;
  } = {},
): Promise<{ name: string; id?: string }> {
  const record = await loadSession(request.name);
  if (!record) throw new Error(`attached bee is not registered: ${request.name}`);
  if (!isRunnableSessionRecord(record)) {
    throw new Error(`attached bee ${record.name} is terminal (${record.status})`);
  }
  await hooks.beforeSessionAdmission?.();
  let updated: SessionRecord;
  try {
    updated = await bindAndDeliverCombAgent(record, request, hooks.deliver);
  } catch (error) {
    throw new AgentActivationAmbiguousError(
      { name: record.name, ...(record.id ? { id: record.id } : {}) },
      error,
    );
  }
  return { name: updated.name, ...(updated.id ? { id: updated.id } : {}) };
}

/** Lifecycle must stay outside every SessionRecord binding and prompt effect. */
async function bindAndDeliverCombAgent(
  snapshot: SessionRecord,
  request: AgentSpawnRequest | AgentAdoptRequest,
  deliver: typeof deliverPromptText = deliverPromptText,
): Promise<SessionRecord> {
  const deliveryId = `comb:${request.runId}:${request.activation.nodeId}:${request.activation.attempt}:${request.activation.itemIndex}:${request.taskId}`;
  return withRunnableSessionAdmission(snapshot, async (lifecycle, admitted) => {
    const now = new Date().toISOString();
    const trackDigest = "trackDigest" in request ? request.trackDigest : undefined;
    const exact = admitted.combActivations?.find(
      (binding) =>
        binding.runId === request.runId &&
        binding.nodeId === request.activation.nodeId &&
        binding.attempt === request.activation.attempt &&
        binding.itemIndex === request.activation.itemIndex &&
        (trackDigest === undefined || binding.trackDigest === trackDigest),
    );
    const bindingPatch = (current: SessionRecord, deliveredAt?: string): Partial<SessionRecord> => {
      const currentExact = current.combActivations?.find(
        (binding) =>
          binding.runId === request.runId &&
          binding.nodeId === request.activation.nodeId &&
          binding.attempt === request.activation.attempt &&
          binding.itemIndex === request.activation.itemIndex &&
          (trackDigest === undefined || binding.trackDigest === trackDigest),
      );
      const deliveryAt = deliveredAt ?? currentExact?.deliveredAt;
      const binding = {
        runId: request.runId,
        nodeId: request.activation.nodeId,
        attempt: request.activation.attempt,
        itemIndex: request.activation.itemIndex,
        taskId: request.taskId,
        status: "current" as const,
        attachedAt: currentExact?.attachedAt ?? now,
        ...(trackDigest ? { trackDigest } : {}),
        ...(deliveryAt ? { deliveredAt: deliveryAt } : {}),
      };
      const otherBindings = (current.combActivations ?? [])
        .filter(
          (candidate) =>
            !(
              candidate.runId === request.runId &&
              candidate.nodeId === request.activation.nodeId &&
              candidate.attempt === request.activation.attempt &&
              candidate.itemIndex === request.activation.itemIndex
            ),
        )
        .map((candidate) =>
          candidate.status === "current" &&
          candidate.runId === request.runId &&
          candidate.nodeId === request.activation.nodeId
            ? { ...candidate, status: "historical" as const, endedAt: now }
            : candidate
        );
      return {
        contract: {
          completion: "seal",
          taskId: request.taskId,
          attempt: request.attempt,
        },
        brief: request.brief,
        combActivations: [...otherBindings, binding],
      };
    };

    if (request.brief && !exact?.deliveredAt) {
      return (await deliverSessionTextInAdmission(lifecycle, admitted, request.brief, {
        deliver,
        deliveryId,
        metadata: (deliveredAt, current) => bindingPatch(current, deliveredAt),
      })).record;
    }
    return lifecycle.commit(bindingPatch(admitted));
  }, { operation: "comb agent activation" });
}
