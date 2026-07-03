export const BUZ_TIERS = ["interrupt", "queue", "passive"] as const;
export type BuzTier = (typeof BUZ_TIERS)[number];

const BUZ_TIER_SET: ReadonlySet<string> = new Set<string>(BUZ_TIERS);

export function isBuzTier(value: unknown): value is BuzTier {
  return typeof value === "string" && BUZ_TIER_SET.has(value);
}
