// Task supply dispatcher (epic: agent task lists, apiary docs/epics/).
//
// Runs right after the buz queue dispatcher on the SAME idle_with_output
// observation: for each bee currently idle, IF this tick's drain delivered
// nothing and the queue is empty, evaluate the six-condition supply gate
// (tasks/supply.ts, pure) and feed the top eligible task — ONE queue-tier
// buz message per feed, normal buz machinery from there. Also flags fed
// tasks the bee idled past without closing as stalled (one grace tick).
//
// Stateful across ticks within a daemon run: an internal map counts, per fed
// task, the idle observations the bee completed with the task still open.
// The FIRST such observation is the grace tick; the second marks the task
// stalled (task.stalled ledger row — Apiary reads the store, no notification
// machinery here). Ticks where the drain delivered, or where the queue is
// non-empty (the carrying message not yet pasted), never count.
//
// Never throws — per-bee errors are captured into the outcomes.

import { readdir } from "node:fs/promises";
import { beeMailboxDir } from "../buz.js";
import type { BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";
import {
  evaluateSupplyGate,
  listTasks,
  markTaskStalled,
  resolveTaskSupply,
  taskInFlight,
  type HiveTask,
  type TaskListId,
} from "../tasks.js";
import { feedTaskToBee } from "../tasks/supply.js";
import type { BuzDispatchOutcome } from "./buzDispatcher.js";

export type TaskSupplyOutcome = {
  bee: string;
  action: "fed" | "stalled" | "error";
  taskId?: string;
  buzMessageId?: string;
  /** Consecutive-feed counter after a feed. */
  feeds?: number;
  /** This feed reached the breaker limit; supply is now paused. */
  breakerTripped?: boolean;
  error?: string;
};

export type TaskSupplyDeps = {
  /** Injectable for tests. Defaults to the real store reads/mutations. */
  listTasksForBee?: (list: TaskListId) => Promise<HiveTask[]>;
  hasQueuedMessages?: (record: SessionRecord) => Promise<boolean>;
  feed?: typeof feedTaskToBee;
  markStalled?: (list: TaskListId, id: string, now: () => number) => Promise<HiveTask | null>;
  now?: () => number;
};

/** Idle observations (queue empty, nothing delivered) before a fed task stalls. */
const STALL_OPEN_IDLE_TICKS = 2;

/**
 * Build the stateful per-tick supply dispatcher. Call the returned function
 * once per tick with the tick's records, its freshly-derived state map, and
 * the buz dispatcher's outcomes (registry order guarantees they ran first).
 */
export function createTaskSupplyDispatcher(deps: TaskSupplyDeps = {}): (
  records: SessionRecord[],
  currentStates: Map<string, BeeState>,
  buzDrains: BuzDispatchOutcome[],
) => Promise<TaskSupplyOutcome[]> {
  const listTasksForBee = deps.listTasksForBee ?? ((list: TaskListId) => listTasks(list));
  const hasQueuedMessages = deps.hasQueuedMessages ?? defaultHasQueuedMessages;
  const feed = deps.feed ?? feedTaskToBee;
  const markStalled = deps.markStalled ?? ((list: TaskListId, id: string, now: () => number) => markTaskStalled(list, id, now));
  const now = deps.now ?? (() => Date.now());

  // Persists across ticks for the life of the daemon run: task id → completed
  // open-idle observations. Entries are dropped once the task closes or
  // stalls; a daemon restart merely re-grants the grace tick.
  const openIdleTicks = new Map<string, number>();

  return async (records, currentStates, buzDrains) => {
    const deliveredTo = new Set<string>();
    for (const outcome of buzDrains) {
      if (outcome.result.delivered.length > 0) deliveredTo.add(outcome.recipient);
    }

    const outcomes: TaskSupplyOutcome[] = [];
    for (const record of records) {
      const state = currentStates.get(record.name);
      if (state !== "idle_with_output") continue;
      // A delivery this tick started a new turn — the idle observation is
      // already consumed; both stall counting and feeding wait for the next.
      if (deliveredTo.has(record.name)) continue;

      try {
        const supply = resolveTaskSupply(record);
        const list: TaskListId = { kind: "bee", name: record.name };
        const tasks = await listTasksForBee(list);
        if (tasks.length === 0 && !supply.on) continue;

        // Reconcile the stall counters: closed/stalled tasks stop counting.
        for (const task of tasks) {
          if (task.stalledAt || !taskInFlight(task)) openIdleTicks.delete(task.id);
        }

        const queueEmpty = !(await hasQueuedMessages(record));

        // Stalled handling: an auto-fed open task, queue empty (the carrying
        // message was consumed), and the bee just completed another idle tick
        // without closing it. First observation = grace; second = stalled.
        if (queueEmpty) {
          for (const task of tasks) {
            if (!task.fedAt || task.stalledAt || !taskInFlight(task)) continue;
            const ticks = (openIdleTicks.get(task.id) ?? 0) + 1;
            if (ticks >= STALL_OPEN_IDLE_TICKS) {
              openIdleTicks.delete(task.id);
              const stalled = await markStalled(list, task.id, now);
              if (stalled) outcomes.push({ bee: record.name, action: "stalled", taskId: task.id });
            } else {
              openIdleTicks.set(task.id, ticks);
            }
          }
        }

        const decision = evaluateSupplyGate({
          supply,
          needsInput: state !== "idle_with_output", // explicit; always false here by the trigger
          buzQueueEmpty: queueEmpty,
          tasks,
        });
        if (!decision.feed) continue;

        const result = await feed(record, list, decision.feed, tasks, now);
        if (!result) continue; // task raced away between snapshot and lock
        if (result.error) {
          outcomes.push({ bee: record.name, action: "error", taskId: result.taskId, error: result.error });
        } else {
          outcomes.push({
            bee: record.name,
            action: "fed",
            taskId: result.taskId,
            ...(result.buzMessageId ? { buzMessageId: result.buzMessageId } : {}),
            feeds: result.feeds,
            ...(result.breakerTripped ? { breakerTripped: true } : {}),
          });
        }
      } catch (error) {
        outcomes.push({
          bee: record.name,
          action: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcomes;
  };
}

async function defaultHasQueuedMessages(record: SessionRecord): Promise<boolean> {
  const entries = await readdir(beeMailboxDir(record.name, "queue")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [] as string[];
    throw error;
  });
  return entries.some((name) => name.endsWith(".md"));
}
