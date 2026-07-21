// ──────────────────────────────────────────────────────────────────────────
// Provider limit windows (Phase 3 follow-up): remaining 5h/weekly usage
// relative to the REAL limits, per account.
//
// This is the dispatch layer: it routes each account to its provider's fetcher
// (the self-contained zai/minimax/moonshot/cursor/xai adapters on the
// registry, or the heavyweight claude/codex paths in ./claude and ./codex)
// and stamps the additive `provider` field uniformly.
// ──────────────────────────────────────────────────────────────────────────

import { resolve } from "node:path";
import { type AccountRecord, PROVIDER_BY_CLI, listAccounts } from "../accounts.js";
import { mapWithConcurrency } from "../concurrency.js";
import { readClaudeKeychain } from "../keychain.js";
import { providerAdapter } from "../providers.js";
import { claudeLimits } from "./claude.js";
import { codexLimits } from "./codex.js";
import type { AccountLimits, LimitsDeps } from "./types.js";

const ACCOUNT_LIMITS_CONCURRENCY = 4;

function memoizeKeychainReads(readKeychain: typeof readClaudeKeychain): typeof readClaudeKeychain {
  const byHome = new Map<string, Promise<string | null>>();
  return (homePath: string) => {
    const key = resolve(homePath);
    const cached = byHome.get(key);
    if (cached) return cached;
    const read = readKeychain(homePath).catch((error: unknown) => {
      byHome.delete(key);
      throw error;
    });
    byHome.set(key, read);
    return read;
  };
}

/**
 * Provider-keyed limits dispatch. A CYCLE-FREE hybrid: self-contained provider
 * fetchers (zai/minimax) live on the registry adapter in providers.ts (which
 * imports limits' TYPES ONLY); the heavyweight anthropic/openai paths live in
 * ./claude and ./codex and are reached by an explicit provider check, so the
 * registry never has to import claudeLimits/codexLimits at runtime. Output for
 * existing claude/codex accounts is identical except for the additive
 * `provider` field, which is stamped uniformly below.
 */
export async function accountLimits(accounts: AccountRecord[], deps: LimitsDeps = {}): Promise<AccountLimits[]> {
  const sweepDeps: LimitsDeps = { ...deps, readKeychain: memoizeKeychainReads(deps.readKeychain ?? readClaudeKeychain) };
  return mapWithConcurrency(
    accounts,
    ACCOUNT_LIMITS_CONCURRENCY,
    async (account) => {
      // Dispatch on the effective provider: the record's own provider when
      // present, else inferred from its cli. Belt-and-suspenders so the dispatch
      // is robust even for a raw AccountRecord that never flowed through
      // listAccounts' backfill (callers normally pass normalized records). The
      // `provider` field is still STAMPED only from the literal account.provider,
      // so a normalized record's output is byte-identical and an un-normalized
      // one routes correctly without gaining a synthesized field.
      const provider = account.provider ?? PROVIDER_BY_CLI[account.tool];
      const stampProvider = (limits: AccountLimits): AccountLimits =>
        account.provider ? { ...limits, provider: account.provider } : limits;
      try {
        const adapter = providerAdapter(provider);
        if (adapter?.fetchLimits) return stampProvider(await adapter.fetchLimits(account, sweepDeps));
        if (provider === "anthropic") return stampProvider(await claudeLimits(account, sweepDeps));
        if (provider === "openai") return stampProvider(await codexLimits(account, sweepDeps));
        return stampProvider({
          account: account.id,
          tool: account.tool,
          ok: false,
          source: "unsupported" as const,
          // fix #8: never print "undefined …" for a provider-less (legacy
          // opencode) account.
          error: provider ? `${provider} has no limits source` : "account has no provider",
        });
      } catch (error) {
        return stampProvider({
          account: account.id,
          tool: account.tool,
          ok: false,
          source: provider === "anthropic" ? ("oauth-api" as const) : ("session-snapshot" as const),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

export async function allAccountLimits(deps: LimitsDeps = {}): Promise<AccountLimits[]> {
  return accountLimits(await listAccounts(), deps);
}

/**
 * Display order for the limits table: claude first, codex next, everything
 * else grouped by tool name; registration order preserved within a group
 * (sort is stable), so accounts of one tool never interleave with another's.
 */
const LIMITS_DISPLAY_RANK: Record<string, number> = { claude: 0, codex: 1 };

export function sortAccountsForLimitsDisplay(accounts: AccountRecord[]): AccountRecord[] {
  return [...accounts].sort(
    (a, b) => (LIMITS_DISPLAY_RANK[a.tool] ?? 2) - (LIMITS_DISPLAY_RANK[b.tool] ?? 2) || a.tool.localeCompare(b.tool),
  );
}
