/**
 * Render a bee's HSR events.jsonl as TranscriptRows — the fallback transcript
 * source for bees whose provider-native transcript is not on this machine
 * (remote-hsr bees observed through the daemon's event mirror, APIA-94).
 *
 * The runner event stream is chunked (stream tiers emit `text`/`thought` as
 * deltas), so consecutive chunks of the same kind are coalesced into one row,
 * with turn markers as hard boundaries. Tool calls become single `tool_use`
 * rows with a compact input preview; bookkeeping events (usage / exhausted /
 * auth / exit) carry no prose and are skipped.
 */
import type { TranscriptRow } from "../transcripts/types.js";
import type { RunnerEvent } from "./types.js";

const TOOL_INPUT_PREVIEW_CHARS = 200;

function rowOf(type: string, content: string, ts?: number): TranscriptRow {
  return { type, content, ...(ts !== undefined ? { timestamp: new Date(ts).toISOString() } : {}) };
}

export function transcriptRowsFromEvents(events: RunnerEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let acc: { type: string; text: string; ts?: number } | null = null;

  const flush = (): void => {
    if (!acc) return;
    const text = acc.text.trim();
    if (text) rows.push(rowOf(acc.type, text, acc.ts));
    acc = null;
  };

  for (const event of events) {
    const ts = typeof event.ts === "number" ? event.ts : undefined;
    switch (event.type) {
      case "text":
      case "thought":
      case "reasoning": {
        const kind = event.type === "text" ? "assistant" : "thinking";
        const text = typeof (event as { text?: unknown }).text === "string" ? (event as { text: string }).text : "";
        if (!text) break;
        if (acc && acc.type === kind) {
          acc.text += text;
        } else {
          flush();
          acc = { type: kind, text, ...(ts !== undefined ? { ts } : {}) };
        }
        break;
      }
      case "tool_use": {
        flush();
        const tool = typeof (event as { tool?: unknown }).tool === "string" ? (event as { tool: string }).tool : "tool";
        const input = (event as { input?: unknown }).input;
        let preview = "";
        if (input !== undefined) {
          try {
            preview = JSON.stringify(input) ?? "";
          } catch {
            preview = "";
          }
          if (preview.length > TOOL_INPUT_PREVIEW_CHARS) preview = `${preview.slice(0, TOOL_INPUT_PREVIEW_CHARS)}…`;
        }
        rows.push(rowOf("tool_use", preview ? `${tool} ${preview}` : tool, ts));
        break;
      }
      case "needs_input": {
        flush();
        const options = Array.isArray(event.options) && event.options.length > 0 ? ` [${event.options.join(" / ")}]` : "";
        rows.push(rowOf("needs_input", `${event.question || "(waiting for input)"}${options}`, ts));
        break;
      }
      case "error": {
        flush();
        const message = typeof (event as { message?: unknown }).message === "string" ? (event as { message: string }).message : "";
        if (message) rows.push(rowOf("error", message, ts));
        break;
      }
      case "turn_start":
      case "turn_end":
        flush();
        break;
      default:
        // usage / exhausted / auth_* / exit — bookkeeping, no prose.
        break;
    }
  }
  flush();
  return rows;
}
