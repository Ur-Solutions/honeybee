// Canonical-JSON ed25519 signing for the execution protocol. Signatures are
// `ed25519:<base64>` over the canonical JSON (sorted keys) of the signed
// document with its `signature` field removed — the same canonical form the
// requestDigest uses (src/comb/canonical.ts), so both repositories can verify
// byte-identically. Keys travel as base64 DER (SPKI public / PKCS8 private).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, createHash, type KeyObject } from "node:crypto";
import { canonicalJson } from "../comb/canonical.js";
import type { JsonValue } from "../comb/types.js";

export const SIGNATURE_PREFIX = "ed25519:";

export type ExecutionKeyPair = {
  /** base64 SPKI DER. */
  publicKey: string;
  /** base64 PKCS8 DER. */
  privateKey: string;
};

export function generateExecutionKeyPair(): ExecutionKeyPair {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

function toPrivateKey(privateKeyB64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
}

function toPublicKey(publicKeyB64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
}

/** `sha256:<hex>` fingerprint of a base64 SPKI DER public key. */
export function publicKeyFingerprint(publicKeyB64: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex")}`;
}

/** True when the value parses as an Ed25519 SPKI DER public key. */
export function isEd25519PublicKey(publicKeyB64: string): boolean {
  try {
    return toPublicKey(publicKeyB64).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function canonicalUnsignedBytes(document: Record<string, JsonValue>): Buffer {
  const { signature: _signature, ...unsigned } = document;
  return Buffer.from(canonicalJson(unsigned as JsonValue), "utf8");
}

/** Sign a document (its `signature` field, if present, is excluded). */
export function signCanonical(privateKeyB64: string, document: Record<string, JsonValue>): string {
  const signature = edSign(null, canonicalUnsignedBytes(document), toPrivateKey(privateKeyB64));
  return `${SIGNATURE_PREFIX}${signature.toString("base64")}`;
}

/** Verify a document's `signature` field against a base64 SPKI DER public key. */
export function verifyCanonicalSignature(publicKeyB64: string, document: Record<string, JsonValue>): boolean {
  const signature = document.signature;
  if (typeof signature !== "string" || !signature.startsWith(SIGNATURE_PREFIX)) return false;
  let raw: Buffer;
  try {
    raw = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), "base64");
  } catch {
    return false;
  }
  try {
    return edVerify(null, canonicalUnsignedBytes(document), toPublicKey(publicKeyB64), raw);
  } catch {
    return false;
  }
}

export type SignatureVerifier = (publicKeyB64: string, document: Record<string, JsonValue>) => boolean;
