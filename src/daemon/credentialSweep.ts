import { resolve } from "node:path";
import { identityRecipeForAgent } from "../drivers.js";
import {
  canonicalActivationHomePath,
  listAccounts,
  readActivationHomeOwner,
  syncAccountCredentialsToVault,
  withActivationHomeLock,
  type AccountCredentialSyncResult,
  type AccountRecord,
} from "../accounts.js";
import {
  beginCredentialHarvestAttempt,
  credentialHarvestHomeIdentityMatches,
  listCredentialHarvestWorkItems,
  recordCredentialHarvestAttempt,
  removeCredentialHarvestWorkItem,
  type CredentialHarvestAttemptOutcome,
  type CredentialHarvestWorkItem,
} from "../accounts/credentialHarvestQueue.js";
import type { SyncAccountCredentialsOptions } from "../accounts/credentialSync.js";
import { candidateHomes, dedicatedHomesFor } from "../accounts/homes.js";
import { isActiveSessionRecord, listSessions, type SessionRecord } from "../store.js";
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
  /** Canonicalized legacy/current ownership evidence for authorization. */
  bindings: Array<{ homePath: string; record: SessionRecord }>;
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
  quarantinedItems: number;
  completedQuarantinedItems: number;
  retainedQuarantinedItems: number;
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
    options?: SyncAccountCredentialsOptions,
  ) => Promise<AccountCredentialSyncResult>;
  accountHomes: (account: AccountRecord) => Promise<string[]>;
  listQuarantined: () => Promise<CredentialHarvestWorkItem[]>;
  now: () => number;
  concurrency: number;
  onProgress?: (progress: CredentialSweepProgress) => void;
};

const DEFAULT_ACCOUNT_CONCURRENCY = 4;

function canonicalPairKey(accountId: string, homePath: string): string {
  return `${accountId}\0${homePath}`;
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
export async function planCredentialSweep(
  records: readonly SessionRecord[],
  allAccounts: readonly AccountRecord[],
): Promise<CredentialSweepPlan> {
  const accounts = allAccounts.filter((account) => identityRecipeForAgent(account.tool));
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const evidenceByPair = new Map<string, { accountId: string; homePath: string; evidence: SessionRecord }>();
  const bindings: CredentialSweepPlan["bindings"] = [];
  const canonicalPaths = new Map<string, Promise<string>>();
  const canonicalize = (homePath: string): Promise<string> => {
    const lexical = resolve(homePath);
    const existing = canonicalPaths.get(lexical);
    if (existing) return existing;
    const pending = canonicalActivationHomePath(lexical);
    canonicalPaths.set(lexical, pending);
    return pending;
  };
  let attemptedPairs = 0;

  for (const record of records) {
    const accountId = record.accountId?.trim();
    const rawHome = record.homePath?.trim();
    if (!accountId || !rawHome) continue;
    attemptedPairs += 1;
    let homePath: string;
    try {
      homePath = await canonicalize(rawHome);
    } catch {
      // Ambiguous/dangling paths are never candidates for credential reads.
      continue;
    }
    bindings.push({ homePath, record });
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
    const canonicalHomes = new Set(await Promise.all(dedicatedHomesFor(account).map(canonicalize)));
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
    bindings,
  };
}

/**
 * Build one sweep-scoped home enumerator. Shared ~/.tool slot discovery is a
 * filesystem scan, but its result depends only on the tool, not the account;
 * cache the in-flight scan so N accounts of one provider do it once.
 */
export function createDefaultAccountHomes(
  scanCandidates: (tool: string) => Promise<string[]> = candidateHomes,
): (account: AccountRecord) => Promise<string[]> {
  const candidatesByTool = new Map<string, Promise<string[]>>();
  return async (account) => {
    const homes = [...dedicatedHomesFor(account)];
    if (account.tool === "claude" || account.tool === "codex" || account.tool === "grok") {
      let candidates = candidatesByTool.get(account.tool);
      if (!candidates) {
        candidates = scanCandidates(account.tool);
        candidatesByTool.set(account.tool, candidates);
      }
      homes.push(...await candidates);
    }
    // Remove lexical duplicates before the later realpath/canonical ownership
    // scan. Physical aliases are still collapsed by that safety-critical pass.
    return [...new Map(homes.map((home) => [resolve(home), home])).values()];
  };
}

function legacyOwnBinding(
  plan: CredentialSweepPlan,
  accountId: string,
  canonicalHomePath: string,
  evidence?: SessionRecord,
): SessionRecord | null {
  let ownEvidence = evidence;
  if (!ownEvidence) {
    for (const binding of plan.bindings) {
      if (binding.homePath !== canonicalHomePath || binding.record.accountId !== accountId) continue;
      if (!ownEvidence || preferEvidence(binding.record, ownEvidence)) ownEvidence = binding.record;
    }
  }
  return ownEvidence ?? null;
}

function legacyForeignBinding(
  plan: CredentialSweepPlan,
  accountId: string,
  canonicalHomePath: string,
  ownEvidence: SessionRecord,
): SessionRecord | null {
  return foreignBindingAfter(plan, accountId, canonicalHomePath, evidenceTime(ownEvidence));
}

function foreignBindingAfter(
  plan: CredentialSweepPlan,
  accountId: string,
  canonicalHomePath: string,
  ownTime: number,
): SessionRecord | null {
  const foreign = plan.bindings
    .filter((binding) =>
      binding.homePath === canonicalHomePath &&
      Boolean(binding.record.accountId) &&
      binding.record.accountId !== accountId &&
      (isActiveSessionRecord(binding.record) || evidenceTime(binding.record) > ownTime))
    .map((binding) => binding.record)
    .sort((a, b) => {
      const activeDelta = Number(isActiveSessionRecord(b)) - Number(isActiveSessionRecord(a));
      return activeDelta || evidenceTime(b) - evidenceTime(a);
    });
  return foreign[0] ?? null;
}

async function withAuthorizedSweepHome<T>(
  plan: CredentialSweepPlan,
  account: AccountRecord,
  homePath: string,
  evidence: SessionRecord | undefined,
  fn: (canonicalHomePath: string, stampedOwner: boolean) => Promise<T>,
): Promise<{ authorized: boolean; value?: T }> {
  return withActivationHomeLock(homePath, async (canonicalHomePath) => {
    const owner = await readActivationHomeOwner(canonicalHomePath);
    let stampedOwner = false;
    if (owner) {
      if (owner.state !== "ready" || owner.accountId !== account.id) return { authorized: false };
      const ownerTime = Date.parse(owner.updatedAt);
      if (
        !Number.isFinite(ownerTime) ||
        foreignBindingAfter(plan, account.id, canonicalHomePath, ownerTime)
      ) return { authorized: false };
      stampedOwner = true;
    } else {
      // A nominal/dedicated pathname is not ownership proof: public --home
      // activation can rebind it, and pre-upgrade homes have no durable owner
      // stamp. Require affirmative same-account SessionRecord evidence, then
      // reject any newer or live foreign binding for the same physical home.
      const ownEvidence = legacyOwnBinding(plan, account.id, canonicalHomePath, evidence);
      if (!ownEvidence || legacyForeignBinding(plan, account.id, canonicalHomePath, ownEvidence)) {
        return { authorized: false };
      }
    }
    return { authorized: true, value: await fn(canonicalHomePath, stampedOwner) };
  });
}

type QuarantinedHarvestDeps = Pick<
  CredentialSweepDeps,
  "syncAccount" | "now"
>;

/**
 * Consume one purged-record recovery handle under the canonical home lock.
 * The provider sync takes the account lock inside this callback, preserving
 * lifecycle -> home -> account lock order. Every stale/rebound/replaced shape
 * stays quarantined; only a completed, content-authorized sync may delete it.
 */
async function consumeQuarantinedHarvest(
  item: CredentialHarvestWorkItem,
  account: AccountRecord | undefined,
  plan: CredentialSweepPlan,
  deps: QuarantinedHarvestDeps,
): Promise<{ removed: boolean; vaultUpdated: boolean }> {
  return withActivationHomeLock(item.home.path, async (canonicalHomePath) => {
    let current = await beginCredentialHarvestAttempt(item, deps.now);
    if (!current) return { removed: false, vaultUpdated: false };
    const retain = async (outcome: CredentialHarvestAttemptOutcome): Promise<{ removed: false; vaultUpdated: false }> => {
      current = await recordCredentialHarvestAttempt(current!, outcome, deps.now) ?? current;
      return { removed: false, vaultUpdated: false };
    };

    if (canonicalHomePath !== item.home.path || !(await credentialHarvestHomeIdentityMatches(item.home))) {
      return retain("home-replaced");
    }
    if (!account) return retain("unknown-account");

    let owner;
    try {
      owner = await readActivationHomeOwner(canonicalHomePath);
    } catch {
      return retain("sync-failed");
    }
    if (item.evidence.kind === "activation-owner") {
      if (
        !owner ||
        owner.accountId !== item.accountId ||
        owner.generation !== item.evidence.ownerGeneration
      ) return retain("home-rebound");
      if (owner.state !== "ready") return retain("owner-incomplete");
      const ownerTime = Date.parse(owner.updatedAt);
      if (!Number.isFinite(ownerTime) || foreignBindingAfter(plan, item.accountId, canonicalHomePath, ownerTime)) {
        return retain("home-rebound");
      }
    } else {
      // An unstamped legacy association is valid only while it remains the
      // latest evidence. Any owner generation (even the same account) is a
      // later activation and must not inherit this stale queue capability.
      if (owner) return retain("home-rebound");
      const evidenceTime = Date.parse(item.evidence.sessionUpdatedAt);
      if (!Number.isFinite(evidenceTime) || foreignBindingAfter(plan, item.accountId, canonicalHomePath, evidenceTime)) {
        return retain("home-rebound");
      }
    }

    try {
      const result = await deps.syncAccount(account, canonicalHomePath, {
        authorization: "automatic",
        trustExtraHome: true,
        homeScope: "extra-only",
        requirePositiveHomeEvidence: true,
      });
      // Automatic provider identity/content rejection is a normal return, not
      // an exception. It is never positive harvest evidence and must retain
      // the item for a later rotated credential or explicit operator action.
      if (result.skipped.length > 0) return retain("content-rejected");
      if (result.harvested !== true) return retain("no-credential-evidence");
      return {
        removed: await removeCredentialHarvestWorkItem(current),
        vaultUpdated: result.vaultUpdated,
      };
    } catch {
      return retain("sync-failed");
    }
  });
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
    quarantinedItems: 0,
    completedQuarantinedItems: 0,
    retainedQuarantinedItems: 0,
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
  const accountHomes = overrides.accountHomes ?? createDefaultAccountHomes();
  const deps: CredentialSweepDeps = {
    listAccounts,
    listSessions,
    syncAccount: syncAccountCredentialsToVault,
    listQuarantined: listCredentialHarvestWorkItems,
    now: Date.now,
    concurrency: envConcurrency("HIVE_DAEMON_CHAIN_SYNC_CONCURRENCY", DEFAULT_ACCOUNT_CONCURRENCY),
    ...overrides,
    accountHomes,
  };
  const startedAt = deps.now();
  const [accounts, records, quarantined] = await Promise.all([
    deps.listAccounts(),
    deps.listSessions(),
    deps.listQuarantined(),
  ]);
  const plan = await planCredentialSweep(records, accounts);
  const telemetry = initialTelemetry(plan);
  telemetry.quarantinedItems = quarantined.length;
  telemetry.retainedQuarantinedItems = quarantined.length;

  // Resolve the account scan before emitting its plan so physical aliases are
  // scheduled once even when a session pair spells the same home differently.
  const accountHomesById = new Map<string, Map<string, string>>();
  const dedicatedHomesById = new Map<string, Set<string>>();
  const accountHomeErrors = new Set<string>();
  for (const account of plan.accounts) {
    dedicatedHomesById.set(account.id, new Set(await Promise.all(
      dedicatedHomesFor(account).map((home) => canonicalActivationHomePath(home)),
    )));
    const homes = new Map<string, string>();
    for (const rawHome of await deps.accountHomes(account)) {
      try {
        const canonicalHome = await canonicalActivationHomePath(rawHome);
        if (!homes.has(canonicalHome)) homes.set(canonicalHome, rawHome);
      } catch {
        accountHomeErrors.add(account.id);
      }
    }
    accountHomesById.set(account.id, homes);
  }

  const extraByAccount = new Map<string, CredentialSweepPair[]>();
  let additionallyCovered = 0;
  for (const pair of plan.extraPairs) {
    if (accountHomesById.get(pair.account.id)?.has(pair.homePath)) {
      additionallyCovered += 1;
      continue;
    }
    const accountPairs = extraByAccount.get(pair.account.id) ?? [];
    accountPairs.push(pair);
    extraByAccount.set(pair.account.id, accountPairs);
  }
  telemetry.scheduledPairs = plan.extraPairs.length - additionallyCovered;
  telemetry.canonicalCoveredPairs += additionallyCovered;
  telemetry.skippedPairs += additionallyCovered;
  deps.onProgress?.({ type: "plan", telemetry: { ...telemetry } });
  const canonicalPairIds = new Map<string, number[]>();
  for (const pair of plan.pairs) {
    if (!pair.coveredByAccountSweep) continue;
    const ids = canonicalPairIds.get(pair.account.id) ?? [];
    ids.push(pair.id);
    canonicalPairIds.set(pair.account.id, ids);
  }

  let nextWorkId = 1;
  const accountsById = new Map(plan.accounts.map((account) => [account.id, account]));
  const quarantinedByAccount = new Map<string, CredentialHarvestWorkItem[]>();
  for (const item of quarantined) {
    const items = quarantinedByAccount.get(item.accountId) ?? [];
    items.push(item);
    quarantinedByAccount.set(item.accountId, items);
  }

  // Unknown/deleted accounts still get a durable failed-closed attempt stamp.
  for (const [accountId, items] of quarantinedByAccount) {
    if (accountsById.has(accountId)) continue;
    for (const item of items) {
      const workId = nextWorkId++;
      const quarantinePairId = -(workId + 1);
      deps.onProgress?.({ type: "work-start", workId, pairIds: [quarantinePairId] });
      try {
        await consumeQuarantinedHarvest(item, undefined, plan, deps);
      } finally {
        deps.onProgress?.({ type: "work-end", workId });
      }
    }
  }

  await mapWithConcurrency(plan.accounts, deps.concurrency, async (account) => {
    for (const item of quarantinedByAccount.get(account.id) ?? []) {
      const quarantineWorkId = nextWorkId++;
      const quarantinePairId = -(quarantineWorkId + 1);
      deps.onProgress?.({ type: "work-start", workId: quarantineWorkId, pairIds: [quarantinePairId] });
      try {
        const outcome = await consumeQuarantinedHarvest(item, account, plan, deps);
        if (outcome.removed) {
          telemetry.completedQuarantinedItems += 1;
          telemetry.retainedQuarantinedItems -= 1;
        }
        if (outcome.vaultUpdated) telemetry.vaultUpdates += 1;
      } finally {
        deps.onProgress?.({ type: "work-end", workId: quarantineWorkId });
      }
    }

    const accountWorkId = nextWorkId++;
    deps.onProgress?.({ type: "work-start", workId: accountWorkId, pairIds: canonicalPairIds.get(account.id) ?? [] });
    try {
      if (accountHomeErrors.has(account.id)) throw new Error(`could not canonicalize every home for ${account.id}`);
      for (const [canonicalHome, rawHome] of accountHomesById.get(account.id) ?? []) {
        const evidence = plan.pairs.find((pair) => pair.account.id === account.id && pair.homePath === canonicalHome)?.evidence;
        const outcome = await withAuthorizedSweepHome(plan, account, rawHome, evidence, (lockedHome, stampedOwner) =>
          deps.syncAccount(account, lockedHome, {
            authorization: "automatic",
            trustExtraHome: stampedOwner || dedicatedHomesById.get(account.id)?.has(canonicalHome) === true || Boolean(evidence),
            homeScope: "extra-only",
          }));
        if (outcome.authorized && outcome.value?.vaultUpdated) telemetry.vaultUpdates += 1;
      }
      if (account.tool === "cursor") {
        const result = await deps.syncAccount(account, undefined, {
          authorization: "automatic",
          homeScope: "machine-only",
        });
        if (result.vaultUpdated) telemetry.vaultUpdates += 1;
      }
      telemetry.completedAccounts += 1;
    } catch {
      telemetry.failedAccounts += 1;
    } finally {
      deps.onProgress?.({ type: "work-end", workId: accountWorkId });
    }

    for (const pair of extraByAccount.get(account.id) ?? []) {
      const pairWorkId = nextWorkId++;
      deps.onProgress?.({ type: "work-start", workId: pairWorkId, pairIds: [pair.id] });
      try {
        const outcome = await withAuthorizedSweepHome(plan, account, pair.homePath, pair.evidence, (lockedHome) =>
          deps.syncAccount(account, lockedHome, {
            authorization: "automatic",
            trustExtraHome: true,
            homeScope: "extra-only",
          }));
        if (outcome.authorized) {
          telemetry.completedPairs += 1;
          if (outcome.value?.vaultUpdated) telemetry.vaultUpdates += 1;
        } else {
          telemetry.skippedPairs += 1;
        }
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

/**
 * Low-level sync for one already-authorized pair. The caller must hold the
 * canonical activation-home lock through this operation: kill/retire does so
 * around its legacy-aware SessionRecord proof, while interactive run requires
 * a ready matching owner stamp. Locking here would deadlock those outer flows.
 */
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
    quarantinedItems: 0,
    completedQuarantinedItems: 0,
    retainedQuarantinedItems: 0,
  };
  deps.onProgress?.({ type: "plan", telemetry: { ...result } });
  if (!account) {
    result.durationMs = Math.max(0, deps.now() - startedAt);
    deps.onProgress?.({ type: "complete", telemetry: { ...result } });
    return result;
  }

  deps.onProgress?.({ type: "work-start", workId: 1, pairIds: [0] });
  try {
    const synced = await deps.syncAccount(account, resolve(homePath), {
      authorization: "automatic",
      trustExtraHome: true,
      homeScope: "extra-only",
      requirePositiveHomeEvidence: true,
    });
    if (synced.skipped.length > 0) throw new Error("credential content identity was rejected");
    if (synced.harvested !== true) throw new Error("no positive credential evidence was harvested");
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
