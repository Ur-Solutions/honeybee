// buz — per-recipient tier policy: accept-list resolution, auto-downgrade,
// and accept-flag parsing/validation.

import { BUZ_TIERS, isBuzTier, type BuzTier } from "../buz_tiers.js";
import type { SessionRecord } from "../store.js";
import { DEFAULT_BUZ_ACCEPT, type DowngradeResult } from "../buz.js";

// ──────────────────────────────────────────────────────────────────────────
// Policy resolution.
// ──────────────────────────────────────────────────────────────────────────

export function resolveBuzAccept(record: Pick<SessionRecord, "buzAccept">): readonly BuzTier[] {
  const explicit = record.buzAccept;
  if (!explicit || explicit.length === 0) return DEFAULT_BUZ_ACCEPT;
  return explicit;
}

const BUZ_DOWNGRADE_CHAIN: readonly BuzTier[] = BUZ_TIERS;
const BUZ_DOWNGRADE_FLOOR: BuzTier = BUZ_TIERS.at(-1)!;

// Auto-downgrade chain interrupt -> queue -> passive. If even passive is
// disallowed by an explicit policy that excludes all three, returns
// passive as a hard floor (we never silently drop a message); callers can
// inspect `downgraded` + `reason` to decide whether to error.
export function downgradeTier(requested: BuzTier, accepted: readonly BuzTier[]): DowngradeResult {
  const startIdx = BUZ_DOWNGRADE_CHAIN.indexOf(requested);
  if (startIdx === -1) throw new Error(`Unknown tier: ${String(requested)}`);
  for (let i = startIdx; i < BUZ_DOWNGRADE_CHAIN.length; i += 1) {
    const candidate = BUZ_DOWNGRADE_CHAIN[i]!;
    if (accepted.includes(candidate)) {
      return {
        effective: candidate,
        downgraded: candidate !== requested,
        ...(candidate !== requested ? { reason: `policy disallows ${requested}` } : {}),
      };
    }
  }
  // Policy excludes every tier — fall back to passive as a documented floor.
  return {
    effective: BUZ_DOWNGRADE_FLOOR,
    downgraded: requested !== BUZ_DOWNGRADE_FLOOR,
    reason: `policy disallows ${requested}; no accepted tier; fell back to ${BUZ_DOWNGRADE_FLOOR}`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Accept policy update.
// ──────────────────────────────────────────────────────────────────────────

export function validateAcceptList(values: string[]): BuzTier[] {
  const out: BuzTier[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (!isBuzTier(value)) {
      throw new Error(`Unknown tier: ${value}. Use one of: ${BUZ_TIERS.join(", ")}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function parseAcceptFlag(value: string): BuzTier[] {
  return validateAcceptList(value.split(",").map((v) => v.trim()).filter(Boolean));
}
