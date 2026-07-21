// ──────────────────────────────────────────────────────────────────────────
// Detached limits refresh — the revalidate half of the auto pick's
// stale-while-revalidate. The pick itself never blocks on provider
// round-trips once a snapshot exists; this forks a throttled, detached
// `hive limits` sweep so the cache is fresh again for the NEXT pick. Detached
// + unref'd is essential: an in-process background fetch would keep a
// short-lived `hive x`/`hive spawn` CLI alive until the sockets drained,
// putting the network right back on the caller's critical path.
// ──────────────────────────────────────────────────────────────────────────

import { spawn as spawnChild } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { storeRoot } from "../fsx.js";

/** Minimum spacing between refresh sweeps — a spawn burst forks at most one. */
export const LIMITS_REFRESH_THROTTLE_MS = 60_000;

function refreshStampPath(): string {
  return join(storeRoot(), "limits-refresh.stamp");
}

/**
 * Resolve the full-CLI entry from the current process entry. `hive-x` runs
 * cli-x.js, which only dispatches `x` — the sweep needs its cli.js sibling.
 */
export function limitsRefreshCliEntry(raw: string | undefined = process.argv[1]): string | null {
  if (!raw) return null;
  const name = basename(raw);
  const extension = extname(name);
  if (![".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) return null;
  const stem = name.slice(0, name.length - extension.length);
  if (stem === "cli" || stem === "cli-x") return join(dirname(raw), `cli${extension}`);
  return null;
}

/**
 * Fork one detached `hive limits` sweep (a ttl-less read refreshes the whole
 * on-disk cache), unless one was started within the throttle window. Returns
 * true when a sweep was actually forked. Never throws — a failed refresh just
 * means the next pick serves the same snapshot and tries again.
 */
export async function scheduleDetachedLimitsRefresh(): Promise<boolean> {
  try {
    const stamp = refreshStampPath();
    const mtimeMs = await stat(stamp).then((s) => s.mtimeMs).catch(() => 0);
    if (Date.now() - mtimeMs < LIMITS_REFRESH_THROTTLE_MS) return false;
    await writeFile(stamp, `${new Date().toISOString()}\n`, { mode: 0o600 });
    const rawEntry = limitsRefreshCliEntry();
    if (!rawEntry) return false;
    const entry = await realpath(rawEntry).catch(() => rawEntry);
    // Keep loader flags (tsx dev runs) but never inherit test/watch modes.
    const execArgv = process.execArgv.filter(
      (arg) => arg !== "--test" && !arg.startsWith("--test=") && arg !== "--watch" && !arg.startsWith("--watch="),
    );
    const child = spawnChild(process.execPath, [...execArgv, entry, "limits"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
