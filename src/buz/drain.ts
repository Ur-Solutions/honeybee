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
import { type BuzMessage, type DaemonDrainContext, type DrainResult } from "../buz.js";

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
  // (HIVE-47). Lock order is always delivery -> write; sendBuzMessage never
  // holds one while acquiring the other, so the pair cannot deadlock.
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
        await context.transport.substrate.sendText(context.transport.tmuxTarget, message.body, context.transport.agentPaneId);
      } catch (error) {
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
        result.errors.push({ id: message.id, message: error instanceof Error ? error.message : String(error) });
        await appendLedger({
          type: "buz.deliver",
          messageId: message.id,
          recipient: record.name,
          tier: "queue",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
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

      result.delivered.push(message.id);
      await appendLedger({
        type: "buz.deliver",
        messageId: message.id,
        recipient: record.name,
        tier: "queue",
        ok: true,
      });
    }
  }, { timeoutMs: DELIVERY_LOCK_TIMEOUT_MS });

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
