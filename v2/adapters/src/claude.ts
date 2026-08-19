/**
 * Claude harness adapter (WP3) — normalizes the `claude -p --input-format
 * stream-json --output-format stream-json --verbose` NDJSON envelope.
 *
 * Stream format derived by reading the previous system's adapter
 * (src/hsr/adapters/claude.ts) and its live-captured fixture
 * (tests/fixtures/claude-stream-json.sample.jsonl, claude_code_version
 * 2.1.198). No code is imported from the old tree — the format knowledge is
 * re-encoded here and must be re-verified against a real stream in the manual
 * smoke (v2/driver-hsr/SMOKE.md).
 *
 * Envelope:
 *   {type:"system",subtype:"init",session_id,...}   — FIRST line; readiness + session id.
 *   {type:"system",subtype:"thinking_tokens",...}   — progress ping, no state signal.
 *   {type:"assistant",message:{content:[...]}}      — mid-turn output, no state signal.
 *   {type:"result",subtype,is_error,result,...}     — TURN END (also emitted for errors).
 *   {type:"rate_limit_event",rate_limit_info:{status,resetsAt,...}}
 *                                                   — status "allowed*" is benign/clearing;
 *                                                     anything else = out of quota.
 *   {type:"control_request",...}                    — interactive tool prompts; out of
 *                                                     WP3's four-state scope, ignored.
 *
 * State mapping (spec 03): init → booted (claude boots straight to
 * ready-for-input, so booted is followed by turn_ended — see types.ts);
 * result → turn_ended. turn_started is synthesized by the driver at the
 * moment it injects input (claude emits no explicit turn-start line).
 */
import {
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  isoFromEpochSeconds,
  parseJsonLine,
  successfulTurnClears,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
  type InterruptContext,
} from "./types.ts";
import { asObject } from "./types.ts";

/**
 * Map a `rate_limit_event`'s `rate_limit_info` to flag evidence. Verified
 * capture shape (old adapter): {status:"allowed"|"allowed_warning"|"rejected"|
 * "blocked"|…, resetsAt:<unix seconds>, rateLimitType, overageStatus, …}.
 * `status` is the gate: "allowed*" means quota is available (contrary
 * evidence → clear); any other status means the account is out of quota.
 */
function rateLimitSignals(rateLimitInfo: unknown): AdapterSignal[] {
  const info = asObject(rateLimitInfo);
  if (!info) return [];
  const status = typeof info.status === "string" ? info.status : undefined;
  if (!status) return [];
  if (status.startsWith("allowed")) {
    return [{ kind: "flag", flag: "resource_blocked", action: "clear", detail: `claude rate limit ${status}` }];
  }
  const reset = isoFromEpochSeconds(info.resetsAt);
  return [{
    kind: "flag",
    flag: "resource_blocked",
    action: "set",
    detail: `claude rate limit ${status}${reset ? `, resets ${reset}` : ""}`,
  }];
}

function resultSignals(msg: Record<string, unknown>): AdapterSignal[] {
  const signals: AdapterSignal[] = [];
  if (msg.is_error === true) {
    const message = String(msg.result ?? msg.api_error_status ?? "claude result error");
    if (isAuthNeededMessage(message)) {
      signals.push({ kind: "flag", flag: "auth_needed", action: "set", detail: message.slice(0, 500) });
    } else if (isResourceBlockedMessage(message)) {
      signals.push({ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) });
    }
    // An errored turn still ENDS the turn (claude emits result either way),
    // but is not contrary evidence — no clears.
    signals.push({ kind: "turn_ended" });
    return signals;
  }
  signals.push(...successfulTurnClears());
  signals.push({ kind: "turn_ended" });
  return signals;
}

export function parseClaudeLine(line: string): AdapterSignal[] {
  const msg = parseJsonLine(line);
  if (!msg || typeof msg.type !== "string") return [];
  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return []; // thinking_tokens etc: progress pings
      const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
      return bootedToIdle(sessionId);
    }
    case "rate_limit_event":
      return rateLimitSignals(msg.rate_limit_info);
    case "result":
      return resultSignals(msg);
    case "assistant":
      // Usually mid-turn output — the driver dedupes by phase, so this is a
      // no-op while running. But a SELF-WOKEN turn (harness-internal wake:
      // background-task notifications, scheduled continuations) has no
      // delivery and no user message — assistant output on an idle runtime
      // is its ONLY opening edge. Without this, self-woken bees showed
      // idle/"needs your reply" while actively working (2026-08-19, observed
      // on the cutover executor itself).
      return [{ kind: "turn_started" }];
    case "user":
    case "control_request": // interactive prompts are out of WP3 scope
    case "control_response":
      return [];
    default:
      return [];
  }
}

/** One stream-json user message line (the same shape the old system verified). */
export function encodeClaudeMessage(body: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: body }] },
  });
}

/**
 * Harness-native resume (spec 07 §F): `claude -p --resume <session_id>` rejoins
 * the headless conversation with full model context and keeps the SAME
 * session_id (the init line echoes it) — verified by the old system for
 * headless↔headless (docs/HSR_EXPLORATION.md 2026-07-03). Requires the process
 * to run with the CLAUDE_CONFIG_DIR the session was created under (the bee's
 * env carries it for imported bees). Never combined with `--session-id`.
 */
export function claudeResumeArgs(providerSessionId: string): string[] {
  return ["--resume", providerSessionId];
}

/**
 * v6 fork: `--resume <source> --fork-session` — claude rejoins the source
 * conversation with full context but mints a NEW session id for the child
 * (the init line reports it; the daemon records it on the fork). Without
 * `--fork-session` the resumed process keeps the SAME id and source + fork
 * would write one transcript (the old system's drivers.ts: "--fork-session
 * forks the resumed transcript"; claude refuses `--resume <id> --session-id
 * <new>` without it). Never combined with `--session-id` here — claude
 * mints; the adapter records.
 */
export function claudeForkArgs(sourceSessionId: string): string[] {
  return ["--resume", sourceSessionId, "--fork-session"];
}

/**
 * v6 interrupt — the stream-json control protocol (the OLD system's verified
 * shape, src/hsr/adapters/claude.ts encodeClaudeInterrupt): claude ends the
 * current turn (emitting its `result` line → turn_ended) and keeps the
 * session alive — unlike SIGINT, which kills the headless child. The
 * `control_response` ack parses to [] (unknown type) in parseClaudeLine.
 */
let interruptCounter = 0;
export function encodeClaudeInterrupt(): string {
  interruptCounter += 1;
  return JSON.stringify({
    type: "control_request",
    request_id: `hive-interrupt-${interruptCounter}`,
    request: { subtype: "interrupt" },
  });
}

export const claudeAdapter: HarnessAdapter = {
  harness: "claude",
  // Claude Code accepts additional stream-json user messages mid-turn and
  // queues them at its own safe boundary (verified by the old system's
  // nativeSteering path).
  acceptsMidTurn: true,
  readyAtSpawn: true,
  bootLines(): string[] {
    return [];
  },
  parseLine: parseClaudeLine,
  encodeMessage(body: string, _ctx: EncodeContext): string | null {
    return encodeClaudeMessage(body);
  },
  resumeArgs: claudeResumeArgs,
  forkArgs: claudeForkArgs,
  encodeInterrupt(_ctx: InterruptContext): string | null {
    return encodeClaudeInterrupt();
  },
};
