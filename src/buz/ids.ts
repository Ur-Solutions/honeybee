// buz — RFC 9562 UUIDv7 message id generation.

import { validate as validateUuid, version as uuidVersion, v7 as uuidv7 } from "uuid";

const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;

/**
 * Generate a chronologically sortable UUIDv7. Production calls omit `now` so
 * uuid's internal monotonic state can order ids created in the same process
 * and millisecond. Tests and deterministic callers may provide the timestamp.
 */
export function generateMessageId(now?: number): string {
  if (now === undefined) return uuidv7();
  if (!Number.isFinite(now) || now < 0 || now > MAX_UUID_V7_TIMESTAMP) {
    throw new Error(`UUIDv7 timestamp out of range: ${now}`);
  }
  return uuidv7({ msecs: Math.floor(now) });
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && validateUuid(value) && uuidVersion(value) === 7;
}
