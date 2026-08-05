// Node-local administrative RPCs for the accountless Apiary L2 bootstrap
// seam: first-bind of a LocalAuthorityHostBinding and working-copy
// registration, on the daemon's aggregate HSR control socket.
//
// These are NOT local-core-v1 corpus methods. They are versioned separately
// (`adminVersion`), advertised separately (`executionAdmin: 1` in the socket's
// `capabilities` handshake), and never claimed by protocol.hello feature
// negotiation. They exist because H1 deliberately has no external route to
// install a binding or register a working copy, and direct file writes from
// Apiary into Honeybee's store are forbidden.
//
// Trust boundary (documented, tested in execution-admin.test.ts):
//   - The control socket lives in a 0o700 directory with a 0o700 socket file,
//     so only the same OS user can connect. Node has no portable peer-
//     credential (SO_PEERCRED/LOCAL_PEERCRED) API, so SOCKET POSSESSION plus
//     the request SIGNATURE are the local trust boundary.
//   - First-bind is trust-on-first-use: the self-signature proves POSSESSION
//     of the authority key, not authorization by any remote org. That is
//     acceptable only for the local-authority-host binding kind on a same-
//     user socket; PairGrant/NodeEnrollment/handoff are explicitly out of
//     scope and there is no replace path.
//   - After the first bind the authority key is pinned: registration requests
//     must verify against the PINNED key, never a key carried in the request.
//
// Fail-closed discipline: strict shapes (unknown fields rejected at every
// level), version drift rejected, canonical request digests, bounded request
// size, and corrupt durable state surfaces as a typed error — never a rewrite.
// Responses are path-free: the node-local locator path is validated, stored,
// and never returned, logged, or broadcast.
import { canonicalDigest } from "../comb/canonical.js";
import type { JsonValue } from "../comb/types.js";
import type { RpcMethodHandler } from "../hsr/rpc.js";
import type { JsonObject } from "./contract.js";
import { NATIVE_PROVIDER_ID } from "./describe.js";
import { executionError, toWireError } from "./errors.js";
import {
  bindLocalAuthorityHostFirstUse,
  requireExecutionBinding,
  type ExecutionBindingRecord,
} from "./nodeState.js";
import { isEd25519PublicKey, publicKeyFingerprint, verifyCanonicalSignature, type SignatureVerifier } from "./signing.js";
import { registerWorkingCopyIdempotent } from "./workingCopies.js";

export const EXECUTION_ADMIN_VERSION = 1;
export const EXECUTION_ADMIN_CAPABILITY = "executionAdmin";
export const ADMIN_BIND_METHOD = "executionAdmin.bindLocalAuthorityHost";
export const ADMIN_REGISTER_METHOD = "executionAdmin.registerWorkingCopy";

/** Admin requests carry identities and one key — far below this bound. */
export const ADMIN_MAX_REQUEST_BYTES = 32 * 1024;

/* ---------------------------------------------------------------- */
/* Strict field validation                                           */
/* ---------------------------------------------------------------- */

// Mirrors the corpus common.schema.json Identifier: opaque ids, never paths.
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw executionError("SCHEMA_UNSUPPORTED", message);
}

function asStrictObject(value: unknown, subject: string, allowedKeys: readonly string[]): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${subject} must be a JSON object`);
  }
  const doc = value as JsonObject;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) invalid(`${subject} carries unknown field "${key}"`);
  }
  return doc;
}

function identifier(doc: JsonObject, subject: string, key: string): string {
  const value = doc[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !IDENTIFIER.test(value)) {
    invalid(`${subject}.${key} must be an identifier (1-128 chars, [A-Za-z0-9._:/-])`);
  }
  return value;
}

function timestamp(doc: JsonObject, subject: string, key: string): string {
  const value = doc[key];
  if (typeof value !== "string" || !TIMESTAMP.test(value)) invalid(`${subject}.${key} must be an ISO-8601 timestamp`);
  return value;
}

function sha256Digest(doc: JsonObject, subject: string, key: string): string {
  const value = doc[key];
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) invalid(`${subject}.${key} must be a sha256:<64-hex> digest`);
  return value;
}

function positiveEpoch(doc: JsonObject, subject: string, key: string): number {
  const value = doc[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalid(`${subject}.${key} must be a positive integer epoch`);
  }
  return value;
}

/**
 * Node-local absolute locator path: absolute, no NUL, no relative escapes.
 * Deliberately never echoed in errors — refusals must stay path-free too.
 */
function locatorPath(doc: JsonObject, subject: string, key: string): string {
  const value = doc[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    !value.startsWith("/") ||
    value.includes("\u0000") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    invalid(`${subject}.${key} must be a clean absolute node-local path`);
  }
  return value;
}

/**
 * Shared envelope checks: version pin, size bound, canonical body digest, and
 * strict top-level shape. Returns the parsed envelope + body object (body is
 * validated per-method).
 */
function parseAdminEnvelope(params: unknown, method: string): { envelope: JsonObject; body: JsonObject } {
  if (JSON.stringify(params ?? null).length > ADMIN_MAX_REQUEST_BYTES) {
    invalid(`${method} request exceeds the ${ADMIN_MAX_REQUEST_BYTES}-byte admin request bound`);
  }
  const envelope = asStrictObject(params, `${method} request`, [
    "adminVersion",
    "requestId",
    "issuedAt",
    "requestDigest",
    "body",
    "signature",
  ]);
  if (envelope.adminVersion !== EXECUTION_ADMIN_VERSION) {
    invalid(`${method} adminVersion ${String(envelope.adminVersion)} is not the supported version ${EXECUTION_ADMIN_VERSION}`);
  }
  identifier(envelope, method, "requestId");
  timestamp(envelope, method, "issuedAt");
  const digest = sha256Digest(envelope, method, "requestDigest");
  if (typeof envelope.signature !== "string" || envelope.signature.length === 0 || envelope.signature.length > 8192) {
    invalid(`${method}.signature must be a non-empty signature string`);
  }
  if (envelope.body === null || typeof envelope.body !== "object" || Array.isArray(envelope.body)) {
    invalid(`${method}.body must be a JSON object`);
  }
  if (canonicalDigest(envelope.body as JsonValue) !== digest) {
    invalid(`${method}.requestDigest is not the canonical digest of body`);
  }
  return { envelope, body: envelope.body as JsonObject };
}

/* ---------------------------------------------------------------- */
/* Method handlers                                                   */
/* ---------------------------------------------------------------- */

export type ExecutionAdminOptions = {
  /** Injectable for tests; defaults to real ed25519 verification. */
  verifySignature?: SignatureVerifier;
};

function bindingFacts(record: ExecutionBindingRecord): JsonObject {
  return {
    ownerScopeId: record.ownerScopeId,
    nodeId: record.nodeId,
    binding: record.binding as unknown as JsonValue,
    installedAt: record.installedAt,
  };
}

/**
 * Idempotent first-bind of the LocalAuthorityHostBinding. The request is
 * SELF-SIGNED by the LocalAuthority key it carries (possession proof); the
 * bound nodeId is the request's single, signed nodeId fact — there is no
 * second node identity in the shape for it to diverge from.
 */
async function bindLocalAuthorityHost(params: unknown, verify: SignatureVerifier): Promise<JsonObject> {
  const { envelope, body } = parseAdminEnvelope(params, ADMIN_BIND_METHOD);
  const subject = `${ADMIN_BIND_METHOD}.body`;
  asStrictObject(body, subject, [
    "ownerScopeId",
    "authorityId",
    "authorityEpoch",
    "bindingId",
    "nodeId",
    "authorityPublicKey",
    "keyFingerprint",
  ]);
  const ownerScopeId = identifier(body, subject, "ownerScopeId");
  const authorityId = identifier(body, subject, "authorityId");
  const bindingId = identifier(body, subject, "bindingId");
  const nodeId = identifier(body, subject, "nodeId");
  const authorityEpoch = positiveEpoch(body, subject, "authorityEpoch");
  const claimedFingerprint = sha256Digest(body, subject, "keyFingerprint");
  const authorityPublicKey = body.authorityPublicKey;
  if (typeof authorityPublicKey !== "string" || !isEd25519PublicKey(authorityPublicKey)) {
    invalid(`${subject}.authorityPublicKey must be a base64 SPKI DER Ed25519 public key`);
  }
  if (publicKeyFingerprint(authorityPublicKey) !== claimedFingerprint) {
    invalid(`${subject}.keyFingerprint does not match authorityPublicKey`);
  }
  if (!verify(authorityPublicKey, envelope as Record<string, JsonValue>)) {
    throw executionError("BINDING_DENIED", "bind request signature does not verify against the carried authority key");
  }
  const { record, outcome } = await bindLocalAuthorityHostFirstUse({
    ownerScopeId,
    bindingId,
    authorityId,
    authorityEpoch,
    authorityPublicKey,
    nodeId,
  });
  return {
    adminVersion: EXECUTION_ADMIN_VERSION,
    requestId: String(envelope.requestId),
    outcome,
    ...bindingFacts(record),
  };
}

/**
 * Idempotent working-copy registration, only after a binding is pinned. The
 * request is signed by the PINNED authority key and carries the exact
 * canonical WorkingCopyRef facts (corpus working-copy-ref vocabulary:
 * workingCopyId/nodeId/providerId/productId/origin/revision/branch) + the
 * snapshot digest + the node-local locator path. The path is REQUEST-ONLY:
 * the response returns the canonical ref and never the locator.
 */
async function registerWorkingCopy(params: unknown, verify: SignatureVerifier): Promise<JsonObject> {
  const { envelope, body } = parseAdminEnvelope(params, ADMIN_REGISTER_METHOD);
  const subject = `${ADMIN_REGISTER_METHOD}.body`;
  asStrictObject(body, subject, [
    "ownerScopeId",
    "authorityId",
    "authorityEpoch",
    "bindingId",
    "workingCopy",
    "snapshotDigest",
    "locator",
  ]);
  const ownerScopeId = identifier(body, subject, "ownerScopeId");
  const authorityId = identifier(body, subject, "authorityId");
  const bindingId = identifier(body, subject, "bindingId");
  const authorityEpoch = positiveEpoch(body, subject, "authorityEpoch");
  const snapshotDigest = sha256Digest(body, subject, "snapshotDigest");

  // Exact canonical WorkingCopyRef facts. The request carries ONE nodeId —
  // inside the ref — so a registration whose node fact diverges from what was
  // signed is impossible by shape.
  const workingCopy = asStrictObject(body.workingCopy, `${subject}.workingCopy`, [
    "workingCopyId",
    "nodeId",
    "providerId",
    "productId",
    "origin",
    "revision",
    "branch",
  ]);
  const workingCopyId = identifier(workingCopy, `${subject}.workingCopy`, "workingCopyId");
  const nodeId = identifier(workingCopy, `${subject}.workingCopy`, "nodeId");
  const providerId = identifier(workingCopy, `${subject}.workingCopy`, "providerId");
  const productId = identifier(workingCopy, `${subject}.workingCopy`, "productId");
  const origin = workingCopy.origin;
  if (typeof origin !== "string" || origin.length === 0 || origin.length > 4096) {
    invalid(`${subject}.workingCopy.origin must be a non-empty normalized origin string`);
  }
  const revision = workingCopy.revision;
  if (typeof revision !== "string" || !FULL_COMMIT_SHA.test(revision)) {
    invalid(`${subject}.workingCopy.revision must be a full 40/64-hex commit SHA`);
  }
  const branch = workingCopy.branch;
  if (branch !== undefined && (typeof branch !== "string" || branch.length === 0 || branch.length > 512)) {
    invalid(`${subject}.workingCopy.branch must be a non-empty string when present`);
  }
  if (providerId !== NATIVE_PROVIDER_ID) {
    throw executionError("CAPABILITY_MISMATCH", `provider ${providerId} is not the registered native provider on this node`);
  }

  const locator = asStrictObject(body.locator, `${subject}.locator`, ["path"]);
  const path = locatorPath(locator, `${subject}.locator`, "path");

  // Binding gate: pinned key, exact scope/binding/epoch/node facts. Absent or
  // corrupt binding fails closed (BINDING_DENIED) before touching the registry.
  const binding = await requireExecutionBinding();
  if (
    ownerScopeId !== binding.ownerScopeId ||
    bindingId !== binding.binding.bindingId ||
    authorityId !== binding.binding.authorityId
  ) {
    throw executionError("BINDING_DENIED", "registration facts do not name the installed LocalAuthority host binding");
  }
  if (authorityEpoch !== binding.binding.authorityEpoch) {
    throw executionError(
      "BINDING_DENIED",
      `registration authority epoch ${authorityEpoch} is not the installed binding epoch ${binding.binding.authorityEpoch}`,
    );
  }
  if (nodeId !== binding.nodeId) {
    throw executionError("BINDING_DENIED", `registration node ${nodeId} is not this node (${binding.nodeId})`);
  }
  if (!verify(binding.authorityPublicKey, envelope as Record<string, JsonValue>)) {
    throw executionError("BINDING_DENIED", "registration signature does not verify against the pinned authority key");
  }

  const { record, outcome } = await registerWorkingCopyIdempotent({
    workingCopyId,
    productId,
    path,
    snapshotDigest,
    origin,
    revision,
    ...(branch !== undefined ? { branch } : {}),
  });
  // Path-free response by construction: the exact canonical WorkingCopyRef
  // facts return; the locator stays node-private in the registry.
  return {
    adminVersion: EXECUTION_ADMIN_VERSION,
    requestId: String(envelope.requestId),
    outcome,
    workingCopy: {
      workingCopyId: record.workingCopyId,
      nodeId: binding.nodeId,
      providerId,
      productId: record.productId,
      origin: record.origin ?? origin,
      revision: record.revision ?? revision,
      ...(record.branch !== undefined ? { branch: record.branch } : {}),
    },
    snapshotDigest: record.snapshotDigest,
    registeredAt: record.registeredAt,
  };
}

/* ---------------------------------------------------------------- */
/* RPC wiring                                                        */
/* ---------------------------------------------------------------- */

/** Wrap a handler so refusals return `{ adminVersion, requestId?, error }` instead of throwing. */
function guarded(fn: (params: unknown) => Promise<JsonObject>): RpcMethodHandler {
  return async (params) => {
    try {
      return await fn(params);
    } catch (error) {
      const requestId = (params as { requestId?: unknown } | null)?.requestId;
      return {
        adminVersion: EXECUTION_ADMIN_VERSION,
        ...(typeof requestId === "string" ? { requestId } : {}),
        error: toWireError(error) as unknown as JsonValue,
      };
    }
  };
}

/** The admin method map, merged onto the aggregate control socket. */
export function createExecutionAdminMethods(options: ExecutionAdminOptions = {}): Record<string, RpcMethodHandler> {
  const verify = options.verifySignature ?? verifyCanonicalSignature;
  return {
    [ADMIN_BIND_METHOD]: guarded((params) => bindLocalAuthorityHost(params, verify)),
    [ADMIN_REGISTER_METHOD]: guarded((params) => registerWorkingCopy(params, verify)),
  };
}
