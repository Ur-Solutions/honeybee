import { homedir } from "node:os";

type Stream = NodeJS.WriteStream | { isTTY?: boolean };

export function isPretty(stream: Stream = process.stdout): boolean {
  return Boolean(stream.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

const ESC = "\x1b[";
const wrap = (code: string) => (s: string): string => (isPretty() ? `${ESC}${code}m${s}${ESC}0m` : s);

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");
export const gray = wrap("90");

export function statusDot(state: "running" | "dead"): string {
  return state === "running" ? green("●") : gray("○");
}

export function formatRelativeTime(fromIso: string | undefined, now: number = Date.now()): string {
  if (!fromIso) return "—";
  const ts = Date.parse(fromIso);
  if (!Number.isFinite(ts)) return "—";
  const delta = Math.max(0, now - ts);
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

export function tildify(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export type TableColumn = {
  header: string;
  align?: "left" | "right";
};

export function formatTable(columns: TableColumn[], rows: string[][]): string {
  const widths = columns.map((column, index) => {
    const headerLength = visibleLength(column.header);
    const cellLengths = rows.map((row) => visibleLength(row[index] ?? ""));
    return Math.max(headerLength, ...cellLengths);
  });

  const formatRow = (cells: string[], styler?: (value: string) => string) =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        const padded = padCell(cell, width, columns[index]?.align ?? "left");
        return styler ? styler(padded) : padded;
      })
      .join("  ");

  const header = formatRow(columns.map((c) => c.header), (value) => bold(dim(value)));
  const body = rows.map((row) => formatRow(row));
  return [header, ...body].join("\n");
}

function padCell(value: string, width: number, align: "left" | "right"): string {
  const visible = visibleLength(value);
  if (visible >= width) return value;
  const padding = " ".repeat(width - visible);
  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

export function visibleLength(value: string): number {
  return displayWidth(stripAnsi(value));
}

// Terminal display width, measured in cells rather than UTF-16 code units.
// East Asian Wide/Fullwidth characters and common emoji take two cells;
// combining marks and joiners take none. A compact range table keeps this
// dependency-free; rare scripts may be slightly off, which is acceptable for
// table alignment.
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x200b, 0x200f], // zero-width space/joiners, directional marks
  [0x20d0, 0x20ff], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
];

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b], // watch, hourglass
  [0x23e9, 0x23ec], // emoji play/fast-forward symbols
  [0x23f0, 0x23f0], // alarm clock
  [0x23f3, 0x23f3], // hourglass with flowing sand
  [0x25fd, 0x25fe], // small squares (emoji presentation)
  [0x2614, 0x2615], // umbrella, hot beverage
  [0x2648, 0x2653], // zodiac
  [0x267f, 0x267f], // wheelchair symbol
  [0x2693, 0x2693], // anchor
  [0x26a1, 0x26a1], // high voltage
  [0x26aa, 0x26ab], // medium circles
  [0x26bd, 0x26be], // soccer, baseball
  [0x26c4, 0x26c5], // snowman, sun behind cloud
  [0x26ce, 0x26ce], // ophiuchus
  [0x26d4, 0x26d4], // no entry
  [0x26ea, 0x26ea], // church
  [0x26f2, 0x26f3], // fountain, golf flag
  [0x26f5, 0x26f5], // sailboat
  [0x26fa, 0x26fa], // tent
  [0x26fd, 0x26fd], // fuel pump
  [0x2705, 0x2705], // check mark button
  [0x270a, 0x270b], // raised fist, raised hand
  [0x2728, 0x2728], // sparkles
  [0x274c, 0x274c], // cross mark
  [0x274e, 0x274e], // cross mark button
  [0x2753, 0x2755], // question/exclamation ornaments
  [0x2757, 0x2757], // heavy exclamation mark
  [0x2795, 0x2797], // heavy plus/minus/division
  [0x27b0, 0x27b0], // curly loop
  [0x27bf, 0x27bf], // double curly loop
  [0x2b1b, 0x2b1c], // large squares
  [0x2b50, 0x2b50], // star
  [0x2b55, 0x2b55], // heavy large circle
  [0x2e80, 0xa4cf], // CJK radicals, kana, CJK ideographs, Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // joker
  [0x1f18e, 0x1f18e], // AB button
  [0x1f191, 0x1f19a], // squared CL..VS
  [0x1f1e6, 0x1f1ff], // regional indicators (flag pairs)
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x1f300, 0x1f64f], // misc pictographs, emoticons
  [0x1f680, 0x1f6ff], // transport and map symbols
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x1fa70, 0x1faff], // symbols and pictographs extended-A
  [0x20000, 0x3fffd], // CJK extensions B and beyond
];

export function codePointWidth(codePoint: number): number {
  if (inRanges(codePoint, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Display width of one grapheme cluster. A cluster renders as a single glyph,
 * so its width is the widest of its code points — ZWJ sequences (family
 * emoji), skin-tone modifiers, and combining marks never double-count.
 */
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

export type ActionStatus = "ok" | "warn" | "err" | "info";

export function actionLine(status: ActionStatus, verb: string, parts: Array<string | undefined | null>): string {
  const icon = actionIcon(status);
  const tag = padCell(verb, 6, "left");
  const tail = parts.filter((part): part is string => Boolean(part && part.length > 0)).join(dim("  ·  "));
  return tail ? `${icon}  ${bold(tag)}  ${tail}` : `${icon}  ${bold(tag)}`;
}

function actionIcon(status: ActionStatus): string {
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

export function note(message: string): string {
  return dim(`hive: ${message}`);
}

export function errorPrefix(): string {
  return `${red(bold("hive"))}${dim(":")}`;
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

const ANSI_PREFIX_RE = /^\x1b\[[0-9;]*m/;

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
    // Advance one grapheme cluster at a time so truncation can never split a
    // ZWJ sequence, skin-tone modifier, or combining mark off its base.
    const cluster = firstGrapheme(value.slice(i));
    const width = graphemeWidth(cluster);
    if (visible + width > maxVisible) break;
    out += cluster;
    visible += width;
    i += cluster.length;
  }
  return out;
}

function firstGrapheme(value: string): string {
  for (const { segment } of GRAPHEMES.segment(value)) return segment;
  return value;
}
