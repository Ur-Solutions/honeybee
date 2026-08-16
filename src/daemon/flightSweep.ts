// Default flight-sweep wiring: connects the pure reconciler (flight/
// controller.ts) to the real spawn, seal, buz, and ledger machinery. Built
// once per daemon run and invoked from the tick's dispatcher registry with
// the tick's already-observed records/states — the sweep itself derives
// nothing from panes or transcripts.
import { join } from "node:path";
import { withSessionLifecycleTransaction } from "../lifecycle.js";
import {
  assertNoCanonicalHsrEventIntegrityDoubt,
  assertNoUnresolvedHsrEventIntegrity,
} from "../hsr/eventIntegrity.js";
import { scanLatestSeal } from "../seal.js";
import { sendBuzMessage } from "../buz/send.js";
import { retireSessionByNameExactly } from "../kill.js";
import { withFileLock } from "../lock.js";
import { sweepFlights, stallNudgeText, type BeeActivitySignal, type FlightSweepDeps, type FlightSweepOutcome } from "../flight/controller.js";
import { spawnSlotBee } from "../flight/spawnSlotBee.js";
import { claimNextTask, finishTask, flightDir, leasedTaskForSlot, listFlights, listSlots, loadFlight, saveFlight, saveSlot, taskCounts } from "../flight/store.js";
import { type SlotSealObservation } from "../flight/types.js";
import type { BeeState } from "../state.js";
import { isRunnableSessionRecord } from "../stateMachine.js";
import { appendLedger, loadSession, type SessionRecord } from "../store.js";

export type FlightSweeper = (
  records: SessionRecord[],
  observed: Map<string, BeeState>,
  activity?: ReadonlyMap<string, BeeActivitySignal>,
) => Promise<FlightSweepOutcome[]>;

export type FlightSweeperOptions = {
  detached?: boolean;
};

/** Exact source gate shared by the production sweeper and integrity tests. */
export async function withFlightAutomaticSourceAdmission<T>(
  source: SessionRecord,
  fn: (current: SessionRecord) => Promise<T>,
): Promise<T> {
  return withSessionLifecycleTransaction(source, async (lifecycle) => {
    const current = await lifecycle.refresh();
    assertNoCanonicalHsrEventIntegrityDoubt(current, "flight automatic replacement");
    await assertNoUnresolvedHsrEventIntegrity(current.name, "flight automatic replacement");
    // A completed archive is exact predecessor-stop proof and may authorize a
    // different slot generation only when no event-history authority remains.
    // A runnable or failed-stop predecessor still owns the lane too.
    if (current.status === "kill_failed" || isRunnableSessionRecord(current)) {
      throw new Error(`flight automatic replacement: ${current.name} still owns its slot`);
    }
    return fn(current);
  });
}

export async function latestSealForCurrentIncarnation(beeName: string): Promise<SlotSealObservation | null> {
  const record = await loadSession(beeName);
  const scan = await scanLatestSeal(beeName, { afterFilename: record?.sealHighWaterFilename });
  if (!scan.seal || !scan.filename) return null;
  return {
    filename: scan.filename,
    sealedAt: scan.seal.sealedAt,
    status: scan.seal.status,
    ...(scan.seal.type !== undefined ? { type: scan.seal.type } : {}),
    ...(scan.seal.taskId !== undefined ? { taskId: scan.seal.taskId } : {}),
    ...(scan.seal.attempt !== undefined ? { attempt: scan.seal.attempt } : {}),
  };
}

export function createFlightSweeper(overrides: Partial<FlightSweepDeps> = {}, options: FlightSweeperOptions = {}): FlightSweeper {
  const deps: FlightSweepDeps = {
    listFlights,
    loadFlight,
    listSlots,
    saveSlot,
    saveFlight,
    latestSeal: latestSealForCurrentIncarnation,
    // Shared with the flight capacity provider (COMBS §9.1) — one code path
    // provisions every lane bee.
    spawnSlot: spawnSlotBee,
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
    withSourceBeeAdmission: withFlightAutomaticSourceAdmission,
    retireBee: (beeName) => retireSessionByNameExactly(beeName, "flight automatic cleanup"),
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
  if (options.detached === false) {
    return (records, observed, activity) => sweepFlights(deps, records, observed, activity);
  }
  // DETACHED execution (2026-07-21 canary breach): a sweep's side effects —
  // account auto-pick (live limits fetch), credential activation
  // (keychain/OAuth), HSR spawn, brief delivery with its ~90s boot-retry
  // window — can legitimately take minutes. Awaiting them inside the tick
  // blew the 120s tick budget the moment a live flight had a lane to fill
  // (first canary tick: 131s → budget breach → sentinel kill). The tick
  // stage now only STARTS a sweep (single-flight guarded; the per-flight
  // file lock still serializes against CLI sweepers) and reports the
  // PREVIOUS completed sweep's outcomes — the tick path never waits on
  // spawn-shaped work, mirroring how chain sync was moved off-tick in
  // phase 0.
  let inFlight = false;
  let startedAtMs = 0;
  let pendingOutcomes: FlightSweepOutcome[] = [];
  return async (records, observed, activity) => {
    // Surface what the last completed sweep did (once).
    const report = pendingOutcomes;
    pendingOutcomes = [];
    if (inFlight) {
      const runningForS = Math.round((Date.now() - startedAtMs) / 1000);
      report.push({ flight: "*", action: "skipped", detail: `sweep still running (${runningForS}s)` });
      return report;
    }
    inFlight = true;
    startedAtMs = Date.now();
    void sweepFlights(deps, records, observed, activity)
      .then((outcomes) => {
        pendingOutcomes = outcomes;
      })
      .catch((error: unknown) => {
        pendingOutcomes = [{ flight: "*", action: "error", error: error instanceof Error ? error.message : String(error) }];
      })
      .finally(() => {
        inFlight = false;
      });
    return report;
  };
}
