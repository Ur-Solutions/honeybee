/** Local control-socket answer delivery for callers already holding lifecycle admission. */

import {
  assertNoUnresolvedHsrAnswerOwnership,
  createHsrAnswerOperation,
  markHsrAnswerOperationSending,
  markHsrAnswerOperationAmbiguous,
  offerHsrAnswerOperation,
  parseHsrAnswerHostCapabilities,
  parseHsrAnswerHostIdentity,
  parseHsrAnswerRpcResult,
  readHsrAnswerReceipt,
  reconcileHsrAnswerOperation,
  type HsrAnswerOperation,
  type HsrAnswerHostIdentity,
  type HsrAnswerRpcResult,
} from "../answerReceipt.js";
import { answerAmbiguityRequestId } from "../requests/keys.js";
import { openRequest } from "../requests/store.js";
import type { SessionRecord } from "../store.js";
import { connectRpcClient } from "./rpc.js";
import { readHsrMeta } from "./runDir.js";
import {
  assertHsrSourceEventLogIntegrity,
  assertNoUnresolvedHsrEventIntegrity,
} from "./eventIntegrity.js";
import type { HsrMeta } from "./runDir.js";
import type { RunnerInputAnswer } from "./types.js";

function resultFromReceipt(
  receipt: Awaited<ReturnType<typeof readHsrAnswerReceipt>>,
): HsrAnswerRpcResult | null {
  if (!receipt) return null;
  if (receipt.phase === "settled") {
    return { status: "settled", replayed: true, ...(receipt.host ? { host: receipt.host } : {}) };
  }
  if (receipt.phase === "ambiguous") {
    return { status: "ambiguous", reason: receipt.reason!, ...(receipt.host ? { host: receipt.host } : {}) };
  }
  if (receipt.phase === "discarded") return { status: "discarded" };
  if (receipt.phase === "dispatching") return { status: "in-flight" };
  return null;
}

export type LocalHsrAnswerDelivery = {
  operation: HsrAnswerOperation;
  result: HsrAnswerRpcResult;
};

export function hsrAnswerHostFromMeta(meta: HsrMeta): HsrAnswerHostIdentity {
  if (!meta.hostFingerprint) {
    throw new Error(`HSR host birth identity is unavailable for ${meta.bee}`);
  }
  return parseHsrAnswerHostIdentity({
    hostPid: meta.hostPid,
    startedAt: meta.startedAt,
    hostFingerprint: meta.hostFingerprint,
  });
}

export async function persistHsrAnswerAmbiguity(
  record: SessionRecord,
  operation: HsrAnswerOperation,
  reason: string,
  host?: HsrAnswerHostIdentity,
): Promise<void> {
  await markHsrAnswerOperationAmbiguous(record.name, operation, reason, host);
  const generation = record.runtimeGeneration ?? 0;
  await openRequest(record.name, {
    id: answerAmbiguityRequestId(record.name, generation, operation.requestId, operation.answerDigest, operation.host),
    kind: "manual-action",
    scope: "runtime-generation",
    grade: "structured",
    generation,
    question: "An answer crossed provider dispatch, but local handoff or HTTP acceptance cannot be proven. Inspect the provider request before reconciling delivered or discard.",
    input: { operation },
    evidence: { grade: "structured", source: "hsr-answer-receipt", detail: "answer-ambiguous" },
  });
}

/**
 * Offer and deliver one exact operation. A settled receipt bypasses pending
 * adapter state, closing the accepted-provider/lost-outer-reply retry window.
 */
export async function answerLocalHsrSessionInAdmission(
  record: SessionRecord,
  requestId: string,
  answer: RunnerInputAnswer,
): Promise<LocalHsrAnswerDelivery> {
  // This helper is also used by daemon/control callers that may already hold
  // lifecycle admission. Recheck the purge-surviving source-history fence
  // before creating an answer offer or any provider-visible receipt.
  await assertNoUnresolvedHsrEventIntegrity(record.name, "HSR answer");
  const meta = await readHsrMeta(record.name);
  if (!meta?.controlSocket) throw new Error(`No control socket for ${record.name}`);
  await assertHsrSourceEventLogIntegrity({
    bee: record.name,
    meta,
    operation: "HSR answer",
  });
  const host = hsrAnswerHostFromMeta(meta);
  const operation = createHsrAnswerOperation(record, requestId, answer, host);
  await assertNoUnresolvedHsrAnswerOwnership(record, "HSR answer", operation);
  let result = resultFromReceipt(await readHsrAnswerReceipt(record.name, operation));
  if (!result || result.status === "in-flight") {
    const client = await connectRpcClient(meta.controlSocket);
    try {
      parseHsrAnswerHostCapabilities(await client.call("answerCapabilities"));
      const offered = await offerHsrAnswerOperation(record.name, operation);
      result = resultFromReceipt(offered);
      if (!result || result.status === "in-flight") {
        await markHsrAnswerOperationSending(record.name, operation);
        try {
          result = parseHsrAnswerRpcResult(await client.call("answer", { operation, answer }));
        } catch (error) {
          let receipt = await readHsrAnswerReceipt(record.name, operation);
          if (receipt?.phase === "sending") {
            const reason = `host answer RPC outcome was lost after request transport: ${error instanceof Error ? error.message : String(error)}`;
            try {
              receipt = await markHsrAnswerOperationAmbiguous(record.name, operation, reason);
            } catch {
              receipt = await readHsrAnswerReceipt(record.name, operation);
            }
          }
          const durable = resultFromReceipt(receipt);
          if (!durable) throw error;
          result = durable;
        }
      }
    } finally {
      client.close();
    }
  }
  if (result.status === "settled") {
    await reconcileHsrAnswerOperation(record.name, operation, "delivered");
  } else if (result.status === "discarded") {
    await reconcileHsrAnswerOperation(record.name, operation, "discard");
  } else if (result.status === "ambiguous") {
    await persistHsrAnswerAmbiguity(record, operation, result.reason, result.host);
  }
  return { operation, result };
}
