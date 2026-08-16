import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionRecord } from "./store.js";

export const CELL_BROKER_CAPABILITY_ENV = "HIVE_CELL_BROKER_TOKEN";
export const CELL_BROKER_CAPABILITY_VERSION = 3;

const CELL_BROKER_CAPABILITY_DOMAIN = "honeybee-cell-broker-capability-v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type MintedCellBrokerCapability = {
  token: string;
  hash: string;
};

/**
 * Hash one opaque runtime-only token against its canonical bee generation.
 * The SessionRecord stores only this digest; the plaintext rides the private
 * 0600 HSR payload and provider environment for that incarnation.
 */
export function hashCellBrokerCapability(
  bee: string,
  runtimeGeneration: number,
  token: string,
): string {
  return `sha256:${createHash("sha256")
    .update(CELL_BROKER_CAPABILITY_DOMAIN)
    .update("\0")
    .update(bee)
    .update("\0")
    .update(String(runtimeGeneration))
    .update("\0")
    .update(token)
    .digest("hex")}`;
}

/** Mint a fresh 256-bit capability for exactly one runtime generation. */
export function mintCellBrokerCapability(
  bee: string,
  runtimeGeneration: number,
): MintedCellBrokerCapability {
  if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 0) {
    throw new Error("Cell broker capability requires a non-negative runtime generation");
  }
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    hash: hashCellBrokerCapability(bee, runtimeGeneration, token),
  };
}

/** Constant-time comparison of a caller token against the canonical record. */
export function matchesCellBrokerCapability(
  record: Pick<SessionRecord, "name" | "runtimeGeneration" | "cellBrokerCapabilityHash">,
  token: unknown,
): boolean {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
  const stored = record.cellBrokerCapabilityHash;
  if (typeof stored !== "string" || !DIGEST_PATTERN.test(stored)) return false;
  const candidate = hashCellBrokerCapability(record.name, record.runtimeGeneration ?? 0, token);
  const storedBytes = Buffer.from(stored, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return storedBytes.length === candidateBytes.length && timingSafeEqual(storedBytes, candidateBytes);
}

export function isCellBrokerCapabilityToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function isCellBrokerCapabilityHash(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}
