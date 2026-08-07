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
  checkpoint?: { nextSeq: number; checkpointDigest?: string; artifactId?: string };
};

export class ExecutionProtocolError extends Error {
  readonly code: ExecutionErrorCode;
  readonly retryable: boolean;
  readonly details?: JsonValue;
  readonly checkpoint?: { nextSeq: number; checkpointDigest?: string; artifactId?: string };

  constructor(
    code: ExecutionErrorCode,
    message: string,
    details?: JsonValue,
    checkpoint?: { nextSeq: number; checkpointDigest?: string; artifactId?: string },
  ) {
    super(message);
    this.name = "ExecutionProtocolError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (details !== undefined) this.details = details;
    if (checkpoint !== undefined) this.checkpoint = checkpoint;
  }

  toWire(): ExecutionErrorWire {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.checkpoint !== undefined ? { checkpoint: this.checkpoint } : {}),
    };
  }
}

/**
 * An execution effect reached a point where a side effect may still be live,
 * so the coordinator must persist a lost/indeterminate Run instead of a
 * comfortable terminal failure. This is intentionally an internal subtype:
 * callers still see the corpus HARNESS_UNAVAILABLE error shape if it escapes,
 * while run.start consumes it to preserve honest durable state.
 */
export class IndeterminateExecutionError extends ExecutionProtocolError {
  readonly cause: string;

  constructor(code: ExecutionErrorCode, message: string, cause: string, details?: JsonValue) {
    super(code, message, details);
    this.name = "IndeterminateExecutionError";
    this.cause = cause;
  }
}

export function executionError(
  code: ExecutionErrorCode,
  message: string,
  details?: JsonValue,
  checkpoint?: { nextSeq: number; checkpointDigest?: string; artifactId?: string },
): ExecutionProtocolError {
  return new ExecutionProtocolError(code, message, details, checkpoint);
}

export function indeterminateExecutionError(
  code: ExecutionErrorCode,
  message: string,
  cause: string,
  details?: JsonValue,
): IndeterminateExecutionError {
  return new IndeterminateExecutionError(code, message, cause, details);
}

/** Coerce any thrown value to a wire error; unknown failures are NODE-side internal faults. */
export function toWireError(error: unknown): ExecutionErrorWire {
  if (error instanceof ExecutionProtocolError) return error.toWire();
  const message = error instanceof Error ? error.message : String(error);
  return { code: "AUTHORITY_UNAVAILABLE", message: `internal execution coordinator failure: ${message}`, retryable: true };
}
