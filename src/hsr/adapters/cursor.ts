/**
 * HSR cursor tier-"turn" adapter.
 *
 * cursor-agent has a headless print mode (`-p --output-format stream-json`)
 * but NO multi-turn stdin protocol: each invocation is one turn, and the
 * conversation continues across processes via `--resume=<chatId>`. The shared
 * process-per-turn plumbing lives in turnRunner.ts; this file is purely the
 * per-harness parse config plus the argv/env policy for cursor.
 *
 * Envelope (verified against the cursor-agent 2026.06.24 bundle — the writer
 * code, not docs; intentionally close to claude's stream-json):
 *   {type:"system",subtype:"init",session_id,model,cwd,...}   — FIRST line, carries session_id (the chat id).
 *   {type:"user",message:{...},session_id}                     — echo of the prompt, ignored.
 *   {type:"assistant",message:{content:[{type:"text",text}]},session_id[,timestamp_ms]}
 *   {type:"tool_call",subtype:"started"|"completed",call_id,tool_call,...}
 *   {type:"retry",subtype,...}                                 — transient, ignored.
 *   {type:"result",subtype,is_error,result,session_id[,usage]} — marks TURN END;
 *     usage keys are camelCase: {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}.
 *
 * Node builtins only.
 */

import type { RunnerAdapter, RunnerEvent, RunnerOpts, RunnerSession, RunnerTier } from "../types.js";
import { startTurnRunner, type TurnRunnerConfig } from "../turnRunner.js";
import { harnessAllowance } from "../harness.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Cursor surfaces quota exhaustion as an error result; keep the match verb-
// anchored like drivers.ts RATE_LIMIT_EXHAUSTED so ordinary prose never trips it.
const CURSOR_EXHAUSTED = /(?:reached|hit|exceeded)\s+(?:your\s+)?(?:usage|rate)\s+limit|(?:usage|rate)\s+limit\s+(?:reached|hit|exceeded)|quota\s+(?:reached|exceeded)/i;

/** Parse one raw cursor stream-json line into zero or more RunnerEvents. */
export function parseCursorLine(line: string): RunnerEvent[] {
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
      // init → session_id learned via sessionIdFromCursorEvent (event-less probe).
      return [];
    case "assistant": {
      const message = asObject(msg.message);
      const content = message?.content;
      if (!Array.isArray(content)) return [];
      const events: RunnerEvent[] = [];
      for (const raw of content) {
        const item = asObject(raw);
        if (!item || item.type !== "text") continue;
        const text = String(item.text ?? "");
        if (text.length > 0) events.push({ type: "text", ts: Date.now(), text });
      }
      return events;
    }
    case "tool_call": {
      if (msg.subtype !== "started") return []; // "completed" would double-count
      return [{ type: "tool_use", ts: Date.now(), tool: cursorToolName(msg.tool_call), input: msg.tool_call }];
    }
    case "result": {
      const events: RunnerEvent[] = [];
      if (msg.is_error === true) {
        const message = String(msg.result ?? "cursor result error");
        events.push({ type: "error", ts: Date.now(), message });
        if (CURSOR_EXHAUSTED.test(message)) events.push({ type: "exhausted", ts: Date.now() });
      }
      events.push({ type: "turn_end", ts: Date.now() });
      const usage = cursorUsageEvent(msg.usage);
      if (usage) events.push(usage);
      return events;
    }
    default:
      // user echo, retry, interaction_query, … are intentionally dropped.
      return [];
  }
}

/**
 * Best-effort tool name from cursor's `tool_call` payload. The payload is a
 * protobuf-ish tagged union; prefer an explicit case/name/tool string, else
 * the first object key (the union tag), else a generic label.
 */
export function cursorToolName(toolCall: unknown): string {
  const tc = asObject(toolCall);
  if (!tc) return "tool";
  for (const key of ["case", "name", "tool"]) {
    if (typeof tc[key] === "string" && (tc[key] as string).length > 0) return tc[key] as string;
  }
  const first = Object.keys(tc)[0];
  return first && first.length > 0 ? first : "tool";
}

/** Build a usage event from cursor's camelCase usage object, or undefined. */
function cursorUsageEvent(value: unknown): (RunnerEvent & { type: "usage" }) | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const inputTokens = toNumber(usage.inputTokens);
  const outputTokens = toNumber(usage.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  return { type: "usage", ts: Date.now(), inputTokens, outputTokens, totalTokens };
}

/** Pull the chat id out of any wire line that carries one (the init line first). */
export function sessionIdFromCursorEvent(_event: RunnerEvent, raw: unknown): string | undefined {
  const obj = asObject(raw);
  if (obj && typeof obj.session_id === "string" && obj.session_id.length > 0) return obj.session_id;
  return undefined;
}

/**
 * Drop print/stream flags the caller's resolved args may already carry so the
 * required-flag prepend never doubles them. Handles both `--flag value` and
 * `--flag=value` shapes for --output-format.
 */
export function stripCursorPrintArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-p" || arg === "--print" || arg === "--trust") continue;
    if (arg === "--output-format") {
      i += 1; // skip the value too
      continue;
    }
    if (arg.startsWith("--output-format=")) continue;
    out.push(arg);
  }
  return out;
}

/**
 * Build the cursor turn config + scrubbed spawn env WITHOUT spawning. Pure —
 * exported so tests can exercise argv/env policy and the parse hooks in
 * isolation.
 */
export function buildCursorTurnConfig(opts: RunnerOpts): {
  config: TurnRunnerConfig;
  env: Record<string, string>;
} {
  const command = opts.command ?? "cursor-agent";
  const authKind = opts.authKind ?? "subscription";
  // The print/stream-json/trust flags + env scrub come from the harness
  // registry's allowance policy — the single source shared with allowance.ts.
  const policy = harnessAllowance("cursor", authKind);
  const requiredFlags = [...(policy?.requiredFlags ?? ["-p", "--output-format", "stream-json", "--trust"])];
  const callerArgs = stripCursorPrintArgs(opts.args ?? []);

  const env: Record<string, string> = { ...opts.env };
  for (const key of policy?.scrubEnv ?? []) delete env[key];

  const config: TurnRunnerConfig = {
    harness: "cursor",
    command,
    baseArgs: [...requiredFlags, ...callerArgs],
    // `--resume=<id>` (equals form): --resume's chat-id is optional, so the
    // space form would swallow whatever token follows it.
    turnArgs: (sessionId) => (sessionId ? [`--resume=${sessionId}`] : []),
    parseLine: parseCursorLine,
    sessionIdFromEvent: sessionIdFromCursorEvent,
  };

  return { config, env };
}

export const cursorAdapter: RunnerAdapter = {
  harness: "cursor",
  tier(): RunnerTier {
    return "turn";
  },
  start(opts: RunnerOpts): Promise<RunnerSession> {
    const { config, env } = buildCursorTurnConfig(opts);
    return startTurnRunner(config, { ...opts, env });
  },
};
