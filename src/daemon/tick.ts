import { hiveStateFor } from "../hiveState.js";
import type { NodeRecord } from "../node.js";
import type { HsrObservation } from "../hsr/observe.js";
import { deriveState, liveTargetKey, type BeeState, type PaneCaptureMap, type StateContext } from "../state.js";
import type { SessionRecord } from "../store.js";
import type { AutoTitleOutcome } from "./autoTitle.js";
import type { AutoswapOutcome } from "./autoswap.js";
import type { BuzDispatchOutcome } from "./buzDispatcher.js";
import type { NeedsInputOutcome } from "./needsInput.js";
import type { NodeReachabilityDispatcher, NodeReachabilityOutcome } from "./nodeReachability.js";
import type { TokenRefreshOutcome } from "./tokenRefresh.js";
import type { PoolSweeper, PoolSweepOutcome } from "./poolSweep.js";
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
};

export type TickResult = DispatcherOutcomes & {
  transitions: TickTransition[];
  observed: Map<string, BeeState>;
  unreachableNodes: Set<string>;
  errors: Error[];
  durationMs: number;
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
 * tick, strictly in this order (autoswap consumes the usage stage's outcomes).
 * Void periodic tasks with positional constraints (mirrorRemoteEvents,
 * syncChains) stay inline in tick() — they produce no outcomes to log.
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
  // Usage sampler: factual per-account token samples + exhaustion events.
  {
    key: "usage",
    name: "sampleUsage",
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
  // Checkout-pool sweep (§6.6): claim GC, refresh-on-vacate, flags, minFree
  // pre-extend. Self-throttled inside the sweeper — most ticks return [].
  {
    key: "poolSweeps",
    name: "sweepPools",
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
  return { buzDrains: [], needsInput: [], nodeReachability: [], usage: [], autoswaps: [], autoTitles: [], tokenRefreshes: [], poolSweeps: [] };
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
): Promise<void> {
  const pending = dispatcher.run(ctx);
  if (!pending) return;
  try {
    ctx.outcomes[dispatcher.key] = await withTimeout(pending, timeouts[dispatcher.timeoutKey], dispatcher.name);
  } catch (error) {
    errors.push(toError(error));
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
  for (const transition of result.transitions) {
    entries.push({
      level: "info",
      msg: "state.transition",
      session: transition.name,
      from: transition.from ?? null,
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
  const recordPlans = records.map((record) => {
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
    const terminal = derived.state === "dead" || derived.state === "crashed" || derived.state === "sealed";
    return {
      record,
      state: derived.state,
      mirrorHiveState: (transitioned || staleHiveState) && !uncertainBooting,
      refreshTranscriptMetadata: (!terminal || !record.transcriptPath) && deps.refreshTranscriptMetadata !== undefined,
    };
  });

  await mapWithConcurrency(
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

      // Persist the latest observed state. Errors are captured but do not abort the loop.
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

      // Dead/sealed bees no longer produce transcript updates — skip the
      // refresh once transcript metadata has been captured. A bee that exited
      // before its first refresh (fast finish between ticks) still gets one
      // pass so list/search/tail metadata is not permanently missing.
      if (plan.refreshTranscriptMetadata && deps.refreshTranscriptMetadata) {
        try {
          await withTimeout(deps.refreshTranscriptMetadata(record), timeouts.transcriptMs, `refreshTranscriptMetadata(${record.name})`);
        } catch (error) {
          errors.push(toError(error));
        }
      }
    },
  );

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
    nowMs,
    outcomes: emptyDispatcherOutcomes(),
  };
  for (const dispatcher of tickDispatchers) {
    await runTickDispatcher(dispatcher, dispatchContext, timeouts, errors);
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
    ...dispatchContext.outcomes,
    durationMs: Math.max(0, deps.now() - start),
  };
}

function liveHiveStateFor(record: SessionRecord, probe: ProbeResult): string | undefined {
  if (!probe.sessionStates) return undefined;
  const keyed = liveTargetKey(record.node, record.tmuxTarget);
  if (probe.sessionStates.has(keyed)) return probe.sessionStates.get(keyed);
  if (probe.sessionStates.has(record.tmuxTarget)) return probe.sessionStates.get(record.tmuxTarget);
  return undefined;
}
