/**
 * `hive bees` — grouped, fuzzy-filtered fleet browser (TUI).
 *
 * Presentation-only: callers supply catalog rows; this module handles grouping,
 * fzf-style filtering, and raw-mode rendering (same discipline as cleanTui).
 */

import * as readline from "node:readline";
import { fuzzyFilter } from "./spawnTui.js";
import { bold, cyan, dim, gray, green, isPretty, red, stripAnsi, tildify, truncate, visibleLength, yellow } from "./format.js";

export type BeesTuiItem = {
  name: string;
  ref: string;
  displayName: string;
  colony: string;
  swarmId: string;
  agent: string;
  cwd: string;
  stateLabel: string;
  /** Live @hive_state when set; otherwise derived state label. */
  stateHeadline: string;
  detail: string;
  age: string;
  tmuxTarget: string;
  node?: string;
  live: boolean;
  /** pro facets resolved from cwd (absent when the cwd isn't under a pro repo). */
  proArea?: string;
  proProject?: string;
  proRepo?: string;
  /** Fuzzy index string (name, title, colony, swarm, agent, cwd, detail). */
  searchText: string;
};

export type BeesTuiGroup = {
  colony: string;
  swarmId: string;
  label: string;
  items: BeesTuiItem[];
};

export type BeesTuiSelectHandler = (item: BeesTuiItem) => void | Promise<void>;

export type RunBeesTuiOptions = {
  items: BeesTuiItem[];
  /** When true, Enter selects but the TUI keeps running (sidebar pane). */
  sidebar?: boolean;
  onSelect: BeesTuiSelectHandler;
  /**
   * Tab opens a large preview for the highlighted bee. The handler owns the
   * presentation (a tmux display-popup), so it blocks until the operator closes
   * it; the TUI re-renders afterward.
   */
  onPreview?: (item: BeesTuiItem) => void | Promise<void>;
  /** Initial grouping facet (default colony/swarm). */
  groupMode?: BeesGroupMode;
  /** Persist the grouping facet (global config) so every sidebar shares it. */
  onGroupChange?: (mode: BeesGroupMode) => void | Promise<void>;
  /**
   * Poll the shared grouping facet so other sidebars live-update when one of
   * them cycles it. Returning a different mode re-groups this instance.
   */
  syncGroupMode?: () => Promise<BeesGroupMode | undefined>;
  /** Kill a bee (Ctrl-K, after a confirm modal). Removes it from the list on ok. */
  onKill?: (item: BeesTuiItem) => Promise<{ ok: boolean; detail?: string }>;
};

const UNGROUPED_COLONY = "—";

/** Sort key: colonies alphabetically (ungrouped last), swarms, then attention-ish state. */
export function groupBeesTuiItems(items: BeesTuiItem[]): BeesTuiGroup[] {
  const byColony = new Map<string, BeesTuiItem[]>();
  for (const item of items) {
    const colony = item.colony.trim().length > 0 ? item.colony.trim() : UNGROUPED_COLONY;
    const bucket = byColony.get(colony) ?? [];
    bucket.push(item);
    byColony.set(colony, bucket);
  }

  const colonyNames = [...byColony.keys()].sort((a, b) => {
    if (a === UNGROUPED_COLONY) return 1;
    if (b === UNGROUPED_COLONY) return -1;
    return a.localeCompare(b);
  });

  const groups: BeesTuiGroup[] = [];
  for (const colony of colonyNames) {
    const colonyItems = byColony.get(colony) ?? [];
    const bySwarm = new Map<string, BeesTuiItem[]>();
    for (const item of colonyItems) {
      const swarm = item.swarmId.trim().length > 0 ? item.swarmId.trim() : "";
      const bucket = bySwarm.get(swarm) ?? [];
      bucket.push(item);
      bySwarm.set(swarm, bucket);
    }
    const swarmKeys = [...bySwarm.keys()].sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b);
    });
    for (const swarmId of swarmKeys) {
      const swarmItems = sortItemsForDisplay(bySwarm.get(swarmId) ?? []);
      const label = swarmId.length > 0 ? swarmLabel(colony, swarmId) : colonySoloLabel(colony);
      groups.push({ colony, swarmId, label, items: swarmItems });
    }
  }
  return groups;
}

/**
 * Grouping facets the operator can cycle through (Ctrl-G). `colony` keeps the
 * nested colony→swarm view; the rest are single-level. Workspaces and quests
 * slot in here once those land (see docs/WORKSPACES_AND_QUESTS_PRD.md): add the
 * mode, a record facet, and a case in groupBeesByMode.
 */
export type BeesGroupMode = "colony" | "pro-repo" | "pro-area" | "folder" | "type";

export const BEES_GROUP_MODES: BeesGroupMode[] = ["colony", "pro-repo", "pro-area", "folder", "type"];

export const BEES_GROUP_MODE_LABEL: Record<BeesGroupMode, string> = {
  colony: "colony/swarm",
  "pro-repo": "pro project/repo",
  "pro-area": "pro area",
  folder: "folder",
  type: "agent type",
};

export function nextBeesGroupMode(mode: BeesGroupMode, delta = 1): BeesGroupMode {
  const i = BEES_GROUP_MODES.indexOf(mode);
  const n = BEES_GROUP_MODES.length;
  return BEES_GROUP_MODES[(((i < 0 ? 0 : i) + delta) % n + n) % n]!;
}

/** Dispatch grouping by the active mode. */
export function groupBeesByMode(items: BeesTuiItem[], mode: BeesGroupMode): BeesTuiGroup[] {
  switch (mode) {
    case "colony":
      return groupBeesTuiItems(items);
    case "pro-repo":
      return groupBySingleFacet(
        items,
        (item) => (item.proProject && item.proRepo ? `${item.proProject}/${item.proRepo}` : ""),
        (item) => (item.proProject && item.proRepo ? `${item.proProject} · ${item.proRepo}` : "no pro repo"),
      );
    case "pro-area":
      return groupBySingleFacet(items, (item) => item.proArea ?? "", (item) => item.proArea || "no pro area");
    case "folder":
      return groupBySingleFacet(items, (item) => item.cwd ?? "", (item) => (item.cwd ? tildify(item.cwd) : "no folder"));
    case "type":
      return groupBySingleFacet(items, (item) => item.agent ?? "", (item) => item.agent || "no agent");
  }
}

/**
 * Group by a single derived key. Empty keys collapse into a trailing "—" bucket
 * so unclassified bees never vanish; named buckets sort alphabetically.
 */
function groupBySingleFacet(
  items: BeesTuiItem[],
  keyFn: (item: BeesTuiItem) => string,
  labelFn: (item: BeesTuiItem) => string,
): BeesTuiGroup[] {
  const buckets = new Map<string, { label: string; items: BeesTuiItem[] }>();
  for (const item of items) {
    const key = keyFn(item).trim();
    const bucket = buckets.get(key) ?? { label: labelFn(item), items: [] };
    bucket.items.push(item);
    buckets.set(key, bucket);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
  return keys.map((key) => ({
    colony: "",
    swarmId: "",
    label: buckets.get(key)!.label,
    items: sortItemsForDisplay(buckets.get(key)!.items),
  }));
}

function swarmLabel(colony: string, swarmId: string): string {
  if (colony === UNGROUPED_COLONY) return `@${swarmId}`;
  return `${colony} · @${swarmId}`;
}

function colonySoloLabel(colony: string): string {
  return colony === UNGROUPED_COLONY ? "ungrouped" : `${colony} · solo`;
}

const STATE_RANK: Record<string, number> = {
  waiting: 0,
  blocked: 1,
  ready: 2,
  active: 3,
  working: 3,
  done: 4,
  idle_with_output: 4,
  sealed: 5,
  booting: 6,
  error: 7,
  dead: 8,
};

function sortItemsForDisplay(items: BeesTuiItem[]): BeesTuiItem[] {
  return [...items].sort((a, b) => {
    const ra = STATE_RANK[a.stateLabel] ?? 50;
    const rb = STATE_RANK[b.stateLabel] ?? 50;
    if (ra !== rb) return ra - rb;
    return a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name);
  });
}

export function beesTuiFuzzyKey(item: BeesTuiItem): string {
  return item.searchText;
}

type FlatRow =
  | { kind: "header"; label: string }
  | { kind: "item"; item: BeesTuiItem; itemIndex: number };

export function flattenBeesTuiGroups(groups: BeesTuiGroup[]): FlatRow[] {
  const rows: FlatRow[] = [];
  let itemIndex = 0;
  for (const group of groups) {
    rows.push({ kind: "header", label: group.label });
    for (const item of group.items) {
      rows.push({ kind: "item", item, itemIndex });
      itemIndex += 1;
    }
  }
  return rows;
}

export function filterBeesTuiItems(items: BeesTuiItem[], query: string): BeesTuiItem[] {
  return fuzzyFilter(query, items, beesTuiFuzzyKey);
}

function stateCell(headline: string, live: boolean): string {
  const h = headline.toLowerCase();
  if (h === "working" || h === "active") return `${green("●")} ${truncate(headline, 8)}`;
  if (h === "waiting" || h === "ready" || h === "blocked") return `${yellow("●")} ${truncate(headline, 8)}`;
  if (h === "failed" || h === "error") return `${red("●")} ${truncate(headline, 8)}`;
  if (!live) return `${dim("○")} ${dim(truncate(headline, 8))}`;
  return `${dim("●")} ${truncate(headline, 8)}`;
}

function stateGlyph(headline: string, live: boolean): string {
  const h = headline.toLowerCase();
  if (h === "working" || h === "active") return green("●");
  if (h === "waiting" || h === "ready" || h === "blocked") return yellow("●");
  if (h === "failed" || h === "error") return red("●");
  if (!live) return dim("○");
  return dim("●");
}

function reverse(text: string): string {
  return isPretty() ? `\x1b[7m${text}\x1b[0m` : text;
}

export async function runBeesTui(options: RunBeesTuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hive bees requires a TTY. Bind it to a tmux pane or run interactively.");
  }
  if (options.items.length === 0) {
    throw new Error("No bees to show. Spawn one with: hive spawn <bee>");
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRaw = stdin.isRaw;
  let catalog = [...options.items];
  let query = "";
  let groupMode: BeesGroupMode = options.groupMode ?? "colony";
  let filtered = catalog;
  let groups = groupBeesByMode(filtered, groupMode);
  let flat = flattenBeesTuiGroups(groups);
  let cursor = firstItemRowIndex(flat);
  let scroll = 0;
  let confirmKill: BeesTuiItem | undefined; // bee awaiting kill confirmation
  let killing = false;
  let message = "type to filter · ↑↓ move · enter selects · q quits";

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[?25l");

  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    stdout.write("\x1b[?25h\x1b[?1049l");
    stdin.setRawMode(previousRaw);
    stdin.pause();
  };
  const onSignal = (signal: NodeJS.Signals) => {
    restoreTerminal();
    process.exit(signal === "SIGTERM" ? 143 : 129);
  };
  process.once("exit", restoreTerminal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  try {
    await new Promise<void>((resolve) => {
      let done = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (pollTimer) clearInterval(pollTimer);
        stdin.off("keypress", onKey);
        stdout.off("resize", onResize);
        resolve();
      };

      const itemRows = () => flat.filter((row): row is Extract<FlatRow, { kind: "item" }> => row.kind === "item");

      const moveCursor = (next: number) => {
        const items = itemRows();
        if (items.length === 0) {
          cursor = 0;
          return;
        }
        const indices = items.map((row) => flat.indexOf(row));
        let pos = indices.indexOf(cursor);
        if (pos < 0) pos = 0;
        pos = Math.max(0, Math.min(indices.length - 1, next));
        cursor = indices[pos]!;
      };

      const currentItem = (): BeesTuiItem | undefined => {
        const row = flat[cursor];
        return row?.kind === "item" ? row.item : undefined;
      };

      const regroup = () => {
        filtered = query.length > 0 ? filterBeesTuiItems(catalog, query) : catalog;
        groups = groupBeesByMode(filtered, groupMode);
        flat = flattenBeesTuiGroups(groups);
        cursor = firstItemRowIndex(flat);
        scroll = 0;
      };

      const applyQuery = (next: string) => {
        query = next;
        regroup();
        const n = itemRows().length;
        message = n === 0 ? "no matches" : n === 1 ? "1 bee" : `${n} bees`;
      };

      const cycleGroup = (delta: number) => {
        groupMode = nextBeesGroupMode(groupMode, delta);
        regroup();
        message = `group: ${BEES_GROUP_MODE_LABEL[groupMode]}`;
        render();
        void options.onGroupChange?.(groupMode);
      };

      const onSelect = async () => {
        const item = currentItem();
        if (!item) return;
        try {
          await options.onSelect(item);
          message = `→ ${item.displayName}`;
          if (!options.sidebar) finish();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
      };

      const step = (delta: number) => {
        const indices = itemRows().map((row) => flat.indexOf(row));
        const pos = indices.indexOf(cursor);
        moveCursor(pos < 0 ? 0 : Math.max(0, Math.min(indices.length - 1, pos + delta)));
        render();
      };

      const openPreview = async () => {
        if (!options.onPreview) { message = "preview unavailable here"; render(); return; }
        const item = currentItem();
        if (!item) return;
        message = `preview: ${item.displayName || item.ref}`;
        render();
        try {
          await options.onPreview(item); // blocks until the popup closes
        } catch (error) {
          if (done) return;
          message = error instanceof Error ? error.message : String(error);
        }
        if (!done) render();
      };

      const requestKill = () => {
        if (!options.onKill) { message = "kill unavailable here"; render(); return; }
        const item = currentItem();
        if (!item) return;
        confirmKill = item;
        render();
      };

      const performKill = async (item: BeesTuiItem) => {
        if (!options.onKill || killing) return;
        killing = true;
        confirmKill = undefined;
        message = `killing ${item.displayName || item.ref}…`;
        render();
        try {
          const result = await options.onKill(item);
          if (done) return;
          if (result.ok) {
            catalog = catalog.filter((c) => c.name !== item.name);
            regroup();
            message = `killed ${item.displayName || item.ref}`;
          } else {
            message = result.detail || "kill failed";
          }
        } catch (error) {
          if (done) return;
          message = error instanceof Error ? error.message : String(error);
        } finally {
          killing = false;
          if (!done) render();
        }
      };

      const onKey = (_value: string, key: readline.Key) => {
        if (key.ctrl && key.name === "c") {
          finish();
          return;
        }
        // Kill confirmation modal owns all input while open.
        if (confirmKill) {
          if (killing) return;
          if (key.name === "y" || key.name === "return" || key.name === "enter") {
            void performKill(confirmKill);
          } else {
            confirmKill = undefined;
            message = "kill cancelled";
            render();
          }
          return;
        }
        if (key.name === "escape") {
          if (query.length > 0) {
            applyQuery("");
            render();
            return;
          }
          finish();
          return;
        }
        if (key.name === "q" && query.length === 0) {
          finish();
          return;
        }
        // Navigation is arrow-keys (plus fzf-style Ctrl-N/P) only — j/k are kept
        // free so they type into the fuzzy filter like any other character.
        if (key.name === "up" || (key.ctrl && key.name === "p")) { step(-1); return; }
        if (key.name === "down" || (key.ctrl && key.name === "n")) { step(1); return; }
        // ⌘g (Meta-g via WezTerm) cycles grouping; Ctrl-G works too where ⌘
        // isn't mapped; Shift-Tab cycles backward.
        if ((key.meta || key.ctrl) && key.name === "g") { cycleGroup(1); return; }
        if (key.ctrl && key.name === "k") { requestKill(); return; }
        if (key.name === "tab" && key.shift) { cycleGroup(-1); return; }
        if (key.name === "tab") { void openPreview(); return; }
        if (key.name === "return" || key.name === "enter") {
          void onSelect();
          render();
          return;
        }
        if (key.name === "backspace") {
          applyQuery(query.slice(0, -1));
          render();
          return;
        }
        if (_value && !key.ctrl && !key.meta) {
          applyQuery(query + _value);
          render();
        }
      };

      const render = () => {
        if (done) return;
        const width = Math.max(12, stdout.columns || 80);
        const height = Math.max(8, stdout.rows || 24);
        const bodyRows = Math.max(2, height - 5);
        scroll = Math.min(scroll, Math.max(0, flat.length - bodyRows));
        if (cursor < scroll) scroll = cursor;
        if (cursor >= scroll + bodyRows) scroll = cursor - bodyRows + 1;
        const matchCount = itemRows().length;
        const lines = [
          renderTitle(width, catalog.length, query, matchCount),
          renderHelp(width),
          "",
        ];
        if (confirmKill) {
          lines.push(...renderKillModal(confirmKill, bodyRows, width, killing));
        } else {
          const visible = flat.slice(scroll, scroll + bodyRows);
          for (let i = 0; i < visible.length; i += 1) lines.push(renderFlatRow(visible[i]!, scroll + i, cursor, width));
          for (let i = visible.length; i < bodyRows; i += 1) lines.push("");
        }
        lines.push(truncate(message, width));
        lines.push(dim(footerHint()));
        stdout.write(`\x1b[2J\x1b[H${lines.map((line) => truncate(line, width)).join("\n")}`);
      };

      const footerHint = (): string => {
        if (confirmKill) return "y kill · n / esc cancel";
        const preview = options.onPreview ? " · tab preview" : "";
        const kill = options.onKill ? " · ^k kill" : "";
        const group = ` · ⌘g ${BEES_GROUP_MODE_LABEL[groupMode]}`;
        return (options.sidebar ? "sidebar · q closes" : "q exit") + preview + kill + group;
      };

      const onResize = () => render();

      render();
      stdin.on("keypress", onKey);
      stdout.on("resize", onResize);
      if (options.syncGroupMode) {
        pollTimer = setInterval(() => {
          void options.syncGroupMode!().then((mode) => {
            if (done || !mode || mode === groupMode) return;
            groupMode = mode;
            regroup();
            render();
          });
        }, 1500);
      }
    });
  } finally {
    process.off("exit", restoreTerminal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    restoreTerminal();
  }
}

function renderTitle(width: number, total: number, query: string, matchCount: number): string {
  const search = query.length > 0 ? `/${query}` : "/";
  if (width < 24) return `${bold("bees")} ${cyan(truncate(search, Math.max(1, width - 7)))}`;
  if (width < 36) return `${bold("hive bees")} ${dim(String(matchCount))} ${cyan(truncate(search, Math.max(1, width - 14)))}`;
  return `${bold("hive bees")}  ${dim(`${total} in hive`)}  ${cyan(truncate(search, Math.max(1, width - 28)))}  ${dim(`${matchCount} shown`)}`;
}

function renderHelp(width: number): string {
  if (width < 24) return dim("type / enter");
  if (width < 40) return dim("type filters · ↑↓ · enter");
  return dim("Colony · swarm groups · live state. ↑↓ move, type filters, tab previews, enter opens.");
}

function firstItemRowIndex(flat: FlatRow[]): number {
  const idx = flat.findIndex((row) => row.kind === "item");
  return idx >= 0 ? idx : 0;
}

function renderFlatRow(row: FlatRow, index: number, cursor: number, width: number): string {
  if (row.kind === "header") {
    if (width < 20) return dim(truncate(row.label, width));
    return dim(`── ${truncate(row.label, Math.max(1, width - 4))} ${"─".repeat(Math.max(0, width - visibleLength(row.label) - 4))}`);
  }
  const isCurrent = index === cursor;
  const pointer = isCurrent ? cyan("›") : " ";
  const title = row.item.displayName.length > 0 ? row.item.displayName : row.item.ref;
  let line: string;
  if (width < 24) {
    line = `${pointer} ${stateGlyph(row.item.stateHeadline, row.item.live)} ${truncate(title, Math.max(1, width - 5))}`;
  } else if (width < 38) {
    line = `${pointer} ${stateGlyph(row.item.stateHeadline, row.item.live)} ${truncate(row.item.ref, 8)} ${truncate(title, Math.max(1, width - 14))}`;
  } else {
    const state = stateCell(row.item.stateHeadline, row.item.live);
    const meta = [
      pointer,
      pad(truncate(row.item.ref, 10), 10),
      pad(state, 12),
      truncate(title, Math.max(8, Math.min(22, width - 50))),
    ].join(" ");
    const tail = truncate(row.item.detail || row.item.agent, Math.max(1, width - visibleLength(stripAnsi(meta)) - 2));
    line = `${meta} ${dim(tail)}`;
  }
  const fitted = truncate(line, width);
  return isCurrent ? reverse(stripAnsi(fitted)) : fitted;
}

function renderKillModal(item: BeesTuiItem, rows: number, width: number, killing: boolean): string[] {
  const name = item.displayName || item.ref;
  const inner = [
    red(bold(`Kill ${truncate(name, Math.max(8, width - 12))}?`)),
    "",
    dim(truncate(`${item.ref}  ${item.agent}  ${item.stateHeadline}`, width - 4)),
    dim(truncate(item.cwd, width - 4)),
    "",
    "This ends the bee's tmux session and drops it from the hive.",
    "",
    killing ? dim("killing…") : `${red(bold("[y]"))} kill    ${dim("[n] / esc cancel")}`,
  ];
  const out: string[] = [];
  const pad = Math.max(0, Math.floor((rows - inner.length) / 2));
  for (let i = 0; i < pad; i += 1) out.push("");
  for (const line of inner) out.push(`  ${truncate(line, width - 2)}`);
  while (out.length < rows) out.push("");
  return out.slice(0, rows);
}

function pad(value: string, size: number, align: "left" | "right" = "left"): string {
  const len = visibleLength(value);
  if (len >= size) return value;
  const padStr = " ".repeat(size - len);
  return align === "right" ? padStr + value : value + padStr;
}

/** Build the fuzzy search corpus for a catalog row. */
export function beesTuiSearchText(parts: {
  name: string;
  displayName: string;
  colony?: string;
  swarmId?: string;
  agent: string;
  cwd: string;
  detail: string;
  ref: string;
}): string {
  return [
    parts.name,
    parts.displayName,
    parts.ref,
    parts.colony ?? "",
    parts.swarmId ? `@${parts.swarmId}` : "",
    parts.agent,
    parts.cwd,
    parts.detail,
  ]
    .join(" ")
    .toLowerCase();
}
