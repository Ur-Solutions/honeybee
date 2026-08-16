/**
 * Terminal-cursor re-probe (cell-smoothness Phase 2).
 *
 * Legacy false crash cursors remain probeable, but they still need a bounded
 * periodic correction path for mixed-version writers.
 *
 * A repair requires both an exact host birth and the same incarnation's live
 * control-socket testimony. False exited metadata is re-published by the host
 * itself; the daemon never writes a cached running cursor.
 *
 * The whole sweep is throttled to one pass per interval.
 */

import { defaultIsPidAlive } from "../fsx.js";
import { inspectHsrHostProcess, listHsrBees } from "../hsr/observe.js";
import { readHsrMetaStrict, type HsrMeta } from "../hsr/runDir.js";
import {
  listProcessRows,
  type ProcessIdentityVerdict,
  type ProcessRow,
} from "../hsr/processIdentity.js";
import { isActiveSessionLifecycle, type ProbeEvidence } from "../stateMachine.js";
import { isActiveSessionRecord, loadSession, markSessionVerified, type SessionRecord } from "../store.js";
import {
  probeHsrControl,
  reassertHsrControlMeta,
  sameHsrHostIncarnation,
  type HsrControlProbe,
} from "./reAdoption.js";
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
  /** @deprecated test seam; production repairs through the host RPC. */
  writeMeta?: (bee: string, meta: HsrMeta) => Promise<void>;
  loadRecord?: (name: string) => Promise<SessionRecord | null>;
  markVerified?: (name: string, probe: ProbeEvidence) => Promise<SessionRecord | null>;
  isHostAlive?: (pid: number) => boolean;
  /** One bounded topology/birth census shared by every host in this sweep. */
  listProcesses?: () => Promise<ProcessRow[]>;
  inspectHost?: (meta: HsrMeta) => Promise<ProcessIdentityVerdict>;
  probeControl?: (meta: HsrMeta) => Promise<HsrControlProbe>;
  repairMeta?: (expected: HsrMeta) => Promise<HsrMeta>;
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
  // Lazily take one coherent process snapshot only when a plausible local HSR
  // host reaches the birth check. The previous default called `/bin/ps -p`
  // once per bee; a large stale-terminal fleet could therefore fork hundreds
  // of helpers every minute. A single `ps -A` keeps the sweep bounded while
  // retaining the exact pid + pgid + birth fingerprint comparison.
  let processRows: Promise<Map<number, ProcessRow>> | undefined;
  const inspectHost = deps.inspectHost ?? (async (meta: HsrMeta) => {
    processRows ??= (deps.listProcesses ?? listProcessRows)().then(
      (rows) => new Map(rows.map((row) => [row.pid, row])),
    );
    return inspectHsrHostProcess(meta, {
      readProcessIdentity: async (pid) => {
        const row = (await processRows!).get(pid);
        return row ? { pgid: row.pgid, startedAt: row.startedAt } : null;
      },
    });
  });
  for (const bee of bees) {
    try {
      let meta = await (deps.readMeta ?? readHsrMetaStrict)(bee).catch(() => null);
      // Mirrors have no local pid to fingerprint-verify; their status is the
      // remoteEventMirror's to own on both sides of this sweep.
      if (!meta || meta.mirrorOfNode) continue;
      const record = await (deps.loadRecord ?? loadSession)(bee);
      if (!record || record.substrate !== "hsr" || !isActiveSessionLifecycle(record)) continue;
      if (record.runnerPid !== undefined && record.runnerPid !== meta.hostPid) continue;
      // Cheap numeric pre-filter only skips obvious dead hosts. It never proves
      // life; birth identity plus the control socket below do that.
      if (!(deps.isHostAlive ?? defaultIsPidAlive)(meta.hostPid)) continue;
      const verdict = await inspectHost(meta);
      if (verdict !== "match") continue;
      const control = await (deps.probeControl ?? probeHsrControl)(meta);
      if (
        control.status !== "matched" ||
        control.meta.status === "exited" ||
        !sameHsrHostIncarnation(meta, control.meta)
      ) continue;
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
        if (deps.writeMeta) {
          await deps.writeMeta(bee, control.meta);
          meta = control.meta;
        } else {
          meta = await (deps.repairMeta ?? reassertHsrControlMeta)(control.meta);
        }
        if (meta.status === "exited") continue;
        outcomes.push({ bee, action: "meta-restored" });
        // Fall through: the restored meta can now clear a stale record cursor
        // in this same pass instead of waiting a full sweep interval.
      }
      // Only a local host claiming "running" can contradict a terminal record
      // cursor.
      if (meta.status !== "running") continue;
      if (!REPROBE_TERMINAL_STATES.has(record.lastObservedState ?? "")) continue;
      if (record.recoveryRequestedAt) continue;
      // Terminal-marked active records deliberately remain in the work set.
      // This inverse sweep may still heal them immediately; the ordinary tick
      // is the second path that will converge the same verified truth.
      if (!isActiveSessionRecord(record)) continue;
      const evidence: ProbeEvidence = {
        kind: "probe",
        probeId: `terminal-reprobe:${bee}:${now()}`,
        observerId: "terminal-reprobe",
        observedAt: new Date(now()).toISOString(),
        outcome: "alive",
        target: { substrate: "hsr", ...(record.node ? { node: record.node } : {}), runnerPid: meta.hostPid },
        detail: "host birth matched; control socket owned the same live incarnation",
      };
      const healed = await (deps.markVerified ?? markSessionVerified)(bee, evidence);
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
