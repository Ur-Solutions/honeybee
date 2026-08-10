// buz — send path: resolve policy, allocate an id, write the outbox audit
// copy, dispatch to the effective tier's delivery handler (interrupt paste /
// queue / passive), and record the ledger entries.

import { stat, utimes } from "node:fs/promises";
import { withFileLock } from "../lock.js";
import { appendLedger } from "../store.js";
import { resetTaskSupplyFeedsForHumanInteraction, TASK_SUPPLY_SENDER_NAME } from "../tasks/supplyConfig.js";
import { generateMessageId, isUuidV7 } from "./ids.js";
import { formatBuzInjection } from "./inject.js";
import { downgradeTier, resolveBuzAccept } from "./policy.js";
import {
  DELIVERY_LOCK_TIMEOUT_MS,
  deliveryLockPath,
  finalizeQueuedDelivery,
  recipientWriteLockPath,
  senderDisplay,
  senderToken,
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
  /** Set when a live substrate paste was attempted, to the tier it was attempted AS. */
  liveTierAttempted?: BuzTier;
};

type BuzDeliveryHandler = (context: BuzDeliveryContext) => Promise<BuzDeliveryOutcome>;

const BUZ_DELIVERY_HANDLERS = {
  interrupt: deliverInterruptTier,
  "next-tool": deliverNextToolTier,
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
  // The accept-list downgrade exists to close the bee-to-bee interrupt
  // spoof/DoS vector. A HUMAN sender (the desktop/CLI user steering their own
  // bee) gets the tier they asked for: any local process can already
  // `hive send` unconditionally, so honoring a human interrupt opens nothing
  // that isn't already open. Substrate-capability downgrades (next-tool on a
  // substrate that cannot hold it) still apply below.
  const accepted = resolveBuzAccept(input.recipient);
  const downgrade = input.sender.kind === "human"
    ? { effective: input.tier, downgraded: false as const }
    : downgradeTier(input.tier, accepted);
  const sentAt = new Date().toISOString();
  if (input.messageId !== undefined && !isUuidV7(input.messageId)) {
    throw new Error("buz messageId must be an RFC 9562 UUIDv7");
  }
  const id = input.messageId ?? generateMessageId();
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

  if (delivery.liveTierAttempted) {
    const failed = message.deliveredAs !== delivery.liveTierAttempted;
    await appendLedger({
      type: "buz.deliver",
      messageId: message.id,
      recipient: message.to,
      tier: delivery.liveTierAttempted,
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
    ...(result.downgraded
      ? { downgraded: true, ...(result.reason ? { reason: result.reason } : {}) }
      : {}),
    ...(input.node ? { node: input.node } : {}),
  });

  // A human-sender send to this bee is the task-supply breaker's "human
  // interaction": reset the consecutive-feed counter (tasks/supplyConfig.ts).
  // The supply loop's own sends are excluded by sender name; best-effort and
  // never fails the send.
  if (input.sender.kind === "human" && senderToken(input.sender) !== TASK_SUPPLY_SENDER_NAME) {
    await resetTaskSupplyFeedsForHumanInteraction(input.recipient);
  }

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
    return {};
  }

  const transport = input.transport;
  try {
    await withFileLock(
      deliveryLockPath(input.recipient.name),
      () => transport.substrate.sendText(transport.tmuxTarget, formatBuzInjection(message), transport.agentPaneId),
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
    return { liveTierAttempted: "interrupt" };
  }

  await writeRecipientMailbox(context, "inbox");
  return { liveTierAttempted: "interrupt" };
}

async function deliverNextToolTier(context: BuzDeliveryContext): Promise<BuzDeliveryOutcome> {
  const { input, message, result } = context;

  // next-tool needs a substrate with a non-interrupting steering path. Without
  // a transport, or on a substrate that would just paste immediately (tmux),
  // downgrade to queue so the semantics stay deterministic rather than
  // silently becoming "now".
  if (!input.transport || input.transport.substrate.supportsNextTool !== true) {
    message.deliveredAs = "queue";
    result.downgraded = true;
    result.reason = result.reason ?? (input.transport
      ? `substrate ${input.transport.substrate.kind} cannot hold next-tool delivery; downgraded to queue`
      : "tier=next-tool without transport context; downgraded to queue");
    await BUZ_DELIVERY_HANDLERS.queue(context);
    return {};
  }

  const transport = input.transport;
  // Stage the exact message in queue/ BEFORE handing it to the provider. The
  // delivery lock excludes the daemon drainer while the hand-off is live. On
  // success, queue -> inbox is one atomic rename; on failure (or a process
  // crash before that rename), the durable row remains drainable. This is the
  // same at-least-once choice as the ordinary queue drainer: ambiguity may
  // duplicate a steer, but it cannot silently lose one.
  await withFileLock(deliveryLockPath(input.recipient.name), async () => {
    await writeRecipientMailbox(context, "queue");
    try {
      await transport.substrate.sendText(
        transport.tmuxTarget,
        formatBuzInjection(message),
        transport.agentPaneId,
        { mode: "next-tool" },
      );
    } catch (error) {
      message.deliveredAs = "queue";
      result.downgraded = true;
      result.reason = `next-tool transport failed: ${error instanceof Error ? error.message : String(error)}`;
      // Rewrite the staged file with its final downgrade metadata. It stays in
      // queue/ for the daemon; do not append a second queue copy. Preserve its
      // initial mtime so messages queued during the RPC cannot jump ahead of it.
      const queuePath = result.queuePath;
      const originalTimes = queuePath ? await stat(queuePath).catch(() => undefined) : undefined;
      await writeRecipientMailbox(context, "queue");
      if (queuePath && originalTimes) {
        await utimes(queuePath, originalTimes.atime, originalTimes.mtime).catch(() => undefined);
      }
      return;
    }

    // deliveredAt is the provider acceptance receipt. Codex waits for the
    // turn/steer response; stream harnesses wait for stdin acceptance into the
    // harness-owned prompt queue.
    message.deliveredAt = new Date().toISOString();
    const queuePath = result.queuePath;
    if (!queuePath) throw new Error("next-tool delivery lost its durable queue stage");
    await withFileLock(recipientWriteLockPath(input.recipient.name), async () => {
      result.inboxPath = await finalizeQueuedDelivery(input.recipient.name, queuePath, message);
      delete result.queuePath;
    });
  }, { timeoutMs: DELIVERY_LOCK_TIMEOUT_MS });

  return { liveTierAttempted: "next-tool" };
}

async function deliverQueueTier(context: BuzDeliveryContext): Promise<BuzDeliveryOutcome> {
  await writeRecipientMailbox(context, "queue");
  return {};
}

async function deliverPassiveTier(context: BuzDeliveryContext): Promise<BuzDeliveryOutcome> {
  await writeRecipientMailbox(context, "inbox");
  return {};
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
