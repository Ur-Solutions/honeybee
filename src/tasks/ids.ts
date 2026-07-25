// tasks — task id generation.
//
// `task_` + the house sortable id style (buz/ids.ts): 13-char Crockford-ish
// base32 timestamp + 6-hex crypto random. Lexicographically sortable by
// creation time, collision-free within a millisecond. (The epic sketch says
// "task_<ulid>"; this is hive's existing ulid-equivalent — one id grammar
// across buz messages and tasks.)

import { generateMessageId } from "../buz/ids.js";

export const TASK_ID_PREFIX = "task_";

export function generateTaskId(now: number = Date.now()): string {
  return `${TASK_ID_PREFIX}${generateMessageId(now)}`;
}

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && /^task_[0-9A-Z]{13}-[0-9a-f]{6}$/.test(value);
}
