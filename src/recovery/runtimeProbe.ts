import { randomUUID } from "node:crypto";
import { probeHsrReAdoption } from "../daemon/reAdoption.js";
import type { ProbeEvidence } from "../stateMachine.js";
import type { SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import type { RemoteHsrSubstrate } from "../substrates/remote-hsr.js";
import type { Substrate } from "../substrates/types.js";

export type RecoverableRuntimeProbeDeps = {
  resolveSubstrate?: (record: SessionRecord) => Substrate;
};

function remoteTarget(record: SessionRecord): ProbeEvidence["target"] {
  return {
    substrate: "remote-hsr",
    node: record.node,
    remoteLaunchId: record.remoteLaunchId,
    remoteIncarnation: record.remoteIncarnation,
  };
}

function remoteEvidence(
  record: SessionRecord,
  observerId: string,
  observedAt: string,
  probeId: string,
  outcome: ProbeEvidence["outcome"],
  detail: string,
): ProbeEvidence {
  return {
    kind: "probe",
    probeId,
    observerId,
    observedAt,
    outcome,
    target: remoteTarget(record),
    detail,
  };
}

/**
 * Probe a recoverable HSR runtime with generation-qualified remote authority.
 * A same-name successor can never satisfy an older SessionRecord's liveness:
 * the durable head must match both immutable tokens and a live head must also
 * authorize a token-qualified events read (which reconciles host birth).
 */
export async function probeRecoverableRuntime(
  record: SessionRecord,
  observerId: string,
  deps: RecoverableRuntimeProbeDeps = {},
): Promise<ProbeEvidence> {
  const substrate = (deps.resolveSubstrate ?? substrateFor)(record);
  if (substrate.kind !== "remote-hsr") {
    return (await probeHsrReAdoption(record, observerId)).evidence;
  }

  const remote = substrate as RemoteHsrSubstrate;
  const observedAt = new Date().toISOString();
  const probeId = `${observerId}:${record.runtimeGeneration ?? 0}:${randomUUID()}`;
  try {
    const head = await remote.launchHeadRemote(record.name);
    if (head.state === "empty") {
      // Legacy remote generations predate durable receipts. Preserve their
      // name-liveness compatibility, but never call it token-qualified proof.
      if (record.remoteLaunchId || record.remoteIncarnation) {
        return remoteEvidence(
          record,
          observerId,
          observedAt,
          probeId,
          "unreachable",
          "remote authority no longer has the canonical launch generation",
        );
      }
      const live = await remote.hasSession(record.tmuxTarget);
      return remoteEvidence(
        record,
        observerId,
        observedAt,
        probeId,
        live ? "alive" : "dead",
        live ? "legacy remote authority verified name liveness" : "remote authority verified legacy run state absent",
      );
    }

    if (
      !record.remoteLaunchId || !record.remoteIncarnation
      || head.launchId !== record.remoteLaunchId
      || head.incarnation !== record.remoteIncarnation
    ) {
      return remoteEvidence(
        record,
        observerId,
        observedAt,
        probeId,
        "unreachable",
        "canonical remote launch tokens no longer own the authority head",
      );
    }
    if (head.state === "stopped") {
      return remoteEvidence(record, observerId, observedAt, probeId, "dead", "remote authority verified the exact launch generation stopped");
    }
    if (head.state !== "running") {
      return remoteEvidence(
        record,
        observerId,
        observedAt,
        probeId,
        "unreachable",
        `remote authority launch generation is ${head.state}`,
      );
    }

    const live = await remote.hasSession(record.tmuxTarget);
    if (!live) {
      return remoteEvidence(record, observerId, observedAt, probeId, "dead", "remote authority verified the exact running head has no live host");
    }
    await remote.eventsTail(record.name, undefined, {
      remoteLaunchId: record.remoteLaunchId,
      remoteIncarnation: record.remoteIncarnation,
    });
    return remoteEvidence(record, observerId, observedAt, probeId, "alive", "remote authority verified the exact launch generation live");
  } catch (error) {
    return remoteEvidence(
      record,
      observerId,
      observedAt,
      probeId,
      "unreachable",
      error instanceof Error ? error.message : String(error),
    );
  }
}
