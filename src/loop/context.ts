// Loop config building — coerce/validate the loose arg record from the CLI or
// the flow runtime into a fully-typed LoopConfig, and map the user-facing
// --context preset onto the two orthogonal knobs (carrier + memory).

import { buildLoopStopConfig } from "./stopConditions.js";
import type { LoopCarrier, LoopConfig, LoopContextMode, LoopMemory } from "./state.js";
export { coerceDuration } from "./stopConditions.js";

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

  const stop = buildLoopStopConfig(input);
  const summarizer = coerceSummarizer(input.summarizer);
  const yolo = coerceBool(input.yolo);

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

function coerceBool(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  const s = String(value).toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function coerceSummarizer(value: unknown): "self" | "bee" {
  if (value === undefined || value === null || value === "") return "self";
  const s = String(value);
  if (s !== "self" && s !== "bee") {
    throw new Error(`Invalid --summarizer "${s}". Use one of: self, bee.`);
  }
  return s;
}
