import { resolve } from "node:path";
import { identityRecipeForAgent } from "../drivers.js";
import {
  listAccounts,
  syncAccountCredentialsToVault,
  type AccountCredentialSyncResult,
  type AccountRecord,
} from "../accounts.js";
import { dedicatedHomesFor } from "../accounts/homes.js";
import { listSessions, type SessionRecord } from "../store.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";

/** One canonical account/home candidate retained from session history. */
export type CredentialSweepPair = {
  id: number;
  account: AccountRecord;
  homePath: string;
  /** The freshest/current SessionRecord proving this pair is attributable. */
  evidence: SessionRecord;
  /** True when the account-only sweep already enumerates this dedicated home. */
  coveredByAccountSweep: boolean;
};

export type CredentialSweepPlan = {
  accounts: AccountRecord[];
  pairs: CredentialSweepPair[];
  extraPairs: CredentialSweepPair[];
  attemptedPairs: number;
  uniquePairs: number;
  skippedPairs: number;
  duplicatePairs: number;
  canonicalCoveredPairs: number;
  unknownAccountPairs: number;
};

/** Secret-free counters/timings emitted for every daemon credential sweep. */
export type CredentialSweepTelemetry = {
  durationMs: number;
  attemptedAccounts: number;
  completedAccounts: number;
  failedAccounts: number;
  attemptedPairs: number;
  uniquePairs: number;
  scheduledPairs: number;
  skippedPairs: number;
  duplicatePairs: number;
  canonicalCoveredPairs: number;
  unknownAccountPairs: number;
  completedPairs: number;
  failedPairs: number;
  timedOutPairs: number;
  vaultUpdates: number;
};

export type CredentialSweepProgress =
  | { type: "plan"; telemetry: CredentialSweepTelemetry }
  | { type: "work-start"; workId: number; pairIds: number[] }
  | { type: "work-end"; workId: number }
  | { type: "complete"; telemetry: CredentialSweepTelemetry };

export type CredentialSweepDeps = {
  listAccounts: () => Promise<AccountRecord[]>;
  listSessions: () => Promise<SessionRecord[]>;
  syncAccount: (
    account: AccountRecord,
    extraHome?: string,
    options?: { trustExtraHome?: boolean },
  ) => Promise<AccountCredentialSyncResult>;
  now: () => number;
  concurrency: number;
  onProgress?: (progress: CredentialSweepProgress) => void;
};

const DEFAULT_ACCOUNT_CONCURRENCY = 4;

function canonicalPairKey(accountId: string, homePath: string): string {
  return `${accountId}\0${resolve(homePath)}`;
}

function evidenceTime(record: SessionRecord): number {
  for (const value of [record.updatedAt, record.lastPromptAt, record.createdAt]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function evidenceIsCurrent(record: SessionRecord): boolean {
  // done/dead records describe closed runtimes. kill_failed is intentionally
  // current: the runtime may still be alive and rotating the home credential.
  return record.status !== "done" && record.status !== "dead";
}

function preferEvidence(candidate: SessionRecord, current: SessionRecord): boolean {
  const candidateCurrent = evidenceIsCurrent(candidate);
  const currentCurrent = evidenceIsCurrent(current);
  if (candidateCurrent !== currentCurrent) return candidateCurrent;
  const candidateTime = evidenceTime(candidate);
  const currentTime = evidenceTime(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return candidate.name.localeCompare(current.name) > 0;
}

/**
 * Collapse all historical SessionRecords to canonical (accountId, resolved
 * homePath) pairs. A current record beats retired history; within the same
 * lifecycle class the newest evidence wins. Distinct historical homes remain
 * in the plan because they may contain the only fresh rotated credential.
 */
export function planCredentialSweep(records: readonly SessionRecord[], allAccounts: readonly AccountRecord[]): CredentialSweepPlan {
  const accounts = allAccounts.filter((account) => identityRecipeForAgent(account.tool));
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const evidenceByPair = new Map<string, { accountId: string; homePath: string; evidence: SessionRecord }>();
  let attemptedPairs = 0;

  for (const record of records) {
    const accountId = record.accountId?.trim();
    const rawHome = record.homePath?.trim();
    if (!accountId || !rawHome) continue;
    attemptedPairs += 1;
    const homePath = resolve(rawHome);
    const key = canonicalPairKey(accountId, homePath);
    const existing = evidenceByPair.get(key);
    if (!existing || preferEvidence(record, existing.evidence)) {
      evidenceByPair.set(key, { accountId, homePath, evidence: record });
    }
  }

  const uniquePairs = evidenceByPair.size;
  const duplicatePairs = attemptedPairs - uniquePairs;
  const known: Array<Omit<CredentialSweepPair, "id">> = [];
  let unknownAccountPairs = 0;
  for (const candidate of evidenceByPair.values()) {
    const account = accountsById.get(candidate.accountId);
    if (!account) {
      unknownAccountPairs += 1;
      continue;
    }
    const canonicalHomes = new Set(dedicatedHomesFor(account).map((home) => resolve(home)));
    known.push({
      account,
      homePath: candidate.homePath,
      evidence: candidate.evidence,
      coveredByAccountSweep: canonicalHomes.has(candidate.homePath),
    });
  }

  // Start current/fresh evidence first. The account grouping in runCredentialSweep
  // preserves this order within each account pipeline.
  known.sort((a, b) => {
    const currentDelta = Number(evidenceIsCurrent(b.evidence)) - Number(evidenceIsCurrent(a.evidence));
    if (currentDelta !== 0) return currentDelta;
    const timeDelta = evidenceTime(b.evidence) - evidenceTime(a.evidence);
    if (timeDelta !== 0) return timeDelta;
    return canonicalPairKey(a.account.id, a.homePath).localeCompare(canonicalPairKey(b.account.id, b.homePath));
  });
  const pairs = known.map((pair, id) => ({ ...pair, id }));
  const extraPairs = pairs.filter((pair) => !pair.coveredByAccountSweep);
  const canonicalCoveredPairs = pairs.length - extraPairs.length;

  return {
    accounts,
    pairs,
    extraPairs,
    attemptedPairs,
    uniquePairs,
    skippedPairs: duplicatePairs + canonicalCoveredPairs + unknownAccountPairs,
    duplicatePairs,
    canonicalCoveredPairs,
    unknownAccountPairs,
  };
}

function initialTelemetry(plan: CredentialSweepPlan): CredentialSweepTelemetry {
  return {
    durationMs: 0,
    attemptedAccounts: plan.accounts.length,
    completedAccounts: 0,
    failedAccounts: 0,
    attemptedPairs: plan.attemptedPairs,
    uniquePairs: plan.uniquePairs,
    scheduledPairs: plan.extraPairs.length,
    skippedPairs: plan.skippedPairs,
    duplicatePairs: plan.duplicatePairs,
    canonicalCoveredPairs: plan.canonicalCoveredPairs,
    unknownAccountPairs: plan.unknownAccountPairs,
    completedPairs: 0,
    failedPairs: 0,
    timedOutPairs: 0,
    vaultUpdates: 0,
  };
}

/**
 * Execute one real sweep. Each account is an independent sequential pipeline:
 * canonical account scan first, then only session homes that scan cannot find.
 * Pipelines run with bounded concurrency so one slow account does not prevent
 * unrelated accounts from reaching their fresh credentials before the worker's
 * process deadline.
 */
export async function runCredentialSweep(
  overrides: Partial<CredentialSweepDeps> = {},
): Promise<CredentialSweepTelemetry> {
  const deps: CredentialSweepDeps = {
    listAccounts,
    listSessions,
    syncAccount: syncAccountCredentialsToVault,
    now: Date.now,
    concurrency: envConcurrency("HIVE_DAEMON_CHAIN_SYNC_CONCURRENCY", DEFAULT_ACCOUNT_CONCURRENCY),
    ...overrides,
  };
  const startedAt = deps.now();
  const [accounts, records] = await Promise.all([deps.listAccounts(), deps.listSessions()]);
  const plan = planCredentialSweep(records, accounts);
  const telemetry = initialTelemetry(plan);
  deps.onProgress?.({ type: "plan", telemetry: { ...telemetry } });

  const extraByAccount = new Map<string, CredentialSweepPair[]>();
  for (const pair of plan.extraPairs) {
    const accountPairs = extraByAccount.get(pair.account.id) ?? [];
    accountPairs.push(pair);
    extraByAccount.set(pair.account.id, accountPairs);
  }
  const canonicalPairIds = new Map<string, number[]>();
  for (const pair of plan.pairs) {
    if (!pair.coveredByAccountSweep) continue;
    const ids = canonicalPairIds.get(pair.account.id) ?? [];
    ids.push(pair.id);
    canonicalPairIds.set(pair.account.id, ids);
  }

  let nextWorkId = 1;
  await mapWithConcurrency(plan.accounts, deps.concurrency, async (account) => {
    const accountWorkId = nextWorkId++;
    deps.onProgress?.({ type: "work-start", workId: accountWorkId, pairIds: canonicalPairIds.get(account.id) ?? [] });
    try {
      const result = await deps.syncAccount(account);
      telemetry.completedAccounts += 1;
      if (result.vaultUpdated) telemetry.vaultUpdates += 1;
    } catch {
      telemetry.failedAccounts += 1;
    } finally {
      deps.onProgress?.({ type: "work-end", workId: accountWorkId });
    }

    for (const pair of extraByAccount.get(account.id) ?? []) {
      const pairWorkId = nextWorkId++;
      deps.onProgress?.({ type: "work-start", workId: pairWorkId, pairIds: [pair.id] });
      try {
        const result = await deps.syncAccount(account, pair.homePath, { trustExtraHome: true });
        telemetry.completedPairs += 1;
        if (result.vaultUpdated) telemetry.vaultUpdates += 1;
      } catch {
        telemetry.failedPairs += 1;
      } finally {
        deps.onProgress?.({ type: "work-end", workId: pairWorkId });
      }
    }
  });

  telemetry.durationMs = Math.max(0, deps.now() - startedAt);
  deps.onProgress?.({ type: "complete", telemetry: { ...telemetry } });
  return telemetry;
}

/** One trusted SessionRecord pair, used for the bounded post-exit harvest. */
export async function runCredentialPairSync(
  accountId: string,
  homePath: string,
  overrides: Pick<Partial<CredentialSweepDeps>, "listAccounts" | "syncAccount" | "now" | "onProgress"> = {},
): Promise<CredentialSweepTelemetry> {
  const deps = {
    listAccounts,
    syncAccount: syncAccountCredentialsToVault,
    now: Date.now,
    ...overrides,
  };
  const startedAt = deps.now();
  const account = (await deps.listAccounts()).find(
    (candidate) => candidate.id === accountId && Boolean(identityRecipeForAgent(candidate.tool)),
  );
  const result: CredentialSweepTelemetry = {
    durationMs: 0,
    attemptedAccounts: 0,
    completedAccounts: 0,
    failedAccounts: 0,
    attemptedPairs: 1,
    uniquePairs: 1,
    scheduledPairs: account ? 1 : 0,
    skippedPairs: account ? 0 : 1,
    duplicatePairs: 0,
    canonicalCoveredPairs: 0,
    unknownAccountPairs: account ? 0 : 1,
    completedPairs: 0,
    failedPairs: 0,
    timedOutPairs: 0,
    vaultUpdates: 0,
  };
  deps.onProgress?.({ type: "plan", telemetry: { ...result } });
  if (!account) {
    result.durationMs = Math.max(0, deps.now() - startedAt);
    deps.onProgress?.({ type: "complete", telemetry: { ...result } });
    return result;
  }

  deps.onProgress?.({ type: "work-start", workId: 1, pairIds: [0] });
  try {
    const synced = await deps.syncAccount(account, resolve(homePath), { trustExtraHome: true });
    result.completedPairs = 1;
    if (synced.vaultUpdated) result.vaultUpdates = 1;
  } catch {
    result.failedPairs = 1;
  } finally {
    deps.onProgress?.({ type: "work-end", workId: 1 });
  }
  result.durationMs = Math.max(0, deps.now() - startedAt);
  deps.onProgress?.({ type: "complete", telemetry: { ...result } });
  return result;
}
