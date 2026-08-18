/**
 * Honeybee v2 invariant harness (WP2 of the reset).
 * Implements docs/design/specs/reset-02-harness.md over the WP1 core library.
 * Depends only on v2/core. Zero imports from old code. No wall time, no
 * real processes, no ~/.hive.
 */
export { SimClock } from "./clock.ts";
export { Prng } from "./prng.ts";
export {
  type DeliverOutcome,
  type DriverObservation,
  type InterruptOutcome,
  type LiveProcess,
  type ObservedExitCause,
  type RuntimeDriver,
  type StopCause,
} from "./driver.ts";
export { SimDriver, type SimDriverConfig } from "./sim-driver.ts";
export {
  FaultInjector,
  type ExecutorCrashPoint,
  type FaultConfig,
  type StepFault,
} from "./faults.ts";
export {
  ExecutorCrashError,
  SimDaemon,
  type BootReport,
  type DaemonPolicy,
  type SimDaemonOptions,
} from "./daemon.ts";
export {
  InvariantChecker,
  formatViolation,
  takePreBootSnapshot,
  type DeliveryGroundTruth,
  type InvariantBounds,
  type InvariantId,
  type PreBootSnapshot,
  type Violation,
} from "./invariants.ts";
export {
  defaultConfig,
  i1DefaultBoundSteps,
  makeConfig,
  runSim,
  type DriverFactory,
  type PolicyConfig,
  type SimConfig,
  type SimConfigOverrides,
  type SimResult,
  type SimStats,
  type WorkloadConfig,
} from "./simulation.ts";
