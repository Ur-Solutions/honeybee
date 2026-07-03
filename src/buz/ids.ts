// buz — message id generation.
//
// ──────────────────────────────────────────────────────────────────────────
// ID generation: 13-char base32 timestamp + 6-hex random, sortable.
// ──────────────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

// Crockford-style base32 (no I, L, O, U). Sorts lexicographically the same
// way as the underlying integer because the alphabet is sorted.
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateMessageId(now: number = Date.now()): string {
  return `${encodeBase32(now, 13)}-${randomHex(3)}`;
}

function encodeBase32(value: number, length: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`encodeBase32: value out of range: ${value}`);
  let n = Math.floor(value);
  const out: string[] = [];
  for (let i = 0; i < length; i += 1) {
    out.unshift(BASE32_ALPHABET[n % 32]!);
    n = Math.floor(n / 32);
  }
  if (n > 0) {
    // Value overflows; truncate to the most significant `length` chars.
    return out.join("");
  }
  return out.join("");
}

// crypto-strength randomness: Math.random suffixes collided across
// same-millisecond sends (broadcasts), silently overwriting mailbox files.
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
