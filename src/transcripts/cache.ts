import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { StatHint, TranscriptRow } from "./types.js";

export async function readJsonl(path: string): Promise<TranscriptRow[]> {
  const text = await readFile(path, "utf8");
  const rows: TranscriptRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as TranscriptRow);
    } catch {
      // Ignore partial/corrupt final line while the provider is still writing.
    }
  }
  return rows;
}

// Transcript files grow to many MB and are re-read by the daemon every tick
// and by waitForIdle every poll. A small mtime+size-keyed LRU lets repeat
// loads short-circuit to the previously parsed rows (and per-file derived
// data) after a single stat, instead of re-reading and re-parsing the file.
export type ParsedTranscriptCacheEntry = {
  mtimeMs: number;
  size: number;
  rows: TranscriptRow[];
  promptMatches: Map<string, boolean>;
  /** Per-provider data derived from the parse (normalized rows, titles, …),
   * memoized alongside the rows via memoizedDerived. */
  derived: Map<string, unknown>;
};

const PARSED_TRANSCRIPT_CACHE_LIMIT = 8;
const parsedTranscriptCache = new Map<string, ParsedTranscriptCacheEntry>();

const DIR_SCAN_TTL_MS = 1_500;
const DIR_SCAN_CACHE_LIMIT = 16;
const dirScanCache = new Map<string, { expiresAt: number; files: string[] }>();

export function clearTranscriptCaches(): void {
  parsedTranscriptCache.clear();
  dirScanCache.clear();
}

export async function readJsonlCached(path: string, knownStat?: StatHint): Promise<ParsedTranscriptCacheEntry | null> {
  const info = knownStat ?? (await stat(path).catch(() => null));
  if (!info) return null;
  const cached = parsedTranscriptCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    parsedTranscriptCache.delete(path);
    parsedTranscriptCache.set(path, cached);
    return cached;
  }
  const rows = await readJsonl(path);
  const entry: ParsedTranscriptCacheEntry = { mtimeMs: info.mtimeMs, size: info.size, rows, promptMatches: new Map(), derived: new Map() };
  parsedTranscriptCache.delete(path);
  parsedTranscriptCache.set(path, entry);
  while (parsedTranscriptCache.size > PARSED_TRANSCRIPT_CACHE_LIMIT) {
    const oldest = parsedTranscriptCache.keys().next().value;
    if (oldest === undefined) break;
    parsedTranscriptCache.delete(oldest);
  }
  return entry;
}

/** Compute once per parsed file: the result lives (and dies) with the cache entry. */
export function memoizedDerived<T>(entry: ParsedTranscriptCacheEntry, key: string, compute: () => T): T {
  if (!entry.derived.has(key)) entry.derived.set(key, compute());
  return entry.derived.get(key) as T;
}

// Provider session trees can hold thousands of directories; re-walking them
// on every poll dwarfs the (now stat-cached) per-file loads. A short TTL keeps
// repeat lookups cheap while still discovering new session files quickly.
export async function findFilesCached(root: string, predicate: (path: string) => boolean, maxDepth: number, tag: string): Promise<string[]> {
  const key = `${root} ${maxDepth} ${tag}`;
  const now = Date.now();
  const cached = dirScanCache.get(key);
  if (cached && cached.expiresAt > now) return cached.files;
  const files = await findFiles(root, predicate, maxDepth);
  dirScanCache.delete(key);
  dirScanCache.set(key, { expiresAt: now + DIR_SCAN_TTL_MS, files });
  while (dirScanCache.size > DIR_SCAN_CACHE_LIMIT) {
    const oldest = dirScanCache.keys().next().value;
    if (oldest === undefined) break;
    dirScanCache.delete(oldest);
  }
  return files;
}

async function findFiles(root: string, predicate: (path: string) => boolean, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && predicate(path)) out.push(path);
    }
  }
  await visit(root, 0);
  return out;
}
