// tasks — task id generation.
//
// New tasks use `task_` + an RFC 9562 UUIDv7, matching buz message ids. The
// validator also accepts the former base32+hex form so persisted task lists
// remain readable across the migration.

import { generateMessageId, isUuidV7 } from "../buz/ids.js";

export const TASK_ID_PREFIX = "task_";

export function generateTaskId(now?: number): string {
  return `${TASK_ID_PREFIX}${generateMessageId(now)}`;
}

export function isTaskId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(TASK_ID_PREFIX)) return false;
  const id = value.slice(TASK_ID_PREFIX.length);
  return isUuidV7(id) || /^[0-9A-Z]{13}-[0-9a-f]{6}$/.test(id);
}
