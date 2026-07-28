/**
 * BeeView V1 — the versioned Honeybee read model (docs/BEEVIEW_READ_API.md).
 *
 * This module is the supported library surface, re-exported through the
 * package root (src/index.ts). It grows in slices: types + pure projection,
 * the unified StateContext assembler, open-request derivation, and finally
 * getBeeView(selector) / listBeeViews() over a live observation pass.
 *
 * Invariant: nothing under src/view/ ever writes — no touchSession, no
 * @hive_state mirroring, no ledger appends. Reads only.
 */

export * from "./types.js";
export { paneFingerprint, projectBeeView, type BeeViewProjectionSources } from "./project.js";
