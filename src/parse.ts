export type Parsed = {
  command: string;
  args: string[];
  flags: Map<string, string | true | string[]>;
  rest: string[];
};

export const BOOLEAN_FLAGS = new Set([
  "accept-trust",
  "all",
  "auto",
  "autoswap",
  "background",
  "briefed",
  "case",
  "cleanup",
  "clear",
  "consume",
  "dangerous",
  "dead",
  "dry-run",
  "f",
  "follow",
  "force",
  "force-send",
  "foreground",
  "here",
  "window",
  "forever",
  "help",
  "i",
  "interactive",
  "json",
  "keep",
  "last",
  "new-client",
  "now",
  "popup",
  "print",
  "read",
  "regex",
  "rm",
  "samples",
  "seal",
  "transcript",
  "trust",
  "unread",
  "version",
  "wait",
  "watch",
  "wide",
  "yolo",
  "no-yolo",
  "no-accept-trust",
  "no-auto",
  "no-trust",
  "no-wait-footer",
  "no-footer",
  "no-wait",
]);

export function parse(argv: string[]): Parsed {
  const [command = "", ...tail] = argv;
  const flags = new Map<string, string | true | string[]>();
  const args: string[] = [];
  let rest: string[] = [];

  for (let i = 0; i < tail.length; i += 1) {
    const item = tail[i]!;
    if (item === "--") {
      rest = tail.slice(i + 1);
      break;
    }
    if (item.startsWith("--")) {
      const eq = item.indexOf("=");
      const key = item.slice(2, eq > -1 ? eq : undefined);
      const value = eq > -1 ? item.slice(eq + 1) : BOOLEAN_FLAGS.has(key) ? true : i + 1 < tail.length && !tail[i + 1]!.startsWith("-") ? tail[++i]! : true;
      setFlag(flags, key, value);
      continue;
    }
    if (item.startsWith("-") && item.length > 1) {
      const key = item.slice(1);
      const value = BOOLEAN_FLAGS.has(key) ? true : i + 1 < tail.length && !tail[i + 1]!.startsWith("-") ? tail[++i]! : true;
      setFlag(flags, key, value);
      continue;
    }
    args.push(item);
  }

  return { command, args, flags, rest };
}

export function setFlag(flags: Map<string, string | true | string[]>, key: string, value: string | true) {
  const existing = flags.get(key);
  if (Array.isArray(existing)) existing.push(String(value));
  else if (existing !== undefined) flags.set(key, [String(existing), String(value)]);
  else flags.set(key, value);
}

export function flag(parsed: Parsed, key: string): string | true | string[] | undefined {
  return parsed.flags.get(key);
}

export function numberFlag(parsed: Parsed, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = flag(parsed, key);
    if (typeof value === "string") {
      const parsedValue = Number(value);
      if (Number.isFinite(parsedValue)) return parsedValue;
    }
  }
  return fallback;
}

export function truthy(value: unknown) {
  return value === true || value === "true" || value === "1" || value === "yes";
}
