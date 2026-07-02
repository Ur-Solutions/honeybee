/**
 * HSR run-dir paths + persistence (APIA-78).
 *
 * Each HSR bee owns a run dir under `storeRoot()/hsr/<bee>/` holding the durable
 * facts a runner-host produces and any cross-process observer (daemon, `hive
 * bees`, SubstrateHsr) reads back (HSR_EXPLORATION.md §3 crash recovery, §7):
 *
 *   meta.json     — the host/child identity + status record (this file's HsrMeta)
 *   events.jsonl  — append-only structured RunnerEvent log (one JSON per line)
 *   ring.txt      — rendered text tail (the assistant-output ring buffer)
 *   control.sock  — the per-bee JSON-RPC control socket (owned by the host)
 *
 * Node builtins only. No spawning, no socket logic here — just paths + IO.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
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

/** Append one structured event to events.jsonl (owner-only, one JSON per line). */
export function appendHsrEvent(bee: string, event: RunnerEvent): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => appendFile(hsrEventsPath(bee), line, { mode: 0o600 }));
  appendChains.set(bee, next);
  return next;
}

/** Atomically replace the ring buffer text tail. */
export async function writeHsrRing(bee: string, text: string): Promise<void> {
  await atomicWriteFile(hsrRingPath(bee), text, { mode: 0o600 });
}
