/**
 * Colony cockpits: ephemeral tmux sessions ("view-<name>") whose windows are
 * link-window references to live bees' windows. Windows are server-level
 * objects — a link is a second handle, not a copy — so a view renders many
 * bees in one session without touching their lifecycle.
 *
 * Hard invariant: closing a view is provably incapable of killing a bee.
 * --close only ever calls unlink-window WITHOUT -k, which tmux refuses when it
 * would remove a window's last link — so an orphaned bee (its home session
 * gone) aborts the close rather than dying. A bee window otherwise always keeps
 * its home link, so unlinking it from a view just drops the view's handle.
 *
 * The mechanics live in src/tmuxLink.ts (the §7.4 shared link-window core,
 * which `workspace` also consumes). This module is the thin, view-specific
 * surface over it: the `view-` prefix, name derivation, and the ephemeral
 * cockpit semantics. The safe-unlink invariant is enforced in tmuxLink.ts and
 * preserved byte-for-byte for both consumers.
 *
 * Views are tmux-derived and ephemeral: no store records, invisible to
 * selectors/clean (those only operate on store records).
 */
import { hasSession, tmux } from "./substrates/local-tmux.js";
import {
  createGroupedSession,
  ensureLinkSession,
  linkTargetsInto,
  linkWindowsInto,
  nextGroupedSessionName,
  parseWindowInventory,
  planLinks,
  safeCloseLinkSession,
  windowInventory,
  type WindowInventory,
} from "./tmuxLink.js";

export const VIEW_PREFIX = "view-";

// Re-export the pure/shared core under view's historical names so existing
// importers (tests/view.test.ts) keep resolving the same symbols.
export { parseWindowInventory, windowInventory };
export type { WindowInventory };
export const planViewLinks = planLinks;

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
  const ensured = await ensureLinkSession(session);
  return linkTargetsInto(session, targets, ensured);
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

/** First free `view-<name>-<n>` grouped-session name (independent focus). */
export async function groupedViewSessionName(name: string): Promise<string> {
  return nextGroupedSessionName(viewSessionName(name));
}

export async function createGroupedView(name: string): Promise<string> {
  return createGroupedSession(viewSessionName(name));
}

export type CloseViewResult = {
  sessions: string[];
  unlinked: number;
};

/**
 * Unlink every window from the view (never -k), then kill the (now-empty) view
 * session(s). If any window refuses to unlink, abort before the kill: a refusal
 * means that window's only link is this view — an orphaned bee whose home
 * session died — and we must never force it.
 */
export async function closeView(name: string): Promise<CloseViewResult> {
  const session = viewSessionName(name);
  if (!(await hasSession(session))) throw new Error(`No such view: ${session}`);
  return safeCloseLinkSession(session);
}
