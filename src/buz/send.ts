// buz — send path: resolve policy, allocate an id, write the outbox audit
// copy, dispatch to the effective tier's delivery handler (interrupt paste /
// queue / passive), and record the ledger entries.

import { stat, utimes } from "node:fs/promises";
import { deliveryContentDigest, persistDeliveryDoubt, readDeliveryDoubt } from "../deliveryDoubt.js";
import { HsrDeliveryAmbiguousError, HsrDeliveryIdentityConflictError, isHsrDeliveryAmbiguous, readPendingHsrTurn } from "../hsr/pendingTurns.js";
import type { SessionLifecycleTransaction } from "../lifecycle.js";
import { withFileLock } from "../lock.js";
import { appendLedger } from "../store.js";
import { assertNoConflictingDeliveryAmbiguityRequest, withRunnableSessionAdmission } from "../delivery.js";
import { resetTaskSupplyFeedsForHumanInteraction, TASK_SUPPLY_SENDER_NAME } from "../tasks/supplyConfig.js";
import { generateMessageId, isUuidV7 } from "./ids.js";
import { formatBuzInjection } from "./inject.js";
import { downgradeTier, resolveBuzAccept } from "./policy.js";
import { openMessageDeliveryRequest } from "./recovery.js";
import { BuzDeliveryRejectedError } from "./errors.js";
import {
  DELIVERY_LOCK_TIMEOUT_MS,
  deliveryLockPath,
  finalizeQueuedDelivery,
  listMessages,
  listSenderOutboxMessages,
  readMessageById,
  readSenderOutboxById,
  recipientWriteLockPath,
  senderDisplay,
  senderToken,
  writeMailbox,
  writeOutbox,
} from "./storage.js";
import { BuzUnresolvedIntentError } from "./errors.js";
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
  deps: BuzSendDependencies;
};

export type BuzSendDependencies = {
  /** Existing outer lifecycle transaction; required for the final canonical ambiguity fence. */
  lifecycle?: SessionLifecycleTransaction;
  /** @internal deterministic fault seams for post-acceptance durability tests. */
  appendLedger?: typeof appendLedger;
  finalizeQueuedDelivery?: typeof finalizeQueuedDelivery;
  persistDeliveryDoubt?: typeof persistDeliveryDoubt;
  openMessageDeliveryRequest?: typeof openMessageDeliveryRequest;
  /** Crash/fault seam after durable offer publication but before provider I/O. */
  afterQueueBeforeTransport?: (message: BuzMessage) => Promise<void>;
  afterOutboxBeforeRecipient?: (message: BuzMessage) => Promise<void>;
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

/**
 * Public Buz admission. Queue/passive messages are future work just as live
 * pastes are, so every new message is serialized against kill/retire before
 * any mailbox or transport side effect is created.
 */
export async function sendBuzMessage(
  input: BuzSendInput,
  deps: Omit<BuzSendDependencies, "lifecycle"> = {},
): Promise<BuzSendResult> {
  return withRunnableSessionAdmission(input.recipient, async (lifecycle, recipient) => {
    return sendBuzMessageInAdmission({ ...input, recipient }, { ...deps, lifecycle });
  }, { operation: "hive buz send", ...(input.messageId ? { deliveryId: input.messageId } : {}) });
}

/**
 * Low-level send for callers that already own the recipient lifecycle lock.
 * Keep this name explicit: using it without admission is an ownership bug.
 */
export async function sendBuzMessageInAdmission(
  input: BuzSendInput,
  deps: BuzSendDependencies = {},
): Promise<BuzSendResult> {
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
  if (input.messageId !== undefined && !isUuidV7(input.messageId)) {
    throw new Error("buz messageId must be an RFC 9562 UUIDv7");
  }
  await assertNoConflictingDeliveryAmbiguityRequest(
    input.recipient.name,
    "hive buz send",
    input.messageId,
  );
  if (input.messageId === undefined && input.forceNewIntent !== true) {
    const unresolved = await findUnresolvedMatchingIntent(input);
    if (unresolved) {
      throw new BuzUnresolvedIntentError(
        unresolved.id,
        `Buz intent is already durably unresolved as ${unresolved.id}; retry with --message-id ${unresolved.id}, or pass --new to send an intentional duplicate`,
      );
    }
  }
  const existingExact = input.messageId === undefined
    ? undefined
    : await readMessageById(input.recipient.name, input.messageId, { strict: true })
      ?? await readSenderOutboxById(input.sender, input.messageId, { strict: true })
      ?? undefined;
  if (existingExact) {
    const sameIntent = messageMatchesIntent(existingExact.message, input);
    if (!sameIntent) {
      throw new HsrDeliveryIdentityConflictError(input.messageId!, `Buz message id ${input.messageId} is bound to different work`);
    }
    if (existingExact.mailbox === "quarantine") {
      throw new BuzDeliveryRejectedError(`Buz ${input.messageId} is quarantined and will not be redelivered under the same id`);
    }
    if (existingExact.mailbox !== "outbox") {
      const [doubt, hsrTurn] = await Promise.all([
        readDeliveryDoubt(input.recipient.name, existingExact.message.id),
        readPendingHsrTurn(input.recipient.name, existingExact.message.id),
      ]);
      if (doubt?.phase === "ambiguous" || hsrTurn?.phase === "ambiguous") {
        throw new HsrDeliveryAmbiguousError(
          existingExact.message.id,
          `Buz ${existingExact.message.id} has unresolved provider ownership`,
        );
      }
      return {
        message: existingExact.message,
        ...(existingExact.mailbox === "queue" ? { queuePath: existingExact.path } : {}),
        ...(existingExact.mailbox === "inbox" ? { inboxPath: existingExact.path } : {}),
        downgraded: existingExact.message.deliveredAs !== input.tier,
        ...(existingExact.message.deliveredAs !== input.tier
          ? { reason: "matching unresolved Buz operation already owns this delivery" }
          : {}),
      };
    }
    // Outbox is only an attempted audit row. Strict recipient lookup proved
    // that the same id has no queue/inbox/read/quarantine owner, so resuming
    // this exact immutable id is safe; the outbox rewrite below converges.
  }
  const sentAt = new Date().toISOString();
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
  await deps.afterOutboxBeforeRecipient?.(message);

  const delivery = await BUZ_DELIVERY_HANDLERS[message.deliveredAs]({ input, message, result, deps });

  if (delivery.liveTierAttempted) {
    const failed = message.deliveredAs !== delivery.liveTierAttempted;
    await (deps.appendLedger ?? appendLedger)({
      type: "buz.deliver",
      messageId: message.id,
      recipient: message.to,
      tier: delivery.liveTierAttempted,
      ok: !failed,
      ...(failed ? { error: result.reason } : {}),
      ...(input.node ? { node: input.node } : {}),
    }).catch(() => undefined);
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

  await (deps.appendLedger ?? appendLedger)({
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
  }).catch(() => undefined);

  // A human-sender send to this bee is the task-supply breaker's "human
  // interaction": reset the consecutive-feed counter (tasks/supplyConfig.ts).
  // The supply loop's own sends are excluded by sender name; best-effort and
  // never fails the send.
  if (input.sender.kind === "human" && senderToken(input.sender) !== TASK_SUPPLY_SENDER_NAME) {
    await resetTaskSupplyFeedsForHumanInteraction(input.recipient).catch(() => undefined);
  }

  return result;
}

function messageMatchesIntent(message: BuzMessage, input: BuzSendInput): boolean {
  return message.to === input.recipient.name &&
    JSON.stringify(message.from) === JSON.stringify(input.sender) &&
    message.tier === input.tier &&
    message.body === input.body &&
    (message.subject ?? undefined) === (input.subject ?? undefined);
}

/**
 * No-id retries cannot prove whether they are a new intent. Queue rows are
 * unresolved by definition. An outbox-only row is also unresolved until a
 * stronger recipient receipt exists; settled inbox/read/quarantine copies do
 * not block a later deliberate repetition of the same text.
 */
async function findUnresolvedMatchingIntent(input: BuzSendInput): Promise<BuzMessage | null> {
  const queued = (await listMessages(input.recipient.name, "queue", { strict: true }))
    .find(({ message }) => messageMatchesIntent(message, input));
  if (queued) return queued.message;

  const outboxRows = await listSenderOutboxMessages(input.sender, { strict: true });
  for (const { message } of outboxRows) {
    if (!messageMatchesIntent(message, input)) continue;
    const recipient = await readMessageById(input.recipient.name, message.id, { strict: true });
    if (!recipient || recipient.mailbox === "outbox" || recipient.mailbox === "queue") return message;
  }
  return null;
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
  await withFileLock(deliveryLockPath(input.recipient.name), async () => {
    // Publish the exact UUID before crossing the provider boundary. If the
    // provider accepts but inbox publication fails, this queue row and the
    // delivery-doubt receipt retain one reconcilable owner instead of letting
    // a CLI/broker retry manufacture a new message id.
    await writeRecipientMailbox(context, "queue");
    const attemptedText = formatBuzInjection(message);
    await context.deps.afterQueueBeforeTransport?.(message);
    try {
      await transport.substrate.sendText(transport.tmuxTarget, attemptedText, transport.agentPaneId, {
        deliveryId: message.id,
        completionRequired: true,
        ...(input.recipient.remoteLaunchId ? { remoteLaunchId: input.recipient.remoteLaunchId } : {}),
        ...(input.recipient.remoteIncarnation ? { remoteIncarnation: input.recipient.remoteIncarnation } : {}),
      });
    } catch (error) {
      if (isHsrDeliveryAmbiguous(error)) {
        message.deliveredAs = "queue";
        result.downgraded = true;
        result.reason = `interrupt delivery ambiguous: ${error instanceof Error ? error.message : String(error)}`;
        await rewriteQueuedDeliveryPreservingOrder(context).catch(() => undefined);
        return throwDurableBuzAmbiguity(
          context,
          attemptedText,
          "interrupt",
          error,
          `Buz ${message.id} crossed interrupt provider dispatch and requires manual reconciliation`,
        );
      }
      // Transport failure on interrupt: downgrade the already-staged exact
      // row to queue. The HSR transport separately classifies post-dispatch
      // ambiguity and its receipt prevents the daemon from blind replay.
      message.deliveredAs = "queue";
      result.downgraded = true;
      result.reason = `interrupt transport failed: ${error instanceof Error ? error.message : String(error)}`;
      await rewriteQueuedDeliveryPreservingOrder(context);
      return;
    }

    message.deliveredAt = new Date().toISOString();
    await finalizeAcceptedQueuedDelivery(context, attemptedText, "interrupt");
  }, { timeoutMs: DELIVERY_LOCK_TIMEOUT_MS });
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
  // same durable identity as the ordinary queue drainer: an uncertain
  // provider boundary keeps this exact UUID queued for reconciliation and is
  // never redriven under a fresh identity.
  await withFileLock(deliveryLockPath(input.recipient.name), async () => {
    await writeRecipientMailbox(context, "queue");
    const attemptedText = formatBuzInjection(message);
    await context.deps.afterQueueBeforeTransport?.(message);
    try {
      await transport.substrate.sendText(
        transport.tmuxTarget,
        attemptedText,
        transport.agentPaneId,
        {
          mode: "next-tool",
          deliveryId: message.id,
          completionRequired: true,
          ...(input.recipient.remoteLaunchId ? { remoteLaunchId: input.recipient.remoteLaunchId } : {}),
          ...(input.recipient.remoteIncarnation ? { remoteIncarnation: input.recipient.remoteIncarnation } : {}),
        },
      );
    } catch (error) {
      if (isHsrDeliveryAmbiguous(error)) {
        message.deliveredAs = "queue";
        result.downgraded = true;
        result.reason = `next-tool delivery ambiguous: ${error instanceof Error ? error.message : String(error)}`;
        await rewriteQueuedDeliveryPreservingOrder(context).catch(() => undefined);
        return throwDurableBuzAmbiguity(
          context,
          attemptedText,
          "next-tool",
          error,
          `Buz ${message.id} crossed next-tool provider dispatch and requires manual reconciliation`,
        );
      }
      message.deliveredAs = "queue";
      result.downgraded = true;
      result.reason = `next-tool transport failed: ${error instanceof Error ? error.message : String(error)}`;
      // Rewrite the staged file with its final downgrade metadata. It stays in
      // queue/ for the daemon; do not append a second queue copy. Preserve its
      // initial mtime so messages queued during the RPC cannot jump ahead of it.
      await rewriteQueuedDeliveryPreservingOrder(context);
      return;
    }

    // deliveredAt is the provider acceptance receipt. Codex waits for the
    // turn/steer response; stream harnesses wait for stdin acceptance into the
    // harness-owned prompt queue.
    message.deliveredAt = new Date().toISOString();
    await finalizeAcceptedQueuedDelivery(context, attemptedText, "next-tool");
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

async function rewriteQueuedDeliveryPreservingOrder(context: BuzDeliveryContext): Promise<void> {
  const queuePath = context.result.queuePath;
  const originalTimes = queuePath ? await stat(queuePath).catch(() => undefined) : undefined;
  await writeRecipientMailbox(context, "queue");
  if (queuePath && originalTimes) {
    await utimes(queuePath, originalTimes.atime, originalTimes.mtime).catch(() => undefined);
  }
}

async function finalizeAcceptedQueuedDelivery(
  context: BuzDeliveryContext,
  attemptedText: string,
  attemptedTier: "interrupt" | "next-tool",
): Promise<void> {
  const { input, message, result, deps } = context;
  const queuePath = result.queuePath;
  if (!queuePath) {
    return throwPostProviderMailboxAmbiguity(
      context,
      attemptedText,
      attemptedTier,
      new Error(`${attemptedTier} delivery lost its durable queue stage`),
    );
  }
  try {
    await withFileLock(recipientWriteLockPath(input.recipient.name), async () => {
      result.inboxPath = await (deps.finalizeQueuedDelivery ?? finalizeQueuedDelivery)(
        input.recipient.name,
        queuePath,
        message,
      );
      delete result.queuePath;
    });
  } catch (error) {
    return throwPostProviderMailboxAmbiguity(context, attemptedText, attemptedTier, error);
  }
}

async function throwPostProviderMailboxAmbiguity(
  context: BuzDeliveryContext,
  attemptedText: string,
  attemptedTier: "interrupt" | "next-tool",
  original: unknown,
): Promise<never> {
  return throwDurableBuzAmbiguity(
    context,
    attemptedText,
    attemptedTier,
    original,
    `Buz ${context.message.id} crossed ${attemptedTier} provider acceptance, but its recipient mailbox receipt failed; refusing automatic retry`,
  );
}

async function throwDurableBuzAmbiguity(
  context: BuzDeliveryContext,
  attemptedText: string,
  attemptedTier: "interrupt" | "next-tool",
  original: unknown,
  messageText: string,
): Promise<never> {
  const { input, message, deps } = context;
  const causes: unknown[] = [original];
  let fenced = false;
  try {
    await (deps.persistDeliveryDoubt ?? persistDeliveryDoubt)(
      input.recipient,
      message.id,
      attemptedText,
      `${attemptedTier} provider handoff succeeded but recipient mailbox publication failed`,
    );
    fenced = true;
  } catch (error) {
    causes.push(error);
  }
  try {
    await (deps.openMessageDeliveryRequest ?? openMessageDeliveryRequest)(
      input.recipient,
      message.id,
      "delivery-ambiguous",
    );
    fenced = true;
  } catch (error) {
    causes.push(error);
  }
  if (!fenced) {
    try {
      fenced = (await readPendingHsrTurn(input.recipient.name, message.id))?.phase === "ambiguous";
    } catch (error) {
      causes.push(error);
    }
  }
  // Local tmux and any transport whose own receipt failed have no remaining
  // durable delivery authority. The lifecycle lock is still held here, so
  // make the canonical row non-runnable before exposing a retry surface.
  if (!fenced && deps.lifecycle) {
    try {
      const fenceError = `Buz delivery ${message.id} may have crossed provider acceptance; durable ambiguity receipt publication failed`;
      const createdAt = new Date().toISOString();
      await deps.lifecycle.commit({
        status: "kill_failed",
        lastError: fenceError,
        deliveryStopDoubt: {
          version: 1,
          deliveryId: message.id,
          contentDigest: deliveryContentDigest(attemptedText),
          source: {
            createdAt: input.recipient.createdAt,
            runtimeGeneration: input.recipient.runtimeGeneration ?? 0,
            ...(input.recipient.id ? { id: input.recipient.id } : {}),
            ...(input.recipient.uuid ? { uuid: input.recipient.uuid } : {}),
          },
          createdAt,
          fenceError,
        },
        updatedAt: createdAt,
      });
      fenced = true;
    } catch (error) {
      causes.push(error);
    }
  }
  throw new HsrDeliveryAmbiguousError(
    message.id,
    messageText,
    {
      cause: causes.length === 1
        ? original
        : new AggregateError(
            causes,
            fenced
              ? "Buz post-provider receipt publication failed; fallback ownership fence retained"
              : "Buz post-provider receipt publication failed and every ownership fence failed",
          ),
    },
  );
}
