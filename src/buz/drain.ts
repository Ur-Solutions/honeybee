// buz — daemon drain: move queue/<bee>/ to inbox/ in mtime order, pasting
// each message to the recipient pane, quarantining on repeated failures.

import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { appendLedger, type SessionRecord } from "../store.js";
import {
  DELIVERY_LOCK_TIMEOUT_MS,
  beeMailboxDir,
  deliveryLockPath,
  parseBuzMessage,
  recipientWriteLockPath,
  serializeBuzMessage,
} from "./storage.js";
import { formatBuzInjection } from "./inject.js";
import { classifyBuzDeliveryFailure } from "./errors.js";
import { clearMessageRecovery, openMessageDeliveryRequest } from "./recovery.js";
import { clearCompletedPendingHsrTurnReceipt, isHsrDeliveryAmbiguous } from "../hsr/pendingTurns.js";
import { type BuzMessage, type DaemonDrainContext, type DrainResult } from "../buz.js";
import { messageDeliveryRequestId } from "../requests/keys.js";
import { readBeeRequests } from "../requests/store.js";

// ──────────────────────────────────────────────────────────────────────────
// Daemon integration seam (PATCH 9 will call this on transition).
// ──────────────────────────────────────────────────────────────────────────

// Drain queue/<bee>/ to inbox/ in mtime order. Rewrites YAML to set
// deliveredAt, then atomic rename queue -> inbox preserving filename.
// Quarantines on repeated substrate failures (counter held in a sidecar
// .retries file per message so we survive restarts).
//
// This function is exported for daemon use (patch 9). Delivery semantics
// are AT-LEAST-ONCE, not idempotent: the pane paste (sendText) and the
// queue->inbox rename are two separate steps, so a crash between them
// leaves the message in queue/ and the next drain pastes it again. We
// accept the rare duplicate paste rather than build a staging protocol;
// the inbox file itself is written at most once (rename preserves the
// filename, so re-drains converge on the same final inbox state).
export async function processQueueForBee(
  record: SessionRecord,
  context: DaemonDrainContext,
): Promise<DrainResult> {
  const maxFailures = context.maxFailures ?? 3;
  const deliverLimit = context.deliverLimit ?? Infinity;
  const queueDir = beeMailboxDir(record.name, "queue");
  const inboxDir = beeMailboxDir(record.name, "inbox");
  const quarantineDir = beeMailboxDir(record.name, "quarantine");

  const entries = await readdir(queueDir).catch(() => [] as string[]);
  const files = entries.filter((f) => f.endsWith(".md")).sort();
  const stamped = await Promise.all(files.map(async (file) => {
    const path = join(queueDir, file);
    const info = await stat(path).catch(() => null);
    return { file, path, mtimeMs: info?.mtimeMs ?? 0 };
  }));
  stamped.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const result: DrainResult = { delivered: [], quarantined: [], errors: [] };

  // The delivery lock — not the write lock — is held for the whole drain: it
  // serializes pastes against interrupt sends and excludes concurrent drains
  // for the same bee (which would double-paste every queue file both listed).
  // Filesystem mutations take the write lock briefly per message, so
  // concurrent senders' mailbox writes never wait behind substrate I/O
  // (HIVE-47). Whenever both are needed, lock order is always delivery ->
  // write (including next-tool's durable hand-off), so the pair cannot
  // deadlock.
  await withFileLock(deliveryLockPath(record.name), async () => {
    await mkdir(inboxDir, { recursive: true });

    for (const entry of stamped) {
      const text = await readFile(entry.path, "utf8").catch(() => null);
      if (text === null) continue;
      let message: BuzMessage;
      try {
        message = parseBuzMessage(text);
      } catch (error) {
        // Malformed file: quarantine.
        await withFileLock(recipientWriteLockPath(record.name), async () => {
          await mkdir(quarantineDir, { recursive: true });
          await rename(entry.path, join(quarantineDir, entry.file));
        });
        result.quarantined.push(entry.file);
        result.errors.push({ id: entry.file, message: error instanceof Error ? error.message : String(error) });
        continue;
      }

      try {
        const ambiguityRequest = (await readBeeRequests(record.name)).find((request) =>
          request.id === messageDeliveryRequestId(record.name, message.id) &&
          request.status === "open" &&
          request.evidence.detail === "delivery-ambiguous");
        if (ambiguityRequest) {
          result.errors.push({
            id: message.id,
            message: "delivery is parked behind a manual ambiguity request",
            code: "HIVE_HSR_DELIVERY_AMBIGUOUS",
          });
          break;
        }
        await context.transport.substrate.sendText(
          context.transport.tmuxTarget,
          formatBuzInjection(message),
          context.transport.agentPaneId,
          {
            deliveryId: message.id,
            completionRequired: true,
            ...(record.remoteLaunchId ? { remoteLaunchId: record.remoteLaunchId } : {}),
            ...(record.remoteIncarnation ? { remoteIncarnation: record.remoteIncarnation } : {}),
          },
        );
      } catch (error) {
        if (isHsrDeliveryAmbiguous(error)) {
          const detail = error instanceof Error ? error.message : String(error);
          await openMessageDeliveryRequest(record, message.id, "delivery-ambiguous").catch(() => undefined);
          result.errors.push({
            id: message.id,
            message: detail,
            code: "HIVE_HSR_DELIVERY_AMBIGUOUS",
          });
          await appendLedger({
            type: "buz.deliver",
            messageId: message.id,
            recipient: record.name,
            tier: "queue",
            ok: false,
            failureClass: "delivery-ambiguous",
            error: detail,
          });
          // Preserve strict mailbox order and stop blind retries. The exact
          // queued file remains until an operator reconciles provider outcome.
          break;
        }
        const failureClass = (context.classifyFailure ?? classifyBuzDeliveryFailure)(error);
        const errorCode = typeof (error as { code?: unknown } | null)?.code === "string"
          ? (error as { code: string }).code
          : undefined;
        if (failureClass === "delivery-rejected") {
          const retriesPath = `${entry.path}.retries`;
          const prev = Number((await readFile(retriesPath, "utf8").catch(() => "0")).trim()) || 0;
          const next = prev + 1;
          await withFileLock(recipientWriteLockPath(record.name), async () => {
            if (next >= maxFailures) {
              await mkdir(quarantineDir, { recursive: true });
              await rename(entry.path, join(quarantineDir, entry.file));
              await rm(retriesPath, { force: true });
              result.quarantined.push(entry.file);
            } else {
              await atomicWriteFile(retriesPath, String(next), { mode: 0o600 });
            }
          });
        }
        result.errors.push({
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
          ...(errorCode ? { code: errorCode } : {}),
        });
        // transitionSession already writes the authoritative rejected-edge
        // audit before throwing. Do not duplicate that proof with a second
        // buz.deliver failure row; the daemon recipient backoff controls its
        // next bounded retry.
        if (errorCode !== "ILLEGAL_BEE_TRANSITION") {
          await appendLedger({
            type: "buz.deliver",
            messageId: message.id,
            recipient: record.name,
            tier: "queue",
            ok: false,
            failureClass,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Daemon dispatcher: stop after first failure so a broken substrate
        // doesn't burn through every queued message in a single tick.
        // Subsequent messages remain in queue/ and will be retried next tick.
        if (context.stopOnFirstFailure) break;
        continue;
      }

      // Rewrite frontmatter with deliveredAt set, then atomic rename
      // queue/<file> -> inbox/<file>. Preserve filename so the daemon
      // collision rules with manual interrupts stay deterministic.
      message.deliveredAt = (context.now ? new Date(context.now()) : new Date()).toISOString();
      message.deliveredAs = "queue";
      const updated = serializeBuzMessage(message);
      await withFileLock(recipientWriteLockPath(record.name), async () => {
        await atomicWriteFile(entry.path, updated, { mode: 0o600 });
        const target = join(inboxDir, entry.file);
        await rename(entry.path, target);
        await rm(`${entry.path}.retries`, { force: true }).catch(() => undefined);
      });
      // The inbox rename is the external mailbox's durable acknowledgement.
      // Only now may a local-HSR completed tombstone be removed; if cleanup
      // fails, retaining it is safe and prevents any future duplicate.
      await clearCompletedPendingHsrTurnReceipt(record.name, message.id).catch(() => undefined);

      result.delivered.push(message.id);
      await appendLedger({
        type: "buz.deliver",
        messageId: message.id,
        recipient: record.name,
        tier: "queue",
        ok: true,
      });
      // One-at-a-time sequencing: the paste above starts a new turn, so any
      // further queued messages must wait for the NEXT idle observation.
      if (result.delivered.length >= deliverLimit) break;
    }
  }, { timeoutMs: DELIVERY_LOCK_TIMEOUT_MS });

  // Never acquire lifecycle while holding the delivery lock. HSR admission
  // owns those locks in the opposite (authoritative) order. A lifecycle-owned
  // daemon drain defers this one step further until its outer admission exits.
  if (!context.deferRecoveryClear) {
    for (const messageId of result.delivered) {
      await clearMessageRecovery(record.name, messageId, { resolveRequestBy: "buz-delivery" }).catch(() => undefined);
    }
  }

  if (result.delivered.length > 0 || result.quarantined.length > 0) {
    await appendLedger({
      type: "buz.queue.drain",
      recipient: record.name,
      delivered: result.delivered,
      quarantined: result.quarantined,
    });
  }
  return result;
}
