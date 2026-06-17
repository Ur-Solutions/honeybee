/**
 * `hive new` — interactive, column-by-column spawn picker.
 *
 * A Miller-columns / Finder-columns wizard for standing up a fresh bee from
 * inside an attached session: choose the agent type, then the account (with live
 * usage), then config toggles, then the working directory. Enter spawns.
 *
 * This module is presentation-only and dependency-free, mirroring src/cleanTui.ts:
 * raw mode + alt screen + signal-safe restore, a single keypress handler, and a
 * full redraw per event. All data (accounts, usage, projects, path validation)
 * arrives through callbacks so the spawn wiring stays in cli.ts.
 */

import * as readline from "node:readline";
import { bold, cyan, dim, green, isPretty, red, stripAnsi, truncate, visibleLength } from "./format.js";

export type SpawnTuiType = {
  kind: string;
  /** Display label (defaults to kind). */
  label?: string;
};

export type SpawnTuiAccount = {
  /** Account id, or the literal "auto" sentinel for the least-loaded pick. */
  id: string;
  label: string;
  isAuto?: boolean;
  /** Pre-formatted usage cell, e.g. "5h 12% · wk 40%". */
  usage?: string;
  /** Near a limit — render the usage in red. */
  saturated?: boolean;
};

export type SpawnTuiProject = {
  label: string;
  path: string;
  project?: string;
};

export type SpawnTuiResult = {
  kind: string;
  /** Account id, "auto", or undefined for a plain (no-account) spawn. */
  account?: string;
  yolo: boolean;
  autoswap: boolean;
  count: number;
  cwd: string;
};

export type SpawnTuiHooks = {
  types: SpawnTuiType[];
  /** Pre-select this type's row (e.g. the current bee's agent). */
  defaultKind?: string;
  defaultCwd: string;
  /** Tildified label for the default cwd row. */
  defaultCwdLabel: string;
  /** Real accounts for a tool (no "auto" row — the picker adds it). */
  loadAccounts: (kind: string) => Promise<SpawnTuiAccount[]>;
  /** Project repos to browse (pro CLI). */
  loadProjects: () => Promise<SpawnTuiProject[]>;
  /** Validate a typed path; ok=false surfaces `error` inline. */
  validatePath: (input: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Initial yolo state for a freshly chosen type. */
  defaultYolo: (kind: string) => boolean;
};

type Stage = "type" | "account" | "config" | "project";
type ProjectView = "menu" | "browse" | "path";
type AsyncState<T> = { state: "idle" } | { state: "loading" } | { state: "loaded"; items: T } | { state: "error"; error: string };

const MAX_COUNT = 24;
const PROJECT_MENU = ["here", "project", "path"] as const;

/**
 * The account-column rule (kept pure for testing): with two or more real
 * accounts the picker shows an interactive column led by an "Auto" row; with
 * exactly one it binds that account silently; with none it spawns without an
 * account. `showColumn` decides whether the wizard pauses on the account stage.
 */
export function resolveAccountStep(real: SpawnTuiAccount[]): {
  showColumn: boolean;
  account?: string;
  label: string;
  rows: SpawnTuiAccount[];
} {
  if (real.length >= 2) {
    const auto: SpawnTuiAccount = { id: "auto", label: "Auto", isAuto: true, usage: "least-loaded" };
    return { showColumn: true, label: "", rows: [auto, ...real] };
  }
  if (real.length === 1) return { showColumn: false, account: real[0]!.id, label: real[0]!.label, rows: [] };
  return { showColumn: false, account: undefined, label: "no account", rows: [] };
}

export async function chooseNewBee(hooks: SpawnTuiHooks): Promise<SpawnTuiResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hive new requires a TTY — run it from a tmux popup binding (e.g. M-n) or an interactive terminal.");
  }
  if (hooks.types.length === 0) throw new Error("hive new: no agent types are available.");

  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRaw = stdin.isRaw;

  // ── selection state ─────────────────────────────────────────────────────
  let stage: Stage = "type";
  let selKind = "";
  let selAccount: string | undefined; // account id, "auto", or undefined
  let accountLabel = "";              // human label for the resolved account
  let yolo = false;
  let autoswap = false;
  let count = 1;
  let selCwd = hooks.defaultCwd;

  // ── per-stage cursors ───────────────────────────────────────────────────
  const initialType = Math.max(0, hooks.types.findIndex((t) => t.kind === hooks.defaultKind));
  let cursorType = initialType;
  let cursorAccount = 0;
  let cursorConfig = 0;
  let cursorProjectMenu = 0;
  let cursorBrowse = 0;
  let browseScroll = 0;

  // ── async-loaded data ───────────────────────────────────────────────────
  let accounts: AsyncState<SpawnTuiAccount[]> = { state: "idle" };
  let accountRows: SpawnTuiAccount[] = []; // [auto, ...real] once loaded
  let projects: AsyncState<SpawnTuiProject[]> = { state: "idle" };
  let projectView: ProjectView = "menu";
  let pathBuffer = "";
  let pathError = "";
  let message = "↑↓ pick · → enter advance · ← back · q cancel";

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
    return await new Promise<SpawnTuiResult | null>((resolve) => {
      let done = false;
      const finish = (result: SpawnTuiResult | null) => {
        if (done) return;
        done = true;
        stdin.off("keypress", onKey);
        stdout.off("resize", onResize);
        resolve(result);
      };

      // ── config rows are dynamic (autoswap depends on an account) ──────────
      const configRows = (): Array<"yolo" | "autoswap" | "count"> => ["yolo", "autoswap", "count"];

      const accountSelectable = () => selAccount !== undefined;

      const enterConfig = () => {
        stage = "config";
        cursorConfig = 0;
        if (!accountSelectable()) autoswap = false;
        message = "space toggles · +/- count · → enter advance · ← back";
        render();
      };

      // Resolve the account list after a type is chosen; skip the column when
      // there are 0 or 1 real accounts (nothing to choose).
      const chooseType = async () => {
        const type = hooks.types[cursorType];
        if (!type) return;
        selKind = type.kind;
        yolo = hooks.defaultYolo(selKind);
        autoswap = false;
        accounts = { state: "loading" };
        accountRows = [];
        selAccount = undefined;
        accountLabel = "";
        render();
        let real: SpawnTuiAccount[] = [];
        try {
          real = await hooks.loadAccounts(selKind);
          accounts = { state: "loaded", items: real };
        } catch (error) {
          accounts = { state: "error", error: error instanceof Error ? error.message : String(error) };
        }
        if (done) return;
        const step = resolveAccountStep(real);
        if (!step.showColumn) {
          // 0 → plain spawn; 1 → bind that account directly. No column.
          selAccount = step.account;
          accountLabel = step.label;
          enterConfig();
          return;
        }
        accountRows = step.rows;
        cursorAccount = 0;
        stage = "account";
        message = "↑↓ pick account · → enter advance · ← back";
        render();
      };

      const chooseAccount = () => {
        const row = accountRows[cursorAccount];
        if (!row) return;
        selAccount = row.id;
        accountLabel = row.label;
        enterConfig();
      };

      const loadProjectsIfNeeded = async () => {
        if (projects.state === "loaded" || projects.state === "loading") return;
        projects = { state: "loading" };
        render();
        try {
          const items = await hooks.loadProjects();
          projects = { state: "loaded", items };
        } catch (error) {
          projects = { state: "error", error: error instanceof Error ? error.message : String(error) };
        }
        if (!done) render();
      };

      const enterProject = () => {
        stage = "project";
        projectView = "menu";
        cursorProjectMenu = 0;
        message = "↑↓ pick · enter: spawn / browse / type a path · ← back";
        render();
      };

      const spawn = () => {
        finish({ kind: selKind, account: selAccount, yolo, autoswap, count, cwd: selCwd });
      };

      // ── project column actions ────────────────────────────────────────────
      const activateProjectMenu = () => {
        const choice = PROJECT_MENU[cursorProjectMenu];
        if (choice === "here") {
          selCwd = hooks.defaultCwd;
          spawn();
        } else if (choice === "project") {
          projectView = "browse";
          cursorBrowse = 0;
          browseScroll = 0;
          message = "↑↓ pick repo · enter spawn here · ← back to project menu";
          void loadProjectsIfNeeded();
          render();
        } else {
          projectView = "path";
          pathBuffer = hooks.defaultCwd;
          pathError = "";
          message = "type a path · enter to validate & spawn · esc to go back";
          stdout.write("\x1b[?25h"); // show cursor for typing
          render();
        }
      };

      const chooseBrowse = () => {
        if (projects.state !== "loaded") return;
        const repo = projects.items[cursorBrowse];
        if (!repo) return;
        selCwd = repo.path;
        spawn();
      };

      const submitPath = async () => {
        const input = pathBuffer.trim();
        if (!input) { pathError = "enter a path"; render(); return; }
        const result = await hooks.validatePath(input);
        if (done) return;
        if (!result.ok || !result.path) {
          pathError = result.error ?? "invalid path";
          render();
          return;
        }
        stdout.write("\x1b[?25l");
        selCwd = result.path;
        spawn();
      };

      // ── navigation ────────────────────────────────────────────────────────
      const goBack = () => {
        if (stage === "type") { finish(null); return; }
        if (stage === "account") { stage = "type"; message = "↑↓ pick type · → enter advance · q cancel"; render(); return; }
        if (stage === "config") {
          // back to account if it had a column, else to type
          if (accountRows.length > 0) { stage = "account"; } else { stage = "type"; }
          render();
          return;
        }
        // project
        if (projectView === "browse" || projectView === "path") {
          projectView = "menu";
          stdout.write("\x1b[?25l");
          message = "↑↓ pick · enter: spawn / browse / type a path · ← back";
          render();
          return;
        }
        stage = "config";
        message = "space toggles · +/- count · → enter advance · ← back";
        render();
      };

      const moveCursor = (delta: number) => {
        if (stage === "type") cursorType = clamp(cursorType + delta, hooks.types.length);
        else if (stage === "account") cursorAccount = clamp(cursorAccount + delta, accountRows.length);
        else if (stage === "config") cursorConfig = clamp(cursorConfig + delta, configRows().length);
        else if (stage === "project") {
          if (projectView === "menu") cursorProjectMenu = clamp(cursorProjectMenu + delta, PROJECT_MENU.length);
          else if (projectView === "browse" && projects.state === "loaded") cursorBrowse = clamp(cursorBrowse + delta, projects.items.length);
        }
        render();
      };

      const advance = () => {
        if (stage === "type") { void chooseType(); return; }
        if (stage === "account") { chooseAccount(); return; }
        if (stage === "config") { enterProject(); return; }
        // project
        if (projectView === "menu") { activateProjectMenu(); return; }
        if (projectView === "browse") { chooseBrowse(); return; }
        if (projectView === "path") { void submitPath(); return; }
      };

      const toggleConfig = () => {
        if (stage !== "config") return;
        const row = configRows()[cursorConfig];
        if (row === "yolo") yolo = !yolo;
        else if (row === "autoswap") {
          if (!accountSelectable()) { message = "autoswap needs an account — pick one in the account column"; render(); return; }
          autoswap = !autoswap;
        } else if (row === "count") {
          // space on count cycles +1 (wraps), +/- for fine control
          count = count >= MAX_COUNT ? 1 : count + 1;
        }
        render();
      };

      const adjustCount = (delta: number) => {
        if (stage === "config") {
          count = clampValue(count + delta, 1, MAX_COUNT);
          cursorConfig = configRows().indexOf("count");
          render();
        }
      };

      // ── path-input typing ─────────────────────────────────────────────────
      const handlePathKey = (value: string, key: readline.Key): boolean => {
        if (!(stage === "project" && projectView === "path")) return false;
        if (key.name === "return" || key.name === "enter") { void submitPath(); return true; }
        if (key.name === "escape") { goBack(); return true; }
        if (key.name === "backspace") { pathBuffer = pathBuffer.slice(0, -1); pathError = ""; render(); return true; }
        if (key.ctrl && key.name === "u") { pathBuffer = ""; pathError = ""; render(); return true; }
        if (key.ctrl || key.meta) return true; // swallow other control keys
        if (value && value.length === 1 && value >= " ") { pathBuffer += value; pathError = ""; render(); return true; }
        return true; // in path mode, consume everything else
      };

      const onKey = (value: string, key: readline.Key) => {
        if (key.ctrl && key.name === "c") { finish(null); return; }
        if (handlePathKey(value, key)) return;
        switch (key.name) {
          case "q":
          case "escape":
            finish(null);
            return;
          case "up":
          case "k":
            moveCursor(-1);
            return;
          case "down":
          case "j":
            moveCursor(1);
            return;
          case "left":
          case "h":
            goBack();
            return;
          case "right":
          case "l":
          case "return":
          case "enter":
            advance();
            return;
          case "space":
            toggleConfig();
            return;
        }
        if (value === "+" || value === "=") adjustCount(1);
        else if (value === "-" || value === "_") adjustCount(-1);
      };

      // ── rendering ──────────────────────────────────────────────────────────
      const render = () => {
        if (done) return;
        const width = Math.max(40, stdout.columns || 100);
        const height = Math.max(12, stdout.rows || 24);
        const bodyRows = Math.max(6, height - 6);

        const inBrowse = stage === "project" && projectView === "browse";
        const inPath = stage === "project" && projectView === "path";

        const header = `${bold("hive new")}  ${dim(breadcrumb())}`;
        const lines: string[] = [header, ""];

        if (inBrowse || inPath) {
          lines.push(...renderFull(width, bodyRows, inBrowse));
        } else {
          lines.push(...renderColumns(width, bodyRows));
        }

        // pad body
        while (lines.length < height - 2) lines.push("");
        lines.push(truncate(pathError ? red(pathError) : message, width));
        lines.push(dim("j/k move · h/l columns · enter advance · +/- count · q quit"));
        stdout.write(`\x1b[2J\x1b[H${lines.map((line) => truncate(line, width)).join("\n")}`);
        if (inPath) {
          // Park the real cursor at the end of the input line. Body starts on
          // the 3rd line (header, blank, then "  <buffer>"); the buffer is
          // indented two columns.
          const promptRow = 3;
          stdout.write(`\x1b[${promptRow};${2 + visibleLength(pathBuffer) + 1}H`);
        }
      };

      const breadcrumb = (): string => {
        const parts: string[] = [];
        if (selKind) parts.push(selKind);
        if (selKind && accountLabel) parts.push(accountLabel);
        if (parts.length === 0) return "pick a type to begin";
        const cfg: string[] = [];
        if (yolo) cfg.push("yolo");
        if (autoswap) cfg.push("autoswap");
        if (count > 1) cfg.push(`×${count}`);
        if (cfg.length) parts.push(cfg.join("+"));
        return parts.join("  ›  ");
      };

      const renderColumns = (width: number, bodyRows: number): string[] => {
        const colCount = 4;
        const sep = " │ ";
        const inner = Math.max(12, Math.floor((width - sep.length * (colCount - 1)) / colCount));
        const cols: string[][] = [
          column("TYPE", typeColumn(inner), stage === "type", inner, bodyRows),
          column("ACCOUNT", accountColumn(inner), stage === "account", inner, bodyRows),
          column("CONFIG", configColumn(inner), stage === "config", inner, bodyRows),
          column("PROJECT", projectColumn(inner), stage === "project", inner, bodyRows),
        ];
        const rowsOut: string[] = [];
        const rowN = bodyRows + 1; // +1 for the title row inside column()
        for (let r = 0; r < rowN; r += 1) {
          rowsOut.push(cols.map((c) => padCell(c[r] ?? "", inner)).join(dim(sep)));
        }
        return rowsOut;
      };

      const typeColumn = (w: number): Cell[] =>
        hooks.types.map((t, i) => ({ text: truncate(t.label ?? t.kind, w), active: stage === "type" && i === cursorType, chosen: t.kind === selKind }));

      const accountColumn = (w: number): Cell[] => {
        if (stage === "type" || (accounts.state === "idle")) return [{ text: dim("·") }];
        if (accounts.state === "loading") return [{ text: dim("loading…") }];
        if (accounts.state === "error") return wrapCell(red(accounts.error), w);
        if (accountRows.length === 0) {
          return [{ text: dim(accountLabel || "no account") }];
        }
        return accountRows.map((a, i) => {
          const usage = a.usage ? "  " + (a.saturated ? red(a.usage) : dim(a.usage)) : "";
          const name = a.isAuto ? bold(a.label) : a.label;
          return {
            text: truncate(`${name}${usage}`, w),
            active: stage === "account" && i === cursorAccount,
            chosen: selAccount === a.id,
          };
        });
      };

      const configColumn = (w: number): Cell[] => {
        if (stage === "type" || stage === "account") return [{ text: dim("·") }];
        const rows = configRows();
        return rows.map((row, i) => {
          let text: string;
          if (row === "yolo") text = `${box(yolo)} yolo`;
          else if (row === "autoswap") text = accountSelectable() ? `${box(autoswap)} autoswap` : dim(`${box(false)} autoswap`);
          else text = `count: ${bold(String(count))}`;
          return { text: truncate(text, w), active: stage === "config" && i === cursorConfig };
        });
      };

      const projectColumn = (w: number): Cell[] => {
        if (stage !== "project") return [{ text: dim("·") }];
        const rows = [
          `here  ${dim(truncate(hooks.defaultCwdLabel, Math.max(6, w - 6)))}`,
          "project…",
          "path…",
        ];
        return rows.map((text, i) => ({ text: truncate(text, w), active: projectView === "menu" && i === cursorProjectMenu }));
      };

      const renderFull = (width: number, bodyRows: number, inBrowse: boolean): string[] => {
        if (inBrowse) {
          if (projects.state === "loading") return [dim("loading projects from `pro`…")];
          if (projects.state === "error") return [red(projects.error), "", dim("press ← to go back and choose another option")];
          if (projects.state !== "loaded" || projects.items.length === 0) return [dim("no pro repos found"), "", dim("press ← to go back")];
          const items = projects.items;
          if (cursorBrowse < browseScroll) browseScroll = cursorBrowse;
          if (cursorBrowse >= browseScroll + bodyRows) browseScroll = cursorBrowse - bodyRows + 1;
          const visible = items.slice(browseScroll, browseScroll + bodyRows);
          return visible.map((repo, i) => {
            const idx = browseScroll + i;
            const pointer = idx === cursorBrowse ? green("›") : " ";
            const label = truncate(repo.label, Math.max(10, Math.floor(width * 0.5)));
            const path = dim(truncate(repo.path, Math.max(10, width - visibleLength(label) - 6)));
            const line = `${pointer} ${idx === cursorBrowse ? bold(label) : label}  ${path}`;
            return idx === cursorBrowse && isPretty() ? reverse(stripAnsi(line)) : line;
          });
        }
        // path input
        return [
          `  ${pathBuffer}`,
          "",
          dim("enter to validate & spawn · esc to go back · ctrl-u clears"),
        ];
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

// ── small rendering helpers ─────────────────────────────────────────────────

type Cell = { text: string; active?: boolean; chosen?: boolean };

function column(title: string, cells: Cell[], active: boolean, width: number, rows: number): string[] {
  const head = active ? bold(cyan(title)) : dim(title);
  const out: string[] = [head];
  for (let i = 0; i < rows; i += 1) {
    const cell = cells[i];
    if (!cell) { out.push(""); continue; }
    let text = cell.text;
    if (cell.chosen && !cell.active) text = green(stripAnsi(text));
    if (cell.active && isPretty()) text = reverse(stripAnsi(text));
    out.push(text);
  }
  return out;
}

function wrapCell(text: string, width: number): Cell[] {
  const plain = stripAnsi(text);
  const out: Cell[] = [];
  for (let i = 0; i < plain.length; i += width) out.push({ text: plain.slice(i, i + width) });
  return out.length ? out : [{ text }];
}

function padCell(value: string, width: number): string {
  const visible = visibleLength(value);
  if (visible >= width) return value;
  return value + " ".repeat(width - visible);
}

function box(on: boolean): string {
  return on ? green("[x]") : "[ ]";
}

function clamp(next: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, next));
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function reverse(value: string): string {
  return isPretty() ? `\x1b[7m${value}\x1b[0m` : value;
}
