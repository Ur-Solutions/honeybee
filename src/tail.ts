import { flag, numberFlag, truthy, type Parsed } from "./parse.js";

export type TailOptions = {
  follow: boolean;
  lines: number;
  pollMs: number;
};

export function parseTailOptions(parsed: Parsed): TailOptions {
  return {
    follow: truthy(flag(parsed, "f")) || truthy(flag(parsed, "follow")),
    lines: numberFlag(parsed, ["n", "lines"], 80),
    pollMs: numberFlag(parsed, ["poll-ms", "poll", "interval"], 1000),
  };
}

export function appendedPaneText(previous: string, next: string): string {
  if (!previous) return next;
  if (next === previous) return "";
  if (next.startsWith(previous)) return next.slice(previous.length).replace(/^\n/, "");
  // TUI agents redraw in place and the capture window slides, so `next`
  // rarely starts with the whole previous capture. Find the largest suffix of
  // `previous` that is a prefix of `next` and emit only the remainder; fall
  // back to a full dump only when the captures share no overlap at all.
  const overlap = suffixPrefixOverlap(previous, next);
  if (overlap === 0) return next;
  return next.slice(overlap).replace(/^\n/, "");
}

// Length of the longest suffix of `previous` that is a prefix of `next`,
// computed in linear time via the KMP prefix function over
// `next + separator + previous`. NUL never occurs in pane captures, so it is
// a safe unique separator.
function suffixPrefixOverlap(previous: string, next: string): number {
  const pattern = next.length > previous.length ? next.slice(0, previous.length) : next;
  const text = `${pattern}\u0000${previous}`;
  const prefix = new Array<number>(text.length).fill(0);
  for (let i = 1; i < text.length; i += 1) {
    let k = prefix[i - 1]!;
    while (k > 0 && text[i] !== text[k]) k = prefix[k - 1]!;
    if (text[i] === text[k]) k += 1;
    prefix[i] = k;
  }
  return Math.min(prefix[text.length - 1]!, pattern.length);
}
