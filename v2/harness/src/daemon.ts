/**
 * SimDaemon — the harness face of the daemon loop cores.
 *
 * WP2 prototyped the executor/delivery/hang loops here; WP4 extracted them to
 * v2/daemon/src/loops.ts (DaemonCore) so the REAL daemon runs the exact code
 * this harness proves. SimDaemon remains the harness's construction: it wires
 * the WP2 FaultInjector into DaemonCore's injected fault hooks and keeps the
 * WP2 surface (`boot()`, `step()`, ExecutorCrashError, DaemonPolicy) intact —
 * `v2:harness` and `v2:harness:real` keep re-asserting all six invariants
 * against the production loop logic on every run.
 */
import {
  DaemonCore,
  ExecutorCrashError,
  type BootReport,
  type DaemonPolicy,
} from "../../daemon/src/loops.ts";
import type { CoreStore } from "../../core/src/index.ts";
import type { RuntimeDriver } from "./driver.ts";
import type { FaultInjector } from "./faults.ts";

export { ExecutorCrashError };
export type { BootReport, DaemonPolicy };

export interface SimDaemonOptions {
  store: CoreStore;
  driver: RuntimeDriver;
  injector: FaultInjector;
  policy: DaemonPolicy;
  now: () => number;
  log: (op: string) => void;
}

export class SimDaemon extends DaemonCore {
  constructor(opts: SimDaemonOptions) {
    super({
      store: opts.store,
      driver: opts.driver,
      policy: opts.policy,
      now: opts.now,
      log: opts.log,
      faults: {
        executorCrash: () => opts.injector.executorCrash(),
        driverTimeout: () => opts.injector.driverTimeout(),
      },
    });
  }
}
