/**
 * HSR runner-host entry (APIA-78) — the process-management heart.
 *
 * `runHsrHost` is the LOGIC a detached `hive __hsr-run <bee>` process runs
 * (HSR_EXPLORATION.md §7): it starts the harness via a RunnerAdapter, writes the
 * run dir, serves the per-bee JSON-RPC control socket, and reconciles meta.json
 * on exit. The CLI/daemon wiring that forks this detached lands in a later unit
 * and reuses this verbatim.
 *
 * Persistence split: the RUNNER (streamRunner.ts) is the sole writer of
 * events.jsonl + ring.txt. The host only BROADCASTS each event to live socket
 * observers and owns meta.json (start → sessionId-learned → exit). This keeps
 * the durable event log authored in exactly one place.
 *
 * Node builtins only. No cli.ts / daemon / SubstrateHsr coupling.
 */

import { performance } from "node:perf_hooks";
import { clearAccountBootFailure, recordAccountBootFailure } from "../accounts/bootHealth.js";
import {
  assertHsrAnswerOperationOwnsRecord,
  coordinateHsrAnswerOnHost,
  parseHsrAnswerRpcParams,
  parseHsrAnswerHostIdentity,
  sameHsrAnswerHostIdentity,
} from "../answerReceipt.js";
import { appendUsageEvent } from "../usage.js";
import { CodexBootProbeError, codexHomeFromEnv, withCodexHomeBootLock } from "../codexBoot.js";
import { probeCodexHomeLogs, reclaimCodexHomeLogs } from "../codexHomeMaintenance.js";
import type { RunnerAdapter, RunnerEvent, RunnerOpts } from "./types.js";
import { loadSession } from "../store.js";
import { startRpcServer, type RpcMethodHandler } from "./rpc.js";
import {
  ensureHsrRunDir,
  hsrControlSocketPath,
  appendHsrEvent,
  markHsrConsumerSubscribedStrict,
  onHsrEventAppended,
  readHsrMetaStrict,
  sealHsrEventStreamClosure,
  writeHsrMeta,
  type HsrMeta,
  type HsrStartupFailure,
} from "./runDir.js";
import { codexStartupConcurrency, withCodexStartupSlot } from "./startupQueue.js";
import {
  claimPendingHsrTurnOnHost,
  ambiguatePendingHsrTurnsForEventIntegrity,
  drainPendingHsrTurns,
  markPendingHsrTurnAccepted,
  markPendingHsrTurnAmbiguous,
  markPendingHsrTurnAuthFailed,
  markPendingHsrTurnCompleted,
  markPendingHsrTurnStarted,
  readPendingHsrTurns,
  withHsrTurnDeliveryLock,
} from "./pendingTurns.js";
import {
  persistHsrEventIntegrityFailure,
  recordHsrEventIntegrityStop,
  type HsrEventIntegrityReceipt,
} from "./eventIntegrity.js";
import { isAuthNeededMessage, pendingNeedsInput } from "./observe.js";
import {
  capturePersistableProcessBirthFingerprint,
  captureProcessBirthFingerprintWithRetry,
  sameProcessBirthFingerprint,
  type ProcessBirthCaptureOptions,
} from "./processIdentity.js";

export type HsrHostHandle = {
  bee: string;
  controlSocket: string;
  /** Resolves once the session has exited and the run dir is finalized. */
  done: Promise<void>;
  /** In-process recovery proof for a final meta write that needs healing. */
  terminalMeta?(): HsrMeta | null;
  /** Stop the session (SIGTERM→SIGKILL its group) and await finalization. */
  stop(): Promise<void>;
};

// Delay before the host reconciles a learned-at-init session id into meta.json,
// covering the no-turn case (the init line lands shortly after spawn).
const SESSION_ID_RECONCILE_MS = 60;

export async function runHsrHost(params: {
  bee: string;
  adapter: RunnerAdapter;
  opts: RunnerOpts;
  hostPid?: number;
  /** Detached local hosts publish startup immediately; in-process remote hosts opt out. */
  queueStartup?: boolean;
  /** Remote controller already proved launch authority and pre-offered receipt. */
  answerAuthority?: "remote-receipt";
  /** Immutable remote generation binding for outside-run-dir integrity facts. */
  runtimeAuthority?: { remoteLaunchId: string; remoteIncarnation: string };
  /** Stable controller projection admitted before any provider event exists. */
  initialEventConsumerId?: string;
  /** Injectable bounded birth capture for deterministic admission tests. */
  processBirthCapture?: ProcessBirthCaptureOptions;
  /** Test barrier after exact child identity is durable, before readiness. */
  afterChildAdmission?: (identity: { pid: number; pgid: number }) => Promise<void>;
  /** Scrub an adapter-start error before it is persisted for the parent. */
  formatStartupFailure?: (error: unknown) => HsrStartupFailure;
}): Promise<HsrHostHandle> {
  const { bee, adapter, opts } = params;
  const hostPid = params.hostPid ?? process.pid;
  const hostFingerprint = await captureProcessBirthFingerprintWithRetry(hostPid, {
    ...params.processBirthCapture,
    // queueStartup marks the detached local runner-entry process. Its identity
    // is persisted for a different parent/daemon process, so an in-process
    // node-time-origin fallback is not admissible. Remote controllers host
    // runners in-process and retain the contained fallback when ps is denied.
    capture: params.processBirthCapture?.capture ?? (params.queueStartup
      ? capturePersistableProcessBirthFingerprint
      : undefined),
  });
  if (!hostFingerprint) {
    throw new Error(`HSR host birth admission failed: process ${hostPid} has no verifiable birth fingerprint`);
  }
  const controlSocket = hsrControlSocketPath(bee);
  const monotonicStart = performance.now();
  const phaseTimings: NonNullable<HsrMeta["phaseTimingsMs"]> = {};
  const elapsed = (): number => Math.max(0, performance.now() - monotonicStart);

  await ensureHsrRunDir(bee);
  if (params.initialEventConsumerId) {
    await markHsrConsumerSubscribedStrict(bee, params.initialEventConsumerId);
  }
  const tier = adapter.tier();
  const startedAt = new Date().toISOString();
  const deliveryHost = { hostPid, startedAt, hostFingerprint };
  const publishStartup = params.queueStartup === true;
  const queueCodexStartup =
    publishStartup &&
    adapter.harness === "codex" &&
    tier === "server" &&
    codexStartupConcurrency() > 0;
  const bootsCodexAppServer = adapter.harness === "codex" && tier === "server";

  // Publish a durable pending admission for EVERY host before an adapter may
  // spawn. Remote in-process hosts used to skip this record until readiness,
  // leaving the same crash window as detached local hosts. `pending` is never
  // absence proof: a dead host cannot be reaped/retired until exact child
  // identity is admitted or a completed no-child admission is persisted.
  let meta: HsrMeta = {
    bee,
    harness: adapter.harness,
    tier,
    hostPid,
    hostFingerprint,
    childAdmission: "pending",
    startedAt,
    ...(queueCodexStartup ? { queuedAt: startedAt } : {}),
    ...(publishStartup ? { startupPhase: queueCodexStartup ? "admission" as const : "harness" as const } : {}),
    controlSocket,
    status: "queued",
    phaseTimingsMs: phaseTimings,
  };
  // Every host-owned meta write is serialized. In particular, boot
  // re-adoption may ask a live host to re-publish its in-memory cursor after a
  // foreign observer falsely stamped disk `exited`. Serializing that repair
  // with finalize guarantees a concurrently queued real exit always wins.
  let metaWriteChain = Promise.resolve();
  const persistMeta = (snapshot: HsrMeta = meta): Promise<void> => {
    const write = metaWriteChain.then(() => writeHsrMeta(bee, snapshot));
    metaWriteChain = write.catch(() => undefined);
    return write;
  };
  // Never replace an unreadable/corrupt locator with apparently healthy
  // startup state. A valid prior incarnation is expected on revive; lifecycle
  // ownership is responsible for stopping it before this launch.
  await readHsrMetaStrict(bee);
  await persistMeta();
  // Events survive host refreshes. Land an exact epoch boundary before the
  // adapter can emit anything so observers never graft a retained request,
  // auth failure, or unfinished turn from the predecessor onto this host.
  try {
    await appendHsrEvent(bee, {
      type: "host_epoch",
      ts: Date.parse(startedAt),
      host: deliveryHost,
    });
  } catch (error) {
    const current = await readHsrMetaStrict(bee);
    if (
      current && current.hostPid === hostPid && current.startedAt === startedAt
      && sameProcessBirthFingerprint(current.hostFingerprint, hostFingerprint)
    ) {
      meta = {
        ...current,
        childAdmission: "none",
        startupFailure: {
          stage: "adapter-start",
          message: "HSR host epoch could not be persisted before provider startup",
          code: "HIVE_HSR_HOST_EPOCH_PERSISTENCE",
        },
        status: "exited",
        exitCode: null,
        endedAt: new Date().toISOString(),
      };
      // This write is the only durable proof that no adapter child was ever
      // attempted. If it fails, propagate uncertainty and leave cleanup in
      // doubt instead of converting `pending` into a false stopped claim.
      await persistMeta();
    }
    throw error;
  }

  let eventIntegrityFailure: string | undefined;
  let eventIntegrityReceipt: HsrEventIntegrityReceipt | undefined;
  let eventIntegritySettlement: Promise<void> | undefined;
  let stopAfterIntegrityFailure: (() => Promise<void>) | undefined;
  let reportObservedEventIntegrityFailure:
    ((reason: string) => Promise<HsrEventIntegrityReceipt>) | undefined;
  let resolveEventIntegrityDetected!: () => void;
  const eventIntegrityDetected = new Promise<void>((resolve) => {
    resolveEventIntegrityDetected = resolve;
  });

  const scanEventIntegrityDeliveries = async (): Promise<{
    deliveryIds: string[];
    deliveryScanError?: string;
  }> => {
    try {
      return {
        deliveryIds: (await readPendingHsrTurns(bee))
          .filter((turn) => turn.phase !== "completed" && turn.phase !== "discarded")
          .map((turn) => turn.id),
      };
    } catch (error) {
      return {
        deliveryIds: [],
        deliveryScanError: `pending HSR delivery authority could not be enumerated: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const publishEventPersistenceFailure = async (event: RunnerEvent, error: unknown): Promise<void> => {
    const detail = `runner could not persist ${event.type} event: ${error instanceof Error ? error.message : String(error)}`;
    eventIntegrityFailure ??= detail;
    resolveEventIntegrityDetected();
    const deliveryScan = await scanEventIntegrityDeliveries();
    // This callback is awaited inside session plumbing before the append
    // rejection reaches `session.events`. It closes the ordinary-dead crash
    // window: recovery can observe the outside receipt even if this process
    // dies before the event-pump catch begins exact stop/drain settlement.
    eventIntegrityReceipt = await persistHsrEventIntegrityFailure({
      bee,
      host: deliveryHost,
      ...(params.runtimeAuthority ? {
        remoteAuthority: {
          launchId: params.runtimeAuthority.remoteLaunchId,
          incarnation: params.runtimeAuthority.remoteIncarnation,
        },
      } : {}),
      ...deliveryScan,
      reason: eventIntegrityFailure,
    });
    // The outside receipt is the authority. Publish the in-run-dir diagnostic
    // only after it exists, so a crash can never leave a marker that ordinary
    // recovery mistakes for a complete/clean event prefix. If this best-effort
    // write is the sole surviving artifact, strict admission promotes it back
    // into the same outside receipt before doing provider work.
    meta = { ...meta, status: "running", eventIntegrityFailure };
    await persistMeta().catch((persistError) => {
      process.stderr.write(`hsr host ${bee}: event-integrity meta write failed: ${String(persistError)}\n`);
    });
  };

  let childAdmissionAttempted = false;
  const markChildAdmissionPending = async (): Promise<void> => {
    const current = await readHsrMetaStrict(bee);
    if (
      !current || current.hostPid !== hostPid || current.startedAt !== startedAt ||
      !sameProcessBirthFingerprint(current.hostFingerprint, hostFingerprint)
    ) {
      throw new Error(`HSR metadata no longer owns host incarnation ${hostPid}`);
    }
    const {
      childPid: _childPid,
      childPgid: _childPgid,
      childFingerprint: _childFingerprint,
      ...withoutPriorChild
    } = current;
    meta = { ...withoutPriorChild, childAdmission: "pending" };
    await persistMeta();
  };
  const markChildSpawnFailed = async (): Promise<void> => {
    const current = await readHsrMetaStrict(bee);
    if (
      !current || current.hostPid !== hostPid || current.startedAt !== startedAt ||
      !sameProcessBirthFingerprint(current.hostFingerprint, hostFingerprint) ||
      current.childAdmission !== "pending"
    ) {
      throw new Error(`HSR metadata no longer owns pending child admission for host ${hostPid}`);
    }
    meta = { ...current, childAdmission: "none" };
    await persistMeta();
  };
  const admitChild = async (identity: { pid: number; pgid: number }): Promise<void> => {
    // Once this callback is entered, a child exists (or existed) and only its
    // exact birth admission can prove cleanup. If adapter.start fails before
    // entering it, the shared spawn helper never produced a child and the host
    // may durably publish the completed no-child outcome instead of leaving a
    // permanently unresolvable `pending` tombstone.
    childAdmissionAttempted = true;
    const childFingerprint = await captureProcessBirthFingerprintWithRetry(identity.pid, params.processBirthCapture);
    if (!childFingerprint || childFingerprint.pgid !== identity.pgid) {
      throw new Error(`process ${identity.pid}/${identity.pgid} has no matching birth fingerprint`);
    }
    const current = await readHsrMetaStrict(bee);
    if (
      !current || current.hostPid !== hostPid || current.startedAt !== startedAt ||
      !sameProcessBirthFingerprint(current.hostFingerprint, hostFingerprint)
    ) {
      throw new Error(`HSR metadata no longer owns host incarnation ${hostPid}`);
    }
    meta = {
      ...current,
      childPid: identity.pid,
      childPgid: identity.pgid,
      childFingerprint,
      childAdmission: "admitted",
    };
    await persistMeta();
    await params.afterChildAdmission?.(identity);
    await opts.onChildSpawn?.(identity);
  };
  const admittedOpts: RunnerOpts = {
    ...opts,
    onChildSpawnPending: markChildAdmissionPending,
    onChildSpawnFailure: markChildSpawnFailed,
    onChildSpawn: admitChild,
    eventHost: deliveryHost,
    onEventPersistenceFailure: publishEventPersistenceFailure,
  };

  let session: Awaited<ReturnType<RunnerAdapter["start"]>>;
  try {
    const startAdapter = async (startOpts: RunnerOpts = admittedOpts) => {
      if (meta.startupPhase === "admission") {
        meta = { ...meta, startupPhase: "harness", phaseTimingsMs: phaseTimings };
        await persistMeta();
      }
      const adapterStarted = performance.now();
      try {
        return await adapter.start(startOpts);
      } finally {
        phaseTimings.adapterReadiness = performance.now() - adapterStarted;
      }
    };
    const startWithHomeLock = () => bootsCodexAppServer
      ? withCodexHomeBootLock(codexHomeFromEnv(opts.env), async ({ waited, waitMs }) => {
          phaseTimings.homeLockWait = waitMs;
          const heldAt = performance.now();
          try {
            // Boot performs only a bounded, read-only size probe. SQLite
            // checkpoint/vacuum is deferred until this runtime exits so a
            // multi-GB/busy DB cannot consume the adapter readiness budget.
            const maintenanceStarted = performance.now();
            await probeCodexHomeLogs(codexHomeFromEnv(opts.env)).catch(() => undefined);
            phaseTimings.maintenanceProbe = performance.now() - maintenanceStarted;
            return await startAdapter(waited ? { ...admittedOpts, codexBootContended: true } : admittedOpts);
          } finally {
            phaseTimings.homeLockHeld = performance.now() - heldAt;
          }
        })
      : startAdapter(admittedOpts);
    session = queueCodexStartup
      ? await withCodexStartupSlot(bee, startWithHomeLock, {
          onTiming: ({ waitMs, heldMs }) => {
            phaseTimings.startupSlotWait = waitMs;
            phaseTimings.startupSlotHeld = heldMs;
          },
        })
      : await startWithHomeLock();
    if (bootsCodexAppServer && opts.accountId) {
      await clearAccountBootFailure(opts.accountId).catch(() => undefined);
    }
  } catch (error) {
    if (bootsCodexAppServer && opts.accountId && error instanceof CodexBootProbeError) {
      await recordAccountBootFailure(opts.accountId).catch(() => undefined);
    }
    const current = await readHsrMetaStrict(bee).catch(() => null);
    if (
      current && current.hostPid === hostPid && current.startedAt === startedAt &&
      sameProcessBirthFingerprint(current.hostFingerprint, hostFingerprint)
    ) {
      let startupFailure: HsrStartupFailure = {
        stage: "adapter-start" as const,
        message: "HSR harness failed during startup; inspect host.log for provider diagnostics",
      };
      try {
        startupFailure = params.formatStartupFailure?.(error) ?? startupFailure;
      } catch {
        // A diagnostic formatter must never prevent durable exit/no-child
        // publication or turn a provider failure into an unresolvable runtime.
      }
      meta = {
        ...current,
        ...(!childAdmissionAttempted && current.childAdmission === "pending"
          ? { childAdmission: "none" as const }
          : {}),
        startupFailure,
        status: "exited",
        exitCode: null,
        endedAt: new Date().toISOString(),
        phaseTimingsMs: phaseTimings,
      };
      await persistMeta().catch(() => undefined);
    }
    throw error;
  }

  if (session.pid) {
    if (meta.childAdmission !== "admitted" || meta.childPid !== session.pid || meta.childPgid !== session.pid) {
      await session.stop().catch(() => undefined);
      throw new Error(`HSR child birth admission did not commit exact process ${session.pid}`);
    }
  } else if (meta.childAdmission === "pending") {
    // Turn-tier sessions have no child while idle. Persist the completed
    // admission outcome; their first per-turn spawn invokes admitChild before
    // any protocol bytes are delivered.
    meta = { ...meta, childAdmission: "none" };
  }
  meta = {
    ...meta,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    status: publishStartup ? "queued" : "running",
    ...(!publishStartup ? { runningAt: new Date().toISOString() } : {}),
    phaseTimingsMs: phaseTimings,
  };
  await persistMeta();

  let finalized = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // Normal local-HSR sends arrive with a durable pending-turn filename. Match
  // those ids to structured turn_start/turn_end frames in FIFO order. A clean
  // turn_end acks the journal file; a login-required error deliberately leaves
  // it in place so auth recovery can replay the operator's exact text.
  const awaitingTurnStart: string[] = [];
  const openTurns: Array<{ deliveryId?: string; authFailed: boolean }> = [];
  const activeDeliveries = new Set<string>();
  let activeSendOperations = 0;
  const sendDrainWaiters = new Set<() => void>();
  const waitForSendOperations = (): Promise<void> => activeSendOperations === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => sendDrainWaiters.add(resolve));
  let lastAccountAuthFailureRecordedAt = 0;

  const finishTrackedProviderOperation = (): void => {
    activeSendOperations -= 1;
    if (activeSendOperations === 0) {
      for (const resolve of sendDrainWaiters) resolve();
      sendDrainWaiters.clear();
    }
  };

  const sendTrackedTurn = async (text: string, mode: unknown, deliveryId: unknown): Promise<void> => {
    activeSendOperations += 1;
    try {
      if (eventIntegrityFailure) throw new Error(eventIntegrityFailure);
      const trackedId = typeof deliveryId === "string" ? deliveryId : undefined;
      const deliveryMode = mode === "next-tool" ? "next-tool" as const : "turn" as const;
      if (trackedId) {
        if (activeDeliveries.has(trackedId)) return;
        const decision = await claimPendingHsrTurnOnHost(bee, trackedId, text, deliveryMode, deliveryHost);
        if (decision.action === "settled") return;
        activeDeliveries.add(trackedId);
        if (deliveryMode === "turn") awaitingTurnStart.push(trackedId);
      }
      try {
        await session.send(text, mode === "next-tool" ? { mode: "next-tool" } : undefined);
        if (trackedId) {
          if (deliveryMode === "next-tool") {
            // next-tool has no independent turn_end. The provider adapter's
            // resolved send is its only acceptance boundary, so completion is
            // persisted here and never earlier.
            await markPendingHsrTurnCompleted(bee, trackedId, deliveryHost);
            activeDeliveries.delete(trackedId);
          } else {
            // turn_start/auth may have advanced the journal while session.send
            // was pending. The monotonic transition refuses any regression.
            await markPendingHsrTurnAccepted(bee, trackedId, deliveryHost);
          }
        }
      } catch (error) {
        // If no turn_start consumed the id, do not let a later unrelated turn
        // inherit it. Once dispatch crossed, an unclassified send rejection is
        // durable ambiguity; only an observed auth failure remains replayable.
        if (trackedId) {
          const pendingIndex = awaitingTurnStart.indexOf(trackedId);
          if (pendingIndex >= 0) awaitingTurnStart.splice(pendingIndex, 1);
          await markPendingHsrTurnAmbiguous(
            bee,
            trackedId,
            deliveryHost,
            `provider send failed after durable dispatch: ${error instanceof Error ? error.message : String(error)}`,
          ).catch(() => undefined);
          activeDeliveries.delete(trackedId);
        }
        throw error;
      }
    } finally {
      finishTrackedProviderOperation();
    }
  };

  // --- control socket --------------------------------------------------------
  const methods: Record<string, RpcMethodHandler> = {
    // Side-effect-free rolling-upgrade proof. New controllers must observe
    // this before publishing a durable answer transport attempt; legacy hosts
    // reject the unknown method without seeing answer bytes.
    answerCapabilities: () => ({ answerReceipt: 1 }),
    send: (params) => {
      const p = (params ?? {}) as { text?: unknown; mode?: unknown; deliveryId?: unknown };
      return sendTrackedTurn(String(p.text ?? ""), p.mode, p.deliveryId);
    },
    interrupt: async () => {
      activeSendOperations += 1;
      try {
        if (eventIntegrityFailure) throw new Error(eventIntegrityFailure);
        return await session.interrupt();
      } finally {
        finishTrackedProviderOperation();
      }
    },
    answer: async (rpcParams) => {
      activeSendOperations += 1;
      try {
        if (eventIntegrityFailure) throw new Error(eventIntegrityFailure);
        const parsed = parseHsrAnswerRpcParams(rpcParams);
        if (params.answerAuthority !== "remote-receipt") {
          const current = await loadSession(bee);
          if (!current) throw new Error(`HSR answer source session ${bee} no longer exists`);
          assertHsrAnswerOperationOwnsRecord(parsed.operation, current);
        }
        return await coordinateHsrAnswerOnHost({
          bee,
          operation: parsed.operation,
          host: { hostPid, startedAt, hostFingerprint },
          prepare: async () => {
            const prepared = await session.prepareAnswer(parsed.operation.requestId, parsed.answer);
            return () => prepared.dispatch();
          },
        });
      } finally {
        finishTrackedProviderOperation();
      }
    },
    pendingInput: () => pendingNeedsInput(bee),
    // Authority-grade observers use this when already-retained source history
    // is malformed/holed while the provider is otherwise idle. Bind the
    // request to this in-memory host birth, durably publish the outside fence,
    // then stop/ambiguate through the same path as an append rejection.
    eventIntegrityFailure: async (rpcParams) => {
      const object = (rpcParams ?? {}) as { host?: unknown; reason?: unknown };
      const expectedHost = parseHsrAnswerHostIdentity(object.host);
      if (!sameHsrAnswerHostIdentity(expectedHost, deliveryHost)) {
        throw new Error(`HSR event-integrity observation does not own ${bee}'s current host`);
      }
      if (!reportObservedEventIntegrityFailure) {
        throw new Error(`HSR event-integrity settlement is not ready for ${bee}`);
      }
      return reportObservedEventIntegrityFailure(
        typeof object.reason === "string" && object.reason.length > 0
          ? object.reason
          : "retained HSR event history failed strict validation",
      );
    },
    // Recovery restores the ORIGINAL pending files/ids, then invokes this RPC.
    // sendTrackedTurn makes a repeated call on this same host idempotent.
    drainPending: () => {
      if (eventIntegrityFailure) throw new Error(eventIntegrityFailure);
      return withHsrTurnDeliveryLock(bee, async () => ({
        delivered: await drainPendingHsrTurns(bee, (turn) => sendTrackedTurn(
          turn.text,
          turn.mode === "next-tool" ? "next-tool" : undefined,
          turn.id,
        )),
      }));
    },
    snapshot: (params) => {
      const lines = (params as { lines?: unknown })?.lines;
      return session.snapshot(typeof lines === "number" ? lines : undefined);
    },
    // Fire-and-forget: awaiting here would race the server.close() in finalize
    // and strand this very response. Callers await `done` (or handle.stop()).
    stop: () => {
      void (eventIntegrityFailure && stopAfterIntegrityFailure
        ? stopAfterIntegrityFailure()
        : session.stop());
      return { stopping: true };
    },
    // Return the host-owned in-memory incarnation, not a fresh disk read. A
    // daemon/reaper can race and mis-stamp meta.json; the live control socket
    // is the independent witness the restart re-adoption sweep uses to heal
    // that stale cursor without confusing it for the runner's own testimony.
    meta: () => meta,
    // Repair is performed by the process that owns the runtime testimony,
    // never by the daemon. The serialized write uses the current in-memory
    // value: if finalize raced, this re-publishes `exited`, not stale `running`.
    reassertMeta: async () => {
      await persistMeta();
      return meta;
    },
  };

  let server: Awaited<ReturnType<typeof startRpcServer>>;
  try {
    server = await startRpcServer({ socketPath: controlSocket, methods });
  } catch (error) {
    // Setup failed AFTER the harness child spawned (e.g. an AF_UNIX EINVAL on a
    // too-long socket path). Don't leak the runner: stop it and finalize meta.
    await session.stop().catch(() => undefined);
    await persistMeta({ ...meta, status: "exited", exitCode: null, endedAt: new Date().toISOString() }).catch(() => undefined);
    throw error;
  }

  // Publish only the post-durable event copy. Session plumbing appends on an
  // async chain and stamps the per-bee sequence there; broadcasting the raw
  // iterator value raced ahead of that append and carried no seq, so a remote
  // observer could not resume an interrupted stream without duplicates or
  // holes. The process-local append tap runs after events.jsonl contains the
  // exact stamped event that the remote `events(afterSeq)` RPC will replay.
  const stopStampedEventBroadcast = onHsrEventAppended((eventBee, event) => {
    if (eventBee !== bee || finalized) return;
    try {
      server.broadcast("event", event);
    } catch {
      // A broadcast failure (closing socket) must not fail durable append.
    }
  });

  if (publishStartup) {
    try {
      // Serialize the state flip with sendText's queued/booting decision. A
      // sender either persists a turn that this drain consumes, or sees running
      // after the lock is released and uses the live RPC socket.
      await withHsrTurnDeliveryLock(bee, async () => {
        phaseTimings.ready = elapsed();
        meta = { ...meta, status: "running", runningAt: new Date().toISOString(), phaseTimingsMs: phaseTimings };
        await persistMeta();
        await drainPendingHsrTurns(bee, (turn) => sendTrackedTurn(
          turn.text,
          turn.mode === "next-tool" ? "next-tool" : undefined,
          turn.id,
        ));
      });
    } catch (error) {
      await session.stop().catch(() => undefined);
      stopStampedEventBroadcast();
      await server.close().catch(() => undefined);
      await persistMeta({
        ...meta,
        status: "exited",
        exitCode: null,
        endedAt: new Date().toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  // Learn the provider session id (captured by the runner from the init line,
  // which carries no RunnerEvent) into meta.json. The child can take longer
  // than the first reconciliation delay to emit init under machine load, so
  // retry with a bounded interval until it arrives instead of sampling once.
  const reconcileSessionId = async (): Promise<void> => {
    if (finalized) return;
    if (session.sessionId && session.sessionId !== meta.sessionId) {
      meta = { ...meta, sessionId: session.sessionId };
      await persistMeta().catch(() => undefined);
    }
  };
  let sessionIdReconcileTimer: NodeJS.Timeout | undefined;
  const scheduleSessionIdReconcile = (delayMs: number): void => {
    sessionIdReconcileTimer = setTimeout(() => {
      void reconcileSessionId().finally(() => {
        if (!finalized && !meta.sessionId) {
          scheduleSessionIdReconcile(Math.min(delayMs * 2, 1_000));
        }
      });
    }, delayMs);
  };
  if (!meta.sessionId) scheduleSessionIdReconcile(SESSION_ID_RECONCILE_MS);

  const finalize = async (exitCode: number | null): Promise<void> => {
    if (finalized) return;
    // A clean terminal meta is positive authority, not a liveness inference.
    // Seal the stamped exit/high-water while the exact host still owns the
    // append domain; if this fails, the event pump raises manual integrity
    // doubt instead of publishing an ordinary recoverable exit.
    const eventStreamClosure = eventIntegrityFailure
      ? undefined
      : await sealHsrEventStreamClosure(bee, meta);
    if (finalized) return;
    finalized = true;
    stopStampedEventBroadcast();
    if (sessionIdReconcileTimer) clearTimeout(sessionIdReconcileTimer);
    meta = {
      ...meta,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      status: "exited",
      exitCode,
      endedAt: new Date().toISOString(),
      phaseTimingsMs: phaseTimings,
      ...(eventStreamClosure ? { eventStreamClosure } : {}),
    };
    await persistMeta().catch(() => undefined);
    await server.close().catch(() => undefined);
    // Heavy SQLite maintenance is a shutdown concern. Acquire the same home
    // boot lock briefly; if another boot already owns it, skip rather than
    // delaying or contending with the newborn adapter.
    if (bootsCodexAppServer) {
      await withCodexHomeBootLock(codexHomeFromEnv(opts.env), async () => {
        const reclaimed = await reclaimCodexHomeLogs(codexHomeFromEnv(opts.env)).catch(() => null);
        if (reclaimed && reclaimed.reclaimedBytes > 0) {
          process.stderr.write(`hive: reclaimed ${(reclaimed.reclaimedBytes / 1048576).toFixed(0)}MB from codex home logs after exit\n`);
        }
      }, { timeoutMs: 250, pollMs: 25 }).catch(() => undefined);
    }
    resolveDone();
  };
  const settleEventIntegrityFailure = async (): Promise<void> => {
    if (eventIntegritySettlement) return eventIntegritySettlement;
    const attempt = (async () => {
      const detail = eventIntegrityFailure ?? "runner event persistence failed; exact history is incomplete";
      const deliveryScan = await scanEventIntegrityDeliveries();
      // This receipt is the irreversible fail-closed boundary. It lives outside
      // the run dir, fences a matching local canonical row when one exists, and
      // lets a remote controller import the exact same proof after this host is
      // stopped. Never signal the provider before it is durable.
      eventIntegrityReceipt = await persistHsrEventIntegrityFailure({
        bee,
        host: deliveryHost,
        ...(params.runtimeAuthority ? {
          remoteAuthority: {
            launchId: params.runtimeAuthority.remoteLaunchId,
            incarnation: params.runtimeAuthority.remoteIncarnation,
          },
        } : {}),
        ...deliveryScan,
        reason: detail,
      });
      try {
        // Signal before taking the turn-delivery lock. drainPending holds that
        // lock while awaiting provider send, and the send may only unblock once
        // this exact stop begins. The outside receipt above is already the
        // durable pre-signal ownership fence.
        await session.stop();
        // A send RPC may have crossed its initial in-memory guard before the
        // event-loss fence was raised. Exact stop terminates its provider call;
        // wait for every such handler to persist its final receipt, then merge
        // and ambiguate the complete set before publishing stop confirmation.
        await waitForSendOperations();
        const afterStopDeliveryScan = await scanEventIntegrityDeliveries();
        eventIntegrityReceipt = await persistHsrEventIntegrityFailure({
          bee,
          host: deliveryHost,
          ...(params.runtimeAuthority ? {
            remoteAuthority: {
              launchId: params.runtimeAuthority.remoteLaunchId,
              incarnation: params.runtimeAuthority.remoteIncarnation,
            },
          } : {}),
          ...afterStopDeliveryScan,
          reason: detail,
        });
        const settledIds = await ambiguatePendingHsrTurnsForEventIntegrity(
          bee,
          `HSR event history became incomplete on host ${deliveryHost.hostPid}; provider outcome requires manual reconciliation`,
        );
        eventIntegrityReceipt = await persistHsrEventIntegrityFailure({
          bee,
          host: deliveryHost,
          ...(params.runtimeAuthority ? {
            remoteAuthority: {
              launchId: params.runtimeAuthority.remoteLaunchId,
              incarnation: params.runtimeAuthority.remoteIncarnation,
            },
          } : {}),
          deliveryIds: settledIds,
          reason: detail,
        });
        // Adapter/session stop is not birth-qualified descendant absence proof.
        // Publish only doubt here; the controller substrate owns the strict
        // host + detached child-group census and is the sole confirmer.
        eventIntegrityReceipt = await recordHsrEventIntegrityStop(
          bee,
          eventIntegrityReceipt.integrityId,
          deliveryHost,
          "doubt",
          "provider adapter stopped; controller child-group proof is still required",
        );
      } catch (error) {
        await recordHsrEventIntegrityStop(
          bee,
          eventIntegrityReceipt.integrityId,
          deliveryHost,
          "doubt",
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
        throw error;
      }
      await finalize(null);
    })();
    eventIntegritySettlement = attempt;
    try {
      await attempt;
    } catch (error) {
      // A later explicit stop may retry the same exact receipt/host. Until then
      // the control authority stays open and meta remains nonterminal.
      if (!finalized) eventIntegritySettlement = undefined;
      throw error;
    }
  };
  stopAfterIntegrityFailure = settleEventIntegrityFailure;
  reportObservedEventIntegrityFailure = async (reason: string): Promise<HsrEventIntegrityReceipt> => {
    eventIntegrityFailure ??= reason;
    resolveEventIntegrityDetected();
    const deliveryScan = await scanEventIntegrityDeliveries();
    eventIntegrityReceipt = await persistHsrEventIntegrityFailure({
      bee,
      host: deliveryHost,
      ...(params.runtimeAuthority ? {
        remoteAuthority: {
          launchId: params.runtimeAuthority.remoteLaunchId,
          incarnation: params.runtimeAuthority.remoteIncarnation,
        },
      } : {}),
      ...deliveryScan,
      reason: eventIntegrityFailure,
    });
    meta = { ...meta, status: "running", eventIntegrityFailure };
    await persistMeta().catch((persistError) => {
      process.stderr.write(`hsr host ${bee}: event-integrity meta write failed: ${String(persistError)}\n`);
    });
    // Let the RPC response carrying the durable integrity id flush before the
    // settlement closes this control server. Any failure remains retryable via
    // handle.stop/control stop against the same outside receipt.
    setImmediate(() => {
      void settleEventIntegrityFailure().catch((error) => {
        process.stderr.write(`hsr host ${bee}: observed event-integrity stop unconfirmed: ${String(error)}\n`);
      });
    });
    return eventIntegrityReceipt;
  };

  // --- event pump: persist is the runner's job; here we only broadcast -------
  void (async () => {
    try {
      for await (const event of session.events) {
        let timingChanged = false;
        if (event.type === "turn_start" && phaseTimings.firstTurn === undefined) {
          phaseTimings.firstTurn = elapsed();
          timingChanged = true;
        }
        if (event.type === "text" && event.text.length > 0 && phaseTimings.firstToken === undefined) {
          phaseTimings.firstToken = elapsed();
          timingChanged = true;
        }
        if (timingChanged) {
          meta = { ...meta, phaseTimingsMs: phaseTimings };
          await persistMeta().catch(() => undefined);
        }
        if (event.type === "turn_start") {
          const deliveryId = awaitingTurnStart.shift();
          openTurns.push({ deliveryId, authFailed: false });
          if (deliveryId) await markPendingHsrTurnStarted(bee, deliveryId, deliveryHost).catch((error) => {
            process.stderr.write(`hsr host ${bee}: could not persist turn start: ${String(error)}\n`);
          });
        } else if (
          (event.type === "error" && isAuthNeededMessage(event.message)) ||
          (event.type === "auth_expired" && event.requiresLogin === true)
        ) {
          const authTurn = openTurns[0];
          const deliveryId = authTurn?.deliveryId ?? awaitingTurnStart[0];
          if (authTurn) authTurn.authFailed = true;
          if (deliveryId) {
            const pendingIndex = awaitingTurnStart.indexOf(deliveryId);
            if (pendingIndex >= 0 && !authTurn) awaitingTurnStart.splice(pendingIndex, 1);
            await markPendingHsrTurnAuthFailed(bee, deliveryId, deliveryHost).catch((error) => {
              process.stderr.write(`hsr host ${bee}: could not persist auth-failed delivery: ${String(error)}\n`);
            });
            activeDeliveries.delete(deliveryId);
          }
          // Account health must see the REAL runtime auth failure (a revoked
          // token 401s every bee on the account while the credential file
          // still exists). Throttled per host: one record per failure burst.
          if (opts.accountId && Date.now() - lastAccountAuthFailureRecordedAt > 5 * 60_000) {
            lastAccountAuthFailureRecordedAt = Date.now();
            await appendUsageEvent({
              ts: new Date().toISOString(),
              kind: "auth_failed",
              account: opts.accountId,
              source: bee,
              detail: (event.type === "error" ? event.message : event.type === "auth_expired" ? event.detail ?? "auth expired" : "auth failure").slice(0, 200),
            }).catch(() => undefined);
          }
        } else if (event.type === "turn_end") {
          const completed = openTurns.shift();
          if (completed?.deliveryId && !completed.authFailed) {
            await markPendingHsrTurnCompleted(bee, completed.deliveryId, deliveryHost).catch((error) => {
              process.stderr.write(`hsr host ${bee}: could not persist completed delivery: ${String(error)}\n`);
            });
            activeDeliveries.delete(completed.deliveryId);
          }
        }
        await reconcileSessionId();
        if (event.type === "exit") await finalize(event.code);
      }
    } catch (error) {
      eventIntegrityFailure ??= "runner event persistence failed; exact history is incomplete";
      resolveEventIntegrityDetected();
      meta = { ...meta, status: "running", eventIntegrityFailure };
      // Meta is only a local diagnostic. Failure here must not mask the
      // outside-run-dir authority established by settleEventIntegrityFailure.
      await persistMeta().catch((persistError) => {
        process.stderr.write(`hsr host ${bee}: event-integrity meta write failed: ${String(persistError)}\n`);
      });
      process.stderr.write(`hsr host ${bee}: event pump error: ${String(error)}\n`);
      // Never publish exited while the provider may still be executing. An
      // exact stop permits finalization; an unconfirmed stop leaves the live
      // authority + durable integrity marker in place and every mutation RPC
      // above refuses until an operator retries stop.
      try {
        await settleEventIntegrityFailure();
      } catch (stopError) {
        process.stderr.write(`hsr host ${bee}: event-integrity stop unconfirmed: ${String(stopError)}\n`);
      }
      return;
    }
    // Stream ended (exit already finalized, or ended without an exit event).
    await finalize(null);
  })();

  return {
    bee,
    controlSocket,
    done,
    terminalMeta: () => finalized ? meta : null,
    async stop(): Promise<void> {
      await session.stop();
      // session.stop() can trigger the terminal provider event whose durable
      // append exposes an already-started integrity settlement. Waiting only
      // on `done` would hang forever when the first settlement attempt fails
      // closed and deliberately leaves the host authority open for retry.
      await Promise.race([done, eventIntegrityDetected]);
      if (!eventIntegrityFailure) {
        await done;
        return;
      }
      // A caller may observe the durable doubt written by an in-flight failed
      // settlement just before that attempt's catch clears the join promise.
      // Joining it once would merely replay the stale rejection and leave the
      // control socket open even after the underlying storage fault was
      // repaired. Yield past the owner catch and retry exactly once; persistent
      // faults still reject promptly and retain the authority for a later
      // explicit stop.
      try {
        await settleEventIntegrityFailure();
      } catch {
        if (finalized) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
        await settleEventIntegrityFailure();
      }
    },
  };
}
