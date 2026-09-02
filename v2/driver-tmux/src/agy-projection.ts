/**
 * agy stream-json projection, captured from agy 1.1.24 on 2026-09-02.
 * HSR logs both the user envelopes written to stdin and agy's stdout lines.
 */
import type {
  TranscriptProjectedEvent,
  TranscriptProjector,
  TranscriptTokenUsage,
} from "./transcript-projection.ts";

type JsonObject = Record<string, unknown>;

const TERMINAL_TOOL_STATES = new Set(["DONE", "ERROR", "FAILED", "CANCELED"]);
const ERROR_TOOL_STATES = new Set(["ERROR", "FAILED", "CANCELED"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const;

function asObject(value: unknown): JsonObject | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((entry) => {
    const block = asObject(entry);
    return block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0
      ? [block.text]
      : [];
  });
  return text.length > 0 ? text.join("\n") : undefined;
}

function usageFrom(value: unknown): TranscriptTokenUsage | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const input = finiteNumber(usage.input_tokens);
  const output = finiteNumber(usage.output_tokens);
  const cacheRead = finiteNumber(usage.cache_read_tokens);
  const cacheWrite = finiteNumber(usage.cache_write_tokens);
  const reasoning = finiteNumber(usage.thinking_tokens);
  const total = finiteNumber(usage.total_tokens);
  const projected: TranscriptTokenUsage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(total !== undefined ? { total } : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function usageDelta(
  current: TranscriptTokenUsage,
  previous: TranscriptTokenUsage | undefined,
  subtractPrevious: boolean,
): TranscriptTokenUsage {
  const projected: TranscriptTokenUsage = {};
  for (const key of USAGE_KEYS) {
    const value = current[key];
    if (value === undefined) continue;
    const before = previous?.[key];
    projected[key] = subtractPrevious && before !== undefined && value >= before
      ? value - before
      : value;
  }
  return projected;
}

function printableOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createAgyProjector(): TranscriptProjector {
  let threadId: string | undefined;
  let sawAssistantText = false;
  let previousResultUsage: TranscriptTokenUsage | undefined;
  let previousNumTurns: number | undefined;
  const assistantFragments = new Map<string, string>();
  const emittedAssistantMessages = new Set<string>();
  const emittedToolCalls = new Set<string>();
  const emittedToolResults = new Set<string>();

  function rememberThread(value: unknown): void {
    const next = nonEmptyString(value);
    if (!next) return;
    if (threadId !== undefined && threadId !== next) {
      previousResultUsage = undefined;
      previousNumTurns = undefined;
      assistantFragments.clear();
      emittedAssistantMessages.clear();
      emittedToolCalls.clear();
      emittedToolResults.clear();
    }
    threadId = next;
  }

  function thread(): { threadId?: string } {
    return threadId ? { threadId } : {};
  }

  function toolCallId(update: JsonObject): string {
    const stepIndex = finiteNumber(update.step_index);
    return `agy:${threadId ?? "unknown"}:${stepIndex ?? "unknown"}`;
  }

  function projectStep(update: JsonObject): TranscriptProjectedEvent[] {
    rememberThread(update.conversation_id);
    const stepType = nonEmptyString(update.step_type);
    if (stepType === "user_input") return [];

    if (stepType === "agent_response") {
      const stepIndex = finiteNumber(update.step_index);
      const eventId = `agy:${threadId ?? "unknown"}:${stepIndex ?? "unknown"}`;
      const delta = typeof update.text_delta === "string" ? update.text_delta : "";
      if (!emittedAssistantMessages.has(eventId) && delta.length > 0) {
        assistantFragments.set(eventId, `${assistantFragments.get(eventId) ?? ""}${delta}`);
      }
      const state = nonEmptyString(update.state)?.toUpperCase();
      if (state !== "DONE" || emittedAssistantMessages.has(eventId)) return [];
      const text = assistantFragments.get(eventId);
      assistantFragments.delete(eventId);
      if (!text || text.trim().length === 0) return [];
      emittedAssistantMessages.add(eventId);
      sawAssistantText = true;
      return [{
        kind: "message",
        ts: null,
        ...thread(),
        role: "assistant",
        text,
        ...(stepIndex !== undefined ? { providerEventId: eventId } : {}),
      }];
    }

    if (stepType !== "tool") return [];
    const state = nonEmptyString(update.state)?.toUpperCase();
    const info = asObject(update.tool_info);
    const name = nonEmptyString(update.tool_name) ?? nonEmptyString(info?.name) ?? "tool";
    const callId = toolCallId(update);
    if (state === "ACTIVE" && !emittedToolCalls.has(callId)) {
      emittedToolCalls.add(callId);
      return [{
        kind: "tool_call",
        ts: null,
        ...thread(),
        callId,
        name,
        ...(info?.parameters !== undefined ? { input: info.parameters } : {}),
      }];
    }
    if (state && TERMINAL_TOOL_STATES.has(state) && !emittedToolResults.has(callId)) {
      emittedToolResults.add(callId);
      const output = printableOutput(info?.output) ?? printableOutput(info?.error);
      return [{
        kind: "tool_result",
        ts: null,
        ...thread(),
        callId,
        name,
        isError: ERROR_TOOL_STATES.has(state),
        ...(output !== undefined ? { output } : {}),
      }];
    }
    return [];
  }

  function projectResult(result: JsonObject): TranscriptProjectedEvent[] {
    rememberThread(result.conversation_id);
    const events: TranscriptProjectedEvent[] = [];
    const response = nonEmptyString(result.response);
    const numTurns = finiteNumber(result.num_turns);
    const turnId = threadId && numTurns !== undefined ? `${threadId}:${numTurns}` : undefined;
    if (response && !sawAssistantText) {
      events.push({ kind: "message", ts: null, ...thread(), role: "assistant", text: response });
    }

    const cumulativeUsage = usageFrom(result.usage);
    if (cumulativeUsage) {
      const canSubtract = previousResultUsage !== undefined
        && previousNumTurns !== undefined
        && numTurns !== undefined
        && numTurns > previousNumTurns;
      events.push({
        kind: "token_usage",
        ts: null,
        ...thread(),
        usage: usageDelta(cumulativeUsage, previousResultUsage, canSubtract),
        scope: "turn",
        ...(turnId ? { providerTurnId: turnId } : {}),
      });
      previousResultUsage = cumulativeUsage;
      previousNumTurns = numTurns;
    }

    const status = nonEmptyString(result.status);
    if (status === "ERROR") {
      const reason = nonEmptyString(result.error) ?? response ?? "agy result error";
      events.push({ kind: "interrupt", ts: null, ...thread(), reason });
    }
    const durationSeconds = finiteNumber(result.duration_seconds);
    events.push({
      kind: "turn_end",
      ts: null,
      ...thread(),
      ...(turnId ? { turnId } : {}),
      ...(durationSeconds !== undefined ? { durationMs: durationSeconds * 1_000 } : {}),
      ...(status ? { finishReason: status } : {}),
      ...((status === "CANCELED" || status === "ERROR") ? { interrupted: true } : {}),
    });
    assistantFragments.clear();
    sawAssistantText = false;
    return events;
  }

  return {
    harness: "agy",
    pushLine(line: string): TranscriptProjectedEvent[] {
      let row: JsonObject | undefined;
      try {
        row = asObject(JSON.parse(line));
      } catch {
        return [];
      }
      if (!row) return [];
      const event = nonEmptyString(row.event);
      if (!event) return [];

      if (event === "init") {
        rememberThread(row.conversation_id);
        sawAssistantText = false;
        return [];
      }
      if (event === "user") {
        const message = asObject(row.message);
        const text = textFromContent(message?.content);
        if (!text) return [];
        sawAssistantText = false;
        return [
          { kind: "turn_start", ts: null, ...thread() },
          { kind: "message", ts: null, ...thread(), role: "user", text },
        ];
      }
      if (event === "step_update") {
        const update = asObject(row.step_update);
        return update ? projectStep(update) : [];
      }
      if (event === "result") {
        const result = asObject(row.result);
        return result ? projectResult(result) : [];
      }
      return [{ kind: "unknown", ts: null, ...thread(), nativeType: event }];
    },
    flush(): TranscriptProjectedEvent[] {
      return [];
    },
  };
}
