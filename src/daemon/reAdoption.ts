/**
 * Daemon boot re-adoption probes.
 *
 * A daemon lifecycle is not a bee lifecycle. This module only gathers
 * proof about the runner incarnation a SessionRecord already names. It never
 * writes a terminal cursor or signals a process. Callers may heal a live
 * cursor, or hand a proof-carrying death to the runtime supervisor, only from
 * the discriminated result below.
 */

import { randomUUID } from "node:crypto";
import { inspectHsrHostProcess } from "../hsr/observe.js";
import type { ProcessIdentityVerdict } from "../hsr/processIdentity.js";
import { sameProcessBirthFingerprint } from "../hsr/processIdentity.js";
import { readHsrMetaStrict, type HsrMeta } from "../hsr/runDir.js";
import { connectRpcClient } from "../hsr/rpc.js";
import {
  appendLedger,
  listSessionsStrict,
  markSessionUnverified,
  markSessionVerified,
  type SessionRecord,
} from "../store.js";
import type { ObserverOfflineMarker, ProbeEvidence, UnverifiedCursorMarker } from "../stateMachine.js";
import { mapWithConcurrency } from "./concurrency.js";

export type HsrControlProbe =
  | { status: "matched"; meta: HsrMeta }
  | { status: "absent"; detail: string }
  | { status: "unreachable"; detail: string };

export type HsrReAdoptionProbe =
  | {
      classification: "live";
      record: SessionRecord;
      evidence: ProbeEvidence & { outcome: "alive" };
      diskMeta: HsrMeta;
      ownedMeta: HsrMeta;
      /** True when a foreign writer stamped disk exited while the host says live. */
      staleExitedMeta: boolean;
    }
  | {
      classification: "dead";
      record: SessionRecord;
      evidence: ProbeEvidence & { outcome: "dead" };
      diskMeta: HsrMeta;
      hostVerdict: "gone" | "mismatch";
    }
  | {
      classification: "uncertain";
      record: SessionRecord;
      evidence: ProbeEvidence & { outcome: "unreachable" };
      diskMeta?: HsrMeta;
      detail: string;
    };

export type HsrReAdoptionDependencies = {
  readMeta?: (bee: string) => Promise<HsrMeta | null>;
  inspectHost?: (meta: HsrMeta) => Promise<ProcessIdentityVerdict>;
  probeControl?: (meta: HsrMeta) => Promise<HsrControlProbe>;
  now?: () => number;
  makeProbeId?: () => string;
};

export type BootReAdoptionOptions = HsrReAdoptionDependencies & {
  observerId: string;
  listRecords?: () => Promise<SessionRecord[]>;
  concurrency?: number;
};

export type CursorMarkerWrite = (
  name: string,
  marker: UnverifiedCursorMarker,
) => Promise<SessionRecord | null>;

export type CursorMarkerOutcome = {
  bee: string;
  marker: UnverifiedCursorMarker;
  status: "marked" | "missing" | "error";
  error?: string;
};

export type ObserverOfflineOptions = {
  observerId: string;
  reason: string;
  lastSeenAt?: string;
  listRecords?: () => Promise<SessionRecord[]>;
  markUnverified?: CursorMarkerWrite;
  concurrency?: number;
  now?: () => number;
};

export type BootCursorMarkerOptions = {
  observerId: string;
  records: SessionRecord[];
  markUnverified: CursorMarkerWrite;
  concurrency?: number;
  now?: () => number;
};

export type LiveHsrReAdoptionProbe = Extract<HsrReAdoptionProbe, { classification: "live" }>;
export type DeadHsrReAdoptionProbe = Extract<HsrReAdoptionProbe, { classification: "dead" }>;

export type AppliedReAdoptionOutcome = {
  bee: string;
  classification: HsrReAdoptionProbe["classification"];
  action: "verified-live" | "verified-dead" | "death-deferred" | "unverified" | "error";
  evidence: ProbeEvidence;
  error?: string;
};

export type BootReAdoptionLifecycleOptions = HsrReAdoptionDependencies & {
  observerId: string;
  listRecords?: () => Promise<SessionRecord[]>;
  markUnverified?: CursorMarkerWrite;
  markVerified?: (name: string, probe: ProbeEvidence) => Promise<SessionRecord | null>;
  repairLiveMeta?: (expected: HsrMeta) => Promise<HsrMeta>;
  /** H2 consumes live recovery proof to emit recovery.succeeded when needed. */
  onVerifiedLive?: (probe: LiveHsrReAdoptionProbe) => Promise<void>;
  /** H2 emits runtime.lost/runtime.parked and confirms that it persisted. */
  onVerifiedDeath?: (probe: DeadHsrReAdoptionProbe) => Promise<"handled" | "deferred">;
  appendAudit?: (event: Record<string, unknown>) => Promise<void>;
  concurrency?: number;
};

/** Records whose runtime cursor still matters. Archived records never adopt. */
export function isHsrReAdoptionCandidate(record: SessionRecord): boolean {
  return record.substrate === "hsr" && record.status !== "done" && record.stateMachine?.lifecycle !== "archived";
}

/** Every active lifecycle cursor becomes uncertain when its observer exits. */
export function isObserverCursorCandidate(record: SessionRecord): boolean {
  return record.status !== "done" && record.stateMachine?.lifecycle !== "archived";
}

/**
 * Shutdown records observer uncertainty only. It never writes a bee runtime or
 * legacy observed state, and failures are reported without blocking teardown.
 */
export async function markObserverOffline(options: ObserverOfflineOptions): Promise<CursorMarkerOutcome[]> {
  const offlineSince = new Date((options.now ?? Date.now)()).toISOString();
  const observer: ObserverOfflineMarker = {
    observerId: options.observerId,
    offlineSince,
    ...(options.lastSeenAt ? { lastSeenAt: options.lastSeenAt } : {}),
    reason: options.reason,
  };
  const marker: UnverifiedCursorMarker = {
    since: offlineSince,
    reason: "observer-offline",
    probeScheduledAt: offlineSince,
    observer,
  };
  const records = (await (options.listRecords ?? listSessionsStrict)()).filter(isObserverCursorCandidate);
  const markUnverified = options.markUnverified ?? markSessionUnverified;
  return mapWithConcurrency(records, Math.max(1, options.concurrency ?? 16), async (record) => {
    try {
      const updated = await markUnverified(record.name, marker);
      return { bee: record.name, marker, status: updated ? "marked" : "missing" };
    } catch (error) {
      return { bee: record.name, marker, status: "error", error: message(error) };
    }
  });
}

/** Mark the complete sweep set before its first probe, making the gap visible. */
export async function markBootCursorsUnverified(options: BootCursorMarkerOptions): Promise<CursorMarkerOutcome[]> {
  const scheduledAt = new Date((options.now ?? Date.now)()).toISOString();
  return mapWithConcurrency(
    options.records.filter(isHsrReAdoptionCandidate),
    Math.max(1, options.concurrency ?? 16),
    async (record) => {
      const existing = (record as SessionRecord & { stateUnverified?: UnverifiedCursorMarker }).stateUnverified;
      const marker: UnverifiedCursorMarker = existing?.reason === "observer-offline"
        ? { ...existing, probeScheduledAt: scheduledAt }
        : {
            since: scheduledAt,
            reason: "stale-cursor",
            probeScheduledAt: scheduledAt,
          };
      try {
        const updated = await options.markUnverified(record.name, marker);
        return { bee: record.name, marker, status: updated ? "marked" : "missing" };
      } catch (error) {
        return { bee: record.name, marker, status: "error", error: message(error) };
      }
    },
  );
}

/**
 * Full boot choreography: expose uncertainty for the complete set, collect
 * three-witness proof, heal only proven-live cursors, and hand proven deaths
 * to H2. Uncertain or unhandled death results retain their marker.
 */
export async function reconcileBootReAdoption(
  options: BootReAdoptionLifecycleOptions,
): Promise<AppliedReAdoptionOutcome[]> {
  const listRecords = options.listRecords ?? listSessionsStrict;
  const records = (await listRecords()).filter(isHsrReAdoptionCandidate);
  const markUnverified = options.markUnverified ?? markSessionUnverified;
  const markVerified = options.markVerified ?? markSessionVerified;
  const appendAudit = options.appendAudit ?? appendLedger;
  const concurrency = Math.max(1, options.concurrency ?? 16);
  const now = options.now ?? Date.now;

  const markers = await markBootCursorsUnverified({
    observerId: options.observerId,
    records,
    markUnverified,
    concurrency,
    now,
  });
  await appendAudit({
    type: "daemon.readoption.start",
    observerId: options.observerId,
    scheduledAt: new Date(now()).toISOString(),
    beeCount: records.length,
    markerErrorCount: markers.filter(({ status }) => status === "error").length,
    markerErrors: markers.filter(({ status }) => status === "error").slice(0, 50).map(({ bee, error }) => ({ bee, error })),
  }).catch(() => undefined);

  const outcomes = await mapWithConcurrency(records, concurrency, async (record): Promise<AppliedReAdoptionOutcome> => {
    const probe = await probeHsrReAdoption(record, options.observerId, options);
    let outcome: AppliedReAdoptionOutcome;
    try {
      if (probe.classification === "live") {
        if (probe.staleExitedMeta) {
          await (options.repairLiveMeta ?? reassertHsrControlMeta)(probe.ownedMeta);
        }
        await options.onVerifiedLive?.(probe);
        if (!(await markVerified(record.name, probe.evidence))) {
          throw new Error("session disappeared before live verification could commit");
        }
        outcome = {
          bee: record.name,
          classification: "live",
          action: "verified-live",
          evidence: probe.evidence,
        };
      } else if (probe.classification === "dead") {
        const handled = await options.onVerifiedDeath?.(probe) ?? "deferred";
        if (handled === "handled") {
          if (!(await markVerified(record.name, probe.evidence))) {
            throw new Error("session disappeared before death verification could commit");
          }
          outcome = {
            bee: record.name,
            classification: "dead",
            action: "verified-dead",
            evidence: probe.evidence,
          };
        } else {
          outcome = {
            bee: record.name,
            classification: "dead",
            action: "death-deferred",
            evidence: probe.evidence,
          };
        }
      } else {
        outcome = {
          bee: record.name,
          classification: "uncertain",
          action: "unverified",
          evidence: probe.evidence,
        };
      }
    } catch (error) {
      outcome = {
        bee: record.name,
        classification: probe.classification,
        action: "error",
        evidence: probe.evidence,
        error: message(error),
      };
    }
    await appendAudit({
      type: "daemon.readoption.probe",
      observerId: options.observerId,
      bee: record.name,
      classification: outcome.classification,
      action: outcome.action,
      evidence: outcome.evidence,
      ...(outcome.error ? { error: outcome.error } : {}),
    }).catch(() => undefined);
    return outcome;
  });

  await appendAudit({
    type: "daemon.readoption.complete",
    observerId: options.observerId,
    completedAt: new Date(now()).toISOString(),
    counts: Object.fromEntries(
      [...new Set(outcomes.map(({ action }) => action))].map((action) => [
        action,
        outcomes.filter((outcome) => outcome.action === action).length,
      ]),
    ),
  }).catch(() => undefined);
  return outcomes;
}

export function sameHsrHostIncarnation(left: HsrMeta, right: HsrMeta): boolean {
  return left.bee === right.bee &&
    left.hostPid === right.hostPid &&
    left.startedAt === right.startedAt &&
    sameProcessBirthFingerprint(left.hostFingerprint, right.hostFingerprint);
}

function controlMeta(value: unknown): HsrMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<HsrMeta>;
  if (
    typeof candidate.bee !== "string" ||
    !Number.isSafeInteger(candidate.hostPid) || Number(candidate.hostPid) <= 0 ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.controlSocket !== "string" ||
    (candidate.status !== "queued" && candidate.status !== "running" && candidate.status !== "exited")
  ) return null;
  return candidate as HsrMeta;
}

function evidenceFor(
  record: SessionRecord,
  observerId: string,
  outcome: ProbeEvidence["outcome"],
  observedAt: string,
  probeId: string,
  detail: string,
  runnerPid?: number,
): ProbeEvidence {
  return {
    kind: "probe",
    probeId,
    observerId,
    observedAt,
    outcome,
    target: {
      substrate: "hsr",
      ...(record.node ? { node: record.node } : {}),
      ...(runnerPid !== undefined ? { runnerPid } : {}),
    },
    detail,
  };
}

function uncertain(
  record: SessionRecord,
  observerId: string,
  observedAt: string,
  probeId: string,
  detail: string,
  diskMeta?: HsrMeta,
): HsrReAdoptionProbe {
  return {
    classification: "uncertain",
    record,
    evidence: evidenceFor(record, observerId, "unreachable", observedAt, probeId, detail, diskMeta?.hostPid) as ProbeEvidence & {
      outcome: "unreachable";
    },
    ...(diskMeta ? { diskMeta } : {}),
    detail,
  };
}

/**
 * Probe one record using three independent observations:
 *
 * 1. strict durable HSR metadata,
 * 2. OS birth identity of the exact recorded host,
 * 3. the host-owned metadata returned by its live control socket.
 *
 * `dead` requires an exact gone/mismatch verdict plus a definitively absent
 * socket. Timeouts, malformed metadata, replacement races, and contradictory
 * witnesses are `uncertain` and can never authorize a terminal transition.
 */
export async function probeHsrReAdoption(
  record: SessionRecord,
  observerId: string,
  deps: HsrReAdoptionDependencies = {},
): Promise<HsrReAdoptionProbe> {
  const now = deps.now ?? Date.now;
  const observedAt = new Date(now()).toISOString();
  const probeId = (deps.makeProbeId ?? randomUUID)();
  let initial: HsrMeta | null;
  try {
    initial = await (deps.readMeta ?? readHsrMetaStrict)(record.name);
  } catch (error) {
    return uncertain(record, observerId, observedAt, probeId, `metadata unreadable: ${message(error)}`);
  }
  if (!initial) {
    return uncertain(record, observerId, observedAt, probeId, "metadata absent");
  }
  if (record.runnerPid !== undefined && record.runnerPid !== initial.hostPid) {
    return uncertain(
      record,
      observerId,
      observedAt,
      probeId,
      `session runner pid ${record.runnerPid} does not name metadata host ${initial.hostPid}`,
      initial,
    );
  }
  if (initial.mirrorOfNode) {
    return uncertain(record, observerId, observedAt, probeId, "remote mirror has no local host birth to re-adopt", initial);
  }

  const inspectHost = deps.inspectHost ?? inspectHsrHostProcess;
  const probeControl = deps.probeControl ?? probeHsrControl;
  const [hostVerdict, control] = await Promise.all([
    inspectHost(initial).catch(() => "unverifiable" as const),
    probeControl(initial).catch((error) => ({ status: "unreachable" as const, detail: message(error) })),
  ]);

  let finalMeta: HsrMeta | null;
  try {
    finalMeta = await (deps.readMeta ?? readHsrMetaStrict)(record.name);
  } catch (error) {
    return uncertain(record, observerId, observedAt, probeId, `metadata re-read failed: ${message(error)}`, initial);
  }
  if (!finalMeta || !sameHsrHostIncarnation(initial, finalMeta)) {
    return uncertain(record, observerId, observedAt, probeId, "runtime incarnation changed during probe", initial);
  }

  if (
    hostVerdict === "match" &&
    control.status === "matched" &&
    sameHsrHostIncarnation(initial, control.meta) &&
    control.meta.status !== "exited"
  ) {
    const detail = `host birth matched; control socket owns ${control.meta.status} incarnation`;
    return {
      classification: "live",
      record,
      evidence: evidenceFor(record, observerId, "alive", observedAt, probeId, detail, initial.hostPid) as ProbeEvidence & {
        outcome: "alive";
      },
      diskMeta: initial,
      ownedMeta: control.meta,
      staleExitedMeta: initial.status === "exited",
    };
  }

  if ((hostVerdict === "gone" || hostVerdict === "mismatch") && control.status === "absent") {
    const detail = `host birth ${hostVerdict}; control socket absent (${control.detail})`;
    return {
      classification: "dead",
      record,
      evidence: evidenceFor(record, observerId, "dead", observedAt, probeId, detail, initial.hostPid) as ProbeEvidence & {
        outcome: "dead";
      },
      diskMeta: initial,
      hostVerdict,
    };
  }

  const controlDetail = control.status === "matched"
    ? `socket answered for ${control.meta.hostPid}/${control.meta.status}`
    : control.detail;
  return uncertain(
    record,
    observerId,
    observedAt,
    probeId,
    `contradictory or incomplete proof: host=${hostVerdict}; control=${control.status} (${controlDetail})`,
    initial,
  );
}

/** One strict, bounded-concurrency boot sweep over every non-archived HSR record. */
export async function runBootReAdoptionSweep(options: BootReAdoptionOptions): Promise<HsrReAdoptionProbe[]> {
  const records = (await (options.listRecords ?? listSessionsStrict)()).filter(isHsrReAdoptionCandidate);
  return mapWithConcurrency(
    records,
    Math.max(1, options.concurrency ?? 16),
    (record) => probeHsrReAdoption(record, options.observerId, options),
  );
}

/** Default bounded socket witness used by boot and periodic re-probes. */
export async function probeHsrControl(meta: HsrMeta): Promise<HsrControlProbe> {
  try {
    const client = await connectRpcClient(meta.controlSocket, { connectTimeoutMs: 1_000 });
    try {
      const owned = controlMeta(await client.call("meta", undefined, { timeoutMs: 1_000 }));
      if (!owned) {
        return { status: "unreachable", detail: "control socket returned malformed metadata" };
      }
      return { status: "matched", meta: owned };
    } finally {
      client.close();
    }
  } catch (error) {
    const detail = message(error);
    if (/no socket at path|connection refused/i.test(detail)) {
      return { status: "absent", detail };
    }
    return { status: "unreachable", detail };
  }
}

/**
 * Ask a proven-live host to re-publish its own current metadata. This is the
 * only safe false-exit repair: the daemon never writes a cached running cursor,
 * and the host serializes this RPC with its real finalize write.
 */
export async function reassertHsrControlMeta(expected: HsrMeta): Promise<HsrMeta> {
  const client = await connectRpcClient(expected.controlSocket, { connectTimeoutMs: 1_000 });
  try {
    const owned = controlMeta(await client.call("reassertMeta", undefined, { timeoutMs: 1_000 }));
    if (!owned) throw new Error("control socket returned malformed reasserted metadata");
    if (!sameHsrHostIncarnation(expected, owned)) throw new Error("runtime incarnation changed before metadata repair");
    if (owned.status === "exited") throw new Error("runner finalized before metadata repair");
    return owned;
  } finally {
    client.close();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
