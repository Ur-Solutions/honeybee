import { appendLedger } from "../store.js";
import type { AccountRecord } from "./registry.js";

// ──────────────────────────────────────────────────────────────────────────
// The shared credential-sync engine. codex/grok/generic (and any future
// file-backed identity) all run the SAME algorithm: read the vault snapshot,
// enumerate the account's attributed homes, pick the freshest attributed
// snapshot, and — only when a home is strictly fresher than the vault — save
// it and ledger the update. A CredentialSyncStrategy supplies the per-tool
// pieces (how to read/attribute/compare/save/ledger a snapshot); the engine
// owns the loop so the three copies stay one implementation. (Claude's chain
// sync is NOT a strategy here — its rotate/park/profile-verify semantics are
// materially different and live in claudeChain.ts.)
// ──────────────────────────────────────────────────────────────────────────

export type SyncAccountCredentialsOptions = {
  /**
   * Trust `extraHome` even when it is not the account's dedicated home. Use
   * only when a live SessionRecord binds that home to the account.
   */
  trustExtraHome?: boolean;
  /** Internal sweep scope: inspect only the already-authorized extraHome. */
  homeScope?: "all" | "extra-only" | "machine-only";
  /**
   * `automatic` is used by daemon sweeps, final harvests, and activation's
   * pre-copy pull. In that context a pathname/SessionRecord is only a source
   * locator: the credential bytes themselves must positively identify the
   * account before they may enter its vault. `explicit` preserves the
   * operator-invoked `hive account sync` recovery semantics.
   */
  authorization?: "explicit" | "automatic";
  /** Emit secret-free skip ledger rows. Defaults to true for automatic sync. */
  emitSkipTelemetry?: boolean;
  /**
   * Recovery queues require affirmative identity evidence from extraHome even
   * when its credential is equal to/older than the vault. Missing content is
   * not a successful harvest and must leave the queue item intact.
   */
  requirePositiveHomeEvidence?: boolean;
};

export type CredentialSyncSkip = {
  /** Stable, secret-free machine reason. */
  reason: "foreign-identity" | "identity-unverifiable" | "content-changed-after-proof";
  /** Home/file locator only; never credential content. */
  source?: string;
};

export type CredentialImportAuthorization =
  | { authorized: true }
  | ({ authorized: false } & CredentialSyncSkip);

/** A ledger record. `type` is required; the rest is tool-specific payload. */
export type LedgerEntry = Record<string, unknown> & { type: string };

/**
 * The per-tool pieces of a credential sync. `TSnapshot` is the tool's snapshot
 * type; `TResult` is its public sync-result shape (`{ auth }`, `{ credentials }`).
 */
export type CredentialSyncStrategy<TSnapshot, TResult> = {
  /** The vault's current snapshot for the account (null when absent). */
  readVaultSnapshot(account: AccountRecord): Promise<TSnapshot | null>;
  /** Homes attributable to the account that may hold a fresher snapshot. */
  homesForAccount(account: AccountRecord, extraHome: string | undefined, options: SyncAccountCredentialsOptions): Promise<string[]>;
  /** The snapshot present in a candidate home (null when absent). */
  readHomeSnapshot(account: AccountRecord, home: string): Promise<TSnapshot | null>;
  /**
   * Guard against poisoning the vault with another account's snapshot (a
   * swapped/shared home). Omit for strategies whose home enumeration already
   * restricts candidates to trusted homes (generic).
   */
  authorizeImport?(
    snapshot: TSnapshot,
    account: AccountRecord,
    vault: TSnapshot | null,
    options: SyncAccountCredentialsOptions,
  ): Promise<CredentialImportAuthorization> | CredentialImportAuthorization;
  /** True when `candidate` is strictly fresher than `current`. */
  isFresher(candidate: TSnapshot, current: TSnapshot | null): boolean;
  /** Persist the chosen snapshot into the vault. Caller holds the account lock. */
  save(account: AccountRecord, snapshot: TSnapshot): Promise<void>;
  /** The ledger record for a vault update. */
  ledger(account: AccountRecord, snapshot: TSnapshot): LedgerEntry;
  /** Wrap the outcome in the tool's public result shape. */
  result(snapshot: TSnapshot | null, vaultUpdated: boolean, skipped: CredentialSyncSkip[], harvested: boolean): TResult;
};

/**
 * Run a credential sync under an already-held account lock: pull the freshest
 * attributed snapshot into the vault, saving + ledgering only when a home beat
 * the vault. Content authorization keeps swapped/shared homes from poisoning
 * a different account's vault entry.
 */
export async function runCredentialSyncLocked<TSnapshot, TResult>(
  account: AccountRecord,
  strategy: CredentialSyncStrategy<TSnapshot, TResult>,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<TResult> {
  const vault = await strategy.readVaultSnapshot(account);
  let best = vault;
  const skipped: CredentialSyncSkip[] = [];
  let harvested = false;
  for (const home of await strategy.homesForAccount(account, extraHome, options)) {
    const snapshot = await strategy.readHomeSnapshot(account, home);
    if (!snapshot) continue;
    const fresher = strategy.isFresher(snapshot, best);
    // Automatic recovery fails closed unless the provider strategy positively
    // authorizes these exact bytes. Explicit/manual sync keeps the historical
    // operator-directed recovery contract for identity-less providers.
    const mustAuthorizeEvidence = options.requirePositiveHomeEvidence === true;
    const authorization = fresher || mustAuthorizeEvidence
      ? strategy.authorizeImport
        ? await strategy.authorizeImport(snapshot, account, vault, options)
        : options.authorization === "automatic"
          ? { authorized: false as const, reason: "identity-unverifiable" as const }
          : { authorized: true as const }
      : null;
    if (!fresher && !mustAuthorizeEvidence) continue;
    if (!authorization) continue;
    if (!authorization.authorized) {
      const skip: CredentialSyncSkip = {
        reason: authorization.reason,
        ...(authorization.source ? { source: authorization.source } : {}),
      };
      skipped.push(skip);
      if (options.emitSkipTelemetry !== false && options.authorization === "automatic") {
        await appendLedger({
          type: "account.credential-sync-skipped",
          account: account.id,
          tool: account.tool,
          reason: skip.reason,
          ...(skip.source ? { from: skip.source } : {}),
        });
      }
      continue;
    }
    harvested = true;
    if (!fresher) continue;
    best = snapshot;
  }
  if (!best || best === vault) return strategy.result(best, false, skipped, harvested);
  await strategy.save(account, best);
  await appendLedger(strategy.ledger(account, best));
  return strategy.result(best, true, skipped, harvested);
}
