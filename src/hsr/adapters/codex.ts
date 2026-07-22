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

import type { ChildProcess } from "node:child_process";
import type { RunnerAdapter, RunnerEvent, RunnerInputAnswer, RunnerInputQuestion, RunnerInterruptResult, RunnerOpts, RunnerSession, RunnerTier } from "../types.js";
import { harnessAllowance } from "../harness.js";
import { attachSessionPlumbing, spawnSessionChild, stopChildGroup } from "../sessionBase.js";
import {
  createCodexRpcPeer,
  CODEX_RPC_METHOD_NOT_FOUND,
  CodexRpcRequestTimeoutError,
  type CodexRpcPeer,
} from "./codexRpc.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function notificationThreadId(params: Record<string, unknown>): string | undefined {
  return stringField(params.threadId) ?? stringField(params.thread_id);
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
      return [{ type: "turn_start", ts: now, ...(notificationThreadId(p) ? { threadId: notificationThreadId(p) } : {}) }];
    case "item/agentMessage/delta": {
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (delta.length === 0) return [];
      return [{ type: "text", ts: now, text: delta }];
    }
    case "turn/completed": {
      const threadId = notificationThreadId(p);
      const events: RunnerEvent[] = [{ type: "turn_end", ts: now, ...(threadId ? { threadId } : {}) }];
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
      // An access-token-only remote codex whose token expired cannot self-refresh
      // (blanked refresh_token) — classify that failure into `auth_expired` so the
      // daemon mints + re-delivers a fresh token; everything else stays `error`.
      if (isCodexAuthExpiryError(message)) return [{ type: "auth_expired", ts: now }];
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

/**
 * Classify a codex error/turn-failure MESSAGE as an access-token expiry that the
 * harness cannot recover from on its own (UNIT 2). A remote codex bee runs on an
 * access-token-only credential with a BLANKED refresh token (remoteCreds.ts), so
 * once the access token dies codex CANNOT refresh — it emits one of:
 *   - "Failed to refresh token: 400 Bad Request: Invalid 'refresh_token': empty
 *     string … \"code\":\"empty_string\"" (confirmed on codex-cli 0.142.5), or
 *   - an initial 401 unauthorized (a token already dead at boot).
 * Match those (and the bare refresh_token / unauthorized signatures) so the
 * daemon's backstop mints + re-delivers a fresh token. Pure + exported for tests.
 */
export function isCodexAuthExpiryError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("failed to refresh token")) return true;
  if (m.includes("empty_string")) return true;
  if (m.includes("refresh_token") || m.includes("refresh token")) return true;
  if (m.includes("401") && m.includes("unauthor")) return true;
  if (m.includes("unauthorized")) return true;
  return false;
}

/** Encode one user turn as a codex UserInput "text" variant (TurnStartParams.input[0]). */
export function encodeCodexUserInput(text: string): unknown {
  return { type: "text", text, text_elements: [] };
}

export type CodexTurnLifecycle = {
  active: boolean;
  turnId: string;
};

/** Keep the interrupt target scoped to the currently-live root turn only. */
export function codexTurnLifecycleAfterNotification(
  current: CodexTurnLifecycle,
  method: string,
  params: unknown,
): CodexTurnLifecycle {
  if (method === "turn/completed") return { active: false, turnId: "" };
  if (method !== "turn/started") return current;
  const p = asObject(params);
  const turn = asObject(p?.turn);
  const turnId =
    turn && typeof turn.id === "string"
      ? turn.id
      : typeof p?.turnId === "string"
        ? p.turnId
        : "";
  return { active: true, turnId };
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
  if (method === "item/tool/requestUserInput") {
    const questions = codexInputQuestions(params);
    const first = questions[0];
    if (!first) return null;
    return {
      type: "needs_input",
      ts: 0,
      kind: "question",
      question: first.question,
      ...(first.options ? { options: first.options.map((option) => option.label), optionDetails: first.options } : {}),
      questions,
      tool: method,
      input: params,
      requestId: String(id),
    };
  }
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

function codexInputQuestions(params: unknown): RunnerInputQuestion[] {
  const questions = asObject(params)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((raw): RunnerInputQuestion[] => {
    const question = asObject(raw);
    if (!question || typeof question.question !== "string" || question.question.length === 0) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          const option = asObject(rawOption);
          if (!option || typeof option.label !== "string") return [];
          return [{
            label: option.label,
            ...(typeof option.description === "string" ? { description: option.description } : {}),
          }];
        })
      : undefined;
    return [{
      ...(typeof question.id === "string" ? { id: question.id } : {}),
      ...(typeof question.header === "string" ? { header: question.header } : {}),
      question: question.question,
      ...(options && options.length > 0 ? { options } : {}),
    }];
  });
}

function codexQuestionAnswers(answer: string, params: unknown): Record<string, { answers: string[] }> {
  const questions = codexInputQuestions(params);
  let supplied: Record<string, unknown> | undefined;
  try {
    supplied = asObject(JSON.parse(answer));
  } catch {
    supplied = undefined;
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const [index, question] of questions.entries()) {
    if (!question.id) continue;
    const value = supplied?.[question.id] ?? supplied?.[question.question] ?? (index === 0 ? answer : undefined);
    if (Array.isArray(value)) answers[question.id] = { answers: value.map(String) };
    else if (typeof value === "string") answers[question.id] = { answers: [value] };
    else if (value !== undefined) answers[question.id] = { answers: [String(value)] };
  }
  return answers;
}

/**
 * Build the JSON-RPC RESPONSE body for an approval server-request, given the
 * method it answers and whether the user approved. Each server-request method
 * has its own response shape (from the generated *Response bindings):
 *   execCommandApproval / applyPatchApproval → { decision: ReviewDecision }        ("approved"|"denied")
 *   item/commandExecution/requestApproval    → { decision: CommandExecutionApprovalDecision } ("accept"|"decline")
 *   item/fileChange/requestApproval          → { decision: FileChangeApprovalDecision }       ("accept"|"decline")
 *   item/permissions/requestApproval         → { permissions: {}, scope: "turn" }  (grant-based; no decision field)
 *   item/tool/requestUserInput               → { answers: { [questionId]: { answers: string[] } } }
 * With approvalPolicy "never" these never fire — this is a best-effort fallback.
 */
export function encodeCodexApprovalResponse(
  method: string,
  approved: boolean,
  answer = "",
  params?: unknown,
): unknown {
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
      return { answers: codexQuestionAnswers(answer, params) };
    default:
      return { decision: approved ? "approved" : "denied" };
  }
}

/** Normalize a free-text answer to an approve/deny boolean. */
function isApproval(answer: string): boolean {
  return /^\s*(y|yes|approve|approved|accept|allow|ok|true)\b/i.test(answer);
}

// --- adapter -----------------------------------------------------------------

/** codex app-server flags: fixed subcommand; most caller argv is ignored for tier "server". */
const CODEX_APP_SERVER_ARGS = ["app-server"];

// codex-cli 0.144.0 acknowledges initialize before its asynchronous online
// model refresh has made the app-server able to service thread/start. A request
// sent inside that window is silently dropped and wedges that connection. There
// is no protocol-level ready notification, so failed attempts must be killed and
// respawned; retrying on the same peer cannot recover it.
const CODEX_THREAD_REQUEST_TIMEOUT_MS = 5_000;
// A caller that waited on its home lock gets more time on the first request
// because the preceding boot may still be completing an auth refresh. The
// fixed ladder remains bounded to 72s (37s delays + 15s + four 5s RPCs).
const CODEX_CONTENDED_FIRST_REQUEST_TIMEOUT_MS = 15_000;
const CODEX_THREAD_HANDSHAKE_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000] as const;
const CODEX_STDERR_LOG_LIMIT_BYTES = 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type CodexThreadHandshakeAttempt<T> = {
  run(preRequestDelayMs: number, requestTimeoutMs: number): Promise<T>;
  /** Process liveness is independent from whether the RPC peer answers. */
  isAlive(): boolean;
  /** Kill and fully discard this attempt; a timed-out connection is unrecoverable. */
  discard(): Promise<void>;
};

export type CodexBootFailureCause = "process-died" | "alive-but-unresponsive";

export class CodexBootProbeError extends Error {
  readonly classification: CodexBootFailureCause;

  constructor(classification: CodexBootFailureCause, error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "CodexBootProbeError";
    this.classification = classification;
  }
}

/**
 * Retry a Codex thread handshake on a fresh app-server after a bounded timeout.
 * Exported so the restart (rather than same-peer retry) contract is hermetically
 * testable without a real Codex account.
 */
export async function retryCodexThreadHandshake<T>(
  createAttempt: () => Promise<CodexThreadHandshakeAttempt<T>>,
  opts: {
    delaysMs?: readonly number[];
    requestTimeoutMs?: number;
    firstRequestTimeoutMs?: number;
    onRetry?: (info: { attempt: number; maxAttempts: number; nextDelayMs: number; error: CodexRpcRequestTimeoutError }) => void;
  } = {},
): Promise<{ attempt: CodexThreadHandshakeAttempt<T>; result: T }> {
  const delaysMs = opts.delaysMs ?? CODEX_THREAD_HANDSHAKE_DELAYS_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? CODEX_THREAD_REQUEST_TIMEOUT_MS;
  if (delaysMs.length === 0) throw new Error("codex thread handshake requires at least one attempt");

  for (let index = 0; index < delaysMs.length; index++) {
    const attempt = await createAttempt();
    try {
      const timeoutMs = index === 0 ? (opts.firstRequestTimeoutMs ?? requestTimeoutMs) : requestTimeoutMs;
      const result = await attempt.run(delaysMs[index] as number, timeoutMs);
      return { attempt, result };
    } catch (error) {
      const classification: CodexBootFailureCause = attempt.isAlive()
        ? "alive-but-unresponsive"
        : "process-died";
      // Always discard a failed child. codex-cli 0.144.0 leaves the connection
      // wedged after a premature thread request, including for later requests.
      await attempt.discard().catch(() => undefined);
      const retryable =
        error instanceof CodexRpcRequestTimeoutError &&
        (error.method === "thread/start" || error.method === "thread/resume");
      const hasNext = index + 1 < delaysMs.length;
      if (!retryable || !hasNext) throw new CodexBootProbeError(classification, error);
      opts.onRetry?.({
        attempt: index + 1,
        maxAttempts: delaysMs.length,
        nextDelayMs: delaysMs[index + 1] as number,
        error,
      });
    }
  }

  // The non-empty loop either returns or throws; this only satisfies TS control flow.
  throw new Error("codex thread handshake exhausted attempts");
}

/**
 * Build the codex spawn command/args + scrubbed env WITHOUT spawning. Pure —
 * exported so tests can exercise argv/env policy in isolation.
 */
export function buildCodexSpawn(opts: RunnerOpts): { command: string; args: string[]; env: Record<string, string> } {
  const command = opts.command ?? "codex";
  const authKind = opts.authKind ?? "subscription";
  const env: Record<string, string> = { ...opts.env };
  for (const key of harnessAllowance("codex", authKind)?.scrubEnv ?? []) delete env[key];
  return { command, args: [...CODEX_APP_SERVER_ARGS, ...codexConfigOverridesFromArgs(opts.args)], env };
}

/**
 * `-c key=value` config overrides recovered from the caller argv and re-applied
 * to the `codex app-server` child (`-c` is a root-level codex flag; process-wide,
 * which matches the one-bee-per-host model). The app-server otherwise ignores
 * TUI argv, so a bee's spawn/set-model reasoning override
 * (`-c model_reasoning_effort="high"`) silently lost to the home config.toml —
 * whose effort may be 5.6-only (ultra), 400-ing every turn once the bee moves
 * to a non-5.6 model.
 */
export function codexConfigOverridesFromArgs(args: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const list = args ?? [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]!;
    if ((arg === "-c" || arg === "--config") && list[i + 1] !== undefined) {
      out.push("-c", list[i + 1]!);
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value.length > 0) out.push("-c", value);
    }
  }
  return out;
}

/**
 * Codex HSR runs `codex app-server`, whose child argv ignores normal TUI model
 * flags. Recover the effective CLI model selector and pass it through the
 * app-server `thread/start` request instead. Last flag wins, matching Codex CLI
 * config precedence (`--model gpt-5.5 --model gpt-5.6-sol` -> Sol).
 */
export function codexModelFromArgs(args: readonly string[] | undefined): string | undefined {
  let model: string | undefined;
  const list = args ?? [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i]!;
    if ((arg === "-m" || arg === "--model") && list[i + 1]) {
      model = list[i + 1]!;
      i++;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (value.length > 0) model = value;
      continue;
    }
    if (arg.startsWith("-m=")) {
      const value = arg.slice("-m=".length);
      if (value.length > 0) model = value;
    }
  }
  return model;
}

export function buildCodexThreadRequestParams(
  opts: RunnerOpts,
  method: "thread/start" | "thread/resume",
): Record<string, unknown> {
  const model = codexModelFromArgs(opts.args) ?? opts.model;
  return method === "thread/resume"
    ? {
        threadId: opts.sessionId as string,
        ...(model ? { model } : {}),
        cwd: opts.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }
    : {
        ...(model ? { model } : {}),
        cwd: opts.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
}

type LiveCodexHandshakeAttempt = CodexThreadHandshakeAttempt<unknown> & {
  child: ChildProcess;
  peer: CodexRpcPeer;
};

function forwardCodexStderr(child: ChildProcess): void {
  let capturedBytes = 0;
  let truncated = false;
  child.stderr?.on("data", (chunk: Buffer | string) => {
    try {
      // The detached HSR host already redirects its stderr to host.log. Forward
      // the app-server's diagnostics there as well so startup failures retain
      // the model-refresh/MCP context that led to them. Keep draining after the
      // bound: RUST_LOG=info can otherwise grow one short turn by many megabytes.
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, CODEX_STDERR_LOG_LIMIT_BYTES - capturedBytes);
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        process.stderr.write(captured);
        capturedBytes += captured.length;
      }
      if (!truncated && buffer.length > remaining) {
        truncated = true;
        process.stderr.write(`\nhive: codex app-server stderr capture truncated after ${CODEX_STDERR_LOG_LIMIT_BYTES} bytes\n`);
      }
    } catch {
      // Logging must never crash the runner if the host stderr is closing.
    }
  });
}

async function createLiveCodexHandshakeAttempt(params: {
  command: string;
  args: string[];
  env: Record<string, string>;
  opts: RunnerOpts;
  method: "thread/start" | "thread/resume";
  requestParams: Record<string, unknown>;
}): Promise<LiveCodexHandshakeAttempt> {
  const child = await spawnSessionChild(params.command, params.args, { cwd: params.opts.cwd, env: params.env });
  forwardCodexStderr(child);
  const peer = createCodexRpcPeer(child.stdin!, child.stdout!);

  // Before durable session plumbing is attached, own enough lifecycle state to
  // reject an in-flight RPC and group-kill a failed handshake attempt cleanly.
  let exited = false;
  let resolveExited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const markExited = (): void => {
    if (exited) return;
    exited = true;
    peer.dispose(new Error("codex app-server exited during handshake"));
    resolveExited();
  };
  if (child.exitCode !== null || child.signalCode !== null) markExited();
  else child.once("exit", markExited);

  // Do not leave an unexpected startup-time server request hanging. These
  // handlers are replaced with the real event/session handlers after success.
  peer.onNotificationCatchAll(() => undefined);
  peer.onServerRequest((method, id) => {
    peer.respondError(id, CODEX_RPC_METHOD_NOT_FOUND, `unsupported server request during handshake: ${method}`);
  });

  return {
    child,
    peer,
    isAlive: () => !exited && child.exitCode === null && child.signalCode === null,
    async run(preRequestDelayMs: number, requestTimeoutMs: number): Promise<unknown> {
      await peer.request("initialize", {
        clientInfo: { name: "hive-hsr", title: null, version: "0" },
        capabilities: null,
      });
      if (preRequestDelayMs > 0) await sleep(preRequestDelayMs);
      return peer.request(params.method, params.requestParams, { timeoutMs: requestTimeoutMs });
    },
    async discard(): Promise<void> {
      peer.dispose(new Error("codex app-server handshake attempt discarded"));
      await stopChildGroup(child, () => exited, exitedPromise).catch(() => undefined);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

export async function startCodexRunner(opts: RunnerOpts): Promise<RunnerSession> {
  const bee = opts.bee;
  const { command, args, env } = buildCodexSpawn(opts);
  const method = opts.resume && opts.sessionId ? "thread/resume" : "thread/start";
  const requestParams = buildCodexThreadRequestParams(opts, method);

  let handshake: Awaited<ReturnType<typeof retryCodexThreadHandshake<unknown>>>;
  try {
    handshake = await retryCodexThreadHandshake(
      () => createLiveCodexHandshakeAttempt({ command, args, env, opts, method, requestParams }),
      {
        ...(opts.codexBootContended ? { firstRequestTimeoutMs: CODEX_CONTENDED_FIRST_REQUEST_TIMEOUT_MS } : {}),
        onRetry: ({ attempt, maxAttempts, nextDelayMs, error }) => {
          process.stderr.write(
            `hive: ${error.message}; restarting codex app-server ` +
            `(attempt ${attempt + 1}/${maxAttempts}, waiting ${nextDelayMs}ms before ${method})\n`,
          );
        },
      },
    );
  } catch (error) {
    if (error instanceof CodexBootProbeError) {
      process.stderr.write(`hive: codex boot probe failed: ${error.classification} (${method})\n`);
    }
    throw error;
  }
  const liveAttempt = handshake.attempt as LiveCodexHandshakeAttempt;
  const { child, peer } = liveAttempt;

  // Shared event queue / ring buffer / ingest / exit teardown / group stop
  // (sessionBase.ts). The peer is disposed FIRST in the exit handler so
  // in-flight requests reject before the exit event lands.
  const { events, ingestEvent, snapshot, hasExited, stop } = attachSessionPlumbing(bee, child, {
    onChildExit: () => peer.dispose(new Error("codex app-server exited")),
  });

  // Track whether the root turn is actually live. Retaining the last completed
  // turn id makes an idle interrupt look accepted even though no future
  // turn/completed event can exist for callers waiting on that boundary.
  let threadId = "";
  let turnLifecycle: CodexTurnLifecycle = { active: false, turnId: "" };
  const requestMethods = new Map<string, { method: string; params: unknown }>(); // requestId → response context

  peer.onNotificationCatchAll((method, params) => {
    turnLifecycle = codexTurnLifecycleAfterNotification(turnLifecycle, method, params);
    for (const ev of codexNotificationToEvents(method, params)) ingestEvent(ev);
  });

  peer.onServerRequest((method, id, params) => {
    const ev = codexServerRequestToNeedsInput(method, id, params);
    if (!ev) {
      // A server request we don't model — don't leave the server hanging.
      peer.respondError(id, CODEX_RPC_METHOD_NOT_FOUND, `unsupported server request: ${method}`);
      return;
    }
    if (ev.type === "needs_input" && ev.requestId) requestMethods.set(ev.requestId, { method, params });
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

  // --- protocol handshake completed on the surviving child -------------------
  threadId = threadIdFromResponse(handshake.result) ?? (method === "thread/resume" ? opts.sessionId ?? "" : "");
  if (threadId.length > 0) session.sessionId = threadId;

  async function send(text: string): Promise<void> {
    if (hasExited()) throw new Error("hsr codex: app-server has exited (session ended?)");
    if (!threadId) throw new Error("hsr codex: no thread id (thread/start did not complete)");
    // Fire the turn; turn_start/turn_end come from turn/started / turn/completed
    // notifications, so we don't block send() on the turn's completion.
    void peer
      .request("turn/start", { threadId, input: [encodeCodexUserInput(text)] })
      .catch((error: unknown) => {
        const message = `turn/start failed: ${String(error)}`;
        // An auth-expiry turn failure (the access token died between boot and this
        // turn) is classified so the daemon backstop recovers it; else generic error.
        ingestEvent(
          isCodexAuthExpiryError(message)
            ? { type: "auth_expired", ts: Date.now() }
            : { type: "error", ts: Date.now(), message },
        );
      });
  }

  async function answer(requestId: string, answerValue: RunnerInputAnswer): Promise<void> {
    const pending = requestMethods.get(requestId);
    if (!pending) throw new Error(`hsr codex: no pending input for requestId ${requestId}`);
    requestMethods.delete(requestId);
    const answerText = typeof answerValue === "string" ? answerValue : JSON.stringify(answerValue);
    const id: string | number = /^\d+$/.test(requestId) ? Number(requestId) : requestId;
    peer.respond(id, encodeCodexApprovalResponse(pending.method, isApproval(answerText), answerText, pending.params));
  }

  async function interrupt(): Promise<RunnerInterruptResult> {
    if (hasExited() || !threadId || !turnLifecycle.active) return { status: "already_idle" };
    if (!turnLifecycle.turnId) throw new Error("hsr codex: active turn has no turn id");
    try {
      await peer.request("turn/interrupt", { threadId, turnId: turnLifecycle.turnId });
    } catch (error) {
      // The turn may have completed between the active check and the RPC
      // response. That race is an idempotent idle success; real failures while
      // the same turn remains live must reach the caller.
      if (!turnLifecycle.active) return { status: "already_idle" };
      throw error;
    }
    return { status: "interrupt_requested" };
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
