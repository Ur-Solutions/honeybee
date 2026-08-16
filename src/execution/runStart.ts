// run.start request validation (RFC §7, §10.3 step 1): everything that must
// fail BEFORE the durable reservation, in corpus terms. Pure functions over
// the wire envelope; no filesystem access. Order matters and is fail-closed:
// schema -> digest -> binding -> lease -> snapshot -> harness -> provider ->
// capabilities. The first violation throws its typed error and nothing else
// runs.
import { canonicalDigest } from "../comb/canonical.js";
import type { JsonValue } from "../comb/types.js";
import type { ExecutionValidator, JsonObject } from "./contract.js";
import { executionError } from "./errors.js";
import { hasExactLocalGithubSessionCredentialLease } from "./localCredentials.js";
import { executionReasoningArgs } from "./harnessPolicy.js";
import type { ExecutionBindingRecord } from "./nodeState.js";
import { bindingRefMatches } from "./nodeState.js";
import { verifyCanonicalSignature, type SignatureVerifier } from "./signing.js";
import { NATIVE_PROVIDER_ID, GIT_WORKTREE_MATERIALIZER_ID, ADVERTISED_HARNESSES } from "./describe.js";

/** Capability leased by Apiary whenever signed harness config selects Kit. */
export const KIT_PROFILE_CAPABILITY = "kit/profile";

export type ValidatedRunStart = {
  envelope: JsonObject;
  body: JsonObject;
  intent: JsonObject;
  lease: JsonObject;
  authority: JsonObject;
  runId: string;
  effectKey: string;
  requestDigest: string;
};

export type RunStartValidationDeps = {
  validator: ExecutionValidator;
  binding: ExecutionBindingRecord;
  nodeId: string;
  protocolVersion: string;
  /** Injectable for corpus-fixture replay tests; defaults to real ed25519. */
  verifySignature?: SignatureVerifier;
  now?: () => Date;
  /**
   * Defer the lease validity-window check to the caller. The coordinator uses
   * this so an identical retry can replay its recorded receipt after lease
   * expiry (replay is read-only); every NEW admission and every relaunch still
   * enforces the window via assertLeaseWindow.
   */
  skipTimeWindow?: boolean;
};

/** Throws LEASE_DENIED when `now` is outside the lease's validity window. */
export function assertLeaseWindow(lease: JsonObject, now: Date): void {
  const notBefore = Date.parse(String(lease.notBefore));
  const expiresAt = Date.parse(String(lease.expiresAt));
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || now.getTime() < notBefore || now.getTime() > expiresAt) {
    throw executionError("LEASE_DENIED", "execution lease is outside its validity window");
  }
}

/** Capabilities run.start can actually satisfy in this slice. */
export function supportedCapabilities(): Set<string> {
  return new Set([
    ...ADVERTISED_HARNESSES.map((kind) => `harness/${kind}`),
    `materializer/${GIT_WORKTREE_MATERIALIZER_ID}`,
    KIT_PROFILE_CAPABILITY,
  ]);
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function canonicalEquals(a: JsonValue, b: JsonValue): boolean {
  return canonicalDigest(a) === canonicalDigest(b);
}

/**
 * The exact lease policy local-core-v1 can enforce today. Schema-valid policy
 * is not automatically supported policy: accepting a CPU/memory limit without
 * cgroups/rlimits, an allowlist without a network namespace, or a credential
 * lease without its broker would turn a signed guarantee into decoration.
 *
 * Keep this deliberately equal to Apiary's current minting defaults. Stronger
 * policy requires a named negotiated capability and a real enforcement seam;
 * until then run.start refuses it before the durable reservation.
 */
export function assertSupportedExecutionLeasePolicy(lease: JsonObject): void {
  if (!canonicalEquals((lease.resourceLimits ?? {}) as JsonValue, {})) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      "resourceLimits are not enforceable by the native local-core-v1 runner; omit all resource limit fields",
    );
  }
  if (!canonicalEquals(lease.networkPolicy as JsonValue, { mode: "inherit-node" })) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      "only networkPolicy mode inherit-node (without an allow list) is supported by the native shared-network runner",
    );
  }
  if (!canonicalEquals((lease.mutationAuthority ?? []) as JsonValue, [{ kind: "working-copy-write" }])) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      "only the unrefined working-copy-write mutation grant is enforceable by the execution Cell sandbox",
    );
  }
  if (Array.isArray(lease.materializationCredentialLeaseIds) && lease.materializationCredentialLeaseIds.length > 0) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      "materialization credential leases require the unnegotiated credential-lease-v1 profile",
    );
  }
  const runtimeCredentialLeaseIds = Array.isArray(lease.runtimeCredentialLeaseIds)
    ? lease.runtimeCredentialLeaseIds.filter((value): value is string => typeof value === "string")
    : [];
  if (
    runtimeCredentialLeaseIds.length > 0 &&
    !hasExactLocalGithubSessionCredentialLease(String(lease.runId), runtimeCredentialLeaseIds)
  ) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      "runtime credential leases are unsupported except the exact Run-bound local-gh-session-v1 lease",
    );
  }
}

const SUPPORTED_EVIDENCE_KINDS = new Set(["logs", "diff", "environment-manifest", "transcript"]);

/** Fail closed over schema-valid intent fields the local runner would ignore. */
export function assertSupportedExecutionIntentPolicy(intent: JsonObject): void {
  const harness = asObject(intent.harness);
  if (harness?.versionRange !== undefined) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      "harness versionRange is not negotiated or enforced by local-core-v1",
    );
  }
  const rawConfig = harness?.config;
  const config = asObject(rawConfig);
  if (rawConfig !== undefined && !config) {
    throw executionError("CAPABILITY_MISMATCH", "harness config must be an object for the local-core-v1 driver");
  }
  if (config) {
    const supportedKeys = new Set(["brief", "account", "preamble", "kitProfile", "cellLayout", "reasoning"]);
    const unknown = Object.keys(config).filter((key) => !supportedKeys.has(key));
    if (unknown.length > 0) {
      throw executionError(
        "CAPABILITY_MISMATCH",
        `harness config fields are not supported by local-core-v1: ${unknown.sort().join(", ")}`,
      );
    }
    if (config.brief !== undefined && typeof config.brief !== "string") {
      throw executionError("CAPABILITY_MISMATCH", "harness config.brief must be a string");
    }
    if (config.account !== undefined && (typeof config.account !== "string" || config.account.length === 0)) {
      throw executionError("CAPABILITY_MISMATCH", "harness config.account must be a non-empty string");
    }
    if (config.preamble !== undefined && (typeof config.preamble !== "string" || config.preamble.trim().length === 0)) {
      throw executionError("CAPABILITY_MISMATCH", "harness config.preamble must be a non-empty string");
    }
    if (config.kitProfile !== undefined && (typeof config.kitProfile !== "string" || config.kitProfile.trim().length === 0)) {
      throw executionError("CAPABILITY_MISMATCH", "harness config.kitProfile must be a non-empty string");
    }
    if (config.cellLayout !== undefined && config.cellLayout !== "v1" && config.cellLayout !== "v2") {
      throw executionError("CAPABILITY_MISMATCH", "harness config.cellLayout must be v1 or v2");
    }
    executionReasoningArgs(
      typeof harness?.driverId === "string" ? harness.driverId : "",
      typeof harness?.model === "string" ? harness.model : undefined,
      config.reasoning,
    );
  }
  if (!canonicalEquals((intent.budget ?? {}) as JsonValue, {})) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      "run budget limits are not enforced by local-core-v1; omit maxDurationSeconds, maxTokens, and maxCostUsd",
    );
  }
  const evidenceContract = asObject(intent.evidenceContract);
  const collect = Array.isArray(evidenceContract?.collect) ? evidenceContract.collect : [];
  const unsupportedEvidence = collect.filter(
    (kind): kind is string => typeof kind === "string" && !SUPPORTED_EVIDENCE_KINDS.has(kind),
  );
  if (evidenceContract?.delivery !== "local-manifest" || unsupportedEvidence.length > 0) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      `evidence contract is not collectable by local-core-v1${
        unsupportedEvidence.length > 0 ? `: ${[...new Set(unsupportedEvidence)].sort().join(", ")}` : ""
      }`,
    );
  }
}

export function validateRunStart(request: JsonValue, deps: RunStartValidationDeps): ValidatedRunStart {
  const { validator, binding } = deps;
  const verify = deps.verifySignature ?? verifyCanonicalSignature;
  const now = (deps.now ?? (() => new Date()))();

  // 1. Envelope + body schema (unknown required shapes fail closed).
  const envelopeCheck = validator.validate("execution-request-envelope", request);
  if (!envelopeCheck.valid) {
    throw executionError("SCHEMA_UNSUPPORTED", `invalid run.start envelope: ${envelopeCheck.errors.join("; ")}`);
  }
  const envelope = request as JsonObject;
  if (envelope.protocolVersion !== deps.protocolVersion) {
    throw executionError(
      "PROTOCOL_INCOMPATIBLE",
      `protocolVersion ${String(envelope.protocolVersion)} is not the negotiated ${deps.protocolVersion}`,
    );
  }
  const bodyCheck = validator.validate("run-start-body", envelope.body);
  if (!bodyCheck.valid) {
    throw executionError("SCHEMA_UNSUPPORTED", `invalid run.start body: ${bodyCheck.errors.join("; ")}`);
  }
  const body = envelope.body as JsonObject;
  const intent = body.intent as JsonObject;
  const lease = body.lease as JsonObject;
  const authority = envelope.authority as JsonObject;

  // 2. The effect digest must be the canonical digest of the body; the
  //    envelope signature must verify against the bound authority key.
  const digest = canonicalDigest(envelope.body as JsonValue);
  if (envelope.requestDigest !== digest) {
    throw executionError("SCHEMA_UNSUPPORTED", "requestDigest is not the canonical digest of body");
  }
  if (!verify(binding.authorityPublicKey, envelope as Record<string, JsonValue>)) {
    throw executionError("LEASE_DENIED", "envelope signature does not verify against the bound authority key");
  }

  // 3. Execution audience binding (owner scope + exact binding facts).
  if (authority.ownerScopeId !== binding.ownerScopeId) {
    throw executionError("BINDING_DENIED", `owner scope ${String(authority.ownerScopeId)} is not bound on this node`);
  }
  const audience = asObject(lease.audience);
  if (!audience || !bindingRefMatches(binding.binding, audience.binding as JsonValue)) {
    throw executionError("BINDING_DENIED", "lease audience binding does not match the installed host binding");
  }

  // 4. Lease: signature, audience, scope, actor, epochs, time, and the
  //    capability-lease linkage (authority.capabilityLeaseId must equal
  //    lease.parentCapabilityLeaseId).
  if (!verify(binding.authorityPublicKey, lease as Record<string, JsonValue>)) {
    throw executionError("LEASE_DENIED", "execution lease signature does not verify against the bound authority key");
  }
  if (authority.capabilityLeaseId === undefined || authority.capabilityLeaseId !== lease.parentCapabilityLeaseId) {
    throw executionError("LEASE_DENIED", "authority capabilityLeaseId does not equal lease.parentCapabilityLeaseId");
  }
  if (audience.nodeId !== deps.nodeId) {
    throw executionError("LEASE_DENIED", `lease audience node ${String(audience.nodeId)} is not this node (${deps.nodeId})`);
  }
  if (audience.providerId !== NATIVE_PROVIDER_ID) {
    throw executionError("CAPABILITY_MISMATCH", `provider ${String(audience.providerId)} is not available on this node`);
  }
  if (lease.runId !== intent.runId) {
    throw executionError("LEASE_DENIED", "lease.runId does not match intent.runId");
  }
  if (lease.ownerScopeId !== authority.ownerScopeId || intent.ownerScopeId !== authority.ownerScopeId) {
    throw executionError("LEASE_DENIED", "owner scope differs between authority, lease, and intent");
  }
  if (lease.workspaceId !== authority.workspaceId || intent.workspaceId !== authority.workspaceId) {
    throw executionError("LEASE_DENIED", "workspace differs between authority, lease, and intent");
  }
  if (!canonicalEquals(lease.actor as JsonValue, authority.actor as JsonValue)) {
    throw executionError("LEASE_DENIED", "lease actor does not match the authority actor context");
  }
  if (lease.authorityEpoch !== authority.authorityEpoch || lease.policyEpoch !== authority.policyEpoch) {
    throw executionError("LEASE_DENIED", "authority/policy epoch differs between authority claims and lease");
  }
  if (lease.authorityEpoch !== binding.binding.authorityEpoch) {
    throw executionError("BINDING_DENIED", `lease authority epoch ${String(lease.authorityEpoch)} is stale for the installed binding`);
  }
  if (!deps.skipTimeWindow) assertLeaseWindow(lease, now);

  // 5. Snapshot: the intent's snapshot digest must be exactly the leased one.
  const target = asObject(intent.target);
  if (!target || target.digest !== lease.allowedSnapshotDigest) {
    throw executionError("LEASE_DENIED", "intent snapshot digest is not the leased allowedSnapshotDigest");
  }

  // 6. Harness: exactly the leased harness, and a driver this node advertises.
  if (!canonicalEquals(intent.harness as JsonValue, lease.allowedHarness as JsonValue)) {
    throw executionError("LEASE_DENIED", "intent harness does not match the leased allowedHarness");
  }
  const harness = asObject(intent.harness);
  const driverId = String(harness?.driverId ?? "");
  if (!(ADVERTISED_HARNESSES as readonly string[]).includes(driverId)) {
    throw executionError("HARNESS_UNAVAILABLE", `harness driver ${driverId} is not advertised by this node`);
  }
  const harnessConfig = asObject(harness?.config);
  const kitProfile = harnessConfig?.kitProfile;
  if (kitProfile !== undefined && (typeof kitProfile !== "string" || kitProfile.trim().length === 0)) {
    throw executionError("HARNESS_UNAVAILABLE", "harness config.kitProfile must be a non-empty string");
  }
  assertSupportedExecutionIntentPolicy(intent);

  // 7. The intent cannot widen the lease: every required capability must be
  //    authorized by an EXACT canonical leased entry (a differing minVersion
  //    or params is a different requirement, not a name match), and mutation
  //    authority + evidence contract must be exactly what was leased. The
  //    trust zone is pinned to the local default this slice executes in.
  if (intent.trustZone !== "local-default") {
    throw executionError("CAPABILITY_MISMATCH", `trust zone ${String(intent.trustZone)} is not available on this node`);
  }
  const leasedEntries = new Set(
    (Array.isArray(lease.capabilities) ? lease.capabilities : []).map((entry) => canonicalDigest(entry as JsonValue)),
  );
  const requirements = Array.isArray(intent.requiredCapabilities) ? intent.requiredCapabilities : [];
  const supported = supportedCapabilities();
  let requiresKitProfile = false;
  for (const entry of requirements) {
    const requirement = asObject(entry as JsonValue);
    const capability = requirement?.capability;
    if (!requirement || !leasedEntries.has(canonicalDigest(requirement as JsonValue))) {
      throw executionError("LEASE_DENIED", `required capability ${String(capability)} is not authorized by an exact leased entry`);
    }
    if (typeof capability !== "string" || !supported.has(capability)) {
      throw executionError("CAPABILITY_MISMATCH", `required capability ${String(capability)} is not supported by this node`);
    }
    if (capability === KIT_PROFILE_CAPABILITY) requiresKitProfile = true;
    if (requirement.minVersion !== undefined || requirement.params !== undefined) {
      throw executionError("CAPABILITY_MISMATCH", `capability constraints (minVersion/params) on ${capability} are not supported by this node`);
    }
  }
  if (kitProfile !== undefined && !requiresKitProfile) {
    throw executionError("CAPABILITY_MISMATCH", `harness config.kitProfile requires ${KIT_PROFILE_CAPABILITY}`);
  }
  if (requiresKitProfile && kitProfile === undefined) {
    throw executionError("CAPABILITY_MISMATCH", `${KIT_PROFILE_CAPABILITY} requires harness config.kitProfile`);
  }
  if (!canonicalEquals((intent.mutationAuthority ?? []) as JsonValue, (lease.mutationAuthority ?? []) as JsonValue)) {
    throw executionError("LEASE_DENIED", "intent mutation authority does not match the leased mutation authority");
  }
  assertSupportedExecutionLeasePolicy(lease);
  if (!canonicalEquals(intent.evidenceContract as JsonValue, lease.evidenceContract as JsonValue)) {
    throw executionError("LEASE_DENIED", "intent evidence contract does not match the leased evidence contract");
  }

  return {
    envelope,
    body,
    intent,
    lease,
    authority,
    runId: String(intent.runId),
    effectKey: String(envelope.effectKey),
    requestDigest: digest,
  };
}
