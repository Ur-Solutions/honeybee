import { readFileSync, unlinkSync } from "node:fs";
import { listAccounts, syncAllClaudeChainsToVault, syncClaudeChainToVault } from "../accounts.js";
import { acquireLongLivedLock, type LongLivedLock, LockBusyError } from "../fsx.js";
import { hiveStateFor, writeHiveState } from "../hiveState.js";
import { listNodes, type NodeRecord } from "../node.js";
import { sealedBeeNames } from "../seal.js";
import { refreshSessionTranscriptMetadata } from "../sessionMetadata.js";
import { deriveState, liveTargetKey, type BeeState, type StateContext } from "../state.js";
import { appendLedger, listSessions, type SessionRecord, touchSession } from "../store.js";
import { localSubstrate, substrateFor, substrateForRecord } from "../substrates/index.js";
import { createAutoTitleDispatcher, type AutoTitleOutcome } from "./autoTitle.js";
import { dispatchAutoswaps, type AutoswapOutcome } from "./autoswap.js";
import { dispatchBuzDrains, type BuzDispatchOutcome } from "./buzDispatcher.js";
import { createUsageSampler, type UsageSampler, type UsageTickOutcome } from "./usageSampler.js";
import { appendDaemonLog } from "./log.js";
import {
  DAEMON_VERSION,
  daemonLockPath,
  defaultDaemonConfig,
  maxRecentErrors,
  writeDaemonState,
  type DaemonConfig,
  type DaemonState,
  type RecentError,
} from "./index.js";

const DEFAULT_NODE_PROBE_TIMEOUT_MS = 2_500;

export type ProbeResult = {
  liveTargets: Set<string>;
  unreachableNodes: Set<string>;
};

export type TickDeps = {
  listSessions: () => Promise<SessionRecord[]>;
  listNodes: () => Promise<NodeRecord[]>;
  /** Live target enumeration + node reachability — substrate-routable. */
  probeNodes: (nodes: NodeRecord[]) => Promise<ProbeResult>;
  /** Captures panes for the subset of live records. */
  capturePanes: (records: SessionRecord[], liveTargets: Set<string>) => Promise<Map<string, string>>;
  /** Live pane ids on the local server, for pane-pinned liveness (problem c). */
  livePanes?: () => Promise<Set<string>>;
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
   * Optional credential-chain sync: pulls rotated claude OAuth chains from
   * the accounts' homes back into the vault (refresh tokens rotate; the live
   * link lands wherever the last refresh ran). The default wiring throttles
   * itself — most ticks are a no-op.
   */
  syncChains?: () => Promise<void>;
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

  const records: SessionRecord[] = await guard(deps.listSessions(), errors, []);
  const nodes: NodeRecord[] = await guard(deps.listNodes(), errors, []);
  const probe: ProbeResult = await guard(
    deps.probeNodes(nodes),
    errors,
    { liveTargets: new Set<string>(), unreachableNodes: new Set<string>() },
  );
  const panes: Map<string, string> = await guard(deps.capturePanes(records, probe.liveTargets), errors, new Map());
  const seals: Set<string> = await guard(deps.sealedBeeNames(), errors, new Set());
  const livePanes: Set<string> = deps.livePanes ? await guard(deps.livePanes(), errors, new Set<string>()) : new Set<string>();

  const nowMs = deps.now();
  const context: StateContext = {
    liveTargets: probe.liveTargets,
    livePanes,
    panes,
    seals,
    unreachableNodes: probe.unreachableNodes,
    now: nowMs,
  };

  const observed = new Map<string, BeeState>();
  const transitions: TickTransition[] = [];
  const observedAtIso = new Date(nowMs).toISOString();

  for (const record of records) {
    const derived = deriveState(record, context);
    observed.set(record.name, derived.state);
    const prev = previousObserved.get(record.name);
    if (prev !== derived.state) {
      transitions.push({ name: record.name, from: prev, to: derived.state });
      if (deps.mirrorHiveState) {
        try {
          await deps.mirrorHiveState(record, derived.state);
        } catch (error) {
          errors.push(toError(error));
        }
      }
    }

    // Persist the latest observed state. Errors are captured but do not abort the loop.
    try {
      await deps.touchSession(record.name, {
        lastObservedState: derived.state,
        lastObservedStateAt: observedAtIso,
      });
    } catch (error) {
      errors.push(toError(error));
    }

    // Dead/sealed bees no longer produce transcript updates — skip the
    // refresh once transcript metadata has been captured. A bee that exited
    // before its first refresh (fast finish between ticks) still gets one
    // pass so list/search/tail metadata is not permanently missing.
    const terminal = derived.state === "dead" || derived.state === "sealed";
    if (!terminal || !record.transcriptPath) {
      try {
        await deps.refreshTranscriptMetadata?.(record);
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
      await deps.appendLedger({
        type: "state.transition",
        session: transition.name,
        from: transition.from,
        to: transition.to,
        ts: observedAtIso,
      });
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
      buzDrains = await deps.dispatchBuzDrain(records, transitions, observed);
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Usage sampler: factual per-account token samples + exhaustion events.
  let usage: UsageTickOutcome[] = [];
  if (deps.sampleUsage) {
    try {
      usage = await deps.sampleUsage(records, panes, nowMs);
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Autoswap: opt-in deterministic reaction to this tick's exhaustion edges.
  let autoswaps: AutoswapOutcome[] = [];
  if (deps.dispatchAutoswap && usage.some((outcome) => outcome.exhausted)) {
    try {
      autoswaps = await deps.dispatchAutoswap(records, usage);
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Auto-titler: kick off (or collect) background title generation for
  // untitled bees whose initial exchange is now visible.
  let autoTitles: AutoTitleOutcome[] = [];
  if (deps.dispatchAutoTitle) {
    try {
      autoTitles = await deps.dispatchAutoTitle(records);
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Chain sync: keep the vault tracking rotated OAuth chains. Self-throttled
  // by the default wiring; errors are captured, never fatal to the tick.
  if (deps.syncChains) {
    try {
      await deps.syncChains();
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
  let activeTick: Promise<void> | null = null;

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

  if (options.shutdownSignal) {
    if (options.shutdownSignal.aborted) {
      requestShutdown("abort", 0);
    } else {
      options.shutdownSignal.addEventListener("abort", () => {
        requestShutdown("abort", 0);
      });
    }
  }

  // Tick loop. We use an async sleep loop (not setInterval) so each tick fully
  // resolves before the next begins; this is the standard reliable-tick pattern.
  try {
    while (!stopping) {
      if (config.maxTicks !== undefined && state.tickCount >= config.maxTicks) break;
      const tickPromise = (async () => {
        let result: TickResult | null = null;
        try {
          result = await tickFn(deps, observed);
        } catch (error) {
          const err = toError(error);
          await appendDaemonLog({ level: "error", msg: "tick.error", error: err.message });
          pushRecentError(state, err);
          return;
        }
        observed = result.observed;
        state.tickCount += 1;
        state.lastTickAt = new Date().toISOString();
        for (const err of result.errors) {
          pushRecentError(state, err);
          await appendDaemonLog({ level: "warn", msg: "tick.partial", error: err.message });
        }
        for (const transition of result.transitions) {
          await appendDaemonLog({
            level: "info",
            msg: "state.transition",
            session: transition.name,
            from: transition.from ?? null,
            to: transition.to,
          });
        }
        for (const outcome of result.buzDrains) {
          if (outcome.result.delivered.length > 0 || outcome.result.quarantined.length > 0 || outcome.result.errors.length > 0) {
            await appendDaemonLog({
              level: outcome.result.errors.length > 0 ? "warn" : "info",
              msg: "buz.drain",
              recipient: outcome.recipient,
              delivered: outcome.result.delivered.length,
              quarantined: outcome.result.quarantined.length,
              errors: outcome.result.errors.length,
            });
          }
        }
        for (const outcome of result.usage) {
          if (!outcome.exhausted) continue;
          await appendDaemonLog({
            level: "warn",
            msg: "account.exhausted",
            session: outcome.bee,
            account: outcome.account,
            resetHint: outcome.resetHint ?? null,
          });
        }
        for (const outcome of result.autoswaps) {
          await appendDaemonLog({
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
          await appendDaemonLog({
            level: outcome.ok ? "info" : "warn",
            msg: "title.auto",
            session: outcome.bee,
            ok: outcome.ok,
            ...(outcome.title ? { title: outcome.title } : {}),
            ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        }
        try {
          await writeDaemonState({ ...state, recentErrors: [...state.recentErrors] });
        } catch (error) {
          const err = toError(error);
          await appendDaemonLog({ level: "warn", msg: "state.write.failed", error: err.message });
        }
      })();
      activeTick = tickPromise;
      await tickPromise;
      activeTick = null;
      if (stopping) break;
      if (config.maxTicks !== undefined && state.tickCount >= config.maxTicks) break;
      await sleep(config.tickMs, () => stopping);
    }

    // Clean shutdown path. Any in-flight tick is already complete because
    // requestShutdown only flips `stopping` — it never interrupts an awaited tick.
    if (activeTick) {
      try {
        await activeTick;
      } catch {
        // tick errors already logged
      }
    }
    await appendDaemonLog({ level: "info", msg: "daemon.shutdown", reason: stopReason });
    await appendLedger({ type: "daemon.stop", pid: process.pid, reason: stopReason, stoppedAt: new Date().toISOString() }).catch(() => undefined);
    for (const error of uncaughtErrors) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      await appendDaemonLog({ level: "error", msg: "daemon.uncaught", error: message });
    }
  } finally {
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

// Chain sync reads every claude home's keychain (a `security` subprocess per
// home) — far too heavy per tick. Every few minutes is plenty: the sweep only
// has to beat the NEXT activation, not the next tick.
const CHAIN_SYNC_INTERVAL_MS = 5 * 60_000;

export function buildDefaultDeps(): TickDeps {
  let lastChainSyncAt = 0;
  return {
    listSessions,
    listNodes,
    probeNodes: defaultProbeNodes,
    capturePanes: defaultCapturePanes,
    livePanes: () => localSubstrate().listPanes(),
    sealedBeeNames,
    touchSession,
    mirrorHiveState: async (record, state) => {
      const mapped = hiveStateFor(state);
      if (mapped) await writeHiveState(record, mapped);
    },
    refreshTranscriptMetadata: refreshSessionTranscriptMetadata,
    appendLedger,
    dispatchBuzDrain: (records, transitions, currentStates) => dispatchBuzDrains(records, transitions, { currentStates }),
    sampleUsage: createUsageSampler(),
    dispatchAutoswap: (records, usageOutcomes) => dispatchAutoswaps(records, usageOutcomes),
    dispatchAutoTitle: createAutoTitleDispatcher(),
    syncChains: async () => {
      const now = Date.now();
      if (now - lastChainSyncAt < CHAIN_SYNC_INTERVAL_MS) return;
      lastChainSyncAt = now;
      await syncAllClaudeChainsToVault();
      // Account-bound bees may run in homes the sweep cannot find on its own
      // (arbitrary --home paths outside ~/.claude*); the session records know
      // them. syncClaudeChainToVault still verifies the home's login email
      // before trusting its chain.
      const accounts = new Map((await listAccounts()).map((account) => [account.id, account]));
      for (const record of await listSessions()) {
        if (!record.accountId || !record.homePath) continue;
        const account = accounts.get(record.accountId);
        if (account?.tool !== "claude") continue;
        await syncClaudeChainToVault(account, record.homePath).catch(() => undefined);
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
  const queries = nodes.map(async (node) => {
    try {
      const substrate = substrateForRecord(node);
      const probeResult = await withTimeout(substrate.probe(), timeoutMs);
      if (!probeResult.ok) {
        unreachableNodes.add(node.name);
        return;
      }
      const result = await withTimeout(substrate.listSessions(), timeoutMs);
      for (const target of result) liveTargets.add(liveTargetKey(node.name, target));
    } catch {
      unreachableNodes.add(node.name);
    }
  });
  await Promise.allSettled(queries);
  return { liveTargets, unreachableNodes };
}

async function defaultCapturePanes(records: SessionRecord[], liveTargets: Set<string>): Promise<Map<string, string>> {
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
        return [key, ""] as const;
      }
    }),
  );
  return new Map(entries);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out after ${ms}ms`));
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
