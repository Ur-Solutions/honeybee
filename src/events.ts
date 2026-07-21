// `hive events` core: a file-backed tail over the store ledger (CL.701 §4.3).
// The ledger is the daemon's event substrate — seals, state transitions,
// flight/slot events, node edges — and this module gives every observer
// (orchestrators, Pollinate scouts, Flightboard, humans) a subscription
// surface WITHOUT a daemon dependency for reads: everything here works off
// the ledger files on disk, even while the daemon is down or breached.
import { createReadStream, type ReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ledgerPath } from "./store.js";

export type LedgerEvent = Record<string, unknown> & { ts?: string; type?: string };

export type LedgerEventFilter = {
  /** Glob patterns matched against `type` (`*` and `?`); empty/absent = all. */
  types?: string[];
  /** Only events with ts >= since (epoch ms). */
  sinceMs?: number;
  /** Only events whose session/name field matches one of these bee names. */
  sessions?: string[];
};

/** Rotation suffix scheme from store.ts pruneLedgerRotations. */
const LEDGER_ROTATION_SUFFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function parseLedgerEvent(line: string): LedgerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as LedgerEvent;
  } catch {
    return null;
  }
}

/**
 * `--since` accepts an ISO timestamp or a relative duration like `30s`, `15m`,
 * `2h`, `1d`. Returns epoch ms; throws on unparseable input so a typo never
 * silently means "everything".
 */
export function parseSince(raw: string, nowMs: number): number {
  const relative = /^(\d+(?:\.\d+)?)([smhd])$/.exec(raw.trim());
  if (relative) {
    const value = Number(relative[1]);
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
    return nowMs - value * unitMs;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--since expects an ISO timestamp or a duration like 30s/15m/2h/1d (got: ${raw})`);
  }
  return parsed;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function matchesEventFilter(event: LedgerEvent, filter: LedgerEventFilter): boolean {
  if (filter.types && filter.types.length > 0) {
    const type = typeof event.type === "string" ? event.type : "";
    if (!filter.types.some((glob) => globToRegExp(glob).test(type))) return false;
  }
  if (filter.sessions && filter.sessions.length > 0) {
    // Flight slot events carry the bee under `bee` (and the flight under
    // `flight`) rather than `session` — match those keys too, so
    // `--session <bee>` works across the whole vocabulary (review CR-11a).
    const candidates = [event.session, event.name, event.bee, event.flight].filter(
      (value): value is string => typeof value === "string",
    );
    if (!candidates.some((value) => filter.sessions!.includes(value))) return false;
  }
  if (filter.sinceMs !== undefined) {
    const ts = typeof event.ts === "string" ? Date.parse(event.ts) : Number.NaN;
    if (!Number.isFinite(ts) || ts < filter.sinceMs) return false;
  }
  return true;
}

/**
 * The ledger files that can contain events for this query, oldest first. A
 * `--since` query reaches back into rotated ledgers (`ledger.jsonl.<stamp>`);
 * without `since`, only the live file is read — the common "what just
 * happened" case never pays for history.
 */
export async function ledgerFilesFor(filter: LedgerEventFilter, path: string = ledgerPath()): Promise<string[]> {
  if (filter.sinceMs === undefined) return [path];
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  const rotations = entries
    .filter((entry) => entry.startsWith(prefix) && LEDGER_ROTATION_SUFFIX_RE.test(entry.slice(prefix.length)))
    .sort()
    .map((entry) => join(dir, entry));
  // A rotation's suffix stamps when it was rotated OUT — every event in it is
  // older than that. Skip rotations that ended before `since`.
  const relevant = rotations.filter((file) => {
    const stamp = basename(file).slice(prefix.length).replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z");
    const rotatedAt = Date.parse(stamp);
    return !Number.isFinite(rotatedAt) || rotatedAt >= filter.sinceMs!;
  });
  return [...relevant, path];
}

/**
 * Collect matching events (source order). `limit` keeps the newest N matches;
 * 0/undefined = no cap.
 */
export async function collectLedgerEvents(options: {
  filter?: LedgerEventFilter;
  limit?: number;
  path?: string;
  /**
   * Receives the byte length of the LIVE ledger file as read by this
   * collection. `hive events -f` hands it to followLedgerEvents as
   * `fromPosition`, closing the backlog→follow gap: an event appended between
   * the backlog read and the follow's first stat is neither dropped nor
   * duplicated (review CR-11b).
   */
  onLivePosition?: (bytes: number) => void;
} = {}): Promise<LedgerEvent[]> {
  const filter = options.filter ?? {};
  const path = options.path ?? ledgerPath();
  const events: LedgerEvent[] = [];
  for (const file of await ledgerFilesFor(filter, path)) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (file === path) options.onLivePosition?.(Buffer.byteLength(raw));
    if (!raw) continue;
    for (const line of raw.split("\n")) {
      const event = parseLedgerEvent(line);
      if (event && matchesEventFilter(event, filter)) events.push(event);
    }
  }
  if (options.limit && options.limit > 0 && events.length > options.limit) {
    return events.slice(-options.limit);
  }
  return events;
}

export type FollowOptions = {
  filter?: LedgerEventFilter;
  path?: string;
  onEvent: (event: LedgerEvent) => void;
  signal?: AbortSignal;
  /** Poll cadence; a file-position poll tolerates rotation, unlike fs.watch. */
  pollMs?: number;
  /**
   * Start following from this byte offset instead of the file's current end —
   * pass collectLedgerEvents' onLivePosition value to make backlog+follow
   * seamless (no gap, no duplicates).
   */
  fromPosition?: number;
  /** Testing seam. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Follow the live ledger from its current end (or `fromPosition`), invoking
 * onEvent for each new matching line until aborted. Rotation-safe: a shrink
 * OR an inode change (a fresh file that already grew past our offset within
 * one poll — review CR-11c) restarts reading from the fresh file's start.
 */
export async function followLedgerEvents(options: FollowOptions): Promise<void> {
  const path = options.path ?? ledgerPath();
  const filter = options.filter ?? {};
  const pollMs = options.pollMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const initial = await stat(path).catch(() => null);
  let position = options.fromPosition ?? initial?.size ?? 0;
  let inode = initial?.ino;
  let partial = "";
  const aborted = () => options.signal?.aborted === true;
  while (!aborted()) {
    const info = await stat(path).catch(() => null);
    if (info && (info.size < position || (inode !== undefined && info.ino !== inode))) {
      position = 0; // rotated/truncated/replaced
      partial = "";
    }
    if (info) inode = info.ino;
    if (info && info.size > position) {
      const stream: ReadStream = createReadStream(path, { start: position, end: info.size - 1 });
      for await (const chunk of stream) {
        partial += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseLedgerEvent(line);
          if (event && matchesEventFilter(event, filter)) options.onEvent(event);
        }
      }
      position = info.size;
    }
    if (aborted()) break;
    await sleep(pollMs);
  }
}
