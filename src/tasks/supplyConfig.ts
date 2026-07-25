// tasks — per-bee auto-supply configuration. Lives on SessionRecord
// (`taskSupply`), the house home for per-bee daemon-readable config (the
// buzAccept precedent): the daemon's tick already holds a fresh records
// snapshot, so the gate reads config without extra fs traffic, and
// updateSession gives cross-process locked read-merge-write for the CLI verb.
//
// Fields (all optional on disk; resolveTaskSupply applies defaults):
//   on     — supply loop enabled. OFF is the default for unconfigured bees.
//   limit  — breaker: max consecutive auto-feeds without human interaction.
//   feeds  — the consecutive-feed counter (incremented by the daemon per feed).
//   paused — breaker tripped; only `hive task supply <bee> --on` clears it.
//
// Breaker reset semantics (the "human interaction" definition, documented per
// the epic): the feeds counter resets on any HUMAN-SENDER buz send addressed
// to the bee, at send time, regardless of tier — hooked in sendBuzMessage
// where the sender kind is authoritative. The supply loop's own sends are
// excluded by sender name (TASK_SUPPLY_SENDER_NAME). A reset clears the
// counter only; a tripped breaker stays paused until an explicit --on.

import { loadSession, touchSession, type SessionRecord, type TaskSupplyConfig } from "../store.js";

export const DEFAULT_TASK_SUPPLY_LIMIT = 5;

/**
 * The human-sender name the supply loop sends fed task messages under
 * (`human:task-supply` in buz attribution; outbox audit copies land in
 * ~/.hive/buz/_external/task-supply/outbox/). Deliberately a human-kind
 * sender: it is not a bee, and human senders bypass the bee-to-bee accept
 * downgrade — the daemon must get the queue tier it asked for.
 */
export const TASK_SUPPLY_SENDER_NAME = "task-supply";

export type ResolvedTaskSupply = {
  on: boolean;
  limit: number;
  feeds: number;
  paused: boolean;
};

export function resolveTaskSupply(record: Pick<SessionRecord, "taskSupply">): ResolvedTaskSupply {
  const config: TaskSupplyConfig | undefined = record.taskSupply;
  return {
    on: config?.on === true,
    limit: normalizeLimit(config?.limit),
    feeds: typeof config?.feeds === "number" && Number.isFinite(config.feeds) && config.feeds > 0 ? Math.floor(config.feeds) : 0,
    paused: config?.paused === true,
  };
}

export function normalizeLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_TASK_SUPPLY_LIMIT;
}

/**
 * Reset the consecutive-feed counter on a human interaction with the bee.
 * touchSession (locked read-merge-write, no ledger row) keeps this quiet; a
 * bee with no counter is a no-op without a disk write. Never throws — a
 * bookkeeping failure must not fail the send that triggered it.
 */
export async function resetTaskSupplyFeedsForHumanInteraction(record: Pick<SessionRecord, "name" | "taskSupply">): Promise<void> {
  try {
    // Re-read fresh rather than trusting the caller's snapshot: the daemon
    // may have bumped feeds (or tripped the breaker) after the snapshot was
    // loaded, and the merge must not clobber that state with stale fields.
    const fresh = await loadSession(record.name);
    const config = fresh?.taskSupply;
    if (!config || !(typeof config.feeds === "number" && config.feeds > 0)) return;
    const { feeds: _feeds, ...rest } = config;
    await touchSession(record.name, { taskSupply: { ...rest } });
  } catch {
    // best-effort
  }
}
