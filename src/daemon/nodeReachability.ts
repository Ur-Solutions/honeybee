/**
 * Node online/offline edge tracker (APIA-96).
 *
 * A small stateful dispatcher for the daemon tick, modelled on the usage
 * sampler's rising-edge detection. Each tick it is handed this tick's `nodes`
 * and the `unreachableNodes` set the node-probe already computed, and it emits a
 * ledger event ONLY on a reachability EDGE:
 *
 *   reachable → unreachable   →  { type: "node.offline", node, ts }
 *   unreachable → reachable   →  { type: "node.online",  node, ts }
 *
 * The FIRST observation of a node establishes its baseline and emits nothing (an
 * edge needs a prior state), so a daemon restart does not spuriously announce
 * every node. Steady state (no change) emits nothing. A node that disappears
 * from the roster is forgotten so it re-baselines if it returns.
 *
 * Build ONCE per daemon run (state persists across ticks). Node builtins only.
 */

import type { NodeRecord } from "../node.js";
import { appendLedger as defaultAppendLedger } from "../store.js";

export type NodeReachabilityTransition = "online" | "offline";

export type NodeReachabilityOutcome = {
  node: string;
  transition: NodeReachabilityTransition;
};

export type NodeReachabilityDeps = {
  /** Append the node.online / node.offline edge event. Defaults to the store ledger. */
  appendLedger?: (event: Record<string, unknown>) => Promise<void>;
};

export type NodeReachabilityDispatcher = (
  nodes: NodeRecord[],
  unreachableNodes: Set<string>,
  nowMs: number,
) => Promise<NodeReachabilityOutcome[]>;

export function createNodeReachabilityTracker(deps: NodeReachabilityDeps = {}): NodeReachabilityDispatcher {
  const appendLedger = deps.appendLedger ?? defaultAppendLedger;
  // Last known reachability per node name. Absent === never observed (baseline).
  const lastReachable = new Map<string, boolean>();

  return async (nodes, unreachableNodes, nowMs) => {
    const outcomes: NodeReachabilityOutcome[] = [];
    const seen = new Set<string>();
    const ts = new Date(nowMs).toISOString();

    for (const node of nodes) {
      seen.add(node.name);
      const reachable = !unreachableNodes.has(node.name);
      const prev = lastReachable.get(node.name);
      lastReachable.set(node.name, reachable);
      if (prev === undefined || prev === reachable) continue; // baseline / steady state
      const transition: NodeReachabilityTransition = reachable ? "online" : "offline";
      outcomes.push({ node: node.name, transition });
      await appendLedger({ type: `node.${transition}`, node: node.name, ts });
    }

    // Forget nodes no longer in the roster so a re-registered node re-baselines
    // rather than firing a stale edge against its last-seen reachability.
    for (const name of [...lastReachable.keys()]) {
      if (!seen.has(name)) lastReachable.delete(name);
    }

    return outcomes;
  };
}
