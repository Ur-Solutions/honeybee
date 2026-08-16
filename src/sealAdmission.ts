/** Lifecycle-linearized publication of completion artifacts. */

import { withRunnableSessionAdmission } from "./delivery.js";
import { writeHiveState } from "./hiveState.js";
import { recordSeal, type SealArtifact, type SealRecord } from "./seal.js";
import type { SessionRecord } from "./store.js";

export type RunnableSealAdmissionOptions = {
  /** Preserve the CLI's historical best-effort `@hive_state=done` mirror. */
  mirrorDone?: boolean;
  /** Deterministic test seam; production uses recordSeal. */
  writeSeal?: typeof recordSeal;
  /** Deterministic test seam; production uses writeHiveState. */
  writeMirror?: typeof writeHiveState;
};

/**
 * Completion is a work mutation, not passive history. Hold the Bee lifecycle
 * authority through artifact persistence and its live-runtime mirror so an
 * explicit stop either happens wholly after the seal or makes the seal a
 * zero-effect refusal. In particular, `kill_failed` never publishes a success
 * artifact from an escaped runtime.
 */
export async function recordRunnableSessionSeal(
  snapshot: SessionRecord,
  artifact: SealArtifact,
  options: RunnableSealAdmissionOptions = {},
): Promise<SealRecord> {
  return withRunnableSessionAdmission(snapshot, async (_lifecycle, current) => {
    const stored = await (options.writeSeal ?? recordSeal)(current.name, artifact);
    if (options.mirrorDone) await (options.writeMirror ?? writeHiveState)(current, "done");
    return stored;
  }, { operation: "hive seal" });
}
