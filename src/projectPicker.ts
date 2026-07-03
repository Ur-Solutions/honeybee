/**
 * ProjectPicker — the three-mode repo/cwd picker (here · browse · type-a-path)
 * shared by `hive new`, `hive loop launch`, and `hive launch`. It used to be
 * triplicated ~verbatim across the three launchers; the fuzzy repo browser, the
 * live path-completion field, the scroll math, and the key handling now live
 * here once.
 *
 * The launchers differ only in wording and in what "choose" means, so those are
 * `ProjectPickerConfig`. `hive new` renders its own Miller-column menu (so it
 * sets `ownsMenu: false` and drives `enterBrowse()`/`enterPath()` itself); the
 * loop/launch dialogs let the picker own the standalone here/browse/path menu.
 */

import type * as readline from "node:readline";
import { bold, cyan, dim, green, isPretty, red, stripAnsi, truncate, visibleLength } from "./format.js";
import {
  type AsyncState,
  clamp,
  expandTilde,
  fuzzyFilter,
  isPrintable,
  relativeTo,
  reverse,
  splitPathQuery,
} from "./tuiKit.js";
import { createFilterList, type Screen, visibleWindow } from "./tuiScreen.js";

/** A browsable repo/cwd row. */
export type ProjectItem = { label: string; path: string; project?: string };

export type ProjectPickerHooks = {
  defaultCwd: string;
  /** Tildified label for the "here" row. */
  defaultCwdLabel: string;
  loadProjects: () => Promise<ProjectItem[]>;
  /** Validate a typed path; ok=false surfaces `error` inline. */
  validatePath: (input: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** List directories under `base` for the path-mode live completion. */
  listSubdirs: (base: string) => Promise<{ ok: boolean; base: string; dirs: string[]; error?: string }>;
};

/** The per-launcher wording (the only cosmetic differences between the three). */
export type ProjectPickerText = {
  /** Menu row label for the browse mode ("project…" / "browse repos…"). */
  browseMenuLabel: string;
  /** Menu row label for the path mode ("path…" / "type a path…"). */
  pathMenuLabel: string;
  /** Status message while on the menu. */
  menuMessage: string;
  /** Status message while browsing repos. */
  browseMessage: string;
  /** Status message while typing a path. */
  pathMessage: string;
  /** Body line while the repo list loads ("loading repos…"). */
  browseLoading: string;
  /** Body line when there are no repos at all ("no repos found"). */
  browseEmptyNone: string;
  /** Tail of the path status/error lines ("enter spawns/uses the typed path"). */
  pathFallback: string;
};

export type ProjectPickerConfig = {
  hooks: ProjectPickerHooks;
  text: ProjectPickerText;
  /**
   * Whether this picker renders + drives its own here/browse/path menu. `hive
   * new` keeps its Miller column and sets false, driving enterBrowse/enterPath
   * itself; loop/launch set true.
   */
  ownsMenu: boolean;
  /**
   * A cwd was chosen. `source` distinguishes the menu "here" row from a browsed
   * repo or a typed/drilled path (the launchers use it for cursor management).
   */
  onChosen: (path: string, source: "here" | "browse" | "path") => void;
  /** Menu left/h — leave the picker to the previous wizard stage (ownsMenu). */
  onBack: () => void;
  /** Menu q/escape — cancel the whole wizard (ownsMenu). */
  onQuit: () => void;
  /** Update the host's status message line. */
  setMessage: (message: string) => void;
  /** Host repaint. */
  render: () => void;
  /** True once the host TUI has finished (skip repaints after async work). */
  isDone: () => boolean;
  /** Wrap path validation in the host busy guard (spawnTui's stageBusy). */
  guardValidate?: boolean;
  /** Toggle the host busy flag around async path validation (spawnTui). */
  setBusy?: (busy: boolean) => void;
  /** stdout for cursor show/hide writes. */
  stdout: { write: (chunk: string) => void };
};

export type ProjectPickerView = "menu" | "browse" | "path";

export type ProjectPicker = Screen & {
  /** view is browse or path — a full-screen overlay the host renders exclusively. */
  active(): boolean;
  view(): ProjectPickerView;
  /** Show the menu (ownsMenu). reset=true parks the menu cursor at the first row. */
  enterMenu(reset: boolean): void;
  /** Enter the fuzzy repo browser. */
  enterBrowse(): void;
  /** Enter the path-completion field. */
  enterPath(): void;
  /** Reset the view back to the menu with no side effects (host re-entry). */
  toMenu(): void;
  /** Current transient error (path validation), or "". */
  errorLine(): string;
};

const PROJECT_MENU = ["here", "browse", "path"] as const;

export function createProjectPicker(config: ProjectPickerConfig): ProjectPicker {
  const { hooks, text, stdout } = config;

  let view: ProjectPickerView = "menu";
  let projects: AsyncState<ProjectItem[]> = { state: "idle" };
  const browse = createFilterList<ProjectItem>(
    () => (projects.state === "loaded" ? projects.items : []),
    (r) => r.label,
  );
  let pathBuffer = "";
  let pathError = "";
  let subdirs: AsyncState<{ base: string; dirs: string[] }> = { state: "idle" };
  let subdirsBase = "";
  let cursorPath = 0;
  let pathScroll = 0;
  let cursorMenu = 0;
  let validating = false; // re-entry guard for the guarded (spawnTui) path validate

  const filteredSubdirs = (): Array<{ abs: string; rel: string }> => {
    if (subdirs.state !== "loaded") return [];
    const { base, dirs } = subdirs.items;
    const { query } = splitPathQuery(expandTilde(pathBuffer));
    return fuzzyFilter(query, dirs.map((abs) => ({ abs, rel: relativeTo(base, abs) })), (row) => row.rel);
  };

  const loadProjectsIfNeeded = async () => {
    if (projects.state === "loaded" || projects.state === "loading") return;
    projects = { state: "loading" };
    config.render();
    try {
      projects = { state: "loaded", items: await hooks.loadProjects() };
    } catch (error) {
      projects = { state: "error", error: error instanceof Error ? error.message : String(error) };
    }
    if (!config.isDone()) config.render();
  };

  // Reload the subdir list whenever the directory portion of the buffer changes;
  // editing only the trailing query reuses the loaded list.
  const refreshPathCompletion = () => {
    const { base } = splitPathQuery(expandTilde(pathBuffer));
    if (base === subdirsBase && subdirs.state !== "idle") { config.render(); return; }
    subdirsBase = base;
    subdirs = { state: "loading" };
    cursorPath = 0;
    pathScroll = 0;
    config.render();
    void hooks
      .listSubdirs(base)
      .then((res) => {
        if (config.isDone() || splitPathQuery(expandTilde(pathBuffer)).base !== base) return; // stale
        subdirs = res.ok
          ? { state: "loaded", items: { base: res.base, dirs: res.dirs } }
          : { state: "error", error: res.error ?? "cannot read directory" };
        config.render();
      })
      .catch((error) => {
        if (config.isDone()) return;
        subdirs = { state: "error", error: error instanceof Error ? error.message : String(error) };
        config.render();
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
    if (pick) { config.onChosen(pick.abs, "path"); return; }
    // Nothing matched the completion — validate the literal text instead.
    const input = pathBuffer.trim();
    if (!input) { pathError = "enter a path"; config.render(); return; }
    if (config.guardValidate) {
      if (validating) return;
      validating = true;
      config.setBusy?.(true);
    }
    let result: { ok: boolean; path?: string; error?: string };
    try {
      result = await hooks.validatePath(input);
    } finally {
      if (config.guardValidate) {
        validating = false;
        config.setBusy?.(false);
      }
    }
    if (config.isDone()) return;
    if (!result.ok || !result.path) { pathError = result.error ?? "invalid path"; config.render(); return; }
    config.onChosen(result.path, "path");
  };

  const chooseBrowse = () => {
    const repo = browse.selected();
    if (repo) config.onChosen(repo.path, "browse");
  };

  const enterMenu = (reset: boolean) => {
    view = "menu";
    if (reset) cursorMenu = 0;
    stdout.write("\x1b[?25l");
    config.setMessage(text.menuMessage);
    config.render();
  };

  const enterBrowse = () => {
    view = "browse";
    browse.reset();
    config.setMessage(text.browseMessage);
    stdout.write("\x1b[?25h"); // show cursor for the filter field
    void loadProjectsIfNeeded();
    config.render();
  };

  const enterPath = () => {
    view = "path";
    pathBuffer = hooks.defaultCwd.endsWith("/") ? hooks.defaultCwd : `${hooks.defaultCwd}/`;
    pathError = "";
    subdirs = { state: "idle" };
    subdirsBase = "";
    cursorPath = 0;
    pathScroll = 0;
    config.setMessage(text.pathMessage);
    stdout.write("\x1b[?25h");
    refreshPathCompletion();
  };

  const activateMenu = () => {
    const choice = PROJECT_MENU[cursorMenu];
    if (choice === "here") { config.onChosen(hooks.defaultCwd, "here"); return; }
    if (choice === "browse") { enterBrowse(); return; }
    enterPath();
  };

  const handleBrowseKey = (value: string, key: readline.Key): boolean => {
    if (key.name === "return" || key.name === "enter") { chooseBrowse(); return true; }
    if (key.name === "escape" || key.name === "left") { enterMenu(false); return true; }
    if (browse.handleNavKey(value, key)) { config.render(); return true; }
    return true; // consume everything else while filtering
  };

  const handlePathKey = (value: string, key: readline.Key): boolean => {
    if (key.name === "return" || key.name === "enter") { void submitPath(); return true; }
    if (key.name === "escape" || key.name === "left") { enterMenu(false); return true; }
    if (key.name === "tab") { drillPath(); return true; }
    if (key.name === "up") { cursorPath = clamp(cursorPath - 1, filteredSubdirs().length); config.render(); return true; }
    if (key.name === "down") { cursorPath = clamp(cursorPath + 1, filteredSubdirs().length); config.render(); return true; }
    if (key.name === "backspace") { pathBuffer = pathBuffer.slice(0, -1); pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
    if (key.ctrl && key.name === "u") { pathBuffer = ""; pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
    if (isPrintable(value, key)) { pathBuffer += value; pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
    return true;
  };

  const handleMenuKey = (_value: string, key: readline.Key): boolean => {
    switch (key.name) {
      case "q":
      case "escape":
        config.onQuit();
        return true;
      case "up":
      case "k":
        cursorMenu = clamp(cursorMenu - 1, PROJECT_MENU.length);
        config.render();
        return true;
      case "down":
      case "j":
        cursorMenu = clamp(cursorMenu + 1, PROJECT_MENU.length);
        config.render();
        return true;
      case "left":
      case "h":
        config.onBack();
        return true;
      case "right":
      case "l":
      case "return":
      case "enter":
        activateMenu();
        return true;
    }
    return true; // stay put on any other key (matches the host menu's fallthrough)
  };

  const renderMenu = (width: number): string[] => {
    const rows = [
      `here  ${dim(truncate(hooks.defaultCwdLabel, Math.max(6, width - 8)))}`,
      text.browseMenuLabel,
      text.pathMenuLabel,
    ];
    return rows.map((line, i) => {
      const pointer = i === cursorMenu ? green("›") : " ";
      const rendered = `${pointer} ${line}`;
      return i === cursorMenu && isPretty() ? reverse(stripAnsi(rendered)) : truncate(rendered, width);
    });
  };

  const renderBrowse = (width: number, bodyRows: number): string[] => {
    const listRows = Math.max(1, bodyRows - 2);
    const total = projects.state === "loaded" ? projects.items.length : 0;
    const list = browse.filtered();
    const out: string[] = [`${cyan("> ")}${browse.query}`];
    if (projects.state === "loading") { out.push(dim(text.browseLoading)); return out; }
    if (projects.state === "error") { out.push(red(projects.error)); return out; }
    out.push(dim(`${list.length}/${total} repos`));
    if (list.length === 0) { out.push(dim(total === 0 ? text.browseEmptyNone : "no match")); return out; }
    for (const { item, focused } of browse.visible(listRows)) {
      const pointer = focused ? green("›") : " ";
      const label = truncate(item.label, Math.max(10, Math.floor(width * 0.5)));
      const path = dim(truncate(item.path, Math.max(10, width - visibleLength(label) - 6)));
      const line = `${pointer} ${focused ? bold(label) : label}  ${path}`;
      out.push(focused && isPretty() ? reverse(stripAnsi(line)) : line);
    }
    return out;
  };

  const renderPath = (width: number, bodyRows: number): string[] => {
    const listRows = Math.max(1, bodyRows - 2);
    const list = filteredSubdirs();
    const out: string[] = [`${cyan("> ")}${pathBuffer}`];
    if (subdirs.state === "loading") { out.push(dim("scanning…")); return out; }
    if (subdirs.state === "error") { out.push(dim(`${subdirs.error} — ${text.pathFallback}`)); return out; }
    out.push(dim(list.length === 0 ? `no subfolders match — ${text.pathFallback}` : `${list.length} folder${list.length === 1 ? "" : "s"} · tab drills in`));
    const win = visibleWindow(cursorPath, pathScroll, listRows, list.length);
    pathScroll = win.scroll;
    for (const idx of win.indices) {
      const row = list[idx]!;
      const pointer = idx === cursorPath ? green("›") : " ";
      const line = `${pointer} ${row.rel}`;
      out.push(idx === cursorPath && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
    }
    return out;
  };

  const picker: ProjectPicker = {
    active() {
      return view === "browse" || view === "path";
    },
    view() {
      return view;
    },
    enterMenu,
    enterBrowse,
    enterPath,
    toMenu() {
      view = "menu";
    },
    errorLine() {
      return pathError;
    },
    onKey(value, key) {
      if (view === "browse") return handleBrowseKey(value, key);
      if (view === "path") return handlePathKey(value, key);
      if (!config.ownsMenu) return false; // spawnTui drives its own column menu
      return handleMenuKey(value, key);
    },
    render(width, bodyRows) {
      if (view === "browse") return renderBrowse(width, bodyRows);
      if (view === "path") return renderPath(width, bodyRows);
      return renderMenu(width);
    },
    cursor() {
      if (view === "browse") return { line: 0, col: 2 + visibleLength(browse.query) + 1 };
      if (view === "path") return { line: 0, col: 2 + visibleLength(pathBuffer) + 1 };
      return null;
    },
  };
  return picker;
}
