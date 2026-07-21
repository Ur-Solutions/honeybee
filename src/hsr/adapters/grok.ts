/** Production Grok ACP stream adapter (`grok --no-auto-update agent stdio`). */
import type { ChildProcess } from "node:child_process";
import type {
  RunnerAdapter,
  RunnerEvent,
  RunnerInputOption,
  RunnerInputQuestion,
  RunnerOpts,
  RunnerSession,
  RunnerTier,
} from "../types.js";
import { harnessAllowance } from "../harness.js";
import { attachSessionPlumbing, spawnSessionChild } from "../sessionBase.js";
import {
  ACP_RPC_METHOD_NOT_FOUND,
  AcpRpcError,
  createAcpRpcPeer,
  type AcpRpcId,
  type AcpRpcPeer,
} from "./acpRpc.js";

type ObjectLike = Record<string, unknown>;
const ACP_PROTOCOL_VERSION = 1;
const INTERRUPT_SETTLE_TIMEOUT_MS = 30_000;

function asObject(value: unknown): ObjectLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectLike : undefined;
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  for (const key of keys) {
    const found = object[key];
    if (typeof found === "string" && found.length > 0) return found;
  }
  return undefined;
}

function numberField(value: unknown, ...keys: string[]): number | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  for (const key of keys) {
    const found = object[key];
    if (typeof found === "number" && Number.isFinite(found)) return found;
  }
  return undefined;
}

function optionValue(args: readonly string[], long: string, short?: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if ((arg === long || (short && arg === short)) && args[index + 1]) value = args[++index];
    else if (arg.startsWith(`${long}=`)) value = arg.slice(long.length + 1);
    else if (short && arg.startsWith(`${short}=`)) value = arg.slice(short.length + 1);
  }
  return value;
}

export function grokModelFromArgs(args: readonly string[]): string | undefined {
  return optionValue(args, "--model", "-m");
}

export function grokReasoningFromArgs(args: readonly string[]): string | undefined {
  return optionValue(args, "--reasoning-effort", "--effort");
}

/** ACP mode ids used by Grok's session/set_mode extension. */
export function grokModeFromArgs(args: readonly string[]): string | undefined {
  const permissionMode = optionValue(args, "--permission-mode");
  if (permissionMode === "plan" || permissionMode === "auto") return permissionMode;
  if (permissionMode === "default" || permissionMode === "acceptEdits" || permissionMode === "dontAsk") return "agent";
  return undefined; // bypassPermissions is represented by the supported --always-approve agent flag.
}

function hasAlwaysApprove(args: readonly string[]): boolean {
  return args.includes("--always-approve")
    || optionValue(args, "--permission-mode") === "bypassPermissions";
}

function supportedAgentExtras(args: readonly string[]): string[] {
  const valueFlags = new Set([
    "--agent-profile",
    "--plugin-dir",
    "--grok-ws-origin",
    "--grok-ws-url",
    "--cli-chat-proxy-base-url",
    "--xai-api-base-url",
    "--debug-file",
  ]);
  const extras: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--debug") {
      extras.push(arg);
      continue;
    }
    const equals = [...valueFlags].find((flag) => arg.startsWith(`${flag}=`));
    if (equals) {
      extras.push(arg);
      continue;
    }
    if (valueFlags.has(arg) && args[index + 1]) extras.push(arg, args[++index]!);
  }
  return extras;
}

export type GrokSpawnConfig = { command: string; args: string[]; env: Record<string, string> };

/** Keep only flags accepted by `grok agent`; ACP owns the session/tool protocol. */
export function buildGrokSpawn(opts: RunnerOpts): GrokSpawnConfig {
  const callerArgs = opts.args ?? [];
  const model = opts.model ?? grokModelFromArgs(callerArgs);
  const reasoning = grokReasoningFromArgs(callerArgs);
  const env = { ...opts.env };
  for (const key of harnessAllowance("grok", opts.authKind ?? "subscription")?.scrubEnv ?? []) delete env[key];
  const args = ["--no-auto-update", "agent", "--no-leader", ...supportedAgentExtras(callerArgs)];
  if (model) args.push("--model", model);
  if (reasoning) args.push("--reasoning-effort", reasoning);
  if (hasAlwaysApprove(callerArgs)) args.push("--always-approve");
  args.push("stdio");
  return { command: opts.command ?? "grok", args, env };
}

/** Pure ACP update mapper. The live adapter de-duplicates repeated tool updates. */
export function grokSessionUpdateToEvents(updateValue: unknown): RunnerEvent[] {
  const update = asObject(updateValue);
  if (!update) return [];
  const kind = stringField(update, "sessionUpdate", "session_update", "type");
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = asObject(update.content);
    const text = stringField(content, "text") ?? stringField(update, "text");
    if (!text) return [];
    return [{ type: kind === "agent_thought_chunk" ? "thought" : "text", ts: 0, text }];
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const title = stringField(update, "title", "kind") ?? "Grok tool";
    const input = update.rawInput ?? update.raw_input ?? update.input;
    return [{ type: "tool_use", ts: 0, tool: title, ...(input !== undefined ? { input } : {}) }];
  }
  return [];
}

function usageObject(value: unknown): ObjectLike | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  const direct = asObject(object.usage);
  if (direct) return direct;
  const meta = asObject(object._meta);
  const metaUsage = asObject(meta?.usage);
  if (metaUsage) return metaUsage;
  const update = asObject(object.update);
  const updateUsage = asObject(update?.usage);
  if (updateUsage) return updateUsage;
  const data = asObject(object.data);
  if (data) return usageObject(data);
  return undefined;
}

/** Exact per-prompt usage from Grok's `_meta.usage`/turn_completed envelope. */
export function grokUsageEvent(value: unknown): Extract<RunnerEvent, { type: "usage" }> | undefined {
  const usage = usageObject(value);
  if (!usage) return undefined;
  const inputTokens = numberField(usage, "inputTokens", "input_tokens");
  const outputTokens = numberField(usage, "outputTokens", "output_tokens");
  const explicitTotal = numberField(usage, "totalTokens", "total_tokens");
  const totalTokens = explicitTotal
    ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  const cacheReadTokens = numberField(usage, "cachedReadTokens", "cached_read_tokens", "cachedInputTokens", "cached_input_tokens");
  const reasoningTokens = numberField(usage, "reasoningTokens", "reasoning_tokens", "reasoningOutputTokens", "reasoning_output_tokens");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
    && cacheReadTokens === undefined && reasoningTokens === undefined) return undefined;
  return {
    type: "usage",
    ts: 0,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

type PermissionOption = { optionId: string; name: string; kind?: string };

function permissionOptions(params: unknown): PermissionOption[] {
  const options = asObject(params)?.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((raw): PermissionOption[] => {
    const option = asObject(raw);
    const optionId = stringField(option, "optionId", "option_id");
    const name = stringField(option, "name", "label");
    if (!optionId || !name) return [];
    const kind = stringField(option, "kind");
    return [{ optionId, name, ...(kind ? { kind } : {}) }];
  });
}

function toolCallText(toolCall: ObjectLike | undefined): string | undefined {
  const content = toolCall?.content;
  if (!Array.isArray(content)) return undefined;
  for (const itemValue of content) {
    const item = asObject(itemValue);
    const nested = asObject(item?.content);
    const text = stringField(nested, "text") ?? stringField(item, "text");
    if (text) return text;
  }
  return undefined;
}

export function grokPermissionRequestToNeedsInput(
  id: AcpRpcId,
  paramsValue: unknown,
  cachedTool?: { title?: string; input?: unknown },
): RunnerEvent {
  const params = asObject(paramsValue) ?? {};
  const toolCall = asObject(params.toolCall ?? params.tool_call);
  const title = cachedTool?.title ?? stringField(toolCall, "title", "kind") ?? "Grok tool";
  const input = cachedTool?.input ?? toolCall?.rawInput ?? toolCall?.raw_input;
  const options = permissionOptions(params);
  const question = toolCallText(toolCall) ?? `Grok requests permission for ${title}`;
  return {
    type: "needs_input",
    ts: 0,
    kind: "permission",
    question,
    ...(options.length ? {
      options: options.map((option) => option.name),
      optionDetails: options.map((option) => ({ label: option.name })),
    } : {}),
    tool: title,
    ...(input !== undefined ? { input } : { input: paramsValue }),
    requestId: String(id),
  };
}

export function encodeGrokPermissionAnswer(params: unknown, answerValue: string): unknown {
  const options = permissionOptions(params);
  const answer = answerValue.trim();
  if (/^(?:cancel|cancelled|skip)$/i.test(answer)) return { outcome: { outcome: "cancelled" } };
  let supplied = answer;
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (typeof parsed === "string") supplied = parsed;
  } catch {
    // Plain text is the normal CLI answer form.
  }
  let selected = options.find((option) => option.optionId.toLowerCase() === supplied.toLowerCase())
    ?? options.find((option) => option.name.toLowerCase() === supplied.toLowerCase());
  const ordinal = Number(supplied);
  if (!selected && Number.isInteger(ordinal) && ordinal >= 1) selected = options[ordinal - 1];
  if (!selected && /^(?:y|yes|allow|approve|accept|ok|true)$/i.test(supplied)) {
    selected = options.find((option) => /allow_once/i.test(option.kind ?? ""))
      ?? options.find((option) => /allow/i.test(option.kind ?? ""))
      ?? options.find((option) => !/reject|deny/i.test(option.kind ?? ""));
  }
  if (!selected && /^(?:n|no|deny|reject|decline|false)$/i.test(supplied)) {
    selected = options.find((option) => /reject_once/i.test(option.kind ?? ""))
      ?? options.find((option) => /reject|deny/i.test(option.kind ?? ""));
  }
  if (!selected) throw new Error(`answer does not match a Grok permission option: ${options.map((option) => option.name).join(", ") || "no options supplied"}`);
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

function questionOptions(value: unknown): RunnerInputOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): RunnerInputOption[] => {
    const option = asObject(raw);
    const label = stringField(option, "label", "name");
    if (!label) return [];
    const description = stringField(option, "description");
    const preview = stringField(option, "preview");
    return [{ label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) }];
  });
}

export function grokInputQuestions(paramsValue: unknown): RunnerInputQuestion[] {
  const questions = asObject(paramsValue)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((raw, index): RunnerInputQuestion[] => {
    const question = asObject(raw);
    const text = stringField(question, "question");
    if (!text) return [];
    const options = questionOptions(question?.options);
    return [{
      id: `q${index}`,
      question: text,
      ...(options.length ? { options } : {}),
      ...(typeof question?.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}),
    }];
  });
}

export function grokQuestionRequestToNeedsInput(id: AcpRpcId, paramsValue: unknown): RunnerEvent {
  const questions = grokInputQuestions(paramsValue);
  const first = questions[0];
  return {
    type: "needs_input",
    ts: 0,
    kind: "question",
    question: first?.question ?? "Grok asks for input",
    ...(first?.options?.length ? {
      options: first.options.map((option) => option.label),
      optionDetails: first.options,
    } : {}),
    ...(questions.length ? { questions, multiSelect: first?.multiSelect } : {}),
    tool: "ask_user_question",
    input: paramsValue,
    requestId: String(id),
  };
}

function answerSource(parsed: unknown, question: RunnerInputQuestion, index: number, count: number): unknown {
  if (Array.isArray(parsed)) return parsed[index];
  const object = asObject(parsed);
  const answers = asObject(object?.answers) ?? object;
  if (answers) return answers[question.id ?? `q${index}`] ?? answers[question.question] ?? answers[String(index)];
  return count === 1 ? parsed : undefined;
}

function selectionsForQuestion(question: RunnerInputQuestion, value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string" && question.multiSelect
      ? (question.options?.some((option) => option.label.toLowerCase() === value.trim().toLowerCase()) ? [value] : value.split(","))
      : [value];
  if (!question.multiSelect && rawValues.length > 1) throw new Error(`${question.id}: only one option may be selected`);
  const selections: string[] = [];
  for (const raw of rawValues) {
    if (typeof raw !== "string" && typeof raw !== "number") throw new Error(`${question.id}: answer must be text or an option number`);
    const supplied = String(raw).trim();
    if (!supplied) throw new Error(`${question.id}: answer is empty`);
    const options = question.options ?? [];
    let selected = options.find((option) => option.label.toLowerCase() === supplied.toLowerCase());
    const ordinal = Number(supplied);
    if (!selected && Number.isInteger(ordinal) && ordinal >= 1) selected = options[ordinal - 1];
    if (options.length && !selected) throw new Error(`${question.id}: answer does not match: ${options.map((option) => option.label).join(", ")}`);
    const label = selected?.label ?? supplied;
    if (!selections.includes(label)) selections.push(label);
  }
  return selections;
}

/** Map Honeybee's string answer into Grok's internally-tagged extension response. */
export function encodeGrokQuestionAnswer(paramsValue: unknown, answerValue: string): unknown {
  const answer = answerValue.trim();
  if (/^(?:cancel|cancelled|skip)$/i.test(answer)) return { outcome: "cancelled" };
  const questions = grokInputQuestions(paramsValue);
  if (!questions.length) throw new Error("Grok question request contained no questions");
  let parsed: unknown = answer;
  try {
    parsed = JSON.parse(answer) as unknown;
  } catch {
    // Plain text is valid for one question.
  }
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const source = answerSource(parsed, question, index, questions.length);
    if (source === undefined) throw new Error(`missing answer for ${question.id}: ${question.question}`);
    answers[question.question] = selectionsForQuestion(question, source).join(", ");
  }
  return { outcome: "accepted", answers, annotations: {} };
}

function errorParts(error: unknown): string[] {
  const parts: string[] = [];
  if (error instanceof Error && error.message) parts.push(error.message);
  const object = asObject(error);
  const data = asObject(error instanceof AcpRpcError ? error.data : object?.data);
  for (const value of [stringField(data, "code"), stringField(data, "message", "detail"), stringField(asObject(data?.error), "code"), stringField(asObject(data?.error), "message", "detail")]) {
    if (value && !parts.some((part) => part.includes(value))) parts.push(value);
  }
  return parts;
}

function resetHint(error: unknown): string | undefined {
  const object = asObject(error);
  const data = asObject(error instanceof AcpRpcError ? error.data : object?.data);
  const reset = data?.resetsAt ?? data?.resetAt ?? data?.reset_at ?? data?.resets_at;
  if (typeof reset === "number" && Number.isFinite(reset)) {
    const millis = reset < 10_000_000_000 ? reset * 1000 : reset;
    return new Date(millis).toISOString();
  }
  if (typeof reset === "string" && reset) return reset;
  const retry = data?.retryAfter ?? data?.retry_after;
  if (typeof retry === "number" || typeof retry === "string") return `retry after ${String(retry)}`;
  return errorParts(error).join(": ") || undefined;
}

function isAuthFailure(error: unknown): boolean {
  const text = errorParts(error).join(" ");
  return /\b401\b|unauthori[sz]ed|auth(?:entication)?[._ -]?(?:required|expired|failed|failure)|(?:sign|log)[ -]?in required|login required|refresh(?: token)?[._ -]?(?:failed|failure)|failed to refresh|token (?:is |has )?expired|no oauth credentials/i.test(text);
}

/** Usage is emitted first even when the prompt itself failed. */
export function grokPromptErrorToEvents(error: unknown, authKind: "subscription" | "api-key" = "subscription"): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  const usage = grokUsageEvent(error instanceof AcpRpcError ? error.data : error);
  if (usage) events.push(usage);
  const code = error instanceof AcpRpcError ? error.code : numberField(error, "code");
  if (code === -32003) {
    events.push({ type: "exhausted", ts: 0, ...(resetHint(error) ? { resetHint: resetHint(error) } : {}) });
    return events;
  }
  if (isAuthFailure(error)) {
    const cause = errorParts(error).join(": ") || "authentication expired";
    const action = authKind === "api-key"
      ? "Verify XAI_API_KEY (or GROK_CODE_XAI_API_KEY), then resume the bee."
      : "Run grok login (or hive login for the bound Grok account), then resume the bee.";
    events.push({ type: "auth_expired", ts: 0, requiresLogin: true, detail: `${cause}. ${action}` });
    return events;
  }
  events.push({ type: "error", ts: 0, message: errorParts(error).join(": ") || "Grok ACP prompt failed" });
  return events;
}

type ToolState = { title?: string; input?: unknown };
type PendingInput = { id: AcpRpcId; params: unknown; kind: "permission" | "question" };
type HeldSend = { text: string; afterBoundary: number };

export type GrokRunnerDependencies = {
  /** Hermetic-test override. Production always uses buildGrokSpawn. */
  spawn?: GrokSpawnConfig;
};

function updatePayload(params: unknown): ObjectLike | undefined {
  return asObject(asObject(params)?.update);
}

function toolId(value: unknown): string | undefined {
  return stringField(value, "toolCallId", "tool_call_id");
}

function sessionIdFromSetup(value: unknown): string | undefined {
  return stringField(value, "sessionId", "session_id");
}

function currentModelId(value: unknown): string | undefined {
  const object = asObject(value);
  const models = asObject(object?.models) ?? asObject(asObject(object?._meta)?.modelState);
  return stringField(models, "currentModelId", "current_model_id");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function authMethodId(initialized: unknown, authKind: "subscription" | "api-key"): string {
  const object = asObject(initialized) ?? {};
  const methods = Array.isArray(object.authMethods) ? object.authMethods : [];
  const ids = methods.flatMap((method) => stringField(method, "id") ? [stringField(method, "id")!] : []);
  const wanted = authKind === "api-key" ? "xai.api_key" : "cached_token";
  if (!ids.includes(wanted)) {
    const action = authKind === "api-key"
      ? "set XAI_API_KEY (or configure an API key in GROK_HOME/config.toml)"
      : "run grok login or activate a Honeybee Grok account into GROK_HOME";
    throw new Error(`Grok ACP did not advertise ${wanted} authentication; ${action}`);
  }
  return wanted;
}

/** Start one local Grok ACP child and complete auth/session setup. */
export async function startGrokRunner(opts: RunnerOpts, dependencies: GrokRunnerDependencies = {}): Promise<RunnerSession> {
  const spawn = dependencies.spawn ?? buildGrokSpawn(opts);
  const child: ChildProcess = await spawnSessionChild(spawn.command, spawn.args, { cwd: opts.cwd, env: spawn.env });
  if (!child.stdin || !child.stdout) throw new Error("hsr grok: ACP child has no stdio pipes");
  const peer = createAcpRpcPeer(child.stdin, child.stdout);
  child.stderr?.resume();
  const authKind = opts.authKind ?? "subscription";
  let stopping = false;
  let active = false;
  let activeGeneration = 0;
  let activeSettlement: Promise<void> = Promise.resolve();
  let resolveActive: (() => void) | undefined;
  let activeUsageFallback: RunnerEvent | undefined;
  let sessionId = "";
  let toolBoundary = 0;
  let interjectChain: Promise<void> = Promise.resolve();
  const queued: string[] = [];
  let heldUntilTool: HeldSend[] = [];
  const tools = new Map<string, ToolState>();
  const seenToolEvents = new Set<string>();
  const pendingInputs = new Map<string, PendingInput>();
  const cancelledGenerations = new Set<number>();

  const plumbing = attachSessionPlumbing(opts.bee, child, {
    onChildExit: () => {
      peer.dispose(new Error("Grok ACP process exited"));
      if (active) settleTurn(activeGeneration, undefined, undefined, false);
    },
  });
  const { events, ingestEvent, snapshot, hasExited } = plumbing;

  const rememberTool = (update: ObjectLike): ToolState | undefined => {
    const id = toolId(update);
    if (!id) return undefined;
    const previous = tools.get(id) ?? {};
    const title = stringField(update, "title", "kind") ?? previous.title;
    const input = update.rawInput ?? update.raw_input ?? update.input ?? previous.input;
    const next = { ...(title ? { title } : {}), ...(input !== undefined ? { input } : {}) };
    tools.set(id, next);
    return next;
  };

  const enqueueHeldAtTurnEnd = (): void => {
    if (!heldUntilTool.length) return;
    queued.push(...heldUntilTool.map((held) => held.text));
    heldUntilTool = [];
  };

  const interjectAtBoundary = (): void => {
    const ready = heldUntilTool.filter((held) => held.afterBoundary < toolBoundary);
    if (!ready.length) return;
    heldUntilTool = heldUntilTool.filter((held) => held.afterBoundary >= toolBoundary);
    for (const held of ready) {
      interjectChain = interjectChain.then(async () => {
        if (stopping || hasExited()) return;
        try {
          await peer.request("_x.ai/interject", { sessionId, text: held.text });
        } catch {
          // Older Grok builds may not expose interject. Preserve the send by
          // falling back to the ordinary serialized prompt queue.
          queued.push(held.text);
          if (!active) void pump();
        }
      });
    }
  };

  const settleTurn = (generation: number, result?: unknown, error?: unknown, pumpNext = true): void => {
    if (!active || generation !== activeGeneration) return;
    const directUsage = error instanceof AcpRpcError ? grokUsageEvent(error.data) : grokUsageEvent(result);
    if (directUsage) ingestEvent(directUsage);
    else if (activeUsageFallback) ingestEvent(activeUsageFallback);
    if (error !== undefined && !cancelledGenerations.has(generation) && !stopping && !hasExited()) {
      const classified = grokPromptErrorToEvents(error, authKind);
      for (const event of classified) {
        if (event.type !== "usage" || !directUsage) ingestEvent(event);
      }
    }
    cancelledGenerations.delete(generation);
    active = false;
    activeUsageFallback = undefined;
    enqueueHeldAtTurnEnd();
    ingestEvent({ type: "turn_end", ts: 0, ...(sessionId ? { threadId: sessionId } : {}) });
    resolveActive?.();
    resolveActive = undefined;
    if (pumpNext && !stopping && !hasExited()) void pump();
  };

  const processUpdate = (params: unknown, transcript: boolean): void => {
    const update = updatePayload(params);
    if (!update) return;
    const usage = grokUsageEvent(update);
    if (usage && active) activeUsageFallback = usage;
    if (!transcript) return;
    const kind = stringField(update, "sessionUpdate", "session_update", "type");
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = toolId(update);
      const state = rememberTool(update);
      const firstForTool = id ? !seenToolEvents.has(id) : kind === "tool_call";
      if (!firstForTool) return;
      if (id) seenToolEvents.add(id);
      toolBoundary += 1;
      interjectAtBoundary();
      const event = grokSessionUpdateToEvents({
        ...update,
        ...(state?.title ? { title: state.title } : {}),
        ...(state?.input !== undefined ? { rawInput: state.input } : {}),
      })[0];
      if (event) ingestEvent(event);
      return;
    }
    for (const event of grokSessionUpdateToEvents(update)) ingestEvent(event);
  };

  peer.onNotification("session/update", (params) => processUpdate(params, true));
  peer.onNotificationCatchAll((method, params) => {
    if (method === "_x.ai/session/update" || method === "x.ai/session/update") processUpdate(params, false);
  });

  peer.onServerRequest((method, id, params) => {
    if (method === "session/request_permission") {
      const toolCall = asObject(asObject(params)?.toolCall ?? asObject(params)?.tool_call);
      const cached = toolId(toolCall) ? tools.get(toolId(toolCall)!) : undefined;
      pendingInputs.set(String(id), { id, params, kind: "permission" });
      ingestEvent(grokPermissionRequestToNeedsInput(id, params, cached));
      return;
    }
    if (method === "x.ai/ask_user_question" || method === "_x.ai/ask_user_question") {
      pendingInputs.set(String(id), { id, params, kind: "question" });
      ingestEvent(grokQuestionRequestToNeedsInput(id, params));
      return;
    }
    peer.respondError(id, ACP_RPC_METHOD_NOT_FOUND, `unsupported ACP server request: ${method}`);
  });

  async function pump(): Promise<void> {
    if (active || stopping || hasExited()) return;
    const text = queued.shift();
    if (text === undefined) return;
    active = true;
    activeUsageFallback = undefined;
    seenToolEvents.clear();
    toolBoundary = 0;
    const generation = ++activeGeneration;
    activeSettlement = new Promise<void>((resolve) => {
      resolveActive = resolve;
    });
    ingestEvent({ type: "turn_start", ts: 0, ...(sessionId ? { threadId: sessionId } : {}) });
    void peer.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    }, { timeoutMs: 0 }).then(
      (result) => settleTurn(generation, result),
      (error: unknown) => settleTurn(generation, undefined, error),
    );
  }

  const cancelPendingInputs = (): void => {
    for (const [requestId, pending] of pendingInputs) {
      pendingInputs.delete(requestId);
      peer.respond(pending.id, pending.kind === "question"
        ? { outcome: "cancelled" }
        : { outcome: { outcome: "cancelled" } });
    }
  };

  try {
    const initialized = await peer.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "Honeybee", version: "1" },
    });
    await peer.request("authenticate", { methodId: authMethodId(initialized, authKind) });
    const capabilities = asObject(asObject(initialized)?.agentCapabilities ?? asObject(initialized)?.agent_capabilities);
    if (opts.resume && opts.sessionId && capabilities?.loadSession !== true && capabilities?.load_session !== true) {
      throw new Error("installed Grok ACP does not advertise session/load");
    }
    const setupMethod = opts.resume && opts.sessionId ? "session/load" : "session/new";
    const setup = await peer.request(setupMethod, {
      cwd: opts.cwd,
      mcpServers: [],
      ...(setupMethod === "session/load" ? { sessionId: opts.sessionId } : {}),
    });
    sessionId = sessionIdFromSetup(setup) ?? (setupMethod === "session/load" ? opts.sessionId ?? "" : "");
    if (!sessionId) throw new Error(`${setupMethod} returned no sessionId`);

    const requestedModel = opts.model ?? grokModelFromArgs(opts.args ?? []);
    const requestedReasoning = grokReasoningFromArgs(opts.args ?? []);
    if (requestedModel || requestedReasoning) {
      const modelId = requestedModel ?? currentModelId(setup) ?? currentModelId(initialized);
      if (!modelId) throw new Error("Grok ACP did not expose a current model for reasoning configuration");
      await peer.request("session/set_model", {
        sessionId,
        modelId,
        ...(requestedReasoning ? { _meta: { reasoningEffort: requestedReasoning } } : {}),
      });
    }
    const requestedMode = grokModeFromArgs(opts.args ?? []);
    if (requestedMode) await peer.request("session/set_mode", { sessionId, modeId: requestedMode });
  } catch (error) {
    peer.dispose(error instanceof Error ? error : new Error(String(error)));
    await plumbing.stop().catch(() => undefined);
    throw new Error(`hsr grok ACP setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const session: RunnerSession = {
    sessionId,
    tier: "stream",
    pid: child.pid,
    async send(text, sendOpts): Promise<void> {
      if (hasExited()) throw new Error("hsr grok: ACP process has exited");
      if (stopping) throw new Error("hsr grok: session is stopping");
      if (sendOpts?.mode === "next-tool" && active) heldUntilTool.push({ text, afterBoundary: toolBoundary });
      else queued.push(text);
      void pump();
    },
    async interrupt() {
      if (hasExited()) return { status: "already_idle" } as const;
      cancelPendingInputs();
      if (!active) return { status: "already_idle" } as const;
      const settlement = activeSettlement;
      const generation = activeGeneration;
      cancelledGenerations.add(generation);
      peer.notify("session/cancel", { sessionId });
      await Promise.race([
        settlement,
        delay(INTERRUPT_SETTLE_TIMEOUT_MS).then(() => {
          throw new Error(`hsr grok: session/cancel did not settle within ${INTERRUPT_SETTLE_TIMEOUT_MS}ms`);
        }),
      ]);
      return { status: "interrupt_requested" } as const;
    },
    async answer(requestId, answer): Promise<void> {
      const pending = pendingInputs.get(requestId);
      if (!pending) throw new Error(`hsr grok: no pending input for requestId ${requestId}`);
      if (typeof answer !== "string") {
        throw new Error("hsr grok: native answer matrices are only supported by OpenCode");
      }
      const response = pending.kind === "question"
        ? encodeGrokQuestionAnswer(pending.params, answer)
        : encodeGrokPermissionAnswer(pending.params, answer);
      pendingInputs.delete(requestId);
      peer.respond(pending.id, response);
    },
    events,
    snapshot,
    async stop(): Promise<void> {
      if (stopping) return plumbing.exitedPromise;
      stopping = true;
      cancelPendingInputs();
      if (active && !hasExited()) {
        cancelledGenerations.add(activeGeneration);
        peer.notify("session/cancel", { sessionId });
        await Promise.race([activeSettlement, delay(2_000)]).catch(() => undefined);
      }
      peer.dispose(new Error("Grok ACP session stopped"));
      // Dispose before awaiting interjections: a Grok build that accepted the
      // extension request but never replies must not turn stop() into a 30s
      // request-timeout wait. Disposing rejects any pending interject now.
      await interjectChain.catch(() => undefined);
      await plumbing.stop();
    },
  };
  return session;
}

export const grokAdapter: RunnerAdapter = {
  harness: "grok",
  tier(): RunnerTier {
    return "stream";
  },
  start(opts): Promise<RunnerSession> {
    return startGrokRunner(opts);
  },
};
