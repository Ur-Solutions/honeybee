import type { NodeRecord } from "../node.js";
import { liveTargetKey, type PaneCaptureMap } from "../state.js";
import type { SessionRecord } from "../store.js";
import { substrateFor, substrateForRecord } from "../substrates/index.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";
import type { ProbeResult } from "./tick.js";
import { withTimeout } from "./timeouts.js";

const DEFAULT_NODE_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_NODE_PROBE_CONCURRENCY = 8;

/**
 * Default TickDeps.probeNodes: probe every node's substrate for reachability
 * and enumerate its live session targets + @hive_state snapshots. Unreachable
 * or failing nodes land in `unreachableNodes`; each probe is bounded by
 * HIVE_NODE_PROBE_MS so one wedged node cannot stall the tick.
 */
export async function defaultProbeNodes(nodes: NodeRecord[]): Promise<ProbeResult> {
  const rawTimeout = Number(process.env.HIVE_NODE_PROBE_MS ?? DEFAULT_NODE_PROBE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_NODE_PROBE_TIMEOUT_MS;
  const liveTargets = new Set<string>();
  const unreachableNodes = new Set<string>();
  const sessionStates = new Map<string, string>();
  await mapWithConcurrency(nodes, envConcurrency("HIVE_NODE_PROBE_CONCURRENCY", DEFAULT_NODE_PROBE_CONCURRENCY), async (node) => {
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
  return { liveTargets, unreachableNodes, sessionStates };
}

/**
 * Default TickDeps.capturePanes: capture the pane text of the subset of records
 * whose target is live. Keyed by the bee's own pane so sub-bees sharing one
 * comb's tmuxTarget keep distinct captures; a failed capture yields undefined.
 */
export async function defaultCapturePanes(records: SessionRecord[], liveTargets: Set<string>): Promise<PaneCaptureMap> {
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
