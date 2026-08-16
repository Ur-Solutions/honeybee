/**
 * A transport may use this error only when it received a definite refusal for
 * the message itself. Missing processes, sockets, panes, nodes, and timeouts
 * are transport failures and must remain ordinary errors so the durable item
 * is retried without a quarantine cap.
 */
export class BuzDeliveryRejectedError extends Error {
  readonly code = "HIVE_BUZ_DELIVERY_REJECTED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BuzDeliveryRejectedError";
  }
}

/**
 * A no-id caller collided with a durable, still-unsettled logical intent.
 * The caller must retry with `messageId`, or explicitly opt into a distinct
 * intent (`--new`) when the repeated payload is deliberate.
 */
export class BuzUnresolvedIntentError extends Error {
  readonly code = "HIVE_BUZ_UNRESOLVED_INTENT";
  readonly messageId: string;

  constructor(messageId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BuzUnresolvedIntentError";
    this.messageId = messageId;
  }
}

export type BuzDeliveryFailureClass = "transport" | "delivery-rejected";

export function classifyBuzDeliveryFailure(error: unknown): BuzDeliveryFailureClass {
  return error instanceof BuzDeliveryRejectedError ||
    (error as { code?: unknown } | null | undefined)?.code === "HIVE_BUZ_DELIVERY_REJECTED"
    ? "delivery-rejected"
    : "transport";
}
