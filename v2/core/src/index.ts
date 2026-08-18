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
  type PutOutcome,
  type PutTemplateInput,
  type PutTrackInput,
} from "./store.ts";
export {
  normalizeTemplate,
  normalizeTrack,
  stableStringify,
  isRowSource,
  isScope,
  type NormalizeOptions,
  type TemplateFields,
  type TrackFields,
} from "./registry.ts";
export * from "./packages.ts";
export * from "./mirror.ts";
export { replayAudit } from "./audit.ts";
export { deriveBeeView } from "./view.ts";
export { SCHEMA_SQL } from "./schema.ts";
