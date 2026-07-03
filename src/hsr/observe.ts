/**
 * HSR cross-process run-dir observer (APIA-78).
 *
 * The daemon, `hive bees`, and SubstrateHsr do NOT hold runner pipes — the
 * detached host does (HSR_EXPLORATION.md §7). They observe HSR bees purely by
 * reading run dirs: liveness from meta.json's host pid, snapshot from ring.txt.
 *
 * Liveness model: the HOST pid is authoritative. A bee is alive iff its meta
 * says `status: "running"` AND the host process is still alive — the host owns
 * the harness child's pipes, so a dead host means the live protocol stream is
 * gone regardless of whether the harness child lingers. "Crash adoption v1"
 * (`reapDeadHosts`) reconciles stale `running` meta with dead host pids; it does
 * not recover pipes.
 *
 * Node builtins only.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import type { BeeState } from "../state.js";
import {
  hsrEventsPath,
  hsrMetaPath,
  hsrRingPath,
  hsrRoot,
  readHsrMeta,
  writeHsrMeta,
} from "./runDir.js";
import type { RunnerEvent } from "./types.js";

/** Signal-0 liveness probe; EPERM means the pid exists but isn't ours. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** All bees with a run dir containing a meta.json, sorted. */
export async function listHsrBees(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(hsrRoot());
  } catch {
    return []; // no hsr root yet
  }
  const bees: string[] = [];
  for (const name of names) {
    try {
      await stat(hsrMetaPath(name));
      bees.push(name);
    } catch {
      // no meta.json (or not a dir) — not an HSR run dir
    }
  }
  return bees.sort();
}

/** bee → alive (host-pid authoritative; see file docs). */
export async function hsrLiveness(): Promise<Map<string, boolean>> {
  const liveness = new Map<string, boolean>();
  for (const bee of await listHsrBees()) {
    const meta = await readHsrMeta(bee);
    const alive = !!meta && meta.status === "running" && isPidAlive(meta.hostPid);
    liveness.set(bee, alive);
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

/** How many trailing events.jsonl lines the structured-state reader inspects. */
const EVENT_TAIL_LINES = 200;

/**
 * A single HSR bee's cross-process observation, read purely from its run dir:
 *   live     — host-pid liveness (see file docs).
 *   state    — a STRUCTURED BeeState derived from the events.jsonl tail, or
 *              undefined when the bee is not live (deriveState resolves
 *              dead/sealed) or no structured signal exists yet.
 *   snapshot — the rendered ring text tail (used as an output fallback).
 */
export type HsrObservation = { live: boolean; state?: BeeState; snapshot: string };

/**
 * Derive a BeeState from the tail of events.jsonl. Only the last few turn
 * markers matter, so we scan the parsed tail for the last turn_start/turn_end
 * and the last needs_input:
 *   - a needs_input with no later turn_end (unresolved) → "blocked".
 *   - a turn in flight (last marker is turn_start) → "active".
 *   - the last turn finished (turn_end) → "idle_with_output".
 *   - no turn markers yet: any assistant text already → "ready", else "booting".
 * Returns undefined when the tail carries no usable signal at all (empty log).
 */
function structuredStateFromEvents(events: RunnerEvent[]): BeeState | undefined {
  let lastStart = -1;
  let lastEnd = -1;
  let lastNeeds = -1;
  let hasText = false;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    switch (event.type) {
      case "turn_start":
        lastStart = i;
        break;
      case "turn_end":
        lastEnd = i;
        break;
      case "needs_input":
        lastNeeds = i;
        break;
      case "text":
        if (event.text.length > 0) hasText = true;
        break;
      default:
        break;
    }
  }
  // An unresolved needs_input (nothing finished the turn after it) blocks the bee.
  if (lastNeeds >= 0 && lastNeeds > lastEnd) return "blocked";
  // A turn is in flight when the last turn marker is a start with no later end.
  if (lastStart > lastEnd) return "active";
  // A completed turn: the bee produced output and is now waiting.
  if (lastEnd >= 0) return "idle_with_output";
  // No turn markers yet — still coming up. Any assistant text already means the
  // session is talking (ready); otherwise it is still booting.
  if (hasText) return "ready";
  return "booting";
}

/**
 * Read the tail of a bee's events.jsonl and parse it into RunnerEvents. Tolerates
 * a missing/partial file and unparseable lines (a truncated crash write) — a bad
 * line is skipped, never thrown.
 */
async function readEventTail(bee: string, lines: number): Promise<RunnerEvent[]> {
  let raw: string;
  try {
    raw = await readFile(hsrEventsPath(bee), "utf8");
  } catch {
    return [];
  }
  const all = raw.split("\n").filter((line) => line.trim().length > 0);
  const tail = all.slice(Math.max(0, all.length - lines));
  const events: RunnerEvent[] = [];
  for (const line of tail) {
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

/**
 * Batch structured observation of every HSR bee, read purely from run dirs (no
 * tmux). Threaded through StateContext so BOTH `hive bees` and the daemon tick
 * derive HSR state and drive transitions/buz-drain from the same source. Never
 * throws: a bad bee yields `{ live: false, snapshot: "" }`.
 */
export async function hsrObservations(): Promise<Map<string, HsrObservation>> {
  const observations = new Map<string, HsrObservation>();
  for (const bee of await listHsrBees()) {
    try {
      const meta = await readHsrMeta(bee);
      const live = !!meta && meta.status === "running" && isPidAlive(meta.hostPid);
      const snapshot = await hsrSnapshot(bee);
      // A dead host's stream is gone — leave state undefined so deriveState
      // settles dead/sealed rather than reporting a stale structured state.
      const state = live ? structuredStateFromEvents(await readEventTail(bee, EVENT_TAIL_LINES)) : undefined;
      observations.set(bee, state === undefined ? { live, snapshot } : { live, state, snapshot });
    } catch {
      observations.set(bee, { live: false, snapshot: "" });
    }
  }
  return observations;
}

/**
 * The pending needs-input a blocked HSR bee is waiting on, read from the events
 * tail. Used by the daemon's needs-input → parent-buz router and `hive answer`.
 * `requestId` falls back to the stable literal "pending" when the emitting event
 * carried none, so callers always have a de-dupe/answer key.
 */
export type PendingNeedsInput = {
  requestId: string;
  kind: "permission" | "question";
  question: string;
  tool?: string;
  options?: string[];
};

/**
 * The LAST needs_input event in the tail that has no later turn_end — i.e. the
 * unresolved request the bee is currently blocked on (mirrors the "blocked"
 * rule in structuredStateFromEvents). Null when the bee is not live or has no
 * pending request. Never throws.
 */
export async function pendingNeedsInput(bee: string): Promise<PendingNeedsInput | null> {
  const meta = await readHsrMeta(bee);
  if (!meta || meta.status !== "running" || !isPidAlive(meta.hostPid)) return null;
  const events = await readEventTail(bee, EVENT_TAIL_LINES);
  let lastNeeds = -1;
  let lastEnd = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "needs_input") lastNeeds = i;
    else if (event.type === "turn_end") lastEnd = i;
  }
  // Unresolved iff a needs_input is the last turn marker (nothing ended after it).
  if (lastNeeds < 0 || lastNeeds <= lastEnd) return null;
  const event = events[lastNeeds] as Extract<RunnerEvent, { type: "needs_input" }>;
  return {
    requestId: event.requestId ?? "pending",
    kind: event.kind,
    question: event.question,
    ...(event.tool ? { tool: event.tool } : {}),
    ...(event.options ? { options: event.options } : {}),
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
 * Reads the whole log (as readEventTail already does under the hood) but is
 * tolerant of a missing/partial/torn file — a bad line is skipped, never thrown.
 */
export type HsrUsageObservation = {
  totals: { inputTokens: number; outputTokens: number } | null;
  latestExhausted?: { ts: number; resetHint?: string };
};

export async function hsrUsageObservation(bee: string): Promise<HsrUsageObservation> {
  let raw: string;
  try {
    raw = await readFile(hsrEventsPath(bee), "utf8");
  } catch {
    return { totals: null };
  }
  let input = 0;
  let output = 0;
  let sawUsage = false;
  let latestExhausted: { ts: number; resetHint?: string } | undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: RunnerEvent;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") continue;
      event = parsed as RunnerEvent;
    } catch {
      continue; // torn / partial line
    }
    if (event.type === "usage") {
      sawUsage = true;
      if (typeof event.inputTokens === "number" && Number.isFinite(event.inputTokens)) input += event.inputTokens;
      if (typeof event.outputTokens === "number" && Number.isFinite(event.outputTokens)) output += event.outputTokens;
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

/**
 * Reconcile stale `running` meta whose host pid is dead: flip status to
 * "exited" (with endedAt) and return the reaped bee names. Crash-adoption v1 —
 * no pipe recovery.
 */
export async function reapDeadHosts(): Promise<string[]> {
  const reaped: string[] = [];
  for (const bee of await listHsrBees()) {
    const meta = await readHsrMeta(bee);
    if (!meta || meta.status !== "running") continue;
    if (isPidAlive(meta.hostPid)) continue;
    await writeHsrMeta(bee, { ...meta, status: "exited", endedAt: new Date().toISOString() });
    reaped.push(bee);
  }
  return reaped;
}
