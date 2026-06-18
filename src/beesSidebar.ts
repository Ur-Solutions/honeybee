/**
 * tmux left sidebar for `hive bees`: split wiring and persistence.
 *
 * A global `@hive_bees_sidebar_width` option remembers that the operator wants
 * the strip; `syncBeesSidebarLayout` re-materializes it on the active window
 * after switch-client / --here linking moves focus.
 */

import { LOCAL_NODE_NAME } from "./node.js";
import { substrateFor } from "./substrates/index.js";
import { formatShellCommand, tmux } from "./tmux.js";
import type { SessionRecord } from "./store.js";
import { BEES_GROUP_MODES, type BeesGroupMode } from "./beesTui.js";

export const BEES_NAV_PANE_OPTION = "@hive_bees_nav";
export const BEES_SIDEBAR_WIDTH_OPTION = "@hive_bees_sidebar_width";
export const BEES_GROUP_OPTION = "@hive_bees_group";

const DEFAULT_SIDEBAR_WIDTH = 54;
const MIN_SIDEBAR_WIDTH = 12;
const MAX_SIDEBAR_WIDTH = 72;

export function clampSidebarWidth(width: number | undefined): number {
  const raw = width ?? DEFAULT_SIDEBAR_WIDTH;
  if (!Number.isFinite(raw)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(raw)));
}

type PaneRow = { paneId: string; nav: boolean };

async function currentWindowTarget(): Promise<string> {
  const result = await tmux(["display-message", "-p", "#{session_name}:#{window_index}"]);
  const target = result.stdout.trim();
  if (!target || !target.includes(":")) throw new Error("Could not resolve the current tmux window");
  return target;
}

async function listWindowPanes(windowTarget: string): Promise<PaneRow[]> {
  const format = "#{pane_id}\t#{@hive_bees_nav}";
  const result = await tmux(["list-panes", "-t", windowTarget, "-F", format], { reject: false });
  if (!result.ok) return [];
  const rows: PaneRow[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, navRaw] = line.split("\t");
    if (!paneId) continue;
    rows.push({ paneId, nav: navRaw === "1" });
  }
  return rows;
}

async function listAllNavPanes(): Promise<string[]> {
  const format = "#{pane_id}\t#{@hive_bees_nav}";
  const result = await tmux(["list-panes", "-a", "-F", format], { reject: false });
  if (!result.ok) return [];
  const panes: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, navRaw] = line.split("\t");
    if (paneId && navRaw === "1") panes.push(paneId);
  }
  return panes;
}

async function setPaneOption(paneId: string, key: string, value: string): Promise<void> {
  await tmux(["set-option", "-p", "-t", paneId, key, value], { reject: false });
}

async function readGlobalSidebarWidth(): Promise<number | undefined> {
  const result = await tmux(["show-option", "-gv", BEES_SIDEBAR_WIDTH_OPTION], { reject: false });
  if (!result.ok) return undefined;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? clampSidebarWidth(value) : undefined;
}

async function setGlobalSidebarWidth(width: number | undefined): Promise<void> {
  if (width === undefined) {
    await tmux(["set-option", "-gu", BEES_SIDEBAR_WIDTH_OPTION], { reject: false });
    return;
  }
  await tmux(["set-option", "-g", BEES_SIDEBAR_WIDTH_OPTION, String(clampSidebarWidth(width))], { reject: false });
}

/** The grouping facet is global config so every sidebar shares it and it persists. */
export async function readBeesGroupMode(): Promise<BeesGroupMode | undefined> {
  if (!process.env.TMUX) return undefined;
  const result = await tmux(["show-option", "-gv", BEES_GROUP_OPTION], { reject: false });
  if (!result.ok) return undefined;
  const value = result.stdout.trim();
  return (BEES_GROUP_MODES as string[]).includes(value) ? (value as BeesGroupMode) : undefined;
}

export async function writeBeesGroupMode(mode: BeesGroupMode): Promise<void> {
  if (!process.env.TMUX) return;
  await tmux(["set-option", "-g", BEES_GROUP_OPTION, mode], { reject: false });
}

function hiveBeesSidebarCommand(): string {
  if (process.env.HIVE_BEES_SIDEBAR_COMMAND) return process.env.HIVE_BEES_SIDEBAR_COMMAND;
  const argv0 = process.argv[1];
  if (argv0 && (argv0.endsWith("cli.ts") || argv0.endsWith("cli.js"))) {
    return formatShellCommand([process.execPath, argv0, "bees", "--sidebar"]);
  }
  return formatShellCommand(["hive", "bees", "--sidebar"]);
}

async function killPaneBestEffort(paneId: string): Promise<void> {
  await tmux(["kill-pane", "-t", paneId], { reject: false });
}

async function openNavPane(windowTarget: string, width: number, command = hiveBeesSidebarCommand()): Promise<string | undefined> {
  const result = await tmux(
    // -f makes this a full-window split, not a split of whichever pane happened
    // to be active. That keeps the sidebar rooted to the left edge.
    ["split-window", "-h", "-f", "-b", "-d", "-l", String(width), "-P", "-F", "#{pane_id}", "-t", windowTarget, command],
    { reject: false },
  );
  const paneId = result.ok ? result.stdout.trim() : "";
  if (!paneId) return undefined;
  await setPaneOption(paneId, BEES_NAV_PANE_OPTION, "1");
  return paneId;
}

async function removeOtherNavPanes(keepPaneId: string | undefined): Promise<void> {
  for (const paneId of await listAllNavPanes()) {
    if (keepPaneId && paneId === keepPaneId) continue;
    await killPaneBestEffort(paneId);
  }
}

export async function toggleBeesSidebar(requestedWidth?: number): Promise<"opened" | "closed"> {
  if (!process.env.TMUX) throw new Error("hive bees --toggle-sidebar must run inside tmux");
  const windowTarget = await currentWindowTarget();
  const panes = await listWindowPanes(windowTarget);
  const nav = panes.find((pane) => pane.nav);
  if (nav) {
    await removeOtherNavPanes(undefined);
    await setGlobalSidebarWidth(undefined);
    return "closed";
  }
  const width = clampSidebarWidth(requestedWidth ?? (await readGlobalSidebarWidth()));
  const paneId = await openNavPane(windowTarget, width);
  if (!paneId) throw new Error("Failed to open bees sidebar pane");
  await setGlobalSidebarWidth(width);
  await removeOtherNavPanes(paneId);
  await tmux(["select-pane", "-t", paneId], { reject: false });
  return "opened";
}

/**
 * If the operator previously enabled the sidebar, ensure the active window has
 * a nav strip (idempotent).
 */
export async function syncBeesSidebarLayout(
  opts: { pruneOthers?: boolean; windowTarget?: string; width?: number } = {},
): Promise<string | undefined> {
  const width = opts.width ?? (await readGlobalSidebarWidth());
  if (width === undefined) return undefined;
  // An explicit window target works against the server with no attached client
  // (so we can pre-build the strip before attaching from outside tmux). Without
  // one we need display-message, which requires a client.
  let windowTarget = opts.windowTarget;
  if (!windowTarget) {
    if (!process.env.TMUX) return undefined;
    windowTarget = await currentWindowTarget();
  }
  const panes = await listWindowPanes(windowTarget);
  let navPaneId = panes.find((pane) => pane.nav)?.paneId;
  if (!navPaneId) navPaneId = await openNavPane(windowTarget, width);
  if (navPaneId) {
    for (const pane of panes) {
      if (pane.nav && pane.paneId !== navPaneId) await killPaneBestEffort(pane.paneId);
    }
    if (opts.pruneOthers) await removeOtherNavPanes(navPaneId);
  }
  return navPaneId;
}

/** Switch to a bee and keep the sidebar strip on the new session's window. */
export async function showBeeBesideSidebar(record: SessionRecord): Promise<void> {
  if (!process.env.TMUX) {
    const { attachSession } = await import("./tmux.js");
    await attachSession(record.tmuxTarget);
    return;
  }
  // A sidebar is active (we're in it), so make sure the global width is set —
  // the strip must materialize on the destination window even if the operator
  // launched via `hive bees --sidebar` rather than the toggle.
  let width = await readGlobalSidebarWidth();
  if (width === undefined) {
    width = DEFAULT_SIDEBAR_WIDTH;
    await setGlobalSidebarWidth(width);
  }

  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  if (!isLocal) {
    await substrateFor(record).attachSession(record.tmuxTarget);
    // pruneOthers:false — selecting a bee from the sidebar must not kill the
    // sidebar pane the picker is running in. Each window keeps its own strip.
    await syncBeesSidebarLayout({ pruneOthers: false, width });
    return;
  }
  await switchClientToBee(record);
  // Pin the strip onto the BEE's window explicitly (not the caller's pane).
  const beeWindow = record.agentPaneId ? await windowTargetForPane(record.agentPaneId) : undefined;
  await syncBeesSidebarLayout({ pruneOthers: false, windowTarget: beeWindow, width });
  await selectBeePane(record);
}

/**
 * Outside tmux: pre-build the sidebar on the bee's window (against the server,
 * no client needed), enable it by default, then attach the bee's session so the
 * operator lands inside tmux with the strip already up and the bee focused.
 */
export async function attachBeeWithSidebar(record: SessionRecord): Promise<void> {
  let width = await readGlobalSidebarWidth();
  if (width === undefined) {
    width = DEFAULT_SIDEBAR_WIDTH;
    await setGlobalSidebarWidth(width);
  }
  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  if (isLocal) {
    const beeWindow = record.agentPaneId ? await windowTargetForPane(record.agentPaneId) : `=${record.tmuxTarget}`;
    await syncBeesSidebarLayout({ pruneOthers: false, windowTarget: beeWindow, width });
    await selectBeePane(record);
  }
  await substrateFor(record).attachSession(record.tmuxTarget);
}

async function switchClientToBee(record: SessionRecord): Promise<void> {
  const target = record.agentPaneId ? await windowTargetForPane(record.agentPaneId) : undefined;
  await tmux(["switch-client", "-t", target ?? `=${record.tmuxTarget}`], { reject: false });
  await selectBeePane(record);
}

async function selectBeePane(record: SessionRecord): Promise<void> {
  if (!record.agentPaneId) return;
  await tmux(["select-pane", "-t", record.agentPaneId], { reject: false });
}

async function windowTargetForPane(paneId: string): Promise<string | undefined> {
  const result = await tmux(["display-message", "-p", "-t", paneId, "#{session_name}:#{window_index}"], { reject: false });
  const target = result.ok ? result.stdout.trim() : "";
  return target.includes(":") ? target : undefined;
}

/** @internal test helper */
export function __testOnlySidebarWidthClamp(width: number): number {
  return clampSidebarWidth(width);
}

/** @internal test helper */
export async function __testOnlyOpenNavPane(windowTarget: string, width: number, command: string): Promise<string | undefined> {
  return openNavPane(windowTarget, width, command);
}
