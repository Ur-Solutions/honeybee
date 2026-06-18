/**
 * The attention queue — "go to the next bee that needs me".
 *
 * A bee carries a coarse @hive_state (working | waiting | done | failed; see
 * hiveState.ts). Every state except `working` means a human's attention would
 * help: `waiting` is blocked on input, `done` finished or went idle with
 * output, `failed` errored out. `hive next` cycles the attached client through
 * exactly those bees, skipping the autonomously-working majority.
 *
 * The ordering and cycling are pure (pickNextBee) so they can be tested without
 * a live tmux server; cli.ts supplies the live session list and the switch.
 */

export type AttentionState = "waiting" | "done" | "failed";

/** Non-`working` states, in the order a press should visit them. */
export const DEFAULT_ATTENTION_STATES: AttentionState[] = ["waiting", "done", "failed"];

const VALID_STATES = new Set<string>(["working", "waiting", "done", "failed"]);

export type BeeStateEntry = {
  /** tmux session name (== SessionRecord.tmuxTarget). */
  name: string;
  /** Live @hive_state, or "" when the session never stamped one. */
  state: string;
};

export type PickNextOptions = {
  /** Which @hive_state values count as "needs me". */
  states: readonly string[];
  /** Walk the queue backwards (previous instead of next). */
  prev?: boolean;
};

/**
 * Pick the next bee to switch to from the attention queue.
 *
 * The queue is the live sessions whose state is in `options.states`, ordered
 * deterministically by name so repeated presses cycle stably. If the currently
 * attached bee is itself in the queue it anchors the walk (next press lands on
 * a *different* waiting bee); otherwise the walk starts at the front (or the
 * back, for `--prev`). Returns undefined when nothing needs attention.
 */
export function pickNextBee(
  sessions: readonly BeeStateEntry[],
  current: string | undefined,
  options: PickNextOptions,
): string | undefined {
  const wanted = new Set(options.states);
  const queue = sessions
    .filter((session) => wanted.has(session.state))
    .map((session) => session.name)
    .sort((a, b) => a.localeCompare(b));
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
 * Parse a `--state waiting,done` value into a validated, de-duplicated list.
 * Throws on an unknown state so a typo surfaces instead of silently matching
 * nothing. `working` is accepted (it is a real state) for callers that want to
 * cycle the whole fleet, even though the default set excludes it.
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
      throw new Error(`Unknown state: ${part}. Valid states: ${[...VALID_STATES].join(", ")}`);
    }
    if (!seen.has(part)) {
      seen.add(part);
      result.push(part);
    }
  }
  if (result.length === 0) throw new Error("--state needs at least one state (e.g. waiting,done)");
  return result;
}
