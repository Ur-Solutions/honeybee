import * as readline from "node:readline";
import { bold, codePointWidth, cyan, dim, gray, green, isPretty, magenta, red, stripAnsi, tildify, truncate, visibleLength, yellow } from "./format.js";
import type { BeeState } from "./state.js";

export type CleanTuiItem = {
  name: string;
  ref: string;
  agent: string;
  state: BeeState;
  detail: string;
  age: string;
  cwd: string;
  disabledReason?: string;
};

export type CleanTuiOptions = {
  loadPreview?: (item: CleanTuiItem) => Promise<string>;
  clean?: (items: CleanTuiItem[]) => Promise<CleanTuiCleanOutcome[]>;
};

export type CleanTuiCleanOutcome = {
  name: string;
  ok: boolean;
  detail: string;
};

export type CleanTuiResult = {
  cleaned: number;
  failed: number;
  cancelled: boolean;
};

type PreviewCacheEntry =
  | { state: "loading" }
  | { state: "loaded"; text: string }
  | { state: "error"; text: string };

export async function chooseCleanTargets(items: CleanTuiItem[], options: CleanTuiOptions = {}): Promise<CleanTuiResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hive clean --interactive requires a TTY. Use hive clean --idle or hive clean --dead in scripts.");
  }
  if (items.length === 0) return { cleaned: 0, failed: 0, cancelled: false };

  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRaw = stdin.isRaw;
  let rows = [...items];
  let cursor = 0;
  let scroll = 0;
  let previewOpen = false;
  let cleaning = false;
  let cleaned = 0;
  let failed = 0;
  let message = "space marks, enter/x cleans, a toggles all, p previews, q exits";
  const selected = new Set<string>();
  const previewCache = new Map<string, PreviewCacheEntry>();

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[?25l");

  // Restore the terminal exactly once, even if we exit through a signal or a
  // crash rather than the happy path: leaving the alt screen in raw mode with
  // a hidden cursor would wedge the user's shell.
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
    return await new Promise<CleanTuiResult>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        stdin.off("keypress", onKey);
        stdout.off("resize", onResize);
        resolve({ cleaned, failed, cancelled: cleaned === 0 && failed === 0 });
      };

      const toggleCurrent = () => {
        const item = rows[cursor];
        if (!item) return;
        if (item.disabledReason) {
          message = `${item.name} is ${item.disabledReason}; use hive kill ${item.name} if you really want it gone`;
          return;
        }
        if (selected.has(item.name)) selected.delete(item.name);
        else selected.add(item.name);
        message = selected.size === 1 ? "1 thread marked" : `${selected.size} threads marked`;
      };

      const toggleAll = () => {
        const cleanable = rows.filter((item) => !item.disabledReason);
        const allSelected = cleanable.length > 0 && cleanable.every((item) => selected.has(item.name));
        if (allSelected) {
          selected.clear();
          message = "selection cleared";
          return;
        }
        for (const item of cleanable) selected.add(item.name);
        message = cleanable.length === 1 ? "1 thread marked" : `${cleanable.length} threads marked`;
      };

      const cleanSelection = async () => {
        if (cleaning) return;
        if (!options.clean) {
          message = "No cleaner is configured for this TUI.";
          render();
          return;
        }
        const targets = selected.size > 0
          ? rows.filter((item) => selected.has(item.name) && !item.disabledReason)
          : rows[cursor] && !rows[cursor]!.disabledReason
            ? [rows[cursor]!]
            : [];
        if (targets.length === 0) {
          const item = rows[cursor];
          message = item?.disabledReason
            ? `${item.name} is ${item.disabledReason}; move to an idle/dead row or mark cleanable rows`
            : "No cleanable rows selected.";
          render();
          return;
        }
        cleaning = true;
        message = targets.length === 1 ? `cleaning ${targets[0]!.name}...` : `cleaning ${targets.length} threads...`;
        render();
        try {
          const outcomes = await options.clean(targets);
          if (done) return;
          const ok = new Set(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.name));
          const bad = outcomes.filter((outcome) => !outcome.ok);
          cleaned += ok.size;
          failed += bad.length;
          rows = rows.filter((item) => !ok.has(item.name));
          for (const name of ok) {
            selected.delete(name);
            previewCache.delete(name);
          }
          if (rows.length === 0) {
            cursor = 0;
            scroll = 0;
          } else {
            cursor = Math.min(cursor, rows.length - 1);
            scroll = Math.min(scroll, Math.max(0, rows.length - 1));
          }
          if (bad.length > 0) {
            const first = bad[0]!;
            message = ok.size > 0
              ? `cleaned ${ok.size}; ${bad.length} failed (${first.name}: ${first.detail})`
              : `clean failed (${first.name}: ${first.detail})`;
          } else {
            message = ok.size === 1 ? "cleaned 1 thread" : `cleaned ${ok.size} threads`;
          }
        } catch (error) {
          failed += targets.length;
          message = `clean failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
          cleaning = false;
          if (!done) {
            render();
            void requestPreview();
          }
        }
      };

      const moveCursor = (next: number) => {
        cursor = rows.length === 0 ? 0 : Math.max(0, Math.min(rows.length - 1, next));
        render();
        void requestPreview();
      };

      const togglePreview = () => {
        previewOpen = !previewOpen;
        message = previewOpen ? "preview open: showing latest transcript or pane tail for the highlighted bee" : "preview closed";
        render();
        void requestPreview();
      };

      const requestPreview = async () => {
        if (!previewOpen || !options.loadPreview) return;
        const item = rows[cursor];
        if (!item || previewCache.has(item.name)) return;
        previewCache.set(item.name, { state: "loading" });
        render();
        try {
          const text = await options.loadPreview(item);
          if (done) return;
          previewCache.set(item.name, { state: "loaded", text });
        } catch (error) {
          if (done) return;
          const text = error instanceof Error ? error.message : String(error);
          previewCache.set(item.name, { state: "error", text });
        }
        render();
      };

      const onKey = (_value: string, key: readline.Key) => {
        // Ctrl+C must work even mid-clean: raw mode swallows SIGINT, so this
        // is the only way out of a hung clean. The finally restores the
        // terminal; the in-flight clean is guarded by `done`.
        if (key.ctrl && key.name === "c") {
          finish();
          return;
        }
        if (cleaning) return;
        switch (key.name) {
          case "escape":
          case "q":
            finish();
            return;
          case "up":
          case "k":
            moveCursor(cursor - 1);
            return;
          case "down":
          case "j":
            moveCursor(cursor + 1);
            return;
          case "home":
            moveCursor(0);
            return;
          case "end":
            moveCursor(items.length - 1);
            return;
          case "space":
            toggleCurrent();
            render();
            return;
          case "a":
            toggleAll();
            render();
            return;
          case "tab":
          case "p":
          case "t":
          case "l":
            togglePreview();
            return;
          case "return":
          case "enter":
          case "x":
          case "d":
            void cleanSelection();
            return;
        }
      };

      const render = () => {
        if (done) return;
        const width = Math.max(1, stdout.columns || 100);
        const height = Math.max(12, stdout.rows || 24);
        const previewRows = previewOpen ? Math.max(4, Math.min(12, Math.floor(height * 0.35))) : 0;
        const previewBlockRows = previewOpen ? previewRows + 2 : 0;
        const bodyRows = Math.max(4, height - 7 - previewBlockRows);
        scroll = Math.min(scroll, Math.max(0, rows.length - bodyRows));
        if (cursor < scroll) scroll = cursor;
        if (cursor >= scroll + bodyRows) scroll = cursor - bodyRows + 1;
        const visible = rows.slice(scroll, scroll + bodyRows);
        const selectedLabel = selected.size === 0 ? dim("nothing marked") : green(`${selected.size} marked`);
        const cleanableCount = rows.filter((item) => !item.disabledReason).length;
        const lines = [
          `${bold("hive clean")}  ${dim(`${rows.length} threads`)}  ${selectedLabel}  ${dim(`${cleanableCount} cleanable`)}  ${dim(`cleaned ${cleaned}`)}`,
          dim("Move with j/k or arrows. Press x/enter to clean marked rows, or the current row if none are marked."),
          "",
          tableHeader(width),
          ...visible.map((item, index) => renderRow(item, scroll + index, cursor, selected, width)),
        ];
        const remaining = bodyRows - visible.length;
        for (let i = 0; i < remaining; i += 1) lines.push("");
        if (previewOpen) {
          lines.push(dim("─".repeat(width)));
          lines.push(...renderPreview(rows[cursor], previewCache, previewRows, width, Boolean(options.loadPreview)));
        }
        lines.push("");
        lines.push(truncate(rows.length === 0 ? `${message}. No threads left; q quits.` : message, width));
        lines.push(dim("p/t/l toggles preview · q exits"));
        stdout.write(`\x1b[2J\x1b[H${lines.map((line) => truncate(line, width)).join("\n")}`);
      };

      const onResize = () => render();

      render();
      stdin.on("keypress", onKey);
      stdout.on("resize", onResize);
    });
  } finally {
    process.off("exit", restoreTerminal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    restoreTerminal();
  }
}

function tableHeader(width: number): string {
  const cwdWidth = cwdColumnWidth(width);
  const cells = [
    " ",
    "   ",
    pad("REF", 12),
    pad("STATE", 10),
    pad("BEE", 10),
    pad("AGE", 7),
    pad("CWD", cwdWidth),
    "DETAIL",
  ];
  return dim(cells.join("  "));
}

function renderRow(item: CleanTuiItem, index: number, cursor: number, selected: Set<string>, width: number): string {
  const isCurrent = index === cursor;
  const pointer = isCurrent ? ">" : " ";
  const mark = selected.has(item.name) ? "[x]" : "[ ]";
  const cwdWidth = cwdColumnWidth(width);
  const state = stateCell(item.state);
  const disabled = item.disabledReason ? dim(` ${item.disabledReason}`) : "";
  const row = [
    pointer,
    item.disabledReason ? dim(mark) : mark,
    pad(truncate(item.ref, 12), 12),
    pad(state, 10),
    pad(truncate(item.agent, 10), 10),
    pad(item.age, 7, "right"),
    pad(dim(truncate(tildify(item.cwd), cwdWidth)), cwdWidth),
    truncate(item.detail, Math.max(10, width - 76)),
    disabled,
  ].join("  ");
  if (item.disabledReason) return dim(row);
  // The selection bar must span the whole row: embedded SGR resets from
  // colored cells would cancel the inverse attribute mid-row, so render the
  // current row without inner colors.
  return isCurrent ? reverse(stripAnsi(row)) : row;
}

function renderPreview(item: CleanTuiItem | undefined, cache: Map<string, PreviewCacheEntry>, rows: number, width: number, hasLoader: boolean): string[] {
  if (!item) return blankLines(rows);
  const header = `${bold(item.name)} ${dim(item.ref)} ${dim(item.cwd)}`;
  const entry = cache.get(item.name);
  let body: string;
  if (!hasLoader) body = "No preview loader is configured.";
  else if (!entry || entry.state === "loading") body = "Loading latest transcript or pane tail...";
  else if (entry.state === "error") body = `Preview failed: ${entry.text}`;
  else body = entry.text.trim() || "No transcript or pane tail available.";

  const contentRows = Math.max(0, rows - 1);
  const bodyLines = wrapPreview(body, width, contentRows).map((line) => dim(line));
  while (bodyLines.length < contentRows) bodyLines.push("");
  return [truncate(header, width), ...bodyLines.slice(0, contentRows)];
}

export function wrapPreview(text: string, width: number, maxRows: number): string[] {
  const lines: string[] = [];
  const usableWidth = Math.max(1, width);
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0) {
      lines.push("");
    } else {
      let rest = line;
      while (rest.length > 0) {
        const end = sliceEndForWidth(rest, usableWidth);
        lines.push(rest.slice(0, end));
        rest = rest.slice(end);
      }
    }
    if (lines.length >= maxRows) break;
  }
  if (lines.length > maxRows) return lines.slice(0, maxRows);
  if (lines.length === maxRows && text.split("\n").length > maxRows) {
    lines[maxRows - 1] = truncate(`${lines[maxRows - 1]} ...`, usableWidth);
  }
  return lines;
}

// Index just past the last code point that fits within maxWidth display
// columns. Iterates by code point so surrogate pairs never get split, and
// counts wide (CJK/emoji) characters as two columns.
function sliceEndForWidth(value: string, maxWidth: number): number {
  let width = 0;
  let i = 0;
  while (i < value.length) {
    const codePoint = value.codePointAt(i)!;
    const charWidth = codePointWidth(codePoint);
    if (width + charWidth > maxWidth && width > 0) break;
    width += charWidth;
    i += codePoint > 0xffff ? 2 : 1;
  }
  return i;
}

function blankLines(count: number): string[] {
  return Array.from({ length: count }, () => "");
}

function stateCell(state: BeeState): string {
  switch (state) {
    case "active":
      return green("active");
    case "ready":
      return green("ready");
    case "booting":
      return cyan("booting");
    case "blocked":
      return yellow("blocked");
    case "idle_with_output":
      return "idle";
    case "sealed":
      return magenta("sealed");
    case "error":
      return red("error");
    case "kill_failed":
      return red("kill_fail");
    case "dead":
      return gray("dead");
    case "node_unreachable":
      return yellow("offline");
  }
}

function cwdColumnWidth(width: number): number {
  return Math.max(14, Math.min(34, width - 84));
}

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  const visible = visibleLength(value);
  if (visible >= width) return value;
  const spaces = " ".repeat(width - visible);
  return align === "right" ? `${spaces}${value}` : `${value}${spaces}`;
}

function reverse(value: string): string {
  return isPretty() ? `\x1b[7m${value}\x1b[0m` : value;
}
