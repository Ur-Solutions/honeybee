export type TranscriptProvider = "claude" | "codex" | "opencode" | "grok";

export type TranscriptRow = Record<string, unknown> & {
  type?: string;
  timestamp?: string;
  content?: unknown;
  aiTitle?: string;
  payload?: unknown;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
  };
  sessionId?: string;
  session_id?: string;
  uuid?: string;
};

export type TranscriptFile = {
  provider: TranscriptProvider;
  path: string;
  sessionId: string;
  startedAtMs?: number;
  mtimeMs: number;
  rows: TranscriptRow[];
  score: number;
  matchedBy: string[];
  title?: string;
};

export type TranscriptLookupOptions = {
  sinceIso?: string;
  prompt?: string;
  transcriptPath?: string;
  sessionId?: string;
  homePath?: string;
  /**
   * The bee's spawn time. An unanchored bee (no transcriptPath/sessionId match)
   * may not adopt a transcript whose session STARTED before it was spawned —
   * that file belongs to an older sibling sharing the cwd. This is the
   * provider-agnostic guard against cross-matching for CLIs (codex/opencode/
   * grok) that, unlike claude, expose no flag to pin a fresh session id.
   */
  notBeforeIso?: string;
};

/** A stat() result already in hand, letting loaders skip a redundant stat. */
export type StatHint = { mtimeMs: number; size: number };

/**
 * One provider's transcript source. The generic scan loop (index.ts) owns the
 * shared discover→stat→mtime-filter→load→bestTranscript scaffold; an adapter
 * only says where its sessions live, which files are candidates, and how to
 * parse one of them. Adding a provider = one adapter file + a registry entry.
 */
export interface TranscriptAdapter {
  provider: TranscriptProvider;
  /** Directory holding this provider's sessions for the given cwd/home. */
  root(cwd: string, options: TranscriptLookupOptions): string;
  /**
   * Absolute paths of candidate transcript files under root. Return the path
   * that should be stat'd and loaded (mtime filtering happens in the scan loop).
   */
  discover(root: string, options: TranscriptLookupOptions): Promise<string[]>;
  /** Parse + score one transcript file; null when it is not an eligible session. */
  load(path: string, cwd: string, options: TranscriptLookupOptions, knownStat?: StatHint): Promise<TranscriptFile | null>;
  /**
   * Does an out-of-root stored transcriptPath still structurally belong to
   * this provider+cwd (e.g. a claude project folder under a DIFFERENT harness
   * home than the lookup's root — inherited-env homes the record never
   * captured)? The scan loop only direct-loads such a path when this says yes;
   * adapters whose session metadata is derived from the directory layout
   * (grok) omit it and stay root-confined.
   */
  ownsPath?(path: string, cwd: string): boolean;
}
