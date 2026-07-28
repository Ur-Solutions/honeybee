import { deliverPromptText } from "../cli/shared.js";
import { pickAutoAccount, resolveAccountFlag, spawnBee } from "../commands/spawn.js";
import { releaseClaim } from "../comb/claims.js";
import {
  sweepCombs,
  type AgentSpawnRequest,
  type CombSweepDeps,
  type CombSweepOutcome,
} from "../comb/controller.js";
import { listSweepableRuns } from "../comb/store.js";
import { transactionalRetire } from "../kill.js";
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
    lookupAgent: loadSession,
    retireAgent: async (beeName) => {
      const record = await loadSession(beeName);
      if (!record || record.status !== "running") return;
      await transactionalRetire(record);
    },
    releaseClaim,
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
