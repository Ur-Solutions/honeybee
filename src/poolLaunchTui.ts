/**
 * `hive pool launch` — the M-P popup (CHECKOUT_POOLS_PRD §6.7): the fastest
 * path from tmux to an agent on a clean base branch. Two fuzzy steps on the
 * shared TUI primitives (runRawModeTui + createFilterList, the launch/fork
 * popup pattern):
 *
 *   1. pool — rows like "core 4/6 · 2 busy"; zero-free pools stay selectable
 *      and show "(will extend)" rather than being disabled.
 *   2. agent — the same account-aware shorthand list `hive launch` offers
 *      (<kind>-auto / <kind>-rr / <kind>-<account>).
 *
 * Happy path: M-P, ↵, ↵ — the caller then allocates + spawns + --here links.
 * Pure choice-gathering: no allocation or spawning happens in here.
 */

import { bold, cyan, dim, green, isPretty, red, stripAnsi, truncate, yellow } from "./format.js";
import type { BeeOption } from "./beePicker.js";
import { reverse, type AsyncState } from "./tuiKit.js";
import { createTuiPainter } from "./tuiPaint.js";
import { runRawModeTui, type RawModeTuiStreams } from "./tuiRuntime.js";
import { createFilterList } from "./tuiScreen.js";

/** One pickable pool row (pre-derived by the caller — no I/O in the TUI). */
export type PoolLaunchRow = {
  /** Full pool key, handed back in the choice. */
  key: string;
  /** Short pool name (the display anchor). */
  pool: string;
  /** e.g. "4/6 free · 2 busy" or "0/3 free (will extend)". */
  capacity: string;
  /** Dimmed context, e.g. "trmd/honeybee/honeybee @ main". */
  context: string;
};

export type PoolLaunchChoice = { poolKey: string; bee: string };

export type PoolLaunchHooks = {
  pools: PoolLaunchRow[];
  /** Account-aware agent shorthands (loaded once, on entering step 2). */
  loadBeeOptions: () => Promise<BeeOption[]>;
  streams?: RawModeTuiStreams;
};

const LIST_ROWS = 12;

/** Render a status row's capacity cell (shared with the non-TUI list output). */
export function poolCapacityCell(status: { free: number; size: number; busy: number }): string {
  if (status.free === 0) return `0/${status.size} free (will extend)`;
  return `${status.free}/${status.size} free · ${status.busy} busy`;
}

export async function choosePoolLaunch(hooks: PoolLaunchHooks): Promise<PoolLaunchChoice | null> {
  return runRawModeTui<PoolLaunchChoice | null>((tui) => {
    const stdout = hooks.streams?.stdout ?? process.stdout;
    const painter = createTuiPainter(stdout);
    let stage: "pool" | "bee" = "pool";
    let chosenPool: PoolLaunchRow | undefined;
    let beeOptions: AsyncState<BeeOption[]> = { state: "idle" };

    const poolList = createFilterList<PoolLaunchRow>(
      () => hooks.pools,
      (row) => `${row.pool} ${row.key} ${row.context}`,
    );
    const beeList = createFilterList<BeeOption>(
      () => (beeOptions.state === "loaded" ? beeOptions.items : []),
      (option) => `${option.label} ${option.value}`,
    );

    const enterBeeStage = async () => {
      stage = "bee";
      beeList.reset();
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

    const render = () => {
      const width = stdout.columns ?? 80;
      const height = stdout.rows ?? 24;
      const lines: string[] = [];
      const crumb = chosenPool ? ` ${dim("·")} ${bold(chosenPool.pool)}` : "";
      lines.push(`${bold("pool launch")}${crumb}  ${dim(stage === "pool" ? "pick a pool" : "pick the agent")}`);
      lines.push("");
      if (stage === "pool") {
        lines.push(`${cyan("> ")}${poolList.query}`);
        const rows = poolList.visible(LIST_ROWS);
        if (rows.length === 0) lines.push(dim(hooks.pools.length === 0 ? "no pools — create one with: pro pool create <name>" : "no match"));
        for (const { item, focused } of rows) {
          const capacity = item.capacity.includes("will extend") ? yellow(item.capacity) : green(item.capacity);
          const line = `${focused ? green("›") : " "} ${focused ? bold(item.pool) : item.pool}  ${capacity}  ${dim(item.context)}`;
          lines.push(focused && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
        }
      } else {
        lines.push(`${cyan("> ")}${beeList.query}`);
        if (beeOptions.state === "loading") lines.push(dim("loading accounts…"));
        else if (beeOptions.state === "error") lines.push(red(beeOptions.error));
        else {
          const rows = beeList.visible(LIST_ROWS);
          if (rows.length === 0) lines.push(dim("no match"));
          for (const { item, focused } of rows) {
            const detail = item.detail ? `  ${dim(item.detail)}` : "";
            const line = `${focused ? green("›") : " "} ${focused ? bold(item.label) : item.label}${detail}`;
            lines.push(focused && isPretty() ? reverse(stripAnsi(line)) : truncate(line, width));
          }
        }
      }
      lines.push("");
      lines.push(dim(stage === "pool" ? "↵ pick pool · type to filter · esc cancel" : "↵ spawn · esc back · type to filter"));
      painter.paint(lines, width, height);
    };

    return {
      onKey(value, key) {
        if (key.ctrl && key.name === "c") { tui.finish(null); return; }
        if (stage === "pool") {
          if (key.name === "escape") { tui.finish(null); return; }
          if (key.name === "return" || key.name === "enter") {
            const pick = poolList.selected();
            if (!pick) return;
            chosenPool = pick;
            void enterBeeStage();
            return;
          }
          if (poolList.handleNavKey(value, key)) render();
          return;
        }
        if (key.name === "escape" || (key.name === "left" && beeList.query.length === 0)) {
          stage = "pool";
          chosenPool = undefined;
          render();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          const bee = beeList.selected();
          if (!bee || !chosenPool) return;
          tui.finish({ poolKey: chosenPool.key, bee: bee.value });
          return;
        }
        if (beeList.handleNavKey(value, key)) render();
      },
      render,
    };
  }, hooks.streams ?? {});
}
