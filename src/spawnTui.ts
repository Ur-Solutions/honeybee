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
  /**
   * List directories up to two levels deep under `base` (junk like
   * node_modules/dist/.git filtered out), for the path-mode live completion.
   * Returns the resolved absolute base and absolute dir paths.
   */
  listSubdirs: (base: string) => Promise<{ ok: boolean; base: string; dirs: string[]; error?: string }>;
  /** Initial yolo state for a freshly chosen type. */
  defaultYolo: (kind: string) => boolean;
  /**
   * Resolve which pro repo a chosen cwd lives in. `null` (not a pro repo, or no
   * `pro` CLI) skips the worktree/checkout step and spawns in the cwd directly.
   * The returned `path` is the repo root pro runs against; `label` is shown.
   */
  proRepoForCwd: (cwd: string) => Promise<{ label: string; path: string } | null>;
  /** Suggested default slot name for a worktree/checkout (per agent kind). */
  suggestDirName: (kind: string) => string;
  /**
   * Create (or reuse) a pro worktree/checkout beside the repo; resolves to its
   * absolute path, which becomes the spawn cwd. ok=false surfaces `error` inline.
   */
  createProDir: (kind: "worktree" | "checkout", repoPath: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
};

type Stage = "type" | "account" | "config" | "project" | "isolation";
type ProjectView = "menu" | "browse" | "path";
type IsolationView = "menu" | "name";
type AsyncState<T> = { state: "idle" } | { state: "loading" } | { state: "loaded"; items: T } | { state: "error"; error: string };

const MAX_COUNT = 24;
const PROJECT_MENU = ["here", "project", "path"] as const;
const ISOLATION_MENU = ["here", "worktree", "checkout"] as const;

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

/**
 * fzf-style incremental filter (kept pure for testing). Empty query keeps the
 * original order; otherwise items are ranked: exact substring beats a scattered
 * subsequence, earlier and more contiguous matches score higher, ties break on
 * the shorter candidate. Non-matches are dropped.
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

function expandTilde(value: string): string {
  return value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
}

/** Display an absolute dir relative to `base` (falls back to the abs path). */
export function relativeTo(base: string, abs: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
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
  let cursorPath = 0;
  let pathScroll = 0;

  // ── async-loaded data ───────────────────────────────────────────────────
  let accounts: AsyncState<SpawnTuiAccount[]> = { state: "idle" };
  let accountRows: SpawnTuiAccount[] = []; // [auto, ...real] once loaded
  let projects: AsyncState<SpawnTuiProject[]> = { state: "idle" };
  let projectView: ProjectView = "menu";
  let browseQuery = "";                     // fzf filter for the pro repo list
  let pathBuffer = "";                      // typed path (path mode)
  let pathError = "";
  // Live subdir completion for path mode, keyed by the base dir being listed.
  let subdirs: AsyncState<{ base: string; dirs: string[] }> = { state: "idle" };
  let subdirsBase = "";                     // raw base string we last requested
  // ── isolation state (only when the chosen cwd is inside a pro repo) ───────
  let proTarget: { label: string; path: string } | null = null;
  let isolationView: IsolationView = "menu";
  let isolationMode: "worktree" | "checkout" = "worktree";
  let cursorIsolation = 0;
  let nameBuffer = "";                       // typed worktree/checkout name
  let nameError = "";
  let isoBusy = false;                       // creating the slot (ignore input)
  let resolvingCwd = false;                  // detecting pro repo (guards re-entry)
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

      // A cwd has been chosen (here / browse / path). If it lives inside a pro
      // repo, offer the worktree/checkout step before spawning; otherwise spawn
      // straight in the cwd (unchanged behavior for non-pro dirs).
      const finalizeCwd = async (cwd: string) => {
        if (resolvingCwd) return;
        resolvingCwd = true;
        selCwd = cwd;
        message = "checking pro repo…";
        render();
        let target: { label: string; path: string } | null = null;
        try {
          target = await hooks.proRepoForCwd(cwd);
        } catch {
          target = null;
        }
        resolvingCwd = false;
        if (done) return;
        if (!target) { spawn(); return; }
        proTarget = target;
        stage = "isolation";
        isolationView = "menu";
        cursorIsolation = 0;
        nameError = "";
        isoBusy = false;
        stdout.write("\x1b[?25l"); // menu mode: no typing cursor
        message = "↑↓ pick · enter select · ← back";
        render();
      };

      const enterIsolationName = (mode: "worktree" | "checkout") => {
        isolationMode = mode;
        isolationView = "name";
        nameBuffer = hooks.suggestDirName(selKind);
        nameError = "";
        message = "type a name · enter create & spawn · esc back";
        stdout.write("\x1b[?25h");
        render();
      };

      const activateIsolationMenu = () => {
        const choice = ISOLATION_MENU[cursorIsolation];
        if (choice === "here") { spawn(); return; }
        enterIsolationName(choice);
      };

      const submitIsolationName = async () => {
        if (isoBusy) return;
        const name = nameBuffer.trim();
        if (!name) { nameError = "enter a name"; render(); return; }
        if (!proTarget) { nameError = "no pro repo"; render(); return; }
        isoBusy = true;
        message = `creating ${isolationMode}…`;
        render();
        let res: { ok: boolean; path?: string; error?: string };
        try {
          res = await hooks.createProDir(isolationMode, proTarget.path, name);
        } catch (error) {
          res = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        isoBusy = false;
        if (done) return;
        if (!res.ok || !res.path) { nameError = res.error ?? `could not create ${isolationMode}`; render(); return; }
        stdout.write("\x1b[?25l");
        selCwd = res.path;
        spawn();
      };

      // ── project column actions ────────────────────────────────────────────
      const filteredProjects = (): SpawnTuiProject[] =>
        projects.state === "loaded" ? fuzzyFilter(browseQuery, projects.items, (repo) => repo.label) : [];

      const filteredSubdirs = (): Array<{ abs: string; rel: string }> => {
        if (subdirs.state !== "loaded") return [];
        const { base, dirs } = subdirs.items;
        const { query } = splitPathQuery(expandTilde(pathBuffer));
        const rows = dirs.map((abs) => ({ abs, rel: relativeTo(base, abs) }));
        return fuzzyFilter(query, rows, (row) => row.rel);
      };

      const activateProjectMenu = () => {
        const choice = PROJECT_MENU[cursorProjectMenu];
        if (choice === "here") {
          void finalizeCwd(hooks.defaultCwd);
        } else if (choice === "project") {
          projectView = "browse";
          browseQuery = "";
          cursorBrowse = 0;
          browseScroll = 0;
          message = "type to filter · ↑↓ pick · enter spawn · esc back";
          stdout.write("\x1b[?25h"); // show cursor for the filter field
          void loadProjectsIfNeeded();
          render();
        } else {
          projectView = "path";
          pathBuffer = hooks.defaultCwd.endsWith("/") ? hooks.defaultCwd : `${hooks.defaultCwd}/`;
          pathError = "";
          subdirs = { state: "idle" };
          subdirsBase = "";
          cursorPath = 0;
          pathScroll = 0;
          message = "type to filter · ↑↓ pick · tab drills in · enter spawn · esc back";
          stdout.write("\x1b[?25h");
          refreshPathCompletion();
        }
      };

      const chooseBrowse = () => {
        const repo = filteredProjects()[cursorBrowse];
        if (!repo) return;
        void finalizeCwd(repo.path);
      };

      // Reload the subdir list whenever the directory portion of the buffer
      // changes; editing only the trailing query reuses the loaded list.
      const refreshPathCompletion = () => {
        const { base } = splitPathQuery(expandTilde(pathBuffer));
        if (base === subdirsBase && subdirs.state !== "idle") { render(); return; }
        subdirsBase = base;
        subdirs = { state: "loading" };
        cursorPath = 0;
        pathScroll = 0;
        render();
        void hooks
          .listSubdirs(base)
          .then((res) => {
            if (done) return;
            if (splitPathQuery(expandTilde(pathBuffer)).base !== base) return; // stale
            subdirs = res.ok
              ? { state: "loaded", items: { base: res.base, dirs: res.dirs } }
              : { state: "error", error: res.error ?? "cannot read directory" };
            render();
          })
          .catch((error) => {
            if (done) return;
            subdirs = { state: "error", error: error instanceof Error ? error.message : String(error) };
            render();
          });
      };

      const drillPath = () => {
        const pick = filteredSubdirs()[cursorPath];
        if (!pick) return;
        pathBuffer = pick.abs.endsWith("/") ? pick.abs : `${pick.abs}/`;
        pathError = "";
        cursorPath = 0;
        refreshPathCompletion();
      };

      const submitPath = async () => {
        const pick = filteredSubdirs()[cursorPath];
        if (pick) {
          stdout.write("\x1b[?25l");
          void finalizeCwd(pick.abs);
          return;
        }
        // Nothing matched the completion — fall back to validating the literal text.
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
        void finalizeCwd(result.path);
      };

      // ── navigation ────────────────────────────────────────────────────────
      const goBack = () => {
        if (stage === "isolation") {
          if (isolationView === "name") {
            isolationView = "menu";
            nameError = "";
            stdout.write("\x1b[?25l");
            message = "↑↓ pick · enter select · ← back";
            render();
            return;
          }
          // back from the isolation menu to the project menu
          stage = "project";
          projectView = "menu";
          message = "↑↓ pick · enter: spawn / browse / type a path · ← back";
          render();
          return;
        }
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
        // Browse/path modes capture their own up/down in the typing handler
        // (j/k are literal text there), so this only covers menu-style stages.
        if (stage === "type") cursorType = clamp(cursorType + delta, hooks.types.length);
        else if (stage === "account") cursorAccount = clamp(cursorAccount + delta, accountRows.length);
        else if (stage === "config") cursorConfig = clamp(cursorConfig + delta, configRows().length);
        else if (stage === "project" && projectView === "menu") cursorProjectMenu = clamp(cursorProjectMenu + delta, PROJECT_MENU.length);
        else if (stage === "isolation" && isolationView === "menu") cursorIsolation = clamp(cursorIsolation + delta, ISOLATION_MENU.length);
        render();
      };

      const moveBrowse = (delta: number) => { cursorBrowse = clamp(cursorBrowse + delta, filteredProjects().length); render(); };
      const movePath = (delta: number) => { cursorPath = clamp(cursorPath + delta, filteredSubdirs().length); render(); };

      const advance = () => {
        if (stage === "type") { void chooseType(); return; }
        if (stage === "account") { chooseAccount(); return; }
        if (stage === "config") { enterProject(); return; }
        if (stage === "isolation") { if (isolationView === "menu") activateIsolationMenu(); return; }
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

      // ── type-to-filter modes ──────────────────────────────────────────────
      // Both the pro-repo browser and the path completer are fzf-style: letters
      // edit a query, arrows move the highlight (j/k would be literal text).
      const isPrintable = (value: string, key: readline.Key) =>
        Boolean(value) && value.length === 1 && value >= " " && !key.ctrl && !key.meta;

      const handleBrowseKey = (value: string, key: readline.Key): boolean => {
        if (!(stage === "project" && projectView === "browse")) return false;
        if (key.name === "return" || key.name === "enter") { chooseBrowse(); return true; }
        if (key.name === "escape" || key.name === "left") { goBack(); return true; }
        if (key.name === "up") { moveBrowse(-1); return true; }
        if (key.name === "down") { moveBrowse(1); return true; }
        if (key.name === "backspace") { browseQuery = browseQuery.slice(0, -1); cursorBrowse = 0; render(); return true; }
        if (key.ctrl && key.name === "u") { browseQuery = ""; cursorBrowse = 0; render(); return true; }
        if (isPrintable(value, key)) { browseQuery += value; cursorBrowse = 0; render(); return true; }
        return true; // consume everything else while filtering
      };

      const handlePathKey = (value: string, key: readline.Key): boolean => {
        if (!(stage === "project" && projectView === "path")) return false;
        if (key.name === "return" || key.name === "enter") { void submitPath(); return true; }
        if (key.name === "escape" || key.name === "left") { goBack(); return true; }
        if (key.name === "tab") { drillPath(); return true; }
        if (key.name === "up") { movePath(-1); return true; }
        if (key.name === "down") { movePath(1); return true; }
        if (key.name === "backspace") { pathBuffer = pathBuffer.slice(0, -1); pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
        if (key.ctrl && key.name === "u") { pathBuffer = ""; pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
        if (isPrintable(value, key)) { pathBuffer += value; pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
        return true;
      };

      // Name entry for a worktree/checkout — a single text field (no completion
      // list). The isolation MENU is steered by the global nav handler below.
      const handleIsolationNameKey = (value: string, key: readline.Key): boolean => {
        if (!(stage === "isolation" && isolationView === "name")) return false;
        if (isoBusy) return true; // creating — swallow input until it resolves
        if (key.name === "return" || key.name === "enter") { void submitIsolationName(); return true; }
        if (key.name === "escape" || key.name === "left") { goBack(); return true; }
        if (key.name === "backspace") { nameBuffer = nameBuffer.slice(0, -1); nameError = ""; render(); return true; }
        if (key.ctrl && key.name === "u") { nameBuffer = ""; nameError = ""; render(); return true; }
        if (isPrintable(value, key)) { nameBuffer += value; nameError = ""; render(); return true; }
        return true;
      };

      const onKey = (value: string, key: readline.Key) => {
        if (key.ctrl && key.name === "c") { finish(null); return; }
        if (handleBrowseKey(value, key)) return;
        if (handlePathKey(value, key)) return;
        if (handleIsolationNameKey(value, key)) return;
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
        const inIsolation = stage === "isolation";
        const inIsoName = inIsolation && isolationView === "name";

        const header = `${bold("hive new")}  ${dim(breadcrumb())}`;
        const lines: string[] = [header, ""];

        if (inIsolation) {
          lines.push(...renderIsolation(width));
        } else if (inBrowse || inPath) {
          lines.push(...renderFull(width, bodyRows, inBrowse));
        } else {
          lines.push(...renderColumns(width, bodyRows));
        }

        // pad body
        while (lines.length < height - 2) lines.push("");
        const errLine = pathError || nameError;
        lines.push(truncate(errLine ? red(errLine) : message, width));
        let footer: string;
        if (inBrowse || inPath) footer = "type to filter · ↑↓ move · enter select · esc back";
        else if (inIsoName) footer = "type a name · enter create & spawn · esc back";
        else if (inIsolation) footer = "j/k move · enter select · ← back · q quit";
        else footer = "j/k move · h/l columns · enter advance · +/- count · q quit";
        lines.push(dim(footer));
        stdout.write(`\x1b[2J\x1b[H${lines.map((line) => truncate(line, width)).join("\n")}`);
        if (inPath || inBrowse || inIsoName) {
          // Park the real cursor at the end of the "> " filter/name field. Body
          // starts on the 3rd screen line (header, blank, then "> <text>"),
          // and the "> " prompt is two columns wide.
          const text = inIsoName ? nameBuffer : inPath ? pathBuffer : browseQuery;
          stdout.write(`\x1b[3;${2 + visibleLength(text) + 1}H`);
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
        const listRows = Math.max(1, bodyRows - 2);
        if (inBrowse) {
          const total = projects.state === "loaded" ? projects.items.length : 0;
          const list = filteredProjects();
          const out: string[] = [`${cyan("> ")}${browseQuery}`];
          if (projects.state === "loading") { out.push(dim("loading repos from `pro`…")); return out; }
          if (projects.state === "error") { out.push(red(projects.error)); return out; }
          out.push(dim(`${list.length}/${total} repos`));
          if (list.length === 0) { out.push(dim(total === 0 ? "no pro repos found" : "no match")); return out; }
          if (cursorBrowse < browseScroll) browseScroll = cursorBrowse;
          if (cursorBrowse >= browseScroll + listRows) browseScroll = cursorBrowse - listRows + 1;
          for (let i = 0; i < Math.min(listRows, list.length - browseScroll); i += 1) {
            const idx = browseScroll + i;
            const repo = list[idx]!;
            const pointer = idx === cursorBrowse ? green("›") : " ";
            const label = truncate(repo.label, Math.max(10, Math.floor(width * 0.5)));
            const path = dim(truncate(repo.path, Math.max(10, width - visibleLength(label) - 6)));
            const line = `${pointer} ${idx === cursorBrowse ? bold(label) : label}  ${path}`;
            out.push(idx === cursorBrowse && isPretty() ? reverse(stripAnsi(line)) : line);
          }
          return out;
        }
        // path completion
        const list = filteredSubdirs();
        const out: string[] = [`${cyan("> ")}${pathBuffer}`];
        if (subdirs.state === "loading") { out.push(dim("scanning…")); return out; }
        if (subdirs.state === "error") { out.push(dim(`${subdirs.error} — enter spawns the typed path`)); return out; }
        out.push(dim(list.length === 0 ? "no subfolders match — enter spawns the typed path" : `${list.length} folder${list.length === 1 ? "" : "s"} · tab drills in`));
        if (cursorPath < pathScroll) pathScroll = cursorPath;
        if (cursorPath >= pathScroll + listRows) pathScroll = cursorPath - listRows + 1;
        for (let i = 0; i < Math.min(listRows, list.length - pathScroll); i += 1) {
          const idx = pathScroll + i;
          const row = list[idx]!;
          const pointer = idx === cursorPath ? green("›") : " ";
          const line = `${pointer} ${row.rel}`;
          out.push(idx === cursorPath && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
        }
        return out;
      };

      // Isolation step: a small menu (here / worktree / checkout), then a single
      // name field. The name field is the first body line so the shared cursor
      // parking in render() lands on it (screen line 3).
      const renderIsolation = (width: number): string[] => {
        const label = proTarget?.label ?? "";
        if (isolationView === "name") {
          const tool = isolationMode === "worktree" ? "pro wt" : "pro co";
          return [`${cyan("> ")}${nameBuffer}`, dim(`${tool} · ${label}`)];
        }
        const rows = [
          `here       ${dim("spawn in the repo as-is")}`,
          `worktree   ${dim("pro wt — new git worktree (shared .git, own branch)")}`,
          `checkout   ${dim("pro co — full --local clone")}`,
        ];
        const out: string[] = [dim(`pro repo: ${label}`), ""];
        rows.forEach((text, i) => {
          const pointer = i === cursorIsolation ? green("›") : " ";
          const line = `${pointer} ${text}`;
          out.push(i === cursorIsolation && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
        });
        return out;
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
