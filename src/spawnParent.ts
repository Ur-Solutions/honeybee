// ──────────────────────────────────────────────────────────────────────────
// Spawn parentage capture. When one bee spawns another, we record the spawner
// on the child (SessionRecord.spawnedById) so the fleet surface can reconstruct
// the orchestrator→worker tree from disk — never from what survived the
// orchestrator's context. This is the one datum that was missing; everything
// else a coordinator needs to reconcile is already ground truth in the store.
//
// Kept low-level (store + env only, no tmux, no cli/shared) so the spawn record
// builders in spawn.ts and agents.ts can both import it without an import cycle.
// ──────────────────────────────────────────────────────────────────────────

import { listSessions } from "./store.js";

/**
 * The id (or name) of the bee the CURRENT process is running inside, or
 * undefined when the spawner is not a bee (operator/daemon-launched roots, which
 * correctly get no parent edge).
 *
 * Strict, matching cli/shared's spawnOriginIsAgent: only the DIRECT anchors
 * count — the HIVE_BEE stamp (HSR children) or a TMUX_PANE that matches a bee's
 * own agent pane (a tmux bee's subprocesses inherit its pane id). The tmux
 * session-name fallback is deliberately not consulted: an operator shell or a
 * display popup shares a bee's session without BEING the bee, and must not be
 * captured as a parent.
 */
export async function resolveSpawningBeeId(): Promise<string | undefined> {
  const hiveBee = process.env.HIVE_BEE;
  const paneId = process.env.TMUX ? process.env.TMUX_PANE : undefined;
  if (!hiveBee && !paneId) return undefined;
  const records = await listSessions();
  if (hiveBee && hiveBee.length > 0) {
    const byEnv = records.find((record) => record.name === hiveBee);
    if (byEnv) return byEnv.id ?? byEnv.name;
  }
  if (paneId && paneId.length > 0) {
    const byPane = records.find((record) => record.agentPaneId === paneId);
    if (byPane) return byPane.id ?? byPane.name;
  }
  return undefined;
}
