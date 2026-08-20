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

type Base = { ts: TranscriptIsoTs; threadId?: string };

export type TranscriptProjectedEvent =
  | (Base & { kind: "turn_start"; turnId?: string })
  | (Base & { kind: "turn_end"; turnId?: string; durationMs?: number; finishReason?: string })
  | (Base & { kind: "interrupt"; reason?: string })
  | (Base & {
      kind: "message";
      role: TranscriptMessageRole;
      text: string;
      providerEventId?: string;
    })
  | (Base & { kind: "thinking"; redacted: boolean; text?: string })
  | (Base & { kind: "tool_call"; callId: string; name: string; input?: unknown })
  | (Base & { kind: "tool_result"; callId: string; isError: boolean; output?: string; name?: string })
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
  | (Base & {
      kind: "token_usage";
      usage: TranscriptTokenUsage;
      scope?: string;
      providerTurnId?: string;
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
