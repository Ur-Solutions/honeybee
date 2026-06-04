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
  if (!next.startsWith(previous)) return next;
  return next.slice(previous.length).replace(/^\n/, "");
}
