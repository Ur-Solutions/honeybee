/**
 * `hive loop launch` — interactive loop launcher (the ⌘⇧L dialog).
 *
 * A wizard for standing up a loop from an attached session: pick a TEMPLATE (a
 * saved preset, or "blank"), pick the repo to run it in (defaults to the current
 * one), then fill in a MINIMAL loop form — context type, bee, and prompt — with
 * the rest tucked behind an [ advanced ▸ ] toggle. Enter on ▶ Launch runs the
 * loop detached; ⊕ Save as template… persists the form as a reusable preset.
 *
 * Presentation-only and dependency-free, mirroring src/launchTui.ts: raw mode +
 * alt screen + signal-safe restore, one keypress handler, a full redraw per
 * event. All data (templates, repos, path validation, bee options) arrives
 * through callbacks so the launch wiring stays in cli.ts. The repo picker reuses
 * spawnTui's pure helpers (fuzzyFilter / splitPathQuery / relativeTo).
 */

import type * as readline from "node:readline";
import { bold, cyan, dim, green, isPretty, red, stripAnsi, truncate, visibleLength } from "./format.js";
import { createTuiPainter } from "./tuiPaint.js";
import type { LoopTemplate } from "./loopTemplate.js";
import { fuzzyFilter, relativeTo, splitPathQuery } from "./spawnTui.js";
import { type AsyncState, clamp, expandTilde, isPrintable, padRight, relTilde, reverse } from "./tuiKit.js";
import { runRawModeTui } from "./tuiRuntime.js";

/** The editable form state — the loop config the user is composing. */
export type LoopFormValues = {
  /** Context mode (the loop "type"): persistent | ralph | rolling. */
  context: string;
  /** Agent shorthand (claude, codex-auto, codex-rr, claude-<account>). Required. */
  bee: string;
  /** The instruction sent each iteration. Required. */
  prompt: string;
  until: string;
  max: string;
  maxDuration: string;
  forever: boolean;
  stopOnSeal: string;
  stopOnSentinel: string;
  judge: string;
  summarizer: string;
  yolo: boolean;
};

/** An agent×account choice for the bee picker (value is a `hive spawn` shorthand). */
export type BeeOption = {
  /** The shorthand written into the field, e.g. "claude-auto", "codex-rr", or "codex-thto". */
  value: string;
  /** Display label, e.g. "claude · auto" or "codex · thto.no". */
  label: string;
  /** Optional right-hand detail (usage, etc.). */
  detail?: string;
};

export type LoopProject = { label: string; path: string; project?: string };

export type LoopLaunchResult = {
  action: "launch" | "save-template";
  cwd: string;
  values: LoopFormValues;
  /** Present when action is "save-template". */
  templateName?: string;
};

export type LoopTuiHooks = {
  /** Saved presets shown after the "✦ blank loop" row. */
  templates: LoopTemplate[];
  defaultCwd: string;
  defaultCwdLabel: string;
  loadProjects: () => Promise<LoopProject[]>;
  validatePath: (input: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  listSubdirs: (base: string) => Promise<{ ok: boolean; base: string; dirs: string[]; error?: string }>;
  /** Account-aware agent options for the bee picker (claude-auto, claude-rr, codex-thto, …). */
  loadBeeOptions: () => Promise<BeeOption[]>;
};

type Stage = "template" | "project" | "form";
type ProjectView = "menu" | "browse" | "path";

const PROJECT_MENU = ["here", "project", "path"] as const;

/** The context-mode choices the "type" picker cycles through. */
export const CONTEXT_MODES = ["persistent", "ralph", "rolling"] as const;

const EMPTY_FORM: LoopFormValues = {
  context: "persistent",
  bee: "",
  prompt: "",
  until: "",
  max: "100",
  maxDuration: "",
  forever: false,
  stopOnSeal: "",
  stopOnSentinel: "",
  judge: "",
  summarizer: "",
  yolo: false,
};

/**
 * Seed the editable form from a template (pure, for testing). A null template
 * (the "blank loop" row) yields the empty defaults; otherwise every loop-config
 * field is copied across, falling back to the blank value when the template
 * omits it.
 */
export function seedFormFromTemplate(template: LoopTemplate | null): LoopFormValues {
  if (!template) return { ...EMPTY_FORM };
  return {
    context: template.context ?? EMPTY_FORM.context,
    bee: template.bee ?? "",
    prompt: template.prompt ?? "",
    until: template.until ?? "",
    max: template.max ?? EMPTY_FORM.max,
    maxDuration: template.maxDuration ?? "",
    forever: template.forever === true,
    stopOnSeal: template.stopOnSeal ?? "",
    stopOnSentinel: template.stopOnSentinel ?? "",
    judge: template.judge ?? "",
    summarizer: template.summarizer ?? "",
    yolo: template.yolo === true,
  };
}

/**
 * The loose arg record handed directly to the detached loop runner. Only
 * non-empty / truthy fields are emitted. Booleans are emitted as `true`
 * (omitted when false).
 */
export function loopStartArgs(values: LoopFormValues): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const put = (key: string, value: string) => {
    if (value.trim().length > 0) out[key] = value.trim();
  };
  put("context", values.context);
  put("bee", values.bee);
  put("prompt", values.prompt);
  put("until", values.until);
  put("max", values.max);
  put("maxDuration", values.maxDuration);
  put("stopOnSeal", values.stopOnSeal);
  put("stopOnSentinel", values.stopOnSentinel);
  put("judge", values.judge);
  put("summarizer", values.summarizer);
  if (values.forever) out.forever = true;
  if (values.yolo) out.yolo = true;
  return out;
}

/**
 * Which essentials are still missing (pure, for testing) — the launch gate.
 * Mirrors buildLoopConfig's required fields so the TUI cannot accept a launch
 * the detached runner will reject immediately.
 */
export function missingForLaunch(values: LoopFormValues): string[] {
  const missing: string[] = [];
  if (values.context.trim().length === 0) missing.push("context");
  if (values.bee.trim().length === 0) missing.push("bee");
  if (values.prompt.trim().length === 0) missing.push("prompt");
  if (!values.forever && values.max.trim().length === 0) missing.push("max");
  return missing;
}

// ── form row model ─────────────────────────────────────────────────────────
// The form is a flat list of focusable rows. Essentials are always present; the
// advanced fields appear only when the toggle is expanded; the two action rows
// (save, launch) are always last.

type FieldRow = {
  kind: "field";
  key: keyof LoopFormValues;
  label: string;
  /** "type" cycles modes, "bee" opens the picker, "bool" toggles, "text" edits. */
  field: "type" | "bee" | "bool" | "text";
  description: string;
};
type ToggleRow = { kind: "toggle"; label: string; description: string };
type ActionRow = { kind: "action"; action: "save" | "launch"; label: string; description: string };
type FormRow = FieldRow | ToggleRow | ActionRow;

const ESSENTIAL_ROWS: FieldRow[] = [
  { kind: "field", key: "context", label: "type", field: "type", description: "loop type — persistent keeps one session, ralph forks fresh, rolling forks with a rolling summary" },
  { kind: "field", key: "bee", label: "bee", field: "bee", description: "which agent runs the loop (↵ to pick an account-aware shorthand)" },
  { kind: "field", key: "prompt", label: "prompt", field: "text", description: "the instruction sent each iteration (required)" },
];

const ADVANCED_ROWS: FieldRow[] = [
  { kind: "field", key: "until", label: "until", field: "text", description: "stop when this shell command exits 0 (run after each iteration)" },
  { kind: "field", key: "max", label: "max", field: "text", description: "stop after N iterations (a positive integer; ignored when forever)" },
  { kind: "field", key: "maxDuration", label: "max-duration", field: "text", description: "stop after a wall-clock budget, e.g. 30s, 10m, 2h" },
  { kind: "field", key: "forever", label: "forever", field: "bool", description: "run with no iteration cap (space toggles)" },
  { kind: "field", key: "stopOnSeal", label: "stop-on-seal", field: "text", description: "stop when the bee seals with these statuses, e.g. done,blocked" },
  { kind: "field", key: "stopOnSentinel", label: "stop-on-sentinel", field: "text", description: "stop when the iteration output contains this sentinel string" },
  { kind: "field", key: "judge", label: "judge", field: "text", description: "ask this bee whether to stop after each iteration" },
  { kind: "field", key: "summarizer", label: "summarizer", field: "text", description: "who writes the rolling summary: self or bee" },
  { kind: "field", key: "yolo", label: "yolo", field: "bool", description: "skip the agent's permission prompts (space toggles)" },
];

const ADVANCED_TOGGLE: ToggleRow = { kind: "toggle", label: "advanced", description: "reveal stop conditions, judge, summarizer, and yolo (↵ to toggle)" };
const SAVE_ACTION: ActionRow = { kind: "action", action: "save", label: "⊕ Save as template…", description: "persist this form as a reusable preset (↵ to name it)" };
const LAUNCH_ACTION: ActionRow = { kind: "action", action: "launch", label: "▶ Launch loop", description: "validate and start the loop detached (↵ to launch)" };

/** The focusable rows for the current expand state (pure, for testing). */
export function formRows(advancedOpen: boolean): FormRow[] {
  return [
    ...ESSENTIAL_ROWS,
    ADVANCED_TOGGLE,
    ...(advancedOpen ? ADVANCED_ROWS : []),
    SAVE_ACTION,
    LAUNCH_ACTION,
  ];
}

export async function chooseLoop(hooks: LoopTuiHooks): Promise<LoopLaunchResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hive loop launch requires a TTY — run it from a tmux popup binding or an interactive terminal.");
  }

  const stdout = process.stdout;

  // ── selection state ─────────────────────────────────────────────────────
  let stage: Stage = "template";
  let selCwd = hooks.defaultCwd;
  let values: LoopFormValues = { ...EMPTY_FORM };
  let advancedOpen = false;
  let formError = "";

  // ── per-stage cursors ───────────────────────────────────────────────────
  let templateQuery = "";
  let cursorTemplate = 0;
  let templateScroll = 0;
  let cursorProjectMenu = 0;
  let cursorBrowse = 0;
  let browseScroll = 0;
  let cursorPath = 0;
  let pathScroll = 0;
  let cursorRow = 0; // index into formRows(advancedOpen)

  // ── bee-picker overlay (the bee field opens an account-aware agent list) ──
  let beePicking = false;
  let beeQuery = "";
  let cursorBee = 0;
  let beeScroll = 0;
  let beeOptions: AsyncState<BeeOption[]> = { state: "idle" };

  // ── save-as-template inline name field ───────────────────────────────────
  let naming = false;
  let nameBuffer = "";
  let nameError = "";

  // ── async-loaded data ───────────────────────────────────────────────────
  let projects: AsyncState<LoopProject[]> = { state: "idle" };
  let projectView: ProjectView = "menu";
  let browseQuery = "";
  let pathBuffer = "";
  let pathError = "";
  let subdirs: AsyncState<{ base: string; dirs: string[] }> = { state: "idle" };
  let subdirsBase = "";
  let message = "type to filter · ↑↓ pick · enter select · q cancel";

  return runRawModeTui<LoopLaunchResult | null>((tui) => {
    const { finish } = tui;

    // ── template stage: "blank" row + saved presets ───────────────────────
    type TemplateRow = { template: LoopTemplate | null; name: string; preview: string };
    const templateRows = (): TemplateRow[] => [
      { template: null, name: "✦ blank loop", preview: "start from empty fields" },
      ...hooks.templates.map((t) => ({ template: t, name: t.name, preview: t.prompt })),
    ];
    const filteredTemplates = (): TemplateRow[] =>
      fuzzyFilter(templateQuery, templateRows(), (r) => `${r.name} ${r.preview}`);

    const filteredProjects = (): LoopProject[] =>
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
      values = seedFormFromTemplate(picked.template);
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
      if (!tui.done) render();
    };

    const repoChosen = (cwd: string) => {
      selCwd = cwd;
      stage = "form";
      cursorRow = 0;
      formError = "";
      stdout.write("\x1b[?25h");
      message = "↑↓ field · type to edit · enter next/launch · ← back";
      render();
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
          if (tui.done || splitPathQuery(expandTilde(pathBuffer)).base !== base) return;
          subdirs = res.ok ? { state: "loaded", items: { base: res.base, dirs: res.dirs } } : { state: "error", error: res.error ?? "cannot read directory" };
          render();
        })
        .catch((error) => {
          if (tui.done) return;
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
      if (tui.done) return;
      if (!result.ok || !result.path) { pathError = result.error ?? "invalid path"; render(); return; }
      repoChosen(result.path);
    };

    // ── form ──────────────────────────────────────────────────────────────
    const rows = (): FormRow[] => formRows(advancedOpen);
    const focusedRow = (): FormRow | undefined => rows()[cursorRow];

    const cycleContext = (dir: 1 | -1) => {
      const i = CONTEXT_MODES.indexOf(values.context as (typeof CONTEXT_MODES)[number]);
      const next = (i + dir + CONTEXT_MODES.length) % CONTEXT_MODES.length;
      values.context = CONTEXT_MODES[next]!;
      render();
    };

    const toggleAdvanced = () => {
      advancedOpen = !advancedOpen;
      // Keep the cursor on the toggle row so the reveal doesn't jump focus.
      cursorRow = ESSENTIAL_ROWS.length;
      message = "↑↓ field · type to edit · enter next/launch · ← back";
      render();
    };

    const submitLaunch = () => {
      const missing = missingForLaunch(values);
      if (missing.length > 0) {
        formError = `fill required: ${missing.join(", ")}`;
        // Focus the first missing essential field.
        const idx = ESSENTIAL_ROWS.findIndex((r) => r.key === missing[0]);
        if (idx >= 0) cursorRow = idx;
        render();
        return;
      }
      finish({ action: "launch", cwd: selCwd, values: { ...values } });
    };

    const beginNaming = () => {
      naming = true;
      nameBuffer = "";
      nameError = "";
      message = "name the template · enter save · esc cancel";
      render();
    };

    const submitName = () => {
      const name = nameBuffer.trim();
      if (name.length === 0) { nameError = "enter a name"; render(); return; }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) { nameError = "use letters, digits, - and _ (must start alphanumeric)"; render(); return; }
      if (missingForLaunch(values).length > 0) { nameError = "a template needs a prompt"; cursorRow = ESSENTIAL_ROWS.findIndex((r) => r.key === "prompt"); naming = false; render(); return; }
      finish({ action: "save-template", cwd: selCwd, values: { ...values }, templateName: name });
    };

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
      if (!tui.done) render();
    };

    const filteredBeeOptions = (): BeeOption[] =>
      beeOptions.state === "loaded" ? fuzzyFilter(beeQuery, beeOptions.items, (o) => `${o.label} ${o.value}`) : [];

    const chooseBee = () => {
      const opt = filteredBeeOptions()[cursorBee];
      if (opt) values.bee = opt.value;
      beePicking = false;
      render();
    };

    // ── key handlers (each returns true when it consumes the key) ──────────
    const handleBeePickerKey = (value: string, key: readline.Key): boolean => {
      if (!(stage === "form" && beePicking)) return false;
      if (key.name === "escape" || key.name === "left") { beePicking = false; render(); return true; }
      if (key.name === "return" || key.name === "enter") { chooseBee(); return true; }
      if (key.name === "up") { cursorBee = clamp(cursorBee - 1, filteredBeeOptions().length); render(); return true; }
      if (key.name === "down") { cursorBee = clamp(cursorBee + 1, filteredBeeOptions().length); render(); return true; }
      if (key.name === "backspace") { beeQuery = beeQuery.slice(0, -1); cursorBee = 0; render(); return true; }
      if (key.ctrl && key.name === "u") { beeQuery = ""; cursorBee = 0; render(); return true; }
      if (isPrintable(value, key)) { beeQuery += value; cursorBee = 0; render(); return true; }
      return true;
    };

    const handleNamingKey = (value: string, key: readline.Key): boolean => {
      if (!(stage === "form" && naming)) return false;
      if (key.name === "escape") { naming = false; nameError = ""; message = "↑↓ field · type to edit · enter next/launch · ← back"; render(); return true; }
      if (key.name === "return" || key.name === "enter") { submitName(); return true; }
      if (key.name === "backspace") { nameBuffer = nameBuffer.slice(0, -1); nameError = ""; render(); return true; }
      if (key.ctrl && key.name === "u") { nameBuffer = ""; nameError = ""; render(); return true; }
      if (isPrintable(value, key)) { nameBuffer += value; nameError = ""; render(); return true; }
      return true;
    };

    const handleFormKey = (value: string, key: readline.Key): boolean => {
      if (stage !== "form" || beePicking || naming) return false;
      if (key.name === "escape" || key.name === "left") { enterProject(); return true; }
      if (key.name === "up") { cursorRow = clamp(cursorRow - 1, rows().length); formError = ""; render(); return true; }
      if (key.name === "down") { cursorRow = clamp(cursorRow + 1, rows().length); formError = ""; render(); return true; }
      const row = focusedRow();
      if (!row) return true;
      if (row.kind === "toggle") {
        if (key.name === "return" || key.name === "enter") { toggleAdvanced(); return true; }
        return true;
      }
      if (row.kind === "action") {
        if (key.name === "return" || key.name === "enter") {
          if (row.action === "save") beginNaming();
          else submitLaunch();
          return true;
        }
        return true;
      }
      // field row
      if (row.field === "type") {
        if (key.name === "return" || key.name === "enter" || key.name === "right" || key.name === "space") { cycleContext(1); return true; }
        if (key.name === "left") { /* handled above as back */ return true; }
        return true;
      }
      if (row.field === "bee") {
        if (key.name === "return" || key.name === "enter" || key.name === "tab" || isPrintable(value, key)) { void openBeePicker(); return true; }
        return true;
      }
      if (row.field === "bool") {
        if (key.name === "space" || key.name === "return" || key.name === "enter") {
          values[row.key] = !values[row.key] as never;
          render();
          return true;
        }
        return true;
      }
      // text field
      if (key.name === "return" || key.name === "enter") { cursorRow = clamp(cursorRow + 1, rows().length); render(); return true; }
      if (key.name === "backspace") { values[row.key] = (String(values[row.key]).slice(0, -1)) as never; render(); return true; }
      if (key.ctrl && key.name === "u") { values[row.key] = "" as never; render(); return true; }
      if (isPrintable(value, key)) { values[row.key] = (String(values[row.key]) + value) as never; render(); return true; }
      return true;
    };

    const goBack = () => {
      if (stage === "template") { finish(null); return; }
      if (stage === "form") { enterProject(); return; }
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
      if (handleNamingKey(value, key)) return;
      if (handleFormKey(value, key)) return;
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
    const painter = createTuiPainter(stdout);
    const render = () => {
      if (tui.done) return;
      const width = Math.max(40, stdout.columns || 100);
      const height = Math.max(12, stdout.rows || 24);
      const bodyRows = Math.max(6, height - 5);

      const header = `${bold("hive loop launch")}  ${dim(breadcrumb())}`;
      const lines: string[] = [header, ""];

      if (stage === "template") lines.push(...renderTemplates(width, bodyRows));
      else if (stage === "form") lines.push(...renderForm(width));
      else lines.push(...renderProject(width, bodyRows));

      while (lines.length < height - 2) lines.push("");
      const err = stage === "form" ? (naming ? nameError : formError) : pathError;
      lines.push(truncate(err ? red(err) : message, width));
      lines.push(dim(footer()));
      painter.paint(lines, width, height);
      parkCursor();
    };

    const footer = (): string => {
      if (stage === "template") return "type to filter · ↑↓ move · enter select · q quit";
      if (stage === "form" && beePicking) return "type to filter · ↑↓ move · enter pick · esc back";
      if (stage === "form" && naming) return "type a name · enter save · esc cancel";
      if (stage === "form") return "↑↓ field · type to edit · enter next/launch · ← back";
      if (projectView === "browse" || projectView === "path") return "type to filter · ↑↓ move · enter select · esc back";
      return "↑↓ move · enter choose · ← back · q quit";
    };

    const breadcrumb = (): string => {
      const parts: string[] = [];
      if (stage === "form" || stage === "project") parts.push(values.context);
      if (stage === "form") parts.push(relTilde(selCwd));
      if (parts.length === 0) return "pick a template to begin";
      return parts.join("  ›  ");
    };

    const renderTemplates = (width: number, bodyRows: number): string[] => {
      const list = filteredTemplates();
      const listRows = Math.max(1, bodyRows - 2);
      const out: string[] = [`${cyan("> ")}${templateQuery}`, dim(`${list.length} option${list.length === 1 ? "" : "s"}`)];
      if (list.length === 0) { out.push(dim("no match")); return out; }
      if (cursorTemplate < templateScroll) templateScroll = cursorTemplate;
      if (cursorTemplate >= templateScroll + listRows) templateScroll = cursorTemplate - listRows + 1;
      for (let i = 0; i < Math.min(listRows, list.length - templateScroll); i += 1) {
        const idx = templateScroll + i;
        const r = list[idx]!;
        const pointer = idx === cursorTemplate ? green("›") : " ";
        const name = idx === cursorTemplate ? bold(r.name) : r.name;
        const preview = r.preview ? dim(`  ${truncate(r.preview.replace(/\s+/g, " "), Math.max(8, Math.floor(width * 0.5)))}`) : "";
        const line = `${pointer} ${name}${preview}`;
        out.push(idx === cursorTemplate && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
      }
      return out;
    };

    const renderProject = (width: number, bodyRows: number): string[] => {
      if (projectView === "menu") {
        const rows2 = [`here  ${dim(truncate(hooks.defaultCwdLabel, Math.max(6, width - 8)))}`, "browse repos…", "type a path…"];
        return rows2.map((text, i) => {
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

    const renderForm = (width: number): string[] => {
      if (beePicking) return renderBeePicker(width);
      if (naming) return renderNaming(width);
      const list = rows();
      const fieldRows = list.filter((r): r is FieldRow => r.kind === "field");
      const labelW = Math.min(16, Math.max(6, ...fieldRows.map((r) => r.label.length + 2)));
      const fieldW = Math.max(10, width - labelW - 8);
      const out: string[] = [dim(`compose the loop — ${red("*")} = required`), ""];
      list.forEach((row, i) => {
        const focused = i === cursorRow;
        const pointer = focused ? green("›") : " ";
        if (row.kind === "toggle") {
          const caret = advancedOpen ? "▾" : "▸";
          const label = `[ advanced ${caret} ]`;
          out.push(`${pointer}   ${focused && isPretty() ? reverse(stripAnsi(label)) : dim(label)}`);
          return;
        }
        if (row.kind === "action") {
          out.push(`${pointer}   ${focused && isPretty() ? reverse(stripAnsi(row.label)) : bold(row.label)}`);
          return;
        }
        const req = row.key === "prompt" || row.key === "bee" || (row.key === "max" && !values.forever) ? red("*") : " ";
        const name = padRight(row.label, labelW);
        let field: string;
        if (row.field === "type") {
          const shown = ` ${padRight(values.context, fieldW)} `;
          field = focused && isPretty() ? reverse(shown) : values.context;
        } else if (row.field === "bool") {
          const mark = values[row.key] ? "✓ on" : "· off";
          field = focused && isPretty() ? reverse(` ${padRight(mark, fieldW)} `) : (values[row.key] ? mark : dim(mark));
        } else {
          const value = String(values[row.key] ?? "");
          const shown = truncate(value, fieldW);
          // No brackets: focused = reverse-video box, unfocused = plain text
          // (a dim placeholder when empty).
          if (focused && isPretty()) field = reverse(` ${padRight(shown, fieldW)} `);
          else if (shown.length > 0) field = shown;
          else field = dim(row.field === "bee" ? "↵ pick an agent" : "—");
        }
        out.push(`${pointer} ${req} ${dim(name)}  ${field}`);
      });
      // Help line for the focused row.
      out.push("");
      const row = focusedRow();
      out.push(row ? dim(`  ${truncate(row.description, width - 4)}`) : "");
      return out;
    };

    const renderBeePicker = (width: number): string[] => {
      const out: string[] = [dim(`pick the agent for the loop`), `${cyan("> ")}${beeQuery}`];
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

    const renderNaming = (width: number): string[] => {
      const fieldW = Math.max(10, width - 16);
      const shown = truncate(nameBuffer, fieldW);
      const box = isPretty() ? reverse(` ${padRight(shown, fieldW)} `) : (shown.length > 0 ? shown : dim("…"));
      return [
        dim("save this loop as a reusable template"),
        "",
        `  ${dim("name")}  ${box}`,
        "",
        dim("  letters, digits, - and _ · enter saves · esc cancels"),
      ];
    };

    const parkCursor = () => {
      if (stage === "template") { stdout.write(`\x1b[3;${2 + visibleLength(templateQuery) + 1}H`); return; }
      if (stage === "form" && beePicking) { stdout.write(`\x1b[4;${2 + visibleLength(beeQuery) + 1}H`); return; }
      if (stage === "form" && naming) { stdout.write(`\x1b[5;${8 + visibleLength(nameBuffer) + 1}H`); return; }
      if (stage === "project" && projectView === "browse") { stdout.write(`\x1b[3;${2 + visibleLength(browseQuery) + 1}H`); return; }
      if (stage === "project" && projectView === "path") { stdout.write(`\x1b[3;${2 + visibleLength(pathBuffer) + 1}H`); return; }
    };

    return { onKey, render };
  });
}
