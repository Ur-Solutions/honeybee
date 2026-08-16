import { basename, join, resolve } from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { withFileLock } from "../lock.js";
import { appendLedger } from "../store.js";
import type { BuzMessage } from "../buz.js";
import {
  DELIVERY_LOCK_TIMEOUT_MS,
  beeMailboxDir,
  deliveryLockPath,
  readMessageById,
  recipientWriteLockPath,
} from "./storage.js";

export type UndeliverableMessageSettlement =
  | { outcome: "undeliverable"; message: BuzMessage; moved: boolean }
  | { outcome: "delivered"; message: BuzMessage }
  | { outcome: "absent" };

/**
 * Remove one exact accepted message from the future-delivery work set without
 * destroying its idempotency receipt. The atomic queue -> quarantine move is
 * serialized against daemon drain and live next-tool hand-off. A concurrent
 * delivery that won first is reported as delivered so callers cannot publish a
 * false UNDELIVERABLE verdict.
 */
export async function settleQueuedBuzMessageUndeliverable(
  beeName: string,
  id: string,
  reason: string,
): Promise<UndeliverableMessageSettlement> {
  let moved = false;
  const settlement = await withFileLock(
    deliveryLockPath(beeName),
    () => withFileLock(recipientWriteLockPath(beeName), async (): Promise<UndeliverableMessageSettlement> => {
      const found = await readMessageById(beeName, id, { strict: true });
      if (!found || found.mailbox === "outbox") return { outcome: "absent" };
      if (found.mailbox === "inbox" || found.mailbox === "read") {
        return { outcome: "delivered", message: found.message };
      }
      if (found.mailbox === "quarantine") {
        return { outcome: "undeliverable", message: found.message, moved: false };
      }

      const queueDir = beeMailboxDir(beeName, "queue");
      const filename = basename(found.path);
      if (resolve(found.path) !== resolve(join(queueDir, filename))) {
        throw new Error(`buz undeliverable settlement escaped recipient queue: ${found.path}`);
      }
      const quarantineDir = beeMailboxDir(beeName, "quarantine");
      await mkdir(quarantineDir, { recursive: true });
      await rename(found.path, join(quarantineDir, filename));
      await rm(`${found.path}.retries`, { force: true }).catch(() => undefined);
      moved = true;
      return { outcome: "undeliverable", message: found.message, moved: true };
    }),
    { timeoutMs: DELIVERY_LOCK_TIMEOUT_MS },
  );

  if (moved) {
    await appendLedger({
      type: "buz.undeliverable",
      bee: beeName,
      messageId: id,
      reason,
      mailbox: "quarantine",
    });
  }
  return settlement;
}
