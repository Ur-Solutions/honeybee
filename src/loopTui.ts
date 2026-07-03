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
 * through callbacks so the launch wiring stays in cli.ts. The repo picker and
 * the bee picker are the shared Screens from src/projectPicker.ts and
 * src/beePicker.ts; this module wires them into the template/form stages.
 */

import type * as readline from "node:readline";
import { bold, cyan, dim, green, isPretty, red, stripAnsi, truncate, visibleLength } from "./format.js";
import { createTuiPainter } from "./tuiPaint.js";
import type { LoopTemplate } from "./loopTemplate.js";
import { createBeePicker, type BeeOption } from "./beePicker.js";
import { createProjectPicker } from "./projectPicker.js";
import { clamp, fuzzyFilter, isPrintable, padRight, relTilde, reverse } from "./tuiKit.js";
import { runRawModeTui } from "./tuiRuntime.js";

/** Re-exported from beePicker: the account-aware agent choice for the bee field. */
export type { BeeOption };

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
  // The repo picker and the bee picker own their own cursors/scroll/query.
  let templateQuery = "";
  let cursorTemplate = 0;
  let templateScroll = 0;
  let cursorRow = 0; // index into formRows(advancedOpen)

  // ── save-as-template inline name field ───────────────────────────────────
  let naming = false;
  let nameBuffer = "";
  let nameError = "";

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

    // ── the repo/cwd picker (here · browse repos · type a path) ────────────
    const projectPicker = createProjectPicker({
      hooks,
      text: {
        browseMenuLabel: "browse repos…",
        pathMenuLabel: "type a path…",
        menuMessage: "↑↓ pick · enter: here / browse repos / type a path · ← back",
        browseMessage: "type to filter · ↑↓ pick · enter select · esc back",
        pathMessage: "type to filter · ↑↓ pick · tab drills in · enter select · esc back",
        browseLoading: "loading repos…",
        browseEmptyNone: "no repos found",
        pathFallback: "enter uses the typed path",
      },
      ownsMenu: true,
      onChosen: (path) => repoChosen(path),
      onBack: () => backToTemplate(),
      onQuit: () => finish(null),
      setMessage: (m) => { message = m; },
      render: () => render(),
      isDone: () => tui.done,
      stdout,
    });

    // ── the bee picker overlay (the bee field opens an agent list) ─────────
    const beePicker = createBeePicker({
      title: () => "pick the agent for the loop",
      load: () => hooks.loadBeeOptions(),
      onChosen: (value) => { values.bee = value; },
      render: () => render(),
      isDone: () => tui.done,
    });

    // ── stage transitions ─────────────────────────────────────────────────
    const chooseTemplate = () => {
      const picked = filteredTemplates()[cursorTemplate];
      if (!picked) return;
      values = seedFormFromTemplate(picked.template);
      enterProject();
    };

    const enterProject = () => {
      stage = "project";
      projectPicker.enterMenu(true);
    };

    const backToTemplate = () => {
      stage = "template";
      stdout.write("\x1b[?25h");
      message = "type to filter · ↑↓ pick · enter select · q cancel";
      render();
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

    // ── key handlers (each returns true when it consumes the key) ──────────
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
      if (stage !== "form" || beePicker.active || naming) return false;
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
        if (key.name === "return" || key.name === "enter" || key.name === "tab" || isPrintable(value, key)) { void beePicker.open(); return true; }
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

    const onKey = (value: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") { finish(null); return; }
      if (handleTemplateKey(value, key)) return;
      if (beePicker.onKey(value, key)) return;
      if (handleNamingKey(value, key)) return;
      if (handleFormKey(value, key)) return;
      if (stage === "project" && projectPicker.onKey(value, key)) return;
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
      else if (stage === "form") lines.push(...renderForm(width, bodyRows));
      else lines.push(...projectPicker.render(width, bodyRows));

      while (lines.length < height - 2) lines.push("");
      const err = stage === "form" ? (naming ? nameError : formError) : projectPicker.errorLine();
      lines.push(truncate(err ? red(err) : message, width));
      lines.push(dim(footer()));
      painter.paint(lines, width, height);
      parkCursor();
    };

    const footer = (): string => {
      if (stage === "template") return "type to filter · ↑↓ move · enter select · q quit";
      if (stage === "form" && beePicker.active) return "type to filter · ↑↓ move · enter pick · esc back";
      if (stage === "form" && naming) return "type a name · enter save · esc cancel";
      if (stage === "form") return "↑↓ field · type to edit · enter next/launch · ← back";
      if (projectPicker.active()) return "type to filter · ↑↓ move · enter select · esc back";
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

    const renderForm = (width: number, bodyRows: number): string[] => {
      if (beePicker.active) return beePicker.render(width, bodyRows);
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
      if (stage === "form" && beePicker.active) { writeCursor(beePicker.cursor()); return; }
      if (stage === "form" && naming) { stdout.write(`\x1b[5;${8 + visibleLength(nameBuffer) + 1}H`); return; }
      if (stage === "project") { writeCursor(projectPicker.cursor()); return; }
    };

    // Park the terminal cursor from a Screen's body-relative coordinate. Body
    // starts on screen line 3 (header, blank, then the first body row).
    const writeCursor = (at: { line: number; col: number } | null) => {
      if (at) stdout.write(`\x1b[${3 + at.line};${at.col}H`);
    };

    return { onKey, render };
  });
}
