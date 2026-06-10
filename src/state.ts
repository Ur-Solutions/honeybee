import { hasAgentDriver } from "./drivers.js";
import { LOCAL_NODE_NAME } from "./node.js";
import { isAgentActivePane, isAgentReadyPane, isMcpWarningPane, isPermissionPromptPane, isTrustPromptPane } from "./readiness.js";
import type { SessionRecord } from "./store.js";

export type BeeState =
  | "dead"
  | "sealed"
  | "blocked"
  | "ready"
  | "active"
  | "idle_with_output"
  | "booting"
  | "error"
  | "kill_failed"
  | "node_unreachable";

export type StateContext = {
  /**
   * Live tmux sessions keyed by liveTargetKey(node, target) so that targets
   * with the same name on different nodes never shadow each other. Bare
   * target names are still honored for single-node callers (back-compat).
   */
  liveTargets: Set<string>;
  panes?: Map<string, string>;
  seals?: Set<string>;
  unreachableNodes?: Set<string>;
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

export function deriveState(record: SessionRecord, context: StateContext): DerivedState {
  if (record.status === "kill_failed") {
    return { state: "kill_failed", detail: record.lastError ?? "previous kill failed" };
  }

  // node_unreachable takes precedence over dead/sealed because we cannot trust the
  // liveTargets set when the bee's node failed to respond — we don't actually know
  // whether the session is alive.
  const nodeName = record.node && record.node.length > 0 ? record.node : LOCAL_NODE_NAME;
  if (context.unreachableNodes?.has(nodeName)) {
    return { state: "node_unreachable", detail: `node ${nodeName} offline` };
  }

  const live = context.liveTargets.has(liveTargetKey(record.node, record.tmuxTarget))
    || context.liveTargets.has(record.tmuxTarget);
  if (!live) {
    if (context.seals?.has(record.name)) return { state: "sealed", detail: "sealed before exit" };
    return { state: "dead", detail: lastActivityHint(record, context) };
  }

  if (context.seals?.has(record.name)) {
    return { state: "sealed", detail: "seal recorded" };
  }

  const pane = context.panes?.get(record.tmuxTarget) ?? "";
  if (pane) {
    if (isMcpWarningPane(pane)) return { state: "blocked", detail: "MCP warning" };
    if (isTrustPromptPane(pane)) return { state: "blocked", detail: "trust prompt" };
    if (isPermissionPromptPane(pane)) return { state: "blocked", detail: "awaiting permission" };
  }

  const now = context.now ?? Date.now();
  const promptAt = record.lastPromptAt ? Date.parse(record.lastPromptAt) : NaN;
  const briefedAt = record.briefedAt ? Date.parse(record.briefedAt) : NaN;
  const lastActivityAt = pickMax(promptAt, briefedAt);
  const hasOutput = pane.length >= READY_PANE_MIN_BYTES;
  const knownAgent = hasAgentDriver(record.agent);
  const paneReady = pane ? isAgentReadyPane(record.agent, pane) : false;
  const paneActive = pane ? isAgentActivePane(record.agent, pane) : false;

  if (Number.isFinite(lastActivityAt) && now - lastActivityAt < ACTIVE_WINDOW_MS) {
    return { state: "active", detail: describeActivity(record) };
  }

  if (!Number.isFinite(promptAt)) {
    if (paneReady) return { state: "ready", detail: record.brief ? "briefed, awaiting prompt" : "awaiting prompt" };
    if (!record.brief && !hasOutput) return { state: "booting", detail: "starting up" };
    if (pane && knownAgent && !paneReady) return { state: "booting", detail: "starting up" };
    return { state: "ready", detail: record.brief ? "briefed, awaiting prompt" : "awaiting prompt" };
  }

  if (paneActive) {
    return { state: "active", detail: describeActivity(record) };
  }

  if (pane && knownAgent && !paneReady) {
    return { state: "active", detail: describeActivity(record) };
  }

  return { state: "idle_with_output", detail: describeIdle(record, now) };
}

export function stateLabel(state: BeeState): string {
  switch (state) {
    case "dead":
      return "dead";
    case "sealed":
      return "sealed";
    case "blocked":
      return "blocked";
    case "ready":
      return "ready";
    case "active":
      return "active";
    case "idle_with_output":
      return "idle";
    case "booting":
      return "booting";
    case "error":
      return "error";
    case "kill_failed":
      return "kill_failed";
    case "node_unreachable":
      return "offline";
  }
}

export function isTerminalState(state: BeeState): boolean {
  // node_unreachable is transient — the node may come back online — and not terminal.
  return state === "dead" || state === "sealed" || state === "error" || state === "kill_failed";
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
