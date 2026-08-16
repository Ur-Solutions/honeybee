import { executionError } from "./errors.js";

const CLAUDE_REASONING = new Set(["low", "medium", "high", "xhigh", "max", "ultracode"]);
const CODEX_REASONING = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const CODEX_56_REASONING = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CODEX_56_LUNA_REASONING = new Set(["low", "medium", "high", "xhigh", "max"]);
const GROK_REASONING = new Set(["low", "medium", "high"]);

/**
 * Translate Apiary's signed, driver-normalized reasoning selection into the
 * exact built-in harness argv. This deliberately does not clamp: a signed
 * request is a guarantee, so an unknown or model-incompatible value is
 * refused before admission instead of silently selecting a different effort.
 */
export function executionReasoningArgs(
  driverId: string,
  model: string | undefined,
  requested: unknown,
): string[] {
  if (requested === undefined) return [];
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw executionError("CAPABILITY_MISMATCH", "harness config.reasoning must be a non-empty string");
  }

  const driver = driverId.toLowerCase();
  const reasoning = requested.toLowerCase();
  let allowed: Set<string> | undefined;
  let args: string[] | undefined;
  if (driver === "claude") {
    allowed = CLAUDE_REASONING;
    args = ["--effort", reasoning];
  } else if (driver === "codex") {
    allowed = model === "gpt-5.6-sol" || model === "gpt-5.6-terra"
      ? CODEX_56_REASONING
      : model === "gpt-5.6-luna"
        ? CODEX_56_LUNA_REASONING
        : CODEX_REASONING;
    args = ["-c", `model_reasoning_effort="${reasoning}"`];
  } else if (driver === "grok") {
    allowed = GROK_REASONING;
    args = ["--effort", reasoning];
  }

  if (!allowed || !allowed.has(reasoning) || !args) {
    throw executionError(
      "CAPABILITY_MISMATCH",
      `harness config.reasoning ${JSON.stringify(requested)} is not supported for ${driverId}${model ? ` model ${model}` : ""}`,
    );
  }
  return args;
}
