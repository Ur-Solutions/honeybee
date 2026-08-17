/**
 * Fault injector — decides, at seeded random points (or fixed periods), which
 * fault hits the node this step:
 *
 * - daemon crash    → store close + reopen + boot replay (processes survive)
 * - machine reboot  → all virtual pids die + reconcileAtBoot
 * - executor crash  → mid-command (before or after the command's effect)
 * - driver timeout  → a start attempt fails at the substrate boundary
 *                     (transient; surfaces through B5 retry/backoff)
 *
 * `disable()` turns all injection off for the settle phase.
 */
import type { Prng } from "./prng.ts";

export interface FaultConfig {
  /** Deterministic period: daemon crash every K steps (null = off). */
  daemonCrashEvery: number | null;
  daemonCrashProbability: number;
  /** Deterministic period: machine reboot every K steps (null = off). */
  machineRebootEvery: number | null;
  machineRebootProbability: number;
  /** Per command execution: probability the executor dies mid-command. */
  executorCrashProbability: number;
  /** Per driver start attempt: probability of a (transient) timeout. */
  driverTimeoutProbability: number;
  /** Steps the daemon stays down after a crash/reboot, inclusive range. */
  daemonDownSteps: [number, number];
}

export type StepFault = "none" | "daemon_crash" | "machine_reboot";
export type ExecutorCrashPoint = "none" | "before_effect" | "after_effect";

export class FaultInjector {
  private readonly cfg: FaultConfig;
  private readonly prng: Prng;
  private enabled = true;

  constructor(cfg: FaultConfig, prng: Prng) {
    this.cfg = cfg;
    this.prng = prng;
  }

  disable(): void {
    this.enabled = false;
  }

  stepFault(step: number): StepFault {
    if (!this.enabled) return "none";
    if (this.cfg.machineRebootEvery != null && step % this.cfg.machineRebootEvery === 0) {
      return "machine_reboot";
    }
    if (this.cfg.daemonCrashEvery != null && step % this.cfg.daemonCrashEvery === 0) {
      return "daemon_crash";
    }
    if (this.prng.chance(this.cfg.machineRebootProbability)) return "machine_reboot";
    if (this.prng.chance(this.cfg.daemonCrashProbability)) return "daemon_crash";
    return "none";
  }

  executorCrash(): ExecutorCrashPoint {
    if (!this.enabled || !this.prng.chance(this.cfg.executorCrashProbability)) return "none";
    return this.prng.chance(0.5) ? "before_effect" : "after_effect";
  }

  driverTimeout(): boolean {
    return this.enabled && this.prng.chance(this.cfg.driverTimeoutProbability);
  }

  downSteps(): number {
    return this.prng.int(this.cfg.daemonDownSteps[0], this.cfg.daemonDownSteps[1]);
  }
}
