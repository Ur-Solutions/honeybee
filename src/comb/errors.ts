import type { CombCliErrorCode, JsonValue } from "./types.js";

const EXIT_CODES: Record<CombCliErrorCode, number> = {
  invalid_argument: 2,
  not_found: 3,
  version_conflict: 4,
  claim_conflict: 4,
  ambiguous_activation: 5,
  cancelled: 5,
  approval_required: 5,
  effect_ambiguous: 6,
  external_dependency: 7,
  corrupt_state: 70,
};

export class CombError extends Error {
  readonly code: CombCliErrorCode;
  readonly exitCode: number;
  readonly details?: JsonValue;

  constructor(code: CombCliErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "CombError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.details = details;
  }
}

export function asCombError(error: unknown): CombError {
  if (error instanceof CombError) return error;
  return new CombError("invalid_argument", error instanceof Error ? error.message : String(error));
}
