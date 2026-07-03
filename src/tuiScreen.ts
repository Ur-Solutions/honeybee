/**
 * Screen abstraction + composable list primitive for the full-screen wizards.
 *
 * The raw-mode/alt-screen lifecycle lives in src/tuiRuntime.ts and the pure
 * micro-helpers in src/tuiKit.ts. This module sits one layer up: it defines the
 * `Screen` a host wizard delegates a stage to, plus `createFilterList` — the
 * fuzzy-filtered scrolling list that every type-to-filter overlay (repo browser,
 * bee picker, template list) is built from. Reusable Screens (ProjectPicker,
 * BeePicker) compose these so a new wizard stage is composition, not a copy.
 */

import type * as readline from "node:readline";
import { clamp, fuzzyFilter, isPrintable } from "./tuiKit.js";

/**
 * A composable sub-screen the full-screen wizards delegate to. The host owns the
 * frame shell (header, footer, paint); a Screen contributes the body lines, the
 * key handling, and where to park the terminal cursor.
 */
export type Screen = {
  /** Handle a keypress; return true when consumed so the host stops dispatching. */
  onKey(value: string, key: readline.Key): boolean;
  /** Body lines for the current frame (the host prepends the header + a blank). */
  render(width: number, bodyRows: number): string[];
  /**
   * Where to park the real terminal cursor, or null to hide it. `line` is the
   * 0-based row within this Screen's body (the host adds its own header offset);
   * `col` is the absolute 1-based screen column.
   */
  cursor(): { line: number; col: number } | null;
};

/**
 * Compute the visible window of a scrolling list: given the cursor and the
 * previously remembered scroll offset, return the (possibly nudged) scroll
 * offset and the absolute indices to draw. Extracted verbatim from the identical
 * scroll math the pickers used to inline.
 */
export function visibleWindow(
  cursor: number,
  prevScroll: number,
  listRows: number,
  length: number,
): { scroll: number; indices: number[] } {
  let scroll = prevScroll;
  if (cursor < scroll) scroll = cursor;
  if (cursor >= scroll + listRows) scroll = cursor - listRows + 1;
  const indices: number[] = [];
  for (let i = 0; i < Math.min(listRows, length - scroll); i += 1) indices.push(scroll + i);
  return { scroll, indices };
}

/** One row the FilterList wants drawn: the item, its absolute index, and focus. */
export type VisibleRow<T> = { item: T; idx: number; focused: boolean };

/**
 * A fuzzy-filtered scrolling list: a query buffer plus a cursor/scroll pair over
 * the filtered results. The type-to-filter overlays (repo browser, bee picker,
 * template list) are all this shape, differing only in per-row rendering.
 */
export type FilterList<T> = {
  /** The live filter query. */
  query: string;
  /** Cursor index into the filtered list. */
  cursor: number;
  /** The filtered items in rank order. */
  filtered(): T[];
  /** The item under the cursor, if any. */
  selected(): T | undefined;
  /** Move the cursor by delta, clamped to the filtered list. */
  move(delta: number): void;
  /** Reset query, cursor, and scroll (e.g. when the overlay reopens). */
  reset(): void;
  /**
   * Consume an editing/navigation key (up/down, backspace, ctrl-u, printable).
   * Returns true when the key edited the query or moved the cursor. Enter, esc,
   * and tab are the host's to interpret.
   */
  handleNavKey(value: string, key: readline.Key): boolean;
  /** The rows to draw for a `listRows`-tall window, scroll offset updated. */
  visible(listRows: number): Array<VisibleRow<T>>;
};

export function createFilterList<T>(source: () => T[], key: (item: T) => string): FilterList<T> {
  let scroll = 0;
  const list: FilterList<T> = {
    query: "",
    cursor: 0,
    filtered() {
      return fuzzyFilter(list.query, source(), key);
    },
    selected() {
      return list.filtered()[list.cursor];
    },
    move(delta) {
      list.cursor = clamp(list.cursor + delta, list.filtered().length);
    },
    reset() {
      list.query = "";
      list.cursor = 0;
      scroll = 0;
    },
    handleNavKey(value, keyInfo) {
      if (keyInfo.name === "up") { list.move(-1); return true; }
      if (keyInfo.name === "down") { list.move(1); return true; }
      if (keyInfo.name === "backspace") { list.query = list.query.slice(0, -1); list.cursor = 0; return true; }
      if (keyInfo.ctrl && keyInfo.name === "u") { list.query = ""; list.cursor = 0; return true; }
      if (isPrintable(value, keyInfo)) { list.query += value; list.cursor = 0; return true; }
      return false;
    },
    visible(listRows) {
      const items = list.filtered();
      const win = visibleWindow(list.cursor, scroll, listRows, items.length);
      scroll = win.scroll;
      return win.indices.map((idx) => ({ item: items[idx]!, idx, focused: idx === list.cursor }));
    },
  };
  return list;
}
