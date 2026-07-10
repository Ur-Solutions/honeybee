import { hasAgentDriver } from "./drivers.js";
import { cyan, dim, gray, green, magenta, red, yellow } from "./format.js";
import { LOCAL_NODE_NAME } from "./node.js";
import { isAgentActivePane, isAgentReadyPane, isMcpWarningPane, isPermissionPromptPane, isTrustPromptPane } from "./readiness.js";
import type { SessionRecord } from "./store.js";

export type BeeState =
  | "dead"
  | "crashed"
  | "sealed"
  | "archived"
  | "blocked"
  | "ready"
  | "active"
  | "idle_with_output"
  | "queued"
  | "booting"
  | "wedged"
  | "error"
  | "kill_failed"
  | "node_unreachable";

export type PaneCaptureMap = ReadonlyMap<string, string | undefined>;

export type StateContext = {
  /**
   * Live tmux sessions keyed by liveTargetKey(node, target) so that targets
   * with the same name on different nodes never shadow each other. Bare
   * target names are still honored for single-node callers (back-compat).
   */
  liveTargets: Set<string>;
  /**
   * Server-wide live pane ids (e.g. "%7") on the LOCAL tmux server. When a bee
   * is pane-pinned (agentPaneId) and local, liveness is the pane's presence
   * here — so killing the agent pane reports the bee dead even while its
   * session survives. Absent → fall back to session liveness for everyone.
   */
  livePanes?: Set<string>;
  panes?: PaneCaptureMap;
  /**
   * Previous in-memory daemon observations, keyed by bee name. Used when pane
   * content is unknown for a live tmux bee so a transient capture failure does
   * not fabricate an active -> idle_with_output transition.
   */
  previousStates?: ReadonlyMap<string, BeeState>;
  seals?: Set<string>;
  unreachableNodes?: Set<string>;
  /**
   * HSR (pane-less runner) observation, keyed by bee name. Sourced from
   * hsrObservations() (run-dir reads, never tmux): `hsrLive` is host-pid
   * liveness, `hsrStates` is the structured BeeState from the events tail, and
   * `hsrSnapshots` is the ring text used as an output fallback. A record with
   * substrate "hsr" is resolved from these instead of the tmux pane sets.
   */
  hsrLive?: Set<string>;
  hsrStates?: Map<string, BeeState>;
  hsrSnapshots?: Map<string, string>;
  /**
   * Bees that are LOCAL MIRRORS of remote-hsr bees (APIA-94): their structured
   * events are replayed into a local run dir by the daemon's remoteEventMirror.
   * A record in this set — even though it carries a `node` and NOT
   * `substrate:"hsr"` — is resolved from the same run-dir HSR observation
   * (hsrLive/hsrStates/hsrSnapshots) as a local HSR bee, giving finer state than
   * the coarse node-probe. Sourced from hsrObservations() rows whose meta is a
   * mirror.
   */
  hsrMirrors?: Set<string>;
  now?: number;
};

/** Node-qualified liveness key; node defaults to the implicit local node. */
export function liveTargetKey(node: string | undefined, target: string): string {
  const nodeName = node && node.length > 0 ? node : LOCAL_NODE_NAME;
  return `${nodeName} ${target}`;
}

export type DerivedState = {
  state: BeeState;
  detail: string;
};

const ACTIVE_WINDOW_MS = 30_000;
const READY_PANE_MIN_BYTES = 200;

/**
 * How long a bee may stay in "booting" before it is reported "wedged" instead.
 * A normal boot reaches ready/active in seconds to a minute or two; a runner
 * that is alive but has produced no output/readiness past this window is stuck
 * (concurrent-boot credential collision, an exhausted account, a hung login),
 * not still coming up. Override with HIVE_BOOT_WEDGE_MS.
 */
const BOOT_WEDGE_MS = (() => {
  const raw = Number(process.env.HIVE_BOOT_WEDGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000;
})();

/** Compact duration for a wedge detail, e.g. 82m / 3h. */
function describeSpan(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * A would-be "booting" result, promoted to "wedged" once the bee has been alive
 * (since spawn) longer than BOOT_WEDGE_MS without ever reaching ready/active.
 */
function bootingOrWedged(record: SessionRecord, now: number): DerivedState {
  const spawnedAt = record.createdAt ? Date.parse(record.createdAt) : NaN;
  const age = Number.isFinite(spawnedAt) ? now - spawnedAt : NaN;
  if (Number.isFinite(age) && age > BOOT_WEDGE_MS) {
    return { state: "wedged", detail: `wedged — no output for ${describeSpan(age)}` };
  }
  return { state: "booting", detail: "starting up" };
}

export function deriveState(record: SessionRecord, context: StateContext): DerivedState {
  if (record.status === "kill_failed") {
    return { state: "kill_failed", detail: record.lastError ?? "previous kill failed" };
  }

  // An archived bee is a settled terminal fact (filed on `quest done`): its tmux
  // target is gone, but it is FILED, not dead, and must never flip to "offline"
  // on an unreachable node. Short-circuit BEFORE the liveness/node probe so the
  // archived status always wins — even over a stray live target of the same name.
  if (record.status === "archived") {
    return { state: "archived", detail: "filed on quest done" };
  }

  // node_unreachable takes precedence over dead/sealed because we cannot trust the
  // liveTargets set when the bee's node failed to respond — we don't actually know
  // whether the session is alive.
  const nodeName = record.node && record.node.length > 0 ? record.node : LOCAL_NODE_NAME;
  if (context.unreachableNodes?.has(nodeName)) {
    return { state: "node_unreachable", detail: `node ${nodeName} offline` };
  }

  // HSR bees are pane-less: they have neither a live pane nor a live tmux target,
  // so the tmux liveness block below would read every one as dead. Resolve them
  // from the run-dir observation (host-pid liveness + structured event state)
  // that hsrObservations() threaded into the context.
  if (record.substrate === "hsr") {
    return deriveHsrState(record, context);
  }

  // A remote-hsr bee with a LOCAL MIRROR (APIA-94): the daemon replays its
  // events into a local run dir, so we resolve it from the same run-dir HSR
  // observation as a local HSR bee — finer than the coarse node-probe state.
  // The node is already known-reachable here (node_unreachable short-circuits
  // above), so the mirror reflects the current remote state.
  if (context.hsrMirrors?.has(record.name)) {
    return deriveHsrState(record, context);
  }

  // Pane-pinned local bees: liveness is the PANE, not the session. This is the
  // fix for "agent pane killed but the session lives on" reporting false-alive.
  // Only applied locally — livePanes is the local server's pane set; a remote
  // bee's pane isn't in it, so remote bees keep session liveness.
  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  const live = record.agentPaneId && context.livePanes && isLocal
    ? context.livePanes.has(record.agentPaneId)
    : context.liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)) || context.liveTargets.has(record.tmuxTarget);
  if (!live) {
    if (context.seals?.has(record.name)) return { state: "sealed", detail: "sealed before exit" };
    return deadOrCrashed(record, context);
  }

  if (context.seals?.has(record.name)) {
    return { state: "sealed", detail: "seal recorded" };
  }

  // Content is keyed by the bee's own pane (agentPaneId) so sub-bees sharing a
  // comb's tmuxTarget don't collide; legacy solo bees fall back to tmuxTarget.
  const paneKey = record.agentPaneId ?? record.tmuxTarget;
  const paneCaptured = context.panes?.has(paneKey) ?? false;
  const pane = paneCaptured ? context.panes?.get(paneKey) : undefined;
  if (pane === undefined) {
    const held = heldStateForUnknownPane(record, context);
    if (held) return held;
    // Capture was unavailable this tick (a busy tmux server drops captures
    // under fleet-scale load) AND the prior observed state was non-holdable —
    // typically a stale `wedged`/`crashed` from an earlier missed capture. For a
    // NEVER-PROMPTED bee, missing pane data would otherwise fall through to
    // bootingOrWedged and re-fabricate `wedged`, which self-sustains: wedged
    // isn't holdable, so every later missed capture re-derives wedged forever,
    // stranding a healthy idle bee as "failed" (real incident 2026-07-08).
    // Missing data is not evidence of a stuck boot — a live, never-prompted bee
    // we simply could not read is at its composer, so report `ready`. Real wedge
    // detection still fires below when the pane IS seen (captured-but-unready),
    // the only trustworthy wedge evidence. Prompted bees fall through to the
    // existing "unknown pane + prompted → active" path and never reach here as
    // wedged, so they are intentionally left to that logic.
    if (!Number.isFinite(record.lastPromptAt ? Date.parse(record.lastPromptAt) : NaN)) {
      return { state: "ready", detail: record.brief ? "briefed, awaiting prompt" : "awaiting prompt" };
    }
  }
  const paneText = pane ?? "";
  if (paneText) {
    if (isMcpWarningPane(paneText)) return { state: "blocked", detail: "MCP warning" };
    if (isTrustPromptPane(paneText)) return { state: "blocked", detail: "trust prompt" };
    if (isPermissionPromptPane(paneText)) return { state: "blocked", detail: "awaiting permission" };
  }

  const now = context.now ?? Date.now();
  const promptAt = record.lastPromptAt ? Date.parse(record.lastPromptAt) : NaN;
  const briefedAt = record.briefedAt ? Date.parse(record.briefedAt) : NaN;
  const lastActivityAt = pickMax(promptAt, briefedAt);
  const hasOutput = paneText.length >= READY_PANE_MIN_BYTES;
  const knownAgent = hasAgentDriver(record.agent);
  const paneReady = paneText ? isAgentReadyPane(record.agent, paneText) : false;
  const paneActive = paneText ? isAgentActivePane(record.agent, paneText) : false;

  if (Number.isFinite(lastActivityAt) && now - lastActivityAt < ACTIVE_WINDOW_MS) {
    return { state: "active", detail: describeActivity(record) };
  }

  if (!Number.isFinite(promptAt)) {
    if (paneReady) return { state: "ready", detail: record.brief ? "briefed, awaiting prompt" : "awaiting prompt" };
    if (!record.brief && !hasOutput) return bootingOrWedged(record, now);
    if (paneText && knownAgent && !paneReady) return bootingOrWedged(record, now);
    return { state: "ready", detail: record.brief ? "briefed, awaiting prompt" : "awaiting prompt" };
  }

  if (paneActive) {
    return { state: "active", detail: describeActivity(record) };
  }

  if (paneText && knownAgent && !paneReady) {
    return { state: "active", detail: describeActivity(record) };
  }

  if (pane === undefined && Number.isFinite(promptAt)) {
    return { state: "active", detail: describeActivity(record) };
  }

  return { state: "idle_with_output", detail: describeIdle(record, now) };
}

/**
 * Resolve an HSR (pane-less) bee purely from run-dir observation. Liveness is
 * the host pid (context.hsrLive); the live state is the structured BeeState the
 * observer derived from the events tail (context.hsrStates). We never touch the
 * tmux pane sets here — an HSR bee has no pane and no live target.
 */
function deriveHsrState(record: SessionRecord, context: StateContext): DerivedState {
  const now = context.now ?? Date.now();
  const live = context.hsrLive?.has(record.name) ?? false;
  if (!live) {
    if (context.seals?.has(record.name)) return { state: "sealed", detail: "sealed before exit" };
    return deadOrCrashed(record, context);
  }
  if (context.seals?.has(record.name)) {
    return { state: "sealed", detail: "seal recorded" };
  }

  const structured = context.hsrStates?.get(record.name);
  if (structured) {
    switch (structured) {
      case "active":
        return { state: "active", detail: describeActivity(record) };
      case "idle_with_output":
        return { state: "idle_with_output", detail: describeIdle(record, context.now ?? Date.now()) };
      case "blocked":
        return { state: "blocked", detail: "awaiting input" };
      case "ready":
        return { state: "ready", detail: record.brief ? "briefed, awaiting prompt" : "awaiting prompt" };
      case "queued":
        return { state: "queued", detail: "waiting for a startup slot" };
      case "booting":
        return bootingOrWedged(record, now);
      case "dead":
      case "crashed":
        return deadOrCrashed(record, context);
      case "sealed":
        return { state: "sealed", detail: "seal recorded" };
      case "archived":
        return { state: "archived", detail: "filed on quest done" };
      case "error":
        return { state: "error", detail: record.lastError ?? "runner error" };
      case "kill_failed":
        return { state: "kill_failed", detail: record.lastError ?? "previous kill failed" };
      case "node_unreachable":
        return { state: "node_unreachable", detail: `node ${record.node && record.node.length > 0 ? record.node : LOCAL_NODE_NAME} offline` };
      default:
        return { state: structured, detail: describeActivity(record) };
    }
  }

  // No structured signal yet: a recent prompt means the bee is working; else the
  // ring snapshot standing in for pane output decides booting vs idle.
  const promptAt = record.lastPromptAt ? Date.parse(record.lastPromptAt) : NaN;
  if (Number.isFinite(promptAt) && now - promptAt < ACTIVE_WINDOW_MS) {
    return { state: "active", detail: describeActivity(record) };
  }
  const snapshot = context.hsrSnapshots?.get(record.name) ?? "";
  if (snapshot.length > 0) return { state: "idle_with_output", detail: describeIdle(record, now) };
  return bootingOrWedged(record, now);
}

/**
 * A bee whose runtime is gone splits on recorded intent: a record still
 * 'running' was never told to stop — nobody issued a retire/kill for it — so
 * something under it failed (tmux server crash, external kill, harness exit)
 * and it reports "crashed". Only a record explicitly marked 'dead' (legacy
 * writers / deserialization fallback) reports plain "dead". This is what makes
 * `hive revive --crashed` precise: deliberate retirement archives the record,
 * so it can never be confused with a crash.
 */
function deadOrCrashed(record: SessionRecord, context: StateContext): DerivedState {
  if (record.status === "running") {
    return { state: "crashed", detail: `exited without retire/kill — ${lastActivityHint(record, context)}` };
  }
  return { state: "dead", detail: lastActivityHint(record, context) };
}

/** Wraps a string in an ANSI color (no-op when output is not a TTY). */
type Colorize = (value: string) => string;

/** Leaves the label uncolored — the glyph carries the state's color alone. */
const plain: Colorize = (value) => value;

/**
 * Single source of truth for how each BeeState is presented. Keying by
 * `Record<BeeState, …>` makes the compiler reject any new/renamed state that
 * forgets an entry, so label/glyph/color/clean-ordering can never drift apart
 * across the three call sites that render them (stateLabel, formatStateCell,
 * cleanStatePriority). A missing clean-priority case used to fall through to
 * `undefined` → `NaN` and silently corrupt `hive clean` ordering.
 */
export type StatePresentation = {
  /** Human-facing label shown in table cells and `state:` filters. */
  label: string;
  /** Status glyph rendered before the label. */
  glyph: string;
  /** Color applied to the glyph. */
  color: Colorize;
  /**
   * Color applied to the label. Most states tint the label to match the glyph;
   * `ready` and `idle_with_output` deliberately leave it uncolored (`plain`).
   */
  labelColor: Colorize;
  /** Tie-break order when `hive clean` sorts same-age candidates (lower first). */
  cleanPriority: number;
};

export const STATE_PRESENTATION: Record<BeeState, StatePresentation> = {
  active: { label: "active", glyph: "●", color: green, labelColor: green, cleanPriority: 8 },
  ready: { label: "ready", glyph: "●", color: green, labelColor: plain, cleanPriority: 4 },
  queued: { label: "queued", glyph: "◌", color: cyan, labelColor: cyan, cleanPriority: 7 },
  booting: { label: "booting", glyph: "●", color: cyan, labelColor: cyan, cleanPriority: 7 },
  wedged: { label: "wedged", glyph: "⊘", color: red, labelColor: red, cleanPriority: 7 },
  blocked: { label: "blocked", glyph: "●", color: yellow, labelColor: yellow, cleanPriority: 5 },
  idle_with_output: { label: "idle", glyph: "●", color: dim, labelColor: plain, cleanPriority: 0 },
  sealed: { label: "sealed", glyph: "●", color: magenta, labelColor: magenta, cleanPriority: 2 },
  archived: { label: "archived", glyph: "○", color: gray, labelColor: gray, cleanPriority: 1 },
  error: { label: "error", glyph: "●", color: red, labelColor: red, cleanPriority: 6 },
  kill_failed: { label: "kill_failed", glyph: "●", color: red, labelColor: red, cleanPriority: 3 },
  dead: { label: "dead", glyph: "○", color: gray, labelColor: gray, cleanPriority: 1 },
  crashed: { label: "crashed", glyph: "○", color: red, labelColor: red, cleanPriority: 1 },
  node_unreachable: { label: "offline", glyph: "?", color: yellow, labelColor: yellow, cleanPriority: 9 },
};

export function stateLabel(state: BeeState): string {
  return STATE_PRESENTATION[state].label;
}

/** Renders the STATE-column cell: colored glyph followed by the label. */
export function formatStateCell(state: BeeState): string {
  const { glyph, color, label, labelColor } = STATE_PRESENTATION[state];
  return `${color(glyph)} ${labelColor(label)}`;
}

/** Clean-ordering tie-break for same-age candidates (lower = cleaned first). */
export function cleanStatePriority(state: BeeState): number {
  return STATE_PRESENTATION[state].cleanPriority;
}

export function isTerminalState(state: BeeState): boolean {
  // node_unreachable is transient — the node may come back online — and not terminal.
  return state === "dead" || state === "crashed" || state === "sealed" || state === "archived" || state === "error" || state === "kill_failed";
}

function heldStateForUnknownPane(record: SessionRecord, context: StateContext): DerivedState | null {
  const previous = context.previousStates?.get(record.name) ?? parseBeeState(record.lastObservedState);
  if (!previous || !isHoldableUnknownPaneState(previous)) return null;
  return { state: previous, detail: detailForHeldState(previous, record, context.now ?? Date.now()) };
}

function parseBeeState(value: string | undefined): BeeState | undefined {
  switch (value) {
    case "blocked":
    case "ready":
    case "active":
    case "idle_with_output":
    case "booting":
    case "queued":
    case "wedged":
    case "error":
    case "dead":
    case "crashed":
    case "sealed":
    case "archived":
    case "kill_failed":
    case "node_unreachable":
      return value;
    default:
      return undefined;
  }
}

function isHoldableUnknownPaneState(state: BeeState): boolean {
  return state === "active" || state === "blocked" || state === "ready" || state === "idle_with_output" || state === "booting" || state === "queued";
}

function detailForHeldState(state: BeeState, record: SessionRecord, now: number): string {
  switch (state) {
    case "active":
    case "blocked":
      return describeActivity(record);
    case "ready":
      return record.brief ? "briefed, awaiting prompt" : "awaiting prompt";
    case "idle_with_output":
      return describeIdle(record, now);
    case "booting":
      return "starting up";
    case "queued":
      return "waiting for a startup slot";
    default:
      return describeActivity(record);
  }
}

function lastActivityHint(record: SessionRecord, _context: StateContext): string {
  const fields = [record.lastPromptAt, record.briefedAt, record.updatedAt].filter((value): value is string => typeof value === "string");
  if (fields.length === 0) return "no recorded activity";
  const max = pickMax(...fields.map((value) => Date.parse(value)));
  const latest = fields.find((value) => Date.parse(value) === max) ?? fields[0]!;
  return `last activity ${latest}`;
}

function describeActivity(record: SessionRecord): string {
  if (record.lastPrompt) return record.lastPrompt.split("\n")[0]!.slice(0, 60);
  if (record.brief) return record.brief.split("\n")[0]!.slice(0, 60);
  return "recently active";
}

function describeIdle(record: SessionRecord, now: number): string {
  const ts = record.lastPromptAt ? Date.parse(record.lastPromptAt) : NaN;
  if (!Number.isFinite(ts)) return "idle";
  const elapsed = Math.max(0, now - ts);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `idle ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `idle ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `idle ${hours}h`;
}

function pickMax(...values: number[]): number {
  let max = -Infinity;
  for (const value of values) {
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}
