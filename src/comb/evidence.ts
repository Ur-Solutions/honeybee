import { judgeActivationEvidence } from "../activation.js";
import type { SealRecord } from "../seal.js";
import { canonicalDigest } from "./canonical.js";
import { terminalizeRun } from "./machine.js";
import { saveEvidence, recordRunEvent } from "./store.js";
import type {
  ActivationRecord,
  EvidenceEnvelope,
  ForumPacket,
  HumanPacketRef,
  JsonObject,
  JsonValue,
  RunRecord,
} from "./types.js";

export type EvidenceIngestResult = "match" | "stale" | "duplicate" | "late-cancelled" | "late-invalidated" | "mismatch";

export function judgeCombEvidence(
  activation: ActivationRecord,
  envelope: Pick<EvidenceEnvelope, "recordedAt" | "activation" | "subject"> & {
    taskId?: string;
    attempt?: number;
  },
): "none" | "match" | "mismatch" {
  const shared = judgeActivationEvidence(
    activation.claim,
    {
      recordedAt: envelope.recordedAt,
      taskId: envelope.taskId,
      attempt: envelope.attempt ?? envelope.activation.attempt,
    },
    { requireKeys: true },
  );
  if (shared !== "match") return shared;
  if (
    envelope.activation.runId !== activation.address.runId ||
    envelope.activation.nodeId !== activation.address.nodeId ||
    envelope.activation.itemIndex !== activation.address.itemIndex ||
    envelope.subject.kind !== activation.subject.kind ||
    envelope.subject.key !== activation.subject.key ||
    envelope.subject.revision !== activation.subject.revision
  ) return "mismatch";
  return "match";
}

export async function ingestSealEvidence(
  run: RunRecord,
  activation: ActivationRecord,
  filename: string,
  seal: SealRecord,
  options: { mismatchDisposition?: "fail" | "inert" } = {},
): Promise<EvidenceIngestResult> {
  const id = canonicalDigest({ beeName: seal.beeName, filename } as JsonValue);
  if (activation.evidenceTail.some((ref) => ref.id === id)) return "duplicate";
  const envelope: EvidenceEnvelope = {
    schemaVersion: 1,
    id,
    activation: activation.address,
    taskId: activation.taskId,
    subject: activation.subject,
    producer: { kind: "bee", id: seal.beeName },
    recordedAt: seal.sealedAt,
    kind: "seal",
    payload: { filename, seal },
  };
  const ref = await saveEvidence(run.id, envelope);
  activation.evidenceCount += 1;
  activation.evidenceTail.push(ref);
  if (activation.evidenceTail.length > 128) activation.evidenceTail.splice(0, activation.evidenceTail.length - 128);

  if (run.cancellation) {
    recordRunEvent(run, "comb.evidence.late_cancelled", activation.address, evidenceEventData(ref.id, ref.kind));
    return "late-cancelled";
  }
  if (activation.invalidatedAt) {
    recordRunEvent(run, "comb.evidence.late_invalidated", activation.address, evidenceEventData(ref.id, ref.kind));
    return "late-invalidated";
  }
  const verdict = judgeCombEvidence(activation, {
    recordedAt: seal.sealedAt,
    taskId: seal.taskId,
    attempt: seal.attempt,
    activation: envelope.activation,
    subject: envelope.subject,
  });
  if (verdict === "mismatch") {
    if (options.mismatchDisposition === "inert") {
      recordRunEvent(run, "comb.evidence.unattributed_seal", activation.address, {
        ...evidenceEventData(ref.id, ref.kind),
        bee: seal.beeName,
        taskId: seal.taskId ?? null,
        attempt: seal.attempt ?? null,
      });
      return "stale";
    }
    const failedAt = new Date().toISOString();
    activation.status = "failed";
    activation.endedAt = failedAt;
    activation.failure = {
      code: "evidence-mismatch",
      message: `seal ${filename} does not match ${activation.taskId} attempt ${activation.address.attempt}`,
      retryable: false,
    };
    terminalizeRun(run, "failed", {
      code: "evidence-mismatch",
      message: activation.failure.message,
      activation: activation.address,
    }, failedAt, activation.address);
    recordRunEvent(run, "comb.violation", activation.address, {
      code: "evidence-mismatch",
      evidenceId: ref.id,
    });
    return "mismatch";
  }
  recordRunEvent(run, "comb.evidence.recorded", activation.address, evidenceEventData(ref.id, ref.kind));
  return verdict === "match" ? "match" : "stale";
}

export async function ingestForumVerdictEvidence(
  run: RunRecord,
  activation: ActivationRecord,
  packet: ForumPacket,
  expected: HumanPacketRef,
): Promise<{ result: EvidenceIngestResult; verdict?: NonNullable<ForumPacket["verdict"]> }> {
  const verdict = packet.verdict;
  if (!verdict) return { result: "stale" };
  const id = canonicalDigest({
    packetId: packet.id,
    verdict: verdict.verdict,
    actor: verdict.actor,
    recordedAt: verdict.recorded_at,
  });
  if (activation.evidenceTail.some((ref) => ref.id === id)) return { result: "duplicate" };
  const envelope: EvidenceEnvelope = {
    schemaVersion: 1,
    id,
    activation: activation.address,
    taskId: activation.taskId,
    subject: activation.subject,
    producer: { kind: "forum", id: packet.id },
    recordedAt: verdict.recorded_at,
    kind: "forum-verdict",
    payload: {
      packetId: packet.id,
      status: packet.status,
      verdict: verdict.verdict,
      comment: verdict.comment,
      destination: verdict.destination,
      actor: verdict.actor,
      snapshotRevision: expected.snapshotRevision,
      definitionDigest: expected.definitionDigest,
      actionBindingDigest: expected.actionBindingDigest,
      subjectRevision: expected.subject.revision,
      blockingSince: packet.blocking_since,
    },
  };
  const ref = await saveEvidence(run.id, envelope);
  appendEvidenceRef(activation, ref);
  if (run.cancellation) {
    recordRunEvent(run, "comb.evidence.late_cancelled", activation.address, evidenceEventData(ref.id, ref.kind));
    return { result: "late-cancelled" };
  }
  if (activation.invalidatedAt) {
    recordRunEvent(run, "comb.evidence.late_invalidated", activation.address, evidenceEventData(ref.id, ref.kind));
    return { result: "late-invalidated" };
  }
  if (!forumVerdictPinsMatch(run, activation, packet, expected)) {
    recordRunEvent(run, "comb.evidence.stale_verdict", activation.address, {
      evidenceId: ref.id,
      packetId: packet.id,
    });
    return { result: "stale" };
  }
  const freshness = judgeActivationEvidence(
    activation.claim,
    {
      recordedAt: verdict.recorded_at,
      taskId: activation.taskId,
      attempt: activation.address.attempt,
    },
    { requireKeys: true },
  );
  if (freshness !== "match") {
    recordRunEvent(run, "comb.evidence.stale_verdict", activation.address, {
      evidenceId: ref.id,
      packetId: packet.id,
    });
    return { result: freshness === "mismatch" ? "mismatch" : "stale" };
  }
  recordRunEvent(run, "comb.evidence.recorded", activation.address, evidenceEventData(ref.id, ref.kind));
  return { result: "match", verdict };
}

function forumVerdictPinsMatch(
  run: RunRecord,
  activation: ActivationRecord,
  packet: ForumPacket,
  expected: HumanPacketRef,
): boolean {
  const verdict = packet.verdict;
  if (!verdict || typeof verdict.actor !== "string" || !verdict.actor.trim()) return false;
  if (packet.id !== expected.packetId || verdict.packet_id !== packet.id) return false;
  if (packet.run_id !== null && packet.run_id !== run.id) return false;
  if (packet.comb_name !== null && packet.comb_name !== run.currentSnapshot.definition.name) return false;
  if (packet.proposed_rev !== null && packet.proposed_rev !== expected.snapshotRevision) return false;
  if (packet.definition_digest !== null && packet.definition_digest !== expected.definitionDigest) return false;
  if (packet.action_binding_digest !== null && packet.action_binding_digest !== expected.actionBindingDigest) return false;
  if (packet.subject_revision !== null && packet.subject_revision !== expected.subject.revision) return false;
  if (
    run.snapshotRevision !== expected.snapshotRevision ||
    run.currentSnapshot.definitionDigest !== expected.definitionDigest ||
    run.currentSnapshot.actionBindingDigest !== expected.actionBindingDigest
  ) return false;
  if (
    activation.nodeSnapshotRevision !== expected.snapshotRevision ||
    activation.subject.kind !== expected.subject.kind ||
    activation.subject.key !== expected.subject.key ||
    activation.subject.revision !== expected.subject.revision
  ) return false;
  if (verdict.definition_digest !== null && verdict.definition_digest !== expected.definitionDigest) return false;
  if (verdict.action_binding_digest !== null && verdict.action_binding_digest !== expected.actionBindingDigest) return false;
  if (verdict.subject_revision !== null && verdict.subject_revision !== expected.subject.revision) return false;
  return true;
}

function appendEvidenceRef(activation: ActivationRecord, ref: ActivationRecord["evidenceTail"][number]): void {
  activation.evidenceCount += 1;
  activation.evidenceTail.push(ref);
  if (activation.evidenceTail.length > 128) {
    activation.evidenceTail.splice(0, activation.evidenceTail.length - 128);
  }
}

function evidenceEventData(id: string, kind: string): JsonObject {
  return { evidenceId: id, kind };
}
