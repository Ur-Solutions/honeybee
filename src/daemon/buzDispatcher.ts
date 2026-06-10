// Buz queue dispatcher (tier-B drain).
//
// The daemon's only Phase 2 dispatcher: every tick, any bee whose CURRENT
// observed state is idle_with_output and whose queue/ mailbox is non-empty
// gets drained — each message is pasted into the tmux pane via the
// recipient's substrate and the file moved to inbox/ on success.
//
// Triggering on the current state (not just the active->idle_with_output
// transition) matters: a message queued while the recipient is ALREADY idle
// must not wait for the bee to become active again, and after a daemon
// restart the first observation (from === undefined) must still drain idle
// bees with queued messages.
//
// Drain behavior is implemented in buz.processQueueForBee. This module is
// the thin daemon seam: it selects the bees to drain, resolves substrates
// from the daemon substrate cache (substrateFor), and calls
// processQueueForBee with stopOnFirstFailure so a broken substrate cannot
// burn through every queued message in a single tick.
//
// Per-bee locking is enforced inside processQueueForBee (withFileLock on
// senderLockPath), so racing drains for the same bee serialize safely.

import { readdir } from "node:fs/promises";
import { beeMailboxDir, processQueueForBee, type DrainResult } from "../buz.js";
import type { SessionRecord } from "../store.js";
import { substrateFor, type Substrate } from "../substrates/index.js";
import type { TickTransition } from "./run.js";

export type BuzDispatchTrigger = {
  record: SessionRecord;
  /** The transition that accompanied this tick's observation, if any. */
  transition?: TickTransition;
};

export type BuzDispatchOutcome = {
  recipient: string;
  result: DrainResult;
};

export type BuzDispatchDeps = {
  /**
   * Resolve a substrate for the given session record. Defaults to
   * substrateFor (the daemon-shared substrate cache). Injectable for tests.
   */
  resolveSubstrate?: (record: SessionRecord) => Substrate;
  /**
   * Run a single drain. Defaults to processQueueForBee. Injectable for
   * tests that want to observe drain inputs without exercising the buz
   * storage layer.
   */
  drain?: typeof processQueueForBee;
  /**
   * Probe whether a bee has queued messages. Defaults to a readdir on the
   * bee's queue/ mailbox. Injectable for tests.
   */
  hasQueuedMessages?: (record: SessionRecord) => Promise<boolean>;
};

/**
 * Select the bees whose queue/ should be drained this tick: every record
 * whose CURRENT observed state is idle_with_output and whose queue/ mailbox
 * is non-empty.
 *
 * The current state is the transition target when the bee transitioned this
 * tick (including first observations, where from === undefined), otherwise
 * the lastObservedState persisted by the previous tick. The non-empty-queue
 * check keeps the steady state cheap: one readdir per idle bee per tick,
 * and only bees with pending messages take the per-bee drain lock.
 */
export async function selectBuzDispatchTriggers(
  records: SessionRecord[],
  transitions: TickTransition[],
  hasQueuedMessages: (record: SessionRecord) => Promise<boolean> = defaultHasQueuedMessages,
): Promise<BuzDispatchTrigger[]> {
  const byName = new Map<string, TickTransition>();
  for (const transition of transitions) byName.set(transition.name, transition);
  const triggers: BuzDispatchTrigger[] = [];
  for (const record of records) {
    const transition = byName.get(record.name);
    const current = transition ? transition.to : record.lastObservedState;
    if (current !== "idle_with_output") continue;
    if (!(await hasQueuedMessages(record))) continue;
    triggers.push({ record, ...(transition ? { transition } : {}) });
  }
  return triggers;
}

async function defaultHasQueuedMessages(record: SessionRecord): Promise<boolean> {
  const entries = await readdir(beeMailboxDir(record.name, "queue")).catch(() => [] as string[]);
  return entries.some((name) => name.endsWith(".md"));
}

/**
 * Drain queue/ for every bee currently observed idle_with_output with
 * queued messages. Errors from a single drain do not abort the dispatcher —
 * each bee's drain runs independently and any thrown error is captured into
 * the returned outcomes (via a synthetic empty DrainResult with errors[]).
 */
export async function dispatchBuzDrains(
  records: SessionRecord[],
  transitions: TickTransition[],
  deps: BuzDispatchDeps = {},
): Promise<BuzDispatchOutcome[]> {
  const triggers = await selectBuzDispatchTriggers(records, transitions, deps.hasQueuedMessages);
  if (triggers.length === 0) return [];

  const resolveSubstrate = deps.resolveSubstrate ?? substrateFor;
  const drain = deps.drain ?? processQueueForBee;

  const outcomes: BuzDispatchOutcome[] = [];
  for (const trigger of triggers) {
    const { record } = trigger;
    try {
      const substrate = resolveSubstrate(record);
      const result = await drain(record, {
        transport: { substrate, tmuxTarget: record.tmuxTarget },
        stopOnFirstFailure: true,
      });
      outcomes.push({ recipient: record.name, result });
    } catch (error) {
      outcomes.push({
        recipient: record.name,
        result: {
          delivered: [],
          quarantined: [],
          errors: [{ id: record.name, message: error instanceof Error ? error.message : String(error) }],
        },
      });
    }
  }
  return outcomes;
}
