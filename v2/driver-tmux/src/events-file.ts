/**
 * Hook/notify events file (WP5, spec 05 observation source 1).
 *
 * The driver owns one jsonl path per bee (`<eventsDir>/<beeId>.events.jsonl`,
 * published to the runtime as HIVE_EVENTS_FILE); harness hooks and notify
 * programs APPEND to it, the driver tails it. This contract is NEW in v2 —
 * the v1 system had no hook installer and consumed hooks only through the
 * `@hive_state` tmux option (no timestamps, no payloads); hook installation
 * UX itself is a spec 05 non-goal.
 *
 * Accepted line shapes (one JSON object per line):
 *  - claude hook payloads, as the hook command receives them on stdin:
 *      {"hook_event_name":"UserPromptSubmit", ...} → turn_started
 *      {"hook_event_name":"Stop", ...}             → turn_ended
 *      {"hook_event_name":"Notification", ...}     → output recency
 *        (a Notification mid-turn means "waiting for permission" — v2 keeps
 *        the turn open; attention surfacing is a store/UI concern)
 *  - codex notify payloads (the argument codex passes its notify program):
 *      {"type":"agent-turn-complete", ...}         → turn_ended
 *  - the generic v2 shape, for stubs and harness-installed hooks such as agy:
 *      {"event":"turn_started"|"turn_ended"|"output"}
 */
import type { TranscriptEvent } from "./transcripts.ts";

export function parseEventsFileLine(line: string): TranscriptEvent[] {
  let row: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    row = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  // claude hook shape
  if (typeof row.hook_event_name === "string") {
    switch (row.hook_event_name) {
      case "UserPromptSubmit":
        return [{ kind: "turn_started" }];
      case "Stop":
      case "SubagentStop":
        return row.hook_event_name === "Stop" ? [{ kind: "turn_ended" }] : [{ kind: "output" }];
      case "Notification":
        return [{ kind: "output" }];
      default:
        return [];
    }
  }
  // codex notify shape
  if (row.type === "agent-turn-complete") return [{ kind: "turn_ended" }];
  // generic v2 shape
  if (row.event === "turn_started") return [{ kind: "turn_started" }];
  if (row.event === "turn_ended") return [{ kind: "turn_ended" }];
  if (row.event === "output") return [{ kind: "output" }];
  return [];
}
