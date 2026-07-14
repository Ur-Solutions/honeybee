/**
 * HSR — Hive Substrate Runner: runner contracts.
 *
 * These are pure interface/data contracts for pane-less local agent execution
 * under the hive daemon (see docs/HSR_EXPLORATION.md §2). Nothing here spawns a
 * process or wires into the spawn/read paths — the SubstrateHsr, the per-harness
 * adapters, and the RunnerRegistry that implement these types land in later
 * units. This file only nails down the shapes they share.
 */

/**
 * Runner tiers, best-available wins (HSR_EXPLORATION.md §2):
 * - "server": one long-lived server process multiplexes N sessions over RPC
 *   (codex `app-server`, opencode `serve`) — best process economics.
 * - "stream": one bidirectional stdin/stdout process per bee, multi-turn
 *   (claude `-p` stream-json, kimi `acp`).
 * - "turn": process per turn, state carried by harness resume (grok `-p`).
 * - "pty": node-pty around the interactive TUI — the fallback when no
 *   structured path is available or allowed.
 */
export type RunnerTier = "server" | "stream" | "turn" | "pty";

/** Provider-neutral structured option/question payload for human input. */
export type RunnerInputOption = {
  label: string;
  description?: string;
};

export type RunnerInputQuestion = {
  /** Provider question key (Codex); Claude keys answers by question text. */
  id?: string;
  header?: string;
  question: string;
  options?: RunnerInputOption[];
  multiSelect?: boolean;
};

/**
 * A structured event emitted by a running harness. Replaces screen-scraping:
 * these feed `deriveState`, needs-input detection, the usage sampler, and the
 * ring buffer that backs `RunnerSession.snapshot()`.
 */
export type RunnerEvent =
  | { type: "turn_start"; ts: number; threadId?: string }
  | { type: "turn_end"; ts: number; threadId?: string }
  | { type: "text"; ts: number; text: string } // assistant output chunk (feeds ring buffer)
  | { type: "tool_use"; ts: number; tool: string; input?: unknown }
  | { type: "usage"; ts: number; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  // Provider rate-limit / exhaustion signal (claude rate_limit_event, codex
  // account/rateLimits/updated). Feeds the usage sampler's account.exhausted
  // edge for pane-less HSR bees. resetHint is a verbatim/derived reset marker.
  | { type: "exhausted"; ts: number; resetHint?: string }
  // Auth-credential expiry signal (UNIT 2): the harness's access token has
  // expired and it CANNOT self-refresh (a remote codex bee runs on an
  // access-token-only credential with a BLANKED refresh token — see
  // remoteCreds.ts). codex surfaces this as a turn `error` whose message is a
  // "Failed to refresh token … empty_string" / 401-unauthorized failure; the
  // adapter classifies THAT into this distinct variant (everything else stays a
  // generic `error`). The daemon reacts by minting a fresh token and restarting
  // the runner with resume — mirrors how `exhausted` drives the autoswap edge.
  | { type: "auth_expired"; ts: number }
  | {
      type: "needs_input";
      ts: number;
      kind: "permission" | "question";
      question: string;
      /** Legacy flat labels for clients that only support one question. */
      options?: string[];
      /** Rich form of `options`, retaining descriptions. */
      optionDetails?: RunnerInputOption[];
      /** Full provider payload; present when a tool asks one or more questions. */
      questions?: RunnerInputQuestion[];
      multiSelect?: boolean;
      tool?: string;
      input?: unknown;
      requestId?: string;
    }
  | { type: "error"; ts: number; message: string }
  | { type: "exit"; ts: number; code: number | null; signal?: string };

/**
 * Everything an adapter needs to start a session. The caller (SubstrateHsr) has
 * already resolved the AgentSpec: `env` is the fully-resolved spawn env with
 * home isolation applied. Depending on the caller, the policy env-scrub (e.g.
 * ANTHROPIC_API_KEY on a claude subscription) may already be done, or the
 * adapter applies it defensively from `authKind`. `command`/`args` carry the
 * resolved base argv from resolveAgent; the adapter appends its tier/auth flags.
 */
export type RunnerOpts = {
  bee: string; // hive bee name
  cwd: string;
  env: Record<string, string>; // fully-resolved spawn env (home isolation already applied by caller)
  sessionId?: string; // provider session id (pinned for claude; learned for others)
  runDir: string; // ~/.hive/hsr/<bee>
  resume?: boolean; // resume an existing provider session (promote/demote, adoption)
  /** Resolved base argv from resolveAgent (the caller). Adapters build the tier argv from these. */
  command?: string;
  args?: string[];
  /** Auth kind for policy (env scrub etc.). Default "subscription". */
  authKind?: "subscription" | "api-key";
  /** Model selector for server-tier adapters that pass it out-of-band (codex thread/start). */
  model?: string;
};

/**
 * How a send should land relative to the live turn. "now" (default) delivers
 * immediately; "next-tool" asks the runner to HOLD the text until the next
 * tool boundary (tool_use / turn_end) of the current turn — idle sessions
 * deliver immediately. Only the stream tier implements the hold; turn tier
 * already queues sends behind the live turn, and server/pty tiers ignore the
 * option (harness-native semantics).
 */
export type RunnerSendOpts = { mode?: "now" | "next-tool" };

/**
 * A live runner session. Steering, interruption, and permission answers route
 * here; `events` is the structured stream and `snapshot()` renders a text tail
 * so the daemon's existing capture/deriveState path keeps functioning.
 */
export type RunnerSession = {
  sessionId: string; // provider session id (pinned or learned)
  tier: RunnerTier;
  pid?: number; // child pid (server tier: the shared server pid)
  send(text: string, opts?: RunnerSendOpts): Promise<void>;
  interrupt(): Promise<void>;
  answer(requestId: string, answer: string): Promise<void>; // respond to a needs_input
  events: AsyncIterable<RunnerEvent>;
  snapshot(lines?: number): string; // rendered tail for Substrate.capture() compat
  stop(): Promise<void>;
};

/**
 * A per-harness runner. `tier()` reflects the allowance registry plus any
 * probe-time downgrade; `start()` wraps the resolved AgentSpec in that tier's
 * process shape and returns a live session.
 */
export type RunnerAdapter = {
  harness: string; // "claude" | "codex" | ...
  tier(): RunnerTier; // from allowance registry + probing
  start(opts: RunnerOpts): Promise<RunnerSession>;
};

/**
 * The registry the SubstrateHsr and the daemon socket call into. Owns the live
 * runner children (spawn/lookup/liveness/stop). Implemented by
 * src/hsr/registry.ts in a later unit.
 */
export type RunnerRegistry = {
  spawn(adapter: RunnerAdapter, opts: RunnerOpts): Promise<RunnerSession>;
  get(bee: string): RunnerSession | undefined;
  liveness(): Map<string, boolean>; // bee -> alive
  stop(bee: string): Promise<void>;
};
