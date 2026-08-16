/** Lifecycle-linearized delivery of a new turn to an existing Bee runtime. */

import { randomUUID } from "node:crypto";
import { assertNoUnresolvedHsrAnswerOwnership } from "./answerReceipt.js";
import { assertNoUnresolvedDeliveryDoubt, deliveryContentDigest, persistDeliveryDoubt, readDeliveryDoubt } from "./deliveryDoubt.js";
import { HsrDeliveryAmbiguousError, HsrDeliveryDiscardedError, HsrDeliveryIdentityConflictError, isHsrDeliveryAmbiguous, markPendingHsrTurnPublicationAmbiguous } from "./hsr/pendingTurns.js";
import { withSessionLifecycleTransaction, type SessionLifecycleTransaction } from "./lifecycle.js";
import { assertNoUnresolvedBeeNameLaunchReservationInAdmission } from "./nameAdmission.js";
import { assertNoUnresolvedHsrEventIntegrity } from "./hsr/eventIntegrity.js";
import { deliveryAmbiguityRequestId } from "./requests/keys.js";
import { openRequest, readBeeRequestsStrict } from "./requests/store.js";
import { nextTurnPatch } from "./seal.js";
import { isArchivedSessionLifecycle, isRunnableSessionRecord } from "./stateMachine.js";
import {
  legacyStateMachineSeed,
  transitionSession,
  type SessionRecord,
} from "./store.js";
import { substrateFor } from "./substrates/index.js";
import type { SendTextOptions } from "./substrates/types.js";

export type SessionTextDeliveryOptions = {
  /** Transport override used by retrying HSR/brief and deterministic tests. */
  deliver?: (record: SessionRecord, text: string, options?: SendTextOptions) => Promise<void>;
  /** Stable effect identity. Reusing it is a receipt lookup, never a second turn. */
  deliveryId?: string;
  /** Require the durable turn_end receipt (mailbox/automatic queue semantics). */
  completionRequired?: boolean;
  /** Additional fields committed with the turn boundary after delivery. */
  metadata?: (deliveredAt: string, record: SessionRecord) => Partial<SessionRecord>;
  now?: () => Date;
  makeActionId?: () => string;
  /** @internal deterministic fault seam for ambiguity visibility tests. */
  openAmbiguityRequest?: typeof openRequest;
  /** @internal deterministic fault seam for durable doubt fallback tests. */
  persistDeliveryDoubt?: typeof persistDeliveryDoubt;
};

export type SessionTextDelivery = {
  record: SessionRecord;
  deliveredAt: string;
};

/** Serialize any new-work effect against kill/retire without changing turn state. */
export async function withRunnableSessionAdmission<T>(
  snapshot: SessionRecord,
  effect: (lifecycle: SessionLifecycleTransaction, record: SessionRecord) => Promise<T>,
  options: {
    operation?: string;
    deliveryId?: string;
    /** Answer chokes defer only until they construct and assert one exact operation under this lock. */
    deferAnswerOwnershipToExactOperation?: true;
  } = {},
): Promise<T> {
  return withSessionLifecycleTransaction(snapshot, async (lifecycle) => {
    const record = await lifecycle.refresh();
    const operation = options.operation ?? "hive send";
    await assertNoUnresolvedBeeNameLaunchReservationInAdmission(record, operation);
    await assertNoUnresolvedHsrEventIntegrity(record.name, operation);
    if (isArchivedSessionLifecycle(record)) {
      throw new Error(`${operation}: ${record.name} is archived`);
    }
    if (!isRunnableSessionRecord(record)) {
      throw new Error(`${operation}: ${record.name} has unresolved stop state`);
    }
    await assertNoUnresolvedDeliveryDoubt(record.name, operation, options.deliveryId);
    await assertNoConflictingDeliveryAmbiguityRequest(record.name, operation, options.deliveryId);
    if (options.deferAnswerOwnershipToExactOperation !== true) {
      await assertNoUnresolvedHsrAnswerOwnership(record, operation);
    }
    return effect(lifecycle, record);
  });
}

/** A visible manual ambiguity remains an admission authority even if the
 * primary sidecar write failed. Exact-id retries may inspect their receipt;
 * every different work id remains fenced. */
export async function assertNoConflictingDeliveryAmbiguityRequest(
  bee: string,
  operation: string,
  allowedDeliveryId?: string,
): Promise<void> {
  for (const request of await readBeeRequestsStrict(bee)) {
    if (request.status !== "open") continue;
    if (request.evidence.detail !== "delivery-ambiguous" && request.evidence.source !== "hsr-delivery") continue;
    const input = request.input && typeof request.input === "object"
      ? request.input as Record<string, unknown>
      : {};
    const deliveryId = typeof input.deliveryId === "string"
      ? input.deliveryId
      : typeof input.messageId === "string"
        ? input.messageId
        : undefined;
    if (deliveryId && deliveryId === allowedDeliveryId) continue;
    throw new HsrDeliveryAmbiguousError(
      deliveryId ?? "unknown-delivery",
      `${operation}: ${bee} has an unresolved manual delivery ambiguity${deliveryId ? ` ${deliveryId}` : ""}`,
    );
  }
}

/**
 * Admit, deliver, and publish one turn under the runtime lifecycle lock.
 *
 * This is deliberately not retried around the transport effect. If the
 * provider accepted text and the following record commit becomes ambiguous,
 * replaying here could duplicate a turn. Callers receive the error and the
 * durable provider/session journals remain the reconciliation authority.
 * If `turn.steered` was already committed, a transport error deliberately
 * leaves the turn working: that conservative ambiguity fence prevents an
 * automatic replay from duplicating provider-accepted work.
 *
 * Holding the lifecycle lock across transport gives stop and delivery one
 * total order: delivery either commits before a kill/retire starts, or it sees
 * the stop/archived fact and performs zero transport work. In particular,
 * `kill_failed` is active only for ownership/cleanup; it is never runnable.
 */
export async function deliverSessionText(
  snapshot: SessionRecord,
  text: string,
  options: SessionTextDeliveryOptions = {},
): Promise<SessionTextDelivery> {
  return withRunnableSessionAdmission(snapshot, (lifecycle, admitted) =>
    deliverSessionTextInAdmission(lifecycle, admitted, text, options), {
      operation: "hive send",
      ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
    });
}

/**
 * Deliver while the caller already owns the Bee lifecycle admission.
 *
 * This is the lock-order-safe form for higher-level transactions that must
 * hold lifecycle outermost while taking their own run/attachment locks. It
 * deliberately performs no lifecycle re-entry; the caller must have obtained
 * `record` from this exact transaction's refresh/admission check.
 */
export async function deliverSessionTextInAdmission(
  lifecycle: SessionLifecycleTransaction,
  admitted: SessionRecord,
  text: string,
  options: SessionTextDeliveryOptions = {},
): Promise<SessionTextDelivery> {
  let record = admitted;
  const actionId = (options.makeActionId ?? randomUUID)();
  const deliveryId = options.deliveryId ?? `delivery:${record.name}:${actionId}`;
  const deliverySubstrate = substrateFor(record).kind;
  const hasDurableTransportReceipt = deliverySubstrate === "hsr" || deliverySubstrate === "remote-hsr";
  const priorDoubt = await readDeliveryDoubt(record.name, deliveryId);
  if (priorDoubt) {
    const sameSource = priorDoubt.source.createdAt === record.createdAt &&
      priorDoubt.source.runtimeGeneration === (record.runtimeGeneration ?? 0) &&
      (priorDoubt.source.id === undefined || priorDoubt.source.id === record.id) &&
      (priorDoubt.source.uuid === undefined || priorDoubt.source.uuid === record.uuid);
    if (!sameSource || priorDoubt.contentDigest !== deliveryContentDigest(text)) {
      throw new HsrDeliveryIdentityConflictError(deliveryId, `delivery id ${deliveryId} is bound to different work`);
    }
    if (priorDoubt.phase === "discarded") {
      throw new HsrDeliveryDiscardedError(deliveryId, `delivery ${deliveryId} was explicitly discarded`);
    }
    if (priorDoubt.phase === "ambiguous") {
      throw new HsrDeliveryAmbiguousError(deliveryId, `delivery ${deliveryId} has unresolved provider ownership`);
    }
  }
  const throwVisibleAmbiguity = async (message: string, original: unknown): Promise<never> => {
    const openedAt = new Date().toISOString();
    let visibilityError: unknown;
    try {
      await (options.openAmbiguityRequest ?? openRequest)(record.name, {
        id: deliveryAmbiguityRequestId(record.name, deliveryId),
        kind: "manual-action",
        scope: "bee",
        grade: "structured",
        generation: record.runtimeGeneration ?? 0,
        openedAt,
        question: "A turn crossed provider dispatch, but acceptance or completion cannot be proven. Reconcile the provider conversation before redriving work.",
        input: { deliveryId },
        evidence: {
          grade: "structured",
          source: "hsr-delivery",
          observedAt: openedAt,
          detail: "delivery-ambiguous",
        },
      });
    } catch (error) {
      visibilityError = error;
    }
    if (isHsrDeliveryAmbiguous(original) && visibilityError === undefined) throw original;
    const causes = visibilityError === undefined ? [original] : [original, visibilityError];
    throw new HsrDeliveryAmbiguousError(deliveryId, message, {
      cause: causes.length === 1 ? original : new AggregateError(causes, "delivery ambiguity and request persistence failure"),
    });
  };
  const state = record.stateMachine ?? legacyStateMachineSeed(record);
  if (state.lifecycle === "active" && state.work === "done") {
    const at = (options.now ?? (() => new Date()))().toISOString();
    const transitioned = await transitionSession(record.name, {
      type: "turn.steered",
      eventId: `turn-steered:${actionId}`,
      at,
      cause: "steer",
      evidence: { kind: "operator", actionId, observedAt: at, action: "steer" },
    });
    if (!transitioned) throw new Error(`hive send: ${record.name} disappeared before delivery`);
    record = await lifecycle.refresh();
  }

  // Snapshot before transport so a very fast seal from the new turn remains
  // above this boundary. Apply it only after transport acceptance.
  const turn = await nextTurnPatch(record);
  const deliver = options.deliver ?? (async (candidate: SessionRecord, body: string) => {
    await substrateFor(candidate).sendText(candidate.tmuxTarget, body, candidate.agentPaneId, {
      deliveryId,
      ...(candidate.remoteLaunchId ? { remoteLaunchId: candidate.remoteLaunchId } : {}),
      ...(candidate.remoteIncarnation ? { remoteIncarnation: candidate.remoteIncarnation } : {}),
    });
  });
  if (priorDoubt?.phase !== "delivered") {
    try {
      await deliver(record, text, {
        deliveryId,
        ...(options.completionRequired ? { completionRequired: true } : {}),
        ...(record.remoteLaunchId ? { remoteLaunchId: record.remoteLaunchId } : {}),
        ...(record.remoteIncarnation ? { remoteIncarnation: record.remoteIncarnation } : {}),
      });
    } catch (error) {
      if (isHsrDeliveryAmbiguous(error)) {
        let durableCause: unknown = error;
        try {
          await (options.persistDeliveryDoubt ?? persistDeliveryDoubt)(record, deliveryId, text, error instanceof Error ? error.message : String(error));
        } catch (persistError) {
          durableCause = new AggregateError([error, persistError], "transport ambiguity and delivery-doubt persistence failure");
        }
        // The HSR journal is the delivery authority; this request is the visible
        // operator fence. A request-store failure must never mask the typed
        // transport ambiguity that keeps launchers/retries fail-closed.
        return throwVisibleAmbiguity(
          error instanceof Error ? error.message : `HSR delivery ${deliveryId} is ambiguous`,
          durableCause,
        );
      }
      throw error;
    }
  }

  const deliveredAt = (options.now ?? (() => new Date()))().toISOString();
  let updated: SessionRecord;
  try {
    updated = await lifecycle.commit({
      ...turn,
      ...options.metadata?.(deliveredAt, record),
      updatedAt: deliveredAt,
      status: "running",
      lastPrompt: text,
      lastPromptAt: deliveredAt,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const durabilityErrors: unknown[] = [];
    let fenced = false;
    try {
      await (options.persistDeliveryDoubt ?? persistDeliveryDoubt)(record, deliveryId, text, detail);
      fenced = true;
    } catch (persistError) {
      durabilityErrors.push(persistError);
    }
    if (hasDurableTransportReceipt) {
      try {
        fenced = !!(await markPendingHsrTurnPublicationAmbiguous(
          record.name,
          deliveryId,
          `Delivery ${deliveryId} crossed transport acceptance but its caller publication failed: ${detail}`,
        )) || fenced;
      } catch (receiptError) {
        durabilityErrors.push(receiptError);
      }
    }
    // A non-HSR transport has no independent turn receipt. If the generic
    // sidecar cannot be written but this transaction still owns the canonical
    // row, turn it non-runnable rather than return an ordinary retry surface.
    // Explicit recovery remains the conservative repair path.
    if (!fenced) {
      try {
        await lifecycle.commit({
          status: "kill_failed",
          lastError: `Delivery ${deliveryId} may have crossed provider acceptance; durable receipt publication failed`,
          updatedAt: new Date().toISOString(),
        });
        fenced = true;
      } catch (canonicalFenceError) {
        durabilityErrors.push(canonicalFenceError);
      }
    }
    const durableCause = durabilityErrors.length === 0
      ? error
      : new AggregateError([error, ...durabilityErrors], fenced
          ? "metadata failure; fallback delivery fence retained"
          : "metadata failure and every durable delivery fence failed");
    return throwVisibleAmbiguity(
      hasDurableTransportReceipt
        ? `Delivery ${deliveryId} was durably handed to ${record.name}, but its SessionRecord publication failed; refusing automatic replay`
        : `Delivery ${deliveryId} may have reached ${record.name}, but its SessionRecord publication failed; refusing automatic replay`,
      durableCause,
    );
  }
  return { record: updated, deliveredAt };
}
