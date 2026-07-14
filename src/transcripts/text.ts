import type { TranscriptRow } from "./types.js";

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

/**
 * User-role rows that are injected by a harness before the human's prompt.
 * Keep this guard in the shared fallback as well as provider adapters: a new
 * Codex carrier shape must not be able to turn bootstrap context into a bee
 * title merely because an adapter has not learned that shape yet.
 */
export function isInjectedUserContext(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<user_instructions>") ||
    trimmed.startsWith("<recommended_plugins>") ||
    /^#\s*agents\.md instructions\b/i.test(trimmed)
  );
}

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
    if (isInjectedUserContext(text)) continue;
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

const TITLE_MAX_CHARS = 80;

export function normalizeTitleCandidate(value: unknown): string | undefined {
  const raw = textFromContent(value).replace(/\s+/g, " ").trim();
  if (!raw) return undefined;
  if (raw.length <= TITLE_MAX_CHARS) return raw;
  return `${raw.slice(0, TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

export function firstUserPromptTitle(rows: TranscriptRow[]): string | undefined {
  for (const row of rows) {
    const role = row.message?.role ?? row.type;
    if (role !== "user") continue;
    const content = textFromContent(row.message?.content ?? row.content);
    if (isInjectedUserContext(content)) continue;
    const title = normalizeTitleCandidate(content);
    if (title) return title;
  }
  return undefined;
}

export function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function textFromContent(content: unknown): string {
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
