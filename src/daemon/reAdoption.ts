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
import { listSessionsStrict, type SessionRecord } from "../store.js";
import type { ProbeEvidence } from "../stateMachine.js";
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

/** Records whose runtime cursor still matters. Archived records never adopt. */
export function isHsrReAdoptionCandidate(record: SessionRecord): boolean {
  return record.substrate === "hsr" && record.status !== "done";
}

function sameHostIncarnation(left: HsrMeta, right: HsrMeta): boolean {
  return left.bee === right.bee &&
    left.hostPid === right.hostPid &&
    left.startedAt === right.startedAt &&
    sameProcessBirthFingerprint(left.hostFingerprint, right.hostFingerprint);
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
  if (!finalMeta || !sameHostIncarnation(initial, finalMeta)) {
    return uncertain(record, observerId, observedAt, probeId, "runtime incarnation changed during probe", initial);
  }

  if (
    hostVerdict === "match" &&
    control.status === "matched" &&
    sameHostIncarnation(initial, control.meta) &&
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
      const owned = await client.call("meta", undefined, { timeoutMs: 1_000 });
      if (!owned || typeof owned !== "object" || Array.isArray(owned)) {
        return { status: "unreachable", detail: "control socket returned malformed metadata" };
      }
      return { status: "matched", meta: owned as HsrMeta };
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
