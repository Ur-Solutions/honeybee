import { deliverPromptText } from "../cli/shared.js";
import { withContractPostscript } from "../contract.js";
import { loadSession, touchSession, type SessionRecord } from "../store.js";
import { canonicalDigest } from "./canonical.js";
import { CombError } from "./errors.js";
import { activateAgent, effectBaseKey } from "./machine.js";
import { renderBrief } from "./schema.js";
import { boardView, entryNodeIds, mutateRun, recordRunEvent, requireRun } from "./store.js";
import type {
  ActivationRecord,
  AgentNode,
  EffectRecord,
  JsonValue,
  RunBoardView,
  RunRecord,
} from "./types.js";

export type AttachRunResult = {
  run: RunBoardView;
  activationId: string;
  bee: string;
  trackPostscript: string;
};

export async function attachBeeToRun(options: {
  runId: string;
  beeName: string;
  entryNodeId?: string;
  brief?: string;
  deliver?: boolean;
  now?: () => number;
}): Promise<AttachRunResult> {
  const nowFn = options.now ?? Date.now;
  const session = await loadSession(options.beeName);
  if (!session) throw new CombError("not_found", `bee not found: ${options.beeName}`);
  if (session.status !== "running") {
    throw new CombError("invalid_argument", `bee ${session.name} is terminal (${session.status})`);
  }
  const run = await requireRun(options.runId);
  const entryId = resolveEntryNode(run, options.entryNodeId);
  const activation = currentEntryActivation(run, entryId);
  const node = run.currentSnapshot.definition.nodes.find(
    (candidate) => candidate.id === entryId,
  );
  if (node?.executor !== "agent") {
    throw new CombError("invalid_argument", `attached entry ${entryId} must be an agent node`);
  }
  const trackPostscript = combTrackPostscript(run, activation, node);
  const contract = {
    completion: "seal" as const,
    taskId: activation.taskId,
    attempt: activation.address.attempt,
  };
  const renderedBrief = options.brief ?? renderBrief(
    node.agent.brief,
    run.input,
    undefined,
    Object.values(run.activations),
  );
  const briefWithContract = withContractPostscript(renderedBrief, contract);
  const fullBrief = `${briefWithContract ? `${briefWithContract}\n\n` : ""}${trackPostscript}`;
  const trackDigest = canonicalDigest(fullBrief);
  const semanticId = `bee:${session.id ?? session.name}`;
  const semanticDigest = canonicalDigest(semanticId);
  const effectKey = `${effectBaseKey(activation)}:agent-adopt:${semanticDigest.slice("sha256:".length)}`;
  const requestDigest = canonicalDigest({
    runId: run.id,
    activation: activation.address,
    bee: { name: session.name, id: session.id ?? null },
    trackDigest,
  });
  const startedAt = new Date(nowFn()).toISOString();

  await mutateRun(run.id, (record) => {
    const current = record.activations[activation.id];
    if (!current) throw new CombError("corrupt_state", `activation disappeared: ${activation.id}`);
    const existing = record.effects[effectKey];
    if (existing && existing.requestDigest !== requestDigest) {
      throw new CombError("version_conflict", `adoption effect ${effectKey} has a different request digest`);
    }
    if (!existing) {
      const effect: EffectRecord = {
        key: effectKey,
        scope: { kind: "activation", activation: current.address },
        kind: "agent-adopt",
        semanticId,
        semanticDigest,
        fenceEpoch: 0,
        status: "prepared",
        preparedAt: startedAt,
        externalRef: session.name,
        requestDigest,
        verificationEvidenceIds: [],
      };
      record.effects[effectKey] = effect;
      current.effectKeys.push(effectKey);
      recordRunEvent(record, "comb.effect.prepared", current.address, {
        effectKey,
        kind: "agent-adopt",
      });
    }
    const effect = record.effects[effectKey]!;
    if (effect.status === "confirmed") return;
    if (effect.status !== "prepared" && effect.status !== "executing") {
      throw new CombError("version_conflict", `adoption effect ${effectKey} is ${effect.status}`);
    }
    effect.status = "executing";
    effect.executeStartedAt ??= startedAt;
    activateAgent(record, current, effect.executeStartedAt);
  });

  const exactBinding = session.combActivations?.find(
    (candidate) =>
      candidate.runId === run.id &&
      candidate.nodeId === activation.address.nodeId &&
      candidate.attempt === activation.address.attempt &&
      candidate.itemIndex === activation.address.itemIndex &&
      candidate.trackDigest === trackDigest,
  );
  const binding = {
    runId: run.id,
    nodeId: activation.address.nodeId,
    attempt: activation.address.attempt,
    itemIndex: activation.address.itemIndex,
    taskId: activation.taskId,
    status: "current" as const,
    attachedAt: exactBinding?.attachedAt ?? startedAt,
    trackDigest,
    ...(exactBinding?.deliveredAt ? { deliveredAt: exactBinding.deliveredAt } : {}),
  };
  let updated = await touchSession(session.name, {
    contract,
    brief: fullBrief,
    combActivations: [
      ...(session.combActivations ?? [])
        .filter(
          (candidate) =>
            !(
              candidate.runId === run.id &&
              candidate.nodeId === activation.address.nodeId &&
              candidate.attempt === activation.address.attempt &&
              candidate.itemIndex === activation.address.itemIndex
            ),
        )
        .map((candidate) =>
          candidate.status === "current" &&
          candidate.runId === run.id &&
          candidate.nodeId === activation.address.nodeId
            ? { ...candidate, status: "historical" as const, endedAt: startedAt }
            : candidate
        ),
      binding,
    ],
  });
  if (!updated) throw new CombError("external_dependency", `bee ${session.name} disappeared during adoption`);
  if (options.deliver !== false && !exactBinding?.deliveredAt) {
    await deliverPromptText(updated, fullBrief);
    const deliveredAt = new Date(nowFn()).toISOString();
    updated = await touchSession(updated.name, {
      combActivations: updated.combActivations?.map((candidate) =>
        candidate.runId === run.id &&
        candidate.nodeId === activation.address.nodeId &&
        candidate.attempt === activation.address.attempt &&
        candidate.itemIndex === activation.address.itemIndex
          ? { ...candidate, deliveredAt }
          : candidate
      ),
    }) ?? updated;
  }

  await mutateRun(run.id, (record) => {
    const effect = record.effects[effectKey];
    const current = record.activations[activation.id];
    if (!effect || !current) throw new CombError("corrupt_state", "adoption state disappeared before confirm");
    if (effect.status === "confirmed") return;
    if (effect.status !== "executing") {
      throw new CombError("version_conflict", `adoption effect ${effectKey} is ${effect.status}`);
    }
    const confirmedAt = new Date(nowFn()).toISOString();
    effect.status = "confirmed";
    effect.confirmedAt = confirmedAt;
    effect.externalRef = session.name;
    effect.result = {
      bee: session.name,
      beeId: session.id ?? null,
      trackDigest,
    };
    if (!current.beeHandles.some((handle) => handle.name === session.name)) {
      current.beeHandles.push({
        name: session.name,
        ...(session.id ? { id: session.id } : {}),
        source: "adopted",
      });
    }
    recordRunEvent(record, "comb.effect.confirmed", current.address, {
      effectKey,
      externalRef: session.name,
    });
  });
  return {
    run: boardView(await requireRun(run.id)),
    activationId: activation.id,
    bee: session.name,
    trackPostscript,
  };
}

export function combTrackPostscript(
  run: RunRecord,
  activation: ActivationRecord,
  node: AgentNode,
): string {
  const expectations = node.agent.expectations?.map((expectation) => expectation.description) ?? [];
  const strictIntents = run.currentSnapshot.definition.nodes.flatMap((candidate) =>
    candidate.executor === "engine" && candidate.engine.kind === "action"
      ? [candidate.engine.intent]
      : []
  );
  return [
    "--- TRACK (hive comb) ---",
    `Run: ${run.id}`,
    `Activation: ${activation.address.nodeId} attempt ${activation.address.attempt} item ${activation.address.itemIndex}`,
    `Expected route: ${expectations.length ? expectations.join("; ") : node.binding}`,
    `Do not execute strict downstream intents (${strictIntents.length ? strictIntents.join(", ") : "none"}).`,
    `When your work is complete, seal with taskId "${activation.taskId}" and attempt ${activation.address.attempt}.`,
    "Review, human verification, and landing are driven by the track after your seal.",
    `Inspect position: hive comb status ${run.id}`,
  ].join("\n");
}

function resolveEntryNode(run: RunRecord, requested: string | undefined): string {
  const entries = entryNodeIds(run.currentSnapshot.definition);
  if (requested) {
    if (!entries.includes(requested)) {
      throw new CombError("invalid_argument", `node ${requested} is not an entry node`);
    }
    return requested;
  }
  if (entries.length !== 1) {
    throw new CombError(
      "ambiguous_activation",
      `comb ${run.currentSnapshot.definition.name} has ${entries.length} entry nodes; pass --entry`,
      entries as unknown as JsonValue,
    );
  }
  return entries[0]!;
}

function currentEntryActivation(run: RunRecord, nodeId: string): ActivationRecord {
  const candidates = Object.values(run.activations)
    .filter(
      (activation) =>
        activation.address.nodeId === nodeId &&
        activation.invalidatedAt === undefined,
    )
    .sort((left, right) => right.address.attempt - left.address.attempt);
  const activation = candidates[0];
  if (!activation) throw new CombError("corrupt_state", `entry activation is missing: ${nodeId}`);
  if (activation.status !== "pending" && activation.status !== "active") {
    throw new CombError("version_conflict", `entry activation ${activation.id} is ${activation.status}`);
  }
  return activation;
}

export function attachedBriefForSession(
  record: Pick<SessionRecord, "brief">,
  trackPostscript: string,
): string {
  return record.brief ? `${record.brief}\n\n${trackPostscript}` : trackPostscript;
}
