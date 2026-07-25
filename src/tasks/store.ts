// tasks — mutation layer: add/transition/claim/mv/edit plus the supply loop's
// feed bookkeeping. Every mutation runs under the list's write lock (same
// discipline as buz mailbox writes: held only across fs mutation, never
// substrate I/O) and appends a ledger row.

import { mkdir, readFile } from "node:fs/promises";
import { cancelQueuedBuzMessage } from "../buz/cancel.js";
import { atomicWriteFile } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { appendLedger } from "../store.js";
import {
  type HiveTask,
  type TaskContext,
  type TaskListId,
  type TaskOrigin,
  type TaskStatus,
  type TaskTransitionAction,
} from "../tasks.js";
import { generateTaskId } from "./ids.js";
import {
  formatListId,
  listDir,
  listTasks,
  listWriteLockPath,
  MAX_TASK_TITLE_LENGTH,
  parseTask,
  serializeTask,
  taskPath,
} from "./storage.js";

/** Gap between consecutive order values so mv can bisect without rewrites. */
export const ORDER_STEP = 10;

// ──────────────────────────────────────────────────────────────────────────
// Provenance → auto rules.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the effective `auto` flag from provenance + the requested flag.
 *   user → default true, --auto/--no-auto respected.
 *   bee  → always false at add time; a requested true is IGNORED (warning) —
 *          promotion is a later receiving-side policy decision (epic §verbs).
 *   self → always false, never promotable: auto-feeding an agent its own plan
 *          back is a self-feeding loop by construction.
 */
export function resolveTaskAuto(origin: TaskOrigin, requested: boolean | undefined): { auto: boolean; warning?: string } {
  if (origin.kind === "user") return { auto: requested ?? true };
  if (requested === true) {
    return {
      auto: false,
      warning: origin.kind === "self"
        ? "self-origin tasks are never auto-supplied; --auto ignored"
        : "bee-origin tasks are created auto:false; --auto ignored (promote via task edit if the human wants it fed)",
    };
  }
  return { auto: false };
}

// ──────────────────────────────────────────────────────────────────────────
// Add.
// ──────────────────────────────────────────────────────────────────────────

export type AddTaskInput = {
  list: TaskListId;
  title: string;
  body?: string;
  context?: TaskContext;
  origin: TaskOrigin;
  /** The caller's --auto/--no-auto; undefined = provenance default. */
  autoRequested?: boolean;
  questId?: string;
  now?: () => number;
};

export async function addTask(input: AddTaskInput): Promise<{ task: HiveTask; warning?: string }> {
  const title = input.title.trim();
  if (title.length === 0) throw new Error("task title must not be empty");
  if (title.includes("\n")) throw new Error("task title must be a single line (use --body for detail)");
  if (title.length > MAX_TASK_TITLE_LENGTH) throw new Error(`task title exceeds ${MAX_TASK_TITLE_LENGTH} characters (use --body for detail)`);

  const { auto, warning } = resolveTaskAuto(input.origin, input.autoRequested);
  const nowIso = new Date(input.now ? input.now() : Date.now()).toISOString();
  const task = await withListLock(input.list, async () => {
    const existing = await listTasks(input.list);
    const maxOrder = existing.reduce((max, t) => Math.max(max, t.order), 0);
    const created: HiveTask = {
      id: generateTaskId(input.now ? input.now() : Date.now()),
      list: formatListId(input.list),
      title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.context ? { context: input.context } : {}),
      origin: input.origin,
      auto,
      status: "pending",
      order: maxOrder + ORDER_STEP,
      ...(input.questId ? { questId: input.questId } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await writeTask(input.list, created);
    return created;
  });

  await appendLedger({
    type: "task.add",
    taskId: task.id,
    list: task.list,
    title: task.title,
    origin: `${task.origin.kind}:${task.origin.sender}`,
    auto: task.auto,
    ...(task.questId ? { questId: task.questId } : {}),
  });
  return { task, ...(warning ? { warning } : {}) };
}

// ──────────────────────────────────────────────────────────────────────────
// Status transitions.
// ──────────────────────────────────────────────────────────────────────────

const TRANSITIONS: Record<TaskTransitionAction, { to: TaskStatus; from: readonly TaskStatus[] }> = {
  start: { to: "in-progress", from: ["pending", "queued", "blocked"] },
  done: { to: "done", from: ["pending", "queued", "in-progress"] },
  block: { to: "blocked", from: ["pending", "queued", "in-progress"] },
  cancel: { to: "cancelled", from: ["pending", "queued", "in-progress", "blocked"] },
};

const CLOSING_ACTIONS: readonly TaskTransitionAction[] = ["done", "block", "cancel"];

export type TransitionOptions = {
  /** `task block -p <reason>`. */
  reason?: string;
  now?: () => number;
};

/**
 * Apply a legal status transition under the list write lock.
 *
 * Closing a `queued` task (done/cancel — and block, same reasoning: the
 * message would deliver a task nobody should work) also cancels the carrying
 * buz message via the internal cancel primitive and clears buzMessageId, so
 * the recipient never receives a paste for a task that is already closed.
 */
export async function transitionTask(
  list: TaskListId,
  id: string,
  action: TaskTransitionAction,
  options: TransitionOptions = {},
): Promise<HiveTask> {
  const rule = TRANSITIONS[action];
  const nowIso = new Date(options.now ? options.now() : Date.now()).toISOString();

  const { task, cancelledBuzMessageId } = await withListLock(list, async () => {
    const current = await readTaskInList(list, id);
    if (!rule.from.includes(current.status)) {
      throw new Error(`task ${id} is ${current.status}; ${action} requires one of: ${rule.from.join(", ")}`);
    }

    let cancelled: string | undefined;
    const next: HiveTask = { ...current, status: rule.to, updatedAt: nowIso };
    if (current.status === "queued" && CLOSING_ACTIONS.includes(action) && current.buzMessageId) {
      // The carrying message: still queued -> remove it; already delivered ->
      // no-op (returns false). A cancel failure (e.g. lock timeout) must not
      // fail the transition — the stale paste is noise, the state is truth.
      if (list.kind === "bee") {
        const removed = await cancelQueuedBuzMessage(list.name, current.buzMessageId).catch(() => false);
        if (removed) cancelled = current.buzMessageId;
      }
      delete next.buzMessageId;
    }
    if (CLOSING_ACTIONS.includes(action)) next.closedAt = nowIso;
    if (action === "start") {
      // Reopening (blocked -> in-progress) clears the closed bookkeeping.
      delete next.closedAt;
      delete next.blockedReason;
    }
    if (action === "block" && options.reason) next.blockedReason = options.reason;
    await writeTask(list, next);
    return { task: next, cancelledBuzMessageId: cancelled };
  });

  await appendLedger({
    type: `task.${action}`,
    taskId: task.id,
    list: task.list,
    status: task.status,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(cancelledBuzMessageId ? { cancelledBuzMessageId } : {}),
  });
  return task;
}

// ──────────────────────────────────────────────────────────────────────────
// Claim (shared lists' atomic take-next primitive).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Atomically take the top unclaimed pending task: set claimedBy + in-progress
 * under the list write lock, so two bees on one list can never double-claim.
 * Returns null when nothing is claimable.
 */
export async function claimTask(list: TaskListId, claimant: string, now: () => number = Date.now): Promise<HiveTask | null> {
  const nowIso = new Date(now()).toISOString();
  const claimed = await withListLock(list, async () => {
    const tasks = await listTasks(list);
    const top = tasks.find((task) => task.status === "pending" && !task.claimedBy);
    if (!top) return null;
    const next: HiveTask = { ...top, status: "in-progress", claimedBy: claimant, updatedAt: nowIso };
    await writeTask(list, next);
    return next;
  });
  if (claimed) {
    await appendLedger({ type: "task.claim", taskId: claimed.id, list: claimed.list, claimedBy: claimant });
  }
  return claimed;
}

// ──────────────────────────────────────────────────────────────────────────
// Reorder.
// ──────────────────────────────────────────────────────────────────────────

export async function moveTask(
  list: TaskListId,
  id: string,
  anchor: { before?: string; after?: string },
  now: () => number = Date.now,
): Promise<HiveTask> {
  const hasBefore = typeof anchor.before === "string";
  const hasAfter = typeof anchor.after === "string";
  if (hasBefore === hasAfter) throw new Error("task mv: pass exactly one of --before <id> or --after <id>");
  const anchorId = (anchor.before ?? anchor.after)!;
  if (anchorId === id) throw new Error("task mv: a task cannot anchor on itself");
  const nowIso = new Date(now()).toISOString();

  const moved = await withListLock(list, async () => {
    const current = await readTaskInList(list, id);
    const tasks = (await listTasks(list)).filter((task) => task.id !== id);
    const anchorIdx = tasks.findIndex((task) => task.id === anchorId);
    if (anchorIdx === -1) throw new Error(`task mv: anchor task ${anchorId} not found in ${formatListId(list)}`);

    // Bisect between the anchor and its neighbor on the target side.
    const anchorOrder = tasks[anchorIdx]!.order;
    let nextOrder: number;
    if (hasBefore) {
      const prev = tasks[anchorIdx - 1];
      nextOrder = prev ? (prev.order + anchorOrder) / 2 : anchorOrder - ORDER_STEP;
    } else {
      const after = tasks[anchorIdx + 1];
      nextOrder = after ? (anchorOrder + after.order) / 2 : anchorOrder + ORDER_STEP;
    }
    const next: HiveTask = { ...current, order: nextOrder, updatedAt: nowIso };
    await writeTask(list, next);
    return next;
  });

  await appendLedger({
    type: "task.mv",
    taskId: moved.id,
    list: moved.list,
    order: moved.order,
    ...(hasBefore ? { before: anchorId } : { after: anchorId }),
  });
  return moved;
}

// ──────────────────────────────────────────────────────────────────────────
// Edit.
// ──────────────────────────────────────────────────────────────────────────

export type EditTaskPatch = {
  title?: string;
  body?: string;
  /** --auto/--no-auto. Promotion to true is rejected for self-origin tasks. */
  auto?: boolean;
};

export async function editTask(list: TaskListId, id: string, patch: EditTaskPatch, now: () => number = Date.now): Promise<HiveTask> {
  if (patch.title === undefined && patch.body === undefined && patch.auto === undefined) {
    throw new Error("task edit: pass at least one of -p <title>, --body <md>, --auto/--no-auto");
  }
  const nowIso = new Date(now()).toISOString();
  const edited = await withListLock(list, async () => {
    const current = await readTaskInList(list, id);
    if (patch.auto === true && current.origin.kind === "self") {
      throw new Error(`task ${id} is self-origin; self tasks are never auto-supplied (promotion rejected)`);
    }
    const next: HiveTask = { ...current, updatedAt: nowIso };
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length === 0) throw new Error("task title must not be empty");
      if (title.includes("\n")) throw new Error("task title must be a single line (use --body for detail)");
      if (title.length > MAX_TASK_TITLE_LENGTH) throw new Error(`task title exceeds ${MAX_TASK_TITLE_LENGTH} characters (use --body for detail)`);
      next.title = title;
    }
    if (patch.body !== undefined) {
      if (patch.body.length === 0) delete next.body;
      else next.body = patch.body;
    }
    if (patch.auto !== undefined) next.auto = patch.auto;
    await writeTask(list, next);
    return next;
  });
  await appendLedger({
    type: "task.edit",
    taskId: edited.id,
    list: edited.list,
    ...(patch.title !== undefined ? { title: edited.title } : {}),
    ...(patch.auto !== undefined ? { auto: edited.auto } : {}),
    ...(patch.body !== undefined ? { bodyEdited: true } : {}),
  });
  return edited;
}

// ──────────────────────────────────────────────────────────────────────────
// Supply-loop bookkeeping (called by the daemon dispatcher).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mark a task queued-for-feed: verifies it is STILL pending + auto under the
 * lock (the eligibility snapshot the gate saw may be stale), then sets
 * status: queued + fedAt. Returns null when the task is no longer eligible.
 * Ledgers `task.feed`.
 */
export async function markTaskQueuedForFeed(list: TaskListId, id: string, now: () => number = Date.now): Promise<HiveTask | null> {
  const nowIso = new Date(now()).toISOString();
  const fed = await withListLock(list, async () => {
    const current = await readTaskInList(list, id).catch(() => null);
    if (!current || current.status !== "pending" || !current.auto) return null;
    const next: HiveTask = { ...current, status: "queued", fedAt: nowIso, updatedAt: nowIso };
    // A re-fed task (previous feed reverted / stall recovered) starts clean.
    delete next.stalledAt;
    await writeTask(list, next);
    return next;
  });
  if (fed) await appendLedger({ type: "task.feed", taskId: fed.id, list: fed.list, fedAt: nowIso });
  return fed;
}

/** Record the carrying buz message id on a fed task. */
export async function recordTaskBuzMessage(list: TaskListId, id: string, buzMessageId: string, now: () => number = Date.now): Promise<void> {
  const nowIso = new Date(now()).toISOString();
  await withListLock(list, async () => {
    const current = await readTaskInList(list, id).catch(() => null);
    if (!current) return;
    await writeTask(list, { ...current, buzMessageId, updatedAt: nowIso });
  });
}

/** Roll a failed feed back to pending (the buz send never happened). */
export async function revertTaskFeed(list: TaskListId, id: string, now: () => number = Date.now): Promise<void> {
  const nowIso = new Date(now()).toISOString();
  await withListLock(list, async () => {
    const current = await readTaskInList(list, id).catch(() => null);
    if (!current || current.status !== "queued") return;
    const next: HiveTask = { ...current, status: "pending", updatedAt: nowIso };
    delete next.fedAt;
    delete next.buzMessageId;
    await writeTask(list, next);
  });
}

/**
 * Flag an auto-fed task the bee went idle past without closing. Idempotent —
 * an already-stalled task is left untouched. Ledgers `task.stalled`; no
 * notification machinery here — Apiary reads the store.
 */
export async function markTaskStalled(list: TaskListId, id: string, now: () => number = Date.now): Promise<HiveTask | null> {
  const nowIso = new Date(now()).toISOString();
  const stalled = await withListLock(list, async () => {
    const current = await readTaskInList(list, id).catch(() => null);
    if (!current || current.stalledAt) return null;
    if (current.status !== "queued" && current.status !== "in-progress") return null;
    const next: HiveTask = { ...current, stalledAt: nowIso, updatedAt: nowIso };
    await writeTask(list, next);
    return next;
  });
  if (stalled) await appendLedger({ type: "task.stalled", taskId: stalled.id, list: stalled.list, stalledAt: nowIso });
  return stalled;
}

// ──────────────────────────────────────────────────────────────────────────
// Internals.
// ──────────────────────────────────────────────────────────────────────────

async function withListLock<T>(list: TaskListId, fn: () => Promise<T>): Promise<T> {
  await mkdir(listDir(list), { recursive: true });
  return withFileLock(listWriteLockPath(list), fn);
}

async function readTaskInList(list: TaskListId, id: string): Promise<HiveTask> {
  const path = taskPath(list, id);
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) throw new Error(`No task ${id} in ${formatListId(list)}`);
  return parseTask(text);
}

async function writeTask(list: TaskListId, task: HiveTask): Promise<void> {
  await atomicWriteFile(taskPath(list, task.id), serializeTask(task), { mode: 0o600 });
}
