import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { listAccounts, syncAccountCredentialsToVault, syncAllAccountCredentialsToVault } from "../accounts.js";
import { acquireLongLivedLock, type LongLivedLock, LockBusyError } from "../fsx.js";
import { hiveStateFor, writeHiveState } from "../hiveState.js";
import { listNodes, type NodeRecord } from "../node.js";
import { sealedBeeNames } from "../seal.js";
import { refreshSessionTranscriptMetadata } from "../sessionMetadata.js";
import { hsrObservations, reapDeadHosts, type HsrObservation } from "../hsr/observe.js";
import { createRemoteEventMirror } from "../hsr/remoteEventMirror.js";
import { deriveState, liveTargetKey, type BeeState, type PaneCaptureMap, type StateContext } from "../state.js";
import { appendLedger, listSessions, type SessionRecord, touchSession } from "../store.js";
import { localSubstrate, substrateFor, substrateForRecord } from "../substrates/index.js";
import { createAutoTitleDispatcher, type AutoTitleOutcome } from "./autoTitle.js";
import { dispatchAutoswaps, type AutoswapOutcome } from "./autoswap.js";
import { dispatchBuzDrains, type BuzDispatchOutcome } from "./buzDispatcher.js";
import { createNeedsInputDispatcher, type NeedsInputOutcome } from "./needsInput.js";
import { createNodeReachabilityTracker, type NodeReachabilityDispatcher, type NodeReachabilityOutcome } from "./nodeReachability.js";
import { createUsageSampler, type UsageSampler, type UsageTickOutcome } from "./usageSampler.js";
import { appendDaemonLog, daemonLogPath } from "./log.js";
import { startHsrControlServer, type HsrControlServer } from "./hsrControl.js";
import {
  DAEMON_VERSION,
  daemonLockPath,
  daemonStatePath,
  defaultDaemonConfig,
  maxRecentErrors,
  writeDaemonState,
  type DaemonConfig,
  type DaemonState,
  type RecentError,
} from "./index.js";

const DEFAULT_NODE_PROBE_TIMEOUT_MS = 2_500;

/**
 * Hard per-call budgets for every external await in the tick path. The tick
 * loop is strictly sequential (one tick fully resolves before the next), so a
 * single never-settling promise — a wedged tmux client, a keychain prompt, or
 * even a lost libuv fs completion (observed in production: an fs.promises
 * readFile of a codex transcript whose threadpool completion was never
 * delivered) — silently freezes the daemon forever while its process stays
 * alive. Timeouts convert that class of failure into a recentErrors entry and
 * a skipped stage instead of a dead observer.
 */
export type TickTimeouts = {
  /** fs-backed deps: listSessions/listNodes/sealedBeeNames/touchSession/appendLedger. */
  fsMs: number;
  /** substrate-backed deps: probeNodes (outer bound), capturePanes, livePanes, mirrorHiveState. */
  substrateMs: number;
  /** per-record transcript metadata refresh (reads provider transcripts). */
  transcriptMs: number;
  /** dispatchers: buz drain, usage sampler, autoswap, auto-title. */
  dispatchMs: number;
  /** credential chain sync (keychain + a sweep over many homes). */
  chainSyncMs: number;
};

export function defaultTickTimeouts(): TickTimeouts {
  return {
    fsMs: envMs("HIVE_DAEMON_FS_TIMEOUT_MS", 15_000),
    substrateMs: envMs("HIVE_DAEMON_SUBSTRATE_TIMEOUT_MS", 20_000),
    transcriptMs: envMs("HIVE_DAEMON_TRANSCRIPT_TIMEOUT_MS", 15_000),
    dispatchMs: envMs("HIVE_DAEMON_DISPATCH_TIMEOUT_MS", 60_000),
    chainSyncMs: envMs("HIVE_DAEMON_CHAIN_SYNC_TIMEOUT_MS", 120_000),
  };
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export type ProbeResult = {
  liveTargets: Set<string>;
  unreachableNodes: Set<string>;
  /** Live @hive_state values keyed by liveTargetKey(node, session). */
  sessionStates?: Map<string, string>;
};

export type TickDeps = {
  listSessions: () => Promise<SessionRecord[]>;
  listNodes: () => Promise<NodeRecord[]>;
  /** Live target enumeration + node reachability — substrate-routable. */
  probeNodes: (nodes: NodeRecord[]) => Promise<ProbeResult>;
  /** Captures panes for the subset of live records. */
  capturePanes: (records: SessionRecord[], liveTargets: Set<string>) => Promise<PaneCaptureMap>;
  /** Live pane ids on the local server, for pane-pinned liveness (problem c). */
  livePanes?: () => Promise<Set<string>>;
  /**
   * Cross-process observation of pane-less HSR bees, read from run dirs (host-pid
   * liveness + structured event state). Threaded into the tick's StateContext so
   * the daemon derives HSR state and drives transitions/buz-drain for HSR bees
   * exactly like tmux bees. Absent → no HSR bees observed this tick.
   */
  hsrObservations?: () => Promise<Map<string, HsrObservation>>;
  /**
   * Optional remote-event mirror (APIA-94): for each live remote-hsr bee,
   * maintains an `observe` subscription to its node's serve and replays every
   * event into the LOCAL run dir (events.jsonl/ring.txt + a mirror meta.json).
   * That makes the mirrored bee observable by the SAME run-dir machinery as a
   * local HSR bee — deriveState (finer than the node-probe) and the usage
   * sampler both read the mirror. Stateful across ticks (subscriptions persist)
   * — build once per daemon run. Runs BEFORE hsrObservations() so this tick can
   * already read a freshly-created mirror meta.
   */
  mirrorRemoteEvents?: (records: SessionRecord[]) => Promise<void>;
  sealedBeeNames: () => Promise<Set<string>>;
  /** Atomically persist observed state without ledger. */
  touchSession: (name: string, fields: Partial<SessionRecord>) => Promise<SessionRecord | null>;
  /**
   * Optional mirror of state transitions onto the bee's tmux session as the
   * @hive_state user option (status bars read it live). Best-effort: only
   * invoked on transitions, never on steady state.
   */
  mirrorHiveState?: (record: SessionRecord, state: BeeState) => Promise<void>;
  /** Best-effort transcript path/provider title discovery. */
  refreshTranscriptMetadata?: (record: SessionRecord) => Promise<SessionRecord | null>;
  /** Append a single event to the ledger (used for state.transition). */
  appendLedger: (event: Record<string, unknown>) => Promise<void>;
  /**
   * Optional dispatcher hook: invoked with the records and the transitions
   * detected this tick. The default implementation drains the buz queue/
   * mailbox for any bee that transitioned into idle_with_output. Tests
   * inject this to observe trigger inputs without exercising substrate IO.
   * `currentStates` is this tick's freshly derived state per bee — the
   * authoritative current state (the persisted lastObservedState lags a
   * tick and goes stale when its touchSession write failed).
   */
  dispatchBuzDrain?: (records: SessionRecord[], transitions: TickTransition[], currentStates: Map<string, BeeState>) => Promise<BuzDispatchOutcome[]>;
  /**
   * Optional HSR needs-input router (APIA-79): for each blocked HSR bee with a
   * structured needs_input, routes the request as an interrupt-tier buz to the
   * living parent, or marks it escalated when parentless/dead. Stateful across
   * ticks (de-dupes each request) — build once per daemon run.
   */
  dispatchNeedsInput?: (records: SessionRecord[], currentStates: Map<string, BeeState>) => Promise<NeedsInputOutcome[]>;
  /**
   * Optional node online/offline edge tracker (APIA-96): given this tick's nodes
   * and the node-probe's unreachableNodes, emits a `node.offline`/`node.online`
   * ledger event ONLY on a reachability edge. Stateful across ticks (edge
   * detection) — build once per daemon run.
   */
  dispatchNodeReachability?: NodeReachabilityDispatcher;
  /**
   * Optional usage sampler (Phase 3): observes panes/transcripts for
   * account-bound bees, appends usage samples and emits account.exhausted
   * events. Stateful across ticks — build once per daemon run.
   */
  sampleUsage?: UsageSampler;
  /**
   * Optional autoswap dispatcher (Phase 3): consumes the sampler's
   * rising-edge exhaustion outcomes for autoswap-enabled bees and calls the
   * swap-account primitive.
   */
  dispatchAutoswap?: (records: SessionRecord[], usageOutcomes: UsageTickOutcome[]) => Promise<AutoswapOutcome[]>;
  /**
   * Optional auto-titler: names untitled bees from their initial transcript
   * exchange using the configured cheap-model CLI. Stateful across ticks —
   * build once per daemon run (generation runs in the background; outcomes
   * surface on a later tick).
   */
  dispatchAutoTitle?: (records: SessionRecord[]) => Promise<AutoTitleOutcome[]>;
  /**
   * Optional credential sync: pulls rotated/refreshed auth from the accounts'
   * homes back into the vault. The default wiring throttles itself — most
   * ticks are a no-op.
   */
  syncChains?: () => Promise<void>;
  /** Per-call hard budgets; unset fields fall back to defaultTickTimeouts(). */
  timeouts?: Partial<TickTimeouts>;
  now: () => number;
};

export type TickTransition = {
  name: string;
  from: BeeState | undefined;
  to: BeeState;
};

export type TickResult = {
  transitions: TickTransition[];
  observed: Map<string, BeeState>;
  unreachableNodes: Set<string>;
  errors: Error[];
  /**
   * Per-bee outcomes from the buz queue dispatcher. Empty when no bee
   * transitioned into idle_with_output this tick or when dispatchBuzDrain
   * was not wired.
   */
  buzDrains: BuzDispatchOutcome[];
  /**
   * HSR needs-input routing outcomes: each blocked HSR bee's request routed to
   * its parent (routedTo) or escalated to the user (escalated). Empty when no
   * blocked HSR bee had a pending request / not wired.
   */
  needsInput: NeedsInputOutcome[];
  /**
   * Node online/offline edges detected this tick (APIA-96). Empty when no node
   * changed reachability / not wired.
   */
  nodeReachability: NodeReachabilityOutcome[];
  /** Per-bee usage sampler outcomes (empty when no account-bound bees / not wired). */
  usage: UsageTickOutcome[];
  /** Autoswap dispatcher outcomes (empty when nothing exhausted / not wired). */
  autoswaps: AutoswapOutcome[];
  /** Auto-title dispatcher outcomes (empty when nothing finished / not wired). */
  autoTitles: AutoTitleOutcome[];
  durationMs: number;
};

/**
 * Pure tick. Performs the per-tick observation cycle using only the injected
 * deps. Returns the transitions detected since the previous observed map and
 * the new observed map for the next tick. No timers, signals, PID, or log
 * writes happen here — those are owned by runDaemon().
 */
export async function tick(deps: TickDeps, previousObserved: Map<string, BeeState>): Promise<TickResult> {
  const start = deps.now();
  const errors: Error[] = [];
  const timeouts: TickTimeouts = { ...defaultTickTimeouts(), ...(deps.timeouts ?? {}) };

  const records: SessionRecord[] = await guard(withTimeout(deps.listSessions(), timeouts.fsMs, "listSessions"), errors, []);
  const nodes: NodeRecord[] = await guard(withTimeout(deps.listNodes(), timeouts.fsMs, "listNodes"), errors, []);
  const probe: ProbeResult = await guard(
    withTimeout(deps.probeNodes(nodes), timeouts.substrateMs, "probeNodes"),
    errors,
    { liveTargets: new Set<string>(), unreachableNodes: new Set<string>() },
  );
  const panes: PaneCaptureMap = await guard(
    withTimeout(deps.capturePanes(records, probe.liveTargets), timeouts.substrateMs, "capturePanes"),
    errors,
    new Map(),
  );
  const seals: Set<string> = await guard(withTimeout(deps.sealedBeeNames(), timeouts.fsMs, "sealedBeeNames"), errors, new Set());
  const livePanes: Set<string> = deps.livePanes
    ? await guard(withTimeout(deps.livePanes(), timeouts.substrateMs, "livePanes"), errors, new Set<string>())
    : new Set<string>();

  // Remote-event mirror (APIA-94): refresh subscriptions + replay remote-hsr
  // events into local run dirs BEFORE we read them below. Same per-call budget +
  // guard as the other dispatchers; errors are captured, never fatal.
  if (deps.mirrorRemoteEvents) {
    try {
      await withTimeout(deps.mirrorRemoteEvents(records), timeouts.dispatchMs, "mirrorRemoteEvents");
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Observe pane-less HSR bees from their run dirs. Same per-call budget +
  // guard as every other external await in the tick — a wedged fs read is
  // converted into a skipped stage (empty map) and a recentErrors entry, never
  // an unbounded await that freezes the loop.
  const hsrObs: Map<string, HsrObservation> = deps.hsrObservations
    ? await guard(withTimeout(deps.hsrObservations(), timeouts.substrateMs, "hsrObservations"), errors, new Map())
    : new Map();
  const hsrLive = new Set<string>();
  const hsrStates = new Map<string, BeeState>();
  const hsrSnapshots = new Map<string, string>();
  const hsrMirrors = new Set<string>();
  for (const [bee, observation] of hsrObs) {
    if (observation.live) hsrLive.add(bee);
    if (observation.state) hsrStates.set(bee, observation.state);
    hsrSnapshots.set(bee, observation.snapshot);
    if (observation.mirrorOf) hsrMirrors.add(bee);
  }

  const nowMs = deps.now();
  const context: StateContext = {
    liveTargets: probe.liveTargets,
    livePanes,
    panes,
    previousStates: previousObserved,
    seals,
    unreachableNodes: probe.unreachableNodes,
    hsrLive,
    hsrStates,
    hsrSnapshots,
    hsrMirrors,
    now: nowMs,
  };

  const observed = new Map<string, BeeState>();
  const transitions: TickTransition[] = [];
  const observedAtIso = new Date(nowMs).toISOString();

  for (const record of records) {
    const derived = deriveState(record, context);
    observed.set(record.name, derived.state);
    const prev = previousObserved.get(record.name);
    const mappedHiveState = hiveStateFor(derived.state);
    const liveHiveState = liveHiveStateFor(record, probe);
    const staleHiveState = mappedHiveState !== undefined && liveHiveState !== undefined && liveHiveState !== mappedHiveState;
    const uncertainBooting = derived.state === "booting" && liveHiveState !== undefined && liveHiveState.length > 0;
    const transitioned = prev !== derived.state;
    if (transitioned) {
      transitions.push({ name: record.name, from: prev, to: derived.state });
    }
    if ((transitioned || staleHiveState) && !uncertainBooting) {
      if (deps.mirrorHiveState) {
        try {
          await withTimeout(deps.mirrorHiveState(record, derived.state), timeouts.substrateMs, `mirrorHiveState(${record.name})`);
        } catch (error) {
          errors.push(toError(error));
        }
      }
    }

    // Persist the latest observed state. Errors are captured but do not abort the loop.
    try {
      await withTimeout(
        deps.touchSession(record.name, {
          lastObservedState: derived.state,
          lastObservedStateAt: observedAtIso,
        }),
        timeouts.fsMs,
        `touchSession(${record.name})`,
      );
    } catch (error) {
      errors.push(toError(error));
    }

    // Dead/sealed bees no longer produce transcript updates — skip the
    // refresh once transcript metadata has been captured. A bee that exited
    // before its first refresh (fast finish between ticks) still gets one
    // pass so list/search/tail metadata is not permanently missing.
    const terminal = derived.state === "dead" || derived.state === "sealed";
    if ((!terminal || !record.transcriptPath) && deps.refreshTranscriptMetadata) {
      try {
        await withTimeout(deps.refreshTranscriptMetadata(record), timeouts.transcriptMs, `refreshTranscriptMetadata(${record.name})`);
      } catch (error) {
        errors.push(toError(error));
      }
    }
  }

  // Emit a ledger event for each transition into idle_with_output (the daemon's
  // headline signal — the buz dispatcher subscribes to this).
  for (const transition of transitions) {
    if (transition.to !== "idle_with_output") continue;
    if (transition.from === undefined) continue; // first observation isn't a transition
    try {
      await withTimeout(
        deps.appendLedger({
          type: "state.transition",
          session: transition.name,
          from: transition.from,
          to: transition.to,
          ts: observedAtIso,
        }),
        timeouts.fsMs,
        `appendLedger(state.transition ${transition.name})`,
      );
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Run dispatchers for state-derived work. The buz queue dispatcher drains
  // tier-B messages for any bee that transitioned into idle_with_output.
  // Dispatcher errors are captured into errors[] but do not abort the tick.
  let buzDrains: BuzDispatchOutcome[] = [];
  if (deps.dispatchBuzDrain) {
    try {
      buzDrains = await withTimeout(deps.dispatchBuzDrain(records, transitions, observed), timeouts.dispatchMs, "dispatchBuzDrain");
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // HSR needs-input router: route each blocked HSR bee's structured request to
  // its living parent (buz) or mark it escalated. Same guard/budget as the
  // other dispatchers; errors are captured, never fatal to the tick.
  let needsInput: NeedsInputOutcome[] = [];
  if (deps.dispatchNeedsInput) {
    try {
      needsInput = await withTimeout(deps.dispatchNeedsInput(records, observed), timeouts.dispatchMs, "dispatchNeedsInput");
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Node reachability edge tracker (APIA-96): emit node.online/node.offline on
  // the reachability edge only, keyed off the node-probe's unreachableNodes.
  // Same guard/budget as the other dispatchers; errors are captured, never fatal.
  let nodeReachability: NodeReachabilityOutcome[] = [];
  if (deps.dispatchNodeReachability) {
    try {
      nodeReachability = await withTimeout(
        deps.dispatchNodeReachability(nodes, probe.unreachableNodes, nowMs),
        timeouts.dispatchMs,
        "dispatchNodeReachability",
      );
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Usage sampler: factual per-account token samples + exhaustion events.
  let usage: UsageTickOutcome[] = [];
  if (deps.sampleUsage) {
    try {
      usage = await withTimeout(deps.sampleUsage(records, panes, nowMs), timeouts.dispatchMs, "sampleUsage");
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Autoswap: opt-in deterministic reaction to this tick's exhaustion edges.
  let autoswaps: AutoswapOutcome[] = [];
  if (deps.dispatchAutoswap && usage.some((outcome) => outcome.exhausted)) {
    try {
      autoswaps = await withTimeout(deps.dispatchAutoswap(records, usage), timeouts.dispatchMs, "dispatchAutoswap");
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Auto-titler: kick off (or collect) background title generation for
  // untitled bees whose initial exchange is now visible.
  let autoTitles: AutoTitleOutcome[] = [];
  if (deps.dispatchAutoTitle) {
    try {
      autoTitles = await withTimeout(deps.dispatchAutoTitle(records), timeouts.dispatchMs, "dispatchAutoTitle");
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Chain sync: keep the vault tracking rotated OAuth chains. Self-throttled
  // by the default wiring; errors are captured, never fatal to the tick.
  if (deps.syncChains) {
    try {
      await withTimeout(deps.syncChains(), timeouts.chainSyncMs, "syncChains");
    } catch (error) {
      errors.push(toError(error));
    }
  }

  return {
    transitions,
    observed,
    unreachableNodes: probe.unreachableNodes,
    errors,
    buzDrains,
    needsInput,
    nodeReachability,
    usage,
    autoswaps,
    autoTitles,
    durationMs: Math.max(0, deps.now() - start),
  };
}

async function guard<T>(promise: Promise<T>, errors: Error[], fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    errors.push(toError(error));
    return fallback;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

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

  // Crash adoption v1: a daemon restart reconciles any HSR bee whose meta still
  // says "running" but whose host pid is dead (the host owns the harness pipes,
  // so a dead host is an unrecoverable session). Best-effort — a bad HSR root
  // must never block startup.
  const reaped = await reapDeadHosts().catch(() => [] as string[]);
  if (reaped.length > 0) {
    await appendDaemonLog({ level: "info", msg: "hsr.reaped", bees: reaped }).catch(() => undefined);
  }

  if (options.shutdownSignal) {
    if (options.shutdownSignal.aborted) {
      requestShutdown("abort", 0);
    } else {
      options.shutdownSignal.addEventListener("abort", () => {
        requestShutdown("abort", 0);
      });
    }
  }

  // Hard self-destruct for a poisoned runtime. Everything here is
  // SYNCHRONOUS on purpose: once a libuv completion is lost, every async fs
  // op hangs forever, and process.exit() deadlocks joining the threadpool
  // (2026-07-02 incident: ~9h stuck inside process.exit called by the
  // previous watchdog). Sync fs is a direct syscall on this thread and
  // SIGKILL needs no cooperation from the wedged runtime; launchd KeepAlive
  // (SuccessfulExit=false) restarts us.
  const hardKill = (info: { stalledMs: number; reason: string }) => {
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
  };
  const onBreach = options.onWatchdogBreach ?? hardKill;
  let breachFired = false;
  const breach = (info: { stalledMs: number; reason: string }) => {
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

  // In-process watchdog: if the loop stops beating for watchdogMs — the tick
  // budget machinery itself failed, or a bookkeeping write wedged past its
  // own timeout — hard-kill so supervision restarts the daemon. A frozen
  // loop must never masquerade as a running daemon. (A synchronously-blocked
  // event loop defeats any timer, including this one — that mode is covered
  // by the out-of-process sentinel.)
  let lastLoopBeatMs = Date.now();
  const watchdog = setInterval(() => {
    const stalledMs = Date.now() - lastLoopBeatMs;
    if (stopping || stalledMs <= config.watchdogMs) return;
    breach({ stalledMs, reason: `watchdog: tick loop stalled past ${config.watchdogMs}ms` });
  }, Math.max(25, Math.min(config.tickMs, 1_000)));

  // Out-of-process sentinel: a separate process that SIGKILLs us when the
  // state.json heartbeat stalls. It is the only defense that works when this
  // process can no longer run ANY JS (sync-blocked loop, wedged exit path).
  let sentinel: ChildProcess | null = null;
  if (options.sentinel === true) {
    try {
      const cliPath = process.argv[1];
      if (!cliPath) throw new Error("cannot resolve CLI entrypoint for sentinel");
      sentinel = spawn(
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

  // Tick loop. We use an async sleep loop (not setInterval) so each tick fully
  // resolves before the next begins; this is the standard reliable-tick pattern.
  let consecutiveFailures = 0;
  let lastHealthyIterationMs = Date.now();
  try {
    while (!stopping) {
      if (config.maxTicks !== undefined && state.tickCount >= config.maxTicks) break;
      lastLoopBeatMs = Date.now();
      iterationIoFailed = false;
      // The whole tick runs under a hard budget. A tick that blows it is
      // abandoned (its late settlement is swallowed) and recorded; the loop
      // moves on to the next tick instead of wedging forever. Production
      // incident 2026-06-29: a lost libuv fs completion froze one tick — and
      // therefore the daemon — for 3+ days with recentErrors empty.
      const tickPromise = tickFn(deps, observed);
      let result: TickResult | null = null;
      let tickError: Error | null = null;
      try {
        result = await withTimeout(tickPromise, config.tickBudgetMs, "tick");
      } catch (error) {
        tickError = toError(error);
        void tickPromise.catch(() => undefined); // an abandoned tick may still reject later
      }
      lastLoopBeatMs = Date.now();
      if (result) {
        observed = result.observed;
        state.tickCount += 1;
        state.lastTickAt = new Date().toISOString();
        for (const err of result.errors) {
          pushRecentError(state, err);
          await safeLog({ level: "warn", msg: "tick.partial", error: err.message });
        }
        for (const transition of result.transitions) {
          await safeLog({
            level: "info",
            msg: "state.transition",
            session: transition.name,
            from: transition.from ?? null,
            to: transition.to,
          });
        }
        for (const outcome of result.buzDrains) {
          if (outcome.result.delivered.length > 0 || outcome.result.quarantined.length > 0 || outcome.result.errors.length > 0) {
            await safeLog({
              level: outcome.result.errors.length > 0 ? "warn" : "info",
              msg: "buz.drain",
              recipient: outcome.recipient,
              delivered: outcome.result.delivered.length,
              quarantined: outcome.result.quarantined.length,
              errors: outcome.result.errors.length,
            });
          }
        }
        for (const outcome of result.needsInput) {
          await safeLog({
            level: outcome.error ? "warn" : "info",
            msg: "needs_input.route",
            session: outcome.bee,
            requestId: outcome.requestId,
            ...(outcome.routedTo ? { routedTo: outcome.routedTo } : {}),
            ...(outcome.escalated ? { escalated: true } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        }
        for (const outcome of result.nodeReachability) {
          await safeLog({
            level: outcome.transition === "offline" ? "warn" : "info",
            msg: `node.${outcome.transition}`,
            node: outcome.node,
          });
        }
        for (const outcome of result.usage) {
          if (!outcome.exhausted) continue;
          await safeLog({
            level: "warn",
            msg: "account.exhausted",
            session: outcome.bee,
            account: outcome.account,
            resetHint: outcome.resetHint ?? null,
          });
        }
        for (const outcome of result.autoswaps) {
          await safeLog({
            level: outcome.ok ? "info" : "warn",
            msg: "account.autoswap",
            session: outcome.bee,
            from: outcome.from,
            to: outcome.to ?? null,
            ok: outcome.ok,
            ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        }
        for (const outcome of result.autoTitles) {
          await safeLog({
            level: outcome.ok ? "info" : "warn",
            msg: "title.auto",
            session: outcome.bee,
            ok: outcome.ok,
            ...(outcome.title ? { title: outcome.title } : {}),
            ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          });
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
          breach({
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
      lastLoopBeatMs = Date.now();
    }

    await appendDaemonLog({ level: "info", msg: "daemon.shutdown", reason: stopReason });
    await appendLedger({ type: "daemon.stop", pid: process.pid, reason: stopReason, stoppedAt: new Date().toISOString() }).catch(() => undefined);
    for (const error of uncaughtErrors) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      await appendDaemonLog({ level: "error", msg: "daemon.uncaught", error: message });
    }
  } finally {
    clearInterval(watchdog);
    if (sentinel) {
      try {
        sentinel.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    if (hsrControl) await hsrControl.close().catch(() => undefined);
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

function pushRecentError(state: DaemonState, error: Error): void {
  const entry: RecentError = { ts: new Date().toISOString(), msg: error.message };
  state.recentErrors.push(entry);
  const cap = maxRecentErrors();
  if (state.recentErrors.length > cap) {
    state.recentErrors.splice(0, state.recentErrors.length - cap);
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

/* ------------------------------------------------------------------ */
/* Default dependency wiring                                           */
/* ------------------------------------------------------------------ */

// Credential sync may read keychain entries and many homes — far too heavy per
// tick. Every few minutes is plenty: the sweep only has to beat the NEXT
// activation, not the next tick.
const CHAIN_SYNC_INTERVAL_MS = 5 * 60_000;

export function buildDefaultDeps(): TickDeps {
  let lastChainSyncAt = 0;
  return {
    listSessions,
    listNodes,
    probeNodes: defaultProbeNodes,
    capturePanes: defaultCapturePanes,
    livePanes: () => localSubstrate().listPanes(),
    hsrObservations: () => hsrObservations(),
    mirrorRemoteEvents: createRemoteEventMirror(),
    sealedBeeNames,
    touchSession,
    mirrorHiveState: async (record, state) => {
      const mapped = hiveStateFor(state);
      if (mapped) await writeHiveState(record, mapped);
    },
    refreshTranscriptMetadata: refreshSessionTranscriptMetadata,
    appendLedger,
    dispatchBuzDrain: (records, transitions, currentStates) => dispatchBuzDrains(records, transitions, { currentStates }),
    dispatchNeedsInput: createNeedsInputDispatcher(),
    dispatchNodeReachability: createNodeReachabilityTracker(),
    sampleUsage: createUsageSampler(),
    dispatchAutoswap: (records, usageOutcomes) => dispatchAutoswaps(records, usageOutcomes),
    dispatchAutoTitle: createAutoTitleDispatcher(),
    syncChains: async () => {
      const now = Date.now();
      if (now - lastChainSyncAt < CHAIN_SYNC_INTERVAL_MS) return;
      lastChainSyncAt = now;
      await syncAllAccountCredentialsToVault();
      // Account-bound bees may run in homes the sweep cannot find on its own
      // (arbitrary --home paths outside ~/.claude*/~/.codex*); the session
      // records know them. Provider sync still verifies the home's identity
      // before trusting its credentials.
      const accounts = new Map((await listAccounts()).map((account) => [account.id, account]));
      for (const record of await listSessions()) {
        if (!record.accountId || !record.homePath) continue;
        const account = accounts.get(record.accountId);
        if (!account) continue;
        await syncAccountCredentialsToVault(account, record.homePath, { trustExtraHome: true }).catch(() => undefined);
      }
    },
    now: () => Date.now(),
  };
}

async function defaultProbeNodes(nodes: NodeRecord[]): Promise<ProbeResult> {
  const rawTimeout = Number(process.env.HIVE_NODE_PROBE_MS ?? DEFAULT_NODE_PROBE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_NODE_PROBE_TIMEOUT_MS;
  const liveTargets = new Set<string>();
  const unreachableNodes = new Set<string>();
  const sessionStates = new Map<string, string>();
  const queries = nodes.map(async (node) => {
    try {
      const substrate = substrateForRecord(node);
      const probeResult = await withTimeout(substrate.probe(), timeoutMs);
      if (!probeResult.ok) {
        unreachableNodes.add(node.name);
        return;
      }
      const result = await withTimeout(substrate.listSessionStates(), timeoutMs);
      for (const [target, state] of result) {
        const key = liveTargetKey(node.name, target);
        liveTargets.add(key);
        sessionStates.set(key, state);
      }
    } catch {
      unreachableNodes.add(node.name);
    }
  });
  await Promise.allSettled(queries);
  return { liveTargets, unreachableNodes, sessionStates };
}

function liveHiveStateFor(record: SessionRecord, probe: ProbeResult): string | undefined {
  if (!probe.sessionStates) return undefined;
  const keyed = liveTargetKey(record.node, record.tmuxTarget);
  if (probe.sessionStates.has(keyed)) return probe.sessionStates.get(keyed);
  if (probe.sessionStates.has(record.tmuxTarget)) return probe.sessionStates.get(record.tmuxTarget);
  return undefined;
}

async function defaultCapturePanes(records: SessionRecord[], liveTargets: Set<string>): Promise<PaneCaptureMap> {
  const liveRecords = records.filter((record) => liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)));
  const entries = await Promise.all(
    liveRecords.map(async (record) => {
      // Key by the bee's own pane so sub-bees sharing one comb's tmuxTarget keep
      // distinct captures; legacy solo bees fall back to tmuxTarget. deriveState
      // reads with the same `agentPaneId ?? tmuxTarget`.
      const key = record.agentPaneId ?? record.tmuxTarget;
      try {
        const text = await substrateFor(record).capture(record.tmuxTarget, 80, record.agentPaneId);
        return [key, text] as const;
      } catch {
        return [key, undefined] as const;
      }
    }),
  );
  return new Map(entries);
}

/**
 * Reject after `ms` if the promise has not settled. The underlying operation
 * is NOT cancelled — an orphaned call may still complete (or never complete)
 * in the background; callers treat the rejection as "skip this stage".
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
