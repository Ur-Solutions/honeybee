/**
 * Shared link-window core (WORKSPACES_AND_QUESTS_PRD §7.4).
 *
 * The tmux mechanics underneath both `view` (ephemeral cockpits) and
 * `workspace` (persisted sessions): linking a bee's window into a host session
 * via `link-window` (a second handle, not a copy), de-duping by window id, the
 * BUILD-time placeholder shell create/kill, grouped-session creation for
 * independent focus, and the SAFE teardown.
 *
 * Hard invariant (carried verbatim from view.ts): closing a host session is
 * provably incapable of killing a bee. Teardown only ever calls unlink-window
 * WITHOUT -k, which tmux refuses when it would remove a window's last link — so
 * an orphaned bee (its home session gone) aborts the close rather than dying.
 * The one kill-window here is BUILD-time only, targeting the exact placeholder
 * window id we just created (single-linked, provably never a bee).
 *
 * This module is session-name-agnostic: it knows nothing about the `view-`/
 * `ws-` prefixes — callers pass a fully-formed session name.
 */
import { hasSession, tmux } from "./substrates/local-tmux.js";

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

export type EnsureLinkSessionResult = {
  /** True when this call created the session (so callers can land on the first bee). */
  created: boolean;
  /**
   * The throwaway placeholder window id, present only when `created` — tmux
   * requires a new session to own a window, so we spawn a shell to anchor it,
   * link the bees in, then kill that exact window. Empty when the session
   * already existed.
   */
  placeholder: string;
};

/**
 * Create `session` if missing (with a throwaway `hive` placeholder window so the
 * empty session is valid), or report that it already existed. The placeholder
 * is removed by `linkTargetsInto` once ≥1 real window has been linked.
 */
export async function ensureLinkSession(session: string): Promise<EnsureLinkSessionResult> {
  if (await hasSession(session)) return { created: false, placeholder: "" };
  await tmux(["new-session", "-d", "-s", session, "-n", "hive"]);
  const placeholder = (await tmux(["display-message", "-p", "-t", `=${session}:`, "#{window_id}"])).stdout.trim();
  return { created: true, placeholder };
}

export type LinkResult = {
  session: string;
  created: boolean;
  linked: string[];
  alreadyLinked: number;
};

/**
 * Link each target session's ACTIVE window into `session`, deduping by window id
 * (the placeholder never counts as "already linked"), then drop the placeholder
 * once ≥1 real window exists. Targets must be live sessions on the local server.
 *
 * This is the buildView body (view.ts:105-135), parameterized by session name.
 */
export async function linkTargetsInto(
  session: string,
  targets: string[],
  opts: EnsureLinkSessionResult,
): Promise<LinkResult> {
  const { created, placeholder } = opts;
  const fresh = await windowInventory();
  const bees: Array<{ session: string; windowId: string }> = [];
  for (const target of targets) {
    const windowId = fresh.active.get(target);
    if (windowId) bees.push({ session: target, windowId });
  }
  // Dedupe against windows already linked into the host; the placeholder is not
  // a bee, so it must never count as "already linked".
  const existing = (fresh.windows.get(session) ?? []).filter((id) => id !== placeholder);
  const plan = planLinks(existing, bees);

  const linked: string[] = [];
  for (const bee of plan) {
    await tmux(["link-window", "-s", bee.windowId, "-t", `=${session}:`]);
    linked.push(bee.session);
  }

  // Drop the placeholder now that real windows exist. kill-window targets the
  // exact id we created moments ago — single-linked, provably never a bee — so
  // it cannot affect any bee. Guarded on having linked ≥1 window so the session
  // is never emptied (which would auto-destroy it).
  if (placeholder && linked.length > 0) {
    await tmux(["kill-window", "-t", `=${session}:${placeholder}`], { reject: false });
  }

  // On first build, land on the first bee rather than wherever tmux left focus.
  if (created && plan[0]) {
    await tmux(["select-window", "-t", `=${session}:${plan[0].windowId}`], { reject: false });
  }

  return { session, created, linked, alreadyLinked: bees.length - plan.length };
}

/**
 * Link bee windows into an EXISTING session (no placeholder), deduping against
 * the session's current windows. For a single bee, optionally select it. This
 * is the linkHere body (view.ts:157-163), reused by `workspace add`.
 *
 * Returns the number of windows actually linked.
 */
export async function linkWindowsInto(
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

/** First free `<session>-<n>` grouped-session name (independent focus). */
export async function nextGroupedSessionName(session: string): Promise<string> {
  const result = await tmux(["list-sessions", "-F", "#{session_name}"], { reject: false });
  const taken = new Set(result.ok ? result.stdout.split("\n").map((s) => s.trim()) : []);
  for (let n = 2; ; n += 1) {
    const candidate = `${session}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Create a grouped session sharing `session`'s window set under an independent name. */
export async function createGroupedSession(session: string): Promise<string> {
  const grouped = await nextGroupedSessionName(session);
  await tmux(["new-session", "-d", "-t", `=${session}`, "-s", grouped]);
  return grouped;
}

/**
 * Enumerate the session group containing `session`: the session itself plus any
 * grouped `<session>-<n>` clients sharing its window set. Used so teardown
 * sweeps the grouped clients too (closeView:202-211).
 */
export async function groupSessions(session: string): Promise<string[]> {
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
  return sessions;
}

export type SafeUnlinkResult = {
  sessions: string[];
  unlinked: number;
};

/**
 * Unlink every window from `session` (never -k), then kill the (now-empty)
 * session(s), grouped clients included. If any window refuses to unlink, abort
 * before the kill: a refusal means that window's only link is this session — an
 * orphaned bee whose home session died — and we must never force it.
 *
 * This is the closeView body (view.ts:200-233), parameterized by session name;
 * the throw message is neutral so both `view` and `workspace` callers read it.
 */
export async function safeCloseLinkSession(session: string): Promise<SafeUnlinkResult> {
  // Grouped sessions share the window set; enumerate the whole group so the
  // final kill sweeps <session>-<n> clients too.
  const sessions = await groupSessions(session);

  const listResult = await tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"]);
  const windows = listResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

  let unlinked = 0;
  for (const windowId of windows) {
    // Session-qualified window id: immune to renumber-windows shifting indexes
    // under the loop, and unambiguous about WHICH link is removed.
    const result = await tmux(["unlink-window", "-t", `=${session}:${windowId}`], { reject: false });
    if (!result.ok) {
      throw new Error(
        `Refusing to close ${session}: window ${windowId} would not unlink (${result.stderr.trim() || "last link?"}). ` +
          `It is a bee whose own session is gone — re-attach it first: tmux attach -t ${session}`,
      );
    }
    unlinked += 1;
  }

  for (const s of sessions) {
    await tmux(["kill-session", "-t", `=${s}`], { reject: false });
  }
  return { sessions, unlinked };
}
