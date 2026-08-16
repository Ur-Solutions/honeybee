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

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import type { ReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { isRunnerAuthNeededMessage, type RunnerEvent, type RunnerTier } from "./types.js";
import { sameProcessBirthFingerprint, type ProcessBirthFingerprint } from "./processIdentity.js";

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

/** Derived, rebuildable validation/projection cursor for bounded control reads. */
function hsrSourceProofPath(bee: string): string {
  return join(hsrRunDir(bee), "source-proof.json");
}

/** Stable cross-process authority lock; deliberately outside disposable run dirs. */
export function hsrEventAuthorityLockPath(bee: string): string {
  const key = createHash("sha256").update(hsrRunDir(bee)).digest("hex");
  return join(storeRoot(), "locks", "hsr-event-authority", `${key}.lock`);
}

/** Purge-surviving audit location for an operator-acknowledged source loss. */
export function hsrEventHistoryEvidenceDir(bee: string, integrityId: string): string {
  const beeKey = createHash("sha256").update(bee).digest("hex");
  const integrityKey = createHash("sha256").update(integrityId).digest("hex");
  return join(storeRoot(), "hsr-event-integrity", "evidence", beeKey, integrityKey);
}

/** Purge-surviving audit record for an explicit durable-consumer history loss. */
export function hsrEventConsumerDiscardEvidencePath(
  bee: string,
  authority: { launchId: string; incarnation: string },
  consumerId: string,
): string {
  const beeKey = createHash("sha256").update(bee).digest("hex");
  const authorityKey = createHash("sha256")
    .update(`${authority.launchId}\0${authority.incarnation}`)
    .digest("hex");
  const consumerKey = createHash("sha256").update(consumerId).digest("hex");
  return join(
    storeRoot(),
    "hsr-event-consumers",
    "discards",
    beeKey,
    `${authorityKey}-${consumerKey}.json`,
  );
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
  /** Durable fail-closed marker when a produced event could not be logged. */
  eventIntegrityFailure?: string;
  /**
   * Positive proof that this exact host durably appended its terminal `exit`
   * event and closed the source stream before publishing `status: exited`.
   * Ordinary dead-host reaping must never synthesize this marker.
   */
  eventStreamClosure?: HsrEventStreamClosure;
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
  /** Exact remote generation mirrored into this local run dir. */
  mirrorRemoteLaunchId?: string;
  mirrorRemoteIncarnation?: string;
  /** Crash-recoverable generation handoff before a mirror becomes live. */
  mirrorSyncPhase?: "resetting" | "syncing";
};

export type HsrEventStreamClosure = {
  version: 1;
  lastSeq: number;
  closedAt: string;
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

function validHsrEventStreamClosure(value: unknown): value is HsrEventStreamClosure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const closure = value as Record<string, unknown>;
  return Object.keys(closure).every((key) => key === "version" || key === "lastSeq" || key === "closedAt")
    && closure.version === 1
    && Number.isSafeInteger(closure.lastSeq) && Number(closure.lastSeq) > 0
    && typeof closure.closedAt === "string" && closure.closedAt.length > 0;
}

function validHsrEventStreamClosureShape(object: Record<string, unknown>): boolean {
  if (object.eventStreamClosure === undefined) return true;
  return validHsrEventStreamClosure(object.eventStreamClosure)
    && object.status === "exited"
    && typeof object.endedAt === "string" && object.endedAt.length > 0
    && object.eventIntegrityFailure === undefined
    && object.mirrorOfNode === undefined;
}

/** Durable pre-adapter proof for the one startup path that attempted no child. */
export function hsrMetaProvesProviderNeverStarted(meta: HsrMeta): boolean {
  return meta.status === "exited"
    && meta.childAdmission === "none"
    && meta.runningAt === undefined
    && meta.startupFailure?.stage === "adapter-start";
}

function validMirrorSyncShape(object: Record<string, unknown>): boolean {
  if (object.mirrorSyncPhase === undefined) return true;
  return (object.mirrorSyncPhase === "resetting" || object.mirrorSyncPhase === "syncing")
    && object.status === "exited"
    && object.hostPid === 0
    && object.controlSocket === ""
    && typeof object.mirrorOfNode === "string" && object.mirrorOfNode.length > 0
    && typeof object.mirrorRemoteLaunchId === "string" && object.mirrorRemoteLaunchId.length > 0
    && typeof object.mirrorRemoteIncarnation === "string" && object.mirrorRemoteIncarnation.length > 0;
}

/** mkdir -p the run dir (owner-only). */
export async function ensureHsrRunDir(bee: string): Promise<void> {
  await mkdir(hsrRunDir(bee), { recursive: true, mode: 0o700 });
}

/**
 * Remove pre-publication run artifacts only after the exact spawned host was
 * confirmed stopped. Absence is harmless; any extant directory must retain an
 * exited, matching incarnation tombstone or cleanup fails closed.
 */
export async function removeConfirmedStoppedHsrRunDir(
  bee: string,
  expectedHostPid: number,
  expectedFingerprint?: ProcessBirthFingerprint,
): Promise<void> {
  await drainHsrEventWrites(bee);
  await withHsrEventAuthorityLock(bee, async () => {
    try {
      await stat(hsrRunDir(bee));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const meta = await readHsrMetaStrict(bee);
    if (
      !meta
      || meta.status !== "exited"
      || meta.hostPid !== expectedHostPid
      || (expectedFingerprint !== undefined
        && !sameProcessBirthFingerprint(meta.hostFingerprint, expectedFingerprint))
    ) {
      throw new Error(`refusing to remove ${bee}'s HSR run state without its exact exited incarnation`);
    }
    await rm(hsrRunDir(bee), { recursive: true });
  });
  forgetHsrRunState(bee);
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
    if (object.eventIntegrityFailure !== undefined && (typeof object.eventIntegrityFailure !== "string" || object.eventIntegrityFailure.length === 0)) return null;
    if (!validHsrEventStreamClosureShape(object)) return null;
    if (object.mirrorRemoteLaunchId !== undefined && (typeof object.mirrorRemoteLaunchId !== "string" || object.mirrorRemoteLaunchId.length === 0)) return null;
    if (object.mirrorRemoteIncarnation !== undefined && (typeof object.mirrorRemoteIncarnation !== "string" || object.mirrorRemoteIncarnation.length === 0)) return null;
    if (!validMirrorSyncShape(object)) return null;
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
  if (object.eventIntegrityFailure !== undefined && (typeof object.eventIntegrityFailure !== "string" || object.eventIntegrityFailure.length === 0)) {
    throw new Error(`Invalid HSR metadata for ${bee}: malformed event integrity failure`);
  }
  if (!validHsrEventStreamClosureShape(object)) {
    throw new Error(`Invalid HSR metadata for ${bee}: malformed or nonterminal event stream closure`);
  }
  if (object.mirrorRemoteLaunchId !== undefined && (typeof object.mirrorRemoteLaunchId !== "string" || object.mirrorRemoteLaunchId.length === 0)) {
    throw new Error(`Invalid HSR metadata for ${bee}: malformed mirror launch id`);
  }
  if (object.mirrorRemoteIncarnation !== undefined && (typeof object.mirrorRemoteIncarnation !== "string" || object.mirrorRemoteIncarnation.length === 0)) {
    throw new Error(`Invalid HSR metadata for ${bee}: malformed mirror incarnation`);
  }
  if (!validMirrorSyncShape(object)) {
    throw new Error(`Invalid HSR metadata for ${bee}: malformed or live mirror sync phase`);
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
 * (lost update), and liveness truth must never lose to a counter bump. Every
 * sidecar mutation shares the per-bee cross-process event-authority lock; each
 * process also serializes its own calls through the append chain below.
 */
export type HsrSeqConsumerState = { ackedSeq?: number };
/** Actionable id representing the pre-multi-consumer single watermark. */
export const HSR_LEGACY_EVENT_CONSUMER_ID = "__legacy_single_consumer__";
export type HsrSeqState = {
  lastSeq: number;
  /** Legacy single-consumer watermark retained for old/local callers. */
  ackedSeq?: number;
  /** Legacy single-consumer admission marker. */
  subscribed?: boolean;
  /** Durable remote observers. Entries are never expired implicitly. */
  consumers?: Record<string, HsrSeqConsumerState>;
  /** Membership CAS generation; lets cross-process writer caches honor removal. */
  consumerRevision?: number;
  /** Latest explicit operator history-loss decision for each durable consumer. */
  consumerDiscards?: Record<string, { throughSeq: number; discardedAt: string }>;
};

/** A healthy cross-process writer kept changing authority during validation. */
export class HsrSourceEventLogBusyError extends Error {
  readonly code = "HIVE_HSR_EVENT_LOG_BUSY";
  constructor(readonly bee: string) {
    super(`HSR event history for ${bee} is changing; retry the operation`);
    this.name = "HsrSourceEventLogBusyError";
  }
}

let eventAuthorityTimeoutOverrideMs: number | undefined;

/** @internal deterministic lock-contention injection for RPC/source tests. */
export function __testOnlySetHsrEventAuthorityTimeout(timeoutMs: number | undefined): void {
  eventAuthorityTimeoutOverrideMs = timeoutMs;
}

export async function withHsrEventAuthorityLock<T>(
  bee: string,
  fn: () => Promise<T>,
  timeoutMs = 120_000,
): Promise<T> {
  const effectiveTimeoutMs = eventAuthorityTimeoutOverrideMs === undefined
    ? timeoutMs
    : Math.min(timeoutMs, eventAuthorityTimeoutOverrideMs);
  let timedOut = false;
  try {
    return await withFileLock(hsrEventAuthorityLockPath(bee), fn, {
      timeoutMs: effectiveTimeoutMs,
      pollMs: 10,
      staleMs: 180_000,
      onTimeout: () => { timedOut = true; },
    });
  } catch (error) {
    if (timedOut) throw new HsrSourceEventLogBusyError(bee);
    throw error;
  }
}

/** Destructive run-state reset sharing the same cross-process writer authority. */
export async function removeHsrRunDirUnderEventAuthority(bee: string): Promise<void> {
  // This helper sits on purge paths that may receive corrupt legacy record
  // names. Normalize with the store's filename contract before BOTH locking
  // and deletion; authority locking alone is not a containment boundary.
  const safeBee = (() => {
    const sanitized = bee.replace(/[^A-Za-z0-9_.:-]/g, "-");
    return /^[.]*$/.test(sanitized) ? sanitized.replace(/[.]/g, "-") || "-" : sanitized;
  })();
  await drainHsrEventWrites(safeBee);
  await withHsrEventAuthorityLock(safeBee, () => rm(hsrRunDir(safeBee), { recursive: true, force: true }));
  forgetHsrRunState(safeBee);
}

/**
 * Remove stopped source state only after every durable consumer has acked the
 * exact issued high-water. A remote kill can race a blocked mirror callback;
 * retaining the exited run dir lets that consumer replay the terminal suffix
 * after the lifecycle lock is released. Consumers which never return pin the
 * bytes deliberately rather than turning operator cleanup into event loss.
 */
export async function removeHsrRunDirIfConsumersCaughtUp(
  bee: string,
  terminalActivations: Readonly<Record<string, { throughSeq: number }>> = {},
): Promise<boolean> {
  const safeBee = (() => {
    const sanitized = bee.replace(/[^A-Za-z0-9_.:-]/g, "-");
    return /^[.]*$/.test(sanitized) ? sanitized.replace(/[.]/g, "-") || "-" : sanitized;
  })();
  await drainHsrEventWrites(safeBee);
  const removed = await withHsrEventAuthorityLock(safeBee, async () => {
    const state = await readHsrSeqStateForWriterStrict(safeBee);
    if (state) {
      // Progress acks permit compaction but never authorize terminal-history
      // deletion. Every named consumer must also have a generation-bound,
      // post-activation finalization in the purge-surviving launch receipt.
      // Legacy single-consumer authority has no such handshake and therefore
      // remains pinned until the operator explicitly discards its pseudo-id.
      if (state.lastSeq > 0 && (state.subscribed || state.ackedSeq !== undefined)) return false;
      for (const [consumerId, consumer] of Object.entries(state.consumers ?? {})) {
        if ((consumer.ackedSeq ?? 0) < state.lastSeq) return false;
        if ((terminalActivations[consumerId]?.throughSeq ?? 0) < state.lastSeq) return false;
      }
    }
    await rm(hsrRunDir(safeBee), { recursive: true, force: true });
    return true;
  });
  if (removed) forgetHsrRunState(safeBee);
  return removed;
}

function validHsrConsumerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function effectiveConsumerWatermark(state: HsrSeqState): number | undefined {
  const watermarks: number[] = [];
  if (state.subscribed || state.ackedSeq !== undefined) watermarks.push(state.ackedSeq ?? 0);
  for (const consumer of Object.values(state.consumers ?? {})) watermarks.push(consumer.ackedSeq ?? 0);
  return watermarks.length > 0 ? Math.min(...watermarks) : undefined;
}

// In-memory seq state, one entry per bee, owned by the append chain. Seeded
// once per process from max(seq.json lastSeq, highest stamped seq in
// events.jsonl) so a crash between the event append and the seq.json write —
// or a lost sidecar — can never reissue a seq (the newest stamped event always
// survives compaction, which keeps at least the final line).
const seqStates = new Map<string, HsrSeqState>();
type HsrEventLogProof = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
const eventLogProofs = new Map<string, HsrEventLogProof | null>();

type HsrSourceTailProof = {
  type: RunnerEvent["type"];
  seq: number;
  host?: Extract<RunnerEvent, { type: "host_epoch" }>["host"];
};

type HsrSourceProjectionFact = { index: number; event: RunnerEvent };
type HsrSourceProjectionFacts = {
  rootStart?: HsrSourceProjectionFact;
  rootEnd?: HsrSourceProjectionFact;
  toolUse?: HsrSourceProjectionFact;
  needsInput?: HsrSourceProjectionFact;
  authNeeded?: HsrSourceProjectionFact;
  authResume?: HsrSourceProjectionFact;
  text?: HsrSourceProjectionFact;
  exhausted?: HsrSourceProjectionFact;
};
type HsrSourceProjectionAccumulator = {
  expectedHost: Extract<RunnerEvent, { type: "host_epoch" }>["host"];
  rootThreadId?: string;
  exact: HsrSourceProjectionFacts;
  hostless: HsrSourceProjectionFacts;
  sawMatchingEpoch: boolean;
  sawUsage: boolean;
  inputTokens: number;
  outputTokens: number;
};

type HsrSourceAuthorityProof = {
  version: 1;
  eventFile: HsrEventLogProof | null;
  throughSeq: number;
  eventCount: number;
  stampedCount: number;
  lastStamped?: HsrSourceTailProof;
  projection?: HsrSourceProjectionAccumulator;
};

const sourceAuthorityProofs = new Map<string, HsrSourceAuthorityProof>();

let sourceValidationAfterEventRead: (() => Promise<void> | void) | undefined;
let wholeEventLogReadGuard: ((bee: string) => Promise<void> | void) | undefined;

/** @internal deterministic cross-process snapshot-race injection. */
export function __testOnlySetSourceValidationAfterEventRead(
  hook: (() => Promise<void> | void) | undefined,
): void {
  sourceValidationAfterEventRead = hook;
}

/** @internal sentinel proving bounded admission/list paths never materialize a pinned log. */
export function __testOnlySetWholeEventLogReadGuard(
  hook: ((bee: string) => Promise<void> | void) | undefined,
): void {
  wholeEventLogReadGuard = hook;
}

async function readWholeHsrEventLog(bee: string): Promise<string> {
  await wholeEventLogReadGuard?.(bee);
  return readFile(hsrEventsPath(bee), "utf8");
}

async function readEventLogProof(bee: string): Promise<HsrEventLogProof | null> {
  try {
    const current = await stat(hsrEventsPath(bee));
    return {
      dev: current.dev,
      ino: current.ino,
      size: current.size,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameEventLogProof(left: HsrEventLogProof | null, right: HsrEventLogProof | null): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.dev === right.dev
      && left.ino === right.ino
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs;
}

function validStoredEventLogProof(value: unknown): value is HsrEventLogProof | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return [proof.dev, proof.ino, proof.size, proof.mtimeMs, proof.ctimeMs]
    .every((field) => typeof field === "number" && Number.isFinite(field) && field >= 0);
}

function validProjectionFact(value: unknown): value is HsrSourceProjectionFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fact = value as { index?: unknown; event?: unknown };
  return Number.isSafeInteger(fact.index) && Number(fact.index) >= 0
    && !!fact.event && typeof fact.event === "object" && !Array.isArray(fact.event)
    && typeof (fact.event as { type?: unknown }).type === "string";
}

function validProjectionFacts(value: unknown): value is HsrSourceProjectionFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  const allowed = new Set(["rootStart", "rootEnd", "toolUse", "needsInput", "authNeeded", "authResume", "text", "exhausted"]);
  return Object.entries(facts).every(([key, fact]) => allowed.has(key) && validProjectionFact(fact));
}

function validSourceProjection(value: unknown): value is HsrSourceProjectionAccumulator {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  const host = projection.expectedHost as Record<string, unknown> | undefined;
  return !!host && typeof host === "object" && !Array.isArray(host)
    && Number.isSafeInteger(host.hostPid) && Number(host.hostPid) > 0
    && typeof host.startedAt === "string" && host.startedAt.length > 0
    && (projection.rootThreadId === undefined || typeof projection.rootThreadId === "string")
    && validProjectionFacts(projection.exact)
    && validProjectionFacts(projection.hostless)
    && typeof projection.sawMatchingEpoch === "boolean"
    && typeof projection.sawUsage === "boolean"
    && typeof projection.inputTokens === "number" && Number.isFinite(projection.inputTokens)
    && typeof projection.outputTokens === "number" && Number.isFinite(projection.outputTokens);
}

function parseSourceAuthorityProof(raw: string): HsrSourceAuthorityProof | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const proof = parsed as Record<string, unknown>;
    if (
      proof.version !== 1
      || !validStoredEventLogProof(proof.eventFile)
      || !Number.isSafeInteger(proof.throughSeq) || Number(proof.throughSeq) < 0
      || !Number.isSafeInteger(proof.eventCount) || Number(proof.eventCount) < 0
      || !Number.isSafeInteger(proof.stampedCount) || Number(proof.stampedCount) < 0
    ) return null;
    let lastStamped: HsrSourceTailProof | undefined;
    if (proof.lastStamped !== undefined) {
      if (!proof.lastStamped || typeof proof.lastStamped !== "object" || Array.isArray(proof.lastStamped)) return null;
      const tail = proof.lastStamped as Record<string, unknown>;
      if (typeof tail.type !== "string" || !Number.isSafeInteger(tail.seq) || Number(tail.seq) <= 0) return null;
      lastStamped = tail as unknown as HsrSourceTailProof;
    }
    return {
      version: 1,
      eventFile: proof.eventFile,
      throughSeq: Number(proof.throughSeq),
      eventCount: Number(proof.eventCount),
      stampedCount: Number(proof.stampedCount),
      ...(lastStamped ? { lastStamped } : {}),
      ...(validSourceProjection(proof.projection) ? { projection: proof.projection } : {}),
    };
  } catch {
    return null; // derived cache only; source bytes remain the authority
  }
}

async function readSourceAuthorityProof(bee: string): Promise<HsrSourceAuthorityProof | null> {
  const cached = sourceAuthorityProofs.get(bee);
  if (cached) return cached;
  try {
    const parsed = parseSourceAuthorityProof(await readFile(hsrSourceProofPath(bee), "utf8"));
    if (parsed) sourceAuthorityProofs.set(bee, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function persistSourceAuthorityProof(bee: string, proof: HsrSourceAuthorityProof): Promise<void> {
  sourceAuthorityProofs.set(bee, proof);
  await atomicWriteFile(hsrSourceProofPath(bee), `${JSON.stringify(proof)}\n`, { mode: 0o600 });
}

async function validatedSourceAuthorityProofInLock(
  bee: string,
  state: HsrSeqState,
): Promise<HsrSourceAuthorityProof | null> {
  const proof = await readSourceAuthorityProof(bee);
  if (!proof || proof.throughSeq < state.lastSeq) return null;
  const current = await readEventLogProof(bee);
  return sameEventLogProof(proof.eventFile, current) ? proof : null;
}

function tailProofOf(event: RunnerEvent): HsrSourceTailProof | undefined {
  if (event.seq === undefined) return undefined;
  return {
    type: event.type,
    seq: event.seq,
    ...(event.host ? { host: event.host } : {}),
  };
}

function sourceEventMatchesHost(
  event: RunnerEvent,
  expected: HsrSourceProjectionAccumulator["expectedHost"],
): boolean {
  const host = event.host;
  return !!host
    && host.hostPid === expected.hostPid
    && host.startedAt === expected.startedAt
    && sameProcessBirthFingerprint(host.hostFingerprint, expected.hostFingerprint);
}

function projectionLifecycleMatchesRoot(event: RunnerEvent, rootThreadId: string | undefined): boolean {
  if (event.type !== "turn_start" && event.type !== "turn_end") return false;
  if (!rootThreadId) return true;
  return typeof event.threadId !== "string" || event.threadId.length === 0 || event.threadId === rootThreadId;
}

function addSourceProjectionFact(
  facts: HsrSourceProjectionFacts,
  event: RunnerEvent,
  index: number,
  rootThreadId: string | undefined,
): void {
  const indexed = { index, event };
  switch (event.type) {
    case "turn_start":
      if (projectionLifecycleMatchesRoot(event, rootThreadId)) facts.rootStart = indexed;
      break;
    case "turn_end":
      if (projectionLifecycleMatchesRoot(event, rootThreadId)) facts.rootEnd = indexed;
      break;
    case "tool_use": facts.toolUse = indexed; break;
    case "needs_input": facts.needsInput = indexed; break;
    case "error":
      if (isRunnerAuthNeededMessage(event.message)) facts.authNeeded = indexed;
      break;
    case "auth_expired":
      if (event.requiresLogin) facts.authNeeded = indexed;
      break;
    case "auth_resume": facts.authResume = indexed; break;
    case "text":
      if (event.text.length > 0) facts.text = indexed;
      break;
    case "exhausted": {
      const prior = facts.exhausted;
      const ts = Number.isFinite(event.ts) ? event.ts : 0;
      const priorTs = prior && Number.isFinite(prior.event.ts) ? prior.event.ts : 0;
      if (!prior || ts > priorTs || (ts === priorTs && index > prior.index)) facts.exhausted = indexed;
      break;
    }
    default: break;
  }
}

function foldSourceProjection(
  projection: HsrSourceProjectionAccumulator,
  event: RunnerEvent,
  index: number,
): HsrSourceProjectionAccumulator {
  if (event.type === "usage") {
    projection.sawUsage = true;
    if (typeof event.inputTokens === "number" && Number.isFinite(event.inputTokens)) projection.inputTokens += event.inputTokens;
    if (typeof event.cacheReadTokens === "number" && Number.isFinite(event.cacheReadTokens)) projection.inputTokens += event.cacheReadTokens;
    if (typeof event.cacheWriteTokens === "number" && Number.isFinite(event.cacheWriteTokens)) projection.inputTokens += event.cacheWriteTokens;
    if (typeof event.outputTokens === "number" && Number.isFinite(event.outputTokens)) projection.outputTokens += event.outputTokens;
    if (typeof event.reasoningTokens === "number" && Number.isFinite(event.reasoningTokens)) projection.outputTokens += event.reasoningTokens;
  }
  const exact = sourceEventMatchesHost(event, projection.expectedHost);
  if (event.type === "host_epoch" && exact) {
    projection.sawMatchingEpoch = true;
    projection.hostless = {};
  }
  if (exact) {
    addSourceProjectionFact(projection.exact, event, index, projection.rootThreadId);
  } else if (
    event.host === undefined
    && (projection.sawMatchingEpoch || (Number.isFinite(Date.parse(projection.expectedHost.startedAt))
      && Number.isFinite(event.ts) && event.ts >= Date.parse(projection.expectedHost.startedAt)))
  ) {
    addSourceProjectionFact(projection.hostless, event, index, projection.rootThreadId);
  }
  return projection;
}

function sourceProjectionMatches(
  projection: HsrSourceProjectionAccumulator | undefined,
  expectedHost: HsrSourceProjectionAccumulator["expectedHost"],
  rootThreadId: string | undefined,
): projection is HsrSourceProjectionAccumulator {
  return !!projection
    && projection.rootThreadId === rootThreadId
    && projection.expectedHost.hostPid === expectedHost.hostPid
    && projection.expectedHost.startedAt === expectedHost.startedAt
    && sameProcessBirthFingerprint(projection.expectedHost.hostFingerprint, expectedHost.hostFingerprint);
}

function emptySourceProjection(
  expectedHost: HsrSourceProjectionAccumulator["expectedHost"],
  rootThreadId: string | undefined,
): HsrSourceProjectionAccumulator {
  return {
    expectedHost,
    ...(rootThreadId ? { rootThreadId } : {}),
    exact: {},
    hostless: {},
    sawMatchingEpoch: false,
    sawUsage: false,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/**
 * Start the host-scoped portion of a projection at a new epoch while retaining
 * the session-cumulative usage counters.  Lifecycle/auth/turn/exhaustion facts
 * belong to one host incarnation; token totals belong to the retained session
 * history and must therefore agree with a later full-log rebuild.
 */
function advanceSourceProjectionHostEpoch(
  prior: HsrSourceProjectionAccumulator,
  expectedHost: HsrSourceProjectionAccumulator["expectedHost"],
  rootThreadId: string | undefined,
): HsrSourceProjectionAccumulator {
  return {
    ...emptySourceProjection(expectedHost, rootThreadId),
    sawUsage: prior.sawUsage,
    inputTokens: prior.inputTokens,
    outputTokens: prior.outputTokens,
  };
}

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
  eventLogProofs.delete(bee);
  sourceAuthorityProofs.delete(bee);
}

/** Wait until every already-enqueued event/reset/ack write for this name lands. */
export async function drainHsrEventWrites(bee: string): Promise<void> {
  for (;;) {
    const pending = appendChains.get(bee);
    if (!pending) return;
    await pending;
    if (appendChains.get(bee) === pending) return;
  }
}

/**
 * Reset only the generation-scoped payload of a LOCAL remote mirror. The reset
 * joins the same append chain as event writes, so an already-delivered event
 * from the predecessor cannot land after the successor's empty boundary.
 */
export function resetHsrMirrorGeneration(bee: string): Promise<void> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      await ensureHsrRunDir(bee);
      await atomicWriteFile(hsrEventsPath(bee), "", { mode: 0o600 });
      await atomicWriteFile(hsrRingPath(bee), "", { mode: 0o600 });
      await rm(hsrSeqPath(bee), { force: true });
      await rm(hsrSourceProofPath(bee), { force: true });
      seqStates.delete(bee);
      eventLogSizes.set(bee, 0);
      eventLogProofs.set(bee, await readEventLogProof(bee));
      sourceAuthorityProofs.delete(bee);
    }));
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

type HsrEventHistorySnapshot = {
  version: 1;
  integrityId: string;
  eventsSha256: string;
  seqSha256?: string;
  capturedAt: string;
};

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseEventHistorySnapshot(raw: string, integrityId: string): HsrEventHistorySnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`HSR event-history quarantine ${integrityId} is malformed`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`HSR event-history quarantine ${integrityId} is malformed`);
  }
  const object = value as Record<string, unknown>;
  if (
    object.version !== 1
    || object.integrityId !== integrityId
    || typeof object.eventsSha256 !== "string" || !/^[a-f0-9]{64}$/.test(object.eventsSha256)
    || (object.seqSha256 !== undefined && (typeof object.seqSha256 !== "string" || !/^[a-f0-9]{64}$/.test(object.seqSha256)))
    || typeof object.capturedAt !== "string" || !Number.isFinite(Date.parse(object.capturedAt))
  ) {
    throw new Error(`HSR event-history quarantine ${integrityId} is malformed`);
  }
  return object as HsrEventHistorySnapshot;
}

async function verifiedEventHistorySnapshot(bee: string, integrityId: string): Promise<HsrEventHistorySnapshot | null> {
  const dir = hsrEventHistoryEvidenceDir(bee, integrityId);
  const raw = await optionalText(join(dir, "snapshot.json"));
  if (raw === null) return null;
  const snapshot = parseEventHistorySnapshot(raw, integrityId);
  const events = await optionalText(join(dir, "events.jsonl"));
  if (events === null || sha256Text(events) !== snapshot.eventsSha256) {
    throw new Error(`HSR event-history quarantine ${integrityId} lost its event evidence`);
  }
  const seq = await optionalText(join(dir, "seq.json"));
  if (snapshot.seqSha256 === undefined ? seq !== null : seq === null || sha256Text(seq) !== snapshot.seqSha256) {
    throw new Error(`HSR event-history quarantine ${integrityId} lost its sequence evidence`);
  }
  return snapshot;
}

/** True only after evidence capture AND active-log reset both completed. */
export async function isHsrEventHistoryQuarantined(bee: string, integrityId: string): Promise<boolean> {
  const raw = await optionalText(join(hsrEventHistoryEvidenceDir(bee, integrityId), "complete.json"));
  if (raw === null) return false;
  const complete = parseEventHistorySnapshot(raw, integrityId);
  const snapshot = await verifiedEventHistorySnapshot(bee, integrityId);
  return !!snapshot
    && snapshot.eventsSha256 === complete.eventsSha256
    && snapshot.seqSha256 === complete.seqSha256;
}

/**
 * Preserve the exact uncertain source bytes before resetting the active seq
 * namespace for an explicitly acknowledged successor. The snapshot marker is
 * committed before any active file changes; `complete.json` lands last, so a
 * crash retries idempotently without ever replacing old evidence with the
 * already-reset empty log.
 */
export function quarantineHsrEventHistory(bee: string, integrityId: string): Promise<void> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev.catch(() => undefined).then(() => withHsrEventAuthorityLock(bee, async () => {
    if (await isHsrEventHistoryQuarantined(bee, integrityId)) return;
    const evidenceDir = hsrEventHistoryEvidenceDir(bee, integrityId);
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    let snapshot = await verifiedEventHistorySnapshot(bee, integrityId);
    if (!snapshot) {
      const events = await optionalText(hsrEventsPath(bee)) ?? "";
      const seq = await optionalText(hsrSeqPath(bee));
      await atomicWriteFile(join(evidenceDir, "events.jsonl"), events, { mode: 0o600 });
      if (seq !== null) await atomicWriteFile(join(evidenceDir, "seq.json"), seq, { mode: 0o600 });
      snapshot = {
        version: 1,
        integrityId,
        eventsSha256: sha256Text(events),
        ...(seq !== null ? { seqSha256: sha256Text(seq) } : {}),
        capturedAt: new Date().toISOString(),
      };
      await atomicWriteFile(join(evidenceDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    }

    let runDirExists = true;
    try {
      await stat(hsrRunDir(bee));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") runDirExists = false;
      else throw error;
    }
    if (runDirExists) {
      await atomicWriteFile(hsrEventsPath(bee), "", { mode: 0o600 });
      await rm(hsrSeqPath(bee), { force: true });
      await rm(hsrSourceProofPath(bee), { force: true });
    }
    seqStates.delete(bee);
    eventLogSizes.set(bee, 0);
    eventLogProofs.set(bee, await readEventLogProof(bee));
    sourceAuthorityProofs.delete(bee);
    await atomicWriteFile(join(evidenceDir, "complete.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  }));
  const next = result.then(() => undefined, () => undefined);
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
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
    let consumers: Record<string, HsrSeqConsumerState> | undefined;
    if (object.consumers !== undefined) {
      if (!object.consumers || typeof object.consumers !== "object" || Array.isArray(object.consumers)) return null;
      consumers = {};
      for (const [consumerId, rawConsumer] of Object.entries(object.consumers as Record<string, unknown>)) {
        if (!validHsrConsumerId(consumerId) || !rawConsumer || typeof rawConsumer !== "object" || Array.isArray(rawConsumer)) return null;
        const consumer = rawConsumer as Record<string, unknown>;
        if (consumer.ackedSeq !== undefined && (
          !Number.isSafeInteger(consumer.ackedSeq)
          || Number(consumer.ackedSeq) < 0
        )) return null;
        consumers[consumerId] = {
          ...(consumer.ackedSeq !== undefined
            ? { ackedSeq: Math.min(Number(consumer.ackedSeq), lastSeq) }
            : {}),
        };
      }
    }
    if (object.consumerRevision !== undefined && (
      !Number.isSafeInteger(object.consumerRevision) || Number(object.consumerRevision) < 0
    )) return null;
    let consumerDiscards: HsrSeqState["consumerDiscards"];
    if (object.consumerDiscards !== undefined) {
      if (!object.consumerDiscards || typeof object.consumerDiscards !== "object" || Array.isArray(object.consumerDiscards)) return null;
      consumerDiscards = {};
      for (const [consumerId, rawDiscard] of Object.entries(object.consumerDiscards as Record<string, unknown>)) {
        if (!validHsrConsumerId(consumerId) || !rawDiscard || typeof rawDiscard !== "object" || Array.isArray(rawDiscard)) return null;
        const discard = rawDiscard as Record<string, unknown>;
        if (
          !Number.isSafeInteger(discard.throughSeq) || Number(discard.throughSeq) < 0
          || Number(discard.throughSeq) > lastSeq
          || typeof discard.discardedAt !== "string" || discard.discardedAt.length === 0
        ) return null;
        consumerDiscards[consumerId] = {
          throughSeq: Number(discard.throughSeq),
          discardedAt: discard.discardedAt,
        };
      }
    }
    return {
      lastSeq,
      ...(ackedSeq !== undefined ? { ackedSeq } : {}),
      ...(object.subscribed === true ? { subscribed: true } : {}),
      ...(consumers ? { consumers } : {}),
      ...(object.consumerRevision !== undefined ? { consumerRevision: Number(object.consumerRevision) } : {}),
      ...(consumerDiscards ? { consumerDiscards } : {}),
    };
  } catch {
    return null;
  }
}

async function persistSeqState(bee: string, state: HsrSeqState): Promise<void> {
  await atomicWriteFile(hsrSeqPath(bee), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

/** Writer/compactor authority read: missing is fresh; every other uncertainty is fatal. */
async function readHsrSeqStateForWriterStrict(bee: string): Promise<HsrSeqState | null> {
  try {
    return parseStrictSeqState(bee, await readFile(hsrSeqPath(bee), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Merge the monotonic portions of two seq authority snapshots. The event lock
 * serializes processes, but each process still has its own `seqStates` cache:
 * a detached host must therefore absorb consumer admissions/acks written by
 * the serve process before it persists its next event high-water. Consumer
 * entries are durable and never implicitly removed, and every cursor is
 * monotonic, so union/max is the only lossless merge.
 */
function mergeHsrSeqStates(left: HsrSeqState, right: HsrSeqState): HsrSeqState {
  const leftRevision = left.consumerRevision ?? 0;
  const rightRevision = right.consumerRevision ?? 0;
  const consumerIds = leftRevision > rightRevision
    ? Object.keys(left.consumers ?? {})
    : rightRevision > leftRevision
      ? Object.keys(right.consumers ?? {})
      : [...new Set([
          ...Object.keys(left.consumers ?? {}),
          ...Object.keys(right.consumers ?? {}),
        ])];
  const consumers: Record<string, HsrSeqConsumerState> = {};
  for (const consumerId of consumerIds) {
    const leftAck = left.consumers?.[consumerId]?.ackedSeq;
    const rightAck = right.consumers?.[consumerId]?.ackedSeq;
    // A membership revision is also an ABA boundary. Once a consumer was
    // removed and later re-admitted under the same stable id, a stale process's
    // pre-removal ack must not jump the new admission cursor forward. Only equal
    // revisions merge monotonic acks; otherwise the newer membership snapshot
    // owns both presence and its cursor.
    const ackedSeq = leftRevision > rightRevision
      ? leftAck
      : rightRevision > leftRevision
        ? rightAck
        : leftAck === undefined
          ? rightAck
          : rightAck === undefined
            ? leftAck
            : Math.max(leftAck, rightAck);
    consumers[consumerId] = ackedSeq === undefined ? {} : { ackedSeq };
  }
  const legacyAck = leftRevision > rightRevision
    ? left.ackedSeq
    : rightRevision > leftRevision
      ? right.ackedSeq
      : left.ackedSeq === undefined
        ? right.ackedSeq
        : right.ackedSeq === undefined
          ? left.ackedSeq
          : Math.max(left.ackedSeq, right.ackedSeq);
  const legacySubscribed = leftRevision > rightRevision
    ? left.subscribed
    : rightRevision > leftRevision
      ? right.subscribed
      : left.subscribed || right.subscribed;
  const consumerDiscards = { ...left.consumerDiscards };
  for (const [consumerId, discard] of Object.entries(right.consumerDiscards ?? {})) {
    const prior = consumerDiscards[consumerId];
    if (!prior || discard.throughSeq > prior.throughSeq || discard.discardedAt > prior.discardedAt) {
      consumerDiscards[consumerId] = discard;
    }
  }
  return {
    lastSeq: Math.max(left.lastSeq, right.lastSeq),
    ...(legacyAck !== undefined ? { ackedSeq: legacyAck } : {}),
    ...(legacySubscribed ? { subscribed: true } : {}),
    ...(Object.keys(consumers).length > 0 ? { consumers } : {}),
    ...(left.consumerRevision !== undefined || right.consumerRevision !== undefined
      ? { consumerRevision: Math.max(leftRevision, rightRevision) }
      : {}),
    ...(Object.keys(consumerDiscards).length > 0 ? { consumerDiscards } : {}),
  };
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
    if (!parsed || typeof parsed !== "object") return line;
    const { seq: _seq, remoteSeq: _remoteSeq, ...rest } = parsed as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return line; // torn / partial line — carried as-is
  }
}

/** Whether a nonempty source file needs a delimiter before its next append. */
async function eventLogNeedsTrailingNewline(bee: string): Promise<boolean> {
  let file: FileHandle | undefined;
  try {
    file = await open(hsrEventsPath(bee), "r");
    const size = (await file.stat()).size;
    if (size === 0) return false;
    const byte = Buffer.allocUnsafe(1);
    const read = await file.read(byte, 0, 1, size - 1);
    return read.bytesRead === 1 && byte[0] !== 0x0a;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`HSR event log for ${bee} is unreadable`, { cause: error });
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function validateDurableConsumerEventLog(bee: string, raw: string, state: HsrSeqState): number {
  const watermark = effectiveConsumerWatermark(state);
  let firstSeq: number | undefined;
  let priorSeq: number | undefined;
  let sourceCheckpoint: number | undefined;
  let sawStampedEvent = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`HSR event log for ${bee} contains a malformed record`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      throw new Error(`HSR event log for ${bee} contains a malformed record`);
    }
    const seq = (parsed as { seq?: unknown }).seq;
    if (seq === undefined) {
      if (sawStampedEvent) {
        throw new Error(`HSR event log for ${bee} contains a seq-less record after stamped history`);
      }
      if ((parsed as { type?: unknown }).type === "source_cursor_checkpoint") {
        const throughSeq = (parsed as { throughSeq?: unknown }).throughSeq;
        if (sourceCheckpoint !== undefined || !Number.isSafeInteger(throughSeq) || Number(throughSeq) <= 0) {
          throw new Error(`HSR event log for ${bee} contains an invalid source compaction checkpoint`);
        }
        sourceCheckpoint = Number(throughSeq);
      }
      continue;
    }
    if (!Number.isSafeInteger(seq) || Number(seq) <= 0) {
      throw new Error(`HSR event log for ${bee} contains an invalid sequence`);
    }
    const numeric = Number(seq);
    sawStampedEvent = true;
    if (firstSeq === undefined) {
      firstSeq = numeric;
      const expectedFirst = (sourceCheckpoint ?? 0) + 1;
      if (numeric !== expectedFirst) {
        throw new Error(
          `HSR event log for ${bee} starts stamped history at ${numeric} without exact compaction proof through ${numeric - 1}`,
        );
      }
    }
    if (priorSeq !== undefined && numeric !== priorSeq + 1) {
      throw new Error(`HSR event log for ${bee} has an internal sequence gap after ${priorSeq}`);
    }
    priorSeq = numeric;
  }
  if (watermark !== undefined && firstSeq !== undefined && firstSeq > watermark + 1) {
    throw new Error(`HSR event log for ${bee} lost an unacknowledged prefix before ${firstSeq}`);
  }
  if (watermark !== undefined && sourceCheckpoint !== undefined && sourceCheckpoint > watermark) {
    throw new Error(`HSR event log for ${bee} compacted beyond durable acknowledgement ${watermark}`);
  }
  const durableHigh = priorSeq ?? sourceCheckpoint ?? 0;
  if (durableHigh < state.lastSeq) {
    throw new Error(`HSR event log for ${bee} ends below durable high-water ${state.lastSeq}`);
  }
  return durableHigh;
}

/**
 * Load (and cache) a bee's seq state. Called only from the per-bee append
 * chain, so the seed read never races a stamped append. Legacy events.jsonl
 * files (pre-seq) scan to 0, so a fresh upgrade starts issuing at 1 with the
 * legacy events left as a seq-less prefix — readers tolerate both shapes.
 */
async function loadSeqState(bee: string): Promise<HsrSeqState> {
  const cached = seqStates.get(bee);
  if (cached) {
    // `appendChains` is process-local. The cross-process event-authority lock
    // prevents simultaneous writes, but does not make this cache coherent with
    // a serve process admitting/acking another durable consumer. Re-read the
    // small sidecar under that lock before every mutation and merge monotonic
    // authority, otherwise the next detached-host append can erase the new
    // consumer and let compaction advance past its cursor.
    const persisted = await readHsrSeqStateForWriterStrict(bee);
    if (!persisted) {
      if (effectiveConsumerWatermark(cached) !== undefined) {
        throw new Error(`HSR event sequence high-water for ${bee} is missing with durable consumer authority`);
      }
      return cached; // stamped source history can recover a best-effort sidecar.
    }
    const merged = mergeHsrSeqStates(cached, persisted);
    seqStates.set(bee, merged);
    return merged;
  }
  const persisted = await readHsrSeqStateForWriterStrict(bee);
  const proof = await validatedSourceAuthorityProofInLock(bee, persisted ?? { lastSeq: 0 });
  if (proof) {
    let state = persisted ?? { lastSeq: 0 };
    if (proof.throughSeq > state.lastSeq) state = { ...state, lastSeq: proof.throughSeq };
    if (!persisted || proof.throughSeq > persisted.lastSeq) await persistSeqState(bee, state);
    seqStates.set(bee, state);
    eventLogProofs.set(bee, proof.eventFile);
    return state;
  }
  const needsTrailingNewline = await eventLogNeedsTrailingNewline(bee);
  try {
    await foldHsrEventLogStrictInLock(bee, undefined, (value) => value, false);
  } catch (error) {
    if (needsTrailingNewline && /malformed record/.test(error instanceof Error ? error.message : String(error))) {
      throw new Error(`HSR event log for ${bee} contains a malformed trailing record`, { cause: error });
    }
    throw error;
  }
  if (needsTrailingNewline) {
    // The streaming validator above proved the complete final JSON record.
    // Append only its missing delimiter; never copy/materialize the retained
    // file merely to make the next append safe.
    await appendFile(hsrEventsPath(bee), "\n", { mode: 0o600 });
  }
  const state = seqStates.get(bee) ?? { lastSeq: 0 };
  eventLogProofs.set(bee, await readEventLogProof(bee));
  return state;
}

/**
 * Validate a local source log as event authority without requiring a remote
 * consumer admission. This joins the writer chain so an in-flight append
 * cannot manufacture a transient hole. It is intentionally read-only:
 * malformed, unreadable, internally holed, or high-water-short history is an
 * integrity failure for an already-running provider, not something an
 * observation pass may repair or reinterpret as absence.
 */
async function readHsrSourceEventLogStrictInChain(bee: string): Promise<RunnerEvent[]> {
  await sourceValidationAfterEventRead?.();
  const folded = await foldHsrEventLogStrictInLock<RunnerEvent[]>(bee, [], (events, event) => {
    events.push(event);
    return events;
  }, false);
  eventLogProofs.set(bee, await readEventLogProof(bee));
  return folded.value;
}

async function currentSourceAuthorityProofInLock(bee: string): Promise<HsrSourceAuthorityProof | null> {
  const persisted = await readHsrSeqStateForWriterStrict(bee);
  const cached = seqStates.get(bee);
  let state = persisted ?? cached ?? { lastSeq: 0 };
  if (persisted && cached) state = mergeHsrSeqStates(persisted, cached);
  const proof = await validatedSourceAuthorityProofInLock(bee, state);
  if (!proof) return null;
  if (proof.throughSeq > state.lastSeq) state = { ...state, lastSeq: proof.throughSeq };
  // A proven append-before-sidecar suffix is safe to heal. Preserve every
  // consumer admission/ack merged from this process and durable disk.
  if (!persisted || state.lastSeq > persisted.lastSeq) await persistSeqState(bee, state);
  seqStates.set(bee, state);
  eventLogProofs.set(bee, proof.eventFile);
  return proof;
}

async function validateHsrSourceEventLogStrictInChain(bee: string): Promise<void> {
  await sourceValidationAfterEventRead?.();
  if (await currentSourceAuthorityProofInLock(bee)) return;
  await foldHsrEventLogStrictInLock(bee, undefined, (value) => value, false);
  eventLogProofs.set(bee, await readEventLogProof(bee));
}

async function terminalEventStreamHighWaterInChain(bee: string, meta: HsrMeta): Promise<number> {
  const cached = await currentSourceAuthorityProofInLock(bee);
  if (cached) {
    const terminal = cached.lastStamped;
    if (!terminal || terminal.type !== "exit" || terminal.seq !== cached.throughSeq || cached.throughSeq <= 0) {
      throw new Error(`HSR event stream for ${bee} has no terminal stamped exit at high-water ${cached.throughSeq}`);
    }
    const host = terminal.host;
    if (
      !host
      || host.hostPid !== meta.hostPid
      || host.startedAt !== meta.startedAt
      || !sameProcessBirthFingerprint(host.hostFingerprint, meta.hostFingerprint)
    ) {
      throw new Error(`HSR event stream closure for ${bee} does not belong to its host incarnation`);
    }
    return cached.throughSeq;
  }
  const folded = await foldHsrEventLogStrictInLock<RunnerEvent | undefined>(
    bee,
    undefined,
    (terminal, event) => event.seq === undefined ? terminal : event,
    false,
  );
  const highWater = folded.throughSeq;
  const terminal = folded.value;
  if (!terminal || terminal.type !== "exit" || terminal.seq !== highWater || highWater <= 0) {
    throw new Error(`HSR event stream for ${bee} has no terminal stamped exit at high-water ${highWater}`);
  }
  const host = terminal.host;
  if (
    !host
    || host.hostPid !== meta.hostPid
    || host.startedAt !== meta.startedAt
    || !sameProcessBirthFingerprint(host.hostFingerprint, meta.hostFingerprint)
  ) {
    throw new Error(`HSR event stream closure for ${bee} does not belong to its host incarnation`);
  }
  return highWater;
}

/**
 * Seal a clean source exit under the same cross-process authority as append.
 * The returned proof is safe to publish in meta only after this call returns.
 */
export function sealHsrEventStreamClosure(
  bee: string,
  meta: HsrMeta,
  timeoutMs = 120_000,
): Promise<HsrEventStreamClosure> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => ({
      version: 1 as const,
      lastSeq: await terminalEventStreamHighWaterInChain(bee, meta),
      closedAt: new Date().toISOString(),
    }), timeoutMs));
  const next = result.then(() => undefined, () => undefined);
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

/** Revalidate a meta-carried clean-exit proof against current durable bytes. */
export function verifyHsrEventStreamClosure(
  bee: string,
  meta: HsrMeta,
  timeoutMs = 120_000,
): Promise<boolean> {
  if (!meta.eventStreamClosure || !validHsrEventStreamClosureShape(meta as unknown as Record<string, unknown>)) {
    return Promise.resolve(false);
  }
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () =>
      await terminalEventStreamHighWaterInChain(bee, meta) === meta.eventStreamClosure!.lastSeq, timeoutMs));
  const next = result.then(() => undefined, () => undefined);
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

export function validateHsrSourceEventLogStrict(bee: string): Promise<void> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, () => validateHsrSourceEventLogStrictInChain(bee), 250));
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
 * Authority-grade local observation snapshot. Validation and parsing happen
 * while holding the same cross-process event lock as append + seq commit, so
 * observers can never validate one prefix and then tolerantly skip a partial
 * record from a later in-flight append.
 */
export function readHsrSourceEventsStrict(bee: string): Promise<RunnerEvent[]> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, () => readHsrSourceEventLogStrictInChain(bee), 250));
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

// Per-bee events.jsonl byte size, tracked by the single writer so the growth
// check is O(1) per append (lazily seeded by one stat, then incremented).
const eventLogSizes = new Map<string, number>();

// events.jsonl growth bounds (HIVE-13). With no lagging durable consumer, once
// the log crosses MAX_BYTES the writer compacts it down to a tail of at most
// COMPACT_KEEP_LINES lines / COMPACT_TARGET_BYTES bytes, folding the dropped
// prefix into checkpoint events (see compactHsrEvents). A slow consumer pins
// its unacked suffix and can therefore make the file exceed this normal cap;
// authority-grade validation/list/closure paths stream that backlog, while
// exact replay consumes bounded pages. Derived state survives either shape.
export const HSR_EVENTS_MAX_BYTES = 1024 * 1024;
export const HSR_EVENTS_COMPACT_KEEP_LINES = 400;
export const HSR_EVENTS_COMPACT_TARGET_BYTES = 512 * 1024;

export type HsrEventsCompactLimits = {
  keepLines: number;
  targetBytes: number;
  /** Test/diagnostic barrier after the exact snapshot read, before replacement. */
  afterSnapshotRead?: () => Promise<void> | void;
};

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
 * Internal in-chain implementation. Public callers use compactHsrEvents below,
 * which joins the same per-bee chain as appends; appendHsrEvent already owns the
 * chain and calls this implementation directly. The atomic replace means
 * concurrent READERS see either the old or the new file, never a tear.
 */
async function compactHsrEventsInChain(
  bee: string,
  limits: HsrEventsCompactLimits = { keepLines: HSR_EVENTS_COMPACT_KEEP_LINES, targetBytes: HSR_EVENTS_COMPACT_TARGET_BYTES },
): Promise<void> {
  let raw: string;
  try {
    raw = await readWholeHsrEventLog(bee);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // nothing to compact
    throw new Error(`HSR event log for ${bee} is unreadable before compaction`, { cause: error });
  }
  await limits.afterSnapshotRead?.();
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
  let seqState = await loadSeqState(bee);
  // Source logs without a remote consumer are still authority for already
  // applied provider events. Validate their complete retained stamped suffix
  // too: consumer watermarks affect only the safe compaction floor, not
  // whether malformed/internal-holed history may be silently folded away.
  const durableHigh = validateDurableConsumerEventLog(bee, raw, seqState);
  if (durableHigh > seqState.lastSeq) {
    const reconciled = { ...seqState, lastSeq: durableHigh };
    await persistSeqState(bee, reconciled);
    seqStates.set(bee, reconciled);
    seqState = reconciled;
  }
  const watermark = seqState ? effectiveConsumerWatermark(seqState) : undefined;
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
  // Current lifecycle authority is host-epoch scoped. A folded predecessor's
  // needs/exhaustion/turn marker must never be moved across the latest host
  // boundary and grafted onto its successor. Locate the newest boundary in the
  // whole file first; only state facts at/after it may be checkpointed.
  let latestHostEpoch: { index: number; line: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "host_epoch") {
        latestHostEpoch = { index: i, line: lines[i]! };
      }
    } catch {
      // The ordinary compactor already treats torn prefix lines as droppable.
    }
  }
  const currentAuthorityFloor = latestHostEpoch?.index ?? 0;
  const mirrorMeta = await readHsrMeta(bee);
  const mirrorGeneration = mirrorMeta?.mirrorOfNode
    && mirrorMeta.mirrorRemoteLaunchId
    && mirrorMeta.mirrorRemoteIncarnation
    ? {
        node: mirrorMeta.mirrorOfNode,
        remoteLaunchId: mirrorMeta.mirrorRemoteLaunchId,
        remoteIncarnation: mirrorMeta.mirrorRemoteIncarnation,
      }
    : undefined;
  if (mirrorGeneration) {
    let verifiedThrough = 0;
    let sawOriginCheckpoint = false;
    for (const line of lines) {
      let event: RunnerEvent;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
          throw new Error("not an event object");
        }
        event = parsed as RunnerEvent;
      } catch (error) {
        throw new Error(`remote mirror event log for ${bee} is malformed before compaction`, { cause: error });
      }
      if (event.type === "remote_cursor_checkpoint") {
        if (
          sawOriginCheckpoint
          || event.node !== mirrorGeneration.node
          || event.remoteLaunchId !== mirrorGeneration.remoteLaunchId
          || event.remoteIncarnation !== mirrorGeneration.remoteIncarnation
          || !Number.isSafeInteger(event.throughRemoteSeq)
          || event.throughRemoteSeq <= 0
          || verifiedThrough !== 0
        ) {
          throw new Error(`remote mirror compaction proof for ${bee} is invalid or belongs to another generation`);
        }
        sawOriginCheckpoint = true;
        verifiedThrough = event.throughRemoteSeq;
        continue;
      }
      if (event.remoteSeq === undefined) continue;
      if (!Number.isSafeInteger(event.remoteSeq) || event.remoteSeq !== verifiedThrough + 1) {
        throw new Error(
          `remote mirror origin sequence for ${bee} is non-contiguous at ${String(event.remoteSeq)}`,
        );
      }
      verifiedThrough = event.remoteSeq;
    }
  }
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
  let latestExhausted: { index: number; ts: number; line: string } | undefined;
  let lastTurnStarts = new Map<string, { index: number; line: string }>();
  let lastTurnEnds = new Map<string, { index: number; line: string }>();
  let lastToolUse: { index: number; line: string } | undefined;
  let lastNeedsInput: { index: number; line: string } | undefined;
  let lastAuthNeeded: { index: number; line: string } | undefined;
  let lastAuthResume: { index: number; line: string } | undefined;
  let lastText: { index: number; ts: number; host?: RunnerEvent["host"] } | undefined;
  let compactedRemoteSeq = 0;
  let compactedRemoteTs = 0;
  let compactedSourceSeq = 0;
  let compactedSourceTs = 0;
  for (let i = 0; i < keepStart; i++) {
    let event: RunnerEvent;
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") continue;
      event = parsed as RunnerEvent;
    } catch {
      continue; // torn / partial line — drop it
    }
    if (event.type === "source_cursor_checkpoint") {
      compactedSourceSeq = event.throughSeq;
      compactedSourceTs = Number.isFinite(event.ts) ? event.ts : compactedSourceTs;
    } else if (Number.isSafeInteger(event.seq) && Number(event.seq) > compactedSourceSeq) {
      compactedSourceSeq = Number(event.seq);
      compactedSourceTs = Number.isFinite(event.ts) ? event.ts : compactedSourceTs;
    }
    if (mirrorGeneration) {
      if (Number.isSafeInteger(event.remoteSeq) && Number(event.remoteSeq) > compactedRemoteSeq) {
        compactedRemoteSeq = Number(event.remoteSeq);
        compactedRemoteTs = Number.isFinite(event.ts) ? event.ts : compactedRemoteTs;
      }
      if (
        event.type === "remote_cursor_checkpoint"
        && event.node === mirrorGeneration.node
        && event.remoteLaunchId === mirrorGeneration.remoteLaunchId
        && event.remoteIncarnation === mirrorGeneration.remoteIncarnation
        && Number.isSafeInteger(event.throughRemoteSeq)
        && event.throughRemoteSeq > compactedRemoteSeq
      ) {
        compactedRemoteSeq = event.throughRemoteSeq;
        compactedRemoteTs = Number.isFinite(event.ts) ? event.ts : compactedRemoteTs;
      }
    }
    const isCurrentAuthority = i >= currentAuthorityFloor;
    if (isCurrentAuthority && event.type === "turn_start") {
      lastTurnStarts.set(lifecycleScopeKey(event), { index: i, line: lines[i]! });
    } else if (isCurrentAuthority && event.type === "turn_end") {
      lastTurnEnds.set(lifecycleScopeKey(event), { index: i, line: lines[i]! });
    } else if (isCurrentAuthority && event.type === "tool_use") {
      lastToolUse = { index: i, line: lines[i]! };
    } else if (isCurrentAuthority && event.type === "needs_input") {
      lastNeedsInput = { index: i, line: lines[i]! };
    } else if (
      isCurrentAuthority
      && (
        (event.type === "error" && isRunnerAuthNeededMessage(event.message))
        || (event.type === "auth_expired" && event.requiresLogin)
      )
    ) {
      lastAuthNeeded = { index: i, line: lines[i]! };
    } else if (isCurrentAuthority && event.type === "auth_resume") {
      lastAuthResume = { index: i, line: lines[i]! };
    } else if (isCurrentAuthority && event.type === "text") {
      if (event.text.length > 0) {
        lastText = {
          index: i,
          ts: typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : 0,
          ...(event.host ? { host: event.host } : {}),
        };
      }
    }
    if (event.type === "usage") {
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
    } else if (isCurrentAuthority && event.type === "exhausted") {
      const ts = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : 0;
      if (!latestExhausted || ts >= latestExhausted.ts) {
        latestExhausted = { index: i, ts, line: lines[i]! };
      }
    }
  }
  const checkpoint: string[] = [];
  if (compactedSourceSeq > 0) {
    checkpoint.push(JSON.stringify({
      type: "source_cursor_checkpoint",
      ts: compactedSourceTs,
      throughSeq: compactedSourceSeq,
    } satisfies RunnerEvent));
  }
  if (mirrorGeneration && compactedRemoteSeq > 0) {
    checkpoint.push(JSON.stringify({
      type: "remote_cursor_checkpoint",
      ts: compactedRemoteTs,
      throughRemoteSeq: compactedRemoteSeq,
      ...mirrorGeneration,
    } satisfies RunnerEvent));
  }
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
  // Turn/needs markers in original relative order — observers derive state
  // from the LAST marker per root thread, so this keeps the derivation exact
  // even when Codex collaboration sub-threads emit their own lifecycle markers.
  const currentStateMarkers = [
    latestExhausted,
    ...lastTurnStarts.values(),
    ...lastTurnEnds.values(),
    lastToolUse,
    lastNeedsInput,
    lastAuthNeeded,
    lastAuthResume,
  ].filter(
    (marker): marker is { index: number; line: string } => marker !== undefined,
  );
  const textMarker = currentStateMarkers.length === 0 && lastText !== undefined
    ? {
        index: lastText.index,
        line: JSON.stringify({
          type: "text",
          ts: lastText.ts,
          text: "…",
          ...(lastText.host ? { host: lastText.host } : {}),
        } satisfies RunnerEvent),
      }
    : undefined;
  const markers = [
    latestHostEpoch && latestHostEpoch.index < keepStart ? latestHostEpoch : undefined,
    ...currentStateMarkers,
    textMarker,
  ].filter(
    (marker): marker is { index: number; line: string } => marker !== undefined,
  );
  markers.sort((a, b) => a.index - b.index);
  checkpoint.push(...markers.map((marker) => stripSeqFromLine(marker.line)));
  const content = `${[...checkpoint, ...lines.slice(keepStart)].join("\n")}\n`;
  await atomicWriteFile(hsrEventsPath(bee), content, { mode: 0o600 });
  eventLogSizes.set(bee, Buffer.byteLength(content, "utf8"));
  eventLogProofs.set(bee, await readEventLogProof(bee));
  sourceAuthorityProofs.delete(bee);
  await rm(hsrSourceProofPath(bee), { force: true }).catch(() => undefined);
}

/**
 * Serialize an explicit/manual compaction with every append/ack/strict-reader
 * mutation for this bee. Without this barrier a command-side compactor could
 * atomically replace from an older snapshot after a new stamped append landed,
 * deleting an issued event and manufacturing a permanent cursor gap.
 */
export function compactHsrEvents(
  bee: string,
  limits: HsrEventsCompactLimits = { keepLines: HSR_EVENTS_COMPACT_KEEP_LINES, targetBytes: HSR_EVENTS_COMPACT_TARGET_BYTES },
): Promise<void> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev.catch(() => undefined).then(() => (
    withHsrEventAuthorityLock(bee, () => compactHsrEventsInChain(bee, limits))
  ));
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
 * HSR_EVENTS_MAX_BYTES it is compacted in-chain when the durable consumer
 * floor permits material progress. A lagging consumer intentionally pins the
 * unacked suffix; streaming authority readers and bounded replay pages keep
 * that backpressure from becoming an allocation or RPC-size failure.
 */
export function appendHsrEvent(bee: string, event: RunnerEvent): Promise<void> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      const priorProof = eventLogProofs.get(bee);
      if (priorProof !== undefined) {
        const currentProof = await readEventLogProof(bee);
        if (!sameEventLogProof(priorProof, currentProof)) {
          await validateHsrSourceEventLogStrictInChain(bee);
        }
      } else if (seqStates.has(bee)) {
        await validateHsrSourceEventLogStrictInChain(bee);
      }
      const seqState = await loadSeqState(bee);
      const priorAuthorityProof = sourceAuthorityProofs.get(bee);
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
      const currentEventProof = await readEventLogProof(bee);
      eventLogProofs.set(bee, currentEventProof);
      let projection = priorAuthorityProof?.projection;
      if (stamped.type === "host_epoch") {
        const meta = await readHsrMeta(bee);
        if (projection && !sourceProjectionMatches(projection, stamped.host, meta?.sessionId)) {
          projection = advanceSourceProjectionHostEpoch(projection, stamped.host, meta?.sessionId);
        } else if (!projection && priorAuthorityProof?.eventCount === 0) {
          // A genuinely empty source can establish its first incremental
          // projection immediately. If a nonempty source has lost its derived
          // proof, leave the projection absent so the next list read performs
          // one strict rebuild instead of inventing zero historical usage.
          projection = emptySourceProjection(stamped.host, meta?.sessionId);
        }
      }
      if (projection) {
        projection = foldSourceProjection(projection, stamped, priorAuthorityProof?.eventCount ?? 0);
      }
      await persistSourceAuthorityProof(bee, {
        version: 1,
        eventFile: currentEventProof,
        throughSeq: candidate,
        eventCount: (priorAuthorityProof?.eventCount ?? 0) + 1,
        stampedCount: (priorAuthorityProof?.stampedCount ?? Math.max(0, candidate - 1)) + 1,
        lastStamped: tailProofOf(stamped)!,
        ...(projection ? { projection } : {}),
      }).catch(() => undefined);
      if (size > HSR_EVENTS_MAX_BYTES) {
        const watermark = effectiveConsumerWatermark(seqState);
        // Backpressure deliberately lets the source log exceed its normal cap.
        // When the slowest consumer is farther than the compactor's bounded
        // retained tail from the high-water, compaction cannot bring the file
        // back under its target: it must retain that whole unacked suffix. Do
        // not readFile/split the ever-growing backlog after every append. Once
        // every consumer catches into the tail window, one compaction pass can
        // make material progress; local/no-consumer logs retain their ordinary
        // bounded behavior.
        if (
          watermark === undefined
          || (watermark > 0 && watermark >= Math.max(1, seqState.lastSeq - HSR_EVENTS_COMPACT_KEEP_LINES))
        ) {
          await compactHsrEventsInChain(bee).catch(() => undefined);
        }
      }
    }));
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
export function ackHsrEvents(bee: string, upToSeq: number, consumerId?: string): Promise<number> {
  if (consumerId !== undefined && !validHsrConsumerId(consumerId)) {
    return Promise.reject(new Error(`HSR event consumer id for ${bee} is malformed`));
  }
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      const seqState = await loadSeqState(bee);
      if (consumerId !== undefined) {
        const prior = seqState.consumers?.[consumerId];
        if (!prior) throw new Error(`HSR event consumer ${consumerId} for ${bee} is not admitted`);
        const target = Math.min(Math.max(Math.floor(upToSeq), prior.ackedSeq ?? 0), seqState.lastSeq);
        if (target > (prior.ackedSeq ?? 0)) {
          const consumers = {
            ...seqState.consumers,
            [consumerId]: { ackedSeq: target },
          };
          await persistSeqState(bee, { ...seqState, consumers });
          seqState.consumers = consumers;
        }
        return seqState.consumers?.[consumerId]?.ackedSeq ?? 0;
      }
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
    }));
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

function withoutConsumer(state: HsrSeqState, consumerId: string): HsrSeqState {
  const consumers = { ...state.consumers };
  delete consumers[consumerId];
  const { consumers: _priorConsumers, ...rest } = state;
  return {
    ...rest,
    ...(Object.keys(consumers).length > 0 ? { consumers } : {}),
    consumerRevision: (state.consumerRevision ?? 0) + 1,
  };
}

export type HsrPendingEventConsumer = {
  consumerId: string;
  ackedSeq: number;
  throughSeq: number;
};

/** Exact durable consumers which still pin a stopped source's retained suffix. */
export async function readPendingHsrEventConsumers(
  bee: string,
  terminalActivations: Readonly<Record<string, { throughSeq: number }>> = {},
): Promise<HsrPendingEventConsumer[]> {
  await drainHsrEventWrites(bee);
  return withHsrEventAuthorityLock(bee, async () => {
    const state = await readHsrSeqStateForWriterStrict(bee);
    if (!state) return [];
    const consumers = Object.entries(state.consumers ?? {})
      .map(([consumerId, consumer]) => ({
        consumerId,
        ackedSeq: consumer.ackedSeq ?? 0,
        throughSeq: state.lastSeq,
      }))
      .filter((consumer) => (
        consumer.ackedSeq < consumer.throughSeq
        || (terminalActivations[consumer.consumerId]?.throughSeq ?? 0) < consumer.throughSeq
      ));
    if (state.lastSeq > 0 && (state.subscribed || state.ackedSeq !== undefined)) {
      consumers.push({
        consumerId: HSR_LEGACY_EVENT_CONSUMER_ID,
        ackedSeq: state.ackedSeq ?? 0,
        throughSeq: state.lastSeq,
      });
    }
    return consumers.sort((left, right) => left.consumerId.localeCompare(right.consumerId));
  });
}

export type HsrConsumerDiscardResult = {
  consumerId: string;
  ackedSeq: number;
  throughSeq: number;
  lostFromSeq?: number;
  lostToSeq?: number;
};

type HsrConsumerDiscardEvidence = HsrConsumerDiscardResult & {
  version: 1;
  bee: string;
  authority: { launchId: string; incarnation: string };
  discardedAt: string;
};

async function readHsrConsumerDiscardEvidence(
  bee: string,
  consumerId: string,
  authority: { launchId: string; incarnation: string },
): Promise<HsrConsumerDiscardEvidence | null> {
  let raw: string;
  try {
    raw = await readFile(hsrEventConsumerDiscardEvidencePath(bee, authority, consumerId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`HSR event consumer discard evidence for ${bee}/${consumerId} is malformed`, { cause: error });
  }
  const evidence = parsed as Partial<HsrConsumerDiscardEvidence> | null;
  if (
    !evidence || evidence.version !== 1 || evidence.bee !== bee || evidence.consumerId !== consumerId
    || evidence.authority?.launchId !== authority.launchId
    || evidence.authority.incarnation !== authority.incarnation
    || !Number.isSafeInteger(evidence.ackedSeq) || Number(evidence.ackedSeq) < 0
    || !Number.isSafeInteger(evidence.throughSeq) || Number(evidence.throughSeq) < Number(evidence.ackedSeq)
    || typeof evidence.discardedAt !== "string" || evidence.discardedAt.length === 0
    || ((evidence.lostFromSeq === undefined) !== (evidence.lostToSeq === undefined))
    || (evidence.lostFromSeq !== undefined && (
      !Number.isSafeInteger(evidence.lostFromSeq) || evidence.lostFromSeq !== Number(evidence.ackedSeq) + 1
      || !Number.isSafeInteger(evidence.lostToSeq) || evidence.lostToSeq !== evidence.throughSeq
    ))
  ) {
    throw new Error(`HSR event consumer discard evidence for ${bee}/${consumerId} is malformed`);
  }
  return evidence as HsrConsumerDiscardEvidence;
}

/**
 * Explicit history-loss settlement for a stopped source. The caller owns
 * generation/token authorization; this storage primitive records the exact
 * discarded range before removing the durable compaction pin.
 */
export function discardHsrEventConsumer(
  bee: string,
  consumerId: string,
  authority: { launchId: string; incarnation: string },
): Promise<HsrConsumerDiscardResult> {
  if (!validHsrConsumerId(consumerId)) {
    return Promise.reject(new Error(`HSR event consumer id for ${bee} is malformed`));
  }
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev.catch(() => undefined).then(() => withHsrEventAuthorityLock(bee, async () => {
    const state = await loadSeqState(bee);
    const legacy = consumerId === HSR_LEGACY_EVENT_CONSUMER_ID;
    const consumer = legacy
      ? (state.subscribed || state.ackedSeq !== undefined ? { ackedSeq: state.ackedSeq } : undefined)
      : state.consumers?.[consumerId];
    if (!consumer) {
      const prior = await readHsrConsumerDiscardEvidence(bee, consumerId, authority);
      if (prior) {
        return {
          consumerId,
          ackedSeq: prior.ackedSeq,
          throughSeq: prior.throughSeq,
          ...(prior.lostFromSeq !== undefined
            ? { lostFromSeq: prior.lostFromSeq, lostToSeq: prior.lostToSeq }
            : {}),
        };
      }
      throw new Error(`HSR event consumer ${consumerId} for ${bee} is not admitted`);
    }
    const ackedSeq = consumer.ackedSeq ?? 0;
    const throughSeq = state.lastSeq;
    const discardedAt = new Date().toISOString();
    const evidence = {
      version: 1,
      bee,
      consumerId,
      authority,
      ackedSeq,
      throughSeq,
      ...(ackedSeq < throughSeq ? { lostFromSeq: ackedSeq + 1, lostToSeq: throughSeq } : {}),
      discardedAt,
    };
    const membership = legacy
      ? (() => {
          const { subscribed: _subscribed, ackedSeq: _ackedSeq, ...rest } = state;
          return { ...rest, consumerRevision: (state.consumerRevision ?? 0) + 1 };
        })()
      : withoutConsumer(state, consumerId);
    const updated = {
      ...membership,
      consumerDiscards: {
        ...state.consumerDiscards,
        [consumerId]: { throughSeq, discardedAt },
      },
    };
    // Audit the exact operator decision outside the disposable run directory
    // before removing its compaction pin. If either write fails, the source
    // bytes remain retained and the command can be retried safely.
    await atomicWriteFile(
      hsrEventConsumerDiscardEvidencePath(bee, authority, consumerId),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    await persistSeqState(bee, updated);
    seqStates.set(bee, updated);
    return {
      consumerId,
      ackedSeq,
      throughSeq,
      ...(ackedSeq < throughSeq ? { lostFromSeq: ackedSeq + 1, lostToSeq: throughSeq } : {}),
    };
  }));
  const next = result.then(() => undefined, () => undefined);
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
 * UNBOUNDED-GROWTH NOTE: once subscribed, a consumer remains durable across
 * relay unobserve and controller shutdown. It must protect events emitted while
 * that controller is offline, even if it was caught up when the relay closed.
 * A controller that will never return requires the explicit stopped-generation
 * `hsr-reconcile --discard-consumer` history-loss decision.
 */
export function markHsrConsumerSubscribed(bee: string, consumerId?: string): Promise<void> {
  if (consumerId !== undefined && !validHsrConsumerId(consumerId)) {
    return Promise.reject(new Error(`HSR event consumer id for ${bee} is malformed`));
  }
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      const seqState = await loadSeqState(bee);
      if (consumerId !== undefined) {
        if (seqState.consumers?.[consumerId]) return;
        const consumers = { ...seqState.consumers, [consumerId]: {} };
        const updated: HsrSeqState = {
          ...seqState,
          consumers,
          ...(seqState.consumerRevision !== undefined
            ? { consumerRevision: seqState.consumerRevision + 1 }
            : {}),
        };
        await persistSeqState(bee, updated);
        seqState.consumers = consumers;
        seqState.consumerRevision = updated.consumerRevision;
        return;
      }
      if (seqState.subscribed) return; // already active — idempotent
      await persistSeqState(bee, { ...seqState, subscribed: true });
      seqState.subscribed = true;
    }));
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
 * Authority-grade variant used before admitting an exact remote observer.
 * Unlike `markHsrConsumerSubscribed`, this must not heal unreadable/corrupt
 * disk state through the tolerant writer cache: doing so could overwrite the
 * only evidence of an issued-but-missing event and falsely report caught up.
 * Only a genuinely empty fresh log with no seq.json may initialize at zero.
 */
export function markHsrConsumerSubscribedStrict(
  bee: string,
  consumerId?: string,
  afterSeq = 0,
): Promise<void> {
  if (consumerId !== undefined && !validHsrConsumerId(consumerId)) {
    return Promise.reject(new Error(`HSR event consumer id for ${bee} is malformed`));
  }
  if (consumerId === HSR_LEGACY_EVENT_CONSUMER_ID) {
    return Promise.reject(new Error(`HSR event consumer id for ${bee} is reserved for legacy reconciliation`));
  }
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    return Promise.reject(new Error(`HSR event consumer cursor for ${bee} must be a non-negative safe integer`));
  }
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      const persistedBefore = await readHsrSeqStateForWriterStrict(bee);
      const cachedProof = await currentSourceAuthorityProofInLock(bee);
      const folded = cachedProof
        ? {
            value: { records: cachedProof.eventCount, stamped: cachedProof.stampedCount },
            throughSeq: cachedProof.throughSeq,
          }
        : await foldHsrEventLogStrictInLock(
            bee,
            { records: 0, stamped: 0 },
            (summary, event) => ({
              records: summary.records + 1,
              stamped: summary.stamped + (event.seq === undefined ? 0 : 1),
            }),
            false,
          );
      // A purely legacy nonempty file has no durable cursor identity to offer
      // a newly admitted exact observer. Preserve the pre-streaming behavior:
      // stamped history can reconstruct a lost sidecar, but legacy-only bytes
      // require an explicit migration boundary rather than cursor laundering.
      if (!persistedBefore && folded.value.records > 0 && folded.value.stamped === 0) {
          throw new Error(`HSR event sequence high-water for ${bee} is missing beside a legacy-only log`);
      }
      const state = seqStates.get(bee) ?? persistedBefore ?? { lastSeq: folded.throughSeq };
      if (afterSeq > state.lastSeq) {
        throw new Error(`HSR event consumer cursor ${afterSeq} for ${bee} is ahead of durable high-water ${state.lastSeq}`);
      }
      const consumerChanged = consumerId !== undefined && state.consumers?.[consumerId] === undefined;
      const priorConsumer = consumerId === undefined ? undefined : state.consumers?.[consumerId];
      const admittedAck = Math.max(priorConsumer?.ackedSeq ?? 0, afterSeq);
      const subscribed: HsrSeqState = consumerId === undefined
        ? { ...state, subscribed: true }
        : {
            ...state,
            consumers: {
              ...state.consumers,
              [consumerId]: admittedAck > 0 ? { ackedSeq: admittedAck } : priorConsumer ?? {},
            },
            ...(consumerChanged && state.consumerRevision !== undefined
              ? { consumerRevision: state.consumerRevision + 1 }
              : {}),
          };
      await persistSeqState(bee, subscribed);
      seqStates.set(bee, subscribed);
    }));
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

/** Wire-sized exact replay page. A single event may consume the whole page. */
export const HSR_EVENT_REPLAY_PAGE_MAX_EVENTS = 128;
export const HSR_EVENT_REPLAY_PAGE_TARGET_BYTES = 256 * 1024;
// The RPC server's request-frame ceiling is 8MiB. Keep one provider event well
// below that so the response envelope can never become an unbounded JSON line.
export const HSR_EVENT_REPLAY_MAX_EVENT_BYTES = 4 * 1024 * 1024;

export type HsrEventsReplayPage = HsrEventsAfterSeq & {
  /** Last source seq represented by this page (or the unchanged request cursor). */
  throughSeq: number;
  /** More events remain in the immutable file snapshot opened for this replay. */
  hasMore: boolean;
  /** Opaque process-local continuation for the same immutable snapshot. */
  pageToken?: string;
};

/** A lost/expired continuation is retryable from the durable seq cursor. */
export class HsrEventReplayPageTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HsrEventReplayPageTokenError";
  }
}

type BoundedEventLogLine = { line: string; bytes: number };
type HsrEventReplaySession = {
  token: string;
  bee: string;
  consumerId?: string;
  cursor: number;
  state: HsrSeqState;
  file?: FileHandle;
  stream?: ReadStream;
  lines: AsyncIterator<BoundedEventLogLine>;
  sourceCheckpoint?: number;
  firstSeq?: number;
  priorSeq?: number;
  sawStampedEvent: boolean;
  pending?: { event: RunnerEvent; bytes: number };
  gap?: HsrSeqGap;
  timer?: NodeJS.Timeout;
  closed: boolean;
};

const replaySessions = new Map<string, HsrEventReplaySession>();
const HSR_EVENT_REPLAY_SESSION_TTL_MS = 5 * 60_000;
const HSR_EVENT_REPLAY_MAX_OPEN_SESSIONS = 256;
let replayPageAfterSessionClaim: ((bee: string, pageToken?: string) => Promise<void> | void) | undefined;

/** @internal deterministic active-continuation eviction barrier. */
export function __testOnlySetReplayPageAfterSessionClaim(
  hook: ((bee: string, pageToken?: string) => Promise<void> | void) | undefined,
): void {
  replayPageAfterSessionClaim = hook;
}

/** @internal release every retained immutable replay snapshot between tests. */
export async function __testOnlyClearHsrEventReplaySessions(): Promise<void> {
  await Promise.all([...replaySessions.values()].map((session) => closeHsrEventReplaySession(session)));
}

async function* boundedEventLogLines(stream: ReadStream, bee: string): AsyncGenerator<BoundedEventLogLine> {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk));
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const bytes = newline + 1;
      if (newline > HSR_EVENT_REPLAY_MAX_EVENT_BYTES) {
        throw new Error(`HSR event log for ${bee} contains an event too large for exact replay`);
      }
      const body = pending.subarray(0, newline);
      pending = pending.subarray(bytes);
      yield { line: body.toString("utf8").replace(/\r$/, ""), bytes };
    }
    if (pending.length > HSR_EVENT_REPLAY_MAX_EVENT_BYTES) {
      throw new Error(`HSR event log for ${bee} contains an event too large for exact replay`);
    }
  }
  if (pending.length > 0) {
    if (pending.length > HSR_EVENT_REPLAY_MAX_EVENT_BYTES) {
      throw new Error(`HSR event log for ${bee} contains an event too large for exact replay`);
    }
    yield { line: pending.toString("utf8").replace(/\r$/, ""), bytes: pending.length };
  }
}

async function closeHsrEventReplaySession(session: HsrEventReplaySession): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  replaySessions.delete(session.token);
  if (session.timer) clearTimeout(session.timer);
  await session.lines.return?.().catch(() => undefined);
  session.stream?.destroy();
  await session.file?.close().catch(() => undefined);
}

function retainHsrEventReplaySession(session: HsrEventReplaySession): void {
  if (session.timer) clearTimeout(session.timer);
  replaySessions.delete(session.token); // refresh insertion order for LRU eviction
  if (replaySessions.size >= HSR_EVENT_REPLAY_MAX_OPEN_SESSIONS) {
    const oldest = replaySessions.values().next().value as HsrEventReplaySession | undefined;
    if (oldest) void closeHsrEventReplaySession(oldest);
  }
  replaySessions.set(session.token, session);
  session.timer = setTimeout(() => {
    void closeHsrEventReplaySession(session);
  }, HSR_EVENT_REPLAY_SESSION_TTL_MS);
  session.timer.unref?.();
}

async function emptyEventLogLines(): Promise<AsyncGenerator<BoundedEventLogLine>> {
  return (async function* (): AsyncGenerator<BoundedEventLogLine> {})();
}

/**
 * Establish the exact source high-water before judging a replay cursor.
 *
 * The event append is the authority and deliberately precedes the best-effort
 * seq.json write. A serve process can therefore restart with a controller
 * cursor at N+1 while the sidecar still says N. Rejecting that cursor before
 * consulting the source proof/log makes the only exact recovery path
 * unreachable. This helper runs under the cross-process event-authority lock:
 * it uses the O(1) proof when it matches the immutable bytes, otherwise performs
 * the same strict checkpoint/contiguous-suffix fold as source validation, then
 * durably heals the sidecar while monotonically preserving disk/cache consumer
 * membership and acknowledgements.
 */
async function strictReplaySeqStateInLock(bee: string): Promise<HsrSeqState> {
  const persistedBefore = await readStrictSeqStateInEventLock(bee);
  const cachedBefore = seqStates.get(bee);
  const expected = cachedBefore
    ? mergeHsrSeqStates(persistedBefore, cachedBefore)
    : persistedBefore;

  const proof = await currentSourceAuthorityProofInLock(bee);
  const durableHigh = proof?.throughSeq ?? (await foldHsrEventLogStrictInLock(
    bee,
    undefined,
    (value) => value,
    false,
  )).throughSeq;
  if (durableHigh < expected.lastSeq) {
    throw new Error(`HSR event log for ${bee} ends below durable high-water ${expected.lastSeq}`);
  }

  const persistedAfter = await readStrictSeqStateInEventLock(bee);
  const cachedAfter = seqStates.get(bee);
  let current = mergeHsrSeqStates(expected, persistedAfter);
  if (cachedAfter) current = mergeHsrSeqStates(current, cachedAfter);
  if (current.lastSeq > durableHigh) {
    throw new Error(`HSR event log for ${bee} ends below durable high-water ${current.lastSeq}`);
  }
  if (durableHigh > current.lastSeq) current = { ...current, lastSeq: durableHigh };

  if (JSON.stringify(current) !== JSON.stringify(persistedAfter)) {
    await persistSeqState(bee, current);
  }
  seqStates.set(bee, current);
  if (proof) eventLogProofs.set(bee, proof.eventFile);
  return current;
}

async function openHsrEventReplaySession(
  bee: string,
  cursor: number,
  consumerId?: string,
): Promise<HsrEventReplaySession> {
  // Heal an append-before-sidecar suffix before admission/cursor comparison.
  // The caller holds the event-authority lock, so this proof and the following
  // immutable snapshot open are one exact storage transaction.
  const state = await strictReplaySeqStateInLock(bee);
  const admitted = consumerId !== undefined
    ? state.consumers?.[consumerId] !== undefined
    : state.subscribed === true;
  if (!admitted) {
    throw new Error(
      consumerId === undefined
        ? `HSR event sequence state for ${bee} is not subscribed`
        : `HSR event consumer ${consumerId} for ${bee} is not admitted`,
    );
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > state.lastSeq) {
    throw new Error(`HSR event resume cursor ${cursor} for ${bee} exceeds durable high-water ${state.lastSeq}`);
  }
  let file: FileHandle | undefined;
  try {
    file = await open(hsrEventsPath(bee), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`HSR event log for ${bee} is unreadable`, { cause: error });
    }
    if (state.lastSeq > 0) throw new Error(`HSR event log for ${bee} is missing below durable high-water ${state.lastSeq}`);
  }
  let stream: ReadStream | undefined;
  let lines: AsyncIterator<BoundedEventLogLine>;
  if (file) {
    const snapshotSize = (await file.stat()).size;
    if (snapshotSize > 0) {
      stream = file.createReadStream({ start: 0, end: snapshotSize - 1, autoClose: false });
      lines = boundedEventLogLines(stream, bee)[Symbol.asyncIterator]();
    } else {
      await file.close();
      file = undefined;
      lines = (await emptyEventLogLines())[Symbol.asyncIterator]();
    }
  } else {
    lines = (await emptyEventLogLines())[Symbol.asyncIterator]();
  }
  return {
    token: randomUUID(),
    bee,
    ...(consumerId ? { consumerId } : {}),
    cursor,
    state,
    ...(file ? { file } : {}),
    ...(stream ? { stream } : {}),
    lines,
    sawStampedEvent: false,
    closed: false,
  };
}

function parseReplayEventLine(session: HsrEventReplaySession, framed: BoundedEventLogLine): RunnerEvent | undefined {
  const { bee } = session;
  if (!framed.line.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(framed.line);
  } catch (error) {
    throw new Error(`HSR event log for ${bee} contains a malformed record`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
    throw new Error(`HSR event log for ${bee} contains a malformed record`);
  }
  const event = parsed as RunnerEvent;
  const seq = event.seq;
  if (seq === undefined) {
    if (session.sawStampedEvent) {
      throw new Error(`HSR event log for ${bee} contains a seq-less record after stamped history`);
    }
    if (event.type === "source_cursor_checkpoint") {
      if (
        session.sourceCheckpoint !== undefined
        || !Number.isSafeInteger(event.throughSeq)
        || event.throughSeq <= 0
      ) {
        throw new Error(`HSR event log for ${bee} contains an invalid source compaction checkpoint`);
      }
      session.sourceCheckpoint = event.throughSeq;
      const watermark = effectiveConsumerWatermark(session.state);
      if (watermark !== undefined && event.throughSeq > watermark) {
        throw new Error(`HSR event log for ${bee} compacted beyond durable acknowledgement ${watermark}`);
      }
      if (event.throughSeq > session.cursor) {
        session.gap = { fromSeq: session.cursor + 1, toSeq: event.throughSeq };
      }
    }
    return undefined;
  }
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error(`HSR event log for ${bee} contains an invalid sequence`);
  }
  session.sawStampedEvent = true;
  if (session.firstSeq === undefined) {
    session.firstSeq = seq;
    const expectedFirst = (session.sourceCheckpoint ?? 0) + 1;
    if (seq !== expectedFirst) {
      throw new Error(
        `HSR event log for ${bee} starts stamped history at ${seq} without exact compaction proof through ${seq - 1}`,
      );
    }
    const watermark = effectiveConsumerWatermark(session.state);
    if (watermark !== undefined && seq > watermark + 1) {
      throw new Error(`HSR event log for ${bee} lost an unacknowledged prefix before ${seq}`);
    }
  }
  if (session.priorSeq !== undefined && seq !== session.priorSeq + 1) {
    throw new Error(`HSR event log for ${bee} has an internal sequence gap after ${session.priorSeq}`);
  }
  session.priorSeq = seq;
  return event;
}

async function finishReplaySnapshot(session: HsrEventReplaySession): Promise<void> {
  const durableHigh = session.priorSeq ?? session.sourceCheckpoint ?? 0;
  if (durableHigh < session.state.lastSeq) {
    throw new Error(`HSR event log for ${session.bee} ends below durable high-water ${session.state.lastSeq}`);
  }
  // The stamped line is the durable authority when the following best-effort
  // seq sidecar write was lost. Read the CURRENT sidecar (consumer acks may
  // have advanced between pages) and merge it with this process's monotonic
  // writer cache. Never seed/regress that cache from the stale sidecar read at
  // snapshot-open: an append between bounded pages must allocate above every
  // already-landed line, not duplicate its seq.
  const persisted = await readStrictSeqStateInEventLock(session.bee);
  const cached = seqStates.get(session.bee);
  const current = cached ? mergeHsrSeqStates(cached, persisted) : persisted;
  if (durableHigh > persisted.lastSeq) {
    const healed = { ...current, lastSeq: Math.max(current.lastSeq, durableHigh) };
    await persistSeqState(session.bee, healed);
    seqStates.set(session.bee, healed);
  } else {
    seqStates.set(session.bee, current);
  }
}

async function readHsrEventReplayPageInLock(session: HsrEventReplaySession): Promise<HsrEventsReplayPage> {
  const events: RunnerEvent[] = [];
  let pageBytes = 0;
  let scannedLines = 0;
  let scannedBytes = 0;
  const add = (event: RunnerEvent, bytes: number): boolean => {
    if (events.length > 0 && pageBytes + bytes > HSR_EVENT_REPLAY_PAGE_TARGET_BYTES) {
      session.pending = { event, bytes };
      return false;
    }
    events.push(event);
    pageBytes += bytes;
    session.cursor = Number(event.seq);
    return true;
  };
  if (session.pending) {
    const pending = session.pending;
    session.pending = undefined;
    add(pending.event, pending.bytes);
  }
  while (events.length < HSR_EVENT_REPLAY_PAGE_MAX_EVENTS) {
    const next = await session.lines.next();
    if (next.done) {
      await finishReplaySnapshot(session);
      return {
        events,
        ...(session.gap ? { gap: session.gap } : {}),
        throughSeq: session.cursor,
        hasMore: false,
      };
    }
    scannedLines += 1;
    scannedBytes += next.value.bytes;
    const scanBudgetReached = scannedLines >= HSR_EVENT_REPLAY_PAGE_MAX_EVENTS
      || scannedBytes >= HSR_EVENT_REPLAY_PAGE_TARGET_BYTES;
    const event = parseReplayEventLine(session, next.value);
    if (!event || Number(event.seq) <= session.cursor) {
      // A slow consumer can pin a very large retained prefix while a faster
      // consumer reconnects near its tail. Bound the work done under the
      // cross-process writer lock even when this page has no new events; the
      // opaque continuation retains the scan position in the immutable inode.
      if (scanBudgetReached) {
        if (session.gap) {
          return { events, gap: session.gap, throughSeq: session.cursor, hasMore: false };
        }
        break;
      }
      continue;
    }
    if (session.gap) {
      // Preserve the old diagnostic shape (gap plus retained suffix), but keep
      // it wire-bounded. Consumers must reject the gap before projecting these
      // events, so the request cursor deliberately does not advance.
      if (
        events.length >= HSR_EVENT_REPLAY_PAGE_MAX_EVENTS
        || (events.length > 0 && pageBytes + next.value.bytes > HSR_EVENT_REPLAY_PAGE_TARGET_BYTES)
      ) {
        return { events, gap: session.gap, throughSeq: session.cursor, hasMore: false };
      }
      events.push(event);
      pageBytes += next.value.bytes;
      continue;
    }
    if (Number(event.seq) !== session.cursor + 1) {
      return {
        events: [],
        gap: { fromSeq: session.cursor + 1, toSeq: Number(event.seq) - 1 },
        throughSeq: session.cursor,
        hasMore: false,
      };
    }
    if (!add(event, next.value.bytes) || scanBudgetReached) break;
  }
  if (session.gap) return { events, gap: session.gap, throughSeq: session.cursor, hasMore: false };
  if (!session.pending && events.length > 0) {
    // The event/scan budget can land exactly on the immutable snapshot's final
    // line. One bounded lookahead distinguishes that EOF from a real
    // continuation. Without it, a stopped one-consumer source may interpret
    // the speculative `hasMore`, ack this page through lastSeq, reclaim its run
    // directory, and make the following empty continuation fail before the
    // controller activates its terminal projection.
    let lookaheadLines = 0;
    let lookaheadBytes = 0;
    while (
      lookaheadLines < HSR_EVENT_REPLAY_PAGE_MAX_EVENTS
      && lookaheadBytes < HSR_EVENT_REPLAY_PAGE_TARGET_BYTES
    ) {
      const lookahead = await session.lines.next();
      if (lookahead.done) {
        await finishReplaySnapshot(session);
        return { events, throughSeq: session.cursor, hasMore: false };
      }
      lookaheadLines += 1;
      lookaheadBytes += lookahead.value.bytes;
      const event = parseReplayEventLine(session, lookahead.value);
      if (session.gap) return { events, gap: session.gap, throughSeq: session.cursor, hasMore: false };
      // Empty framing lines do not imply a continuation. Consume them within a
      // bounded lookahead so an exact-full terminal page followed by ordinary
      // whitespace can still prove EOF in the same response. If an adversarial
      // number of ignorable lines exceeds this bound, the durable terminal
      // activation handshake still prevents a progress ack from reclaiming the
      // stopped source before its controller reaches EOF.
      if (!event || Number(event.seq) <= session.cursor) continue;
      if (Number(event.seq) !== session.cursor + 1) {
        return {
          events: [],
          gap: { fromSeq: session.cursor + 1, toSeq: Number(event.seq) - 1 },
          throughSeq: session.cursor,
          hasMore: false,
        };
      }
      session.pending = { event, bytes: lookahead.value.bytes };
      break;
    }
  }
  return { events, throughSeq: session.cursor, hasMore: true, pageToken: session.token };
}

/**
 * Read one bounded contiguous exact-replay page. A process-local opaque token
 * keeps an immutable FileHandle snapshot open between pages, avoiding both an
 * unbounded JSON-RPC response and O(n²) rescans of a long unacked suffix.
 */
export function readHsrEventsPageAfterSeqStrict(
  bee: string,
  afterSeq: number,
  consumerId?: string,
  pageToken?: string,
): Promise<HsrEventsReplayPage> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      let session: HsrEventReplaySession;
      if (pageToken !== undefined) {
        const existing = replaySessions.get(pageToken);
        if (
          !existing || existing.closed || existing.bee !== bee
          || existing.consumerId !== consumerId || existing.cursor !== afterSeq
        ) {
          throw new HsrEventReplayPageTokenError(`HSR event replay continuation for ${bee} is absent or stale`);
        }
        session = existing;
        // An actively consumed continuation is not an eviction candidate.
        // Other bees can open enough sessions to rotate the bounded LRU while
        // this iterator is awaiting IO; keeping it in the map would let that
        // rotation close its FileHandle and turn healthy replay into EBADF.
        replaySessions.delete(pageToken);
        if (session.timer) clearTimeout(session.timer);
        session.timer = undefined;
      } else {
        session = await openHsrEventReplaySession(bee, afterSeq, consumerId);
      }
      try {
        await replayPageAfterSessionClaim?.(bee, pageToken);
        const page = await readHsrEventReplayPageInLock(session);
        if (page.hasMore) retainHsrEventReplaySession(session);
        else await closeHsrEventReplaySession(session);
        return page;
      } catch (error) {
        await closeHsrEventReplaySession(session);
        throw error;
      }
    }, 5_000));
  const next = result.then(() => undefined, () => undefined);
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

function parseStrictSeqState(bee: string, raw: string): HsrSeqState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`HSR event sequence state for ${bee} is malformed`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`HSR event sequence state for ${bee} is malformed`);
  }
  const object = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(object.lastSeq) || Number(object.lastSeq) < 0) {
    throw new Error(`HSR event sequence high-water for ${bee} is malformed`);
  }
  if (object.ackedSeq !== undefined && (
    !Number.isSafeInteger(object.ackedSeq)
    || Number(object.ackedSeq) < 0
    || Number(object.ackedSeq) > Number(object.lastSeq)
  )) {
    throw new Error(`HSR event acknowledgement cursor for ${bee} is malformed`);
  }
  let consumers: Record<string, HsrSeqConsumerState> | undefined;
  if (object.consumers !== undefined) {
    if (!object.consumers || typeof object.consumers !== "object" || Array.isArray(object.consumers)) {
      throw new Error(`HSR event consumers for ${bee} are malformed`);
    }
    consumers = {};
    for (const [consumerId, rawConsumer] of Object.entries(object.consumers as Record<string, unknown>)) {
      if (!validHsrConsumerId(consumerId) || !rawConsumer || typeof rawConsumer !== "object" || Array.isArray(rawConsumer)) {
        throw new Error(`HSR event consumer ${consumerId || "<empty>"} for ${bee} is malformed`);
      }
      const consumer = rawConsumer as Record<string, unknown>;
      if (consumer.ackedSeq !== undefined && (
        !Number.isSafeInteger(consumer.ackedSeq)
        || Number(consumer.ackedSeq) < 0
        || Number(consumer.ackedSeq) > Number(object.lastSeq)
      )) {
        throw new Error(`HSR event consumer acknowledgement for ${bee} is malformed`);
      }
      consumers[consumerId] = {
        ...(consumer.ackedSeq !== undefined ? { ackedSeq: Number(consumer.ackedSeq) } : {}),
      };
    }
  }
  if (object.consumerRevision !== undefined && (
    !Number.isSafeInteger(object.consumerRevision) || Number(object.consumerRevision) < 0
  )) {
    throw new Error(`HSR event consumer revision for ${bee} is malformed`);
  }
  let consumerDiscards: HsrSeqState["consumerDiscards"];
  if (object.consumerDiscards !== undefined) {
    if (!object.consumerDiscards || typeof object.consumerDiscards !== "object" || Array.isArray(object.consumerDiscards)) {
      throw new Error(`HSR event consumer discard history for ${bee} is malformed`);
    }
    consumerDiscards = {};
    for (const [consumerId, rawDiscard] of Object.entries(object.consumerDiscards as Record<string, unknown>)) {
      if (!validHsrConsumerId(consumerId) || !rawDiscard || typeof rawDiscard !== "object" || Array.isArray(rawDiscard)) {
        throw new Error(`HSR event consumer discard ${consumerId || "<empty>"} for ${bee} is malformed`);
      }
      const discard = rawDiscard as Record<string, unknown>;
      if (
        !Number.isSafeInteger(discard.throughSeq) || Number(discard.throughSeq) < 0
        || Number(discard.throughSeq) > Number(object.lastSeq)
        || typeof discard.discardedAt !== "string" || discard.discardedAt.length === 0
      ) {
        throw new Error(`HSR event consumer discard ${consumerId} for ${bee} is malformed`);
      }
      consumerDiscards[consumerId] = {
        throughSeq: Number(discard.throughSeq),
        discardedAt: discard.discardedAt,
      };
    }
  }
  return {
    lastSeq: Number(object.lastSeq),
    ...(object.ackedSeq !== undefined ? { ackedSeq: Number(object.ackedSeq) } : {}),
    ...(object.subscribed === true ? { subscribed: true } : {}),
    ...(consumers ? { consumers } : {}),
    ...(object.consumerRevision !== undefined ? { consumerRevision: Number(object.consumerRevision) } : {}),
    ...(consumerDiscards ? { consumerDiscards } : {}),
  };
}

async function readStrictSeqStateInEventLock(bee: string): Promise<HsrSeqState> {
  let seqRaw: string;
  try {
    seqRaw = await readFile(hsrSeqPath(bee), "utf8");
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `HSR event sequence high-water for ${bee} is missing`
        : `HSR event sequence high-water for ${bee} is unreadable`,
      { cause: error },
    );
  }
  return parseStrictSeqState(bee, seqRaw);
}

export type HsrRetainedEventFoldResult<T> = {
  value: T;
  /** Exact stamped/checkpoint high-water proven by the immutable source file. */
  throughSeq: number;
  /** Bounded metadata used to publish a rebuildable validation cursor. */
  eventCount: number;
  stampedCount: number;
  lastStamped?: HsrSourceTailProof;
};

async function foldHsrEventLogStrictInLock<T>(
  bee: string,
  initial: T,
  fold: (value: T, event: RunnerEvent, index: number) => T,
  requireDurableConsumer: boolean,
): Promise<HsrRetainedEventFoldResult<T>> {
  let state: HsrSeqState;
  try {
    state = await readStrictSeqStateInEventLock(bee);
  } catch (error) {
    if (requireDurableConsumer || (error as { cause?: NodeJS.ErrnoException }).cause?.code !== "ENOENT") throw error;
    state = seqStates.get(bee) ?? { lastSeq: 0 };
  }
  const watermark = effectiveConsumerWatermark(state);
  if (requireDurableConsumer && watermark === undefined) {
    throw new Error(`HSR event sequence state for ${bee} is not subscribed`);
  }

  let file: FileHandle | undefined;
  let stream: ReadStream | undefined;
  let value = initial;
  let index = 0;
  let sourceCheckpoint: number | undefined;
  let firstSeq: number | undefined;
  let priorSeq: number | undefined;
  let sawStampedEvent = false;
  let stampedCount = 0;
  let lastStamped: HsrSourceTailProof | undefined;
  try {
    try {
      file = await open(hsrEventsPath(bee), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`HSR event log for ${bee} is unreadable`, { cause: error });
      }
      if (state.lastSeq > 0) {
        throw new Error(`HSR event log for ${bee} ends below durable high-water ${state.lastSeq}`);
      }
    }
    if (file) {
      const snapshotSize = (await file.stat()).size;
      if (snapshotSize > 0) {
        stream = file.createReadStream({ start: 0, end: snapshotSize - 1, autoClose: false });
        for await (const framed of boundedEventLogLines(stream, bee)) {
          if (!framed.line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(framed.line);
          } catch (error) {
            throw new Error(`HSR event log for ${bee} contains a malformed record`, { cause: error });
          }
          if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
            throw new Error(`HSR event log for ${bee} contains a malformed record`);
          }
          const event = parsed as RunnerEvent;
          const seq = event.seq;
          if (seq === undefined) {
            if (sawStampedEvent) {
              throw new Error(`HSR event log for ${bee} contains a seq-less record after stamped history`);
            }
            if (event.type === "source_cursor_checkpoint") {
              if (
                sourceCheckpoint !== undefined
                || !Number.isSafeInteger(event.throughSeq)
                || event.throughSeq <= 0
              ) {
                throw new Error(`HSR event log for ${bee} contains an invalid source compaction checkpoint`);
              }
              sourceCheckpoint = event.throughSeq;
              if (watermark !== undefined && sourceCheckpoint > watermark) {
                throw new Error(`HSR event log for ${bee} compacted beyond durable acknowledgement ${watermark}`);
              }
            }
          } else {
            if (!Number.isSafeInteger(seq) || seq <= 0) {
              throw new Error(`HSR event log for ${bee} contains an invalid sequence`);
            }
            sawStampedEvent = true;
            if (firstSeq === undefined) {
              firstSeq = seq;
              const expectedFirst = (sourceCheckpoint ?? 0) + 1;
              if (seq !== expectedFirst) {
                throw new Error(
                  `HSR event log for ${bee} starts stamped history at ${seq} without exact compaction proof through ${seq - 1}`,
                );
              }
              if (watermark !== undefined && seq > watermark + 1) {
                throw new Error(`HSR event log for ${bee} lost an unacknowledged prefix before ${seq}`);
              }
            }
            if (priorSeq !== undefined && seq !== priorSeq + 1) {
              throw new Error(`HSR event log for ${bee} has an internal sequence gap after ${priorSeq}`);
            }
            priorSeq = seq;
            stampedCount += 1;
            lastStamped = tailProofOf(event);
          }
          value = fold(value, event, index);
          index += 1;
        }
      }
    }
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === "string") {
      throw new Error(`HSR event log for ${bee} is unreadable`, { cause: error });
    }
    throw error;
  } finally {
    stream?.destroy();
    await file?.close().catch(() => undefined);
  }

  const durableHigh = priorSeq ?? sourceCheckpoint ?? 0;
  if (durableHigh < state.lastSeq) {
    throw new Error(`HSR event log for ${bee} ends below durable high-water ${state.lastSeq}`);
  }
  if (durableHigh > state.lastSeq) {
    state = { ...state, lastSeq: durableHigh };
    await persistSeqState(bee, state);
  }
  seqStates.set(bee, state);
  const eventFile = await readEventLogProof(bee);
  eventLogProofs.set(bee, eventFile);
  await persistSourceAuthorityProof(bee, {
    version: 1,
    eventFile,
    throughSeq: durableHigh,
    eventCount: index,
    stampedCount,
    ...(lastStamped ? { lastStamped } : {}),
  }).catch(() => undefined);
  return {
    value,
    throughSeq: durableHigh,
    eventCount: index,
    stampedCount,
    ...(lastStamped ? { lastStamped } : {}),
  };
}

/**
 * Strictly fold a source log without ever materializing its retained suffix.
 *
 * A slow durable consumer intentionally lets events.jsonl grow past the normal
 * compaction cap. Node list/state projection must still validate every record,
 * but a whole-file read/split made that routine control-plane operation scale
 * with the backlog in memory. This reader holds the cross-process event lock,
 * streams bounded records from one immutable inode, validates the same
 * checkpoint/sequence/high-water proof as exact replay, and exposes only the
 * caller's accumulator. Callers are responsible for keeping that accumulator
 * bounded; the remote list fold retains only a fixed set of lifecycle facts and
 * numeric usage totals.
 */
export function foldHsrRetainedEventsStrict<T>(
  bee: string,
  initial: T,
  fold: (value: T, event: RunnerEvent, index: number) => T,
): Promise<HsrRetainedEventFoldResult<T>> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(
      bee,
      () => foldHsrEventLogStrictInLock(bee, initial, fold, true),
      5_000,
    ));
  const next = result.then(() => undefined, () => undefined);
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

/**
 * Strict O(1)-capable source fold for metadata/state projection.
 *
 * Unlike exact replay, a read-only state projection does not require an
 * admitted durable consumer: legacy/local source logs may legitimately have
 * none. The same checkpoint/order/high-water proof still applies, so absence
 * of a consumer relaxes retention only, never source integrity.
 */
export function foldHsrSourceEventsStrict<T>(
  bee: string,
  initial: T,
  fold: (value: T, event: RunnerEvent, index: number) => T,
): Promise<HsrRetainedEventFoldResult<T>> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(
      bee,
      () => foldHsrEventLogStrictInLock(bee, initial, fold, false),
      5_000,
    ));
  const next = result.then(() => undefined, () => undefined);
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

export type HsrSourceListProjection = {
  stateEvents: RunnerEvent[];
  usage: {
    totals: { inputTokens: number; outputTokens: number } | null;
    latestExhausted?: { ts: number; resetHint?: string };
  };
};

function latestSourceProjectionFact(
  left: HsrSourceProjectionFact | undefined,
  right: HsrSourceProjectionFact | undefined,
): HsrSourceProjectionFact | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.index >= right.index ? left : right;
}

function latestSourceExhausted(
  left: HsrSourceProjectionFact | undefined,
  right: HsrSourceProjectionFact | undefined,
): HsrSourceProjectionFact | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftTs = Number.isFinite(left.event.ts) ? left.event.ts : 0;
  const rightTs = Number.isFinite(right.event.ts) ? right.event.ts : 0;
  return leftTs > rightTs || (leftTs === rightTs && left.index >= right.index) ? left : right;
}

function finishSourceProjection(projection: HsrSourceProjectionAccumulator): HsrSourceListProjection {
  const stateEvents = [
    latestSourceProjectionFact(projection.exact.rootStart, projection.hostless.rootStart),
    latestSourceProjectionFact(projection.exact.rootEnd, projection.hostless.rootEnd),
    latestSourceProjectionFact(projection.exact.toolUse, projection.hostless.toolUse),
    latestSourceProjectionFact(projection.exact.needsInput, projection.hostless.needsInput),
    latestSourceProjectionFact(projection.exact.authNeeded, projection.hostless.authNeeded),
    latestSourceProjectionFact(projection.exact.authResume, projection.hostless.authResume),
    latestSourceProjectionFact(projection.exact.text, projection.hostless.text),
  ].filter((fact): fact is HsrSourceProjectionFact => fact !== undefined)
    .sort((left, right) => left.index - right.index)
    .map((fact) => fact.event);
  const exhausted = latestSourceExhausted(projection.exact.exhausted, projection.hostless.exhausted)?.event;
  return {
    stateEvents,
    usage: {
      totals: projection.sawUsage
        ? { inputTokens: projection.inputTokens, outputTokens: projection.outputTokens }
        : null,
      ...(exhausted?.type === "exhausted"
        ? {
            latestExhausted: {
              ts: Number.isFinite(exhausted.ts) ? exhausted.ts : 0,
              ...(exhausted.resetHint ? { resetHint: exhausted.resetHint } : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * Exact current-host state/usage summary without rescanning a consumer-pinned
 * backlog on every list tick. A source-file stat + high-water proof is written
 * after each completed append. Matching proof makes this O(1); a missing or
 * stale derived proof triggers one strict streaming rebuild, never a silent
 * cap/drop of source facts.
 */
export function readHsrSourceListProjectionStrict(
  bee: string,
  expectedHost: HsrSourceProjectionAccumulator["expectedHost"],
  rootThreadId?: string,
): Promise<HsrSourceListProjection> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      const proof = await currentSourceAuthorityProofInLock(bee);
      if (proof && sourceProjectionMatches(proof.projection, expectedHost, rootThreadId)) {
        return finishSourceProjection(proof.projection);
      }
      const projection = emptySourceProjection(expectedHost, rootThreadId);
      await foldHsrEventLogStrictInLock(
        bee,
        projection,
        (value, event, index) => foldSourceProjection(value, event, index),
        false,
      );
      const rebuilt = sourceAuthorityProofs.get(bee);
      if (!rebuilt) throw new Error(`HSR source validation proof for ${bee} was not rebuilt`);
      const withProjection = { ...rebuilt, projection };
      await persistSourceAuthorityProof(bee, withProjection).catch(() => undefined);
      return finishSourceProjection(projection);
    }, 5_000));
  const next = result.then(() => undefined, () => undefined);
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

export type HsrLeastConsumerCursor = { consumerId: string; ackedSeq: number };

/** Read the slowest active relay consumer without scanning its retained log. */
export function readHsrLeastConsumerCursorStrict(
  bee: string,
  consumerIds: readonly string[],
): Promise<HsrLeastConsumerCursor> {
  const ids = [...new Set(consumerIds)];
  if (ids.length === 0 || ids.some((consumerId) => !validHsrConsumerId(consumerId))) {
    return Promise.reject(new Error(`HSR event consumer set for ${bee} is malformed or empty`));
  }
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      const state = await readStrictSeqStateInEventLock(bee);
      let least: HsrLeastConsumerCursor | undefined;
      for (const consumerId of ids) {
        const consumer = state.consumers?.[consumerId];
        if (!consumer) throw new Error(`HSR event consumer ${consumerId} for ${bee} is not admitted`);
        const ackedSeq = consumer.ackedSeq ?? 0;
        if (!least || ackedSeq < least.ackedSeq) least = { consumerId, ackedSeq };
      }
      return least!;
    }, 5_000));
  const next = result.then(() => undefined, () => undefined);
  appendChains.set(bee, next);
  void next.then(() => {
    if (appendChains.get(bee) === next) appendChains.delete(bee);
  });
  return result;
}

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
    raw = await readWholeHsrEventLog(bee);
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

/**
 * Authority-grade seq resume. Unlike the tolerant local observation reader,
 * this never converts storage uncertainty into an empty/caught-up stream. A
 * remote observer first calls `markHsrConsumerSubscribed`, so seq.json is the
 * durable issued high-water even when zero events exist. Missing/malformed
 * state, non-ENOENT event reads, malformed lines, duplicate/out-of-order seqs,
 * and a file high-water beyond seq.json all fail closed.
 */
function readHsrEventsWindowStrict(
  bee: string,
  cursorForState: (state: HsrSeqState) => number,
  consumerId?: string,
  allowAnyDurableConsumer = false,
): Promise<HsrEventsAfterSeq> {
  const prev = appendChains.get(bee) ?? Promise.resolve();
  const result = prev
    .catch(() => undefined)
    .then(() => withHsrEventAuthorityLock(bee, async () => {
      let raw: string;
      try {
        raw = await readWholeHsrEventLog(bee);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`HSR event log for ${bee} is unreadable`, { cause: error });
        }
        raw = "";
      }

      let seqRaw: string;
      try {
        seqRaw = await readFile(hsrSeqPath(bee), "utf8");
      } catch (error) {
        throw new Error(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `HSR event sequence high-water for ${bee} is missing`
            : `HSR event sequence high-water for ${bee} is unreadable`,
          { cause: error },
        );
      }
      let state = parseStrictSeqState(bee, seqRaw);
      // Validate the complete retained source shape independently of the
      // caller's cursor. A durable cursor is not evidence that a deleted
      // prefix existed; only the compaction checkpoint plus contiguous suffix
      // proves that history. This also keeps already-admitted consumers from
      // laundering damage that happened after observe admission.
      const durableHigh = validateDurableConsumerEventLog(bee, raw, state);
      if (durableHigh > state.lastSeq) {
        // appendHsrEvent commits the stamped line before its best-effort
        // sidecar update. A crash/EIO in that narrow window leaves a complete
        // contiguous suffix that is itself the durable high-water authority.
        // Heal it under this same event lock so an already-admitted or terminal
        // observer is not falsely integrity-fenced merely because no new
        // `observe` call happened to run markHsrConsumerSubscribedStrict first.
        const repaired = { ...state, lastSeq: durableHigh };
        await persistSeqState(bee, repaired);
        state = repaired;
      }
      seqStates.set(bee, state);
      const admitted = consumerId !== undefined
        ? state.consumers?.[consumerId] !== undefined
        : allowAnyDurableConsumer
          ? state.subscribed === true || Object.keys(state.consumers ?? {}).length > 0
          : state.subscribed === true;
      if (!admitted) {
        throw new Error(
          consumerId === undefined
            ? `HSR event sequence state for ${bee} is not subscribed`
            : `HSR event consumer ${consumerId} for ${bee} is not admitted`,
        );
      }
      const cursor = Math.max(0, Math.floor(cursorForState(state)));
      if (cursor > state.lastSeq) {
        throw new Error(
          `HSR event resume cursor ${cursor} for ${bee} exceeds durable high-water ${state.lastSeq}`,
        );
      }

      const events: RunnerEvent[] = [];
      const retained: number[] = [];
      let priorSeq = 0;
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        let event: RunnerEvent;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
            throw new Error("not an event object");
          }
          event = parsed as RunnerEvent;
        } catch (error) {
          throw new Error(`HSR event log for ${bee} contains a malformed record`, { cause: error });
        }
        const seq = event.seq;
        if (seq === undefined) {
          if (priorSeq > 0) {
            throw new Error(`HSR event log for ${bee} contains a seq-less record after stamped history`);
          }
          continue; // legacy/checkpoint evidence; gap below reports folded seqs.
        }
        if (!Number.isSafeInteger(seq) || seq <= 0 || (priorSeq > 0 && seq !== priorSeq + 1)) {
          throw new Error(`HSR event log for ${bee} has invalid sequence ordering`);
        }
        priorSeq = seq;
        retained.push(seq);
        if (seq > cursor) events.push(event);
      }
      if (priorSeq > state.lastSeq) {
        throw new Error(`HSR event log for ${bee} exceeds its durable sequence high-water`);
      }
      const gap = firstSeqGap(cursor, retained, state.lastSeq);
      return gap ? { events, gap } : { events };
    }, 5_000));
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

export function readHsrEventsAfterSeqStrict(
  bee: string,
  afterSeq: number,
  consumerId?: string,
): Promise<HsrEventsAfterSeq> {
  return readHsrEventsWindowStrict(bee, () => afterSeq, consumerId);
}

/**
 * Strict retained suffix protected by the durable consumer acknowledgement.
 * Refresh handoff uses this instead of the tolerant timestamp tail: every
 * current-host event emitted after the last acknowledged predecessor event is
 * returned under the same append-chain snapshot, or an explicit gap/error is
 * reported.
 */
export function readHsrRetainedEventsStrict(bee: string): Promise<HsrEventsAfterSeq> {
  return readHsrEventsWindowStrict(bee, (state) => effectiveConsumerWatermark(state) ?? 0, undefined, true);
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
