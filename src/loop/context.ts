// Loop config building — coerce/validate the loose arg record from the CLI or
// the flow runtime into a fully-typed LoopConfig, and map the user-facing
// --context preset onto the two orthogonal knobs (carrier + memory).

import type { SealStatus } from "../seal.js";
import type { LoopCarrier, LoopConfig, LoopContextMode, LoopMemory, LoopStopConfig } from "./state.js";

const SEAL_STATUSES = new Set<SealStatus>(["done", "blocked", "needs_input", "failed"]);

export type ContextKnobs = {
  context: LoopContextMode;
  carrier: LoopCarrier;
  memory: LoopMemory;
};

/**
 * Map the single --context preset onto the two internal knobs:
 *   persistent → { same,  harness }
 *   ralph      → { fresh, none    }
 *   rolling    → { fresh, rolling }
 */
export function parseContextMode(s: string): ContextKnobs {
  switch (s) {
    case "persistent":
      return { context: "persistent", carrier: "same", memory: "harness" };
    case "ralph":
      return { context: "ralph", carrier: "fresh", memory: "none" };
    case "rolling":
      return { context: "rolling", carrier: "fresh", memory: "rolling" };
    default:
      throw new Error(`Unknown --context "${s}". Use one of: persistent, ralph, rolling.`);
  }
}

/**
 * Build a fully-validated LoopConfig from a loose Record<string,unknown>. Coerces
 * booleans/numbers/CSV from the loose values the CLI/runtime hand us (each --arg
 * only ever coerces to true/false/finite-number/else-string). Throws on any
 * invalid or missing required field so callers can surface errors before
 * spawning a detached driver.
 */
export function buildLoopConfig(input: Record<string, unknown>): LoopConfig {
  const bee = requiredString(input.bee, "bee");
  const cwd = requiredString(input.cwd, "cwd");
  const prompt = requiredString(input.prompt, "prompt");

  const contextRaw = input.context;
  if (typeof contextRaw !== "string" || contextRaw.length === 0) {
    throw new Error("Loop requires --context (persistent | ralph | rolling).");
  }
  const knobs = parseContextMode(contextRaw);

  const forever = coerceBool(input.forever);
  const max = coerceMax(input.max, forever);
  const maxDurationMs = coerceDuration(input.maxDuration);
  const until = optionalString(input.until);
  const stopOnSentinel = optionalString(input.stopOnSentinel);
  const judge = optionalString(input.judge);
  const stopOnSeal = coerceStopOnSeal(input.stopOnSeal);

  const summarizer = coerceSummarizer(input.summarizer);
  const yolo = coerceBool(input.yolo);

  const stop: LoopStopConfig = {
    max,
    maxDurationMs,
    forever,
    until,
    stopOnSeal,
    stopOnSentinel,
    judge,
  };

  const now = new Date().toISOString();
  const loopId = typeof input.loopId === "string" && input.loopId.length > 0 ? input.loopId : "";

  return {
    loopId,
    bee,
    cwd,
    context: knobs.context,
    carrier: knobs.carrier,
    memory: knobs.memory,
    prompt,
    stop,
    summarizer,
    yolo,
    status: "running",
    iteration: 0,
    startedAt: now,
    updatedAt: now,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Coercion helpers.
// ──────────────────────────────────────────────────────────────────────────

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Loop requires --${name} (non-empty).`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.trim().length === 0 ? null : s;
}

function coerceBool(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  const s = String(value).toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function coerceMax(value: unknown, forever: boolean): number | null {
  if (value === undefined || value === null || value === "") {
    if (forever) return null;
    throw new Error("Loop requires --max <N> (a positive integer) unless --forever is set.");
  }
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --max "${String(value)}": expected a positive integer.`);
  }
  return n;
}

function coerceStopOnSeal(value: unknown): SealStatus[] {
  if (value === undefined || value === null || value === "") return ["done"];
  const parts = String(value)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return ["done"];
  for (const part of parts) {
    if (!SEAL_STATUSES.has(part as SealStatus)) {
      throw new Error(`Invalid --stop-on-seal "${part}". Use any of: done, blocked, needs_input, failed.`);
    }
  }
  return parts as SealStatus[];
}

function coerceSummarizer(value: unknown): "self" | "bee" {
  if (value === undefined || value === null || value === "") return "self";
  const s = String(value);
  if (s !== "self" && s !== "bee") {
    throw new Error(`Invalid --summarizer "${s}". Use one of: self, bee.`);
  }
  return s;
}

/**
 * Parse a duration like `30s`, `10m`, `2h` (or a bare number of milliseconds)
 * into milliseconds. Returns null when no duration is supplied.
 */
export function coerceDuration(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --max-duration "${value}".`);
    return Math.floor(value);
  }
  const s = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!match) throw new Error(`Invalid --max-duration "${s}". Use e.g. 30s, 10m, 2h.`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = Math.floor(amount * multiplier);
  if (ms <= 0) throw new Error(`Invalid --max-duration "${s}".`);
  return ms;
}
