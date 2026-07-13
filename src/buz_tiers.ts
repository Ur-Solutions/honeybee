// Tier order IS the downgrade chain (policy.ts walks it left to right).
// next-tool sits between interrupt and queue: it interjects like an interrupt
// but the HSR runner holds it until the next tool boundary; substrates that
// cannot honor the hold downgrade it to queue.
export const BUZ_TIERS = ["interrupt", "next-tool", "queue", "passive"] as const;
export type BuzTier = (typeof BUZ_TIERS)[number];

const BUZ_TIER_SET: ReadonlySet<string> = new Set<string>(BUZ_TIERS);

export function isBuzTier(value: unknown): value is BuzTier {
  return typeof value === "string" && BUZ_TIER_SET.has(value);
}
