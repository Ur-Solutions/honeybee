import { deliverPromptText } from "../cli/shared.js";
import { withContractPostscript } from "../contract.js";
import { deliverSessionTextInAdmission, withRunnableSessionAdmission } from "../delivery.js";
import { isRunnableSessionRecord } from "../stateMachine.js";
import { loadSession, type SessionRecord } from "../store.js";
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
  /** Transport override for deterministic admission tests. */
  deliverText?: typeof deliverPromptText;
  now?: () => number;
  /** Deterministic race seam: invoked after snapshots, before lifecycle admission. */
  beforeSessionAdmission?: () => Promise<void>;
  /** Deterministic race seam: invoked after lifecycle admission, before the run lock. */
  beforeRunMutation?: () => Promise<void>;
}): Promise<AttachRunResult> {
  const nowFn = options.now ?? Date.now;
  const session = await loadSession(options.beeName);
  if (!session) throw new CombError("not_found", `bee not found: ${options.beeName}`);
  if (!isRunnableSessionRecord(session)) {
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
  if (node.agent.capacity.kind !== "spawn") {
    throw new CombError(
      "invalid_argument",
      `attached entry ${entryId} must use spawn capacity in strict-spine slice 1`,
    );
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
  const semanticId = `bee:${session.name}`;
  const semanticDigest = canonicalDigest(semanticId);
  const effectKey = `${effectBaseKey(activation)}:agent-adopt:${semanticDigest.slice("sha256:".length)}`;
  const adoptionRequest = {
    runId: run.id,
    activation: activation.address,
    name: session.name,
    agent: node.agent.capacity.bee,
    ...(node.agent.capacity.account ? { account: node.agent.capacity.account } : {}),
    ...(node.agent.capacity.model ? { model: node.agent.capacity.model } : {}),
    substrate: node.agent.capacity.substrate ?? "hsr",
    cwd: run.cwd,
    brief: fullBrief,
    taskId: activation.taskId,
    attempt: activation.address.attempt,
    trackDigest,
  };
  const requestDigest = canonicalDigest(adoptionRequest as unknown as JsonValue);
  const startedAt = new Date(nowFn()).toISOString();

  await options.beforeSessionAdmission?.();
  await withRunnableSessionAdmission(session, async (lifecycle, admitted) => {
    let effectStarted = false;
    const bindingPatch = (current: SessionRecord, deliveredAt?: string): Partial<SessionRecord> => {
      const exact = current.combActivations?.find(
        (candidate) =>
          candidate.runId === run.id &&
          candidate.nodeId === activation.address.nodeId &&
          candidate.attempt === activation.address.attempt &&
          candidate.itemIndex === activation.address.itemIndex &&
          candidate.trackDigest === trackDigest,
      );
      const deliveryAt = deliveredAt ?? exact?.deliveredAt;
      const binding = {
        runId: run.id,
        nodeId: activation.address.nodeId,
        attempt: activation.address.attempt,
        itemIndex: activation.address.itemIndex,
        taskId: activation.taskId,
        status: "current" as const,
        attachedAt: exact?.attachedAt ?? startedAt,
        trackDigest,
        ...(deliveryAt ? { deliveredAt: deliveryAt } : {}),
      };
      return {
        contract,
        brief: fullBrief,
        combActivations: [
          ...(current.combActivations ?? [])
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
      };
    };

    try {
      await options.beforeRunMutation?.();
      await mutateRun(run.id, (record) => {
        if (record.status !== "active" || record.cancellation) {
          throw new CombError("version_conflict", `comb run ${record.id} is no longer active`);
        }
        if (
          record.snapshotRevision !== run.snapshotRevision ||
          record.currentSnapshot.definitionDigest !== run.currentSnapshot.definitionDigest
        ) {
          throw new CombError("version_conflict", `comb run ${record.id} changed before attachment`);
        }
        const current = currentEntryActivation(record, entryId);
        if (current.id !== activation.id) {
          throw new CombError(
            "version_conflict",
            `entry activation changed from ${activation.id} to ${current.id} before attachment`,
          );
        }
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
            externalRef: admitted.name,
            requestDigest,
            request: adoptionRequest as unknown as JsonValue,
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
        effectStarted = true;
      });

      const exactBinding = admitted.combActivations?.find(
        (candidate) =>
          candidate.runId === run.id &&
          candidate.nodeId === activation.address.nodeId &&
          candidate.attempt === activation.address.attempt &&
          candidate.itemIndex === activation.address.itemIndex &&
          candidate.trackDigest === trackDigest,
      );
      let updated: SessionRecord;
      if (options.deliver !== false && !exactBinding?.deliveredAt) {
        updated = (await deliverSessionTextInAdmission(lifecycle, admitted, fullBrief, {
          deliver: options.deliverText ?? deliverPromptText,
          deliveryId: `comb:${effectKey}`,
          now: () => new Date(nowFn()),
          metadata: (deliveredAt, current) => bindingPatch(current, deliveredAt),
        })).record;
      } else {
        updated = await lifecycle.commit(bindingPatch(admitted));
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
        effect.externalRef = admitted.name;
        effect.result = {
          bee: admitted.name,
          beeId: updated.id ?? null,
          trackDigest,
        };
        if (!current.beeHandles.some((handle) => handle.name === admitted.name)) {
          current.beeHandles.push({
            name: admitted.name,
            ...(updated.id ? { id: updated.id } : {}),
            source: "adopted",
          });
        }
        recordRunEvent(record, "comb.effect.confirmed", current.address, {
          effectKey,
          externalRef: admitted.name,
        });
      });
    } catch (error) {
      if (effectStarted) {
        const message = error instanceof Error ? error.message : String(error);
        await mutateRun(run.id, (record) => {
          const effect = record.effects[effectKey];
          const current = record.activations[activation.id];
          if (!effect || !current || effect.status !== "executing") return;
          // Transport rejection is not proof that the Bee did not accept the
          // brief, and a following binding commit can fail after transport.
          // Hold the exact activation for manual reconciliation; never turn
          // either ambiguity into a retry on a different Bee.
          effect.status = "ambiguous";
          effect.error = message;
          recordRunEvent(record, "comb.effect.failed", current.address, {
            effectKey,
            outcome: "ambiguous-adoption",
          });
        }).catch(() => undefined);
      }
      throw error;
    }
  }, { operation: "hive comb attach" });
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
