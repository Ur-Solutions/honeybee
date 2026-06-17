// Autoswap dispatcher (Phase 3 patch 3.6) — the default, OPT-IN flow that
// turns account.exhausted facts into swap-account calls.
//
// Policy is deliberately deterministic and transparent: a bee participates
// only when its SessionRecord has autoswap=true; the replacement account is
// picked by least-recently-exhausted round-robin (never-exhausted accounts
// first, oldest registration first). Every swap is ledger-logged by the
// primitive. Disable the dispatcher (or never opt in) and the same primitive
// remains drivable from Hermes/a manager/cron — honeybee never hides the
// rotation.

import { accountHasCredentials, listAccounts, type AccountRecord } from "../accounts.js";
import { canonicalAgentKind } from "../agents.js";
import { swapAccount } from "../swap.js";
import type { SessionRecord } from "../store.js";
import { isRecentlyExhausted, usageSummary, type UsageSummary } from "../usage.js";
import type { UsageTickOutcome } from "./usageSampler.js";

export type AutoswapOutcome = {
  bee: string;
  from: string;
  to?: string;
  ok: boolean;
  /** Why no swap happened (no candidate, bee not opted in resolved earlier, ...). */
  skipped?: string;
  error?: string;
};

export type AutoswapDeps = {
  listAccounts?: typeof listAccounts;
  accountHasCredentials?: typeof accountHasCredentials;
  usageSummary?: (accountId: string, now: number) => Promise<UsageSummary>;
  swapAccount?: typeof swapAccount;
  now?: () => number;
};

export type AutoswapCandidate = {
  account: AccountRecord;
  summary: UsageSummary;
};

/**
 * Deterministic selection: never-exhausted accounts first (by addedAt, then id),
 * then least-recently-exhausted. Accounts still inside their exhaustion
 * cool-off are excluded entirely.
 */
export function selectSwapTarget(candidates: AutoswapCandidate[], now: number): AccountRecord | null {
  const eligible = candidates.filter((candidate) => !isRecentlyExhausted(candidate.summary, now));
  eligible.sort((a, b) => {
    const aExhausted = a.summary.lastExhaustedAt ?? "";
    const bExhausted = b.summary.lastExhaustedAt ?? "";
    if (!aExhausted && bExhausted) return -1;
    if (aExhausted && !bExhausted) return 1;
    if (aExhausted !== bExhausted) return aExhausted.localeCompare(bExhausted);
    if (a.account.addedAt !== b.account.addedAt) return a.account.addedAt.localeCompare(b.account.addedAt);
    return a.account.id.localeCompare(b.account.id);
  });
  return eligible[0]?.account ?? null;
}

export async function dispatchAutoswaps(
  records: SessionRecord[],
  usageOutcomes: UsageTickOutcome[],
  deps: AutoswapDeps = {},
): Promise<AutoswapOutcome[]> {
  const triggers = usageOutcomes.filter((outcome) => outcome.exhausted);
  if (triggers.length === 0) return [];

  const byName = new Map<string, SessionRecord>();
  for (const record of records) byName.set(record.name, record);

  const resolveAccounts = deps.listAccounts ?? listAccounts;
  const hasCredentials = deps.accountHasCredentials ?? accountHasCredentials;
  const summarize = deps.usageSummary ?? ((accountId: string, now: number) => usageSummary(accountId, now));
  const swap = deps.swapAccount ?? swapAccount;
  const now = (deps.now ?? Date.now)();

  const outcomes: AutoswapOutcome[] = [];
  for (const trigger of triggers) {
    const record = byName.get(trigger.bee);
    if (!record || record.autoswap !== true || !record.accountId) continue;

    const outcome: AutoswapOutcome = { bee: record.name, from: record.accountId, ok: false };
    try {
      const tool = canonicalAgentKind(record.agent).toLowerCase();
      const all = await resolveAccounts();
      // The bee's current account's provider scopes the candidate pool so a glm
      // bee never swaps to a minimax account that merely shares the opencode
      // CLI. TOLERATE undefined (fix #9): require provider equality only when
      // BOTH sides are defined; otherwise fall back to tool-only (legacy
      // single-provider-per-cli back-compat).
      const fromProvider = all.find((account) => account.id === record.accountId)?.provider;
      const accounts = all.filter(
        (account) =>
          account.tool === tool &&
          account.id !== record.accountId &&
          (fromProvider === undefined || account.provider === undefined || account.provider === fromProvider),
      );
      const candidates: AutoswapCandidate[] = [];
      for (const account of accounts) {
        if (!(await hasCredentials(account))) continue;
        candidates.push({ account, summary: await summarize(account.id, now) });
      }
      const target = selectSwapTarget(candidates, now);
      if (!target) {
        outcome.skipped = "no non-exhausted account with vaulted credentials available";
        outcomes.push(outcome);
        continue;
      }
      await swap(record, target);
      outcome.to = target.id;
      outcome.ok = true;
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    outcomes.push(outcome);
  }
  return outcomes;
}
