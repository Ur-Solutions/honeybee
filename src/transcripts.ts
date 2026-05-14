import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type TranscriptProvider = "claude" | "codex" | "opencode";

export type TranscriptRow = Record<string, unknown> & {
  type?: string;
  timestamp?: string;
  content?: unknown;
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
};

export type TranscriptLookupOptions = {
  sinceIso?: string;
  prompt?: string;
  transcriptPath?: string;
  sessionId?: string;
};

export async function latestTranscript(agent: string, cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  if (agent === "claude") return latestClaudeTranscript(cwd, options);
  if (agent === "codex") return latestCodexTranscript(cwd, options);
  if (agent === "opencode") return latestOpenCodeTranscript(cwd, options);
  return null;
}

export async function latestClaudeTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  if (options.transcriptPath) {
    const direct = await loadClaudeTranscript(options.transcriptPath, options);
    if (direct) return direct;
  }

  const dir = claudeProjectFolder(cwd);
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
    const tx = await loadClaudeTranscript(path, options, info.mtimeMs);
    if (tx) loaded.push(tx);
  }

  return bestTranscript(loaded);
}

export async function latestCodexTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  if (options.transcriptPath) {
    const direct = await loadCodexTranscript(options.transcriptPath, cwd, options);
    if (direct) return direct;
  }

  const root = join(homedir(), ".codex", "sessions");
  const sinceMs = sinceMillis(options);
  const files = await findFiles(root, (path) => path.endsWith(".jsonl"), 5).catch(() => []);
  const loaded: TranscriptFile[] = [];

  for (const path of files) {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const tx = await loadCodexTranscript(path, cwd, options, info.mtimeMs);
    if (tx) loaded.push(tx);
  }

  return bestTranscript(loaded);
}

export async function latestOpenCodeTranscript(cwd: string, options: TranscriptLookupOptions = {}): Promise<TranscriptFile | null> {
  if (options.transcriptPath) {
    const direct = await loadOpenCodeTranscript(options.transcriptPath, cwd, options);
    if (direct) return direct;
  }

  const sessionRoot = join(homedir(), ".local", "share", "opencode", "storage", "session");
  const sinceMs = sinceMillis(options);
  const files = await findFiles(sessionRoot, (path) => path.endsWith(".json"), 3).catch(() => []);
  const loaded: TranscriptFile[] = [];

  for (const path of files) {
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const tx = await loadOpenCodeTranscript(path, cwd, options, info.mtimeMs);
    if (tx) loaded.push(tx);
  }

  return bestTranscript(loaded);
}

export function claudeProjectFolder(cwd: string, home = process.env.HOME ?? "") {
  return join(home, ".claude", "projects", projectKeyForCwd(cwd));
}

export function projectKeyForCwd(cwd: string): string {
  return resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9._-]/g, "-");
}

export async function readJsonl(path: string): Promise<TranscriptRow[]> {
  const text = await readFile(path, "utf8");
  const rows: TranscriptRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as TranscriptRow);
    } catch {
      // Ignore partial/corrupt final line while the provider is still writing.
    }
  }
  return rows;
}

export function renderTranscript(rows: TranscriptRow[], options: { limit?: number; json?: boolean } = {}): string {
  const selected = typeof options.limit === "number" && options.limit > 0 ? rows.slice(-options.limit) : rows;
  if (options.json) return selected.map((row) => JSON.stringify(row)).join("\n");

  const rendered: string[] = [];
  for (const row of selected) {
    const role = row.message?.role ?? row.type ?? "event";
    const text = textFromContent(row.message?.content ?? row.content);
    if (!text) continue;
    rendered.push(`## ${role}\n${text}`);
  }
  return rendered.join("\n\n");
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

async function loadClaudeTranscript(path: string, options: TranscriptLookupOptions, knownMtimeMs?: number): Promise<TranscriptFile | null> {
  const mtimeMs = await getMtime(path, knownMtimeMs);
  if (mtimeMs === null) return null;
  const rows = await readJsonl(path);
  if (rows.length === 0) return null;
  const sessionId = basename(path).replace(/\.jsonl$/, "");
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, mtimeMs, options });
  return { provider: "claude", path, sessionId, mtimeMs, rows, score, matchedBy };
}

async function loadCodexTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownMtimeMs?: number): Promise<TranscriptFile | null> {
  const mtimeMs = await getMtime(path, knownMtimeMs);
  if (mtimeMs === null) return null;
  const rawRows = await readJsonl(path);
  if (rawRows.length === 0) return null;
  const sessionMeta = rawRows.find((row) => row.type === "session_meta") as { payload?: Record<string, unknown> } | undefined;
  const sessionId = String(sessionMeta?.payload?.id ?? basename(path).replace(/\.jsonl$/, ""));
  const rows = rawRows.flatMap(normalizeCodexRow);
  if (rows.length === 0) return null;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, mtimeMs, options });
  const metaCwd = String(sessionMeta?.payload?.cwd ?? sessionMeta?.payload?.original_cwd ?? "");
  if (samePath(metaCwd, cwd)) {
    return { provider: "codex", path, sessionId, mtimeMs, rows, score: score + 200, matchedBy: [...matchedBy, "cwd"] };
  }
  return { provider: "codex", path, sessionId, mtimeMs, rows, score, matchedBy };
}

async function loadOpenCodeTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownMtimeMs?: number): Promise<TranscriptFile | null> {
  const mtimeMs = await getMtime(path, knownMtimeMs);
  if (mtimeMs === null) return null;
  const session = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const sessionId = String(session.id ?? basename(path).replace(/\.json$/, ""));
  const directory = String(session.directory ?? "");
  const rows = await readOpenCodeRows(sessionId);
  if (rows.length === 0) return null;
  const { score, matchedBy } = scoreTranscript({ rows, path, sessionId, mtimeMs, options });
  if (samePath(directory, cwd)) {
    return { provider: "opencode", path, sessionId, mtimeMs, rows, score: score + 200, matchedBy: [...matchedBy, "cwd"] };
  }
  return { provider: "opencode", path, sessionId, mtimeMs, rows, score, matchedBy };
}

function normalizeCodexRow(row: TranscriptRow): TranscriptRow[] {
  const payload = row.payload as Record<string, unknown> | undefined;
  if (!payload) return [];
  if (row.type === "event_msg") {
    if (payload.type === "user_message" && typeof payload.message === "string") {
      return [{ type: "user", timestamp: row.timestamp, message: { role: "user", content: payload.message } }];
    }
    if (payload.type === "agent_message" && typeof payload.message === "string") {
      return [{ type: "assistant", timestamp: row.timestamp, message: { role: "assistant", content: payload.message } }];
    }
    return [];
  }
  if (row.type === "response_item" && payload.type === "message") {
    const role = typeof payload.role === "string" ? payload.role : "event";
    const content = textFromContent(payload.content);
    if (!content) return [];
    return [{ type: role, timestamp: row.timestamp, message: { role, content } }];
  }
  return [];
}

async function readOpenCodeRows(sessionId: string): Promise<TranscriptRow[]> {
  const storageRoot = join(homedir(), ".local", "share", "opencode", "storage");
  const msgDir = join(storageRoot, "message", sessionId);
  const messageFiles = await readdir(msgDir).catch(() => []);
  const rows: TranscriptRow[] = [];

  for (const file of messageFiles.filter((name) => name.endsWith(".json"))) {
    const msgPath = join(msgDir, file);
    const msg = JSON.parse(await readFile(msgPath, "utf8")) as Record<string, unknown>;
    const messageId = String(msg.id ?? basename(file, ".json"));
    const role = String(msg.role ?? "event");
    const partDir = join(storageRoot, "part", messageId);
    const partFiles = await readdir(partDir).catch(() => []);
    const parts: string[] = [];
    for (const partFile of partFiles.filter((name) => name.endsWith(".json"))) {
      const part = JSON.parse(await readFile(join(partDir, partFile), "utf8")) as Record<string, unknown>;
      if (typeof part.text === "string") parts.push(part.text);
      else if (typeof part.content === "string") parts.push(part.content);
    }
    const content = parts.join("\n").trim();
    if (content) rows.push({ type: role, message: { role, content }, timestamp: String((msg.time as { created?: unknown } | undefined)?.created ?? "") });
  }

  return rows;
}

function scoreTranscript(input: { rows: TranscriptRow[]; path: string; sessionId: string; mtimeMs: number; options: TranscriptLookupOptions }) {
  const { rows, path, sessionId, mtimeMs, options } = input;
  let score = mtimeMs / 1_000_000_000_000;
  const matchedBy: string[] = ["mtime"];

  if (options.transcriptPath && samePath(options.transcriptPath, path)) {
    score += 2_000;
    matchedBy.push("path");
  }
  if (options.sessionId && options.sessionId === sessionId) {
    score += 1_000;
    matchedBy.push("session-id");
  }
  if (options.prompt && rowsContainPrompt(rows, options.prompt)) {
    score += 500;
    matchedBy.push("prompt");
  }
  if (options.sinceIso && mtimeMs >= Date.parse(options.sinceIso) - 5_000) {
    score += 10;
    matchedBy.push("since");
  }

  return { score, matchedBy };
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

function sinceMillis(options: TranscriptLookupOptions): number {
  return options.sinceIso ? Date.parse(options.sinceIso) - 5_000 : 0;
}

async function getMtime(path: string, knownMtimeMs?: number): Promise<number | null> {
  if (knownMtimeMs !== undefined) return knownMtimeMs;
  const info = await stat(path).catch(() => null);
  return info?.mtimeMs ?? null;
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return resolve(a) === resolve(b);
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
