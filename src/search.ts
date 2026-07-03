// Pure search engine over seals + ledger + session records. Transcripts are
// intentionally excluded per the locked Phase 2 decision: the on-disk transcript
// corpus is too noisy and lives outside ~/.hive on most providers, so we'd be
// promising something we can't honor cross-machine.
//
// The engine is parameterised by a CorpusReader so tests can pipe in synthetic
// data without touching the real filesystem, and so future corpora (artifacts,
// buz messages) can plug in via additional reader methods.

import { open, readFile, readdir, stat } from "node:fs/promises";
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
  raw?: unknown;
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
  // True when the returned hits were capped at `limit`. Once a higher-ranked
  // corpus fills the top-N, lower-ranked corpora may be skipped without probing
  // whether they contain additional matches.
  truncated: boolean;
};

export type CorpusReader = {
  listLedgerFiles(): Promise<string[]>;
  readSeals(filter: SealFilter): AsyncIterable<{ path: string; record: SealRecord }>;
  readSessionRecords(filter: SessionFilter): AsyncIterable<{ path: string; record: SessionRecord }>;
  readLedgerLines(filter: LedgerFilter): AsyncIterable<LedgerLine>;
};

export type LedgerLine = {
  path: string;
  line: string;
  parsed?: Record<string, unknown>;
  ts: string;
  // Present for readers that can provide a source line cheaply. The default
  // reverse-streaming reader omits it to avoid a full-file pre-scan.
  lineNumber?: number;
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
const LEDGER_READ_CHUNK_BYTES = 64 * 1024;

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
      if (options.sinceMs !== undefined && Number.isFinite(matchedAtMs) && matchedAtMs < options.sinceMs) continue;
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
        raw: record,
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
        if (!passesLedgerFilters(parsed, options)) continue;
        const match = matcher.find(line);
        if (!match) continue;
        const snippet = makeSnippet(line, match.start, match.end);
        hits.push({
          type: "ledger",
          path: lineNumber === undefined ? path : `${path}:${lineNumber}`,
          snippet: snippet.text,
          matchStartInSnippet: snippet.matchStart,
          matchEndInSnippet: snippet.matchEnd,
          score: scoreHit("ledger", ts),
          matchedAt: ts,
          raw: parsed ?? line,
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
        if (options.sinceMs !== undefined && Number.isFinite(matchedAtMs) && matchedAtMs < options.sinceMs) continue;
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
          raw: record,
        });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return { hits: limit > 0 ? hits.slice(0, limit) : hits, truncated: truncated || (limit > 0 && hits.length > limit) };
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
  const body = text.slice(start, end).replace(/\s+/g, " ");

  // Snippet output keeps the ellipsis prefix/suffix so users can see truncation,
  // but match offsets refer to the visible match characters inside the snippet.
  const prefix = ellipsisLeft ? "…" : "";
  const suffix = ellipsisRight ? "…" : "";
  // Match start in slice -> add prefix length. We collapsed whitespace so the
  // raw count from `text` is an upper bound; we recompute by finding the match
  // text inside the formatted snippet for robustness.
  const matchText = text.slice(matchStart, matchEnd).replace(/\s+/g, " ");
  const rawSliceMatchOffset = matchStart - start;
  // Best-effort: find the first occurrence of `matchText` in `body`. If the
  // whitespace collapse changed the layout we still recover a sensible offset.
  let visibleStart = body.indexOf(matchText);
  if (visibleStart === -1) visibleStart = Math.max(0, Math.min(rawSliceMatchOffset, body.length));
  const visibleEnd = Math.min(body.length, visibleStart + matchText.length);
  return {
    text: `${prefix}${body}${suffix}`,
    matchStart: prefix.length + visibleStart,
    matchEnd: prefix.length + visibleEnd,
  };
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
  return parts.filter((p) => p && p.length > 0).join("\n");
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
  return parts.filter((p) => p && p.length > 0).join("\n");
}

function passesLedgerFilters(parsed: Record<string, unknown> | undefined, options: SearchOptions): boolean {
  // The ledger is JSONL; the reader parses each row once and passes the object
  // through. Bad lines are skipped silently when structured filters are needed
  // because we never want one malformed row to abort a long search.
  if (!options.colony && !options.swarm && !options.bee) return true;
  if (!parsed) return false;
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

async function* defaultReadLedgerLines(filter: LedgerFilter): AsyncIterable<LedgerLine> {
  const files = await listLedgerFiles();
  for (const file of files) {
    try {
      for await (const line of readFileLinesNewestFirst(file)) {
        const parsed = parseLedgerLine(line);
        const ts = typeof parsed?.ts === "string" ? parsed.ts : "";
        if (filter.sinceMs !== undefined) {
          const tsMs = Date.parse(ts);
          if (Number.isFinite(tsMs) && tsMs < filter.sinceMs) continue;
        }
        yield { path: file, line, ...(parsed ? { parsed } : {}), ts };
      }
    } catch {
      continue;
    }
  }
}

async function* readFileLinesNewestFirst(file: string): AsyncIterable<string> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    let position = info.size;
    let carry = Buffer.alloc(0);

    while (position > 0) {
      const chunkSize = Math.min(LEDGER_READ_CHUNK_BYTES, position);
      position -= chunkSize;
      const chunk = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, position);
      if (bytesRead <= 0) continue;
      const buffer = bytesRead === chunkSize ? chunk : chunk.subarray(0, bytesRead);
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i -= 1) {
        if (buffer[i] !== 0x0a) continue;
        const segment = buffer.subarray(i + 1, end);
        const lineBuffer = carry.length > 0 ? Buffer.concat([segment, carry]) : segment;
        const line = trimTrailingCarriageReturn(lineBuffer.toString("utf8"));
        if (line.length > 0) yield line;
        carry = Buffer.alloc(0);
        end = i;
      }
      const prefix = buffer.subarray(0, end);
      carry = carry.length > 0 ? Buffer.concat([prefix, carry]) : Buffer.from(prefix);
    }

    if (carry.length > 0) {
      const line = trimTrailingCarriageReturn(carry.toString("utf8"));
      if (line.length > 0) yield line;
    }
  } finally {
    await handle.close();
  }
}

function trimTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseLedgerLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}
