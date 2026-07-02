/**
 * HSR claude tier-B (stream) adapter (APIA-74).
 *
 * Configures the shared `BaseStreamRunner` for `claude -p` with the stream-json
 * envelope: one child per bee, NDJSON stdin/stdout, multi-turn. The process
 * plumbing lives in streamRunner.ts; this file is purely the per-harness
 * parse/encode config plus the argv/env policy for claude.
 *
 * Envelope (claude 2.1.x, verified from a live capture):
 *   {type:"system",subtype:"init",session_id,...}     — FIRST line, carries session_id.
 *   {type:"rate_limit_event",rate_limit_info,...}      — future exhaustion signal, ignored v1.
 *   {type:"system",subtype:"thinking_tokens",...}      — progress ping, ignored.
 *   {type:"assistant",message:{content:[thinking|text|tool_use]},...}
 *   {type:"result",subtype,is_error,result,usage,...}  — marks TURN END.
 *
 * Node builtins only.
 */

import type { RunnerAdapter, RunnerEvent, RunnerOpts, RunnerSession, RunnerTier } from "../types.js";
import { startStreamRunner, type StreamRunnerConfig } from "../streamRunner.js";
import { scrubEnvFor } from "../allowance.js";

// The stream-json flags the adapter prepends for tier "stream". The caller's
// args (--model, --session-id, --dangerously-skip-permissions, …) follow.
const CLAUDE_STREAM_FLAGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
];

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse one raw claude stream-json line into zero or more RunnerEvents. */
function parseClaudeLine(line: string): RunnerEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const msg = asObject(parsed);
  if (!msg || typeof msg.type !== "string") return [];

  switch (msg.type) {
    case "system":
      // init → sessionId learned via sessionIdFromEvent; thinking_tokens → progress ping.
      return [];
    case "rate_limit_event":
      // v1: rate_limit_info is a future exhaustion signal, not acted on yet.
      return [];
    case "assistant": {
      const message = asObject(msg.message);
      const content = message?.content;
      if (!Array.isArray(content)) return [];
      const events: RunnerEvent[] = [];
      for (const raw of content) {
        const item = asObject(raw);
        if (!item || typeof item.type !== "string") continue;
        if (item.type === "text") {
          events.push({ type: "text", ts: Date.now(), text: String(item.text ?? "") });
        } else if (item.type === "tool_use") {
          events.push({ type: "tool_use", ts: Date.now(), tool: String(item.name ?? ""), input: item.input });
        }
        // "thinking" (and anything else) is intentionally dropped — reasoning stays
        // out of the ring/text stream.
      }
      return events;
    }
    case "result": {
      const usage = asObject(msg.usage) ?? {};
      const inputTokens = toNumber(usage.input_tokens);
      const outputTokens = toNumber(usage.output_tokens);
      const totalTokens =
        inputTokens !== undefined || outputTokens !== undefined
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : undefined;
      const events: RunnerEvent[] = [];
      if (msg.is_error === true) {
        const message = String(msg.result ?? msg.api_error_status ?? "claude result error");
        events.push({ type: "error", ts: Date.now(), message });
      }
      events.push({ type: "turn_end", ts: Date.now() });
      events.push({ type: "usage", ts: Date.now(), inputTokens, outputTokens, totalTokens });
      return events;
    }
    default:
      return [];
  }
}

/** Pull the provider session id out of a system/init line (event-less). */
function sessionIdFromClaudeEvent(_event: RunnerEvent, raw: unknown): string | undefined {
  const obj = asObject(raw);
  if (obj && obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    return obj.session_id;
  }
  return undefined;
}

/** Encode a user turn as one stream-json user message line (trailing newline). */
function encodeClaudeUserTurn(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/**
 * Build the claude stream config + scrubbed spawn env WITHOUT spawning. Pure —
 * exported so tests can exercise argv/env policy and the parse/encode hooks in
 * isolation.
 */
export function buildClaudeStreamConfig(opts: RunnerOpts): {
  config: StreamRunnerConfig;
  env: Record<string, string>;
} {
  const command = opts.command ?? "claude";

  // Prepend the stream-json flags, then preserve the caller's resolved args
  // (--model, --session-id, --dangerously-skip-permissions, …). Defensive: if
  // the caller already carries -p, don't add it a second time.
  const callerArgs = opts.args ?? [];
  const streamFlags = callerArgs.includes("-p") ? CLAUDE_STREAM_FLAGS.filter((f) => f !== "-p") : CLAUDE_STREAM_FLAGS;
  const args = [...streamFlags, ...callerArgs];

  // Env scrub: on a claude subscription, a present ANTHROPIC_API_KEY is silently
  // billed in -p mode. Delete every scrub key for this (harness, authKind).
  const authKind = opts.authKind ?? "subscription";
  const env: Record<string, string> = { ...opts.env };
  for (const key of scrubEnvFor("claude", authKind)) delete env[key];

  const config: StreamRunnerConfig = {
    harness: "claude",
    tier: "stream",
    command,
    args,
    parseLine: parseClaudeLine,
    encodeUserTurn: encodeClaudeUserTurn,
    // encodeAnswer omitted for v1 — claude permission routing is deferred; yolo
    // mode has no prompts to answer.
    sessionIdFromEvent: sessionIdFromClaudeEvent,
  };

  return { config, env };
}

export const claudeAdapter: RunnerAdapter = {
  harness: "claude",
  tier(): RunnerTier {
    return "stream";
  },
  start(opts: RunnerOpts): Promise<RunnerSession> {
    const { config, env } = buildClaudeStreamConfig(opts);
    return startStreamRunner(config, { ...opts, env });
  },
};
