/**
 * The daemon's self-supervision defenses: the in-process watchdog, the
 * synchronous breach/hard-kill self-destruct, and the out-of-process sentinel
 * spawn. These exist because a poisoned Node runtime (a lost libuv fs
 * completion) hangs every async fs op forever, and process.exit() itself
 * deadlocks joining the threadpool (2026-07-02 incident: ~9h stuck inside
 * process.exit). The only escapes are a synchronous syscall (sync fs bypasses
 * the threadpool) and SIGKILL (needs no cooperation from the wedged runtime);
 * launchd KeepAlive (SuccessfulExit=false) restarts the daemon.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { daemonLogPath } from "./log.js";
import { daemonStatePath, maxRecentErrors, type DaemonConfig, type DaemonState, type RecentError } from "./index.js";

export type BreachInfo = { stalledMs: number; reason: string };

export type Supervisor = {
  /** Record a tick-loop heartbeat; the watchdog measures stall from the last beat. */
  beat: () => void;
  /** Start the in-process watchdog timer. */
  start: () => void;
  /** Stop the watchdog timer (idempotent). */
  stop: () => void;
  /**
   * Judge the daemon unrecoverable and fire the breach action exactly once:
   * record the reason, persist state synchronously, then hard-kill (or run the
   * injected handler). Called by the watchdog and by the loop's
   * consecutive-failure escalation.
   */
  breach: (info: BreachInfo) => void;
};

export type CreateSupervisorOptions = {
  config: DaemonConfig;
  /** The live daemon state object; breach records into and persists it. */
  state: DaemonState;
  /** Best-effort synchronous lock release, shared with the process-exit net. */
  safetyNetRelease: () => void;
  /**
   * Invoked when an in-process defense judges the daemon unrecoverable. The
   * default hard-kills the process (see hardKill); tests inject a spy.
   */
  onWatchdogBreach?: (info: BreachInfo) => void;
  /** Whether the daemon is already shutting down — the watchdog suppresses then. */
  isStopping: () => boolean;
};

/**
 * Build the in-process supervisor around a daemon run's mutable state. The
 * watchdog fires when the tick loop stops beating for config.watchdogMs — the
 * tick budget machinery itself failed, or a bookkeeping write wedged past its
 * own timeout. A frozen loop must never masquerade as a running daemon. (A
 * synchronously-blocked event loop defeats any timer, including this one — that
 * mode is covered by the out-of-process sentinel.)
 */
export function createSupervisor(options: CreateSupervisorOptions): Supervisor {
  const { config, state, safetyNetRelease, isStopping } = options;
  const onBreach = options.onWatchdogBreach ?? ((info: BreachInfo) => hardKill(info, safetyNetRelease));
  let breachFired = false;
  let lastLoopBeatMs = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const breach = (info: BreachInfo): void => {
    if (breachFired) return;
    breachFired = true;
    pushRecentError(state, new Error(`${info.reason}; hard-killing for supervised restart (stalled ${info.stalledMs}ms)`));
    // Persist the breach record synchronously BEFORE the breach action: the
    // action is normally SIGKILL, after which nothing runs, and async writes
    // are exactly what a poisoned threadpool can no longer deliver.
    try {
      writeFileSync(daemonStatePath(), `${JSON.stringify({ ...state, recentErrors: [...state.recentErrors] }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // best effort
    }
    onBreach(info);
  };

  return {
    beat: () => {
      lastLoopBeatMs = Date.now();
    },
    start: () => {
      watchdog = setInterval(
        () => {
          const stalledMs = Date.now() - lastLoopBeatMs;
          if (isStopping() || stalledMs <= config.watchdogMs) return;
          breach({ stalledMs, reason: `watchdog: tick loop stalled past ${config.watchdogMs}ms` });
        },
        Math.max(25, Math.min(config.tickMs, 1_000)),
      );
    },
    stop: () => {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
    },
    breach,
  };
}

/**
 * Hard self-destruct for a poisoned runtime. Everything here is SYNCHRONOUS on
 * purpose: once a libuv completion is lost, every async fs op hangs forever,
 * and process.exit() deadlocks joining the threadpool. Sync fs is a direct
 * syscall on this thread and SIGKILL needs no cooperation from the wedged
 * runtime; launchd KeepAlive restarts us.
 */
function hardKill(info: BreachInfo, safetyNetRelease: () => void): void {
  try {
    appendFileSync(
      daemonLogPath(),
      `${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "daemon.breach", reason: info.reason, stalledMs: info.stalledMs })}\n`,
    );
  } catch {
    // best effort
  }
  safetyNetRelease();
  process.kill(process.pid, "SIGKILL");
}

/**
 * Spawn the out-of-process sentinel: a separate process that SIGKILLs this
 * daemon when the state.json heartbeat stalls. It is the only defense that
 * works when this process can no longer run ANY JS (sync-blocked loop, wedged
 * exit path). Throws if the CLI entrypoint cannot be resolved; the caller logs
 * and continues — the sentinel is best-effort.
 */
export function spawnSentinel(config: DaemonConfig): ChildProcess {
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error("cannot resolve CLI entrypoint for sentinel");
  const sentinel = spawn(
    process.execPath,
    [
      cliPath,
      "daemon",
      "sentinel",
      "--parent-pid",
      String(process.pid),
      "--state-path",
      daemonStatePath(),
      "--stale-ms",
      String(config.sentinelStaleMs),
      "--check-ms",
      String(config.sentinelCheckMs),
      "--log-path",
      daemonLogPath(),
    ],
    { stdio: "ignore" },
  );
  sentinel.unref();
  return sentinel;
}

export function pushRecentError(state: DaemonState, error: Error): void {
  const entry: RecentError = { ts: new Date().toISOString(), msg: error.message };
  state.recentErrors.push(entry);
  const cap = maxRecentErrors();
  if (state.recentErrors.length > cap) {
    state.recentErrors.splice(0, state.recentErrors.length - cap);
  }
}
