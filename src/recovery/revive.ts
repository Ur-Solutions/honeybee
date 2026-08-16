/** Exact pending-turn preservation around the ordinary HSR revive primitive. */

import { assertNoUnresolvedHsrAnswerOwnership } from "../answerReceipt.js";
import { reviveRecordInTransaction } from "../commands/migrate.js";
import {
  drainStagedPendingHsrTurns,
  isHsrDeliveryAmbiguous,
  stagePendingHsrTurnsForRecovery,
  type StagedPendingTurnDrain,
} from "../hsr/pendingTurns.js";
import { withSessionLifecycleTransaction, type SessionLifecycleTransaction } from "../lifecycle.js";
import { assertNoUnresolvedBeeNameLaunchReservationInAdmission } from "../nameAdmission.js";
import { assertNoUnresolvedHsrEventIntegrity } from "../hsr/eventIntegrity.js";
import { deliveryAmbiguityRequestId } from "../requests/keys.js";
import { openRequest } from "../requests/store.js";
import { isArchivedSessionLifecycle, isRunnableSessionRecord } from "../stateMachine.js";
import type { SessionRecord } from "../store.js";

export type AutomaticHsrReviveDeps = {
  /** Test seam; invoked while the candidate's lifecycle lock is already held. */
  revive?: (
    record: SessionRecord,
    lifecycle: SessionLifecycleTransaction,
    operation: string,
  ) => Promise<SessionRecord>;
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
  const operation = `runtime-recovery:${episodeId}`;
  return withSessionLifecycleTransaction(record, async (lifecycle) => {
    const current = await lifecycle.refresh();
    if (isArchivedSessionLifecycle(current)) {
      throw new Error(`automatic runtime recovery: ${current.name} is archived`);
    }
    await assertNoUnresolvedBeeNameLaunchReservationInAdmission(
      current,
      "automatic runtime recovery",
    );
    await assertNoUnresolvedHsrEventIntegrity(current.name, "automatic runtime recovery");
    await assertNoUnresolvedHsrAnswerOwnership(current, "automatic runtime recovery");
    if (!isRunnableSessionRecord(current)) {
      throw new Error(
        `automatic runtime recovery: ${current.name} is archived or has unresolved stop ownership`,
      );
    }

    // Stage only after lifecycle admission. A kill/retire that won after the
    // daemon's claim therefore leaves both the runtime and pending-turn
    // metadata untouched.
    await stagePendingHsrTurnsForRecovery(current.name, episodeId);
    const revived = deps.revive
      ? await deps.revive(current, lifecycle, operation)
      : await reviveRecordInTransaction(lifecycle, {
          fresh: false,
          replacementOperation: operation,
        });
    let replayedTurns: number;
    try {
      replayedTurns = await drainStagedPendingHsrTurns(current.name, deps.drain);
    } catch (error) {
      if (isHsrDeliveryAmbiguous(error)) {
        const deliveryId = (error as { deliveryId?: unknown }).deliveryId;
        if (typeof deliveryId === "string") {
          const openedAt = new Date().toISOString();
          await openRequest(current.name, {
            id: deliveryAmbiguityRequestId(current.name, deliveryId),
            kind: "manual-action",
            scope: "bee",
            grade: "structured",
            generation: revived.runtimeGeneration ?? 0,
            openedAt,
            question: "A recovered turn may have reached the prior provider host. Reconcile that conversation before redriving queued work.",
            input: { deliveryId, recoveryEpisodeId: episodeId },
            evidence: {
              grade: "structured",
              source: "hsr-recovery",
              observedAt: openedAt,
              detail: "delivery-ambiguous",
            },
          });
        }
      }
      throw error;
    }
    return { record: revived, replayedTurns };
  });
}
