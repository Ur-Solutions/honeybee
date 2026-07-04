// ──────────────────────────────────────────────────────────────────────────
// The costing layer: turn a raw SpendEvent into a priced CostedEvent using the
// versioned, human-editable RateTable. Pure functions, no I/O — the ingest and
// report layers own reading/writing; this module only does arithmetic and rule
// resolution so it stays trivially testable and re-runnable over history.
//
// Rates are USD per 1,000,000 tokens. A price we do not know is an explicit
// null and MUST surface on the unknown/unresolved path — it is never silently
// treated as zero. When a rate cannot be resolved we emit usd = 0 and flag the
// event (rateResolved:false) rather than fabricating a number.
// ──────────────────────────────────────────────────────────────────────────

import {
  TOKEN_TIERS,
  type CostedEvent,
  type RateRule,
  type RateTable,
  type RateVersion,
  type SpendEvent,
  type TokenTier,
  zeroTokens,
} from "./types.js";
import { osloDay } from "./time.js";

/** The RateVersion field that prices a given token tier (USD per 1M tokens). */
const TIER_RATE_FIELD: Record<TokenTier, keyof RateVersion> = {
  input: "inputPerMTok",
  output: "outputPerMTok",
  cacheRead: "cacheReadPerMTok",
  cacheWrite5m: "cacheWrite5mPerMTok",
  cacheWrite1h: "cacheWrite1hPerMTok",
};

/** Escape a string for literal use inside a RegExp (everything but our `*`). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How specific a pattern is: its literal (non-wildcard) character count. */
function literalLength(pattern: string): number {
  return pattern.replace(/\*/g, "").length;
}

/**
 * Does `modelId` match `pattern`? Case-insensitive. A pattern with no `*`
 * matches as a substring; a pattern with `*` is a wildcard anchored end-to-end
 * (`claude-*` matches the whole id, `*haiku*` matches anywhere).
 */
function patternMatches(pattern: string, modelId: string): boolean {
  const haystack = modelId.toLowerCase();
  const needle = pattern.toLowerCase();
  if (!needle.includes("*")) return haystack.includes(needle);
  const source = needle.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(haystack);
}

/**
 * The rate rule governing `modelId`, or null if none match. Matching is
 * case-insensitive; the most specific (longest literal-char) matching rule
 * wins, with ties resolved by table order (first declared).
 */
export function matchModelRule(table: RateTable, modelId: string): RateRule | null {
  let best: RateRule | null = null;
  let bestLen = -1;
  for (const rule of table.rules) {
    if (!patternMatches(rule.modelPattern, modelId)) continue;
    const len = literalLength(rule.modelPattern);
    if (len > bestLen) {
      best = rule;
      bestLen = len;
    }
  }
  return best;
}

/**
 * The rate version in force for an event: the one whose effectiveFrom is the
 * latest date <= the event's Europe/Oslo calendar day. Returns null when no
 * version applies (all effectiveFrom dates are in the future, or none exist).
 */
export function selectRateVersion(rule: RateRule, eventIso: string): RateVersion | null {
  const eventDay = osloDay(eventIso) ?? eventIso.slice(0, 10);
  let best: RateVersion | null = null;
  for (const version of rule.versions) {
    // effectiveFrom and eventDay are both YYYY-MM-DD, so string order == date order.
    if (version.effectiveFrom <= eventDay && (best === null || version.effectiveFrom > best.effectiveFrom)) {
      best = version;
    }
  }
  return best;
}

/**
 * Price one event. usdByTier[tier] = tokens[tier] * ratePerMTok / 1_000_000,
 * usd is their sum. The event is UNRESOLVED (rateResolved:false, usd and
 * usdByTier forced to 0) when no rule matched (unknownModel is set), the rule
 * is a todo placeholder, no version applies, or the version leaves a tier
 * priced at null while that tier carries nonzero tokens. A null rate on a tier
 * with zero tokens is harmless and does not unresolve the event.
 */
export function priceEvent(event: SpendEvent, table: RateTable): CostedEvent {
  const usdByTier = zeroTokens();

  const rule = matchModelRule(table, event.model);
  if (!rule) {
    return { ...event, usd: 0, usdByTier, rateResolved: false, unknownModel: event.model };
  }
  if (rule.todo) {
    return { ...event, usd: 0, usdByTier, rateResolved: false };
  }

  const version = selectRateVersion(rule, event.ts);
  if (!version) {
    return { ...event, usd: 0, usdByTier, rateResolved: false };
  }

  let usd = 0;
  let resolved = true;
  for (const tier of TOKEN_TIERS) {
    const tokens = event.tokens[tier];
    const rate = version[TIER_RATE_FIELD[tier]] as number | null;
    if (rate === null) {
      // A missing price only matters when this tier actually billed tokens.
      if (tokens !== 0) resolved = false;
      continue;
    }
    const cost = (tokens * rate) / 1_000_000;
    usdByTier[tier] = cost;
    usd += cost;
  }

  if (!resolved) {
    // Do not fabricate a partial price: zero everything and flag it.
    return { ...event, usd: 0, usdByTier: zeroTokens(), rateResolved: false };
  }
  return { ...event, usd, usdByTier, rateResolved: true };
}

/** Price a batch of events, preserving order. */
export function priceEvents(events: SpendEvent[], table: RateTable): CostedEvent[] {
  return events.map((event) => priceEvent(event, table));
}

/**
 * The distinct model ids that hit the unknown-model path (no matching rule),
 * sorted. Surface these loudly so the operator can register a rate for them.
 */
export function unknownModels(costed: CostedEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of costed) {
    if (event.unknownModel !== undefined) seen.add(event.unknownModel);
  }
  return [...seen].sort();
}
