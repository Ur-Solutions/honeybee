/**
 * Harness adapters — the normalization layer (WP3, spec 03).
 *
 * One adapter per agent CLI. Pure translation: raw native event-stream lines
 * in, normalized signals out. No state, no I/O, no timers. The contract calls
 * this "the most important machinery in the system" (§4.1): heterogeneous
 * harness events become exactly booted / turn_started / turn_ended (exited is
 * a process fact the driver observes itself), plus condition-flag *evidence*.
 *
 * Q1 resolution (operator): the session log is the verbatim native jsonl
 * stream only. Adapters ARE the normalization — observations are always
 * re-derivable by replaying the log through `parseLine`.
 *
 * Flag evidence (spec 03, resolving WP2 ambiguity 6): adapters only *report*
 * evidence; the daemon acts on it. Every flag-setter has a contrary-evidence
 * clearer in the same adapter:
 *   - `booted` clears `spawn_failed` (the runtime demonstrably came up),
 *   - a successful (non-error) turn end clears `auth_needed` — the turn was
 *     authenticated — and `resource_blocked` — the provider served it,
 *   - a provider "allowed again" rate-limit update clears `resource_blocked`.
 * No flag is permanent short of operator action.
 */

/** Flags an adapter can produce evidence for (subset of the core closed list). */
export type AdapterFlag = "auth_needed" | "resource_blocked" | "spawn_failed";

export type AdapterSignal =
  /**
   * The CLI signaled readiness. `sessionId` is the provider session/thread id
   * when the stream carries one (claude system/init, codex thread/start).
   *
   * Normalization note: the four-state model defines `booted` as "live and
   * working its initial turn" (running). A harness that boots straight to
   * ready-for-input has an empty initial turn — its adapter emits `booted`
   * immediately followed by `turn_ended`, landing the store on `idle`.
   */
  | { kind: "booted"; sessionId?: string }
  /**
   * `turnId`: the harness-native turn id when the stream carries one (codex
   * turn/started) — needed to interrupt it. `threadId` scopes lifecycle from
   * multiplexed harnesses: codex app-server also reports native subagent
   * threads on the root bee's stream.
   */
  | { kind: "turn_started"; turnId?: string; threadId?: string }
  | { kind: "turn_ended"; threadId?: string }
  /**
   * Application-level acknowledgement for a delivered mailbox message.
   * RPC harnesses emit this only after the provider accepted the request;
   * the driver keeps the durable mailbox row pending until then.
   */
  | { kind: "delivery_confirmed"; messageId: number }
  /** The RPC request was rejected and may be retried at a later accept point. */
  | { kind: "delivery_refused"; messageId: number }
  /** Condition-flag evidence. The adapter reports; the daemon decides. */
  | {
      kind: "flag";
      flag: AdapterFlag;
      action: "set" | "clear";
      detail: string;
      /** Provider-declared instant (epoch ms) the condition lifts, when the provider states one. */
      resetsAt?: number;
    }
  /**
   * Protocol lines the driver must write back to the runtime's stdin (e.g. the
   * codex JSON-RPC handshake continuation). Derived purely from the input line.
   */
  | { kind: "respond"; lines: string[] };

/** Context the driver supplies when encoding a delivered mailbox message. */
export interface EncodeContext {
  /** Provider session/thread id learned from the `booted` signal, if any. */
  sessionId: string | null;
  /** The mailbox message id being delivered (stable across retries). */
  messageId: number;
  /** Whether the driver is currently inside a real or synthetic turn. */
  turnActive: boolean;
  /** Harness-native id of that active turn, when the protocol reports one. */
  turnId: string | null;
}

/** Context the driver supplies when encoding a turn interrupt (v6 `bee.interrupt`). */
export interface InterruptContext {
  sessionId: string | null;
  /** The harness-native id of the turn in flight, when the stream reported one (codex). */
  turnId: string | null;
}

export interface HarnessAdapter {
  readonly harness: string;
  /**
   * Whether the runtime accepts additional input mid-turn (claude queues
   * stream-json user messages natively; codex turn/start would collide with
   * the active turn). When false the driver refuses mid-turn deliveries with
   * `not_ready` and the daemon's delivery loop retries — same shape as the Q2
   * booting refusal.
   */
  readonly acceptsMidTurn: boolean;
  /**
   * Whether a mid-turn delivery cannot be encoded until the active native
   * turn id is known. The HSR driver uses this to recover the id from the
   * durable observation journal when adopting a surviving runtime.
   */
  readonly midTurnMessageNeedsTurnId?: boolean;
  /**
   * Whether writing the encoded line is only a request, not yet the harness
   * accept point. Such adapters emit delivery_confirmed/refused from the
   * corresponding protocol response; the mailbox is marked delivered only
   * after confirmation.
   */
  readonly confirmsDelivery?: boolean;
  /**
   * Whether the runtime is deliverable the moment it is spawned. claude's
   * stream-json mode emits NOTHING (not even init) until the first user
   * message arrives on stdin — waiting for a booted line deadlocks (found by
   * the WP3 manual smoke). readyAtSpawn adapters get a synthetic booted
   * observation at spawn — followed by a synthetic turn_ended when nothing
   * has been injected yet, so the store lands on idle like the driver's own
   * phase — and start in the idle phase; stdin buffering makes early
   * delivery safe.
   */
  readonly readyAtSpawn: boolean;
  /** Lines to write to the runtime's stdin immediately after spawn. */
  bootLines(): string[];
  /** Pure, stateless: one raw native stream line → zero or more signals. */
  parseLine(line: string): AdapterSignal[];
  /**
   * Encode one delivered message for the runtime's stdin protocol. Returns
   * null when encoding is impossible yet (e.g. codex before its thread id is
   * known) — the driver refuses `not_ready` and the daemon retries.
   */
  encodeMessage(body: string, ctx: EncodeContext): string | null;
  /**
   * Harness-native resume (spec 07 §F): extra CLI args that make a NEW process
   * continue the conversation identified by `providerSessionId` (claude:
   * `--resume <id>`). Absent when the harness resumes through its protocol
   * instead of argv (codex: `thread/resume` in the handshake — see
   * `codexAdapter({ resumeThreadId })`) or has no resume mechanism at all
   * (the runtime restarts fresh on the same session log).
   */
  resumeArgs?(providerSessionId: string): string[];
  /**
   * v6 fork (`bee.fork`): extra CLI args that make a NEW process continue the
   * conversation identified by `sourceSessionId` under a NEW session of its
   * own (claude: `--resume <id> --fork-session` — plain `--resume` would keep
   * the SAME id and make source and fork share one transcript). Absent when
   * the harness forks through its protocol (codex `thread/fork` — see
   * `codexAdapter({ forkThreadId })`) or cannot fork (the fork boots fresh;
   * provenance is still recorded).
   */
  forkArgs?(sourceSessionId: string): string[];
  /**
   * v6 interrupt: encode an in-band "stop the current turn" line for the
   * runtime's stdin (claude `control_request {subtype:"interrupt"}`, codex
   * `turn/interrupt`). Returns null when it cannot be encoded yet (codex
   * before the turn id is known). Absent = the harness has no in-band
   * interrupt (the driver answers `unsupported`; SIGINT would kill a headless
   * child outright, so it is never used as a fallback).
   */
  encodeInterrupt?(ctx: InterruptContext): string | null;
}

// ---------------------------------------------------------------------------
// Shared helpers (pure)
// ---------------------------------------------------------------------------

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/**
 * Login-required auth-failure classifier, shared by the adapters. Signatures
 * distilled from the previous system's observed provider messages (claude
 * "Not logged in · /login", codex "Failed to refresh token … empty_string" /
 * 401-unauthorized, OAuth expiry variants). The daemon maps this evidence to
 * the `auth_needed` flag (contract §4.2 — provider boundary).
 */
export function isAuthNeededMessage(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("not logged in")) return true;
  if (m.includes("please log out and sign in again")) return true;
  if (m.includes("please sign out and sign in again")) return true;
  if (m.includes("access token") && m.includes("refresh")) return true;
  if (m.includes("failed to refresh token")) return true;
  if (m.includes("refresh_token") || m.includes("refresh token")) return true;
  if ((m.includes("token") || m.includes("oauth")) && m.includes("revoked")) return true;
  if (m.includes("401") && (m.includes("oauth") || m.includes("unauthor") || m.includes("authentication"))) return true;
  if (m.includes("unauthorized")) return true;
  if (m.startsWith("failed to authenticate")) return true;
  return (
    (m.includes("oauth") || m.includes("session")) &&
    m.includes("expired") &&
    m.includes("refreshed")
  );
}

/**
 * Rate-limit / provider-backpressure classifier for free-text error messages
 * (contract §4.2 `resource_blocked` — machine/provider boundary). Structured
 * rate-limit notifications are handled per-adapter; this catches the message
 * shapes providers put into generic error/result lines.
 */
export function isResourceBlockedMessage(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("429")) return true;
  if (m.includes("rate limit") || m.includes("rate-limit") || m.includes("rate_limit")) return true;
  if (m.includes("overloaded")) return true;
  if (m.includes("quota") && (m.includes("exceeded") || m.includes("exhausted"))) return true;
  return false;
}

/** Convert a UNIX-seconds epoch to an ISO hint, or undefined if unusable. */
/** Provider `resetsAt` (unix seconds) → epoch ms, or undefined when absent/invalid. */
export function epochMsFromSeconds(value: unknown): number | undefined {
  const seconds = toNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}

export function isoFromEpochSeconds(value: unknown): string | undefined {
  const seconds = toNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** The clears every successful (authenticated, provider-served) turn implies. */
export function successfulTurnClears(): AdapterSignal[] {
  return [
    { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
  ];
}

/** The signals a ready-without-initial-turn boot normalizes to. */
export function bootedToIdle(sessionId?: string): AdapterSignal[] {
  return [
    sessionId === undefined ? { kind: "booted" } : { kind: "booted", sessionId },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ];
}
