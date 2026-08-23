import type {
  TranscriptIsoTs,
  TranscriptProjectedImage,
  TranscriptProjectedEvent,
  TranscriptProjector,
  TranscriptTokenUsage,
} from "./transcript-projection.ts";

type JsonObject = Record<string, unknown>;

/**
 * Claude stream-json pane projection (G3 completion, 2026-08-21).
 *
 * The codex and grok G3 slices shipped rich stateful projectors while claude
 * kept the text-only renderer fallback — which maps every tool block to
 * `unknown`, so panes on the typed feed showed messages but LOST tool calls
 * (the post-cutover "transcripts aren't showing, especially tool calls"
 * regression). This projector restores parity from the same published
 * session-log lines.
 *
 * Line shapes (HSR stream-json, both directions in one log):
 *  - user     {message.content: string | blocks} — plain text is the operator
 *    prompt (turn boundary); tool_result blocks are tool completions.
 *  - assistant {message.content: blocks} — text / thinking / tool_use.
 *  - result   {subtype, usage, stop_reason, duration_ms} — the turn boundary
 *    close, with turn-scoped usage.
 *  - system init carries the session id; every other system subtype plus
 *    rate_limit_event / tool_progress is protocol noise, projected to []
 *    exactly like codex deltas (noise is not "unknown" — unknown is reserved
 *    for genuinely unrecognized record types).
 *
 * Stateless per line (claude lines are complete messages); the projector
 * interface stays stateful-shaped for uniformity with codex/grok.
 */

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Claude HSR lines carry no wall-clock timestamp; the feed orders by line. */
const NO_TS: TranscriptIsoTs = null;

const NOISE_TYPES = new Set(["rate_limit_event", "tool_progress", "stream_event"]);
const IMAGE_META_RE = /^\[Image:\s*original\s+\d+x\d+(?:,[^\]]*)?\]\s*$/i;
const IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_PROJECTED_IMAGES = 8;
/** Keeps one canonical event comfortably below Apiary's 32 MiB peer frame. */
const MAX_PROJECTED_IMAGE_DATA_CHARS = 24 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const value of content) {
    if (typeof value === "string") {
      parts.push(value);
      continue;
    }
    const block = asObject(value);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function imagesFromContent(content: unknown): TranscriptProjectedImage[] {
  if (!Array.isArray(content)) return [];
  const images: TranscriptProjectedImage[] = [];
  let retainedChars = 0;
  for (const value of content) {
    if (images.length >= MAX_PROJECTED_IMAGES) break;
    const block = asObject(value);
    if (block?.type !== "image") continue;
    const source = asObject(block.source);
    const mimeType = nonEmptyString(source?.media_type);
    const data = nonEmptyString(source?.data);
    if (
      source?.type !== "base64" ||
      !mimeType ||
      !IMAGE_MIME_TYPES.has(mimeType) ||
      !data ||
      data.length % 4 !== 0 ||
      !BASE64_RE.test(data) ||
      retainedChars + data.length > MAX_PROJECTED_IMAGE_DATA_CHARS
    ) {
      continue;
    }
    images.push({ data, mimeType });
    retainedChars += data.length;
  }
  return images;
}

function usageFrom(raw: unknown): TranscriptTokenUsage | null {
  const usage = asObject(raw);
  if (!usage) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const out: TranscriptTokenUsage = {
    ...(num(usage.input_tokens) !== undefined ? { input: num(usage.input_tokens) } : {}),
    ...(num(usage.output_tokens) !== undefined ? { output: num(usage.output_tokens) } : {}),
    ...(num(usage.cache_read_input_tokens) !== undefined
      ? { cacheRead: num(usage.cache_read_input_tokens) }
      : {}),
    ...(num(usage.cache_creation_input_tokens) !== undefined
      ? { cacheWrite: num(usage.cache_creation_input_tokens) }
      : {}),
  };
  return Object.keys(out).length > 0 ? out : null;
}

export function createClaudeProjector(): TranscriptProjector {
  return {
    harness: "claude",
    pushLine(line: string): TranscriptProjectedEvent[] {
      let row: JsonObject | null;
      try {
        row = asObject(JSON.parse(line));
      } catch {
        return [];
      }
      if (!row) return [];
      const type = nonEmptyString(row.type);
      if (!type || NOISE_TYPES.has(type)) return [];
      const providerEventId = nonEmptyString(row.uuid);

      if (type === "user") {
        const message = asObject(row.message);
        const content = message?.content;
        const events: TranscriptProjectedEvent[] = [];
        // Tool completions ride user-role lines as tool_result blocks.
        if (Array.isArray(content)) {
          for (const value of content) {
            const block = asObject(value);
            if (block?.type !== "tool_result") continue;
            // Real claude blocks always carry ids; a missing one (synthetic
            // or truncated logs) must not vanish — same fallback discipline
            // as the codex projector's itemCallId.
            const callId = nonEmptyString(block.tool_use_id) ?? "claude:tool_result:unknown";
            const output = textFromContent(block.content);
            const images = imagesFromContent(block.content);
            events.push({
              kind: "tool_result",
              ts: NO_TS,
              callId,
              isError: block.is_error === true,
              ...(output.trim().length > 0 ? { output } : {}),
              ...(images.length > 0 ? { images } : {}),
            });
          }
        }
        if (events.length > 0) return events;
        const text = textFromContent(content);
        // A meta row is never an operator prompt. Current Claude versions mark
        // the dimensions echo after an image result as `isSynthetic` instead
        // of `isMeta`; suppress that exact provider-owned shape as well.
        if (
          row.isMeta === true ||
          (row.isSynthetic === true && IMAGE_META_RE.test(text.trim()))
        ) return [];
        if (text.trim().length === 0) return [];
        return [
          { kind: "turn_start", ts: NO_TS },
          {
            kind: "message",
            ts: NO_TS,
            role: "user",
            text,
            ...(providerEventId ? { providerEventId } : {}),
          },
        ];
      }

      if (type === "assistant") {
        const message = asObject(row.message);
        const content = message?.content;
        // String-content assistant messages are legitimate API shape.
        if (typeof content === "string") {
          const text = nonEmptyString(content);
          return text
            ? [{
                kind: "message",
                ts: NO_TS,
                role: "assistant",
                text,
                ...(providerEventId ? { providerEventId } : {}),
              }]
            : [];
        }
        if (!Array.isArray(content)) return [];
        const events: TranscriptProjectedEvent[] = [];
        for (const value of content) {
          const block = asObject(value);
          if (!block) continue;
          switch (block.type) {
            case "text": {
              const text = nonEmptyString(block.text);
              if (text) {
                events.push({
                  kind: "message",
                  ts: NO_TS,
                  role: "assistant",
                  text,
                  ...(providerEventId ? { providerEventId } : {}),
                });
              }
              break;
            }
            case "thinking": {
              const text = nonEmptyString(block.thinking);
              // Signature-only blocks are encrypted reasoning: present, but
              // its text is unavailable — the load-bearing redacted shape.
              events.push(
                text
                  ? { kind: "thinking", ts: NO_TS, redacted: false, text }
                  : { kind: "thinking", ts: NO_TS, redacted: true },
              );
              break;
            }
            case "redacted_thinking":
              events.push({ kind: "thinking", ts: NO_TS, redacted: true });
              break;
            case "tool_use": {
              events.push({
                kind: "tool_call",
                ts: NO_TS,
                callId: nonEmptyString(block.id) ?? "claude:tool_use:unknown",
                name: nonEmptyString(block.name) ?? "tool",
                ...(block.input !== undefined ? { input: block.input } : {}),
              });
              break;
            }
            default:
              break; // image/document blocks etc: no pane row yet
          }
        }
        return events;
      }

      if (type === "result") {
        const events: TranscriptProjectedEvent[] = [];
        const usage = usageFrom(row.usage);
        if (usage) {
          events.push({
            kind: "token_usage",
            ts: NO_TS,
            usage,
            scope: "turn",
          });
        }
        const durationMs =
          typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms)
            ? row.duration_ms
            : undefined;
        events.push({
          kind: "turn_end",
          ts: NO_TS,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(nonEmptyString(row.stop_reason) ? { finishReason: nonEmptyString(row.stop_reason) } : {}),
        });
        return events;
      }

      // system init/subtypes are lifecycle + progress chatter, not pane rows.
      if (type === "system") return [];

      return [{ kind: "unknown", ts: NO_TS, nativeType: type }];
    },
    flush(): TranscriptProjectedEvent[] {
      return [];
    },
  };
}
