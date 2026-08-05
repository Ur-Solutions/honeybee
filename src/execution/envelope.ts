// Common validation for the per-run effect envelopes (run.command, run.cancel,
// run.collect, run.retain, run.release — RFC §7). Everything that must fail
// BEFORE any durable effect, in corpus terms and fail-closed order: envelope
// schema -> protocol version -> body schema -> digest -> signature -> owner
// scope -> authority epoch. Run-bound checks (workspace, capability lease,
// lease expiry) live in assertRunBinding/assertLeaseNotExpired because they
// need the reservation.
import { canonicalDigest } from "../comb/canonical.js";
import type { JsonValue } from "../comb/types.js";
import type { ExecutionValidator, JsonObject } from "./contract.js";
import { executionError } from "./errors.js";
import type { ExecutionBindingRecord } from "./nodeState.js";
import { verifyCanonicalSignature, type SignatureVerifier } from "./signing.js";
import type { RunReservation } from "./runStore.js";

export type ValidatedOperationEnvelope = {
  envelope: JsonObject;
  authority: JsonObject;
  body: JsonObject;
  runId: string;
  effectKey: string;
  requestDigest: string;
};

export type OperationEnvelopeDeps = {
  validator: ExecutionValidator;
  binding: ExecutionBindingRecord;
  protocolVersion: string;
  /** Body schema name for the method (e.g. "run-cancel-body"). */
  bodySchema: string;
  method: string;
  verifySignature?: SignatureVerifier;
};

export function validateOperationEnvelope(request: JsonValue, deps: OperationEnvelopeDeps): ValidatedOperationEnvelope {
  const { validator, binding } = deps;
  const verify = deps.verifySignature ?? verifyCanonicalSignature;

  const envelopeCheck = validator.validate("execution-request-envelope", request);
  if (!envelopeCheck.valid) {
    throw executionError("SCHEMA_UNSUPPORTED", `invalid ${deps.method} envelope: ${envelopeCheck.errors.join("; ")}`);
  }
  const envelope = request as JsonObject;
  if (envelope.protocolVersion !== deps.protocolVersion) {
    throw executionError(
      "PROTOCOL_INCOMPATIBLE",
      `protocolVersion ${String(envelope.protocolVersion)} is not the negotiated ${deps.protocolVersion}`,
    );
  }
  const bodyCheck = validator.validate(deps.bodySchema, envelope.body);
  if (!bodyCheck.valid) {
    throw executionError("SCHEMA_UNSUPPORTED", `invalid ${deps.method} body: ${bodyCheck.errors.join("; ")}`);
  }
  const body = envelope.body as JsonObject;

  const digest = canonicalDigest(envelope.body as JsonValue);
  if (envelope.requestDigest !== digest) {
    throw executionError("SCHEMA_UNSUPPORTED", "requestDigest is not the canonical digest of body");
  }
  if (!verify(binding.authorityPublicKey, envelope as Record<string, JsonValue>)) {
    throw executionError("LEASE_DENIED", "envelope signature does not verify against the bound authority key");
  }

  const authority = envelope.authority as JsonObject;
  if (authority.ownerScopeId !== binding.ownerScopeId) {
    throw executionError("BINDING_DENIED", `owner scope ${String(authority.ownerScopeId)} is not bound on this node`);
  }
  if (authority.authorityEpoch !== binding.binding.authorityEpoch) {
    throw executionError(
      "BINDING_DENIED",
      `authority epoch ${String(authority.authorityEpoch)} is stale for the installed binding`,
    );
  }

  return {
    envelope,
    authority,
    body,
    runId: String(body.runId),
    effectKey: String(envelope.effectKey),
    requestDigest: digest,
  };
}

/**
 * The envelope's authority claims must name exactly the Run's admitted scope:
 * owner scope, workspace, and (when the reservation recorded one) the same
 * parent capability lease. A caller from another workspace or under a
 * different capability lease cannot steer or clean up this Run.
 */
export function assertRunBinding(reservation: RunReservation, authority: JsonObject): void {
  if (authority.ownerScopeId !== reservation.ownerScopeId) {
    throw executionError("BINDING_DENIED", `owner scope ${String(authority.ownerScopeId)} does not own run ${reservation.runId}`);
  }
  if (authority.workspaceId !== reservation.workspaceId) {
    throw executionError("LEASE_DENIED", `workspace ${String(authority.workspaceId)} does not match the run's admitted workspace`);
  }
  if (authority.capabilityLeaseId !== reservation.capabilityLeaseId) {
    throw executionError("LEASE_DENIED", "authority capabilityLeaseId does not match the run's admitted capability lease");
  }
}

/**
 * Steering (run.command) is new external mutation and dies with the execution
 * lease. Evidence collection and cleanup (cancel/collect/retain/release)
 * deliberately do NOT call this — an expired lease may permit evidence
 * collection and cleanup, never new external mutation (RFC §18).
 */
export function assertLeaseNotExpired(reservation: RunReservation, now: Date): void {
  const expiresAt = Date.parse(reservation.leaseExpiresAt);
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
    throw executionError("LEASE_DENIED", "execution lease has expired; steering commands are no longer authorized");
  }
}
