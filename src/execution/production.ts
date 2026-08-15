// One lazy production execution coordinator per daemon process. The aggregate
// RPC endpoint and the node-owned inventory reconciler share this provider so
// their in-process single-flight maps agree; cross-process safety remains in
// the durable launch/operation ownership records and file locks.

import type { ExecutionService } from "./service.js";

export type ExecutionServiceProvider = () => Promise<ExecutionService>;

export async function createProductionExecutionService(): Promise<ExecutionService> {
  const [{ createExecutionService, storeSessionEvidenceSource }, { createHsrRunLauncher }, { requireExecutionBinding }] =
    await Promise.all([
      import("./service.js"),
      import("./launcher.js"),
      import("./nodeState.js"),
    ]);
  return createExecutionService({
    // Runs execute as the CANONICAL bound Apiary nodeId; resolved lazily
    // because a durable reservation cannot exist before binding admission.
    launcher: createHsrRunLauncher({ nodeId: async () => (await requireExecutionBinding()).nodeId }),
    sessions: storeSessionEvidenceSource(),
  });
}

/** Cache only success so a transient contract/bootstrap failure can recover. */
export function createProductionExecutionServiceProvider(): ExecutionServiceProvider {
  let servicePromise: Promise<ExecutionService> | undefined;
  return () => {
    const attempt = servicePromise ??= createProductionExecutionService()
      .catch((error: unknown) => {
        if (servicePromise === attempt) servicePromise = undefined;
        throw error;
      });
    return attempt;
  };
}
