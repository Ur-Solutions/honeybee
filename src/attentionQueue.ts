/**
 * The attention queue — the pure ordering/cycling core of `hive next` (PRD §9,
 * Tier 1). This is the "push, not pull" surface (§6): instead of scanning the
 * whole fleet, the human walks only the bees whose live `@hive_state` says they
 * need attention, oldest-first, cycling with `M-n` / `M-N`.
 *
 * Liveness and live `@hive_state` come from the local tmux server
 * (listSessionStates()); the store supplies the per-bee record + the
 * "how long in this state" timestamp. The functions here are deliberately pure
 * (no tmux, no store, no I/O) so the ordering and the next/prev cycling are unit
 * testable without a live server.
 */

/** The coarse @hive_state values that mean "this bee needs me" — never "working". */
export const DEFAULT_ATTENTION_STATES = ["waiting", "done", "failed"] as const;

/** A bee that is a candidate for the attention queue, post live-state join. */
export type AttentionCandidate = {
  /** The tmux session name (switch-client target). */
  session: string;
  /** The bee's display ref (for the confirmation line); falls back to session. */
  ref?: string;
  /** The live @hive_state read from tmux (one of the attention states). */
  state: string;
  /**
   * When the bee entered its current observable state, used for oldest-first
   * ordering. `lastObservedStateAt ?? updatedAt` at the call site; an absent /
   * unparseable value sorts last within its state group (newest).
   */
  stateSince?: string;
};

/**
 * Parse an ISO timestamp to epoch ms for ordering. Absent or unparseable values
 * become +Infinity so they sort AFTER every real timestamp (oldest-first puts
 * them last — a bee with no recorded time is treated as freshly observed).
 */
function sinceMs(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Order candidates into the attention queue:
 *   1. filter to bees whose live state is in `attentionStates`
 *   2. group by the state's position in `attentionStates` (state priority)
 *   3. within a group, oldest-first (smallest stateSince) — longest in that state
 *   4. ties broken by session name for a stable, deterministic order
 *
 * `attentionStates` is the explicit order the caller asked for (default
 * waiting → done → failed, or the `--state` comma-list). A state not in the
 * list excludes the bee entirely (working bees are never here).
 */
export function orderAttentionQueue(
  candidates: AttentionCandidate[],
  attentionStates: readonly string[],
): AttentionCandidate[] {
  const priority = new Map(attentionStates.map((state, index) => [state, index] as const));
  return candidates
    .filter((candidate) => priority.has(candidate.state))
    .slice()
    .sort((a, b) => {
      const pa = priority.get(a.state)!;
      const pb = priority.get(b.state)!;
      if (pa !== pb) return pa - pb;
      const ta = sinceMs(a.stateSince);
      const tb = sinceMs(b.stateSince);
      if (ta !== tb) return ta - tb;
      return a.session.localeCompare(b.session);
    });
}

export type PickResult = {
  target: AttentionCandidate;
  /** The 0-based index of the chosen target within the ordered queue. */
  index: number;
};

/**
 * Given the raw candidates, the attention-state order, the current tmux session
 * name, and a direction, pick the target bee:
 *   - order the queue (orderAttentionQueue)
 *   - find the current session's index; the target is the NEXT entry (or the
 *     previous with `prev`), cycling with wraparound
 *   - current not in the queue → start at index 0 (prev → the last entry)
 *   - empty queue → null (the caller prints "no bees need attention")
 *   - single-element queue → that element (next or prev both land on it)
 *
 * Pure: no tmux, no store. The unit tests drive every branch through here.
 */
export function pickNextAttentionTarget(
  candidates: AttentionCandidate[],
  attentionStates: readonly string[],
  currentSession: string | undefined,
  options: { prev?: boolean } = {},
): PickResult | null {
  const ordered = orderAttentionQueue(candidates, attentionStates);
  if (ordered.length === 0) return null;
  const prev = options.prev ?? false;

  const currentIndex = currentSession ? ordered.findIndex((c) => c.session === currentSession) : -1;
  const length = ordered.length;

  let index: number;
  if (currentIndex === -1) {
    // The current pane is not a bee in the attention set (or we are outside a
    // bee). `next` enters at the front; `prev` enters at the back.
    index = prev ? length - 1 : 0;
  } else {
    index = prev ? (currentIndex - 1 + length) % length : (currentIndex + 1) % length;
  }
  return { target: ordered[index]!, index };
}

/**
 * Parse a `--state` comma-list into the explicit attention-state order, trimming
 * blanks and de-duplicating while preserving first-seen order. Returns the
 * default order when the flag is absent/empty.
 */
export function parseAttentionStates(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_ATTENTION_STATES];
  const parsed: string[] = [];
  for (const part of raw.split(",")) {
    const state = part.trim().toLowerCase();
    if (state.length > 0 && !parsed.includes(state)) parsed.push(state);
  }
  return parsed.length > 0 ? parsed : [...DEFAULT_ATTENTION_STATES];
}
