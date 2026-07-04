// ──────────────────────────────────────────────────────────────────────────
// Shared vocabulary for the spend subsystem: the priced-event ledger that turns
// on-disk harness transcripts into an API-equivalent cost time series. Every
// spend/* module and src/commands/spend.ts imports these types; kept
// dependency-light (types only) so there is no runtime import cycle.
//
// The headline product is the "leverage multiple": API-equivalent USD (what the
// same token consumption would have cost at published list rates) divided by
// actual subscription cost, as a daily series.
// ──────────────────────────────────────────────────────────────────────────

export type Harness = "claude" | "codex" | "grok" | "opencode";

/**
 * The five token classes we price independently. Cache writes split by TTL tier
 * because Anthropic bills 5-minute and 1-hour ephemeral writes at different
 * rates (usage.cache_creation.ephemeral_5m/1h_input_tokens). A harness that does
 * not distinguish tiers folds all cache-write tokens into cacheWrite5m.
 */
export type TokenTier = "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h";

export const TOKEN_TIERS: readonly TokenTier[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
] as const;

export type TokenCounts = Record<TokenTier, number>;

export function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

/**
 * One assistant message / API call. The atomic ledger row. `id` is the dedup
 * key — stable across re-ingestion of the same source line so a re-run never
 * double-counts. Source coordinates (file + line offset) let us prove
 * provenance and re-price historically without re-reading everything.
 */
export type SpendEvent = {
  /** Dedup key: `${harness}:${requestId||message.id||uuid||contentHash}`. */
  id: string;
  /** ISO-8601 timestamp of the message. */
  ts: string;
  harness: Harness;
  /** Seat id — the config dir this transcript lives under (see Seat.id). */
  seat: string;
  sessionId: string;
  /** Cross-session parent when derivable (honeybee store parentId/forkedFromId). */
  parentSessionId?: string;
  /** True for in-session subagent messages (claude isSidechain / Task tool). */
  isSubagent?: boolean;
  /** Raw provider model id, verbatim (e.g. "claude-haiku-4-5-20251001"). */
  model: string;
  tokens: TokenCounts;
  /** Best-effort count of tool_use blocks in the message. */
  toolUseCount?: number;
  /** Absolute path of the transcript file this row came from. */
  sourceFile: string;
  /** 0-based line index within sourceFile. */
  sourceOffset: number;
};

// ──────────────────────────────────────────────────────────────────────────
// Rates: versioned, human-editable pricing. USD per 1,000,000 tokens.
// ──────────────────────────────────────────────────────────────────────────

/**
 * A price set effective from a date. A null field is an explicit "not known" —
 * it MUST surface on the unknown-rate path, never be treated as zero. Absent
 * (undefined) fields inherit 0 only for token classes a model never bills
 * (e.g. a model with no cache write tier); prefer explicit nulls when unsure.
 */
export type RateVersion = {
  /** ISO date (YYYY-MM-DD). The version in force is the latest one <= event date. */
  effectiveFrom: string;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cacheReadPerMTok: number | null;
  cacheWrite5mPerMTok: number | null;
  cacheWrite1hPerMTok: number | null;
};

export type RateRule = {
  /**
   * Matched against a raw model id by matchModelRule(): case-insensitive. A
   * pattern with no glob chars matches as a substring; `*` is a wildcard. The
   * most specific (longest literal) matching rule wins.
   */
  modelPattern: string;
  provider?: string;
  /** Human note; shown in `spend rates`. */
  note?: string;
  /**
   * Explicit unknown marker. When true, events matching this rule are counted
   * but priced at nothing and flagged loudly — used to register a model id we
   * have seen but not yet priced. A rule may be `todo:true` with empty versions.
   */
  todo?: boolean;
  versions: RateVersion[];
};

export type RateTable = { rules: RateRule[] };

/** The priced view of one event. */
export type CostedEvent = SpendEvent & {
  /** Total API-equivalent USD for this event. */
  usd: number;
  usdByTier: Record<TokenTier, number>;
  /** False when the model hit the unknown/TODO path (usd is 0 and untrustworthy). */
  rateResolved: boolean;
  /** The model id that failed to resolve, echoed for loud reporting. */
  unknownModel?: string;
};

// ──────────────────────────────────────────────────────────────────────────
// Seats: a paying identity. Scaffolded from discovered config dirs; the user
// fills in provider/plan/monthly cost.
// ──────────────────────────────────────────────────────────────────────────

export type Seat = {
  /** Stable id, `${harness}:${configDirBasename}` e.g. "claude:default", "codex:codex-2". */
  id: string;
  harness: Harness;
  /** Absolute path of the transcript config dir this seat owns. */
  configDir: string;
  provider?: string;
  plan?: string;
  /** Actual subscription cost in USD/month. Undefined => not set; excluded from leverage. */
  monthlyUsd?: number;
  /** Human label; defaults to the config dir basename. */
  label?: string;
  /** Linked honeybee vault account id when resolvable, else undefined. */
  accountId?: string;
};

export type SeatsFile = { seats: Seat[] };

// ──────────────────────────────────────────────────────────────────────────
// Report shapes (pure data; formatting is separate).
// ──────────────────────────────────────────────────────────────────────────

export type DailyLedgerRow = {
  /** Europe/Oslo calendar day, YYYY-MM-DD. */
  day: string;
  seat: string;
  model: string;
  tokens: TokenCounts;
  usd: number;
  /** True only if every event in this bucket resolved a rate. */
  rateResolved: boolean;
};

export type LeveragePoint = {
  day: string;
  /** A seat id, or "portfolio" for the machine-wide aggregate. */
  seat: string;
  apiEquivUsd: number;
  /** Subscriptions pro-rated to this single day (monthlyUsd * 12 / 365). */
  actualUsd: number;
  /** apiEquivUsd / actualUsd; null when actualUsd is 0/unknown. */
  leverage: number | null;
  avg7: number | null;
  avg30: number | null;
};

export type SessionRollup = {
  sessionId: string;
  harness: Harness;
  seat: string;
  title?: string;
  apiEquivUsd: number;
  orchestratorUsd: number;
  subagentUsd: number;
  startTs: string;
  endTs: string;
  durationMs: number;
  /** model id -> API-equivalent USD. */
  models: Record<string, number>;
  /** True if any event in the session hit the unknown-rate path. */
  hasUnknownRate: boolean;
};

export type BlendRow = {
  /** Bucket label — Europe/Oslo day or month depending on the report granularity. */
  period: string;
  model: string;
  /** API-equivalent USD by token tier. */
  usdByTier: Record<TokenTier, number>;
  tokensByTier: TokenCounts;
};

/** Persisted between incremental ingests: per source file, how far we consumed. */
export type IngestState = {
  /** sourceFile -> { mtimeMs, lines } consumed so far. */
  files: Record<string, { mtimeMs: number; lines: number }>;
  lastRunIso?: string;
};

export type IngestResult = {
  filesScanned: number;
  eventsAppended: number;
  duplicatesSkipped: number;
  /** Model ids seen that had no resolved (non-todo) rate. Surface loudly. */
  unknownModels: string[];
  /** Seats newly discovered this run (added to seats.json as scaffolds). */
  newSeats: string[];
};
