/**
 * Terminal-cursor re-probe (cell-smoothness Phase 2).
 *
 * A record whose lastObservedState is terminal (crashed/dead) is de-indexed
 * from the daemon work set (store.ts isActiveSessionRecord) and therefore
 * never re-observed by the tick — one false crash observation is
 * self-sustaining forever, even while the bee's HSR host is demonstrably
 * alive (2026-08-10: six live bees hand-repaired out of exactly this state).
 *
 * This sweep is reapDeadHosts' inverse: reap flips live-mismatch METAS to
 * exited; this clears a stale terminal RECORD cursor when the meta's exact
 * host incarnation verifiably lives (birth-fingerprint probe, locale-
 * tolerant). Clearing the cursor puts the record back in the active index,
 * so the next tick re-observes it and truth re-propagates on its own.
 *
 * Cheap by construction: metas are read first (run-dir scan the boot reap
 * already pays), a dead host pid short-circuits before any record load, and
 * the whole sweep is throttled to one pass per interval.
 */

import { defaultIsPidAlive } from "../fsx.js";
import { inspectHsrHostProcess, listHsrBees } from "../hsr/observe.js";
import { readHsrMetaStrict, type HsrMeta } from "../hsr/runDir.js";
import type { ProcessIdentityVerdict } from "../hsr/processIdentity.js";
import { isActiveSessionRecord, loadSession, updateSession, type SessionRecord } from "../store.js";
import { envMs } from "./timeouts.js";

export type TerminalReprobeOutcome = {
  bee: string;
  action: "healed" | "error";
  /** The stale cursor value that was cleared (healed only). */
  clearedState?: string;
  error?: string;
};

export type TerminalReprobeDependencies = {
  listBees?: () => Promise<string[]>;
  readMeta?: (bee: string) => Promise<HsrMeta | null>;
  loadRecord?: (name: string) => Promise<SessionRecord | null>;
  updateRecord?: (name: string, patch: Partial<SessionRecord>) => Promise<SessionRecord | null>;
  isHostAlive?: (pid: number) => boolean;
  inspectHost?: (meta: HsrMeta) => Promise<ProcessIdentityVerdict>;
  intervalMs?: number;
  now?: () => number;
};

/** Only the FALSE-crash class is healable; done/sealed/retired/killed are deliberate. */
const REPROBE_TERMINAL_STATES = new Set(["crashed", "dead"]);

const DEFAULT_TERMINAL_REPROBE_INTERVAL_MS = 60_000;

/**
 * One unthrottled sweep. Exported for tests; the daemon wires the throttled
 * closure from createTerminalReprobeSweeper below.
 */
export async function reprobeTerminalCursors(
  deps: TerminalReprobeDependencies = {},
): Promise<TerminalReprobeOutcome[]> {
  const outcomes: TerminalReprobeOutcome[] = [];
  const bees = await (deps.listBees ?? listHsrBees)();
  for (const bee of bees) {
    try {
      const meta = await (deps.readMeta ?? readHsrMetaStrict)(bee).catch(() => null);
      // Only a local host claiming "running" can contradict a terminal record
      // cursor. Mirrors have no local pid to fingerprint-verify; exited metas
      // agree with the cursor.
      if (!meta || meta.status !== "running" || meta.mirrorOfNode) continue;
      // Numeric-pid pre-filter: a dead host cannot heal anything (that is
      // reapDeadHosts' territory) and must never resurrect a record.
      if (!(deps.isHostAlive ?? defaultIsPidAlive)(meta.hostPid)) continue;
      const record = await (deps.loadRecord ?? loadSession)(bee);
      if (!record || record.substrate !== "hsr" || record.status !== "running") continue;
      if (!REPROBE_TERMINAL_STATES.has(record.lastObservedState ?? "")) continue;
      // Already in the work set (e.g. recoveryRequestedAt): the ordinary tick
      // observation self-heals it; this sweep only serves de-indexed records.
      if (isActiveSessionRecord(record)) continue;
      // Birth-fingerprint proof of life for the EXACT recorded incarnation.
      // gone/mismatch/unverifiable are not proof — leave the cursor alone.
      const verdict = await (deps.inspectHost ? deps.inspectHost(meta) : inspectHsrHostProcess(meta));
      if (verdict !== "match") continue;
      const healed = await (deps.updateRecord ?? updateSession)(bee, {
        lastObservedState: undefined,
        lastObservedStateAt: undefined,
      });
      if (healed) {
        outcomes.push({ bee, action: "healed", clearedState: record.lastObservedState! });
      }
    } catch (error) {
      outcomes.push({ bee, action: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

/**
 * The tick-wired sweeper: self-throttled to one pass per interval
 * (HIVE_DAEMON_TERMINAL_REPROBE_INTERVAL_MS, default 60s), like the pool
 * sweeper — most ticks return [] without touching the filesystem.
 */
export function createTerminalReprobeSweeper(
  deps: TerminalReprobeDependencies = {},
): () => Promise<TerminalReprobeOutcome[]> {
  const intervalMs = deps.intervalMs ??
    envMs("HIVE_DAEMON_TERMINAL_REPROBE_INTERVAL_MS", DEFAULT_TERMINAL_REPROBE_INTERVAL_MS);
  const now = deps.now ?? (() => Date.now());
  let lastSweepAt = Number.NEGATIVE_INFINITY;
  return async () => {
    const at = now();
    if (at - lastSweepAt < intervalMs) return [];
    lastSweepAt = at;
    return reprobeTerminalCursors(deps);
  };
}
