// Flight Controller types (CL.701 §4.2): a flight is a MAINTAINED capacity
// invariant — "keep N slots productive with this model mix under this
// completion contract" — where a swarm is only a spawn-time cohort. Slots hold
// leases with evidence-driven deadlines; every judgment call (what to do with
// an escalated slot, whether to substitute a mix) is escalated OUT — the
// controller is deliberately mechanical and spends zero LLM tokens while
// healthy.
import { activationKey } from "../activation.js";
import type { SealStatus, SealType } from "../seal.js";
import { safeName } from "../store.js";

export type FlightMixEntry = {
  /** Mix key referenced by slots ("fable", "codex"). */
  key: string;
  /** Harness kind for spawnBee ("claude", "codex", …). */
  agent: string;
  /** How many of the flight's slots draw from this mix. */
  count: number;
  model?: string;
  /** Account query for spawn ("auto", "rr", or an account id). */
  account?: string;
};

export type FlightContractSpec = {
  /** Slot completion evidence: seal (default) or exit for harnesses that cannot seal. */
  completion: "seal" | "exit";
  sealType?: SealType;
  /** provisioning/booting older than this without a live turn → wedged. */
  readinessDeadlineMs: number;
  /** A slot that never produced activity within this of its lease start → stalled. */
  firstEvidenceDeadlineMs: number;
  /** No activity AND no seal for this long → stalled (violation, never done). */
  stallMs: number;
  /** Attempts (spawns) per slot before the slot is abandoned + escalated. */
  maxAttemptsPerSlot: number;
};

export type FlightReplacementSpec = {
  policy: "replace-before-collect";
  /** Backpressure valve: concurrent provisioning/booting slots per flight. */
  maxConcurrentBoots: number;
};

export type FlightStatus = "active" | "draining" | "closed";

export type FlightRecord = {
  /** "FL.<suffix>" */
  id: string;
  name: string;
  colony?: string;
  /** Orchestrator bee id, stamped as spawnedById on slot bees. */
  createdBy?: string;
  cwd: string;
  /** Brief template delivered to every slot bee (contract postscript appended). */
  brief?: string;
  target: { slots: number; mix: FlightMixEntry[] };
  contract: FlightContractSpec;
  replacement: FlightReplacementSpec;
  status: FlightStatus;
  createdAt: string;
  updatedAt: string;
};

export const SLOT_STATES = [
  "vacant",
  "provisioning",
  "booting",
  "working",
  "stalled",
  "blocked",
  "done",
  "escalated",
  "abandoned",
] as const;

export type SlotState = (typeof SLOT_STATES)[number];

/** States that count against the replacement backpressure valve. */
export const SLOT_BOOTING_STATES: readonly SlotState[] = ["provisioning", "booting"];

/** Terminal slot states — the controller stops driving them. */
export const SLOT_TERMINAL_STATES: readonly SlotState[] = ["done", "abandoned"];

export type SlotHistoryEntry = {
  attempt: number;
  beeName?: string;
  outcome: string;
  at: string;
};

export type SlotRecord = {
  flightId: string;
  /** "s1".."sN" */
  slotId: string;
  mixKey: string;
  /** 0 = never spawned; incremented DURABLY before each spawn executes. */
  attempt: number;
  beeName?: string;
  beeId?: string;
  state: SlotState;
  /** ISO of the last state change (the lease clock). */
  since: string;
  /**
   * ISO of the moment the CURRENT attempt was durably claimed (right before
   * its spawn executed). All evidence is scoped to it: a seal recorded before
   * attemptStartedAt belongs to a previous attempt and can never satisfy this
   * one (the activation rule from CL.701 §4.2).
   */
  attemptStartedAt?: string;
  evidence: {
    /** First observed activity (an in-flight turn) for the CURRENT attempt. */
    firstEvidenceAt?: string;
    /** Last observed activity/state change for the current attempt. */
    lastActivityAt?: string;
    /** Seal filename that satisfied (or mismatched) the contract. */
    sealFilename?: string;
  };
  /**
   * `${flightId}:${slotId}:${attempt}` — persisted BEFORE the spawn for that
   * attempt executes (prepare → execute → confirm), so a controller crash
   * mid-replacement can never double-spawn an attempt.
   */
  idempotencyKey?: string;
  /** Set when the deterministic stall nudge has been sent for this attempt. */
  nudgedAt?: string;
  history: SlotHistoryEntry[];
};

export function slotTaskId(flightId: string, slotId: string): string {
  return `${flightId}/${slotId}`;
}

/**
 * Deterministic bee name for a slot attempt. Deliberately a pure function of
 * (flight ID, slot, attempt): after a controller crash between spawn and
 * confirm, the next sweep re-derives this name and ADOPTS the already-spawned
 * bee instead of double-spawning the attempt. Keyed on the unique flight ID —
 * flight NAMES can repeat (review CR-4), and a name collision would overwrite
 * another flight's session records and mis-adopt its bees.
 */
export function slotBeeName(flightId: string, slotId: string, attempt: number): string {
  // safeName matches what spawnBee persists, so crash-recovery adoption looks
  // up exactly the name the spawn actually registered.
  return safeName(`${flightId}-${slotId}-a${attempt}`);
}

export function slotIdempotencyKey(flightId: string, slotId: string, attempt: number): string {
  return activationKey(flightId, slotId, attempt);
}

export const FLIGHT_CONTRACT_DEFAULTS: FlightContractSpec = {
  completion: "seal",
  readinessDeadlineMs: 5 * 60_000,
  firstEvidenceDeadlineMs: 4 * 60_000,
  stallMs: 10 * 60_000,
  maxAttemptsPerSlot: 3,
};

export const FLIGHT_REPLACEMENT_DEFAULTS: FlightReplacementSpec = {
  policy: "replace-before-collect",
  maxConcurrentBoots: 3,
};

/** A seal observation scoped for contract matching (subset of SealRecord). */
export type SlotSealObservation = {
  filename: string;
  sealedAt: string;
  status: SealStatus;
  /** The seal's declared type — checked against the contract's sealType. */
  type?: string;
  taskId?: string;
  attempt?: number;
};
