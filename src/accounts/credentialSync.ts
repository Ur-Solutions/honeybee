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
};

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
  belongsToAccount?(snapshot: TSnapshot, account: AccountRecord, vault: TSnapshot | null): Promise<boolean> | boolean;
  /** True when `candidate` is strictly fresher than `current`. */
  isFresher(candidate: TSnapshot, current: TSnapshot | null): boolean;
  /** Persist the chosen snapshot into the vault. Caller holds the account lock. */
  save(account: AccountRecord, snapshot: TSnapshot): Promise<void>;
  /** The ledger record for a vault update. */
  ledger(account: AccountRecord, snapshot: TSnapshot): LedgerEntry;
  /** Wrap the outcome in the tool's public result shape. */
  result(snapshot: TSnapshot | null, vaultUpdated: boolean): TResult;
};

/**
 * Run a credential sync under an already-held account lock: pull the freshest
 * attributed snapshot into the vault, saving + ledgering only when a home beat
 * the vault. Identity checks (strategy.belongsToAccount) keep swapped/shared
 * homes from poisoning a different account's vault entry.
 */
export async function runCredentialSyncLocked<TSnapshot, TResult>(
  account: AccountRecord,
  strategy: CredentialSyncStrategy<TSnapshot, TResult>,
  extraHome?: string,
  options: SyncAccountCredentialsOptions = {},
): Promise<TResult> {
  const vault = await strategy.readVaultSnapshot(account);
  let best = vault;
  for (const home of await strategy.homesForAccount(account, extraHome, options)) {
    const snapshot = await strategy.readHomeSnapshot(account, home);
    if (!snapshot) continue;
    if (strategy.belongsToAccount && !(await strategy.belongsToAccount(snapshot, account, vault))) continue;
    if (strategy.isFresher(snapshot, best)) best = snapshot;
  }
  if (!best || best === vault) return strategy.result(best, false);
  await strategy.save(account, best);
  await appendLedger(strategy.ledger(account, best));
  return strategy.result(best, true);
}
