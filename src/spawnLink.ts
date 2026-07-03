/**
 * `spawn --here` window linking: link freshly spawned bees' tmux windows into
 * the caller's current session via `link-window` (a second handle, not a copy),
 * deduping by window id. Purely presentational — the bees' own sessions and
 * records are untouched, and nothing here ever unlinks or kills a window.
 *
 * Slimmed from the retired workspace/view link-window core (tmuxLink.ts): the
 * cockpit/workspace surfaces moved to the Apiary app; only the --here placement
 * affordance stays CLI-side.
 */
import { tmux } from "./substrates/local-tmux.js";

export type WindowInventory = {
  /** session → window ids linked into it (in index order). */
  windows: Map<string, string[]>;
  /** session → its active window id. */
  active: Map<string, string>;
};

/** Parse `list-windows -a -F '#{session_name}\t#{window_id}\t#{window_active}'`. */
export function parseWindowInventory(stdout: string): WindowInventory {
  const windows = new Map<string, string[]>();
  const active = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [session, windowId, isActive] = line.split("\t");
    if (!session || !windowId) continue;
    const list = windows.get(session) ?? [];
    list.push(windowId);
    windows.set(session, list);
    if (isActive === "1") active.set(session, windowId);
  }
  return { windows, active };
}

/**
 * Dedupe: link only bee windows not already present in the host. Re-running the
 * link on a grown swarm links just the new bees.
 */
export function planLinks(
  existingWindowIds: Iterable<string>,
  bees: Array<{ session: string; windowId: string }>,
): Array<{ session: string; windowId: string }> {
  const existing = new Set(existingWindowIds);
  return bees.filter((bee) => !existing.has(bee.windowId));
}

export async function windowInventory(): Promise<WindowInventory> {
  const result = await tmux(["list-windows", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_active}"], { reject: false });
  return parseWindowInventory(result.ok ? result.stdout : "");
}

async function linkWindowsInto(
  session: string,
  currentWindows: Iterable<string>,
  bees: Array<{ session: string; windowId: string }>,
  opts: { select: boolean },
): Promise<number> {
  const plan = planLinks(currentWindows, bees);
  for (const bee of plan) {
    await tmux(["link-window", "-s", bee.windowId, "-t", `=${session}:`]);
  }
  if (opts.select && bees.length === 1) {
    await tmux(["select-window", "-t", `=${session}:${bees[0]!.windowId}`], { reject: false });
  }
  return plan.length;
}

export type LinkHereResult = { session: string; linked: number };

/**
 * `--here`: link bee windows into the caller's current tmux session — purely
 * presentational, the bees' own sessions/records are untouched. For a single
 * bee the linked window is selected; swarms link without stealing focus.
 */
export async function linkHere(
  targets: string[],
  opts: { select: boolean; currentSession?: string },
): Promise<LinkHereResult> {
  const current = opts.currentSession ?? (await tmux(["display-message", "-p", "#{session_name}"])).stdout.trim();
  if (!current) throw new Error("Could not discover the current tmux session");
  const inventory = await windowInventory();
  const bees: Array<{ session: string; windowId: string }> = [];
  for (const target of targets) {
    const windowId = inventory.active.get(target);
    if (windowId) bees.push({ session: target, windowId });
  }
  const linked = await linkWindowsInto(current, inventory.windows.get(current) ?? [], bees, { select: opts.select });
  return { session: current, linked };
}
