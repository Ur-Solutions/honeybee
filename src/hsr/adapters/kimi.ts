/** Production Kimi Code ACP stream adapter (`kimi acp`). */
import type { ChildProcess } from "node:child_process";
import type {
  RunnerAdapter,
  RunnerEvent,
  RunnerInputQuestion,
  RunnerOpts,
  RunnerSession,
  RunnerTier,
} from "../types.js";
import { harnessAllowance } from "../harness.js";
import { attachSessionPlumbing, spawnSessionChild } from "../sessionBase.js";
import {
  ACP_RPC_METHOD_NOT_FOUND,
  createAcpRpcPeer,
  type AcpRpcId,
  type AcpRpcPeer,
} from "./acpRpc.js";
import {
  kimiErrorToRunnerEvent,
  kimiHome,
  startKimiWireTelemetry,
  type KimiTelemetryTail,
} from "./kimiTelemetry.js";

type ObjectLike = Record<string, unknown>;
const ACP_PROTOCOL_VERSION = 1;
const INTERRUPT_SETTLE_TIMEOUT_MS = 30_000;

export const KIMI_MODELS = [
  "kimi-code/k3",
  "kimi-code/kimi-for-coding",
  "kimi-code/kimi-for-coding-highspeed",
] as const;
export type KimiModel = (typeof KIMI_MODELS)[number];
export const KIMI_MODES = ["default", "plan", "auto", "yolo"] as const;
export type KimiMode = (typeof KIMI_MODES)[number];

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

export function normalizeKimiModel(model: string): KimiModel {
  const normalized = model.includes("/") ? model : `kimi-code/${model}`;
  if ((KIMI_MODELS as readonly string[]).includes(normalized)) return normalized as KimiModel;
  throw new Error(`unsupported Kimi model ${model}; supported models: ${KIMI_MODELS.join(", ")}`);
}

export function kimiModelFromArgs(args: readonly string[]): KimiModel | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if ((arg === "--model" || arg === "-m") && args[index + 1]) value = args[++index];
    else if (arg.startsWith("--model=")) value = arg.slice("--model=".length);
  }
  return value ? normalizeKimiModel(value) : undefined;
}

/** Last mode flag wins, matching ordinary CLI option behavior. */
export function kimiModeFromArgs(args: readonly string[]): KimiMode {
  let mode: KimiMode = "default";
  for (const arg of args) {
    if (arg === "--plan") mode = "plan";
    else if (arg === "--auto") mode = "auto";
    else if (arg === "--yolo" || arg === "-y") mode = "yolo";
  }
  return mode;
}

export type KimiSpawnConfig = { command: string; args: string[]; env: Record<string, string> };

/** ACP owns model/mode configuration, so caller `--model`/`--yolo` args are never forwarded. */
export function buildKimiSpawn(opts: RunnerOpts): KimiSpawnConfig {
  const env = { ...opts.env };
  for (const key of harnessAllowance("kimi", opts.authKind ?? "subscription")?.scrubEnv ?? []) delete env[key];
  return { command: opts.command ?? "kimi", args: ["acp"], env };
}

/** Pure ACP update mapper. The live adapter de-duplicates repeated tool updates. */
export function kimiSessionUpdateToEvents(updateValue: unknown): RunnerEvent[] {
  const update = asObject(updateValue);
  if (!update) return [];
  const kind = stringField(update, "sessionUpdate", "session_update", "type");
  if (kind === "agent_message_chunk") {
    const content = asObject(update.content);
    const text = stringField(content, "text") ?? (typeof update.text === "string" ? update.text : undefined);
    return text ? [{ type: "text", ts: 0, text }] : [];
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const title = stringField(update, "title", "kind") ?? "Kimi tool";
    const input = update.rawInput ?? update.raw_input ?? update.input;
    return [{ type: "tool_use", ts: 0, tool: title, ...(input !== undefined ? { input } : {}) }];
  }
  return [];
}

type KimiPermissionOption = { optionId: string; name: string; kind?: string };

function permissionOptions(params: unknown): KimiPermissionOption[] {
  const options = asObject(params)?.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((raw): KimiPermissionOption[] => {
    const option = asObject(raw);
    const optionId = stringField(option, "optionId", "option_id");
    const name = stringField(option, "name");
    if (!optionId || !name) return [];
    return [{ optionId, name, ...(stringField(option, "kind") ? { kind: stringField(option, "kind") } : {}) }];
  });
}

function rawQuestions(value: unknown): RunnerInputQuestion[] {
  const questions = asObject(value)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((raw, index): RunnerInputQuestion[] => {
    const question = asObject(raw);
    const text = stringField(question, "question");
    if (!question || !text) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          const option = asObject(rawOption);
          const label = stringField(option, "label", "name");
          if (!label) return [];
          const description = stringField(option, "description");
          return [{ label, ...(description ? { description } : {}) }];
        })
      : undefined;
    return [{
      id: stringField(question, "id") ?? `q${index}`,
      ...(stringField(question, "header") ? { header: stringField(question, "header") } : {}),
      question: text,
      ...(options?.length ? { options } : {}),
      ...(typeof question.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}),
    }];
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

/** Map the ACP permission request to Honeybee's permission/question envelope. */
export function kimiPermissionRequestToNeedsInput(
  id: AcpRpcId,
  paramsValue: unknown,
  cachedTool?: { title?: string; input?: unknown },
): RunnerEvent {
  const params = asObject(paramsValue) ?? {};
  const toolCall = asObject(params.toolCall ?? params.tool_call);
  const title = cachedTool?.title ?? stringField(toolCall, "title", "kind") ?? "Kimi tool";
  const input = cachedTool?.input ?? toolCall?.rawInput ?? toolCall?.raw_input;
  const questions = rawQuestions(input);
  const options = permissionOptions(params);
  const isQuestion = questions.length > 0 || /ask.?user|question/i.test(title);
  const first = questions[0];
  const question = first?.question
    ?? toolCallText(toolCall)
    ?? (isQuestion ? `Kimi asks: ${title}` : `Kimi requests permission for ${title}`);
  const optionDetails = first?.options ?? options.map((option) => ({ label: option.name }));
  return {
    type: "needs_input",
    ts: 0,
    kind: isQuestion ? "question" : "permission",
    question,
    ...(optionDetails.length ? { options: optionDetails.map((option) => option.label), optionDetails } : {}),
    ...(questions.length ? { questions, multiSelect: first?.multiSelect } : {}),
    tool: title,
    input: paramsValue,
    requestId: String(id),
  };
}

/** Convert free-text `hive answer` input to ACP's selected/cancelled outcome. */
export function encodeKimiPermissionAnswer(params: unknown, answerValue: string): unknown {
  const options = permissionOptions(params);
  const answer = answerValue.trim();
  if (/^(?:cancel|cancelled|skip)$/i.test(answer)) return { outcome: { outcome: "cancelled" } };

  let supplied = answer;
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (typeof parsed === "string") supplied = parsed;
    else if (asObject(parsed)) {
      const first = Object.values(asObject(parsed)!).find((value) => typeof value === "string");
      if (typeof first === "string") supplied = first;
    }
  } catch {
    // Plain text is the normal CLI answer form.
  }

  let selected = options.find((option) => option.optionId.toLowerCase() === supplied.toLowerCase())
    ?? options.find((option) => option.name.toLowerCase() === supplied.toLowerCase());
  const ordinal = Number(supplied);
  if (!selected && Number.isInteger(ordinal) && ordinal >= 1) selected = options[ordinal - 1];
  if (!selected && /^(?:y|yes|allow|approve|approved|accept|ok|true)$/i.test(supplied)) {
    selected = options.find((option) => /allow_once/i.test(option.kind ?? ""))
      ?? options.find((option) => /allow/i.test(option.kind ?? ""))
      ?? options.find((option) => !/reject/i.test(option.kind ?? ""));
  }
  if (!selected && /^(?:n|no|deny|denied|reject|decline|false)$/i.test(supplied)) {
    selected = options.find((option) => /reject_once/i.test(option.kind ?? ""))
      ?? options.find((option) => /reject/i.test(option.kind ?? ""));
  }
  if (!selected) {
    throw new Error(`answer does not match a Kimi option: ${options.map((option) => option.name).join(", ") || "no options supplied"}`);
  }
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

type ToolState = { title?: string; input?: unknown };
type PendingInput = { id: AcpRpcId; params: unknown };

export type KimiRunnerDependencies = {
  /** Hermetic-test override. Production always uses buildKimiSpawn (`kimi acp`). */
  spawn?: KimiSpawnConfig;
  startTelemetry?: typeof startKimiWireTelemetry;
};

function sessionIdFromSetup(value: unknown): string | undefined {
  return stringField(value, "sessionId", "session_id");
}

function configOptions(value: unknown): ObjectLike[] {
  const options = asObject(value)?.configOptions ?? asObject(value)?.config_options;
  if (!Array.isArray(options)) return [];
  const result: ObjectLike[] = [];
  for (const option of options) {
    const object = asObject(option);
    if (object) result.push(object);
  }
  return result;
}

function configValue(setup: unknown, configId: string): string | undefined {
  const option = configOptions(setup).find((candidate) => stringField(candidate, "id", "configId", "config_id") === configId);
  return stringField(option, "currentValue", "current_value", "value");
}

async function setKimiConfig(peer: AcpRpcPeer, sessionId: string, configId: "model" | "mode", value: string): Promise<void> {
  await peer.request("session/set_config_option", { sessionId, configId, value });
}

function updatePayload(params: unknown): ObjectLike | undefined {
  return asObject(asObject(params)?.update);
}

function toolId(value: unknown): string | undefined {
  return stringField(value, "toolCallId", "tool_call_id");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Start one local Kimi ACP child and complete initialization/session setup. */
export async function startKimiRunner(opts: RunnerOpts, dependencies: KimiRunnerDependencies = {}): Promise<RunnerSession> {
  const spawn = dependencies.spawn ?? buildKimiSpawn(opts);
  const child: ChildProcess = await spawnSessionChild(spawn.command, spawn.args, {
    cwd: opts.cwd,
    env: spawn.env,
  });
  if (!child.stdin || !child.stdout) throw new Error("hsr kimi: ACP child has no stdio pipes");
  const peer = createAcpRpcPeer(child.stdin, child.stdout);
  // Kimi mirrors some diagnostics to stderr. ACP/wire supply the structured
  // form, but the pipe still must be drained or a long session can deadlock on
  // OS pipe backpressure.
  child.stderr?.resume();
  let telemetry: KimiTelemetryTail | undefined;
  let stopping = false;
  let active = false;
  let activeGeneration = 0;
  let activeSettlement: Promise<void> = Promise.resolve();
  let resolveActive: (() => void) | undefined;
  let sawTool = false;
  let sessionId = "";
  const queued: string[] = [];
  const heldUntilTool: string[] = [];
  const tools = new Map<string, ToolState>();
  const seenToolEvents = new Set<string>();
  const pendingInputs = new Map<string, PendingInput>();
  const recentSignals = new Map<string, number>();
  const cancelledGenerations = new Set<number>();

  const plumbing = attachSessionPlumbing(opts.bee, child, {
    onChildExit: () => {
      peer.dispose(new Error("Kimi ACP process exited"));
      void telemetry?.stop();
      if (active) settleTurn(activeGeneration, false);
    },
  });
  const { events, ingestEvent, snapshot, hasExited } = plumbing;

  const ingestSignal = (event: RunnerEvent): void => {
    if (event.type !== "error" && event.type !== "auth_expired" && event.type !== "exhausted") {
      ingestEvent(event);
      return;
    }
    const key = event.type === "error" ? `error:${event.message.replace(/^.*?failed:\s*/i, "")}` : event.type;
    const now = Date.now();
    if (now - (recentSignals.get(key) ?? 0) < 2_000) return;
    recentSignals.set(key, now);
    ingestEvent(event);
  };

  const releaseHeld = (): void => {
    if (heldUntilTool.length) queued.push(...heldUntilTool.splice(0));
  };

  const settleTurn = (generation: number, pumpNext = true): void => {
    if (!active || generation !== activeGeneration) return;
    active = false;
    releaseHeld();
    ingestEvent({ type: "turn_end", ts: 0, ...(sessionId ? { threadId: sessionId } : {}) });
    resolveActive?.();
    resolveActive = undefined;
    if (pumpNext && !stopping && !hasExited()) void pump();
  };

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

  peer.onNotification("session/update", (params) => {
    const update = updatePayload(params);
    if (!update) return;
    const kind = stringField(update, "sessionUpdate", "session_update", "type");
    const id = toolId(update);
    const state = rememberTool(update);
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (!sawTool) {
        sawTool = true;
        releaseHeld();
      }
      if (id && seenToolEvents.has(id)) return;
      if (id) seenToolEvents.add(id);
      const event = kimiSessionUpdateToEvents({ ...update, ...(state?.title ? { title: state.title } : {}), ...(state?.input !== undefined ? { rawInput: state.input } : {}) })[0];
      if (event) ingestEvent(event);
      return;
    }
    for (const event of kimiSessionUpdateToEvents(update)) ingestEvent(event);
  });
  peer.onNotificationCatchAll(() => undefined);

  peer.onServerRequest((method, id, params) => {
    if (method !== "session/request_permission") {
      peer.respondError(id, ACP_RPC_METHOD_NOT_FOUND, `unsupported ACP server request: ${method}`);
      return;
    }
    const toolCall = asObject(asObject(params)?.toolCall ?? asObject(params)?.tool_call);
    const cached = toolId(toolCall) ? tools.get(toolId(toolCall)!) : undefined;
    const event = kimiPermissionRequestToNeedsInput(id, params, cached);
    pendingInputs.set(String(id), { id, params });
    ingestEvent(event);
  });

  async function pump(): Promise<void> {
    if (active || stopping || hasExited()) return;
    const text = queued.shift();
    if (text === undefined) return;
    active = true;
    sawTool = false;
    seenToolEvents.clear();
    const generation = ++activeGeneration;
    activeSettlement = new Promise<void>((resolve) => {
      resolveActive = resolve;
    });
    ingestEvent({ type: "turn_start", ts: 0, ...(sessionId ? { threadId: sessionId } : {}) });
    void peer.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    }, { timeoutMs: 0 }).then(
      () => settleTurn(generation),
      (error: unknown) => {
        if (!stopping && !hasExited() && !cancelledGenerations.has(generation)) ingestSignal(kimiErrorToRunnerEvent(error));
        cancelledGenerations.delete(generation);
        settleTurn(generation);
      },
    );
  }

  const cancelPendingInputs = (): void => {
    for (const [requestId, pending] of pendingInputs) {
      pendingInputs.delete(requestId);
      peer.respond(pending.id, { outcome: { outcome: "cancelled" } });
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
    const initializedObject = asObject(initialized);
    const capabilities = asObject(initializedObject?.agentCapabilities ?? initializedObject?.agent_capabilities);
    if (opts.resume && opts.sessionId) {
      const sessionCapabilities = asObject(
        initializedObject?.sessionCapabilities
        ?? initializedObject?.session_capabilities
        ?? capabilities?.sessionCapabilities
        ?? capabilities?.session_capabilities,
      );
      if (capabilities?.loadSession !== true && capabilities?.load_session !== true && (!sessionCapabilities || !("resume" in sessionCapabilities))) {
        throw new Error("installed Kimi ACP does not advertise session/resume");
      }
    }

    const setupMethod = opts.resume && opts.sessionId ? "session/resume" : "session/new";
    const setup = await peer.request(setupMethod, {
      cwd: opts.cwd,
      mcpServers: [],
      ...(setupMethod === "session/resume" ? { sessionId: opts.sessionId } : {}),
    });
    sessionId = sessionIdFromSetup(setup) ?? (setupMethod === "session/resume" ? opts.sessionId ?? "" : "");
    if (!sessionId) throw new Error(`${setupMethod} returned no sessionId`);

    const requestedModel = opts.model ? normalizeKimiModel(opts.model) : kimiModelFromArgs(opts.args ?? []);
    const selectedModel = requestedModel ?? configValue(setup, "model");
    const selectedMode = kimiModeFromArgs(opts.args ?? []);
    if (!selectedModel) throw new Error("Kimi ACP session did not expose a model config option");
    if (!configOptions(setup).some((option) => stringField(option, "id", "configId", "config_id") === "mode")) {
      throw new Error("Kimi ACP session did not expose a mode config option");
    }
    // ACP ignores top-level Kimi model/yolo flags: configure both explicitly
    // after session/new or session/resume, before accepting the first prompt.
    await setKimiConfig(peer, sessionId, "model", selectedModel);
    await setKimiConfig(peer, sessionId, "mode", selectedMode);

    const startTelemetry = dependencies.startTelemetry ?? startKimiWireTelemetry;
    telemetry = startTelemetry({
      home: kimiHome(spawn.env),
      sessionId,
      onEvent: ingestSignal,
    });
  } catch (error) {
    peer.dispose(error instanceof Error ? error : new Error(String(error)));
    await plumbing.stop().catch(() => undefined);
    throw new Error(`hsr kimi ACP setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const session: RunnerSession = {
    sessionId,
    tier: "stream",
    pid: child.pid,
    async send(text, sendOpts): Promise<void> {
      if (hasExited()) throw new Error("hsr kimi: ACP process has exited");
      if (stopping) throw new Error("hsr kimi: session is stopping");
      if (sendOpts?.mode === "next-tool" && active && !sawTool) heldUntilTool.push(text);
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
          throw new Error(`hsr kimi: session/cancel did not settle within ${INTERRUPT_SETTLE_TIMEOUT_MS}ms`);
        }),
      ]);
      return { status: "interrupt_requested" } as const;
    },
    async answer(requestId, answer): Promise<void> {
      const pending = pendingInputs.get(requestId);
      if (!pending) throw new Error(`hsr kimi: no pending input for requestId ${requestId}`);
      const answerText = typeof answer === "string" ? answer : JSON.stringify(answer);
      const response = encodeKimiPermissionAnswer(pending.params, answerText);
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
      await telemetry?.stop().catch(() => undefined);
      peer.dispose(new Error("Kimi ACP session stopped"));
      await plumbing.stop();
    },
  };
  return session;
}

export const kimiAdapter: RunnerAdapter = {
  harness: "kimi",
  tier(): RunnerTier {
    return "stream";
  },
  start(opts): Promise<RunnerSession> {
    return startKimiRunner(opts);
  },
};
