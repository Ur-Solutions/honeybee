/** Production OpenCode server-tier adapter (`opencode serve` REST + SSE). */

import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { harnessAllowance } from "../harness.js";
import { makeLineReader } from "../lineReader.js";
import { attachSessionPlumbing, spawnSessionChild } from "../sessionBase.js";
import type {
  RunnerAdapter,
  RunnerEvent,
  RunnerInputAnswer,
  RunnerInputQuestion,
  RunnerOpts,
  RunnerSendOpts,
  RunnerSession,
  RunnerTier,
} from "../types.js";

type ObjectLike = Record<string, unknown>;
type FetchLike = typeof fetch;

const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 50;
const RECONNECT_MAX_MS = 1_000;
const MAX_ERROR_BODY_BYTES = 4_096;
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;
const OWNER_METADATA_KEY = "honeybee";

export type OpenCodeModelSelection = { providerID: string; modelID: string };

export type OpenCodeAdapterDependencies = {
  fetch?: FetchLike;
  randomPassword?: () => string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnectBaseMs?: number;
};

type OpenCodeSessionInfo = {
  id: string;
  directory: string;
  metadata?: ObjectLike;
  [key: string]: unknown;
};

type PendingInput = {
  kind: "permission" | "question";
  properties: ObjectLike;
};

type QueuedSend = { text: string };

class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`OpenCode ${path} returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "OpenCodeHttpError";
  }
}

function asObject(value: unknown): ObjectLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectLike : undefined;
}

function stringField(value: ObjectLike | undefined, ...keys: string[]): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function flagValue(args: readonly string[], names: readonly string[]): string | undefined {
  let selected: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    for (const name of names) {
      if (arg === name) {
        const next = args[index + 1];
        if (next && !next.startsWith("-")) selected = next;
      } else if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1);
        if (value.length > 0) selected = value;
      }
    }
  }
  return selected;
}

export function parseOpenCodeModel(value: string | undefined): OpenCodeModelSelection | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

/** Resolve OpenCode's qualified model and provider-specific reasoning variant. */
export function openCodeSelection(opts: Pick<RunnerOpts, "model" | "args">): {
  model?: OpenCodeModelSelection;
  variant?: string;
  agent?: string;
} {
  const args = opts.args ?? [];
  const argModel = flagValue(args, ["--model", "-m"]);
  const requested = argModel ?? opts.model;
  const model = parseOpenCodeModel(requested);
  if (requested && !model) {
    throw new Error(`hsr opencode: model must be qualified as provider/model (got ${JSON.stringify(requested)})`);
  }
  const variant = flagValue(args, ["--variant", "--effort", "--reasoning-effort"]);
  const agent = flagValue(args, ["--agent"]);
  return { ...(model ? { model } : {}), ...(variant ? { variant } : {}), ...(agent ? { agent } : {}) };
}

function isOpenCodeExecutable(value: string): boolean {
  return ["opencode", "opencode.exe"].includes(basename(value).toLowerCase());
}

/** Normalize a resolved interactive argv into one headless server invocation. */
export function buildOpenCodeSpawn(opts: RunnerOpts, password: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const command = opts.command ?? "opencode";
  const original = [...(opts.args ?? [])];
  let prefix: string[] = [];
  if (!isOpenCodeExecutable(command)) {
    const wrappedIndex = original.findIndex(isOpenCodeExecutable);
    prefix = wrappedIndex >= 0 ? original.slice(0, wrappedIndex + 1) : original;
  }
  const args = [...prefix, "serve", "--hostname", "127.0.0.1", "--port", "0"];
  if (original.includes("--pure")) args.push("--pure");

  const env = { ...opts.env };
  for (const key of harnessAllowance("opencode", opts.authKind ?? "subscription")?.scrubEnv ?? []) delete env[key];
  // Account isolation intentionally relocates XDG_DATA_HOME, where OpenCode
  // stores auth.json. A mise shim also derives its own installation registry
  // from XDG_DATA_HOME; without pinning the parent registry, the shim can run
  // `mise` itself instead of the installed OpenCode binary. Preserve an
  // explicit MISE_DATA_DIR, otherwise derive the parent process's normal one.
  if (env.XDG_DATA_HOME && !env.MISE_DATA_DIR) {
    const parentMiseData = process.env.MISE_DATA_DIR
      ?? (process.env.XDG_DATA_HOME
        ? join(process.env.XDG_DATA_HOME, "mise")
        : process.env.HOME
          ? join(process.env.HOME, ".local", "share", "mise")
          : undefined);
    if (parentMiseData) env.MISE_DATA_DIR = parentMiseData;
  }
  // Always replace caller-provided server credentials. The password is unique
  // to this bee and never appears in argv, logs, metadata, or error text.
  env.OPENCODE_SERVER_USERNAME = "opencode";
  env.OPENCODE_SERVER_PASSWORD = password;
  return { command, args, env };
}

/** Parse and validate the one startup line emitted by OpenCode 1.17.x. */
export function parseOpenCodeStartupUrl(line: string): URL | undefined {
  const match = line.match(/(?:^|\s)opencode server listening on (https?:\/\/[^\s]+)\s*$/i);
  if (!match?.[1]) return undefined;
  let url: URL;
  try {
    url = new URL(match[1]);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]" && url.hostname !== "::1") {
    return undefined;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return url;
}

function safeDetail(value: unknown): string {
  const object = asObject(value);
  const data = asObject(object?.data);
  const message = stringField(data, "message") ?? stringField(object, "message", "name");
  if (message) return message.slice(0, 1_000);
  if (typeof value === "string") return value.slice(0, 1_000);
  try {
    return JSON.stringify(value).slice(0, 1_000);
  } catch {
    return "OpenCode request failed";
  }
}

function errorShape(value: unknown): { name: string; message: string; status?: number; headers?: ObjectLike; body?: string } {
  const outer = asObject(value) ?? {};
  const data = asObject(outer.data) ?? outer;
  const name = stringField(outer, "name") ?? stringField(data, "name", "code") ?? "OpenCodeError";
  const message = stringField(data, "message") ?? stringField(outer, "message") ?? safeDetail(value);
  const status = finiteNumber(data.statusCode) ?? finiteNumber(data.status) ?? finiteNumber(outer.statusCode);
  const headers = asObject(data.responseHeaders) ?? asObject(outer.responseHeaders);
  const body = stringField(data, "responseBody") ?? stringField(outer, "responseBody");
  return { name, message, ...(status !== undefined ? { status } : {}), ...(headers ? { headers } : {}), ...(body ? { body } : {}) };
}

function resetHint(error: ReturnType<typeof errorShape>): string | undefined {
  const headerValue = (name: string): string | undefined => {
    if (!error.headers) return undefined;
    for (const [key, value] of Object.entries(error.headers)) {
      if (key.toLowerCase() === name && typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };
  const retryAfter = headerValue("retry-after");
  if (retryAfter) return `retry-after ${retryAfter}`;
  const reset = headerValue("x-ratelimit-reset") ?? headerValue("x-rate-limit-reset");
  if (reset) return `reset ${reset}`;
  const source = `${error.message} ${error.body ?? ""}`;
  return source.match(/\b(?:retry|reset|try again)\b[^.\n]{0,120}/i)?.[0]?.trim();
}

function isAbortError(value: unknown): boolean {
  const error = errorShape(value);
  return error.name === "MessageAbortedError" || error.name === "AbortError";
}

/** Classify provider errors into Honeybee auth/exhaustion state edges. */
export function openCodeErrorToRunnerEvent(value: unknown): RunnerEvent {
  const error = errorShape(value);
  const text = `${error.name} ${error.message} ${error.body ?? ""}`.toLowerCase();
  const detail = `${error.name}: ${error.message}`.slice(0, 1_000);
  if (
    error.name === "ProviderAuthError" ||
    error.status === 401 ||
    error.status === 403 ||
    /(?:auth|credential|api[ _-]?key|token).*(?:expired|invalid|missing|required|unauthori[sz]ed)|not logged in|login required/.test(text)
  ) {
    return { type: "auth_expired", ts: 0, detail };
  }
  if (
    error.status === 429 ||
    /rate[ _.-]?limit|usage[ _.-]?limit|quota.*(?:reached|exceeded|exhausted)|too many requests|resource_exhausted/.test(text)
  ) {
    const hint = resetHint(error);
    return { type: "exhausted", ts: 0, ...(hint ? { resetHint: hint } : { resetHint: detail }) };
  }
  return { type: "error", ts: 0, message: detail };
}

/** Exact per-assistant-message usage from OpenCode's completed message info. */
export function openCodeAssistantUsage(value: unknown): (RunnerEvent & { type: "usage" }) | undefined {
  const info = asObject(value);
  if (info?.role !== "assistant") return undefined;
  const tokens = asObject(info.tokens);
  if (!tokens) return undefined;
  const cache = asObject(tokens.cache);
  const inputTokens = finiteNumber(tokens.input);
  const outputTokens = finiteNumber(tokens.output);
  const reasoningTokens = finiteNumber(tokens.reasoning);
  const cacheReadTokens = finiteNumber(cache?.read);
  const cacheWriteTokens = finiteNumber(cache?.write);
  const totalTokens = finiteNumber(tokens.total)
    ?? [inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens]
      .reduce<number>((sum, item) => sum + (item ?? 0), 0);
  const cost = finiteNumber(info.cost);
  return {
    type: "usage",
    ts: 0,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

export function openCodePermissionNeedsInput(value: unknown): RunnerEvent | undefined {
  const properties = asObject(value);
  const requestId = stringField(properties, "id", "requestID");
  const sessionID = stringField(properties, "sessionID");
  const permission = stringField(properties, "permission") ?? "tool";
  if (!properties || !requestId || !sessionID) return undefined;
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((item): item is string => typeof item === "string")
    : [];
  const canAlways = Array.isArray(properties.always) && properties.always.some((item) => typeof item === "string");
  const options = canAlways ? ["once", "always", "reject"] : ["once", "reject"];
  return {
    type: "needs_input",
    ts: 0,
    kind: "permission",
    requestId,
    tool: permission,
    question: `Allow ${permission}${patterns.length > 0 ? ` (${patterns.join(", ")})` : ""}?`,
    options,
    optionDetails: [
      { label: "once", description: "Allow this request once." },
      ...(canAlways ? [{ label: "always", description: "Allow matching requests for this session." }] : []),
      { label: "reject", description: "Reject this request." },
    ],
    input: properties,
  };
}

export function openCodeQuestionNeedsInput(value: unknown): RunnerEvent | undefined {
  const properties = asObject(value);
  const requestId = stringField(properties, "id", "requestID");
  const sessionID = stringField(properties, "sessionID");
  if (!properties || !requestId || !sessionID || !Array.isArray(properties.questions)) return undefined;
  const questions: RunnerInputQuestion[] = properties.questions.flatMap((raw, index) => {
    const question = asObject(raw);
    const text = stringField(question, "question");
    if (!question || !text) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((item) => {
          const option = asObject(item);
          const label = stringField(option, "label");
          return label ? [{ label, ...(stringField(option, "description") ? { description: stringField(option, "description") } : {}) }] : [];
        })
      : undefined;
    return [{
      id: String(index),
      question: text,
      ...(stringField(question, "header") ? { header: stringField(question, "header") } : {}),
      ...(options ? { options } : {}),
      ...(typeof question.multiple === "boolean" ? { multiSelect: question.multiple } : {}),
    }];
  });
  if (questions.length === 0) return undefined;
  const first = questions[0]!;
  return {
    type: "needs_input",
    ts: 0,
    kind: "question",
    requestId,
    question: questions.map((item) => item.question).join("\n"),
    questions,
    ...(first.options ? { options: first.options.map((option) => option.label), optionDetails: first.options } : {}),
    ...(first.multiSelect !== undefined ? { multiSelect: first.multiSelect } : {}),
    tool: "question",
    input: properties,
  };
}

function permissionReply(answer: string): "once" | "always" | "reject" {
  const value = answer.trim().toLowerCase();
  if (["always", "all", "persist"].includes(value)) return "always";
  if (["no", "n", "deny", "denied", "reject", "rejected", "cancel"].includes(value)) return "reject";
  return "once";
}

function questionAnswers(answer: RunnerInputAnswer, pending: PendingInput): string[][] {
  if (Array.isArray(answer)) return answer.map((items) => [...items]);
  const trimmed = answer.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))
      ) {
        return parsed as string[][];
      }
    } catch {
      // Fall through to the compatibility path below.
    }
  }
  const count = Array.isArray(pending.properties.questions) ? pending.properties.questions.length : 1;
  if (count !== 1) {
    throw new Error(`hsr opencode: ${count} questions require a JSON string[][] answer`);
  }
  return [[answer]];
}

async function canonicalDirectory(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function ownerMetadata(bee: string, cwd: string): ObjectLike {
  return { bee, cwd, adapter: "opencode-hsr-v1" };
}

function validateOwner(session: OpenCodeSessionInfo, bee: string, cwd: string): void {
  const owner = asObject(session.metadata?.[OWNER_METADATA_KEY]);
  const ownerBee = stringField(owner, "bee");
  const ownerCwd = stringField(owner, "cwd");
  if (ownerBee && ownerBee !== bee) {
    throw new Error(`hsr opencode: session ${session.id} is owned by bee ${ownerBee}, not ${bee}`);
  }
  if (ownerCwd && resolve(ownerCwd) !== resolve(cwd)) {
    throw new Error(`hsr opencode: session ${session.id} ownership cwd ${ownerCwd} does not match ${cwd}`);
  }
}

function eventSessionId(properties: ObjectLike): string | undefined {
  return stringField(properties, "sessionID")
    ?? stringField(asObject(properties.part), "sessionID")
    ?? stringField(asObject(properties.info), "sessionID");
}

function isAssistantCompleted(info: ObjectLike): boolean {
  return info.role === "assistant" && finiteNumber(asObject(info.time)?.completed) !== undefined;
}

function isProcessAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function startOpenCodeRunner(
  opts: RunnerOpts,
  dependencies: OpenCodeAdapterDependencies = {},
): Promise<RunnerSession> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const reconnectBaseMs = dependencies.reconnectBaseMs ?? RECONNECT_BASE_MS;
  const password = dependencies.randomPassword?.() ?? randomBytes(32).toString("base64url");
  const spawn = buildOpenCodeSpawn(opts, password);
  const selection = openCodeSelection(opts);
  const cwd = await canonicalDirectory(opts.cwd);
  const autoApprove = (opts.args ?? []).includes("--auto");

  const child = await spawnSessionChild(spawn.command, spawn.args, { cwd: opts.cwd, env: spawn.env });
  const sseAbort = new AbortController();
  let stopping = false;
  const plumbing = attachSessionPlumbing(opts.bee, child, { onChildExit: () => sseAbort.abort() });
  const { ingestEvent, events, snapshot, hasExited } = plumbing;

  const startupLines: string[] = [];
  let resolveUrl!: (url: URL) => void;
  let rejectUrl!: (error: Error) => void;
  let startupSettled = false;
  const startupUrl = new Promise<URL>((resolveUrlPromise, rejectUrlPromise) => {
    resolveUrl = (url) => {
      if (startupSettled) return;
      startupSettled = true;
      resolveUrlPromise(url);
    };
    rejectUrl = (error) => {
      if (startupSettled) return;
      startupSettled = true;
      rejectUrlPromise(error);
    };
  });
  const onStartupLine = (line: string): void => {
    if (startupLines.length < 20) startupLines.push(line);
    const parsed = parseOpenCodeStartupUrl(line);
    if (parsed) resolveUrl(parsed);
  };
  child.stdout?.on("data", makeLineReader(onStartupLine));
  child.stderr?.on("data", makeLineReader(onStartupLine));
  child.once("exit", (code, signal) => {
    rejectUrl(new Error(`hsr opencode: server exited before startup (code ${code ?? "null"}, signal ${signal ?? "none"})`));
  });

  let baseUrl: URL;
  try {
    baseUrl = await withTimeout(startupUrl, startupTimeoutMs, "hsr opencode startup URL");
  } catch (error) {
    stopping = true;
    await plumbing.stop().catch(() => undefined);
    const detail = startupLines.length > 0 ? `; output: ${startupLines.join(" | ").slice(0, 2_000)}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }

  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

  async function request(path: string, init: RequestInit = {}, includeDirectory = true): Promise<Response> {
    const url = new URL(path, baseUrl);
    if (includeDirectory) url.searchParams.set("directory", cwd);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`request timeout after ${requestTimeoutMs}ms`)), requestTimeoutMs);
    const outer = init.signal;
    const relay = (): void => controller.abort(outer?.reason);
    outer?.addEventListener("abort", relay, { once: true });
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("Accept", headers.get("Accept") ?? "application/json");
    if (init.body !== undefined) headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    try {
      return await fetchImpl(url, { ...init, headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      outer?.removeEventListener("abort", relay);
    }
  }

  async function eventRequest(): Promise<Response> {
    const url = new URL("/event", baseUrl);
    url.searchParams.set("directory", cwd);
    return fetchImpl(url, {
      headers: {
        Accept: "text/event-stream",
        Authorization: authorization,
      },
      // Keep the caller-owned signal attached for the lifetime of the response
      // body. A request-timeout controller is safe for JSON headers, but
      // detaching its relay after fetch() resolves would make an SSE stream
      // impossible to cancel during shutdown.
      signal: sseAbort.signal,
    });
  }

  async function responseDetail(response: Response): Promise<string> {
    try {
      return (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
    } catch {
      return "";
    }
  }

  async function jsonRequest(path: string, init: RequestInit = {}, includeDirectory = true): Promise<unknown> {
    const response = await request(path, init, includeDirectory);
    if (!response.ok) throw new OpenCodeHttpError(response.status, path, await responseDetail(response));
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) as unknown : undefined;
  }

  try {
    const deadline = Date.now() + startupTimeoutMs;
    for (;;) {
      try {
        const health = asObject(await jsonRequest("/global/health", {}, false));
        if (health?.healthy === true) break;
        throw new Error("health response did not report healthy:true");
      } catch (error) {
        if (error instanceof OpenCodeHttpError && error.status >= 400 && error.status < 500) throw error;
        if (Date.now() >= deadline || !isProcessAlive(child)) throw error;
        await delay(50);
      }
    }
  } catch (error) {
    stopping = true;
    await plumbing.stop().catch(() => undefined);
    throw new Error(`hsr opencode health failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const permissionRules = autoApprove
    ? [{ permission: "*", pattern: "*", action: "allow" }]
    : undefined;
  let sessionInfo: OpenCodeSessionInfo;
  try {
    if (opts.resume) {
      if (!opts.sessionId) throw new Error("resume requires an existing session id");
      const loaded = asObject(await jsonRequest(`/session/${encodeURIComponent(opts.sessionId)}`));
      if (!loaded || typeof loaded.id !== "string" || typeof loaded.directory !== "string") {
        throw new Error(`session ${opts.sessionId} returned an invalid response`);
      }
      sessionInfo = loaded as OpenCodeSessionInfo;
      if (sessionInfo.id !== opts.sessionId) throw new Error(`loaded session id ${sessionInfo.id} does not match ${opts.sessionId}`);
      const sessionCwd = await canonicalDirectory(sessionInfo.directory);
      if (sessionCwd !== cwd) throw new Error(`session ${sessionInfo.id} belongs to cwd ${sessionCwd}, not ${cwd}`);
      validateOwner(sessionInfo, opts.bee, cwd);
      const metadata = { ...(sessionInfo.metadata ?? {}), [OWNER_METADATA_KEY]: ownerMetadata(opts.bee, cwd) };
      const claimed = asObject(await jsonRequest(`/session/${encodeURIComponent(sessionInfo.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ metadata, ...(permissionRules ? { permission: permissionRules } : {}) }),
      }));
      if (claimed) sessionInfo = claimed as OpenCodeSessionInfo;
    } else {
      const metadata = { [OWNER_METADATA_KEY]: ownerMetadata(opts.bee, cwd) };
      const model = selection.model
        ? { id: selection.model.modelID, providerID: selection.model.providerID, ...(selection.variant ? { variant: selection.variant } : {}) }
        : undefined;
      const created = asObject(await jsonRequest("/session", {
        method: "POST",
        body: JSON.stringify({
          title: `Honeybee ${opts.bee}`,
          metadata,
          ...(model ? { model } : {}),
          ...(selection.agent ? { agent: selection.agent } : {}),
          ...(permissionRules ? { permission: permissionRules } : {}),
        }),
      }));
      if (!created || typeof created.id !== "string" || typeof created.directory !== "string") {
        throw new Error("session create returned an invalid response");
      }
      sessionInfo = created as OpenCodeSessionInfo;
      const sessionCwd = await canonicalDirectory(sessionInfo.directory);
      if (sessionCwd !== cwd) throw new Error(`created session ${sessionInfo.id} belongs to cwd ${sessionCwd}, not ${cwd}`);
    }
  } catch (error) {
    stopping = true;
    await plumbing.stop().catch(() => undefined);
    throw new Error(`hsr opencode session setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sessionId = sessionInfo.id;
  const assistantMessages = new Set<string>();
  const emittedUsage = new Set<string>();
  const partKinds = new Map<string, "text" | "reasoning">();
  const partContent = new Map<string, string>();
  const toolSignatures = new Map<string, string>();
  const pendingInputs = new Map<string, PendingInput>();
  const normalQueue: QueuedSend[] = [];
  const boundaryQueue: QueuedSend[] = [];
  let active = false;
  let dispatching = false;
  let reconnects = 0;
  let reportedDisconnect = false;
  let resolveSseReady!: () => void;
  let rejectSseReady!: (error: Error) => void;
  let sseReadySettled = false;
  const sseReady = new Promise<void>((resolveReady, rejectReady) => {
    resolveSseReady = () => {
      if (sseReadySettled) return;
      sseReadySettled = true;
      resolveReady();
    };
    rejectSseReady = (error) => {
      if (sseReadySettled) return;
      sseReadySettled = true;
      rejectReady(error);
    };
  });

  function promptBody(text: string): ObjectLike {
    return {
      parts: [{ type: "text", text }],
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.variant ? { variant: selection.variant } : {}),
      ...(selection.agent ? { agent: selection.agent } : {}),
    };
  }

  async function postPrompt(text: string, startsTurn: boolean): Promise<void> {
    if (startsTurn) {
      active = true;
      ingestEvent({ type: "turn_start", ts: Date.now() });
    }
    try {
      await jsonRequest(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        body: JSON.stringify(promptBody(text)),
      });
    } catch (error) {
      const event = error instanceof OpenCodeHttpError && (error.status === 401 || error.status === 403)
        ? { type: "auth_expired", ts: Date.now(), detail: error.message } satisfies RunnerEvent
        : { type: "error", ts: Date.now(), message: `OpenCode prompt failed: ${error instanceof Error ? error.message : String(error)}` } satisfies RunnerEvent;
      ingestEvent(event);
      if (startsTurn) {
        active = false;
        ingestEvent({ type: "turn_end", ts: Date.now() });
      }
      throw error;
    }
  }

  function drain(): void {
    if (stopping || hasExited() || active || dispatching || normalQueue.length === 0) return;
    const next = normalQueue.shift()!;
    dispatching = true;
    void postPrompt(next.text, true)
      .catch(() => undefined)
      .finally(() => {
        dispatching = false;
        if (!active) drain();
      });
  }

  function flushBoundaryQueue(): void {
    if (stopping || boundaryQueue.length === 0) return;
    const pending = boundaryQueue.splice(0);
    void (async () => {
      for (const item of pending) {
        if (stopping || hasExited()) return;
        await postPrompt(item.text, false).catch(() => undefined);
      }
    })();
  }

  function finishTurn(): void {
    if (active) {
      active = false;
      ingestEvent({ type: "turn_end", ts: Date.now() });
    }
    pendingInputs.clear();
    if (boundaryQueue.length > 0) normalQueue.unshift(...boundaryQueue.splice(0));
    drain();
  }

  function emitFullPart(part: ObjectLike): void {
    const partId = stringField(part, "id");
    const messageID = stringField(part, "messageID");
    if (!partId || !messageID || !assistantMessages.has(messageID)) return;
    if (part.type !== "text" && part.type !== "reasoning") return;
    const kind = part.type;
    partKinds.set(partId, kind);
    const full = typeof part.text === "string" ? part.text : "";
    const previous = partContent.get(partId) ?? "";
    if (full.startsWith(previous) && full.length > previous.length) {
      const delta = full.slice(previous.length);
      ingestEvent(kind === "text" ? { type: "text", ts: 0, text: delta } : { type: "reasoning", ts: 0, text: delta });
      partContent.set(partId, full);
    } else if (previous.length === 0) {
      partContent.set(partId, full);
    }
  }

  function emitToolPart(part: ObjectLike): void {
    if (part.type !== "tool") return;
    const messageID = stringField(part, "messageID");
    if (!messageID || !assistantMessages.has(messageID)) return;
    const state = asObject(part.state);
    const status = stringField(state, "status");
    const tool = stringField(part, "tool") ?? "tool";
    const callId = stringField(part, "callID", "id");
    if (!state || !status || !["pending", "running", "completed", "error"].includes(status)) return;
    const key = callId ?? `${messageID}:${tool}`;
    const signature = JSON.stringify({ status, input: state.input, output: state.output, error: state.error });
    const previous = toolSignatures.get(key);
    if (previous === signature) return;
    toolSignatures.set(key, signature);
    if (previous === undefined) {
      ingestEvent({ type: "tool_use", ts: 0, tool, ...(callId ? { callId } : {}), ...(state.input !== undefined ? { input: state.input } : {}) });
      flushBoundaryQueue();
      if (status === "pending" || status === "running") return;
    }
    ingestEvent({
      type: "tool_update",
      ts: 0,
      tool,
      ...(callId ? { callId } : {}),
      status: status as "pending" | "running" | "completed" | "error",
      ...(state.input !== undefined ? { input: state.input } : {}),
      ...(state.output !== undefined ? { output: state.output } : {}),
      ...(typeof state.error === "string" ? { error: state.error } : {}),
    });
  }

  function processMessageInfo(info: ObjectLike): void {
    const messageID = stringField(info, "id");
    if (!messageID || stringField(info, "sessionID") !== sessionId || info.role !== "assistant") return;
    assistantMessages.add(messageID);
    if (isAssistantCompleted(info) && !emittedUsage.has(messageID)) {
      emittedUsage.add(messageID);
      const usage = openCodeAssistantUsage(info);
      if (usage) ingestEvent(usage);
      if (info.error && !isAbortError(info.error)) ingestEvent(openCodeErrorToRunnerEvent(info.error));
    }
  }

  function processPart(part: ObjectLike): void {
    emitFullPart(part);
    emitToolPart(part);
  }

  async function handleProviderEvent(eventValue: unknown): Promise<void> {
    const event = asObject(eventValue);
    const type = stringField(event, "type");
    const properties = asObject(event?.properties);
    if (!event || !type || !properties) return;
    if (type === "server.connected" || type === "server.heartbeat") return;
    if (eventSessionId(properties) !== sessionId) return;

    if (type === "message.updated") {
      const info = asObject(properties.info);
      if (info) processMessageInfo(info);
      return;
    }
    if (type === "message.part.updated") {
      const part = asObject(properties.part);
      if (part) processPart(part);
      return;
    }
    if (type === "message.part.delta") {
      const messageID = stringField(properties, "messageID");
      const partID = stringField(properties, "partID");
      const deltaText = stringField(properties, "delta");
      if (!messageID || !partID || !deltaText || properties.field !== "text" || !assistantMessages.has(messageID)) return;
      const kind = partKinds.get(partID);
      if (!kind) return;
      partContent.set(partID, `${partContent.get(partID) ?? ""}${deltaText}`);
      ingestEvent(kind === "text" ? { type: "text", ts: 0, text: deltaText } : { type: "reasoning", ts: 0, text: deltaText });
      return;
    }
    if (type === "session.status") {
      const status = asObject(properties.status);
      if (status?.type === "busy") {
        if (!active) {
          active = true;
          ingestEvent({ type: "turn_start", ts: Date.now() });
        }
      } else if (status?.type === "retry") {
        ingestEvent(openCodeErrorToRunnerEvent({
          name: "OpenCodeRetry",
          message: stringField(status, "message") ?? "OpenCode provider retry",
          action: status.action,
        }));
      }
      return;
    }
    if (type === "session.idle") {
      finishTurn();
      return;
    }
    if (type === "session.error") {
      if (properties.error) ingestEvent(openCodeErrorToRunnerEvent(properties.error));
      return;
    }
    if (type === "permission.asked") {
      const needs = openCodePermissionNeedsInput(properties);
      const requestId = stringField(properties, "id", "requestID");
      if (needs && requestId) {
        pendingInputs.set(requestId, { kind: "permission", properties });
        ingestEvent(needs);
      }
      return;
    }
    if (type === "question.asked") {
      const needs = openCodeQuestionNeedsInput(properties);
      const requestId = stringField(properties, "id", "requestID");
      if (needs && requestId) {
        pendingInputs.set(requestId, { kind: "question", properties });
        ingestEvent(needs);
      }
      return;
    }
    if (["permission.replied", "question.replied", "question.rejected"].includes(type)) {
      const requestId = stringField(properties, "requestID", "id");
      if (requestId) pendingInputs.delete(requestId);
    }
  }

  async function reconcileAfterReconnect(): Promise<void> {
    const [messagesValue, statusValue, permissionsValue, questionsValue] = await Promise.all([
      jsonRequest(`/session/${encodeURIComponent(sessionId)}/message`),
      jsonRequest("/session/status"),
      jsonRequest("/permission"),
      jsonRequest("/question"),
    ]);
    const messages = Array.isArray(messagesValue)
      ? messagesValue.flatMap((message) => asObject(message) ? [asObject(message)!] : [])
      : [];
    messages.sort((left, right) => {
      const leftCreated = finiteNumber(asObject(asObject(left.info)?.time)?.created) ?? 0;
      const rightCreated = finiteNumber(asObject(asObject(right.info)?.time)?.created) ?? 0;
      return leftCreated - rightCreated;
    });
    for (const message of messages) {
      const info = asObject(message.info);
      if (info) processMessageInfo(info);
      if (Array.isArray(message.parts)) {
        for (const part of message.parts) {
          const object = asObject(part);
          if (object) processPart(object);
        }
      }
    }
    for (const item of Array.isArray(permissionsValue) ? permissionsValue : []) {
      const properties = asObject(item);
      if (properties && stringField(properties, "sessionID") === sessionId) {
        await handleProviderEvent({ type: "permission.asked", properties });
      }
    }
    for (const item of Array.isArray(questionsValue) ? questionsValue : []) {
      const properties = asObject(item);
      if (properties && stringField(properties, "sessionID") === sessionId) {
        await handleProviderEvent({ type: "question.asked", properties });
      }
    }
    const statusMap = asObject(statusValue);
    const status = statusMap ? asObject(statusMap[sessionId]) : undefined;
    if (status && status.type !== "idle") {
      await handleProviderEvent({ type: "session.status", properties: { sessionID: sessionId, status } });
    } else {
      // OpenCode's live transition publishes session.status(idle) immediately
      // followed by session.idle. Only session.idle closes a live turn, or the
      // queued prompt it releases could be mistaken for the old turn by that
      // second event. A reconnect has no replayed idle event, so close it here.
      finishTurn();
    }
  }

  async function consumeSse(response: Response, reconnect: boolean): Promise<void> {
    if (!response.body) throw new Error("OpenCode SSE response has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_BUFFER_BYTES) throw new Error("OpenCode SSE frame exceeded 2 MiB");
        for (;;) {
          const boundary = buffer.search(/\r?\n\r?\n/);
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
          buffer = buffer.slice(boundary + separator.length);
          const data = block.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          const eventObject = asObject(event);
          if (eventObject?.type === "server.connected") {
            connected = true;
            if (reconnect) await reconcileAfterReconnect();
            resolveSseReady();
            continue;
          }
          await handleProviderEvent(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!connected) throw new Error("OpenCode SSE ended before server.connected");
  }

  const sseLoop = (async () => {
    while (!stopping && !hasExited()) {
      try {
        const response = await eventRequest();
        if (!response.ok) {
          const error = new OpenCodeHttpError(response.status, "/event", await responseDetail(response));
          if (!sseReadySettled && response.status >= 400 && response.status < 500) rejectSseReady(error);
          throw error;
        }
        await consumeSse(response, reconnects > 0);
        reconnects++;
        reportedDisconnect = false;
        if (!stopping && !hasExited()) {
          const backoff = Math.min(RECONNECT_MAX_MS, reconnectBaseMs * 2 ** Math.min(reconnects, 5));
          await delay(backoff, sseAbort.signal);
        }
      } catch (error) {
        if (stopping || hasExited() || sseAbort.signal.aborted) break;
        if (!sseReadySettled && error instanceof OpenCodeHttpError && error.status >= 400 && error.status < 500) {
          rejectSseReady(error);
          break;
        }
        if (sseReadySettled && !reportedDisconnect) {
          reportedDisconnect = true;
          ingestEvent({ type: "error", ts: Date.now(), message: `OpenCode SSE disconnected; reconnecting: ${error instanceof Error ? error.message : String(error)}` });
        }
        const backoff = Math.min(RECONNECT_MAX_MS, reconnectBaseMs * 2 ** Math.min(reconnects, 5));
        reconnects++;
        await delay(backoff, sseAbort.signal);
      }
    }
  })();

  try {
    await withTimeout(sseReady, startupTimeoutMs, "hsr opencode SSE subscription");
  } catch (error) {
    stopping = true;
    sseAbort.abort();
    await sseLoop.catch(() => undefined);
    await plumbing.stop().catch(() => undefined);
    throw new Error(`hsr opencode SSE setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const session: RunnerSession = {
    sessionId,
    tier: "server",
    pid: child.pid,
    async send(text: string, sendOpts?: RunnerSendOpts): Promise<void> {
      if (stopping || hasExited()) throw new Error("hsr opencode: server process has exited or is stopping");
      if (text.length === 0) throw new Error("hsr opencode: cannot send an empty prompt");
      if (sendOpts?.mode === "next-tool" && active) boundaryQueue.push({ text });
      else normalQueue.push({ text });
      drain();
    },
    async interrupt(): Promise<void> {
      if (stopping || hasExited() || !active) return;
      await jsonRequest(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }).catch((error) => {
        ingestEvent({ type: "error", ts: Date.now(), message: `OpenCode abort failed: ${error instanceof Error ? error.message : String(error)}` });
      });
    },
    async answer(requestId: string, answer: RunnerInputAnswer): Promise<void> {
      const pending = pendingInputs.get(requestId);
      if (!pending) throw new Error(`hsr opencode: no pending input for requestId ${requestId}`);
      if (pending.kind === "permission") {
        const text = typeof answer === "string" ? answer : JSON.stringify(answer);
        await jsonRequest(`/permission/${encodeURIComponent(requestId)}/reply`, {
          method: "POST",
          body: JSON.stringify({ reply: permissionReply(text) }),
        });
      } else {
        const text = typeof answer === "string" ? answer.trim().toLowerCase() : "";
        if (["reject", "cancel", "dismiss"].includes(text)) {
          await jsonRequest(`/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
        } else {
          await jsonRequest(`/question/${encodeURIComponent(requestId)}/reply`, {
            method: "POST",
            body: JSON.stringify({ answers: questionAnswers(answer, pending) }),
          });
        }
      }
      pendingInputs.delete(requestId);
    },
    events,
    snapshot,
    async stop(): Promise<void> {
      if (stopping) return plumbing.exitedPromise;
      stopping = true;
      normalQueue.length = 0;
      boundaryQueue.length = 0;
      if (active && !hasExited()) {
        await jsonRequest(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }).catch(() => undefined);
      }
      sseAbort.abort();
      await sseLoop.catch(() => undefined);
      await plumbing.stop();
    },
  };
  return session;
}

export const openCodeAdapter: RunnerAdapter = {
  harness: "opencode",
  tier(): RunnerTier {
    return "server";
  },
  start(opts): Promise<RunnerSession> {
    return startOpenCodeRunner(opts);
  },
};
