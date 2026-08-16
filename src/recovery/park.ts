/** Lifecycle-serialized intentional HSR runtime parking. */

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { beeMailboxDir } from "../buz.js";
import { stopHsrRunner } from "../commands/migrate.js";
import { probeHsrReAdoption } from "../daemon/reAdoption.js";
import {
  withSessionLifecycleTransaction,
  type SessionLifecycleTransaction,
} from "../lifecycle.js";
import {
  legacyStateMachineSeed,
  transitionSession,
  type SessionRecord,
} from "../store.js";
import type { ParkingEvidence, ProbeEvidence } from "../stateMachine.js";

export type IdleRuntimeParkingIntent = {
  idleSince: string;
  graceMs: number;
  work: "done" | "needs-you";
};

export type ParkIdleHsrRuntimeDeps = {
  stop?: (record: SessionRecord) => Promise<void>;
  probe?: (record: SessionRecord) => Promise<ProbeEvidence>;
  transition?: typeof transitionSession;
  hasQueuedMessages?: (record: SessionRecord) => Promise<boolean>;
  now?: () => number;
  makeParkingId?: () => string;
};

export type ParkIdleHsrRuntimeResult = {
  record: SessionRecord;
  action: "parked" | "skipped";
  reason?: string;
  evidence?: ParkingEvidence;
  probe?: ProbeEvidence;
};

function axes(record: SessionRecord) {
  return record.stateMachine ?? legacyStateMachineSeed(record);
}

async function defaultHasQueuedMessages(record: SessionRecord): Promise<boolean> {
  const entries = await readdir(beeMailboxDir(record.name, "queue")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [] as string[];
    throw error;
  });
  return entries.some((name) => name.endsWith(".md"));
}

async function defaultProbe(record: SessionRecord): Promise<ProbeEvidence> {
  return (await probeHsrReAdoption(record, `idle-parking:${process.pid}`)).evidence;
}

function eligibilityReason(
  record: SessionRecord,
  intent: IdleRuntimeParkingIntent,
  nowMs: number,
): string | undefined {
  const state = axes(record);
  if (record.substrate !== "hsr") return "not-local-hsr";
  if (record.status !== "running" || state.lifecycle !== "active") return "inactive-lifecycle";
  if (state.runtime !== "live") return "runtime-not-live";
  // A needs-input prompt is not safely resumable across every harness. Codex,
  // Claude, Grok and OpenCode adapters retain parts of the pending answer
  // exchange in process-local maps; stopping that host can preserve the
  // durable request while destroying the actual response handle. Keep those
  // runtimes hot until the user answers or the turn settles.
  if (intent.work !== "done") return "interactive-request-open";
  if (state.work !== "done") return "work-changed";
  if (record.stateUnverified) return "runtime-unverified";
  if (!record.providerSessionId) return "missing-provider-session";
  const idleSinceMs = Date.parse(intent.idleSince);
  if (!Number.isFinite(idleSinceMs) || !Number.isFinite(intent.graceMs) || intent.graceMs < 0) {
    return "invalid-idle-evidence";
  }
  if (nowMs - idleSinceMs < intent.graceMs) return "grace-not-elapsed";
  return undefined;
}

/**
 * Stop and park one exact HSR runtime generation without filing the bee.
 *
 * The lifecycle transaction is deliberately held across the pre-stop proof,
 * strict incarnation teardown, post-stop proof, and bounded transition. A
 * direct/queued send either wins first and changes the work/generation fence,
 * or waits and wakes the fully parked generation; it can never race through a
 * half-stopped runtime.
 */
export async function parkIdleHsrRuntime(
  snapshot: SessionRecord,
  intent: IdleRuntimeParkingIntent,
  deps: ParkIdleHsrRuntimeDeps = {},
): Promise<ParkIdleHsrRuntimeResult> {
  return withSessionLifecycleTransaction(snapshot, async (lifecycle: SessionLifecycleTransaction) => {
    let record = await lifecycle.refresh();
    const nowMs = (deps.now ?? Date.now)();
    const ineligible = eligibilityReason(record, intent, nowMs);
    if (ineligible) return { record, action: "skipped", reason: ineligible };
    if (await (deps.hasQueuedMessages ?? defaultHasQueuedMessages)(record)) {
      return { record, action: "skipped", reason: "queued-send" };
    }

    const probe = deps.probe ?? defaultProbe;
    const liveProbe = await probe(record);
    if (liveProbe.outcome !== "alive") {
      if (liveProbe.outcome === "dead") {
        return { record, action: "skipped", reason: "runtime-died-before-offload", probe: liveProbe };
      }
      throw new Error(
        `idle parking: pre-stop probe was unreachable for ${record.name}: ${liveProbe.detail ?? "unverified runtime"}`,
      );
    }

    await (deps.stop ?? stopHsrRunner)(record);
    const deadProbe = await probe(record);
    if (deadProbe.outcome !== "dead") {
      throw new Error(
        `idle parking: post-stop probe returned ${deadProbe.outcome} for ${record.name}: ${deadProbe.detail ?? "stop unverified"}`,
      );
    }

    // The durable transition is dated by the post-stop proof, not the earlier
    // policy evaluation, so its evidence cannot appear to precede teardown.
    const observedAt = deadProbe.observedAt;
    const parkingId = (deps.makeParkingId ?? randomUUID)();
    const evidence: ParkingEvidence = {
      kind: "parking",
      parkingId,
      observedAt,
      policy: "idle-grace",
      idleSince: intent.idleSince,
      graceMs: intent.graceMs,
      runtimeGeneration: record.runtimeGeneration ?? 0,
      work: intent.work,
    };
    const transitioned = await (deps.transition ?? transitionSession)(record.name, {
      type: "runtime.parked",
      eventId: `runtime-parked:intentional:${record.name}:${evidence.runtimeGeneration}:${parkingId}`,
      at: observedAt,
      cause: "intentional-idle-offload",
      evidence,
      liveProbe,
      probe: deadProbe,
    });
    if (!transitioned) throw new Error(`idle parking: session disappeared while parking ${record.name}`);
    record = await lifecycle.refresh();
    return { record, action: "parked", evidence, probe: deadProbe };
  });
}
