/**
 * Human-mode CLI presentation primitives for Honeybee v2.
 *
 * Color and emphasis wrap only when the stream is a real terminal and color
 * is not disabled. Layout (alignment, icons, headers) always applies: `--json`
 * is the machine surface, human mode is for operators.
 */
import { homedir } from "node:os";

type Stream = NodeJS.WriteStream | { isTTY?: boolean };

export function isPretty(stream: Stream = process.stdout): boolean {
  if (colorDisabledByEnv()) return false;
  if (forceColor()) return true;
  return Boolean(stream.isTTY) && !terminalIsDumbForUi();
}

function forceColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0";
}

function colorDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HIVE_NO_COLOR !== undefined && env.HIVE_NO_COLOR !== "") return true;
  if (forceColor(env)) return false;
  // Codex/automation parents often export NO_COLOR=1 together with TERM=dumb.
  // Do not let that leak into interactive tmux; use HIVE_NO_COLOR inside tmux.
  return env.TMUX === undefined && env.NO_COLOR !== undefined && env.NO_COLOR !== "";
}

function terminalIsDumbForUi(env: NodeJS.ProcessEnv = process.env): boolean {
  if (forceColor()) return false;
  return env.TMUX === undefined && env.TERM === "dumb";
}

const ESC = "\x1b[";
const wrap = (code: string) => (s: string): string => (isPretty() ? `${ESC}${code}m${s}${ESC}0m` : s);

export const bold = wrap("1");
export const dim = wrap("2");
export const italic = wrap("3");
export const underline = wrap("4");
export const inverse = wrap("7");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");
export const gray = wrap("90");

/** Brand gold — handles, hive wordmark. Falls back to yellow when not pretty. */
export const honey = wrap("1;33");

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

export function visibleLength(value: string): number {
  return displayWidth(stripAnsi(value));
}

const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
];

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff],
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function inRanges(codePoint: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  if (codePoint < ranges[0]![0]) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (codePoint < start) hi = mid - 1;
    else if (codePoint > end) lo = mid + 1;
    else return true;
  }
  return false;
}

export function codePointWidth(codePoint: number): number {
  if (inRanges(codePoint, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeWidth(cluster: string): number {
  let width = 0;
  for (const char of cluster) width = Math.max(width, codePointWidth(char.codePointAt(0)!));
  return width;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(value)) width += graphemeWidth(segment);
  return width;
}

export function padCell(value: string, width: number, align: "left" | "right" = "left"): string {
  const visible = visibleLength(value);
  if (visible >= width) return value;
  const padding = " ".repeat(width - visible);
  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

const ANSI_PREFIX_RE = /^\x1b\[[0-9;]*m/;

function firstGrapheme(value: string): string {
  for (const { segment } of GRAPHEMES.segment(value)) return segment;
  return value;
}

function stripAnsiSlice(value: string, maxVisible: number): string {
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < value.length && visible < maxVisible) {
    const match = ANSI_PREFIX_RE.exec(value.slice(i));
    if (match) {
      out += match[0];
      i += match[0].length;
      continue;
    }
    const cluster = firstGrapheme(value.slice(i));
    const width = graphemeWidth(cluster);
    if (visible + width > maxVisible) break;
    out += cluster;
    visible += width;
    i += cluster.length;
  }
  return out;
}

export function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  const visible = visibleLength(value);
  if (visible <= max) return value;
  if (max <= 1) return "…";
  const sliced = stripAnsiSlice(value, max - 1);
  const reset = sliced.includes("\x1b[") ? "\x1b[0m" : "";
  return `${sliced}${reset}…`;
}

export type TableColumn = {
  header: string;
  align?: "left" | "right";
};

export function formatTable(columns: TableColumn[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = columns.map((column, index) => {
    const headerLength = visibleLength(column.header);
    const cellLengths = rows.map((row) => visibleLength(row[index] ?? ""));
    return Math.max(headerLength, ...cellLengths);
  });

  const formatRow = (cells: string[], styler?: (value: string, index: number) => string) =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        const padded = padCell(cell, width, columns[index]?.align ?? "left");
        return styler ? styler(padded, index) : padded;
      })
      .join("  ")
      .trimEnd();

  const header = formatRow(
    columns.map((c) => c.header),
    (value) => dim(value),
  );
  const rule = formatRow(
    columns.map((c, i) => "─".repeat(widths[i] ?? 0)),
    (value) => dim(value),
  );
  const body = rows.map((row) => formatRow(row));
  return [header, rule, ...body];
}

export function formatRelativeTime(fromMs: number | undefined | null, now: number = Date.now()): string {
  if (fromMs == null || !Number.isFinite(fromMs)) return "—";
  const delta = Math.max(0, now - fromMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function formatTimeUntil(untilMs: number | undefined | null, now: number = Date.now()): string {
  if (untilMs == null || !Number.isFinite(untilMs)) return "—";
  if (untilMs <= now) return "now";
  // Round so a "2 hours from now" reset never reads "1h" a few ms later.
  const minutes = Math.round((untilMs - now) / 60_000);
  if (minutes < 60) return minutes <= 0 ? "now" : `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function tildify(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export type ActionStatus = "ok" | "warn" | "err" | "info";

export function actionIcon(status: ActionStatus): string {
  switch (status) {
    case "ok":
      return green("✓");
    case "warn":
      return yellow("!");
    case "err":
      return red("✗");
    case "info":
      return cyan("›");
  }
}

/**
 * Confirm a mutation. Deduped replays keep the `deduped:` prefix (the
 * one-key rule's human marker) and skip the icon so greps still work.
 * Pass `verb` as `already spawned` when the original phrasing used "already".
 */
export function actionLine(status: ActionStatus, verb: string, detail: string, deduped = false): string {
  if (deduped) {
    return `${yellow("deduped:")} ${verb} ${detail}`.trimEnd();
  }
  const tail = detail.trim();
  return tail ? `${actionIcon(status)}  ${bold(verb)} ${tail}` : `${actionIcon(status)}  ${bold(verb)}`;
}

export function stalePrefix(stale: boolean): string {
  return stale ? `${yellow("stale:")} ` : "";
}

export function staleBanner(storePath: string): string {
  return `${yellow(bold("STALE"))}${dim(":")} daemon not running — read directly from ${dim(tildify(storePath))}`;
}

export function errorLine(message: string, code?: string): string {
  const head = `${red(bold("hive"))}${dim(":")}`;
  if (code) return `${head} ${red(code)}  ${message}`;
  return `${head} ${message}`;
}

export function kv(label: string, value: string): string {
  return `  ${dim(padCell(label, 11))}  ${value}`;
}

export function joinParts(parts: Array<string | undefined | null>, sep = `  ${dim("·")}  `): string {
  return parts.filter((p): p is string => Boolean(p && p.length > 0)).join(sep);
}

export function emptyLine(stale: boolean, noun: string): string {
  return `${stalePrefix(stale)}${dim(`no ${noun}`)}`;
}
