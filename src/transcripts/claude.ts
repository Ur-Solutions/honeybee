import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { memoizedDerived, readJsonlCached } from "./cache.js";
import { scoreTranscript, transcriptStartMs } from "./scoring.js";
import { firstUserPromptTitle, normalizeTitleCandidate } from "./text.js";
import type { StatHint, TranscriptAdapter, TranscriptFile, TranscriptLookupOptions, TranscriptRow } from "./types.js";

export const claudeAdapter: TranscriptAdapter = {
  provider: "claude",
  root: (cwd, options) => claudeProjectFolder(cwd, options.homePath),
  discover: async (root) => (await readdir(root).catch(() => [])).filter((name) => name.endsWith(".jsonl")).map((name) => join(root, name)),
  load: (path, _cwd, options, knownStat) => loadClaudeTranscript(path, options, knownStat),
  // Every claude home keys project folders the same way, so a stored path
  // whose parent folder is this cwd's project key is this bee's transcript
  // under some OTHER home (e.g. an env-inherited one the lookup's root missed).
  ownsPath: (path, cwd) => basename(dirname(path)) === projectKeyForCwd(cwd) && path.endsWith(".jsonl"),
};

export function claudeProjectFolder(cwd: string, configDir = join(homedir(), ".claude")) {
  return join(configDir, "projects", projectKeyForCwd(cwd));
}

export function projectKeyForCwd(cwd: string): string {
  // Claude Code encodes project dirs with [^a-zA-Z0-9] → "-": dots and
  // underscores become dashes too (/Users/x/.openclaw → -Users-x--openclaw).
  return resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
}

async function loadClaudeTranscript(path: string, options: TranscriptLookupOptions, knownStat?: StatHint): Promise<TranscriptFile | null> {
  const entry = await readJsonlCached(path, knownStat);
  if (!entry || entry.rows.length === 0) return null;
  const { rows, mtimeMs } = entry;
  const sessionId = basename(path).replace(/\.jsonl$/, "");
  const startedAtMs = transcriptStartMs(rows) ?? undefined;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, startedAtMs, mtimeMs, options, promptMatches: entry.promptMatches });
  const title = memoizedDerived(entry, "claude-title", () => extractClaudeTitle(rows));
  return { provider: "claude", path, sessionId, ...(startedAtMs !== undefined ? { startedAtMs } : {}), mtimeMs, rows, score, matchedBy, ...(title ? { title } : {}) };
}

function extractClaudeTitle(rows: TranscriptRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.type !== "ai-title") continue;
    const title = normalizeTitleCandidate(row.aiTitle);
    if (title) return title;
  }
  return firstUserPromptTitle(rows);
}
