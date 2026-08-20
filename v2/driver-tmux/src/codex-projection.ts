import type {
  TranscriptFileChange,
  TranscriptIsoTs,
  TranscriptMessageRole,
  TranscriptProjectedEvent,
  TranscriptProjector,
  TranscriptTokenUsage,
} from "./transcript-projection.ts";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function parseLine(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function idString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isoFrom(value: unknown): TranscriptIsoTs {
  let ms: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    const numeric = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : Number.NaN;
    ms = Number.isFinite(numeric) ? numeric : Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function firstIso(...values: unknown[]): TranscriptIsoTs {
  for (const value of values) {
    const iso = isoFrom(value);
    if (iso != null) return iso;
  }
  return null;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return nonEmptyString(content);
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const value of content) {
    if (typeof value === "string") {
      const text = nonEmptyString(value);
      if (text) texts.push(text);
      continue;
    }
    const block = asObject(value);
    if (!block) continue;
    if (block.type !== "text" && block.type !== "input_text" && block.type !== "output_text" && block.type !== "summary_text") {
      continue;
    }
    const text = nonEmptyString(block.text);
    if (text) texts.push(text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function serialized(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeMessageIdentity(role: "user" | "assistant", text: string): string {
  return `${role}:${text.trim().replace(/\s+/g, " ")}`;
}

function fileChanges(item: JsonObject): TranscriptFileChange[] {
  if (!Array.isArray(item.changes)) return [];
  const files: TranscriptFileChange[] = [];
  for (const value of item.changes) {
    const change = asObject(value);
    if (!change) continue;
    const path = nonEmptyString(change.path);
    if (!path) continue;
    const kind = asObject(change.kind);
    const changeKind = nonEmptyString(kind?.type) ?? nonEmptyString(change.kind);
    const move = asObject(change.move);
    const oldPath = nonEmptyString(change.oldPath)
      ?? nonEmptyString(change.move)
      ?? nonEmptyString(move?.path)
      ?? nonEmptyString(move?.from)
      ?? nonEmptyString(move?.to)
      ?? nonEmptyString(move?.toPath);
    files.push({
      path,
      ...(changeKind ? { changeKind } : {}),
      ...(typeof change.diff === "string" ? { diff: change.diff } : {}),
      ...(oldPath ? { oldPath } : {}),
      ...(finiteNumber(change.addedLines) !== undefined ? { addedLines: finiteNumber(change.addedLines) } : {}),
      ...(finiteNumber(change.removedLines) !== undefined ? { removedLines: finiteNumber(change.removedLines) } : {}),
    });
  }
  return files;
}

function mergeItems(started: JsonObject | undefined, completed: JsonObject): JsonObject {
  if (!started) return completed;
  const merged: JsonObject = { ...started, ...completed };
  const startedInvocation = asObject(started.invocation);
  const completedInvocation = asObject(completed.invocation);
  if (startedInvocation || completedInvocation) {
    merged.invocation = { ...startedInvocation, ...completedInvocation };
  }
  return merged;
}

function mcpName(item: JsonObject): string {
  const invocation = asObject(item.invocation);
  return nonEmptyString(item.name)
    ?? nonEmptyString(item.tool)
    ?? nonEmptyString(invocation?.tool)
    ?? nonEmptyString(invocation?.name)
    ?? "mcp";
}

function mcpInput(item: JsonObject): unknown {
  const invocation = asObject(item.invocation);
  return item.arguments ?? item.input ?? invocation?.arguments ?? invocation?.input;
}

function mcpOutput(item: JsonObject): string | undefined {
  const error = asObject(item.error);
  return serialized(item.result ?? item.output ?? item.content ?? error?.message ?? item.error);
}

function itemCallId(item: JsonObject, nativeType: string): string {
  return idString(item.id) ?? idString(item.callId) ?? `codex:${nativeType}:unknown`;
}

function withThreadId(events: TranscriptProjectedEvent[], threadId: string | undefined): TranscriptProjectedEvent[] {
  return threadId ? events.map((event) => ({ ...event, threadId })) : events;
}

function tokenUsageFrom(source: JsonObject | null | undefined): TranscriptTokenUsage | undefined {
  if (!source) return undefined;
  const raw = asObject(source.usage)
    ?? asObject(source.tokenUsage)
    ?? asObject(source.tokens)
    ?? asObject(source.total_token_usage)
    ?? asObject(source.last_token_usage)
    ?? source;
  const usage: TranscriptTokenUsage = {
    ...(finiteNumber(raw.input ?? raw.input_tokens) !== undefined
      ? { input: finiteNumber(raw.input ?? raw.input_tokens) }
      : {}),
    ...(finiteNumber(raw.output ?? raw.output_tokens) !== undefined
      ? { output: finiteNumber(raw.output ?? raw.output_tokens) }
      : {}),
    ...(finiteNumber(raw.cacheRead ?? raw.cached_input_tokens ?? raw.cache_read) !== undefined
      ? { cacheRead: finiteNumber(raw.cacheRead ?? raw.cached_input_tokens ?? raw.cache_read) }
      : {}),
    ...(finiteNumber(raw.cacheWrite ?? raw.cache_write) !== undefined
      ? { cacheWrite: finiteNumber(raw.cacheWrite ?? raw.cache_write) }
      : {}),
    ...(finiteNumber(raw.reasoning ?? raw.reasoning_output_tokens) !== undefined
      ? { reasoning: finiteNumber(raw.reasoning ?? raw.reasoning_output_tokens) }
      : {}),
    ...(finiteNumber(raw.total ?? raw.total_tokens) !== undefined
      ? { total: finiteNumber(raw.total ?? raw.total_tokens) }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function messageRole(item: JsonObject, fallback: TranscriptMessageRole): TranscriptMessageRole {
  const role = item.role;
  if (role === "user" || role === "assistant" || role === "system" || role === "developer") return role;
  return fallback;
}

function completedItemEvent(
  item: JsonObject,
  ts: TranscriptIsoTs,
  startSeen: boolean,
): TranscriptProjectedEvent[] {
  const nativeType = nonEmptyString(item.type);
  if (!nativeType) return [];
  const itemId = idString(item.id);
  switch (nativeType) {
    case "agentMessage": {
      const text = nonEmptyString(item.text);
      return text
        ? [{
          kind: "message",
          ts,
          role: messageRole(item, "assistant"),
          text,
          ...(itemId ? { providerEventId: itemId } : {}),
        }]
        : [];
    }
    case "userMessage": {
      const text = textFromContent(item.content) ?? nonEmptyString(item.text);
      return text
        ? [{
          kind: "message",
          ts,
          role: messageRole(item, "user"),
          text,
          ...(itemId ? { providerEventId: itemId } : {}),
        }]
        : [];
    }
    case "commandExecution":
      return [{
        kind: "shell",
        ts,
        callId: itemCallId(item, nativeType),
        ...(nonEmptyString(item.command) ? { command: nonEmptyString(item.command) } : {}),
        ...(nonEmptyString(item.cwd) ? { cwd: nonEmptyString(item.cwd) } : {}),
        ...(typeof item.aggregatedOutput === "string" ? { stdout: item.aggregatedOutput } : {}),
        ...(typeof item.stderr === "string" ? { stderr: item.stderr } : {}),
        ...(finiteNumber(item.exitCode) !== undefined ? { exitCode: finiteNumber(item.exitCode) } : {}),
        ...(finiteNumber(item.durationMs) !== undefined ? { durationMs: finiteNumber(item.durationMs) } : {}),
        status: "completed",
      }];
    case "mcpToolCall": {
      const status = nonEmptyString(item.status);
      const isError = item.error != null || status === "failed" || status === "error";
      const output = mcpOutput(item);
      const callId = itemCallId(item, nativeType);
      const result: TranscriptProjectedEvent = {
        kind: "tool_result",
        ts,
        callId,
        isError,
        ...(output !== undefined ? { output } : {}),
      };
      if (startSeen) return [result];
      const input = mcpInput(item);
      return [
        {
          kind: "tool_call",
          ts,
          callId,
          name: mcpName(item),
          ...(input !== undefined ? { input } : {}),
        },
        result,
      ];
    }
    case "reasoning": {
      const text = textFromContent(item.summary) ?? nonEmptyString(item.summary);
      return text
        ? [{ kind: "thinking", ts, redacted: false, text }]
        : [{ kind: "thinking", ts, redacted: true }];
    }
    case "fileChange":
      return [{ kind: "file_edit", ts, ...(itemId ? { callId: itemId } : {}), files: fileChanges(item) }];
    case "contextCompaction": {
      const trigger = nonEmptyString(item.trigger) ?? nonEmptyString(item.reason);
      return [{ kind: "compaction", ts, ...(trigger ? { trigger } : {}) }];
    }
    case "webSearch": {
      const action = asObject(item.action);
      const query = nonEmptyString(item.query) ?? nonEmptyString(action?.query);
      const callId = itemCallId(item, nativeType);
      const call: TranscriptProjectedEvent = {
        kind: "tool_call",
        ts,
        callId,
        name: "web_search",
        ...(query ? { input: { query } } : {}),
      };
      const result: TranscriptProjectedEvent = {
        kind: "tool_result",
        ts,
        callId,
        isError: false,
        ...(serialized(item.result ?? item.output) !== undefined
          ? { output: serialized(item.result ?? item.output) }
          : {}),
      };
      return startSeen ? [result] : [call, result];
    }
    default:
      return [{ kind: "unknown", ts, nativeType }];
  }
}

/**
 * Stateful projection of Codex app-server session logs plus native rollout
 * rows. App-server request/notification envelopes are authoritative for HSR;
 * nested turn items are intentionally never replayed from turn/completed.
 */
export function createCodexProjector(): TranscriptProjector {
  const startedItems = new Map<string, JsonObject>();
  const rolloutMessages = new Set<string>();
  let rolloutTurnOpen = false;

  const emitRolloutMessage = (
    role: "user" | "assistant",
    text: string,
    ts: TranscriptIsoTs,
    itemId?: string,
  ): TranscriptProjectedEvent[] => {
    const identity = normalizeMessageIdentity(role, text);
    if (rolloutMessages.has(identity)) return [];
    rolloutMessages.add(identity);
    return [{ kind: "message", ts, role, text, ...(itemId ? { providerEventId: itemId } : {}) }];
  };

  const pushRollout = (row: JsonObject): TranscriptProjectedEvent[] => {
    const ts = firstIso(row.timestamp, row.emittedAtMs);
    if (row.type === "turn_context") {
      if (rolloutTurnOpen) return [];
      rolloutTurnOpen = true;
      rolloutMessages.clear();
      return [{ kind: "turn_start", ts }];
    }
    const payload = asObject(row.payload);
    if (!payload) return [];
    if (row.type === "event_msg") {
      switch (payload.type) {
        case "task_started":
          if (rolloutTurnOpen) return [];
          rolloutTurnOpen = true;
          rolloutMessages.clear();
          return [{ kind: "turn_start", ts }];
        case "task_complete": {
          rolloutTurnOpen = false;
          const turnId = idString(payload.turn_id) ?? idString(payload.turnId);
          return [{ kind: "turn_end", ts, ...(turnId ? { turnId } : {}) }];
        }
        case "agent_message": {
          const text = nonEmptyString(payload.message);
          return text ? emitRolloutMessage("assistant", text, ts, idString(payload.id)) : [];
        }
        case "user_message": {
          const text = nonEmptyString(payload.message);
          return text ? emitRolloutMessage("user", text, ts, idString(payload.id)) : [];
        }
        case "context_compacted":
          return [{ kind: "compaction", ts }];
        default:
          return [];
      }
    }
    if (row.type !== "response_item") return [];
    switch (payload.type) {
      case "message": {
        const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : null;
        const text = textFromContent(payload.content);
        return role && text ? emitRolloutMessage(role, text, ts, idString(payload.id)) : [];
      }
      case "function_call":
      case "custom_tool_call": {
        const callId = idString(payload.call_id) ?? idString(payload.callId) ?? idString(payload.id);
        if (!callId) return [];
        return [{
          kind: "tool_call",
          ts,
          callId,
          name: nonEmptyString(payload.name) ?? "tool",
          ...((payload.arguments ?? payload.input) !== undefined ? { input: payload.arguments ?? payload.input } : {}),
        }];
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = idString(payload.call_id) ?? idString(payload.callId) ?? idString(payload.id);
        if (!callId) return [];
        const output = serialized(payload.output);
        return [{ kind: "tool_result", ts, callId, isError: false, ...(output !== undefined ? { output } : {}) }];
      }
      case "reasoning": {
        const text = textFromContent(payload.summary) ?? nonEmptyString(payload.summary);
        return text ? [{ kind: "thinking", ts, redacted: false, text }] : [{ kind: "thinking", ts, redacted: true }];
      }
      default:
        return [];
    }
  };

  return {
    harness: "codex",
    pushLine(line: string): TranscriptProjectedEvent[] {
      const row = parseLine(line);
      if (!row) return [];
      const method = nonEmptyString(row.method);
      if (!method) return pushRollout(row);
      const params = asObject(row.params) ?? {};
      switch (method) {
        // Client request: no native turn id exists yet. Only turn/started is
        // the app-server's explicit turn boundary.
        case "turn/start":
          return [];
        case "turn/started": {
          const turn = asObject(params.turn);
          const turnId = idString(turn?.id);
          const threadId = idString(params.threadId);
          return [{
            kind: "turn_start",
            ts: firstIso(row.emittedAtMs),
            ...(turnId ? { turnId } : {}),
            ...(threadId ? { threadId } : {}),
          }];
        }
        case "turn/completed": {
          const turn = asObject(params.turn);
          const turnId = idString(turn?.id);
          const threadId = idString(params.threadId);
          const durationMs = finiteNumber(turn?.durationMs);
          const finishReason = nonEmptyString(turn?.status);
          const usage = tokenUsageFrom(turn);
          const ts = firstIso(row.emittedAtMs);
          const events: TranscriptProjectedEvent[] = [{
            kind: "turn_end",
            ts,
            ...(turnId ? { turnId } : {}),
            ...(threadId ? { threadId } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(finishReason ? { finishReason } : {}),
          }];
          if (usage) {
            events.push({
              kind: "token_usage",
              ts,
              usage,
              scope: "turn",
              ...(turnId ? { providerTurnId: turnId } : {}),
              ...(threadId ? { threadId } : {}),
            });
          }
          return events;
        }
        case "turn/interrupt": {
          const threadId = idString(params.threadId);
          return [{
            kind: "interrupt",
            ts: firstIso(row.emittedAtMs),
            ...(nonEmptyString(params.reason) ? { reason: nonEmptyString(params.reason) } : {}),
            ...(threadId ? { threadId } : {}),
          }];
        }
        case "item/started": {
          const item = asObject(params.item);
          if (!item) return [];
          const itemId = idString(item.id);
          if (itemId) startedItems.set(itemId, item);
          const threadId = idString(params.threadId);
          const ts = firstIso(params.startedAtMs, row.emittedAtMs);
          if (item.type === "commandExecution") {
            return withThreadId([{
              kind: "shell",
              ts,
              callId: itemCallId(item, "commandExecution"),
              ...(nonEmptyString(item.command) ? { command: nonEmptyString(item.command) } : {}),
              ...(nonEmptyString(item.cwd) ? { cwd: nonEmptyString(item.cwd) } : {}),
              status: "started",
            }], threadId);
          }
          if (item.type === "mcpToolCall") {
            const input = mcpInput(item);
            return withThreadId([{
              kind: "tool_call",
              ts,
              callId: itemCallId(item, "mcpToolCall"),
              name: mcpName(item),
              ...(input !== undefined ? { input } : {}),
            }], threadId);
          }
          if (item.type === "webSearch") {
            const action = asObject(item.action);
            const query = nonEmptyString(item.query) ?? nonEmptyString(action?.query);
            return withThreadId([{
              kind: "tool_call",
              ts,
              callId: itemCallId(item, "webSearch"),
              name: "web_search",
              ...(query ? { input: { query } } : {}),
            }], threadId);
          }
          return [];
        }
        case "item/completed": {
          const completed = asObject(params.item);
          if (!completed) return [];
          const itemId = idString(completed.id);
          const startSeen = itemId != null && startedItems.has(itemId);
          const item = mergeItems(itemId ? startedItems.get(itemId) : undefined, completed);
          if (itemId) startedItems.delete(itemId);
          return withThreadId(
            completedItemEvent(item, firstIso(params.completedAtMs, row.emittedAtMs), startSeen),
            idString(params.threadId),
          );
        }
        case "thread/tokenUsage/updated": {
          const usage = tokenUsageFrom(params) ?? tokenUsageFrom(asObject(params.rateLimits) ?? params);
          if (!usage) return [];
          const threadId = idString(params.threadId);
          return [{
            kind: "token_usage",
            ts: firstIso(row.emittedAtMs),
            usage,
            scope: nonEmptyString(params.scope) ?? "cumulative",
            ...(threadId ? { threadId } : {}),
          }];
        }
        default:
          // Deltas, usage/account notifications, and server protocol chatter
          // are not pane events. Lifecycle stays owned by the adapter/core.
          return [];
      }
    },
    flush(): TranscriptProjectedEvent[] {
      startedItems.clear();
      return [];
    },
  };
}
