import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
export { hasTranscriptProvider } from "./drivers.js";
import { namingGeneratorCwd } from "./fsx.js";

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

const SCORE = {
  path: 2_000,
  sessionId: 1_000,
  prompt: 500,
  spawnProximity: 300,
  cwd: 200,
  since: 10,
};

export async function latestTranscript(agent: string, cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  if (agent === "claude") return latestClaudeTranscript(cwd, options);
  if (agent === "codex") return latestCodexTranscript(cwd, options);
  if (agent === "opencode") return latestOpenCodeTranscript(cwd, options);
  if (agent === "grok") return latestGrokTranscript(cwd, options);
  return null;
}

export async function latestClaudeTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  const dir = claudeProjectFolder(cwd, options.homePath);
  if (options.transcriptPath) {
    const direct = isPathInside(options.transcriptPath, dir) ? await loadClaudeTranscript(options.transcriptPath, options) : null;
    if (direct) return direct;
  }

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const sinceMs = sinceMillis(options);
  const loaded: TranscriptFile[] = [];
  for (const name of names.filter((name) => name.endsWith(".jsonl"))) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const tx = await loadClaudeTranscript(path, options, info);
    if (tx) loaded.push(tx);
  }

  return bestTranscript(loaded, options);
}

export async function latestCodexTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  const root = join(options.homePath ?? join(homedir(), ".codex"), "sessions");
  if (options.transcriptPath) {
    const direct = isPathInside(options.transcriptPath, root) ? await loadCodexTranscript(options.transcriptPath, cwd, options) : null;
    if (direct) return direct;
  }

  const sinceMs = sinceMillis(options);
  const files = await findFilesCached(root, (path) => path.endsWith(".jsonl"), 5, "codex-jsonl").catch(() => []);
  const loaded: TranscriptFile[] = [];

  for (const path of files) {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const tx = await loadCodexTranscript(path, cwd, options, info);
    if (tx) loaded.push(tx);
  }

  return bestTranscript(loaded, options);
}

export async function latestOpenCodeTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  const sessionRoot = opencodeSessionRoot(options.homePath);
  if (options.transcriptPath) {
    const direct = isPathInside(options.transcriptPath, sessionRoot) ? await loadOpenCodeTranscript(options.transcriptPath, cwd, options) : null;
    if (direct) return direct;
  }

  const sinceMs = sinceMillis(options);
  const files = await findFilesCached(sessionRoot, (path) => path.endsWith(".json"), 3, "opencode-json").catch(() => []);
  const loaded: TranscriptFile[] = [];

  for (const path of files) {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const tx = await loadOpenCodeTranscript(path, cwd, options, info.mtimeMs);
    if (tx) loaded.push(tx);
  }

  return bestTranscript(loaded, options);
}

export async function latestGrokTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  const workspaceRoot = join(options.homePath ?? join(homedir(), ".grok"), "sessions", encodeURIComponent(resolve(cwd)));
  if (options.transcriptPath) {
    const direct = isPathInside(options.transcriptPath, workspaceRoot) ? await loadGrokTranscript(options.transcriptPath, cwd, options) : null;
    if (direct) return direct;
  }

  const sinceMs = sinceMillis(options);
  const files = await findFilesCached(workspaceRoot, (path) => basename(path) === "summary.json", 2, "grok-summary").catch(() => []);
  const loaded: TranscriptFile[] = [];

  for (const path of files) {
    const chatPath = join(dirname(path), "chat_history.jsonl");
    const info = await stat(chatPath).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const tx = await loadGrokTranscript(chatPath, cwd, options, info);
    if (tx) loaded.push(tx);
  }

  return bestTranscript(loaded, options);
}

export function claudeProjectFolder(cwd: string, configDir = join(homedir(), ".claude")) {
  return join(configDir, "projects", projectKeyForCwd(cwd));
}

export function projectKeyForCwd(cwd: string): string {
  // Claude Code encodes project dirs with [^a-zA-Z0-9] → "-": dots and
  // underscores become dashes too (/Users/x/.openclaw → -Users-x--openclaw).
  return resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
}

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
type StatHint = { mtimeMs: number; size: number };

type ParsedTranscriptCacheEntry = {
  mtimeMs: number;
  size: number;
  rows: TranscriptRow[];
  promptMatches: Map<string, boolean>;
  claude?: { title?: string };
  codex?: { rows: TranscriptRow[]; sessionId: string; metaCwd: string; startedAtMs?: number; title?: string };
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

async function readJsonlCached(path: string, knownStat?: StatHint): Promise<ParsedTranscriptCacheEntry | null> {
  const info = knownStat ?? (await stat(path).catch(() => null));
  if (!info) return null;
  const cached = parsedTranscriptCache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    parsedTranscriptCache.delete(path);
    parsedTranscriptCache.set(path, cached);
    return cached;
  }
  const rows = await readJsonl(path);
  const entry: ParsedTranscriptCacheEntry = { mtimeMs: info.mtimeMs, size: info.size, rows, promptMatches: new Map() };
  parsedTranscriptCache.delete(path);
  parsedTranscriptCache.set(path, entry);
  while (parsedTranscriptCache.size > PARSED_TRANSCRIPT_CACHE_LIMIT) {
    const oldest = parsedTranscriptCache.keys().next().value;
    if (oldest === undefined) break;
    parsedTranscriptCache.delete(oldest);
  }
  return entry;
}

export function renderTranscript(rows: TranscriptRow[], options: { limit?: number; json?: boolean } = {}): string {
  const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : 0;
  if (options.json) {
    const selected = limit ? rows.slice(-limit) : rows;
    return selected.map((row) => JSON.stringify(row)).join("\n");
  }

  // Format first, then slice: raw tails are dominated by text-less rows
  // (tool_use/tool_result), so limiting raw rows often renders nothing.
  const rendered: string[] = [];
  for (const row of rows) {
    const role = row.message?.role ?? row.type ?? "event";
    const text = textFromContent(row.message?.content ?? row.content);
    if (!text) continue;
    rendered.push(`## ${role}\n${text}`);
  }
  const selected = limit ? rendered.slice(-limit) : rendered;
  return selected.join("\n\n");
}

// Claude wraps slash-command runs and harness injections in pseudo-XML blocks
// that carry no task intent (`<local-command-caveat>`, `<command-name>`, the
// `/model` and `/effort` plumbing, `<system-reminder>`, …). Left in, they
// become the "first user message" a titler sees and get echoed back as a
// title. Strip them so the real prompt underneath wins.
const COMMAND_NOISE_RE =
  /<(local-command-caveat|command-name|command-message|command-args|command-contents|local-command-stdout|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/gi;

export function stripCommandNoise(text: string): string {
  return text.replace(COMMAND_NOISE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function firstUserText(rows: TranscriptRow[]): string {
  for (const row of rows) {
    const role = row.message?.role ?? row.type;
    if (role !== "user") continue;
    // Skip rows that are pure command/harness noise; strip residual noise from
    // the first row that carries a real message.
    const text = stripCommandNoise(textFromContent(row.message?.content ?? row.content));
    if (text) return text;
  }
  return "";
}

export function lastAssistantText(rows: TranscriptRow[]): string {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    const role = row.message?.role ?? row.type;
    if (role !== "assistant") continue;
    const text = textFromContent(row.message?.content ?? row.content).trim();
    if (text) return text;
  }
  return "";
}

export function rowsContainPrompt(rows: TranscriptRow[], prompt: string): boolean {
  const needle = normalizeForMatch(prompt);
  if (!needle) return false;
  return rows.some((row) => normalizeForMatch(textFromContent(row.message?.content ?? row.content)).includes(needle));
}

function memoizedPromptMatch(rows: TranscriptRow[], prompt: string, memo?: Map<string, boolean>): boolean {
  if (!memo) return rowsContainPrompt(rows, prompt);
  const key = normalizeForMatch(prompt);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const result = rowsContainPrompt(rows, prompt);
  memo.set(key, result);
  return result;
}

async function loadClaudeTranscript(path: string, options: TranscriptLookupOptions, knownStat?: StatHint): Promise<TranscriptFile | null> {
  const entry = await readJsonlCached(path, knownStat);
  if (!entry || entry.rows.length === 0) return null;
  const { rows, mtimeMs } = entry;
  const sessionId = basename(path).replace(/\.jsonl$/, "");
  const startedAtMs = transcriptStartMs(rows) ?? undefined;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, startedAtMs, mtimeMs, options, promptMatches: entry.promptMatches });
  entry.claude ??= { title: extractClaudeTitle(rows) };
  const title = entry.claude.title;
  return { provider: "claude", path, sessionId, ...(startedAtMs !== undefined ? { startedAtMs } : {}), mtimeMs, rows, score, matchedBy, ...(title ? { title } : {}) };
}

async function loadCodexTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownStat?: StatHint): Promise<TranscriptFile | null> {
  const entry = await readJsonlCached(path, knownStat);
  if (!entry || entry.rows.length === 0) return null;
  const { rows: rawRows, mtimeMs } = entry;
  if (!entry.codex) {
    const sessionMeta = rawRows.find((row) => row.type === "session_meta") as { payload?: Record<string, unknown> } | undefined;
    const sessionId = String(sessionMeta?.payload?.id ?? basename(path).replace(/\.jsonl$/, ""));
    const startedAtMs = codexSessionStartMs(rawRows);
    // Real rollouts usually carry each message twice: as an event_msg
    // (user_message/agent_message) and as a response_item message. Dedup only
    // the response_item copies whose role/text identity is actually present in
    // the event stream so mixed provider formats do not lose messages.
    const eventMessages = codexEventMessages(rawRows);
    const rows = rawRows.flatMap((row) => normalizeCodexRow(row, eventMessages));
    const metaCwd = String(sessionMeta?.payload?.cwd ?? sessionMeta?.payload?.original_cwd ?? "");
    entry.codex = { rows, sessionId, metaCwd, ...(startedAtMs !== null ? { startedAtMs } : {}), title: extractCodexTitle(rawRows, rows) };
  }
  const { rows, sessionId, metaCwd, startedAtMs, title } = entry.codex;
  if (rows.length === 0) return null;
  // Title-generator subprocesses run `codex exec` in a dedicated cwd
  // (namingGeneratorCwd). codex stores rollouts globally per-home rather than
  // per-project, so a bee sharing that home would otherwise adopt the title-gen
  // session as its own transcript — and its first user message (the title
  // prompt: "You are a session-title generator…") as the bee's title. Skip them.
  if (isGeneratorTranscriptCwd(metaCwd)) return null;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, startedAtMs, mtimeMs, cwd, transcriptCwd: metaCwd, options, promptMatches: entry.promptMatches });
  return { provider: "codex", path, sessionId, ...(startedAtMs !== undefined ? { startedAtMs } : {}), mtimeMs, rows, score, matchedBy, ...(title ? { title } : {}) };
}

async function loadOpenCodeTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownMtimeMs?: number): Promise<TranscriptFile | null> {
  const mtimeMs = await getMtime(path, knownMtimeMs);
  if (mtimeMs === null) return null;
  const session = await readJsonObject(path);
  const sessionId = String(session.id ?? basename(path).replace(/\.json$/, ""));
  const directory = String(session.directory ?? "");
  // See loadCodexTranscript: opencode also scans storage globally, so skip
  // title-generator sessions rather than adopt them as a bee's transcript.
  if (isGeneratorTranscriptCwd(directory)) return null;
  const rows = await readOpenCodeRows(sessionId, opencodeStorageRoot(options.homePath));
  if (rows.length === 0) return null;
  const startedAtMs = transcriptStartMs(rows) ?? undefined;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, startedAtMs, mtimeMs, cwd, transcriptCwd: directory, options });
  return { provider: "opencode", path, sessionId, ...(startedAtMs !== undefined ? { startedAtMs } : {}), mtimeMs, rows, score, matchedBy };
}

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

type CodexConversationRole = "user" | "assistant";

type CodexEventMessages = Record<CodexConversationRole, Set<string>>;

function codexEventMessages(rows: TranscriptRow[]): CodexEventMessages {
  const seen: CodexEventMessages = { user: new Set(), assistant: new Set() };
  for (const row of rows) {
    if (row.type !== "event_msg") continue;
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.message !== "string") continue;
    const role = codexEventRole(payload.type);
    if (!role) continue;
    if (role === "user" && isInjectedCodexContext(payload.message)) continue;
    const text = normalizeForMatch(payload.message);
    if (text) seen[role].add(text);
  }
  return seen;
}

function codexEventRole(type: unknown): CodexConversationRole | null {
  if (type === "user_message") return "user";
  if (type === "agent_message") return "assistant";
  return null;
}

function hasCodexEventMessage(eventMessages: CodexEventMessages, role: CodexConversationRole, content: string): boolean {
  const text = normalizeForMatch(content);
  return Boolean(text) && eventMessages[role].has(text);
}

function normalizeCodexRow(row: TranscriptRow, eventMessages: CodexEventMessages): TranscriptRow[] {
  const payload = row.payload as Record<string, unknown> | undefined;
  if (!payload) return [];
  if (row.type === "event_msg") {
    if (payload.type === "user_message" && typeof payload.message === "string") {
      if (isInjectedCodexContext(payload.message)) return [];
      return [{ type: "user", timestamp: row.timestamp, message: { role: "user", content: payload.message } }];
    }
    if (payload.type === "agent_message" && typeof payload.message === "string") {
      return [{ type: "assistant", timestamp: row.timestamp, message: { role: "assistant", content: payload.message } }];
    }
    return [];
  }
  if (row.type === "response_item" && payload.type === "message") {
    const role = typeof payload.role === "string" ? payload.role : "event";
    // developer/system rows carry harness instructions, not conversation.
    if (role !== "user" && role !== "assistant") return [];
    const content = textFromContent(payload.content);
    if (!content) return [];
    if (role === "user" && isInjectedCodexContext(content)) return [];
    // The event_msg stream already carries this exact conversation message;
    // keeping the response_item copy would duplicate it in the render.
    if (hasCodexEventMessage(eventMessages, role, content)) return [];
    return [{ type: role, timestamp: row.timestamp, message: { role, content } }];
  }
  return [];
}

// response_item user rows embed harness-injected blobs that should never be
// rendered (or win the first-user-prompt title fallback).
function isInjectedCodexContext(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<environment_context>") || trimmed.startsWith("<user_instructions>");
}

function normalizeGrokRow(row: TranscriptRow): TranscriptRow[] {
  const role = row.message?.role ?? row.type;
  if (role !== "user" && role !== "assistant") return [];
  const content = textFromContent(row.message?.content ?? row.content);
  if (!content) return [];
  return [{ type: role, timestamp: row.timestamp, message: { role, content } }];
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

function scoreTranscript(input: { rows: TranscriptRow[]; path: string; sessionId: string; startedAtMs?: number; mtimeMs: number; cwd?: string; transcriptCwd?: string; options: TranscriptLookupOptions; promptMatches?: Map<string, boolean> }) {
  const { rows, path, sessionId, startedAtMs, mtimeMs, cwd, transcriptCwd, options, promptMatches } = input;
  let score = mtimeMs / 1_000_000_000_000;
  const matchedBy: string[] = ["mtime"];

  if (options.transcriptPath && samePath(options.transcriptPath, path)) {
    score += SCORE.path;
    matchedBy.push("path");
  }
  if (options.sessionId && options.sessionId === sessionId) {
    score += SCORE.sessionId;
    matchedBy.push("session-id");
  }
  if (options.prompt && memoizedPromptMatch(rows, options.prompt, promptMatches)) {
    score += SCORE.prompt;
    matchedBy.push("prompt");
  }
  if (options.notBeforeIso && startedAtMs !== undefined) {
    const spawnedAt = Date.parse(options.notBeforeIso);
    if (Number.isFinite(spawnedAt) && startedAtMs >= spawnedAt - CREATED_FLOOR_GRACE_MS) {
      const distanceSeconds = Math.abs(startedAtMs - spawnedAt) / 1_000;
      const proximity = Math.max(0, SCORE.spawnProximity - distanceSeconds);
      if (proximity > 0) {
        score += proximity;
        matchedBy.push("spawn-proximity");
      }
    }
  }
  if (cwd && transcriptCwd && samePath(transcriptCwd, cwd)) {
    score += SCORE.cwd;
    matchedBy.push("cwd");
  }
  if (options.sinceIso && mtimeMs >= Date.parse(options.sinceIso) - 5_000) {
    score += SCORE.since;
    matchedBy.push("since");
  }

  return { score, matchedBy };
}

// Provider session trees can hold thousands of directories; re-walking them
// on every poll dwarfs the (now stat-cached) per-file loads. A short TTL keeps
// repeat lookups cheap while still discovering new session files quickly.
async function findFilesCached(root: string, predicate: (path: string) => boolean, maxDepth: number, tag: string): Promise<string[]> {
  const key = `${root} ${maxDepth} ${tag}`;
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

function bestTranscript(loaded: TranscriptFile[], options: TranscriptLookupOptions = {}): TranscriptFile | null {
  const eligible = loaded.filter((tx) => passesCreatedFloor(tx, options));
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.mtimeMs - a.mtimeMs;
  });
  return eligible[0] ?? null;
}

// Clock-skew / boot-latency cushion: the agent writes its first transcript row
// shortly AFTER we stamp the bee's createdAt, so a real own-transcript clears
// the floor comfortably; the cushion only forgives sub-second skew.
const CREATED_FLOOR_GRACE_MS = 5_000;

/**
 * A transcript clears the floor when the bee was spawned no later than the
 * session's first activity. An explicit id/path match is authoritative
 * (resumed/anchored bees legitimately reopen an older session), so it always
 * passes regardless of the floor.
 */
function passesCreatedFloor(tx: TranscriptFile, options: TranscriptLookupOptions): boolean {
  if (!options.notBeforeIso) return true;
  if (tx.matchedBy.includes("session-id") || tx.matchedBy.includes("path")) return true;
  const floor = Date.parse(options.notBeforeIso) - CREATED_FLOOR_GRACE_MS;
  if (!Number.isFinite(floor)) return true;
  const start = tx.startedAtMs ?? transcriptStartMs(tx.rows);
  return start === null || start >= floor;
}

/** Earliest parseable row timestamp = when the provider session began. */
function transcriptStartMs(rows: TranscriptRow[]): number | null {
  let min: number | null = null;
  for (const row of rows) {
    const ms = parseTimestampMs(row.timestamp);
    if (ms === null) continue;
    if (min === null || ms < min) min = ms;
  }
  return min;
}

function codexSessionStartMs(rows: TranscriptRow[]): number | null {
  for (const row of rows) {
    if (row.type !== "session_meta") continue;
    const payload = objectPayload(row);
    const fromPayload = parseTimestampMs(payload?.timestamp);
    if (fromPayload !== null) return fromPayload;
    const fromRow = parseTimestampMs(row.timestamp);
    if (fromRow !== null) return fromRow;
  }
  return transcriptStartMs(rows);
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.length === 0) return null;
  // OpenCode stamps epoch-ms as a string; everything else is ISO-8601.
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const TITLE_MAX_CHARS = 80;

function extractClaudeTitle(rows: TranscriptRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.type !== "ai-title") continue;
    const title = normalizeTitleCandidate(row.aiTitle);
    if (title) return title;
  }
  return firstUserPromptTitle(rows);
}

function extractCodexTitle(rawRows: TranscriptRow[], rows: TranscriptRow[]): string | undefined {
  for (let i = rawRows.length - 1; i >= 0; i -= 1) {
    const payload = objectPayload(rawRows[i]);
    const title = firstTitleField(payload, ["title", "conversation_title", "conversationTitle", "thread_title", "threadTitle"]);
    if (title) return title;
  }

  // Note: turn_context/session_meta payload.summary is the reasoning-summary
  // MODE ("auto"), not a conversation summary — never use it as a title.
  return firstUserPromptTitle(rows);
}

function firstTitleField(object: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const title = normalizeTitleCandidate(object[key]);
    if (title) return title;
  }
  return undefined;
}

function firstUserPromptTitle(rows: TranscriptRow[]): string | undefined {
  for (const row of rows) {
    const role = row.message?.role ?? row.type;
    if (role !== "user") continue;
    const title = normalizeTitleCandidate(row.message?.content ?? row.content);
    if (title) return title;
  }
  return undefined;
}

function normalizeTitleCandidate(value: unknown): string | undefined {
  const raw = textFromContent(value).replace(/\s+/g, " ").trim();
  if (!raw) return undefined;
  if (raw.length <= TITLE_MAX_CHARS) return raw;
  return `${raw.slice(0, TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

function objectPayload(row: TranscriptRow | undefined): Record<string, unknown> | undefined {
  const payload = row?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
}

function sinceMillis(options: TranscriptLookupOptions): number {
  return options.sinceIso ? Date.parse(options.sinceIso) - 5_000 : 0;
}

async function getMtime(path: string, knownMtimeMs?: number): Promise<number | null> {
  if (knownMtimeMs !== undefined) return knownMtimeMs;
  const info = await stat(path).catch(() => null);
  return info?.mtimeMs ?? null;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return resolve(a) === resolve(b);
}

/** A transcript recorded in the title-generator's dedicated cwd is a title-gen
 * artifact, never a real bee session — see loadCodexTranscript. */
function isGeneratorTranscriptCwd(transcriptCwd: string): boolean {
  return samePath(transcriptCwd, namingGeneratorCwd());
}

function isPathInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath));
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

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      if ("text" in block && typeof block.text === "string") return block.text;
      if ("content" in block && typeof block.content === "string") return block.content;
      if ("input_text" in block && typeof block.input_text === "string") return block.input_text;
      if ("output_text" in block && typeof block.output_text === "string") return block.output_text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
