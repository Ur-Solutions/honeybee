import { join } from "node:path";
import { sendBuzMessage } from "../buz.js";
import { deliverPromptText } from "../cli/shared.js";
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
  type AgentAdoptRequest,
  type AgentSpawnRequest,
  type CombSweepDeps,
  type CombSweepOutcome,
} from "../comb/controller.js";
import { listSweepableRuns } from "../comb/store.js";
import { transactionalRetire } from "../kill.js";
import { withFileLock } from "../lock.js";
import { scanLatestSeal } from "../seal.js";
import type { BeeState } from "../state.js";
import { loadSession, touchSession, type SessionRecord } from "../store.js";

export type CombSweeper = (
  records: SessionRecord[],
  observed: Map<string, BeeState>,
) => Promise<CombSweepOutcome[]>;

export type CombSweeperOptions = {
  detached?: boolean;
};

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
    retireAgent: async (beeName) => {
      const record = await loadSession(beeName);
      if (!record || record.status !== "running") return;
      await transactionalRetire(record);
    },
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
    releaseClaim,
    withRunSweepLock: (runId, fn) =>
      withFileLock(join(combRunDir(runId), ".sweep.lock"), fn, { timeoutMs: 5_000, staleMs: 10 * 60_000 }),
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

async function spawnCombAgent(request: AgentSpawnRequest): Promise<{ name: string; id?: string }> {
  const account = request.account === "auto"
    ? await pickAutoAccount(request.agent, undefined)
    : request.account
      ? await resolveAccountFlag(request.account, request.agent, undefined)
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
  await touchSession(record.name, {
    combActivations: [
      ...(record.combActivations ?? []).map((binding) =>
        binding.status === "current" && binding.runId === request.runId && binding.nodeId === request.activation.nodeId
          ? { ...binding, status: "historical" as const, endedAt: new Date().toISOString() }
          : binding,
      ),
      {
        runId: request.runId,
        nodeId: request.activation.nodeId,
        attempt: request.activation.attempt,
        itemIndex: request.activation.itemIndex,
        taskId: request.taskId,
        status: "current",
        attachedAt: new Date().toISOString(),
      },
    ],
  });
  if (record.brief) await deliverPromptText(record, record.brief);
  return { name: record.name, ...(record.id ? { id: record.id } : {}) };
}

async function adoptCombAgent(request: AgentAdoptRequest): Promise<{ name: string; id?: string }> {
  const record = await loadSession(request.name);
  if (!record) throw new Error(`attached bee is not registered: ${request.name}`);
  if (record.status !== "running") {
    throw new Error(`attached bee ${record.name} is terminal (${record.status})`);
  }
  const now = new Date().toISOString();
  const exact = record.combActivations?.find(
    (binding) =>
      binding.runId === request.runId &&
      binding.nodeId === request.activation.nodeId &&
      binding.attempt === request.activation.attempt &&
      binding.itemIndex === request.activation.itemIndex &&
      binding.trackDigest === request.trackDigest,
  );
  const binding = {
    runId: request.runId,
    nodeId: request.activation.nodeId,
    attempt: request.activation.attempt,
    itemIndex: request.activation.itemIndex,
    taskId: request.taskId,
    status: "current" as const,
    attachedAt: exact?.attachedAt ?? now,
    trackDigest: request.trackDigest,
    ...(exact?.deliveredAt ? { deliveredAt: exact.deliveredAt } : {}),
  };
  const otherBindings = (record.combActivations ?? [])
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
  let updated = await touchSession(record.name, {
    contract: {
      completion: "seal",
      taskId: request.taskId,
      attempt: request.attempt,
    },
    brief: request.brief,
    combActivations: [...otherBindings, binding],
  });
  if (!updated) throw new Error(`attached bee disappeared during adoption: ${record.name}`);
  if (!exact?.deliveredAt) {
    await deliverPromptText(updated, request.brief);
    const deliveredAt = new Date().toISOString();
    updated = await touchSession(updated.name, {
      combActivations: updated.combActivations?.map((candidate) =>
        candidate.runId === request.runId &&
        candidate.nodeId === request.activation.nodeId &&
        candidate.attempt === request.activation.attempt &&
        candidate.itemIndex === request.activation.itemIndex &&
        candidate.trackDigest === request.trackDigest
          ? { ...candidate, deliveredAt }
          : candidate
      ),
    }) ?? updated;
  }
  return { name: updated.name, ...(updated.id ? { id: updated.id } : {}) };
}
