import type { HsrAnswerHostIdentity } from "../answerReceipt.js";

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
 *   (claude `-p` stream-json, kimi `acp`, grok `agent stdio`).
 * - "turn": process per turn, state carried by harness resume (cursor `-p`).
 * - "pty": node-pty around the interactive TUI — the fallback when no
 *   structured path is available or allowed.
 */
export type RunnerTier = "server" | "stream" | "turn" | "pty";

/** Provider-neutral structured option/question payload for human input. */
export type RunnerInputOption = {
  label: string;
  description?: string;
  /** Optional richer comparison content (Grok ask_user_question extension). */
  preview?: string;
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
 * Provider-neutral answer accepted by RunnerSession.answer(). The legacy text
 * form remains valid for permissions and single questions. Providers with a
 * multi-question form (OpenCode) can retain their native ordered, multi-select
 * answer matrix instead of flattening it through a string.
 */
export type RunnerInputAnswer = string | string[][];

/** Shared auth-failure classifier used by observation and compaction folds. */
export function isRunnerAuthNeededMessage(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("not logged in") && m.includes("/login")) return true;
  if (m.includes("please log out and sign in again")) return true;
  if (m.includes("please sign out and sign in again")) return true;
  if (m.includes("access token") && m.includes("could not be refreshed")) return true;
  if (m.includes("access token") && m.includes("couldn't be refreshed")) return true;
  if (m.includes("access token") && m.includes("cannot be refreshed")) return true;
  if ((m.includes("token") || m.includes("oauth")) && m.includes("revoked")) return true;
  if (m.includes("401") && (m.includes("oauth") || m.includes("unauthorized") || m.includes("authentication"))) return true;
  if ((m.includes("please log in") || m.includes("please login") || m.includes("sign in again")) && m.includes("auth")) return true;
  if (m.startsWith("failed to authenticate")) return true;
  return (
    (m.includes("oauth") || m.includes("session"))
    && m.includes("expired")
    && (m.includes("could not be refreshed") || m.includes("couldn't be refreshed") || m.includes("cannot be refreshed"))
  );
}

/** Validation-only answer preparation followed by one write-confirmed effect. */
export type RunnerPreparedAnswer = {
  dispatch(): Promise<void>;
};

/**
 * A structured event emitted by a running harness. Replaces screen-scraping:
 * these feed `deriveState`, needs-input detection, the usage sampler, and the
 * ring buffer that backs `RunnerSession.snapshot()`.
 *
 * `seq` is the per-bee monotonic sequence cursor (cell transport): the run-dir
 * writer stamps it on EVERY append (starting at 1), so a consumer that resumes
 * after a dead connection can fetch exactly `seq > afterSeq` and ack a
 * high-water mark. Optional on the wire for back-compat — legacy on-disk
 * events and synthetic compaction checkpoints carry no seq.
 */
export type RunnerEvent = (
  | { type: "host_epoch"; ts: number; host: HsrAnswerHostIdentity }
  | {
      /**
       * Local source compaction proof. `throughSeq` is the exact contiguous
       * stamped prefix intentionally folded by the authority-held compactor;
       * without it, a retained suffix starting above seq 1 is indistinguishable
       * from deleted provider history.
       */
      type: "source_cursor_checkpoint";
      ts: number;
      throughSeq: number;
    }
  | {
      /**
       * Local mirror compaction proof. This seq-less checkpoint is written in
       * the same atomic events.jsonl replacement that folds remote-origin
       * events, so a daemon restart can distinguish intentional compaction from
       * a deleted/corrupt local projection.
       */
      type: "remote_cursor_checkpoint";
      ts: number;
      throughRemoteSeq: number;
      node: string;
      remoteLaunchId: string;
      remoteIncarnation: string;
    }
  | { type: "turn_start"; ts: number; threadId?: string }
  | { type: "turn_end"; ts: number; threadId?: string }
  | { type: "text"; ts: number; text: string } // assistant output chunk (feeds ring buffer)
  | { type: "thought"; ts: number; text: string } // reasoning chunk (structured stream only; never rendered into ring text)
  | { type: "reasoning"; ts: number; text: string }
  | { type: "tool_use"; ts: number; tool: string; callId?: string; input?: unknown }
  | {
      type: "tool_update";
      ts: number;
      tool: string;
      callId?: string;
      status: "pending" | "running" | "completed" | "error";
      input?: unknown;
      output?: unknown;
      error?: string;
    }
  | {
      type: "usage";
      ts: number;
      /** Non-cached input tokens when cache fields are present. */
      inputTokens?: number;
      /** Non-reasoning output tokens when reasoningTokens is present. */
      outputTokens?: number;
      /** Provider-reported total, when supplied. */
      totalTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      cost?: number;
    }
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
  | { type: "auth_expired"; ts: number; detail?: string; requiresLogin?: boolean }
  // Legacy credential recovery marker emitted by builds before runner-host
  // epochs became authoritative. Current recovery relies on the successor's
  // pre-adapter `host_epoch`; retaining this variant keeps old logs readable.
  // Within a legacy epoch, an auth error AFTER the marker still re-wins.
  | {
      type: "auth_resume";
      ts: number;
      /** Recovery provenance for event-tail inspection; absent on legacy markers. */
      source?: "human-login" | "valid-disk-credentials" | "valid-vault-credentials" | "auto";
      /** Daemon incident attempt, intentionally metadata-only (never credentials). */
      attempt?: number;
      replayedPrompts?: number;
    }
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
  | { type: "exit"; ts: number; code: number | null; signal?: string }
) & {
  seq?: number;
  /**
   * Origin sequence when an event is durably projected from a remote runner.
   * The local mirror allocates its own `seq`; retaining this independent cursor
   * makes replay idempotent across a crash between local append and cursor-file
   * publication.
   */
  remoteSeq?: number;
  /** Exact non-authorizing runner-host epoch that produced this event. */
  host?: HsrAnswerHostIdentity;
};

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
  /** Vault account whose credentials were activated into this runner's home. */
  accountId?: string;
  /** Internal boot-probe hint: this CODEX_HOME was contended before admission. */
  codexBootContended?: boolean;
  /**
   * Provider-enforced filesystem mutation boundary. Execution-protocol Cells
   * set `cwd`: harness file tools and subprocesses may write only inside the
   * working copy while host reads and network access remain available.
   */
  filesystemWriteScope?: "cwd";
  /**
   * Whole-process-tree containment selected by the detached runner host after
   * its OS dependency probe succeeds. Provider adapters may safely suppress
   * their own narrower approval sandboxes only when this fact is present.
   */
  cellSandbox?: "macos-seatbelt" | "linux-bubblewrap";
  /**
   * Internal host admission hook. Every detached harness child invokes this
   * synchronously after the OS `spawn` event and before protocol readiness.
   * A rejection forces exact ChildProcess rollback and the adapter never
   * returns a live session.
   */
  onChildSpawn?: (identity: { pid: number; pgid: number }) => Promise<void>;
  /** Host-owned pre-spawn admission. `pending` must be durable before fork. */
  onChildSpawnPending?: () => Promise<void>;
  /** Host-owned proof that a failed OS spawn created no child. */
  onChildSpawnFailure?: () => Promise<void>;
  /** Internal host-owned event provenance; adapters must not source this. */
  eventHost?: HsrAnswerHostIdentity;
  /** Publish durable event-history doubt before a persistence error reaches the event iterator. */
  onEventPersistenceFailure?: (event: RunnerEvent, error: unknown) => Promise<void>;
};

/**
 * How a send should land relative to the live turn. "now" (default) delivers
 * immediately; "next-tool" means non-interrupting steering into the current
 * turn. Provider-native queues (Codex turn/steer, Claude streaming input) own
 * the exact safe boundary; other structured runners hold until tool_use or
 * turn_end. Idle sessions deliver immediately as a fresh turn.
 */
export type RunnerSendOpts = { mode?: "now" | "next-tool" };

/**
 * Result of requesting a turn interrupt. Interrupt is idempotent: callers must
 * be able to distinguish an idle no-op from a request that will produce a
 * future turn_end boundary.
 */
export type RunnerInterruptResult =
  | { status: "already_idle" }
  | { status: "interrupt_requested" };

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
  interrupt(): Promise<RunnerInterruptResult>;
  prepareAnswer(requestId: string, answer: RunnerInputAnswer): Promise<RunnerPreparedAnswer>;
  answer(requestId: string, answer: RunnerInputAnswer): Promise<void>; // respond to a needs_input
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
