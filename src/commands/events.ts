// `hive events` — subscribe to the ledger's event stream (CL.701 §4.3).
// Reads are pure file tails: they work with the daemon down, so an observer
// never has to poll an LLM (or a transcript) to learn what changed.
import { collectLedgerEvents, followLedgerEvents, parseSince, type LedgerEvent, type LedgerEventFilter } from "../events.js";
import { bold, cyan, dim, isPretty } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { followFlag, logLinesFlag } from "../cli/shared.js";

export const EVENTS_USAGE =
  "Usage: hive events [-n <count>] [--type <glob>]... [--session <bee>]... [--since <iso|30s|15m|2h|1d>] [-f|--follow] [--json]";

function listFlag(parsed: Parsed, name: string): string[] {
  const raw = flag(parsed, name);
  if (raw === undefined) return [];
  if (raw === true) throw new Error(`--${name} requires a value`);
  return (Array.isArray(raw) ? raw : [raw]).flatMap((value) => String(value).split(",")).map((v) => v.trim()).filter(Boolean);
}

export function eventsFilterFromFlags(parsed: Parsed, nowMs: number): LedgerEventFilter {
  const types = listFlag(parsed, "type");
  const sessions = listFlag(parsed, "session");
  const sinceRaw = flag(parsed, "since");
  if (sinceRaw === true) throw new Error("--since requires a value");
  if (Array.isArray(sinceRaw)) throw new Error("--since was given multiple times; pass it once");
  return {
    ...(types.length > 0 ? { types } : {}),
    ...(sessions.length > 0 ? { sessions } : {}),
    ...(sinceRaw !== undefined ? { sinceMs: parseSince(String(sinceRaw), nowMs) } : {}),
  };
}

export function formatLedgerEvent(event: LedgerEvent, pretty: boolean): string {
  if (!pretty) return JSON.stringify(event);
  const { ts, type, session, name, ...rest } = event;
  const subject = typeof session === "string" ? session : typeof name === "string" ? name : undefined;
  const extras = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return [
    dim(typeof ts === "string" ? ts : ""),
    cyan(typeof type === "string" ? type : "(untyped)"),
    subject ? bold(subject) : "",
    extras ? dim(extras) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function cmdEvents(parsed: Parsed): Promise<void> {
  if (parsed.args[0] === "help" || truthy(flag(parsed, "help"))) {
    console.log(EVENTS_USAGE);
    return;
  }
  const json = truthy(flag(parsed, "json"));
  const pretty = !json && isPretty();
  const follow = followFlag(parsed);
  const limit = logLinesFlag(parsed, 50);
  const filter = eventsFilterFromFlags(parsed, Date.now());

  // The backlog read reports how far into the live file it got; the follow
  // resumes from exactly there — no gap, no duplicates (review CR-11b).
  let livePosition: number | undefined;
  const backlog = await collectLedgerEvents({ filter, limit, onLivePosition: (bytes) => (livePosition = bytes) });
  for (const event of backlog) console.log(formatLedgerEvent(event, pretty));

  if (!follow) return;
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await followLedgerEvents({
      filter,
      signal: controller.signal,
      ...(livePosition !== undefined ? { fromPosition: livePosition } : {}),
      onEvent: (event) => console.log(formatLedgerEvent(event, pretty)),
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
