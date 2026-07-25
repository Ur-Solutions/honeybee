// tasks — file-backed shared micro-task lists with gated auto-supply
// (docs/epics/agent-task-lists.md in the apiary repo). Buz's sibling store:
// same flat-YAML-frontmatter + markdown-body file family, same per-recipient
// write-lock discipline, same ledger audit trail.
//
// Storage layout (under storeRoot() — e.g. ~/.hive):
//
//   ~/.hive/tasks/bee/<bee-name>/<task-id>.md      per-bee lists ("bee:<name>")
//   ~/.hive/tasks/shared/<name>/<task-id>.md       shared lists ("shared:<name>")
//   ~/.hive/tasks/<kind>/<name>/.write.lock        per-list write lock
//
// A bare list reference ("mybee") means "bee:mybee". Tasks are durable state;
// buz is the ONLY delivery path: feeding a task = sending one queue-tier buz
// message that references it (see tasks/supply.ts + daemon/taskSupplyDispatcher).
//
// Status model:
//   pending      — in the backlog, not delivered anywhere
//   queued       — a buz message carrying this task exists (supply loop fed it)
//   in-progress  — someone is working it (task start / task claim)
//   done | blocked | cancelled — closed states (closedAt set)
//
// Provenance sets the `auto` (auto-supply eligible) default: user → true,
// bee → false (never promotable at add time), self → false and NEVER
// promotable to true — auto-feeding an agent its own plan back is a
// self-feeding loop by construction.
//
// ──────────────────────────────────────────────────────────────────────────
// This module is the public barrel + shared types. Implementation lives in
// tasks/ so each concern stands alone (mirrors buz/):
//   tasks/ids.ts          — task id generation
//   tasks/storage.ts      — paths, list ids, (de)serialization, fs reads
//   tasks/store.ts        — mutations: add/transition/claim/mv/edit (+ledger)
//   tasks/supplyConfig.ts — per-bee supply config on SessionRecord
//   tasks/supply.ts       — supply gate (pure), fed-message marker, feed
// ──────────────────────────────────────────────────────────────────────────

export const TASK_STATUSES = ["pending", "queued", "in-progress", "done", "blocked", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/** Statuses that count as "not closed". */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = Object.freeze(["pending", "queued", "in-progress"]);

export const TASK_ORIGIN_KINDS = ["user", "self", "bee"] as const;
export type TaskOriginKind = (typeof TASK_ORIGIN_KINDS)[number];

export function isTaskOriginKind(value: unknown): value is TaskOriginKind {
  return typeof value === "string" && (TASK_ORIGIN_KINDS as readonly string[]).includes(value);
}

export type TaskOrigin = {
  kind: TaskOriginKind;
  /** Human handle (sanitized) or bee name. */
  sender: string;
};

/**
 * Opaque structured payload riding with the task ({kind, payload}); stored
 * verbatim (e.g. kind "browser-comment" with a Syn ElementSnapshotPayload-
 * shaped payload + screenshot path). Bounded — see MAX_TASK_CONTEXT_BYTES.
 */
export type TaskContext = { kind: string } & Record<string, unknown>;

export type TaskListKind = "bee" | "shared";

export type TaskListId = {
  kind: TaskListKind;
  name: string;
};

export interface HiveTask {
  id: string; // task_<sortable id> (tasks/ids.ts)
  list: string; // "bee:<bee-name>" | "shared:<name>"
  title: string; // one line, imperative
  body?: string; // optional markdown detail (the file body)
  context?: TaskContext;
  origin: TaskOrigin;
  auto: boolean; // eligible for auto-supply
  status: TaskStatus;
  claimedBy?: string; // bee name; shared lists (set by task claim)
  order: number; // user-reorderable FIFO position
  questId?: string; // optional rollup link, never required
  buzMessageId?: string; // set when fed: the buz message that carried it
  /** Set by the supply loop when it feeds the task (marks it "auto-fed"). */
  fedAt?: string;
  /** Set when an auto-fed task survived its grace idle tick without closure. */
  stalledAt?: string;
  /** Reason given to `task block -p <reason>`. */
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type TaskTransitionAction = "start" | "done" | "block" | "cancel";

// ──────────────────────────────────────────────────────────────────────────
// Barrel: re-export the implementation from the tasks/ submodules.
// ──────────────────────────────────────────────────────────────────────────

export { generateTaskId, isTaskId } from "./tasks/ids.js";

export {
  MAX_TASK_CONTEXT_BYTES,
  MAX_TASK_TITLE_LENGTH,
  findTaskById,
  formatListId,
  listDir,
  listTaskLists,
  listTasks,
  listWriteLockPath,
  parseListId,
  parseTask,
  parseTaskContext,
  serializeTask,
  taskPath,
  tasksRoot,
  type TaskListSummary,
} from "./tasks/storage.js";

export {
  ORDER_STEP,
  addTask,
  claimTask,
  editTask,
  moveTask,
  transitionTask,
  markTaskQueuedForFeed,
  markTaskStalled,
  recordTaskBuzMessage,
  revertTaskFeed,
  resolveTaskAuto,
  type AddTaskInput,
  type EditTaskPatch,
} from "./tasks/store.js";

export {
  DEFAULT_TASK_SUPPLY_LIMIT,
  TASK_SUPPLY_SENDER_NAME,
  resetTaskSupplyFeedsForHumanInteraction,
  resolveTaskSupply,
  type ResolvedTaskSupply,
} from "./tasks/supplyConfig.js";

export {
  TASK_FEED_PROMPT_MARKER,
  buildTaskFeedBody,
  evaluateSupplyGate,
  taskInFlight,
  type SupplyGateBlockReason,
  type SupplyGateDecision,
  type SupplyGateInput,
  type TaskFeedPayload,
} from "./tasks/supply.js";
