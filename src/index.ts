/**
 * honeybee library root — the only supported import surface for embedders
 * (docs/BEEVIEW_READ_API.md decision 5). The CLI (`hive`) stays the human
 * surface; this entry exposes the BeeView read model plus the record/state
 * types consumers bind against.
 *
 * Library READS never write: no touchSession, no @hive_state mirroring, no
 * ledger appends happen on any read path reachable from here. The request
 * store's mutation verbs (openRequest/resolveRequest/…) are explicit,
 * deliberate writes — exported for embedders, never called by the view.
 */

export * from "./view/index.js";
export * from "./requests/keys.js";
export * from "./requests/store.js";

export { parseBeeState, type BeeState } from "./state.js";
export type { SessionRecord } from "./store.js";
export type { SealRecord, SealStatus, SealType } from "./seal.js";
export type { BeeContract } from "./contract.js";
