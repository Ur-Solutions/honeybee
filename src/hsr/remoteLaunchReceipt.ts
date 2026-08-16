import { dirname, isAbsolute, join } from "node:path";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { atomicWriteFile } from "../fsx.js";
import type { ProcessBirthFingerprint } from "./processIdentity.js";
import { hsrRoot, hsrRunDir } from "./runDir.js";
import type { RunnerTier } from "./types.js";

/** Capability advertised by runner-host ping before any irreversible spawn RPC. */
export const REMOTE_HSR_SAFETY_PROTOCOL = 1;

export type RemoteHsrHostIdentity = {
  hostPid: number;
  startedAt: string;
  hostFingerprint: ProcessBirthFingerprint;
};

export type RemoteHsrLaunchReceipt = {
  version: typeof REMOTE_HSR_SAFETY_PROTOCOL;
  bee: string;
  /** Client-generated idempotency/reconciliation key. */
  launchId: string;
  /** Remote-generated immutable logical-runtime generation. */
  incarnation: string;
  /** CAS predecessor observed before this launch was first dispatched. */
  previousLaunchId?: string;
  requestDigest: string;
  state: "reserved" | "dispatching" | "running" | "refreshing" | "stopping" | "stopped";
  createdAt: string;
  stoppedAt?: string;
  cwd: string;
  tier: RunnerTier;
  sessionId?: string;
  host?: RemoteHsrHostIdentity;
  /**
   * Durable credential-refresh subphase. `dispatching` is written only after
   * the old host is exactly stopped and its meta removed, immediately before
   * the replacement host is started. While dispatching, `host` is deliberately
   * absent: a later replacement meta may be bound, but absence can never be
   * mistaken for proof that the replacement did not escape.
   */
  refreshPhase?: "stopping" | "stopped" | "dispatching";
  refreshSourceHost?: RemoteHsrHostIdentity;
  /**
   * Durable proof that an exact controller consumer activated its locally
   * persisted terminal projection before issuing the final acknowledgement.
   * This authority survives run-dir reclamation, making a lost final-ack reply
   * idempotently retryable without reopening the deleted event history.
   */
  terminalConsumerActivations?: Record<string, {
    throughSeq: number;
    activatedAt: string;
    host: RemoteHsrHostIdentity;
  }>;
};

export function remoteHsrLaunchReceiptPath(bee: string): string {
  // Keep the authority receipt OUTSIDE the disposable runtime directory. A
  // successful kill removes hsrRunDir(bee), but its stopped tombstone must
  // survive so a delayed retry of that launchId can never resurrect the bee.
  // The digest is a containment boundary even if a future caller forgets to
  // canonicalize an untrusted RPC name before reading. The receipt body still
  // carries and validates the exact canonical bee name.
  const key = createHash("sha256").update(bee).digest("hex");
  return join(hsrRoot(), "launch-receipts", `${key}.json`);
}

function remoteHsrLaunchHistoryPath(bee: string, launchId: string): string {
  const beeKey = createHash("sha256").update(bee).digest("hex");
  const launchKey = createHash("sha256").update(launchId).digest("hex");
  return join(hsrRoot(), "launch-receipts", "history", beeKey, `${launchKey}.json`);
}

function remoteHsrLaunchCancellationPath(bee: string, launchId: string): string {
  const beeKey = createHash("sha256").update(bee).digest("hex");
  const launchKey = createHash("sha256").update(launchId).digest("hex");
  return join(hsrRoot(), "launch-receipts", "cancellations", beeKey, `${launchKey}.json`);
}

/** Stat run ownership without collapsing EACCES/EIO into apparent absence. */
export async function remoteHsrRunDirExistsStrict(bee: string): Promise<boolean> {
  try {
    await stat(hsrRunDir(bee));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Unable to inspect remote HSR run state for ${bee}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validFingerprint(value: unknown): value is ProcessBirthFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Number.isSafeInteger(object.pgid) && Number(object.pgid) > 0
    && typeof object.startedAt === "string" && object.startedAt.length > 0;
}

function validHost(value: unknown): value is RemoteHsrHostIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Number.isSafeInteger(object.hostPid) && Number(object.hostPid) > 0
    && typeof object.startedAt === "string" && object.startedAt.length > 0
    && validFingerprint(object.hostFingerprint);
}

const RUNNER_TIERS = new Set<RunnerTier>(["server", "stream", "turn", "pty"]);

/** Fail-closed durable receipt read; malformed ownership can never authorize I/O. */
async function readReceiptAtStrict(
  path: string,
  bee: string,
  expectedLaunchId?: string,
): Promise<RemoteHsrLaunchReceipt | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Unable to read remote HSR launch receipt for ${bee}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid remote HSR launch receipt JSON for ${bee}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid remote HSR launch receipt shape for ${bee}`);
  }
  const object = parsed as Record<string, unknown>;
  const refreshPhase = object.refreshPhase;
  const refreshSourceHost = object.refreshSourceHost;
  let terminalConsumerActivations: RemoteHsrLaunchReceipt["terminalConsumerActivations"];
  if (object.terminalConsumerActivations !== undefined) {
    if (
      !object.terminalConsumerActivations
      || typeof object.terminalConsumerActivations !== "object"
      || Array.isArray(object.terminalConsumerActivations)
    ) {
      throw new Error(`Invalid remote HSR terminal consumer activations for ${bee}`);
    }
    terminalConsumerActivations = {};
    for (const [consumerId, rawActivation] of Object.entries(
      object.terminalConsumerActivations as Record<string, unknown>,
    )) {
      if (
        consumerId.length === 0 || consumerId.length > 256
        || !rawActivation || typeof rawActivation !== "object" || Array.isArray(rawActivation)
      ) {
        throw new Error(`Invalid remote HSR terminal consumer activation for ${bee}`);
      }
      const activation = rawActivation as Record<string, unknown>;
      if (
        !Number.isSafeInteger(activation.throughSeq) || Number(activation.throughSeq) <= 0
        || typeof activation.activatedAt !== "string" || !Number.isFinite(Date.parse(activation.activatedAt))
        || !validHost(activation.host)
      ) {
        throw new Error(`Invalid remote HSR terminal consumer activation for ${bee}`);
      }
      terminalConsumerActivations[consumerId] = {
        throughSeq: Number(activation.throughSeq),
        activatedAt: activation.activatedAt,
        host: activation.host,
      };
    }
  }
  const validRefreshShape = (() => {
    if (refreshPhase === undefined && refreshSourceHost === undefined) return true;
    if (refreshPhase !== "stopping" && refreshPhase !== "stopped" && refreshPhase !== "dispatching") return false;
    if (object.state !== "refreshing" && object.state !== "stopping") return false;
    if (refreshPhase === "dispatching") {
      return object.host === undefined && validHost(refreshSourceHost);
    }
    return validHost(object.host) && refreshSourceHost === undefined;
  })();
  if (
    object.version !== REMOTE_HSR_SAFETY_PROTOCOL
    || object.bee !== bee
    || typeof object.launchId !== "string" || object.launchId.length === 0
    || (expectedLaunchId !== undefined && object.launchId !== expectedLaunchId)
    || typeof object.incarnation !== "string" || object.incarnation.length === 0
    || (object.previousLaunchId !== undefined && (typeof object.previousLaunchId !== "string" || object.previousLaunchId.length === 0))
    || typeof object.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(object.requestDigest)
    || (object.state !== "reserved" && object.state !== "dispatching" && object.state !== "running" && object.state !== "refreshing" && object.state !== "stopping" && object.state !== "stopped")
    || typeof object.createdAt !== "string" || !Number.isFinite(Date.parse(object.createdAt))
    || (object.stoppedAt !== undefined && (typeof object.stoppedAt !== "string" || !Number.isFinite(Date.parse(object.stoppedAt))))
    || typeof object.cwd !== "string" || !isAbsolute(object.cwd)
    || typeof object.tier !== "string" || !RUNNER_TIERS.has(object.tier as RunnerTier)
    || (object.sessionId !== undefined && (typeof object.sessionId !== "string" || object.sessionId.length === 0))
    || (object.host !== undefined && !validHost(object.host))
    || (object.state === "running" && !validHost(object.host))
    || (object.state === "refreshing" && refreshPhase !== "dispatching" && !validHost(object.host))
    || !validRefreshShape
  ) {
    throw new Error(`Invalid remote HSR launch receipt for ${bee}`);
  }
  if (terminalConsumerActivations) {
    if (!validHost(object.host)) throw new Error(`Invalid unbound terminal consumer activation for ${bee}`);
    for (const activation of Object.values(terminalConsumerActivations)) {
      if (
        activation.host.hostPid !== object.host.hostPid
        || activation.host.startedAt !== object.host.startedAt
        || activation.host.hostFingerprint.pgid !== object.host.hostFingerprint.pgid
        || activation.host.hostFingerprint.startedAt !== object.host.hostFingerprint.startedAt
      ) {
        throw new Error(`Invalid stale-host terminal consumer activation for ${bee}`);
      }
    }
  }
  return {
    ...(object as RemoteHsrLaunchReceipt),
    ...(terminalConsumerActivations ? { terminalConsumerActivations } : {}),
  };
}

/**
 * Durable negative admission for an exact launch id whose rollback reached the
 * authority before the delayed spawn request. This closes the kill-first race:
 * a later first arrival of the cancelled request must never look fresh.
 */
export async function writeRemoteHsrLaunchCancellation(bee: string, launchId: string): Promise<void> {
  const path = remoteHsrLaunchCancellationPath(bee, launchId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, `${JSON.stringify({ bee, launchId, cancelledAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

/** Fail closed on malformed cancellation state; only ENOENT means not cancelled. */
export async function readRemoteHsrLaunchCancellationStrict(bee: string, launchId: string): Promise<boolean> {
  const path = remoteHsrLaunchCancellationPath(bee, launchId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Unable to read remote HSR launch cancellation for ${bee}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid remote HSR launch cancellation JSON for ${bee}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid remote HSR launch cancellation shape for ${bee}`);
  }
  const object = parsed as Record<string, unknown>;
  if (
    object.bee !== bee
    || object.launchId !== launchId
    || typeof object.cancelledAt !== "string"
    || !Number.isFinite(Date.parse(object.cancelledAt))
  ) {
    throw new Error(`Invalid remote HSR launch cancellation for ${bee}`);
  }
  return true;
}

export async function readRemoteHsrLaunchReceiptStrict(bee: string): Promise<RemoteHsrLaunchReceipt | null> {
  return readReceiptAtStrict(remoteHsrLaunchReceiptPath(bee), bee);
}

/** Enumerate every durable authority head; malformed rows fail shutdown closed. */
export async function listRemoteHsrLaunchReceiptsStrict(): Promise<RemoteHsrLaunchReceipt[]> {
  const root = join(hsrRoot(), "launch-receipts");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Unable to enumerate remote HSR launch receipts: ${error instanceof Error ? error.message : String(error)}`);
  }
  const receipts: RemoteHsrLaunchReceipt[] = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    const path = join(root, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`Invalid remote HSR authority head ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const bee = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).bee
      : undefined;
    if (typeof bee !== "string" || remoteHsrLaunchReceiptPath(bee) !== path) {
      throw new Error(`Invalid remote HSR authority head identity ${path}`);
    }
    const receipt = await readReceiptAtStrict(path, bee);
    if (!receipt) throw new Error(`Remote HSR authority head vanished during enumeration: ${path}`);
    receipts.push(receipt);
  }
  return receipts.sort((left, right) => left.bee.localeCompare(right.bee));
}

/** Durable per-launch history prevents an old id from becoming fresh after head rotation. */
export async function readRemoteHsrLaunchHistoryStrict(
  bee: string,
  launchId: string,
): Promise<RemoteHsrLaunchReceipt | null> {
  return readReceiptAtStrict(remoteHsrLaunchHistoryPath(bee, launchId), bee, launchId);
}

export async function writeRemoteHsrLaunchReceipt(receipt: RemoteHsrLaunchReceipt): Promise<void> {
  await mkdir(join(hsrRoot(), "launch-receipts"), { recursive: true, mode: 0o700 });
  const historyPath = remoteHsrLaunchHistoryPath(receipt.bee, receipt.launchId);
  await mkdir(dirname(historyPath), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  // Head first: once visible it fences every different launchId, even if the
  // history write is interrupted. Callers treat a history-write failure as an
  // uncommitted launch and exact-clean through this authoritative head.
  await atomicWriteFile(
    remoteHsrLaunchReceiptPath(receipt.bee),
    serialized,
    { mode: 0o600 },
  );
  await atomicWriteFile(
    historyPath,
    serialized,
    { mode: 0o600 },
  );
}
