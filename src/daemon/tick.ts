import { hiveStateFor } from "../hiveState.js";
import type { NodeRecord } from "../node.js";
import type { HsrObservation } from "../hsr/observe.js";
import { deriveState, isTerminalState, liveTargetKey, type BeeState, type PaneCaptureMap, type StateContext } from "../state.js";
import type { SessionRecord } from "../store.js";
import type { AutoTitleOutcome } from "./autoTitle.js";
import type { AutoswapOutcome } from "./autoswap.js";
import type { BuzDispatchOutcome } from "./buzDispatcher.js";
import type { NeedsInputOutcome } from "./needsInput.js";
import type { NodeReachabilityDispatcher, NodeReachabilityOutcome } from "./nodeReachability.js";
import type { TokenRefreshOutcome } from "./tokenRefresh.js";
import type { PoolSweeper, PoolSweepOutcome } from "./poolSweep.js";
import type { FlightSweeper } from "./flightSweep.js";
import type { FlightSweepOutcome } from "../flight/controller.js";
import type { UsageSampler, UsageTickOutcome } from "./usageSampler.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";
import type { LogInput } from "./log.js";
import { defaultTickTimeouts, guard, toError, withTimeout, type TickTimeouts } from "./timeouts.js";

const DEFAULT_RECORD_CONCURRENCY = 8;

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
   * exactly like tmux bees. Absent → no HSR bees observed this tick. The default
   * wiring runs the sweep in a disposable child process (observerProcess.ts) so
   * a wedged fs call can never poison the daemon's own threadpool; `close`
   * tears the child down at shutdown.
   */
  hsrObservations?: ((beeNames: readonly string[]) => Promise<Map<string, HsrObservation>>) & { close?: () => Promise<void> };
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
  mirrorRemoteEvents?: ((records: SessionRecord[]) => Promise<void>) & { close?: () => Promise<void> };
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
  dispatchNeedsInput?: (
    records: SessionRecord[],
    currentStates: Map<string, BeeState>,
    hsrObservations?: ReadonlyMap<string, HsrObservation>,
  ) => Promise<NeedsInputOutcome[]>;
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
   * Optional remote codex token refresher (UNIT 2): for each LIVE remote
   * ephemeral-token codex bee, proactively re-delivers a fresh access token
   * before its `remoteTokenExpiresAt` lapses, and reactively re-delivers on a
   * mirrored `auth_expired` event. Mints centrally (the daemon has the vault) and
   * restarts the remote runner with resume. Stateful across ticks (in-flight
   * guard + cooldown + handled-expiry cursor) — build once per daemon run.
   */
  refreshRemoteTokens?: (
    records: SessionRecord[],
    hsrObs: ReadonlyMap<string, HsrObservation>,
    nowMs: number,
  ) => Promise<TokenRefreshOutcome[]>;
  /**
   * Optional checkout-pool sweep (CHECKOUT_POOLS_PRD §6.6): claim GC,
   * refresh-on-vacate, dirty/parked flags, minFree pre-extend. Stateful across
   * ticks (vacate-edge detection, flag de-dupe, background extends) and
   * self-throttled — build once per daemon run.
   */
  sweepPools?: PoolSweeper;
  /**
   * Optional flight reconciler (CL.701 §4.2): drives slot leases from this
   * tick's records + observed states — contract-matched seal completion,
   * readiness/first-evidence/stall deadlines, idempotent replacement under
   * backpressure. Build once per daemon run (createFlightSweeper).
   */
  sweepFlights?: FlightSweeper;
  /**
   * Optional credential sync: pulls rotated/refreshed auth from the accounts'
   * homes back into the vault. The default wiring throttles itself — most
   * runs are a no-op. NOT called by tick(): runDaemon drives it on its own
   * track so a keychain prompt or a sweep over hundreds of homes can never
   * starve the observation loop (the recurring listSessions-timeout breach
   * cycle traced back to heavy fs work sharing the tick's sequential path).
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

/**
 * Per-stage outcome arrays produced by the dispatcher registry below. Each key
 * is one registry stage; a stage that was not wired (or whose trigger condition
 * did not fire) keeps its empty array.
 */
export type DispatcherOutcomes = {
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
  /** Remote codex token-refresh outcomes (empty when nothing near-expiry / not wired). */
  tokenRefreshes: TokenRefreshOutcome[];
  /** Checkout-pool sweep outcomes (empty on throttled/no-op sweeps / not wired). */
  poolSweeps: PoolSweepOutcome[];
  /** Flight reconciler outcomes (empty when no active flights / not wired). */
  flightSweeps: FlightSweepOutcome[];
};

export type TickResult = DispatcherOutcomes & {
  transitions: TickTransition[];
  observed: Map<string, BeeState>;
  unreachableNodes: Set<string>;
  errors: Error[];
  durationMs: number;
  /**
   * Wall-clock milliseconds spent per tick stage (fs reads, probes, the
   * per-record loop, each dispatcher). Persisted into DaemonState as
   * lastTickStageMs so `hive daemon status --json` makes a slow stage
   * diagnosable from the status output alone — the listSessions-timeout
   * incident was only attributable after ad-hoc log archaeology.
   */
  stageMs: Record<string, number>;
  /**
   * Dispatcher stages bounded by budget policy this tick (per-stage cap or
   * the shared pool: timed out or skipped dry). EXPECTED degradation, not
   * failure — kept out of errors[] so routine cap enforcement can never
   * saturate recentErrors and flip status to UNHEALTHY (2026-07-21 canary
   * round 5). Logged as one `tick.truncated` row.
   */
  truncated: string[];
};

/** Everything a tick has observed by the time the dispatcher stages run. */
export type DispatchContext = {
  deps: TickDeps;
  records: SessionRecord[];
  nodes: NodeRecord[];
  probe: ProbeResult;
  panes: PaneCaptureMap;
  hsrObs: Map<string, HsrObservation>;
  transitions: TickTransition[];
  /** This tick's freshly derived state per bee (authoritative current state). */
  observed: Map<string, BeeState>;
  /**
   * True on the daemon's first tick after boot (no tick has completed yet).
   * Cold-cache periodic samplers marked skipFirstTick sit this one out so the
   * boot tick proves the loop healthy in seconds, not minutes.
   */
  firstTick: boolean;
  /**
   * False when listSessions failed and the records snapshot is the guard's
   * empty fallback. Stages whose ACTIONS treat record-absence as meaningful
   * (the flight reconciler) must not run on an untrusted snapshot.
   */
  sessionsSnapshotTrusted: boolean;
  nowMs: number;
  /**
   * Outcomes of the stages that already ran this tick, in registry order —
   * later stages may consume earlier stages' outcomes (autoswap reads usage).
   */
  outcomes: DispatcherOutcomes;
};

/**
 * One outcome-producing dispatcher stage. tick() iterates the registry to run
 * the stages (each under its own budget, errors captured, never fatal) and
 * logTickResult() iterates the SAME registry to log the outcomes — adding a
 * periodic task is one TickDeps hook plus one registry entry.
 *
 * `run`/`log` use method syntax deliberately: its bivariant parameter check is
 * what lets the per-key entries form the AnyTickDispatcher union.
 */
export type TickDispatcher<K extends keyof DispatcherOutcomes> = {
  /** DispatcherOutcomes/TickResult field the stage's outcomes land in. */
  key: K;
  /** withTimeout label, surfaced in timeout errors. */
  name: string;
  /** Which TickTimeouts budget bounds the stage. */
  timeoutKey: keyof TickTimeouts;
  /**
   * Periodic samplers with cold-cache first runs (usage sampler ~60s, auto
   * titler ~22s on a large fleet) skip the daemon's FIRST tick entirely: the
   * boot tick's one job is proving the loop healthy before the watchdogs and
   * before deferred boot work (crash-adoption reap) starts competing.
   */
  skipFirstTick?: boolean;
  /**
   * Hard per-stage cap BELOW the shared pool, for best-effort stages that
   * would otherwise drain it (2026-07-21 canary round 4: sampleUsage consumed
   * 59.8s of the 60s pool and starved every stage behind it). Effective
   * timeout = min(timeoutKey budget, capMs, remaining pool).
   */
  capMs?: number;
  /**
   * Start the stage. Return undefined to skip it — dep not wired, or the
   * stage's trigger condition not met — leaving its outcomes empty.
   */
  run(ctx: DispatchContext): Promise<DispatcherOutcomes[K]> | undefined;
  /** Map one outcome to a daemon-log entry; null = this outcome is not logged. */
  log(outcome: DispatcherOutcomes[K][number]): LogInput | null;
};

type AnyTickDispatcher = { [K in keyof DispatcherOutcomes]: TickDispatcher<K> }[keyof DispatcherOutcomes];

/**
 * The dispatcher registry: state-derived work that runs at the end of every
 * tick, strictly in this order. SAFETY-CRITICAL, cheap stages come FIRST
 * (buz drain, needs-input routing, node edges, the detached flight starter,
 * token refresh) and best-effort samplers LAST (usage, auto-title, pool
 * sweep) — under the shared dispatch pool, order is priority: a slow sampler
 * must starve itself, never the flight reconciler (2026-07-21 canary round
 * 4). Autoswap consumes the usage stage's outcomes and must follow it.
 * Void periodic tasks with positional constraints (mirrorRemoteEvents) stay
 * inline in tick() — they produce no outcomes to log. syncChains runs on its
 * own track in runDaemon, outside the tick path entirely.
 */
export const tickDispatchers: readonly AnyTickDispatcher[] = [
  // The buz queue dispatcher drains tier-B messages for any bee that
  // transitioned into idle_with_output.
  {
    key: "buzDrains",
    name: "dispatchBuzDrain",
    timeoutKey: "dispatchMs",
    run: ({ deps, records, transitions, observed }) => deps.dispatchBuzDrain?.(records, transitions, observed),
    log: (outcome) =>
      outcome.result.delivered.length > 0 || outcome.result.quarantined.length > 0 || outcome.result.errors.length > 0
        ? {
            level: outcome.result.errors.length > 0 ? "warn" : "info",
            msg: "buz.drain",
            recipient: outcome.recipient,
            delivered: outcome.result.delivered.length,
            quarantined: outcome.result.quarantined.length,
            errors: outcome.result.errors.length,
          }
        : null,
  },
  // HSR needs-input router: route each blocked HSR bee's structured request to
  // its living parent (buz) or mark it escalated.
  {
    key: "needsInput",
    name: "dispatchNeedsInput",
    timeoutKey: "dispatchMs",
    run: ({ deps, records, observed, hsrObs }) => deps.dispatchNeedsInput?.(records, observed, hsrObs),
    log: (outcome) => ({
      level: outcome.error ? "warn" : "info",
      msg: "needs_input.route",
      session: outcome.bee,
      requestId: outcome.requestId,
      ...(outcome.routedTo ? { routedTo: outcome.routedTo } : {}),
      ...(outcome.escalated ? { escalated: true } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }),
  },
  // Node reachability edge tracker (APIA-96): emit node.online/node.offline on
  // the reachability edge only, keyed off the node-probe's unreachableNodes.
  {
    key: "nodeReachability",
    name: "dispatchNodeReachability",
    timeoutKey: "dispatchMs",
    run: ({ deps, nodes, probe, nowMs }) => deps.dispatchNodeReachability?.(nodes, probe.unreachableNodes, nowMs),
    log: (outcome) => ({
      level: outcome.transition === "offline" ? "warn" : "info",
      msg: `node.${outcome.transition}`,
      node: outcome.node,
    }),
  },
  // Flight reconciler (CL.701): drive slot leases from this tick's evidence —
  // seal completion, deadlines, idempotent replacement under backpressure.
  {
    key: "flightSweeps",
    name: "sweepFlights",
    timeoutKey: "dispatchMs",
    // NEVER against an untrusted snapshot: absence must not read as death.
    run: ({ deps, records, observed, sessionsSnapshotTrusted }) =>
      sessionsSnapshotTrusted ? deps.sweepFlights?.(records, observed) : undefined,
    log: (outcome) => ({
      level: outcome.action === "error" ? "warn" : "info",
      msg: `flight.${outcome.action}`,
      flight: outcome.flight,
      ...(outcome.slot ? { slot: outcome.slot } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }),
  },
  // Remote codex token refresher (UNIT 2): proactively re-deliver a fresh access
  // token before expiry, and reactively on a mirrored auth_expired event.
  {
    key: "tokenRefreshes",
    name: "refreshRemoteTokens",
    timeoutKey: "dispatchMs",
    run: ({ deps, records, hsrObs, nowMs }) => deps.refreshRemoteTokens?.(records, hsrObs, nowMs),
    // A pure skip (in-flight / cooldown / not-eligible) is not a refresh — don't log it.
    log: (outcome) =>
      outcome.skipped
        ? null
        : {
            level: outcome.ok ? "info" : "warn",
            msg: "token.refresh",
            session: outcome.bee,
            ...(outcome.account ? { account: outcome.account } : {}),
            ...(outcome.trigger ? { trigger: outcome.trigger } : {}),
            ok: outcome.ok,
            ...(outcome.expiresAt ? { expiresAt: new Date(outcome.expiresAt * 1000).toISOString() } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          },
  },
  // Usage sampler: factual per-account token samples + exhaustion events.
  {
    key: "usage",
    name: "sampleUsage",
    skipFirstTick: true,
    // Best-effort: half the shared pool at most, so a slow sampler can never
    // starve the stages behind it (it retries with warm caches next tick).
    capMs: 20_000,
    timeoutKey: "dispatchMs",
    run: ({ deps, records, panes, nowMs, hsrObs }) => deps.sampleUsage?.(records, panes, nowMs, hsrObs),
    log: (outcome) =>
      outcome.exhausted
        ? {
            level: "warn",
            msg: "account.exhausted",
            session: outcome.bee,
            account: outcome.account,
            resetHint: outcome.resetHint ?? null,
          }
        : null,
  },
  // Autoswap: opt-in deterministic reaction to this tick's exhaustion edges.
  {
    key: "autoswaps",
    name: "dispatchAutoswap",
    timeoutKey: "dispatchMs",
    run: ({ deps, records, outcomes }) =>
      deps.dispatchAutoswap && outcomes.usage.some((outcome) => outcome.exhausted)
        ? deps.dispatchAutoswap(records, outcomes.usage)
        : undefined,
    log: (outcome) => ({
      level: outcome.ok ? "info" : "warn",
      msg: "account.autoswap",
      session: outcome.bee,
      from: outcome.from,
      to: outcome.to ?? null,
      ok: outcome.ok,
      ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }),
  },
  // Auto-titler: kick off (or collect) background title generation for
  // untitled bees whose initial exchange is now visible.
  {
    key: "autoTitles",
    name: "dispatchAutoTitle",
    skipFirstTick: true,
    capMs: 15_000,
    timeoutKey: "dispatchMs",
    run: ({ deps, records }) => deps.dispatchAutoTitle?.(records),
    log: (outcome) => ({
      level: outcome.ok ? "info" : "warn",
      msg: "title.auto",
      session: outcome.bee,
      ok: outcome.ok,
      ...(outcome.title ? { title: outcome.title } : {}),
      ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }),
  },
  // Checkout-pool sweep (§6.6): claim GC, refresh-on-vacate, flags, minFree
  // pre-extend. Self-throttled inside the sweeper — most ticks return [].
  {
    key: "poolSweeps",
    name: "sweepPools",
    skipFirstTick: true,
    timeoutKey: "dispatchMs",
    run: ({ deps, records, observed }) => deps.sweepPools?.(records, observed),
    log: (outcome) => ({
      level: outcome.error || outcome.flagged || outcome.warned ? "warn" : "info",
      msg: "pool.sweep",
      pool: outcome.pool,
      ...(outcome.gcExpired !== undefined ? { gcExpired: outcome.gcExpired } : {}),
      ...(outcome.synced ? { synced: outcome.synced.map((row) => `${row.member}:${row.status}`).join(",") } : {}),
      ...(outcome.flagged ? { flagged: outcome.flagged.map((f) => `${f.member}:${f.reason}${f.nudged ? `→${f.nudged}` : ""}`).join(",") } : {}),
      ...(outcome.extendStarted !== undefined ? { extendStarted: outcome.extendStarted } : {}),
      ...(outcome.extended !== undefined ? { extended: outcome.extended } : {}),
      ...(outcome.warned ? { warned: outcome.warned } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }),
  },
];

export function emptyDispatcherOutcomes(): DispatcherOutcomes {
  return { buzDrains: [], needsInput: [], nodeReachability: [], usage: [], autoswaps: [], autoTitles: [], tokenRefreshes: [], flightSweeps: [], poolSweeps: [] };
}

/**
 * Run one registry stage under its budget, landing its outcomes in
 * ctx.outcomes[key]. Errors (including timeouts) are captured into errors[]
 * and the stage's outcomes stay empty — never fatal to the tick. Generic so
 * the key/outcome-array pairing stays correlated per stage.
 */
async function runTickDispatcher<K extends keyof DispatcherOutcomes>(
  dispatcher: TickDispatcher<K>,
  ctx: DispatchContext,
  timeouts: TickTimeouts,
  errors: Error[],
  stageMs: Record<string, number>,
  truncated: string[],
  /** Remaining shared dispatcher pool (ms); the effective timeout is the min. */
  remainingMs: number,
): Promise<void> {
  if (dispatcher.skipFirstTick && ctx.firstTick) return;
  const pending = dispatcher.run(ctx);
  if (!pending) return;
  const start = ctx.deps.now();
  const budgetMs = Math.max(1, Math.min(timeouts[dispatcher.timeoutKey], dispatcher.capMs ?? Number.POSITIVE_INFINITY, remainingMs));
  try {
    ctx.outcomes[dispatcher.key] = await withTimeout(pending, budgetMs, dispatcher.name);
  } catch (error) {
    // A budget timeout is POLICY (bounded best-effort; the stage retries next
    // tick) — record it as truncation, not as an error: routine enforcement
    // must never saturate recentErrors into a false UNHEALTHY. Anything else
    // a stage throws is a real failure.
    const err = toError(error);
    if (new RegExp(`^${dispatcher.name} timed out after `).test(err.message)) {
      truncated.push(`${dispatcher.name}@${budgetMs}ms`);
    } else {
      errors.push(err);
    }
  } finally {
    stageMs[dispatcher.name] = Math.max(0, ctx.deps.now() - start);
  }
}

/** Log entries for one stage's outcomes (registry order), skipping nulls. */
function dispatcherLogEntries<K extends keyof DispatcherOutcomes>(
  dispatcher: TickDispatcher<K>,
  outcomes: DispatcherOutcomes,
): LogInput[] {
  const entries: LogInput[] = [];
  for (const outcome of outcomes[dispatcher.key]) {
    const entry = dispatcher.log(outcome);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Flatten a completed tick's result into the daemon-log entries runDaemon
 * emits for it, in a fixed order: partial-tick errors, then state transitions,
 * then each dispatcher stage's outcomes (registry order). runDaemon owns the
 * DaemonState mutations (tickCount, recentErrors) and the actual writes; this
 * only decides WHAT to log so the fan-out stays out of the loop body.
 */
export function logTickResult(result: TickResult): LogInput[] {
  const entries: LogInput[] = [];
  for (const err of result.errors) {
    entries.push({ level: "warn", msg: "tick.partial", error: err.message });
  }
  if (result.truncated.length > 0) {
    entries.push({ level: "info", msg: "tick.truncated", stages: result.truncated.join(",") });
  }
  for (const transition of result.transitions) {
    // First observations (daemon restart: EVERY session "transitions" from
    // undefined) are not events — on a large registry they flooded the log
    // with hundreds of `from:null → archived` rows written sequentially
    // inside the loop body (2026-07-21 canary). Same rule as the ledger.
    if (transition.from === undefined) continue;
    entries.push({
      level: "info",
      msg: "state.transition",
      session: transition.name,
      from: transition.from,
      to: transition.to,
    });
  }
  for (const dispatcher of tickDispatchers) {
    for (const entry of dispatcherLogEntries(dispatcher, result)) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Pure tick. Performs the per-tick observation cycle using only the injected
 * deps. Returns the transitions detected since the previous observed map and
 * the new observed map for the next tick. No timers, signals, PID, or log
 * writes happen here — those are owned by runDaemon().
 */
export async function tick(
  deps: TickDeps,
  previousObserved: Map<string, BeeState>,
  options: { firstTick?: boolean } = {},
): Promise<TickResult> {
  const start = deps.now();
  const errors: Error[] = [];
  const timeouts: TickTimeouts = { ...defaultTickTimeouts(), ...(deps.timeouts ?? {}) };
  const stageMs: Record<string, number> = {};
  const truncated: string[] = [];
  const timeStage = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const stageStart = deps.now();
    try {
      return await run();
    } finally {
      stageMs[name] = Math.max(0, deps.now() - stageStart);
    }
  };

  const errorsBeforeListSessions = errors.length;
  const records: SessionRecord[] = await timeStage("listSessions", () =>
    guard(withTimeout(deps.listSessions(), timeouts.fsMs, "listSessions"), errors, []));
  // A failed listSessions yields an EMPTY snapshot via the guard — usable for
  // passive observation (held states), but NEVER as evidence of absence: the
  // flight reconciler must not run against it (2026-07-21 incident: an fs
  // storm's empty snapshot crash-vacated ten working slots at once).
  const sessionsSnapshotTrusted = errors.length === errorsBeforeListSessions;
  const nodes: NodeRecord[] = await timeStage("listNodes", () =>
    guard(withTimeout(deps.listNodes(), timeouts.fsMs, "listNodes"), errors, []));
  const probe: ProbeResult = await timeStage("probeNodes", () =>
    guard(
      withTimeout(deps.probeNodes(nodes), timeouts.substrateMs, "probeNodes"),
      errors,
      { liveTargets: new Set<string>(), unreachableNodes: new Set<string>() },
    ));
  const panes: PaneCaptureMap = await timeStage("capturePanes", () =>
    guard(
      withTimeout(deps.capturePanes(records, probe.liveTargets), timeouts.substrateMs, "capturePanes"),
      errors,
      new Map(),
    ));
  const seals: Set<string> = await timeStage("sealedBeeNames", () =>
    guard(withTimeout(deps.sealedBeeNames(), timeouts.fsMs, "sealedBeeNames"), errors, new Set()));
  const livePanes: Set<string> = deps.livePanes
    ? await timeStage("livePanes", () =>
        guard(withTimeout(deps.livePanes!(), timeouts.substrateMs, "livePanes"), errors, new Set<string>()))
    : new Set<string>();

  // Remote-event mirror (APIA-94): refresh subscriptions + replay remote-hsr
  // events into local run dirs BEFORE we read them below. Same per-call budget +
  // guard as the other dispatchers; errors are captured, never fatal.
  if (deps.mirrorRemoteEvents) {
    try {
      await timeStage("mirrorRemoteEvents", () => withTimeout(deps.mirrorRemoteEvents!(records), timeouts.dispatchMs, "mirrorRemoteEvents"));
    } catch (error) {
      errors.push(toError(error));
    }
  }

  // Observe only RUNNING records whose substrate is local HSR or whose node is
  // remote-hsr. The observer used to enumerate every historical run dir on
  // every tick (hundreds in a busy hive), including exited bees whose events
  // can no longer affect state.
  const remoteHsrNodes = new Set(nodes.filter((node) => node.kind === "remote-hsr").map((node) => node.name));
  const hsrBeeNames = records
    .filter((record) => record.status === "running" && record.lastObservedState !== "sealed" && !seals.has(record.name) && (
      record.substrate === "hsr" || (record.node !== undefined && remoteHsrNodes.has(record.node))
    ))
    .map((record) => record.name);

  // A failed observation batch is UNKNOWN, not an authoritative empty result.
  // Keep the last trustworthy state for its records and do not persist/mirror a
  // fabricated terminal state. This is deliberately separate from a successful
  // empty map, which really does mean the requested run dirs are gone.
  let hsrObs = new Map<string, HsrObservation>();
  const hsrUnavailable = new Set<string>();
  if (hsrBeeNames.length > 0) {
    if (deps.hsrObservations) {
      try {
        hsrObs = await timeStage("hsrObservations", () =>
          withTimeout(deps.hsrObservations!(hsrBeeNames), timeouts.substrateMs, "hsrObservations"));
      } catch (error) {
        errors.push(toError(error));
        for (const bee of hsrBeeNames) hsrUnavailable.add(bee);
      }
    } else {
      for (const bee of hsrBeeNames) hsrUnavailable.add(bee);
    }
  }
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
    hsrUnavailable,
    now: nowMs,
  };

  const observed = new Map<string, BeeState>();
  const transitions: TickTransition[] = [];
  const observedAtIso = new Date(nowMs).toISOString();
  const recordPlans = records.map((record) => {
    const derived = deriveState(record, context);
    observed.set(record.name, derived.state);
    const prev = previousObserved.get(record.name);
    const mappedHiveState = hiveStateFor(derived.state);
    const liveHiveState = liveHiveStateFor(record, probe);
    const staleHiveState = mappedHiveState !== undefined && liveHiveState !== undefined && liveHiveState !== mappedHiveState;
    const uncertainBooting = derived.state === "booting" && liveHiveState !== undefined && liveHiveState.length > 0;
    const observationUnavailable = hsrUnavailable.has(record.name);
    // A seal or offline node is independently trustworthy even when the local
    // HSR run-dir batch failed. Every other HSR state is held, not republished.
    const observationTrusted = !observationUnavailable || derived.state === "sealed" || derived.state === "node_unreachable";
    const transitioned = observationTrusted && prev !== derived.state;
    if (transitioned) {
      transitions.push({ name: record.name, from: prev, to: derived.state });
    }
    const terminal = isTerminalState(derived.state);
    const archived = derived.state === "archived";
    // A seal is already a durable task artifact: it does not justify one last
    // provider-wide transcript scan. Other fast terminal exits get one claimed
    // best-effort pass in case they died between spawn and the first tick.
    const claimTerminalTranscriptDiscovery = terminal && derived.state !== "sealed" &&
      !record.transcriptPath && !record.terminalTranscriptDiscoveryAt;
    return {
      record,
      state: derived.state,
      persistObservation: observationTrusted,
      mirrorHiveState: observationTrusted && (transitioned || staleHiveState) && !uncertainBooting,
      refreshTranscriptMetadata:
        observationTrusted && !archived && (!terminal || claimTerminalTranscriptDiscovery) && deps.refreshTranscriptMetadata !== undefined,
      claimTerminalTranscriptDiscovery,
    };
  });

  await timeStage("records", () => mapWithConcurrency(
    recordPlans,
    envConcurrency("HIVE_DAEMON_RECORD_CONCURRENCY", DEFAULT_RECORD_CONCURRENCY),
    async (plan) => {
      const { record } = plan;

      if (plan.mirrorHiveState && deps.mirrorHiveState) {
        try {
          await withTimeout(deps.mirrorHiveState(record, plan.state), timeouts.substrateMs, `mirrorHiveState(${record.name})`);
        } catch (error) {
          errors.push(toError(error));
        }
      }

      // Persist only trustworthy observations. On an HSR batch timeout the
      // previous state remains on disk with its original timestamp.
      if (plan.persistObservation) {
        try {
          await withTimeout(
            deps.touchSession(record.name, {
              lastObservedState: plan.state,
              lastObservedStateAt: observedAtIso,
            }),
            timeouts.fsMs,
            `touchSession(${record.name})`,
          );
        } catch (error) {
          errors.push(toError(error));
        }
      }

      // Archived bees are immutable, and dead/sealed bees no longer produce
      // transcript updates. A fast-finishing bee still gets one discovery
      // pass, but claim it durably BEFORE scanning: terminal records with no
      // matching transcript must not repeat a full provider scan every tick or
      // after every daemon restart.
      if (plan.refreshTranscriptMetadata && deps.refreshTranscriptMetadata) {
        if (plan.claimTerminalTranscriptDiscovery) {
          try {
            const claimed = await withTimeout(
              deps.touchSession(record.name, { terminalTranscriptDiscoveryAt: observedAtIso }),
              timeouts.fsMs,
              `claimTerminalTranscriptDiscovery(${record.name})`,
            );
            if (!claimed) return;
          } catch (error) {
            errors.push(toError(error));
            return;
          }
        }
        try {
          await withTimeout(deps.refreshTranscriptMetadata(record), timeouts.transcriptMs, `refreshTranscriptMetadata(${record.name})`);
        } catch (error) {
          errors.push(toError(error));
        }
      }
    },
  ));

  // Emit a ledger event for EVERY state transition — not just into
  // idle_with_output. The ledger is the event substrate observers (hive
  // events, Pollinate, flights) subscribe to; ledgering only the buz
  // dispatcher's headline signal left wedged/crashed/blocked/sealed edges
  // invisible to anything that doesn't poll derived state itself.
  await timeStage("ledger", async () => {
    for (const transition of transitions) {
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
  });

  // Run the dispatcher registry for state-derived work, strictly in registry
  // order (autoswap consumes the usage stage's outcomes). Each stage runs
  // under its own budget; errors are captured into errors[], never fatal.
  const dispatchContext: DispatchContext = {
    deps,
    records,
    nodes,
    probe,
    panes,
    hsrObs,
    transitions,
    observed,
    firstTick: options.firstTick === true,
    sessionsSnapshotTrusted,
    nowMs,
    outcomes: emptyDispatcherOutcomes(),
  };
  // The registry runs under a SHARED pool (dispatchTotalMs) in addition to
  // each stage's own budget: N sequential 60s-budgeted stages must never be
  // able to sum past the whole-tick watchdog (2026-07-21 canary breach,
  // round 3). A dry pool skips the remaining stages — recorded, never fatal;
  // they run again next tick.
  const dispatchDeadline = deps.now() + timeouts.dispatchTotalMs;
  for (const dispatcher of tickDispatchers) {
    const remainingMs = dispatchDeadline - deps.now();
    if (remainingMs <= 0) {
      // Never call run() here — that would START the stage's side effects
      // only to abandon them. Record the skip (skipFirstTick stages that
      // weren't going to run anyway stay silent) and move on.
      if (!(dispatcher.skipFirstTick && dispatchContext.firstTick)) {
        truncated.push(`${dispatcher.name}@pool-dry`);
      }
      continue;
    }
    await runTickDispatcher(dispatcher, dispatchContext, timeouts, errors, stageMs, truncated, remainingMs);
  }

  // Chain sync deliberately does NOT run here: runDaemon drives deps.syncChains
  // on its own interval so keychain prompts and multi-home sweeps can never
  // starve the observation loop (see runChainSyncLoop in run.ts).

  return {
    transitions,
    observed,
    unreachableNodes: probe.unreachableNodes,
    errors,
    ...dispatchContext.outcomes,
    durationMs: Math.max(0, deps.now() - start),
    stageMs,
    truncated,
  };
}

function liveHiveStateFor(record: SessionRecord, probe: ProbeResult): string | undefined {
  if (!probe.sessionStates) return undefined;
  const keyed = liveTargetKey(record.node, record.tmuxTarget);
  if (probe.sessionStates.has(keyed)) return probe.sessionStates.get(keyed);
  if (probe.sessionStates.has(record.tmuxTarget)) return probe.sessionStates.get(record.tmuxTarget);
  return undefined;
}
