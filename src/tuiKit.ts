/**
 * Shared micro-helpers for the full-screen TUIs (spawnTui, loopTui, launchTui,
 * beesTui, cleanTui, forkTui, usageTui). Pure and dependency-light — the
 * raw-mode/alt-screen lifecycle lives in src/tuiRuntime.ts.
 */

import type * as readline from "node:readline";
import { isPretty, visibleLength } from "./format.js";

/**
 * fzf-style incremental filter. Empty query keeps the original order; otherwise
 * items are ranked: exact substring beats a scattered subsequence, earlier and
 * more contiguous matches score higher, ties break on the shorter candidate.
 * Non-matches are dropped.
 */
export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: Array<{ item: T; score: number; len: number }> = [];
  for (const item of items) {
    const text = key(item);
    const score = fuzzyScore(q, text.toLowerCase());
    if (score >= 0) scored.push({ item, score, len: text.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map((entry) => entry.item);
}

function fuzzyScore(query: string, text: string): number {
  const idx = text.indexOf(query);
  if (idx >= 0) return 2000 - Math.min(idx, 1000); // contiguous substring wins decisively
  let from = 0;
  let score = 0;
  let streak = 0;
  let first = -1;
  let last = -1;
  for (const ch of query) {
    const found = text.indexOf(ch, from);
    if (found < 0) return -1;
    if (first < 0) first = found;
    last = found;
    streak = found === from ? streak + 1 : 0;
    score += 1 + streak;
    from = found + 1;
  }
  // Reject sparse matches: a real fuzzy hit is reasonably localized, but a
  // garbage query (e.g. "ebabaebaerba") only "matches" a long corpus by
  // scattering its characters across the whole thing. Cap the gap between the
  // first and last matched character relative to the query length.
  const gaps = last - first + 1 - query.length;
  if (gaps > Math.max(8, query.length * 2)) return -1;
  return score;
}

/** Split a typed path into the directory to list and the trailing fuzzy query. */
export function splitPathQuery(buffer: string): { base: string; query: string } {
  const slash = buffer.lastIndexOf("/");
  if (slash < 0) return { base: ".", query: buffer };
  return { base: buffer.slice(0, slash) || "/", query: buffer.slice(slash + 1) };
}

/** Display an absolute dir relative to `base` (falls back to the abs path). */
export function relativeTo(base: string, abs: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

/** Lifecycle of data a TUI loads through a hook while the screen is live. */
export type AsyncState<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; items: T }
  | { state: "error"; error: string };

/** Reverse-video highlight (the selection bar); a no-op when output is plain. */
export function reverse(value: string): string {
  return isPretty() ? `\x1b[7m${value}\x1b[0m` : value;
}

/** Clamp a cursor index into [0, length); an empty list parks at 0. */
export function clamp(next: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, next));
}

/** Pad with trailing spaces to `width` display columns (ANSI-aware). */
export function padRight(value: string, width: number): string {
  const visible = visibleLength(value);
  return visible >= width ? value : value + " ".repeat(width - visible);
}

/** A single printable character (not a ctrl/meta chord) — text-field input. */
export function isPrintable(value: string, key: readline.Key): boolean {
  return Boolean(value) && value.length === 1 && value >= " " && !key.ctrl && !key.meta;
}

/** Expand a leading `~` (or `~/…`) to $HOME. */
export function expandTilde(value: string): string {
  return value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
}

/** Display an absolute path with $HOME abbreviated to `~`. */
export function relTilde(abs: string): string {
  const home = process.env.HOME;
  return home && abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs;
}
