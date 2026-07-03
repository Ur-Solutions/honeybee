// buz — send path: resolve policy, allocate an id, write the outbox audit
// copy, dispatch to the effective tier's delivery handler (interrupt paste /
// queue / passive), and record the ledger entries.

import { withFileLock } from "../lock.js";
import { appendLedger } from "../store.js";
import { generateMessageId } from "./ids.js";
import { downgradeTier, resolveBuzAccept } from "./policy.js";
import {
  DELIVERY_LOCK_TIMEOUT_MS,
  deliveryLockPath,
  recipientWriteLockPath,
  senderDisplay,
  writeMailbox,
  writeOutbox,
} from "./storage.js";
import {
  type BuzMailbox,
  type BuzMessage,
  type BuzSendInput,
  type BuzSendResult,
  type BuzTier,
} from "../buz.js";

type BuzDeliveryContext = {
  input: BuzSendInput;
  message: BuzMessage;
  result: BuzSendResult;
};

type BuzDeliveryOutcome = {
  interruptAttempted: boolean;
};

type BuzDeliveryHandler = (context: BuzDeliveryContext) => Promise<BuzDeliveryOutcome>;

const BUZ_DELIVERY_HANDLERS = {
  interrupt: deliverInterruptTier,
  queue: deliverQueueTier,
  passive: deliverPassiveTier,
} satisfies Record<BuzTier, BuzDeliveryHandler>;

type RecipientDeliveryMailbox = Extract<BuzMailbox, "inbox" | "queue">;

const RESULT_PATH_FIELD_BY_MAILBOX = {
  inbox: "inboxPath",
  queue: "queuePath",
} satisfies Record<RecipientDeliveryMailbox, "inboxPath" | "queuePath">;

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

  const delivery = await BUZ_DELIVERY_HANDLERS[message.deliveredAs]({ input, message, result });

  if (delivery.interruptAttempted) {
    const failed = message.deliveredAs !== "interrupt";
    await appendLedger({
      type: "buz.deliver",
      messageId: message.id,
      recipient: message.to,
      tier: "interrupt",
      ok: !failed,
      ...(failed ? { error: result.reason } : {}),
      ...(input.node ? { node: input.node } : {}),
    });
  }

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

async function deliverInterruptTier(context: BuzDeliveryContext): Promise<BuzDeliveryOutcome> {
  const { input, message, result } = context;

  // The interrupt paste runs OUTSIDE the recipient write lock: sendText can
  // block for up to the substrate exec timeout (30s per tmux call), far past
  // the write lock's 10s default, so holding the write lock across it starved
  // concurrent senders and the daemon drain (HIVE-47). Pastes serialize on
  // the dedicated delivery lock instead.
  if (!input.transport) {
    // Strict: interrupt requires a transport context. If transport is
    // missing, downgrade to queue rather than silently failing.
    message.deliveredAs = "queue";
    result.downgraded = true;
    result.reason = result.reason ?? "tier=interrupt without transport context; downgraded to queue";
    await BUZ_DELIVERY_HANDLERS.queue(context);
    return { interruptAttempted: false };
  }

  const transport = input.transport;
  try {
    await withFileLock(
      deliveryLockPath(input.recipient.name),
      () => transport.substrate.sendText(transport.tmuxTarget, input.body, transport.agentPaneId),
      { timeoutMs: DELIVERY_LOCK_TIMEOUT_MS },
    );
    message.deliveredAt = new Date().toISOString();
  } catch (error) {
    // Transport failure on interrupt: downgrade to queue and let the daemon
    // retry. Do not lose the message.
    message.deliveredAs = "queue";
    result.downgraded = true;
    result.reason = `interrupt transport failed: ${error instanceof Error ? error.message : String(error)}`;
    await BUZ_DELIVERY_HANDLERS.queue(context);
    return { interruptAttempted: true };
  }

  await writeRecipientMailbox(context, "inbox");
  return { interruptAttempted: true };
}

async function deliverQueueTier(context: BuzDeliveryContext): Promise<BuzDeliveryOutcome> {
  await writeRecipientMailbox(context, "queue");
  return { interruptAttempted: false };
}

async function deliverPassiveTier(context: BuzDeliveryContext): Promise<BuzDeliveryOutcome> {
  await writeRecipientMailbox(context, "inbox");
  return { interruptAttempted: false };
}

async function writeRecipientMailbox(context: BuzDeliveryContext, mailbox: RecipientDeliveryMailbox): Promise<void> {
  const { input, message, result } = context;
  // Serialize per-bee mailbox writes so two concurrent senders cannot collide
  // on the same filename / mailbox. Held only for the filesystem mutation —
  // never across substrate I/O. A write-lock timeout after a successful paste
  // loses the inbox copy but not the paste; delivery is at-least-once and the
  // pre-delivery outbox record above keeps the audit trail.
  await withFileLock(recipientWriteLockPath(input.recipient.name), async () => {
    result[RESULT_PATH_FIELD_BY_MAILBOX[mailbox]] = await writeMailbox(input.recipient.name, mailbox, message);
  });
}
