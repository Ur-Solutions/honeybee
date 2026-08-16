/** Operator reconciliation for a Buz turn with ambiguous provider ownership. */

import { basename, join } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { atomicWriteFile } from "../fsx.js";
import { deliveryContentDigest, readDeliveryDoubt, settleDeliveryDoubt } from "../deliveryDoubt.js";
import {
  clearCompletedPendingHsrTurnReceipt,
  markAmbiguousPendingHsrTurnReceiptDiscarded,
  markAmbiguousPendingHsrTurnReceiptCompleted,
  readPendingHsrTurn,
} from "../hsr/pendingTurns.js";
import {
  readHsrEventIntegrityReceipt,
  recordHsrEventIntegrityDeliveryVerdict,
} from "../hsr/eventIntegrity.js";
import { withFileLock } from "../lock.js";
import { withSessionLifecycleLock } from "../lifecycle.js";
import { deliveryAmbiguityRequestId, messageDeliveryRequestId } from "../requests/keys.js";
import { resolveRequest } from "../requests/store.js";
import { appendLedger, loadSession, saveSessionLocked, withSessionLock, type DeliveryStopDoubt, type SessionRecord } from "../store.js";
import { isArchivedSessionLifecycle } from "../stateMachine.js";
import { formatBuzInjectionAs, matchesBuzInjection } from "./inject.js";
import {
  DELIVERY_LOCK_TIMEOUT_MS,
  beeMailboxDir,
  deliveryLockPath,
  readMessageById,
  recipientWriteLockPath,
  serializeBuzMessage,
} from "./storage.js";

export type AmbiguousBuzDeliveryVerdict = "delivered" | "discard";

/**
 * Resolve one exact ambiguity without ever invoking the provider transport.
 *
 * `delivered`: receipt ambiguous -> completed first, then queue/quarantine ->
 * inbox, then clear only after the durable inbox proof. A crash after the
 * first step makes the daemon's same-id retry a completed receipt lookup.
 *
 * `discard`: queue -> quarantine first, then clear the ambiguity fence. A
 * crash between the steps leaves the receipt fenced and the work non-runnable;
 * repeating the same command converges.
 */
export async function reconcileAmbiguousBuzDelivery(
  bee: string,
  messageId: string,
  verdict: AmbiguousBuzDeliveryVerdict,
  options: { now?: () => Date } = {},
): Promise<{ verdict: AmbiguousBuzDeliveryVerdict; mailbox: "inbox" | "read" | "quarantine" | "absent" }> {
  const outcome = await withSessionLifecycleLock(bee, () =>
    withFileLock(deliveryLockPath(bee), () =>
      withFileLock(recipientWriteLockPath(bee), async () => {
      let receipt = await readPendingHsrTurn(bee, messageId);
      const doubt = await readDeliveryDoubt(bee, messageId);
      let found = await readMessageById(bee, messageId, { strict: true });
      const canonical = await loadSession(bee);
      const canonicalMarker = canonical?.deliveryStopDoubt?.deliveryId === messageId
        ? canonical.deliveryStopDoubt
        : undefined;
      const eventIntegrity = await readHsrEventIntegrityReceipt(bee);
      const eventIntegrityOwnsDelivery = eventIntegrity?.deliveryIds.includes(messageId) === true;
      const eventIntegrityVerdict = eventIntegrityOwnsDelivery
        ? eventIntegrity?.deliveryVerdicts?.[messageId]
        : undefined;
      if (canonicalMarker && canonical && !deliveryMarkerMatchesRecord(canonicalMarker, canonical)) {
        throw new Error(`canonical delivery marker ${messageId} no longer owns ${bee}'s runtime generation`);
      }
      if (
        eventIntegrityVerdict
        && eventIntegrityVerdict !== (verdict === "delivered" ? "delivered" : "discarded")
      ) {
        throw new Error(
          `HSR event-integrity delivery ${messageId} is already ${eventIntegrityVerdict}, not awaiting ${verdict}`,
        );
      }

      if (!receipt && !doubt && !canonicalMarker && !eventIntegrityOwnsDelivery) {
        const settled = verdict === "delivered"
          ? found?.mailbox === "inbox" || found?.mailbox === "read"
          : found?.mailbox === "quarantine" || !found;
        if (!settled) throw new Error(`HSR delivery ${messageId} has no ambiguity receipt to reconcile`);
        return { verdict, mailbox: (found?.mailbox ?? "absent") as "inbox" | "read" | "quarantine" | "absent" };
      }

      if (receipt && receipt.phase !== "ambiguous" && !(verdict === "delivered" && receipt.phase === "completed") && !(verdict === "discard" && receipt.phase === "discarded")) {
        throw new Error(`HSR delivery ${messageId} is ${receipt.phase}, not an ambiguity awaiting ${verdict}`);
      }
      if (receipt && found && found.mailbox !== "outbox") {
        if (!matchesBuzInjection(receipt.text, found.message)) {
          throw new Error(`Buz message ${messageId} content does not match its durable HSR delivery receipt`);
        }
      }
      if (doubt && found && found.mailbox !== "outbox") {
        const possibleInjections = new Set<typeof found.message.deliveredAs>([
          found.message.deliveredAs,
          "interrupt",
          "next-tool",
          "queue",
          "passive",
        ]);
        const matches = [...possibleInjections].some((deliveredAs) =>
          doubt.contentDigest === deliveryContentDigest(formatBuzInjectionAs(found!.message, deliveredAs)));
        if (!matches) throw new Error(`Buz message ${messageId} does not match its delivery-doubt digest`);
      }
      if (canonicalMarker && found && found.mailbox !== "outbox") {
        const possibleInjections = new Set<typeof found.message.deliveredAs>([
          found.message.deliveredAs,
          "interrupt",
          "next-tool",
          "queue",
          "passive",
        ]);
        const matches = [...possibleInjections].some((deliveredAs) =>
          canonicalMarker.contentDigest === deliveryContentDigest(formatBuzInjectionAs(found!.message, deliveredAs)));
        if (!matches) throw new Error(`Buz message ${messageId} does not match its canonical delivery marker`);
      }

      if (verdict === "delivered") {
        if (receipt?.phase === "ambiguous") {
          receipt = await markAmbiguousPendingHsrTurnReceiptCompleted(bee, messageId);
        }
        await settleDeliveryDoubt(bee, messageId, "delivered");
        if (!found || found.mailbox === "outbox") {
          // Non-Buz direct turns have no mailbox. Their durable completed HSR
          // tombstone (and generic delivered verdict) remains the authority.
          await recordHsrEventIntegrityDeliveryVerdict(bee, messageId, "delivered");
          if (canonicalMarker) await clearCanonicalDeliveryMarker(bee, canonicalMarker);
          return { verdict, mailbox: "absent" as const };
        }
        if (found.mailbox !== "inbox" && found.mailbox !== "read") {
          const inboxDir = beeMailboxDir(bee, "inbox");
          await mkdir(inboxDir, { recursive: true });
          found.message.deliveredAt ??= (options.now ?? (() => new Date()))().toISOString();
          found.message.deliveredAs = "queue";
          await atomicWriteFile(found.path, serializeBuzMessage(found.message), { mode: 0o600 });
          await rename(found.path, join(inboxDir, basename(found.path)));
          found = await readMessageById(bee, messageId, { strict: true });
          if (!found || found.mailbox !== "inbox") {
            throw new Error(`Buz delivery ${messageId} did not publish its durable inbox receipt`);
          }
        }
        // Retain the exact verdict in the purge-surviving event-integrity head
        // before clearing the Buz/turn tombstone. Otherwise the mandated
        // delivered reconciliation would make later HSR loss acknowledgement
        // impossible even though the durable inbox already proves delivery.
        await recordHsrEventIntegrityDeliveryVerdict(bee, messageId, "delivered");
        if (receipt) await clearCompletedPendingHsrTurnReceipt(bee, messageId);
        if (canonicalMarker) await clearCanonicalDeliveryMarker(bee, canonicalMarker);
        return { verdict, mailbox: found.mailbox as "inbox" | "read" };
      }

      if (found?.mailbox === "inbox" || found?.mailbox === "read") {
        throw new Error(`refusing to discard Buz delivery ${messageId}: recipient mailbox proves it delivered`);
      }
      if (found?.mailbox === "queue") {
        const quarantineDir = beeMailboxDir(bee, "quarantine");
        await mkdir(quarantineDir, { recursive: true });
        await rename(found.path, join(quarantineDir, basename(found.path)));
        found = await readMessageById(bee, messageId, { strict: true });
        if (!found || found.mailbox !== "quarantine") {
          throw new Error(`Buz delivery ${messageId} did not publish its quarantine receipt`);
        }
      }
      // An explicitly named discard may settle a mailbox row already purged
      // by the operator; the durable ambiguity id itself remains the authority.
      if (receipt?.phase === "ambiguous") await markAmbiguousPendingHsrTurnReceiptDiscarded(bee, messageId);
      await settleDeliveryDoubt(bee, messageId, "discarded");
      await recordHsrEventIntegrityDeliveryVerdict(bee, messageId, "discarded");
      if (canonicalMarker) await clearCanonicalDeliveryMarker(bee, canonicalMarker);
      return { verdict, mailbox: (found?.mailbox ?? "absent") as "quarantine" | "absent" };
      }),
    { timeoutMs: DELIVERY_LOCK_TIMEOUT_MS }));

  const resolution = verdict === "delivered"
    ? "operator confirmed provider delivery"
    : "operator discarded ambiguous delivery";
  await resolveRequest(bee, messageDeliveryRequestId(bee, messageId), { by: "buz-reconcile", resolution }).catch(() => undefined);
  await resolveRequest(bee, deliveryAmbiguityRequestId(bee, messageId), { by: "buz-reconcile", resolution }).catch(() => undefined);
  await appendLedger({ type: "buz.reconcile", bee, messageId, verdict, mailbox: outcome.mailbox }).catch(() => undefined);
  return outcome;
}

function deliveryMarkerMatchesRecord(marker: DeliveryStopDoubt, record: SessionRecord): boolean {
  return marker.source.createdAt === record.createdAt &&
    marker.source.runtimeGeneration === (record.runtimeGeneration ?? 0) &&
    (marker.source.id === undefined || marker.source.id === record.id) &&
    (marker.source.uuid === undefined || marker.source.uuid === record.uuid);
}

/** Caller owns the lifecycle-name lock; take only the short record lock here. */
async function clearCanonicalDeliveryMarker(bee: string, expected: DeliveryStopDoubt): Promise<void> {
  await withSessionLock(bee, async () => {
    const current = await loadSession(bee);
    if (!current) return;
    if (JSON.stringify(current.deliveryStopDoubt) !== JSON.stringify(expected)) {
      throw new Error(`canonical delivery marker ${expected.deliveryId} changed during reconciliation`);
    }
    const next: SessionRecord = { ...current, updatedAt: new Date().toISOString() };
    delete next.deliveryStopDoubt;
    const ownsCanonicalFence = current.lastError === expected.fenceError;
    if (ownsCanonicalFence) {
      delete next.lastError;
    }
    if (!isArchivedSessionLifecycle(current) && current.status === "kill_failed" && ownsCanonicalFence) next.status = "running";
    await saveSessionLocked(next);
  });
}
