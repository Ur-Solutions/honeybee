/**
 * Shared raw-mode/alt-screen runtime for the full-screen TUIs.
 *
 * Every hive TUI has the same shell: enter the alt screen in raw mode with a
 * hidden cursor, run a single keypress handler plus a full-redraw render loop,
 * and restore the terminal exactly once no matter how the TUI ends (finish,
 * throw, signal, or process exit). This module owns that shell so a lifecycle
 * fix lands in one place; the TUIs themselves stay presentation-only.
 *
 * Usage: `runRawModeTui((tui) => { …closure state…; return { onKey, render } })`.
 * The runtime paints the first frame, wires keypress/resize, and resolves with
 * whatever the app passes to `tui.finish(result)`.
 */

import * as readline from "node:readline";

/** Handle the app uses to end the TUI and to guard its async callbacks. */
export type RawModeTui<T> = {
  /** True once finish() has run — async callbacks should bail instead of repainting. */
  readonly done: boolean;
  /** Resolve runRawModeTui with `result`, detaching listeners. Idempotent. */
  finish: (result: T) => void;
  /** Register teardown (timers, …) run inside the first finish(), before resolve. */
  defer: (fn: () => void) => void;
};

/** What the app hands back to the runtime: its key handler and render loop. */
export type RawModeTuiApp = {
  /** The single raw-mode keypress handler. */
  onKey: (value: string, key: readline.Key) => void;
  /** Full-frame repaint; called once after setup and on every resize. */
  render: () => void;
  /** Resize handler; defaults to `render`. */
  onResize?: () => void;
  /** Runs after the first render and listener attach (kick off timers/fetches). */
  start?: () => void;
};

/** Stream overrides for tests; defaults to the real process stdin/stdout. */
export type RawModeTuiStreams = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
};

/**
 * Run a full-screen TUI: alt screen + raw mode + hidden cursor on entry, a
 * signal-safe restore on every exit path, and resolve/teardown plumbing via
 * `tui.finish`. Callers must have verified the streams are TTYs.
 */
export async function runRawModeTui<T>(
  create: (tui: RawModeTui<T>) => RawModeTuiApp,
  streams: RawModeTuiStreams = {},
): Promise<T> {
  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  const previousRaw = stdin.isRaw;

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
    return await new Promise<T>((resolve) => {
      let done = false;
      const deferred: Array<() => void> = [];
      let onKey: RawModeTuiApp["onKey"] | undefined;
      let onResize: (() => void) | undefined;
      const tui: RawModeTui<T> = {
        get done() {
          return done;
        },
        finish: (result: T) => {
          if (done) return;
          done = true;
          for (const fn of deferred) fn();
          if (onKey) stdin.off("keypress", onKey);
          if (onResize) stdout.off("resize", onResize);
          resolve(result);
        },
        defer: (fn) => {
          deferred.push(fn);
        },
      };
      const app = create(tui);
      if (done) return; // finished during setup — nothing to attach
      onKey = app.onKey;
      onResize = app.onResize ?? app.render;
      app.render();
      stdin.on("keypress", onKey);
      stdout.on("resize", onResize);
      app.start?.();
    });
  } finally {
    process.off("exit", restoreTerminal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    restoreTerminal();
  }
}
