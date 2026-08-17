/**
 * Honeybee v2 core library (WP1 of the reset).
 * Implements docs/design/specs/reset-01-core.md over docs/design/core-contract.md.
 * Pure library: no processes, no I/O beyond SQLite. Zero imports from old code.
 */
export * from "./types.ts";
export {
  CoreStore,
  openCoreStore,
  type CoreStoreOptions,
  type CreateBeeInput,
  type SendResult,
  type DeleteResult,
  type ReconcileResult,
  type LivePid,
} from "./store.ts";
export { replayAudit } from "./audit.ts";
export { SCHEMA_SQL } from "./schema.ts";
