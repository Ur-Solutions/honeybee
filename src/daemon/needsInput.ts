// HSR needs-input → parent-buz router (APIA-79).
//
// When an HSR bee emits a structured needs_input (permission/question) and
// blocks, the orchestrator — not the user — should answer it. This dispatcher
// implements Apiary's "suppress orchestrated children" rule at the source
// (HSR_EXPLORATION.md §5, needs-input routing):
//
//   - A blocked HSR bee with a LIVING parent → deliver the request as an
//     interrupt-tier buz to that parent (its job to steer). The parent answers
//     with `hive answer <bee> <text>`.
//   - Parentless, or the parent is dead/terminal → escalate to the user. v1
//     escalation is best-effort: the bee is already surfaced as `blocked` in
//     `hive bees`; we just record the escalation outcome (the caller logs it).
//     Desktop notifications / Apiary "Needs-me" are a later UI concern.
//
// Stateful across ticks within a daemon run: an internal Set de-dupes on
// "<bee>:<requestId>:<event-ts>" so each needs_input is routed ONCE, not
// re-buzzed every tick while the bee stays blocked. The event timestamp keeps
// id-less adapter requests distinct after the bee unblocks and blocks again.
// Never throws — per-bee errors are captured into the outcome.

import { sendBuzMessage, type BuzSender } from "../buz.js";
import { pendingNeedsInput, type PendingNeedsInput } from "../hsr/observe.js";
import { isTerminalState, type BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";

export type NeedsInputOutcome = {
  bee: string;
  requestId: string;
  routedTo?: string;
  escalated?: boolean;
  skipped?: string;
  error?: string;
};

/**
 * A parent is "alive" when its freshly-observed state exists and is not
 * terminal (dead/sealed/archived/error/kill_failed). An unknown state (parent
 * not in this tick's observed map) is treated as not-alive → escalate, so a
 * request is never routed into a void.
 */
function parentIsAlive(parent: SessionRecord, currentStates: Map<string, BeeState>): boolean {
  const state = currentStates.get(parent.name);
  if (state === undefined) return false;
  return !isTerminalState(state);
}

/** The buz body the parent (orchestrator) receives: who, what, and how to answer. */
function formatBody(bee: string, pending: PendingNeedsInput): string {
  const lines = [
    `Child bee "${bee}" is blocked awaiting input (${pending.kind}).`,
    `Question: ${pending.question}`,
  ];
  if (pending.tool) lines.push(`Tool: ${pending.tool}`);
  if (pending.options && pending.options.length > 0) lines.push(`Options: ${pending.options.join(", ")}`);
  lines.push(`Answer with: hive answer ${bee} <text>`);
  return lines.join("\n");
}

function dedupeKey(bee: string, pending: PendingNeedsInput): string {
  return `${bee}:${pending.requestId}:${pending.ts}`;
}

/**
 * Build the stateful per-tick needs-input dispatcher. Call the returned function
 * once per tick with the tick's records and its freshly-derived state map.
 */
export function createNeedsInputDispatcher(): (
  records: SessionRecord[],
  currentStates: Map<string, BeeState>,
) => Promise<NeedsInputOutcome[]> {
  // Persists across ticks for the life of the daemon run so each needs_input is
  // routed exactly once.
  const handled = new Set<string>();

  return async (records, currentStates) => {
    const outcomes: NeedsInputOutcome[] = [];
    for (const record of records) {
      if (record.substrate !== "hsr") continue;
      if (currentStates.get(record.name) !== "blocked") continue;
      try {
        const pending = await pendingNeedsInput(record.name);
        if (!pending) continue;
        const key = dedupeKey(record.name, pending);
        if (handled.has(key)) continue;

        // parentId is a bee id; tolerate a name for older/loose records.
        const parent = record.parentId
          ? records.find((r) => r.id === record.parentId) ?? records.find((r) => r.name === record.parentId)
          : undefined;

        if (parent && parentIsAlive(parent, currentStates)) {
          const sender: BuzSender = { kind: "bee", id: record.id ?? record.name };
          await sendBuzMessage({
            recipient: parent,
            sender,
            tier: "interrupt",
            subject: "needs input",
            body: formatBody(record.name, pending),
          });
          handled.add(key);
          outcomes.push({ bee: record.name, requestId: pending.requestId, routedTo: parent.name });
        } else {
          // Parentless or the parent is dead/terminal → escalate to the user.
          handled.add(key);
          outcomes.push({ bee: record.name, requestId: pending.requestId, escalated: true });
        }
      } catch (error) {
        outcomes.push({
          bee: record.name,
          requestId: "pending",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcomes;
  };
}
