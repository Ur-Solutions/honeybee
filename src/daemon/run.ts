import type { ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { acquireLongLivedLock, type LongLivedLock, LockBusyError } from "../fsx.js";
import { reapDeadHosts } from "../hsr/observe.js";
import type { BeeState } from "../state.js";
import { appendLedger } from "../store.js";
import { appendDaemonLog } from "./log.js";
import { startHsrControlServer, type HsrControlServer } from "./hsrControl.js";
import {
  DAEMON_VERSION,
  daemonLockPath,
  defaultDaemonConfig,
  writeDaemonState,
  type DaemonConfig,
  type DaemonState,
} from "./index.js";
import { logTickResult, tick, type TickResult } from "./tick.js";
import { defaultTickTimeouts, envMs, toError, withTimeout } from "./timeouts.js";
import { buildDefaultDeps } from "./wiring.js";
import { createSupervisor, pushRecentError, spawnSentinel } from "./supervision.js";

// The daemon's tick machinery, default wiring, and timeout primitives moved to
// dedicated modules (tick/probe/wiring/supervision/timeouts) in the HIVE-18
// decomposition. Re-export the public surface here so existing imports of
// `./daemon/run.js` keep resolving.
export {
  emptyDispatcherOutcomes,
  tick,
  tickDispatchers,
  type DispatchContext,
  type DispatcherOutcomes,
  type ProbeResult,
  type TickDeps,
  type TickDispatcher,
  type TickResult,
  type TickTransition,
} from "./tick.js";
export { defaultTickTimeouts, withTimeout, type TickTimeouts } from "./timeouts.js";
export {
  buildDefaultDeps,
  createThrottledTranscriptMetadataRefresh,
  type ThrottledTranscriptRefreshOptions,
} from "./wiring.js";

/* ------------------------------------------------------------------ */
/* Effectful runDaemon                                                 */
/* ------------------------------------------------------------------ */

export type RunDaemonOptions = {
  config?: Partial<DaemonConfig>;
  /** Inject a custom tick implementation (testing). */
  tickImpl?: typeof tick;
  /** Resolve when the daemon is asked to shut down (testing). */
  shutdownSignal?: AbortSignal;
  /**
   * Invoked when an in-process defense judges the daemon unrecoverable: the
   * loop stopped beating past config.watchdogMs, or maxConsecutiveFailures
   * loop iterations failed in a row (a poisoned threadpool fails every fs op
   * forever). The default hard-kills the process: best-effort SYNC state/log
   * writes (sync fs syscalls bypass the threadpool) then SIGKILL — NOT
   * process.exit(), whose exit path joins the threadpool and deadlocked for
   * ~9h in the 2026-07-02 incident. Supervision (launchd KeepAlive) restarts
   * the daemon. Injectable for tests.
   */
  onWatchdogBreach?: (info: { stalledMs: number; reason: string }) => void;
  /**
   * Spawn the out-of-process sentinel (SIGKILLs this daemon when the
   * state.json heartbeat stalls; see sentinel.ts). Off by default so tests
   * and embedders opt in; the `hive daemon run` CLI path enables it.
   */
  sentinel?: boolean;
  /** Injectable crash-adoption reap (testing); defaults to reapDeadHosts. */
  bootReap?: () => Promise<string[]>;
};

export async function runDaemon(options: RunDaemonOptions = {}): Promise<void> {
  const config = { ...defaultDaemonConfig(), ...(options.config ?? {}) };
  let lock: LongLivedLock | null = null;
  try {
    lock = await acquireLongLivedLock(daemonLockPath(), { label: "hive daemon" });
  } catch (error) {
    if (error instanceof LockBusyError) {
      const existing = error.existing;
      const msg = existing
        ? `hive daemon already running (pid ${existing.pid} on ${existing.hostname || "<unknown>"}, since ${existing.startedAt})`
        : `hive daemon lock busy: ${daemonLockPath()}`;
      await appendDaemonLog({ level: "error", msg });
      const err = new Error(msg);
      (err as NodeJS.ErrnoException).code = "EBUSY";
      throw err;
    }
    throw error;
  }

  const startedAt = new Date().toISOString();
  const state: DaemonState = {
    startedAt,
    lastTickAt: null,
    lastSuccessfulTickAt: null,
    tickCount: 0,
    version: DAEMON_VERSION,
    pid: process.pid,
    recentErrors: [],
  };

  let observed = new Map<string, BeeState>();
  let stopping = false;
  let stopReason = "loop-exit";
  let exitCode = 0;

  const tickFn = options.tickImpl ?? tick;
  const deps = buildDefaultDeps();

  const requestShutdown = (reason: string, code: number) => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    exitCode = code;
  };

  // Register signal handlers BEFORE any awaitable IO. A test (or upstream supervisor)
  // may SIGTERM the daemon the moment it sees the lock or state file appear; without
  // a registered handler the process would die on default action and leak the lock.
  const onSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`signal:${signal}`, 0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const uncaughtErrors: unknown[] = [];
  const onUncaught = (error: unknown) => {
    uncaughtErrors.push(error);
    requestShutdown("uncaught-exception", 1);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  // Best-effort synchronous safety net: if Node terminates without our async cleanup
  // completing (eg fatal C error, signal arriving during an unrelated sync op), still
  // try to remove the lock file. The condition matches releaseIfOwner's semantics.
  const safetyNetRelease = () => {
    try {
      const meta = readFileSync(daemonLockPath(), "utf8");
      const parsed = JSON.parse(meta) as { token?: string };
      if (lock && parsed.token === lock.token) {
        unlinkSync(daemonLockPath());
      }
    } catch {
      // best effort
    }
  };
  process.on("exit", safetyNetRelease);

  // Now safe to do awaitable IO — signal handlers will request shutdown if SIGTERM
  // arrives mid-write.
  await writeDaemonState(state);
  await appendDaemonLog({ level: "info", msg: "daemon.start", pid: process.pid, tickMs: config.tickMs });
  await appendLedger({ type: "daemon.start", pid: process.pid, startedAt, version: DAEMON_VERSION }).catch(() => undefined);

  // HSR aggregate control/observe endpoint (APIA-73): one unix socket the
  // CLI/Apiary ride for spawn/send/interrupt/observe/liveness across all HSR
  // bees. Started best-effort and event-driven (independent of the tick loop);
  // a socket failure must NOT prevent the daemon from running.
  let hsrControl: HsrControlServer | null = null;
  try {
    hsrControl = await startHsrControlServer();
    await appendDaemonLog({ level: "info", msg: "hsr.control.start", path: hsrControl.path });
  } catch (error) {
    await appendDaemonLog({ level: "warn", msg: "hsr.control.start.failed", error: error instanceof Error ? error.message : String(error) });
  }

  // Crash adoption v1 (reapDeadHosts): reconcile HSR bees whose meta says
  // "running" but whose host pid is dead. DEFERRED until after the FIRST
  // SUCCESSFUL tick (2026-07-21 canary, round 2): merely detaching it was not
  // enough — the scan is ~1000 run-dir reads plus main-thread JSON parsing in
  // THIS process, and launched at boot it raced the cold first tick for the
  // event loop and fs pool, starving it past the 120s budget into the breach
  // cycle the detach was meant to fix (two post-patch pids breached exactly
  // this way; verified via process sampling). Adoption is not urgent — the
  // tick's per-bee observation reaches the same verdict — so it now waits for
  // the loop to prove one healthy tick first. The kick lives in the loop body
  // below; nothing runs here.
  const bootReap = options.bootReap ?? reapDeadHosts;
  let bootReapKicked = false;

  if (options.shutdownSignal) {
    if (options.shutdownSignal.aborted) {
      requestShutdown("abort", 0);
    } else {
      options.shutdownSignal.addEventListener("abort", () => {
        requestShutdown("abort", 0);
      });
    }
  }

  // In-process supervision: the watchdog hard-kills the daemon if the tick loop
  // stops beating past config.watchdogMs, and breach() is also called by the
  // loop's consecutive-failure escalation below. Both persist state
  // synchronously before the SIGKILL — the synchronous path is the only one a
  // poisoned threadpool can still complete (see supervision.ts).
  const supervisor = createSupervisor({
    config,
    state,
    safetyNetRelease,
    onWatchdogBreach: options.onWatchdogBreach,
    isStopping: () => stopping,
  });
  supervisor.start();

  // Out-of-process sentinel: a separate process that SIGKILLs us when the
  // state.json heartbeat stalls. It is the only defense that works when this
  // process can no longer run ANY JS (sync-blocked loop, wedged exit path).
  let sentinel: ChildProcess | null = null;
  if (options.sentinel === true) {
    try {
      sentinel = spawnSentinel(config);
      await appendDaemonLog({ level: "info", msg: "daemon.sentinel.start", pid: sentinel.pid ?? null, staleMs: config.sentinelStaleMs });
    } catch (error) {
      await appendDaemonLog({ level: "warn", msg: "daemon.sentinel.start.failed", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    }
  }

  // Bookkeeping IO (daemon log + state writes) runs under the same hard
  // budget as tick-path fs. Incident 2026-07-02: the tick was contained by
  // its per-call timeouts, but an UNTIMED post-tick appendDaemonLog hung on
  // the poisoned threadpool and froze the loop with recentErrors empty.
  const bookkeepingMs = defaultTickTimeouts().fsMs;
  let iterationIoFailed = false;
  const safeLog = async (entry: Parameters<typeof appendDaemonLog>[0]) => {
    try {
      await withTimeout(appendDaemonLog(entry), bookkeepingMs, "appendDaemonLog");
    } catch {
      iterationIoFailed = true;
    }
  };

  // Chain sync runs on its OWN track, never inside the tick path: a keychain
  // prompt or a sweep over hundreds of session homes is far too heavy to share
  // the observation loop's sequential budget (the listSessions-timeout breach
  // cycle was starvation of exactly that path). The loop sleeps first, so a
  // supervised-restart storm never front-loads keychain sweeps into boot.
  const chainSyncIntervalMs = envMs("HIVE_DAEMON_CHAIN_SYNC_INTERVAL_MS", 5 * 60_000);
  const chainSyncBudgetMs = defaultTickTimeouts().chainSyncMs;
  const chainSyncLoop = deps.syncChains
    ? (async () => {
        while (!stopping) {
          await sleep(chainSyncIntervalMs, () => stopping);
          if (stopping) return;
          try {
            await withTimeout(deps.syncChains!(), chainSyncBudgetMs, "syncChains");
          } catch (error) {
            pushRecentError(state, toError(error));
            await safeLog({ level: "warn", msg: "chain.sync.failed", error: toError(error).message });
          }
        }
      })()
    : Promise.resolve();

  // Tick loop: an async sleep loop (not setInterval), with ticks strictly
  // serialized — at most one tick is ever in flight. A budget-abandoned tick
  // keeps running in the background, and the tick path is NOT reentrant: the
  // dispatchers (usage sampler, needs-input, node reachability, auto-title)
  // are stateful closures built once per daemon run, and the per-record loop
  // writes session files. Overlapping ticks would mutate that shared state
  // concurrently (double-fired events, corrupted sampler maps, torn record
  // writes), so while an abandoned tick is still pending the loop SKIPS its
  // tick instead of starting another.
  let consecutiveFailures = 0;
  let lastHealthyIterationMs = Date.now();
  // The most recent budget-abandoned tick, until it settles. `result` carries
  // its late resolution so the next tick can adopt the observed map.
  let abandonedTick: { settled: boolean; result: TickResult | null } | null = null;
  try {
    while (!stopping) {
      if (config.maxTicks !== undefined && state.tickCount >= config.maxTicks) break;
      supervisor.beat();
      iterationIoFailed = false;
      // The whole tick runs under a hard budget. A tick that blows it is
      // abandoned and recorded; the loop keeps iterating (skipping ticks)
      // until the abandoned tick settles, so the loop itself never wedges —
      // production incident 2026-06-29: a lost libuv fs completion froze one
      // tick, and therefore the daemon, for 3+ days with recentErrors empty.
      // Skipped iterations count as failures, so a tick that NEVER settles
      // escalates through maxConsecutiveFailures to a supervised restart.
      let result: TickResult | null = null;
      let tickError: Error | null = null;
      if (abandonedTick && !abandonedTick.settled) {
        tickError = new Error(`tick skipped: previous tick still running past its ${config.tickBudgetMs}ms budget`);
      } else {
        if (abandonedTick) {
          // The abandoned tick's side effects (dispatches, ledger events,
          // record writes) really happened: adopt its observed map so the
          // next tick doesn't re-detect — and re-dispatch — the same
          // transitions. It still doesn't count toward tickCount.
          if (abandonedTick.result) observed = abandonedTick.result.observed;
          await safeLog({ level: "info", msg: "tick.abandoned.settled", adoptedObserved: abandonedTick.result !== null });
          abandonedTick = null;
        }
        // firstTick until one tick has COUNTED: cold-cache samplers sit out
        // (skipFirstTick) so the boot tick proves loop health in seconds.
        const tickPromise = tickFn(deps, observed, { firstTick: state.tickCount === 0 });
        try {
          result = await withTimeout(tickPromise, config.tickBudgetMs, "tick");
        } catch (error) {
          tickError = toError(error);
          const entry: { settled: boolean; result: TickResult | null } = { settled: false, result: null };
          tickPromise.then(
            (late) => {
              entry.settled = true;
              entry.result = late;
            },
            () => {
              entry.settled = true; // an abandoned tick may still reject later
            },
          );
          abandonedTick = entry;
        }
      }
      supervisor.beat();
      if (result) {
        observed = result.observed;
        state.tickCount += 1;
        state.lastTickAt = new Date().toISOString();
        state.lastSuccessfulTickAt = state.lastTickAt;
        state.lastTickStageMs = result.stageMs;
        state.lastTickDurationMs = result.durationMs;
        // Crash-adoption reap: kicked exactly once, only after the loop has
        // PROVEN one healthy tick — never racing the cold boot tick for the
        // event loop (2026-07-21 canary round 2).
        if (!bootReapKicked) {
          bootReapKicked = true;
          void bootReap()
            .then((reaped) =>
              reaped.length > 0 ? appendDaemonLog({ level: "info", msg: "hsr.reaped", bees: reaped }).catch(() => undefined) : undefined,
            )
            .catch(() => undefined);
        }
        // Record every partial-tick error into recentErrors, then flush the
        // tick's log fan-out (partials, transitions, dispatcher outcomes) in a
        // fixed order — see logTickResult().
        for (const err of result.errors) {
          pushRecentError(state, err);
        }
        for (const entry of logTickResult(result)) {
          await safeLog(entry);
        }
      } else if (tickError) {
        pushRecentError(state, tickError);
        await safeLog({ level: "error", msg: "tick.error", error: tickError.message });
        // A budget-abandoned or thrown tick still proves the loop is alive:
        // stamp lastTickAt (external staleness checks key on loop-death, not
        // slow ticks) but do not count it — a frozen tickCount alongside
        // fresh lastTickAt + recentErrors reads as "loop alive, ticks failing".
        state.lastTickAt = new Date().toISOString();
      }
      try {
        await withTimeout(writeDaemonState({ ...state, recentErrors: [...state.recentErrors] }), bookkeepingMs, "writeDaemonState");
      } catch (error) {
        iterationIoFailed = true;
        const err = toError(error);
        await safeLog({ level: "warn", msg: "state.write.failed", error: err.message });
      }
      // A poisoned threadpool (lost libuv completion) fails EVERY fs op from
      // then on: each iteration times out its tick and its bookkeeping, but
      // the loop itself stays alive — so the beat watchdog never fires and
      // the daemon would run uselessly forever. Escalate to a hard kill once
      // failures are clearly systemic rather than a transient blip.
      if (tickError !== null || iterationIoFailed) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= config.maxConsecutiveFailures && !stopping) {
          supervisor.breach({
            stalledMs: Date.now() - lastHealthyIterationMs,
            reason: `${consecutiveFailures} consecutive failed loop iterations (poisoned runtime)`,
          });
        }
      } else {
        consecutiveFailures = 0;
        lastHealthyIterationMs = Date.now();
      }
      if (stopping) break;
      if (config.maxTicks !== undefined && state.tickCount >= config.maxTicks) break;
      await sleep(config.tickMs, () => stopping);
      supervisor.beat();
    }
    // The loop can exit without requestShutdown (maxTicks): flip `stopping` so
    // the chain-sync track (which keys on it) winds down instead of keeping
    // the process alive on its interval forever.
    stopping = true;

    await appendDaemonLog({ level: "info", msg: "daemon.shutdown", reason: stopReason });
    await appendLedger({ type: "daemon.stop", pid: process.pid, reason: stopReason, stoppedAt: new Date().toISOString() }).catch(() => undefined);
    for (const error of uncaughtErrors) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      await appendDaemonLog({ level: "error", msg: "daemon.uncaught", error: message });
    }
  } finally {
    supervisor.stop();
    // Give the chain-sync loop a beat to notice `stopping`; a sync wedged
    // mid-flight is bounded by its own withTimeout and must not hold shutdown.
    await Promise.race([chainSyncLoop, new Promise((resolve) => setTimeout(resolve, 500))]);
    if (sentinel) {
      try {
        sentinel.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    if (hsrControl) await hsrControl.close().catch(() => undefined);
    await deps.mirrorRemoteEvents?.close?.().catch(() => undefined);
    await deps.hsrObservations?.close?.().catch(() => undefined);
    if (lock) {
      try {
        await lock.release();
      } catch {
        // ignore
      }
    }
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    process.off("exit", safetyNetRelease);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = 50;
    let elapsed = 0;
    const handle = setInterval(() => {
      elapsed += tick;
      if (shouldStop() || elapsed >= ms) {
        clearInterval(handle);
        resolve();
      }
    }, Math.min(tick, Math.max(1, ms)));
    if (ms <= 0) {
      clearInterval(handle);
      resolve();
    }
  });
}
