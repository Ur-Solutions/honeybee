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
//
// ──────────────────────────────────────────────────────────────────────────
// This module is the public barrel + shared types. The implementation is
// split across buz/ so each concern lives on its own (HIVE-25):
//   buz/ids.ts      — message id generation
//   buz/policy.ts   — accept-list resolution, tier downgrade, accept flags
//   buz/storage.ts  — paths, sanitization, filenames, (de)serialization, fs ops
//   buz/send.ts     — sendBuzMessage + transport delivery
//   buz/drain.ts    — processQueueForBee (daemon drain)
// ──────────────────────────────────────────────────────────────────────────

import type { BuzTier } from "./buz_tiers.js";
import type { SessionRecord } from "./store.js";
import type { Substrate } from "./substrates/index.js";

export { BUZ_TIERS, isBuzTier, type BuzTier } from "./buz_tiers.js";

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
  /** The recipient bee's pinned pane, so an interrupt hits the agent pane. */
  agentPaneId?: string;
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

export type DowngradeResult = {
  effective: BuzTier;
  downgraded: boolean;
  reason?: string;
};

export type ListMessagesOptions = {
  limit?: number;
  fromFilter?: string;
};

export type PurgeOptions = {
  scope: "read" | "older-than" | "all";
  olderThanMs?: number;
  now?: number;
};

export type PurgeResult = {
  removed: number;
  paths: string[];
};

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

// ──────────────────────────────────────────────────────────────────────────
// Barrel: re-export the implementation from the buz/ submodules.
// ──────────────────────────────────────────────────────────────────────────

export { generateMessageId } from "./buz/ids.js";

export { downgradeTier, parseAcceptFlag, resolveBuzAccept, validateAcceptList } from "./buz/policy.js";

export {
  beeMailboxDir,
  buzRoot,
  consumeMessage,
  externalOutboxDir,
  inboxFilename,
  listMessages,
  outboxFilename,
  parseBuzMessage,
  purgeMailbox,
  readMessageById,
  recipientMailboxFilename,
  sanitizeHumanName,
  senderDisplay,
  senderToken,
  serializeBuzMessage,
} from "./buz/storage.js";

export { sendBuzMessage } from "./buz/send.js";

export { processQueueForBee } from "./buz/drain.js";
