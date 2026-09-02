/**
 * Pane-ready transcript projection (G3).
 *
 * One stateful projector per harness consumes published session-log JSONL and
 * emits canonical events. The union is a geometry-blind payload: apiaryd stores
 * one feed row per line with the events array and synthesizes ids
 * `beeId:lineNo:idx`. Observation parsers in transcripts.ts stay three-kind
 * (turn_started / output / turn_ended) and MUST NOT infer lifecycle, attention,
 * or permission — no `needs_input` kind.
 *
 * Shape is a pure map onto Apiary's AgentEvent (minus id/harness/raw; threadId
 * optional here, root fallback on the Apiary side). Confirmed CL.7920 2026-08-20.
 *
 * Threads (2026-09-02): a projector that can prove parentage sets BOTH
 * `threadId` and `parentThreadId` — that pair is the sidechain contract.
 * `parentThreadId` is always the literal `"root"` today (one nesting level;
 * deeper harness children flatten onto it). A `threadId` WITHOUT
 * `parentThreadId` is a provider-native conversation id, not a sidechain, and
 * consumers keep treating it as the root thread. Harness-internal subagents
 * (claude `Agent`/`Task`) ride the parent's own session log, so the projector
 * introduces each one with a `session_start` on its thread (agentType,
 * description, spawnToolUseId) and closes it with `session_end` (status) when
 * the harness reports the task done — explicit facts, never inferred from
 * quiescence.
 *
 * ts is ISO-8601 or null. Epoch fields on the wire (emittedAtMs, startedAtMs,
 * completedAtMs) convert here. Unknown completed item types become `unknown`
 * with nativeType — never dropped silently, never bee state.
 */
export type TranscriptIsoTs = string | null;

export type TranscriptMessageRole = "user" | "assistant" | "system" | "developer";

export type TranscriptTokenUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
};

export type TranscriptFileChange = {
  path: string;
  changeKind?: string;
  oldPath?: string;
  diff?: string;
  addedLines?: number;
  removedLines?: number;
};

/** Bounded inline image bytes emitted by a harness tool result. */
export type TranscriptProjectedImage = {
  data: string;
  mimeType: string;
};

export const ROOT_THREAD_ID = "root";
export const SIDECHAIN_THREAD_PREFIX = "sidechain:";
/** Thread id for a harness-internal subagent (its harness-native task/agent id). */
export function sidechainThreadId(agentId: string): string {
  return `${SIDECHAIN_THREAD_PREFIX}${agentId}`;
}

type Base = { ts: TranscriptIsoTs; threadId?: string; parentThreadId?: string };

export type TranscriptProjectedEvent =
  | (Base & {
      kind: "session_start";
      sessionId?: string;
      cwd?: string;
      model?: string;
      cliVersion?: string;
      /** Harness-defined subagent kind (claude `subagent_type`, e.g. `Explore`). */
      agentType?: string;
      /** Human-readable subagent task description from the spawn record. */
      description?: string;
      /** The parent-thread tool call (claude `Agent` tool_use id) that spawned this thread. */
      spawnToolUseId?: string;
    })
  | (Base & { kind: "session_end"; status?: string })
  | (Base & { kind: "turn_start"; turnId?: string })
  | (Base & { kind: "turn_end"; turnId?: string; durationMs?: number; finishReason?: string; interrupted?: boolean })
  | (Base & { kind: "interrupt"; reason?: string })
  | (Base & {
      kind: "message";
      role: TranscriptMessageRole;
      text: string;
      providerEventId?: string;
    })
  | (Base & { kind: "thinking"; redacted: boolean; text?: string })
  | (Base & { kind: "tool_call"; callId: string; name: string; input?: unknown })
  | (Base & {
      kind: "tool_result";
      callId: string;
      isError: boolean;
      output?: string;
      name?: string;
      images?: TranscriptProjectedImage[];
    })
  | (Base & {
      kind: "shell";
      callId: string;
      status: "started" | "completed";
      command?: string;
      cwd?: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      durationMs?: number;
    })
  | (Base & { kind: "file_edit"; callId?: string; files: TranscriptFileChange[] })
  | (Base & { kind: "web_search"; itemId?: string; providerEventId?: string; query?: string })
  | (Base & {
      kind: "token_usage";
      /** `input` is UNCACHED input everywhere (OpenAI/xAI-shaped counts, which
       * fold cached reads into input, are normalized by their projectors). */
      usage: TranscriptTokenUsage;
      scope?: string;
      providerTurnId?: string;
      /** Provider model id the usage was billed against, when the log says. */
      model?: string;
      /** Provider-reported USD for this usage (claude `result` rows), when present. */
      costUsd?: number;
    })
  | (Base & { kind: "compaction"; trigger?: string; tokensBefore?: number; tokensAfter?: number })
  | (Base & { kind: "unknown"; nativeType: string; detail?: string });

/**
 * Incremental contract, identical to Apiary TranscriptNormalizer push/flush:
 * pushLine returns events derivable so far; flush emits held pairing/chunks.
 */
export interface TranscriptProjector {
  readonly harness: string;
  pushLine(line: string): TranscriptProjectedEvent[];
  flush(): TranscriptProjectedEvent[];
}

export type TranscriptProjectorFactory = () => TranscriptProjector;
