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
import { appendUsageEvent } from "../usage.js";
import { CodexBootProbeError, codexHomeFromEnv, withCodexHomeBootLock } from "../codexBoot.js";
import { probeCodexHomeLogs, reclaimCodexHomeLogs } from "../codexHomeMaintenance.js";
import type { RunnerAdapter, RunnerInputAnswer, RunnerOpts } from "./types.js";
import { startRpcServer, type RpcMethodHandler } from "./rpc.js";
import {
  ensureHsrRunDir,
  hsrControlSocketPath,
  readHsrMetaStrict,
  writeHsrMeta,
  type HsrMeta,
  type HsrStartupFailure,
} from "./runDir.js";
import { codexStartupConcurrency, withCodexStartupSlot } from "./startupQueue.js";
import {
  createPendingHsrDeliveryGate,
  drainPendingHsrTurns,
  removePendingHsrTurn,
  withHsrTurnDeliveryLock,
} from "./pendingTurns.js";
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
  /** Stop the session (SIGTERM→SIGKILL its group) and await finalization. */
  stop(): Promise<void>;
};

function runnerInputAnswer(value: unknown): RunnerInputAnswer {
  if (
    Array.isArray(value) &&
    value.every((answer) => Array.isArray(answer) && answer.every((item) => typeof item === "string"))
  ) {
    return value as string[][];
  }
  return String(value ?? "");
}

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
  const tier = adapter.tier();
  const startedAt = new Date().toISOString();
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

  let childAdmissionAttempted = false;
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
  const admittedOpts: RunnerOpts = { ...opts, onChildSpawn: admitChild };

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
  // One delivery id may be offered repeatedly when a daemon dies after the
  // replacement host accepted its recovery drain but before clearing the
  // replay manifest. De-dupe only within this live host incarnation: after a
  // real host crash, a new host must replay the still-journaled turn.
  const deliveryGate = createPendingHsrDeliveryGate();
  let lastAccountAuthFailureRecordedAt = 0;

  const sendTrackedTurn = async (text: string, mode: unknown, deliveryId: unknown): Promise<void> => {
    const trackedId = mode !== "next-tool" && typeof deliveryId === "string" ? deliveryId : undefined;
    if (trackedId) {
      if (!deliveryGate.claim(trackedId)) return;
      awaitingTurnStart.push(trackedId);
    }
    try {
      await session.send(text, mode === "next-tool" ? { mode: "next-tool" } : undefined);
    } catch (error) {
      // If no turn_start consumed the id, do not let a later unrelated turn
      // inherit it. The journal file stays for a future host/recovery drain.
      if (trackedId) {
        const pendingIndex = awaitingTurnStart.indexOf(trackedId);
        if (pendingIndex >= 0) awaitingTurnStart.splice(pendingIndex, 1);
        deliveryGate.release(trackedId);
      }
      throw error;
    }
  };

  // --- control socket --------------------------------------------------------
  const methods: Record<string, RpcMethodHandler> = {
    send: (params) => {
      const p = (params ?? {}) as { text?: unknown; mode?: unknown; deliveryId?: unknown };
      return sendTrackedTurn(String(p.text ?? ""), p.mode, p.deliveryId);
    },
    interrupt: () => session.interrupt(),
    answer: (params) => {
      const p = (params ?? {}) as { requestId?: unknown; answer?: unknown };
      return session.answer(String(p.requestId ?? ""), runnerInputAnswer(p.answer));
    },
    pendingInput: () => pendingNeedsInput(bee),
    // Recovery restores the ORIGINAL pending files/ids, then invokes this RPC.
    // sendTrackedTurn makes a repeated call on this same host idempotent.
    drainPending: () => withHsrTurnDeliveryLock(bee, async () => ({
      delivered: await drainPendingHsrTurns(bee, (turn) => sendTrackedTurn(turn.text, undefined, turn.filename)),
    })),
    snapshot: (params) => {
      const lines = (params as { lines?: unknown })?.lines;
      return session.snapshot(typeof lines === "number" ? lines : undefined);
    },
    // Fire-and-forget: awaiting here would race the server.close() in finalize
    // and strand this very response. Callers await `done` (or handle.stop()).
    stop: () => {
      void session.stop();
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

  if (publishStartup) {
    try {
      // Serialize the state flip with sendText's queued/booting decision. A
      // sender either persists a turn that this drain consumes, or sees running
      // after the lock is released and uses the live RPC socket.
      await withHsrTurnDeliveryLock(bee, async () => {
        phaseTimings.ready = elapsed();
        meta = { ...meta, status: "running", runningAt: new Date().toISOString(), phaseTimingsMs: phaseTimings };
        await persistMeta();
        await drainPendingHsrTurns(bee, (turn) => sendTrackedTurn(turn.text, undefined, turn.filename));
      });
    } catch (error) {
      await session.stop().catch(() => undefined);
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
    finalized = true;
    if (sessionIdReconcileTimer) clearTimeout(sessionIdReconcileTimer);
    meta = {
      ...meta,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      status: "exited",
      exitCode,
      endedAt: new Date().toISOString(),
      phaseTimingsMs: phaseTimings,
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
          openTurns.push({ deliveryId: awaitingTurnStart.shift(), authFailed: false });
        } else if (
          (event.type === "error" && isAuthNeededMessage(event.message)) ||
          (event.type === "auth_expired" && event.requiresLogin === true)
        ) {
          if (openTurns[0]) openTurns[0].authFailed = true;
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
            let acknowledged = false;
            await removePendingHsrTurn(bee, completed.deliveryId).then(() => {
              acknowledged = true;
            }).catch((error) => {
              process.stderr.write(`hsr host ${bee}: could not ack pending turn: ${String(error)}\n`);
            });
            // A failed unlink leaves the journal authoritative; retain the
            // in-host de-dupe until a later recovery instead of double-running.
            if (acknowledged) deliveryGate.release(completed.deliveryId);
          }
        }
        try {
          server.broadcast("event", event);
        } catch {
          // A broadcast failure (closing socket) must not wedge the pump.
        }
        await reconcileSessionId();
        if (event.type === "exit") await finalize(event.code);
      }
    } catch (error) {
      process.stderr.write(`hsr host ${bee}: event pump error: ${String(error)}\n`);
    }
    // Stream ended (exit already finalized, or ended without an exit event).
    await finalize(null);
  })();

  return {
    bee,
    controlSocket,
    done,
    async stop(): Promise<void> {
      await session.stop();
      await done;
    },
  };
}
