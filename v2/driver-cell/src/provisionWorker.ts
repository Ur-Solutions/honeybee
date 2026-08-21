import { parentPort, workerData } from "node:worker_threads";
import { provisionCell, type ProvisionRequest } from "./provision.ts";

interface ProvisionWorkerData {
  cellsRoot: string;
  request: ProvisionRequest;
  opId: string;
  disableCow: boolean;
}

interface ProvisionWorkerResult {
  ok: boolean;
  error?: string;
}

const data = workerData as ProvisionWorkerData;

try {
  provisionCell(data.cellsRoot, data.request, data.opId, {
    disableCow: data.disableCow,
  });
  parentPort?.postMessage({ ok: true } satisfies ProvisionWorkerResult);
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  } satisfies ProvisionWorkerResult);
}
