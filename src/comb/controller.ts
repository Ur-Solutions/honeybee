import type { SealRecord } from "../seal.js";
import type { BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";
import { withContractPostscript } from "../contract.js";
import { combTrackPostscript } from "./attachment.js";
import { canonicalDigest } from "./canonical.js";
import { ingestForumVerdictEvidence, ingestSealEvidence } from "./evidence.js";
import {
  applyHumanVerdict,
  applySealCompletion,
  activateAgent,
  effectBaseKey,
  evaluatePredicate,
  reconcileMachine,
  terminalizeRun,
} from "./machine.js";
import { renderBrief } from "./schema.js";
import { initializeRunCleanup, mutateRun, recordRunEvent, saveEvidence, type listSweepableRuns } from "./store.js";
import type {
  ActivationRecord,
  EffectRecord,
  ForumPacket,
  HumanPacketRef,
  JsonValue,
  ReviewFeedbackDestination,
  RunRecord,
} from "./types.js";
import type {
  ForumPacketEffectRequest,
  ForumPacketListResult,
  ForumPacketQuarantine,
} from "./forum.js";

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

export type AgentAdoptRequest = AgentSpawnRequest & {
  trackDigest: string;
};

export type CombSweepOutcome = {
  run: string;
  action: "noop" | "reconciled" | "spawned" | "adopted" | "packet" | "notified" | "failed" | "cleanup" | "error";
  activation?: string;
  bee?: string;
  detail?: string;
  error?: string;
};

export type CombSweepDeps = {
  listRuns: typeof listSweepableRuns;
  latestSeal: (beeName: string) => Promise<LatestCombSeal>;
  spawnAgent: (request: AgentSpawnRequest) => Promise<{ name: string; id?: string }>;
  adoptAgent?: (request: AgentAdoptRequest) => Promise<{ name: string; id?: string }>;
  lookupAgent: (name: string) => Promise<SessionRecord | null>;
  retireAgent: (name: string) => Promise<void>;
  listHumanPackets?: () => Promise<ForumPacket[] | ForumPacketListResult>;
  executeHumanEffect?: (request: ForumPacketEffectRequest) => Promise<ForumPacket>;
  packetDigest?: (packet: ForumPacket) => string;
  notifyOperator?: (notice: HumanStallNotice) => Promise<void>;
  notifyPacketQuarantine?: (notice: HumanPacketQuarantineNotice) => Promise<void>;
  releaseClaim?: (claimId: string, runId: string) => Promise<void>;
  withRunSweepLock?: <T>(runId: string, fn: () => Promise<T>) => Promise<T>;
  now: () => number;
};

type PreparedAgentEffect = {
  runId: string;
  activationId: string;
  effectKey: string;
  request: AgentSpawnRequest;
  mode: "spawn" | "adopt";
};

type PreparedHumanEffect = {
  runId: string;
  activationId: string;
  effectKey: string;
  request: ForumPacketEffectRequest;
};

export type HumanStallNotice = {
  runId: string;
  activation: ActivationRecord["address"];
  packetId: string;
  blockingSince: string;
  thresholdMs: number;
  recipient?: string;
  message: string;
};

export type HumanPacketQuarantineNotice = ForumPacketQuarantine & {
  message: string;
};

export async function sweepCombs(
  deps: CombSweepDeps,
  records: readonly SessionRecord[],
  observed: ReadonlyMap<string, BeeState>,
): Promise<CombSweepOutcome[]> {
  const outcomes: CombSweepOutcome[] = [];
  const runs = await deps.listRuns();
  const hasHumanNodes = runs.some((run) =>
    run.currentSnapshot.definition.nodes.some((node) => node.executor === "human")
  );
  let packets: ForumPacket[] = [];
  let quarantined: ForumPacketQuarantine[] = [];
  if (hasHumanNodes && deps.listHumanPackets) {
    try {
      const polled = await deps.listHumanPackets();
      if (Array.isArray(polled)) {
        packets = polled;
      } else {
        packets = polled.packets;
        quarantined = polled.quarantined;
      }
    } catch (error) {
      outcomes.push({
        run: "*",
        action: "error",
        error: `Forum packet poll degraded: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  for (const packet of quarantined) {
    outcomes.push({
      run: packet.runId ?? "*",
      action: "error",
      detail: `quarantined Forum packet${packet.packetId ? ` ${packet.packetId}` : ""}`,
      error: packet.error,
    });
    if (!deps.notifyPacketQuarantine) continue;
    try {
      await deps.notifyPacketQuarantine({
        ...packet,
        message:
          `Comb quarantined malformed Forum packet${packet.packetId ? ` ${packet.packetId}` : ""} ` +
          `at list index ${packet.index}: ${packet.error}`,
      });
    } catch (error) {
      outcomes.push({
        run: packet.runId ?? "*",
        action: "error",
        error: `Forum quarantine notification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
  const packetsById = new Map(packets.map((packet) => [packet.id, packet]));
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  for (const listed of runs) {
    try {
      const sweep = () => sweepOneRun(deps, listed.id, recordsByName, observed, packetsById);
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
  packets: ReadonlyMap<string, ForumPacket>,
): Promise<CombSweepOutcome[]> {
  const outcomes: CombSweepOutcome[] = [];
  const now = new Date(deps.now()).toISOString();
  const prepared: PreparedAgentEffect[] = [];
  const preparedHuman: PreparedHumanEffect[] = [];
  const stallNotices: HumanStallNotice[] = [];
  const first = await mutateRun(runId, async (run) => {
    if (run.status === "active") {
      run.packetThreads ??= [];
      await ingestAgentEvidence(deps, run, now);
      await ingestHumanEvidence(deps, run, packets, now);
      stallNotices.push(...await reconcileHumanStalls(run, now));
      reconcileDeadOrStalledAgents(run, records, observed, now);
      reconcileMachine(run, now);
      prepared.push(...planAgentEffects(run, records, now));
      preparedHuman.push(...planHumanEffects(run, records, packets, now));
    }
  });
  if (first.changed) outcomes.push({ run: runId, action: "reconciled" });

  for (const plan of prepared) {
    const result = await executeAgentEffect(deps, plan);
    outcomes.push(result);
  }
  for (const plan of preparedHuman) {
    outcomes.push(await executeHumanEffect(deps, plan));
  }
  for (const notice of stallNotices) {
    if (!deps.notifyOperator) continue;
    try {
      await deps.notifyOperator(notice);
      outcomes.push({
        run: runId,
        action: "notified",
        activation: `${notice.activation.nodeId}@${notice.activation.attempt}#${notice.activation.itemIndex}`,
        detail: notice.recipient ? `operator ${notice.recipient}` : "operator",
      });
    } catch (error) {
      outcomes.push({
        run: runId,
        action: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await mutateRun(runId, (run) => {
    if (run.status === "active") reconcileMachine(run, new Date(deps.now()).toISOString());
  });
  outcomes.push(...await recoverTerminalHumanEffects(deps, runId));
  const withdrawals = await mutateRun(runId, async (run) => {
    if (run.status === "active") return [] as PreparedHumanEffect[];
    await ingestTerminalHumanEvidence(deps, run, packets);
    return planPacketWithdrawals(run, packets, new Date(deps.now()).toISOString());
  });
  for (const plan of withdrawals.result) {
    outcomes.push(await executeHumanEffect(deps, plan));
  }
  outcomes.push(...await reconcileTerminalEffects(deps, runId));
  outcomes.push(...await driveCleanup(deps, runId));
  if (outcomes.length === 0) outcomes.push({ run: runId, action: "noop" });
  return outcomes;
}

async function ingestAgentEvidence(deps: CombSweepDeps, run: RunRecord, now: string): Promise<void> {
  const routes = new Map<
    string,
    Array<{ activation: ActivationRecord; source: ActivationRecord["beeHandles"][number]["source"] }>
  >();
  for (const activation of Object.values(run.activations)) {
    if (activation.beeHandles.length === 0 || (isTerminal(activation) && !activation.invalidatedAt)) continue;
    for (const handle of activation.beeHandles) {
      const candidates = routes.get(handle.name) ?? [];
      candidates.push({ activation, source: handle.source });
      routes.set(handle.name, candidates);
    }
  }
  for (const [beeName, candidates] of routes) {
    const latest = await deps.latestSeal(beeName);
    if (!latest) continue;
    const exact = candidates.find(({ activation }) =>
      latest.seal.taskId === activation.taskId &&
      latest.seal.attempt === activation.address.attempt
    );
    const liveCandidates = candidates
      .filter(({ activation }) => !activation.invalidatedAt && !isTerminal(activation))
      .sort((left, right) => right.activation.address.attempt - left.activation.address.attempt);
    const selected = exact ?? liveCandidates.find(
      ({ activation }) => latest.seal.taskId === activation.taskId,
    );
    if (!selected) {
      const adopted = liveCandidates.find(({ source }) => source === "adopted");
      if (adopted) {
        await ingestSealEvidence(
          run,
          adopted.activation,
          latest.filename,
          latest.seal,
          { mismatchDisposition: "inert" },
        );
      }
      continue;
    }
    const priorReboundAttempt = !exact &&
      selected.source === "adopted" &&
      candidates.some(({ activation }) =>
        activation.address.nodeId === selected.activation.address.nodeId &&
        activation.address.itemIndex === selected.activation.address.itemIndex &&
        activation.address.attempt < selected.activation.address.attempt &&
        Boolean(activation.invalidatedAt)
      );
    const result = await ingestSealEvidence(
      run,
      selected.activation,
      latest.filename,
      latest.seal,
      priorReboundAttempt ? { mismatchDisposition: "inert" } : {},
    );
    if (result === "match") {
      applySealCompletion(run, selected.activation, latest.seal, now);
    }
  }
}

async function ingestHumanEvidence(
  deps: CombSweepDeps,
  run: RunRecord,
  packets: ReadonlyMap<string, ForumPacket>,
  now: string,
): Promise<void> {
  for (const activation of currentActivations(run)) {
    const node = run.currentSnapshot.definition.nodes.find(
      (candidate) => candidate.id === activation.address.nodeId,
    );
    if (node?.executor !== "human" || activation.status !== "waiting-human" || !activation.packetId) continue;
    const packet = packets.get(activation.packetId);
    if (!packet) continue;
    activation.packetDigest = deps.packetDigest
      ? deps.packetDigest(packet)
      : canonicalDigest(packet as unknown as JsonValue);
    if (packet.blocking_since) activation.blockingSince = packet.blocking_since;
    if (
      packet.status !== "approved" &&
      packet.status !== "resolved" &&
      packet.status !== "changes_requested"
    ) continue;
    const thread = (run.packetThreads ?? []).find((candidate) => candidate.key === activation.threadId);
    const expected = thread?.packetTail.find(
      (candidate) =>
        candidate.packetId === activation.packetId &&
        candidate.status === "current",
    );
    if (!expected || !packet.verdict) continue;
    const ingested = await ingestForumVerdictEvidence(run, activation, packet, expected);
    if (ingested.result !== "match" || !ingested.verdict) continue;
    applyHumanVerdict(
      run,
      activation,
      {
        verdict: ingested.verdict.verdict,
        comment: ingested.verdict.comment,
        destination: ingested.verdict.destination,
      },
      now,
    );
  }
}

async function ingestTerminalHumanEvidence(
  deps: CombSweepDeps,
  run: RunRecord,
  packets: ReadonlyMap<string, ForumPacket>,
): Promise<void> {
  for (const activation of currentActivations(run)) {
    if (!activation.packetId) continue;
    const packet = packets.get(activation.packetId);
    if (!packet?.verdict) continue;
    activation.packetDigest = deps.packetDigest
      ? deps.packetDigest(packet)
      : canonicalDigest(packet as unknown as JsonValue);
    const thread = (run.packetThreads ?? []).find((candidate) => candidate.key === activation.threadId);
    const expected = thread?.packetTail.find(
      (candidate) =>
        candidate.packetId === activation.packetId &&
        candidate.status === "current",
    );
    if (expected) await ingestForumVerdictEvidence(run, activation, packet, expected);
  }
}

async function reconcileHumanStalls(run: RunRecord, now: string): Promise<HumanStallNotice[]> {
  const notices: HumanStallNotice[] = [];
  for (const activation of currentActivations(run)) {
    if (
      activation.status !== "waiting-human" ||
      !activation.packetId ||
      !activation.blockingSince ||
      activation.stallNotifiedAt
    ) continue;
    const edges = run.currentSnapshot.definition.edges
      .filter(
        (edge) =>
          edge.kind === "waiting" &&
          edge.on === "waiting" &&
          edge.from === activation.address.nodeId &&
          edge.when?.kind === "clock" &&
          edge.when.from === "blocking-since",
      )
      .sort((left, right) =>
        (left.when?.kind === "clock" ? left.when.afterMs : 0) -
        (right.when?.kind === "clock" ? right.when.afterMs : 0)
      );
    const due = edges.find((edge) =>
      evaluatePredicate(run, edge.when!, {
        itemIndex: activation.address.itemIndex,
        now,
        activation,
      }).state === "true"
    );
    if (!due || due.when?.kind !== "clock") continue;
    const dueAt = new Date(Date.parse(activation.blockingSince) + due.when.afterMs).toISOString();
    const evidenceId = canonicalDigest({
      activation: activation.address,
      basis: "blocking-since",
      thresholdMs: due.when.afterMs,
      dueAt,
    });
    const envelope = {
      schemaVersion: 1 as const,
      id: evidenceId,
      activation: activation.address,
      taskId: activation.taskId,
      subject: activation.subject,
      producer: { kind: "engine" as const, id: run.id },
      recordedAt: now,
      kind: "clock" as const,
      payload: {
        basis: "blocking-since",
        thresholdMs: due.when.afterMs,
        dueAt,
      },
    };
    const ref = await saveEvidence(run.id, envelope);
    activation.evidenceCount += 1;
    activation.evidenceTail.push(ref);
    if (activation.evidenceTail.length > 128) {
      activation.evidenceTail.splice(0, activation.evidenceTail.length - 128);
    }
    activation.stallNotifiedAt = now;
    recordRunEvent(run, "comb.evidence.recorded", activation.address, {
      evidenceId,
      kind: "clock",
    });
    const recipient = operatorRecipient(run, activation);
    notices.push({
      runId: run.id,
      activation: activation.address,
      packetId: activation.packetId,
      blockingSince: activation.blockingSince,
      thresholdMs: due.when.afterMs,
      ...(recipient ? { recipient } : {}),
      message:
        `Human review is stalled for comb ${run.currentSnapshot.definition.name} run ${run.id}. ` +
        `Packet ${activation.packetId} has blocked ${activation.address.nodeId} since ${activation.blockingSince}.`,
    });
  }
  return notices;
}

function operatorRecipient(run: RunRecord, activation: ActivationRecord): string | undefined {
  if (run.origin.kind === "attached") return run.origin.beeName;
  const node = run.currentSnapshot.definition.nodes.find(
    (candidate) => candidate.id === activation.address.nodeId,
  );
  if (node?.executor !== "human" || node.human.feedbackDestination.type !== "bee") return undefined;
  const fromNodeId = node.human.feedbackDestination.fromNodeId;
  return currentActivations(run)
    .filter(
      (candidate) =>
        candidate.address.nodeId === fromNodeId &&
        candidate.address.itemIndex === activation.address.itemIndex,
    )
    .sort((left, right) => right.address.attempt - left.address.attempt)[0]
    ?.beeHandles[0]
    ?.name;
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

function planAgentEffects(
  run: RunRecord,
  records: ReadonlyMap<string, SessionRecord>,
  now: string,
): PreparedAgentEffect[] {
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
    const adoptTarget = resolveAgentAdoptTarget(run, activation, records, now);
    if (adoptTarget === null) continue;
    const mode = adoptTarget ? "adopt" as const : "spawn" as const;
    if (
      run.origin.kind === "attached" &&
      activation.address.attempt === 1 &&
      activation.address.nodeId === run.origin.entryNodeId &&
      !adoptTarget
    ) {
      continue;
    }
    if (mode === "adopt") {
      const contractBrief = withContractPostscript(brief, {
        completion: "seal",
        taskId: activation.taskId,
        attempt: activation.address.attempt,
      });
      brief = `${contractBrief ? `${contractBrief}\n\n` : ""}${combTrackPostscript(run, activation, node)}`;
    }
    const semanticId = mode === "adopt" ? `bee:${adoptTarget}` : "primary";
    const semanticDigest = canonicalDigest(semanticId);
    const effectKind = mode === "adopt" ? "agent-adopt" : "agent-spawn";
    const key = `${effectBaseKey(activation)}:${effectKind}:${semanticDigest.slice("sha256:".length)}`;
    const baseRequest: AgentSpawnRequest = {
      runId: run.id,
      activation: activation.address,
      name: adoptTarget ?? deterministicAgentName(run.id, activation),
      agent: node.agent.capacity.bee,
      ...(node.agent.capacity.account ? { account: node.agent.capacity.account } : {}),
      ...(node.agent.capacity.model ? { model: node.agent.capacity.model } : {}),
      substrate: node.agent.capacity.substrate ?? "hsr",
      cwd: run.cwd,
      brief,
      taskId: activation.taskId,
      attempt: activation.address.attempt,
    };
    const request: AgentSpawnRequest | AgentAdoptRequest = mode === "adopt"
      ? {
          ...baseRequest,
          trackDigest: canonicalDigest(brief),
        }
      : baseRequest;
    const requestDigest = canonicalDigest(request as unknown as JsonValue);
    const existing = run.effects[key];
    if (existing) {
      const executionRequest =
        existing.kind === "agent-adopt" && existing.request
          ? existing.request as unknown as AgentAdoptRequest
          : request;
      const executionRequestDigest = canonicalDigest(executionRequest as unknown as JsonValue);
      if (existing.status === "confirmed") {
        continue;
      }
      if (existing.requestDigest !== executionRequestDigest) {
        terminalizeRun(run, "failed", {
          code: "effect-key-collision",
          message: `effect ${key} was replanned with a different request`,
          activation: activation.address,
        }, now, activation.address);
        recordRunEvent(run, "comb.violation", activation.address, { code: "effect-key-collision", effectKey: key });
      } else if (existing.status === "prepared" || existing.status === "executing") {
        plans.push({
          runId: run.id,
          activationId: activation.id,
          effectKey: key,
          request: executionRequest,
          mode,
        });
        if (activation.status === "pending") available -= 1;
      }
      continue;
    }
    if (activation.status === "active") continue;
    const effect: EffectRecord = {
      key,
      scope: { kind: "activation", activation: activation.address },
      kind: effectKind,
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
    plans.push({ runId: run.id, activationId: activation.id, effectKey: key, request, mode });
    available -= 1;
  }
  return plans;
}

function resolveAgentAdoptTarget(
  run: RunRecord,
  activation: ActivationRecord,
  records: ReadonlyMap<string, SessionRecord>,
  now: string,
): string | undefined | null {
  if (
    run.origin.kind === "attached" &&
    activation.address.nodeId === run.origin.entryNodeId &&
    activation.address.attempt === 1
  ) {
    return run.origin.beeName;
  }
  if (activation.retryContext?.verdict !== "request_changes") return undefined;
  const source = run.activations[
    `${activation.retryContext.from.nodeId}@${activation.retryContext.from.attempt}#${activation.retryContext.from.itemIndex}`
  ];
  const output = source?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const destination = output.destination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) return undefined;
  if (destination.type !== "bee" || typeof destination.sessionId !== "string") return undefined;
  const record = [...records.values()].find(
    (candidate) => candidate.name === destination.sessionId || candidate.id === destination.sessionId,
  );
  if (record?.status === "running") return record.name;
  if (run.policies.attachedRetryOnDead === "fail") {
    activation.status = "failed";
    activation.endedAt = now;
    activation.failure = {
      code: "attached-retry-bee-dead",
      message: `human feedback destination ${destination.sessionId} is not a live bee`,
      retryable: false,
    };
    recordRunEvent(run, "comb.activation.failed", activation.address, {
      code: "attached-retry-bee-dead",
      destination: destination.sessionId,
    });
  }
  return run.policies.attachedRetryOnDead === "fail" ? null : undefined;
}

function planHumanEffects(
  run: RunRecord,
  records: ReadonlyMap<string, SessionRecord>,
  packets: ReadonlyMap<string, ForumPacket>,
  now: string,
): PreparedHumanEffect[] {
  if (run.cancellation || run.status !== "active") return [];
  const plans: PreparedHumanEffect[] = [];
  run.packetThreads ??= [];
  for (const activation of currentActivations(run)) {
    if (activation.status !== "pending" && activation.status !== "active") continue;
    const node = run.currentSnapshot.definition.nodes.find(
      (candidate) => candidate.id === activation.address.nodeId,
    );
    if (node?.executor !== "human") continue;
    const threadId = humanThreadId(activation);
    const thread = run.packetThreads.find((candidate) => candidate.key === threadId);
    const current = thread?.packetTail.find(
      (candidate) =>
        candidate.packetId === thread.currentPacketId &&
        candidate.status === "current",
    );
    const currentPacket = current ? packets.get(current.packetId) : undefined;
    if (current && !currentPacket) continue;
    const samePins = current ? packetPinsMatch(run, activation, current) : false;
    const reusableStatus = currentPacket?.status === "changes_requested" ||
      currentPacket?.status === "needs_review" ||
      currentPacket?.status === "in_review";
    const operation: ForumPacketEffectRequest["operation"] =
      !current ? "create" : samePins && reusableStatus ? "rerequest" : "successor";
    let destination: ReviewFeedbackDestination;
    try {
      destination = resolveHumanDestination(run, activation, node, records);
    } catch (error) {
      activation.status = "failed";
      activation.endedAt = now;
      activation.failure = {
        code: "human-feedback-destination-unavailable",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
      recordRunEvent(run, "comb.activation.failed", activation.address, {
        code: "human-feedback-destination-unavailable",
      });
      continue;
    }
    const kind = operation === "create"
      ? "forum-create"
      : operation === "rerequest"
        ? "forum-rerequest"
        : "forum-successor";
    const semanticId = operation === "rerequest"
      ? `${threadId}:attempt:${activation.address.attempt}`
      : `${threadId}:${activation.subject.revision}:${run.currentSnapshot.definitionDigest}`;
    const semanticDigest = canonicalDigest(semanticId);
    const key = `${effectBaseKey(activation)}:${kind}:${semanticDigest.slice("sha256:".length)}`;
    const request: ForumPacketEffectRequest = {
      operation,
      idempotencyKey: key,
      runId: run.id,
      nodeId: activation.address.nodeId,
      itemIndex: activation.address.itemIndex,
      snapshotRevision: activation.nodeSnapshotRevision,
      definitionDigest: run.currentSnapshot.definitionDigest,
      actionBindingDigest: run.currentSnapshot.actionBindingDigest,
      subject: activation.subject,
      combName: run.currentSnapshot.definition.name,
      cwd: run.cwd,
      definition: run.currentSnapshot.definition,
      human: node.human,
      destination,
      ...(current ? { predecessorPacketId: current.packetId } : {}),
    };
    const requestDigest = humanEffectRequestDigest(request);
    const existing = run.effects[key];
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        terminalizeRun(run, "failed", {
          code: "effect-key-collision",
          message: `effect ${key} was replanned with a different request`,
          activation: activation.address,
        }, now, activation.address);
        recordRunEvent(run, "comb.violation", activation.address, {
          code: "effect-key-collision",
          effectKey: key,
        });
      } else if (existing.status === "prepared" || existing.status === "executing") {
        plans.push({
          runId: run.id,
          activationId: activation.id,
          effectKey: key,
          request: existing.request
            ? existing.request as unknown as ForumPacketEffectRequest
            : request,
        });
      }
      continue;
    }
    if (activation.status === "active") continue;
    const effect: EffectRecord = {
      key,
      scope: { kind: "activation", activation: activation.address },
      kind,
      semanticId,
      semanticDigest,
      fenceEpoch: 0,
      status: "prepared",
      preparedAt: now,
      ...(current ? { externalRef: current.packetId } : {}),
      requestDigest,
      request: request as unknown as JsonValue,
      verificationEvidenceIds: [],
    };
    run.effects[key] = effect;
    activation.effectKeys.push(key);
    recordRunEvent(run, "comb.effect.prepared", activation.address, {
      effectKey: key,
      kind,
    });
    plans.push({ runId: run.id, activationId: activation.id, effectKey: key, request });
  }
  return plans;
}

function humanEffectRequestDigest(request: ForumPacketEffectRequest): string {
  const { destination: _volatileDestination, ...stableRequest } = request;
  return canonicalDigest(stableRequest as unknown as JsonValue);
}

function planPacketWithdrawals(
  run: RunRecord,
  packets: ReadonlyMap<string, ForumPacket>,
  now: string,
): PreparedHumanEffect[] {
  const plans: PreparedHumanEffect[] = [];
  for (const packetId of [...run.cleanup.pendingPacketIds]) {
    const observed = packets.get(packetId);
    if (
      observed?.status === "approved" ||
      observed?.status === "resolved" ||
      observed?.status === "superseded" ||
      observed?.status === "archived"
    ) {
      markPacketWithdrawn(run, packetId, now);
      continue;
    }
    const activation = Object.values(run.activations).find(
      (candidate) => candidate.packetId === packetId,
    );
    if (!activation) {
      recordRunEvent(run, "comb.violation", undefined, {
        code: "packet-withdrawal-activation-missing",
        packetId,
      });
      continue;
    }
    const node = run.currentSnapshot.definition.nodes.find(
      (candidate) =>
        candidate.id === activation.address.nodeId &&
        candidate.executor === "human",
    );
    if (!node || node.executor !== "human") {
      recordRunEvent(run, "comb.violation", activation.address, {
        code: "packet-withdrawal-node-missing",
        packetId,
      });
      continue;
    }
    const semanticId = `packet:${packetId}:cancellation:${run.cancellation?.epoch ?? 0}`;
    const semanticDigest = canonicalDigest(semanticId);
    const key = `run:${run.id}:forum-withdraw:${semanticDigest.slice("sha256:".length)}`;
    const request: ForumPacketEffectRequest = {
      operation: "withdraw",
      idempotencyKey: key,
      runId: run.id,
      nodeId: activation.address.nodeId,
      itemIndex: activation.address.itemIndex,
      snapshotRevision: activation.nodeSnapshotRevision,
      definitionDigest: run.currentSnapshot.definitionDigest,
      actionBindingDigest: run.currentSnapshot.actionBindingDigest,
      subject: activation.subject,
      combName: run.currentSnapshot.definition.name,
      cwd: run.cwd,
      definition: run.currentSnapshot.definition,
      human: node.human,
      destination: { type: "new-agent" },
      predecessorPacketId: packetId,
    };
    const requestDigest = canonicalDigest(request as unknown as JsonValue);
    const existing = run.effects[key];
    if (existing) {
      if (
        existing.status === "prepared" ||
        existing.status === "executing" ||
        existing.status === "ambiguous"
      ) {
        plans.push({
          runId: run.id,
          activationId: activation.id,
          effectKey: key,
          request,
        });
      }
      continue;
    }
    const effect: EffectRecord = {
      key,
      scope: { kind: "activation", activation: activation.address },
      kind: "forum-withdraw",
      semanticId,
      semanticDigest,
      fenceEpoch: run.cancellation?.epoch ?? 0,
      status: "prepared",
      preparedAt: now,
      externalRef: packetId,
      requestDigest,
      request: request as unknown as JsonValue,
      verificationEvidenceIds: [],
    };
    run.effects[key] = effect;
    activation.effectKeys.push(key);
    run.cleanup.pendingEffectKeys = [...new Set([...run.cleanup.pendingEffectKeys, key])];
    recordRunEvent(run, "comb.effect.prepared", activation.address, {
      effectKey: key,
      kind: effect.kind,
    });
    plans.push({
      runId: run.id,
      activationId: activation.id,
      effectKey: key,
      request,
    });
  }
  return plans;
}

async function recoverTerminalHumanEffects(
  deps: CombSweepDeps,
  runId: string,
): Promise<CombSweepOutcome[]> {
  const recoverable = await mutateRun(runId, (run) => {
    if (run.status === "active") return [] as PreparedHumanEffect[];
    const plans: PreparedHumanEffect[] = [];
    for (const effect of Object.values(run.effects)) {
      if (
        effect.kind === "forum-withdraw" ||
        (effect.kind !== "forum-create" &&
          effect.kind !== "forum-rerequest" &&
          effect.kind !== "forum-successor") ||
        (effect.status !== "executing" && effect.status !== "ambiguous") ||
        effect.scope.kind !== "activation" ||
        !effect.request
      ) continue;
      const activationId =
        `${effect.scope.activation.nodeId}@${effect.scope.activation.attempt}#${effect.scope.activation.itemIndex}`;
      plans.push({
        runId,
        activationId,
        effectKey: effect.key,
        request: effect.request as unknown as ForumPacketEffectRequest,
      });
    }
    return plans;
  });
  const outcomes: CombSweepOutcome[] = [];
  for (const plan of recoverable.result) {
    outcomes.push(await executeHumanEffect(deps, plan, true));
  }
  return outcomes;
}

async function executeHumanEffect(
  deps: CombSweepDeps,
  plan: PreparedHumanEffect,
  allowTerminalRecovery = false,
): Promise<CombSweepOutcome> {
  const start = await mutateRun(plan.runId, (run) => {
    const effect = run.effects[plan.effectKey];
    const activation = run.activations[plan.activationId];
    if (!effect || !activation) return false;
    const withdrawal = plan.request.operation === "withdraw";
    if (
      !withdrawal &&
      !allowTerminalRecovery &&
      (run.cancellation || run.status !== "active")
    ) {
      if (effect.status === "prepared") {
        effect.status = "not-executed";
        effect.confirmedAt = new Date(deps.now()).toISOString();
        recordRunEvent(run, "comb.effect.failed", activation.address, {
          effectKey: effect.key,
          outcome: "not-executed",
        });
      }
      return false;
    }
    if (
      effect.status !== "prepared" &&
      effect.status !== "executing" &&
      effect.status !== "ambiguous"
    ) return false;
    if (effect.status === "prepared") {
      effect.status = "executing";
      effect.executeStartedAt = new Date(deps.now()).toISOString();
      if (!withdrawal) {
        activation.status = "active";
        activation.startedAt ??= effect.executeStartedAt;
        activation.claim.attemptStartedAt ??= effect.executeStartedAt;
        recordRunEvent(run, "comb.activation.active", activation.address);
      }
    }
    return true;
  });
  if (!start.result) return { run: plan.runId, action: "noop", activation: plan.activationId };
  if (!deps.executeHumanEffect) {
    return failHumanEffect(deps, plan, new Error("Forum packet executor is not configured"));
  }
  let packet: ForumPacket;
  try {
    packet = await deps.executeHumanEffect(plan.request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateRun(plan.runId, (run) => {
      const effect = run.effects[plan.effectKey];
      const activation = run.activations[plan.activationId];
      if (
        !effect ||
        !activation ||
        (effect.status !== "executing" && effect.status !== "ambiguous")
      ) return;
      effect.error = message;
      recordRunEvent(run, "comb.effect.failed", activation.address, {
        effectKey: effect.key,
        ambiguous: true,
        retryable: true,
      });
    });
    return {
      run: plan.runId,
      action: "error",
      activation: plan.activationId,
      error: message,
      detail: "Forum command outcome is ambiguous; idempotent execution will resume on the next sweep",
    };
  }
  const confirmed = await mutateRun(plan.runId, (run) => {
    const effect = run.effects[plan.effectKey];
    const activation = run.activations[plan.activationId];
    if (
      !effect ||
      !activation ||
      (effect.status !== "executing" && effect.status !== "ambiguous")
    ) return "ignored";
    const now = new Date(deps.now()).toISOString();
    effect.status = "confirmed";
    effect.confirmedAt = now;
    effect.externalRef = packet.id;
    effect.result = packet as unknown as JsonValue;
    if (plan.request.operation === "withdraw") {
      markPacketWithdrawn(run, packet.id, now);
    } else {
      const fenceCrossed =
        run.status !== "active" ||
        (run.cancellation?.epoch ?? 0) !== effect.fenceEpoch;
      linkHumanPacket(
        run,
        activation,
        packet,
        plan.request,
        deps.packetDigest ? deps.packetDigest(packet) : canonicalDigest(packet as unknown as JsonValue),
        now,
        !fenceCrossed,
      );
      if (fenceCrossed) reopenCleanupForPacket(run, packet.id, now);
    }
    recordRunEvent(run, "comb.effect.confirmed", activation.address, {
      effectKey: effect.key,
      externalRef: packet.id,
      ...(run.cancellation ? { cancellationFenceCrossed: true } : {}),
    });
    return "confirmed";
  });
  return {
    run: plan.runId,
    action: "packet",
    activation: plan.activationId,
    detail: `${plan.request.operation}:${packet.id}:${confirmed.result}`,
  };
}

async function failHumanEffect(
  deps: CombSweepDeps,
  plan: PreparedHumanEffect,
  error: unknown,
): Promise<CombSweepOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  await mutateRun(plan.runId, (run) => {
    const effect = run.effects[plan.effectKey];
    const activation = run.activations[plan.activationId];
    if (!effect || !activation) return;
    effect.status = "failed";
    effect.error = message;
    activation.status = "failed";
    activation.endedAt = new Date(deps.now()).toISOString();
    activation.failure = {
      code: "forum-effect-failed",
      message,
      retryable: true,
    };
    recordRunEvent(run, "comb.effect.failed", activation.address, {
      effectKey: effect.key,
    });
    recordRunEvent(run, "comb.activation.failed", activation.address, {
      code: "forum-effect-failed",
    });
  });
  return {
    run: plan.runId,
    action: "failed",
    activation: plan.activationId,
    error: message,
  };
}

function linkHumanPacket(
  run: RunRecord,
  activation: ActivationRecord,
  packet: ForumPacket,
  request: ForumPacketEffectRequest,
  digest: string,
  now: string,
  activate = true,
): void {
  run.packetThreads ??= [];
  const key = humanThreadId(activation);
  let thread = run.packetThreads.find((candidate) => candidate.key === key);
  if (!thread) {
    const ref = packetRef(packet.id, request, now);
    thread = {
      key,
      nodeId: activation.address.nodeId,
      itemIndex: activation.address.itemIndex,
      packetCount: 1,
      packetTail: [ref],
      currentPacketId: packet.id,
      subject: activation.subject,
      createdAt: now,
      updatedAt: now,
    };
    run.packetThreads.push(thread);
  } else if (request.operation === "successor" && thread.currentPacketId !== packet.id) {
    const predecessor = thread.packetTail.find(
      (candidate) => candidate.packetId === request.predecessorPacketId,
    );
    if (predecessor) {
      predecessor.status = "superseded";
      predecessor.successorPacketId = packet.id;
      predecessor.supersededAt = now;
    }
    thread.packetTail.push({
      ...packetRef(packet.id, request, now),
      ...(request.predecessorPacketId ? { predecessorPacketId: request.predecessorPacketId } : {}),
    });
    if (thread.packetTail.length > 64) {
      thread.packetTail.splice(0, thread.packetTail.length - 64);
    }
    thread.packetCount += 1;
    thread.currentPacketId = packet.id;
    thread.subject = activation.subject;
    thread.updatedAt = now;
  } else {
    thread.updatedAt = now;
  }
  activation.packetId = packet.id;
  activation.packetDigest = digest;
  activation.threadId = key;
  activation.blockingSince = packet.blocking_since ?? now;
  if (!activate) return;
  activation.status = "waiting-human";
  recordRunEvent(run, "comb.activation.waiting_human", activation.address, {
    packetId: packet.id,
    packetDigest: digest,
    threadId: key,
  });
}

function markPacketWithdrawn(run: RunRecord, packetId: string, now: string): void {
  let changed = false;
  for (const thread of run.packetThreads ?? []) {
    const ref = thread.packetTail.find((candidate) => candidate.packetId === packetId);
    if (!ref || ref.status === "withdrawn") continue;
    ref.status = "withdrawn";
    ref.supersededAt = now;
    thread.updatedAt = now;
    changed = true;
  }
  run.cleanup.pendingPacketIds = run.cleanup.pendingPacketIds.filter(
    (candidate) => candidate !== packetId,
  );
  if (changed) recordRunEvent(run, "comb.packet.withdrawn", undefined, { packetId });
}

function reopenCleanupForPacket(run: RunRecord, packetId: string, now: string): void {
  if (run.cleanup.status === "complete" || run.cleanup.status === "not-required") {
    run.cleanup.status = "pending";
    run.cleanup.startedAt ??= now;
    delete run.cleanup.completedAt;
  } else if (run.cleanup.status === "blocked-ambiguous") {
    run.cleanup.status = "pending";
  }
  run.cleanup.pendingPacketIds = [...new Set([...run.cleanup.pendingPacketIds, packetId])];
}

function packetRef(
  packetId: string,
  request: ForumPacketEffectRequest,
  now: string,
): HumanPacketRef {
  return {
    packetId,
    snapshotRevision: request.snapshotRevision,
    definitionDigest: request.definitionDigest,
    actionBindingDigest: request.actionBindingDigest,
    subject: request.subject,
    status: "current",
    createdAt: now,
  };
}

function resolveHumanDestination(
  run: RunRecord,
  activation: ActivationRecord,
  node: Extract<RunRecord["currentSnapshot"]["definition"]["nodes"][number], { executor: "human" }>,
  records: ReadonlyMap<string, SessionRecord>,
): ReviewFeedbackDestination {
  const authored = node.human.feedbackDestination;
  if (authored.type !== "bee") return authored;
  const handles = currentActivations(run)
    .filter(
      (candidate) =>
        candidate.address.nodeId === authored.fromNodeId &&
        candidate.address.itemIndex === activation.address.itemIndex,
    )
    .sort((left, right) => right.address.attempt - left.address.attempt)
    .flatMap((candidate) => candidate.beeHandles);
  const sessionIds = [...new Set(handles.map((handle) => {
    const record = records.get(handle.name);
    return record?.id ?? handle.id ?? handle.name;
  }))];
  if (sessionIds.length !== 1) {
    throw new Error(
      `human feedback destination ${authored.fromNodeId} resolved ${sessionIds.length} current bees`,
    );
  }
  return { type: "bee", sessionId: sessionIds[0]! };
}

function humanThreadId(activation: ActivationRecord): string {
  return `${activation.address.nodeId}#${activation.address.itemIndex}`;
}

function packetPinsMatch(
  run: RunRecord,
  activation: ActivationRecord,
  ref: HumanPacketRef,
): boolean {
  return (
    ref.snapshotRevision === activation.nodeSnapshotRevision &&
    ref.snapshotRevision === run.snapshotRevision &&
    ref.definitionDigest === run.currentSnapshot.definitionDigest &&
    ref.actionBindingDigest === run.currentSnapshot.actionBindingDigest &&
    ref.subject.kind === activation.subject.kind &&
    ref.subject.key === activation.subject.key &&
    ref.subject.revision === activation.subject.revision
  );
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
  if (plan.mode === "adopt") {
    if (!deps.adoptAgent) {
      return failAgentEffect(
        deps,
        plan,
        new Error("attached bee adoption is not configured"),
        "adopt-failed",
      );
    }
    try {
      spawned = await deps.adoptAgent(plan.request as AgentAdoptRequest);
    } catch (error) {
      return failAgentEffect(deps, plan, error, "adopt-failed");
    }
  } else if (recover) {
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
      return failAgentEffect(deps, plan, error, "spawn-failed");
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
          source: plan.mode === "adopt" ? "adopted" : "spawn",
        });
        reopenCleanupForBee(run, spawned.name, now, plan.mode === "spawn");
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
        activation.beeHandles.push({ name: spawned.name, ...(spawned.id ? { id: spawned.id } : {}), source: plan.mode === "adopt" ? "adopted" : "spawn" });
      }
      reopenCleanupForBee(run, spawned.name, now, plan.mode === "spawn");
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
      activation.beeHandles.push({ name: spawned.name, ...(spawned.id ? { id: spawned.id } : {}), source: plan.mode === "adopt" ? "adopted" : "spawn" });
    }
    recordRunEvent(run, "comb.effect.confirmed", activation.address, { effectKey: effect.key, externalRef: spawned.name });
    return "confirmed";
  });
  return {
    run: plan.runId,
    action: plan.mode === "adopt" || recover ? "adopted" : "spawned",
    activation: plan.activationId,
    bee: spawned.name,
    detail: confirmed.result,
  };
}

async function failAgentEffect(
  deps: CombSweepDeps,
  plan: PreparedAgentEffect,
  error: unknown,
  code: "spawn-failed" | "adopt-failed",
): Promise<CombSweepOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  await mutateRun(plan.runId, (run) => {
    const effect = run.effects[plan.effectKey];
    const activation = run.activations[plan.activationId];
    if (!effect || !activation) return;
    effect.status = "failed";
    effect.error = message;
    activation.status = "failed";
    activation.endedAt = new Date(deps.now()).toISOString();
    activation.failure = { code, message, retryable: code === "spawn-failed" };
    recordRunEvent(run, "comb.effect.failed", activation.address, { effectKey: effect.key });
    recordRunEvent(run, "comb.activation.failed", activation.address, { code });
  });
  return {
    run: plan.runId,
    action: "failed",
    activation: plan.activationId,
    error: message,
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
      const forumEffect = effect.kind === "forum-create" ||
        effect.kind === "forum-rerequest" ||
        effect.kind === "forum-successor" ||
        effect.kind === "forum-withdraw";
      if (forumEffect) {
        if (effect.status === "prepared" && effect.kind !== "forum-withdraw") {
          effect.status = "not-executed";
          effect.confirmedAt = now;
          recordRunEvent(run, "comb.effect.failed", effectActivation, {
            effectKey: effect.key,
            outcome: "not-executed",
          });
        }
        continue;
      }
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
            source: effect.kind === "agent-spawn" ? "spawn" : "adopted",
          });
        }
        reopenCleanupForBee(run, existing.name, now, effect.kind === "agent-spawn");
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
    if (remaining.length || run.cleanup.pendingPacketIds.length || unresolved.length) {
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

function reopenCleanupForBee(
  run: RunRecord,
  beeName: string,
  now: string,
  owned: boolean,
): void {
  if (!owned || !run.policies.retireAgentsOnTerminal) return;
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
  const feedback = activation.retryContext?.verdict === "request_changes"
    ? `\n\nHuman feedback for attempt ${activation.address.attempt}:\n${activation.retryContext.comment ?? "(no comment supplied)"}`
    : "";
  return `${rendered}${expectations}${feedback}\n\nThis is strict comb activation ${activation.id}. Do only the requested review work and return structured output in your completion seal.`;
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
