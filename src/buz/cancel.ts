// buz — cancel a queued (not-yet-delivered) message. Extracted from the CLI
// verb (commands/buz.ts) so internal callers — the task store cancelling a fed
// task's carrying message — reuse the exact locking discipline instead of
// shelling `hive buz cancel`.

import { rm } from "node:fs/promises";
import { withFileLock } from "../lock.js";
import { appendLedger } from "../store.js";
import { DELIVERY_LOCK_TIMEOUT_MS, deliveryLockPath, readMessageById, recipientWriteLockPath } from "./storage.js";

/**
 * Remove a queued message from the recipient's queue/ under the delivery +
 * write locks so a concurrent daemon drain either delivers it fully or never
 * sees it. Lock order matches the drain (delivery -> write): holding the
 * delivery lock means an in-flight drain has either fully delivered this
 * message (rename to inbox done) or not read it yet — never
 * pasted-but-still-queued. Only queue/ messages are cancellable — anything in
 * inbox/read/quarantine has already settled.
 *
 * Returns true when the message was removed; false when it was not found in
 * queue/ (already delivered, already cancelled, or never existed). Ledgers
 * `buz.cancel` on success.
 */
export async function cancelQueuedBuzMessage(beeName: string, id: string): Promise<boolean> {
  const cancelled = await withFileLock(deliveryLockPath(beeName), () =>
    withFileLock(recipientWriteLockPath(beeName), async () => {
      const found = await readMessageById(beeName, id);
      if (!found || found.mailbox !== "queue") return false;
      await rm(found.path, { force: true });
      await rm(`${found.path}.retries`, { force: true }).catch(() => undefined);
      return true;
    }), { timeoutMs: DELIVERY_LOCK_TIMEOUT_MS });

  if (cancelled) await appendLedger({ type: "buz.cancel", bee: beeName, messageId: id });
  return cancelled;
}
