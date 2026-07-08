import { normalizeForMatch, rowsContainPrompt } from "./text.js";
import type { TranscriptFile, TranscriptLookupOptions, TranscriptRow } from "./types.js";
import { samePath } from "./util.js";

const SCORE = {
  path: 2_000,
  sessionId: 1_000,
  prompt: 500,
  spawnProximity: 300,
  cwd: 200,
  since: 10,
};

export function scoreTranscript(input: { rows: TranscriptRow[]; path: string; sessionId: string; startedAtMs?: number; mtimeMs: number; cwd?: string; transcriptCwd?: string; options: TranscriptLookupOptions; promptMatches?: Map<string, boolean> }) {
  const { rows, path, sessionId, startedAtMs, mtimeMs, cwd, transcriptCwd, options, promptMatches } = input;
  let score = mtimeMs / 1_000_000_000_000;
  const matchedBy: string[] = ["mtime"];

  if (options.transcriptPath && samePath(options.transcriptPath, path)) {
    score += SCORE.path;
    matchedBy.push("path");
  }
  if (options.sessionId && options.sessionId === sessionId) {
    score += SCORE.sessionId;
    matchedBy.push("session-id");
  }
  if (options.prompt && memoizedPromptMatch(rows, options.prompt, promptMatches)) {
    score += SCORE.prompt;
    matchedBy.push("prompt");
  }
  if (options.notBeforeIso && startedAtMs !== undefined) {
    const spawnedAt = Date.parse(options.notBeforeIso);
    if (Number.isFinite(spawnedAt) && startedAtMs >= spawnedAt - CREATED_FLOOR_GRACE_MS) {
      const distanceSeconds = Math.abs(startedAtMs - spawnedAt) / 1_000;
      const proximity = Math.max(0, SCORE.spawnProximity - distanceSeconds);
      if (proximity > 0) {
        score += proximity;
        matchedBy.push("spawn-proximity");
      }
    }
  }
  if (cwd && transcriptCwd && samePath(transcriptCwd, cwd)) {
    score += SCORE.cwd;
    matchedBy.push("cwd");
  }
  if (options.sinceIso && mtimeMs >= Date.parse(options.sinceIso) - 5_000) {
    score += SCORE.since;
    matchedBy.push("since");
  }

  return { score, matchedBy };
}

/**
 * Did this transcript match on evidence that actually ties it to the bee
 * (explicit path/session-id anchor, the bee's own prompt text, or spawn-time
 * proximity) — as opposed to circumstantial mtime/cwd/since overlap? Weakly
 * matched transcripts are fine to *display* as a best guess, but must never be
 * persisted as a bee's identity or used to title it: any sibling in the same
 * cwd folder "matches" that way, which is how one fresh bee's transcript
 * mass-overwrote its neighbours' titles and session ids.
 */
export function isAnchoredTranscriptMatch(tx: { matchedBy: string[] }): boolean {
  return tx.matchedBy.some((match) => match === "path" || match === "session-id" || match === "prompt" || match === "spawn-proximity");
}

function memoizedPromptMatch(rows: TranscriptRow[], prompt: string, memo?: Map<string, boolean>): boolean {
  if (!memo) return rowsContainPrompt(rows, prompt);
  const key = normalizeForMatch(prompt);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const result = rowsContainPrompt(rows, prompt);
  memo.set(key, result);
  return result;
}

export function bestTranscript(loaded: TranscriptFile[], options: TranscriptLookupOptions = {}): TranscriptFile | null {
  const eligible = loaded.filter((tx) => passesCreatedFloor(tx, options));
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.mtimeMs - a.mtimeMs;
  });
  return eligible[0] ?? null;
}

// Clock-skew / boot-latency cushion: the agent writes its first transcript row
// shortly AFTER we stamp the bee's createdAt, so a real own-transcript clears
// the floor comfortably; the cushion only forgives sub-second skew.
const CREATED_FLOOR_GRACE_MS = 5_000;

/**
 * A transcript clears the floor when the bee was spawned no later than the
 * session's first activity. An explicit id/path match is authoritative
 * (resumed/anchored bees legitimately reopen an older session), so it always
 * passes regardless of the floor.
 */
function passesCreatedFloor(tx: TranscriptFile, options: TranscriptLookupOptions): boolean {
  if (!options.notBeforeIso) return true;
  if (tx.matchedBy.includes("session-id") || tx.matchedBy.includes("path")) return true;
  const floor = Date.parse(options.notBeforeIso) - CREATED_FLOOR_GRACE_MS;
  if (!Number.isFinite(floor)) return true;
  const start = tx.startedAtMs ?? transcriptStartMs(tx.rows);
  return start === null || start >= floor;
}

/** Earliest parseable row timestamp = when the provider session began. */
export function transcriptStartMs(rows: TranscriptRow[]): number | null {
  let min: number | null = null;
  for (const row of rows) {
    const ms = parseTimestampMs(row.timestamp);
    if (ms === null) continue;
    if (min === null || ms < min) min = ms;
  }
  return min;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.length === 0) return null;
  // OpenCode stamps epoch-ms as a string; everything else is ISO-8601.
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
