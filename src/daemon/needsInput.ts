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
// Routing state lives in the durable request store (docs/
// INTERVENTION_REQUESTS.md), not in memory: per candidate the dispatcher
// looks the request up under its shared id (requests/keys.ts), skips it
// unless it is OPEN and not yet routed/escalated, routes, then persists
// routedTo/routedAt (or escalated) via markRequestRouted. A relaunched daemon
// therefore reads routedAt from disk — no duplicate routing — and a request
// resolved while the daemon was down is never routed at all. The reconciler
// stage runs immediately before this one and normally owns the open; when the
// record is missing (ordering is a fast path, not correctness) the dispatcher
// opens it itself. `ni:<bee>:<ts>` ids keep unblock-then-reblock requests
// distinct, exactly as the old in-memory "<bee>:<requestId>:<event-ts>" key
// did. Never throws — per-bee errors are captured into the outcome.

import { sendBuzMessage, type BuzSender } from "../buz.js";
import { pendingNeedsInput, type HsrObservation, type PendingNeedsInput } from "../hsr/observe.js";
import { needsInputRequestId } from "../requests/keys.js";
import { markRequestRouted, openRequest, readBeeRequests, type OpenRequestInput } from "../requests/store.js";
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
 * terminal (dead/done/error/kill_failed). An unknown state (parent
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

/** Self-heal open input when the reconciler has not landed the record yet. */
function openInputFor(record: SessionRecord, pending: PendingNeedsInput): OpenRequestInput {
  const openedAt = Number.isFinite(pending.ts) && pending.ts > 0 ? new Date(pending.ts).toISOString() : undefined;
  return {
    id: needsInputRequestId(record.name, pending),
    kind: pending.kind,
    scope: "turn",
    grade: "structured",
    generation: record.runtimeGeneration ?? 0,
    ...(openedAt !== undefined ? { openedAt } : {}),
    question: pending.question,
    ...(pending.tool !== undefined ? { tool: pending.tool } : {}),
    ...(pending.options !== undefined ? { options: pending.options } : {}),
    ...(pending.optionDetails !== undefined ? { optionDetails: pending.optionDetails } : {}),
    ...(pending.questions !== undefined ? { questions: pending.questions } : {}),
    ...(pending.multiSelect !== undefined ? { multiSelect: pending.multiSelect } : {}),
    ...(pending.input !== undefined ? { input: pending.input } : {}),
    evidence: { grade: "structured", source: "hsr-events", ...(openedAt !== undefined ? { observedAt: openedAt } : {}), detail: "needs_input" },
  };
}

/**
 * Build the needs-input dispatcher. Call the returned function once per tick
 * with the tick's records and its freshly-derived state map. Stateless in
 * memory — routing exactly-once is carried by the request store's
 * routedAt/escalated marks, which survive daemon restarts.
 */
export function createNeedsInputDispatcher(): (
  records: SessionRecord[],
  currentStates: Map<string, BeeState>,
  hsrObservations?: ReadonlyMap<string, HsrObservation>,
) => Promise<NeedsInputOutcome[]> {
  return async (records, currentStates, hsrObservations) => {
    const outcomes: NeedsInputOutcome[] = [];
    for (const record of records) {
      if (record.substrate !== "hsr") continue;
      if (currentStates.get(record.name) !== "blocked") continue;
      try {
        const observed = hsrObservations?.get(record.name);
        const pending = observed?.live && observed.eventSnapshot
          ? observed.eventSnapshot.pendingNeedsInput
          : await pendingNeedsInput(record.name);
        if (!pending) continue;

        // Durable routing state under the shared id. The reconciler ran just
        // before this stage; when the record is absent the dispatcher opens
        // it itself (fast path, not correctness).
        const requestId = needsInputRequestId(record.name, pending);
        let request = (await readBeeRequests(record.name)).find((candidate) => candidate.id === requestId);
        if (!request) {
          request = (await openRequest(record.name, openInputFor(record, pending))).record;
        }
        // A request resolved while the daemon was down (hive answer) or
        // cancelled by scope closure is NEVER routed; one already routed or
        // escalated (possibly by a previous daemon run) is not routed again.
        if (request.status !== "open") continue;
        if (request.routedAt !== undefined || request.escalated === true) continue;

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
          await markRequestRouted(record.name, requestId, { routedTo: parent.name });
          outcomes.push({ bee: record.name, requestId: pending.requestId, routedTo: parent.name });
        } else {
          // Parentless or the parent is dead/terminal → escalate to the user.
          await markRequestRouted(record.name, requestId, { escalated: true });
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
