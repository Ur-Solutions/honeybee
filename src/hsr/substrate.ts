/**
 * SubstrateHsr (APIA-76) — the record-level, local-only HSR substrate.
 *
 * HSR bees run under a detached, self-supervising runner host (see host.ts and
 * HSR_EXPLORATION.md §7), NOT inside a tmux session. This substrate therefore
 * never talks to tmux: it observes bees by reading their run dirs (meta.json,
 * ring.txt) and steers/stops them over each bee's per-bee JSON-RPC control
 * socket. Spawn does not go through `newSession` — the spawn path forks the
 * runner host directly (`hive __hsr-run`) and only then records the bee — so the
 * `newSession` verb throws.
 *
 * For an HSR bee the `target` argument passed to every method IS the bee name
 * (spawn sets `record.tmuxTarget = record.name`, a logical id). There are no
 * panes, so `paneId` args are ignored.
 *
 * Node builtins only.
 */

import type {
  KillResult,
  LaunchSpec,
  NewSessionResult,
  ProbeResult,
  SendTextOptions,
  Substrate,
  TmuxWindowOptions,
} from "../substrates/types.js";
import { defaultIsPidAlive as isPidAlive } from "../fsx.js";
import { LOCAL_NODE } from "../substrates/types.js";
import {
  ensureOrphanedChildGroupStopped,
  hsrSnapshot,
  inspectHsrHostProcess,
  listHsrBees,
  type HsrProcessSignalDependencies,
} from "./observe.js";
import {
  HsrSourceEventLogBusyError,
  hsrMetaProvesProviderNeverStarted,
  isHsrEventHistoryQuarantined,
  readHsrMeta,
  readHsrMetaStrict,
  sealHsrEventStreamClosure,
  verifyHsrEventStreamClosure,
  writeHsrMeta,
  type HsrMeta,
} from "./runDir.js";
import { readProcessBirthFingerprint, sameProcessBirthFingerprint } from "./processIdentity.js";
import { connectRpcClient } from "./rpc.js";
import {
  cancelPendingHsrTurnIfQueued,
  enqueuePendingHsrTurn,
  HsrDeliveryAmbiguousError,
  HsrDeliveryDiscardedError,
  HsrDeliveryIdentityConflictError,
  HsrDeliveryInFlightError,
  markPendingHsrTurnAmbiguous,
  readPendingHsrTurn,
  readPendingHsrTurns,
  settlePendingHsrTurnsForIntentionalStop,
  withHsrTurnDeliveryLock,
} from "./pendingTurns.js";
import { stopSpawnedHsrHost } from "./runnerHost.js";
import {
  HsrSourceEventIntegrityError,
  assertHsrSourceEventLogIntegrity,
  hsrEventIntegrityReceiptOwnsHost,
  readHsrEventIntegrityReceipt,
  recordHsrEventIntegrityStop,
  type HsrEventIntegrityReceipt,
} from "./eventIntegrity.js";

/** A queued or running host is live while its detached host pid is alive. */
async function hasSession(bee: string, deps: HsrProcessSignalDependencies = {}): Promise<boolean> {
  const meta = await readHsrMetaStrict(bee);
  if (!meta || meta.status === "exited") return false;
  if (meta.mirrorOfNode) return meta.status === "running";
  return await inspectHsrHostProcess(meta, deps) === "match";
}

/** Rendered text tail from ring.txt (Substrate.capture compat). */
async function capture(bee: string, lines?: number): Promise<string> {
  return hsrSnapshot(bee, lines);
}

/** Deliver a user turn over the bee's control socket. Throws if no live host. */
async function sendText(bee: string, text: string, _paneId?: string, options?: SendTextOptions): Promise<void> {
  await withHsrTurnDeliveryLock(bee, async () => {
    const callerDeliveryId = options?.deliveryId;
    const mode = options?.mode === "next-tool" ? "next-tool" as const : "turn" as const;
    const durableTurns = await readPendingHsrTurns(bee);
    const exact = callerDeliveryId
      ? durableTurns.find((candidate) => candidate.id === callerDeliveryId)
      : undefined;
    if (exact && (exact.text !== text || exact.mode !== mode)) {
      throw new HsrDeliveryIdentityConflictError(
        callerDeliveryId!,
        `HSR delivery id ${callerDeliveryId} is already bound to different content or delivery mode`,
      );
    }
    if (exact?.phase === "completed") return;
    if (exact?.phase === "ambiguous") {
      throw new HsrDeliveryAmbiguousError(
        exact.id,
        exact.error ?? `HSR delivery ${exact.id} is durably ambiguous`,
      );
    }
    if (exact?.phase === "discarded") {
      throw new HsrDeliveryDiscardedError(exact.id, `HSR delivery ${exact.id} was explicitly discarded`);
    }
    // A completed same-id replay is a receipt lookup, not new work. Every
    // other fresh delivery is ordered behind a prior durable ambiguity so a
    // caller cannot bypass an uncertain provider acceptance with a new id.
    const olderAmbiguity = durableTurns.find((candidate) =>
      candidate.phase === "ambiguous" && candidate.id !== callerDeliveryId);
    if (olderAmbiguity) {
      throw new HsrDeliveryAmbiguousError(
        olderAmbiguity.id,
        olderAmbiguity.error ?? `HSR delivery ${olderAmbiguity.id} is durably ambiguous; refusing later work`,
      );
    }
    const abandonedDispatch = durableTurns.find((candidate) =>
      candidate.phase === "dispatching" && candidate.id !== callerDeliveryId);
    if (abandonedDispatch) {
      const detail = `HSR delivery ${abandonedDispatch.id} was left at caller dispatch without a settled RPC outcome; refusing later work`;
      if (abandonedDispatch.host?.hostFingerprint) {
        await markPendingHsrTurnAmbiguous(bee, abandonedDispatch.id, abandonedDispatch.host, detail);
      }
      throw new HsrDeliveryAmbiguousError(abandonedDispatch.id, detail);
    }
    const meta = await readHsrMeta(bee);
    if (meta) {
      await assertHsrSourceEventLogIntegrity({
        bee,
        meta,
        operation: "HSR delivery",
      });
    }
    const live = !!meta && (meta.mirrorOfNode ? meta.status === "running" : await inspectHsrHostProcess(meta) === "match");
    if (meta?.status === "queued" && live) {
      // A queued/booting host has no live turn — the pending turn drains once
      // its harness and control socket are ready, so delivery mode is moot.
      const queued = await enqueuePendingHsrTurn(bee, text, {
        ...(options?.deliveryId ? { deliveryId: options.deliveryId } : {}),
        mode,
      });
      if (options?.completionRequired) {
        throw new HsrDeliveryInFlightError(
          queued.id,
          `HSR delivery ${queued.id} is durably queued until the host completes it`,
        );
      }
      return;
    }
    if (!meta || meta.status !== "running" || !live) {
      throw new Error(`HSR bee ${bee} has no live runner host to steer`);
    }
    if (!meta.hostFingerprint) {
      throw new Error(`HSR bee ${bee} has no birth-qualified host identity for delivery`);
    }
    const turn = await enqueuePendingHsrTurn(bee, text, {
      ...(options?.deliveryId ? { deliveryId: options.deliveryId } : {}),
      mode,
    });
    const host = {
      hostPid: meta.hostPid,
      startedAt: meta.startedAt,
      hostFingerprint: meta.hostFingerprint,
    };
    const exactOnCurrentHost = !!exact?.host &&
      exact.host.hostPid === host.hostPid &&
      exact.host.startedAt === host.startedAt &&
      sameProcessBirthFingerprint(exact.host.hostFingerprint, host.hostFingerprint);
    if (exactOnCurrentHost && (exact.phase === "accepted" || exact.phase === "started")) {
      if (options?.completionRequired) {
        throw new HsrDeliveryInFlightError(
          turn.id,
          `HSR delivery ${turn.id} is ${exact.phase} on this host`,
        );
      }
      return;
    }
    if (exactOnCurrentHost && exact.phase === "dispatching") {
      throw new HsrDeliveryInFlightError(
        turn.id,
        `HSR delivery ${turn.id} is already dispatching on this host`,
      );
    }
    let client: Awaited<ReturnType<typeof connectRpcClient>> | undefined;
    try {
      try {
        client = await connectRpcClient(meta.controlSocket);
        // `queued` is the caller's durable offer. The host alone atomically
        // claims queued -> dispatching after it has received this request and
        // immediately before session.send. A coordinator crash before the
        // host claim can therefore retry this exact id without manual repair.
        await client.call("send", {
          text,
          deliveryId: turn.id,
          ...(mode === "next-tool" ? { mode: "next-tool" } : {}),
        });
      } catch (error) {
        // The host may have durably advanced the delivery before its RPC reply
        // was lost. Same-host accepted/started is not re-sent, but Buz keeps
        // its queue item until completed so a later host crash remains visible.
        let current;
        try {
          const cancellation = await cancelPendingHsrTurnIfQueued(bee, turn.id);
          if (cancellation.cancelled) throw error;
          current = cancellation.turn;
        } catch (readError) {
          if (readError === error) throw error;
          throw new HsrDeliveryAmbiguousError(
            turn.id,
            `HSR delivery ${turn.id} crossed RPC dispatch and its durable outcome is unreadable`,
            { cause: new AggregateError([error, readError], "RPC failure and unreadable HSR delivery journal") },
          );
        }
        if (current?.phase === "completed") return;
        if (current?.phase === "accepted" || current?.phase === "started") {
          if (options?.completionRequired) {
            throw new HsrDeliveryInFlightError(turn.id, `HSR delivery ${turn.id} is ${current.phase} on this host`);
          }
          return;
        }
        if (current?.phase === "ambiguous") {
          throw new HsrDeliveryAmbiguousError(turn.id, current.error ?? `HSR delivery ${turn.id} is ambiguous`, { cause: error });
        }
        if (current?.phase === "auth_failed") {
          throw new HsrDeliveryInFlightError(
            turn.id,
            `HSR delivery ${turn.id} is awaiting exact auth recovery`,
          );
        }
        if (
          current?.phase === "dispatching" &&
          (error as { code?: unknown } | null)?.code === -32000 &&
          /already dispatching on this host/.test(error instanceof Error ? error.message : String(error))
        ) {
          throw new HsrDeliveryInFlightError(
            turn.id,
            `HSR delivery ${turn.id} is already dispatching on this host`,
          );
        }
        const detail = `HSR delivery ${turn.id} lost its RPC outcome after durable dispatch: ${error instanceof Error ? error.message : String(error)}`;
        try {
          await markPendingHsrTurnAmbiguous(bee, turn.id, host, detail);
        } catch (persistError) {
          throw new HsrDeliveryAmbiguousError(
            turn.id,
            `${detail}; ambiguity marker persistence also failed`,
            { cause: new AggregateError([error, persistError], "RPC failure and ambiguity persistence failure") },
          );
        }
        throw new HsrDeliveryAmbiguousError(turn.id, detail, { cause: error });
      }
      if (options?.completionRequired) {
        const current = await readPendingHsrTurn(bee, turn.id);
        if (current?.phase === "completed") return;
        if (current?.phase === "ambiguous") {
          throw new HsrDeliveryAmbiguousError(turn.id, current.error ?? `HSR delivery ${turn.id} is ambiguous`);
        }
        throw new HsrDeliveryInFlightError(
          turn.id,
          `HSR delivery ${turn.id} is ${current?.phase ?? "dispatching"}; queue remains durable until completion`,
        );
      }
    } finally {
      client?.close();
    }
  });
}

/** Poll the same runtime incarnation until it is no longer live. */
function sameHostIncarnation(left: HsrMeta, right: HsrMeta | null): boolean {
  return !!right && left.hostPid === right.hostPid && left.startedAt === right.startedAt &&
    sameProcessBirthFingerprint(left.hostFingerprint, right.hostFingerprint);
}

async function waitUntilHostStopped(
  bee: string,
  expected: HsrMeta,
  timeoutMs: number,
  deps: HsrProcessSignalDependencies = {},
): Promise<boolean> {
  // An exited pre-fingerprint host is never safe to signal, but exact numeric
  // PID absence is sufficient to prove that the recorded host is no longer
  // running. A live/reused PID or an unreadable census remains unconfirmed.
  if (expected.status === "exited" && !expected.hostFingerprint) {
    try {
      const current = await (deps.readProcessIdentity ?? readProcessBirthFingerprint)(expected.hostPid);
      if (current === null) return true;
    } catch {
      return false;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await inspectHsrHostProcess(expected, deps);
    if (identity === "gone" || identity === "mismatch") return true;
    if (identity === "unverifiable") return false;
    // Remote/in-process hosts deliberately share this process (the host test
    // exercises that supported shape). Their process cannot exit when one
    // logical HSR session stops, so the incarnation's finalized meta is the
    // strongest available confirmation. Detached production hosts always have
    // another pid and still require observed OS exit below.
    if (expected.hostPid === process.pid) {
      const latest = await readHsrMetaStrict(bee);
      if (sameHostIncarnation(expected, latest) && latest?.status === "exited") return true;
    }
    await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(50);
  }
  // Meta status is not enough: finalize writes `exited` immediately before the
  // host process itself returns. Confirm OS liveness so terminal Run state can
  // never race that final process-exit window.
  const identity = await inspectHsrHostProcess(expected, deps);
  if (identity === "gone" || identity === "mismatch") return true;
  if (identity !== "match" || expected.hostPid !== process.pid) return false;
  const latest = await readHsrMetaStrict(bee);
  return sameHostIncarnation(expected, latest) && latest?.status === "exited";
}

async function confirmChildGroupStopped(
  meta: HsrMeta | null,
  deps: HsrProcessSignalDependencies = {},
): Promise<boolean> {
  return ensureOrphanedChildGroupStopped(meta, deps);
}

/**
 * Numeric-absence death proof for a host whose birth fingerprint is not
 * comparable (legacy or hand-repaired metadata). Exact PID absence still
 * proves the RECORDED host process no longer exists — the same carve-out
 * waitUntilHostStopped grants exited pre-fingerprint metas, extended to
 * stale `running` metas so a long-dead host cannot wedge kill/revive
 * forever behind "HSR stop unconfirmed" (cell-smoothness Phase 2). A live,
 * reused, or unreadable pid stays unconfirmed; mirrors and sentinel pids
 * are never death-provable this way.
 */
async function recordedHostPidAbsent(meta: HsrMeta, deps: HsrProcessSignalDependencies): Promise<boolean> {
  if (meta.mirrorOfNode || !Number.isSafeInteger(meta.hostPid) || meta.hostPid <= 0) return false;
  if (meta.hostPid === process.pid) return false;
  try {
    return (await (deps.readProcessIdentity ?? readProcessBirthFingerprint)(meta.hostPid)) === null;
  } catch {
    return false;
  }
}

/**
 * Publish a proven stop outcome onto the exact incarnation's metadata. A
 * confirmed-stopped host whose meta still says queued/running re-enters every
 * observer and stop path looking alive (the revive wedge: each retry re-fails
 * the same verification). Mirrors reapDeadHosts' flip; best-effort — the stop
 * result stands even when the write fails, and a replacement incarnation's
 * metadata is never touched.
 */
async function publishProvenStop(bee: string, initial: HsrMeta, current: HsrMeta | null): Promise<void> {
  // Only the freshly-read on-disk meta authorizes the write: a replacement
  // incarnation's metadata (or an already-final record) is never overwritten.
  // Unlike the signalling paths, a pair of fingerprint-LESS metas with the
  // same pid + startedAt is the same incarnation for this non-destructive
  // publication — legacy metas must not be exempt from the flip.
  if (!current || current.status === "exited") return;
  const sameIncarnation = initial.hostPid === current.hostPid && initial.startedAt === current.startedAt &&
    (sameProcessBirthFingerprint(initial.hostFingerprint, current.hostFingerprint) ||
      (initial.hostFingerprint === undefined && current.hostFingerprint === undefined));
  if (!sameIncarnation) return;
  await writeHsrMeta(bee, { ...current, status: "exited", endedAt: new Date().toISOString() }).catch(() => undefined);
}

type StoppedSourceHistory =
  | { kind: "clean" }
  | { kind: "acknowledged" }
  | { kind: "integrity"; receipt: HsrEventIntegrityReceipt };

/**
 * Classify the event stream only after exact host + descendant absence is
 * proven. A dead process is not proof that every provider byte/effect reached
 * events.jsonl: SIGKILL can land before the append begins. Clean replacement
 * therefore requires either a host-authored closure that still verifies, an
 * exact terminal exit we can seal now, or durable proof that the adapter never
 * started. Every other outcome becomes purge-surviving manual authority.
 */
async function settleStoppedSourceHistory(
  bee: string,
  initial: HsrMeta,
  current: HsrMeta,
): Promise<StoppedSourceHistory> {
  // A local remote mirror is a derived projection, never the provider event
  // source. Its generation/cursor protocol owns integrity and teardown; do not
  // manufacture a local source-loss receipt from the hostPid=0 sentinel.
  if (current.mirrorOfNode) return { kind: "clean" };
  const host = {
    hostPid: initial.hostPid,
    startedAt: initial.startedAt,
    ...(initial.hostFingerprint ? { hostFingerprint: initial.hostFingerprint } : {}),
  };
  const existing = await readHsrEventIntegrityReceipt(bee);
  if (existing?.phase === "unresolved") {
    if (!hsrEventIntegrityReceiptOwnsHost(existing, host)) {
      throw new Error(`event-integrity authority belongs to a different ${bee} incarnation`);
    }
    return { kind: "integrity", receipt: existing };
  }
  if (
    existing?.phase === "acknowledged"
    && existing.stopState === "confirmed"
    && hsrEventIntegrityReceiptOwnsHost(existing, host)
    && await isHsrEventHistoryQuarantined(bee, existing.integrityId)
  ) return { kind: "acknowledged" };

  // A host-authored append-failure marker is direct missing-event evidence.
  // A later exit can be perfectly contiguous because the lost event never
  // acquired a sequence; it must never launder this marker into clean proof.
  if (!current.eventIntegrityFailure) {
    if (hsrMetaProvesProviderNeverStarted(current)) return { kind: "clean" };
    if (current.eventStreamClosure) {
      try {
        if (await verifyHsrEventStreamClosure(bee, current, 250)) return { kind: "clean" };
      } catch (error) {
        if (error instanceof HsrSourceEventLogBusyError) throw error;
        // Invalid closure/history falls through to the durable integrity fence.
      }
    }

    try {
      const closure = await sealHsrEventStreamClosure(bee, current, 250);
      const latest = await readHsrMetaStrict(bee);
      if (!sameHostIncarnation(initial, latest)) {
        throw new Error(`HSR source authority changed while sealing ${bee}'s clean exit`);
      }
      await writeHsrMeta(bee, {
        ...latest!,
        status: "exited",
        exitCode: latest!.exitCode ?? null,
        endedAt: latest!.endedAt ?? closure.closedAt,
        eventStreamClosure: closure,
      });
      const healed = await readHsrMetaStrict(bee);
      if (!sameHostIncarnation(initial, healed) || !healed?.eventStreamClosure) {
        throw new Error(`HSR clean-exit proof for ${bee} was not durably published`);
      }
      return { kind: "clean" };
    } catch (cause) {
      if (cause instanceof HsrSourceEventLogBusyError) throw cause;
    }
  }

  try {
    await assertHsrSourceEventLogIntegrity({
      bee,
      meta: {
        ...current,
        eventIntegrityFailure: current.eventIntegrityFailure
          ?? "runner host stopped without a durable clean event-stream closure",
      },
      operation: "HSR stopped-source history settlement",
    });
    throw new Error(`HSR stopped-source integrity guard unexpectedly admitted ${bee}`);
  } catch (error) {
    if (!(error instanceof HsrSourceEventIntegrityError)) throw error;
  }
  const receipt = await readHsrEventIntegrityReceipt(bee);
  if (!receipt || receipt.phase !== "unresolved" || !hsrEventIntegrityReceiptOwnsHost(receipt, host)) {
    throw new Error(`HSR stopped-source integrity receipt for ${bee} was not durably published`);
  }
  return { kind: "integrity", receipt };
}

/**
 * Best-effort stop: ask the host to stop cleanly over the control socket and
 * give it a brief grace to finalize (the host's stop tears down the harness
 * child, then flips meta to "exited"). Only if that clean stop does not take —
 * the socket is dead/unreachable, or the host ignores it — SIGTERM the host pid
 * as a fallback (its SIGTERM handler stops the child too). Never throws —
 * killing an already-dead bee is a no-op success.
 */
export async function stopHsrIncarnation(
  bee: string,
  initial: HsrMeta,
  deps: HsrProcessSignalDependencies = {},
): Promise<KillResult> {
  // An `exited` meta can be visible just before the detached host process
  // returns. Treat it as a reason not to signal a possibly recycled pid, but
  // still confirm both the recorded host incarnation and its child group.
  let stopped = initial.status === "exited"
    ? await waitUntilHostStopped(bee, initial, 1_000, deps)
    : false;
  // `ownedMeta` may learn childPid/childPgid only while meta still names the
  // initial host. A replacement incarnation is never adopted for cleanup.
  let ownedMeta: HsrMeta = initial;
  if (initial.status !== "exited" && initial.controlSocket) {
    try {
      const client = await connectRpcClient(initial.controlSocket);
      try {
        await client.call("stop");
      } finally {
        client.close();
      }
      stopped = await waitUntilHostStopped(bee, initial, 2_500, deps);
    } catch {
      // Host unreachable / socket stale — fall through to the signal fallback.
    }
  }
  // Fall back to an OS signal only after re-validating the exact host birth.
  // An `exited` meta does not by itself prove the detached host process has
  // returned: finalize publishes `exited` before runner-entry exits, and a slow
  // or stuck finalizer can remain observable during an immediate account swap.
  // The persisted birth fingerprint is the safety boundary here. A matching
  // birth authorizes signalling that exact lingering host; a recycled,
  // fingerprint-less, or otherwise unverifiable pid never does.
  if (!stopped) {
    const latest = await readHsrMetaStrict(bee);
    if (sameHostIncarnation(initial, latest)) ownedMeta = latest!;
    // Only signal the exact runtime incarnation read at entry. A replacement
    // host under the same bee name is not ours to shoot by a recycled pid.
    const hostIdentity = await inspectHsrHostProcess(initial, deps);
    if (latest && sameHostIncarnation(initial, latest) && hostIdentity === "match") {
      try {
        (deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)))(initial.hostPid, "SIGTERM");
      } catch {
        // Already gone or not signalable.
      }
      stopped = await waitUntilHostStopped(bee, initial, 2_000, deps);
      if (!stopped) {
        const current = await readHsrMetaStrict(bee);
        const currentIdentity = await inspectHsrHostProcess(initial, deps);
        if (current && sameHostIncarnation(initial, current) && currentIdentity === "match") {
          try {
            (deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)))(initial.hostPid, "SIGKILL");
          } catch {
            // Already gone or not signalable.
          }
        }
        stopped = await waitUntilHostStopped(bee, initial, 1_000, deps);
      }
    } else {
      // Missing/replacement/exited meta never authorizes a signal. A gone or
      // different OS birth proves only that the INITIAL host is gone; a match
      // behind replacement metadata stays unconfirmed. An unverifiable birth
      // (legacy/hand-repaired meta without a comparable fingerprint) may still
      // be death-proven by exact numeric PID absence; a live or unreadable
      // pid keeps failing closed.
      stopped = hostIdentity === "gone" || hostIdentity === "mismatch" ||
        (hostIdentity === "unverifiable" && await recordedHostPidAbsent(initial, deps)) ||
        (initial.hostPid === process.pid && sameHostIncarnation(initial, latest) && latest?.status === "exited");
    }
  }

  const finalMeta = await readHsrMetaStrict(bee);
  if (sameHostIncarnation(initial, finalMeta)) ownedMeta = finalMeta!;
  const childStopped = stopped ? await confirmChildGroupStopped(ownedMeta, deps) : false;
  const confirmed = stopped && childStopped;
  if (confirmed) {
    let sourceHistory: StoppedSourceHistory;
    try {
      sourceHistory = await settleStoppedSourceHistory(bee, initial, ownedMeta);
    } catch (error) {
      return {
        ok: false,
        stdout: "",
        stderr: `HSR runtime stopped but source-history settlement is unconfirmed for ${bee}: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: 1,
      };
    }
    if (sourceHistory.kind === "integrity") {
      await recordHsrEventIntegrityStop(
        bee,
        sourceHistory.receipt.integrityId,
        sourceHistory.receipt.host,
        "confirmed",
        "local controller exact host and child-group stop proof",
      );
    }
    try {
      await settlePendingHsrTurnsForIntentionalStop(bee);
    } catch (error) {
      return {
        ok: false,
        stdout: "",
        stderr: `HSR runtime stopped but durable delivery ownership could not be settled for ${bee}: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: 1,
      };
    }
    if (sourceHistory.kind === "clean" || sourceHistory.kind === "acknowledged") {
      await publishProvenStop(bee, initial, await readHsrMetaStrict(bee));
    }
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }
  return {
    ok: false,
    stdout: "",
    stderr: `HSR stop unconfirmed for ${bee}: host or detached harness process group remains live`,
    exitCode: 1,
  };
}

/**
 * Stop only the runner-host incarnation returned by spawnHsrHost. If metadata
 * already names a replacement, leave it untouched and report whether the
 * launched pid is independently confirmed gone.
 */
export async function stopHsrIncarnationByPid(bee: string, expectedHostPid: number): Promise<KillResult> {
  // Check the spawn handle before metadata. If this process already reaped the
  // exact child, a recycled same-number pid in replacement metadata must never
  // be adopted or signalled.
  const current = await readHsrMetaStrict(bee);
  if (current?.hostPid === expectedHostPid) return stopHsrIncarnation(bee, current);
  // Publication may lag spawn. The spawning process retains the returned
  // ChildProcess handle, so rollback does not adopt whatever same-name
  // metadata appeared meanwhile; the host's SIGTERM path retains its existing
  // birth-validated descendant teardown.
  const spawnedStop = await stopSpawnedHsrHost(expectedHostPid);
  // The exact host handle proves only host exit. Without metadata, a detached
  // harness child may have escaped during startup, so neither a clean handle
  // exit nor numeric pid absence is sufficient child-group absence proof.
  return {
    ok: false,
    stdout: "",
    stderr: `HSR stop unconfirmed for ${bee}: ${
      spawnedStop === "unconfirmed" || isPidAlive(expectedHostPid)
        ? `launched host ${expectedHostPid} or its child tree remains observable`
        : `metadata does not prove child absence for launched host ${expectedHostPid}`
    }`,
    exitCode: 1,
  };
}

/** Generic user kill also fails closed when the child locator is absent. */
async function kill(bee: string, deps: HsrProcessSignalDependencies = {}): Promise<KillResult> {
  const initial = await readHsrMetaStrict(bee);
  if (!initial) {
    return {
      ok: false,
      stdout: "",
      stderr: `HSR stop unconfirmed for ${bee}: metadata is absent and detached child absence is unproven`,
      exitCode: 1,
    };
  }
  return stopHsrIncarnation(bee, initial, deps);
}

/**
 * Strict stop for an execution launcher that already knows spawn returned.
 * Missing metadata is not evidence that the detached host is dead: startup
 * publication may simply be late, so terminal failure must remain forbidden.
 */
export async function stopKnownHsrExecution(bee: string): Promise<KillResult> {
  const initial = await readHsrMetaStrict(bee);
  if (!initial) {
    return {
      ok: false,
      stdout: "",
      stderr: `HSR stop unconfirmed for ${bee}: spawned runtime metadata is not yet observable`,
      exitCode: 1,
    };
  }
  return stopHsrIncarnation(bee, initial);
}

let cached: Substrate | undefined;

/** The singleton HSR substrate (local-only, record-routed). */
export function hsrSubstrate(): Substrate {
  if (cached) return cached;
  cached = createHsrSubstrate();
  return cached;
}

/** Injectable HSR substrate for deterministic incarnation-safety tests. */
export function createHsrSubstrate(processSignals: HsrProcessSignalDependencies = {}): Substrate {
  return {
    kind: "hsr",
    node: LOCAL_NODE,
    // The runner host sees tool events inline, so it can hold a next-tool send.
    supportsNextTool: true,
    async probe(): Promise<ProbeResult> {
      return { ok: true };
    },
    hasSession: (target: string) => hasSession(target, processSignals),
    // Spawn forks the runner host directly (hive __hsr-run) and records the bee;
    // it never routes through newSession.
    newSession(): Promise<NewSessionResult> {
      throw new Error("HSR bees spawn via the runner host, not newSession");
    },
    // Combs are retired (APIA-85): no newPane/killPane. Killing an HSR bee is
    // killing its runner host (kill), since there is no pane.
    kill: (target: string) => kill(target, processSignals),
    capture: (target: string, lines?: number) => capture(target, lines),
    sendText: (target: string, text: string, paneId?: string, options?: SendTextOptions) =>
      sendText(target, text, paneId, options),
    // HSR turns are committed atomically by sendText (the runner encodes and
    // flushes one user message); there is no separate terminal Enter/keystroke
    // channel the way tmux has, so these are intentional no-ops.
    async sendEnter(): Promise<void> {
      /* no-op: HSR has no separate Enter — sendText commits the turn */
    },
    async sendKey(): Promise<void> {
      /* no-op: HSR has no keystroke channel */
    },
    listSessions: () => listHsrBees(),
    // No panes, and HSR state/liveness is answered by the observe/deriveState
    // follow-up (run-dir based), not tmux session-state options.
    async listPanes(): Promise<Set<string>> {
      return new Set();
    },
    async listSessionStates(): Promise<Map<string, string>> {
      return new Map();
    },
    // Best-effort tmux-only concerns; no-ops for a pane-less bee.
    async setUserOptions(): Promise<void> {
      /* no-op */
    },
    async setWindowOptions(_target: string, _options: TmuxWindowOptions | undefined): Promise<void> {
      /* no-op */
    },
    async renameWindow(): Promise<void> {
      /* no-op */
    },
    // No tmux target to attach; a read-only console tab is a later Apiary concern.
    attachCommand(): string[] {
      return [];
    },
    async attachSession(): Promise<void> {
      throw new Error("HSR bees have no tmux target; use hive tail/transcript");
    },
  };
}
