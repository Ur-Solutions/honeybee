import type { CorpusReader, SearchHit, SearchHitType, SearchOptions, SearchResult } from "../search.js";
import { passesLedgerFilters, redactSearchText, sealHaystack, sessionHaystack } from "./haystacks.js";

const DEFAULT_LIMIT = 30;
const MAX_REGEX_LENGTH = 256;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;
const SNIPPET_CAP = SNIPPET_BEFORE + SNIPPET_AFTER; // 120 total chars

// Ranking weights. The exact numbers don't matter, only their relative order:
// seals dominate ledger which dominates sessions. Recency is encoded via a
// per-corpus age decay so a 1-second-old session hit can't outrank a 1-month-
// old seal hit.
const CORPUS_RANK: Record<SearchHitType, number> = {
  seal: 3_000_000,
  ledger: 2_000_000,
  session: 1_000_000,
};

export async function search(options: SearchOptions, reader: CorpusReader): Promise<SearchResult> {
  const matcher = compileMatcher(options);
  const limit = options.limit === undefined ? DEFAULT_LIMIT : Math.max(0, Math.floor(options.limit));
  const wantSeals = !options.types || options.types.has("seals");
  const wantLedger = !options.types || options.types.has("ledger");
  const wantSessions = !options.types || options.types.has("sessions");

  const hits: SearchHit[] = [];
  let truncated = false;
  const limitReached = () => limit > 0 && hits.length >= limit;

  if (wantSeals) {
    for await (const { path, record } of reader.readSeals({
      ...(options.colony ? { colony: options.colony } : {}),
      ...(options.swarm ? { swarm: options.swarm } : {}),
      ...(options.bee ? { bee: options.bee } : {}),
      ...(options.status ? { status: options.status } : {}),
    })) {
      const matchedAtMs = Date.parse(record.sealedAt);
      if (options.sinceMs !== undefined && (!Number.isFinite(matchedAtMs) || matchedAtMs < options.sinceMs)) continue;
      const text = sealHaystack(record);
      const match = matcher.find(text);
      if (!match) continue;
      const snippet = makeSnippet(text, match.start, match.end);
      hits.push({
        type: "seal",
        path,
        beeName: record.beeName,
        snippet: snippet.text,
        matchStartInSnippet: snippet.matchStart,
        matchEndInSnippet: snippet.matchEnd,
        score: scoreHit("seal", record.sealedAt),
        matchedAt: record.sealedAt,
      });
    }
  }

  if (wantLedger) {
    if (limitReached()) {
      truncated = true;
    } else {
      for await (const { path, line, parsed, ts, lineNumber } of reader.readLedgerLines({
        ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}),
      })) {
        if (isOutsideSinceWindow(ts, options.sinceMs)) continue;
        if (!passesLedgerFilters(parsed, options)) continue;
        const text = redactSearchText(line);
        const match = matcher.find(text);
        if (!match) continue;
        const snippet = makeSnippet(text, match.start, match.end);
        hits.push({
          type: "ledger",
          path: lineNumber === undefined ? path : `${path}:${lineNumber}`,
          snippet: snippet.text,
          matchStartInSnippet: snippet.matchStart,
          matchEndInSnippet: snippet.matchEnd,
          score: scoreHit("ledger", ts),
          matchedAt: ts,
        });
        if (limitReached()) {
          truncated = true;
          break;
        }
      }
    }
  }

  if (wantSessions) {
    if (limitReached()) {
      truncated = true;
    } else {
      for await (const { path, record } of reader.readSessionRecords({
        ...(options.colony ? { colony: options.colony } : {}),
        ...(options.swarm ? { swarm: options.swarm } : {}),
        ...(options.bee ? { bee: options.bee } : {}),
      })) {
        const matchedAt = record.updatedAt ?? record.createdAt ?? "";
        const matchedAtMs = Date.parse(matchedAt);
        if (options.sinceMs !== undefined && (!Number.isFinite(matchedAtMs) || matchedAtMs < options.sinceMs)) continue;
        const text = sessionHaystack(record);
        const match = matcher.find(text);
        if (!match) continue;
        const snippet = makeSnippet(text, match.start, match.end);
        hits.push({
          type: "session",
          path,
          beeName: record.name,
          snippet: snippet.text,
          matchStartInSnippet: snippet.matchStart,
          matchEndInSnippet: snippet.matchEnd,
          score: scoreHit("session", matchedAt),
          matchedAt,
        });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return { hits: limit > 0 ? hits.slice(0, limit) : hits, truncated: truncated || (limit > 0 && hits.length > limit) };
}

type CompiledMatcher = { find(text: string): { start: number; end: number } | null };

export function compileMatcher(options: SearchOptions): CompiledMatcher {
  if (!options.query) throw new Error("hive search requires a non-empty query");
  if (options.regex) {
    if (options.query.length > MAX_REGEX_LENGTH) {
      throw new Error(`--regex pattern too long (max ${MAX_REGEX_LENGTH} characters)`);
    }
    const flags = options.caseSensitive ? "" : "i";
    let re: RegExp;
    try {
      re = new RegExp(options.query, flags);
    } catch (error) {
      throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      find(text: string): { start: number; end: number } | null {
        const match = re.exec(text);
        if (!match) return null;
        return { start: match.index, end: match.index + match[0].length };
      },
    };
  }
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  return {
    find(text: string): { start: number; end: number } | null {
      const haystack = options.caseSensitive ? text : text.toLowerCase();
      const idx = haystack.indexOf(needle);
      if (idx === -1) return null;
      return { start: idx, end: idx + needle.length };
    },
  };
}

export function makeSnippet(text: string, matchStart: number, matchEnd: number): {
  text: string;
  matchStart: number;
  matchEnd: number;
} {
  // Compute a window of SNIPPET_BEFORE chars before the match and SNIPPET_AFTER
  // after, then clamp to text boundaries. Use raw character offsets so the
  // caller can apply ANSI highlighting without re-running the search.
  let start = Math.max(0, matchStart - SNIPPET_BEFORE);
  let end = Math.min(text.length, matchEnd + SNIPPET_AFTER);

  // If we clipped at start, shift the window right to keep total length close
  // to SNIPPET_CAP (improves snippet quality when the match is near the start).
  if (start === 0 && end - start < SNIPPET_CAP) {
    end = Math.min(text.length, start + SNIPPET_CAP);
  }
  // Same idea but for matches near the end.
  if (end === text.length && end - start < SNIPPET_CAP) {
    start = Math.max(0, end - SNIPPET_CAP);
  }

  const ellipsisLeft = start > 0;
  const ellipsisRight = end < text.length;
  const body = normalizeSnippetWhitespace(text.slice(start, end));

  // Snippet output keeps the ellipsis prefix/suffix so users can see truncation,
  // but match offsets refer to the visible match characters inside the snippet.
  const prefix = ellipsisLeft ? "…" : "";
  const suffix = ellipsisRight ? "…" : "";
  const matchText = normalizeSnippetWhitespace(text.slice(matchStart, matchEnd));
  const rawSliceBeforeMatch = text.slice(start, matchStart);
  const visibleStart = Math.max(0, Math.min(normalizeSnippetWhitespace(rawSliceBeforeMatch).length, body.length));
  const visibleEnd = Math.min(body.length, visibleStart + matchText.length);
  return {
    text: `${prefix}${body}${suffix}`,
    matchStart: prefix.length + visibleStart,
    matchEnd: prefix.length + visibleEnd,
  };
}

function normalizeSnippetWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

export function scoreHit(type: SearchHitType, matchedAt: string): number {
  const corpus = CORPUS_RANK[type];
  const ts = Date.parse(matchedAt);
  // Use the timestamp itself (ms since epoch) divided by a large constant so it
  // contributes meaningful but smaller-than-corpus magnitude. This keeps the
  // ranking corpus-first, recency-second.
  const recency = Number.isFinite(ts) ? ts / 1_000_000 : 0;
  return corpus + recency;
}

function isOutsideSinceWindow(timestamp: string, sinceMs: number | undefined): boolean {
  if (sinceMs === undefined) return false;
  const ms = Date.parse(timestamp);
  return !Number.isFinite(ms) || ms < sinceMs;
}
