// Default flight-sweep wiring: connects the pure reconciler (flight/
// controller.ts) to the real spawn, seal, buz, and ledger machinery. Built
// once per daemon run and invoked from the tick's dispatcher registry with
// the tick's already-observed records/states — the sweep itself derives
// nothing from panes or transcripts.
import { join } from "node:path";
import { scanLatestSeal } from "../seal.js";
import { sendBuzMessage } from "../buz/send.js";
import { spawnBee } from "../commands/spawn.js";
import { deliverPromptText } from "../cli/shared.js";
import { resolveAccountFlag } from "../commands/spawn.js";
import { transactionalRetire } from "../kill.js";
import { withFileLock } from "../lock.js";
import { sweepFlights, stallNudgeText, type FlightSweepDeps, type FlightSweepOutcome } from "../flight/controller.js";
import { claimNextTask, finishTask, flightDir, leasedTaskForSlot, listFlights, listSlots, saveFlight, saveSlot, taskCounts } from "../flight/store.js";
import { slotBeeName, slotContractTaskId, type SlotSealObservation } from "../flight/types.js";
import type { BeeState } from "../state.js";
import { appendLedger, loadSession, type SessionRecord } from "../store.js";

export type FlightSweeper = (records: SessionRecord[], observed: Map<string, BeeState>) => Promise<FlightSweepOutcome[]>;

export function createFlightSweeper(overrides: Partial<FlightSweepDeps> = {}): FlightSweeper {
  const deps: FlightSweepDeps = {
    listFlights,
    listSlots,
    saveSlot,
    saveFlight,
    latestSeal: async (beeName): Promise<SlotSealObservation | null> => {
      const scan = await scanLatestSeal(beeName);
      if (!scan.seal || !scan.filename) return null;
      return {
        filename: scan.filename,
        sealedAt: scan.seal.sealedAt,
        status: scan.seal.status,
        ...(scan.seal.type !== undefined ? { type: scan.seal.type } : {}),
        ...(scan.seal.taskId !== undefined ? { taskId: scan.seal.taskId } : {}),
        ...(scan.seal.attempt !== undefined ? { attempt: scan.seal.attempt } : {}),
      };
    },
    spawnSlot: async (flight, slot, mix, task) => {
      const account = mix.account ? await resolveAccountFlag(mix.account, mix.agent, undefined) : undefined;
      // A queue task's packet overrides the flight defaults: its brief IS the
      // route packet, and its cwd points the lane at the task's own
      // worktree/checkout.
      const brief = task?.brief ?? flight.brief;
      // HSR substrate: pane-less, daemon-spawnable, and the brief goes over
      // the control socket — no tmux interaction from inside the daemon.
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
      // Deliver the composed brief (task + contract postscript) as the first
      // turn. spawnBee already waited for host readiness. Delivery failure is
      // NOT a spawn failure: the bee exists and is tracked — throwing here
      // would burn the attempt and orphan a live bee forever (kimi's review
      // find). The unbriefed slot hits its first-evidence deadline instead,
      // where the stall/nudge/escalate path surfaces it.
      if (record.brief) {
        try {
          await deliverPromptText(record, record.brief);
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
    },
    nudge: async (flight, slot, beeName) => {
      const recipient = await loadSession(beeName);
      if (!recipient) throw new Error(`nudge: bee ${beeName} has no session record`);
      await sendBuzMessage({
        recipient,
        // The flight's orchestrator (or the flight itself) is the sender —
        // there is no "system" sender kind in buz.
        sender: { kind: "bee", id: flight.createdBy ?? flight.id },
        tier: "interrupt",
        subject: `flight ${flight.id} slot ${slot.slotId} stall`,
        body: stallNudgeText(flight, slot),
      });
    },
    // Cross-process exclusion (CR-1): one sweep per flight at a time, across
    // the daemon and any `hive flight sweep` CLI. staleMs sits above the
    // slowest realistic sweep (multi-slot boot + brief windows) so a crashed
    // holder's lock expires but a live slow sweep is never stolen.
    withFlightLock: (flightId, fn) =>
      withFileLock(join(flightDir(flightId), ".sweep.lock"), fn, { timeoutMs: 5_000, staleMs: 10 * 60_000 }),
    retireBee: async (beeName) => {
      const record = await loadSession(beeName);
      if (!record || record.status !== "running") return;
      await transactionalRetire(record);
    },
    queue: {
      counts: taskCounts,
      claimNext: claimNextTask,
      leasedForSlot: leasedTaskForSlot,
      finish: finishTask,
    },
    appendLedger,
    now: () => Date.now(),
    ...overrides,
  };
  // In-process single-flight guard: a sweep that outlives its dispatch budget
  // keeps running (withTimeout never cancels) — the next tick must not start
  // a second reconciler over the same slots (CR-1).
  let inFlight = false;
  return async (records, observed) => {
    if (inFlight) {
      return [{ flight: "*", action: "skipped", detail: "previous sweep still running" }];
    }
    inFlight = true;
    try {
      return await sweepFlights(deps, records, observed);
    } finally {
      inFlight = false;
    }
  };
}
