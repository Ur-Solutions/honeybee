import { withSessionLifecycleTransaction } from "../lifecycle.js";
import { messageDeliveryRequestId } from "../requests/keys.js";
import { openRequest, readBeeRequests, resolveRequest } from "../requests/store.js";
import { loadSession, type SessionRecord } from "../store.js";
import { listMessages } from "./storage.js";

export type MessageUndeliverableReason =
  | "missing-cwd"
  | "missing-provider-session"
  | "wake-retry-exhausted"
  | "queued-message-missing"
  | "archive-unresolved";

function undeliverableQuestion(record: SessionRecord, reason: MessageUndeliverableReason): string {
  switch (reason) {
    case "missing-cwd":
      return `Message is queued, but the working directory is unavailable: ${record.cwd}. Restore or recreate the working copy, then retry delivery.`;
    case "missing-provider-session":
      return "Message is queued, but this bee has no recorded provider session to resume. Choose an exact session id or revive it fresh, then retry delivery.";
    case "queued-message-missing":
      return "The accepted message can no longer be found in the delivery queue. Inspect buz history before retrying it.";
    case "archive-unresolved":
      return "Message is queued, but the bee's archive request is unresolved and its runtime is no longer live. Resolve the stop state before retrying delivery.";
    case "wake-retry-exhausted":
      return "Message is queued, but automatic runtime recovery failed repeatedly. Inspect daemon recovery logs, repair the runtime, then retry delivery.";
  }
}

export async function openMessageDeliveryRequest(
  record: SessionRecord,
  messageId: string,
  reason: MessageUndeliverableReason,
  openedAt = new Date().toISOString(),
): Promise<string> {
  const id = messageDeliveryRequestId(record.name, messageId);
  await openRequest(record.name, {
    id,
    kind: "manual-action",
    scope: "bee",
    grade: "structured",
    generation: record.runtimeGeneration ?? 0,
    openedAt,
    question: undeliverableQuestion(record, reason),
    input: { messageId },
    evidence: {
      grade: "structured",
      source: "buz-recovery",
      observedAt: openedAt,
      detail: reason,
    },
  });
  return id;
}

/**
 * Clear one exact delivery obligation without clobbering a newer accepted
 * message. A stale lifecycle snapshot is harmless: the next daemon pass sees
 * the marker and retries the compare against the authoritative record.
 */
export async function clearMessageRecovery(
  bee: string,
  messageId: string,
  options: { resolveRequestBy?: string; resolution?: string } = {},
): Promise<boolean> {
  if (options.resolveRequestBy) {
    await resolveRequest(bee, messageDeliveryRequestId(bee, messageId), {
      by: options.resolveRequestBy,
      resolution: options.resolution ?? "message delivered",
    }).catch(() => undefined);
  }
  const record = await loadSession(bee);
  if (!record || record.recoveryMessageId !== messageId || !record.recoveryRequestedAt) return false;
  try {
    return await withSessionLifecycleTransaction(record, async (lifecycle) => {
      const current = await lifecycle.refresh();
      if (current.recoveryMessageId !== messageId || !current.recoveryRequestedAt) return false;

      // The record stores one recovery cursor, not the complete delivery
      // backlog. The queue is the durable authority. When the cursor settles,
      // promote the oldest queued message that is not already parked behind a
      // manual-action request. Without this promotion, accepting A then B and
      // cancelling/delivering B could clear the scalar and strand A forever.
      const [queued, requests] = await Promise.all([
        listMessages(bee, "queue"),
        readBeeRequests(bee),
      ]);
      const openRequestIds = new Set(
        requests.filter((request) => request.status === "open").map((request) => request.id),
      );
      const promoted = queued
        .filter((entry) => entry.message.id !== messageId
          && !openRequestIds.has(messageDeliveryRequestId(bee, entry.message.id)))
        .at(-1)?.message;
      const updatedAt = new Date().toISOString();
      await lifecycle.commit(promoted
        ? {
            recoveryRequestedAt: updatedAt,
            recoveryMessageId: promoted.id,
            recoveryAttemptCount: 0,
            recoveryNextAttemptAt: undefined,
            updatedAt,
          }
        : {
            recoveryRequestedAt: undefined,
            recoveryMessageId: undefined,
            recoveryAttemptCount: undefined,
            recoveryNextAttemptAt: undefined,
            updatedAt,
          });
      return true;
    });
  } catch {
    return false;
  }
}
