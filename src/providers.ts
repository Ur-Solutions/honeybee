// ──────────────────────────────────────────────────────────────────────────
// Provider adapters. Keyed by provider id (the "who/which quota"), distinct
// from the CLI driver (the "how to launch"). An account is a (cli, provider)
// pair; this registry is the provider half.
//
// S1 SCAFFOLD ONLY. The adapter shape carries OPTIONAL fetchLimits/isExhausted/
// login slots so S3 can move the `account.tool` switch out of limits.ts into
// here without a new-file churn — but none of them are implemented and there
// are NO production callers in S1. Only providerAdapter()/hasProviderAdapter()
// are exercised (by tests).
//
// Heavy types are imported as TYPES ONLY to keep this a leaf module — the
// optional fn signatures must not pull accounts.ts / limits.ts / drivers.ts
// into a runtime import cycle.
// ──────────────────────────────────────────────────────────────────────────

import type { AccountRecord } from "./accounts.js";
import type { AccountLimits, LimitsDeps } from "./limits.js";
import type { ExhaustionHit } from "./drivers.js";

export type ProviderId =
  | "anthropic"
  | "openai"
  | "xai"
  | "moonshot"
  | "minimax-coding-plan"
  | "zai-coding-plan"
  | "kimi-for-coding";

export type ProviderAdapter = {
  id: ProviderId;
  baseURL?: string;
  defaultModel?: string;
  models?: () => Promise<string[]> | string[];
  // ── S3 wires these in; UNIMPLEMENTED in S1 (typed scaffold only) ──────────
  /** Fetch the provider's real 5h/weekly quota windows for an account. */
  fetchLimits?: (account: AccountRecord, deps?: LimitsDeps) => Promise<AccountLimits>;
  /** Optional pane-level exhaustion signal at provider granularity. */
  isExhausted?: (pane: string) => ExhaustionHit | null;
  /** Provider-specific login flow into an account's isolated home. */
  login?: (account: AccountRecord, homePath: string) => Promise<void>;
};

// All 7 provider ids. `moonshot` is the kimi-code single-provider CLI account;
// `kimi-for-coding` is the opencode-hosted Kimi provider — distinct accounts,
// both registered.
const PROVIDERS: Record<string, ProviderAdapter> = {
  anthropic: { id: "anthropic", baseURL: "https://api.anthropic.com" },
  openai: { id: "openai" },
  xai: { id: "xai" },
  moonshot: { id: "moonshot" },
  "minimax-coding-plan": { id: "minimax-coding-plan" },
  "zai-coding-plan": { id: "zai-coding-plan" },
  "kimi-for-coding": { id: "kimi-for-coding" },
};

/** The adapter for a provider id, or undefined for an unknown/absent id. */
export function providerAdapter(id: string | undefined): ProviderAdapter | undefined {
  return id ? PROVIDERS[id] : undefined;
}

/** True when a provider id has a registered adapter. */
export function hasProviderAdapter(id: string | undefined): boolean {
  return id ? id in PROVIDERS : false;
}
