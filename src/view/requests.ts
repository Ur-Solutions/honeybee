/**
 * Open InterventionRequest derivation (docs/BEEVIEW_READ_API.md §1, ADR 001,
 * docs/INTERVENTION_REQUESTS.md) — STORE-FIRST:
 *
 *   1. durable store records with status open and the CURRENT generation
 *      project verbatim (authoritative). This is the improvement over pure
 *      re-derivation: an answered-but-events-trailing needs_input has a
 *      RESOLVED record, so it is NOT open even while the tail still shows
 *      pendingNeedsInput;
 *   2. live structured derivation (unresolved needs_input, unbounded auth)
 *      applies only when NO store record exists under that id — the
 *      daemon-down fallback, byte-identical ids via src/requests/keys.ts;
 *   3. observer-grade derivation is unchanged (never persisted — observer
 *      ids legitimately recur within a generation), suppressed by a same-id
 *      store record or when structured evidence already covers the bee.
 *
 * Live-only sources re-derived per pass:
 *   - pane-detected permission/trust/MCP prompts (readiness.ts predicates) →
 *     permission, grade observer,
 *     id = `obs:<bee>:<gen>:permission:<fingerprint(pane block)>`;
 *   - auth without structured evidence → observer-grade from pane/held state;
 *   - wedged/error → a synthesized observer-grade manual-action request
 *     (id `manual:<bee>:<gen>:wedged`) — a recovery condition, not a
 *     lifecycle (design decision 2).
 *
 * Read-only and pure over its sources — view/* NEVER writes the store.
 */

import { createHash } from "node:crypto";
import { isAuthNeededMessage, type HsrEventSnapshot } from "../hsr/observe.js";
import { authRequestId, needsInputRequestId, stopFailedRequestId } from "../requests/keys.js";
import type { InterventionRequestRecord } from "../requests/store.js";
import type { RunnerEvent } from "../hsr/types.js";
import { isMcpWarningPane, isPermissionPromptPane, isTrustPromptPane } from "../readiness.js";
import type { DerivedState, StateContext } from "../state.js";
import { isPendingSessionRuntimeReplacement, type SessionRecord } from "../store.js";
import type { BeeViewRequest } from "./types.js";

export type OpenRequestSources = {
  record: SessionRecord;
  context: StateContext;
  /** deriveState output for this record over the same context. */
  derived: DerivedState;
  /** record.runtimeGeneration ?? 0. */
  generation: number;
  /** Structured HSR event snapshot, when the run dir was read this pass. */
  eventSnapshot?: HsrEventSnapshot;
  /** Durable request records for this bee, when its store file was read. */
  storedRequests?: InterventionRequestRecord[];
  now: number;
};

/** Map a durable store record verbatim onto the BeeView request shape. */
export function storedRequestView(record: InterventionRequestRecord): BeeViewRequest {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    scope: record.scope,
    grade: record.grade,
    openedAt: record.openedAt,
    ...(record.question !== undefined ? { question: record.question } : {}),
    ...(record.tool !== undefined ? { tool: record.tool } : {}),
    ...(record.options !== undefined ? { options: record.options } : {}),
    ...(record.optionDetails !== undefined ? { optionDetails: record.optionDetails } : {}),
    ...(record.questions !== undefined ? { questions: record.questions } : {}),
    ...(record.multiSelect !== undefined ? { multiSelect: record.multiSelect } : {}),
    ...(record.input !== undefined ? { input: record.input } : {}),
    ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
    ...(record.cancelReason !== undefined ? { cancelReason: record.cancelReason } : {}),
    evidence: record.evidence,
  };
}

/** Stable fingerprint of a pane block, so identical captures share request ids. */
export function paneFingerprint(pane: string): string {
  const block = pane.trimEnd().split("\n").slice(-15).join("\n").trim();
  return createHash("sha256").update(block).digest("hex").slice(0, 12);
}

function isoFromEpochMs(ts: number): string | undefined {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : undefined;
}

/** Last auth-needed signal (error/auth_expired) not yet bounded by auth_resume. */
export function lastAuthNeededEvent(events: RunnerEvent[]): RunnerEvent | undefined {
  let lastAuth: RunnerEvent | undefined;
  let lastAuthIdx = -1;
  let lastResumeIdx = -1;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.type === "auth_resume") lastResumeIdx = i;
    if (event.type === "auth_expired" && event.requiresLogin) {
      lastAuth = event;
      lastAuthIdx = i;
    }
    if (event.type === "error" && isAuthNeededMessage(event.message)) {
      lastAuth = event;
      lastAuthIdx = i;
    }
  }
  return lastAuthIdx > lastResumeIdx ? lastAuth : undefined;
}

export function deriveOpenRequests(sources: OpenRequestSources): BeeViewRequest[] {
  const { record, context, derived, generation, eventSnapshot, now } = sources;
  const requests: BeeViewRequest[] = [];

  // 0. Store records first (authoritative): open + current generation project
  //    verbatim. A record under an id — in ANY status — also suppresses the
  //    live structured derivation of that id below: an answered-but-events-
  //    trailing needs_input is resolved, hence NOT open.
  const stored = sources.storedRequests ?? [];
  const storedIds = new Set(stored.map((request) => request.id));
  const pendingReplacement = isPendingSessionRuntimeReplacement(record);
  const openStored = stored.filter((request) =>
    request.status === "open" &&
    (request.scope === "bee" || request.generation === generation) &&
    !(pendingReplacement && request.id === stopFailedRequestId(record.name, generation)));
  for (const request of openStored) requests.push(storedRequestView(request));
  const storedNeedsReplyOpen = openStored.some((request) => request.kind === "question" || request.kind === "permission");
  const storedAuthOpen = openStored.some((request) => request.kind === "auth");

  // 1. Unresolved structured needs_input → question/permission, grade
  //    structured, payload passed through so answer UIs need no second read.
  //    The snapshot's pendingNeedsInput is null once a later turn_end resolved
  //    it, so closure is inherent in re-derivation. Live fallback only: a
  //    store record under the same id (any status) wins.
  const pending = eventSnapshot?.pendingNeedsInput ?? null;
  // A remote mirror without its exact runner epoch cannot derive the same
  // durable id as the authority. Rely on the store record populated by the
  // token-qualified request sweep instead of fabricating a requestId-only row.
  const pendingHasExactIdentity = !!pending && (record.substrate === "hsr" || !!pending.host);
  if (pending && pendingHasExactIdentity && !storedIds.has(needsInputRequestId(record.name, pending))) {
    const openedAt = isoFromEpochMs(pending.ts);
    requests.push({
      id: needsInputRequestId(record.name, pending),
      kind: pending.kind,
      status: "open",
      scope: "turn",
      grade: "structured",
      ...(openedAt !== undefined ? { openedAt } : {}),
      question: pending.question,
      ...(pending.tool !== undefined ? { tool: pending.tool } : {}),
      ...(pending.options !== undefined ? { options: pending.options } : {}),
      ...(pending.optionDetails !== undefined ? { optionDetails: pending.optionDetails } : {}),
      ...(pending.questions !== undefined ? { questions: pending.questions } : {}),
      ...(pending.multiSelect !== undefined ? { multiSelect: pending.multiSelect } : {}),
      ...(pending.input !== undefined ? { input: pending.input } : {}),
      evidence: { grade: "structured", source: "hsr-events", ...(openedAt !== undefined ? { observedAt: openedAt } : {}), detail: "needs_input" },
    });
  }

  // 2. Pane-detected permission/trust/MCP prompts (observer grade, stable
  //    fingerprint ids), only when no structured request already covers it
  //    (a live pending OR an open store-backed needs-reply record).
  if (derived.state === "blocked" && !pending && !storedNeedsReplyOpen) {
    const paneKey = record.agentPaneId ?? record.tmuxTarget;
    const pane = context.panes?.get(paneKey);
    const observerId = pane && (isPermissionPromptPane(pane) || isTrustPromptPane(pane) || isMcpWarningPane(pane))
      ? `obs:${record.name}:${generation}:permission:${paneFingerprint(pane)}`
      : `obs:${record.name}:${generation}:permission:held`;
    if (!storedIds.has(observerId)) {
      if (pane && (isPermissionPromptPane(pane) || isTrustPromptPane(pane) || isMcpWarningPane(pane))) {
        requests.push({
          id: observerId,
          kind: "permission",
          status: "open",
          scope: "turn",
          grade: "observer",
          question: derived.detail,
          evidence: { grade: "observer", source: "pane-capture", observedAt: new Date(now).toISOString(), detail: derived.detail },
        });
      } else {
        // Blocked without a readable pane this pass (held state, or an HSR
        // structured "blocked" whose needs_input payload was not snapshot).
        requests.push({
          id: observerId,
          kind: "permission",
          status: "open",
          scope: "turn",
          grade: "observer",
          question: derived.detail,
          evidence: { grade: "observer", source: "session-record", detail: `blocked without pane evidence this pass (${derived.detail})` },
        });
      }
    }
  }

  // 3. Auth: structured when the events tail carries the login-required
  //    failure and no later auth_resume bounds it; observer-grade from
  //    pane/held state otherwise. Scope: the generation needs re-credentialing.
  if (derived.state === "auth-needed") {
    const authEvent = lastAuthNeededEvent(eventSnapshot?.events ?? []);
    if (authEvent && !storedIds.has(authRequestId(record.name, authEvent.ts))) {
      const openedAt = isoFromEpochMs(authEvent.ts);
      requests.push({
        id: authRequestId(record.name, authEvent.ts),
        kind: "auth",
        status: "open",
        scope: "runtime-generation",
        grade: "structured",
        ...(openedAt !== undefined ? { openedAt } : {}),
        question: derived.detail,
        evidence: { grade: "structured", source: "hsr-events", ...(openedAt !== undefined ? { observedAt: openedAt } : {}), detail: authEvent.type },
      });
    } else if (!authEvent && !storedAuthOpen && !storedIds.has(`obs:${record.name}:${generation}:auth:held`)) {
      requests.push({
        id: `obs:${record.name}:${generation}:auth:held`,
        kind: "auth",
        status: "open",
        scope: "runtime-generation",
        grade: "observer",
        question: derived.detail,
        evidence: { grade: "observer", source: "session-record", detail: "auth-needed from pane/held state" },
      });
    }
  }

  // 4. wedged/error: a recovery condition, not a lifecycle — synthesize an
  //    observer-grade manual-action request (design decision 2).
  if ((derived.state === "wedged" || derived.state === "error") && !storedIds.has(`manual:${record.name}:${generation}:wedged`)) {
    requests.push({
      id: `manual:${record.name}:${generation}:wedged`,
      kind: "manual-action",
      status: "open",
      scope: "runtime-generation",
      grade: "observer",
      question: derived.detail,
      evidence: { grade: "observer", source: "session-record", detail: derived.detail },
    });
  }

  return requests;
}
