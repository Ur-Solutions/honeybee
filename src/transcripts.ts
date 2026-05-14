import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type TranscriptProvider = "claude";

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
  if (agent !== "claude") return null;
  return latestClaudeTranscript(cwd, options);
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

  const sinceMs = options.sinceIso ? Date.parse(options.sinceIso) - 5_000 : 0;
  const candidates = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path);
        return { path, name, mtimeMs: info.mtimeMs };
      }),
  );

  const loaded: TranscriptFile[] = [];
  for (const candidate of candidates.filter((candidate) => candidate.mtimeMs >= sinceMs)) {
    const tx = await loadClaudeTranscript(candidate.path, options, candidate.mtimeMs);
    if (tx) loaded.push(tx);
  }

  loaded.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.mtimeMs - a.mtimeMs;
  });

  return loaded[0] ?? null;
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
  let mtimeMs = knownMtimeMs;
  if (mtimeMs === undefined) {
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      return null;
    }
  }

  const rows = await readJsonl(path);
  if (rows.length === 0) return null;

  const sessionId = basename(path).replace(/\.jsonl$/, "");
  let score = mtimeMs / 1_000_000_000_000;
  const matchedBy: string[] = ["mtime"];

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

  return { provider: "claude", path, sessionId, mtimeMs, rows, score, matchedBy };
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
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
