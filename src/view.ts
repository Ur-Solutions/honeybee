/**
 * Colony cockpits: ephemeral tmux sessions ("view-<name>") whose windows are
 * link-window references to live bees' windows. Windows are server-level
 * objects — a link is a second handle, not a copy — so a view renders many
 * bees in one session without touching their lifecycle.
 *
 * Hard invariant: nothing in this module ever calls kill-window or passes -k
 * to unlink-window. A bee window always keeps its home link in the bee's own
 * session, so unlinking it from a view can never be fatal (tmux refuses to
 * remove a window's last link). The only kill here is kill-session on the
 * view itself, and only after every bee window was verifiably unlinked — the
 * view's own lobby window (tagged at creation in @hive_view_lobby) is the
 * sole window a dying view may take with it.
 *
 * Views are tmux-derived and ephemeral: no store records, invisible to
 * selectors/clean (those only operate on store records).
 */
import { hasSession, tmux } from "./substrates/local-tmux.js";

export const VIEW_PREFIX = "view-";

/** `@t1` → t1, `colony:fe` → fe, bee names pass through; sanitized for tmux. */
export function deriveViewName(selector: string): string {
  const bare = selector.startsWith("@") ? selector.slice(1) : selector.startsWith("colony:") ? selector.slice("colony:".length) : selector;
  const safe = bare.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`Cannot derive a view name from selector: ${selector}`);
  return safe;
}

export function viewSessionName(name: string): string {
  const bare = name.startsWith(VIEW_PREFIX) ? name.slice(VIEW_PREFIX.length) : name;
  if (!/^[A-Za-z0-9_-]+$/.test(bare)) throw new Error(`Invalid view name: ${name}`);
  return `${VIEW_PREFIX}${bare}`;
}

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
 * Dedupe: link only bee windows not already present in the view. Re-running
 * `view` on a grown swarm links just the new bees.
 */
export function planViewLinks(
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

export type BuildViewResult = {
  session: string;
  created: boolean;
  linked: string[];
  alreadyLinked: number;
};

/**
 * Create or reuse `view-<name>` and link each target session's active window
 * into it. Targets must be live sessions on the local server.
 */
export async function buildView(name: string, targets: string[]): Promise<BuildViewResult> {
  const session = viewSessionName(name);
  const inventory = await windowInventory();

  let created = false;
  if (!(await hasSession(session))) {
    // The lobby shell anchors the session: links come and go, the view stays.
    // Its window id is tagged on the session so --close can prove what it owns.
    await tmux(["new-session", "-d", "-s", session, "-n", "hive"]);
    const lobby = await tmux(["display-message", "-p", "-t", `=${session}:`, "#{window_id}"]);
    // set/show-options only honor "=" exact matching in the "=name:" form.
    await tmux(["set-option", "-t", `=${session}:`, "@hive_view_lobby", lobby.stdout.trim()]);
    created = true;
  }

  const fresh = created ? await windowInventory() : inventory;
  const bees: Array<{ session: string; windowId: string }> = [];
  for (const target of targets) {
    const windowId = fresh.active.get(target);
    if (windowId) bees.push({ session: target, windowId });
  }
  const plan = planViewLinks(fresh.windows.get(session) ?? [], bees);

  const linked: string[] = [];
  for (const bee of plan) {
    await tmux(["link-window", "-s", bee.windowId, "-t", `=${session}:`]);
    linked.push(bee.session);
  }
  return { session, created, linked, alreadyLinked: bees.length - plan.length };
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
  const plan = planViewLinks(inventory.windows.get(current) ?? [], bees);
  for (const bee of plan) {
    await tmux(["link-window", "-s", bee.windowId, "-t", `=${current}:`]);
  }
  if (opts.select && bees.length === 1) {
    await tmux(["select-window", "-t", `=${current}:${bees[0]!.windowId}`], { reject: false });
  }
  return { session: current, linked: plan.length };
}

/** First free `view-<name>-<n>` grouped-session name (independent focus). */
export async function groupedViewSessionName(name: string): Promise<string> {
  const session = viewSessionName(name);
  const result = await tmux(["list-sessions", "-F", "#{session_name}"], { reject: false });
  const taken = new Set(result.ok ? result.stdout.split("\n").map((s) => s.trim()) : []);
  for (let n = 2; ; n += 1) {
    const candidate = `${session}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function createGroupedView(name: string): Promise<string> {
  const session = viewSessionName(name);
  const grouped = await groupedViewSessionName(name);
  await tmux(["new-session", "-d", "-t", `=${session}`, "-s", grouped]);
  return grouped;
}

export type CloseViewResult = {
  sessions: string[];
  unlinked: number;
};

/**
 * Unlink every bee window from the view (never -k), then kill the empty view
 * session(s). If any non-lobby window refuses to unlink, abort before the
 * kill — kill-session must only ever destroy the lobby.
 */
export async function closeView(name: string): Promise<CloseViewResult> {
  const session = viewSessionName(name);
  if (!(await hasSession(session))) throw new Error(`No such view: ${session}`);

  const lobbyResult = await tmux(["show-options", "-v", "-t", `=${session}:`, "@hive_view_lobby"], { reject: false });
  const lobbyId = lobbyResult.ok ? lobbyResult.stdout.trim() : "";

  // Grouped sessions share the window set; enumerate the whole group so the
  // final kill sweeps view-<name>-<n> clients too.
  const groupResult = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_group}"], { reject: false });
  const pairs = (groupResult.ok ? groupResult.stdout.split("\n").filter(Boolean) : []).map((line) => {
    const tab = line.indexOf("\t");
    return [tab >= 0 ? line.slice(0, tab) : line, tab >= 0 ? line.slice(tab + 1) : ""] as const;
  });
  const group = pairs.find(([s]) => s === session)?.[1] ?? "";
  const sessions = pairs
    .filter(([s, g]) => s === session || (group.length > 0 && g === group && s.startsWith(`${session}-`)))
    .map(([s]) => s);
  if (!sessions.includes(session)) sessions.unshift(session);

  const listResult = await tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"]);
  const windows = listResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

  let unlinked = 0;
  for (const windowId of windows) {
    if (windowId === lobbyId) continue;
    // Session-qualified window id: immune to renumber-windows shifting
    // indexes under the loop, and unambiguous about WHICH link is removed.
    const result = await tmux(["unlink-window", "-t", `=${session}:${windowId}`], { reject: false });
    if (!result.ok) {
      throw new Error(
        `Refusing to close ${session}: window ${windowId} would not unlink (${result.stderr.trim() || "last link?"}). ` +
          `It may be a bee whose own session is gone — re-attach it first: tmux attach -t ${session}`,
      );
    }
    unlinked += 1;
  }

  for (const s of sessions) {
    await tmux(["kill-session", "-t", `=${s}`], { reject: false });
  }
  return { sessions, unlinked };
}
