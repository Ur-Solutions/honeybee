/**
 * `hive usage --live` — auto-refreshing usage dashboard (TUI).
 *
 * A wall dashboard for the provider-limit windows: the same per-account 5h /
 * weekly / Fable data as the static `hive usage` table, redrawn on a 1s render
 * tick (so countdowns and as-of ages move) and re-fetched on a slower fetch
 * tick. No cursor, no selection — it just paints.
 *
 * Presentation-only and dependency-free, mirroring src/beesTui.ts and
 * src/loopTui.ts: raw mode + alt screen + signal-safe restore, one keypress
 * handler, a full redraw per event, a `resize` listener on stdout. All data
 * arrives through caller-supplied hooks (fetchLimits/seedLimits) so the wiring
 * stays in cli.ts. This module never imports cli.ts; it takes types from
 * limits.ts and rendering helpers from format.ts, and its layout helpers are
 * exported as pure functions for unit tests.
 */

import * as readline from "node:readline";
import {
  dim,
  formatRelativeTime,
  formatTimeUntil,
  green,
  isPretty,
  red,
  stripAnsi,
  truncate,
  visibleLength,
  yellow,
} from "./format.js";
import { paceDelta, windowRolledOver, type AccountLimits, type WindowUsage } from "./limits.js";

export type UsageTuiHooks = {
  /** One live sweep across the selected accounts (ttl handled by caller). */
  fetchLimits: () => Promise<AccountLimits[]>;
  /**
   * Optional cheap first read (e.g. cache-served) for an instant first paint.
   * Falls back to {@link fetchLimits} when absent; the live fetch fires right
   * after the seed lands either way.
   */
  seedLimits?: () => Promise<AccountLimits[]>;
  /** Live-fetch cadence in ms (default 120_000, floored at 10_000). */
  intervalMs?: number;
  /** Standing warnings (e.g. identity-check gaps) pinned into the footer every frame. */
  warnings?: string[];
  /** Injectable clock for tests. */
  now?: () => number;
};

/* ------------------------------------------------------------------ */
/* interval parsing / clamping                                         */
/* ------------------------------------------------------------------ */

// 2 minutes: a sweep costs one usage call per claude account (plus codex
// app-server round-trips), and the provider 429s aggressive pollers.
export const USAGE_TUI_DEFAULT_INTERVAL_MS = 120_000;
/** Floor so `--interval` can never hammer the provider endpoints. */
export const USAGE_TUI_MIN_INTERVAL_MS = 10_000;
/** Backoff cap: consecutive rate-limited sweeps double the wait up to 8× the interval. */
export const USAGE_TUI_MAX_BACKOFF_FACTOR = 8;

/** True when any account's live read was rejected for rate limiting. */
export function usageResultsRateLimited(results: AccountLimits[]): boolean {
  return results.some((result) => !result.ok && /\b429\b|rate.?limit/i.test(result.error ?? ""));
}

/**
 * Delay until the next automatic fetch: the interval, doubled per consecutive
 * rate-limited sweep, capped at {@link USAGE_TUI_MAX_BACKOFF_FACTOR}×.
 */
export function nextUsageFetchDelayMs(intervalMs: number, rateLimitedStreak: number): number {
  const factor = Math.min(USAGE_TUI_MAX_BACKOFF_FACTOR, 2 ** Math.max(0, rateLimitedStreak));
  return intervalMs * factor;
}

/** Clamp a requested live-fetch cadence: non-positive/NaN → default; floor at 10s. */
export function clampUsageInterval(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return USAGE_TUI_DEFAULT_INTERVAL_MS;
  return Math.max(USAGE_TUI_MIN_INTERVAL_MS, Math.floor(ms));
}

/* ------------------------------------------------------------------ */
/* pure rendering helpers (unit-tested)                                */
/* ------------------------------------------------------------------ */

// Fixed columns; the two bars share whatever width is left over. The account
// column alone is elastic — sized to the longest id on screen (see
// usageAccountWidth) so full account names win over bar width.
const ACCOUNT_W = 14;
const ACCOUNT_W_MAX = 40;
const PLAN_W = 6;
/** Room for `100% ⟳ 1h4m ▲+99` after each bar. */
const STATS_W = 15;
/** Terse Fable cell: `100% ⟳ 3d`. */
const FABLE_W = 11;
/** Trailing as-of tag: `cache 12m`. */
const ASOF_W = 9;

/** Account column width for a result set: fits the longest id, clamped to 14–40. */
export function usageAccountWidth(results: AccountLimits[]): number {
  const longest = results.reduce((width, result) => Math.max(width, result.account.length), 0);
  return Math.max(ACCOUNT_W, Math.min(ACCOUNT_W_MAX, longest));
}

/**
 * Bar width for the current terminal columns: the space left after the fixed
 * columns split across the two windows, floored at 10 (same minimum the spec
 * calls for) and capped so ultra-wide terminals stay readable.
 */
export function usageBarWidth(columns: number, accountWidth = ACCOUNT_W): number {
  const fixedNonBar =
    1 + accountWidth + 1 + PLAN_W + 1 + (1 + STATS_W) + 1 + (1 + STATS_W) + 1 + FABLE_W + 1 + ASOF_W;
  const perBar = Math.floor((columns - fixedNonBar) / 2);
  return Math.max(10, Math.min(40, Number.isFinite(perBar) ? perBar : 10));
}

/**
 * A usage bar of `width` cells: `█` filled to `percent`, `░` for the rest.
 * Percent is clamped to 0–100; no color decision lives here (see {@link paintBar})
 * so the glyph output is trivially testable.
 */
export function usageBar(percent: number, width: number): string {
  const w = Math.max(1, Math.floor(width));
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.max(0, Math.min(w, Math.round((p / 100) * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/** {@link usageBar} tinted by the same 70/90% yellow/red thresholds as `limitBar`. */
function paintBar(percent: number, width: number): string {
  const bar = usageBar(percent, width);
  if (!isPretty()) return bar;
  const p = Math.max(0, Math.min(100, percent));
  if (p >= 90) return red(bar);
  if (p >= 70) return yellow(bar);
  return green(bar);
}

/** Pace glyph/label mirroring cli.ts' formatPace: ▲ over pace, ▼ headroom, ● on pace. */
function formatPaceCell(delta: number): string {
  const rounded = Math.round(delta);
  if (Math.abs(rounded) <= 2) return isPretty() ? dim("●") : "=0";
  const label = rounded > 0 ? `▲+${rounded}` : `▼${rounded}`;
  if (!isPretty()) return rounded > 0 ? `+${rounded}` : `${rounded}`;
  if (rounded > 0) return rounded >= 15 ? red(label) : yellow(label);
  return green(label);
}

/** Left/right pad to a visible width, ANSI-aware (colored cells keep their width). */
function pad(value: string, size: number, align: "left" | "right" = "left"): string {
  const len = visibleLength(value);
  if (len >= size) return value;
  const padding = " ".repeat(size - len);
  return align === "right" ? padding + value : value + padding;
}

/** A single window cell: bar + `52% ⟳ 1h4m ▲+9`, padded to a fixed width. */
function windowCell(window: WindowUsage | undefined, now: number, barWidth: number): string {
  const cellW = barWidth + 1 + STATS_W;
  if (!window) return pad(dim("—"), cellW);
  if (windowRolledOver(window, now)) {
    return `${paintBar(0, barWidth)} ${pad("0%", STATS_W)}`;
  }
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const pct = `${String(Math.round(percent)).padStart(3)}%`;
  const reset = window.resetsAt ? ` ⟳ ${formatTimeUntil(window.resetsAt, now)}` : "";
  const pace = paceDelta(window, now);
  const paceSuffix = pace === null ? "" : ` ${formatPaceCell(pace)}`;
  const stats = truncate(`${pct}${reset}${paceSuffix}`, STATS_W);
  return `${paintBar(percent, barWidth)} ${pad(stats, STATS_W)}`;
}

/** Terse Fable cell (no bar): `42% ⟳ 3d`, colored by threshold. */
function fableCell(window: WindowUsage | undefined, now: number): string {
  if (!window) return "-";
  if (windowRolledOver(window, now)) return "0%";
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const text = `${Math.round(percent)}%`;
  const colored = !isPretty() ? text : percent >= 90 ? red(text) : percent >= 70 ? yellow(text) : green(text);
  return window.resetsAt ? `${colored} ⟳ ${formatTimeUntil(window.resetsAt, now)}` : colored;
}

/** Trailing freshness tag: `cache 3m` for cached rows, snapshot age for disk data, else blank. */
function asOfTag(result: AccountLimits, now: number): string {
  if (!result.ok) return "";
  if (result.cached) return dim(`cache ${formatRelativeTime(result.asOf, now)}`);
  if (result.asOf) return dim(formatRelativeTime(result.asOf, now));
  return "";
}

/**
 * One account's row for the given bar width. An unreadable account (`ok:false`)
 * renders its error inline (dimmed) in place of the bars; a healthy account
 * renders 5h / weekly bars, the terse Fable cell, and an as-of tag.
 */
export function usageRow(result: AccountLimits, now: number, barWidth: number, accountWidth = ACCOUNT_W): string {
  const account = pad(truncate(result.account, accountWidth), accountWidth);
  const plan = pad(truncate(result.plan ?? "-", PLAN_W), PLAN_W);
  if (!result.ok) {
    return ` ${account} ${plan} ${dim(result.error ?? "unreadable")}`;
  }
  const five = windowCell(result.fiveHour, now, barWidth);
  const week = windowCell(result.weekly, now, barWidth);
  const fable = pad(fableCell(result.fableWeekly, now), FABLE_W);
  const asof = asOfTag(result, now);
  return ` ${account} ${plan} ${five} ${week} ${fable} ${asof}`.replace(/\s+$/, "");
}

/** The column-header row aligned to the same layout as {@link usageRow}. */
function usageHeaderRow(barWidth: number, accountWidth: number): string {
  const cellW = barWidth + 1 + STATS_W;
  return dim(
    ` ${pad("ACCOUNT", accountWidth)} ${pad("PLAN", PLAN_W)} ${pad("5H", cellW)} ${pad("WEEKLY", cellW)} ${pad("FABLE", FABLE_W)}`,
  );
}

/**
 * The dashboard body: a column header plus one row per account, each fitted to
 * `columns`. The account column stretches to the longest id on screen; the
 * bars scale to whatever terminal width remains (see {@link usageBarWidth}).
 */
export function buildUsageRows(results: AccountLimits[], now: number, columns: number): string[] {
  const accountWidth = usageAccountWidth(results);
  const barWidth = usageBarWidth(columns, accountWidth);
  const header = truncate(usageHeaderRow(barWidth, accountWidth), columns);
  const rows = results.map((result) => truncate(usageRow(result, now, barWidth, accountWidth), columns));
  return [header, ...rows];
}

/**
 * The header's right-hand status string: `refreshed 12s ago · next in 48s ·
 * [r]efresh [q]uit`. Shows `loading…` before the first result lands and
 * `refreshing…` (in place of the countdown) while a fetch is in flight.
 */
export function formatHeaderStatus(
  lastFetchedAt: number | undefined,
  nextFetchAt: number | undefined,
  fetching: boolean,
  now: number,
  rateLimited = false,
): string {
  const parts: string[] = [];
  if (lastFetchedAt === undefined) parts.push("loading…");
  else parts.push(`refreshed ${formatRelativeTime(new Date(lastFetchedAt).toISOString(), now)} ago`);
  if (rateLimited) parts.push("rate-limited, backing off");
  if (fetching) parts.push("refreshing…");
  else if (nextFetchAt !== undefined) parts.push(`next in ${Math.max(0, Math.ceil((nextFetchAt - now) / 1000))}s`);
  parts.push("[r]efresh [q]uit");
  return parts.join(" · ");
}

/** Footer: a refresh-failure banner, standing warnings, per-account error notes, then the pace legend. */
export function buildUsageFooter(results: AccountLimits[], refreshError: string | undefined, warnings: string[] = []): string[] {
  const lines: string[] = [];
  if (refreshError) lines.push(red(`refresh failed: ${refreshError}`));
  lines.push(...warnings);
  for (const result of results.filter((candidate) => !candidate.ok)) {
    lines.push(dim(`${result.account}: ${result.error ?? "unreadable"}`));
  }
  lines.push(dim("pace: ▲ burning faster than the window refills · ▼ headroom · ● on pace"));
  return lines;
}

/* ------------------------------------------------------------------ */
/* the TUI loop                                                        */
/* ------------------------------------------------------------------ */

export async function runUsageTui(hooks: UsageTuiHooks): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hive usage --live requires a TTY.");
  }

  const now = hooks.now ?? Date.now;
  const intervalMs = clampUsageInterval(hooks.intervalMs);
  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRaw = stdin.isRaw;

  let results: AccountLimits[] | undefined;
  let lastFetchedAt: number | undefined;
  let nextFetchAt: number | undefined;
  let fetching = false;
  let refreshError: string | undefined;
  let rateLimitedStreak = 0;

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
      let renderTimer: ReturnType<typeof setInterval> | undefined;
      let fetchTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (done) return;
        done = true;
        if (renderTimer) clearInterval(renderTimer);
        if (fetchTimer) clearTimeout(fetchTimer);
        stdin.off("keypress", onKey);
        stdout.off("resize", render);
        resolve();
      };

      const render = () => {
        if (done) return;
        const width = Math.max(20, stdout.columns || 80);
        const height = Math.max(8, stdout.rows || 24);
        const status = formatHeaderStatus(lastFetchedAt, nextFetchAt, fetching, now(), rateLimitedStreak > 0);
        const title = "hive usage — live";
        const gap = Math.max(1, width - visibleLength(title) - visibleLength(status));
        const lines: string[] = [truncate(` ${title}${" ".repeat(gap)}${dim(status)}`, width), ""];

        if (!results) {
          lines.push(dim("  loading…"));
        } else {
          const body = buildUsageRows(results, now(), width);
          const footer = buildUsageFooter(results, refreshError, hooks.warnings ?? []);
          // title(1) + blank(1) + blank-before-footer(1) + footer lines.
          const reserved = 3 + footer.length;
          const avail = Math.max(1, height - reserved);
          if (body.length > avail) {
            const shown = body.slice(0, Math.max(1, avail - 1));
            lines.push(...shown, dim(`… ${body.length - shown.length} more`));
          } else {
            lines.push(...body);
          }
          lines.push("");
          lines.push(...footer.map((line) => truncate(line, width)));
        }
        stdout.write(`\x1b[2J\x1b[H${lines.map((line) => truncate(line, width)).join("\n")}`);
      };

      const scheduleNextFetch = () => {
        if (fetchTimer) clearTimeout(fetchTimer);
        // Consecutive rate-limited sweeps double the wait (capped) — polling
        // through a 429 only prolongs it.
        const delay = nextUsageFetchDelayMs(intervalMs, rateLimitedStreak);
        nextFetchAt = now() + delay;
        fetchTimer = setTimeout(() => {
          if (!fetching) doFetch(hooks.fetchLimits);
        }, delay);
      };

      const doFetch = (fn: () => Promise<AccountLimits[]>) => {
        if (fetching) return; // never overlap a fetch
        fetching = true;
        render();
        fn()
          .then((next) => {
            if (done) return;
            results = next;
            lastFetchedAt = now();
            refreshError = undefined;
            rateLimitedStreak = usageResultsRateLimited(next) ? rateLimitedStreak + 1 : 0;
          })
          .catch((error) => {
            if (done) return;
            refreshError = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            fetching = false;
            if (!done) {
              scheduleNextFetch();
              render();
            }
          });
      };

      const onKey = (_value: string, key: readline.Key) => {
        if (key.ctrl && key.name === "c") {
          finish();
          return;
        }
        if (key.name === "q" || key.name === "escape") {
          finish();
          return;
        }
        if (key.name === "r") {
          rateLimitedStreak = 0; // a human override retries at full cadence
          doFetch(hooks.fetchLimits);
        }
      };

      render();
      stdin.on("keypress", onKey);
      stdout.on("resize", render);
      renderTimer = setInterval(render, 1000);

      // Seed the first frame from the cheap read, then immediately go live.
      const seed = hooks.seedLimits ?? hooks.fetchLimits;
      seed()
        .then((next) => {
          if (done) return;
          results = next;
          lastFetchedAt = now();
          render();
        })
        .catch(() => { /* the live fetch below will surface any error */ })
        .finally(() => {
          if (!done) doFetch(hooks.fetchLimits);
        });
    });
  } finally {
    process.off("exit", restoreTerminal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    restoreTerminal();
  }
}

// Re-exported for callers/tests that want to strip a rendered row.
export { stripAnsi };
