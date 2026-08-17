/**
 * Transcript-file observers (WP5, spec 05 observation source 2 — the
 * MANDATORY baseline for every supported harness under A3).
 *
 * Every harness CLI writes session/transcript files; the adapter tails the
 * bee's transcript and derives turn boundaries + output recency from file
 * truth. Formats below are distilled from the v1 tree's transcript layer
 * (src/transcripts/{claude,codex,grok}.ts and src/threadCopy.ts, read-only
 * reference — v2 imports nothing from it).
 *
 * Per-harness confidence (documented per the spec):
 *
 *  - claude  — HIGH (format). Path `~/.claude/projects/<projectKey>/<sessionId>.jsonl`,
 *    projectKey = resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g,"-").
 *    Rows `{type:"user"|"assistant", timestamp, message:{role,content},
 *    sessionId, uuid, isSidechain?, isMeta?}`. Turn start = user row that is
 *    not a sidechain/meta row and carries real text (v1 threadCopy.ts
 *    isTurnStartRow). NO explicit turn-end record exists in the file —
 *    turn_ended is quiescence-derived here, and the v1 incident record
 *    (2026-07-13: claude emits mid-turn lulls during long tool chains) is
 *    why hooks (Stop) are the preferred source when present. Confidence on
 *    quiescence-derived ends: MEDIUM — verify against a live stream in the
 *    WP5 manual smoke.
 *
 *  - codex   — HIGH. Path `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
 *    Rows `{timestamp, type, payload}`: `turn_context` marks a turn start,
 *    `event_msg`/`task_started` its prelude, `event_msg`/`task_complete` an
 *    EXPLICIT turn end, `event_msg`/`agent_message` + `response_item`
 *    assistant messages are output. (Messages appear twice — event_msg and
 *    response_item — which the phase machine dedups naturally.)
 *
 *  - grok    — MEDIUM (fixture-derived; the transcript-only observer
 *    PATTERN). Path `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl`
 *    with a sibling summary.json. Rows: role from `message.role ?? type`,
 *    content string or `[{type:"text",text}]` blocks. No explicit end →
 *    quiescence-derived, like claude. Shapes come from v1's fixtures
 *    (tests/transcripts.test.ts), NOT from a captured live stream — verify
 *    in a real-grok smoke before relying on it in production.
 */
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";

export type TranscriptEvent =
  | { kind: "turn_started" }
  | { kind: "turn_ended" }
  /** Output/recency evidence (assistant text, tool traffic, …). */
  | { kind: "output" };

export interface TranscriptParser {
  readonly harness: string;
  /**
   * Whether this format carries an explicit turn-completion record. When
   * false the observer derives turn_ended from quiescence (no appends for
   * the configured window after output was seen).
   */
  readonly explicitTurnEnd: boolean;
  /** Pure, stateless: one raw transcript line → zero or more events. */
  parseLine(line: string): TranscriptEvent[];
}

function jsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Partial/corrupt line while the provider is still writing — skip
    // (the v1 readJsonl tolerance).
  }
  return null;
}

/** v1 threadCopy.isTurnStartRow: real user text, not tool-result carriage. */
function hasUserText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(
      (b) => b != null && typeof b === "object" && (b as { type?: unknown }).type === "text",
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// claude — ~/.claude/projects/<projectKey>/<sessionId>.jsonl
// ---------------------------------------------------------------------------

export const claudeTranscriptParser: TranscriptParser = {
  harness: "claude",
  explicitTurnEnd: false,
  parseLine(line: string): TranscriptEvent[] {
    const row = jsonLine(line);
    if (!row) return [];
    if (row.isSidechain === true || row.isMeta === true) return [];
    const message = row.message as { content?: unknown } | undefined;
    if (row.type === "user" && hasUserText(message?.content)) return [{ kind: "turn_started" }];
    if (row.type === "assistant") return [{ kind: "output" }];
    return [];
  },
};

/** The v1 project-key derivation for a claude transcript dir. */
export function claudeProjectKey(cwd: string): string {
  return resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
}

// ---------------------------------------------------------------------------
// codex — ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// ---------------------------------------------------------------------------

export const codexTranscriptParser: TranscriptParser = {
  harness: "codex",
  explicitTurnEnd: true,
  parseLine(line: string): TranscriptEvent[] {
    const row = jsonLine(line);
    if (!row) return [];
    const payload = row.payload as { type?: unknown; role?: unknown } | undefined;
    if (row.type === "turn_context") return [{ kind: "turn_started" }];
    if (row.type === "event_msg") {
      if (payload?.type === "task_started") return [{ kind: "turn_started" }];
      if (payload?.type === "task_complete") return [{ kind: "turn_ended" }];
      if (payload?.type === "agent_message") return [{ kind: "output" }];
      return [];
    }
    if (row.type === "response_item" && payload?.type === "message" && payload.role === "assistant") {
      return [{ kind: "output" }];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// grok — ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/chat_history.jsonl
// (the transcript-only PATTERN: fixture-driven, no explicit end record)
// ---------------------------------------------------------------------------

export const grokTranscriptParser: TranscriptParser = {
  harness: "grok",
  explicitTurnEnd: false,
  parseLine(line: string): TranscriptEvent[] {
    const row = jsonLine(line);
    if (!row) return [];
    const message = row.message as { role?: unknown; content?: unknown } | undefined;
    const role = typeof message?.role === "string" ? message.role : row.type;
    const content = message?.content ?? row.content;
    // Live-file finding (2026-08-17 tmux smoke prep): grok appends SYNTHETIC
    // user rows (`synthetic_reason: "system_reminder" | "task_completed" | …`)
    // for injected context — real user text shape, but not a prompt. They can
    // arrive while idle with no response following, so treating them as turn
    // starts would open a turn that never ends (quiescence needs output).
    if (role === "user" && row.synthetic_reason != null) return [];
    if (role === "user" && hasUserText(content)) return [{ kind: "turn_started" }];
    if (role === "assistant") return [{ kind: "output" }];
    return [];
  },
};

export const TRANSCRIPT_PARSERS: Record<string, TranscriptParser> = {
  claude: claudeTranscriptParser,
  codex: codexTranscriptParser,
  grok: grokTranscriptParser,
};

// ---------------------------------------------------------------------------
// discovery — bind the newest matching file created around/after spawn
// ---------------------------------------------------------------------------

export interface TranscriptLocator {
  /** Directory to search (harness-specific, resolved by the caller). */
  dir: string;
  /** Filename filter (default: *.jsonl). */
  match?: RegExp;
  /** Recursive search depth (codex nests YYYY/MM/DD). Default 5. */
  depth?: number;
}

/**
 * Newest transcript file matching the locator whose mtime is at/after
 * `notBeforeMs` (the v1 created-floor idea, tightened to the exact spawn
 * stamp: a PREVIOUS generation's transcript in the same dir must never be
 * cross-matched to a fresh runtime — everything is same-clock local here).
 */
export function findTranscript(locator: TranscriptLocator, notBeforeMs: number): string | null {
  const match = locator.match ?? /\.jsonl$/;
  const maxDepth = locator.depth ?? 5;
  const floor = notBeforeMs;
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
        continue;
      }
      if (!match.test(entry.name)) continue;
      let mtime: number;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < floor) continue;
      if (best == null || mtime > best.mtime) best = { path: p, mtime };
    }
  };
  walk(locator.dir, 0);
  return best == null ? null : (best as { path: string; mtime: number }).path;
}
