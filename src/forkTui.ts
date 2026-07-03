/**
 * `hive fork launch` — interactive fork launcher (the ⌘K window).
 *
 * Unlike the loop/frame launchers, the SOURCE is fixed — it's the bee that owns
 * the current pane — so there is no template or project-picker stage: the dialog
 * opens straight on a single form for composing the fork (seed mode, agent,
 * model, worktree isolation, account, name). Enter on ▶ Fork returns the chosen
 * values; cli.ts turns them into a `hive fork` invocation.
 *
 * Presentation-only and dependency-free, mirroring src/loopTui.ts: raw mode +
 * alt screen + signal-safe restore, one keypress handler, a full redraw per
 * event. All data (agent kinds, account options, pro-repo detection) arrives
 * through the hooks so the fork wiring stays in cli.ts.
 */

import * as readline from "node:readline";
import { bold, cyan, dim, green, isPretty, red, stripAnsi, truncate, visibleLength } from "./format.js";

/** The editable form state — the fork the user is composing. */
export type ForkFormValues = {
  /** Seeding intent: auto (resume→seal→log→cold ladder) | seal | log | cold. */
  seed: string;
  /** Fork's agent kind (defaults to the source's). */
  agent: string;
  /** Optional model override. */
  model: string;
  /** Working dir: same as source, or a fresh pro worktree/checkout. */
  where: string;
  /** Worktree/checkout slot name (used only when where ≠ "same"). */
  slot: string;
  /** Account value: "" (inherit / no binding) | "auto" | <account-id>. */
  account: string;
  /** Optional explicit fork name. */
  name: string;
  /** Optional first instruction sent to the fork once it boots. */
  message: string;
};

/** An account choice for the account picker. `value` is what `--account` gets. */
export type ForkAccountOption = {
  /** "" = inherit/no binding, "auto" = least-loaded, or an account id. */
  value: string;
  label: string;
  detail?: string;
};

export type ForkSource = {
  name: string;
  id: string;
  agent: string;
  cwd: string;
  accountId?: string;
};

export type ForkLaunchResult = {
  action: "fork";
  values: ForkFormValues;
};

export type ForkTuiHooks = {
  source: ForkSource;
  /** Tildified source cwd, for the breadcrumb. */
  cwdLabel: string;
  /** Agent kinds the agent field cycles through. */
  agentKinds: string[];
  /** The pro repo the source lives in, or null when worktree isolation is N/A. */
  proRepo: { label: string; path: string } | null;
  /** True when the source is account-bound: the fork MUST pick its own account. */
  accountRequired: boolean;
  /** Account choices (already filtered to safe options by cli.ts). */
  accountOptions: ForkAccountOption[];
  /** Pre-seeded defaults (built by cli.ts so the form opens ready to launch). */
  defaults: ForkFormValues;
};

/** The seed-intent choices the "seed" picker cycles through. */
export const SEED_OPTIONS = ["auto", "seal", "log", "cold"] as const;

/** One-line gloss per seed intent, shown as the focused row's help. */
export const SEED_HELP: Record<string, string> = {
  auto: "resume the same session if possible, else seed from a seal, then the log, then boot cold",
  seal: "seed the fork with a brief from the source's latest seal",
  log: "tell the fork to read the source's transcript log and continue",
  cold: "a fresh sibling — same agent and cwd, no inherited history",
};

/** The working-dir choices; worktree/checkout only when the source is in a pro repo. */
export function whereOptions(hasProRepo: boolean): string[] {
  return hasProRepo ? ["same", "worktree", "checkout"] : ["same"];
}

/**
 * Build the form's opening values (pure, for testing). The account defaults to
 * the first concrete option for an account-bound source (which never includes
 * the source's own account), otherwise to "" (inherit / no binding).
 */
export function defaultForkForm(input: {
  sourceAgent: string;
  accountRequired: boolean;
  accountOptions: ForkAccountOption[];
  suggestSlot: string;
}): ForkFormValues {
  const account = input.accountRequired
    ? (input.accountOptions.find((o) => o.value !== "")?.value ?? "auto")
    : "";
  return {
    seed: "auto",
    agent: input.sourceAgent,
    model: "",
    where: "same",
    slot: input.suggestSlot,
    account,
    name: "",
    message: "",
  };
}

/**
 * Which essentials are still missing (pure, for testing) — the launch gate. A
 * worktree/checkout needs a slot name; an account-bound source needs an account.
 */
export function missingForFork(values: ForkFormValues, ctx: { accountRequired: boolean }): string[] {
  const missing: string[] = [];
  if (ctx.accountRequired && values.account.trim().length === 0) missing.push("account");
  if ((values.where === "worktree" || values.where === "checkout") && values.slot.trim().length === 0) {
    missing.push("name");
  }
  return missing;
}

/** The fork intent — the structured shape cli.ts maps onto `hive fork` flags. */
export type ForkIntent = {
  selector: string;
  /** undefined = auto/default ladder; otherwise the explicit `--seed`. */
  seed?: "seal" | "log" | "none";
  agent?: string;
  model?: string;
  name?: string;
  /** "auto" or an account id; absent = inherit / no binding. */
  account?: string;
  isolation?: { kind: "worktree" | "checkout"; name: string };
  message?: string;
};

/**
 * Translate the composed form into a fork intent (pure, for testing). Only
 * meaningful overrides are emitted: an unchanged agent, an empty model, the
 * "same" working dir, and an empty account all fall through to `hive fork`'s
 * own defaults.
 */
export function forkIntent(values: ForkFormValues, ctx: { sourceName: string; sourceAgent: string }): ForkIntent {
  const intent: ForkIntent = { selector: ctx.sourceName };
  if (values.seed === "seal") intent.seed = "seal";
  else if (values.seed === "log") intent.seed = "log";
  else if (values.seed === "cold") intent.seed = "none";
  const agent = values.agent.trim();
  if (agent && agent !== ctx.sourceAgent) intent.agent = agent;
  if (values.model.trim()) intent.model = values.model.trim();
  if (values.name.trim()) intent.name = values.name.trim();
  if (values.account.trim()) intent.account = values.account.trim();
  if (values.where === "worktree" || values.where === "checkout") {
    intent.isolation = { kind: values.where, name: values.slot.trim() };
  }
  if (values.message.trim()) intent.message = values.message.trim();
  return intent;
}

// ── form row model ───────────────────────────────────────────────────────────
// A flat list of focusable rows, recomputed each render. The slot row appears
// only for a worktree/checkout; the account row is an essential for an
// account-bound source and an advanced field otherwise.

type OptKind = "seed" | "agent" | "where" | "account";
type FieldRow = {
  kind: "field";
  key: keyof ForkFormValues;
  label: string;
  field: "cycle" | "text";
  opts?: OptKind;
  description: string;
};
type ToggleRow = { kind: "toggle"; label: string; description: string };
type ActionRow = { kind: "action"; label: string; description: string };
type FormRow = FieldRow | ToggleRow | ActionRow;

const SEED_ROW: FieldRow = { kind: "field", key: "seed", label: "seed", field: "cycle", opts: "seed", description: SEED_HELP.auto! };
const AGENT_ROW: FieldRow = { kind: "field", key: "agent", label: "agent", field: "cycle", opts: "agent", description: "the fork's harness (defaults to the source's; a different harness seeds from a seal/log)" };
const WHERE_ROW: FieldRow = { kind: "field", key: "where", label: "where", field: "cycle", opts: "where", description: "run in the source's dir, or branch into a fresh pro worktree/checkout" };
const SLOT_ROW: FieldRow = { kind: "field", key: "slot", label: "name", field: "text", description: "name for the new worktree/checkout slot (created beside the repo)" };
const ACCOUNT_ROW: FieldRow = { kind: "field", key: "account", label: "account", field: "cycle", opts: "account", description: "which account the fork runs on (must differ from the source's)" };
const MODEL_ROW: FieldRow = { kind: "field", key: "model", label: "model", field: "text", description: "model override, e.g. opus / sonnet / gpt-5-codex (blank keeps the default)" };
const NAME_ROW: FieldRow = { kind: "field", key: "name", label: "fork name", field: "text", description: "explicit name for the fork (blank auto-generates one)" };
const MESSAGE_ROW: FieldRow = { kind: "field", key: "message", label: "message", field: "text", description: "first instruction sent to the fork once it boots (blank sends nothing)" };
const ADVANCED_TOGGLE: ToggleRow = { kind: "toggle", label: "advanced", description: "reveal model, fork name, account, and first message (↵ to toggle)" };
const FORK_ACTION: ActionRow = { kind: "action", label: "▶ Fork", description: "create the fork and link it here (↵ to fork)" };

/** The focusable rows for the current form state (pure, for testing). */
export function formRows(values: ForkFormValues, advancedOpen: boolean, accountRequired: boolean): FormRow[] {
  const rows: FormRow[] = [SEED_ROW, AGENT_ROW, WHERE_ROW];
  if (values.where === "worktree" || values.where === "checkout") rows.push(SLOT_ROW);
  if (accountRequired) rows.push(ACCOUNT_ROW);
  rows.push(ADVANCED_TOGGLE);
  if (advancedOpen) {
    rows.push(MODEL_ROW, NAME_ROW);
    if (!accountRequired) rows.push(ACCOUNT_ROW);
    rows.push(MESSAGE_ROW);
  }
  rows.push(FORK_ACTION);
  return rows;
}

export async function chooseFork(hooks: ForkTuiHooks): Promise<ForkLaunchResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("hive fork launch requires a TTY — run it from a tmux popup binding (⌘K) or an interactive terminal.");
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRaw = stdin.isRaw;

  const optionList = (kind: OptKind): string[] => {
    switch (kind) {
      case "seed": return [...SEED_OPTIONS];
      case "agent": return hooks.agentKinds.length > 0 ? hooks.agentKinds : [hooks.source.agent];
      case "where": return whereOptions(hooks.proRepo !== null);
      case "account": return hooks.accountOptions.map((o) => o.value);
    }
  };
  const accountLabel = (value: string): string => {
    const opt = hooks.accountOptions.find((o) => o.value === value);
    if (!opt) return value || "—";
    return opt.detail ? `${opt.label}  ${dim(opt.detail)}` : opt.label;
  };

  let values: ForkFormValues = { ...hooks.defaults };
  let advancedOpen = false;
  let cursorRow = 0;
  let formError = "";
  let message = "↑↓ field · type to edit · ←/→ or space cycle · enter fork · q cancel";

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
    return await new Promise<ForkLaunchResult | null>((resolve) => {
      let done = false;
      const finish = (result: ForkLaunchResult | null) => {
        if (done) return;
        done = true;
        stdin.off("keypress", onKey);
        stdout.off("resize", onResize);
        resolve(result);
      };

      const rows = (): FormRow[] => formRows(values, advancedOpen, hooks.accountRequired);
      const focusedRow = (): FormRow | undefined => rows()[cursorRow];

      const cycle = (kind: OptKind, dir: 1 | -1) => {
        const list = optionList(kind);
        if (list.length === 0) return;
        const key = kind === "seed" ? "seed" : kind === "agent" ? "agent" : kind === "where" ? "where" : "account";
        const i = Math.max(0, list.indexOf(values[key as keyof ForkFormValues] as string));
        const next = (i + dir + list.length) % list.length;
        values[key as keyof ForkFormValues] = list[next]! as never;
        formError = "";
        render();
      };

      const toggleAdvanced = () => {
        advancedOpen = !advancedOpen;
        // Keep focus on the toggle row so the reveal doesn't jump the cursor.
        cursorRow = rows().findIndex((r) => r.kind === "toggle");
        render();
      };

      const submitFork = () => {
        const missing = missingForFork(values, { accountRequired: hooks.accountRequired });
        if (missing.length > 0) {
          formError = `fill required: ${missing.join(", ")}`;
          render();
          return;
        }
        finish({ action: "fork", values: { ...values } });
      };

      const isPrintable = (value: string, key: readline.Key) =>
        Boolean(value) && value.length === 1 && value >= " " && !key.ctrl && !key.meta;

      const onKey = (value: string, key: readline.Key) => {
        if (key.ctrl && key.name === "c") { finish(null); return; }
        if (key.name === "escape") { finish(null); return; }
        if (key.name === "up") { cursorRow = clamp(cursorRow - 1, rows().length); formError = ""; render(); return; }
        if (key.name === "down") { cursorRow = clamp(cursorRow + 1, rows().length); formError = ""; render(); return; }

        const row = focusedRow();
        // `q` cancels everywhere except a focused text field, where it is
        // literal input — a fork named "queen" must be typable. esc/Ctrl-C
        // (above) cancel regardless of focus.
        if (key.name === "q" && !(row?.kind === "field" && row.field === "text")) { finish(null); return; }
        if (!row) return;

        if (row.kind === "toggle") {
          if (key.name === "return" || key.name === "enter" || key.name === "space" || key.name === "right" || key.name === "left") toggleAdvanced();
          return;
        }
        if (row.kind === "action") {
          if (key.name === "return" || key.name === "enter") submitFork();
          return;
        }
        // field row
        if (row.field === "cycle" && row.opts) {
          if (key.name === "right" || key.name === "space" || key.name === "return" || key.name === "enter") { cycle(row.opts, 1); return; }
          if (key.name === "left") { cycle(row.opts, -1); return; }
          return;
        }
        // text field
        if (key.name === "return" || key.name === "enter") { cursorRow = clamp(cursorRow + 1, rows().length); render(); return; }
        if (key.name === "left" || key.name === "right") return; // let arrows stay on the row
        if (key.name === "backspace") { values[row.key] = String(values[row.key]).slice(0, -1) as never; render(); return; }
        if (key.ctrl && key.name === "u") { values[row.key] = "" as never; render(); return; }
        if (isPrintable(value, key)) { values[row.key] = (String(values[row.key]) + value) as never; render(); return; }
      };

      // ── rendering ──────────────────────────────────────────────────────────
      const render = () => {
        if (done) return;
        const width = Math.max(40, stdout.columns || 100);
        const height = Math.max(12, stdout.rows || 24);

        const header = `${bold("hive fork")}  ${dim(breadcrumb())}`;
        const lines: string[] = [header, "", ...renderForm(width)];
        while (lines.length < height - 2) lines.push("");
        lines.push(truncate(formError ? red(formError) : message, width));
        lines.push(dim("↑↓ field · ←/→ or space cycle · type to edit · enter fork · q/esc cancel"));
        stdout.write(`\x1b[2J\x1b[H${lines.map((line) => truncate(line, width)).join("\n")}`);
        parkCursor(width);
      };

      const breadcrumb = (): string => {
        const parts = [`${hooks.source.name}`, values.agent, values.seed];
        if (values.where !== "same") parts.push(`${values.where}:${values.slot || "…"}`);
        else parts.push(relTilde(hooks.source.cwd));
        return parts.join("  ›  ");
      };

      const renderForm = (width: number): string[] => {
        const list = rows();
        const fieldRows = list.filter((r): r is FieldRow => r.kind === "field");
        const labelW = Math.min(16, Math.max(6, ...fieldRows.map((r) => r.label.length + 2)));
        const fieldW = Math.max(10, width - labelW - 8);
        const out: string[] = [dim(`fork ${hooks.source.name} — ${red("*")} = required`), ""];
        list.forEach((row, i) => {
          const focused = i === cursorRow;
          const pointer = focused ? green("›") : " ";
          if (row.kind === "toggle") {
            const label = `[ advanced ${advancedOpen ? "▾" : "▸"} ]`;
            out.push(`${pointer}   ${focused && isPretty() ? reverse(stripAnsi(label)) : dim(label)}`);
            return;
          }
          if (row.kind === "action") {
            out.push(`${pointer}   ${focused && isPretty() ? reverse(stripAnsi(row.label)) : bold(row.label)}`);
            return;
          }
          const required = (row.key === "slot" && values.where !== "same") || (row.key === "account" && hooks.accountRequired);
          const req = required ? red("*") : " ";
          const name = padRight(row.label, labelW);
          let field: string;
          if (row.field === "cycle") {
            const shown = row.opts === "account" ? accountLabel(values.account) : String(values[row.key]);
            field = focused && isPretty() ? reverse(` ${padRight(stripAnsi(shown), fieldW)} `) : shown;
          } else {
            const shown = truncate(String(values[row.key] ?? ""), fieldW);
            if (focused && isPretty()) field = reverse(` ${padRight(shown, fieldW)} `);
            else if (shown.length > 0) field = shown;
            else field = dim("—");
          }
          out.push(`${pointer} ${req} ${dim(name)}  ${field}`);
        });
        out.push("");
        const row = focusedRow();
        const help = row?.kind === "field" && row.key === "seed" ? (SEED_HELP[values.seed] ?? row.description) : row && "description" in row ? row.description : "";
        out.push(help ? dim(`  ${truncate(help, width - 4)}`) : "");
        return out;
      };

      const parkCursor = (width: number) => {
        // Park the real cursor at the end of a focused TEXT field so typing feels
        // native; cycle/toggle/action rows hide it.
        const row = focusedRow();
        if (!row || row.kind !== "field" || row.field !== "text") return;
        const list = rows();
        const labelW = Math.min(16, Math.max(6, ...list.filter((r): r is FieldRow => r.kind === "field").map((r) => r.label.length + 2)));
        const screenRow = 2 /* header+blank */ + 2 /* form title+blank */ + cursorRow + 1;
        const col = 1 /* pointer */ + 1 + 1 /* req */ + 1 + labelW + 2 + 1 + visibleLength(String(values[row.key]));
        stdout.write(`\x1b[${screenRow};${Math.min(col, width)}H`);
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
