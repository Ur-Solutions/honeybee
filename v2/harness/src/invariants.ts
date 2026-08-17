/**
 * Invariant checker — evaluates the six spec-02 invariants against the real
 * CoreStore plus the driver's delivery ground truth, and records violations as
 * structured one-liners (the ledger format doubles as the telemetry shape the
 * real daemon will emit for contract invariant 1 later).
 *
 *  I1 — every accepted message reaches `delivered` within a bounded number of
 *       sim steps (Q1: default 2 × (max boot delay + max turn duration) per
 *       pending message, configurable), and a `delivered` mark is backed by a
 *       runtime that actually consumed the message (ground truth).
 *  I2 — no bee state outside the model (states, flags, lifecycle, exit causes,
 *       generations, closed lists).
 *  I3 — no permanent zombie after fault storms settle.
 *  I4 — reboot produces zero failed states (B7, re-asserted at every boot).
 *  I5 — audit replay reproduces the final state exactly.
 *  I6 — the command queue drains; nothing stays queued/running forever and
 *       every `failed` command has surfaced a closed-list flag.
 */
import { isDeepStrictEqual } from "node:util";
import {
  COMMAND_STATUSES,
  EXIT_CAUSES,
  FLAGS,
  RUNTIME_STATES,
  VERBS,
  replayAudit,
  type CoreStore,
  type StateDump,
} from "../../core/src/index.ts";
import type { LiveProcess } from "./driver.ts";

export type InvariantId = "I1" | "I2" | "I3" | "I4" | "I5" | "I6";

export interface Violation {
  seed: number;
  step: number;
  beeId: string | null;
  invariant: InvariantId;
  detail: string;
  /** Op history tail at the moment of detection — enough to replay by hand. */
  ops: string[];
}

/** The violation-ledger line: one structured JSON object per line. */
export function formatViolation(v: Violation): string {
  return JSON.stringify({
    seed: v.seed,
    step: v.step,
    bee: v.beeId,
    invariant: v.invariant,
    detail: v.detail,
    ops: v.ops,
  });
}

/** What the checker needs from the driver besides the store. */
export interface DeliveryGroundTruth {
  consumedGeneration(messageId: number): number | undefined;
  liveProcesses(): LiveProcess[];
}

export interface InvariantBounds {
  /** I1: allowed undelivered age per pending message, in sim steps. */
  i1BoundSteps: number;
  /** I6: max age of a queued/running command, in sim steps. */
  queueBoundSteps: number;
  /** I2: commands never exceed the configured retry budget. */
  maxAttempts: number;
  /** I3: a settled `running` runtime must be younger than this. */
  turnHangTimeoutSteps: number;
}

export interface PreBootSnapshot {
  failedCommandIds: number[];
  activeFlagIds: number[];
}

export function takePreBootSnapshot(store: CoreStore): PreBootSnapshot {
  const dump = store.dumpState();
  return {
    failedCommandIds: dump.commands.filter((c) => c.status === "failed").map((c) => c.id),
    activeFlagIds: dump.flags.filter((f) => f.clearedAt == null).map((f) => f.id),
  };
}

export class InvariantChecker {
  readonly violations: Violation[] = [];
  private readonly seed: number;
  private readonly bounds: InvariantBounds;
  private readonly opsTail: () => string[];
  private readonly maxViolations: number;
  private readonly seen = new Set<string>();

  constructor(seed: number, bounds: InvariantBounds, opsTail: () => string[], maxViolations = 25) {
    this.seed = seed;
    this.bounds = bounds;
    this.opsTail = opsTail;
    this.maxViolations = maxViolations;
  }

  private report(
    step: number,
    beeId: string | null,
    invariant: InvariantId,
    key: string,
    detail: string,
  ): void {
    if (this.seen.has(key) || this.violations.length >= this.maxViolations) return;
    this.seen.add(key);
    this.violations.push({ seed: this.seed, step, beeId, invariant, detail, ops: this.opsTail() });
  }

  /** Run after every simulation step (store open). Covers I1, I2, I6. */
  checkStep(step: number, now: number, store: CoreStore, gt: DeliveryGroundTruth): void {
    const dump = store.dumpState();
    this.checkModel(step, dump);
    this.checkI1(step, now, dump, gt);
    this.checkQueue(step, now, dump);
  }

  // ---------------------------------------------------------------------------
  // I2 — the state model, all closed lists
  // ---------------------------------------------------------------------------

  private checkModel(step: number, dump: StateDump): void {
    const beeIds = new Set(dump.bees.map((b) => b.id));
    for (const bee of dump.bees) {
      if (bee.lifecycle !== "active" && bee.lifecycle !== "archived") {
        this.report(step, bee.id, "I2", `I2:lifecycle:${bee.id}`, `stored lifecycle ${bee.lifecycle}`);
      }
      if ((bee.lifecycle === "archived") !== (bee.archivedAt != null)) {
        this.report(step, bee.id, "I2", `I2:archivedAt:${bee.id}`, `archived_at inconsistent with lifecycle ${bee.lifecycle}`);
      }
      const gens = dump.runtimes
        .filter((r) => r.beeId === bee.id)
        .map((r) => r.generation)
        .sort((a, b) => a - b);
      if (gens.length === 0) {
        this.report(step, bee.id, "I2", `I2:no-runtime:${bee.id}`, "bee has no runtime rows");
      } else if (!gens.every((g, i) => g === i + 1)) {
        this.report(step, bee.id, "I2", `I2:generations:${bee.id}`, `generations not contiguous: ${gens.join(",")}`);
      }
    }
    for (const rt of dump.runtimes) {
      const key = `${rt.beeId}#${rt.generation}`;
      if (!beeIds.has(rt.beeId)) {
        this.report(step, rt.beeId, "I2", `I2:orphan-rt:${key}`, "runtime row for missing bee");
      }
      if (!(RUNTIME_STATES as readonly string[]).includes(rt.state)) {
        this.report(step, rt.beeId, "I2", `I2:state:${key}`, `runtime state ${rt.state} outside the four-state model`);
      }
      if ((rt.state === "stopped") !== (rt.exitCause != null)) {
        this.report(step, rt.beeId, "I2", `I2:exitcause:${key}`, `exit_cause=${rt.exitCause} with state=${rt.state}`);
      }
      if (rt.exitCause != null && !(EXIT_CAUSES as readonly string[]).includes(rt.exitCause)) {
        this.report(step, rt.beeId, "I2", `I2:exitcause-list:${key}`, `exit cause ${rt.exitCause} outside closed list`);
      }
      const highest = Math.max(
        ...dump.runtimes.filter((r) => r.beeId === rt.beeId).map((r) => r.generation),
      );
      if (rt.generation !== highest && rt.state !== "stopped") {
        this.report(step, rt.beeId, "I2", `I2:stale-live:${key}`, `non-current generation ${rt.generation} still ${rt.state}`);
      }
    }
    for (const flag of dump.flags) {
      if (!beeIds.has(flag.beeId)) {
        this.report(step, flag.beeId, "I2", `I2:orphan-flag:${flag.id}`, "flag row for missing bee");
      }
      if (!(FLAGS as readonly string[]).includes(flag.flag)) {
        this.report(step, flag.beeId, "I2", `I2:flag:${flag.id}`, `flag ${flag.flag} outside closed list`);
      }
      if (flag.clearedAt != null && flag.clearedAt < flag.setAt) {
        this.report(step, flag.beeId, "I2", `I2:flag-times:${flag.id}`, "flag cleared before set");
      }
    }
    for (const msg of dump.mailbox) {
      if (!beeIds.has(msg.beeId)) {
        this.report(step, msg.beeId, "I2", `I2:orphan-msg:${msg.id}`, "mailbox row for missing bee");
      }
      if ((msg.deliveredAt != null) !== (msg.deliveredGeneration != null)) {
        this.report(step, msg.beeId, "I2", `I2:msg-delivery:${msg.id}`, "delivered_at and delivered_generation must be set together");
      }
    }
    for (const cmd of dump.commands) {
      if (!(VERBS as readonly string[]).includes(cmd.verb)) {
        this.report(step, cmd.beeId, "I2", `I2:verb:${cmd.id}`, `verb ${cmd.verb} outside closed list`);
      }
      if (!(COMMAND_STATUSES as readonly string[]).includes(cmd.status)) {
        this.report(step, cmd.beeId, "I2", `I2:cmd-status:${cmd.id}`, `status ${cmd.status} outside closed list`);
      }
      if (cmd.attempts > this.bounds.maxAttempts) {
        this.report(step, cmd.beeId, "I2", `I2:attempts:${cmd.id}`, `attempts ${cmd.attempts} exceed budget ${this.bounds.maxAttempts}`);
      }
      if (cmd.status === "failed" && (cmd.failureCause == null || !(FLAGS as readonly string[]).includes(cmd.failureCause))) {
        this.report(step, cmd.beeId, "I2", `I2:failure-cause:${cmd.id}`, `failed without a closed-list failure_cause (${cmd.failureCause})`);
      }
      if ((cmd.status === "done" || cmd.status === "failed") && cmd.finishedAt == null) {
        this.report(step, cmd.beeId, "I2", `I2:finished:${cmd.id}`, `${cmd.status} without finished_at`);
      }
      if ((cmd.status === "queued" || cmd.status === "running") && cmd.finishedAt != null) {
        this.report(step, cmd.beeId, "I2", `I2:unfinished:${cmd.id}`, `${cmd.status} with finished_at set`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // I1 — the yardstick
  // ---------------------------------------------------------------------------

  private checkI1(step: number, now: number, dump: StateDump, gt: DeliveryGroundTruth): void {
    const activeFlagBees = new Set(
      dump.flags.filter((f) => f.clearedAt == null).map((f) => f.beeId),
    );
    for (const bee of dump.bees) {
      // A bee carrying a closed-list flag is visibly blocked at an external
      // boundary (contract §4.2); its delivery clock is suspended until the
      // flag clears — that situation is I3/I6 territory, not an I1 breach.
      if (activeFlagBees.has(bee.id)) continue;
      const lastClear = Math.max(
        0,
        ...dump.flags.filter((f) => f.beeId === bee.id && f.clearedAt != null).map((f) => f.clearedAt as number),
      );
      const pending = dump.mailbox
        .filter((m) => m.beeId === bee.id && m.deliveredAt == null)
        .sort((a, b) => a.id - b.id);
      pending.forEach((m, pos) => {
        const base = Math.max(m.enqueuedAt, lastClear);
        const deadline = base + (pos + 1) * this.bounds.i1BoundSteps;
        if (now > deadline) {
          this.report(
            step,
            bee.id,
            "I1",
            `I1:msg=${m.id}`,
            `message ${m.id} undelivered past bound (enqueued=${m.enqueuedAt} pos=${pos} deadline=${deadline} now=${now})`,
          );
        }
      });
    }
    // Ground truth: a store `delivered` mark must be backed by actual consumption.
    for (const m of dump.mailbox) {
      if (m.deliveredAt == null) continue;
      const consumedBy = gt.consumedGeneration(m.id);
      if (consumedBy !== m.deliveredGeneration) {
        this.report(
          step,
          m.beeId,
          "I1",
          `I1:ghost=${m.id}`,
          `message ${m.id} marked delivered to generation ${m.deliveredGeneration} but the runtime consumed ${consumedBy ?? "nothing"} (dropped delivery)`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // I6 — command queue drains
  // ---------------------------------------------------------------------------

  private checkQueue(step: number, now: number, dump: StateDump): void {
    const beeIds = new Set(dump.bees.map((b) => b.id));
    for (const cmd of dump.commands) {
      if (cmd.status === "queued" || cmd.status === "running") {
        if (now - cmd.enqueuedAt > this.bounds.queueBoundSteps) {
          this.report(
            step,
            cmd.beeId,
            "I6",
            `I6:cmd=${cmd.id}`,
            `command ${cmd.id} (${cmd.verb}) ${cmd.status} for ${now - cmd.enqueuedAt} steps (bound ${this.bounds.queueBoundSteps})`,
          );
        }
      }
      if (cmd.status === "failed" && beeIds.has(cmd.beeId)) {
        const surfaced = dump.flags.some((f) => f.beeId === cmd.beeId && f.flag === cmd.failureCause);
        if (!surfaced) {
          this.report(
            step,
            cmd.beeId,
            "I6",
            `I6:failed=${cmd.id}`,
            `command ${cmd.id} settled failed(${cmd.failureCause}) without surfacing the flag`,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // I4 — reboot produces zero failed states (checked at every boot)
  // ---------------------------------------------------------------------------

  checkBoot(
    step: number,
    store: CoreStore,
    gt: DeliveryGroundTruth,
    before: PreBootSnapshot,
    kind: string,
  ): void {
    const dump = store.dumpState();
    const beforeFailed = new Set(before.failedCommandIds);
    for (const cmd of dump.commands) {
      if (cmd.status === "running") {
        this.report(step, cmd.beeId, "I4", `I4:running=${cmd.id}:${step}`, `command ${cmd.id} still running after ${kind} boot (B5 replay missed it)`);
      }
      if (cmd.status === "failed" && !beforeFailed.has(cmd.id)) {
        this.report(step, cmd.beeId, "I4", `I4:failed=${cmd.id}`, `${kind} boot produced failed command ${cmd.id} (${cmd.failureCause})`);
      }
    }
    const beforeFlags = new Set(before.activeFlagIds);
    for (const flag of dump.flags) {
      if (flag.clearedAt == null && !beforeFlags.has(flag.id)) {
        this.report(step, flag.beeId, "I4", `I4:flag=${flag.id}`, `${kind} boot raised flag ${flag.flag}`);
      }
    }
    // Every live runtime row must be backed by an adopted live process; anything
    // else had to become stopped(machine_restart) — never a failed state.
    const live = new Set(gt.liveProcesses().map((p) => `${p.beeId}#${p.generation}`));
    for (const rt of dump.runtimes) {
      if (rt.state === "stopped") continue;
      if (!live.has(`${rt.beeId}#${rt.generation}`)) {
        this.report(
          step,
          rt.beeId,
          "I4",
          `I4:zombie=${rt.beeId}#${rt.generation}:${step}`,
          `runtime ${rt.generation} is ${rt.state} after ${kind} boot but no live process backs it`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // I3 — no permanent zombie once storms settle
  // ---------------------------------------------------------------------------

  checkSettle(step: number, now: number, store: CoreStore): void {
    const dump = store.dumpState();
    const activeFlagBees = new Set(
      dump.flags.filter((f) => f.clearedAt == null).map((f) => f.beeId),
    );
    for (const bee of dump.bees) {
      if (activeFlagBees.has(bee.id)) continue; // visibly blocked — the legal terminal
      const undelivered = dump.mailbox.filter((m) => m.beeId === bee.id && m.deliveredAt == null);
      if (undelivered.length > 0) {
        this.report(
          step,
          bee.id,
          "I3",
          `I3:mail:${bee.id}`,
          `${undelivered.length} message(s) still undelivered after settle (first id ${undelivered[0]?.id})`,
        );
      }
      const rts = dump.runtimes.filter((r) => r.beeId === bee.id);
      const current = rts.reduce((a, b) => (b.generation > (a?.generation ?? 0) ? b : a), rts[0]);
      if (!current) continue;
      if (current.state === "booting") {
        this.report(step, bee.id, "I3", `I3:booting:${bee.id}`, `runtime ${current.generation} stuck booting after settle`);
      }
      if (current.state === "running" && now - current.updatedAt > this.bounds.turnHangTimeoutSteps) {
        this.report(step, bee.id, "I3", `I3:running:${bee.id}`, `runtime ${current.generation} running ${now - current.updatedAt} steps after settle (hang policy missed it)`);
      }
    }
    for (const cmd of dump.commands) {
      if (cmd.status === "queued" || cmd.status === "running") {
        this.report(step, cmd.beeId, "I3", `I3:cmd:${cmd.id}`, `command ${cmd.id} (${cmd.verb}) still ${cmd.status} after settle`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // I5 — audit replay reproduces the final state
  // ---------------------------------------------------------------------------

  checkReplay(step: number, store: CoreStore): void {
    let replayed: StateDump;
    try {
      replayed = replayAudit(store.auditRows());
    } catch (err) {
      this.report(step, null, "I5", "I5:replay-error", `audit replay threw: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!isDeepStrictEqual(replayed, store.dumpState())) {
      this.report(step, null, "I5", "I5:mismatch", "audit replay does not reproduce the final state");
    }
  }
}
