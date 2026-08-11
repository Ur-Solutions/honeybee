/** Exact pending-turn preservation around the ordinary HSR revive primitive. */

import { reviveRecord } from "../commands/migrate.js";
import {
  drainStagedPendingHsrTurns,
  stagePendingHsrTurnsForRecovery,
  type StagedPendingTurnDrain,
} from "../hsr/pendingTurns.js";
import type { SessionRecord } from "../store.js";

export type AutomaticHsrReviveDeps = {
  revive?: (record: SessionRecord) => Promise<SessionRecord>;
  drain?: StagedPendingTurnDrain;
};

/**
 * Stage the exact durable pending turns before revive's intentional stop clears
 * `pending-turns/`, then restore/drain them into the replacement generation.
 */
export async function reviveHsrForAutomaticRecovery(
  record: SessionRecord,
  episodeId: string,
  deps: AutomaticHsrReviveDeps = {},
): Promise<{ record: SessionRecord; replayedTurns: number }> {
  if (record.substrate !== "hsr") throw new Error(`automatic HSR recovery requires substrate=hsr (${record.name})`);
  await stagePendingHsrTurnsForRecovery(record.name, episodeId);
  const revived = await (deps.revive ?? ((candidate) => reviveRecord(candidate, { fresh: false })))(record);
  const replayedTurns = await drainStagedPendingHsrTurns(record.name, deps.drain);
  return { record: revived, replayedTurns };
}
