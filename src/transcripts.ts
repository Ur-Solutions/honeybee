import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
export { hasTranscriptProvider } from "./drivers.js";

export type TranscriptProvider = "claude" | "codex" | "opencode" | "grok" | "kimi";

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
};

const SCORE = {
  path: 2_000,
  sessionId: 1_000,
  prompt: 500,
  cwd: 200,
  since: 10,
};

export async function latestTranscript(agent: string, cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  if (agent === "claude") return latestClaudeTranscript(cwd, options);
  if (agent === "codex") return latestCodexTranscript(cwd, options);
  if (agent === "opencode") return latestOpenCodeTranscript(cwd, options);
  if (agent === "grok") return latestGrokTranscript(cwd, options);
  if (agent === "kimi") return latestKimiTranscript(cwd, options);
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

  return bestTranscript(loaded);
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

  return bestTranscript(loaded);
}

export async function latestOpenCodeTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  // opencode 1.17.7+ stores sessions in a single SQLite db (opencode.db); older
  // versions used a storage/session/*.json file tree. Try SQLite first and fall
  // back to the file tree so both layouts keep working.
  const fromDb = await latestOpenCodeSqliteTranscript(cwd, options).catch(() => null);
  if (fromDb) return fromDb;
  return latestOpenCodeFileTranscript(cwd, options);
}

async function latestOpenCodeFileTranscript(cwd: string, options: TranscriptLookupOptions): Promise<TranscriptFile | null> {
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

  return bestTranscript(loaded);
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

  return bestTranscript(loaded);
}

// --- kimi-code reader ------------------------------------------------------
//
// kimi-code keeps a flat, file-based store under KIMI_CODE_HOME (~/.kimi-code by
// default). session_index.jsonl maps each session to its workDir (the cwd) and
// sessionDir; per-session state.json carries title/updatedAt and
// agents/main/wire.jsonl is the append-only event log we reconstruct rows from.

type KimiIndexEntry = { sessionId: string; sessionDir: string; workDir: string };

export async function latestKimiTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  const home = options.homePath ?? join(homedir(), ".kimi-code");
  const indexPath = join(home, "session_index.jsonl");
  const entries = (await readJsonl(indexPath).catch(() => [])) as KimiIndexEntry[];
  if (entries.length === 0) return null;

  const targetCwd = resolve(cwd);
  const sinceMs = sinceMillis(options);
  const loaded: TranscriptFile[] = [];
  for (const entry of entries) {
    const sessionDir = typeof entry.sessionDir === "string" ? entry.sessionDir : "";
    if (!sessionDir) continue;
    const workDir = typeof entry.workDir === "string" ? entry.workDir : "";
    const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
    const tx = await loadKimiTranscript(wirePath, cwd, options, {
      sessionId: typeof entry.sessionId === "string" ? entry.sessionId : basename(sessionDir),
      sessionDir,
      workDir,
    });
    if (!tx) continue;
    if (tx.mtimeMs < sinceMs) continue;
    // workDir is the authoritative cwd for a kimi session; only keep sessions
    // whose workDir matches (mirrors how the other readers gate on cwd before
    // scoring, since kimi's store is not partitioned by cwd on disk).
    if (workDir && samePath(workDir, targetCwd)) loaded.push(tx);
    else if (options.transcriptPath && samePath(options.transcriptPath, wirePath)) loaded.push(tx);
    else if (options.sessionId && options.sessionId === tx.sessionId) loaded.push(tx);
  }

  return bestTranscript(loaded);
}

async function loadKimiTranscript(
  wirePath: string,
  cwd: string,
  options: TranscriptLookupOptions,
  meta: KimiIndexEntry,
): Promise<TranscriptFile | null> {
  const statePath = join(meta.sessionDir, "state.json");
  const state = await readJsonObject(statePath);
  const updatedAt = typeof state.updatedAt === "string" ? Date.parse(state.updatedAt) : NaN;
  // Fall back to the wire file's mtime when state.json lacks a parseable
  // updatedAt, so a session still scores by recency.
  let mtimeMs = Number.isFinite(updatedAt) ? updatedAt : null;
  if (mtimeMs === null) mtimeMs = await getMtime(wirePath).catch(() => null);
  if (mtimeMs === null) return null;

  const rows = await readKimiRows(wirePath);
  if (rows.length === 0) return null;

  const sessionId = meta.sessionId || basename(meta.sessionDir);
  const { score, matchedBy } = scoreTranscript({ rows, path: wirePath, sessionId, mtimeMs, cwd, transcriptCwd: meta.workDir, options });
  const title = normalizeTitleCandidate(state.title);
  return { provider: "kimi", path: wirePath, sessionId, mtimeMs, rows, score, matchedBy, ...(title ? { title } : {}) };
}

async function readKimiRows(wirePath: string): Promise<TranscriptRow[]> {
  const events = await readJsonl(wirePath).catch(() => []);
  const rows: TranscriptRow[] = [];
  for (const event of events) {
    for (const row of normalizeKimiEvent(event)) {
      // turn.prompt and context.append_message both carry the same user text;
      // skip a row that exactly repeats the previous one to avoid doubling it.
      const prev = rows[rows.length - 1];
      if (prev && prev.message?.role === row.message?.role && textFromContent(prev.message?.content) === textFromContent(row.message?.content)) continue;
      rows.push(row);
    }
  }
  return rows;
}

function normalizeKimiEvent(event: TranscriptRow): TranscriptRow[] {
  const type = typeof event.type === "string" ? event.type : "";
  const timestamp = String((event as { time?: unknown }).time ?? "");
  if (type === "turn.prompt") {
    // The user's prompt for the turn; origin.kind is "user" for human input.
    const origin = (event as { origin?: { kind?: unknown } }).origin;
    if (origin && typeof origin.kind === "string" && origin.kind !== "user") return [];
    const content = textFromContent((event as { input?: unknown }).input);
    if (!content) return [];
    return [{ type: "user", timestamp, message: { role: "user", content } }];
  }
  if (type === "context.append_message") {
    const message = (event as { message?: { role?: unknown; content?: unknown } }).message;
    if (!message) return [];
    const role = typeof message.role === "string" ? message.role : "";
    if (role !== "user" && role !== "assistant") return [];
    const content = textFromContent(message.content);
    if (!content) return [];
    return [{ type: role, timestamp, message: { role, content } }];
  }
  return [];
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
  codex?: { rows: TranscriptRow[]; sessionId: string; metaCwd: string; title?: string };
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
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, mtimeMs, options, promptMatches: entry.promptMatches });
  entry.claude ??= { title: extractClaudeTitle(rows) };
  const title = entry.claude.title;
  return { provider: "claude", path, sessionId, mtimeMs, rows, score, matchedBy, ...(title ? { title } : {}) };
}

async function loadCodexTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownStat?: StatHint): Promise<TranscriptFile | null> {
  const entry = await readJsonlCached(path, knownStat);
  if (!entry || entry.rows.length === 0) return null;
  const { rows: rawRows, mtimeMs } = entry;
  if (!entry.codex) {
    const sessionMeta = rawRows.find((row) => row.type === "session_meta") as { payload?: Record<string, unknown> } | undefined;
    const sessionId = String(sessionMeta?.payload?.id ?? basename(path).replace(/\.jsonl$/, ""));
    // Real rollouts carry each message twice: as an event_msg
    // (user_message/agent_message) and as a response_item message. When the
    // event stream is present, it wins and the response_item copies are
    // dropped so transcripts do not render every message duplicated.
    const hasEventMessages = rawRows.some((row) => {
      if (row.type !== "event_msg") return false;
      const payloadType = (row.payload as Record<string, unknown> | undefined)?.type;
      return payloadType === "user_message" || payloadType === "agent_message";
    });
    const rows = rawRows.flatMap((row) => normalizeCodexRow(row, hasEventMessages));
    const metaCwd = String(sessionMeta?.payload?.cwd ?? sessionMeta?.payload?.original_cwd ?? "");
    entry.codex = { rows, sessionId, metaCwd, title: extractCodexTitle(rawRows, rows) };
  }
  const { rows, sessionId, metaCwd, title } = entry.codex;
  if (rows.length === 0) return null;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, mtimeMs, cwd, transcriptCwd: metaCwd, options, promptMatches: entry.promptMatches });
  return { provider: "codex", path, sessionId, mtimeMs, rows, score, matchedBy, ...(title ? { title } : {}) };
}

async function loadOpenCodeTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownMtimeMs?: number): Promise<TranscriptFile | null> {
  const mtimeMs = await getMtime(path, knownMtimeMs);
  if (mtimeMs === null) return null;
  const session = await readJsonObject(path);
  const sessionId = String(session.id ?? basename(path).replace(/\.json$/, ""));
  const directory = String(session.directory ?? "");
  const rows = await readOpenCodeRows(sessionId, opencodeStorageRoot(options.homePath));
  if (rows.length === 0) return null;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, mtimeMs, cwd, transcriptCwd: directory, options });
  return { provider: "opencode", path, sessionId, mtimeMs, rows, score, matchedBy };
}

// --- opencode 1.17.7+ SQLite reader ---------------------------------------
//
// opencode keeps the db open in WAL mode while running, so every read MUST use
// the sqlite3 CLI in -readonly mode (no write lock, no journal). We shell out
// (zero runtime dep) and JSON.parse the -json output. Any failure — sqlite3
// missing, db absent/locked, unparseable output — resolves to null so the
// caller transparently falls back to the file-tree reader.

type OpenCodeSessionRow = { id: string; directory: string; title: string; time_updated: number };
type OpenCodePartRow = { m_id: string; role: string; type: string; text: string | null; m_created: number; p_created: number };

async function latestOpenCodeSqliteTranscript(cwd: string, options: TranscriptLookupOptions): Promise<TranscriptFile | null> {
  const dbPath = opencodeDbPath(options.homePath);
  if (!dbPath) return null;

  const sessions = await querySqliteJson<OpenCodeSessionRow>(
    dbPath,
    "SELECT id, directory, title, time_updated FROM session ORDER BY time_updated DESC;",
  );
  if (!sessions) return null;

  const sinceMs = sinceMillis(options);
  const loaded: TranscriptFile[] = [];
  for (const session of sessions) {
    const mtimeMs = Number(session.time_updated);
    if (!Number.isFinite(mtimeMs) || mtimeMs < sinceMs) continue;
    const tx = await loadOpenCodeSqliteTranscript(dbPath, session, cwd, options);
    if (tx) loaded.push(tx);
  }
  return bestTranscript(loaded);
}

async function loadOpenCodeSqliteTranscript(
  dbPath: string,
  session: OpenCodeSessionRow,
  cwd: string,
  options: TranscriptLookupOptions,
): Promise<TranscriptFile | null> {
  const sessionId = String(session.id ?? "");
  if (!sessionId) return null;
  const rows = await readOpenCodeSqliteRows(dbPath, sessionId);
  if (rows.length === 0) return null;
  const mtimeMs = Number(session.time_updated) || 0;
  const directory = String(session.directory ?? "");
  // A db:<sessionId> pseudo-path keeps transcriptPath/path semantics meaningful
  // without pointing at a file (the SQLite store has no per-session file).
  const path = `${dbPath}:${sessionId}`;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, mtimeMs, cwd, transcriptCwd: directory, options });
  const title = normalizeTitleCandidate(session.title);
  return { provider: "opencode", path, sessionId, mtimeMs, rows, score, matchedBy, ...(title ? { title } : {}) };
}

async function readOpenCodeSqliteRows(dbPath: string, sessionId: string): Promise<TranscriptRow[]> {
  // Pull every text part for the session joined to its message role in one
  // query, ordered by message then part time so reconstruction matches the
  // real conversation order. reasoning/step-* parts are dropped (text only).
  const parts = await querySqliteJson<OpenCodePartRow>(
    dbPath,
    "SELECT m.id AS m_id, json_extract(m.data,'$.role') AS role, json_extract(p.data,'$.type') AS type, json_extract(p.data,'$.text') AS text, " +
      "m.time_created AS m_created, p.time_created AS p_created " +
      "FROM message m JOIN part p ON p.message_id = m.id " +
      `WHERE m.session_id = ${sqlQuote(sessionId)} ` +
      "ORDER BY m.time_created, m.id, p.time_created, p.id;",
  );
  if (!parts) return [];

  // Concatenate consecutive text parts of the same message into one row,
  // preserving message order. Each message becomes a single user/assistant row.
  const rows: TranscriptRow[] = [];
  let currentRole: string | null = null;
  let currentCreated = 0;
  let currentMid: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentRole === null) return;
    const content = buffer.join("\n").trim();
    if (content) rows.push({ type: currentRole, message: { role: currentRole, content }, timestamp: String(currentCreated) });
    buffer = [];
  };
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const role = String(part.role ?? "event");
    const created = Number(part.m_created) || 0;
    const mid = String(part.m_id ?? "");
    // Flush on a new message: two distinct same-role messages can share a
    // time_created, so the message id is the authoritative row boundary.
    if (mid !== currentMid || role !== currentRole || created !== currentCreated) {
      flush();
      currentRole = role;
      currentCreated = created;
      currentMid = mid;
    }
    buffer.push(part.text);
  }
  flush();
  return rows;
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
  const { score, matchedBy } = scoreTranscript({ rows, path: chatPath, sessionId, mtimeMs, cwd, transcriptCwd: metaCwd, options, promptMatches: entry.promptMatches });
  return { provider: "grok", path: chatPath, sessionId, mtimeMs, rows, score, matchedBy };
}

function normalizeCodexRow(row: TranscriptRow, skipResponseItemMessages: boolean): TranscriptRow[] {
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
    // The event_msg stream already carries these messages; keeping the
    // response_item copies would duplicate every message in the render.
    if (skipResponseItemMessages) return [];
    const content = textFromContent(payload.content);
    if (!content) return [];
    if (role === "user" && isInjectedCodexContext(content)) return [];
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

function scoreTranscript(input: { rows: TranscriptRow[]; path: string; sessionId: string; mtimeMs: number; cwd?: string; transcriptCwd?: string; options: TranscriptLookupOptions; promptMatches?: Map<string, boolean> }) {
  const { rows, path, sessionId, mtimeMs, cwd, transcriptCwd, options, promptMatches } = input;
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
  const key = `${root}\u0000${maxDepth}\u0000${tag}`;
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

function bestTranscript(loaded: TranscriptFile[]): TranscriptFile | null {
  loaded.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.mtimeMs - a.mtimeMs;
  });
  return loaded[0] ?? null;
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
  const opencodeDir = join(homePath, "xdg-data", "opencode");
  const identity = join(opencodeDir, "storage");
  if (existsSync(identity)) return identity;
  // Mirror opencodeDbPath's scoping: a home that owns a relocated xdg-data/
  // opencode tree is an isolated store — it must NEVER fall back to the global
  // default store (that would surface a different bee's history when this home's
  // own session lookup comes up empty). Only a home with no opencode tree at all
  // (a plain --home spawn that never relocated XDG) uses the default.
  return existsSync(opencodeDir) ? identity : fallback;
}

function opencodeSessionRoot(homePath?: string): string {
  return join(opencodeStorageRoot(homePath), "session");
}

// opencode 1.17.7+ keeps everything in {XDG_DATA}/opencode/opencode.db. Identity
// homes relocate XDG_DATA_HOME to {home}/xdg-data; plain spawns leave it at the
// default ~/.local/share. Prefer the home-relative db when it exists, else the
// default — but only reach the global default when this home does NOT have its
// own relocated XDG opencode tree. A homePath whose xdg-data/opencode exists is
// an isolated store: if it has no db it is an older file-tree store for THIS
// home, and we must not leak into another bee's default db. Returns null when
// no db is found (callers fall back to the file-tree reader).
function opencodeDbPath(homePath?: string): string | null {
  const defaultDb = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (homePath) {
    const opencodeDir = join(homePath, "xdg-data", "opencode");
    const identityDb = join(opencodeDir, "opencode.db");
    if (existsSync(identityDb)) return identityDb;
    // The home owns a relocated opencode tree but no db (old file-tree store) —
    // stay scoped to this home rather than reaching the global default.
    if (existsSync(opencodeDir)) return null;
  }
  return existsSync(defaultDb) ? defaultDb : null;
}

// Single-quote a SQL string literal (SQLite escapes ' by doubling it). Used for
// the session id, which is provider-generated (ses_…) but quoted defensively so
// the read-only query can never be derailed by an unexpected value.
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Run a read-only SQL query through the sqlite3 CLI and JSON.parse its output.
// Returns null on any failure (binary missing, db locked/absent, non-zero exit,
// unparseable/non-array output) so callers fall back gracefully and never throw.
function querySqliteJson<T>(dbPath: string, sql: string): Promise<T[] | null> {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn("sqlite3", ["-readonly", "-json", dbPath, sql], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolveResult(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value: T[] | null) => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const trimmed = out.trim();
      // sqlite3 -json emits nothing for an empty result set; treat as [].
      if (!trimmed) {
        finish([] as T[]);
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        finish(Array.isArray(parsed) ? (parsed as T[]) : null);
      } catch {
        finish(null);
      }
    });
  });
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
