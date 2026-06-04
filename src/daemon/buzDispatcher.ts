// Buz queue dispatcher (tier-B drain).
//
// The daemon's only Phase 2 dispatcher: when a bee transitions into
// idle_with_output the dispatcher drains the bee's queue/ mailbox, pasting
// each message into the tmux pane via the recipient's substrate and moving
// the file to inbox/ on success.
//
// Drain behavior is implemented in buz.processQueueForBee. This module is
// the thin daemon seam: it filters transitions, resolves substrates from
// the daemon substrate cache (substrateFor), and calls processQueueForBee
// with stopOnFirstFailure so a broken substrate cannot burn through every
// queued message in a single tick.
//
// Per-bee locking is enforced inside processQueueForBee (withFileLock on
// senderLockPath), so racing drains for the same bee serialize safely.

import { processQueueForBee, type DrainResult } from "../buz.js";
import type { SessionRecord } from "../store.js";
import { substrateFor, type Substrate } from "../substrates/index.js";
import type { TickTransition } from "./run.js";

export type BuzDispatchTrigger = {
  record: SessionRecord;
  transition: TickTransition;
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
};

/**
 * Filter the tick transitions to those that should trigger a queue drain
 * (any prev !== idle_with_output && next === idle_with_output) and pair
 * each with its matching SessionRecord.
 *
 * The first-observation case (from === undefined) is intentionally
 * excluded — we don't have evidence that the bee actually transitioned;
 * waiting one more tick costs ~2s and avoids spurious drains right after
 * daemon start.
 */
export function selectBuzDispatchTriggers(
  records: SessionRecord[],
  transitions: TickTransition[],
): BuzDispatchTrigger[] {
  const byName = new Map<string, SessionRecord>();
  for (const record of records) byName.set(record.name, record);
  const triggers: BuzDispatchTrigger[] = [];
  for (const transition of transitions) {
    if (transition.to !== "idle_with_output") continue;
    if (transition.from === undefined) continue;
    const record = byName.get(transition.name);
    if (!record) continue;
    triggers.push({ record, transition });
  }
  return triggers;
}

/**
 * Drain queue/ for every bee that transitioned into idle_with_output.
 * Errors from a single drain do not abort the dispatcher — each bee's
 * drain runs independently and any thrown error is captured into the
 * returned outcomes (via a synthetic empty DrainResult with errors[]).
 */
export async function dispatchBuzDrains(
  records: SessionRecord[],
  transitions: TickTransition[],
  deps: BuzDispatchDeps = {},
): Promise<BuzDispatchOutcome[]> {
  const triggers = selectBuzDispatchTriggers(records, transitions);
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
