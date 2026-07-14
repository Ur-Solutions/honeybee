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

import type { RunnerAdapter, RunnerOpts } from "./types.js";
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

// Delay before the host reconciles a learned-at-init session id into meta.json,
// covering the no-turn case (the init line lands shortly after spawn).
const SESSION_ID_RECONCILE_MS = 60;

export async function runHsrHost(params: {
  bee: string;
  adapter: RunnerAdapter;
  opts: RunnerOpts;
  hostPid?: number;
  /** Detached local hosts queue fragile Codex cold starts; in-process remote hosts opt out. */
  queueStartup?: boolean;
}): Promise<HsrHostHandle> {
  const { bee, adapter, opts } = params;
  const hostPid = params.hostPid ?? process.pid;
  const controlSocket = hsrControlSocketPath(bee);

  await ensureHsrRunDir(bee);
  const tier = adapter.tier();
  const queuedAt = new Date().toISOString();
  const queueCodexStartup =
    params.queueStartup === true &&
    adapter.harness === "codex" &&
    tier === "server" &&
    codexStartupConcurrency() > 0;

  let queuedMeta: HsrMeta | undefined;
  if (queueCodexStartup) {
    // Publish liveness before waiting for admission so `hive ps` reports an
    // intentional queued bee instead of fabricating a crash/boot wedge.
    queuedMeta = {
      bee,
      harness: adapter.harness,
      tier,
      hostPid,
      startedAt: queuedAt,
      queuedAt,
      controlSocket,
      status: "queued",
    };
    await writeHsrMeta(bee, queuedMeta);
  }

  let session: Awaited<ReturnType<RunnerAdapter["start"]>>;
  try {
    session = queueCodexStartup
      ? await withCodexStartupSlot(bee, () => adapter.start(opts))
      : await adapter.start(opts);
  } catch (error) {
    if (queuedMeta) {
      await writeHsrMeta(bee, {
        ...queuedMeta,
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
    startedAt: queuedMeta?.startedAt ?? new Date().toISOString(),
    ...(queuedMeta?.queuedAt ? { queuedAt: queuedMeta.queuedAt } : {}),
    controlSocket,
    status: queueCodexStartup ? "queued" : "running",
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
      return session.answer(String(p.requestId ?? ""), String(p.answer ?? ""));
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

  if (queueCodexStartup) {
    try {
      // Serialize the state flip with sendText's queued decision. A sender
      // either sees queued and persists a turn that this drain consumes, or
      // sees running after this lock is released and uses the live RPC socket.
      await withHsrTurnDeliveryLock(bee, async () => {
        meta = { ...meta, status: "running" };
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
