import type { BeeState } from "../state.js";
import type { SealStatus, SealType } from "../seal.js";
import type { BeeContract } from "../contract.js";

export const BEE_VIEW_SCHEMA_VERSION = 1 as const;

/**
 * Evidence grade attached to every projected fact, ordered by trust:
 *   structured — HSR events.jsonl (turn_start/turn_end/needs_input/auth), seals
 *   hook       — agent Stop/Notification hooks via @hive_state (waiting/done)
 *   observer   — pane captures, ring snapshots, pid/session liveness, node probes
 *   legacy     — persisted caches (lastObservedState, SessionRecord.status)
 */
export type EvidenceGrade = "structured" | "hook" | "observer" | "legacy";

export type BeeViewEvidence = {
  grade: EvidenceGrade;
  /** Machine-readable origin, e.g. "hsr-events", "pane-capture",
   *  "hive-state-option", "seal", "session-record", "node-probe",
   *  "hsr-meta", "daemon-observation". */
  source: string;
  /** ISO timestamp of the underlying observation, when the source carries
   *  one. @hive_state notably carries none. */
  observedAt?: string;
  /** Free-text pointer for debugging (event type, filename, matched rule). */
  detail?: string;
};

/** Durable identity + lifecycle (ADR "Bee"). */
export type BeeViewBee = {
  /** Canonical id (record.id ?? name). */
  id: string;
  name: string;
  uuid?: string;
  title?: string;
  agent: string;
  cwd: string;
  colony?: string;
  swarmId?: string;
  tags: string[];
  node: string;               // LOCAL_NODE_NAME when unset
  /**
   * active  — record.status "running" | "dead" | "kill_failed"
   * retired — record.status "done" (filed via retire / quest done)
   * A SEALED but un-filed bee is NOT retired — completion never changes
   * lifecycle (ADR invariant 10). Its seal appears in latestContractResult.
   */
  lifecycle: "active" | "retired";
  createdAt: string;
  updatedAt: string;
  contract?: BeeContract;
  spawnedById?: string;
  taskAttribution?: { runId?: string; flowName?: string };
};

/** Latest runtime incarnation (ADR "RuntimeGeneration", projected). */
export type BeeViewRuntime = {
  /** record.runtimeGeneration ?? 0 — monotonic across revive/promote/demote. */
  generation: number;
  /**
   * starting — booting | queued
   * online   — live target/pane/host-pid confirmed
   * exited   — liveness probe negative
   * unknown  — node unreachable or observation unavailable this pass
   */
  state: "starting" | "online" | "exited" | "unknown";
  substrate: "local-tmux" | "hsr";
  tmuxTarget?: string;
  agentPaneId?: string;
  runnerPid?: number;
  runnerTier?: string;
  providerSessionId?: string;
  /**
   * Only derivable for exited runtimes, from recorded intent:
   *   stopped — record.status "dead"/"done" (a retire/kill was recorded)
   *   crashed — record.status still "running" (exit without stop intent)
   * "clean" (exit-contract completion) is not derivable until Turn ids land.
   */
  exitClass?: "stopped" | "crashed";
  /** kill_failed: the stop failed and the runtime may still be alive. */
  stopFailed?: boolean;
  evidence: BeeViewEvidence;   // what liveness was concluded from
};

/**
 * RESERVED — always undefined in schemaVersion 1. Honeybee has no Turn ids
 * yet (assessment §4 step 5); the field exists so consumers can bind to the
 * shape without a schema bump when Turn stamping lands.
 */
export type BeeViewTurn = {
  id: string;
  state: "queued" | "running";
  acceptedAt?: string;
  boundGeneration?: number;
  evidence: BeeViewEvidence;
};

/**
 * ADR "InterventionRequest". Structured-grade requests come from the durable
 * request store (src/requests/store.ts — authoritative when a record exists);
 * live derivation remains the daemon-down fallback under the SAME ids
 * (src/requests/keys.ts), and observer-grade requests stay live-derived only:
 *   - `id` is the durable idempotency key shared with the store
 *     (structured requestId, or scope+kind+fingerprint for observer grade)
 *   - `status`: openRequests carries "open" only; resolved/cancelled appear
 *     in recentClosedRequests (additive within schemaVersion 1)
 *   - `turnId` stays absent until Turn ids exist.
 */
export type BeeViewRequest = {
  id: string;
  kind: "question" | "permission" | "auth" | "manual-action";
  status: "open" | "resolved" | "cancelled";
  scope: "turn" | "runtime-generation" | "bee";
  grade: "structured" | "observer";
  /** ISO — always present on store-backed requests; observer-grade live
   *  derivation may omit it (projection time is not persisted). */
  openedAt?: string;
  question?: string;
  tool?: string;
  options?: string[];
  /** Pass-through of the structured needs_input payload (hsr/observe.ts
   *  PendingNeedsInput) so `hive answer` UIs need no second read. */
  optionDetails?: unknown;
  questions?: unknown;
  multiSelect?: boolean;
  input?: unknown;
  /** Store-backed resolved requests: "hive-answer[:caller]" | "auth-resume" | "stop-succeeded". */
  resolvedBy?: string;
  /** Store-backed cancelled requests. */
  cancelReason?: "scope-closed" | "superseded";
  turnId?: string;             // absent until Turn ids land
  evidence: BeeViewEvidence;
};

/** ADR "TurnEndEvidence" projection for the latest settled response. */
export type BeeViewTurnResult = {
  /**
   * responded          — structured turn_end (or hook Stop "done")
   * settled-unverified — observer-only pane/ring settling (idle_with_output)
   * interrupted        — runtime exited mid-turn (crashed while running)
   * failed             — runner error event
   * "cancelled" is not derivable in v1 (no cancellation record exists).
   */
  outcome: "responded" | "settled-unverified" | "interrupted" | "failed";
  endedAt?: string;
  turnId?: string;             // absent in v1
  evidence: BeeViewEvidence;
};

/** ADR "ContractResult": latest seal of the CURRENT incarnation
 *  (sealHighWaterFilename-gated). */
export type BeeViewContractResult = {
  verdict: "success" | "failed" | "blocked";  // seal done→success; needs_input→blocked
  sealStatus: SealStatus;
  sealType: SealType;
  sealedAt: string;
  taskId?: string;
  attempt?: number;
  /**
   * true  — seal satisfies the bee's contract correlation keys
   * false — contract demands keys the seal lacks/mismatches (keyless seal:
   *         reviewable artifact, NOT contract completion — ADR rule)
   * undefined — the bee has no contract to correlate against.
   */
  matchesContract?: boolean;
  evidence: BeeViewEvidence;   // grade "structured", source "seal"
};

/**
 * Derived-only summary. Honeybee stores NO inbox dispositions in v1 —
 * read/dismiss/snooze remain Apiary-owned until the InboxItem slice exists.
 */
export type BeeViewInboxSummary = {
  openRequestCounts: { needsReply: number; needsAuth: number; needsAction: number };
  /** latestContractResult or latestTurnResult present on a non-retired bee. */
  hasUnretiredResult: boolean;
  latestResultAt?: string;
};

/** ADR BeeDisplayState precedence, post-rename vocabulary. */
export type BeeDisplayState =
  | "retired"
  | "needs-auth"
  | "needs-reply"
  | "needs-action"
  | "stop-failed"
  | "crashed"
  | "unreachable"
  | "starting"
  | "working"
  | "ready"
  | "offline";

/**
 * Product interaction contract. Consumers should use this three-state field
 * for primary UX and keep displayState/runtime details for diagnostics only.
 * Every non-archived bee accepts messages, including a cold idle runtime.
 */
export type BeeInteractionState = "working" | "idle" | "archived";

export type ObservationSourceFreshness = {
  source: "hsr-events" | "pane-capture" | "hive-state-option"
    | "daemon-observation" | "node-probe";
  status: "fresh" | "stale" | "missing" | "untimed";
  observedAt?: string;
  ageMs?: number;
  /** e.g. "lastObservedStateAt is a fleet-wide sweep stamp; do not use for
   *  turn timing", "HSR observation batch failed this pass — state held",
   *  "@hive_state carries no timestamp". */
  caveat?: string;
};

export type BeeViewObservationFreshness = {
  /** True when this projection pass itself observed live substrate. */
  observedLive: boolean;
  /** The daemon is NOT required; this reports whether its cache was current. */
  sources: ObservationSourceFreshness[];
};

/** Verbatim legacy fields so consumers migrate additively. */
export type BeeViewCompatibilityFields = {
  beeState: BeeState;              // deriveState output, post-rename vocabulary
  beeStateDetail: string;
  sessionStatus: "running" | "dead" | "kill_failed" | "done";
  hiveStateOption?: string;        // raw @hive_state
  effectiveHiveState?: string;     // hiveState.ts effectiveHiveState()
  lastObservedState?: string;      // persisted daemon cache, unnormalized
  lastObservedStateAt?: string;
};

export type BeeViewV1 = {
  schemaVersion: typeof BEE_VIEW_SCHEMA_VERSION;
  bee: BeeViewBee;
  latestRuntime: BeeViewRuntime;
  currentTurn?: BeeViewTurn;                    // always undefined in v1
  openRequests: BeeViewRequest[];
  /**
   * Newest-first resolved/cancelled requests from the durable store (capped
   * at 5). Absent when the bee has no stored request history. Additive
   * within schemaVersion 1.
   */
  recentClosedRequests?: BeeViewRequest[];
  latestTurnResult?: BeeViewTurnResult;
  latestContractResult?: BeeViewContractResult;
  inboxSummary: BeeViewInboxSummary;
  interactionState: BeeInteractionState;
  displayState: BeeDisplayState;
  /** The precedence rule that produced displayState (for `state explain`). */
  displayStateReason: string;
  observationFreshness: BeeViewObservationFreshness;
  lastProjectedAt: string;
  compatibilityFields: BeeViewCompatibilityFields;
};

export type BeeViewListV1 = {
  schemaVersion: typeof BEE_VIEW_SCHEMA_VERSION;
  generatedAt: string;
  node: string;
  unreachableNodes: string[];
  bees: BeeViewV1[];
};
