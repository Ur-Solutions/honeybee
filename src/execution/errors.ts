// Typed execution-protocol errors (contracts/execution/v1 error.schema.json).
// Every refusal the H1 server surfaces is one of the corpus codes; unknown
// shapes fail closed as SCHEMA_UNSUPPORTED before any side effect.
import type { JsonValue } from "../comb/types.js";

export type ExecutionErrorCode =
  | "PROTOCOL_INCOMPATIBLE"
  | "SCHEMA_UNSUPPORTED"
  | "BINDING_DENIED"
  | "LEASE_DENIED"
  | "IDEMPOTENCY_CONFLICT"
  | "CAPABILITY_MISMATCH"
  | "SNAPSHOT_UNAVAILABLE"
  | "MATERIALIZATION_FAILED"
  | "HARNESS_UNAVAILABLE"
  | "RUN_VERSION_CONFLICT"
  | "RUN_UNKNOWN"
  | "CURSOR_EXPIRED"
  | "NODE_LOST"
  | "AUTHORITY_UNAVAILABLE";

const RETRYABLE: ReadonlySet<ExecutionErrorCode> = new Set(["AUTHORITY_UNAVAILABLE"]);

/** Wire shape of error.schema.json (the parts local-core-v1 emits). */
export type ExecutionErrorWire = {
  code: ExecutionErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonValue;
};

export class ExecutionProtocolError extends Error {
  readonly code: ExecutionErrorCode;
  readonly retryable: boolean;
  readonly details?: JsonValue;

  constructor(code: ExecutionErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "ExecutionProtocolError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (details !== undefined) this.details = details;
  }

  toWire(): ExecutionErrorWire {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function executionError(code: ExecutionErrorCode, message: string, details?: JsonValue): ExecutionProtocolError {
  return new ExecutionProtocolError(code, message, details);
}

/** Coerce any thrown value to a wire error; unknown failures are NODE-side internal faults. */
export function toWireError(error: unknown): ExecutionErrorWire {
  if (error instanceof ExecutionProtocolError) return error.toWire();
  const message = error instanceof Error ? error.message : String(error);
  return { code: "AUTHORITY_UNAVAILABLE", message: `internal execution coordinator failure: ${message}`, retryable: true };
}
