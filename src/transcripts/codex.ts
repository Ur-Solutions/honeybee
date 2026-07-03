import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findFilesCached, memoizedDerived, readJsonlCached } from "./cache.js";
import { parseTimestampMs, scoreTranscript, transcriptStartMs } from "./scoring.js";
import { firstUserPromptTitle, normalizeForMatch, normalizeTitleCandidate, textFromContent } from "./text.js";
import type { StatHint, TranscriptAdapter, TranscriptFile, TranscriptLookupOptions, TranscriptRow } from "./types.js";
import { isGeneratorTranscriptCwd } from "./util.js";

export const codexAdapter: TranscriptAdapter = {
  provider: "codex",
  root: (_cwd, options) => join(options.homePath ?? join(homedir(), ".codex"), "sessions"),
  discover: (root) => findFilesCached(root, (path) => path.endsWith(".jsonl"), 5, "codex-jsonl"),
  load: loadCodexTranscript,
};

/** Rows/session-id/cwd/title derived once per parsed rollout (cached in the
 * parsed-file LRU) — normalization walks every row and is not free. */
type CodexDerived = { rows: TranscriptRow[]; sessionId: string; metaCwd: string; startedAtMs?: number; title?: string };

async function loadCodexTranscript(path: string, cwd: string, options: TranscriptLookupOptions, knownStat?: StatHint): Promise<TranscriptFile | null> {
  const entry = await readJsonlCached(path, knownStat);
  if (!entry || entry.rows.length === 0) return null;
  const { rows: rawRows, mtimeMs } = entry;
  const derived = memoizedDerived(entry, "codex", (): CodexDerived => {
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
    return { rows, sessionId, metaCwd, ...(startedAtMs !== null ? { startedAtMs } : {}), title: extractCodexTitle(rawRows, rows) };
  });
  const { rows, sessionId, metaCwd, startedAtMs, title } = derived;
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

function objectPayload(row: TranscriptRow | undefined): Record<string, unknown> | undefined {
  const payload = row?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
}
