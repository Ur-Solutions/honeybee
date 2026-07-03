import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { findFilesCached, readJsonlCached } from "./cache.js";
import { scoreTranscript, transcriptStartMs } from "./scoring.js";
import { textFromContent } from "./text.js";
import type { StatHint, TranscriptAdapter, TranscriptFile, TranscriptLookupOptions, TranscriptRow } from "./types.js";
import { readJsonObject } from "./util.js";

export const grokAdapter: TranscriptAdapter = {
  provider: "grok",
  root: (cwd, options) => join(options.homePath ?? join(homedir(), ".grok"), "sessions", encodeURIComponent(resolve(cwd))),
  // Sessions are directories holding summary.json + chat_history.jsonl; the
  // summary marks the session, but the chat history is what gets stat'd/loaded.
  discover: async (root) =>
    (await findFilesCached(root, (path) => basename(path) === "summary.json", 2, "grok-summary")).map((path) => join(dirname(path), "chat_history.jsonl")),
  load: loadGrokTranscript,
};

async function loadGrokTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownStat?: StatHint): Promise<TranscriptFile | null> {
  const sessionDir = basename(path) === "chat_history.jsonl" || basename(path) === "summary.json" ? dirname(path) : path;
  const chatPath = join(sessionDir, "chat_history.jsonl");
  const summaryPath = join(sessionDir, "summary.json");
  const entry = await readJsonlCached(chatPath, knownStat);
  if (!entry) return null;
  const { rows: rawRows, mtimeMs } = entry;
  const rows = rawRows.flatMap(normalizeGrokRow);
  if (rows.length === 0) return null;
  const summary = await readJsonObject(summaryPath);
  const info = (summary.info && typeof summary.info === "object" ? summary.info : {}) as Record<string, unknown>;
  const sessionId = String(info.id ?? summary.id ?? basename(sessionDir));
  const metaCwd = String(info.cwd ?? summary.cwd ?? "");
  const startedAtMs = transcriptStartMs(rows) ?? undefined;
  const { score, matchedBy } = scoreTranscript({ rows, path: chatPath, sessionId, startedAtMs, mtimeMs, cwd, transcriptCwd: metaCwd, options, promptMatches: entry.promptMatches });
  return { provider: "grok", path: chatPath, sessionId, ...(startedAtMs !== undefined ? { startedAtMs } : {}), mtimeMs, rows, score, matchedBy };
}

function normalizeGrokRow(row: TranscriptRow): TranscriptRow[] {
  const role = row.message?.role ?? row.type;
  if (role !== "user" && role !== "assistant") return [];
  const content = textFromContent(row.message?.content ?? row.content);
  if (!content) return [];
  return [{ type: role, timestamp: row.timestamp, message: { role, content } }];
}
