import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findFilesCached } from "./cache.js";
import { scoreTranscript, transcriptStartMs } from "./scoring.js";
import type { StatHint, TranscriptAdapter, TranscriptFile, TranscriptLookupOptions, TranscriptRow } from "./types.js";
import { getMtime, isGeneratorTranscriptCwd, readJsonObject } from "./util.js";

export const opencodeAdapter: TranscriptAdapter = {
  provider: "opencode",
  root: (_cwd, options) => opencodeSessionRoot(options.homePath),
  discover: (root) => findFilesCached(root, (path) => path.endsWith(".json"), 3, "opencode-json"),
  load: loadOpenCodeTranscript,
};

async function loadOpenCodeTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownStat?: StatHint): Promise<TranscriptFile | null> {
  const mtimeMs = await getMtime(path, knownStat?.mtimeMs);
  if (mtimeMs === null) return null;
  const session = await readJsonObject(path);
  const sessionId = String(session.id ?? basename(path).replace(/\.json$/, ""));
  const directory = String(session.directory ?? "");
  // See the codex adapter: opencode also scans storage globally, so skip
  // title-generator sessions rather than adopt them as a bee's transcript.
  if (isGeneratorTranscriptCwd(directory)) return null;
  const rows = await readOpenCodeRows(sessionId, opencodeStorageRoot(options.homePath));
  if (rows.length === 0) return null;
  const startedAtMs = transcriptStartMs(rows) ?? undefined;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, startedAtMs, mtimeMs, cwd, transcriptCwd: directory, options });
  return { provider: "opencode", path, sessionId, ...(startedAtMs !== undefined ? { startedAtMs } : {}), mtimeMs, rows, score, matchedBy };
}

async function readOpenCodeRows(sessionId: string, storageRoot: string): Promise<TranscriptRow[]> {
  if (!isSafeStorageId(sessionId)) return [];
  const msgDir = join(storageRoot, "message", sessionId);
  const messageFiles = (await readdir(msgDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();

  // readdir order is unspecified; order messages by time.created with the
  // (sortable, id-prefixed) filename as tie-break so transcripts and
  // lastAssistantText reflect the real conversation order.
  const messages: { file: string; msg: Record<string, unknown>; created: number | null }[] = [];
  for (const file of messageFiles) {
    const msg = await readJsonObject(join(msgDir, file));
    const created = Number((msg.time as { created?: unknown } | undefined)?.created);
    messages.push({ file, msg, created: Number.isFinite(created) ? created : null });
  }
  messages.sort((a, b) => {
    if (a.created !== null && b.created !== null && a.created !== b.created) return a.created - b.created;
    return a.file.localeCompare(b.file);
  });

  const rows: TranscriptRow[] = [];
  for (const { file, msg } of messages) {
    const messageId = String(msg.id ?? basename(file, ".json"));
    if (!isSafeStorageId(messageId)) continue;
    const role = String(msg.role ?? "event");
    const partDir = join(storageRoot, "part", messageId);
    const partFiles = (await readdir(partDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    const parts: string[] = [];
    for (const partFile of partFiles) {
      const part = await readJsonObject(join(partDir, partFile));
      if (typeof part.text === "string") parts.push(part.text);
      else if (typeof part.content === "string") parts.push(part.content);
    }
    const content = parts.join("\n").trim();
    if (content) rows.push({ type: role, message: { role, content }, timestamp: String((msg.time as { created?: unknown } | undefined)?.created ?? "") });
  }

  return rows;
}

function isSafeStorageId(value: string): boolean {
  return Boolean(value) && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function opencodeStorageRoot(homePath?: string): string {
  // OpenCode's storage is an XDG data tree, NOT the bee's home directory.
  // Identity/profile homes relocate it via XDG_DATA_HOME={home}/xdg-data
  // (drivers.ts), so a bee with a homePath keeps its transcripts under
  // {home}/xdg-data/opencode/storage. Plain --home spawns only move
  // OPENCODE_CONFIG_DIR, leaving storage at the default XDG location — hence
  // the existence check with the default as fallback.
  const fallback = join(homedir(), ".local", "share", "opencode", "storage");
  if (!homePath) return fallback;
  const identity = join(homePath, "xdg-data", "opencode", "storage");
  return existsSync(identity) ? identity : fallback;
}

function opencodeSessionRoot(homePath?: string): string {
  return join(opencodeStorageRoot(homePath), "session");
}
