/**
 * SimDriver — virtual runtimes implementing the RuntimeDriver interface
 * (driver.ts, the WP3 draft) against no real processes and no real time.
 *
 * Each virtual process has a configurable boot delay, turn duration, a
 * per-step spontaneous crash probability, a hang probability (never reaches
 * idle — decided per boot and per turn) and a clean-exit probability at turn
 * end. `tick()` advances all processes by one virtual step.
 *
 * The driver also keeps the simulation's delivery ground truth: which
 * generation actually consumed each message. The invariant checker compares
 * the store's `delivered` marks against this — a driver that marks messages
 * accepted but drops them (the spec02.7 meta-test) is caught here.
 */
import type {
  DeliverOutcome,
  DriverObservation,
  InterruptOutcome,
  LiveProcess,
  RuntimeDriver,
  StopCause,
} from "./driver.ts";
import type { Prng } from "./prng.ts";

export interface SimDriverConfig {
  /** Boot delay range in sim steps, inclusive. */
  bootDelay: [number, number];
  /** Turn duration range in sim steps, inclusive. */
  turnDuration: [number, number];
  /** Per live process, per step: probability of a spontaneous crash. */
  crashProbability: number;
  /** Per boot and per turn: probability it hangs (never completes). */
  hangProbability: number;
  /** At turn end: probability the runtime exits cleanly instead of idling. */
  exitProbability: number;
}

interface VirtualProcess {
  beeId: string;
  generation: number;
  pid: number;
  pidStartedAt: number;
  phase: "booting" | "running" | "idle";
  bootDoneAt: number;
  turnEndsAt: number;
  hungBoot: boolean;
  hungTurn: boolean;
}

export class SimDriver implements RuntimeDriver {
  protected readonly cfg: SimDriverConfig;
  protected readonly prng: Prng;
  protected readonly now: () => number;
  /** Keyed by beeId — at most one live process per bee, by construction. */
  private readonly procs = new Map<string, VirtualProcess>();
  private events: DriverObservation[] = [];
  /** Ground truth: messageId → generation that actually consumed it. */
  private readonly consumed = new Map<number, number>();
  private nextPid = 1000;
  private quiescent = false;

  constructor(cfg: SimDriverConfig, prng: Prng, now: () => number) {
    this.cfg = cfg;
    this.prng = prng;
    this.now = now;
  }

  // -------------------------------------------------------------------------
  // RuntimeDriver (the WP3 interface)
  // -------------------------------------------------------------------------

  start(beeId: string, generation: number): void {
    const existing = this.procs.get(beeId);
    if (existing) {
      throw new Error(
        `sim driver: bee ${beeId} already has a live process (generation ${existing.generation})`,
      );
    }
    const at = this.now();
    this.procs.set(beeId, {
      beeId,
      generation,
      pid: this.nextPid++,
      pidStartedAt: at,
      phase: "booting",
      bootDoneAt: at + this.prng.int(this.cfg.bootDelay[0], this.cfg.bootDelay[1]),
      turnEndsAt: 0,
      hungBoot: !this.quiescent && this.prng.chance(this.cfg.hangProbability),
      hungTurn: false,
    });
  }

  deliver(beeId: string, generation: number, messageId: number, _body: string): DeliverOutcome {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { accepted: false, reason: "no_process" };
    if (p.phase === "booting") return { accepted: false, reason: "not_ready" };
    this.consumed.set(messageId, generation);
    if (p.phase === "idle") {
      p.phase = "running";
      p.turnEndsAt = this.now() + this.prng.int(this.cfg.turnDuration[0], this.cfg.turnDuration[1]);
      p.hungTurn = !this.quiescent && this.prng.chance(this.cfg.hangProbability);
      this.events.push({ beeId, generation, kind: "turn_started" });
    }
    return { accepted: true };
  }

  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { hadProcess: false };
    this.procs.delete(beeId);
    this.events.push({ beeId, generation, kind: "exited", exitCause: cause });
    return { hadProcess: true };
  }

  /** A virtual interrupt ends the turn immediately (turn_ended), un-hanging a hung turn. */
  interrupt(beeId: string, generation: number): InterruptOutcome {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { interrupted: false, reason: "no_process" };
    if (p.phase === "booting") return { interrupted: false, reason: "not_ready" };
    if (p.phase === "idle") return { interrupted: false, reason: "idle" };
    p.phase = "idle";
    p.hungTurn = false;
    this.events.push({ beeId, generation, kind: "turn_ended" });
    return { interrupted: true };
  }

  observe(): DriverObservation[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  hasProcess(beeId: string, generation: number): boolean {
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation;
  }

  snapshotLive(): LiveProcess[] {
    return [...this.procs.values()].map((p) => ({
      beeId: p.beeId,
      generation: p.generation,
      pid: p.pid,
      pidStartedAt: p.pidStartedAt,
    }));
  }

  // -------------------------------------------------------------------------
  // Sim controls (not part of the WP3 interface)
  // -------------------------------------------------------------------------

  /** Advance every virtual process by one step of virtual time. */
  tick(): void {
    const now = this.now();
    for (const p of [...this.procs.values()]) {
      if (!this.quiescent && this.prng.chance(this.cfg.crashProbability)) {
        this.procs.delete(p.beeId);
        this.events.push({
          beeId: p.beeId,
          generation: p.generation,
          kind: "exited",
          exitCause: "crashed",
        });
        continue;
      }
      if (p.phase === "booting" && !p.hungBoot && now >= p.bootDoneAt) {
        // Boot completes into the initial turn (running), then idles.
        p.phase = "running";
        p.turnEndsAt = now + this.prng.int(this.cfg.turnDuration[0], this.cfg.turnDuration[1]);
        p.hungTurn = !this.quiescent && this.prng.chance(this.cfg.hangProbability);
        this.events.push({
          beeId: p.beeId,
          generation: p.generation,
          kind: "booted",
          pid: p.pid,
          pidStartedAt: p.pidStartedAt,
        });
      } else if (p.phase === "running" && !p.hungTurn && now >= p.turnEndsAt) {
        if (!this.quiescent && this.prng.chance(this.cfg.exitProbability)) {
          this.procs.delete(p.beeId);
          this.events.push({
            beeId: p.beeId,
            generation: p.generation,
            kind: "exited",
            exitCause: "clean",
          });
        } else {
          p.phase = "idle";
          this.events.push({ beeId: p.beeId, generation: p.generation, kind: "turn_ended" });
        }
      }
    }
  }

  /** Machine reboot: every virtual pid dies; pending (unreported) events die with them. */
  killAll(): void {
    this.procs.clear();
    this.events = [];
  }

  /**
   * Settle mode: no NEW spontaneous faults (crash/hang/clean-exit). Already-hung
   * processes remain running: without positive failure evidence they are
   * intentionally indistinguishable from legitimate long-running turns.
   */
  quiesce(): void {
    this.quiescent = true;
  }

  /** Ground truth for the invariant checker. */
  consumedGeneration(messageId: number): number | undefined {
    return this.consumed.get(messageId);
  }

  consumedCount(): number {
    return this.consumed.size;
  }

  liveProcesses(): LiveProcess[] {
    return this.snapshotLive();
  }
}
