/**
 * Per-call timeout budgets and the primitives that enforce them.
 *
 * The daemon tick loop is strictly sequential (one tick fully resolves before
 * the next), so a single never-settling promise — a wedged tmux client, a
 * keychain prompt, or even a lost libuv fs completion (observed in production:
 * an fs.promises readFile of a codex transcript whose threadpool completion was
 * never delivered) — silently freezes the daemon forever while its process
 * stays alive. `withTimeout` converts that class of failure into a recentErrors
 * entry and a skipped stage instead of a dead observer; `guard` and `toError`
 * are the error-capture helpers the tick path uses around every external await.
 */

/**
 * Hard per-call budgets for every external await in the tick path. See the
 * module doc: an unbounded await freezes the whole loop.
 */
export type TickTimeouts = {
  /** fs-backed deps: listSessions/listNodes/sealedBeeNames/touchSession/appendLedger. */
  fsMs: number;
  /** substrate-backed deps: probeNodes (outer bound), capturePanes, livePanes, mirrorHiveState. */
  substrateMs: number;
  /** per-record transcript metadata refresh (reads provider transcripts). */
  transcriptMs: number;
  /** dispatchers: buz drain, usage sampler, autoswap, auto-title. */
  dispatchMs: number;
  /** credential chain sync (keychain + a sweep over many homes). */
  chainSyncMs: number;
};

export function defaultTickTimeouts(): TickTimeouts {
  return {
    fsMs: envMs("HIVE_DAEMON_FS_TIMEOUT_MS", 15_000),
    substrateMs: envMs("HIVE_DAEMON_SUBSTRATE_TIMEOUT_MS", 20_000),
    transcriptMs: envMs("HIVE_DAEMON_TRANSCRIPT_TIMEOUT_MS", 15_000),
    dispatchMs: envMs("HIVE_DAEMON_DISPATCH_TIMEOUT_MS", 60_000),
    chainSyncMs: envMs("HIVE_DAEMON_CHAIN_SYNC_TIMEOUT_MS", 120_000),
  };
}

export function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Reject after `ms` if the promise has not settled. The underlying operation
 * is NOT cancelled — an orphaned call may still complete (or never complete)
 * in the background; callers treat the rejection as "skip this stage".
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Await `promise`, capturing any rejection into `errors` and returning
 * `fallback` instead — the tick path never lets one failed stage abort the
 * observation cycle.
 */
export async function guard<T>(promise: Promise<T>, errors: Error[], fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    errors.push(toError(error));
    return fallback;
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
