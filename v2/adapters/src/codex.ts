/**
 * Codex harness adapter (WP3) — normalizes the `codex app-server` JSON-RPC 2.0
 * stdio stream.
 *
 * Format derived by reading the previous system's adapter
 * (src/hsr/adapters/codex.ts + codexRpc.ts, protocol names taken there
 * verbatim from the generated app-server bindings, codex-cli 0.142.5). No old
 * code is imported; re-verify against a real app-server in the manual smoke.
 *
 * Unlike claude, codex is a bidirectional RPC peer, but every message is still
 * one JSON line on stdout/stdin — so it fits the driver's line-stream model
 * with the handshake expressed as pure `respond` signals:
 *
 *   we write : {"jsonrpc":"2.0","id":1,"method":"initialize",...}   (bootLines)
 *   server   : {"jsonrpc":"2.0","id":1,"result":{...}}              → respond:
 *   we write :   {"jsonrpc":"2.0","method":"initialized"} +
 *                {"jsonrpc":"2.0","id":2,"method":"thread/start",
 *                 params:{cwd,approvalPolicy:"never",sandbox:"danger-full-access"[,model]}}
 *   server   : {"jsonrpc":"2.0","id":2,"result":{"thread":{"id":...}}} → booted
 *   server   : {"method":"turn/started",...}                        → turn_started
 *   server   : {"method":"turn/completed",...}                      → turn_ended
 *   server   : {"method":"error","params":{"error":{"message"}}}    → flag evidence
 *   server   : {"method":"account/rateLimits/updated",
 *               "params":{"rateLimits":{rateLimitReachedType,...}}} → resource_blocked
 *
 * Known sharp edge (old code, codex-cli 0.144.x): the app-server acks
 * `initialize` before it can service `thread/start`; a premature thread
 * request can be silently dropped, wedging the connection. WP3 keeps the
 * simple ack-ordered handshake (thread/start is only sent after the
 * initialize RESPONSE arrives, which is later than the old code's failing
 * pipeline) and leaves boot-timeout recovery to the daemon's hang policy —
 * a wedged boot is stopped and retried. Flagged for the manual smoke.
 *
 * The adapter is a factory: thread/start needs cwd (and optionally model),
 * which is per-bee configuration, not state. The returned object is still
 * pure/stateless — signals derive only from the input line.
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

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
/** v6 `turn/interrupt` request id (one interrupt in flight per turn; the ack response parses to []). */
const TURN_INTERRUPT_ID = 3;
/** Delivered-message request ids: offset by the mailbox message id (globally unique). */
const TURN_REQUEST_ID_BASE = 1000;

export interface CodexAdapterOptions {
  cwd: string;
  model?: string;
  /**
   * Harness-native resume (spec 07 §F): when set, the handshake sends
   * `thread/resume {threadId}` instead of `thread/start`, rejoining the
   * recorded conversation (codex has no interactive/headless store split —
   * `codex resume <threadId>` and app-server `thread/resume` share rollouts).
   * The response carries the same `thread.id`, which lands as `booted`. The
   * process must run with the CODEX_HOME the rollout lives under (bee env).
   */
  resumeThreadId?: string;
  /**
   * v6 fork (`bee.fork`): when set (and no resumeThreadId), the handshake
   * sends `thread/fork {threadId}` — the app-server copies the source rollout
   * into a NEW thread (present in codex-cli ≥ 0.147: `thread/fork` /
   * ThreadForkParams / ThreadForkResponse{thread}) — and the response's
   * `thread.id` (the NEW id) lands as `booted`, so the daemon records the
   * fork's own thread id. Plain `thread/resume` of the source id would make
   * source and fork share one thread. An app-server without `thread/fork`
   * answers method-not-found: no booted; the daemon's boot-hang policy
   * stops it and the spawn budget makes the failure visible.
   */
  forkThreadId?: string;
}

/**
 * `AccountRateLimitsUpdatedNotification.rateLimits` (a RateLimitSnapshot):
 * `rateLimitReachedType` non-null is the authoritative exhausted gate; null is
 * a benign rolling update (old bindings, codex app-server v2). The reset hint
 * comes from the primary window's `resetsAt` (unix seconds), falling back to
 * secondary.
 */
export function codexRateLimitSignals(rateLimits: unknown): AdapterSignal[] {
  const snapshot = asObject(rateLimits);
  if (!snapshot) return [];
  const reached = snapshot.rateLimitReachedType;
  if (reached === null || reached === undefined) return [];
  const reset =
    isoFromEpochSeconds(asObject(snapshot.primary)?.resetsAt) ??
    isoFromEpochSeconds(asObject(snapshot.secondary)?.resetsAt);
  return [{
    kind: "flag",
    flag: "resource_blocked",
    action: "set",
    detail: `codex rate limit reached (${String(reached)})${reset ? `, resets ${reset}` : ""}`,
  }];
}

function errorSignals(message: string): AdapterSignal[] {
  if (isAuthNeededMessage(message)) {
    return [{ kind: "flag", flag: "auth_needed", action: "set", detail: message.slice(0, 500) }];
  }
  if (isResourceBlockedMessage(message)) {
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) }];
  }
  return [];
}

// Server→client request methods that expect a response; with
// approvalPolicy:"never" these should not fire, but a hanging server request
// wedges the peer, so refuse them explicitly (JSON-RPC method-not-found).
const SERVER_REQUEST_REFUSAL_CODE = -32601;

/** The thread request params (shape taken from the old adapter's buildCodexThreadRequestParams). */
export function codexThreadRequest(opts: CodexAdapterOptions): { method: "thread/start" | "thread/resume" | "thread/fork"; params: Record<string, unknown> } {
  const base = {
    ...(opts.model ? { model: opts.model } : {}),
    cwd: opts.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
  if (opts.resumeThreadId) return { method: "thread/resume", params: { threadId: opts.resumeThreadId, ...base } };
  if (opts.forkThreadId) return { method: "thread/fork", params: { threadId: opts.forkThreadId, ...base } };
  return { method: "thread/start", params: base };
}

export function codexAdapter(opts: CodexAdapterOptions): HarnessAdapter {
  const threadRequest = codexThreadRequest(opts);
  const threadStartLine = JSON.stringify({
    jsonrpc: "2.0",
    id: THREAD_START_ID,
    method: threadRequest.method,
    params: threadRequest.params,
  });

  function parseLine(line: string): AdapterSignal[] {
    const msg = parseJsonLine(line);
    if (!msg) return [];

    // A `method` marks a notification or a server→client request; a message
    // without one is a response to something we sent. Classify method-bearing
    // messages first so a server request can never be misread as our response.
    if (typeof msg.method === "string") return methodSignals(msg);

    // --- responses to our requests -------------------------------------
    if (msg.id === INITIALIZE_ID && "result" in msg) {
      return [{
        kind: "respond",
        lines: [JSON.stringify({ jsonrpc: "2.0", method: "initialized" }), threadStartLine],
      }];
    }
    if (msg.id === THREAD_START_ID) {
      const threadId = asObject(asObject(msg.result)?.thread)?.id;
      if (typeof threadId === "string" && threadId.length > 0) {
        // codex boots to ready-for-input: booted lands on idle (types.ts).
        return bootedToIdle(threadId);
      }
      if ("result" in msg && opts.resumeThreadId) {
        // thread/resume acknowledged without echoing the thread: the old
        // adapter fell back to the requested id (threadIdFromResponse ?? sessionId).
        return bootedToIdle(opts.resumeThreadId);
      }
      const err = asObject(msg.error);
      if (err) return errorSignals(String(err.message ?? `codex ${threadRequest.method} failed`));
      return [];
    }
    // A turn/start request error response (our TURN_REQUEST_ID_BASE+messageId
    // ids): surface flag evidence; turn-state recovery is the daemon's job.
    if (typeof msg.id === "number" && msg.id >= TURN_REQUEST_ID_BASE && "error" in msg) {
      const err = asObject(msg.error);
      return errorSignals(String(err?.message ?? "codex turn/start failed"));
    }
    return [];
  }

  function methodSignals(msg: Record<string, unknown>): AdapterSignal[] {
    const params = asObject(msg.params) ?? {};

    // A server REQUEST (has an id): refuse rather than leave the peer hanging.
    if (msg.id !== undefined && msg.id !== null) {
      return [{
        kind: "respond",
        lines: [JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: SERVER_REQUEST_REFUSAL_CODE, message: `unsupported server request: ${String(msg.method)}` },
        })],
      }];
    }

    switch (msg.method) {
      case "turn/started": {
        // `turn.id` is what turn/interrupt needs (v6 bee.interrupt).
        const turnId = asObject(params.turn)?.id;
        return [typeof turnId === "string" && turnId.length > 0 ? { kind: "turn_started", turnId } : { kind: "turn_started" }];
      }
      case "turn/completed":
        return [...successfulTurnClears(), { kind: "turn_ended" }];
      case "error": {
        const err = asObject(params.error);
        return errorSignals(String(err?.message ?? params.message ?? "codex error"));
      }
      case "account/rateLimits/updated":
        return codexRateLimitSignals(params.rateLimits);
      default:
        // item/agentMessage/delta, item/reasoning/*, thread/tokenUsage/updated,
        // … — mid-turn activity/usage, no state edge in the four-state model.
        return [];
    }
  }

  return {
    harness: "codex",
    // turn/start while a turn is active collides with it (steering is a
    // different RPC, out of WP3 scope) — the driver refuses mid-turn and the
    // daemon retries at the next idle.
    acceptsMidTurn: false,
    readyAtSpawn: false,
    bootLines(): string[] {
      return [JSON.stringify({
        jsonrpc: "2.0",
        id: INITIALIZE_ID,
        method: "initialize",
        params: { clientInfo: { name: "hive-hsr", title: null, version: "0" }, capabilities: null },
      })];
    },
    parseLine,
    encodeMessage(body: string, ctx: EncodeContext): string | null {
      if (!ctx.sessionId) return null; // thread id not learned yet → not_ready
      return JSON.stringify({
        jsonrpc: "2.0",
        id: TURN_REQUEST_ID_BASE + ctx.messageId,
        method: "turn/start",
        params: { threadId: ctx.sessionId, input: [{ type: "text", text: body, text_elements: [] }] },
      });
    },
    // v6 interrupt: `turn/interrupt {threadId, turnId}` (the OLD adapter's
    // verified call, src/hsr/adapters/codex.ts). Needs the turn id from
    // turn/started; before that there is nothing to interrupt yet.
    encodeInterrupt(ctx: InterruptContext): string | null {
      if (!ctx.sessionId || !ctx.turnId) return null;
      return JSON.stringify({
        jsonrpc: "2.0",
        id: TURN_INTERRUPT_ID,
        method: "turn/interrupt",
        params: { threadId: ctx.sessionId, turnId: ctx.turnId },
      });
    },
  };
}
