// Pure search engine over seals + ledger + session records. Transcripts are
// intentionally excluded per the locked Phase 2 decision: the on-disk transcript
// corpus is too noisy and lives outside ~/.hive on most providers, so we'd be
// promising something we can't honor cross-machine.
//
// The engine is parameterised by a CorpusReader so tests can pipe in synthetic
// data without touching the real filesystem, and so future corpora (artifacts,
// buz messages) can plug in via additional reader methods.

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { storeRoot } from "./fsx.js";
import { sealsRoot, type SealRecord } from "./seal.js";
import { ledgerPath, listSessions, safeName, type SessionRecord } from "./store.js";

export type SearchHitType = "seal" | "ledger" | "session";

export type SearchHit = {
  type: SearchHitType;
  path: string;
  beeName?: string;
  snippet: string;
  // Offset of the match inside `snippet`; used by the CLI to colour the hit
  // without re-running the regex/substring search.
  matchStartInSnippet: number;
  matchEndInSnippet: number;
  // Higher = more relevant. We rank by corpus first (seals > ledger > sessions)
  // then break ties by recency, so callers can sort([]).reverse() if needed.
  score: number;
  matchedAt: string; // ISO timestamp used for recency ranking
};

export type SearchTypeFilter = "seals" | "ledger" | "sessions";

export type SearchOptions = {
  query: string;
  limit?: number; // 0 = unlimited; default 30
  caseSensitive?: boolean;
  regex?: boolean;
  colony?: string;
  swarm?: string;
  bee?: string;
  // Lower bound (inclusive) — only emit hits whose matchedAt is >= sinceMs.
  sinceMs?: number;
  status?: string; // applies to seals only
  types?: Set<SearchTypeFilter>;
  now?: number; // for tests that compare against parseAge windows
};

export type SearchResult = {
  hits: SearchHit[];
  truncated: boolean; // true if more hits existed past `limit`
};

export type CorpusReader = {
  listLedgerFiles(): Promise<string[]>;
  readSeals(filter: SealFilter): AsyncIterable<{ path: string; record: SealRecord }>;
  readSessionRecords(filter: SessionFilter): AsyncIterable<{ path: string; record: SessionRecord }>;
  readLedgerLines(filter: LedgerFilter): AsyncIterable<{ path: string; line: string; ts: string; lineNumber: number }>;
};

export type SealFilter = {
  colony?: string;
  swarm?: string;
  bee?: string;
  status?: string;
};

export type SessionFilter = {
  colony?: string;
  swarm?: string;
  bee?: string;
};

export type LedgerFilter = {
  sinceMs?: number;
};

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

export async function search(options: SearchOptions, reader: CorpusReader = defaultCorpusReader()): Promise<SearchResult> {
  const matcher = compileMatcher(options);
  const limit = options.limit === undefined ? DEFAULT_LIMIT : Math.max(0, Math.floor(options.limit));
  const wantSeals = !options.types || options.types.has("seals");
  const wantLedger = !options.types || options.types.has("ledger");
  const wantSessions = !options.types || options.types.has("sessions");

  const hits: SearchHit[] = [];

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
    for await (const { path, line, ts, lineNumber } of reader.readLedgerLines({
      ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}),
    })) {
      if (isOutsideSinceWindow(ts, options.sinceMs)) continue;
      if (!passesLedgerFilters(line, options)) continue;
      const text = redactSearchText(line);
      const match = matcher.find(text);
      if (!match) continue;
      const snippet = makeSnippet(text, match.start, match.end);
      hits.push({
        type: "ledger",
        path: `${path}:${lineNumber}`,
        snippet: snippet.text,
        matchStartInSnippet: snippet.matchStart,
        matchEndInSnippet: snippet.matchEnd,
        score: scoreHit("ledger", ts),
        matchedAt: ts,
      });
    }
  }

  if (wantSessions) {
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

  hits.sort((a, b) => b.score - a.score);
  const truncated = limit > 0 && hits.length > limit;
  return { hits: limit > 0 ? hits.slice(0, limit) : hits, truncated };
}

type CompiledMatcher = { find(text: string): { start: number; end: number } | null };

function compileMatcher(options: SearchOptions): CompiledMatcher {
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

function scoreHit(type: SearchHitType, matchedAt: string): number {
  const corpus = CORPUS_RANK[type];
  const ts = Date.parse(matchedAt);
  // Use the timestamp itself (ms since epoch) divided by a large constant so it
  // contributes meaningful but smaller-than-corpus magnitude. This keeps the
  // ranking corpus-first, recency-second.
  const recency = Number.isFinite(ts) ? ts / 1_000_000 : 0;
  return corpus + recency;
}

function sealHaystack(record: SealRecord): string {
  // Concatenate every searchable field into a single string. Order matters only
  // for snippet quality (matches earlier in the string get more "after" room).
  const parts: string[] = [
    record.beeName,
    record.status,
    record.summary,
    record.type ?? "",
    (record.filesChanged ?? []).join(" "),
    (record.risks ?? []).join(" "),
    (record.nextActions ?? []).join(" "),
    ...(record.testsRun ?? []).map((t) => `${t.command} ${t.result} ${t.notes ?? ""}`),
  ];
  return redactSearchText(parts.filter((p) => p && p.length > 0).join("\n"));
}

function sessionHaystack(record: SessionRecord): string {
  const parts: string[] = [
    record.name,
    record.agent,
    record.command,
    record.cwd,
    record.title ?? "",
    record.lastPrompt ?? "",
    record.brief ?? "",
    record.notes ?? "",
  ];
  return redactSearchText(parts.filter((p) => p && p.length > 0).join("\n"));
}

const REDACTED = "[redacted]";
const SECRET_ASSIGNMENT_RE = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',;)}\]]+/gi;
const BEARER_SECRET_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi;
const KNOWN_SECRET_VALUE_RE = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9][A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

function redactSearchText(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT_RE, `$1${REDACTED}`)
    .replace(BEARER_SECRET_RE, `$1${REDACTED}`)
    .replace(KNOWN_SECRET_VALUE_RE, REDACTED)
    .replace(JWT_RE, REDACTED);
}

function passesLedgerFilters(line: string, options: SearchOptions): boolean {
  // The ledger is JSONL; filter by colony/swarm/bee by parsing once. Bad lines
  // are skipped silently — the ledger is append-only and we never want one
  // malformed row to abort a long search.
  if (!options.colony && !options.swarm && !options.bee) return true;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (options.colony && parsed.colony !== options.colony) return false;
  if (options.swarm && parsed.swarmId !== options.swarm && parsed.swarm !== options.swarm) return false;
  if (options.bee) {
    const session = typeof parsed.session === "string" ? parsed.session : undefined;
    const name = typeof parsed.name === "string" ? parsed.name : undefined;
    if (session !== options.bee && name !== options.bee) return false;
  }
  return true;
}

// ---------- Default corpus reader (real filesystem) ---------------------------

export function defaultCorpusReader(): CorpusReader {
  return {
    listLedgerFiles,
    readSeals: defaultReadSeals,
    readSessionRecords: defaultReadSessionRecords,
    readLedgerLines: defaultReadLedgerLines,
  };
}

export async function listLedgerFiles(root: string = storeRoot()): Promise<string[]> {
  const base = ledgerPath();
  const dir = root === storeRoot() ? root : join(root);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const ledgerName = basename(base);
  // The current ledger is `ledger.jsonl`; rotations land as
  // `ledger.jsonl.<ISO-with-colons-replaced>`. We sort newest-first so callers
  // get the most recent activity at the top.
  const matches = entries.filter((entry) => entry === ledgerName || entry.startsWith(`${ledgerName}.`));
  const withMtime: { file: string; mtime: number }[] = [];
  for (const file of matches) {
    const full = join(dir, file);
    try {
      const info = await stat(full);
      withMtime.push({ file: full, mtime: info.mtimeMs });
    } catch {
      // file disappeared mid-scan; skip
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.map((entry) => entry.file);
}

async function* defaultReadSeals(filter: SealFilter): AsyncIterable<{ path: string; record: SealRecord }> {
  const root = sealsRoot();
  const beeDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  // First, build list of (beeName, filename) to enable filter pruning before IO.
  const candidates: { beeName: string; filePath: string }[] = [];
  for (const entry of beeDirs) {
    if (!entry.isDirectory()) continue;
    const beeName = entry.name;
    if (filter.bee && beeName !== filter.bee) continue;
    const sealDir = join(root, beeName);
    const files = await readdir(sealDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      candidates.push({ beeName, filePath: join(sealDir, file) });
    }
  }
  // Sort newest-first by filename (timestamp-based names sort lexicographically).
  candidates.sort((a, b) => b.filePath.localeCompare(a.filePath));
  for (const { filePath } of candidates) {
    let record: SealRecord;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as SealRecord;
      record = parsed;
    } catch {
      continue;
    }
    if (filter.status && record.status !== filter.status) continue;
    // Colony/swarm don't live on the seal — they're an attribute of the bee's
    // SessionRecord. When the caller passes those filters, we resolve them via
    // a small in-process cache lookup. Keep that out of the hot path by only
    // doing it when needed.
    if (filter.colony || filter.swarm) {
      const sessionMatch = await sessionMetaFor(record.beeName);
      if (filter.colony && sessionMatch?.colony !== filter.colony) continue;
      if (filter.swarm && sessionMatch?.swarmId !== filter.swarm) continue;
    }
    yield { path: filePath, record };
  }
}

let cachedSessionMeta: Map<string, { colony?: string; swarmId?: string }> | null = null;
async function sessionMetaFor(beeName: string): Promise<{ colony?: string; swarmId?: string } | null> {
  if (!cachedSessionMeta) {
    cachedSessionMeta = new Map();
    const records = await listSessions().catch(() => [] as SessionRecord[]);
    for (const record of records) {
      cachedSessionMeta.set(record.name, {
        ...(record.colony ? { colony: record.colony } : {}),
        ...(record.swarmId ? { swarmId: record.swarmId } : {}),
      });
    }
  }
  return cachedSessionMeta.get(beeName) ?? null;
}

export function resetSessionMetaCache(): void {
  cachedSessionMeta = null;
}

async function* defaultReadSessionRecords(filter: SessionFilter): AsyncIterable<{ path: string; record: SessionRecord }> {
  const records = await listSessions().catch(() => [] as SessionRecord[]);
  // Sessions are stored as <storeRoot>/sessions/<safeName>.json. We surface that
  // path so the CLI can print it next to the snippet.
  const sessionsDir = join(storeRoot(), "sessions");
  for (const record of records) {
    if (filter.bee && record.name !== filter.bee) continue;
    if (filter.colony && record.colony !== filter.colony) continue;
    if (filter.swarm && record.swarmId !== filter.swarm) continue;
    yield { path: join(sessionsDir, `${safeName(record.name)}.json`), record };
  }
}

async function* defaultReadLedgerLines(filter: LedgerFilter): AsyncIterable<{
  path: string;
  line: string;
  ts: string;
  lineNumber: number;
}> {
  const files = await listLedgerFiles();
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    // Lines are newest-last inside any single rotation. Iterate newest-first by
    // walking the array in reverse so the search-order matches the file-order
    // (newest-first overall: most recent rotation, newest line, etc.).
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line) continue;
      const ts = ledgerLineTimestamp(line);
      if (filter.sinceMs !== undefined) {
        const tsMs = Date.parse(ts);
        if (!Number.isFinite(tsMs) || tsMs < filter.sinceMs) continue;
      }
      yield { path: file, line, ts, lineNumber: i + 1 };
    }
  }
}

function isOutsideSinceWindow(timestamp: string, sinceMs: number | undefined): boolean {
  if (sinceMs === undefined) return false;
  const ms = Date.parse(timestamp);
  return !Number.isFinite(ms) || ms < sinceMs;
}

function ledgerLineTimestamp(line: string): string {
  try {
    const parsed = JSON.parse(line) as { ts?: string };
    if (parsed && typeof parsed.ts === "string") return parsed.ts;
  } catch {
    // fall through
  }
  return "";
}
