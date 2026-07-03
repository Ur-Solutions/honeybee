/**
 * Incremental frame painter shared by the full-screen TUIs. Repainting used to
 * erase the whole screen (\x1b[2J) and rewrite every line on each keypress and
 * timer tick, which flickers on most terminals. The painter remembers the
 * previously painted frame and rewrites only the lines that changed, clearing
 * each rewritten line before writing so shorter content leaves no residue. A
 * size change (the terminal reflows the alt screen unpredictably on resize)
 * drops the remembered frame and falls back to one full clear + repaint.
 */
import { truncate } from "./format.js";

export type TuiPainter = {
  /** Truncate each line to `width` and paint the frame, diffing against the previous paint. */
  paint(lines: string[], width: number, height: number): void;
  /** Forget the previous frame so the next paint() does a full clear + repaint. */
  reset(): void;
};

export function createTuiPainter(out: { write: (chunk: string) => void }): TuiPainter {
  let prev: string[] | undefined;
  let prevWidth = -1;
  let prevHeight = -1;
  return {
    reset() {
      prev = undefined;
    },
    paint(lines, width, height) {
      if (width !== prevWidth || height !== prevHeight) prev = undefined;
      prevWidth = width;
      prevHeight = height;
      const next = lines.map((line) => truncate(line, width));
      if (!prev) {
        out.write(`\x1b[2J\x1b[H${next.join("\n")}`);
        prev = next;
        return;
      }
      let chunk = "";
      for (let i = 0; i < next.length; i += 1) {
        if (next[i] === prev[i]) continue;
        chunk += `\x1b[${i + 1};1H\x1b[2K${next[i]}`;
      }
      // The frame shrank: wipe the rows the previous frame still owns below it.
      if (next.length < prev.length) chunk += `\x1b[${next.length + 1};1H\x1b[0J`;
      prev = next;
      if (chunk) out.write(chunk);
    },
  };
}
