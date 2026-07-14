/**
 * HSR claude tier-B (stream) adapter (APIA-74).
 *
 * Configures the shared stream runner for `claude -p` with the stream-json
 * envelope: one child per bee, NDJSON stdin/stdout, multi-turn. The process
 * plumbing lives in streamRunner.ts; this file is purely the per-harness
 * parse/encode config plus the argv/env policy for claude.
 *
 * Envelope (claude 2.1.x, verified from a live capture):
 *   {type:"system",subtype:"init",session_id,...}     — FIRST line, carries session_id.
 *   {type:"rate_limit_event",rate_limit_info,...}      — exhaustion signal → {type:"exhausted"} when rejected.
 *   {type:"system",subtype:"thinking_tokens",...}      — progress ping, ignored.
 *   {type:"assistant",message:{content:[thinking|text|tool_use]},...}
 *   {type:"result",subtype,is_error,result,usage,...}  — marks TURN END.
 *
 * Node builtins only.
 */

import type {
  RunnerAdapter,
  RunnerEvent,
  RunnerInputQuestion,
  RunnerOpts,
  RunnerSession,
  RunnerTier,
} from "../types.js";
import { startStreamRunner, type StreamRunnerConfig } from "../streamRunner.js";
import { harnessAllowance } from "../harness.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse one raw claude stream-json line into zero or more RunnerEvents. */
function parseClaudeQuestions(input: unknown): RunnerInputQuestion[] {
  const questions = asObject(input)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((raw): RunnerInputQuestion[] => {
    const q = asObject(raw);
    if (!q || typeof q.question !== "string" || q.question.length === 0) return [];
    const options = Array.isArray(q.options)
      ? q.options.flatMap((rawOption) => {
          const option = asObject(rawOption);
          if (!option || typeof option.label !== "string") return [];
          return [{
            label: option.label,
            ...(typeof option.description === "string" ? { description: option.description } : {}),
          }];
        })
      : undefined;
    return [{
      question: q.question,
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      ...(options && options.length > 0 ? { options } : {}),
      ...(typeof q.multiSelect === "boolean" ? { multiSelect: q.multiSelect } : {}),
    }];
  });
}

function claudeNeedsInput(requestId: string, input: unknown): RunnerEvent | null {
  const questions = parseClaudeQuestions(input);
  const first = questions[0];
  if (!first) return null;
  return {
    type: "needs_input",
    ts: Date.now(),
    kind: "question",
    question: first.question,
    ...(first.options ? { options: first.options.map((option) => option.label), optionDetails: first.options } : {}),
    ...(first.multiSelect !== undefined ? { multiSelect: first.multiSelect } : {}),
    questions,
    tool: "AskUserQuestion",
    input,
    requestId,
  };
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
    case "control_request": {
      const request = asObject(msg.request);
      if (
        request?.subtype !== "can_use_tool" ||
        request.tool_name !== "AskUserQuestion" ||
        typeof msg.request_id !== "string"
      ) return [];
      const event = claudeNeedsInput(msg.request_id, request.input);
      return event ? [event] : [];
    }
    case "system":
      // init → sessionId learned via sessionIdFromEvent; thinking_tokens → progress ping.
      return [];
    case "rate_limit_event":
      return parseClaudeRateLimit(msg.rate_limit_info);
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

/**
 * Map a claude `rate_limit_event`'s `rate_limit_info` to zero or one `exhausted`
 * event. Real envelope (verified capture):
 *   {status:"allowed", resetsAt:1783034400, rateLimitType:"five_hour",
 *    overageStatus:"rejected", overageDisabledReason:..., isUsingOverage:false}
 *
 * `status` is the gate. Claude Code's rolling-limit statuses are "allowed" and
 * "allowed_warning" (benign — allowed now / approaching the cap) plus rejected
 * states ("rejected", "blocked", …) that mean the account is out of quota. We
 * treat any status that does NOT start with "allowed" as exhausted, so a benign
 * update (or a future "allowed_*" variant) keeps returning []. `resetsAt` is a
 * UNIX-SECONDS epoch; we surface it as an ISO resetHint when present.
 */
function parseClaudeRateLimit(rateLimitInfo: unknown): RunnerEvent[] {
  const info = asObject(rateLimitInfo);
  if (!info) return [];
  const status = typeof info.status === "string" ? info.status : undefined;
  // No status, or a benign "allowed"/"allowed_warning": not an exhaustion edge.
  if (!status || status.startsWith("allowed")) return [];
  const resetHint = resetHintFromEpochSeconds(info.resetsAt);
  return [{ type: "exhausted", ts: Date.now(), ...(resetHint ? { resetHint } : {}) }];
}

/** Convert a UNIX-seconds epoch to an ISO reset hint, or undefined if unusable. */
function resetHintFromEpochSeconds(value: unknown): string | undefined {
  const seconds = toNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
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

function parsedAnswerMap(answer: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(answer);
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

/** Encode a response to Claude's stream-json can_use_tool control request. */
export function encodeClaudeQuestionAnswer(requestId: string, answer: string, input: unknown): string {
  const questions = parseClaudeQuestions(input);
  const supplied = parsedAnswerMap(answer);
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const value = supplied?.[question.question] ?? supplied?.[question.id ?? ""] ?? (index === 0 ? answer : undefined);
    if (typeof value === "string") answers[question.question] = value;
    else if (Array.isArray(value)) answers[question.question] = value.map(String).join(", ");
    else if (value !== undefined) answers[question.question] = String(value);
  }
  const original = asObject(input) ?? {};
  return `${JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { behavior: "allow", updatedInput: { ...original, answers } },
    },
  })}\n`;
}

/**
 * Encode an in-band turn interrupt (stream-json control protocol): claude ends
 * the current turn (emitting its result line) and keeps the session alive —
 * unlike SIGINT, which kills the headless child and crashes the bee. The
 * control_response ack line parses to [] in parseClaudeLine (unknown type).
 */
let interruptRequestCounter = 0;
function encodeClaudeInterrupt(): string {
  interruptRequestCounter += 1;
  return `${JSON.stringify({
    type: "control_request",
    request_id: `hive-interrupt-${interruptRequestCounter}`,
    request: { subtype: "interrupt" },
  })}\n`;
}

/**
 * Drop any `--session-id <id>` pair from an arg list. A fresh spawn pins the
 * provider session with `--session-id`; a RESUME must instead carry `--resume
 * <id>` and MUST NOT also pass `--session-id` (claude rejects starting a session
 * whose id already exists on disk). Removes the flag and its following value.
 */
function stripSessionIdArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session-id") {
      i += 1; // skip the flag's value too
      continue;
    }
    out.push(args[i]!);
  }
  return out;
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
  const authKind = opts.authKind ?? "subscription";
  // The stream-json flags + env scrub come from the harness registry's
  // allowance policy — the single source shared with allowance.ts (HIVE-20).
  const policy = harnessAllowance("claude", authKind);

  // Prepend the stream-json flags, then preserve the caller's resolved args
  // (--model, --session-id, --dangerously-skip-permissions, …). Defensive: if
  // the caller already carries -p, don't add it a second time.
  //
  // RESUME (demote: tmux→HSR headless resume): when the caller asks to resume an
  // existing provider session, emit `--resume <sessionId>` INSTEAD of the fresh
  // spawn's `--session-id` pinning. We strip any `--session-id <id>` pair the
  // caller left in (a fresh spawn's forcedSessionIdArgs) and ensure `--resume
  // <sessionId>` is present exactly once, so the headless run rejoins the SAME
  // native transcript the interactive/tmux session was writing (§4).
  let callerArgs = opts.args ?? [];
  if (opts.resume === true && opts.sessionId) {
    callerArgs = stripSessionIdArgs(callerArgs);
    if (!callerArgs.includes("--resume")) {
      callerArgs = ["--resume", opts.sessionId, ...callerArgs];
    }
  }
  const requiredFlags = policy?.requiredFlags ?? [];
  const streamFlags = callerArgs.includes("-p") ? requiredFlags.filter((f) => f !== "-p") : [...requiredFlags];
  const args = [...streamFlags, ...callerArgs];

  // Env scrub: on a claude subscription, a present ANTHROPIC_API_KEY is silently
  // billed in -p mode. Delete every scrub key for this (harness, authKind).
  const env: Record<string, string> = { ...opts.env };
  for (const key of policy?.scrubEnv ?? []) delete env[key];

  const pendingQuestions = new Map<string, unknown>();
  const parseLine = (line: string): RunnerEvent[] => {
    const events = parseClaudeLine(line);
    for (const event of events) {
      if (event.type === "needs_input" && event.requestId) pendingQuestions.set(event.requestId, event.input);
    }
    return events;
  };
  const config: StreamRunnerConfig = {
    harness: "claude",
    tier: "stream",
    command,
    args,
    parseLine,
    encodeUserTurn: encodeClaudeUserTurn,
    encodeInterrupt: encodeClaudeInterrupt,
    encodeAnswer: (requestId, answer) => {
      const input = pendingQuestions.get(requestId);
      if (input === undefined) throw new Error(`hsr claude: no pending question for requestId ${requestId}`);
      pendingQuestions.delete(requestId);
      return encodeClaudeQuestionAnswer(requestId, answer, input);
    },
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
