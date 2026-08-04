// Tier order IS the downgrade chain (policy.ts walks it left to right).
// next-tool sits between interrupt and queue: it steers the current turn
// without cancelling it. Provider-native queues own the safe model/tool
// boundary; other HSR runners hold until their next observable boundary.
// Substrates that cannot honor either behavior downgrade it to queue.
export const BUZ_TIERS = ["interrupt", "next-tool", "queue", "passive"] as const;
export type BuzTier = (typeof BUZ_TIERS)[number];

/** Omitted tier: steer the active turn without cancelling it. */
export const DEFAULT_BUZ_TIER: BuzTier = "next-tool";

const BUZ_TIER_SET: ReadonlySet<string> = new Set<string>(BUZ_TIERS);

export function isBuzTier(value: unknown): value is BuzTier {
  return typeof value === "string" && BUZ_TIER_SET.has(value);
}
