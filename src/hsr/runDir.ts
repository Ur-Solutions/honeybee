/**
 * HSR run-dir paths + persistence (APIA-78).
 *
 * Each HSR bee owns a run dir under `storeRoot()/hsr/<bee>/` holding the durable
 * facts a runner-host produces and any cross-process observer (daemon, `hive
 * bees`, SubstrateHsr) reads back (HSR_EXPLORATION.md §3 crash recovery, §7):
 *
 *   meta.json     — the host/child identity + status record (this file's HsrMeta)
 *   events.jsonl  — append-mostly structured RunnerEvent log (one JSON per line),
 *                   compacted past a byte cap (HIVE-13): the dropped prefix is
 *                   folded into synthetic checkpoint events so cumulative usage
 *                   totals and the latest exhaustion signal survive exactly
 *   ring.txt      — rendered text tail (the assistant-output ring buffer)
 *   control.sock  — the per-bee JSON-RPC control socket (owned by the host)
 *
 * Node builtins only. No spawning, no socket logic here — just paths + IO.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import type { RunnerEvent, RunnerTier } from "./types.js";

/** Root of all HSR run dirs: `~/.hive/hsr`. */
export function hsrRoot(): string {
  return join(storeRoot(), "hsr");
}

/** Per-bee run dir: `~/.hive/hsr/<bee>`. */
export function hsrRunDir(bee: string): string {
  return join(hsrRoot(), bee);
}

/**
 * Root of working-copy checkouts provisioned on this node: `~/.hive/worktrees`.
 * A `remote-hsr` node clones repos here (one dir per named checkout) so a bee can
 * be run inside a fresh checkout on the remote (APIA-95). Groundwork for Apiary's
 * "where-it-lives" selector on non-local substrates (substrates-research §5.3 /
 * architecture §7.5) — the enumeration + provisioning verbs live here; no Apiary
 * work in this repo.
 */
export function worktreesRoot(): string {
  return join(storeRoot(), "worktrees");
}

export function hsrMetaPath(bee: string): string {
  return join(hsrRunDir(bee), "meta.json");
}

export function hsrEventsPath(bee: string): string {
  return join(hsrRunDir(bee), "events.jsonl");
}

export function hsrRingPath(bee: string): string {
  return join(hsrRunDir(bee), "ring.txt");
}

/**
 * Short, stable directory for per-bee control sockets. The control socket does
 * NOT live under the run dir because an AF_UNIX path is capped at ~104 bytes on
 * macOS (~108 on Linux) — a relocated HIVE_STORE_ROOT or a long bee name would
 * push `<runDir>/control.sock` past `bind()`'s limit (EINVAL). A short base
 * keyed by the OS temp root keeps the full path well under the cap.
 */
export function hsrSocketDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  // Prefer a very short /tmp base; fall back to the OS temp dir if unusual.
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(base, `hive-hsr-${uid}`);
}

/**
 * Per-bee JSON-RPC control socket path. Kept SHORT (a hash of the run dir under
 * hsrSocketDir()) so it never exceeds the AF_UNIX sun_path limit; the real path
 * is recorded in meta.controlSocket for observers to read back.
 */
export function hsrControlSocketPath(bee: string): string {
  const key = createHash("sha1").update(hsrRunDir(bee)).digest("hex").slice(0, 16);
  const safeBee = bee.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return join(hsrSocketDir(), `${safeBee}-${key}.sock`);
}

/**
 * The durable identity + status record for a runner-host. `hostPid` is the
 * authoritative liveness signal (the host owns the harness pipes; a dead host
 * means the live protocol stream is unrecoverable — see observe.ts).
 */
export type HsrMeta = {
  bee: string;
  harness: string;
  tier: RunnerTier;
  sessionId?: string;
  hostPid: number;
  childPid?: number;
  childPgid?: number;
  startedAt: string; // ISO
  controlSocket: string;
  status: "running" | "exited";
  exitCode?: number | null;
  endedAt?: string; // ISO
  /**
   * Remote-event-mirror marker (APIA-94): when set, this run dir is a LOCAL
   * MIRROR of a bee hosted on the named remote-hsr node — the daemon's
   * remoteEventMirror subscribes to that node's serve and replays every event
   * here so deriveState/usage/capture work for remote bees like local ones.
   *
   * A mirror has NO local host: `hostPid` is a sentinel (0), so its liveness is
   * NOT the local-pid probe. Instead the mirror owns `status` — it flips to
   * "exited" when the bee leaves the remote node's live list. Observers treat a
   * mirror meta as live iff `status === "running"` (see observe.ts isMetaLive).
   */
  mirrorOfNode?: string;
};

/** mkdir -p the run dir (owner-only). */
export async function ensureHsrRunDir(bee: string): Promise<void> {
  await mkdir(hsrRunDir(bee), { recursive: true, mode: 0o700 });
}

/** Atomically write meta.json (owner-only, pretty-printed for eyeballing). */
export async function writeHsrMeta(bee: string, meta: HsrMeta): Promise<void> {
  await atomicWriteFile(hsrMetaPath(bee), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Read meta.json. Tolerant: missing file or garbage JSON (a half-written record,
 * a truncated crash) resolves to null rather than throwing — observers reconcile
 * from live pids, they don't trust a corrupt record.
 */
export async function readHsrMeta(bee: string): Promise<HsrMeta | null> {
  let raw: string;
  try {
    raw = await readFile(hsrMetaPath(bee), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    // Require the load-bearing identity fields; everything else is optional.
    if (typeof object.bee !== "string" || typeof object.hostPid !== "number") return null;
    if (object.status !== "running" && object.status !== "exited") return null;
    return object as unknown as HsrMeta;
  } catch {
    return null;
  }
}

// Per-bee append serialization. The runner fires appendHsrEvent concurrently
// (one per produced event, not awaited); on POSIX O_APPEND keeps each write
// atomic, but a burst of same-turn events would race the libuv threadpool and
// could land out of order. Chain appends per bee so events.jsonl preserves
// production order — observers tail it for state / needs-input / crash recovery.
const appendChains = new Map<string, Promise<void>>();

// Per-bee events.jsonl byte size, tracked by the single writer so the growth
// check is O(1) per append (lazily seeded by one stat, then incremented).
const eventLogSizes = new Map<string, number>();

// events.jsonl growth bounds (HIVE-13). The log is the daemon's per-tick read
// for state + usage, so it must stay small: once it crosses MAX_BYTES the
// writer compacts it down to a tail of at most COMPACT_KEEP_LINES lines /
// COMPACT_TARGET_BYTES bytes, folding the dropped prefix into checkpoint
// events (see compactHsrEvents). KEEP_LINES stays comfortably above the
// observers' 200-line tail window (observe.ts EVENT_TAIL_LINES).
export const HSR_EVENTS_MAX_BYTES = 1024 * 1024;
export const HSR_EVENTS_COMPACT_KEEP_LINES = 400;
export const HSR_EVENTS_COMPACT_TARGET_BYTES = 512 * 1024;

export type HsrEventsCompactLimits = { keepLines: number; targetBytes: number };

/**
 * Compact a bee's events.jsonl: keep the trailing `keepLines` lines (fewer if
 * they exceed `targetBytes`; always at least the last line) and fold the
 * dropped prefix into synthetic checkpoint events prepended to the new file:
 *
 *   - one `usage` event summing every dropped usage event's token counts, so
 *     hsrUsageObservation's cumulative sum is unchanged by compaction;
 *   - the latest dropped `exhausted` event, so the usage sampler's
 *     latest-by-ts exhaustion edge survives even when it fell in the prefix.
 *
 * Checkpoint types carry no turn markers, so the structured-state derivation
 * over the kept tail is unaffected. Single-writer only (the host / mirror that
 * owns the run dir) — called from the per-bee append chain; the atomic replace
 * means concurrent READERS see either the old or the new file, never a tear.
 */
export async function compactHsrEvents(
  bee: string,
  limits: HsrEventsCompactLimits = { keepLines: HSR_EVENTS_COMPACT_KEEP_LINES, targetBytes: HSR_EVENTS_COMPACT_TARGET_BYTES },
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(hsrEventsPath(bee), "utf8");
  } catch {
    return; // nothing to compact
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  // Walk back from the end, keeping lines until either bound trips (always
  // keep at least the final line so the newest event is never dropped).
  let keepStart = lines.length;
  let keptBytes = 0;
  while (keepStart > 0 && lines.length - keepStart < limits.keepLines) {
    const lineBytes = Buffer.byteLength(lines[keepStart - 1]!, "utf8") + 1;
    if (keptBytes + lineBytes > limits.targetBytes && keepStart < lines.length) break;
    keptBytes += lineBytes;
    keepStart -= 1;
  }
  if (keepStart === 0) return; // already within bounds — nothing to drop
  // Fold the dropped prefix: sum usage tokens, remember the newest exhausted.
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let sawUsage = false;
  let usageTs = 0;
  let latestExhausted: { ts: number; resetHint?: string } | undefined;
  for (let i = 0; i < keepStart; i++) {
    let event: RunnerEvent;
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") continue;
      event = parsed as RunnerEvent;
    } catch {
      continue; // torn / partial line — drop it
    }
    if (event.type === "usage") {
      sawUsage = true;
      if (typeof event.inputTokens === "number" && Number.isFinite(event.inputTokens)) inputTokens += event.inputTokens;
      if (typeof event.outputTokens === "number" && Number.isFinite(event.outputTokens)) outputTokens += event.outputTokens;
      if (typeof event.totalTokens === "number" && Number.isFinite(event.totalTokens)) totalTokens += event.totalTokens;
      if (typeof event.ts === "number" && Number.isFinite(event.ts) && event.ts > usageTs) usageTs = event.ts;
    } else if (event.type === "exhausted") {
      const ts = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : 0;
      if (!latestExhausted || ts >= latestExhausted.ts) {
        latestExhausted = { ts, ...(event.resetHint ? { resetHint: event.resetHint } : {}) };
      }
    }
  }
  const checkpoint: string[] = [];
  if (sawUsage) {
    checkpoint.push(JSON.stringify({ type: "usage", ts: usageTs, inputTokens, outputTokens, totalTokens } satisfies RunnerEvent));
  }
  if (latestExhausted) {
    checkpoint.push(JSON.stringify({ type: "exhausted", ...latestExhausted } satisfies RunnerEvent));
  }
  const content = `${[...checkpoint, ...lines.slice(keepStart)].join("\n")}\n`;
  await atomicWriteFile(hsrEventsPath(bee), content, { mode: 0o600 });
  eventLogSizes.set(bee, Buffer.byteLength(content, "utf8"));
}

/**
 * Append one structured event to events.jsonl (owner-only, one JSON per line).
 * Once the log crosses HSR_EVENTS_MAX_BYTES it is compacted in-chain (see
 * compactHsrEvents), so the file every observer re-reads per tick stays bounded.
 */
export function appendHsrEvent(bee: string, event: RunnerEvent): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await appendFile(hsrEventsPath(bee), line, { mode: 0o600 });
      let size = eventLogSizes.get(bee);
      if (size === undefined) {
        try {
          size = (await stat(hsrEventsPath(bee))).size;
        } catch {
          size = Buffer.byteLength(line, "utf8");
        }
      } else {
        size += Buffer.byteLength(line, "utf8");
      }
      eventLogSizes.set(bee, size);
      if (size > HSR_EVENTS_MAX_BYTES) {
        await compactHsrEvents(bee).catch(() => undefined);
      }
    });
  appendChains.set(bee, next);
  return next;
}

/** Atomically replace the ring buffer text tail. */
export async function writeHsrRing(bee: string, text: string): Promise<void> {
  await atomicWriteFile(hsrRingPath(bee), text, { mode: 0o600 });
}

// Ring buffer caps — whichever hits first bounds the rendered text tail. Shared
// by the local stream runner (streamRunner.ts) and the remote event mirror
// (remoteEventMirror.ts) so both bound ring.txt identically.
export const HSR_RING_MAX_LINES = 200;
export const HSR_RING_MAX_BYTES = 16 * 1024;

/**
 * Append `text` to a ring buffer and bound it: cap by line count first, then by
 * byte size (dropping whole leading lines). Pure — returns the new ring text.
 */
export function appendRingText(ring: string, text: string): string {
  let out = ring + (text.endsWith("\n") ? text : `${text}\n`);
  const lines = out.split("\n");
  if (lines.length > HSR_RING_MAX_LINES + 1) {
    out = lines.slice(lines.length - (HSR_RING_MAX_LINES + 1)).join("\n");
  }
  while (Buffer.byteLength(out, "utf8") > HSR_RING_MAX_BYTES) {
    const nl = out.indexOf("\n");
    if (nl === -1) {
      out = out.slice(out.length - HSR_RING_MAX_BYTES);
      break;
    }
    out = out.slice(nl + 1);
  }
  return out;
}
