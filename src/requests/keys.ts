/**
 * InterventionRequest id builders — the SINGLE source of request ids
 * (docs/INTERVENTION_REQUESTS.md). The durable store and the live BeeView
 * derivation (src/view/requests.ts) both build ids here, so a record persisted
 * by the daemon and a request derived live while the daemon is down are
 * byte-identical: `hive answer` can resolve either under the same key.
 *
 * The formats are frozen — they predate the store (view/requests.ts emitted
 * them first) and every persisted record depends on them.
 */

import { createHash } from "node:crypto";
import type { HsrAnswerHostIdentity } from "../answerReceipt.js";

/**
 * Structured needs_input (question/permission), scope turn. The adapter's own
 * requestId is preferred; an empty or `"pending"` placeholder (id-less
 * adapters) falls back to `ni:<bee>:<event ts>` so a bee that unblocks and
 * re-blocks gets a fresh id per event.
 */
export function needsInputRequestId(
  bee: string,
  pending: { requestId?: string; ts: number; host?: HsrAnswerHostIdentity },
): string {
  if (!pending.requestId || pending.requestId === "pending") return `ni:${bee}:${pending.ts}`;
  if (!pending.host) return pending.requestId;
  return `ni:${bee}:${pending.requestId}:${answerHostEpoch(pending.host)}`;
}

/** Structured auth (login required), scope runtime-generation, keyed by the grounding event's ts. */
export function authRequestId(bee: string, eventTs: number): string {
  return `auth:${bee}:${eventTs}`;
}

/** Manual action: an auth-failed turn had no exactly recoverable prompt text. */
export function authPromptLossRequestId(bee: string, generation: number, eventTs: number): string {
  return `manual:${bee}:${generation}:auth-prompt-loss:${eventTs}`;
}

/** Manual action: a recorded stop (kill/retire) failed for this generation. */
export function stopFailedRequestId(bee: string, generation: number): string {
  return `manual:${bee}:${generation}:stop-failed`;
}

/** Bee-scoped manual action: one durably accepted buz message is undeliverable. */
export function messageDeliveryRequestId(bee: string, messageId: string): string {
  return `manual:${bee}:message-delivery:${messageId}`;
}

/** Bee-scoped manual action: a non-mail turn crossed an unprovable provider boundary. */
export function deliveryAmbiguityRequestId(bee: string, deliveryId: string): string {
  return `manual:${bee}:delivery-ambiguous:${deliveryId}`;
}

/** Runtime-scoped manual action: an exact needs-input answer crossed dispatch. */
export function answerAmbiguityRequestId(
  bee: string,
  generation: number,
  requestId: string,
  answerDigest: string,
  host: HsrAnswerHostIdentity,
): string {
  return `manual:${bee}:${generation}:answer-ambiguous:${requestId}:${answerDigest.slice(0, 16)}:${answerHostEpoch(host)}`;
}

function answerHostEpoch(host: HsrAnswerHostIdentity): string {
  return createHash("sha256").update(JSON.stringify(host)).digest("hex").slice(0, 16);
}

/** Bee-scoped manual action: automatic runtime recovery exhausted its budget. */
export function recoveryFailedRequestId(bee: string, episodeId: string): string {
  return `manual:${bee}:recovery-failed:${episodeId}`;
}
