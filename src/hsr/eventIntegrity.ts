/**
 * Durable authority for a runner event that the provider produced but the HSR
 * event log could not record.  The receipt deliberately lives outside the
 * disposable per-Bee run directory: stopping or purging a runtime is not proof
 * that the provider-side effect represented by the lost event did not happen.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { isArchivedSessionLifecycle } from "../stateMachine.js";
import {
  loadSession,
  saveSessionLocked,
  withSessionLock,
  type HsrEventIntegrityDoubt,
  type SessionRecord,
} from "../store.js";
import { readPendingHsrTurn } from "./pendingTurns.js";
import { readPendingHsrTurns } from "./pendingTurns.js";
import { connectRpcClient } from "./rpc.js";
import {
  HsrSourceEventLogBusyError,
  isHsrEventHistoryQuarantined,
  quarantineHsrEventHistory,
  readHsrMetaStrict,
  readHsrSourceEventsStrict,
  validateHsrSourceEventLogStrict,
  type HsrMeta,
} from "./runDir.js";
import type { RunnerEvent } from "./types.js";
import { readRemoteHsrLaunchReceiptStrict } from "./remoteLaunchReceipt.js";
import {
  sameProcessBirthFingerprint,
  type ProcessBirthFingerprint,
} from "./processIdentity.js";

const HSR_EVENT_INTEGRITY_VERSION = 1 as const;

export type HsrEventIntegrityHost = {
  hostPid: number;
  startedAt: string;
  /** Absent only for a pre-birth-fingerprint legacy host; never signal it. */
  hostFingerprint?: ProcessBirthFingerprint;
};

export type HsrEventIntegrityReceipt = {
  version: typeof HSR_EVENT_INTEGRITY_VERSION;
  integrityId: string;
  bee: string;
  host: HsrEventIntegrityHost;
  /** Present only for a controller-owned remote generation. */
  remoteAuthority?: { launchId: string; incarnation: string };
  phase: "unresolved" | "acknowledged";
  stopState: "pending" | "confirmed" | "doubt";
  deliveryIds: string[];
  /**
   * Present when durable pending-turn authority could not be enumerated while
   * this receipt was published. An empty deliveryIds array is not absence
   * proof in that case, so operator acknowledgement remains fail-closed until
   * a later exact rescan repairs the receipt.
   */
  deliveryScanError?: string;
  /** Terminal operator verdicts retained even after Buz clears its receipt. */
  deliveryVerdicts?: Record<string, "delivered" | "discarded">;
  reason: string;
  createdAt: string;
  updatedAt: string;
  stopDetail?: string;
  acknowledgedAt?: string;
};

export class HsrSourceEventIntegrityError extends Error {
  readonly code = "HIVE_HSR_EVENT_INTEGRITY";

  constructor(
    readonly bee: string,
    readonly integrityId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HsrSourceEventIntegrityError";
  }
}

/** The observed host/generation was replaced before a corruption fence landed. */
export class HsrSourceAuthorityChangedError extends Error {
  readonly code = "HIVE_HSR_SOURCE_AUTHORITY_CHANGED";
  constructor(readonly bee: string) {
    super(`HSR source authority for ${bee} changed while validating retained history`);
    this.name = "HsrSourceAuthorityChangedError";
  }
}

function beeKey(bee: string): string {
  return createHash("sha256").update(bee).digest("hex");
}

function receiptPath(bee: string): string {
  return join(storeRoot(), "hsr-event-integrity", `${beeKey(bee)}.json`);
}

function receiptHistoryPath(receipt: HsrEventIntegrityReceipt): string {
  const integrityKey = createHash("sha256").update(receipt.integrityId).digest("hex");
  return join(
    storeRoot(),
    "hsr-event-integrity",
    "history",
    beeKey(receipt.bee),
    `${integrityKey}.json`,
  );
}

function lockPath(bee: string): string {
  return join(storeRoot(), "locks", "hsr-event-integrity", `${beeKey(bee)}.lock`);
}

function validFingerprint(value: unknown): value is ProcessBirthFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Number.isSafeInteger(object.pgid) && Number(object.pgid) > 0
    && typeof object.startedAt === "string" && object.startedAt.length > 0;
}

function validHost(value: unknown): value is HsrEventIntegrityHost {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Number.isSafeInteger(object.hostPid) && Number(object.hostPid) > 0
    && typeof object.startedAt === "string" && object.startedAt.length > 0
    && (object.hostFingerprint === undefined || validFingerprint(object.hostFingerprint));
}

function parseReceipt(raw: string, expectedBee: string): HsrEventIntegrityReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`HSR event-integrity receipt for ${expectedBee} is malformed`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`HSR event-integrity receipt for ${expectedBee} is malformed`);
  }
  const object = parsed as Record<string, unknown>;
  const remote = object.remoteAuthority;
  const deliveryVerdicts = object.deliveryVerdicts;
  const validRemote = remote === undefined || (
    !!remote && typeof remote === "object" && !Array.isArray(remote)
    && typeof (remote as Record<string, unknown>).launchId === "string"
    && ((remote as Record<string, unknown>).launchId as string).length > 0
    && typeof (remote as Record<string, unknown>).incarnation === "string"
    && ((remote as Record<string, unknown>).incarnation as string).length > 0
  );
  if (
    object.version !== HSR_EVENT_INTEGRITY_VERSION
    || typeof object.integrityId !== "string" || object.integrityId.length === 0
    || object.bee !== expectedBee
    || !validHost(object.host)
    || !validRemote
    || (object.phase !== "unresolved" && object.phase !== "acknowledged")
    || (object.stopState !== "pending" && object.stopState !== "confirmed" && object.stopState !== "doubt")
    || !Array.isArray(object.deliveryIds)
    || !object.deliveryIds.every((id) => typeof id === "string" && id.length > 0)
    || new Set(object.deliveryIds as string[]).size !== object.deliveryIds.length
    || (object.deliveryScanError !== undefined && (
      typeof object.deliveryScanError !== "string" || object.deliveryScanError.length === 0
    ))
    || (deliveryVerdicts !== undefined && (
      !deliveryVerdicts || typeof deliveryVerdicts !== "object" || Array.isArray(deliveryVerdicts)
      || !Object.entries(deliveryVerdicts as Record<string, unknown>).every(([id, verdict]) =>
        (object.deliveryIds as string[]).includes(id)
        && (verdict === "delivered" || verdict === "discarded"))
    ))
    || typeof object.reason !== "string" || object.reason.length === 0
    || typeof object.createdAt !== "string" || !Number.isFinite(Date.parse(object.createdAt))
    || typeof object.updatedAt !== "string" || !Number.isFinite(Date.parse(object.updatedAt))
    || (object.stopDetail !== undefined && typeof object.stopDetail !== "string")
    || (object.acknowledgedAt !== undefined && (
      typeof object.acknowledgedAt !== "string" || !Number.isFinite(Date.parse(object.acknowledgedAt))
    ))
    || (object.phase === "acknowledged" && object.acknowledgedAt === undefined)
    || (object.phase === "acknowledged" && object.stopState !== "confirmed")
    || (object.phase === "acknowledged" && object.deliveryScanError !== undefined)
    || (object.phase === "acknowledged" && (object.deliveryIds as string[]).some(
      (id) => (deliveryVerdicts as Record<string, unknown> | undefined)?.[id] !== "delivered"
        && (deliveryVerdicts as Record<string, unknown> | undefined)?.[id] !== "discarded",
    ))
  ) {
    throw new Error(`HSR event-integrity receipt for ${expectedBee} is malformed`);
  }
  return object as HsrEventIntegrityReceipt;
}

export function parseHsrEventIntegrityReceipt(
  value: unknown,
  expectedBee: string,
): HsrEventIntegrityReceipt {
  return parseReceipt(typeof value === "string" ? value : JSON.stringify(value), expectedBee);
}

function sameHost(left: HsrEventIntegrityHost, right: HsrEventIntegrityHost): boolean {
  return left.hostPid === right.hostPid
    && left.startedAt === right.startedAt
    && (
      sameProcessBirthFingerprint(left.hostFingerprint, right.hostFingerprint)
      || (left.hostFingerprint === undefined && right.hostFingerprint === undefined)
    );
}

function metaOwnsObservedHost(meta: HsrMeta, observed: HsrEventIntegrityHost): boolean {
  return meta.hostPid === observed.hostPid
    && meta.startedAt === observed.startedAt
    && (
      sameProcessBirthFingerprint(meta.hostFingerprint, observed.hostFingerprint)
      || (meta.hostFingerprint === undefined && observed.hostFingerprint === undefined)
    );
}

function sameRemoteAuthority(
  left: HsrEventIntegrityReceipt["remoteAuthority"],
  right: HsrEventIntegrityReceipt["remoteAuthority"],
): boolean {
  return left?.launchId === right?.launchId && left?.incarnation === right?.incarnation;
}

export function hsrEventIntegrityReceiptOwnsHost(
  receipt: HsrEventIntegrityReceipt,
  host: HsrEventIntegrityHost,
  remoteAuthority?: HsrEventIntegrityReceipt["remoteAuthority"],
): boolean {
  return sameHost(receipt.host, host) && sameRemoteAuthority(receipt.remoteAuthority, remoteAuthority);
}

export async function readHsrEventIntegrityReceipt(bee: string): Promise<HsrEventIntegrityReceipt | null> {
  try {
    return parseReceipt(await readFile(receiptPath(bee), "utf8"), bee);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Import the remote node's exact receipt into the controller's outside store.
 * Node fields remain authoritative; controller-side terminal delivery verdicts
 * are merged because they may have been published by local Buz reconciliation.
 */
export async function importRemoteHsrEventIntegrityReceipt(
  value: unknown,
  expectedBee: string,
): Promise<HsrEventIntegrityReceipt> {
  const remote = parseHsrEventIntegrityReceipt(value, expectedBee);
  if (!remote.remoteAuthority) {
    throw new Error(`remote HSR event-integrity receipt for ${expectedBee} has no launch authority`);
  }
  const imported = await withFileLock(lockPath(expectedBee), async () => {
    let local = await readHsrEventIntegrityReceipt(expectedBee);
    if (local?.phase === "unresolved" && local.integrityId !== remote.integrityId) {
      throw new Error(
        `HSR event-integrity receipt ${local.integrityId} already fences a different ${expectedBee} generation`,
      );
    }
    if (local?.integrityId === remote.integrityId && local.phase === "acknowledged" && remote.phase === "unresolved") {
      throw new Error(`remote HSR event-integrity receipt ${remote.integrityId} regressed after local acknowledgement`);
    }
    if (local?.integrityId === remote.integrityId) {
      for (const [deliveryId, localVerdict] of Object.entries(local.deliveryVerdicts ?? {})) {
        const remoteVerdict = remote.deliveryVerdicts?.[deliveryId];
        if (remoteVerdict && remoteVerdict !== localVerdict) {
          throw new Error(
            `remote HSR event-integrity delivery ${deliveryId} verdict ${remoteVerdict} conflicts with local ${localVerdict}`,
          );
        }
      }
    }
    if (local?.phase === "acknowledged" && local.integrityId !== remote.integrityId) {
      // A later remote generation owns a new head, but the controller's prior
      // explicit acknowledgement remains immutable audit authority just like
      // the local persistence path. Never overwrite it in place during import.
      const target = receiptHistoryPath(local);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(receiptPath(expectedBee), target);
      local = null;
    }
    const next: HsrEventIntegrityReceipt = {
      ...remote,
      ...(local?.integrityId === remote.integrityId && local.deliveryVerdicts
        ? { deliveryVerdicts: { ...remote.deliveryVerdicts, ...local.deliveryVerdicts } }
        : {}),
      updatedAt: local && local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt,
    };
    await writeReceipt(next);
    return next;
  }, { timeoutMs: 30_000 });
  if (imported.phase === "unresolved") await fenceCanonicalHsrEventIntegrity(imported);
  else await clearCanonicalHsrEventIntegrityProjection(expectedBee, imported.integrityId);
  return imported;
}

async function writeReceipt(receipt: HsrEventIntegrityReceipt): Promise<void> {
  const path = receiptPath(receipt.bee);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Whether an event-integrity receipt names the exact runtime generation still
 * carried by a canonical session row. Public read-model code uses the same
 * proof gate as the mutation path; a matching marker alone is not successor
 * ownership proof.
 */
export function hsrEventIntegrityReceiptOwnsSession(
  receipt: HsrEventIntegrityReceipt,
  record: SessionRecord,
): boolean {
  if (record.name !== receipt.bee) return false;
  if (receipt.remoteAuthority) {
    return !!record.node
      && record.remoteLaunchId === receipt.remoteAuthority.launchId
      && record.remoteIncarnation === receipt.remoteAuthority.incarnation;
  }
  return record.substrate === "hsr"
    && !record.node
    && record.runnerPid === receipt.host.hostPid
    && (
      sameProcessBirthFingerprint(record.runnerFingerprint, receipt.host.hostFingerprint)
      || (record.runnerFingerprint === undefined && receipt.host.hostFingerprint === undefined)
    );
}

async function currentReceiptOwnership(
  receipt: HsrEventIntegrityReceipt,
): Promise<"owns" | "different" | "unknown"> {
  const record = await loadSession(receipt.bee);
  if (record && !isArchivedSessionLifecycle(record)) {
    if (hsrEventIntegrityReceiptOwnsSession(receipt, record)) return "owns";
    if (receipt.remoteAuthority) {
      if (record.node && record.remoteLaunchId && record.remoteIncarnation) return "different";
    } else if (record.substrate === "hsr" && !record.node && record.runnerPid !== undefined) {
      if (record.runnerPid !== receipt.host.hostPid) return "different";
      if (record.runnerFingerprint && receipt.host.hostFingerprint) return "different";
    }
  }
  if (receipt.remoteAuthority) {
    const authority = await readRemoteHsrLaunchReceiptStrict(receipt.bee);
    if (authority) {
      return authority.launchId === receipt.remoteAuthority.launchId
        && authority.incarnation === receipt.remoteAuthority.incarnation
        ? "owns"
        : "different";
    }
  }
  return "unknown";
}

async function archiveStaleReceipt(receipt: HsrEventIntegrityReceipt): Promise<void> {
  await withFileLock(lockPath(receipt.bee), async () => {
    const current = await readHsrEventIntegrityReceipt(receipt.bee);
    if (!current || current.integrityId !== receipt.integrityId || current.phase !== "unresolved") return;
    const target = receiptHistoryPath(current);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(receiptPath(receipt.bee), target);
  }, { timeoutMs: 30_000 });
}

function canonicalMarker(receipt: HsrEventIntegrityReceipt): HsrEventIntegrityDoubt {
  const fenceError = `HSR event history integrity is unresolved (${receipt.integrityId}); run hive hsr-reconcile ${receipt.bee} ${receipt.integrityId} --acknowledge-loss after settling every ambiguous delivery`;
  return {
    version: 1,
    integrityId: receipt.integrityId,
    source: {
      hostPid: receipt.host.hostPid,
      startedAt: receipt.host.startedAt,
      ...(receipt.host.hostFingerprint ? { hostFingerprint: receipt.host.hostFingerprint } : {}),
      ...(receipt.remoteAuthority ? {
        remoteLaunchId: receipt.remoteAuthority.launchId,
        remoteIncarnation: receipt.remoteAuthority.incarnation,
      } : {}),
    },
    createdAt: receipt.createdAt,
    fenceError,
  };
}

/** Fence a matching canonical row; a remote authority without a local row is harmless. */
export async function fenceCanonicalHsrEventIntegrity(
  receipt: HsrEventIntegrityReceipt,
): Promise<boolean> {
  // Do not enter the Bee lifecycle lock here. A controller deliberately holds
  // that lock across provider RPC, and a source append failure must be able to
  // publish its fence and exact-stop the provider before replying. The short
  // record CAS is safe across archive/replacement: the marker is name-scoped,
  // source-qualified, and independently backed by the outside receipt.
  return withSessionLock(receipt.bee, async () => {
    const head = await readHsrEventIntegrityReceipt(receipt.bee);
    if (!head || head.integrityId !== receipt.integrityId || head.phase !== "unresolved") return false;
    const current = await loadSession(receipt.bee);
    if (!current || isArchivedSessionLifecycle(current)) return false;
    if (!hsrEventIntegrityReceiptOwnsSession(head, current)) return false;
    const marker = canonicalMarker(head);
    if (
      current.status !== "kill_failed"
      || current.lastError !== marker.fenceError
      || JSON.stringify(current.eventIntegrityDoubt) !== JSON.stringify(marker)
    ) {
      await saveSessionLocked({
        ...current,
        status: "kill_failed",
        lastError: marker.fenceError,
        eventIntegrityDoubt: marker,
        updatedAt: new Date().toISOString(),
      });
    }
    return true;
  });
}

export async function persistHsrEventIntegrityFailure(input: {
  bee: string;
  host: HsrEventIntegrityHost;
  remoteAuthority?: HsrEventIntegrityReceipt["remoteAuthority"];
  deliveryIds: string[];
  deliveryScanError?: string;
  reason: string;
}): Promise<HsrEventIntegrityReceipt> {
  const writeHead = () => withFileLock(lockPath(input.bee), async () => {
    let existing = await readHsrEventIntegrityReceipt(input.bee);
    const now = new Date().toISOString();
    if (existing?.phase === "unresolved") {
      if (!hsrEventIntegrityReceiptOwnsHost(existing, input.host, input.remoteAuthority)) {
        if ((await currentReceiptOwnership(existing)) !== "different") {
          throw new Error(
            `HSR event-integrity receipt ${existing.integrityId} already fences a different ${input.bee} generation`,
          );
        }
        const target = receiptHistoryPath(existing);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rename(receiptPath(input.bee), target);
        existing = null;
      } else {
        const deliveryIds = [...new Set([...existing.deliveryIds, ...input.deliveryIds])].sort();
        const deliveryAuthorityChanged =
          JSON.stringify(deliveryIds) !== JSON.stringify(existing.deliveryIds)
          || existing.deliveryScanError !== input.deliveryScanError;
        if (!deliveryAuthorityChanged) return existing;
        const next: HsrEventIntegrityReceipt = {
          ...existing,
          deliveryIds,
          ...(input.deliveryScanError ? { deliveryScanError: input.deliveryScanError } : {}),
          updatedAt: now,
        };
        if (!input.deliveryScanError) delete next.deliveryScanError;
        await writeReceipt(next);
        return next;
      }
    }
    if (existing?.phase === "acknowledged") {
      // The acknowledged predecessor remains immutable audit authority. A
      // later generation's genuine loss gets a new head, never overwrites the
      // operator's prior settlement proof.
      const target = receiptHistoryPath(existing);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(receiptPath(input.bee), target);
      existing = null;
    }
    const next: HsrEventIntegrityReceipt = {
      version: HSR_EVENT_INTEGRITY_VERSION,
      integrityId: randomUUID(),
      bee: input.bee,
      host: input.host,
      ...(input.remoteAuthority ? { remoteAuthority: input.remoteAuthority } : {}),
      phase: "unresolved",
      stopState: "pending",
      deliveryIds: [...new Set(input.deliveryIds)].sort(),
      ...(input.deliveryScanError ? { deliveryScanError: input.deliveryScanError } : {}),
      reason: input.reason,
      createdAt: now,
      updatedAt: now,
    };
    await writeReceipt(next);
    return next;
  }, { timeoutMs: 30_000 });

  // Publish the purge-surviving head before touching canonical state. This is
  // intentionally independent of the lifecycle lock: controller delivery may
  // hold that lock while this host reports a persistence failure. Every launch
  // dispatch rechecks this head after predecessor stop, and the short canonical
  // projection below fences all scalar isRunnable consumers without re-entry.
  if (!input.remoteAuthority) {
    return withSessionLock(input.bee, async () => {
      const current = await loadSession(input.bee);
      const currentMeta = await readHsrMetaStrict(input.bee);
      if (currentMeta && !metaOwnsObservedHost(currentMeta, input.host)) {
        throw new HsrSourceAuthorityChangedError(input.bee);
      }
      if (!currentMeta && current && !isArchivedSessionLifecycle(current)) {
        const ownsCurrent = current.substrate === "hsr"
          && !current.node
          && current.runnerPid === input.host.hostPid
          && (
            sameProcessBirthFingerprint(current.runnerFingerprint, input.host.hostFingerprint)
            || (current.runnerFingerprint === undefined && input.host.hostFingerprint === undefined)
          );
        if (!ownsCurrent) throw new HsrSourceAuthorityChangedError(input.bee);
      }
      const receipt = await writeHead();
      if (current && !isArchivedSessionLifecycle(current) && hsrEventIntegrityReceiptOwnsSession(receipt, current)) {
        const marker = canonicalMarker(receipt);
        if (
          current.status !== "kill_failed"
          || current.lastError !== marker.fenceError
          || JSON.stringify(current.eventIntegrityDoubt) !== JSON.stringify(marker)
        ) {
          await saveSessionLocked({
            ...current,
            status: "kill_failed",
            lastError: marker.fenceError,
            eventIntegrityDoubt: marker,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return receipt;
    });
  }
  const remoteHead = await readRemoteHsrLaunchReceiptStrict(input.bee);
  if (
    remoteHead
    && (
      remoteHead.launchId !== input.remoteAuthority.launchId
      || remoteHead.incarnation !== input.remoteAuthority.incarnation
      || (remoteHead.host && !sameHost(remoteHead.host, input.host))
    )
  ) {
    throw new HsrSourceAuthorityChangedError(input.bee);
  }
  const receipt = await writeHead();
  await fenceCanonicalHsrEventIntegrity(receipt);
  return receipt;
}

/**
 * Strict pre-effect/idle-observation guard for a SOURCE run directory. Remote
 * mirror projections use their own generation/cursor integrity protocol and
 * must never enter this path. On corruption, ask the exact live host to raise
 * its normal source-loss settlement; if that handoff is unavailable, publish
 * the same purge-surviving receipt ourselves before refusing all work.
 */
export async function assertHsrSourceEventLogIntegrity(input: {
  bee: string;
  meta: HsrMeta;
  operation: string;
  remoteAuthority?: HsrEventIntegrityReceipt["remoteAuthority"];
  /** Only observation needs event payloads; mutation guards validate in O(1) memory. */
  includeEvents?: boolean;
}): Promise<RunnerEvent[]> {
  if (input.meta.mirrorOfNode) return [];
  const observedHost: HsrEventIntegrityHost = {
    hostPid: input.meta.hostPid,
    startedAt: input.meta.startedAt,
    ...(input.meta.hostFingerprint ? { hostFingerprint: input.meta.hostFingerprint } : {}),
  };
  const settled = await readHsrEventIntegrityReceipt(input.bee);
  if (
    settled?.phase === "acknowledged"
    && settled.stopState === "confirmed"
    && hsrEventIntegrityReceiptOwnsHost(settled, observedHost, input.remoteAuthority)
    && await isHsrEventHistoryQuarantined(input.bee, settled.integrityId)
  ) {
    // Explicit operator settlement is durable authority for this exact stopped
    // source generation. It does not claim the bytes are clean; it only avoids
    // minting an identical new doubt while teardown/replacement removes the
    // acknowledged predecessor's run state.
    return [];
  }
  try {
    // The host persists this exact-incarnation diagnostic if event append
    // admission failed but writing the outside receipt itself was interrupted.
    // A valid-looking prefix cannot prove the lost provider event was absent;
    // recover the purge-surviving authority before admitting any more work.
    if (input.meta.eventIntegrityFailure) {
      throw new Error(input.meta.eventIntegrityFailure);
    }
    if (input.includeEvents) return await readHsrSourceEventsStrict(input.bee);
    await validateHsrSourceEventLogStrict(input.bee);
    return [];
  } catch (cause) {
    // A bounded unstable snapshot is a retryable admission refusal, not proof
    // of lost history. Never stop or publish a manual-integrity receipt merely
    // because a healthy detached writer remained busy across all read attempts.
    if (cause instanceof HsrSourceEventLogBusyError) throw cause;
    let host: HsrEventIntegrityHost = observedHost;
    const reason = `retained HSR event history failed strict validation: ${cause instanceof Error ? cause.message : String(cause)}`;
    let receipt: HsrEventIntegrityReceipt | undefined;
    let client: Awaited<ReturnType<typeof connectRpcClient>> | undefined;
    try {
      if (input.meta.controlSocket) {
        client = await connectRpcClient(input.meta.controlSocket);
        if (!host.hostFingerprint) {
          const owned = await client.call("meta") as Partial<HsrMeta>;
          if (
            owned.hostPid !== host.hostPid
            || owned.startedAt !== host.startedAt
            || !owned.hostFingerprint
          ) {
            throw new Error(`HSR control socket does not prove ${input.bee}'s legacy host birth`);
          }
          host = { ...host, hostFingerprint: owned.hostFingerprint };
        }
        const reported = parseHsrEventIntegrityReceipt(
          await client.call("eventIntegrityFailure", { host, reason }),
          input.bee,
        );
        if (!hsrEventIntegrityReceiptOwnsHost(reported, host, input.remoteAuthority)) {
          throw new Error(`HSR host reported event-integrity authority for another ${input.bee} generation`);
        }
        receipt = reported;
      }
    } catch {
      // Transport refusal and exact-host rejection are both uncertainty. Do
      // not send an unqualified stop through this socket: the name may already
      // have been rebound to a successor that correctly rejected our A token.
    } finally {
      client?.close();
    }
    if (!receipt) {
      // The socket may have rejected because this stale observer read host A
      // just before a same-name successor B was published. Re-read immutable
      // authority before creating any name-scoped outside head: an A receipt
      // must never poison, stop, or globally fence an already-admitted B.
      const currentMeta = await readHsrMetaStrict(input.bee);
      if (currentMeta && !metaOwnsObservedHost(currentMeta, host)) {
        throw new HsrSourceAuthorityChangedError(input.bee);
      }
      if (input.remoteAuthority) {
        const currentAuthority = await readRemoteHsrLaunchReceiptStrict(input.bee);
        if (
          !currentAuthority
          || currentAuthority.launchId !== input.remoteAuthority.launchId
          || currentAuthority.incarnation !== input.remoteAuthority.incarnation
          || (currentAuthority.host && !sameHost(currentAuthority.host, host))
        ) {
          throw new HsrSourceAuthorityChangedError(input.bee);
        }
      } else if (!currentMeta) {
        const current = await loadSession(input.bee);
        if (
          !current
          || current.substrate !== "hsr"
          || !!current.node
          || current.runnerPid !== host.hostPid
          || !(
            sameProcessBirthFingerprint(current.runnerFingerprint, host.hostFingerprint)
            || (current.runnerFingerprint === undefined && host.hostFingerprint === undefined)
          )
        ) {
          throw new HsrSourceAuthorityChangedError(input.bee);
        }
      }
      // A legacy/unreachable host cannot acknowledge the new handoff. The
      // outside receipt is still the fail-closed name/runtime boundary. Stop
      // proof remains doubt until a lifecycle owner performs birth-qualified
      // host and child-group teardown.
      let deliveryIds: string[] = [];
      let deliveryScanError: string | undefined;
      try {
        deliveryIds = (await readPendingHsrTurns(input.bee))
          .filter((turn) => turn.phase !== "completed" && turn.phase !== "discarded")
          .map((turn) => turn.id);
      } catch (error) {
        deliveryScanError = `pending HSR delivery authority could not be enumerated: ${error instanceof Error ? error.message : String(error)}`;
      }
      receipt = await persistHsrEventIntegrityFailure({
        bee: input.bee,
        host,
        ...(input.remoteAuthority ? { remoteAuthority: input.remoteAuthority } : {}),
        deliveryIds,
        ...(deliveryScanError ? { deliveryScanError } : {}),
        reason,
      });
      await recordHsrEventIntegrityStop(
        input.bee,
        receipt.integrityId,
        host,
        "doubt",
        "strict source-history failure was fenced; exact host/group stop proof is pending",
      );
    }
    throw new HsrSourceEventIntegrityError(
      input.bee,
      receipt.integrityId,
      `${input.operation}: ${input.bee} has unresolved HSR event history ${receipt.integrityId}`,
      { cause },
    );
  }
}

export async function recordHsrEventIntegrityDeliveryVerdict(
  bee: string,
  deliveryId: string,
  verdict: "delivered" | "discarded",
): Promise<boolean> {
  return withFileLock(lockPath(bee), async () => {
    const current = await readHsrEventIntegrityReceipt(bee);
    if (!current || current.phase !== "unresolved" || !current.deliveryIds.includes(deliveryId)) return false;
    const prior = current.deliveryVerdicts?.[deliveryId];
    if (prior && prior !== verdict) {
      throw new Error(`HSR event-integrity delivery ${deliveryId} already has verdict ${prior}`);
    }
    if (prior === verdict) return true;
    await writeReceipt({
      ...current,
      deliveryVerdicts: { ...current.deliveryVerdicts, [deliveryId]: verdict },
      updatedAt: new Date().toISOString(),
    });
    return true;
  }, { timeoutMs: 30_000 });
}

export async function recordHsrEventIntegrityStop(
  bee: string,
  integrityId: string,
  host: HsrEventIntegrityHost,
  stopState: "confirmed" | "doubt",
  stopDetail?: string,
): Promise<HsrEventIntegrityReceipt> {
  const next = await withFileLock(lockPath(bee), async () => {
    const current = await readHsrEventIntegrityReceipt(bee);
    if (!current || current.integrityId !== integrityId || !sameHost(current.host, host)) {
      throw new Error(`HSR event-integrity stop result does not own ${bee}/${integrityId}`);
    }
    if (current.phase !== "unresolved") return current;
    if (current.stopState === "confirmed" && stopState === "doubt") return current;
    const stopDetailChanged = stopDetail !== undefined && stopDetail !== current.stopDetail;
    if (current.stopState === stopState && !stopDetailChanged) return current;
    const updated: HsrEventIntegrityReceipt = {
      ...current,
      stopState,
      updatedAt: new Date().toISOString(),
      ...(stopDetail ? { stopDetail } : {}),
    };
    await writeReceipt(updated);
    return updated;
  }, { timeoutMs: 30_000 });
  await fenceCanonicalHsrEventIntegrity(next);
  return next;
}

export async function assertNoUnresolvedHsrEventIntegrity(
  bee: string,
  operation: string,
): Promise<void> {
  const receipt = await readHsrEventIntegrityReceipt(bee);
  if (receipt?.phase !== "unresolved") return;
  if ((await currentReceiptOwnership(receipt)) === "different") {
    // A completed exact replacement may expose a legacy/delayed predecessor
    // head written by older bytes. Preserve it as audit history, but do not let
    // it monopolize the name-level slot or block the proven current runtime.
    await archiveStaleReceipt(receipt);
    return;
  }
  const error = new Error(
    `${operation}: ${bee} has unresolved HSR event history ${receipt.integrityId}; provider effects may be missing from the durable event log`,
  ) as Error & { code?: string; integrityId?: string };
  error.code = "HIVE_HSR_EVENT_INTEGRITY_UNRESOLVED";
  error.integrityId = receipt.integrityId;
  throw error;
}

/** Synchronous companion for imported remote receipts projected on a row. */
export function assertNoCanonicalHsrEventIntegrityDoubt(
  record: Pick<SessionRecord, "name" | "eventIntegrityDoubt">,
  operation: string,
): void {
  if (!record.eventIntegrityDoubt) return;
  const error = new Error(
    `${operation}: ${record.name} has unresolved HSR event history ${record.eventIntegrityDoubt.integrityId}`,
  ) as Error & { code?: string; integrityId?: string };
  error.code = "HIVE_HSR_EVENT_INTEGRITY_UNRESOLVED";
  error.integrityId = record.eventIntegrityDoubt.integrityId;
  throw error;
}

/**
 * Explicit operator acknowledgement.  Stop proof and every exact delivery
 * verdict are prerequisites; this command never guesses that unknown provider
 * work was absent and never replays it.
 */
export async function acknowledgeHsrEventIntegrityLoss(
  bee: string,
  integrityId: string,
): Promise<HsrEventIntegrityReceipt> {
  const acknowledged = await withFileLock(lockPath(bee), async () => {
    let current = await readHsrEventIntegrityReceipt(bee);
    if (!current || current.integrityId !== integrityId) {
      throw new Error(`HSR event-integrity receipt ${integrityId} is not current for ${bee}`);
    }
    if (current.phase === "acknowledged") return current;
    if (current.stopState !== "confirmed") {
      throw new Error(`HSR event-integrity receipt ${integrityId} has no exact provider-stop proof`);
    }
    if (current.deliveryScanError) {
      let turns;
      try {
        turns = await readPendingHsrTurns(bee);
      } catch (error) {
        throw new Error(
          `HSR event-integrity receipt ${integrityId} cannot be acknowledged because pending delivery authority was unreadable: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      // Repair only the same locked head after a successful strict rescan.
      // Any newly discovered nonterminal ID becomes explicit ambiguity and
      // still requires its normal delivered/discarded verdict below.
      const repaired: HsrEventIntegrityReceipt = {
        ...current,
        deliveryIds: [...new Set([
          ...current.deliveryIds,
          ...turns
            .filter((turn) => turn.phase !== "completed" && turn.phase !== "discarded")
            .map((turn) => turn.id),
        ])].sort(),
        updatedAt: new Date().toISOString(),
      };
      delete repaired.deliveryScanError;
      await writeReceipt(repaired);
      current = repaired;
    }
    const deliveryVerdicts = { ...current.deliveryVerdicts };
    for (const deliveryId of current.deliveryIds) {
      if (deliveryVerdicts[deliveryId]) continue;
      const turn = await readPendingHsrTurn(bee, deliveryId);
      if (!turn || (turn.phase !== "completed" && turn.phase !== "discarded")) {
        throw new Error(
          `HSR delivery ${deliveryId} must be reconciled with hive buz reconcile ${bee} ${deliveryId} --delivered|--discard before acknowledging event loss`,
        );
      }
      deliveryVerdicts[deliveryId] = turn.phase === "completed" ? "delivered" : "discarded";
    }
    // Preserve the exact uncertain bytes and establish a fresh active sequence
    // namespace BEFORE the receipt can become non-blocking. A crash anywhere
    // before `complete.json` leaves phase=unresolved; retry resumes from the
    // immutable evidence snapshot rather than recopying the reset log.
    await quarantineHsrEventHistory(bee, current.integrityId);
    const now = new Date().toISOString();
    const next: HsrEventIntegrityReceipt = {
      ...current,
      phase: "acknowledged",
      ...(current.deliveryIds.length > 0 ? { deliveryVerdicts } : {}),
      acknowledgedAt: now,
      updatedAt: now,
    };
    await writeReceipt(next);
    return next;
  }, { timeoutMs: 30_000 });
  // Clear only this exact projection. A newer receipt may have been published
  // after the acknowledgement write and must remain fenced.
  await clearCanonicalHsrEventIntegrityProjection(bee, integrityId);
  return acknowledged;
}

async function clearCanonicalHsrEventIntegrityProjection(
  bee: string,
  integrityId: string,
): Promise<void> {
  await withSessionLock(bee, async () => {
    const current = await loadSession(bee);
    if (!current || current.eventIntegrityDoubt?.integrityId !== integrityId) return;
    const next: SessionRecord = { ...current, updatedAt: new Date().toISOString() };
    const ownsError = current.lastError === current.eventIntegrityDoubt.fenceError;
    delete next.eventIntegrityDoubt;
    if (ownsError) delete next.lastError;
    await saveSessionLocked(next);
  });
}
