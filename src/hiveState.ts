/**
 * Bee state as tmux session user options.
 *
 * Every bee session carries @hive_id / @hive_colony / @hive_swarm / @hive_state,
 * so status bars and dashboards can render swarm state straight from
 * `tmux list-sessions -F` — the options ARE the API, no hive-store polling.
 *
 * The four-value @hive_state vocabulary is intentionally coarser than
 * BeeState: it answers "does this bee need me?", not "what exactly is it
 * doing". External writers exist (agent Stop/Notification hooks set waiting/
 * done directly); hive's writes are last-writer-wins alongside them.
 *
 * All writes are best-effort: a missing session or unreachable node must
 * never break spawn/wait/seal/daemon flows.
 */
import type { BeeState } from "./state.js";
import type { SessionRecord } from "./store.js";
import { substrateFor } from "./substrates/index.js";

export type HiveTmuxState = "working" | "waiting" | "done" | "failed";

export const HIVE_STATE_OPTION = "@hive_state";

export function hiveStateFor(state: BeeState): HiveTmuxState | undefined {
  switch (state) {
    case "booting":
    case "active":
      return "working";
    case "ready":
    case "blocked":
      return "waiting";
    case "idle_with_output":
    case "sealed":
      return "done";
    case "error":
    case "kill_failed":
      return "failed";
    case "dead":
    case "node_unreachable":
      // Session gone or unknowable — nothing to write to.
      return undefined;
  }
}

type SessionRef = Pick<SessionRecord, "node" | "tmuxTarget">;

export async function writeHiveState(record: SessionRef, state: HiveTmuxState): Promise<void> {
  try {
    await substrateFor(record).setUserOptions(record.tmuxTarget, { [HIVE_STATE_OPTION]: state });
  } catch {
    // best-effort
  }
}

/** Mirror the bee's display title (rename/auto/provider); "" clears it. */
export async function writeHiveTitle(record: SessionRef, title: string): Promise<void> {
  try {
    await substrateFor(record).setUserOptions(record.tmuxTarget, { "@hive_title": title });
  } catch {
    // best-effort
  }
}

/** Stamp a freshly spawned bee's session with its hive identity + working state. */
export async function writeSpawnOptions(record: SessionRecord): Promise<void> {
  try {
    await substrateFor(record).setUserOptions(record.tmuxTarget, {
      "@hive_id": record.id ?? record.name,
      "@hive_colony": record.colony ?? "",
      "@hive_swarm": record.swarmId ?? "",
      "@hive_title": record.title ?? "",
      [HIVE_STATE_OPTION]: "working",
    });
  } catch {
    // best-effort
  }
}
