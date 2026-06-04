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
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
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

export function visibleLength(value: string): number {
  return value.replace(ANSI_RE, "").length;
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
    out += value[i];
    visible += 1;
    i += 1;
  }
  return out;
}
