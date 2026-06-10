// buz — file-backed three-tier addressed messaging between bees.
//
// Storage layout (under storeRoot() — e.g. ~/.hive):
//
//   ~/.hive/buz/<bee>/inbox/<ts>-from-<sender>-<id>.md
//   ~/.hive/buz/<bee>/queue/<ts>-from-<sender>-<id>.md
//   ~/.hive/buz/<bee>/outbox/<ts>-to-<recipient>-<id>.md
//   ~/.hive/buz/<bee>/read/
//   ~/.hive/buz/<bee>/quarantine/
//   ~/.hive/buz/_external/<sanitized-human-name>/outbox/  (human senders only)
//
// Tiers:
//   interrupt — substrate.sendText immediately + copy in inbox/
//   queue     — store in queue/ (drained by the daemon whenever the
//               recipient is observed idle_with_output)
//   passive   — store in inbox/ only, no live delivery
//
// Per-recipient policy: SessionRecord.buzAccept lists allowed tiers. Missing
// field defaults to ['queue','passive'] (interrupts require explicit opt-in
// to close the spoof/DoS vector documented in PHASE2_PLAN.md decision #8).
// Disallowed tiers auto-downgrade interrupt -> queue -> passive; the
// actually-delivered tier is recorded in the message frontmatter as
// deliveredAs and surfaced in the ledger.
//
// Sender attribution (strict): callers must supply EITHER `senderBee` (a
// SessionRecord, the registered bee identity) OR `senderHuman` (a free
// string sanitized to lowercase + [a-z0-9_-]). Human-originated messages
// route via ~/.hive/buz/_external/<sanitized>/outbox/ so audit trails can
// distinguish bee-from-bee from human-from-bee traffic.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseBuzDocument, serializeBuzDocument, type BuzFrontmatter } from "./buz_format.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger, safeName, type SessionRecord } from "./store.js";
import type { Substrate } from "./substrates/index.js";

export const BUZ_TIERS = ["interrupt", "queue", "passive"] as const;
export type BuzTier = (typeof BUZ_TIERS)[number];

export const BUZ_MAILBOXES = ["inbox", "queue", "outbox", "read", "quarantine"] as const;
export type BuzMailbox = (typeof BUZ_MAILBOXES)[number];

export const EXTERNAL_NAMESPACE = "_external";

// Default policy when SessionRecord.buzAccept is undefined: queue + passive
// accepted; interrupts require explicit opt-in.
export const DEFAULT_BUZ_ACCEPT: readonly BuzTier[] = Object.freeze(["queue", "passive"]);

export type BuzSender =
  | { kind: "bee"; id: string }       // bee id (resolved from a SessionRecord)
  | { kind: "human"; name: string };  // sanitized human handle

export type BuzMessage = {
  id: string;
  from: BuzSender;
  to: string;          // recipient bee name
  tier: BuzTier;       // requested tier
  deliveredAs: BuzTier; // tier actually used after policy downgrade
  sentAt: string;       // ISO timestamp
  deliveredAt?: string; // ISO timestamp when paste/queue-drain completed
  subject?: string;
  body: string;
};

export type BuzTransportContext = {
  substrate: Substrate;
  tmuxTarget: string;
};

export type BuzSendInput = {
  recipient: SessionRecord;
  sender: BuzSender;
  tier: BuzTier;
  body: string;
  subject?: string;
  transport?: BuzTransportContext;
  node?: string;
};

export type BuzSendResult = {
  message: BuzMessage;
  inboxPath?: string;
  queuePath?: string;
  outboxPath?: string;
  downgraded: boolean;
  reason?: string;
};

// ──────────────────────────────────────────────────────────────────────────
// ID generation: 13-char base32 timestamp + 6-hex random, sortable.
// ──────────────────────────────────────────────────────────────────────────

// Crockford-style base32 (no I, L, O, U). Sorts lexicographically the same
// way as the underlying integer because the alphabet is sorted.
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateMessageId(now: number = Date.now()): string {
  return `${encodeBase32(now, 13)}-${randomHex(3)}`;
}

function encodeBase32(value: number, length: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`encodeBase32: value out of range: ${value}`);
  let n = Math.floor(value);
  const out: string[] = [];
  for (let i = 0; i < length; i += 1) {
    out.unshift(BASE32_ALPHABET[n % 32]!);
    n = Math.floor(n / 32);
  }
  if (n > 0) {
    // Value overflows; truncate to the most significant `length` chars.
    return out.join("");
  }
  return out.join("");
}

// crypto-strength randomness: Math.random suffixes collided across
// same-millisecond sends (broadcasts), silently overwriting mailbox files.
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ──────────────────────────────────────────────────────────────────────────
// Paths.
// ──────────────────────────────────────────────────────────────────────────

export function buzRoot(): string {
  return join(storeRoot(), "buz");
}

export function beeMailboxDir(beeName: string, mailbox: BuzMailbox): string {
  return join(buzRoot(), safeName(beeName), mailbox);
}

export function externalOutboxDir(humanName: string): string {
  return join(buzRoot(), EXTERNAL_NAMESPACE, sanitizeHumanName(humanName), "outbox");
}

function senderLockPath(beeName: string): string {
  return join(buzRoot(), safeName(beeName), ".write.lock");
}

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
// Policy resolution.
// ──────────────────────────────────────────────────────────────────────────

export function resolveBuzAccept(record: Pick<SessionRecord, "buzAccept">): readonly BuzTier[] {
  const explicit = record.buzAccept;
  if (!explicit || explicit.length === 0) return DEFAULT_BUZ_ACCEPT;
  return explicit;
}

export type DowngradeResult = {
  effective: BuzTier;
  downgraded: boolean;
  reason?: string;
};

// Auto-downgrade chain interrupt -> queue -> passive. If even passive is
// disallowed by an explicit policy that excludes all three, returns
// passive as a hard floor (we never silently drop a message); callers can
// inspect `downgraded` + `reason` to decide whether to error.
export function downgradeTier(requested: BuzTier, accepted: readonly BuzTier[]): DowngradeResult {
  const chain: BuzTier[] = ["interrupt", "queue", "passive"];
  const startIdx = chain.indexOf(requested);
  if (startIdx === -1) throw new Error(`Unknown tier: ${String(requested)}`);
  for (let i = startIdx; i < chain.length; i += 1) {
    const candidate = chain[i]!;
    if (accepted.includes(candidate)) {
      return {
        effective: candidate,
        downgraded: candidate !== requested,
        ...(candidate !== requested ? { reason: `policy disallows ${requested}` } : {}),
      };
    }
  }
  // Policy excludes every tier — fall back to passive as a documented floor.
  return {
    effective: "passive",
    downgraded: requested !== "passive",
    reason: `policy disallows ${requested}; no accepted tier; fell back to passive`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Filename construction.
// ──────────────────────────────────────────────────────────────────────────

export function inboxFilename(message: BuzMessage): string {
  const stamp = safeStamp(message.sentAt);
  return `${stamp}-from-${senderToken(message.from)}-${message.id}.md`;
}

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
  const tier = frontmatter.tier as BuzTier;
  const deliveredAs = frontmatter.deliveredAs as BuzTier;
  if (!BUZ_TIERS.includes(tier)) throw new Error(`Invalid tier: ${tier}`);
  if (!BUZ_TIERS.includes(deliveredAs)) throw new Error(`Invalid deliveredAs: ${deliveredAs}`);
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
// Send.
// ──────────────────────────────────────────────────────────────────────────

export async function sendBuzMessage(input: BuzSendInput): Promise<BuzSendResult> {
  const accepted = resolveBuzAccept(input.recipient);
  const downgrade = downgradeTier(input.tier, accepted);
  const sentAt = new Date().toISOString();
  const id = generateMessageId();
  const message: BuzMessage = {
    id,
    from: input.sender,
    to: input.recipient.name,
    tier: input.tier,
    deliveredAs: downgrade.effective,
    sentAt,
    body: input.body,
    ...(input.subject ? { subject: input.subject } : {}),
  };

  const result: BuzSendResult = {
    message,
    downgraded: downgrade.downgraded,
    ...(downgrade.reason ? { reason: downgrade.reason } : {}),
  };

  // Write the outbox audit copy up front so a failed delivery (e.g. the
  // recipient lock times out and the block below throws) still leaves a
  // sender-side record of the attempt; it is rewritten after delivery once
  // the effective tier is final.
  result.outboxPath = await writeOutbox(message);

  // Serialize per-bee writes so two concurrent senders cannot collide on
  // the same filename / mailbox. We have a single lock per recipient bee.
  await withFileLock(senderLockPath(input.recipient.name), async () => {
    if (downgrade.effective === "interrupt") {
      // Strict: interrupt requires a transport context. If transport is
      // missing, downgrade to queue rather than silently failing.
      if (!input.transport) {
        message.deliveredAs = "queue";
        const queued = await writeMailbox(input.recipient.name, "queue", message);
        result.queuePath = queued;
        result.downgraded = true;
        result.reason = result.reason ?? "tier=interrupt without transport context; downgraded to queue";
        return;
      }
      try {
        await input.transport.substrate.sendText(input.transport.tmuxTarget, input.body);
        message.deliveredAt = new Date().toISOString();
      } catch (error) {
        // Transport failure on interrupt: downgrade to queue and let the
        // daemon retry. Do not lose the message.
        message.deliveredAs = "queue";
        const queued = await writeMailbox(input.recipient.name, "queue", message);
        result.queuePath = queued;
        result.downgraded = true;
        result.reason = `interrupt transport failed: ${error instanceof Error ? error.message : String(error)}`;
        await appendLedger({
          type: "buz.deliver",
          messageId: message.id,
          recipient: message.to,
          tier: "interrupt",
          ok: false,
          error: result.reason,
          ...(input.node ? { node: input.node } : {}),
        });
        return;
      }
      result.inboxPath = await writeMailbox(input.recipient.name, "inbox", message);
      await appendLedger({
        type: "buz.deliver",
        messageId: message.id,
        recipient: message.to,
        tier: "interrupt",
        ok: true,
        ...(input.node ? { node: input.node } : {}),
      });
    } else if (downgrade.effective === "queue") {
      result.queuePath = await writeMailbox(input.recipient.name, "queue", message);
    } else {
      // passive
      result.inboxPath = await writeMailbox(input.recipient.name, "inbox", message);
    }
  });

  // Rewrite the outbox copy now that delivery settled: an interrupt can
  // downgrade to queue mid-delivery (missing transport, transport failure),
  // so only here are deliveredAs/deliveredAt final. Same filename — the
  // message id is unchanged — so this replaces the pre-delivery copy. A
  // rewrite failure must not fail the send: delivery already happened, and a
  // thrown error here would trigger retry-driven duplicates; the pre-delivery
  // audit copy remains in place.
  try {
    result.outboxPath = await writeOutbox(message);
  } catch {
    // keep the pre-delivery outbox copy
  }

  await appendLedger({
    type: "buz.send",
    messageId: message.id,
    from: senderDisplay(message.from),
    to: message.to,
    tier: input.tier,
    deliveredAs: message.deliveredAs,
    ...(downgrade.downgraded ? { downgraded: true, reason: result.reason } : {}),
    ...(input.node ? { node: input.node } : {}),
  });

  return result;
}

async function writeMailbox(beeName: string, mailbox: BuzMailbox, message: BuzMessage): Promise<string> {
  const dir = beeMailboxDir(beeName, mailbox);
  await mkdir(dir, { recursive: true });
  const path = join(dir, inboxFilename(message));
  await atomicWriteFile(path, serializeBuzMessage(message), { mode: 0o600 });
  return path;
}

async function writeOutbox(message: BuzMessage): Promise<string> {
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

export type ListMessagesOptions = {
  limit?: number;
  fromFilter?: string;
};

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
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    let message: BuzMessage;
    try {
      message = parseBuzMessage(text);
    } catch {
      continue;
    }
    if (options.fromFilter && senderDisplay(message.from) !== options.fromFilter
        && (message.from.kind !== "bee" || message.from.id !== options.fromFilter)) {
      continue;
    }
    results.push({ message, path });
  }
  if (typeof options.limit === "number" && options.limit >= 0) {
    return results.slice(0, options.limit);
  }
  return results;
}

export async function readMessageById(beeName: string, id: string): Promise<{ message: BuzMessage; path: string; mailbox: BuzMailbox } | null> {
  for (const mailbox of BUZ_MAILBOXES) {
    const dir = beeMailboxDir(beeName, mailbox);
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const file of entries) {
      if (!file.endsWith(`-${id}.md`)) continue;
      const path = join(dir, file);
      const text = await readFile(path, "utf8");
      return { message: parseBuzMessage(text), path, mailbox };
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
  const filename = found.path.split("/").pop()!;
  const dest = join(readDir, filename);
  await rename(found.path, dest);
  await appendLedger({ type: "buz.read", bee: beeName, messageId: id, consumed: true, mailbox: "inbox" });
  return { message: found.message, from: "inbox", toPath: dest };
}

// ──────────────────────────────────────────────────────────────────────────
// Purge.
// ──────────────────────────────────────────────────────────────────────────

export type PurgeOptions = {
  scope: "read" | "older-than" | "all";
  olderThanMs?: number;
  now?: number;
};

export type PurgeResult = {
  removed: number;
  paths: string[];
};

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

// ──────────────────────────────────────────────────────────────────────────
// Daemon integration seam (PATCH 9 will call this on transition).
// ──────────────────────────────────────────────────────────────────────────

export type DaemonDrainContext = {
  transport: BuzTransportContext;
  maxFailures?: number;
  now?: () => number;
  /**
   * Daemon dispatcher behavior: stop draining after the first substrate
   * failure (the broken substrate likely cannot deliver subsequent messages
   * either). Subsequent messages remain in queue and will be retried on the
   * next tick the recipient is observed idle_with_output. Retries/quarantine
   * bookkeeping for the failing message still runs before the loop
   * terminates.
   */
  stopOnFirstFailure?: boolean;
};

export type DrainResult = {
  delivered: string[];
  quarantined: string[];
  errors: { id: string; message: string }[];
};

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

  await withFileLock(senderLockPath(record.name), async () => {
    await mkdir(inboxDir, { recursive: true });

    for (const entry of stamped) {
      const text = await readFile(entry.path, "utf8").catch(() => null);
      if (text === null) continue;
      let message: BuzMessage;
      try {
        message = parseBuzMessage(text);
      } catch (error) {
        // Malformed file: quarantine.
        await mkdir(quarantineDir, { recursive: true });
        await rename(entry.path, join(quarantineDir, entry.file));
        result.quarantined.push(entry.file);
        result.errors.push({ id: entry.file, message: error instanceof Error ? error.message : String(error) });
        continue;
      }

      try {
        await context.transport.substrate.sendText(context.transport.tmuxTarget, message.body);
      } catch (error) {
        const retriesPath = `${entry.path}.retries`;
        const prev = Number((await readFile(retriesPath, "utf8").catch(() => "0")).trim()) || 0;
        const next = prev + 1;
        if (next >= maxFailures) {
          await mkdir(quarantineDir, { recursive: true });
          await rename(entry.path, join(quarantineDir, entry.file));
          await rm(retriesPath, { force: true });
          result.quarantined.push(entry.file);
        } else {
          await atomicWriteFile(retriesPath, String(next), { mode: 0o600 });
        }
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
      await atomicWriteFile(entry.path, updated, { mode: 0o600 });
      const target = join(inboxDir, entry.file);
      await rename(entry.path, target);
      await rm(`${entry.path}.retries`, { force: true }).catch(() => undefined);

      result.delivered.push(message.id);
      await appendLedger({
        type: "buz.deliver",
        messageId: message.id,
        recipient: record.name,
        tier: "queue",
        ok: true,
      });
    }
  });

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

// ──────────────────────────────────────────────────────────────────────────
// Accept policy update.
// ──────────────────────────────────────────────────────────────────────────

export function validateAcceptList(values: string[]): BuzTier[] {
  const out: BuzTier[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (!BUZ_TIERS.includes(value as BuzTier)) {
      throw new Error(`Unknown tier: ${value}. Use one of: ${BUZ_TIERS.join(", ")}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value as BuzTier);
  }
  return out;
}

export function parseAcceptFlag(value: string): BuzTier[] {
  return validateAcceptList(value.split(",").map((v) => v.trim()).filter(Boolean));
}
