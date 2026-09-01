/**
 * Long-lived title generator transports.
 *
 * Codex uses one warm app-server process and a fresh ephemeral thread for
 * every title. The Responses API uses Node's process-wide fetch pool, so its
 * HTTP/TLS connection can be reused without keeping an agent conversation.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { RecordNamingUsageInput } from "../../core/src/index.ts";
import type { ResolvedNamingConfig } from "./config.ts";
import {
  buildTitleContentPrompt,
  generateTitle,
  normalizeGeneratedTitle,
  TITLE_SYSTEM_PROMPT,
  type TitleContext,
} from "./naming.ts";

const DEFAULT_GENERATOR_TIMEOUT_MS = 20_000;
const MAX_PROTOCOL_BUFFER_CHARS = 4 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;

type JsonObject = Record<string, unknown>;

export interface TitleGeneratorServiceOptions {
  timeoutMs?: number;
  codexCommand?: string;
  codexArgs?: string[];
  fetchImpl?: typeof globalThis.fetch;
  log?: (op: string) => void;
  now?: () => number;
  recordUsage?: (usage: RecordNamingUsageInput) => void;
}

interface OpenAiUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

interface OpenAiRunResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: JsonObject;
  text: string;
  responseId: string | null;
  requestId: string | null;
  usage: OpenAiUsage | null;
}

export interface OpenAiNamingRates {
  inputNanoUsd: number;
  cachedInputNanoUsd: number;
  cacheWriteNanoUsd: number;
  outputNanoUsd: number;
}

/** Published standard-tier prices, converted to integer nano-USD per token. */
const OPENAI_NAMING_RATES: Readonly<Record<string, OpenAiNamingRates>> = {
  "gpt-5.6-sol": { inputNanoUsd: 4_000, cachedInputNanoUsd: 400, cacheWriteNanoUsd: 5_000, outputNanoUsd: 20_000 },
  "gpt-5.6-terra": { inputNanoUsd: 2_000, cachedInputNanoUsd: 200, cacheWriteNanoUsd: 2_500, outputNanoUsd: 12_000 },
  "gpt-5.6-luna": { inputNanoUsd: 200, cachedInputNanoUsd: 20, cacheWriteNanoUsd: 250, outputNanoUsd: 1_200 },
};

export function openAiNamingRates(model: string): OpenAiNamingRates | null {
  return OPENAI_NAMING_RATES[model] ?? null;
}

function integerField(object: JsonObject | null, key: string): number | null {
  const value = object?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function openAiUsage(body: JsonObject): OpenAiUsage | null {
  const usage = asObject(body.usage);
  if (!usage) return null;
  const inputDetails = asObject(usage.input_tokens_details);
  const outputDetails = asObject(usage.output_tokens_details);
  return {
    inputTokens: integerField(usage, "input_tokens"),
    cachedInputTokens: integerField(inputDetails, "cached_tokens"),
    cacheWriteInputTokens: integerField(inputDetails, "cache_write_tokens"),
    outputTokens: integerField(usage, "output_tokens"),
    reasoningTokens: integerField(outputDetails, "reasoning_tokens"),
    totalTokens: integerField(usage, "total_tokens"),
  };
}

export function estimateOpenAiNamingCostNanoUsd(
  usage: OpenAiUsage | null,
  rates: OpenAiNamingRates | null,
): number | null {
  if (!usage || !rates || usage.inputTokens == null || usage.outputTokens == null) return null;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cacheWrite = Math.min(usage.cacheWriteInputTokens ?? 0, Math.max(0, usage.inputTokens - cached));
  const uncached = Math.max(0, usage.inputTokens - cached - cacheWrite);
  return uncached * rates.inputNanoUsd
    + cached * rates.cachedInputNanoUsd
    + cacheWrite * rates.cacheWriteNanoUsd
    + usage.outputTokens * rates.outputNanoUsd;
}

type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingTurn = {
  parts: string[];
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function errorMessage(value: unknown, fallback: string): string {
  const object = asObject(value);
  const message = typeof object?.message === "string" ? object.message : fallback;
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

/** Minimal JSON-RPC peer dedicated to semantic titles. */
export class CodexNamingAppServer {
  private readonly timeoutMs: number;
  private readonly command: string;
  private readonly args: string[];
  private readonly log: (op: string) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextRequestId = 1;
  private buffer = "";
  private stderrTail = "";
  private pending = new Map<number, PendingRequest>();
  private turns = new Map<string, PendingTurn>();
  private queue: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(options: TitleGeneratorServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GENERATOR_TIMEOUT_MS;
    this.command = options.codexCommand ?? "codex";
    this.args = options.codexArgs ?? ["app-server"];
    this.log = options.log ?? (() => undefined);
  }

  async warm(): Promise<void> {
    await this.ensureStarted();
  }

  generate(prompt: string, config: ResolvedNamingConfig): Promise<string> {
    const run = this.queue.then(() => this.generateOnce(prompt, config));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  close(): void {
    this.closing = true;
    this.reset(new Error("Codex naming app-server closed"));
  }

  private async generateOnce(prompt: string, config: ResolvedNamingConfig): Promise<string> {
    // A process can disappear between the writability check and a request (for
    // example while Codex is updating). Title generation is side-effect free,
    // so one transparent restart is safer than waiting for the dispatcher's
    // longer retry backoff.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ensureStarted();
        mkdirSync(config.generatorCwd, { recursive: true });
        const started = await this.request("thread/start", {
          model: config.model,
          cwd: config.generatorCwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions: TITLE_SYSTEM_PROMPT,
          developerInstructions: TITLE_SYSTEM_PROMPT,
          ephemeral: true,
        });
        const threadId = asObject(started.thread)?.id;
        if (typeof threadId !== "string" || threadId.length === 0) {
          throw new Error("Codex naming app-server returned no thread id");
        }
        const completion = this.waitForTurn(threadId);
        const [, output] = await Promise.all([
          this.request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            effort: config.effort,
          }),
          completion,
        ]);
        return output;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.reset(failure);
        if (attempt === 1) throw failure;
      }
    }
    throw new Error("Codex naming app-server retry exhausted");
  }

  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    this.closing = false;
    this.starting = this.startProcess()
      .catch((error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.reset(failure);
        throw failure;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async startProcess(): Promise<void> {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    this.stderrTail = "";
    child.stdin.on("error", (error) => this.onExit(child, error));
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-2_000);
    });
    child.once("error", (error) => this.onExit(child, error));
    child.once("exit", (code, signal) => {
      const detail = this.stderrTail.trim();
      this.onExit(child, new Error(
        `Codex naming app-server exited${code === null ? "" : ` ${code}`}${signal ? ` (${signal})` : ""}${detail ? `: ${detail}` : ""}`,
      ));
    });
    await this.request("initialize", {
      clientInfo: { name: "hive-auto-title", title: "Hive auto-title", version: "1" },
      capabilities: null,
    });
    this.notify("initialized", {});
    this.log(`autoTitle.generator warm=codex-app-server pid=${child.pid ?? "unknown"}`);
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error("Codex naming app-server is not writable"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex naming app-server ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private waitForTurn(threadId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(threadId);
        reject(new Error(`Codex naming turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref();
      this.turns.set(threadId, { parts: [], resolve, reject, timer });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    if (this.buffer.length > MAX_PROTOCOL_BUFFER_CHARS) {
      this.reset(new Error("Codex naming app-server exceeded its protocol buffer"));
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        this.child?.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `unsupported server request: ${message.method}` },
        })}\n`);
        return;
      }
      this.onNotification(message.method, asObject(message.params) ?? {});
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new Error(errorMessage(message.error, "Codex naming app-server request failed")));
      return;
    }
    pending.resolve(asObject(message.result) ?? {});
  }

  private onNotification(method: string, params: JsonObject): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const turn = this.turns.get(threadId);
    if (method === "item/completed" && turn) {
      const item = asObject(params.item);
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        turn.parts.push(item.text.trim());
      }
      return;
    }
    if (method === "turn/completed" && turn) {
      this.turns.delete(threadId);
      clearTimeout(turn.timer);
      const completed = asObject(params.turn);
      if (completed?.status && completed.status !== "completed") {
        turn.reject(new Error(errorMessage(completed.error, `Codex naming turn ${String(completed.status)}`)));
        return;
      }
      const output = turn.parts.at(-1)?.trim();
      if (!output) {
        turn.reject(new Error("Codex naming app-server produced no agent message"));
        return;
      }
      turn.resolve(output);
      return;
    }
    if (method === "error" && turn) {
      this.turns.delete(threadId);
      clearTimeout(turn.timer);
      turn.reject(new Error(errorMessage(params.error ?? params, "Codex naming app-server error")));
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    // A killed process can emit its exit event after its replacement has
    // already initialized. Never let that stale event tear down the new peer.
    if (this.child !== child) return;
    this.reset(error);
  }

  private reset(error: Error): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGKILL");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.turns.clear();
  }
}

export class TitleGeneratorService {
  private readonly codex: CodexNamingAppServer;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly log: (op: string) => void;
  private readonly now: () => number;
  private readonly recordUsage: ((usage: RecordNamingUsageInput) => void) | null;

  constructor(options: TitleGeneratorServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GENERATOR_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.recordUsage = options.recordUsage ?? null;
    this.codex = new CodexNamingAppServer(options);
  }

  warm(config: ResolvedNamingConfig): void {
    if (!config.auto || config.command || config.backend !== "codex-app-server") return;
    void this.codex.warm().catch((error) => {
      this.log(`autoTitle.generator warm.error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    });
  }

  reconfigure(config: ResolvedNamingConfig): void {
    if (config.auto && !config.command && config.backend === "codex-app-server") this.warm(config);
    else this.codex.close();
  }

  async generate(context: TitleContext, config: ResolvedNamingConfig): Promise<string> {
    const startedAt = this.now();
    let api: OpenAiRunResult | null = null;
    let status: RecordNamingUsageInput["status"] = "failed";
    let failure: Error | null = null;
    try {
      let raw: string;
      if (config.command || config.backend === "claude-cli") {
        raw = await generateTitle(context, { config });
      } else {
        const prompt = buildTitleContentPrompt(context);
        if (config.backend === "openai-api") {
          api = await this.runOpenAi(prompt, config);
          if (!api.ok) {
            throw new Error(
              `OpenAI API naming failed (${api.status}): ${errorMessage(api.body.error, api.statusText)}`,
            );
          }
          raw = api.text;
        } else {
          raw = await this.codex.generate(prompt, config);
        }
      }
      const title = normalizeGeneratedTitle(raw);
      if (!title) throw new Error(`title generator produced no usable title (${config.backend})`);
      status = "succeeded";
      return title;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw failure;
    } finally {
      const completedAt = this.now();
      this.emitUsage({
        beeId: context.beeId ?? null,
        backend: config.command ? "custom-command" : config.backend,
        provider: config.tool === "claude" ? "anthropic" : "openai",
        model: config.model,
        status,
        latencyMs: Math.max(0, Math.round(completedAt - startedAt)),
        ...this.apiUsageFields(api, config.model),
        responseId: api?.responseId ?? null,
        requestId: api?.requestId ?? null,
        error: failure?.message ?? null,
        recordedAt: completedAt,
      });
    }
  }

  close(): void {
    this.codex.close();
  }

  private emitUsage(usage: RecordNamingUsageInput): void {
    const cost = usage.estimatedCostNanoUsd == null ? "unknown" : String(usage.estimatedCostNanoUsd);
    this.log(
      `autoTitle.usage backend=${usage.backend} model=${JSON.stringify(usage.model)} status=${usage.status} ` +
      `latencyMs=${usage.latencyMs} inputTokens=${usage.inputTokens ?? "unknown"} ` +
      `outputTokens=${usage.outputTokens ?? "unknown"} costNanoUsd=${cost}`,
    );
    if (!this.recordUsage) return;
    try {
      this.recordUsage(usage);
    } catch (error) {
      this.log(`autoTitle.usage.error ${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private apiUsageFields(api: OpenAiRunResult | null, model: string): Partial<RecordNamingUsageInput> {
    if (!api?.usage) return {};
    const rates = openAiNamingRates(model);
    return {
      ...api.usage,
      inputRateNanoUsd: rates?.inputNanoUsd ?? null,
      cachedInputRateNanoUsd: rates?.cachedInputNanoUsd ?? null,
      cacheWriteRateNanoUsd: rates?.cacheWriteNanoUsd ?? null,
      outputRateNanoUsd: rates?.outputNanoUsd ?? null,
      estimatedCostNanoUsd: estimateOpenAiNamingCostNanoUsd(api.usage, rates),
    };
  }

  private async runOpenAi(prompt: string, config: ResolvedNamingConfig): Promise<OpenAiRunResult> {
    if (!config.apiKey) throw new Error("OpenAI API naming requires a configured API key");
    const response = await this.fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        instructions: TITLE_SYSTEM_PROMPT,
        input: prompt,
        reasoning: { effort: config.effort },
        text: { verbosity: "low" },
        max_output_tokens: 24,
        store: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: JsonObject;
    try {
      body = asObject(await response.json()) ?? {};
    } catch {
      body = {};
    }
    const output = Array.isArray(body.output) ? body.output : [];
    const parts: string[] = [];
    for (const entry of output) {
      const message = asObject(entry);
      if (message?.type !== "message" || !Array.isArray(message.content)) continue;
      for (const content of message.content) {
        const item = asObject(content);
        if (item?.type === "output_text" && typeof item.text === "string") parts.push(item.text);
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
      text: parts.join("").trim(),
      responseId: typeof body.id === "string" ? body.id : null,
      requestId: response.headers.get("x-request-id"),
      usage: openAiUsage(body),
    };
  }
}
