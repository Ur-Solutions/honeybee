// buz — on-disk storage layer: mailbox paths, sender sanitization, filename
// construction, message (de)serialization, and the filesystem read/write/
// list/consume/purge operations over a bee's mailboxes.

import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseBuzDocument, serializeBuzDocument, type BuzFrontmatter } from "../buz_format.js";
import { isBuzTier } from "../buz_tiers.js";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { appendLedger, safeName } from "../store.js";
import {
  BUZ_MAILBOXES,
  EXTERNAL_NAMESPACE,
  type BuzMailbox,
  type BuzMessage,
  type BuzSender,
  type ListMessagesOptions,
  type PurgeOptions,
  type PurgeResult,
} from "../buz.js";

// ──────────────────────────────────────────────────────────────────────────
// Paths.
// ──────────────────────────────────────────────────────────────────────────

export function buzRoot(): string {
  return join(storeRoot(), "buz");
}

export function beeMailboxDir(beeName: string, mailbox: BuzMailbox): string {
  return anchoredBuzPath(safeName(beeName), mailbox);
}

export function externalOutboxDir(humanName: string): string {
  return anchoredBuzPath(EXTERNAL_NAMESPACE, sanitizeHumanName(humanName), "outbox");
}

export function recipientWriteLockPath(beeName: string): string {
  return anchoredBuzPath(safeName(beeName), ".write.lock");
}

function anchoredBuzPath(...segments: string[]): string {
  const root = buzRoot();
  const path = join(root, ...segments);
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`buz path escaped root: ${path}`);
  }
  return path;
}

// Serializes substrate pastes to a recipient's pane: sendText loads a tmux
// buffer whose name is derived from the target, so two concurrent pastes to
// the same bee would clobber each other's buffer (and interleave the
// paste+Enter pair). Kept separate from the write lock so filesystem mailbox
// mutations never wait behind live tmux/ssh I/O (HIVE-47).
export function deliveryLockPath(beeName: string): string {
  return join(buzRoot(), safeName(beeName), ".deliver.lock");
}

// Must exceed the worst-case sendText: three substrate execs (load-buffer,
// paste-buffer, send-keys) at up to the 30s per-exec tmux timeout each. The
// write lock keeps its 10s default — it now only guards fast fs mutations.
export const DELIVERY_LOCK_TIMEOUT_MS = 120_000;

// ──────────────────────────────────────────────────────────────────────────
// Sender sanitization.
// ──────────────────────────────────────────────────────────────────────────

// Sanitize a human-supplied sender name to lowercase + [a-z0-9_-]. Non-
// matching runs collapse to a single underscore. Empty results throw.
export function sanitizeHumanName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length === 0) throw new Error("sender-human name must not be empty");
  const sanitized = trimmed.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (sanitized.length === 0) throw new Error(`sender-human name yields no safe characters: ${JSON.stringify(name)}`);
  return sanitized;
}

export function senderToken(sender: BuzSender): string {
  return sender.kind === "bee" ? safeName(sender.id) : sanitizeHumanName(sender.name);
}

export function senderDisplay(sender: BuzSender): string {
  return sender.kind === "bee" ? sender.id : `human:${sanitizeHumanName(sender.name)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Filename construction.
// ──────────────────────────────────────────────────────────────────────────

export function recipientMailboxFilename(message: BuzMessage): string {
  const stamp = safeStamp(message.sentAt);
  return `${stamp}-from-${senderToken(message.from)}-${message.id}.md`;
}

export const inboxFilename = recipientMailboxFilename;

export function outboxFilename(message: BuzMessage): string {
  const stamp = safeStamp(message.sentAt);
  return `${stamp}-to-${safeName(message.to)}-${message.id}.md`;
}

function safeStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

// ──────────────────────────────────────────────────────────────────────────
// Serialization.
// ──────────────────────────────────────────────────────────────────────────

export function serializeBuzMessage(message: BuzMessage): string {
  const fm: BuzFrontmatter = {
    id: message.id,
    from: senderDisplay(message.from),
    to: message.to,
    tier: message.tier,
    deliveredAs: message.deliveredAs,
    sentAt: message.sentAt,
    ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
    ...(message.subject ? { subject: message.subject } : {}),
  };
  return serializeBuzDocument(fm, message.body);
}

export function parseBuzMessage(text: string): BuzMessage {
  const { frontmatter, body } = parseBuzDocument(text);
  const required = ["id", "from", "to", "tier", "deliveredAs", "sentAt"] as const;
  for (const key of required) {
    if (typeof frontmatter[key] !== "string") throw new Error(`Buz message missing field: ${key}`);
  }
  const tier = frontmatter.tier!;
  const deliveredAs = frontmatter.deliveredAs!;
  if (!isBuzTier(tier)) throw new Error(`Invalid tier: ${tier}`);
  if (!isBuzTier(deliveredAs)) throw new Error(`Invalid deliveredAs: ${deliveredAs}`);
  const fromRaw = frontmatter.from!;
  const from: BuzSender = fromRaw.startsWith("human:")
    ? { kind: "human", name: fromRaw.slice("human:".length) }
    : { kind: "bee", id: fromRaw };
  const message: BuzMessage = {
    id: frontmatter.id!,
    from,
    to: frontmatter.to!,
    tier,
    deliveredAs,
    sentAt: frontmatter.sentAt!,
    body,
  };
  if (frontmatter.deliveredAt) message.deliveredAt = frontmatter.deliveredAt;
  if (frontmatter.subject) message.subject = frontmatter.subject;
  return message;
}

// ──────────────────────────────────────────────────────────────────────────
// Mailbox writes.
// ──────────────────────────────────────────────────────────────────────────

export async function writeMailbox(beeName: string, mailbox: BuzMailbox, message: BuzMessage): Promise<string> {
  const dir = beeMailboxDir(beeName, mailbox);
  await mkdir(dir, { recursive: true });
  const path = join(dir, recipientMailboxFilename(message));
  await atomicWriteFile(path, serializeBuzMessage(message), { mode: 0o600 });
  return path;
}

/**
 * Complete a live delivery that was staged durably in queue/. The caller must
 * hold the recipient write lock. Rewriting before rename keeps deliveredAt and
 * deliveredAs exact while the atomic move preserves the original FIFO name.
 */
export async function finalizeQueuedDelivery(
  beeName: string,
  queuePath: string,
  message: BuzMessage,
): Promise<string> {
  const queueDir = beeMailboxDir(beeName, "queue");
  const filename = basename(queuePath);
  if (resolve(queuePath) !== resolve(join(queueDir, filename))) {
    throw new Error(`buz queued delivery escaped recipient queue: ${queuePath}`);
  }
  const inboxDir = beeMailboxDir(beeName, "inbox");
  await mkdir(inboxDir, { recursive: true });
  await atomicWriteFile(queuePath, serializeBuzMessage(message), { mode: 0o600 });
  const inboxPath = join(inboxDir, filename);
  await rename(queuePath, inboxPath);
  await rm(`${queuePath}.retries`, { force: true }).catch(() => undefined);
  return inboxPath;
}

export async function writeOutbox(message: BuzMessage): Promise<string> {
  let dir: string;
  if (message.from.kind === "bee") {
    dir = beeMailboxDir(message.from.id, "outbox");
  } else {
    dir = externalOutboxDir(message.from.name);
  }
  await mkdir(dir, { recursive: true });
  const path = join(dir, outboxFilename(message));
  await atomicWriteFile(path, serializeBuzMessage(message), { mode: 0o600 });
  return path;
}

// ──────────────────────────────────────────────────────────────────────────
// Inbox / outbox / queue listing + read.
// ──────────────────────────────────────────────────────────────────────────

export async function listMessages(
  beeName: string,
  mailbox: BuzMailbox,
  options: ListMessagesOptions = {},
): Promise<{ message: BuzMessage; path: string }[]> {
  const dir = beeMailboxDir(beeName, mailbox);
  const entries = await readdir(dir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  // Filenames begin with safeStamp(sentAt); sort descending so newest is first.
  const files = entries.filter((f) => f.endsWith(".md")).sort().reverse();
  const results: { message: BuzMessage; path: string }[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (options.strict) throw new Error(`buz message ${file} in ${mailbox} is unreadable`, { cause: error });
      continue;
    }
    let message: BuzMessage;
    try {
      message = parseBuzMessage(text);
    } catch (error) {
      if (options.strict) throw new Error(`buz message ${file} in ${mailbox} is malformed`, { cause: error });
      continue;
    }
    if (options.fromFilter && !senderMatchesFilter(message.from, options.fromFilter)) {
      continue;
    }
    results.push({ message, path });
  }
  if (typeof options.limit === "number" && options.limit >= 0) {
    return results.slice(0, options.limit);
  }
  return results;
}

/** Strictly list one sender's audit rows, including the external-human root. */
export async function listSenderOutboxMessages(
  sender: BuzSender,
  options: ListMessagesOptions = {},
): Promise<{ message: BuzMessage; path: string }[]> {
  const dir = sender.kind === "bee" ? beeMailboxDir(sender.id, "outbox") : externalOutboxDir(sender.name);
  const entries = await readdir(dir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const files = entries.filter((file) => file.endsWith(".md")).sort().reverse();
  const results: { message: BuzMessage; path: string }[] = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const message = parseBuzMessage(await readFile(path, "utf8"));
      if (options.fromFilter && !senderMatchesFilter(message.from, options.fromFilter)) continue;
      results.push({ message, path });
    } catch (error) {
      if (options.strict) throw new Error(`sender outbox message ${file} is unreadable or malformed`, { cause: error });
    }
  }
  if (typeof options.limit === "number" && options.limit >= 0) return results.slice(0, options.limit);
  return results;
}

function senderMatchesFilter(sender: BuzSender, rawFilter: string): boolean {
  const filter = rawFilter.trim();
  if (filter.length === 0) return true;
  if (senderDisplay(sender) === filter) return true;
  if (sender.kind === "bee") return sender.id === filter;
  const humanFilter = filter.startsWith("human:") ? filter.slice("human:".length) : filter;
  try {
    return sanitizeHumanName(humanFilter) === sanitizeHumanName(sender.name);
  } catch {
    return false;
  }
}

export async function readMessageById(
  beeName: string,
  id: string,
  options: { strict?: boolean } = {},
): Promise<{ message: BuzMessage; path: string; mailbox: BuzMailbox } | null> {
  // This lookup is an acceptance/receipt authority, not a filesystem browser.
  // Prefer recipient settlement over transient stages and audit copies:
  // delivered (inbox/read) > definitively undeliverable (quarantine) > queued
  // > sender-only outbox. In particular, a self-send leaves both an outbox and
  // a recipient copy; the audit row must never mask the stronger recipient
  // verdict and turn a delivered replay into ambiguity.
  const receiptPrecedence: readonly BuzMailbox[] = [
    "inbox",
    "read",
    "quarantine",
    "queue",
    "outbox",
  ];
  for (const mailbox of receiptPrecedence) {
    const dir = beeMailboxDir(beeName, mailbox);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      // Missing mailboxes are the normal empty-store shape. Any other I/O
      // failure is not proof that an id is absent: callers use this read to
      // decide whether replaying a durable effect is safe.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of entries) {
      if (!file.endsWith(`-${id}.md`)) continue;
      const path = join(dir, file);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        // A concurrent consume/purge may remove the file after readdir. Do not
        // collapse permission/media faults into a false idempotency miss.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        return { message: parseBuzMessage(text), path, mailbox };
      } catch (error) {
        // Display/cleanup callers historically tolerate malformed mail. A
        // caller using this lookup as an idempotency authority cannot: a file
        // naming the exact caller id but failing to parse is unknown durable
        // state, not proof that the id is free to enqueue again.
        if (options.strict) {
          throw new Error(
            `buz message ${id} in ${mailbox} is malformed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
    }
  }
  return null;
}

/** Strict sender-side lookup for an exact audit id (including human outbox). */
export async function readSenderOutboxById(
  sender: BuzSender,
  id: string,
  options: { strict?: boolean } = {},
): Promise<{ message: BuzMessage; path: string; mailbox: "outbox" } | null> {
  const dir = sender.kind === "bee" ? beeMailboxDir(sender.id, "outbox") : externalOutboxDir(sender.name);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const file of entries) {
    if (!file.endsWith(`-${id}.md`)) continue;
    const path = join(dir, file);
    try {
      return { message: parseBuzMessage(await readFile(path, "utf8")), path, mailbox: "outbox" };
    } catch (error) {
      if (options.strict) throw new Error(`sender outbox message ${id} is unreadable or malformed`, { cause: error });
    }
  }
  return null;
}

export async function consumeMessage(beeName: string, id: string): Promise<{ message: BuzMessage; from: BuzMailbox; toPath: string } | null> {
  // Move from inbox/ -> read/. If the message lives elsewhere (queue,
  // quarantine), we leave it where it is and return null so the caller
  // knows there's nothing to consume.
  const found = await readMessageById(beeName, id);
  if (!found || found.mailbox !== "inbox") return null;
  const readDir = beeMailboxDir(beeName, "read");
  await mkdir(readDir, { recursive: true });
  const filename = basename(found.path);
  const dest = join(readDir, filename);
  await rename(found.path, dest);
  await appendLedger({ type: "buz.read", bee: beeName, messageId: id, consumed: true, mailbox: "inbox" });
  return { message: found.message, from: "inbox", toPath: dest };
}

// ──────────────────────────────────────────────────────────────────────────
// Purge.
// ──────────────────────────────────────────────────────────────────────────

export async function purgeMailbox(beeName: string, options: PurgeOptions): Promise<PurgeResult> {
  const now = options.now ?? Date.now();
  const out: PurgeResult = { removed: 0, paths: [] };

  if (options.scope === "read") {
    await purgeDir(beeName, "read", () => true, out);
    await appendLedger({ type: "buz.purge", bee: beeName, scope: "read", removed: out.removed });
    return out;
  }

  if (options.scope === "all") {
    for (const mailbox of BUZ_MAILBOXES) {
      await purgeDir(beeName, mailbox, () => true, out);
    }
    await appendLedger({ type: "buz.purge", bee: beeName, scope: "all", removed: out.removed });
    return out;
  }

  // older-than: scan inbox + queue + outbox + read + quarantine and remove
  // files whose mtime is older than now - olderThanMs.
  const olderThanMs = options.olderThanMs;
  if (typeof olderThanMs !== "number" || olderThanMs <= 0) {
    throw new Error("purgeMailbox older-than requires a positive olderThanMs");
  }
  const cutoff = now - olderThanMs;
  for (const mailbox of BUZ_MAILBOXES) {
    await purgeDir(beeName, mailbox, async (path) => {
      const info = await stat(path).catch(() => null);
      if (!info) return false;
      return info.mtimeMs < cutoff;
    }, out);
  }
  await appendLedger({ type: "buz.purge", bee: beeName, scope: "older-than", olderThanMs, removed: out.removed });
  return out;
}

async function purgeDir(
  beeName: string,
  mailbox: BuzMailbox,
  predicate: (path: string) => Promise<boolean> | boolean,
  acc: PurgeResult,
): Promise<PurgeResult> {
  const dir = beeMailboxDir(beeName, mailbox);
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    if (await predicate(path)) {
      await rm(path, { force: true });
      acc.removed += 1;
      acc.paths.push(path);
    }
  }
  return acc;
}
