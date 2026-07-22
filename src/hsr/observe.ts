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
import { defaultIsPidAlive as isPidAlive } from "../fsx.js";
import {
  HSR_EVENTS_MAX_BYTES,
  hsrEventsPath,
  hsrMetaPath,
  hsrRingPath,
  hsrRoot,
  readHsrMeta,
  writeHsrMeta,
  type HsrMeta,
} from "./runDir.js";
import type { RunnerEvent } from "./types.js";

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
 *              dead/sealed) or no structured signal exists yet.
 *   snapshot — the rendered ring text tail (used as an output fallback).
 */
export type HsrObservation = {
  live: boolean;
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
 *   - no turn markers yet: any assistant text already → "ready", else "booting".
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
  // `auth_resume` marker (written by `hive auth-resume` after capture+revive)
  // bounds the stickiness: a resumed bee sits idle without starting a new
  // turn, so the stale error must not keep re-deriving auth-needed. An auth
  // error AFTER the marker (the resumed runner failed again) still wins.
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
  // No turn markers yet — still coming up. Any assistant text already means the
  // session is talking (ready); otherwise it is still booting.
  if (hasText) return "ready";
  return "booting";
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

function activityFingerprint(event: RunnerEvent, index: number): string {
  const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 16);
  return `${index}:${event.type}:${event.ts}:${digest}`;
}

export function hsrActivityFromEvents(
  events: RunnerEvent[],
  options: HsrEventDerivationOptions = {},
): HsrActivityObservation | null {
  const rootThreadId = options.rootThreadId;
  let latest: { event: RunnerEvent; index: number } | null = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (!Number.isFinite(event.ts) || !isActivityEvent(event, rootThreadId)) continue;
    latest = { event, index: i };
  }
  if (!latest) return null;
  return {
    at: latest.event.ts,
    fingerprint: activityFingerprint(latest.event, latest.index),
    eventType: latest.event.type,
  };
}

export function isAuthNeededMessage(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("not logged in") && m.includes("/login")) return true;
  if (m.includes("please log out and sign in again")) return true;
  if (m.includes("please sign out and sign in again")) return true;
  if (m.includes("access token") && m.includes("could not be refreshed")) return true;
  if (m.includes("access token") && m.includes("couldn't be refreshed")) return true;
  if (m.includes("access token") && m.includes("cannot be refreshed")) return true;
  if ((m.includes("please log in") || m.includes("please login") || m.includes("sign in again")) && m.includes("auth")) return true;
  return false;
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

async function readEventTail(bee: string): Promise<RunnerEvent[]> {
  const raw = await readTailText(hsrEventsPath(bee), EVENT_TAIL_MAX_BYTES);
  return raw === null ? [] : parseRunnerEvents(raw);
}

async function readEventSnapshot(bee: string, rootThreadId?: string): Promise<HsrEventSnapshot> {
  const events = await readEventTail(bee);
  return {
    events,
    tailEvents: events,
    activity: hsrActivityFromEvents(events, { rootThreadId }),
    usage: hsrUsageObservationFromEvents(events),
    pendingNeedsInput: pendingNeedsInputFromEvents(events, { rootThreadId }),
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
 * Never throws: a bad bee yields `{ live: false, snapshot: "" }`.
 */
export async function hsrObservations(options: HsrObservationOptions = {}): Promise<Map<string, HsrObservation>> {
  const observations = new Map<string, HsrObservation>();
  const bees = options.bees === undefined
    ? await listHsrBees()
    : [...new Set(options.bees)].sort();
  const rows = await mapWithConcurrency(bees, observationConcurrency(options.concurrency), async (bee) => {
    try {
      const meta = await readHsrMeta(bee);
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
      if (options.includeEvents) {
        const [snapshot, eventSnapshot] = await Promise.all([
          hsrSnapshot(bee),
          readEventSnapshot(bee, rootThreadId),
        ]);
        const state = meta.status === "queued"
          ? meta.startupPhase === "harness" ? "booting" : "queued"
          : structuredStateFromEvents(eventSnapshot.tailEvents, { rootThreadId });
        return [bee, {
          live: true,
          snapshot,
          state,
          ...(eventSnapshot.activity ? { activity: eventSnapshot.activity } : {}),
          ...(mirrorOf ? { mirrorOf } : {}),
          eventSnapshot,
        }] as const;
      }

      const [snapshot, events] = await Promise.all([
        hsrSnapshot(bee),
        readEventTail(bee),
      ]);
      const state = meta.status === "queued"
        ? meta.startupPhase === "harness" ? "booting" : "queued"
        : structuredStateFromEvents(events, { rootThreadId });
      const activity = hsrActivityFromEvents(events, { rootThreadId });
      return [bee, {
        live,
        snapshot,
        state,
        ...(activity ? { activity } : {}),
        ...(mirrorOf ? { mirrorOf } : {}),
      }] as const;
    } catch {
      return [bee, { live: false, snapshot: "" }] as const;
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
};

function pendingNeedsInputFromEvents(
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
  return pendingNeedsInputFromEvents(await readEventTail(bee), { rootThreadId: meta?.sessionId });
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
  return hsrUsageObservationFromEvents(parseRunnerEvents(raw));
}

// Escalation grace for orphaned harness child groups (SIGTERM → SIGKILL),
// mirrors streamRunner.ts stop().
const ORPHAN_STOP_GRACE_MS = 2_000;
const ORPHAN_STOP_POLL_MS = 25;

/** Signal-0 liveness probe of a whole process group. */
function isPgidAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
export async function killOrphanedChildGroup(meta: HsrMeta | null): Promise<boolean> {
  const pgid = meta?.childPgid ?? meta?.childPid ?? 0;
  if (!isPgidAlive(pgid)) return false;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    // Died between the probe and the signal.
  }
  const deadline = Date.now() + ORPHAN_STOP_GRACE_MS;
  while (isPgidAlive(pgid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ORPHAN_STOP_POLL_MS));
  }
  if (isPgidAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // best-effort
    }
  }
  return true;
}

/**
 * Reconcile stale `queued`/`running` meta whose host pid is dead: kill the orphaned
 * harness child group it left behind (HIVE-53), flip status to "exited" (with
 * endedAt) and return the reaped bee names. Crash-adoption v1 — no pipe
 * recovery.
 */
export async function reapDeadHosts(): Promise<string[]> {
  const reaped: string[] = [];
  for (const bee of await listHsrBees()) {
    const meta = await readHsrMeta(bee);
    if (!meta || meta.status === "exited") continue;
    // A mirror has no local host pid to reap: the remoteEventMirror owns its
    // status (flips to "exited" when the bee leaves the remote list). Skip it.
    if (meta.mirrorOfNode) continue;
    if (isPidAlive(meta.hostPid)) continue;
    // The dead host never ran finalize, so its detached harness child may still
    // be running with no control plane — kill the group before flipping meta,
    // or the leak outlives the reap.
    await killOrphanedChildGroup(meta);
    await writeHsrMeta(bee, { ...meta, status: "exited", endedAt: new Date().toISOString() });
    reaped.push(bee);
  }
  return reaped;
}
