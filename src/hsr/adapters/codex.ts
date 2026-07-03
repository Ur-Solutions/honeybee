/**
 * HSR codex tier-S (server) adapter (APIA-75).
 *
 * codex is tier "server": it speaks JSON-RPC 2.0 over a `codex app-server` child's
 * stdio, BIDIRECTIONALLY (the server also sends us requests, for approvals). It
 * does NOT use the stream runner — the transport is a request/response + inbound
 * server-request peer (codexRpc.ts), not a line→event stream. This file owns:
 *   - the codex protocol flow (initialize → thread/start → turn/start → notifications)
 *   - PURE mappers (exported for hermetic tests): notification→events,
 *     user-input encode, server-request→needs_input.
 *
 *   - the shared session plumbing (event queue + ring buffer + run-dir
 *     persistence + child teardown) comes from sessionBase.ts (HIVE-20)
 *
 * v1 scoping: ONE `codex app-server` child per BEE hosting ONE thread. sessionId
 * is the thread id learned from the thread/start response. yolo =
 * approvalPolicy:"never" + sandbox:"danger-full-access" ⇒ no approval prompts.
 *
 * Protocol field names are taken verbatim from the generated app-server bindings
 * (codex-cli 0.142.5): ThreadStartResponse.thread.id, UserInput{type:"text",text,
 * text_elements}, TurnCompletedNotification{threadId,turn}, AgentMessageDelta
 * {delta}, ErrorNotification{error:{message}}, ThreadTokenUsage{last:{...}}.
 *
 * Node builtins only.
 */

import type { RunnerAdapter, RunnerEvent, RunnerOpts, RunnerSession, RunnerTier } from "../types.js";
import { harnessAllowance } from "../harness.js";
import { attachSessionPlumbing, spawnSessionChild } from "../sessionBase.js";
import { createCodexRpcPeer, CODEX_RPC_METHOD_NOT_FOUND, type CodexRpcPeer } from "./codexRpc.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// --- PURE MAPPERS (exported for hermetic tests) ------------------------------

/**
 * Map one codex app-server NOTIFICATION (method + params) to zero or more
 * RunnerEvents. Reasoning deltas and everything unmodeled map to []. ts is
 * stamped by the ingest path, not here.
 *
 * Modeled methods (ServerNotification union, exact names):
 *   turn/started                → [turn_start]
 *   item/agentMessage/delta     → [text]                       (params.delta)
 *   turn/completed              → [turn_end] (+ [usage] if params carries tokens)
 *   thread/tokenUsage/updated   → [usage]                      (params.tokenUsage.last)
 *   account/rateLimits/updated  → [exhausted] when a limit is REACHED (else [])
 *   error                       → [error]                      (params.error.message)
 */
export function codexNotificationToEvents(method: string, params: unknown): RunnerEvent[] {
  const p = asObject(params) ?? {};
  const now = 0; // stamped downstream
  switch (method) {
    case "turn/started":
      return [{ type: "turn_start", ts: now }];
    case "item/agentMessage/delta": {
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (delta.length === 0) return [];
      return [{ type: "text", ts: now, text: delta }];
    }
    case "turn/completed": {
      const events: RunnerEvent[] = [{ type: "turn_end", ts: now }];
      // Defensive: the base TurnCompletedNotification body is {threadId, turn}
      // and carries no tokens, but honor a token breakdown if a variant supplies
      // one on `usage` (TokenUsageBreakdown-shaped) or `tokenUsage` (ThreadTokenUsage).
      const usage = usageFromBreakdown(p.usage) ?? usageFromThreadTokenUsage(p.tokenUsage);
      if (usage) events.push(usage);
      return events;
    }
    case "thread/tokenUsage/updated": {
      const usage = usageFromThreadTokenUsage(p.tokenUsage);
      return usage ? [usage] : [];
    }
    case "account/rateLimits/updated":
      return rateLimitsToEvents(p.rateLimits);
    case "error": {
      const err = asObject(p.error);
      const message = String(err?.message ?? p.message ?? "codex error");
      return [{ type: "error", ts: now, message }];
    }
    default:
      // item/reasoning/*, item/started, item/completed, thread/*, warnings, … are
      // intentionally dropped from the v1 event/ring stream.
      return [];
  }
}

/**
 * Map a codex `AccountRateLimitsUpdatedNotification.rateLimits` (a
 * `RateLimitSnapshot`) to zero or one `exhausted` event. Exact bindings
 * (codex app-server v2):
 *   RateLimitSnapshot { limitId, limitName, primary: RateLimitWindow|null,
 *     secondary: RateLimitWindow|null, credits, individualLimit, planType,
 *     rateLimitReachedType: RateLimitReachedType|null }
 *   RateLimitWindow  { usedPercent, windowDurationMins, resetsAt: number|null }
 *   RateLimitReachedType = "rate_limit_reached" | "workspace_owner_credits_depleted"
 *     | "workspace_member_credits_depleted" | "workspace_owner_usage_limit_reached"
 *     | "workspace_member_usage_limit_reached"
 *
 * `rateLimitReachedType` is the authoritative gate: a NON-null value means a
 * limit has actually been reached / credits depleted ⇒ exhausted. A rolling
 * update with `rateLimitReachedType: null` (the common case) is benign ⇒ [].
 * The reset hint comes from the primary window's `resetsAt` (UNIX seconds),
 * falling back to the secondary window.
 *
 * NOTE (unverified): codex may also surface a per-turn rate-limit as an `error`
 * notification, but the generated bindings give `ErrorNotification` only a
 * `{error:{message}}` shape with no typed rate-limit discriminator, so we cannot
 * reliably distinguish a rate-limit error from any other error here. Those keep
 * mapping to `error` (unchanged); the snapshot notification is the safe subset.
 */
function rateLimitsToEvents(rateLimits: unknown): RunnerEvent[] {
  const snapshot = asObject(rateLimits);
  if (!snapshot) return [];
  const reached = snapshot.rateLimitReachedType;
  // null / absent ⇒ benign rolling update. Only a non-null reached-type exhausts.
  if (reached === null || reached === undefined) return [];
  const resetHint =
    resetHintFromWindow(snapshot.primary) ?? resetHintFromWindow(snapshot.secondary);
  return [{ type: "exhausted", ts: 0, ...(resetHint ? { resetHint } : {}) }];
}

/** ISO reset hint from a RateLimitWindow.resetsAt (UNIX seconds), or undefined. */
function resetHintFromWindow(value: unknown): string | undefined {
  const window = asObject(value);
  const seconds = toNumber(window?.resetsAt);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** Build a usage event from a TokenUsageBreakdown-shaped object, or undefined. */
function usageFromBreakdown(value: unknown): (RunnerEvent & { type: "usage" }) | undefined {
  const b = asObject(value);
  if (!b) return undefined;
  const inputTokens = toNumber(b.inputTokens);
  const outputTokens = toNumber(b.outputTokens);
  const totalTokens = toNumber(b.totalTokens)
    ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { type: "usage", ts: 0, inputTokens, outputTokens, totalTokens };
}

/** Build a usage event from a ThreadTokenUsage {last: TokenUsageBreakdown}, or undefined. */
function usageFromThreadTokenUsage(value: unknown): (RunnerEvent & { type: "usage" }) | undefined {
  const tu = asObject(value);
  if (!tu) return undefined;
  return usageFromBreakdown(tu.last);
}

/** Encode one user turn as a codex UserInput "text" variant (TurnStartParams.input[0]). */
export function encodeCodexUserInput(text: string): unknown {
  return { type: "text", text, text_elements: [] };
}

// The server-request (child→us) methods that are approval/input prompts.
const CODEX_APPROVAL_METHODS = new Set<string>([
  "item/permissions/requestApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "execCommandApproval", // legacy
  "applyPatchApproval", // legacy
]);

/**
 * Map one inbound SERVER REQUEST (approval/input) to a needs_input event, or
 * null for a server-request method we don't model (the caller respondErrors it).
 * The JSON-RPC id becomes requestId (as a string) so answer() can respond to it.
 */
export function codexServerRequestToNeedsInput(
  method: string,
  id: string | number,
  params: unknown,
): RunnerEvent | null {
  if (!CODEX_APPROVAL_METHODS.has(method)) return null;
  const p = asObject(params) ?? {};
  const reason = typeof p.reason === "string" && p.reason.length > 0 ? p.reason : undefined;
  const command = typeof p.command === "string" ? p.command : undefined;
  const question = reason ?? command ?? `codex requests approval: ${method}`;
  return {
    type: "needs_input",
    ts: 0,
    kind: "permission",
    question,
    tool: method,
    input: params,
    requestId: String(id),
  };
}

/**
 * Build the JSON-RPC RESPONSE body for an approval server-request, given the
 * method it answers and whether the user approved. Each server-request method
 * has its own response shape (from the generated *Response bindings):
 *   execCommandApproval / applyPatchApproval → { decision: ReviewDecision }        ("approved"|"denied")
 *   item/commandExecution/requestApproval    → { decision: CommandExecutionApprovalDecision } ("accept"|"decline")
 *   item/fileChange/requestApproval          → { decision: FileChangeApprovalDecision }       ("accept"|"decline")
 *   item/permissions/requestApproval         → { permissions: {}, scope: "turn" }  (grant-based; no decision field)
 *   item/tool/requestUserInput               → { answers: {} }                     (structural; can't map yes/no)
 * With approvalPolicy "never" these never fire — this is a best-effort fallback.
 */
export function encodeCodexApprovalResponse(method: string, approved: boolean): unknown {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: approved ? "approved" : "denied" };
    case "item/commandExecution/requestApproval":
      return { decision: approved ? "accept" : "decline" };
    case "item/fileChange/requestApproval":
      return { decision: approved ? "accept" : "decline" };
    case "item/permissions/requestApproval":
      // GrantedPermissionProfile is grant-based; a denial grants nothing. We can't
      // synthesize a broad grant here, so both paths send the minimal (empty) grant.
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    default:
      return { decision: approved ? "approved" : "denied" };
  }
}

/** Normalize a free-text answer to an approve/deny boolean. */
function isApproval(answer: string): boolean {
  return /^\s*(y|yes|approve|approved|accept|allow|ok|true)\b/i.test(answer);
}

// --- adapter -----------------------------------------------------------------

/** codex app-server flags: fixed subcommand; caller argv is ignored for tier "server". */
const CODEX_APP_SERVER_ARGS = ["app-server"];

/**
 * Build the codex spawn command/args + scrubbed env WITHOUT spawning. Pure —
 * exported so tests can exercise argv/env policy in isolation.
 */
export function buildCodexSpawn(opts: RunnerOpts): { command: string; args: string[]; env: Record<string, string> } {
  const command = opts.command ?? "codex";
  const authKind = opts.authKind ?? "subscription";
  const env: Record<string, string> = { ...opts.env };
  for (const key of harnessAllowance("codex", authKind)?.scrubEnv ?? []) delete env[key];
  return { command, args: [...CODEX_APP_SERVER_ARGS], env };
}

export async function startCodexRunner(opts: RunnerOpts): Promise<RunnerSession> {
  const bee = opts.bee;
  const { command, args, env } = buildCodexSpawn(opts);

  const child = await spawnSessionChild(command, args, { cwd: opts.cwd, env });

  // --- codex rpc peer over the child stdio ------------------------------------
  const peer: CodexRpcPeer = createCodexRpcPeer(child.stdin!, child.stdout!);

  // Shared event queue / ring buffer / ingest / exit teardown / group stop
  // (sessionBase.ts). The peer is disposed FIRST in the exit handler so
  // in-flight requests reject before the exit event lands.
  const { events, ingestEvent, snapshot, hasExited, stop } = attachSessionPlumbing(bee, child, {
    onChildExit: () => peer.dispose(new Error("codex app-server exited")),
  });

  // Track the live thread + turn ids so interrupt/turn-start carry them.
  let threadId = "";
  let currentTurnId = "";
  const requestMethods = new Map<string, string>(); // needs_input requestId → server method

  const rememberTurnId = (params: unknown): void => {
    const p = asObject(params);
    if (!p) return;
    const turn = asObject(p.turn);
    if (turn && typeof turn.id === "string") currentTurnId = turn.id;
    else if (typeof p.turnId === "string") currentTurnId = p.turnId;
  };

  peer.onNotificationCatchAll((method, params) => {
    rememberTurnId(params);
    for (const ev of codexNotificationToEvents(method, params)) ingestEvent(ev);
  });

  peer.onServerRequest((method, id, params) => {
    const ev = codexServerRequestToNeedsInput(method, id, params);
    if (!ev) {
      // A server request we don't model — don't leave the server hanging.
      peer.respondError(id, CODEX_RPC_METHOD_NOT_FOUND, `unsupported server request: ${method}`);
      return;
    }
    if (ev.type === "needs_input" && ev.requestId) requestMethods.set(ev.requestId, method);
    ingestEvent(ev);
  });

  const session: RunnerSession = {
    sessionId: opts.sessionId ?? "",
    tier: "server",
    pid: child.pid as number,
    send,
    interrupt,
    answer,
    events,
    snapshot,
    stop,
  };

  // --- protocol handshake: initialize → thread/start (or resume) --------------
  await peer.request("initialize", {
    clientInfo: { name: "hive-hsr", title: null, version: "0" },
    capabilities: null,
  });

  if (opts.resume && opts.sessionId) {
    const res = await peer.request("thread/resume", {
      threadId: opts.sessionId,
      ...(opts.model ? { model: opts.model } : {}),
      cwd: opts.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    threadId = threadIdFromResponse(res) ?? opts.sessionId;
  } else {
    const res = await peer.request("thread/start", {
      ...(opts.model ? { model: opts.model } : {}),
      cwd: opts.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    threadId = threadIdFromResponse(res) ?? "";
  }
  if (threadId.length > 0) session.sessionId = threadId;

  async function send(text: string): Promise<void> {
    if (hasExited()) throw new Error("hsr codex: app-server has exited (session ended?)");
    if (!threadId) throw new Error("hsr codex: no thread id (thread/start did not complete)");
    // Fire the turn; turn_start/turn_end come from turn/started / turn/completed
    // notifications, so we don't block send() on the turn's completion.
    void peer
      .request("turn/start", { threadId, input: [encodeCodexUserInput(text)] })
      .catch((error: unknown) => {
        ingestEvent({ type: "error", ts: Date.now(), message: `turn/start failed: ${String(error)}` });
      });
  }

  async function answer(requestId: string, answerText: string): Promise<void> {
    const method = requestMethods.get(requestId);
    if (!method) throw new Error(`hsr codex: no pending approval for requestId ${requestId}`);
    requestMethods.delete(requestId);
    const id: string | number = /^\d+$/.test(requestId) ? Number(requestId) : requestId;
    peer.respond(id, encodeCodexApprovalResponse(method, isApproval(answerText)));
  }

  async function interrupt(): Promise<void> {
    if (hasExited() || !threadId) return;
    await peer
      .request("turn/interrupt", { threadId, turnId: currentTurnId })
      .catch(() => undefined);
  }

  return session;
}

/** Pull the thread id out of a thread/start (or thread/resume) response: `thread.id`. */
function threadIdFromResponse(res: unknown): string | undefined {
  const obj = asObject(res);
  const thread = asObject(obj?.thread);
  if (thread && typeof thread.id === "string" && thread.id.length > 0) return thread.id;
  return undefined;
}

export const codexAdapter: RunnerAdapter = {
  harness: "codex",
  tier(): RunnerTier {
    return "server";
  },
  start(opts: RunnerOpts): Promise<RunnerSession> {
    return startCodexRunner(opts);
  },
};
