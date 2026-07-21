// The activation rule, claimant-generic (Apiary combs-concept §6.1). A flight
// slot today and a comb-run node activation next both follow the same
// discipline: an ATTEMPT is durably claimed (prepare) before its side effect
// executes (execute) and its outcome is recorded (confirm), and all completion
// evidence is scoped to the claim — evidence recorded before the attempt
// started is "none" (a previous activation's leftovers), evidence carrying
// correlation keys that disagree with the claim is a "mismatch" (escalate,
// never complete), and only agreeing, attempt-fresh evidence is a "match".
// Quiet (idle without evidence) is a stall, never completion — that judgment
// lives in the claimant's state machine, not here.
//
// This module deliberately holds only the pure, shared kernel: the claim
// shape, the idempotency key, and the evidence verdict. Claimant-specific
// state machines (flight/machine.ts today, the comb-run engine next) build on
// it without inheriting each other's vocabulary.

export type ActivationClaim = {
  /** Correlation key the evidence must carry verbatim (e.g. "FL.x/s3"). */
  taskId: string;
  /** 1-based attempt number of the current activation. */
  attempt: number;
  /**
   * ISO timestamp of the durable claim — written BEFORE the attempt's side
   * effect executes. Evidence recorded earlier belongs to a previous attempt
   * and can never satisfy this one. Absent on legacy records → no time
   * scoping (correlation keys still apply).
   */
  attemptStartedAt?: string;
};

/** The evidence fields the verdict inspects (a seal, a node result, …). */
export type ActivationEvidence = {
  /** ISO timestamp the evidence was recorded. */
  recordedAt: string;
  /** Correlation key carried by the evidence, when it carries one. */
  taskId?: string;
  /** Attempt number carried by the evidence, when it carries one. */
  attempt?: number;
};

export type ActivationEvidenceVerdict = "none" | "match" | "mismatch";

export type JudgeActivationOptions = {
  /**
   * Demand that the evidence CARRIES the correlation keys, not merely that it
   * doesn't contradict them. Enforcing claimants (flight seal contracts) set
   * this: a keyless artifact then reads as "none" — it never completes the
   * activation, and the claimant's stall machinery re-instructs the worker —
   * instead of a lenient "match" that would let any fresh generic artifact
   * complete any activation (review finding CR-2).
   */
  requireKeys?: boolean;
};

/**
 * Idempotency key for one activation attempt: `${scope}:${claimant}:${n}`
 * (flight: `FL.x:s3:2`; comb run: `<runId>:<nodeId>:<n>`). Persisted with the
 * claim so a crash between prepare and confirm can never double-execute.
 */
export function activationKey(scopeId: string, claimantId: string, attempt: number): string {
  return `${scopeId}:${claimantId}:${attempt}`;
}

/**
 * Judge evidence against a claim. "none" = ignore (stale, absent, or —
 * under requireKeys — keyless); "mismatch" = the evidence is fresh but claims
 * a different task/attempt — surface it, never complete on it; "match" =
 * attempt-fresh and agreeing on the correlation keys (all carried keys
 * agree; with requireKeys, both keys must be carried).
 */
export function judgeActivationEvidence(
  claim: ActivationClaim,
  evidence: ActivationEvidence | null | undefined,
  options: JudgeActivationOptions = {},
): ActivationEvidenceVerdict {
  if (!evidence) return "none";
  if (claim.attemptStartedAt && evidence.recordedAt < claim.attemptStartedAt) return "none";
  if (evidence.taskId !== undefined && evidence.taskId !== claim.taskId) return "mismatch";
  if (evidence.attempt !== undefined && evidence.attempt !== claim.attempt) return "mismatch";
  if (options.requireKeys && (evidence.taskId === undefined || evidence.attempt === undefined)) return "none";
  return "match";
}
