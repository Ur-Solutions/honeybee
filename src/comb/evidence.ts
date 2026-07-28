import { judgeActivationEvidence } from "../activation.js";
import type { SealRecord } from "../seal.js";
import { canonicalDigest } from "./canonical.js";
import { terminalizeRun } from "./machine.js";
import { saveEvidence, recordRunEvent } from "./store.js";
import type { ActivationRecord, EvidenceEnvelope, JsonObject, JsonValue, RunRecord } from "./types.js";

export type EvidenceIngestResult = "match" | "stale" | "duplicate" | "late-cancelled" | "late-invalidated" | "mismatch";

export function judgeCombEvidence(
  activation: ActivationRecord,
  envelope: Pick<EvidenceEnvelope, "recordedAt" | "taskId" | "activation" | "subject"> & { attempt?: number },
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
  const verdict = judgeActivationEvidence(
    activation.claim,
    { recordedAt: seal.sealedAt, taskId: seal.taskId, attempt: seal.attempt },
    { requireKeys: true },
  );
  if (verdict === "mismatch") {
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

function evidenceEventData(id: string, kind: string): JsonObject {
  return { evidenceId: id, kind };
}
