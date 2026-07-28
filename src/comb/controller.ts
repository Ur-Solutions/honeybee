import type { SealRecord } from "../seal.js";
import type { BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";
import { canonicalDigest } from "./canonical.js";
import { ingestSealEvidence } from "./evidence.js";
import { applySealCompletion, activateAgent, effectBaseKey, reconcileMachine, terminalizeRun } from "./machine.js";
import { renderBrief } from "./schema.js";
import { initializeRunCleanup, mutateRun, recordRunEvent, type listSweepableRuns } from "./store.js";
import type { ActivationRecord, EffectRecord, JsonValue, RunRecord } from "./types.js";

export type LatestCombSeal = { filename: string; seal: SealRecord } | null;

export type AgentSpawnRequest = {
  runId: string;
  activation: ActivationRecord["address"];
  name: string;
  agent: string;
  account?: string;
  model?: string;
  substrate: "hsr" | "local-tmux";
  cwd: string;
  brief: string;
  taskId: string;
  attempt: number;
};

export type CombSweepOutcome = {
  run: string;
  action: "noop" | "reconciled" | "spawned" | "adopted" | "failed" | "cleanup" | "error";
  activation?: string;
  bee?: string;
  detail?: string;
  error?: string;
};

export type CombSweepDeps = {
  listRuns: typeof listSweepableRuns;
  latestSeal: (beeName: string) => Promise<LatestCombSeal>;
  spawnAgent: (request: AgentSpawnRequest) => Promise<{ name: string; id?: string }>;
  lookupAgent: (name: string) => Promise<SessionRecord | null>;
  retireAgent: (name: string) => Promise<void>;
  releaseClaim?: (claimId: string, runId: string) => Promise<void>;
  withRunSweepLock?: <T>(runId: string, fn: () => Promise<T>) => Promise<T>;
  now: () => number;
};

type PreparedAgentEffect = {
  runId: string;
  activationId: string;
  effectKey: string;
  request: AgentSpawnRequest;
};

export async function sweepCombs(
  deps: CombSweepDeps,
  records: readonly SessionRecord[],
  observed: ReadonlyMap<string, BeeState>,
): Promise<CombSweepOutcome[]> {
  const outcomes: CombSweepOutcome[] = [];
  const runs = await deps.listRuns();
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  for (const listed of runs) {
    try {
      const sweep = () => sweepOneRun(deps, listed.id, recordsByName, observed);
      outcomes.push(...await (deps.withRunSweepLock ? deps.withRunSweepLock(listed.id, sweep) : sweep()));
    } catch (error) {
      outcomes.push({ run: listed.id, action: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

async function sweepOneRun(
  deps: CombSweepDeps,
  runId: string,
  records: ReadonlyMap<string, SessionRecord>,
  observed: ReadonlyMap<string, BeeState>,
): Promise<CombSweepOutcome[]> {
  const outcomes: CombSweepOutcome[] = [];
  const now = new Date(deps.now()).toISOString();
  const prepared: PreparedAgentEffect[] = [];
  const first = await mutateRun(runId, async (run) => {
    if (run.status === "active") {
      await ingestAgentEvidence(deps, run, now);
      reconcileDeadOrStalledAgents(run, records, observed, now);
      reconcileMachine(run, now);
      prepared.push(...planAgentEffects(run, now));
    }
  });
  if (first.changed) outcomes.push({ run: runId, action: "reconciled" });

  for (const plan of prepared) {
    const result = await executeAgentEffect(deps, plan);
    outcomes.push(result);
  }

  await mutateRun(runId, (run) => {
    if (run.status === "active") reconcileMachine(run, new Date(deps.now()).toISOString());
  });
  outcomes.push(...await reconcileTerminalEffects(deps, runId));
  outcomes.push(...await driveCleanup(deps, runId));
  if (outcomes.length === 0) outcomes.push({ run: runId, action: "noop" });
  return outcomes;
}

async function ingestAgentEvidence(deps: CombSweepDeps, run: RunRecord, now: string): Promise<void> {
  for (const activation of Object.values(run.activations)) {
    if (activation.beeHandles.length === 0 || (isTerminal(activation) && !activation.invalidatedAt)) continue;
    for (const handle of activation.beeHandles) {
      const latest = await deps.latestSeal(handle.name);
      if (!latest) continue;
      const result = await ingestSealEvidence(run, activation, latest.filename, latest.seal);
      if (result === "match") applySealCompletion(run, activation, latest.seal, now);
    }
  }
}

function reconcileDeadOrStalledAgents(
  run: RunRecord,
  records: ReadonlyMap<string, SessionRecord>,
  observed: ReadonlyMap<string, BeeState>,
  now: string,
): void {
  for (const activation of currentActivations(run)) {
    const node = run.currentSnapshot.definition.nodes.find((candidate) => candidate.id === activation.address.nodeId);
    if (node?.executor !== "agent" || activation.status !== "active") continue;
    const terminalBee = activation.beeHandles.find((handle) => {
      const state = observed.get(handle.name);
      const record = records.get(handle.name);
      return state === "dead" || state === "crashed" || state === "error" || state === "done" || record?.status === "dead" || record?.status === "done";
    });
    if (terminalBee) {
      activation.status = "failed";
      activation.endedAt = now;
      activation.failure = {
        code: "bee-terminal-without-seal",
        message: `bee ${terminalBee.name} became terminal without a matching completion seal`,
        retryable: true,
      };
      recordRunEvent(run, "comb.activation.failed", activation.address, { code: "bee-terminal-without-seal", bee: terminalBee.name });
      continue;
    }
    if (activation.startedAt && Date.parse(now) - Date.parse(activation.startedAt) >= run.policies.stallMs) {
      activation.status = "failed";
      activation.endedAt = now;
      activation.failure = {
        code: "idle-without-completion",
        message: `activation ${activation.id} exceeded stallMs without matching completion evidence`,
        retryable: true,
      };
      recordRunEvent(run, "comb.violation", activation.address, { code: "idle-without-completion" });
      recordRunEvent(run, "comb.activation.failed", activation.address, { code: "idle-without-completion" });
    }
  }
}

function planAgentEffects(run: RunRecord, now: string): PreparedAgentEffect[] {
  if (run.cancellation || run.status !== "active") return [];
  const activeCount = currentActivations(run).filter((activation) => activation.status === "active").length;
  let available = Math.max(0, run.policies.maxConcurrentActivations - activeCount);
  const plans: PreparedAgentEffect[] = [];
  for (const activation of currentActivations(run)) {
    if (activation.status !== "pending" && activation.status !== "active") continue;
    if (activation.status === "pending" && (available <= 0 || activation.nextEligibleAt && activation.nextEligibleAt > now)) continue;
    const node = run.currentSnapshot.definition.nodes.find((candidate) => candidate.id === activation.address.nodeId);
    if (node?.executor !== "agent") continue;
    if (node.agent.capacity.kind !== "spawn") {
      activation.status = "failed";
      activation.endedAt = now;
      activation.failure = { code: "flight-capacity-unavailable", message: "flight-backed comb agents are outside slice 1", retryable: false };
      recordRunEvent(run, "comb.activation.failed", activation.address, { code: "flight-capacity-unavailable" });
      continue;
    }
    let brief: string;
    try {
      brief = renderAgentBrief(run, activation, node);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      activation.status = "failed";
      activation.endedAt = now;
      activation.failure = {
        code: "invalid-brief",
        message,
        retryable: false,
      };
      recordRunEvent(run, "comb.activation.failed", activation.address, { code: "invalid-brief" });
      recordRunEvent(run, "comb.violation", activation.address, { code: "invalid-brief", message });
      continue;
    }
    const semanticId = "primary";
    const semanticDigest = canonicalDigest(semanticId);
    const key = `${effectBaseKey(activation)}:agent-spawn:${semanticDigest.slice("sha256:".length)}`;
    const request: AgentSpawnRequest = {
      runId: run.id,
      activation: activation.address,
      name: deterministicAgentName(run.id, activation),
      agent: node.agent.capacity.bee,
      ...(node.agent.capacity.account ? { account: node.agent.capacity.account } : {}),
      ...(node.agent.capacity.model ? { model: node.agent.capacity.model } : {}),
      substrate: node.agent.capacity.substrate ?? "hsr",
      cwd: run.cwd,
      brief,
      taskId: activation.taskId,
      attempt: activation.address.attempt,
    };
    const requestDigest = canonicalDigest(request as unknown as JsonValue);
    const existing = run.effects[key];
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        terminalizeRun(run, "failed", {
          code: "effect-key-collision",
          message: `effect ${key} was replanned with a different request`,
          activation: activation.address,
        }, now, activation.address);
        recordRunEvent(run, "comb.violation", activation.address, { code: "effect-key-collision", effectKey: key });
      } else if (existing.status === "prepared" || existing.status === "executing") {
        plans.push({ runId: run.id, activationId: activation.id, effectKey: key, request });
        if (activation.status === "pending") available -= 1;
      }
      continue;
    }
    if (activation.status === "active") continue;
    const effect: EffectRecord = {
      key,
      scope: { kind: "activation", activation: activation.address },
      kind: "agent-spawn",
      semanticId,
      semanticDigest,
      fenceEpoch: 0,
      status: "prepared",
      preparedAt: now,
      externalRef: request.name,
      requestDigest,
      verificationEvidenceIds: [],
    };
    run.effects[key] = effect;
    activation.effectKeys.push(key);
    recordRunEvent(run, "comb.effect.prepared", activation.address, { effectKey: key, kind: effect.kind });
    plans.push({ runId: run.id, activationId: activation.id, effectKey: key, request });
    available -= 1;
  }
  return plans;
}

async function executeAgentEffect(deps: CombSweepDeps, plan: PreparedAgentEffect): Promise<CombSweepOutcome> {
  let recover = false;
  const start = await mutateRun(plan.runId, (run) => {
    const effect = run.effects[plan.effectKey];
    const activation = run.activations[plan.activationId];
    if (!effect || !activation) return false;
    if (run.cancellation || run.status !== "active") {
      if (effect.status === "prepared") {
        effect.status = "not-executed";
        effect.confirmedAt = new Date(deps.now()).toISOString();
        recordRunEvent(run, "comb.effect.failed", activation.address, { effectKey: effect.key, outcome: "not-executed" });
      }
      return false;
    }
    if (effect.status === "executing") {
      recover = true;
      return true;
    }
    if (effect.status !== "prepared") return false;
    effect.status = "executing";
    effect.executeStartedAt = new Date(deps.now()).toISOString();
    activateAgent(run, activation, effect.executeStartedAt);
    return true;
  });
  if (!start.result) return { run: plan.runId, action: "noop", activation: plan.activationId };

  let spawned: { name: string; id?: string };
  if (recover) {
    const existing = await deps.lookupAgent(plan.request.name);
    if (!existing) {
      const effect = start.run.effects[plan.effectKey];
      const executeStartedAt = effect?.executeStartedAt;
      if (!executeStartedAt || deps.now() - Date.parse(executeStartedAt) < start.run.policies.firstEvidenceMs) {
        return {
          run: plan.runId,
          action: "noop",
          activation: plan.activationId,
          detail: "executing spawn is still within its adoption window",
        };
      }
    }
    if (!existing || existing.contract?.taskId !== plan.request.taskId || existing.contract?.attempt !== plan.request.attempt) {
      await mutateRun(plan.runId, (run) => {
        const effect = run.effects[plan.effectKey];
        const activation = run.activations[plan.activationId];
        if (!effect || !activation || effect.status !== "executing") return;
        effect.status = "failed";
        effect.error = "executing spawn was not adoptable after restart";
        activation.status = "failed";
        activation.endedAt = new Date(deps.now()).toISOString();
        activation.failure = { code: "spawn-adoption-missing", message: effect.error, retryable: true };
        recordRunEvent(run, "comb.effect.failed", activation.address, { effectKey: effect.key });
        recordRunEvent(run, "comb.activation.failed", activation.address, { code: "spawn-adoption-missing" });
      });
      return { run: plan.runId, action: "failed", activation: plan.activationId, error: "executing spawn was not adoptable" };
    }
    spawned = { name: existing.name, ...(existing.id ? { id: existing.id } : {}) };
  } else {
    try {
      spawned = await deps.spawnAgent(plan.request);
    } catch (error) {
      await mutateRun(plan.runId, (run) => {
        const effect = run.effects[plan.effectKey];
        const activation = run.activations[plan.activationId];
        if (!effect || !activation) return;
        effect.status = "failed";
        effect.error = error instanceof Error ? error.message : String(error);
        activation.status = "failed";
        activation.endedAt = new Date(deps.now()).toISOString();
        activation.failure = { code: "spawn-failed", message: effect.error, retryable: true };
        recordRunEvent(run, "comb.effect.failed", activation.address, { effectKey: effect.key });
        recordRunEvent(run, "comb.activation.failed", activation.address, { code: "spawn-failed" });
      });
      return { run: plan.runId, action: "failed", activation: plan.activationId, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const confirmed = await mutateRun(plan.runId, (run) => {
    const effect = run.effects[plan.effectKey];
    const activation = run.activations[plan.activationId];
    if (!effect || !activation) return "missing";
    const now = new Date(deps.now()).toISOString();
    if (effect.status !== "executing") {
      if (
        run.status !== "active" &&
        effect.status !== "confirmed" &&
        !activation.beeHandles.some((handle) => handle.name === spawned.name)
      ) {
        effect.status = "confirmed";
        effect.confirmedAt = now;
        effect.externalRef = spawned.name;
        activation.beeHandles.push({
          name: spawned.name,
          ...(spawned.id ? { id: spawned.id } : {}),
          source: recover ? "adopted" : "spawn",
        });
        reopenCleanupForBee(run, spawned.name, now);
        recordRunEvent(run, "comb.effect.confirmed", activation.address, {
          effectKey: effect.key,
          externalRef: spawned.name,
          late: true,
        });
        return "late-confirmed";
      }
      return `ignored-${effect.status}`;
    }
    if ((run.cancellation?.epoch ?? 0) !== effect.fenceEpoch) {
      effect.status = "confirmed";
      effect.confirmedAt = now;
      effect.externalRef = spawned.name;
      if (!activation.beeHandles.some((handle) => handle.name === spawned.name)) {
        activation.beeHandles.push({ name: spawned.name, ...(spawned.id ? { id: spawned.id } : {}), source: recover ? "adopted" : "spawn" });
      }
      reopenCleanupForBee(run, spawned.name, now);
      recordRunEvent(run, "comb.effect.confirmed", activation.address, {
        effectKey: effect.key,
        externalRef: spawned.name,
        cancellationFenceCrossed: true,
      });
      return "confirmed-after-cancel";
    }
    effect.status = "confirmed";
    effect.confirmedAt = now;
    effect.externalRef = spawned.name;
    if (!activation.beeHandles.some((handle) => handle.name === spawned.name)) {
      activation.beeHandles.push({ name: spawned.name, ...(spawned.id ? { id: spawned.id } : {}), source: recover ? "adopted" : "spawn" });
    }
    recordRunEvent(run, "comb.effect.confirmed", activation.address, { effectKey: effect.key, externalRef: spawned.name });
    return "confirmed";
  });
  return {
    run: plan.runId,
    action: recover ? "adopted" : "spawned",
    activation: plan.activationId,
    bee: spawned.name,
    detail: confirmed.result,
  };
}

async function reconcileTerminalEffects(
  deps: CombSweepDeps,
  runId: string,
): Promise<CombSweepOutcome[]> {
  const prepared = await mutateRun(runId, (run) => {
    if (run.status === "active") return [] as Array<{ key: string; activationId: string; name?: string }>;
    const now = new Date(deps.now()).toISOString();
    if (run.cleanup.status === "not-required") initializeRunCleanup(run, now);
    const candidates: Array<{ key: string; activationId: string; name?: string }> = [];
    for (const effect of Object.values(run.effects)) {
      if (effect.scope.kind !== "activation") continue;
      const effectActivation = effect.scope.activation;
      const activationId = `${effectActivation.nodeId}@${effectActivation.attempt}#${effectActivation.itemIndex}`;
      if (effect.status === "prepared") {
        effect.status = "not-executed";
        effect.confirmedAt = now;
        recordRunEvent(run, "comb.effect.failed", effectActivation, {
          effectKey: effect.key,
          outcome: "not-executed",
        });
      } else if (effect.status === "executing" || effect.status === "ambiguous") {
        candidates.push({ key: effect.key, activationId, ...(effect.externalRef ? { name: effect.externalRef } : {}) });
      }
    }
    if (run.cleanup.status === "blocked-ambiguous") run.cleanup.status = "pending";
    return candidates;
  });
  const outcomes: CombSweepOutcome[] = [];
  for (const candidate of prepared.result) {
    const existing = candidate.name ? await deps.lookupAgent(candidate.name) : null;
    const classified = await mutateRun(runId, (run) => {
      const effect = run.effects[candidate.key];
      const activation = run.activations[candidate.activationId];
      if (!effect || !activation || (effect.status !== "executing" && effect.status !== "ambiguous")) return "unchanged";
      const now = new Date(deps.now()).toISOString();
      if (
        existing &&
        existing.contract?.taskId === activation.taskId &&
        existing.contract?.attempt === activation.address.attempt
      ) {
        effect.status = "confirmed";
        effect.confirmedAt = now;
        effect.externalRef = existing.name;
        if (!activation.beeHandles.some((handle) => handle.name === existing.name)) {
          activation.beeHandles.push({
            name: existing.name,
            ...(existing.id ? { id: existing.id } : {}),
            source: "adopted",
          });
        }
        reopenCleanupForBee(run, existing.name, now);
        recordRunEvent(run, "comb.effect.confirmed", activation.address, {
          effectKey: effect.key,
          externalRef: existing.name,
          recoveredDuringCleanup: true,
        });
        return "confirmed";
      }
      effect.status = "failed";
      effect.confirmedAt = now;
      effect.error = existing
        ? `cleanup adoption contract mismatch for ${existing.name}`
        : "cleanup found no spawned session";
      if (existing) {
        recordRunEvent(run, "comb.violation", activation.address, {
          code: "spawn-adoption-mismatch",
          effectKey: effect.key,
          externalRef: existing.name,
        });
      }
      recordRunEvent(run, "comb.effect.failed", activation.address, {
        effectKey: effect.key,
        outcome: "failed",
      });
      return "failed";
    });
    outcomes.push({
      run: runId,
      action: "cleanup",
      activation: candidate.activationId,
      ...(candidate.name ? { bee: candidate.name } : {}),
      detail: `effect-${classified.result}`,
    });
  }
  return outcomes;
}

async function driveCleanup(deps: CombSweepDeps, runId: string): Promise<CombSweepOutcome[]> {
  const before = await mutateRun(runId, (run) => {
    if (run.status !== "active" && run.cleanup.status === "not-required") {
      initializeRunCleanup(run, new Date(deps.now()).toISOString());
    }
    return {
      runStatus: run.status,
      status: run.cleanup.status,
      bees: [...run.cleanup.pendingBeeNames],
      claimId: run.subjectClaimId,
      claimReleasedAt: run.subjectClaimReleasedAt,
    };
  });
  if (before.result.runStatus === "active" || before.result.status === "not-required") return [];
  const outcomes: CombSweepOutcome[] = [];
  const remaining: string[] = [];
  for (const bee of before.result.bees) {
    try {
      await deps.retireAgent(bee);
      outcomes.push({ run: runId, action: "cleanup", bee, detail: "retired" });
    } catch (error) {
      remaining.push(bee);
      outcomes.push({ run: runId, action: "error", bee, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const completed = await mutateRun(runId, (run) => {
    if (run.cleanup.status === "complete") return true;
    if (run.cleanup.status !== "pending" && run.cleanup.status !== "blocked-ambiguous") return false;
    run.cleanup.pendingBeeNames = remaining;
    const unresolved = Object.values(run.effects).filter((effect) => effect.status === "prepared" || effect.status === "executing" || effect.status === "ambiguous");
    run.cleanup.pendingEffectKeys = unresolved.map((effect) => effect.key);
    if (remaining.length || unresolved.length) {
      run.cleanup.status = unresolved.some((effect) => effect.status === "ambiguous")
        ? "blocked-ambiguous"
        : "pending";
      return false;
    }
    const now = new Date(deps.now()).toISOString();
    run.cleanup.status = "complete";
    run.cleanup.completedAt = now;
    run.endedAt ??= now;
    recordRunEvent(run, "comb.run.cleanup_complete");
    return true;
  });
  if (completed.result && before.result.claimId && !before.result.claimReleasedAt && deps.releaseClaim) {
    await deps.releaseClaim(before.result.claimId, runId);
    const releasedAt = new Date(deps.now()).toISOString();
    await mutateRun(runId, (run) => {
      if (run.subjectClaimReleasedAt) return;
      run.subjectClaimReleasedAt = releasedAt;
      recordRunEvent(run, "comb.claim.released", undefined, { claimId: before.result.claimId! });
    });
    outcomes.push({ run: runId, action: "cleanup", detail: "claim-released" });
  }
  return outcomes;
}

function reopenCleanupForBee(run: RunRecord, beeName: string, now: string): void {
  if (run.cleanup.status === "complete" || run.cleanup.status === "not-required") {
    run.cleanup.status = "pending";
    run.cleanup.startedAt ??= now;
    delete run.cleanup.completedAt;
  } else if (run.cleanup.status === "blocked-ambiguous") {
    run.cleanup.status = "pending";
  }
  run.cleanup.pendingBeeNames = [...new Set([...run.cleanup.pendingBeeNames, beeName])];
}

function renderAgentBrief(run: RunRecord, activation: ActivationRecord, node: Extract<RunRecord["currentSnapshot"]["definition"]["nodes"][number], { executor: "agent" }>): string {
  const rendered = renderBrief(node.agent.brief, run.input, undefined, Object.values(run.activations));
  const expectations = node.agent.expectations?.length
    ? `\nExpected evidence:\n${node.agent.expectations.map((expectation) => `- ${expectation.id}: ${expectation.description}`).join("\n")}`
    : "";
  return `${rendered}${expectations}\n\nThis is strict comb activation ${activation.id}. Do only the requested review work and return structured output in your completion seal.`;
}

export function deterministicAgentName(runId: string, activation: ActivationRecord): string {
  const suffix = canonicalDigest(runId).slice("sha256:".length, "sha256:".length + 12);
  const node = activation.address.nodeId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 28);
  return `comb-${suffix}-${node}-i${activation.address.itemIndex}-a${activation.address.attempt}`;
}

function currentActivations(run: RunRecord): ActivationRecord[] {
  return Object.values(run.activations).filter((activation) => activation.invalidatedAt === undefined);
}

function isTerminal(activation: ActivationRecord): boolean {
  return activation.status === "done" || activation.status === "failed" || activation.status === "skipped";
}
