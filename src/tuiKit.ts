/**
 * Shared micro-helpers for the full-screen TUIs (spawnTui, loopTui, launchTui,
 * beesTui, cleanTui, forkTui, usageTui). Pure and dependency-light — the
 * raw-mode/alt-screen lifecycle lives in src/tuiRuntime.ts.
 */

import type * as readline from "node:readline";
import { isPretty, visibleLength } from "./format.js";

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
