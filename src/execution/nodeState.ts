// Durable node-local execution-protocol state: the node's signing identity and
// the installed LocalAuthority host binding (H1 slice; RFC §8, §10.2).
//
// Everything lives under `<storeRoot()>/execution/`:
//   node-identity.json — { nodeId, publicKey, privateKey } minted once
//   binding.json       — the accepted LocalAuthorityHostBinding + the
//                        authority's public key used to verify leases/envelopes
//
// A node cannot self-assert an authority relationship: the binding is written
// by an explicit install step (Apiary's LocalAuthority / tests), and a missing
// or corrupt binding fails closed as BINDING_DENIED — it never defaults open.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, machineId, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import type { JsonValue } from "../comb/types.js";
import { executionError } from "./errors.js";
import { generateExecutionKeyPair, isEd25519PublicKey, publicKeyFingerprint, signCanonical, verifyCanonicalSignature } from "./signing.js";

export function executionRoot(): string {
  return join(storeRoot(), "execution");
}

export async function ensureExecutionRoot(): Promise<void> {
  await mkdir(executionRoot(), { recursive: true, mode: 0o700 });
}

/* ---------------------------------------------------------------- */
/* Node identity                                                     */
/* ---------------------------------------------------------------- */

export type ExecutionNodeIdentity = {
  version: 1;
  nodeId: string;
  /** base64 SPKI DER ed25519. */
  publicKey: string;
  /** base64 PKCS8 DER ed25519. */
  privateKey: string;
  createdAt: string;
};

function identityPath(): string {
  return join(executionRoot(), "node-identity.json");
}

/** Identifier-safe nodeId derived from the persisted machine id. */
function mintNodeId(): string {
  const raw = machineId().replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 32);
  return `node-${raw || "local"}`;
}

/** Parse + verify a persisted identity; throws on any incoherence. */
function parseIdentity(raw: string): ExecutionNodeIdentity {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.version !== 1 ||
    typeof parsed.nodeId !== "string" ||
    parsed.nodeId.length === 0 ||
    typeof parsed.publicKey !== "string" ||
    typeof parsed.privateKey !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("node identity record has an unknown version or missing fields");
  }
  const identity = parsed as unknown as ExecutionNodeIdentity;
  // Key coherence: the stored public key must be the one the private key
  // signs for; a mismatched pair would sign descriptors nobody can verify.
  const probe = signCanonical(identity.privateKey, { probe: "node-identity" });
  if (!verifyCanonicalSignature(identity.publicKey, { probe: "node-identity", signature: probe })) {
    throw new Error("node identity public/private keys are incoherent");
  }
  return identity;
}

/**
 * Read-or-mint the node's execution identity. Minting happens ONLY when the
 * identity file is truly absent (ENOENT): a corrupt or incoherent record
 * fails closed — silently minting a replacement key would let a damaged node
 * re-enter with a fresh identity nobody enrolled.
 */
export async function loadNodeIdentity(): Promise<ExecutionNodeIdentity> {
  const read = async (): Promise<ExecutionNodeIdentity | null> => {
    let raw: string;
    try {
      raw = await readFile(identityPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw executionError("AUTHORITY_UNAVAILABLE", `node identity is unreadable: ${String(error)}`);
    }
    try {
      return parseIdentity(raw);
    } catch (error) {
      throw executionError(
        "AUTHORITY_UNAVAILABLE",
        `node identity at ${identityPath()} is corrupt (${error instanceof Error ? error.message : String(error)}); refusing to mint a replacement — restore or explicitly remove it`,
      );
    }
  };
  const existing = await read();
  if (existing) return existing;
  await ensureExecutionRoot();
  return withFileLock(join(executionRoot(), ".node-identity.lock"), async () => {
    const raced = await read();
    if (raced) return raced;
    const pair = generateExecutionKeyPair();
    const identity: ExecutionNodeIdentity = {
      version: 1,
      nodeId: mintNodeId(),
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      createdAt: new Date().toISOString(),
    };
    await atomicWriteFile(identityPath(), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    return identity;
  });
}

/* ---------------------------------------------------------------- */
/* LocalAuthority host binding                                       */
/* ---------------------------------------------------------------- */

/** Wire shape of the local-authority-host arm of execution-audience-binding-ref.schema.json. */
export type LocalAuthorityHostBindingRef = {
  kind: "local-authority-host";
  bindingId: string;
  authorityId: string;
  keyFingerprint: string;
  authorityEpoch: number;
};

export type ExecutionBindingRecord = {
  version: 1;
  ownerScopeId: string;
  /**
   * The CANONICAL public node identity this node executes as: the Apiary
   * LocalAuthorityManifest's intended host fact, bound at install time. Every
   * protocol surface (node.describe, lease audience, explicit placement,
   * event origins) speaks this id; the Honeybee-minted identity in
   * node-identity.json remains signing-key custody only, so L2 never juggles
   * two public node identities.
   */
  nodeId: string;
  binding: LocalAuthorityHostBindingRef;
  /** base64 SPKI DER of the LocalAuthority signing key; leases/envelopes verify against it. */
  authorityPublicKey: string;
  installedAt: string;
};

function bindingPath(): string {
  return join(executionRoot(), "binding.json");
}

export type InstallBindingInput = {
  ownerScopeId: string;
  bindingId: string;
  authorityId: string;
  authorityEpoch: number;
  authorityPublicKey: string;
  /** Canonical Apiary nodeId (the authority manifest's hostNodeId). */
  nodeId: string;
};

function buildBindingRecord(input: InstallBindingInput): ExecutionBindingRecord {
  if (!input.ownerScopeId || !input.bindingId || !input.authorityId || !input.authorityPublicKey || !input.nodeId) {
    throw new Error(
      "installLocalAuthorityHostBinding: ownerScopeId, bindingId, authorityId, authorityPublicKey, nodeId required",
    );
  }
  if (!Number.isInteger(input.authorityEpoch) || input.authorityEpoch < 1) {
    throw new Error("installLocalAuthorityHostBinding: authorityEpoch must be a positive integer");
  }
  if (!isEd25519PublicKey(input.authorityPublicKey)) {
    throw new Error("installLocalAuthorityHostBinding: authorityPublicKey must be a base64 SPKI DER Ed25519 key");
  }
  return {
    version: 1,
    ownerScopeId: input.ownerScopeId,
    nodeId: input.nodeId,
    binding: {
      kind: "local-authority-host",
      bindingId: input.bindingId,
      authorityId: input.authorityId,
      keyFingerprint: publicKeyFingerprint(input.authorityPublicKey),
      authorityEpoch: input.authorityEpoch,
    },
    authorityPublicKey: input.authorityPublicKey,
    installedAt: new Date().toISOString(),
  };
}

/**
 * Install (or replace, e.g. on authority-epoch bump) the node's accepted
 * LocalAuthority host binding. The keyFingerprint is derived from the supplied
 * authority public key, so a record can never carry a fingerprint that does
 * not match the key it verifies with. Direct-write seam for tests/tooling;
 * the RPC surface goes through bindLocalAuthorityHostFirstUse, which never
 * replaces an existing binding.
 */
export async function installLocalAuthorityHostBinding(input: InstallBindingInput): Promise<ExecutionBindingRecord> {
  const record = buildBindingRecord(input);
  await ensureExecutionRoot();
  await atomicWriteFile(bindingPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

export type FirstUseBindOutcome = { record: ExecutionBindingRecord; outcome: "created" | "replayed" };

/**
 * Idempotent trust-on-first-use bind. Under the binding lock:
 *   - truly absent binding  -> install (TOFU is acceptable ONLY because the
 *     control socket is same-user restricted; see adminMethods.ts);
 *   - identical facts       -> replay of the original record (no rewrite);
 *   - any differing fact    -> IDEMPOTENCY_CONFLICT, fail closed. There is no
 *     replace/handoff path here — epoch bumps and authority moves are an
 *     explicit future operation, never a bind side effect;
 *   - corrupt existing record -> BINDING_DENIED (propagated from read).
 */
export async function bindLocalAuthorityHostFirstUse(input: InstallBindingInput): Promise<FirstUseBindOutcome> {
  const candidate = buildBindingRecord(input);
  await ensureExecutionRoot();
  return withFileLock(join(executionRoot(), ".binding.lock"), async () => {
    const existing = await readExecutionBinding();
    if (!existing) {
      await atomicWriteFile(bindingPath(), `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
      return { record: candidate, outcome: "created" as const };
    }
    const identical =
      existing.ownerScopeId === candidate.ownerScopeId &&
      existing.nodeId === candidate.nodeId &&
      existing.authorityPublicKey === candidate.authorityPublicKey &&
      existing.binding.bindingId === candidate.binding.bindingId &&
      existing.binding.authorityId === candidate.binding.authorityId &&
      existing.binding.keyFingerprint === candidate.binding.keyFingerprint &&
      existing.binding.authorityEpoch === candidate.binding.authorityEpoch;
    if (!identical) {
      throw executionError(
        "IDEMPOTENCY_CONFLICT",
        "a different LocalAuthority host binding is already installed on this node; refusing to replace it",
        { installedBindingId: existing.binding.bindingId, installedAuthorityId: existing.binding.authorityId },
      );
    }
    return { record: existing, outcome: "replayed" as const };
  });
}

/**
 * Read the installed binding. Absent (ENOENT) -> null; a corrupt record or a
 * tampered key/fingerprint pair fails closed as BINDING_DENIED — the stored
 * keyFingerprint is recomputed from the stored key on every read, so editing
 * both the key and its claimed fingerprint in the file still refuses.
 */
export async function readExecutionBinding(): Promise<ExecutionBindingRecord | null> {
  let raw: string;
  try {
    raw = await readFile(bindingPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw executionError("BINDING_DENIED", `execution binding is unreadable: ${String(error)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw executionError("BINDING_DENIED", "execution binding record is corrupt; reinstall the host binding");
  }
  const binding = parsed.binding as Record<string, unknown> | undefined;
  if (
    parsed.version !== 1 ||
    typeof parsed.ownerScopeId !== "string" ||
    typeof parsed.nodeId !== "string" ||
    parsed.nodeId.length === 0 ||
    typeof parsed.authorityPublicKey !== "string" ||
    !binding ||
    binding.kind !== "local-authority-host" ||
    typeof binding.bindingId !== "string" ||
    typeof binding.authorityId !== "string" ||
    typeof binding.keyFingerprint !== "string" ||
    typeof binding.authorityEpoch !== "number"
  ) {
    throw executionError("BINDING_DENIED", "execution binding record is malformed; reinstall the host binding");
  }
  if (!isEd25519PublicKey(parsed.authorityPublicKey)) {
    throw executionError("BINDING_DENIED", "execution binding authority key is not a valid Ed25519 public key");
  }
  if (publicKeyFingerprint(parsed.authorityPublicKey) !== binding.keyFingerprint) {
    throw executionError("BINDING_DENIED", "execution binding key fingerprint does not match its authority key");
  }
  return parsed as unknown as ExecutionBindingRecord;
}

/** The installed binding, or a typed BINDING_DENIED when absent/corrupt. */
export async function requireExecutionBinding(): Promise<ExecutionBindingRecord> {
  const record = await readExecutionBinding();
  if (!record) {
    throw executionError("BINDING_DENIED", "no LocalAuthority host binding is installed on this node");
  }
  return record;
}

/** Structural equality between a wire binding ref and the installed record. */
export function bindingRefMatches(installed: LocalAuthorityHostBindingRef, ref: JsonValue): boolean {
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return false;
  const value = ref as Record<string, JsonValue>;
  return (
    value.kind === "local-authority-host" &&
    value.bindingId === installed.bindingId &&
    value.authorityId === installed.authorityId &&
    value.keyFingerprint === installed.keyFingerprint &&
    value.authorityEpoch === installed.authorityEpoch
  );
}
