import { stat } from "node:fs/promises";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { grokAdapter } from "./grok.js";
import { opencodeAdapter } from "./opencode.js";
import { bestTranscript } from "./scoring.js";
import type { TranscriptAdapter, TranscriptFile, TranscriptLookupOptions, TranscriptProvider } from "./types.js";
import { isPathInside, sinceMillis } from "./util.js";

export type { StatHint, TranscriptAdapter, TranscriptFile, TranscriptLookupOptions, TranscriptProvider, TranscriptRow } from "./types.js";
export { clearTranscriptCaches, readJsonl } from "./cache.js";
export { claudeProjectFolder, projectKeyForCwd } from "./claude.js";
export { firstUserText, lastAssistantText, renderTranscript, rowsContainPrompt, stripCommandNoise } from "./text.js";

export const transcriptAdapters: Readonly<Record<TranscriptProvider, TranscriptAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  grok: grokAdapter,
};

export async function latestTranscript(agent: string, cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  const adapter = (transcriptAdapters as Record<string, TranscriptAdapter | undefined>)[agent];
  if (!adapter) return null;
  return latestFromAdapter(adapter, cwd, options);
}

export function latestClaudeTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  return latestFromAdapter(claudeAdapter, cwd, options);
}

export function latestCodexTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  return latestFromAdapter(codexAdapter, cwd, options);
}

export function latestOpenCodeTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  return latestFromAdapter(opencodeAdapter, cwd, options);
}

export function latestGrokTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  return latestFromAdapter(grokAdapter, cwd, options);
}

/**
 * The one scan loop every provider shares: honor an explicit transcriptPath
 * when it lies inside the provider root, otherwise discover candidates,
 * mtime-filter against sinceIso, load each, and pick the best-scoring file.
 */
async function latestFromAdapter(adapter: TranscriptAdapter, cwd: string, options: TranscriptLookupOptions): Promise<TranscriptFile | null> {
  const root = adapter.root(cwd, options);
  if (options.transcriptPath) {
    const direct = isPathInside(options.transcriptPath, root) ? await adapter.load(options.transcriptPath, cwd, options) : null;
    if (direct) return direct;
  }

  const sinceMs = sinceMillis(options);
  const files = await adapter.discover(root, options).catch(() => [] as string[]);
  const loaded: TranscriptFile[] = [];
  for (const path of files) {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const tx = await adapter.load(path, cwd, options, info);
    if (tx) loaded.push(tx);
  }

  return bestTranscript(loaded, options);
}
