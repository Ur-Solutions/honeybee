/**
 * Terminal-cursor re-probe (cell-smoothness Phase 2).
 *
 * A record whose lastObservedState is terminal (crashed/dead) is de-indexed
 * from the daemon work set (store.ts isActiveSessionRecord) and therefore
 * never re-observed by the tick — one false crash observation is
 * self-sustaining forever, even while the bee's HSR host is demonstrably
 * alive (2026-08-10: six live bees hand-repaired out of exactly this state).
 *
 * This sweep is reapDeadHosts' inverse, on both layers: reap flips
 * live-mismatch METAS to exited; this restores a mis-reaped exited META to
 * running and clears a stale terminal RECORD cursor when the meta's exact
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
import { readHsrMetaStrict, writeHsrMeta, type HsrMeta } from "../hsr/runDir.js";
import type { ProcessIdentityVerdict } from "../hsr/processIdentity.js";
import { isActiveSessionRecord, loadSession, updateSession, type SessionRecord } from "../store.js";
import { envMs } from "./timeouts.js";

export type TerminalReprobeOutcome = {
  bee: string;
  action: "healed" | "meta-restored" | "error";
  /** The stale cursor value that was cleared (healed only). */
  clearedState?: string;
  error?: string;
};

export type TerminalReprobeDependencies = {
  listBees?: () => Promise<string[]>;
  readMeta?: (bee: string) => Promise<HsrMeta | null>;
  writeMeta?: (bee: string, meta: HsrMeta) => Promise<void>;
  loadRecord?: (name: string) => Promise<SessionRecord | null>;
  updateRecord?: (name: string, patch: Partial<SessionRecord>) => Promise<SessionRecord | null>;
  isHostAlive?: (pid: number) => boolean;
  inspectHost?: (meta: HsrMeta) => Promise<ProcessIdentityVerdict>;
  intervalMs?: number;
  /** Minimum age of an exited stamp before the inverse meta heal may act. */
  metaRestoreGraceMs?: number;
  now?: () => number;
};

/** Only the FALSE-crash class is healable; done/sealed/retired/killed are deliberate. */
const REPROBE_TERMINAL_STATES = new Set(["crashed", "dead"]);

const DEFAULT_TERMINAL_REPROBE_INTERVAL_MS = 60_000;

/**
 * A clean shutdown writes `exited` moments before the host process actually
 * dies; healing inside that window would resurrect a meta whose pid is about
 * to vanish. Only exited stamps older than this grace are candidates — by
 * then a genuinely exiting host is long gone and its pid fails the pre-filter.
 */
const DEFAULT_META_RESTORE_GRACE_MS = 30_000;

/**
 * One unthrottled sweep. Exported for tests; the daemon wires the throttled
 * closure from createTerminalReprobeSweeper below.
 */
export async function reprobeTerminalCursors(
  deps: TerminalReprobeDependencies = {},
): Promise<TerminalReprobeOutcome[]> {
  const outcomes: TerminalReprobeOutcome[] = [];
  const bees = await (deps.listBees ?? listHsrBees)();
  const now = deps.now ?? (() => Date.now());
  const graceMs = deps.metaRestoreGraceMs ?? DEFAULT_META_RESTORE_GRACE_MS;
  for (const bee of bees) {
    try {
      let meta = await (deps.readMeta ?? readHsrMetaStrict)(bee).catch(() => null);
      // Mirrors have no local pid to fingerprint-verify; their status is the
      // remoteEventMirror's to own on both sides of this sweep.
      if (!meta || meta.mirrorOfNode) continue;
      // Numeric-pid pre-filter: a dead host cannot heal anything (that is
      // reapDeadHosts' territory) and must never resurrect a record or meta.
      if (!(deps.isHostAlive ?? defaultIsPidAlive)(meta.hostPid)) continue;
      let verdict: ProcessIdentityVerdict | undefined;
      // Inverse meta heal — reapDeadHosts' converse: a meta stamped `exited`
      // while its exact recorded host incarnation verifiably lives is a
      // mis-reap (2026-08-10: a daemon-env locale flip made the boot reap
      // stamp 10 live runners exited). Only proof restores: pid alive AND
      // birth fingerprint match — a recycled pid (mismatch) or an uncertain
      // census leaves the exited stamp standing. A startupFailure stamp is the
      // host's own testimony, never a reap artifact, so it is not healable.
      if (meta.status === "exited" && !meta.startupFailure) {
        const endedAtMs = meta.endedAt ? Date.parse(meta.endedAt) : Number.NaN;
        if (!Number.isFinite(endedAtMs) || now() - endedAtMs < graceMs) continue;
        verdict = await (deps.inspectHost ? deps.inspectHost(meta) : inspectHsrHostProcess(meta));
        if (verdict !== "match") continue;
        const { endedAt: _endedAt, exitCode: _exitCode, ...rest } = meta;
        meta = { ...rest, status: "running" };
        await (deps.writeMeta ?? writeHsrMeta)(bee, meta);
        outcomes.push({ bee, action: "meta-restored" });
        // Fall through: the restored meta can now clear a stale record cursor
        // in this same pass instead of waiting a full sweep interval.
      }
      // Only a local host claiming "running" can contradict a terminal record
      // cursor.
      if (meta.status !== "running") continue;
      const record = await (deps.loadRecord ?? loadSession)(bee);
      if (!record || record.substrate !== "hsr" || record.status !== "running") continue;
      if (!REPROBE_TERMINAL_STATES.has(record.lastObservedState ?? "")) continue;
      // Already in the work set (e.g. recoveryRequestedAt): the ordinary tick
      // observation self-heals it; this sweep only serves de-indexed records.
      if (isActiveSessionRecord(record)) continue;
      // Birth-fingerprint proof of life for the EXACT recorded incarnation.
      // gone/mismatch/unverifiable are not proof — leave the cursor alone.
      verdict ??= await (deps.inspectHost ? deps.inspectHost(meta) : inspectHsrHostProcess(meta));
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
