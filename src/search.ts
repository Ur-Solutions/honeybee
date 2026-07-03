// Public search API over seals + ledger + session records. Transcripts are
// intentionally excluded per the locked Phase 2 decision: the on-disk transcript
// corpus is too noisy and lives outside ~/.hive on most providers, so we'd be
// promising something we can't honor cross-machine.
//
// Keep this file as the stable entry point. The pure engine, corpus haystacks,
// and real filesystem readers live under ./search/* so tests and future corpora
// can swap readers without pulling filesystem concerns into matching logic.

import { makeSnippet, search as searchWithReader } from "./search/engine.js";
import { defaultCorpusReader, listLedgerFiles, resetSessionMetaCache } from "./search/readers.js";
import type { SealRecord } from "./seal.js";
import type { SessionRecord } from "./store.js";

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
  // Lower bound (inclusive) - only emit hits whose matchedAt is >= sinceMs.
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

export async function search(options: SearchOptions, reader: CorpusReader = defaultCorpusReader()): Promise<SearchResult> {
  return searchWithReader(options, reader);
}

export { defaultCorpusReader, listLedgerFiles, makeSnippet, resetSessionMetaCache };
