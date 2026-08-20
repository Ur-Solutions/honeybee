/**
 * Grok harness adapter (WP3) — normalizes `grok agent stdio` ACP JSON-RPC.
 *
 * Format distilled from the previous system's adapter (`src/hsr/adapters/grok.ts`
 * + `acpRpc.ts`): NDJSON JSON-RPC 2.0, handshake initialize → authenticate →
 * session/new|load, then session/prompt for each mailbox delivery. No old
 * code is imported. Re-verify against a live `grok agent stdio` in the
 * manual smoke (`v2/driver-hsr/SMOKE.md`).
 *
 *   we write : initialize {protocolVersion:1, clientCapabilities, clientInfo}
 *   server   : initialize result {authMethods, agentCapabilities} → respond:
 *                authenticate {methodId: cached_token | xai.api_key}
 *   server   : authenticate result → respond:
 *                session/new {cwd, mcpServers:[]}  (or session/load {sessionId})
 *   server   : session/new|load result {sessionId} → booted (idle)
 *   we write : session/prompt {sessionId, prompt:[{type:"text",text}]}
 *   server   : session/prompt result → turn_ended
 *   server   : session/update agent_* chunks → turn_started (self-woken turns:
 *              background-task completions have no session/prompt result)
 *   server   : _x.ai/session_notification turn_completed
 *              / _x.ai/session/prompt_complete → turn_ended
 *   server   : session/request_permission → auto-allow (spawn uses --always-approve)
 *
 * The adapter is a factory: session/new needs cwd (and optionally a resume
 * session id). The returned object is still pure/stateless — signals derive
 * only from the input line.
 */
import {
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  parseJsonLine,
  successfulTurnClears,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
  type InterruptContext,
} from "./types.ts";
import { asObject } from "./types.ts";

const INITIALIZE_ID = 1;
const AUTHENTICATE_ID = 2;
const SESSION_SETUP_ID = 3;
const PROMPT_ID_BASE = 1000;
const ACP_PROTOCOL_VERSION = 1;
const METHOD_NOT_FOUND = -32601;

export interface GrokAdapterOptions {
  cwd: string;
  /**
   * Harness-native resume (spec 07 §F): when set, the handshake sends
   * `session/load {sessionId}` instead of `session/new`. Grok has no argv
   * resume on `agent stdio` — the ACP method is the resume path.
   */
  resumeSessionId?: string;
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

/** ACP prompt failures: JSON-RPC -32003 is grok's quota-exhausted code (old adapter). */
function promptErrorSignals(err: Record<string, unknown> | undefined, fallback: string): AdapterSignal[] {
  const message = String(err?.message ?? fallback);
  if (err?.code === -32003) {
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) }];
  }
  return errorSignals(message);
}

function updateKind(params: unknown): string | undefined {
  const object = asObject(params);
  const update = asObject(object?.update) ?? object;
  const kind = update?.sessionUpdate ?? update?.session_update ?? update?.type;
  return typeof kind === "string" ? kind : undefined;
}

function isReplay(params: unknown): boolean {
  const meta = asObject(asObject(params)?._meta);
  return meta?.isReplay === true;
}

function isGrokTurnCompleteMethod(method: string): boolean {
  return method === "_x.ai/session/prompt_complete"
    || method === "x.ai/session/prompt_complete";
}

function isSessionUpdateMethod(method: string): boolean {
  return method === "session/update"
    || method === "_x.ai/session/update"
    || method === "x.ai/session/update"
    || method === "_x.ai/session_notification"
    || method === "x.ai/session_notification";
}

function authMethodId(initialized: Record<string, unknown> | undefined): string | undefined {
  const methods = initialized && Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  const ids = methods.flatMap((method) => {
    const id = asObject(method)?.id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
  if (ids.includes("cached_token")) return "cached_token";
  if (ids.includes("xai.api_key")) return "xai.api_key";
  return ids[0];
}

function sessionIdOf(value: unknown): string | undefined {
  const object = asObject(value);
  const id = object?.sessionId ?? object?.session_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Pick the allow-once / allow option from a permission request, if any. */
export function grokAllowPermissionResult(params: unknown): Record<string, unknown> {
  const options = asObject(params)?.options;
  if (Array.isArray(options)) {
    const mapped = options.flatMap((raw) => {
      const option = asObject(raw);
      const optionId = option?.optionId ?? option?.option_id;
      const kind = typeof option?.kind === "string" ? option.kind : "";
      return typeof optionId === "string" ? [{ optionId, kind }] : [];
    });
    const selected = mapped.find((option) => /allow_once/i.test(option.kind))
      ?? mapped.find((option) => /allow/i.test(option.kind) && !/reject|deny/i.test(option.kind))
      ?? mapped[0];
    if (selected) return { outcome: { outcome: "selected", optionId: selected.optionId } };
  }
  return { outcome: { outcome: "selected", optionId: "allow-once" } };
}

export function grokAdapter(opts: GrokAdapterOptions): HarnessAdapter {
  const setupMethod = opts.resumeSessionId ? "session/load" : "session/new";
  const setupLine = JSON.stringify({
    jsonrpc: "2.0",
    id: SESSION_SETUP_ID,
    method: setupMethod,
    params: {
      cwd: opts.cwd,
      mcpServers: [],
      ...(opts.resumeSessionId ? { sessionId: opts.resumeSessionId } : {}),
    },
  });

  function parseLine(line: string): AdapterSignal[] {
    const msg = parseJsonLine(line);
    if (!msg) return [];

    if (typeof msg.method === "string") return methodSignals(msg);

    if (msg.id === INITIALIZE_ID) {
      if ("error" in msg) {
        const err = asObject(msg.error);
        return errorSignals(String(err?.message ?? "grok initialize failed"));
      }
      const methodId = authMethodId(asObject(msg.result));
      if (!methodId) {
        return [{ kind: "flag", flag: "auth_needed", action: "set", detail: "Grok ACP advertised no auth methods" }];
      }
      return [{
        kind: "respond",
        lines: [JSON.stringify({
          jsonrpc: "2.0",
          id: AUTHENTICATE_ID,
          method: "authenticate",
          params: { methodId },
        })],
      }];
    }

    if (msg.id === AUTHENTICATE_ID) {
      if ("error" in msg) {
        const err = asObject(msg.error);
        return errorSignals(String(err?.message ?? "grok authenticate failed"));
      }
      return [{ kind: "respond", lines: [setupLine] }];
    }

    if (msg.id === SESSION_SETUP_ID) {
      if ("error" in msg) {
        const err = asObject(msg.error);
        return errorSignals(String(err?.message ?? `grok ${setupMethod} failed`));
      }
      const sessionId = sessionIdOf(msg.result) ?? opts.resumeSessionId;
      if (sessionId) return bootedToIdle(sessionId);
      return errorSignals(`grok ${setupMethod} returned no sessionId`);
    }

    if (typeof msg.id === "number" && msg.id >= PROMPT_ID_BASE) {
      if ("error" in msg) {
        const err = asObject(msg.error);
        const signals = promptErrorSignals(err, "grok session/prompt failed");
        signals.push({ kind: "turn_ended" });
        return signals;
      }
      return [...successfulTurnClears(), { kind: "turn_ended" }];
    }

    return [];
  }

  function methodSignals(msg: Record<string, unknown>): AdapterSignal[] {
    if (msg.id !== undefined && msg.id !== null) {
      if (msg.method === "session/request_permission") {
        return [{
          kind: "respond",
          lines: [JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: grokAllowPermissionResult(msg.params) })],
        }];
      }
      return [{
        kind: "respond",
        lines: [JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: METHOD_NOT_FOUND, message: `unsupported server request: ${String(msg.method)}` },
        })],
      }];
    }
    // Replayed historical updates must not reopen/close the live turn.
    if (isReplay(msg.params)) return [];

    // Self-woken turns (background tasks, scheduled continuations): ACP has
    // no session/prompt JSON-RPC, so agent output is the opening edge and
    // Grok's turn_completed / prompt_complete notifications are the close.
    // Hive-delivered turns also emit those notifications; duplicate
    // turn_ended is idle-idempotent in the driver.
    if (typeof msg.method === "string" && isGrokTurnCompleteMethod(msg.method)) {
      return [...successfulTurnClears(), { kind: "turn_ended" }];
    }
    if (typeof msg.method === "string" && isSessionUpdateMethod(msg.method)) {
      const kind = updateKind(msg.params);
      if (kind === "turn_completed") {
        return [...successfulTurnClears(), { kind: "turn_ended" }];
      }
      if (
        kind === "agent_message_chunk"
        || kind === "agent_message"
        || kind === "agent_thought_chunk"
        || kind === "tool_call"
        || kind === "tool_call_update"
      ) {
        return [{ kind: "turn_started" }];
      }
    }
    return [];
  }

  return {
    harness: "grok",
    acceptsMidTurn: false,
    readyAtSpawn: false,
    bootLines(): string[] {
      return [JSON.stringify({
        jsonrpc: "2.0",
        id: INITIALIZE_ID,
        method: "initialize",
        params: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "Honeybee", version: "2" },
        },
      })];
    },
    parseLine,
    encodeMessage(body: string, ctx: EncodeContext): string | null {
      if (!ctx.sessionId) return null;
      return JSON.stringify({
        jsonrpc: "2.0",
        id: PROMPT_ID_BASE + ctx.messageId,
        method: "session/prompt",
        params: { sessionId: ctx.sessionId, prompt: [{ type: "text", text: body }] },
      });
    },
    encodeInterrupt(ctx: InterruptContext): string | null {
      if (!ctx.sessionId) return null;
      return JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: ctx.sessionId },
      });
    },
  };
}
