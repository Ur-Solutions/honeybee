/**
 * HSR cross-process run-dir observer (APIA-78).
 *
 * The daemon, `hive bees`, and SubstrateHsr do NOT hold runner pipes — the
 * detached host does (HSR_EXPLORATION.md §7). They observe HSR bees purely by
 * reading run dirs: liveness from meta.json's host pid, snapshot from ring.txt.
 *
 * Liveness model: the HOST pid is authoritative. A bee is alive iff its meta
 * says `status: "queued"|"running"` AND the host process is still alive — the host owns
 * the harness child's pipes, so a dead host means the live protocol stream is
 * gone regardless of whether the harness child lingers. "Crash adoption v1"
 * (`reapDeadHosts`) reconciles stale `running` meta with dead host pids and
 * kills the orphaned harness child group the dead host left behind (HIVE-53);
 * it does not recover pipes.
 *
 * Node builtins only.
 */

import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import type { BeeState } from "../state.js";
import {
  parseHsrAnswerHostIdentity,
  sameHsrAnswerHostIdentity,
  type HsrAnswerHostIdentity,
} from "../answerReceipt.js";
import { defaultIsPidAlive as isPidAlive } from "../fsx.js";
import { withSessionLifecycleLock } from "../lifecycle.js";
import {
  HSR_EVENTS_MAX_BYTES,
  hsrEventsPath,
  hsrMetaPath,
  hsrRingPath,
  hsrRoot,
  readHsrMeta,
  readHsrMetaStrict,
  writeHsrMeta,
  type HsrMeta,
} from "./runDir.js";
import {
  assertHsrSourceEventLogIntegrity,
  HsrSourceEventIntegrityError,
} from "./eventIntegrity.js";
import {
  inspectProcessGroupBirth,
  inspectProcessBirth,
  readProcessBirthFingerprint,
  readProcessGroupPresence,
  type ProcessGroupPresenceReader,
  type ProcessIdentityReader,
  type ProcessIdentityVerdict,
} from "./processIdentity.js";
import { isRunnerAuthNeededMessage, type RunnerEvent } from "./types.js";

const DEFAULT_HSR_DISCOVERY_CONCURRENCY = 64;
const DEFAULT_HSR_OBSERVATION_CONCURRENCY = 32;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function observationConcurrency(value: number | undefined): number {
  const raw = value ?? Number(process.env.HIVE_HSR_OBSERVATION_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_HSR_OBSERVATION_CONCURRENCY;
  return Math.max(1, Math.floor(raw));
}

/**
 * Whether a meta record represents a live bee. For a LOCAL host the host pid is
 * authoritative (see file docs). For a MIRROR (APIA-94: `mirrorOfNode` set)
 * there is NO local host — liveness is remote-list driven, and the mirror owns
 * `status`, flipping it to "exited" when the bee leaves the remote node's live
 * list. So a mirror is live iff `status === "running"`; never pid-probed.
 */
function isMetaLive(meta: HsrMeta | null): boolean {
  if (!meta || meta.status === "exited") return false;
  if (meta.mirrorOfNode) return meta.status === "running";
  return isPidAlive(meta.hostPid);
}

/** All bees with a run dir containing a meta.json, sorted. */
export async function listHsrBees(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(hsrRoot());
  } catch {
    return []; // no hsr root yet
  }
  const present = await mapWithConcurrency(
    names,
    DEFAULT_HSR_DISCOVERY_CONCURRENCY,
    async (name) => {
      try {
        await stat(hsrMetaPath(name));
        return name;
      } catch {
        return undefined; // no meta.json (or not a dir) — not an HSR run dir
      }
    },
  );
  return present.filter((name): name is string => name !== undefined).sort();
}

/** bee → alive (host-pid authoritative; see file docs). */
export async function hsrLiveness(): Promise<Map<string, boolean>> {
  const liveness = new Map<string, boolean>();
  const bees = await listHsrBees();
  const rows = await mapWithConcurrency(bees, observationConcurrency(undefined), async (bee) => ({
    bee,
    live: isMetaLive(await readHsrMeta(bee)),
  }));
  for (const row of rows) {
    liveness.set(row.bee, row.live);
  }
  return liveness;
}

/**
 * Exact-record HSR liveness for fail-closed safety decisions. Unlike the
 * display-oriented batch observer, malformed/unreadable metadata propagates
 * instead of becoming `live: false`.
 */
export async function hsrLivenessStrict(bees: Iterable<string>): Promise<Map<string, boolean | null>> {
  const names = [...new Set(bees)].sort();
  const rows = await mapWithConcurrency(names, observationConcurrency(undefined), async (bee) => {
    const meta = await readHsrMetaStrict(bee);
    return { bee, live: meta ? isMetaLive(meta) : null };
  });
  return new Map(rows.map((row) => [row.bee, row.live]));
}

export type HsrPoolLivenessDependencies = {
  isHostAlive?: (pid: number) => boolean;
  readProcessIdentity?: ProcessIdentityReader;
  readProcessGroupPresence?: ProcessGroupPresenceReader;
};

/**
 * Exact HSR mutator liveness for pool capacity decisions. A live host remains
 * occupied. Once the host is gone, a birth-matched detached child group also
 * remains occupied; partial or contradictory group evidence fails closed as
 * occupied. Only confirmed exact-group absence (or a proven replacement birth)
 * releases the checkout. This observer never signals a process.
 */
export async function isHsrPoolMutatorLive(
  meta: HsrMeta,
  deps: HsrPoolLivenessDependencies = {},
): Promise<boolean> {
  if (meta.mirrorOfNode) return meta.status === "running";
  if (meta.status !== "exited" && (deps.isHostAlive ?? isPidAlive)(meta.hostPid)) return true;

  // A host may die between starting the detached harness and publishing its
  // child identity. Queued/running metadata without a complete group therefore
  // cannot prove that no mutator exists.
  if (!meta.childPid || !meta.childPgid || meta.childPid !== meta.childPgid) {
    return meta.status !== "exited";
  }
  const verdict = await inspectProcessGroupBirth(
    meta.childPgid,
    meta.childFingerprint,
    deps.readProcessIdentity,
    deps.readProcessGroupPresence,
  );
  return verdict !== "gone" && verdict !== "mismatch";
}

/** Strict-meta batch wrapper used exclusively by pool safety decisions. */
export async function hsrPoolLivenessStrict(
  bees: Iterable<string>,
  deps: HsrPoolLivenessDependencies = {},
): Promise<Map<string, boolean | null>> {
  const names = [...new Set(bees)].sort();
  const rows = await mapWithConcurrency(names, observationConcurrency(undefined), async (bee) => {
    const meta = await readHsrMetaStrict(bee);
    return { bee, live: meta ? await isHsrPoolMutatorLive(meta, deps) : null };
  });
  return new Map(rows.map((row) => [row.bee, row.live]));
}

/** Tail of ring.txt (last `lines`, or all). Empty string if absent. */
export async function hsrSnapshot(bee: string, lines?: number): Promise<string> {
  let text: string;
  try {
    text = await readFile(hsrRingPath(bee), "utf8");
  } catch {
    return "";
  }
  if (lines === undefined) return text;
  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * Byte cap on the events.jsonl tail read (HIVE-13). The daemon re-reads every
 * bee's events.jsonl each tick, so the read must be O(cap), not O(file) — even
 * for a huge legacy log written before writer-side compaction (runDir.ts)
 * bounded the file. Sized to cover the writer's whole bound (a compacted log
 * never exceeds HSR_EVENTS_MAX_BYTES by more than the append that trips
 * compaction), so on any writer-maintained log the observers see EVERY event:
 * a single long turn cannot push its turn_start out of the window (HIVE-55).
 */
export const EVENT_TAIL_MAX_BYTES = HSR_EVENTS_MAX_BYTES + 64 * 1024;

/**
 * Read at most the trailing `maxBytes` of a file. When the read starts mid-file
 * the first (possibly partial) line is dropped, so callers always see whole
 * lines. Null when the file is missing/unreadable.
 */
async function readTailText(path: string, maxBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      // We landed mid-line (possibly mid-codepoint) — skip to the next full line.
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * A single HSR bee's cross-process observation, read purely from its run dir:
 *   live     — host-pid liveness (see file docs).
 *   state    — a STRUCTURED BeeState derived from the events.jsonl tail, or
 *              undefined when the bee is not live (deriveState resolves
 *              dead/done) or no structured signal exists yet.
 *   snapshot — the rendered ring text tail (used as an output fallback).
 */
export type HsrObservation = {
  live: boolean;
  /** Per-Bee authority/read failure. Consumers must treat this row as unknown. */
  unavailable?: {
    kind: "integrity" | "busy" | "storage";
    detail: string;
    integrityId?: string;
  };
  state?: BeeState;
  snapshot: string;
  /** Latest genuine runner-event progress observed in events.jsonl. */
  activity?: HsrActivityObservation;
  /**
   * Set to the remote node name when this bee is a LOCAL MIRROR of a remote-hsr
   * bee (APIA-94). The daemon uses it to route the (node-carrying, non-`hsr`)
   * SessionRecord through the HSR state path instead of the coarse node-probe.
   */
  mirrorOf?: string;
  /**
   * Optional per-tick daemon cache of events.jsonl-derived facts. Normal callers
   * do not request this; the daemon does so it can feed state, usage, and
   * needs-input from the same bounded event read.
   */
  eventSnapshot?: HsrEventSnapshot;
};

export type HsrEventSnapshot = {
  events: RunnerEvent[];
  tailEvents: RunnerEvent[];
  activity: HsrActivityObservation | null;
  usage: HsrUsageObservation;
  pendingNeedsInput: PendingNeedsInput | null;
};

export type HsrActivityObservation = {
  /** Runner event timestamp (epoch ms). */
  at: number;
  /** Compact identity of the activity event, stable across unchanged sweeps. */
  fingerprint: string;
  eventType: RunnerEvent["type"];
};

export type HsrObservationOptions = {
  includeEvents?: boolean;
  /**
   * Optional exact bee set. The daemon supplies its running HSR session names
   * so an observation tick never scans historical/deleted run directories.
   * Other callers omit this to retain the all-run-dirs behavior.
   */
  bees?: Iterable<string>;
  /** Bounded run-dir read concurrency; defaults to HIVE_HSR_OBSERVATION_CONCURRENCY or 32. */
  concurrency?: number;
};

export type HsrEventDerivationOptions = {
  /** Provider root thread id from meta.json; scoped lifecycle events from other threads are ignored. */
  rootThreadId?: string;
};

function eventHost(event: RunnerEvent): HsrAnswerHostIdentity | undefined {
  if (!("host" in event) || event.host === undefined) return undefined;
  try {
    return parseHsrAnswerHostIdentity(event.host);
  } catch {
    return undefined;
  }
}

function latestStampedHost(events: RunnerEvent[]): HsrAnswerHostIdentity | undefined {
  // A host_epoch is durably appended before its adapter can emit. Prefer that
  // explicit boundary; fall back to the latest stamped event for logs written
  // during a rolling upgrade where the marker itself was unavailable.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "host_epoch") continue;
    const host = eventHost(event);
    if (host) return host;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const host = eventHost(events[index]!);
    if (host) return host;
  }
  return undefined;
}

export type HsrCurrentEventEpoch = {
  host?: HsrAnswerHostIdentity;
  events: RunnerEvent[];
};

/**
 * Select events owned by one exact runner-host epoch. Local callers supply the
 * host from meta.json. Remote mirrors recover it from the durable host_epoch
 * marker. Hostless legacy events are accepted only on a local same-clock run
 * and only at/after that host's startedAt boundary; mirrors fail closed until
 * exact stamped provenance arrives.
 */
export function currentHsrEventEpoch(
  events: RunnerEvent[],
  expectedHost?: HsrAnswerHostIdentity,
): HsrCurrentEventEpoch {
  const host = expectedHost ?? latestStampedHost(events);
  if (!host) return { events: [] };
  const startedAt = Date.parse(host.startedAt);
  const allowLegacyTimestampBoundary = expectedHost !== undefined && Number.isFinite(startedAt);
  let markerIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "host_epoch") continue;
    const stamped = eventHost(event);
    if (stamped && sameHsrAnswerHostIdentity(stamped, host)) {
      markerIndex = index;
      break;
    }
  }
  return {
    host,
    events: events.filter((event, index) => {
      const stamped = eventHost(event);
      if (stamped) return sameHsrAnswerHostIdentity(stamped, host);
      if ("host" in event && event.host !== undefined) return false;
      // Once the durable boundary exists, file order is stronger than a
      // provider-supplied wall clock for rolling-upgrade hostless events.
      if (markerIndex >= 0) return index > markerIndex;
      return allowLegacyTimestampBoundary && Number.isFinite(event.ts) && event.ts >= startedAt;
    }),
  };
}

function lifecycleThreadId(event: RunnerEvent): string | undefined {
  if ((event.type !== "turn_start" && event.type !== "turn_end") || !("threadId" in event)) return undefined;
  return typeof event.threadId === "string" && event.threadId.length > 0 ? event.threadId : undefined;
}

function lifecycleAppliesToRoot(event: RunnerEvent, rootThreadId: string | undefined): boolean {
  if (!rootThreadId) return true;
  const threadId = lifecycleThreadId(event);
  // Legacy events predate lifecycle thread ids; keep treating them as root
  // markers so older HSR logs and non-Codex adapters preserve their behavior.
  return threadId === undefined || threadId === rootThreadId;
}

/**
 * Derive a BeeState from the events.jsonl window. Only the LAST turn markers
 * on the root thread matter, so we scan the parsed window for the last
 * root turn_start/turn_end, the last tool_use, and the last needs_input:
 *   - a login-required auth error in the latest turn → "auth-needed".
 *   - a needs_input with no later turn_end (unresolved) → "blocked".
 *   - a turn in flight (last marker is turn_start) → "active".
 *   - a tool_use AFTER the last turn_end → "active" (see below).
 *   - the last turn finished (turn_end) → "idle_with_output".
 *   - no turn markers yet: any assistant text already → "ready".
 * Returns undefined when the tail carries no usable signal at all (empty log).
 *
 * Why tool_use gates idle: turn_end comes from the harness's own end-of-turn
 * line (claude stream-json `result`), and claude emits one MID-TURN during long
 * tool chains — the log then shows dozens of further tool_use events with no
 * new turn_start. Trusting that turn_end reported the bee idle while it was
 * still working, which drained queued buz messages into the middle of a live
 * tool call (observed 2026-07-13: a silent `Bash sleep` turn). A tool_use later
 * than the last turn_end therefore means work resumed: the bee is active until
 * a turn_end closes the tail. A stuck/never-returning tool leaves the bee
 * reading active, which mirrors how an unterminated turn_start already behaves
 * and is the safe direction — a false idle delivers messages mid-work.
 */
export function structuredStateFromEvents(
  events: RunnerEvent[],
  options: HsrEventDerivationOptions = {},
): BeeState | undefined {
  const rootThreadId = options.rootThreadId;
  let lastStart = -1;
  let lastEnd = -1;
  let lastTool = -1;
  let lastNeeds = -1;
  let lastAuthNeeded = -1;
  let lastAuthResume = -1;
  let hasText = false;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    switch (event.type) {
      case "turn_start":
        if (lifecycleAppliesToRoot(event, rootThreadId)) lastStart = i;
        break;
      case "turn_end":
        if (lifecycleAppliesToRoot(event, rootThreadId)) lastEnd = i;
        break;
      case "tool_use":
        lastTool = i;
        break;
      case "needs_input":
        lastNeeds = i;
        break;
      case "text":
        if (event.text.length > 0) hasText = true;
        break;
      case "error":
        if (isAuthNeededMessage(event.message)) lastAuthNeeded = i;
        break;
      case "auth_expired":
        if (event.requiresLogin) lastAuthNeeded = i;
        break;
      case "auth_resume":
        lastAuthResume = i;
        break;
      default:
        break;
    }
  }
  // A login-required auth failure is sticky for the turn it happened in. It is
  // intentionally separate from `auth_expired`: remote ephemeral-token bees can
  // recover that automatically, while this one requires a human login. The
  // Legacy `auth_resume` markers bound this stickiness within pre-epoch logs.
  // Current relaunches instead publish `host_epoch` before adapter start, and
  // currentHsrEventEpoch removes every predecessor fact before this derivation.
  // An auth error AFTER either boundary still wins.
  if (lastAuthNeeded >= 0 && lastAuthNeeded >= lastStart && lastAuthNeeded > lastAuthResume) {
    return "auth-needed";
  }
  // An unresolved needs_input (nothing finished the turn after it) blocks the bee.
  if (lastNeeds >= 0 && lastNeeds > lastEnd) return "blocked";
  // A turn is in flight when the last turn marker is a start with no later end.
  if (lastStart > lastEnd) return "active";
  // A tool fired after the last turn_end: the harness closed a turn mid-work
  // (claude does this on long tool chains) and kept going. Still working.
  if (lastTool > lastEnd) return "active";
  // A completed turn: the bee produced output and is now waiting.
  if (lastEnd >= 0) return "idle_with_output";
  // No turn markers yet. Assistant text proves the session is talking; without
  // it, the event tail has no decisive lifecycle signal. Do not call that
  // "booting" here: a successfully-started server HSR intentionally emits no
  // runner event until its first prompt. The run-dir meta owns startup state.
  if (hasText) return "ready";
  return undefined;
}

/**
 * Project one live run dir's startup metadata and event tail into BeeState.
 * `runningAt` is written only after adapter startup and the control socket are
 * ready, so it is the authoritative readiness signal for a never-prompted HSR.
 * Before that point, queued admission remains queued and queued harness startup
 * remains booting, preserving the real boot-wedge detector.
 */
function structuredStateFromRunDir(meta: HsrMeta, events: RunnerEvent[]): BeeState {
  if (meta.status === "queued") {
    return meta.startupPhase === "harness" ? "booting" : "queued";
  }
  const eventState = structuredStateFromEvents(events, { rootThreadId: meta.sessionId });
  if (eventState) return eventState;
  return meta.runningAt ? "ready" : "booting";
}

function eventText(event: RunnerEvent): string | undefined {
  return "text" in event && typeof event.text === "string" ? event.text : undefined;
}

function isActivityEvent(event: RunnerEvent, rootThreadId: string | undefined): boolean {
  switch (event.type) {
    case "turn_start":
    case "turn_end":
      return lifecycleAppliesToRoot(event, rootThreadId);
    case "text":
    case "thought":
    case "reasoning":
      return (eventText(event)?.length ?? 0) > 0;
    case "tool_use":
    case "tool_update":
    case "usage":
    case "exhausted":
    case "auth_expired":
    case "auth_resume":
    case "needs_input":
    case "error":
      return true;
    case "exit":
      return false;
    default:
      return false;
  }
}

function activityFingerprint(event: RunnerEvent): string {
  const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 16);
  return `${event.type}:${event.ts}:${digest}`;
}

export function hsrActivityFromEvents(
  events: RunnerEvent[],
  options: HsrEventDerivationOptions = {},
): HsrActivityObservation | null {
  const rootThreadId = options.rootThreadId;
  let latest: RunnerEvent | null = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (!Number.isFinite(event.ts) || !isActivityEvent(event, rootThreadId)) continue;
    latest = event;
  }
  if (!latest) return null;
  return {
    at: latest.ts,
    fingerprint: activityFingerprint(latest),
    eventType: latest.type,
  };
}

export function isAuthNeededMessage(message: string): boolean {
  return isRunnerAuthNeededMessage(message);
}

/**
 * Read the tail of a bee's events.jsonl and parse it into RunnerEvents. Reads
 * at most the trailing EVENT_TAIL_MAX_BYTES of the file — on a writer-bounded
 * log that is the WHOLE log, so no fixed line count can hide an old turn_start
 * or unresolved needs_input behind a burst of text chunks (HIVE-55). Tolerates
 * a missing/partial file and unparseable lines (a truncated crash write) — a
 * bad line is skipped, never thrown.
 */
function parseRunnerEvents(raw: string): RunnerEvent[] {
  const all = raw.split("\n").filter((line) => line.trim().length > 0);
  const events: RunnerEvent[] = [];
  for (const line of all) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        events.push(parsed as RunnerEvent);
      }
    } catch {
      // truncated / partial line — skip
    }
  }
  return events;
}

export async function readEventTail(bee: string): Promise<RunnerEvent[]> {
  const raw = await readTailText(hsrEventsPath(bee), EVENT_TAIL_MAX_BYTES);
  return raw === null ? [] : parseRunnerEvents(raw);
}

/** Current-host lifecycle slice, including for a dead host whose exact meta remains. */
export async function readCurrentHsrEventTail(bee: string): Promise<RunnerEvent[]> {
  const [retainedEvents, meta] = await Promise.all([readEventTail(bee), readHsrMeta(bee)]);
  if (!meta) return [];
  const host = meta.hostFingerprint ? {
    hostPid: meta.hostPid,
    startedAt: meta.startedAt,
    hostFingerprint: meta.hostFingerprint,
  } : undefined;
  const epoch = currentHsrEventEpoch(retainedEvents, host);
  if (!meta.mirrorOfNode && !host && !epoch.host) return retainedEvents;
  return epoch.events;
}

function eventSnapshotFromRetainedEvents(
  retainedEvents: RunnerEvent[],
  rootThreadId?: string,
  host?: HsrAnswerHostIdentity,
  allowUnboundLegacy = false,
): HsrEventSnapshot {
  const derivedEpoch = currentHsrEventEpoch(retainedEvents, host);
  const epoch = allowUnboundLegacy && !host && !derivedEpoch.host
    ? { events: retainedEvents }
    : derivedEpoch;
  const pending = pendingNeedsInputFromEvents(epoch.events, { rootThreadId });
  const cumulativeUsage = hsrUsageObservationFromEvents(retainedEvents);
  const currentUsage = hsrUsageObservationFromEvents(epoch.events);
  return {
    // Current-lifecycle consumers (state, auth, recovery, BeeView, pending
    // routing) must never see retained predecessor-host authority.
    events: epoch.events,
    tailEvents: epoch.events,
    activity: hsrActivityFromEvents(epoch.events, { rootThreadId }),
    // Token totals are session-history cumulative. Exhaustion is an active
    // host signal and therefore comes only from the current epoch.
    usage: {
      totals: cumulativeUsage.totals,
      ...(currentUsage.latestExhausted ? { latestExhausted: currentUsage.latestExhausted } : {}),
    },
    pendingNeedsInput: pending && epoch.host ? { ...pending, host: epoch.host } : pending,
  };
}

/**
 * Batch structured observation of HSR bees, read purely from run dirs (no
 * tmux). By default every run dir is included; callers with an authoritative
 * session set can pass `bees` and avoid historical directory discovery.
 *
 * Run dirs are observed with bounded concurrency. Exited hosts are metadata-
 * only: stale ring/events cannot affect state, usage, or needs-input routing,
 * so rereading them every tick is pure waste. For live hosts, ring and event
 * reads run concurrently and a requested event snapshot is reused for state.
 * Never throws: a bad bee yields an unavailable row. Source event facts are
 * always returned from the same strict event-authority snapshot that admitted
 * them; callers must not treat `unavailable` as an idle/dead observation.
 */
export async function hsrObservations(options: HsrObservationOptions = {}): Promise<Map<string, HsrObservation>> {
  const observations = new Map<string, HsrObservation>();
  const bees = options.bees === undefined
    ? await listHsrBees()
    : [...new Set(options.bees)].sort();
  const rows = await mapWithConcurrency(bees, observationConcurrency(options.concurrency), async (bee) => {
    try {
      const admitted = await withSessionLifecycleLock(bee, async () => {
        const current = await readHsrMetaStrict(bee);
        let sourceEvents: RunnerEvent[] | undefined;
        if (current && !current.mirrorOfNode) {
          sourceEvents = await assertHsrSourceEventLogIntegrity({
            bee,
            meta: current,
            operation: "HSR observation",
            includeEvents: true,
          });
        }
        return { meta: current, sourceEvents };
      });
      const { meta, sourceEvents } = admitted;
      if (!meta) return undefined;
      const live = isMetaLive(meta);
      const mirrorOf = meta?.mirrorOfNode;
      if (!live) {
        return [bee, {
          live: false,
          snapshot: "",
          ...(mirrorOf ? { mirrorOf } : {}),
        }] as const;
      }

      const rootThreadId = meta?.sessionId;
      const host = meta.hostFingerprint ? {
        hostPid: meta.hostPid,
        startedAt: meta.startedAt,
        hostFingerprint: meta.hostFingerprint,
      } : undefined;
      if (options.includeEvents) {
        const retainedEvents = sourceEvents ?? await readEventTail(bee);
        const snapshotPromise = hsrSnapshot(bee);
        const eventSnapshot = eventSnapshotFromRetainedEvents(retainedEvents, rootThreadId, host, !meta.mirrorOfNode);
        const snapshot = await snapshotPromise;
        const state = structuredStateFromRunDir(meta, eventSnapshot.tailEvents);
        return [bee, {
          live: true,
          snapshot,
          state,
          ...(eventSnapshot.activity ? { activity: eventSnapshot.activity } : {}),
          ...(mirrorOf ? { mirrorOf } : {}),
          eventSnapshot,
        }] as const;
      }

      const [snapshot, retainedEvents] = await Promise.all([
        hsrSnapshot(bee),
        sourceEvents ? Promise.resolve(sourceEvents) : readEventTail(bee),
      ]);
      const derivedEpoch = currentHsrEventEpoch(retainedEvents, host);
      const epoch = !meta.mirrorOfNode && !host && !derivedEpoch.host
        ? { events: retainedEvents }
        : derivedEpoch;
      const state = structuredStateFromRunDir(meta, epoch.events);
      const activity = hsrActivityFromEvents(epoch.events, { rootThreadId });
      return [bee, {
        live,
        snapshot,
        state,
        ...(activity ? { activity } : {}),
        ...(mirrorOf ? { mirrorOf } : {}),
      }] as const;
    } catch (error) {
      return [bee, {
        live: false,
        snapshot: "",
        unavailable: error instanceof HsrSourceEventIntegrityError
          ? { kind: "integrity" as const, detail: error.message, integrityId: error.integrityId }
          : (error as { code?: unknown }).code === "HIVE_HSR_EVENT_LOG_BUSY"
            ? { kind: "busy" as const, detail: error instanceof Error ? error.message : String(error) }
            : { kind: "storage" as const, detail: error instanceof Error ? error.message : String(error) },
      }] as const;
    }
  });
  for (const row of rows) {
    if (row) observations.set(row[0], row[1]);
  }
  return observations;
}

/**
 * The pending needs-input a blocked HSR bee is waiting on, read from the events
 * tail. Used by the daemon's needs-input → parent-buz router and `hive answer`.
 * `requestId` falls back to the stable literal "pending" when the emitting event
 * carried none, so answer paths always have a key. `ts` identifies the specific
 * needs_input event for routing de-dupe when adapters do not provide requestId.
 */
export type PendingNeedsInput = {
  requestId: string;
  ts: number;
  kind: "permission" | "question";
  question: string;
  tool?: string;
  options?: string[];
  optionDetails?: Extract<RunnerEvent, { type: "needs_input" }>["optionDetails"];
  questions?: Extract<RunnerEvent, { type: "needs_input" }>["questions"];
  multiSelect?: boolean;
  input?: unknown;
  /** Exact non-authorizing runner epoch that emitted this request. */
  host?: HsrAnswerHostIdentity;
};

export function pendingNeedsInputFromEvents(
  events: RunnerEvent[],
  options: HsrEventDerivationOptions = {},
): PendingNeedsInput | null {
  const rootThreadId = options.rootThreadId;
  let lastNeeds = -1;
  let lastEnd = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "needs_input") lastNeeds = i;
    else if (event.type === "turn_end" && lifecycleAppliesToRoot(event, rootThreadId)) lastEnd = i;
  }
  // Unresolved iff a needs_input is the last turn marker (nothing ended after it).
  if (lastNeeds < 0 || lastNeeds <= lastEnd) return null;
  const event = events[lastNeeds] as Extract<RunnerEvent, { type: "needs_input" }>;
  return {
    requestId: event.requestId ?? "pending",
    ts: event.ts,
    kind: event.kind,
    question: event.question,
    ...(event.tool ? { tool: event.tool } : {}),
    ...(event.options ? { options: event.options } : {}),
    ...(event.optionDetails ? { optionDetails: event.optionDetails } : {}),
    ...(event.questions ? { questions: event.questions } : {}),
    ...(event.multiSelect !== undefined ? { multiSelect: event.multiSelect } : {}),
    ...(event.input !== undefined ? { input: event.input } : {}),
  };
}

/**
 * The LAST needs_input event in the tail that has no later turn_end — i.e. the
 * unresolved request the bee is currently blocked on (mirrors the "blocked"
 * rule in structuredStateFromEvents). Null when the bee is not live or has no
 * pending request. Never throws.
 */
export async function pendingNeedsInput(bee: string): Promise<PendingNeedsInput | null> {
  const meta = await readHsrMeta(bee);
  if (!isMetaLive(meta)) return null;
  const host = meta?.hostFingerprint ? {
    hostPid: meta.hostPid,
    startedAt: meta.startedAt,
    hostFingerprint: meta.hostFingerprint,
  } : undefined;
  const retainedEvents = await readEventTail(bee);
  const derivedEpoch = currentHsrEventEpoch(retainedEvents, host);
  const epoch = !meta?.mirrorOfNode && !host && !derivedEpoch.host
    ? { events: retainedEvents }
    : derivedEpoch;
  const pending = pendingNeedsInputFromEvents(epoch.events, { rootThreadId: meta?.sessionId });
  if (!pending || !epoch.host) return pending;
  return {
    ...pending,
    host: epoch.host,
  };
}

/**
 * Cumulative token totals + the latest provider-exhaustion signal for an HSR
 * bee, derived from its events.jsonl. Feeds the usage sampler (a pane-less HSR
 * bee has no live pane to scrape, but its events carry EXACT usage + typed
 * rate-limit signals).
 *
 *   totals          — session cumulative tokens. `usage` events carry PER-TURN
 *                     counts (claude result usage; codex thread token deltas),
 *                     so the cumulative is their sum, which stays monotonic
 *                     across a session. null when the log holds no usage yet.
 *   latestExhausted — the newest `exhausted` event (by ts) with its resetHint,
 *                     or undefined. The caller edge-detects on `ts`.
 *
 * Reads the whole log — the cumulative sum needs every usage event, including
 * the checkpoint the writer prepends on compaction — but the log itself is
 * bounded by writer-side compaction (runDir.ts HSR_EVENTS_MAX_BYTES), so this
 * stays O(cap) per tick, not O(session lifetime). Tolerant of a
 * missing/partial/torn file — a bad line is skipped, never thrown.
 */
export type HsrUsageObservation = {
  totals: { inputTokens: number; outputTokens: number } | null;
  latestExhausted?: { ts: number; resetHint?: string };
};

export function hsrUsageObservationFromEvents(events: RunnerEvent[]): HsrUsageObservation {
  let input = 0;
  let output = 0;
  let sawUsage = false;
  let latestExhausted: { ts: number; resetHint?: string } | undefined;
  for (const event of events) {
    if (event.type === "usage") {
      sawUsage = true;
      if (typeof event.inputTokens === "number" && Number.isFinite(event.inputTokens)) input += event.inputTokens;
      if (typeof event.cacheReadTokens === "number" && Number.isFinite(event.cacheReadTokens)) input += event.cacheReadTokens;
      if (typeof event.cacheWriteTokens === "number" && Number.isFinite(event.cacheWriteTokens)) input += event.cacheWriteTokens;
      if (typeof event.outputTokens === "number" && Number.isFinite(event.outputTokens)) output += event.outputTokens;
      if (typeof event.reasoningTokens === "number" && Number.isFinite(event.reasoningTokens)) output += event.reasoningTokens;
    } else if (event.type === "exhausted") {
      const ts = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : 0;
      if (!latestExhausted || ts >= latestExhausted.ts) {
        latestExhausted = { ts, ...(event.resetHint ? { resetHint: event.resetHint } : {}) };
      }
    }
  }
  return {
    totals: sawUsage ? { inputTokens: input, outputTokens: output } : null,
    ...(latestExhausted ? { latestExhausted } : {}),
  };
}

export async function hsrUsageObservation(bee: string): Promise<HsrUsageObservation> {
  let raw: string;
  try {
    raw = await readFile(hsrEventsPath(bee), "utf8");
  } catch {
    return { totals: null };
  }
  const retainedEvents = parseRunnerEvents(raw);
  const cumulative = hsrUsageObservationFromEvents(retainedEvents);
  const meta = await readHsrMeta(bee).catch(() => null);
  const host = meta?.hostFingerprint ? {
    hostPid: meta.hostPid,
    startedAt: meta.startedAt,
    hostFingerprint: meta.hostFingerprint,
  } : undefined;
  const derivedEpoch = currentHsrEventEpoch(retainedEvents, host);
  const currentEvents = !meta?.mirrorOfNode && !host && !derivedEpoch.host
    ? retainedEvents
    : derivedEpoch.events;
  const current = hsrUsageObservationFromEvents(currentEvents);
  return {
    totals: cumulative.totals,
    ...(current.latestExhausted ? { latestExhausted: current.latestExhausted } : {}),
  };
}

// Escalation grace for orphaned harness child groups (SIGTERM → SIGKILL),
// mirrors streamRunner.ts stop().
const ORPHAN_STOP_GRACE_MS = 2_000;
const ORPHAN_STOP_POLL_MS = 25;
const ORPHAN_KILL_CONFIRM_MS = 1_000;

export type HsrProcessSignalDependencies = {
  /** Current OS birth identity; injectable for deterministic PID-reuse tests. */
  readProcessIdentity?: ProcessIdentityReader;
  /** process.kill-compatible signal function; negative ids are process groups. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  isProcessGroupAlive?: (pgid: number) => boolean;
  /** Strict, non-signalling group census used for legacy exited metadata. */
  readProcessGroupPresence?: ProcessGroupPresenceReader;
  sleep?: (ms: number) => Promise<void>;
};

/** Signal-0 liveness probe of a whole process group. */
export function isHsrProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Birth-validated state of the exact host incarnation recorded in meta. */
export function inspectHsrHostProcess(
  meta: HsrMeta,
  deps: HsrProcessSignalDependencies = {},
): Promise<ProcessIdentityVerdict> {
  return inspectProcessBirth(meta.hostPid, meta.hostFingerprint, deps.readProcessIdentity);
}

export type HsrChildProcessVerdict = ProcessIdentityVerdict | "absent";

/** Birth-validated state of the exact child/group leader recorded in meta. */
export function inspectHsrChildProcess(
  meta: HsrMeta | null,
  deps: HsrProcessSignalDependencies = {},
): Promise<HsrChildProcessVerdict> {
  if (!meta?.childPid && !meta?.childPgid) {
    // Only a completed no-child admission is durable absence. `pending` and
    // legacy missing admission state can be the pre-publication orphan window:
    // treating either as absent would let reap/kill discard the sole locator.
    return Promise.resolve(meta?.childAdmission === "none" ? "absent" : "unverifiable");
  }
  const pid = meta.childPid;
  const pgid = meta.childPgid ?? pid;
  if (!pid || !pgid || meta.childFingerprint?.pgid !== pgid) return Promise.resolve("unverifiable");
  return inspectProcessBirth(pid, meta.childFingerprint, deps.readProcessIdentity);
}

/**
 * Kill the harness child group a dead host left behind (HIVE-53). The runner
 * spawns the harness detached (own group leader, pgid === childPid), so a host
 * that dies WITHOUT running finalize (SIGKILL/OOM — locally a crashed
 * `__hsr-run`, remotely the serve whose in-process runners share its pid)
 * strands the child: still running, control socket gone, meta stuck "running".
 * Callers pass a meta whose host pid is already known-dead; we SIGTERM the
 * recorded child group, grant a short grace, then SIGKILL. Returns true when a
 * live group was signalled. Never throws.
 */
export async function killOrphanedChildGroup(
  meta: HsrMeta | null,
  deps: HsrProcessSignalDependencies = {},
): Promise<boolean> {
  const pgid = meta?.childPgid ?? meta?.childPid ?? 0;
  const groupAlive = deps.isProcessGroupAlive ?? isHsrProcessGroupAlive;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // PID/PGID numbers can be recycled.  Match both the child's OS birth and
  // group before every destructive signal.  Gone/mismatch proves the original
  // incarnation is gone but never authorizes signalling its replacement;
  // missing/unreadable identity fails closed.
  if ((await inspectHsrChildProcess(meta, deps)) !== "match" || !groupAlive(pgid)) return false;
  try {
    kill(-pgid, "SIGTERM");
  } catch {
    // Died between the probe and the signal.
  }
  const deadline = Date.now() + ORPHAN_STOP_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) {
    await sleep(ORPHAN_STOP_POLL_MS);
  }
  if (groupAlive(pgid) && (await inspectHsrChildProcess(meta, deps)) === "match") {
    try {
      kill(-pgid, "SIGKILL");
    } catch {
      // best-effort
    }
    const confirmDeadline = Date.now() + ORPHAN_KILL_CONFIRM_MS;
    while (groupAlive(pgid) && Date.now() < confirmDeadline) {
      await sleep(ORPHAN_STOP_POLL_MS);
    }
  }
  return true;
}

/** Confirm the recorded child group is gone, signalling only a birth match. */
export async function ensureOrphanedChildGroupStopped(
  meta: HsrMeta | null,
  deps: HsrProcessSignalDependencies = {},
): Promise<boolean> {
  const before = await inspectHsrChildProcess(meta, deps);
  if (before === "absent") return true;
  if (before === "gone" || before === "mismatch") {
    // A detached process-group leader may exit while descendants keep the
    // recorded PGID alive. Leader death (or PID reuse) therefore proves only
    // that we must not signal through that numeric identity; it does not prove
    // that the whole owned group is gone. Require a separate non-destructive
    // group census before publishing a confirmed stop.
    const pgid = meta?.childPgid ?? meta?.childPid ?? 0;
    if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
    try {
      if (deps.readProcessGroupPresence) {
        return (await deps.readProcessGroupPresence(pgid)) === "absent";
      }
      if (deps.isProcessGroupAlive) return !deps.isProcessGroupAlive(pgid);
      return (await readProcessGroupPresence(pgid)) === "absent";
    } catch {
      return false;
    }
  }
  // Pre-fingerprint Honeybee persisted the detached child PID/PGID but no OS
  // birth token. Never signal such a recyclable numeric identity. An already
  // finalized legacy host can still be reconciled safely when two independent,
  // non-destructive observations agree that both the leader PID and its whole
  // process group are absent. Live/reused, unreadable, partially published, and
  // contradictory evidence remains unconfirmed.
  if (
    before === "unverifiable" &&
    meta?.status === "exited" &&
    meta.childAdmission === undefined &&
    meta.childFingerprint === undefined &&
    meta.childPid !== undefined &&
    meta.childPid === meta.childPgid
  ) {
    try {
      const identityReader = deps.readProcessIdentity ?? readProcessBirthFingerprint;
      const groupReader = deps.readProcessGroupPresence ?? readProcessGroupPresence;
      const [leader, group] = await Promise.all([
        identityReader(meta.childPid),
        groupReader(meta.childPgid),
      ]);
      if (leader === null && group === "absent") return true;
    } catch {
      return false;
    }
  }
  if (before !== "match") return false;
  await killOrphanedChildGroup(meta, deps);
  const pgid = meta?.childPgid ?? meta?.childPid ?? 0;
  const groupAlive = deps.isProcessGroupAlive ?? isHsrProcessGroupAlive;
  if (!groupAlive(pgid)) return true;
  // A live group whose birth-verified leader vanished may still contain the
  // original descendants, but it can no longer be revalidated before another
  // signal. Preserve unconfirmed state instead of risking a recycled PGID.
  return false;
}

/**
 * Positive no-descendant proof used with a durable terminal event-stream seal.
 * Unlike `ensureOrphanedChildGroupStopped`, this never signals: a group that
 * still exists after the host's terminal event is ambiguity, not clean exit.
 */
export async function proveHsrChildGroupAbsent(
  meta: HsrMeta,
  deps: HsrProcessSignalDependencies = {},
): Promise<boolean> {
  if (meta.childAdmission === "none") return true;
  if (meta.childAdmission !== "admitted" || !meta.childPid || !meta.childPgid || !meta.childFingerprint) {
    return false;
  }
  const leader = await inspectHsrChildProcess(meta, deps);
  if (leader === "unverifiable" || leader === "match") return false;
  if (leader === "mismatch") return true;
  try {
    return await (deps.readProcessGroupPresence ?? readProcessGroupPresence)(meta.childPgid) === "absent";
  } catch {
    return false;
  }
}

/**
 * Reconcile stale `queued`/`running` meta whose host pid is dead: kill the orphaned
 * harness child group it left behind (HIVE-53), flip status to "exited" (with
 * endedAt) and return the reaped bee names. Crash-adoption v1 — no pipe
 * recovery.
 */
export async function reapDeadHosts(deps: HsrProcessSignalDependencies = {}): Promise<string[]> {
  const reaped: string[] = [];
  for (const bee of await listHsrBees()) {
    // Corrupt or unreadable existing metadata is uncertainty, not absence.
    // Preserve it for explicit repair instead of overwriting the only runtime
    // locator with an exited record.
    const meta = await readHsrMetaStrict(bee).catch(() => null);
    if (!meta || meta.status === "exited") continue;
    // A mirror has no local host pid to reap: the remoteEventMirror owns its
    // status (flips to "exited" when the bee leaves the remote list). Skip it.
    if (meta.mirrorOfNode) continue;
    const host = await inspectHsrHostProcess(meta, deps);
    if (host === "match") continue;
    if (host === "unverifiable") continue;
    // The dead host never ran finalize, so its detached harness child may still
    // be running with no control plane — kill the group before flipping meta,
    // or the leak outlives the reap.
    if (!(await ensureOrphanedChildGroupStopped(meta, deps))) continue;
    await writeHsrMeta(bee, { ...meta, status: "exited", endedAt: new Date().toISOString() });
    reaped.push(bee);
  }
  return reaped;
}
