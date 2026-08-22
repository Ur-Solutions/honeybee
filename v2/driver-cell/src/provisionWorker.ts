import { parentPort, workerData } from "node:worker_threads";
import { gitImagesRootForCells, refreshGitImage } from "./gitImage.ts";
import { provisionCell, type ProvisionRequest } from "./provision.ts";

interface ProvisionWorkerData {
  cellsRoot: string;
  request: ProvisionRequest;
  opId: string;
  disableCow: boolean;
  useGitImages: boolean;
  gitImagesRoot?: string;
}

interface ProvisionWorkerResult {
  ok: boolean;
  error?: string;
}

const data = workerData as ProvisionWorkerData;

try {
  provisionCell(data.cellsRoot, data.request, data.opId, {
    disableCow: data.disableCow,
    useGitImages: data.useGitImages,
    gitImagesRoot: data.gitImagesRoot,
  });
  parentPort?.postMessage({ ok: true } satisfies ProvisionWorkerResult);
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  } satisfies ProvisionWorkerResult);
  process.exitCode = 1;
}

// Cache maintenance is explicitly after the Cell-ready result. A cache
// failure must never turn a correct, provisioned Cell into a failed start.
if (process.exitCode == null && data.useGitImages && !data.disableCow) {
  try {
    refreshGitImage(
      data.gitImagesRoot ?? gitImagesRootForCells(data.cellsRoot),
      data.request.originRepo,
      data.request.sha,
    );
  } catch {
    // A later Cell retries under the per-repository stale-safe build lock.
  }
}
