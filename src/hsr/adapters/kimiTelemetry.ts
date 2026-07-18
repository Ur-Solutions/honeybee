/**
 * Kimi's ACP stream does not currently publish usage or rate-limit updates.
 * This module tails only native `usage.record` and structured error records;
 * conversation/content records are deliberately ignored so ACP remains the
 * single transcript source.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RunnerEvent } from "../types.js";

type ObjectLike = Record<string, unknown>;
const MAX_TAIL_READ_BYTES = 1024 * 1024;
const MAX_WIRE_LINE_BYTES = 1024 * 1024;

function asObject(value: unknown): ObjectLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectLike : undefined;
}

function numberField(object: ObjectLike, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringField(object: ObjectLike | undefined, ...keys: string[]): string | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function errorShape(value: unknown): { code?: string; message: string; statusCode?: number; resetHint?: string } {
  const outer = asObject(value) ?? {};
  const nested = asObject(outer.error) ?? asObject(outer.data) ?? outer;
  const details = asObject(nested.details) ?? asObject(outer.details);
  const code = stringField(nested, "code", "errorCode", "error_code") ?? stringField(outer, "code", "errorCode", "error_code");
  const message = stringField(nested, "message", "detail", "reason")
    ?? stringField(outer, "message", "detail", "reason")
    ?? "Kimi request failed";
  const statusCode = numberField(nested, "statusCode", "status_code", "status")
    ?? numberField(outer, "statusCode", "status_code", "status");
  const resetHint = stringField(details, "resetHint", "resetAt", "retryAfter", "retry_after")
    ?? stringField(nested, "resetHint", "resetAt", "retryAfter", "retry_after");
  return { ...(code ? { code } : {}), message, ...(statusCode !== undefined ? { statusCode } : {}), ...(resetHint ? { resetHint } : {}) };
}

/** Classify an ACP or native Kimi error without exposing arbitrary detail blobs. */
export function kimiErrorToRunnerEvent(value: unknown): RunnerEvent {
  const error = errorShape(value);
  const text = `${error.code ?? ""} ${error.message}`.toLowerCase();
  if (
    error.statusCode === 401 || error.statusCode === 403 ||
    /(?:^|[._-])auth(?:[._-]|$)|login_required|unauthori[sz]ed|credential.*(?:expired|invalid)|token.*expired/.test(text)
  ) {
    return { type: "auth_expired", ts: 0 };
  }
  if (
    error.statusCode === 429 ||
    /rate[_ .-]?limit|usage[_ .-]?limit|quota.*(?:reached|exceeded|exhausted)|provider\.rate_limit/.test(text)
  ) {
    const hintFromMessage = error.message.match(/\b(?:retry|reset|try again)\b[^.\n]{0,100}/i)?.[0]?.trim();
    return { type: "exhausted", ts: 0, ...(error.resetHint || hintFromMessage ? { resetHint: error.resetHint ?? hintFromMessage } : {}) };
  }
  return { type: "error", ts: 0, message: error.code ? `[${error.code}] ${error.message}` : error.message };
}

/** Pure parser for one native Kimi `wire.jsonl` record. */
export function parseKimiWireRecord(line: string): RunnerEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const record = asObject(parsed);
  if (!record) return [];
  const type = stringField(record, "type");
  if (type === "usage.record") {
    const usage = asObject(record.usage);
    if (!usage) return [];
    const inputOther = numberField(usage, "inputOther", "input_other") ?? 0;
    const inputCacheRead = numberField(usage, "inputCacheRead", "input_cache_read") ?? 0;
    const inputCacheCreation = numberField(usage, "inputCacheCreation", "input_cache_creation") ?? 0;
    const directInput = numberField(usage, "inputTokens", "input_tokens");
    const inputTokens = directInput ?? inputOther + inputCacheRead + inputCacheCreation;
    const outputTokens = numberField(usage, "output", "outputTokens", "output_tokens") ?? 0;
    return [{ type: "usage", ts: 0, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }];
  }

  // Do not parse context/content/turn transcript records. Only terminal error
  // record types are telemetry. Retry-attempt records intentionally stay quiet.
  if (type === "error" || type === "turn.error" || type === "turn.failed" || type === "provider.error") {
    return [kimiErrorToRunnerEvent(record)];
  }
  if ((type === "turn.ended" || type === "turn.end") && record.error) {
    return [kimiErrorToRunnerEvent(record.error)];
  }
  const event = asObject(record.event);
  const eventType = stringField(event, "type");
  if (event && (eventType === "error" || eventType === "turn.error" || eventType === "turn.failed")) {
    return [kimiErrorToRunnerEvent(event)];
  }
  if (event?.error && (eventType === "turn.ended" || eventType === "turn.end" || eventType === "step.end")) {
    return [kimiErrorToRunnerEvent(event.error)];
  }
  return [];
}

export function kimiHome(env: Record<string, string>): string {
  return env.KIMI_CODE_HOME ?? join(env.HOME ?? homedir(), ".kimi-code");
}

/** Locate `<home>/sessions/<cwd-bucket>/<session>/agents/main/wire.jsonl`. */
export async function findKimiWirePath(home: string, sessionId: string): Promise<string | undefined> {
  if (!sessionId || basename(sessionId) !== sessionId || sessionId === "." || sessionId === "..") return undefined;
  let buckets: string[];
  try {
    buckets = await readdir(join(home, "sessions"));
  } catch {
    return undefined;
  }
  for (const bucket of buckets) {
    const candidate = join(home, "sessions", bucket, sessionId, "agents", "main", "wire.jsonl");
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Session ids are unique; keep looking through cwd buckets.
    }
  }
  return undefined;
}

export type KimiTelemetryTail = {
  pollNow(): Promise<void>;
  stop(): Promise<void>;
};

/** Polling tailer; tolerant of delayed creation, truncation, rotation, and partial lines. */
export function startKimiWireTelemetry(opts: {
  home: string;
  sessionId: string;
  onEvent(event: RunnerEvent): void;
  pollMs?: number;
}): KimiTelemetryTail {
  let wirePath: string | undefined;
  let position = 0;
  let partial = "";
  let discardUntilNewline = false;
  let fileIdentity: string | undefined;
  let initialLookupDone = false;
  let skipExistingOnFirstOpen = false;
  let stopped = false;
  let polling: Promise<void> | undefined;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (!wirePath) {
      wirePath = await findKimiWirePath(opts.home, opts.sessionId);
      if (!initialLookupDone) {
        initialLookupDone = true;
        skipExistingOnFirstOpen = wirePath !== undefined;
      }
    }
    if (!wirePath) return;
    let info;
    try {
      info = await stat(wirePath);
    } catch {
      wirePath = undefined;
      position = 0;
      partial = "";
      discardUntilNewline = false;
      fileIdentity = undefined;
      return;
    }
    const identity = `${info.dev}:${info.ino}`;
    if (fileIdentity !== undefined && identity !== fileIdentity) {
      // Replacement/rotation: do not replay the replacement's existing body.
      fileIdentity = identity;
      position = info.size;
      partial = "";
      discardUntilNewline = false;
      return;
    }
    fileIdentity = identity;
    if (skipExistingOnFirstOpen) {
      skipExistingOnFirstOpen = false;
      // The session was already present (resume, or setup records from new).
      // Start at EOF so historical usage/errors are never replayed.
      position = info.size;
      return;
    }
    if (info.size < position) {
      // Truncated/rotated: skip the replacement's existing body.
      position = info.size;
      partial = "";
      discardUntilNewline = false;
      return;
    }
    if (info.size === position) return;
    const length = Math.min(info.size - position, MAX_TAIL_READ_BYTES);
    const handle = await open(wirePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      position += bytesRead;
      let chunk = buffer.subarray(0, bytesRead).toString("utf8");
      if (discardUntilNewline) {
        const newline = chunk.indexOf("\n");
        if (newline === -1) return;
        discardUntilNewline = false;
        chunk = chunk.slice(newline + 1);
      }
      const body = partial + chunk;
      const lines = body.split("\n");
      partial = lines.pop() ?? "";
      if (Buffer.byteLength(partial) > MAX_WIRE_LINE_BYTES) {
        partial = "";
        discardUntilNewline = true;
      }
      for (const line of lines) {
        if (!line.trim() || Buffer.byteLength(line) > MAX_WIRE_LINE_BYTES) continue;
        for (const event of parseKimiWireRecord(line)) opts.onEvent(event);
      }
    } finally {
      await handle.close();
    }
  };

  const pollNow = (): Promise<void> => {
    polling = (polling ?? Promise.resolve()).then(poll, poll);
    return polling;
  };
  // Scheduled telemetry is best-effort: a wire rotation/removal race must not
  // become an unhandled rejection that can take down the runner host. Callers
  // invoking pollNow() directly still receive the rejection for diagnostics.
  const pollInBackground = (): void => {
    void pollNow().catch(() => undefined);
  };
  const timer = setInterval(pollInBackground, opts.pollMs ?? 100);
  timer.unref?.();
  pollInBackground();

  return {
    pollNow,
    async stop(): Promise<void> {
      if (stopped) return;
      clearInterval(timer);
      await pollNow().catch(() => undefined);
      stopped = true;
    },
  };
}
