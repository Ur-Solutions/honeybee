// ──────────────────────────────────────────────────────────────────────────
// Per-message SpendEvent extraction from on-disk harness transcripts. Reads are
// pure: rows are handed in already-parsed with their 0-based line offsets, and
// we emit atomic ledger events (one API call each). No I/O here — discovery and
// appending live in discover.ts / ingest.ts.
//
// The `id` on each event is the dedup key. It MUST be reproducible from the same
// source line so re-extracting an unchanged (or grown) file never double-counts:
//   - claude → `claude:${requestId||message.id||uuid}` (all stable on-disk).
//   - codex  → `codex:${sessionId}:${turnIndex}` (deterministic by position).
// ──────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Harness, Seat, SpendEvent, TokenCounts } from "./types.js";
import { zeroTokens } from "./types.js";
import type { TranscriptRow } from "../transcripts/types.js";

/**
 * A parsed transcript row paired with its 0-based line index in the source
 * file. ingest.ts builds these from the full file so codex cumulative deltas
 * and claude offsets are both correct; extraction never re-reads the file.
 */
export type RowWithOffset = { row: TranscriptRow; offset: number };

function num(object: Record<string, unknown> | undefined, key: string): number {
  const value = object?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countToolUse(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") count += 1;
  }
  return count;
}

/**
 * One SpendEvent per assistant row carrying message.usage. Cache writes split by
 * TTL from usage.cache_creation.ephemeral_5m/1h_input_tokens; when that object is
 * absent all cache_creation_input_tokens fold into the 5m tier (verified shape in
 * SPEND_SPEC). isSubagent tracks claude's isSidechain flag.
 */
export function extractClaudeEvents(rows: RowWithOffset[], sourceFile: string, seat: Seat): SpendEvent[] {
  const events: SpendEvent[] = [];
  for (const { row, offset } of rows) {
    const message = row.message as
      | { model?: string; id?: string; content?: unknown; usage?: Record<string, unknown> }
      | undefined;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object") continue;

    const tokens: TokenCounts = zeroTokens();
    tokens.input = num(usage, "input_tokens");
    tokens.output = num(usage, "output_tokens");
    tokens.cacheRead = num(usage, "cache_read_input_tokens");
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
    if (cacheCreation && typeof cacheCreation === "object") {
      tokens.cacheWrite5m = num(cacheCreation, "ephemeral_5m_input_tokens");
      tokens.cacheWrite1h = num(cacheCreation, "ephemeral_1h_input_tokens");
    } else {
      // No TTL breakdown on this row → attribute the whole cache write to 5m.
      tokens.cacheWrite5m = num(usage, "cache_creation_input_tokens");
    }

    const requestId = typeof row.requestId === "string" ? row.requestId : undefined;
    const messageId = typeof message?.id === "string" ? message.id : undefined;
    const uuid = typeof row.uuid === "string" ? row.uuid : undefined;
    // requestId/uuid are always present on real claude assistant rows; randomUUID
    // is a last-ditch fallback that (rarely) makes an id non-reproducible.
    const id = `claude:${requestId ?? messageId ?? uuid ?? randomUUID()}`;

    const sessionId =
      (typeof row.sessionId === "string" && row.sessionId) ||
      (typeof row.session_id === "string" && row.session_id) ||
      "";

    events.push({
      id,
      ts: typeof row.timestamp === "string" ? row.timestamp : "",
      harness: "claude",
      seat: seat.id,
      sessionId,
      isSubagent: row.isSidechain === true,
      model: typeof message?.model === "string" ? message.model : "unknown",
      tokens,
      toolUseCount: countToolUse(message?.content),
      sourceFile,
      sourceOffset: offset,
    });
  }
  return events;
}

/**
 * Codex reports CUMULATIVE token_count.info.total_token_usage, not per-message.
 * We derive per-turn deltas from consecutive token_count events. Reliable per-turn
 * attribution IS possible here (the running total is monotonic within a session),
 * so we emit one event per non-empty delta rather than a single session-level
 * total. Notes:
 *   - input_tokens is the FULL input (cached included); cached_input_tokens is the
 *     cached subset → tokens.input = inputDelta - cachedDelta, tokens.cacheRead =
 *     cachedDelta. Codex has no 5m/1h split, so cacheWrite tiers stay 0.
 *   - A downward jump in the cumulative total means the session compacted/reset;
 *     we rebase from zero for that row so the post-reset turn is still counted.
 *   - model comes from turn_context.payload.model (session_meta only carries the
 *     provider); we attribute each delta to the most recently seen model.
 */
export function extractCodexEvents(rows: RowWithOffset[], sourceFile: string, seat: Seat): SpendEvent[] {
  const events: SpendEvent[] = [];
  let sessionId = "";
  let model = "";
  let turnIndex = 0;
  let prevInput = 0;
  let prevCached = 0;
  let prevOutput = 0;

  for (const { row, offset } of rows) {
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") continue;

    // session_meta (first row) fixes the session id; turn_context carries the
    // live model id, which can change mid-session.
    if (row.type === "session_meta") {
      const id = payload.id;
      if (typeof id === "string" && id) sessionId = id;
    }
    if (typeof payload.model === "string" && payload.model) model = payload.model;

    if (payload.type !== "token_count") continue;
    const info = payload.info as Record<string, unknown> | undefined;
    const totals = info?.total_token_usage as Record<string, unknown> | undefined;
    if (!totals || typeof totals !== "object") continue; // rate-limit-only rows have info:null

    const curInput = num(totals, "input_tokens");
    const curCached = num(totals, "cached_input_tokens");
    const curOutput = num(totals, "output_tokens");

    const reset = curInput < prevInput || curOutput < prevOutput;
    const baseInput = reset ? 0 : prevInput;
    const baseCached = reset ? 0 : prevCached;
    const baseOutput = reset ? 0 : prevOutput;

    const inputDelta = Math.max(0, curInput - baseInput);
    const cachedDelta = Math.max(0, curCached - baseCached);
    const outputDelta = Math.max(0, curOutput - baseOutput);

    prevInput = curInput;
    prevCached = curCached;
    prevOutput = curOutput;

    const tokens: TokenCounts = zeroTokens();
    tokens.input = Math.max(0, inputDelta - cachedDelta);
    tokens.cacheRead = cachedDelta;
    tokens.output = outputDelta;
    if (tokens.input === 0 && tokens.cacheRead === 0 && tokens.output === 0) continue;

    const sid = sessionId || basename(sourceFile).replace(/\.jsonl$/, "");
    events.push({
      id: `codex:${sid}:${turnIndex}`,
      ts: typeof row.timestamp === "string" ? row.timestamp : "",
      harness: "codex",
      seat: seat.id,
      sessionId: sid,
      model: model || "unknown",
      tokens,
      sourceFile,
      sourceOffset: offset,
    });
    turnIndex += 1;
  }
  return events;
}

/** Dispatch to the per-harness extractor. Unsupported harnesses emit nothing. */
export function extractEvents(
  harness: Harness,
  rows: RowWithOffset[],
  sourceFile: string,
  seat: Seat,
): SpendEvent[] {
  if (harness === "claude") return extractClaudeEvents(rows, sourceFile, seat);
  if (harness === "codex") return extractCodexEvents(rows, sourceFile, seat);
  // grok/opencode transcripts are not yet priced — no extractor exists.
  return [];
}
