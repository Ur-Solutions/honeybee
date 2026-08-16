// The one true slot-bee spawn: shared by the daemon's flight sweeper and the
// flight capacity provider (COMBS_ENGINE_DESIGN §9 contract 1), so a lane bee
// is provisioned identically no matter which consumer claimed the lane —
// same HSR substrate, same contract postscript, same deterministic name the
// crash-adoption paths re-derive.
import { deliverPromptText } from "../cli/shared.js";
import { deliverSessionText } from "../delivery.js";
import { resolveAccountFlag, spawnBee } from "../commands/spawn.js";
import { appendLedger } from "../store.js";
import { slotBeeName, slotContractTaskId, type FlightMixEntry, type FlightRecord, type FlightTaskPacket, type SlotRecord } from "./types.js";

export type SpawnedSlotBee = { beeName: string; beeId?: string };

/**
 * Spawn the bee for a prepared slot lease. The task packet (queue packet or a
 * comb-lease's synthetic packet) overrides the flight defaults: its brief IS
 * the work, its cwd points at the task's worktree. HSR substrate: pane-less,
 * daemon-spawnable, brief over the control socket. Brief-delivery failure is
 * NOT a spawn failure (review find): the bee exists and is tracked — the
 * first-evidence deadline surfaces an unbriefed lane instead of burning the
 * attempt and orphaning a live bee.
 */
export async function spawnSlotBee(
  flight: FlightRecord,
  slot: SlotRecord,
  mix: FlightMixEntry,
  task?: FlightTaskPacket,
): Promise<SpawnedSlotBee> {
  const account = mix.account ? await resolveAccountFlag(mix.account, mix.agent, undefined, false, mix.model) : undefined;
  const brief = task?.brief ?? flight.brief;
  const record = await spawnBee({
    agent: mix.agent,
    extraArgs: [],
    cwd: task?.cwd ?? flight.cwd,
    yolo: true,
    name: slotBeeName(flight.id, slot.slotId, slot.generation, slot.attempt),
    ...(flight.colony ? { colony: flight.colony } : {}),
    ...(flight.createdBy ? { spawnedById: flight.createdBy } : {}),
    substrate: "hsr",
    ...(account ? { account } : {}),
    ...(mix.model ?? account?.model ? { model: mix.model ?? account?.model } : {}),
    ...(brief ? { brief } : {}),
    contract: {
      completion: flight.contract.completion,
      ...(flight.contract.sealType ? { sealType: flight.contract.sealType } : {}),
      taskId: slotContractTaskId(slot),
      attempt: slot.attempt,
    },
  });
  if (record.brief) {
    try {
      await deliverSessionText(record, record.brief, {
        deliver: deliverPromptText,
        deliveryId: `flight:${flight.id}:${slot.slotId}:${slot.generation}:${slot.attempt}:brief`,
      });
    } catch (error) {
      await appendLedger({
        type: "flight.slot.brief_failed",
        flight: flight.id,
        slot: slot.slotId,
        bee: record.name,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }
  return { beeName: record.name, ...(record.id ? { beeId: record.id } : {}) };
}
