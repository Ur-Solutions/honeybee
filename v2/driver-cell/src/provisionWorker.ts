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

interface MaintenanceStart {
  kind: "refresh_git_image";
}

const MAINTENANCE_FALLBACK_MS = 30_000;

async function waitForMaintenanceStart(): Promise<void> {
  const port = parentPort;
  if (port == null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.off("message", onMessage);
      resolve();
    };
    const onMessage = (message: MaintenanceStart): void => {
      if (message?.kind === "refresh_git_image") done();
    };
    const timer = setTimeout(done, MAINTENANCE_FALLBACK_MS);
    port.on("message", onMessage);
  });
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

// Post-turn maintenance retries any foreground image miss/failure and is a
// cheap ready check when provisioning already ensured the requested graph. A
// cache failure must never turn a correct, provisioned Cell into a failed start.
if (process.exitCode == null && data.useGitImages && !data.disableCow) {
  await waitForMaintenanceStart();
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
