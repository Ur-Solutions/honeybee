/**
 * `hive bees` — grouped, fuzzy-filtered fleet browser (TUI).
 *
 * Presentation-only: callers supply catalog rows; this module handles grouping,
 * fzf-style filtering, and raw-mode rendering (same discipline as cleanTui).
 */

import type * as readline from "node:readline";
import { fuzzyFilter } from "./spawnTui.js";
import { bold, cyan, dim, gray, green, isPretty, red, stripAnsi, tildify, truncate, visibleLength, yellow } from "./format.js";
import { createTuiPainter } from "./tuiPaint.js";
import { reverse } from "./tuiKit.js";
import { runRawModeTui } from "./tuiRuntime.js";
import type { ProSlotKind } from "./proProjects.js";

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
  /**
   * When the cwd lives in a pro worktree/checkout rather than the canonical
   * repo, the slot kind and name. The bee still groups under its pro
   * project/repo (proProject/proRepo); this just tags the row so two bees in the
   * same repo's different slots are distinguishable.
   */
  proSlotKind?: ProSlotKind;
  proSlotName?: string;
  /**
   * Checkout-pool member attribution (from SessionRecord.poolKey/poolMember —
   * never re-derived), e.g. "core-3". Upgrades the slot glyph to `⎇ core-3` so
   * pool bees read apart from ad-hoc checkout bees at a glance.
   */
  poolMemberLabel?: string;
  /** Fuzzy index string (name, title, colony, swarm, agent, cwd, detail, slot). */
  searchText: string;
};

export type BeesTuiGroup = {
  colony: string;
  swarmId: string;
  label: string;
  items: BeesTuiItem[];
};

/**
 * A stable fingerprint of the rendering-relevant fields of a catalog. The
 * sidebar polls a fresh catalog and only re-groups/re-renders when this changes,
 * so a rename, spawn, kill, or state change shows up live without churning the
 * display on every tick. `age` is intentionally excluded — it drifts every
 * minute and isn't worth a forced redraw mid-interaction.
 */
export function beesCatalogSignature(items: BeesTuiItem[]): string {
  return items
    .map((i) => [i.name, i.displayName, i.stateHeadline, i.detail, i.colony, i.swarmId, i.live ? "1" : "0"].join(""))
    .join("");
}

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
  /**
   * Checkout-pool capacity strip rendered under the header (e.g.
   * "pools: core 4/6 · 2 busy | fleet 0/3 (will extend)"). Static per launch;
   * absent (or a narrow sidebar) hides the row.
   */
  poolsLine?: string;
  /** Initial grouping facet (default colony/swarm). */
  groupMode?: BeesGroupMode;
  /** Persist the grouping facet (global config) so every sidebar shares it. */
  onGroupChange?: (mode: BeesGroupMode) => void | Promise<void>;
  /**
   * Poll the shared grouping facet so other sidebars live-update when one of
   * them cycles it. Returning a different mode re-groups this instance.
   */
  syncGroupMode?: () => Promise<BeesGroupMode | undefined>;
  /**
   * Reload the catalog from the store so renames, spawns, kills, and state
   * changes surface live. Polled on the same cadence as syncGroupMode (every
   * other tick); the TUI diffs via {@link beesCatalogSignature} and only
   * re-groups/re-renders when something actually changed, preserving the cursor
   * and active filter.
   */
  refreshItems?: () => Promise<BeesTuiItem[]>;
  /** Kill a bee (Ctrl-K, after a confirm modal). Removes it from the list on ok. */
  onKill?: (item: BeesTuiItem) => Promise<{ ok: boolean; detail?: string }>;
  /**
   * The bee whose tmux window this strip lives beside (sidebar). Its row starts
   * selected and carries a "you are here" marker so each window's fresh sidebar
   * lands on the bee it sits next to rather than the top of the list. Matched by
   * `BeesTuiItem.name`; undefined → first item, no marker.
   */
  currentName?: string;
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
  wedged: 7,
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

/** One typing burst costs one fuzzy pass instead of one per keystroke. */
export const BEES_FILTER_DEBOUNCE_MS = 24;

/**
 * True when the matches for `next` can be found by re-filtering the matches of
 * a previous pass for `prev` instead of the whole catalog. That needs "matches
 * next ⇒ matches prev", which holds for a prefix extension — except that
 * fuzzyScore's sparse-match cap is max(8, 2·len), so past 4 effective chars the
 * cap grows with the query and an item rejected for the prefix can legally
 * match the longer query. Short queries are also exactly where the full scan is
 * expensive (most matches, biggest sort).
 */
export function canNarrowBeesFilter(prev: string, next: string): boolean {
  const p = prev.trim().toLowerCase();
  const n = next.trim().toLowerCase();
  return p.length > 0 && n.length <= 4 && n.length > p.length && n.startsWith(p);
}

function stateCell(headline: string, live: boolean): string {
  const h = headline.toLowerCase();
  if (h === "working" || h === "active") return `${green("●")} ${truncate(headline, 8)}`;
  if (h === "waiting" || h === "ready" || h === "blocked") return `${yellow("●")} ${truncate(headline, 8)}`;
  if (h === "wedged") return `${red("⊘")} ${truncate(headline, 8)}`;
  if (h === "failed" || h === "error") return `${red("●")} ${truncate(headline, 8)}`;
  if (!live) return `${dim("○")} ${dim(truncate(headline, 8))}`;
  return `${dim("●")} ${truncate(headline, 8)}`;
}

function stateGlyph(headline: string, live: boolean): string {
  const h = headline.toLowerCase();
  if (h === "working" || h === "active") return green("●");
  if (h === "waiting" || h === "ready" || h === "blocked") return yellow("●");
  if (h === "wedged") return red("⊘");
  if (h === "failed" || h === "error") return red("●");
  if (!live) return dim("○");
  return dim("●");
}

export async function runBeesTui(options: RunBeesTuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hive bees requires a TTY. Bind it to a tmux pane or run interactively.");
  }
  if (options.items.length === 0) {
    throw new Error("No bees to show. Spawn one with: hive spawn <bee>");
  }

  const stdout = process.stdout;
  let catalog = [...options.items];
  let query = "";
  let groupMode: BeesGroupMode = options.groupMode ?? "colony";
  let filtered = catalog;
  let groups = groupBeesByMode(filtered, groupMode);
  let flat = flattenBeesTuiGroups(groups);
  let cursor = initialBeesCursor(flat, options.currentName);
  let scroll = 0;
  let confirmKill: BeesTuiItem | undefined; // bee awaiting kill confirmation
  let killing = false;
  let selecting: BeesTuiItem | undefined;
  let message = "type to filter · ↑↓ move · enter selects · esc quits";

  return runRawModeTui<void>((tui) => {
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let filterTimer: ReturnType<typeof setTimeout> | undefined;
    tui.defer(() => {
      if (pollTimer) clearInterval(pollTimer);
      if (filterTimer) clearTimeout(filterTimer);
    });
    const finish = () => tui.finish();

    const itemRows = () => flat.filter((row): row is Extract<FlatRow, { kind: "item" }> => row.kind === "item");

    const currentItem = (): BeesTuiItem | undefined => {
      const row = flat[cursor];
      return row?.kind === "item" ? row.item : undefined;
    };

    // The match set of the last fuzzy pass, so a query that merely extends
    // the previous one narrows from those matches instead of re-scanning the
    // catalog. `catalog` is kept by reference: a refresh/kill swaps the array
    // and silently invalidates the cache.
    let lastFilter: { query: string; catalog: BeesTuiItem[]; items: BeesTuiItem[] } | undefined;

    const regroup = () => {
      // Read the highlighted bee from the OLD flat before rebuilding so the
      // cursor can follow it; resolveRegroupCursor handles the fallbacks.
      const prevName = currentItem()?.name;
      if (query.length === 0) {
        filtered = catalog;
        lastFilter = undefined;
      } else {
        const pool = lastFilter && lastFilter.catalog === catalog && canNarrowBeesFilter(lastFilter.query, query)
          ? lastFilter.items
          : catalog;
        filtered = filterBeesTuiItems(pool, query);
        lastFilter = { query, catalog, items: filtered };
      }
      groups = groupBeesByMode(filtered, groupMode);
      flat = flattenBeesTuiGroups(groups);
      cursor = resolveRegroupCursor(flat, prevName, options.currentName);
      scroll = 0;
    };

    const applyQuery = (next: string) => {
      query = next;
      // Debounce the fuzzy pass + regroup: the caller's render() echoes the
      // typed query immediately (over the previous match list), and the
      // filter runs once when the burst pauses.
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        filterTimer = undefined;
        if (tui.done) return;
        regroup();
        const n = itemRows().length;
        message = n === 0 ? "no matches" : n === 1 ? "1 bee" : `${n} bees`;
        render();
      }, BEES_FILTER_DEBOUNCE_MS);
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
      if (!item || selecting) return;
      selecting = item;
      message = `opening ${item.displayName || item.ref}...`;
      render();
      try {
        await options.onSelect(item);
        message = `→ ${item.displayName}`;
        if (!options.sidebar) finish();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        selecting = undefined;
        if (!tui.done) render();
      }
    };

    const step = (delta: number) => {
      cursor = stepBeesCursor(flat, cursor, delta);
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
        if (tui.done) return;
        message = error instanceof Error ? error.message : String(error);
      }
      if (!tui.done) render();
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
        if (tui.done) return;
        if (result.ok) {
          catalog = catalog.filter((c) => c.name !== item.name);
          regroup();
          message = `killed ${item.displayName || item.ref}`;
        } else {
          message = result.detail || "kill failed";
        }
      } catch (error) {
        if (tui.done) return;
        message = error instanceof Error ? error.message : String(error);
      } finally {
        killing = false;
        if (!tui.done) render();
      }
    };

    const onKey = (_value: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        finish();
        return;
      }
      if (selecting) return;
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
      // Quit is esc/Ctrl-C only — the fuzzy filter is always the live text
      // buffer here, so every printable (q, j, k, …) must type into it or a
      // bee named "queen" becomes unfindable by prefix.
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

    const painter = createTuiPainter(stdout);
    const render = () => {
      if (tui.done) return;
      const width = Math.max(12, stdout.columns || 80);
      const height = Math.max(8, stdout.rows || 24);
      // The pools capacity strip takes one chrome row when present.
      const poolsRow = options.poolsLine && width >= 38 ? [dim(truncate(options.poolsLine, width))] : [];
      const bodyRows = Math.max(2, height - 5 - poolsRow.length);
      scroll = Math.min(scroll, Math.max(0, flat.length - bodyRows));
      if (cursor < scroll) scroll = cursor;
      if (cursor >= scroll + bodyRows) scroll = cursor - bodyRows + 1;
      const matchCount = itemRows().length;
      const lines = [
        renderTitle(width, catalog.length, query, matchCount),
        renderHelp(width),
        ...poolsRow,
        "",
      ];
      if (confirmKill) {
        lines.push(...renderKillModal(confirmKill, bodyRows, width, killing));
      } else {
        const visible = flat.slice(scroll, scroll + bodyRows);
        for (let i = 0; i < visible.length; i += 1) lines.push(renderFlatRow(visible[i]!, scroll + i, cursor, width, options.currentName));
        for (let i = visible.length; i < bodyRows; i += 1) lines.push("");
      }
      lines.push(truncate(message, width));
      lines.push(dim(footerHint()));
      painter.paint(lines, width, height);
    };

    const footerHint = (): string => {
      if (confirmKill) return "y kill · n / esc cancel";
      const preview = options.onPreview ? " · tab preview" : "";
      const kill = options.onKill ? " · ^k kill" : "";
      const group = ` · ⌘g ${BEES_GROUP_MODE_LABEL[groupMode]}`;
      return (options.sidebar ? "sidebar · esc closes" : "esc exit") + preview + kill + group;
    };

    const start = () => {
      if (!options.syncGroupMode && !options.refreshItems) return;
      let refreshing = false;
      let tick = 0;
      let lastSignature = beesCatalogSignature(catalog);
      pollTimer = setInterval(() => {
        tick += 1;
        if (options.syncGroupMode) {
          void options.syncGroupMode().then((mode) => {
            // Same guard as the catalog refresh below: a confirm modal or an
            // in-flight kill owns the screen, so don't re-group/repaint under
            // it — the next poll picks the mode change up once it closes.
            if (tui.done || selecting || confirmKill || killing || !mode || mode === groupMode) return;
            groupMode = mode;
            regroup();
            render();
          });
        }
        // Catalog refresh runs every other tick (~3s) and never overlaps
        // itself, so a slow store/probe read can't pile up. A confirm modal or
        // an in-flight kill owns the screen, so defer the redraw until it ends.
        if (options.refreshItems && tick % 2 === 0 && !refreshing) {
          refreshing = true;
          void options.refreshItems()
            .then((items) => {
              if (tui.done || confirmKill || killing || selecting) return;
              const signature = beesCatalogSignature(items);
              if (signature === lastSignature) return;
              lastSignature = signature;
              catalog = items;
              regroup();
              render();
            })
            .catch(() => { /* best-effort; keep the last good catalog */ })
            .finally(() => { refreshing = false; });
        }
      }, 1500);
    };

    return { onKey, render, start };
  });
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

/** Flat-row index of the item whose name matches, or -1 when absent/unset. */
export function itemRowIndexForName(flat: FlatRow[], name: string | undefined): number {
  if (!name) return -1;
  return flat.findIndex((row) => row.kind === "item" && row.item.name === name);
}

/** Where the cursor should land: the named bee if present, else the first item. */
export function initialBeesCursor(flat: FlatRow[], name: string | undefined): number {
  const named = itemRowIndexForName(flat, name);
  return named >= 0 ? named : firstItemRowIndex(flat);
}

/**
 * Cursor row after a regroup: keep the previously-highlighted bee when it
 * survived the rebuild (filter refinement, group cycling); otherwise fall back
 * to the current-window bee, then the first item. After a kill the highlighted
 * bee is gone from the new list, so this lands on the home bee, not the top.
 */
export function resolveRegroupCursor(flat: FlatRow[], prevName: string | undefined, currentName: string | undefined): number {
  const survived = itemRowIndexForName(flat, prevName);
  return survived >= 0 ? survived : initialBeesCursor(flat, currentName);
}

/**
 * Cursor row after moving `delta` item rows (headers are skipped, ends clamp).
 * A cursor that no longer sits on an item (e.g. it drifted onto a header)
 * snaps to the first item; an item-less list parks at 0.
 */
export function stepBeesCursor(flat: FlatRow[], cursor: number, delta: number): number {
  const indices = flat.flatMap((row, i) => (row.kind === "item" ? [i] : []));
  if (indices.length === 0) return 0;
  const pos = indices.indexOf(cursor);
  const next = pos < 0 ? 0 : Math.max(0, Math.min(indices.length - 1, pos + delta));
  return indices[next]!;
}

/**
 * Leading icon for a bee living in a pro worktree/checkout (⧉ worktree,
 * ⎇ checkout), prefixed onto the title column so two bees in the same repo read
 * apart at a glance. "" for canonical-repo bees so their title stays clean.
 * A checkout-pool member carries its member name too (`⎇ core-3`) — exported
 * for the glyph test so the convention can't silently drift.
 */
export function slotGlyph(item: Pick<BeesTuiItem, "proSlotKind" | "poolMemberLabel">): string {
  if (item.poolMemberLabel) return `⎇ ${item.poolMemberLabel}`;
  if (!item.proSlotKind) return "";
  return item.proSlotKind === "worktree" ? "⧉" : "⎇";
}

function renderFlatRow(row: FlatRow, index: number, cursor: number, width: number, currentName?: string): string {
  if (row.kind === "header") {
    if (width < 20) return dim(truncate(row.label, width));
    return dim(`── ${truncate(row.label, Math.max(1, width - 4))} ${"─".repeat(Math.max(0, width - visibleLength(row.label) - 4))}`);
  }
  const isCursor = index === cursor;
  // The leading 1-col gutter is the "you are here" marker: `>` flags the bee whose
  // window this strip lives beside, else blank. The cursor row has no caret — it's
  // shown by the reverse-video highlight below — so `>` stays put even when the
  // active bee is also selected. Reusing one fixed-width slot keeps the ref aligned.
  const isHere = currentName !== undefined && row.item.name === currentName;
  const pointer = isHere ? green(">") : " ";
  // A pro worktree/checkout bee gets a kind icon at the front of the title.
  const glyph = slotGlyph(row.item);
  const baseTitle = row.item.displayName.length > 0 ? row.item.displayName : row.item.ref;
  const title = glyph ? `${glyph} ${baseTitle}` : baseTitle;
  let line: string;
  if (width < 24) {
    line = `${pointer} ${stateGlyph(row.item.stateHeadline, row.item.live)} ${truncate(title, Math.max(1, width - 5))}`;
  } else if (width < 38) {
    line = `${pointer} ${stateGlyph(row.item.stateHeadline, row.item.live)} ${truncate(row.item.ref, 8)} ${truncate(title, Math.max(1, width - 14))}`;
  } else {
    // ref + state + name (with a leading worktree/checkout icon). The name gets
    // all remaining width; the noisy detail tail ("awaiting prompt", …) is
    // dropped — it duplicates the state column and crowds out the name. Wide
    // terminals still show the detail.
    const state = stateCell(row.item.stateHeadline, row.item.live);
    const head = `${pointer} ${pad(truncate(row.item.ref, 10), 10)} ${pad(state, 12)}`;
    const room = Math.max(8, width - visibleLength(stripAnsi(head)) - 1);
    if (width >= 90) {
      const nameCell = truncate(title, Math.min(40, room));
      const detailRoom = room - visibleLength(nameCell) - 1;
      const tail = detailRoom >= 12 ? ` ${dim(truncate(row.item.detail || row.item.agent, detailRoom))}` : "";
      line = `${head} ${nameCell}${tail}`;
    } else {
      line = `${head} ${truncate(title, room)}`;
    }
  }
  const fitted = truncate(line, width);
  return isCursor ? reverse(stripAnsi(fitted)) : fitted;
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
  slot?: string;
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
    parts.slot ?? "",
  ]
    .join(" ")
    .toLowerCase();
}
