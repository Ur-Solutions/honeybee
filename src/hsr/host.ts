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

import { clearAccountBootFailure, recordAccountBootFailure } from "../accounts/bootHealth.js";
import { CodexBootProbeError, codexHomeFromEnv, withCodexHomeBootLock } from "../codexBoot.js";
import type { RunnerAdapter, RunnerInputAnswer, RunnerOpts } from "./types.js";
import { startRpcServer, type RpcMethodHandler } from "./rpc.js";
import {
  ensureHsrRunDir,
  hsrControlSocketPath,
  readHsrMeta,
  writeHsrMeta,
  type HsrMeta,
} from "./runDir.js";
import { codexStartupConcurrency, withCodexStartupSlot } from "./startupQueue.js";
import { drainPendingHsrTurns, withHsrTurnDeliveryLock } from "./pendingTurns.js";
import { pendingNeedsInput } from "./observe.js";

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
}): Promise<HsrHostHandle> {
  const { bee, adapter, opts } = params;
  const hostPid = params.hostPid ?? process.pid;
  const controlSocket = hsrControlSocketPath(bee);

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

  let startupMeta: HsrMeta | undefined;
  if (publishStartup) {
    // Publish liveness before the native harness handshake. This lets x/run
    // durably enqueue the first turn and return immediately for every local
    // HSR harness. Keep the established `queued` status for rolling-version
    // compatibility; startupPhase refines admission backpressure vs harness
    // boot for new observers without making older daemons reject the meta.
    startupMeta = {
      bee,
      harness: adapter.harness,
      tier,
      hostPid,
      startedAt,
      ...(queueCodexStartup ? { queuedAt: startedAt } : {}),
      startupPhase: queueCodexStartup ? "admission" : "harness",
      controlSocket,
      status: "queued",
    };
    await writeHsrMeta(bee, startupMeta);
  }

  let session: Awaited<ReturnType<RunnerAdapter["start"]>>;
  try {
    const startAdapter = async (startOpts: RunnerOpts = opts) => {
      if (startupMeta?.startupPhase === "admission") {
        startupMeta = { ...startupMeta, startupPhase: "harness" };
        await writeHsrMeta(bee, startupMeta);
      }
      return adapter.start(startOpts);
    };
    const startWithHomeLock = () => bootsCodexAppServer
      ? withCodexHomeBootLock(codexHomeFromEnv(opts.env), ({ waited }) =>
          startAdapter(waited ? { ...opts, codexBootContended: true } : opts))
      : startAdapter(opts);
    session = queueCodexStartup
      ? await withCodexStartupSlot(bee, startWithHomeLock)
      : await startWithHomeLock();
    if (bootsCodexAppServer && opts.accountId) {
      await clearAccountBootFailure(opts.accountId).catch(() => undefined);
    }
  } catch (error) {
    if (bootsCodexAppServer && opts.accountId && error instanceof CodexBootProbeError) {
      await recordAccountBootFailure(opts.accountId).catch(() => undefined);
    }
    if (startupMeta) {
      await writeHsrMeta(bee, {
        ...startupMeta,
        status: "exited",
        exitCode: null,
        endedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
    throw error;
  }

  let meta: HsrMeta = {
    bee,
    harness: adapter.harness,
    tier,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    hostPid,
    childPid: session.pid,
    childPgid: session.pid, // detached ⇒ pgid === child pid
    startedAt: startupMeta?.startedAt ?? new Date().toISOString(),
    ...(startupMeta?.queuedAt ? { queuedAt: startupMeta.queuedAt } : {}),
    ...(startupMeta?.startupPhase ? { startupPhase: startupMeta.startupPhase } : {}),
    controlSocket,
    status: startupMeta ? "queued" : "running",
    ...(!startupMeta ? { runningAt: new Date().toISOString() } : {}),
  };
  await writeHsrMeta(bee, meta);

  let finalized = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // --- control socket --------------------------------------------------------
  const methods: Record<string, RpcMethodHandler> = {
    send: (params) => {
      const p = (params ?? {}) as { text?: unknown; mode?: unknown };
      return session.send(String(p.text ?? ""), p.mode === "next-tool" ? { mode: "next-tool" } : undefined);
    },
    interrupt: () => session.interrupt(),
    answer: (params) => {
      const p = (params ?? {}) as { requestId?: unknown; answer?: unknown };
      return session.answer(String(p.requestId ?? ""), runnerInputAnswer(p.answer));
    },
    pendingInput: () => pendingNeedsInput(bee),
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
    meta: () => readHsrMeta(bee),
  };

  let server: Awaited<ReturnType<typeof startRpcServer>>;
  try {
    server = await startRpcServer({ socketPath: controlSocket, methods });
  } catch (error) {
    // Setup failed AFTER the harness child spawned (e.g. an AF_UNIX EINVAL on a
    // too-long socket path). Don't leak the runner: stop it and finalize meta.
    await session.stop().catch(() => undefined);
    await writeHsrMeta(bee, { ...meta, status: "exited", exitCode: null, endedAt: new Date().toISOString() }).catch(() => undefined);
    throw error;
  }

  if (startupMeta) {
    try {
      // Serialize the state flip with sendText's queued/booting decision. A
      // sender either persists a turn that this drain consumes, or sees running
      // after the lock is released and uses the live RPC socket.
      await withHsrTurnDeliveryLock(bee, async () => {
        meta = { ...meta, status: "running", runningAt: new Date().toISOString() };
        await writeHsrMeta(bee, meta);
        await drainPendingHsrTurns(bee, (text) => session.send(text));
      });
    } catch (error) {
      await session.stop().catch(() => undefined);
      await server.close().catch(() => undefined);
      await writeHsrMeta(bee, {
        ...meta,
        status: "exited",
        exitCode: null,
        endedAt: new Date().toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  // Learn the provider session id (captured by the runner from the init line,
  // which carries no RunnerEvent) into meta.json.
  const reconcileSessionId = async (): Promise<void> => {
    if (finalized) return;
    if (session.sessionId && session.sessionId !== meta.sessionId) {
      meta = { ...meta, sessionId: session.sessionId };
      await writeHsrMeta(bee, meta).catch(() => undefined);
    }
  };
  setTimeout(() => void reconcileSessionId(), SESSION_ID_RECONCILE_MS);

  const finalize = async (exitCode: number | null): Promise<void> => {
    if (finalized) return;
    finalized = true;
    meta = {
      ...meta,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      status: "exited",
      exitCode,
      endedAt: new Date().toISOString(),
    };
    await writeHsrMeta(bee, meta).catch(() => undefined);
    await server.close().catch(() => undefined);
    resolveDone();
  };

  // --- event pump: persist is the runner's job; here we only broadcast -------
  void (async () => {
    try {
      for await (const event of session.events) {
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
