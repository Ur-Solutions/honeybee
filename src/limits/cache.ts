// ──────────────────────────────────────────────────────────────────────────
// limits cache — every live read is snapshotted; readers may accept an entry
// younger than their ttl instead of paying the round-trips.
// ──────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountRecord } from "../accounts.js";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { accountLimits } from "./dispatch.js";
import type { AccountLimits, LimitsDeps } from "./types.js";

export type LimitsCacheEntry = { fetchedAt: string; limits: AccountLimits };
type LimitsCache = Record<string, LimitsCacheEntry>;

export function limitsCachePath(): string {
  return join(storeRoot(), "limits-cache.json");
}

async function readLimitsCache(): Promise<LimitsCache> {
  const raw = await readFile(limitsCachePath(), "utf8").catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const cache: LimitsCache = {};
    for (const [account, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as LimitsCacheEntry;
      if (typeof candidate.fetchedAt !== "string" || !candidate.limits || typeof candidate.limits !== "object") continue;
      cache[account] = candidate;
    }
    return cache;
  } catch {
    return {};
  }
}

/** Snapshot successful reads into the cache; failures are never cached (they should retry, not stick). */
async function updateLimitsCache(results: AccountLimits[], now: number): Promise<void> {
  const fresh = results.filter((result) => result.ok);
  if (fresh.length === 0) return;
  await withFileLock(`${limitsCachePath()}.lock`, async () => {
    const cache = await readLimitsCache();
    for (const result of fresh) {
      const { cached: _cached, ...limits } = result;
      cache[result.account] = { fetchedAt: new Date(now).toISOString(), limits };
    }
    await atomicWriteFile(limitsCachePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  });
}

/**
 * How much cache-freshness a just-picked account keeps (HIVE-80). Within this
 * grace a spawn burst still reads the snapshot (the pick debits cover the
 * burst); after it, the entry is expired so the next auto pick re-reads live
 * — right around when the provider's numbers start reflecting the new load.
 */
export const PICKED_ENTRY_GRACE_MS = 5 * 60 * 1000;

/**
 * Backdate one account's cache entry so it expires `graceMs` from now for
 * readers using `ttlMs` (the auto pick's 1h by default). The snapshot itself
 * is kept — the 429 fallback in cachedAccountLimits still needs it. No-op for
 * an absent entry, and never makes an already-older entry look fresher.
 */
export async function agePickedLimitsCacheEntry(
  accountId: string,
  opts: { now?: number; ttlMs?: number; graceMs?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  const graceMs = Math.min(opts.graceMs ?? PICKED_ENTRY_GRACE_MS, ttlMs);
  const agedFetchedAt = new Date(now - (ttlMs - graceMs)).toISOString();
  await withFileLock(`${limitsCachePath()}.lock`, async () => {
    const cache = await readLimitsCache();
    const entry = cache[accountId];
    if (!entry || entry.fetchedAt <= agedFetchedAt) return;
    cache[accountId] = { ...entry, fetchedAt: agedFetchedAt };
    await atomicWriteFile(limitsCachePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  });
}

export type CachedLimitsOptions = LimitsDeps & {
  /** Serve cache entries younger than this; missing/0 → always fetch live. */
  ttlMs?: number;
  /**
   * Stale-while-revalidate: entries older than ttlMs but younger than this are
   * still served from the snapshot (so the caller never blocks on provider
   * round-trips), and their account ids are reported via onStaleServed so the
   * caller can schedule an off-path refresh. Absent/0 → stale entries fetch
   * live as before. Only meaningful with ttlMs > 0.
   */
  serveStaleUpToMs?: number;
  /** Fires (once, before returning) with the accounts served past their ttl. */
  onStaleServed?: (accountIds: string[]) => void;
  /** Live fetch override (tests). Defaults to accountLimits. */
  fetchLimits?: typeof accountLimits;
};

/**
 * accountLimits behind the on-disk cache. Per account: a cache entry younger
 * than ttlMs is served as-is (flagged `cached`, asOf falling back to fetch
 * time); anything older or missing is fetched live, and every successful live
 * read refreshes the cache — including ttl-less calls, so a plain
 * `hive limits` keeps the cache warm for later cached readers.
 */
/** True when a failed live read was the provider pushing back (HTTP 429), not a broken account. */
function isRateLimitedFailure(result: AccountLimits): boolean {
  return !result.ok && /\b429\b|rate.?limit/i.test(result.error ?? "");
}

export async function cachedAccountLimits(accounts: AccountRecord[], options: CachedLimitsOptions = {}): Promise<AccountLimits[]> {
  const now = (options.now ?? Date.now)();
  const ttlMs = options.ttlMs ?? 0;
  // The cache is read even for ttl-less calls: a rate-limited live read falls
  // back to the last good snapshot below.
  const serveStaleUpToMs = ttlMs > 0 ? Math.max(options.serveStaleUpToMs ?? 0, ttlMs) : 0;
  const cache = await readLimitsCache();
  const hits = new Map<string, AccountLimits>();
  const misses: AccountRecord[] = [];
  const staleServed: string[] = [];
  for (const account of accounts) {
    const entry = cache[account.id];
    const age = entry ? now - Date.parse(entry.fetchedAt) : Number.NaN;
    if (ttlMs > 0 && entry && Number.isFinite(age) && age >= 0 && age <= ttlMs) {
      hits.set(account.id, { ...entry.limits, cached: true, asOf: entry.limits.asOf ?? entry.fetchedAt });
    } else if (serveStaleUpToMs > ttlMs && entry && Number.isFinite(age) && age >= 0 && age <= serveStaleUpToMs) {
      hits.set(account.id, { ...entry.limits, cached: true, asOf: entry.limits.asOf ?? entry.fetchedAt });
      staleServed.push(account.id);
    } else {
      misses.push(account);
    }
  }
  if (staleServed.length > 0) options.onStaleServed?.(staleServed);
  const fetchLimits = options.fetchLimits ?? accountLimits;
  const fetched = misses.length > 0 ? await fetchLimits(misses, options) : [];
  if (fetched.length > 0) await updateLimitsCache(fetched, now).catch(() => undefined);
  const fetchedById = new Map(fetched.map((result) => [result.account, result]));
  return accounts
    .map((account) => hits.get(account.id) ?? fetchedById.get(account.id))
    .filter((result): result is AccountLimits => result !== undefined)
    .map((result) => {
      // A 429 is transient provider push-back, not truth about the account —
      // and the endpoint is contended (every running claude session polls it
      // too). Serve the last good snapshot instead of an error row, with the
      // age visible via asOf and `rateLimited` kept so pollers (the --live
      // dashboard) still see the signal and back off.
      if (!isRateLimitedFailure(result)) return result;
      const entry = cache[result.account];
      if (!entry) return { ...result, rateLimited: true };
      return { ...entry.limits, cached: true, rateLimited: true, asOf: entry.limits.asOf ?? entry.fetchedAt };
    });
}
