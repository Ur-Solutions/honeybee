/**
 * Open InterventionRequest derivation (docs/BEEVIEW_READ_API.md §1, ADR 001).
 *
 * Requests are projected from CURRENT evidence only and re-derived per
 * projection pass, so scope closure is inherent: a turn_end after a
 * needs_input, an auth_resume after a login failure, or a dead runtime
 * naturally closes them — no store, no cancellation records yet. Ids are the
 * durable idempotency keys of the request store (src/requests/keys.ts is the
 * single id source shared with it):
 *
 *   1. unresolved structured needs_input → question/permission, grade
 *      structured, id = the adapter's requestId (or `ni:<bee>:<ts>` when the
 *      adapter sent none), full payload passed through for `hive answer` UIs;
 *   2. pane-detected permission/trust/MCP prompts (readiness.ts predicates) →
 *      permission, grade observer,
 *      id = `obs:<bee>:<gen>:permission:<fingerprint(pane block)>`;
 *   3. auth: the structured login-required failure from events, bounded by
 *      the auth_resume marker, or observer-grade from pane/held state; scope
 *      runtime-generation;
 *   4. wedged/error → a synthesized observer-grade manual-action request
 *      (id `manual:<bee>:<gen>:wedged`) — a recovery condition, not a
 *      lifecycle (design decision 2).
 *
 * Read-only and pure over its sources.
 */

import { createHash } from "node:crypto";
import { isAuthNeededMessage, type HsrEventSnapshot } from "../hsr/observe.js";
import { authRequestId, needsInputRequestId } from "../requests/keys.js";
import type { RunnerEvent } from "../hsr/types.js";
import { isMcpWarningPane, isPermissionPromptPane, isTrustPromptPane } from "../readiness.js";
import type { DerivedState, StateContext } from "../state.js";
import type { SessionRecord } from "../store.js";
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
  now: number;
};

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

  // 1. Unresolved structured needs_input → question/permission, grade
  //    structured, payload passed through so answer UIs need no second read.
  //    The snapshot's pendingNeedsInput is null once a later turn_end resolved
  //    it, so closure is inherent in re-derivation.
  const pending = eventSnapshot?.pendingNeedsInput ?? null;
  if (pending) {
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
  //    fingerprint ids), only when no structured request already covers it.
  if (derived.state === "blocked" && !pending) {
    const paneKey = record.agentPaneId ?? record.tmuxTarget;
    const pane = context.panes?.get(paneKey);
    if (pane && (isPermissionPromptPane(pane) || isTrustPromptPane(pane) || isMcpWarningPane(pane))) {
      requests.push({
        id: `obs:${record.name}:${generation}:permission:${paneFingerprint(pane)}`,
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
        id: `obs:${record.name}:${generation}:permission:held`,
        kind: "permission",
        status: "open",
        scope: "turn",
        grade: "observer",
        question: derived.detail,
        evidence: { grade: "observer", source: "session-record", detail: `blocked without pane evidence this pass (${derived.detail})` },
      });
    }
  }

  // 3. Auth: structured when the events tail carries the login-required
  //    failure and no later auth_resume bounds it; observer-grade from
  //    pane/held state otherwise. Scope: the generation needs re-credentialing.
  if (derived.state === "auth-needed") {
    const authEvent = lastAuthNeededEvent(eventSnapshot?.events ?? []);
    if (authEvent) {
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
    } else {
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
  if (derived.state === "wedged" || derived.state === "error") {
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
