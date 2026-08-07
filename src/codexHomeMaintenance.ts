/**
 * Reclaim the tracing DBs codex keeps in a CODEX_HOME (`logs_*.sqlite`).
 *
 * Codex maintains these itself — byte-budget row retention, auto_vacuum=
 * INCREMENTAL, wal_checkpoint(PASSIVE) — but that design assumes roughly one
 * app-server per home. Hive runs several against the same home, so a PASSIVE
 * checkpoint never finds a moment with no reader holding a snapshot: the WAL is
 * never truncated and freed pages are never released. Homes have been observed
 * at 99.8% freelist inside multi-GB files.
 *
 * The cost is not only disk. Retention only runs once codex is up, so a home
 * that grows big enough to stall the boot handshake stops pruning and cannot
 * recover on its own — bee CO.66ad0 reached 5.1M live rows behind a 1.4GB WAL
 * and timed out `initialize` on every boot until the home was reclaimed by hand.
 *
 * Full reclaim runs after a host exits, outside the next boot's adapter
 * readiness path. It remains deliberately self-arbitrating:
 * wal_checkpoint(TRUNCATE) reports `busy` when another app-server still holds
 * a snapshot, so an active home costs a few milliseconds and reclaims nothing
 * rather than needing to count processes.
 */

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Total wall-clock budget for one post-session maintenance pass. */
const MAINTENANCE_BUDGET_MS = 5_000;
/**
 * Pages released per incremental_vacuum call. Measured at roughly 4k pages/sec,
 * so a chunk is well under a second and the deadline is checked between chunks
 * instead of being enforced mid-statement. A badly bloated home therefore
 * converges over several boots rather than stalling any single one.
 */
const VACUUM_CHUNK_PAGES = 2_000;
/** A quiet home should not wait on a lock at all — a busy one is the normal case. */
const BUSY_TIMEOUT_MS = 250;
/** `PRAGMA auto_vacuum` value for INCREMENTAL, the only mode incremental_vacuum acts on. */
const AUTO_VACUUM_INCREMENTAL = 2;
/** Remaining budget below which another vacuum chunk is not worth starting. */
const CHUNK_FLOOR_MS = 750;
export const CODEX_HOME_BOOT_PROBE_BUDGET_MS = 100;
const BOOT_PROBE_MAX_DBS = 32;

export type CodexHomeMaintenanceResult = {
  /** Bytes released across every logs DB in the home (db + wal). */
  reclaimedBytes: number;
  /** True when a live app-server held the WAL, so nothing could be reclaimed. */
  busy: boolean;
};

const NOTHING: CodexHomeMaintenanceResult = { reclaimedBytes: 0, busy: false };

export type CodexHomeSafetyProbe = {
  dbCount: number;
  bytes: number;
  timedOut: boolean;
};

const EMPTY_PROBE: CodexHomeSafetyProbe = { dbCount: 0, bytes: 0, timedOut: false };

export function codexHomeMaintenanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HIVE_CODEX_HOME_MAINTENANCE !== "0";
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Bounded, read-only boot probe. It never opens SQLite and therefore cannot
 * checkpoint/vacuum a multi-GB database on the adapter critical path. The
 * heavy reclaim remains available for post-session maintenance below.
 */
export async function probeCodexHomeLogs(
  home: string,
  options: { budgetMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CodexHomeSafetyProbe> {
  if (!codexHomeMaintenanceEnabled(options.env ?? process.env)) return EMPTY_PROBE;
  const budgetMs = Math.max(1, options.budgetMs ?? CODEX_HOME_BOOT_PROBE_BUDGET_MS);
  let timer: NodeJS.Timeout | undefined;
  const work = (async (): Promise<CodexHomeSafetyProbe> => {
    let names: string[];
    try {
      names = (await readdir(home)).filter((name) => /^logs_\d+\.sqlite$/.test(name)).slice(0, BOOT_PROBE_MAX_DBS);
    } catch {
      return EMPTY_PROBE;
    }
    let bytes = 0;
    for (const name of names) {
      const db = join(home, name);
      bytes += (await sizeOf(db)) + (await sizeOf(`${db}-wal`));
    }
    return { dbCount: names.length, bytes, timedOut: false };
  })();
  const timeout = new Promise<CodexHomeSafetyProbe>((resolve) => {
    timer = setTimeout(() => resolve({ ...EMPTY_PROBE, timedOut: true }), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sqlite(dbPath: string, sql: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileP("sqlite3", [dbPath, `pragma busy_timeout=${BUSY_TIMEOUT_MS}; ${sql}`], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * `wal_checkpoint(TRUNCATE)` answers "is anyone else using this home?" as a side
 * effect: it returns `busy|log|checkpointed`, where a non-zero first column means
 * a reader blocked the reset. That is the gate for the expensive half — releasing
 * freelist pages while another app-server reads would push the freed pages into
 * the WAL and grow the home instead of shrinking it.
 */
async function reclaimOne(dbPath: string, deadline: number): Promise<CodexHomeMaintenanceResult> {
  const wal = `${dbPath}-wal`;
  const before = (await sizeOf(dbPath)) + (await sizeOf(wal));

  const checkpoint = await sqlite(dbPath, "pragma wal_checkpoint(truncate);", Math.max(1, deadline - Date.now()));
  const busy = checkpoint.split("\n").pop()?.split("|")[0] !== "0";
  if (busy) return { reclaimedBytes: 0, busy: true };

  // incremental_vacuum is a silent no-op unless the DB was created with
  // auto_vacuum=INCREMENTAL, and auto_vacuum cannot be switched on afterwards
  // without a full VACUUM. Codex sets it (every home here reports 2), but a DB
  // that reports otherwise would spin this loop for the whole budget on every
  // boot and reclaim nothing, so check before spending anything. The checkpoint
  // above is still worth having on such a home — that is where the GB live.
  const autoVacuum = Number((await sqlite(dbPath, "pragma auto_vacuum;", 2_000)).split("\n").pop());
  if (autoVacuum === AUTO_VACUUM_INCREMENTAL) {
    let previous = Infinity;
    // Only start a chunk there is time to finish. Handing execFile the last few
    // milliseconds of the budget kills it mid-statement, and that error would
    // otherwise discard the accounting and skip the checkpoint below — losing
    // the GB the first checkpoint already reclaimed.
    while (deadline - Date.now() > CHUNK_FLOOR_MS) {
      let remaining: number;
      try {
        const freed = await sqlite(
          dbPath,
          `pragma incremental_vacuum(${VACUUM_CHUNK_PAGES}); select (select * from pragma_freelist_count());`,
          deadline - Date.now(),
        );
        remaining = Number(freed.split("\n").pop());
      } catch {
        break; // a locked or slow DB ends the vacuum, not the whole pass
      }
      // Stop on an empty freelist, and defensively on any chunk that made no
      // progress, so a DB that cannot shrink can never spin out the budget.
      if (!Number.isFinite(remaining) || remaining === 0 || remaining >= previous) break;
      previous = remaining;
    }
  }
  // Land the page churn the vacuum just wrote back into the main file.
  await sqlite(dbPath, "pragma wal_checkpoint(truncate);", 2_000).catch(() => "");

  const after = (await sizeOf(dbPath)) + (await sizeOf(wal));
  return { reclaimedBytes: before - after, busy: false };
}

/**
 * Best-effort: a home that cannot be reclaimed must never block a bee from
 * booting, so every failure here (missing sqlite3, a locked DB, a timeout) is
 * swallowed and reported as "nothing reclaimed".
 */
export async function reclaimCodexHomeLogs(
  home: string,
  opts: { budgetMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CodexHomeMaintenanceResult> {
  if (!codexHomeMaintenanceEnabled(opts.env ?? process.env)) return NOTHING;
  const deadline = Date.now() + (opts.budgetMs ?? MAINTENANCE_BUDGET_MS);

  let dbs: string[];
  try {
    dbs = (await readdir(home)).filter((name) => /^logs_\d+\.sqlite$/.test(name));
  } catch {
    return NOTHING;
  }

  let reclaimedBytes = 0;
  let busy = false;
  for (const db of dbs) {
    if (Date.now() >= deadline) break;
    try {
      const result = await reclaimOne(join(home, db), deadline);
      reclaimedBytes += result.reclaimedBytes;
      busy ||= result.busy;
    } catch {
      // sqlite3 absent, DB locked, or budget exhausted mid-statement.
    }
  }
  return { reclaimedBytes, busy };
}
