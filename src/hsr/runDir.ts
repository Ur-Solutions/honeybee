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
 *   seq.json      — durable per-bee event-sequence state (lastSeq issued +
 *                   the consumer ack watermark) for the cell transport's
 *                   seq-cursor resume protocol (see appendHsrEvent)
 *   control.sock  — the per-bee JSON-RPC control socket (owned by the host)
 *
 * Node builtins only. No spawning, no socket logic here — just paths + IO.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import type { RunnerEvent, RunnerTier } from "./types.js";
import type { ProcessBirthFingerprint } from "./processIdentity.js";

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

export function hsrSeqPath(bee: string): string {
  return join(hsrRunDir(bee), "seq.json");
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
  /** OS birth identity required before signalling a meta-derived host PID. */
  hostFingerprint?: ProcessBirthFingerprint;
  childPid?: number;
  childPgid?: number;
  /** OS birth identity of childPid; also binds the detached child PGID. */
  childFingerprint?: ProcessBirthFingerprint;
  /** Durable outcome of the adapter's child-spawn admission. */
  childAdmission?: "pending" | "none" | "admitted";
  /**
   * Secret-scrubbed reason an adapter failed before reaching runnable state.
   * The detached parent cannot safely recover this from host.log, whose raw
   * provider diagnostics may contain credentials or payload-derived paths.
   */
  startupFailure?: HsrStartupFailure;
  startedAt: string; // ISO — detached host startup (includes any queued/starting wait)
  /** Set when this host entered the bounded Codex cold-start queue. */
  queuedAt?: string;
  /** Refines queued without breaking older daemon/CLI readers. */
  startupPhase?: "admission" | "harness";
  /** Set once the harness session and control socket are ready for direct turns. */
  runningAt?: string;
  /**
   * Secret-free monotonic durations measured by this runtime incarnation.
   * Values are elapsed milliseconds, never wall-clock subtraction, so clock
   * adjustments cannot make phase evidence regress.
   */
  phaseTimingsMs?: {
    startupSlotWait?: number;
    startupSlotHeld?: number;
    homeLockWait?: number;
    homeLockHeld?: number;
    maintenanceProbe?: number;
    adapterReadiness?: number;
    ready?: number;
    firstTurn?: number;
    firstToken?: number;
  };
  controlSocket: string;
  status: "queued" | "running" | "exited";
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

export type HsrStartupFailure = {
  stage: "adapter-start";
  message: string;
  code?: string;
};

function validHsrStartupFailure(value: unknown): value is HsrStartupFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  return failure.stage === "adapter-start" &&
    typeof failure.message === "string" && failure.message.length > 0 &&
    (failure.code === undefined || typeof failure.code === "string");
}

/** mkdir -p the run dir (owner-only). */
export async function ensureHsrRunDir(bee: string): Promise<void> {
  await mkdir(hsrRunDir(bee), { recursive: true, mode: 0o700 });
}

/**
 * The spawn parameters a runner-host needs to RESTART a bee's runner faithfully
 * with resume (UNIT 2 token refresh). Written on the remote at spawn so a later
 * `refreshCreds` RPC can stop → re-deliver a fresh credential → restart the same
 * runner, without the daemon having to re-ship the resolved spec. Holds NO
 * delivered credential bytes — creds are delivered/shredded separately; the
 * refresh path writes the fresh ones and the restart re-overlays process.env.
 */
export type HsrRestartDescriptor = {
  kind: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  home?: string;
  model?: string;
  authKind?: "subscription" | "api-key";
  comb?: string;
  parent?: string;
};

function hsrRestartPath(bee: string): string {
  return join(hsrRunDir(bee), "restart.json");
}

/** Persist the restart descriptor (owner-only). Best-effort caller. */
export async function writeHsrRestart(bee: string, descriptor: HsrRestartDescriptor): Promise<void> {
  await atomicWriteFile(hsrRestartPath(bee), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
}

/** Read the restart descriptor back; null when missing/garbage (tolerant like readHsrMeta). */
export async function readHsrRestart(bee: string): Promise<HsrRestartDescriptor | null> {
  let raw: string;
  try {
    raw = await readFile(hsrRestartPath(bee), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    if (typeof object.kind !== "string") return null;
    return object as unknown as HsrRestartDescriptor;
  } catch {
    return null;
  }
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
    if (object.status !== "queued" && object.status !== "running" && object.status !== "exited") return null;
    const validFingerprint = (value: unknown): value is ProcessBirthFingerprint => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const fingerprint = value as Record<string, unknown>;
      return Number.isSafeInteger(fingerprint.pgid) && Number(fingerprint.pgid) > 0 &&
        typeof fingerprint.startedAt === "string" && fingerprint.startedAt.length > 0;
    };
    if (object.hostFingerprint !== undefined && !validFingerprint(object.hostFingerprint)) return null;
    if (object.childFingerprint !== undefined && !validFingerprint(object.childFingerprint)) return null;
    for (const key of ["childPid", "childPgid"] as const) {
      if (object[key] !== undefined && (!Number.isSafeInteger(object[key]) || Number(object[key]) <= 0)) return null;
    }
    const hasChildPid = object.childPid !== undefined;
    const hasChildPgid = object.childPgid !== undefined;
    if (hasChildPid !== hasChildPgid || (hasChildPid && object.childPid !== object.childPgid)) return null;
    if (object.childFingerprint !== undefined && !hasChildPid) return null;
    if (object.childFingerprint !== undefined && object.childFingerprint.pgid !== object.childPgid) return null;
    if (
      object.childAdmission !== undefined &&
      object.childAdmission !== "pending" &&
      object.childAdmission !== "none" &&
      object.childAdmission !== "admitted"
    ) return null;
    if (object.startupFailure !== undefined && !validHsrStartupFailure(object.startupFailure)) return null;
    const hasChildIdentity = hasChildPid || object.childFingerprint !== undefined;
    if (object.childAdmission === "admitted" && (!hasChildPid || !validFingerprint(object.childFingerprint))) return null;
    if ((object.childAdmission === "pending" || object.childAdmission === "none") && hasChildIdentity) return null;
    return object as unknown as HsrMeta;
  } catch {
    return null;
  }
}

/**
 * Fail-closed metadata read for runtime-safety decisions. Missing meta is an
 * observed absence; unreadable or malformed existing state is uncertainty and
 * rejects instead of being converted to a dead HSR runtime.
 */
export async function readHsrMetaStrict(bee: string): Promise<HsrMeta | null> {
  let raw: string;
  try {
    raw = await readFile(hsrMetaPath(bee), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Unable to read HSR metadata for ${bee}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in HSR metadata for ${bee}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid HSR metadata shape for ${bee}`);
  const object = parsed as Record<string, unknown>;
  if (object.bee !== bee) throw new Error(`Invalid HSR metadata for ${bee}: stored bee identity does not match`);
  if (!Number.isSafeInteger(object.hostPid) || (object.hostPid as number) < 0) {
    throw new Error(`Invalid HSR metadata for ${bee}: hostPid must be a non-negative safe integer`);
  }
  if (!object.mirrorOfNode && (object.hostPid as number) < 1) {
    throw new Error(`Invalid HSR metadata for ${bee}: local hostPid must be positive`);
  }
  if (object.status !== "queued" && object.status !== "running" && object.status !== "exited") {
    throw new Error(`Invalid HSR metadata for ${bee}: unknown status`);
  }
  const validFingerprint = (value: unknown): value is ProcessBirthFingerprint => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const fingerprint = value as Record<string, unknown>;
    return Number.isSafeInteger(fingerprint.pgid) && Number(fingerprint.pgid) > 0 &&
      typeof fingerprint.startedAt === "string" && fingerprint.startedAt.length > 0;
  };
  if (object.hostFingerprint !== undefined && !validFingerprint(object.hostFingerprint)) {
    throw new Error(`Invalid HSR metadata for ${bee}: malformed host fingerprint`);
  }
  if (object.childFingerprint !== undefined && !validFingerprint(object.childFingerprint)) {
    throw new Error(`Invalid HSR metadata for ${bee}: malformed child fingerprint`);
  }
  for (const key of ["childPid", "childPgid"] as const) {
    if (object[key] !== undefined && (!Number.isSafeInteger(object[key]) || Number(object[key]) <= 0)) {
      throw new Error(`Invalid HSR metadata for ${bee}: ${key} must be a positive safe integer when present`);
    }
  }
  const hasChildPid = object.childPid !== undefined;
  const hasChildPgid = object.childPgid !== undefined;
  if (hasChildPid !== hasChildPgid) {
    throw new Error(`Invalid HSR metadata for ${bee}: childPid and childPgid must be stored together`);
  }
  if (hasChildPid && object.childPid !== object.childPgid) {
    throw new Error(`Invalid HSR metadata for ${bee}: detached childPid and childPgid must match`);
  }
  if (object.childFingerprint !== undefined && !hasChildPid) {
    throw new Error(`Invalid HSR metadata for ${bee}: child fingerprint has no child process group`);
  }
  if (
    object.childFingerprint !== undefined &&
    (object.childFingerprint as ProcessBirthFingerprint).pgid !== object.childPgid
  ) {
    throw new Error(`Invalid HSR metadata for ${bee}: child fingerprint does not match childPgid`);
  }
  if (
    object.childAdmission !== undefined &&
    object.childAdmission !== "pending" &&
    object.childAdmission !== "none" &&
    object.childAdmission !== "admitted"
  ) {
    throw new Error(`Invalid HSR metadata for ${bee}: unknown child admission state`);
  }
  const hasChildIdentity = hasChildPid || object.childFingerprint !== undefined;
  if (object.childAdmission === "admitted" && (!hasChildPid || !validFingerprint(object.childFingerprint))) {
    throw new Error(`Invalid HSR metadata for ${bee}: admitted child birth identity is incomplete`);
  }
  if ((object.childAdmission === "pending" || object.childAdmission === "none") && hasChildIdentity) {
    throw new Error(`Invalid HSR metadata for ${bee}: ${object.childAdmission} admission cannot carry child identity`);
  }
  if (object.startupFailure !== undefined && !validHsrStartupFailure(object.startupFailure)) {
    throw new Error(`Invalid HSR metadata for ${bee}: malformed startup failure`);
  }
  return object as unknown as HsrMeta;
}

// Per-bee append serialization. The runner fires appendHsrEvent concurrently
// (one per produced event, not awaited); on POSIX O_APPEND keeps each write
// atomic, but a burst of same-turn events would race the libuv threadpool and
// could land out of order. Chain appends per bee so events.jsonl preserves
// production order — observers tail it for state / needs-input / crash recovery.
const appendChains = new Map<string, Promise<void>>();

/** @internal test helper */
export function __testOnlyHasAppendChain(bee: string): boolean {
  return appendChains.has(bee);
}

/**
 * Durable per-bee event-sequence state (seq.json). `lastSeq` is the highest
 * seq ever issued (the high-water mark a restart resumes above); `ackedSeq` is
 * the consumer high-water mark advanced by ackHsrEvents — compaction may only
 * fold events at or below it. `subscribed` is an explicit consumer-active
 * marker (set by markHsrConsumerSubscribed when the gateway connect transport
 * engages a subscribe/ack path): while set but before any ack it protects
 * EVERY stamped event from folding (an effective ack floor of 0), so a
 * connected-but-un-acked consumer is no longer indistinguishable from true
 * local-only serve mode. A bee with NEITHER field (no consumer ever) keeps
 * today's byte-identical size-first fold.
 *
 * This lives in its OWN sidecar file (like restart.json), NOT in meta.json:
 * meta.json is owned by the host lifecycle, which rewrites its in-memory
 * record whole on status transitions — a per-append read-modify-write of
 * meta.json from the append chain could clobber a concurrent status flip
 * (lost update), and liveness truth must never lose to a counter bump. The
 * sidecar has exactly one writer: the per-bee append chain below.
 */
export type HsrSeqState = { lastSeq: number; ackedSeq?: number; subscribed?: boolean };

// In-memory seq state, one entry per bee, owned by the append chain. Seeded
// once per process from max(seq.json lastSeq, highest stamped seq in
// events.jsonl) so a crash between the event append and the seq.json write —
// or a lost sidecar — can never reissue a seq (the newest stamped event always
// survives compaction, which keeps at least the final line).
const seqStates = new Map<string, HsrSeqState>();

/** @internal test helper: simulate a process restart (drop cached seq state). */
export function __testOnlyResetSeqState(bee?: string): void {
  if (bee === undefined) seqStates.clear();
  else seqStates.delete(bee);
}

/**
 * Drop this process's cached seq/size state for a bee. Called when a run dir is
 * removed (kill) so a later spawn that RECREATES the same bee name in the same
 * process starts from the on-disk truth instead of inheriting a stale
 * lastSeq/ackedSeq/size from the deleted incarnation (the in-process cache is
 * keyed by bee, so same-name reuse would otherwise resurrect a dead cursor).
 */
export function forgetHsrRunState(bee: string): void {
  seqStates.delete(bee);
  eventLogSizes.delete(bee);
}

/** Read seq.json back; null when missing/garbage (tolerant like readHsrMeta). */
export async function readHsrSeqState(bee: string): Promise<HsrSeqState | null> {
  let raw: string;
  try {
    raw = await readFile(hsrSeqPath(bee), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(object.lastSeq) || Number(object.lastSeq) < 0) return null;
    if (object.ackedSeq !== undefined && (!Number.isSafeInteger(object.ackedSeq) || Number(object.ackedSeq) < 0)) return null;
    const lastSeq = object.lastSeq as number;
    // Clamp a corrupt/stale ackedSeq that somehow exceeds the issued high-water:
    // an ack can never legitimately outrun lastSeq, and letting it through would
    // let compaction fold events that were never issued/acked.
    let ackedSeq = object.ackedSeq as number | undefined;
    if (ackedSeq !== undefined && ackedSeq > lastSeq) ackedSeq = lastSeq;
    return {
      lastSeq,
      ...(ackedSeq !== undefined ? { ackedSeq } : {}),
      ...(object.subscribed === true ? { subscribed: true } : {}),
    };
  } catch {
    return null;
  }
}

async function persistSeqState(bee: string, state: HsrSeqState): Promise<void> {
  await atomicWriteFile(hsrSeqPath(bee), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

/** Parse a line's stamped seq; undefined for legacy/checkpoint/torn lines. */
function seqOfLine(line: string): number | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const seq = (parsed as { seq?: unknown }).seq;
    return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
  } catch {
    return undefined; // torn / partial line
  }
}

/**
 * Re-serialize a checkpoint-carried line WITHOUT its seq. A folded event's seq
 * leaves the cursor space (readHsrEventsAfterSeq signals the folded range as a
 * gap); carrying it on a reordered checkpoint marker would instead punch
 * silent holes into the cursor space.
 */
function stripSeqFromLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { seq?: unknown }).seq === undefined) return line;
    const { seq: _seq, ...rest } = parsed as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return line; // torn / partial line — carried as-is
  }
}

/**
 * Make events.jsonl newline-safe before this process's first append. A crash
 * mid-append can leave a torn final record (invalid JSON) OR a complete record
 * that never got its trailing newline; a naive appendFile would then FUSE the
 * next event's JSON onto that line and every reader would skip the whole fused
 * line — a SILENT seq hole. Runs once per bee (from loadSeqState, on the
 * single-writer append chain): a complete-but-unterminated final record is
 * preserved by terminating its line; a torn partial is truncated away so its
 * un-landed seq is reissued into a clean line instead of being swallowed.
 * Returns the repaired content so the caller's max-seq scan sees the truth.
 */
async function repairTornEventLogTail(bee: string, raw: string): Promise<string> {
  const lastNl = raw.lastIndexOf("\n");
  const tail = raw.slice(lastNl + 1);
  let complete = false;
  try {
    const parsed = JSON.parse(tail) as unknown;
    complete = !!parsed && typeof parsed === "object";
  } catch {
    complete = false; // torn partial — unparseable
  }
  const repaired = complete
    ? `${raw}\n` // whole record, just missing its newline: keep it, terminate the line
    : lastNl >= 0
      ? raw.slice(0, lastNl + 1) // drop the torn partial so the next append can't fuse onto it
      : "";
  try {
    await atomicWriteFile(hsrEventsPath(bee), repaired, { mode: 0o600 });
  } catch {
    // Best-effort: if the repair write fails the append below still targets the
    // same file; the scan already reflects `repaired`, so lastSeq is truthful.
  }
  return repaired;
}

/**
 * Load (and cache) a bee's seq state. Called only from the per-bee append
 * chain, so the seed read never races a stamped append. Legacy events.jsonl
 * files (pre-seq) scan to 0, so a fresh upgrade starts issuing at 1 with the
 * legacy events left as a seq-less prefix — readers tolerate both shapes.
 */
async function loadSeqState(bee: string): Promise<HsrSeqState> {
  const cached = seqStates.get(bee);
  if (cached) return cached;
  const persisted = await readHsrSeqState(bee);
  let maxInLog = 0;
  let raw: string | undefined;
  try {
    raw = await readFile(hsrEventsPath(bee), "utf8");
  } catch {
    raw = undefined; // no events yet — fresh dir
  }
  // Newline-safe the tail exactly once per bee before any append lands on it.
  if (raw !== undefined && raw.length > 0 && !raw.endsWith("\n")) {
    raw = await repairTornEventLogTail(bee, raw);
  }
  if (raw !== undefined) {
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      const seq = seqOfLine(line);
      if (seq !== undefined && seq > maxInLog) maxInLog = seq;
    }
  }
  const state: HsrSeqState = {
    lastSeq: Math.max(persisted?.lastSeq ?? 0, maxInLog),
    ...(persisted?.ackedSeq !== undefined ? { ackedSeq: persisted.ackedSeq } : {}),
    ...(persisted?.subscribed ? { subscribed: true } : {}),
  };
  seqStates.set(bee, state);
  return state;
}

// Per-bee events.jsonl byte size, tracked by the single writer so the growth
// check is O(1) per append (lazily seeded by one stat, then incremented).
const eventLogSizes = new Map<string, number>();

// events.jsonl growth bounds (HIVE-13). The log is the daemon's per-tick read
// for state + usage, so it must stay small: once it crosses MAX_BYTES the
// writer compacts it down to a tail of at most COMPACT_KEEP_LINES lines /
// COMPACT_TARGET_BYTES bytes, folding the dropped prefix into checkpoint
// events (see compactHsrEvents). Observers read the whole bounded log
// (observe.ts EVENT_TAIL_MAX_BYTES covers MAX_BYTES), so the derived
// structured state survives any turn length (HIVE-55).
export const HSR_EVENTS_MAX_BYTES = 1024 * 1024;
export const HSR_EVENTS_COMPACT_KEEP_LINES = 400;
export const HSR_EVENTS_COMPACT_TARGET_BYTES = 512 * 1024;

export type HsrEventsCompactLimits = { keepLines: number; targetBytes: number };

function lifecycleScopeKey(event: Extract<RunnerEvent, { type: "turn_start" | "turn_end" }>): string {
  return typeof event.threadId === "string" && event.threadId.length > 0 ? event.threadId : "";
}

/**
 * Compact a bee's events.jsonl: keep the trailing `keepLines` lines (fewer if
 * they exceed `targetBytes`; always at least the last line) and fold the
 * dropped prefix into synthetic checkpoint events prepended to the new file:
 *
 *   - one `usage` event summing every dropped usage event's token counts, so
 *     hsrUsageObservation's cumulative sum is unchanged by compaction;
 *   - the latest dropped `exhausted` event, so the usage sampler's
 *     latest-by-ts exhaustion edge survives even when it fell in the prefix;
 *   - the LAST dropped turn_start / turn_end line PER thread id, plus the last
 *     needs_input, verbatim and in their original relative order (HIVE-55).
 *     The structured-state derivation and pendingNeedsInput only depend on the
 *     relative order of the last marker for the relevant root thread, so
 *     preserving scoped lifecycle markers makes the derived state invariant
 *     under compaction — a root turn whose start scrolled into the dropped
 *     prefix still observes as "active" even if nested-thread markers arrived
 *     later, and an unresolved needs_input keeps its full payload for `hive
 *     answer`;
 *   - a minimal `text` stub when the prefix held assistant text but no turn
 *     markers at all, so a marker-less session keeps observing "ready"
 *     rather than regressing to "booting".
 *
 * Ack-aware (cell transport): when a consumer watermark exists (seq.json
 * ackedSeq), only events with `seq <= ackedSeq` may be folded — the byte cap
 * yields to ack correctness, so a sleeping consumer's un-acked events survive
 * verbatim for an exact seq-cursor resume. Absent a watermark (no consumer
 * ever acked), behavior is exactly today's size-first fold. Checkpoint lines
 * are seq-LESS (re-carried markers are stripped of their seq): the folded seq
 * range leaves the cursor space entirely, so readHsrEventsAfterSeq reports it
 * as an explicit gap instead of a silent hole.
 *
 * Single-writer only (the host / mirror that
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
  // Ack-aware floor: never fold an event above the effective consumer
  // watermark. Only shrinks the dropped prefix (keeps more), so the byte/line
  // bounds above remain the ceiling for what IS dropped.
  //   - an explicit ackedSeq → fold only events at or below it;
  //   - a subscribed-but-un-acked consumer → floor of 0, so EVERY stamped
  //     event survives (a connected/sleeping consumer that hasn't acked its
  //     first event is protected, not folded like local-only serve mode);
  //   - neither (no consumer ever) → undefined, today's byte-identical fold.
  const seqState = seqStates.get(bee) ?? (await readHsrSeqState(bee)) ?? undefined;
  let watermark: number | undefined;
  if (seqState) {
    if (seqState.ackedSeq !== undefined) watermark = seqState.ackedSeq;
    else if (seqState.subscribed) watermark = 0;
  }
  if (watermark !== undefined) {
    for (let i = 0; i < keepStart; i++) {
      const seq = seqOfLine(lines[i]!);
      if (seq !== undefined && seq > watermark) {
        keepStart = i;
        break;
      }
    }
  }
  if (keepStart === 0) return; // already within bounds — nothing to drop
  // Fold the dropped prefix: sum usage tokens, remember the newest exhausted,
  // and keep the last turn/needs markers so the derived state survives.
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let cost = 0;
  let sawCacheReadTokens = false;
  let sawCacheWriteTokens = false;
  let sawReasoningTokens = false;
  let sawCost = false;
  let sawUsage = false;
  let usageTs = 0;
  let latestExhausted: { ts: number; resetHint?: string } | undefined;
  let lastTurnStarts = new Map<string, { index: number; line: string }>();
  let lastTurnEnds = new Map<string, { index: number; line: string }>();
  let lastNeedsInput: { index: number; line: string } | undefined;
  let lastTextTs: number | undefined;
  for (let i = 0; i < keepStart; i++) {
    let event: RunnerEvent;
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") continue;
      event = parsed as RunnerEvent;
    } catch {
      continue; // torn / partial line — drop it
    }
    if (event.type === "turn_start") {
      lastTurnStarts.set(lifecycleScopeKey(event), { index: i, line: lines[i]! });
    } else if (event.type === "turn_end") {
      lastTurnEnds.set(lifecycleScopeKey(event), { index: i, line: lines[i]! });
    } else if (event.type === "needs_input") {
      lastNeedsInput = { index: i, line: lines[i]! };
    } else if (event.type === "text") {
      if (event.text.length > 0) lastTextTs = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : 0;
    } else if (event.type === "usage") {
      sawUsage = true;
      if (typeof event.inputTokens === "number" && Number.isFinite(event.inputTokens)) inputTokens += event.inputTokens;
      if (typeof event.outputTokens === "number" && Number.isFinite(event.outputTokens)) outputTokens += event.outputTokens;
      if (typeof event.totalTokens === "number" && Number.isFinite(event.totalTokens)) totalTokens += event.totalTokens;
      if (typeof event.cacheReadTokens === "number" && Number.isFinite(event.cacheReadTokens)) {
        sawCacheReadTokens = true;
        cacheReadTokens += event.cacheReadTokens;
      }
      if (typeof event.cacheWriteTokens === "number" && Number.isFinite(event.cacheWriteTokens)) {
        sawCacheWriteTokens = true;
        cacheWriteTokens += event.cacheWriteTokens;
      }
      if (typeof event.reasoningTokens === "number" && Number.isFinite(event.reasoningTokens)) {
        sawReasoningTokens = true;
        reasoningTokens += event.reasoningTokens;
      }
      if (typeof event.cost === "number" && Number.isFinite(event.cost)) {
        sawCost = true;
        cost += event.cost;
      }
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
    checkpoint.push(JSON.stringify({
      type: "usage",
      ts: usageTs,
      inputTokens,
      outputTokens,
      totalTokens,
      ...(sawCacheReadTokens ? { cacheReadTokens } : {}),
      ...(sawCacheWriteTokens ? { cacheWriteTokens } : {}),
      ...(sawReasoningTokens ? { reasoningTokens } : {}),
      ...(sawCost ? { cost } : {}),
    } satisfies RunnerEvent));
  }
  if (latestExhausted) {
    checkpoint.push(JSON.stringify({ type: "exhausted", ...latestExhausted } satisfies RunnerEvent));
  }
  // Turn/needs markers in original relative order — observers derive state
  // from the LAST marker per root thread, so this keeps the derivation exact
  // even when Codex collaboration sub-threads emit their own lifecycle markers.
  const markers = [...lastTurnStarts.values(), ...lastTurnEnds.values(), lastNeedsInput].filter(
    (marker): marker is { index: number; line: string } => marker !== undefined,
  );
  markers.sort((a, b) => a.index - b.index);
  if (markers.length > 0) {
    checkpoint.push(...markers.map((marker) => stripSeqFromLine(marker.line)));
  } else if (lastTextTs !== undefined) {
    // Marker-less prefix with assistant text: keep "ready" observable via a
    // minimal stub instead of re-carrying a possibly huge text line.
    checkpoint.push(JSON.stringify({ type: "text", ts: lastTextTs, text: "…" } satisfies RunnerEvent));
  }
  const content = `${[...checkpoint, ...lines.slice(keepStart)].join("\n")}\n`;
  await atomicWriteFile(hsrEventsPath(bee), content, { mode: 0o600 });
  eventLogSizes.set(bee, Buffer.byteLength(content, "utf8"));
}

// Process-local tap over the append chain (cell transport). The per-bee
// control-socket broadcast the serve mode relays carries the RAW runner event
// — the seq is stamped by appendHsrEvent, on a copy, after the broadcast — so
// a live-tail consumer that needs the stamped seq (the gateway `connect`
// transport's subscribe stream) cannot use that relay. This tap fires INSIDE
// the append chain, after the stamped line has landed on disk, with the exact
// event object that was written (seq included): durable replay via
// readHsrEventsAfterSeq and this live feed share one monotonic numbering, so a
// replay→live handoff can merge on seq with no dupes and no holes. In-process
// only by design: a cell's runners are hosted in-process by its controller,
// so every event a cell produces flows through this process's append chain.
const eventTap = new EventEmitter();
eventTap.setMaxListeners(0);

/**
 * Subscribe to every stamped event append in THIS process. The listener runs
 * synchronously on the append chain after the event is durable — keep it
 * cheap and non-throwing (throws are swallowed, never fail the append).
 * Returns an unsubscribe fn.
 */
export function onHsrEventAppended(listener: (bee: string, event: RunnerEvent) => void): () => void {
  eventTap.on("append", listener);
  return () => {
    eventTap.removeListener("append", listener);
  };
}

/**
 * Append one structured event to events.jsonl (owner-only, one JSON per line).
 * Every append is stamped with the bee's next monotonic `seq` (starting at 1;
 * a mirror-replayed event is re-stamped into the LOCAL seq space) and the
 * issued high-water is persisted to seq.json AFTER the event lands, so a crash
 * between the two leaves no seq hole — restart recovery takes
 * max(seq.json, stamped log) and can never reissue. Once the log crosses
 * HSR_EVENTS_MAX_BYTES it is compacted in-chain (see compactHsrEvents), so the
 * file every observer re-reads per tick stays bounded.
 */
export function appendHsrEvent(bee: string, event: RunnerEvent): Promise<void> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const seqState = await loadSeqState(bee);
      // Allocate the next seq as a CANDIDATE, but do not advance the in-memory
      // high-water until the event has durably landed. A rejected append thus
      // leaves lastSeq untouched, so the next append REUSES this candidate (a
      // clean reissue of the un-landed seq) instead of burning it into a silent
      // cursor hole — never expose a seq as issued before its event is durable.
      const candidate = seqState.lastSeq + 1;
      const stamped: RunnerEvent = { ...event, seq: candidate };
      const line = `${JSON.stringify(stamped)}\n`;
      await appendFile(hsrEventsPath(bee), line, { mode: 0o600 });
      seqState.lastSeq = candidate;
      // Best-effort durability: the stamped event itself is the recovery
      // source of truth, so a failed sidecar write must not fail the append.
      await persistSeqState(bee, seqState).catch(() => undefined);
      try {
        eventTap.emit("append", bee, stamped);
      } catch {
        // A tap listener must never fail the append chain.
      }
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
  void next.then(
    () => {
      if (appendChains.get(bee) === next) appendChains.delete(bee);
    },
    () => {
      if (appendChains.get(bee) === next) appendChains.delete(bee);
    },
  );
  return next;
}

/**
 * Advance a bee's consumer ack watermark to `upToSeq` (clamped to the issued
 * high-water, never regressing). Runs on the per-bee append chain — the same
 * serialization domain as the seq stamping and compaction — and persists the
 * watermark to seq.json. Returns the effective watermark. Once set, compaction
 * may only fold events at or below it (see compactHsrEvents).
 */
export function ackHsrEvents(bee: string, upToSeq: number): Promise<number> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(async () => {
      const seqState = await loadSeqState(bee);
      const target = Math.min(Math.max(Math.floor(upToSeq), seqState.ackedSeq ?? 0), seqState.lastSeq);
      // An ack clamped to 0 (nothing issued yet) is a no-op — persisting a
      // 0 watermark would block compaction without protecting any event.
      if (target > (seqState.ackedSeq ?? 0)) {
        // Persist BEFORE advancing the in-memory watermark: compaction reads the
        // cached ackedSeq, so mutating it ahead of a rejected sidecar write would
        // let a later fold drop never-acked events. A rejection here leaves the
        // cache (and thus the compaction floor) untouched and fails the ack RPC.
        await persistSeqState(bee, { ...seqState, ackedSeq: target });
        seqState.ackedSeq = target;
      }
      return seqState.ackedSeq ?? 0;
    });
  const next = result.then(
    () => undefined,
    () => undefined,
  );
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

/**
 * Mark a bee as having an ACTIVE durable consumer (the gateway `connect`
 * transport engaged a subscribe/ack path), persisted in seq.json. Until the
 * consumer acks, this protects EVERY stamped event from compaction (an
 * effective ack floor of 0, see compactHsrEvents) so a connected-but-sleeping
 * consumer resumes exactly rather than degrading to a gap. Idempotent; runs on
 * the per-bee append chain (the seq stamping / ack / compaction serialization
 * domain).
 *
 * A genuinely local-only serve-mode bee never engages this path, so its
 * seq.json carries NO watermark and compaction stays byte-identical to the
 * pre-cell-transport size-first fold.
 *
 * UNBOUNDED-GROWTH NOTE: once subscribed, a consumer that connects but never
 * acks holds the log above the size cap indefinitely (exact resume trades log
 * bytes for durability). A consumer-expiry / quota policy is OUT OF SCOPE here;
 * the operational contract is that a live consumer acks its high-water, and a
 * gone consumer is reclaimed by killing the bee (which removes the run dir).
 */
export function markHsrConsumerSubscribed(bee: string): Promise<void> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(async () => {
      const seqState = await loadSeqState(bee);
      if (seqState.subscribed) return; // already active — idempotent
      await persistSeqState(bee, { ...seqState, subscribed: true });
      seqState.subscribed = true;
    });
  const next = result.then(
    () => undefined,
    () => undefined,
  );
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

/**
 * The events strictly after a consumer's seq cursor, plus an EXPLICIT gap
 * marker when the retained stamped seqs are not the contiguous run the cursor
 * expects — a compacted-away prefix, an INTERNAL hole (a torn/reissued line),
 * or a tail lost below seq.json's issued high-water. A resuming consumer must
 * never silently diverge. Legacy seq-less events and synthetic compaction
 * checkpoints have no cursor identity and are never returned here; they remain
 * reachable through the ts-based tail read (observe.ts readEventTail).
 */
export type HsrSeqGap = { fromSeq: number; toSeq: number };
export type HsrEventsAfterSeq = { events: RunnerEvent[]; gap?: HsrSeqGap };

/**
 * The first break in the contiguous seq run a consumer at `cursor` expects.
 * Appends never skip a seq, so from cursor+1 the retained stamped seqs must be
 * cursor+1, cursor+2, … up to the issued high-water; the FIRST missing seq (and
 * the run of missing seqs before the next retained one, or up to issuedMax when
 * nothing retained follows) is the gap. `retained` is in file (ascending)
 * order. Undefined when the run is intact.
 */
function firstSeqGap(cursor: number, retained: number[], issuedMax: number): HsrSeqGap | undefined {
  let expected = cursor + 1;
  for (const seq of retained) {
    if (seq < expected) continue; // at/below the cursor, or a duplicate already covered
    if (seq > expected) return { fromSeq: expected, toSeq: seq - 1 };
    expected = seq + 1; // seq === expected — the run continues
  }
  if (issuedMax >= expected) return { fromSeq: expected, toSeq: issuedMax };
  return undefined;
}

/**
 * Read the events with `seq > afterSeq` off a bee's events.jsonl. Reads the
 * whole file — writer-bounded to ~HSR_EVENTS_MAX_BYTES (the same cost class as
 * observe.ts's afterTs tail read) EXCEPT under ack backpressure, where the log
 * intentionally outgrows the cap and a resume must still see every unacked
 * event. Tolerates a missing file and torn lines like every other reader.
 */
export async function readHsrEventsAfterSeq(bee: string, afterSeq: number): Promise<HsrEventsAfterSeq> {
  const cursor = Math.max(0, Math.floor(afterSeq));
  let raw: string;
  try {
    raw = await readFile(hsrEventsPath(bee), "utf8");
  } catch {
    raw = "";
  }
  const events: RunnerEvent[] = [];
  const retained: number[] = []; // stamped seqs in file (ascending) order
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: RunnerEvent;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") continue;
      event = parsed as RunnerEvent;
    } catch {
      continue; // torn / partial line
    }
    const seq = event.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) continue; // seq-less prefix
    retained.push(seq);
    if (seq > cursor) events.push(event);
  }
  // The issued high-water (seq.json) bounds the trailing-gap check so a tail
  // lost below lastSeq (retained prefix ends early) is reported too.
  const persisted = await readHsrSeqState(bee);
  const gap = firstSeqGap(cursor, retained, persisted?.lastSeq ?? 0);
  return gap ? { events, gap } : { events };
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
