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
import { repoTagFor } from "./repoTag.js";
import type { BeeState } from "./state.js";
import type { SessionRecord } from "./store.js";
import { substrateFor } from "./substrates/index.js";
import { renderTags } from "./tags.js";

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
    case "wedged":
    case "error":
    case "kill_failed":
      return "failed";
    case "dead":
    case "crashed":
    case "archived":
    case "node_unreachable":
      // Session gone (or filed), or unknowable — nothing to write to.
      return undefined;
  }
}

/**
 * The live @hive_state to trust for display, or undefined to fall back to the
 * freshly pane-derived state. @hive_state is a cached tmux hint: it's stamped
 * "working" at spawn and only cleared by agent Stop/Notification hooks or the
 * daemon's mirror. Hookless CLIs (notably codex) have no way to clear it
 * themselves, so a lagging or stopped daemon strands "working" on bees whose
 * live pane plainly shows them idle/ready/blocked. When the pane-derived state
 * contradicts a stale "working", the pane wins — it's the real-time truth.
 *
 * "failed" is treated the same way: it is ONLY ever produced by the daemon's
 * mirror of a derived wedged/error/kill_failed (no agent hook sets it), so a
 * "failed" hint that disagrees with a healthy live pane is stale and must not
 * mask it — otherwise a bee that briefly wedged (e.g. a slow boot) stays
 * "failed" in `hive ps` long after its pane returned to a ready composer
 * (real incident 2026-07-08). "waiting"/"done" DO come from real hook events
 * and are trusted as-is.
 */
export function effectiveHiveState(liveHive: string | undefined, derived: BeeState | undefined): string | undefined {
  if (!liveHive || liveHive.length === 0) return undefined;
  if (derived === undefined) return liveHive;
  // Only the daemon/spawn-stamped hints (working, failed) are overridable by a
  // contradicting live pane; hook-authoritative hints (waiting, done) stand.
  if (liveHive !== "working" && liveHive !== "failed") return liveHive;
  const derivedHive = hiveStateFor(derived);
  return derivedHive !== undefined && derivedHive !== liveHive ? undefined : liveHive;
}

type SessionRef = Pick<SessionRecord, "node" | "tmuxTarget">;

export async function writeHiveState(record: SessionRef, state: HiveTmuxState): Promise<void> {
  try {
    await substrateFor(record).setUserOptions(record.tmuxTarget, { [HIVE_STATE_OPTION]: state });
  } catch {
    // best-effort
  }
}

/**
 * Mirror the bee's display title (rename/auto/provider); "" clears it. The
 * window is renamed too — that is what choose-tree, the window strip, and
 * view cockpits actually display (a cleared title falls back to the bee's
 * session name).
 */
export async function writeHiveTitle(record: SessionRef, title: string): Promise<void> {
  try {
    const substrate = substrateFor(record);
    await substrate.setUserOptions(record.tmuxTarget, { "@hive_title": title });
    await substrate.renameWindow(record.tmuxTarget, title.length > 0 ? title : record.tmuxTarget);
  } catch {
    // best-effort
  }
}

/**
 * Mirror the bee's effective tag set to @hive_tags for store-free, tmux-native
 * filtering (PRD §9.1/§9.2). Follows the best-effort discipline of
 * writeHiveState / writeHiveTitle: a missing session never breaks the command.
 *
 * §9.3 solo-comb caveat: @hive_* options are session-scoped, but a multi-bee
 * comb shares one session, so only one @hive_tags string can exist. The store
 * scan in `hive list --tag` is authoritative; this mirror is a best-effort
 * fast-path hint for solo combs. No special multi-bee logic is needed in Phase
 * 1 — the store is the source of truth.
 */
export async function writeHiveTags(record: SessionRecord): Promise<void> {
  try {
    await substrateFor(record).setUserOptions(record.tmuxTarget, { "@hive_tags": renderTags(record) });
  } catch {
    // best-effort
  }
}

/** Stamp a freshly spawned bee's session with its hive identity + working state. */
export async function writeSpawnOptions(record: SessionRecord): Promise<void> {
  try {
    const substrate = substrateFor(record);
    await substrate.setUserOptions(record.tmuxTarget, {
      "@hive_id": record.id ?? record.name,
      "@hive_colony": record.colony ?? "",
      "@hive_swarm": record.swarmId ?? "",
      "@hive_title": record.title ?? "",
      "@hive_pane": record.agentPaneId ?? "",
      "@hive_agent": record.agent,
      "@hive_repo": repoTagFor(record.cwd),
      "@hive_tags": renderTags(record),
      [HIVE_STATE_OPTION]: "working",
    });
    // Name the window after the bee (instead of the launcher command) so
    // views and choose-tree are legible before a real title lands.
    await substrate.renameWindow(record.tmuxTarget, record.title ?? record.id ?? record.name);
  } catch {
    // best-effort
  }
}
