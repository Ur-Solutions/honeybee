/**
 * honeybee library root — the only supported import surface for embedders
 * (docs/BEEVIEW_READ_API.md decision 5). The CLI (`hive`) stays the human
 * surface; this entry exposes the BeeView read model plus the record/state
 * types consumers bind against.
 *
 * Library calls never write: no touchSession, no @hive_state mirroring, no
 * ledger appends happen on any code path reachable from here.
 */

export * from "./view/index.js";

export { parseBeeState, type BeeState } from "./state.js";
export type { SessionRecord } from "./store.js";
export type { SealRecord, SealStatus, SealType } from "./seal.js";
export type { BeeContract } from "./contract.js";
