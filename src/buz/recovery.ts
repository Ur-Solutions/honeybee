import { LifecycleConflictError, withSessionLifecycleTransaction } from "../lifecycle.js";
import { messageDeliveryRequestId } from "../requests/keys.js";
import { openRequest, resolveRequest } from "../requests/store.js";
import { loadSession, type SessionRecord } from "../store.js";

export type MessageUndeliverableReason =
  | "missing-cwd"
  | "missing-provider-session"
  | "wake-retry-exhausted"
  | "recovery-request-expired"
  | "queued-message-missing"
  | "archive-unresolved";

function undeliverableQuestion(record: SessionRecord, reason: MessageUndeliverableReason): string {
  switch (reason) {
    case "missing-cwd":
      return `Message is queued, but the working directory is unavailable: ${record.cwd}. Restore or recreate the working copy, then retry delivery.`;
    case "missing-provider-session":
      return "Message is queued, but this bee has no recorded provider session to resume. Choose an exact session id or revive it fresh, then retry delivery.";
    case "recovery-request-expired":
      return "Message is queued, but its recovery request is too old to auto-revive after a daemon restart. Confirm the bee should be resumed, then retry delivery.";
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
 * Turn a queue-tier send that raced intentional parking into one durable wake
 * obligation. If the queue write wins first, the parking primitive sees the
 * mailbox and cancels; if parking wins first, this waits for its lifecycle
 * lock and requests one lazy replacement.
 */
export async function requestMessageRecoveryIfParked(
  snapshot: SessionRecord,
  messageId: string,
  now: () => number = Date.now,
): Promise<boolean> {
  let current = snapshot;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withSessionLifecycleTransaction(current, async (lifecycle) => {
        const record = await lifecycle.refresh();
        if (record.status === "done" || record.stateMachine?.lifecycle === "archived") return false;
        if (record.stateMachine?.runtime !== "parked") return false;
        if (record.recoveryRequestedAt && record.recoveryMessageId) return true;
        const at = new Date(now()).toISOString();
        await lifecycle.commit({
          recoveryRequestedAt: at,
          recoveryMessageId: messageId,
          recoveryAttemptCount: 0,
          recoveryNextAttemptAt: undefined,
          updatedAt: at,
        });
        return true;
      });
    } catch (error) {
      if (!(error instanceof LifecycleConflictError)) throw error;
      const latest = await loadSession(snapshot.name);
      if (!latest) return false;
      current = latest;
    }
  }
  return false;
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
      await lifecycle.commit({
        recoveryRequestedAt: undefined,
        recoveryMessageId: undefined,
        recoveryAttemptCount: undefined,
        recoveryNextAttemptAt: undefined,
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  } catch {
    return false;
  }
}
