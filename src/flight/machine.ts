// The slot state machine (CL.701 §4.2). Pure: evidence in, next slot + events
// + desires out. Every transition is driven by structured evidence — session
// record status, this tick's derived BeeState, and attempt-scoped seals —
// never pane text, never prose. The invariants the property tests pin down:
//   * a slot NEVER reaches `done` without current-attempt completion evidence;
//   * idle-without-seal is a stall (violation), never completion;
//   * evidence from a previous attempt (stale seal) never satisfies this one;
//   * judgment (escalated/abandoned verdicts) always leaves the machine as an
//     event — the machine itself never guesses.
import { judgeActivationEvidence, type ActivationEvidenceVerdict } from "../activation.js";
import type { BeeState } from "../state.js";
import {
  slotContractTaskId,
  type FlightRecord,
  type SlotRecord,
  type SlotSealObservation,
  type SlotState,
} from "./types.js";

export type SlotEvidence = {
  /** Session-record status when the slot bee's record still exists. */
  beeStatus?: "running" | "dead" | "kill_failed" | "archived";
  /** This tick's derived state for the bee (authoritative, structured). */
  beeState?: BeeState;
  /** The bee's LATEST seal (any attempt; the machine does the scoping). */
  seal?: SlotSealObservation | null;
};

export type SlotPlanEvent = { type: string; data?: Record<string, unknown> };

export type SlotPlan = {
  slot: SlotRecord;
  changed: boolean;
  events: SlotPlanEvent[];
  /** The slot is vacant and eligible — the controller spawns under backpressure. */
  wantsSpawn: boolean;
  /** The slot just hit its stall deadline — send the deterministic nudge. */
  wantsNudge: boolean;
};

/**
 * Attempt-scoped seal matching: the flight-flavored view of the shared
 * activation rule (src/activation.ts — the comb-run engine consumes the same
 * kernel). A seal only counts for the CURRENT attempt: sealedAt must be at or
 * after attemptStartedAt, and it must CARRY the slot's correlation keys —
 * the contract postscript demands them verbatim, so a keyless seal is "none"
 * (the stall machinery re-instructs the bee), never a completion (CR-2).
 * Carried keys that disagree are a MISMATCH (escalate — the bee sealed
 * something else); a stale seal is "none".
 */
export function judgeSeal(slot: SlotRecord, seal: SlotSealObservation | null | undefined): ActivationEvidenceVerdict {
  return judgeActivationEvidence(
    {
      taskId: slotContractTaskId(slot),
      attempt: slot.attempt,
      ...(slot.attemptStartedAt ? { attemptStartedAt: slot.attemptStartedAt } : {}),
    },
    seal ? { recordedAt: seal.sealedAt, ...(seal.taskId !== undefined ? { taskId: seal.taskId } : {}), ...(seal.attempt !== undefined ? { attempt: seal.attempt } : {}) } : null,
    { requireKeys: true },
  );
}

const DEAD_BEE_STATES: ReadonlySet<BeeState> = new Set(["dead", "crashed", "error", "kill_failed"]);

export function planSlot(flight: FlightRecord, slot: SlotRecord, evidence: SlotEvidence, nowMs: number): SlotPlan {
  const nowIso = new Date(nowMs).toISOString();
  const next: SlotRecord = { ...slot, evidence: { ...slot.evidence }, history: [...slot.history] };
  const events: SlotPlanEvent[] = [];
  let wantsNudge = false;

  const beeData = () => ({
    slot: slot.slotId,
    attempt: next.attempt,
    ...(next.beeName ? { bee: next.beeName } : {}),
    mixKey: slot.mixKey,
  });

  const transition = (state: SlotState, extra?: Record<string, unknown>) => {
    if (next.state !== state) {
      next.state = state;
      next.since = nowIso;
      events.push({ type: `flight.slot.${state}`, data: { ...beeData(), ...(extra ?? {}) } });
    }
  };

  /** Close the current attempt and open the vacancy (replacement path). */
  const vacate = (outcome: string, extra?: Record<string, unknown>) => {
    events.push({ type: `flight.slot.${outcome}`, data: { ...beeData(), ...(extra ?? {}) } });
    next.history.push({ attempt: next.attempt, generation: next.generation, ...(next.taskId ? { taskId: next.taskId } : {}), ...(next.beeName ? { beeName: next.beeName } : {}), outcome, at: nowIso });
    delete next.beeName;
    delete next.beeId;
    delete next.nudgedAt;
    delete next.attemptStartedAt;
    next.evidence = {};
    if (next.attempt >= flight.contract.maxAttemptsPerSlot) {
      next.state = "abandoned";
      next.since = nowIso;
      // The controller never silently rebalances or over-spends attempts —
      // an exhausted slot is surfaced loudly for a judgment call.
      events.push({ type: "flight.mix.violation", data: { slot: slot.slotId, mixKey: slot.mixKey, attempts: next.attempt } });
      events.push({ type: "flight.slot.abandoned", data: { slot: slot.slotId, mixKey: slot.mixKey } });
    } else {
      next.state = "vacant";
      next.since = nowIso;
      events.push({ type: "flight.vacancy", data: { slot: slot.slotId, mixKey: slot.mixKey } });
    }
  };

  const finish = (): SlotPlan => ({
    slot: next,
    changed: JSON.stringify(next) !== JSON.stringify(slot),
    events,
    wantsSpawn: next.state === "vacant" && flight.status === "active",
    wantsNudge,
  });

  // Terminal states and closed flights: nothing to drive.
  if (slot.state === "done" || slot.state === "abandoned" || slot.state === "drained" || flight.status === "closed") return finish();

  // Vacant: the desire to spawn is the only output (the controller owns the
  // durable attempt claim + backpressure).
  if (slot.state === "vacant") return finish();

  // A node outage is unknown-ness, not evidence: hold every clock (the stall
  // deadline must not fire off mirror staleness — CL.701 open question 5).
  if (evidence.beeState === "node_unreachable") return finish();

  const sealVerdict = flight.contract.completion === "seal" ? judgeSeal(slot, evidence.seal) : "none";

  // 1) Completion evidence beats everything else.
  if (sealVerdict === "match") {
    const seal = evidence.seal!;
    // The demanded seal type is part of the contract: correct keys but the
    // wrong artifact kind is a judgment call, not completion (CR-2).
    if (flight.contract.sealType && seal.type !== flight.contract.sealType) {
      next.evidence.sealFilename = seal.filename;
      transition("escalated", { seal: seal.filename, reason: "seal-type-mismatch", sealType: seal.type ?? null, wantedSealType: flight.contract.sealType });
      return finish();
    }
    if (seal.status === "done") {
      next.evidence.sealFilename = seal.filename;
      transition("done", { seal: seal.filename });
      next.history.push({ attempt: next.attempt, generation: next.generation, ...(next.taskId ? { taskId: next.taskId } : {}), ...(next.beeName ? { beeName: next.beeName } : {}), outcome: "done", at: nowIso });
      return finish();
    }
    // A contract-matching seal that says blocked/failed/needs_input is honest
    // completion of the ATTEMPT but not of the task — judgment call.
    next.evidence.sealFilename = seal.filename;
    transition("escalated", { seal: seal.filename, sealStatus: seal.status });
    return finish();
  }
  if (sealVerdict === "mismatch") {
    const seal = evidence.seal!;
    next.evidence.sealFilename = seal.filename;
    transition("escalated", { seal: seal.filename, reason: "seal-mismatch", sealTaskId: seal.taskId ?? null, sealAttempt: seal.attempt ?? null });
    return finish();
  }

  const attemptStartMs = Date.parse(next.attemptStartedAt ?? next.since);

  // 2a) A MISSING session record for a freshly claimed slot is ambiguity, not
  // death: the spawn may still be executing (in another process — the CLI
  // sweeper racing the daemon, or a budget-abandoned sweep), or listSessions
  // may have raced saveSession. Hold the claim until the readiness deadline;
  // only then is the attempt written off (review CR-1). A record that EXISTS
  // and says dead remains unambiguous and falls through to 2b.
  if (evidence.beeStatus === undefined && (slot.state === "provisioning" || slot.state === "booting")) {
    if (Number.isFinite(attemptStartMs) && nowMs - attemptStartMs > flight.contract.readinessDeadlineMs) {
      vacate("wedged", { reason: "no-session-record" });
    }
    return finish();
  }

  // 2b) Liveness: a dead host/record is unambiguous structured evidence.
  const beeDead =
    evidence.beeStatus === undefined ||
    evidence.beeStatus === "dead" ||
    evidence.beeStatus === "kill_failed" ||
    evidence.beeStatus === "archived" ||
    (evidence.beeState !== undefined && DEAD_BEE_STATES.has(evidence.beeState));
  if (beeDead) {
    // Exit contracts: only a CLEAN exit is completion. Crash-flavored
    // evidence (crashed/error/kill_failed) is never done — a segfault is not
    // an honest finish (CR-10a). And a fast worker that exits cleanly
    // between two sweeps may never have an observed `active` tick, so a
    // clean `dead` record counts even without firstEvidenceAt (CR-10b) —
    // the exit contract's boundary is the exit itself.
    const crashFlavored =
      evidence.beeStatus === "kill_failed" ||
      (evidence.beeState !== undefined && evidence.beeState !== "dead" && DEAD_BEE_STATES.has(evidence.beeState));
    if (flight.contract.completion === "exit" && !crashFlavored && (next.evidence.firstEvidenceAt || evidence.beeStatus === "dead")) {
      transition("done", { completion: "exit" });
      next.history.push({ attempt: next.attempt, generation: next.generation, ...(next.taskId ? { taskId: next.taskId } : {}), ...(next.beeName ? { beeName: next.beeName } : {}), outcome: "done", at: nowIso });
      return finish();
    }
    vacate("crashed", { ...(evidence.beeStatus ? { beeStatus: evidence.beeStatus } : {}), ...(evidence.beeState ? { beeState: evidence.beeState } : {}) });
    return finish();
  }

  const beeState = evidence.beeState;

  // 3) Activity evidence.
  if (beeState === "active") {
    if (!next.evidence.firstEvidenceAt) next.evidence.firstEvidenceAt = nowIso;
    next.evidence.lastActivityAt = nowIso;
    delete next.nudgedAt;
    transition("working");
    return finish();
  }

  // 4) Blocked: structured needs-input. The daemon's needs-input router owns
  // delivery; the slot escalates if it out-waits the stall budget. An already-
  // escalated slot stays escalated — flipping back to blocked would flap
  // blocked↔escalated every stallMs and spam events (review CR-7a).
  if (beeState === "blocked" || beeState === "auth-needed") {
    if (next.state === "escalated") return finish();
    transition("blocked", { ...(beeState === "auth-needed" ? { reason: "auth-needed" } : {}) });
    if (nowMs - Date.parse(next.since) > flight.contract.stallMs) {
      transition("escalated", { reason: "blocked-timeout" });
    }
    return finish();
  }

  // 5) Boot phase: no activity yet.
  if (!next.evidence.firstEvidenceAt) {
    if (beeState === "booting" || beeState === "queued" || next.state === "provisioning") {
      if (Number.isFinite(attemptStartMs) && nowMs - attemptStartMs > flight.contract.readinessDeadlineMs) {
        vacate("wedged", { deadline: "readiness" });
        return finish();
      }
      transition("booting");
      return finish();
    }
    // Live and idle/ready but never worked: first-evidence deadline.
    if (Number.isFinite(attemptStartMs) && nowMs - attemptStartMs > flight.contract.firstEvidenceDeadlineMs) {
      return stall(flight, next, events, nowMs, nowIso, "first-evidence", beeData, () => {
        wantsNudge = true;
      }, finish);
    }
    transition("booting");
    return finish();
  }

  // 6) Worked before, quiet now (idle_with_output / ready / sealed-without-
  // matching-seal all land here): idle is NEVER done — it's working until the
  // stall clock says violation.
  const lastActivityMs = Date.parse(next.evidence.lastActivityAt ?? next.evidence.firstEvidenceAt);
  if (Number.isFinite(lastActivityMs) && nowMs - lastActivityMs > flight.contract.stallMs) {
    return stall(flight, next, events, nowMs, nowIso, "stall", beeData, () => {
      wantsNudge = true;
    }, finish);
  }
  transition("working");
  return finish();
}

/**
 * Shared stall handling: first breach → `stalled` + the deterministic nudge;
 * a DELIVERED nudge (nudgedAt is stamped by the controller only after the
 * send succeeds — review CR-5) that goes unanswered for another stall budget
 * → `escalated`. Until delivery succeeds the nudge is re-requested every
 * sweep, and an undelivered nudge can never escalate as "unanswered". LLM
 * (or human) attention is spent on the exception only.
 */
function stall(
  flight: FlightRecord,
  next: SlotRecord,
  events: SlotPlanEvent[],
  nowMs: number,
  nowIso: string,
  reason: string,
  beeData: () => Record<string, unknown>,
  markNudge: () => void,
  finish: () => SlotPlan,
): SlotPlan {
  // An escalated slot is already in judgment's hands: only fresh evidence
  // (activity, a seal, death) moves it — re-deriving the stall would flap
  // stalled↔escalated and spam events every sweep.
  if (next.state === "escalated") return finish();
  if (next.state !== "stalled") {
    next.state = "stalled";
    next.since = nowIso;
    events.push({ type: "flight.slot.stalled", data: { ...beeData(), reason } });
  }
  if (!next.nudgedAt) {
    markNudge();
    return finish();
  }
  if (nowMs - Date.parse(next.nudgedAt) > flight.contract.stallMs) {
    next.state = "escalated";
    next.since = nowIso;
    events.push({ type: "flight.slot.escalated", data: { ...beeData(), reason: `${reason}-nudge-unanswered` } });
  }
  return finish();
}
