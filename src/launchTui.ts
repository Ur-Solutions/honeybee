/**
 * `hive launch` — interactive frame/flow launcher.
 *
 * A wizard for standing up work from inside an attached session: pick a FRAME
 * (a parameterless caste swarm) or a FLOW (a parameterized orchestration), pick
 * the repo to run it in (defaults to the current one), and — for flows — fill in
 * the declared arguments in editable input boxes. Enter launches (detached).
 *
 * Presentation-only and dependency-free, mirroring src/spawnTui.ts: raw mode +
 * alt screen + signal-safe restore, one keypress handler, a full redraw per
 * event. All data (templates, repos, path validation) arrives through callbacks
 * so the launch wiring stays in cli.ts. The repo picker reuses spawnTui's pure
 * helpers (fuzzyFilter / splitPathQuery / relativeTo).
 */

import * as readline from "node:readline";
import { bold, cyan, dim, green, isPretty, red, stripAnsi, truncate, visibleLength } from "./format.js";
import { fuzzyFilter, relativeTo, splitPathQuery } from "./spawnTui.js";

export type LaunchArg = {
  name: string;
  /** Default value (stringified); absent ⇒ a required field. */
  default?: string;
  /** One-line help shown under the field while it is focused. */
  description?: string;
  /** When "bee", the field is filled from an account-aware agent picker, not free text. */
  picker?: "bee";
};

/** An agent×account choice for the bee picker (value is a `hive spawn` shorthand). */
export type BeeOption = {
  /** The shorthand written into the field, e.g. "claude-auto" or "codex-thto". */
  value: string;
  /** Display label, e.g. "claude · auto" or "codex · thto.no". */
  label: string;
  /** Optional right-hand detail (usage, etc.). */
  detail?: string;
};

export type LaunchTemplate = {
  kind: "frame" | "flow";
  name: string;
  description?: string;
  /** Bee count for a frame (sum of caste counts); shown as context. */
  beeCount?: number;
  /** Declared args (flows only). Frames have none. */
  args?: LaunchArg[];
};

export type LaunchProject = { label: string; path: string; project?: string };

export type LaunchResult = {
  kind: "frame" | "flow";
  name: string;
  cwd: string;
  /** Filled flow args (name → value); empty for frames. */
  args: Record<string, string>;
};

export type LaunchTuiHooks = {
  templates: LaunchTemplate[];
  defaultCwd: string;
  defaultCwdLabel: string;
  loadProjects: () => Promise<LaunchProject[]>;
  validatePath: (input: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  listSubdirs: (base: string) => Promise<{ ok: boolean; base: string; dirs: string[]; error?: string }>;
  /** Account-aware agent options for a `bee`-picker field (claude-auto, codex-thto, …). */
  loadBeeOptions: () => Promise<BeeOption[]>;
};

type Stage = "template" | "project" | "args";
type ProjectView = "menu" | "browse" | "path";
type AsyncState<T> = { state: "idle" } | { state: "loading" } | { state: "loaded"; items: T } | { state: "error"; error: string };

const PROJECT_MENU = ["here", "project", "path"] as const;

/** A required arg is one with no default value. (Pure, for testing.) */
export function requiredArgNames(template: LaunchTemplate): string[] {
  return (template.args ?? []).filter((a) => a.default === undefined).map((a) => a.name);
}

/**
 * Seed the editable arg buffers from a template's defaults (pure, for testing):
 * every declared arg gets a starting string (its default, or "" when required).
 */
export function seedArgValues(template: LaunchTemplate): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of template.args ?? []) out[arg.name] = arg.default ?? "";
  return out;
}

/**
 * Which required args are still blank (pure, for testing) — the launch gate.
 * Returns the names in declaration order so the caller can focus the first.
 */
export function missingRequiredArgs(template: LaunchTemplate, values: Record<string, string>): string[] {
  return requiredArgNames(template).filter((name) => (values[name] ?? "").trim().length === 0);
}

function expandTilde(value: string): string {
  return value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
}

export async function chooseLaunch(hooks: LaunchTuiHooks): Promise<LaunchResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hive launch requires a TTY — run it from a tmux popup binding or an interactive terminal.");
  }
  if (hooks.templates.length === 0) {
    throw new Error("hive launch: no frames or flows are defined. Create one with `hive frame define` / `hive flow define`.");
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRaw = stdin.isRaw;

  // ── selection state ─────────────────────────────────────────────────────
  let stage: Stage = "template";
  let template: LaunchTemplate | null = null;
  let selCwd = hooks.defaultCwd;
  let argValues: Record<string, string> = {};
  let argError = "";

  // ── per-stage cursors ───────────────────────────────────────────────────
  let templateQuery = "";
  let cursorTemplate = 0;
  let templateScroll = 0;
  let cursorProjectMenu = 0;
  let cursorBrowse = 0;
  let browseScroll = 0;
  let cursorPath = 0;
  let pathScroll = 0;
  let cursorArg = 0; // 0..args.length; args.length === the "Launch" row

  // ── bee-picker overlay (a `bee` field opens an account-aware agent list) ──
  let beePicking = false;
  let beeQuery = "";
  let cursorBee = 0;
  let beeScroll = 0;
  let beeOptions: AsyncState<BeeOption[]> = { state: "idle" };

  // ── async-loaded data ───────────────────────────────────────────────────
  let projects: AsyncState<LaunchProject[]> = { state: "idle" };
  let projectView: ProjectView = "menu";
  let browseQuery = "";
  let pathBuffer = "";
  let pathError = "";
  let subdirs: AsyncState<{ base: string; dirs: string[] }> = { state: "idle" };
  let subdirsBase = "";
  let message = "type to filter · ↑↓ pick · enter select · q cancel";

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
    return await new Promise<LaunchResult | null>((resolve) => {
      let done = false;
      const finish = (result: LaunchResult | null) => {
        if (done) return;
        done = true;
        stdin.off("keypress", onKey);
        stdout.off("resize", onResize);
        resolve(result);
      };

      const filteredTemplates = (): LaunchTemplate[] =>
        fuzzyFilter(templateQuery, hooks.templates, (t) => `${t.kind} ${t.name} ${t.description ?? ""}`);

      const filteredProjects = (): LaunchProject[] =>
        projects.state === "loaded" ? fuzzyFilter(browseQuery, projects.items, (repo) => repo.label) : [];

      const filteredSubdirs = (): Array<{ abs: string; rel: string }> => {
        if (subdirs.state !== "loaded") return [];
        const { base, dirs } = subdirs.items;
        const { query } = splitPathQuery(expandTilde(pathBuffer));
        return fuzzyFilter(query, dirs.map((abs) => ({ abs, rel: relativeTo(base, abs) })), (row) => row.rel);
      };

      // ── stage transitions ─────────────────────────────────────────────────
      const chooseTemplate = () => {
        const picked = filteredTemplates()[cursorTemplate];
        if (!picked) return;
        template = picked;
        argValues = seedArgValues(picked);
        enterProject();
      };

      const enterProject = () => {
        stage = "project";
        projectView = "menu";
        cursorProjectMenu = 0;
        stdout.write("\x1b[?25l");
        message = "↑↓ pick · enter: here / browse repos / type a path · ← back";
        render();
      };

      const loadProjectsIfNeeded = async () => {
        if (projects.state === "loaded" || projects.state === "loading") return;
        projects = { state: "loading" };
        render();
        try {
          projects = { state: "loaded", items: await hooks.loadProjects() };
        } catch (error) {
          projects = { state: "error", error: error instanceof Error ? error.message : String(error) };
        }
        if (!done) render();
      };

      // After a repo is chosen: flows → fill args; frames → launch now.
      const repoChosen = (cwd: string) => {
        selCwd = cwd;
        stdout.write("\x1b[?25l");
        // If the flow declares a `cwd` arg, seed it with the picked repo so the
        // repo selection actually drives where the flow's bees run (editable).
        if (template?.kind === "flow" && Object.prototype.hasOwnProperty.call(argValues, "cwd")) {
          argValues.cwd = cwd;
        }
        if (template && template.kind === "flow" && (template.args?.length ?? 0) > 0) {
          stage = "args";
          cursorArg = 0;
          argError = "";
          message = "↑↓ field · type to edit · enter launch · ← back";
          stdout.write("\x1b[?25h");
          render();
          return;
        }
        launch();
      };

      const launch = () => {
        if (!template) return;
        finish({ kind: template.kind, name: template.name, cwd: selCwd, args: { ...argValues } });
      };

      const activateProjectMenu = () => {
        const choice = PROJECT_MENU[cursorProjectMenu];
        if (choice === "here") {
          repoChosen(hooks.defaultCwd);
        } else if (choice === "project") {
          projectView = "browse";
          browseQuery = "";
          cursorBrowse = 0;
          browseScroll = 0;
          message = "type to filter · ↑↓ pick · enter select · esc back";
          stdout.write("\x1b[?25h");
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
          message = "type to filter · ↑↓ pick · tab drills in · enter select · esc back";
          stdout.write("\x1b[?25h");
          refreshPathCompletion();
        }
      };

      const chooseBrowse = () => {
        const repo = filteredProjects()[cursorBrowse];
        if (repo) repoChosen(repo.path);
      };

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
            if (done || splitPathQuery(expandTilde(pathBuffer)).base !== base) return;
            subdirs = res.ok ? { state: "loaded", items: { base: res.base, dirs: res.dirs } } : { state: "error", error: res.error ?? "cannot read directory" };
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
        if (pick) { repoChosen(pick.abs); return; }
        const input = pathBuffer.trim();
        if (!input) { pathError = "enter a path"; render(); return; }
        const result = await hooks.validatePath(input);
        if (done) return;
        if (!result.ok || !result.path) { pathError = result.error ?? "invalid path"; render(); return; }
        repoChosen(result.path);
      };

      // ── args form ─────────────────────────────────────────────────────────
      const argList = (): LaunchArg[] => template?.args ?? [];
      const launchRow = () => argList().length; // cursor index of the "Launch" action

      const submitArgs = () => {
        if (!template) return;
        const missing = missingRequiredArgs(template, argValues);
        if (missing.length > 0) {
          argError = `fill required: ${missing.join(", ")}`;
          cursorArg = argList().findIndex((a) => a.name === missing[0]);
          render();
          return;
        }
        launch();
      };

      const focusedArg = (): LaunchArg | undefined => (cursorArg < launchRow() ? argList()[cursorArg] : undefined);

      const openBeePicker = async () => {
        beePicking = true;
        beeQuery = "";
        cursorBee = 0;
        beeScroll = 0;
        if (beeOptions.state === "idle" || beeOptions.state === "error") {
          beeOptions = { state: "loading" };
          render();
          try {
            beeOptions = { state: "loaded", items: await hooks.loadBeeOptions() };
          } catch (error) {
            beeOptions = { state: "error", error: error instanceof Error ? error.message : String(error) };
          }
        }
        if (!done) render();
      };

      const filteredBeeOptions = (): BeeOption[] =>
        beeOptions.state === "loaded" ? fuzzyFilter(beeQuery, beeOptions.items, (o) => `${o.label} ${o.value}`) : [];

      const chooseBee = () => {
        const arg = focusedArg();
        const opt = filteredBeeOptions()[cursorBee];
        if (arg && opt) argValues[arg.name] = opt.value;
        beePicking = false;
        render();
      };

      const handleBeePickerKey = (value: string, key: readline.Key): boolean => {
        if (!(stage === "args" && beePicking)) return false;
        if (key.name === "escape" || key.name === "left") { beePicking = false; render(); return true; }
        if (key.name === "return" || key.name === "enter") { chooseBee(); return true; }
        if (key.name === "up") { cursorBee = clamp(cursorBee - 1, filteredBeeOptions().length); render(); return true; }
        if (key.name === "down") { cursorBee = clamp(cursorBee + 1, filteredBeeOptions().length); render(); return true; }
        if (key.name === "backspace") { beeQuery = beeQuery.slice(0, -1); cursorBee = 0; render(); return true; }
        if (key.ctrl && key.name === "u") { beeQuery = ""; cursorBee = 0; render(); return true; }
        if (isPrintable(value, key)) { beeQuery += value; cursorBee = 0; render(); return true; }
        return true;
      };

      const handleArgsKey = (value: string, key: readline.Key): boolean => {
        if (stage !== "args" || beePicking) return false;
        if (key.name === "escape" || key.name === "left") { enterProject(); return true; }
        if (key.name === "up") { cursorArg = clamp(cursorArg - 1, launchRow() + 1); argError = ""; render(); return true; }
        if (key.name === "down") { cursorArg = clamp(cursorArg + 1, launchRow() + 1); argError = ""; render(); return true; }
        const arg = focusedArg();
        // A `bee` field is filled from the account-aware picker, not free text.
        if (arg?.picker === "bee" && (key.name === "return" || key.name === "enter" || key.name === "tab" || isPrintable(value, key))) {
          void openBeePicker();
          return true;
        }
        if (key.name === "return" || key.name === "enter") {
          if (cursorArg < launchRow()) { cursorArg = clamp(cursorArg + 1, launchRow() + 1); render(); return true; }
          submitArgs();
          return true;
        }
        // editing the focused free-text field
        if (arg) {
          if (key.name === "backspace") { argValues[arg.name] = (argValues[arg.name] ?? "").slice(0, -1); render(); return true; }
          if (key.ctrl && key.name === "u") { argValues[arg.name] = ""; render(); return true; }
          if (isPrintable(value, key)) { argValues[arg.name] = (argValues[arg.name] ?? "") + value; render(); return true; }
        }
        return true; // consume everything else while in the form
      };

      // ── navigation ────────────────────────────────────────────────────────
      const goBack = () => {
        if (stage === "template") { finish(null); return; }
        if (stage === "args") { enterProject(); return; }
        // project
        if (projectView === "browse" || projectView === "path") {
          projectView = "menu";
          stdout.write("\x1b[?25l");
          message = "↑↓ pick · enter: here / browse repos / type a path · ← back";
          render();
          return;
        }
        stage = "template";
        stdout.write("\x1b[?25h");
        message = "type to filter · ↑↓ pick · enter select · q cancel";
        render();
      };

      // ── type-to-filter handlers (template list + repo browse + path) ───────
      const isPrintable = (value: string, key: readline.Key) =>
        Boolean(value) && value.length === 1 && value >= " " && !key.ctrl && !key.meta;

      const handleTemplateKey = (value: string, key: readline.Key): boolean => {
        if (stage !== "template") return false;
        if (key.name === "return" || key.name === "enter") { chooseTemplate(); return true; }
        if (key.name === "escape" || (key.ctrl && key.name === "c")) { finish(null); return true; }
        if (key.name === "up") { cursorTemplate = clamp(cursorTemplate - 1, filteredTemplates().length); render(); return true; }
        if (key.name === "down") { cursorTemplate = clamp(cursorTemplate + 1, filteredTemplates().length); render(); return true; }
        if (key.name === "backspace") { templateQuery = templateQuery.slice(0, -1); cursorTemplate = 0; render(); return true; }
        if (key.ctrl && key.name === "u") { templateQuery = ""; cursorTemplate = 0; render(); return true; }
        if (isPrintable(value, key)) { templateQuery += value; cursorTemplate = 0; render(); return true; }
        return true;
      };

      const handleBrowseKey = (value: string, key: readline.Key): boolean => {
        if (!(stage === "project" && projectView === "browse")) return false;
        if (key.name === "return" || key.name === "enter") { chooseBrowse(); return true; }
        if (key.name === "escape" || key.name === "left") { goBack(); return true; }
        if (key.name === "up") { cursorBrowse = clamp(cursorBrowse - 1, filteredProjects().length); render(); return true; }
        if (key.name === "down") { cursorBrowse = clamp(cursorBrowse + 1, filteredProjects().length); render(); return true; }
        if (key.name === "backspace") { browseQuery = browseQuery.slice(0, -1); cursorBrowse = 0; render(); return true; }
        if (key.ctrl && key.name === "u") { browseQuery = ""; cursorBrowse = 0; render(); return true; }
        if (isPrintable(value, key)) { browseQuery += value; cursorBrowse = 0; render(); return true; }
        return true;
      };

      const handlePathKey = (value: string, key: readline.Key): boolean => {
        if (!(stage === "project" && projectView === "path")) return false;
        if (key.name === "return" || key.name === "enter") { void submitPath(); return true; }
        if (key.name === "escape" || key.name === "left") { goBack(); return true; }
        if (key.name === "tab") { drillPath(); return true; }
        if (key.name === "up") { cursorPath = clamp(cursorPath - 1, filteredSubdirs().length); render(); return true; }
        if (key.name === "down") { cursorPath = clamp(cursorPath + 1, filteredSubdirs().length); render(); return true; }
        if (key.name === "backspace") { pathBuffer = pathBuffer.slice(0, -1); pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
        if (key.ctrl && key.name === "u") { pathBuffer = ""; pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
        if (isPrintable(value, key)) { pathBuffer += value; pathError = ""; cursorPath = 0; refreshPathCompletion(); return true; }
        return true;
      };

      const onKey = (value: string, key: readline.Key) => {
        if (key.ctrl && key.name === "c") { finish(null); return; }
        if (handleTemplateKey(value, key)) return;
        if (handleBeePickerKey(value, key)) return;
        if (handleArgsKey(value, key)) return;
        if (handleBrowseKey(value, key)) return;
        if (handlePathKey(value, key)) return;
        // project menu
        switch (key.name) {
          case "q":
          case "escape":
            finish(null);
            return;
          case "up":
          case "k":
            cursorProjectMenu = clamp(cursorProjectMenu - 1, PROJECT_MENU.length);
            render();
            return;
          case "down":
          case "j":
            cursorProjectMenu = clamp(cursorProjectMenu + 1, PROJECT_MENU.length);
            render();
            return;
          case "left":
          case "h":
            goBack();
            return;
          case "right":
          case "l":
          case "return":
          case "enter":
            activateProjectMenu();
            return;
        }
      };

      // ── rendering ──────────────────────────────────────────────────────────
      const render = () => {
        if (done) return;
        const width = Math.max(40, stdout.columns || 100);
        const height = Math.max(12, stdout.rows || 24);
        const bodyRows = Math.max(6, height - 5);

        const header = `${bold("hive launch")}  ${dim(breadcrumb())}`;
        const lines: string[] = [header, ""];

        if (stage === "template") lines.push(...renderTemplates(width, bodyRows));
        else if (stage === "args") lines.push(...renderArgs(width, bodyRows));
        else lines.push(...renderProject(width, bodyRows));

        while (lines.length < height - 2) lines.push("");
        const err = stage === "args" ? argError : pathError;
        lines.push(truncate(err ? red(err) : message, width));
        lines.push(dim(footer()));
        stdout.write(`\x1b[2J\x1b[H${lines.map((line) => truncate(line, width)).join("\n")}`);
        parkCursor();
      };

      const footer = (): string => {
        if (stage === "template") return "type to filter · ↑↓ move · enter select · q quit";
        if (stage === "args" && beePicking) return "type to filter · ↑↓ move · enter pick · esc back";
        if (stage === "args") return "↑↓ field · type to edit · enter next/launch · ← back";
        if (projectView === "browse" || projectView === "path") return "type to filter · ↑↓ move · enter select · esc back";
        return "↑↓ move · enter choose · ← back · q quit";
      };

      const breadcrumb = (): string => {
        const parts: string[] = [];
        if (template) parts.push(`${template.kind}:${template.name}`);
        if (template && stage !== "template" && stage !== "project") parts.push(relTilde(selCwd));
        if (parts.length === 0) return "pick a frame or flow to begin";
        return parts.join("  ›  ");
      };

      const renderTemplates = (width: number, bodyRows: number): string[] => {
        const list = filteredTemplates();
        const listRows = Math.max(1, bodyRows - 2);
        const out: string[] = [`${cyan("> ")}${templateQuery}`, dim(`${list.length}/${hooks.templates.length} frames + flows`)];
        if (list.length === 0) { out.push(dim("no match")); return out; }
        if (cursorTemplate < templateScroll) templateScroll = cursorTemplate;
        if (cursorTemplate >= templateScroll + listRows) templateScroll = cursorTemplate - listRows + 1;
        for (let i = 0; i < Math.min(listRows, list.length - templateScroll); i += 1) {
          const idx = templateScroll + i;
          const t = list[idx]!;
          const pointer = idx === cursorTemplate ? green("›") : " ";
          const tag = t.kind === "flow" ? cyan("[flow]") : green("[frame]");
          const meta = t.kind === "flow"
            ? dim((t.args?.length ?? 0) > 0 ? `${t.args!.length} arg${t.args!.length === 1 ? "" : "s"}` : "no args")
            : dim(t.beeCount ? `${t.beeCount} bee${t.beeCount === 1 ? "" : "s"}` : "");
          const desc = t.description ? dim(`  ${truncate(t.description, Math.max(8, Math.floor(width * 0.4)))}`) : "";
          const line = `${pointer} ${tag} ${idx === cursorTemplate ? bold(t.name) : t.name}  ${meta}${desc}`;
          out.push(idx === cursorTemplate && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
        }
        return out;
      };

      const renderProject = (width: number, bodyRows: number): string[] => {
        if (projectView === "menu") {
          const rows = [`here  ${dim(truncate(hooks.defaultCwdLabel, Math.max(6, width - 8)))}`, "browse repos…", "type a path…"];
          return rows.map((text, i) => {
            const pointer = i === cursorProjectMenu ? green("›") : " ";
            const line = `${pointer} ${text}`;
            return i === cursorProjectMenu && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width);
          });
        }
        const listRows = Math.max(1, bodyRows - 2);
        if (projectView === "browse") {
          const total = projects.state === "loaded" ? projects.items.length : 0;
          const list = filteredProjects();
          const out: string[] = [`${cyan("> ")}${browseQuery}`];
          if (projects.state === "loading") { out.push(dim("loading repos…")); return out; }
          if (projects.state === "error") { out.push(red(projects.error)); return out; }
          out.push(dim(`${list.length}/${total} repos`));
          if (list.length === 0) { out.push(dim(total === 0 ? "no repos found" : "no match")); return out; }
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
        // path
        const list = filteredSubdirs();
        const out: string[] = [`${cyan("> ")}${pathBuffer}`];
        if (subdirs.state === "loading") { out.push(dim("scanning…")); return out; }
        if (subdirs.state === "error") { out.push(dim(`${subdirs.error} — enter uses the typed path`)); return out; }
        out.push(dim(list.length === 0 ? "no subfolders match — enter uses the typed path" : `${list.length} folder${list.length === 1 ? "" : "s"} · tab drills in`));
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

      const renderArgs = (width: number, _bodyRows: number): string[] => {
        if (beePicking) return renderBeePicker(width);
        const out: string[] = [dim(`${template?.name} — ${red("*")} = required`), ""];
        const labelW = Math.min(22, Math.max(6, ...argList().map((a) => a.name.length + 2)));
        const fieldW = Math.max(10, width - labelW - 8);
        argList().forEach((arg, i) => {
          const focused = i === cursorArg;
          const req = arg.default === undefined ? red("*") : " ";
          const name = padRight(arg.name, labelW);
          const value = argValues[arg.name] ?? "";
          const shown = truncate(value, fieldW);
          // No brackets: the focused field is a reverse-video input box; an
          // unfocused field is plain text (a dim placeholder when empty).
          let field: string;
          if (focused && isPretty()) field = reverse(` ${padRight(shown, fieldW)} `);
          else if (shown.length > 0) field = shown;
          else field = dim(arg.picker === "bee" ? "↵ pick an agent" : "—");
          out.push(`${focused ? green("›") : " "} ${req} ${dim(name)}  ${field}`);
        });
        // Help line for the focused field (what it does).
        const arg = focusedArg();
        out.push("");
        out.push(arg?.description ? dim(`  ${truncate(arg.description, width - 4)}`) : "");
        const launchFocused = cursorArg === launchRow();
        const action = `▶ Launch ${template?.kind ?? ""} ${template?.name ?? ""} in ${relTilde(selCwd)}`;
        out.push(`${launchFocused ? green("›") : " "}   ${launchFocused && isPretty() ? reverse(stripAnsi(action)) : bold(action)}`);
        return out;
      };

      const renderBeePicker = (width: number): string[] => {
        const out: string[] = [dim(`pick the agent for "${focusedArg()?.name ?? "bee"}"`), `${cyan("> ")}${beeQuery}`];
        if (beeOptions.state === "loading") { out.push(dim("loading accounts…")); return out; }
        if (beeOptions.state === "error") { out.push(red(beeOptions.error)); return out; }
        const list = filteredBeeOptions();
        if (list.length === 0) { out.push(dim("no match")); return out; }
        const listRows = 12;
        if (cursorBee < beeScroll) beeScroll = cursorBee;
        if (cursorBee >= beeScroll + listRows) beeScroll = cursorBee - listRows + 1;
        for (let i = 0; i < Math.min(listRows, list.length - beeScroll); i += 1) {
          const idx = beeScroll + i;
          const o = list[idx]!;
          const pointer = idx === cursorBee ? green("›") : " ";
          const detail = o.detail ? `  ${dim(o.detail)}` : "";
          const line = `${pointer} ${idx === cursorBee ? bold(o.label) : o.label}${detail}`;
          out.push(idx === cursorBee && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
        }
        return out;
      };

      const parkCursor = () => {
        // Show a text cursor at the end of the active typing field.
        if (stage === "template") { stdout.write(`\x1b[3;${2 + visibleLength(templateQuery) + 1}H`); return; }
        if (stage === "args" && beePicking) { stdout.write(`\x1b[4;${2 + visibleLength(beeQuery) + 1}H`); return; } // header, blank, title, "> query"
        if (stage === "project" && projectView === "browse") { stdout.write(`\x1b[3;${2 + visibleLength(browseQuery) + 1}H`); return; }
        if (stage === "project" && projectView === "path") { stdout.write(`\x1b[3;${2 + visibleLength(pathBuffer) + 1}H`); return; }
      };

      const relTilde = (abs: string): string => {
        const home = process.env.HOME;
        return home && abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs;
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

// ── small helpers ────────────────────────────────────────────────────────────

function clamp(next: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, next));
}

function padRight(value: string, width: number): string {
  const visible = visibleLength(value);
  return visible >= width ? value : value + " ".repeat(width - visible);
}

function reverse(value: string): string {
  return isPretty() ? `\x1b[7m${value}\x1b[0m` : value;
}
