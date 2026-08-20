import type {
  TranscriptIsoTs,
  TranscriptProjectedEvent,
  TranscriptProjector,
} from "./transcript-projection.ts";

type JsonObject = Record<string, unknown>;
type MessageRole = "user" | "assistant";

type OpenChunk =
  | { kind: "message"; role: MessageRole; text: string; ts: TranscriptIsoTs }
  | { kind: "thinking"; text: string; ts: TranscriptIsoTs };

interface ToolState {
  name: string;
  input?: unknown;
  status?: string;
  callEmitted: boolean;
  resultEmitted: boolean;
}

const UPDATE_METHODS = new Set([
  "session/update",
  "_x.ai/session/update",
  "x.ai/session/update",
  "_x.ai/session_notification",
  "x.ai/session_notification",
]);

const PROMPT_COMPLETE_METHODS = new Set([
  "session/prompt_complete",
  "_x.ai/session/prompt_complete",
  "x.ai/session/prompt_complete",
]);

function asObject(value: unknown): JsonObject | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function jsonObject(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line)) ?? null;
  } catch {
    return null;
  }
}

function stringField(value: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function firstDefined(value: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

function hasField(value: JsonObject, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isoTimestamp(...values: Array<JsonObject | undefined>): TranscriptIsoTs {
  for (const value of values) {
    if (!value) continue;
    const meta = asObject(value._meta);
    const direct = firstDefined(value, "timestamp", "ts");
    const epochMs = firstDefined(
      value,
      "agentTimestampMs",
      "timestampMs",
      "emittedAtMs",
      "startedAtMs",
      "completedAtMs",
    ) ?? (meta && firstDefined(
      meta,
      "agentTimestampMs",
      "timestampMs",
      "emittedAtMs",
      "startedAtMs",
      "completedAtMs",
    ));
    const candidate = direct ?? epochMs;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }
  }
  return null;
}

/** Extract text without trimming chunk whitespace, which is semantically significant. */
function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const texts = value.flatMap((block) => {
      const text = textContent(block);
      return text != null && text.trim().length > 0 ? [text] : [];
    });
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  const object = asObject(value);
  if (!object) return undefined;
  if (typeof object.text === "string") return object.text;
  if (object.content !== value) return textContent(object.content);
  return undefined;
}

function updateKind(update: JsonObject): string | undefined {
  return stringField(update, "sessionUpdate", "session_update", "type");
}

function updatePayload(row: JsonObject): { params?: JsonObject; update?: JsonObject } {
  const params = asObject(row.params);
  return { params, update: asObject(params?.update) ?? params };
}

function promptText(params: JsonObject | undefined): string | undefined {
  const text = textContent(params?.prompt);
  return text != null && text.trim().length > 0 ? text : undefined;
}

function toolOutput(update: JsonObject): unknown {
  return firstDefined(update, "rawOutput", "raw_output", "output", "result");
}

function printableOutput(value: unknown): string | undefined {
  const text = textContent(value);
  if (text !== undefined) return text;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isTerminalToolStatus(status: string | undefined): boolean {
  return status != null && [
    "complete",
    "completed",
    "success",
    "succeeded",
    "failed",
    "error",
    "cancelled",
    "canceled",
  ].includes(status.toLowerCase());
}

function isErrorToolStatus(status: string | undefined): boolean {
  return status != null && ["failed", "error", "cancelled", "canceled"].includes(status.toLowerCase());
}

/**
 * Project Grok's published ACP session log and native chat_history rows.
 *
 * ACP message and thought updates are deltas, not message boundaries. The
 * projector therefore owns a single open chunk buffer and only publishes it
 * when the stream changes shape or the caller explicitly flushes at EOF.
 */
export function createGrokProjector(): TranscriptProjector {
  let openChunk: OpenChunk | undefined;
  const tools = new Map<string, ToolState>();

  function flushOpenChunk(): TranscriptProjectedEvent[] {
    const chunk = openChunk;
    openChunk = undefined;
    if (!chunk || chunk.text.trim().length === 0) return [];
    if (chunk.kind === "thinking") {
      return [{ kind: "thinking", ts: chunk.ts, redacted: false, text: chunk.text }];
    }
    return [{ kind: "message", ts: chunk.ts, role: chunk.role, text: chunk.text }];
  }

  function appendMessageChunk(role: MessageRole, text: string, ts: TranscriptIsoTs): TranscriptProjectedEvent[] {
    if (openChunk?.kind === "message" && openChunk.role === role) {
      openChunk.text += text;
      return [];
    }
    const events = flushOpenChunk();
    openChunk = { kind: "message", role, text, ts };
    return events;
  }

  function appendThinkingChunk(text: string, ts: TranscriptIsoTs): TranscriptProjectedEvent[] {
    if (openChunk?.kind === "thinking") {
      openChunk.text += text;
      return [];
    }
    const events = flushOpenChunk();
    openChunk = { kind: "thinking", text, ts };
    return events;
  }

  function projectTool(update: JsonObject, ts: TranscriptIsoTs): TranscriptProjectedEvent[] {
    const callId = stringField(update, "toolCallId", "tool_call_id", "callId", "call_id", "id");
    if (!callId) {
      return [{ kind: "unknown", ts, nativeType: updateKind(update) ?? "tool_call", detail: "missing tool call id" }];
    }

    const previous = tools.get(callId);
    const name = stringField(update, "title", "name", "kind") ?? previous?.name ?? "tool";
    const nextInput = firstDefined(update, "rawInput", "raw_input", "input");
    const status = stringField(update, "status") ?? previous?.status;
    const state: ToolState = {
      name,
      ...(nextInput !== undefined ? { input: nextInput } : previous?.input !== undefined ? { input: previous.input } : {}),
      ...(status ? { status } : {}),
      callEmitted: previous?.callEmitted ?? false,
      resultEmitted: previous?.resultEmitted ?? false,
    };
    tools.set(callId, state);

    const events: TranscriptProjectedEvent[] = [];
    if (!state.callEmitted) {
      events.push({
        kind: "tool_call",
        ts,
        callId,
        name: state.name,
        ...(state.input !== undefined ? { input: state.input } : {}),
      });
      state.callEmitted = true;
    }

    const terminal = isTerminalToolStatus(state.status);
    const hasOutput = hasField(update, "rawOutput", "raw_output", "output", "result");
    const outputValue = hasOutput ? toolOutput(update) : terminal ? update.content : undefined;
    if (!state.resultEmitted && (hasOutput || terminal)) {
      const output = printableOutput(outputValue);
      events.push({
        kind: "tool_result",
        ts,
        callId,
        name: state.name,
        isError: isErrorToolStatus(state.status) || update.isError === true || update.is_error === true,
        ...(output !== undefined ? { output } : {}),
      });
      state.resultEmitted = true;
    }
    return events;
  }

  function projectUpdate(row: JsonObject): TranscriptProjectedEvent[] {
    const { params, update } = updatePayload(row);
    if (!update) return flushOpenChunk();
    const kind = updateKind(update);
    const ts = isoTimestamp(update, params, row);
    const text = textContent(update.content) ?? textContent(update.text);

    if (kind === "agent_message_chunk") {
      return text !== undefined ? appendMessageChunk("assistant", text, ts) : [];
    }
    if (kind === "user_message_chunk") {
      return text !== undefined ? appendMessageChunk("user", text, ts) : [];
    }
    if (kind === "agent_thought_chunk") {
      return text !== undefined ? appendThinkingChunk(text, ts) : [];
    }

    const events = flushOpenChunk();
    if ((kind === "agent_message" || kind === "user_message") && text != null && text.trim().length > 0) {
      events.push({
        kind: "message",
        ts,
        role: kind === "agent_message" ? "assistant" : "user",
        text,
      });
      return events;
    }
    if (kind === "agent_thought" && text != null && text.trim().length > 0) {
      events.push({ kind: "thinking", ts, redacted: false, text });
      return events;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      events.push(...projectTool(update, ts));
      return events;
    }
    if (kind && kind !== "turn_completed") {
      events.push({ kind: "unknown", ts, nativeType: kind });
    }
    return events;
  }

  function projectNativeRow(row: JsonObject): TranscriptProjectedEvent[] {
    const events = flushOpenChunk();
    if (row.synthetic_reason != null) return events;
    const message = asObject(row.message);
    const roleValue = typeof message?.role === "string" ? message.role : row.type;
    const role = roleValue === "user" || roleValue === "assistant" ? roleValue : undefined;
    const text = textContent(message?.content ?? row.content);
    if (!role || text == null || text.trim().length === 0) return events;
    const providerEventId = stringField(row, "id", "uuid", "messageId", "message_id");
    events.push({
      kind: "message",
      ts: isoTimestamp(row, message),
      role,
      text,
      ...(providerEventId ? { providerEventId } : {}),
    });
    return events;
  }

  return {
    harness: "grok",
    pushLine(line: string): TranscriptProjectedEvent[] {
      const row = jsonObject(line);
      if (!row) return [];
      const method = typeof row.method === "string" ? row.method : undefined;
      if (!method) return projectNativeRow(row);
      if (UPDATE_METHODS.has(method)) return projectUpdate(row);
      if (method === "session/prompt") {
        const events = flushOpenChunk();
        const params = asObject(row.params);
        const text = promptText(params);
        if (text !== undefined) {
          events.push({ kind: "message", ts: isoTimestamp(params, row), role: "user", text });
        }
        return events;
      }
      if (PROMPT_COMPLETE_METHODS.has(method)) return flushOpenChunk();
      return flushOpenChunk();
    },
    flush(): TranscriptProjectedEvent[] {
      return flushOpenChunk();
    },
  };
}
