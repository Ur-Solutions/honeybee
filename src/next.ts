/**
 * The attention queue — "go to the next bee that needs me".
 *
 * The queue is driven by the BeeView displayState (view/types.ts, ADR 001):
 * every state naming an open human request ranks ABOVE ready — needs-auth,
 * needs-reply, needs-action, then stop-failed, then ready (a settled bee whose
 * output/result awaits you). `hive next` cycles the attached client through
 * exactly those bees, skipping the autonomously-working majority.
 * (BEEVIEW_READ_API.md decision 4: this replaced the coarse @hive_state
 * vocabulary — operator-approved behavior change.)
 *
 * The ordering and cycling are pure (pickNextBee) so they can be tested without
 * a live observation pass; commands/observe.ts supplies the projected views and
 * the switch.
 */

import type { BeeDisplayState } from "./view/types.js";

export type AttentionState = BeeDisplayState;

/**
 * Display states that mean a human's attention would help, in rank order: open
 * requests first, then a failed stop, then settled bees awaiting review.
 * working/starting bees are autonomous; crashed/offline/retired/unreachable
 * bees have no live local session to switch to.
 */
export const DEFAULT_ATTENTION_STATES: AttentionState[] = ["needs-auth", "needs-reply", "needs-action", "stop-failed", "ready"];

const VALID_STATES = new Set<string>([
  "retired", "needs-auth", "needs-reply", "needs-action", "stop-failed",
  "crashed", "unreachable", "starting", "working", "ready", "offline",
]);

export type BeeStateEntry = {
  /** tmux session name (== SessionRecord.tmuxTarget). */
  name: string;
  /** The bee's BeeView displayState. */
  state: string;
};

export type PickNextOptions = {
  /** Which display states count as "needs me", in visiting order. */
  states: readonly string[];
  /** Walk the queue backwards (previous instead of next). */
  prev?: boolean;
};

/**
 * Pick the next bee to switch to from the attention queue.
 *
 * The queue is the sessions whose state is in `options.states`, grouped by
 * that list's order (so with the default set every needs-* bee is visited
 * before any ready one) and ordered by name within a group, so repeated
 * presses cycle stably. If the currently attached bee is itself in the queue
 * it anchors the walk (next press lands on a *different* bee); otherwise the
 * walk starts at the front (or the back, for `--prev`). Returns undefined
 * when nothing needs attention.
 */
export function pickNextBee(
  sessions: readonly BeeStateEntry[],
  current: string | undefined,
  options: PickNextOptions,
): string | undefined {
  const rank = new Map(options.states.map((state, index) => [state, index]));
  const queue = sessions
    .filter((session) => rank.has(session.state))
    .sort((a, b) => rank.get(a.state)! - rank.get(b.state)! || a.name.localeCompare(b.name))
    .map((session) => session.name);
  if (queue.length === 0) return undefined;

  const step = options.prev ? -1 : 1;
  const index = current ? queue.indexOf(current) : -1;
  if (index === -1) return options.prev ? queue[queue.length - 1] : queue[0];
  return queue[(index + step + queue.length) % queue.length];
}

/** How many bees are in the attention set for the given states. */
export function attentionCount(sessions: readonly BeeStateEntry[], states: readonly string[]): number {
  const wanted = new Set(states);
  return sessions.reduce((count, session) => (wanted.has(session.state) ? count + 1 : count), 0);
}

/**
 * Parse a `--state needs-reply,ready` value into a validated, de-duplicated
 * list. Throws on an unknown state so a typo surfaces instead of silently
 * matching nothing. Any display state is accepted (`working` too) for callers
 * that want to cycle the whole fleet, even though the default set excludes it.
 */
export function parseStateList(value: string): string[] {
  const parts = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    if (!VALID_STATES.has(part)) {
      throw new Error(`Unknown display state: ${part}. Valid states: ${[...VALID_STATES].join(", ")}`);
    }
    if (!seen.has(part)) {
      seen.add(part);
      result.push(part);
    }
  }
  if (result.length === 0) throw new Error("--state needs at least one state (e.g. needs-reply,ready)");
  return result;
}
