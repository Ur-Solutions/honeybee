/**
 * BeePicker — the account-aware agent overlay shared by `hive loop launch` and
 * `hive launch`. A field opens it; it loads `<kind>-auto`/`<kind>-rr`/per-account
 * shorthands once, fuzzy-filters them, and writes the chosen value back through
 * `onChosen`. The two hosts differ only in the overlay title and where the value
 * lands, so both are configuration on the same Screen.
 */

import type * as readline from "node:readline";
import { bold, cyan, dim, green, isPretty, red, stripAnsi, truncate, visibleLength } from "./format.js";
import { type AsyncState, reverse } from "./tuiKit.js";
import { createFilterList, type Screen } from "./tuiScreen.js";

/** An agent×account choice (value is a `hive spawn` shorthand). */
export type BeeOption = {
  /** The shorthand written into the field, e.g. "claude-auto", "codex-rr", or "codex-thto". */
  value: string;
  /** Display label, e.g. "claude · auto" or "codex · thto.no". */
  label: string;
  /** Optional right-hand detail (usage, etc.). */
  detail?: string;
};

export type BeePickerConfig = {
  /** Overlay title line, e.g. "pick the agent for the loop". Evaluated per render. */
  title: () => string;
  /** Load the account-aware options (called once; cached across reopens). */
  load: () => Promise<BeeOption[]>;
  /** Write the chosen shorthand back into the host form. */
  onChosen: (value: string) => void;
  /** Host repaint. */
  render: () => void;
  /** True once the host TUI has finished (skip a repaint after an async load). */
  isDone: () => boolean;
};

export type BeePicker = Screen & {
  /** Whether the overlay is currently open (the host routes keys/render on this). */
  active: boolean;
  /** Open the overlay, loading options on first use. */
  open(): Promise<void>;
};

const LIST_ROWS = 12;

export function createBeePicker(config: BeePickerConfig): BeePicker {
  let options: AsyncState<BeeOption[]> = { state: "idle" };
  const list = createFilterList<BeeOption>(
    () => (options.state === "loaded" ? options.items : []),
    (o) => `${o.label} ${o.value}`,
  );

  const choose = () => {
    const opt = list.selected();
    if (opt) config.onChosen(opt.value);
    picker.active = false;
    config.render();
  };

  const picker: BeePicker = {
    active: false,
    async open() {
      picker.active = true;
      list.reset();
      if (options.state === "idle" || options.state === "error") {
        options = { state: "loading" };
        config.render();
        try {
          options = { state: "loaded", items: await config.load() };
        } catch (error) {
          options = { state: "error", error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (!config.isDone()) config.render();
    },
    onKey(value, key) {
      if (!picker.active) return false;
      if (key.name === "escape" || key.name === "left") { picker.active = false; config.render(); return true; }
      if (key.name === "return" || key.name === "enter") { choose(); return true; }
      if (list.handleNavKey(value, key)) { config.render(); return true; }
      return true; // consume everything else while filtering
    },
    render(width) {
      const out: string[] = [dim(config.title()), `${cyan("> ")}${list.query}`];
      if (options.state === "loading") { out.push(dim("loading accounts…")); return out; }
      if (options.state === "error") { out.push(red(options.error)); return out; }
      if (list.filtered().length === 0) { out.push(dim("no match")); return out; }
      for (const { item, focused } of list.visible(LIST_ROWS)) {
        const pointer = focused ? green("›") : " ";
        const detail = item.detail ? `  ${dim(item.detail)}` : "";
        const line = `${pointer} ${focused ? bold(item.label) : item.label}${detail}`;
        out.push(focused && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
      }
      return out;
    },
    cursor() {
      // The query lives on the 2nd body line (title, then "> query").
      return picker.active ? { line: 1, col: 2 + visibleLength(list.query) + 1 } : null;
    },
  };
  return picker;
}
