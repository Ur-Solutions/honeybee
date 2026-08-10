// buz — re-drive quarantined messages. Quarantine is a durable dead-letter
// mailbox (repeated definite delivery rejections, or malformed files), not a
// terminal one: once the underlying condition is fixed (runner host back up,
// recipient healthy again) the operator moves messages back to queue/ and the
// daemon drain retries them like any other queued mail.

import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../lock.js";
import { appendLedger } from "../store.js";
import { beeMailboxDir, parseBuzMessage, recipientWriteLockPath } from "./storage.js";

export type RequeueResult = {
  /** Message ids moved back to queue/. */
  requeued: string[];
  /** Files left in quarantine/ (malformed, or not the requested id). */
  skipped: { file: string; reason: string }[];
};

/**
 * Move quarantined messages back to the recipient's queue/ under the write
 * lock so a concurrent drain never observes a half-moved mailbox. Filenames
 * are preserved, so a requeued message re-enters the queue at its original
 * FIFO position (queue order is mtime, and rename keeps content mtime
 * semantics deterministic enough for the drain's stamped sort).
 *
 * Malformed files stay in quarantine — requeueing them would only bounce
 * straight back on the drain's parse check. Ledgers `buz.requeue` when at
 * least one message moved.
 */
export async function requeueQuarantinedMessages(
  beeName: string,
  options: { id?: string } = {},
): Promise<RequeueResult> {
  const quarantineDir = beeMailboxDir(beeName, "quarantine");
  const queueDir = beeMailboxDir(beeName, "queue");
  const result: RequeueResult = { requeued: [], skipped: [] };

  await withFileLock(recipientWriteLockPath(beeName), async () => {
    const entries = await readdir(quarantineDir).catch(() => [] as string[]);
    if (entries.length > 0) await mkdir(queueDir, { recursive: true });
    for (const file of entries.filter((f) => f.endsWith(".md")).sort()) {
      const path = join(quarantineDir, file);
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) continue;
      let id: string;
      try {
        id = parseBuzMessage(text).id;
      } catch (error) {
        result.skipped.push({ file, reason: `malformed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (options.id && id !== options.id) continue;
      await rename(path, join(queueDir, file));
      // A fresh delivery attempt starts with a clean rejection budget.
      await rm(`${join(queueDir, file)}.retries`, { force: true }).catch(() => undefined);
      result.requeued.push(id);
    }
  });

  if (result.requeued.length > 0) {
    await appendLedger({ type: "buz.requeue", bee: beeName, messageIds: result.requeued });
  }
  return result;
}

/**
 * Raw count of quarantined message files (including malformed ones, which
 * listMessages deliberately skips) — the "you have dead letters" signal for
 * `hive buz inbox`.
 */
export async function countQuarantinedMessages(beeName: string): Promise<number> {
  const entries = await readdir(beeMailboxDir(beeName, "quarantine")).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith(".md")).length;
}
