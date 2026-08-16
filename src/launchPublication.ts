import { loadSession, saveSession, updateSession, type SessionRecord } from "./store.js";
import type { NewSessionResult, Substrate } from "./substrates/types.js";
import type { RemoteHsrSubstrate } from "./substrates/remote-hsr.js";
import type { BeeNameLaunchReservation } from "./nameAdmission.js";
import { sameProcessBirthFingerprint } from "./hsr/processIdentity.js";
import { sessionLifecycleTransactionForHeldLock } from "./lifecycle.js";
import { purgeSessionAfterConfirmedRuntimeStopInTransaction } from "./kill.js";

export type LaunchCleanupProof = { stopped: boolean; detail: string };

export type FreshLaunchRollbackResult = {
  cleanup: LaunchCleanupProof;
  /** Runtime absence and all local publication state were settled exactly. */
  settled: boolean;
  /** A durable canonical row and/or launch journal retains stop doubt. */
  ownershipPersisted: boolean;
  detail: string;
};

export type FreshLaunchRollbackOptions = {
  context: string;
  cleanup: () => Promise<LaunchCleanupProof>;
  /** Remote launch dispatch can need a richer locator than generic retention. */
  retainStopDoubt?: (detail: string) => Promise<void>;
  /** Deterministic coordinator-crash seam after stop dispatch, before purge. */
  afterStopDispatch?: () => void | Promise<void>;
  /** Exact pre-publication runtime artifacts not covered by SessionRecord purge. */
  cleanupPrepublicationArtifacts?: () => void | Promise<void>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exactFreshLaunchRecord(expected: SessionRecord, current: SessionRecord): boolean {
  const common = current.name === expected.name
    && current.createdAt === expected.createdAt
    && current.id === expected.id
    && current.uuid === expected.uuid
    && (current.runtimeGeneration ?? 0) === (expected.runtimeGeneration ?? 0)
    && current.executionRunId === expected.executionRunId;
  if (!common) return false;

  if (expected.remoteLaunchId !== undefined || expected.remoteIncarnation !== undefined) {
    return current.node === expected.node
      && current.remoteLaunchId === expected.remoteLaunchId
      && current.remoteIncarnation === expected.remoteIncarnation;
  }
  if (expected.substrate === "hsr") {
    return current.substrate === "hsr"
      && current.runnerPid === expected.runnerPid
      && sameProcessBirthFingerprint(current.runnerFingerprint, expected.runnerFingerprint);
  }
  return current.substrate === expected.substrate
    && current.node === expected.node
    && current.tmuxTarget === expected.tmuxTarget
    && current.agentPaneId === expected.agentPaneId
    && current.launcherPgid === expected.launcherPgid
    && (
      expected.launcherFingerprint === undefined
        ? current.launcherFingerprint === undefined
        : sameProcessBirthFingerprint(current.launcherFingerprint, expected.launcherFingerprint)
    );
}

async function retainRollbackDoubt(
  reservation: BeeNameLaunchReservation,
  options: FreshLaunchRollbackOptions,
  detail: string,
): Promise<boolean> {
  try {
    await (options.retainStopDoubt ?? ((value) => reservation.retainStopDoubt(value)))(detail);
    return true;
  } catch {
    return false;
  }
}

/**
 * Roll back a fresh-name launch while `withBeeNameLaunchAdmission` still owns
 * the Bee lifecycle lock.
 *
 * Save failures are ambiguous because an atomic rename can commit before the
 * write reports failure. Re-read the canonical row and birth-qualify it. When
 * it exists, commit the non-runnable kill_failed fence before the first stop
 * signal, then keep the already-held lifecycle lock through exact stop and
 * record-last purge. Missing/read-mismatched evidence sends no signal.
 */
export async function rollbackFreshLaunchPublication(
  reservation: BeeNameLaunchReservation,
  expected: SessionRecord,
  options: FreshLaunchRollbackOptions,
): Promise<FreshLaunchRollbackResult> {
  let current: SessionRecord | null;
  try {
    current = await loadSession(expected.name);
  } catch (error) {
    const detail = `${options.context}; canonical SessionRecord read failed before stop dispatch: ${messageOf(error)}`;
    return {
      cleanup: { stopped: false, detail: "stop was not dispatched" },
      settled: false,
      ownershipPersisted: await retainRollbackDoubt(reservation, options, detail),
      detail,
    };
  }

  let lifecycle = current ? sessionLifecycleTransactionForHeldLock(current) : undefined;
  let stopping: SessionRecord | undefined;
  if (current) {
    if (!exactFreshLaunchRecord(expected, current)) {
      const detail = `${options.context}; canonical SessionRecord does not match the launched runtime; stop was not dispatched`;
      return {
        cleanup: { stopped: false, detail: "stop was not dispatched" },
        settled: false,
        ownershipPersisted: await retainRollbackDoubt(reservation, options, detail),
        detail,
      };
    }
    try {
      const refreshed = await lifecycle!.refresh();
      if (!exactFreshLaunchRecord(expected, refreshed)) {
        throw new Error("canonical launch generation changed before stop dispatch");
      }
      stopping = await lifecycle!.commit({
        status: "kill_failed",
        lastError: `${options.context}; exact runtime cleanup is in progress`,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const detail = `${options.context}; canonical stop-intent fence failed before stop dispatch: ${messageOf(error)}`;
      return {
        cleanup: { stopped: false, detail: "stop was not dispatched" },
        settled: false,
        ownershipPersisted: await retainRollbackDoubt(reservation, options, detail),
        detail,
      };
    }
  }

  let cleanup: LaunchCleanupProof;
  try {
    cleanup = await options.cleanup();
  } catch (error) {
    cleanup = { stopped: false, detail: messageOf(error) };
  }

  try {
    await options.afterStopDispatch?.();
  } catch (error) {
    const detail = `${options.context}; coordinator failed after stop dispatch: ${messageOf(error)}`;
    const journal = await retainRollbackDoubt(reservation, options, detail);
    return {
      cleanup,
      settled: false,
      ownershipPersisted: !!stopping || journal,
      detail,
    };
  }

  if (!cleanup.stopped) {
    const detail = `${options.context}; exact launched runtime cleanup unconfirmed: ${cleanup.detail}`;
    const journal = await retainRollbackDoubt(reservation, options, detail);
    if (lifecycle && stopping) {
      await lifecycle.commit({
        status: "kill_failed",
        lastError: detail,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      return { cleanup, settled: false, ownershipPersisted: true, detail };
    }
    const record = await persistUnconfirmedLaunchOwnership(expected, cleanup.detail);
    return { cleanup, settled: false, ownershipPersisted: record || journal, detail };
  }

  if (!lifecycle || !stopping) {
    try {
      await options.cleanupPrepublicationArtifacts?.();
      await reservation.clearAfterConfirmedStop();
      return {
        cleanup,
        settled: true,
        ownershipPersisted: false,
        detail: "exact pre-publication runtime stop and launch-journal cleanup confirmed",
      };
    } catch (error) {
      const detail = `${options.context}; runtime stopped but launch-journal cleanup failed: ${messageOf(error)}`;
      return {
        cleanup,
        settled: false,
        ownershipPersisted: await retainRollbackDoubt(reservation, options, detail),
        detail,
      };
    }
  }

  try {
    await purgeSessionAfterConfirmedRuntimeStopInTransaction(
      lifecycle,
      stopping,
      { emitLedger: false },
    );
    // Purge removes the on-disk journal through the exact record proof. Also
    // settle this callback's in-memory handle, or the outer admission catch
    // would interpret it as unfinished and recreate phase=launched.
    await reservation.clearAfterConfirmedStop();
    return {
      cleanup,
      settled: true,
      ownershipPersisted: false,
      detail: "exact runtime and canonical fresh-launch publication were purged",
    };
  } catch (error) {
    const detail = `${options.context}; runtime stopped but canonical publication purge failed: ${messageOf(error)}`;
    await retainRollbackDoubt(reservation, options, detail);
    await lifecycle.commit({
      status: "kill_failed",
      lastError: detail,
      updatedAt: new Date().toISOString(),
    }).catch(() => undefined);
    return { cleanup, settled: false, ownershipPersisted: true, detail };
  }
}

/** Exact cleanup of the concrete tmux/ssh incarnation returned by newSession. */
export async function cleanupLaunchedTmuxIncarnation(
  substrate: Substrate,
  target: string,
  launch: NewSessionResult,
): Promise<LaunchCleanupProof> {
  try {
    const result = substrate.killIncarnation
      ? await substrate.killIncarnation(target, launch)
      : await substrate.kill(target, {
          launcherPgid: launch.launcherPgid,
          launcherFingerprint: launch.launcherFingerprint,
        });
    if (!result.ok) {
      return {
        stopped: false,
        detail: result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
      };
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!(await substrate.hasSession(target))) {
        return { stopped: true, detail: "exact launched tmux incarnation stop confirmed" };
      }
      if (attempt < 9) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return { stopped: false, detail: `${target} remained live after exact cleanup` };
  } catch (error) {
    return { stopped: false, detail: messageOf(error) };
  }
}

/** Remote HSR authority serializes a name, so its strict kill is incarnation-safe. */
export async function cleanupLaunchedRemoteHsrIncarnation(
  substrate: RemoteHsrSubstrate,
  target: string,
  locator: { launchId: string; incarnation?: string },
): Promise<LaunchCleanupProof> {
  try {
    const result = await substrate.killRemoteIncarnation(target, locator);
    if (!result.ok) {
      return {
        stopped: false,
        detail: result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
      };
    }
    if (!result.incarnationStopped) {
      return { stopped: false, detail: "remote authority did not return exact-incarnation stop proof" };
    }
    return { stopped: true, detail: "remote authority confirmed exact cleanup and retained a terminal tombstone" };
  } catch (error) {
    return { stopped: false, detail: messageOf(error) };
  }
}

/**
 * Preserve the only known runtime locator when post-launch cleanup is not
 * proven. The name lifecycle lock must be held by the caller.
 */
export async function persistUnconfirmedLaunchOwnership(
  record: SessionRecord,
  detail: string,
): Promise<boolean> {
  const patch = {
    status: "kill_failed" as const,
    lastError: `spawn publication failed; exact launched runtime cleanup unconfirmed: ${detail}`,
    updatedAt: new Date().toISOString(),
  };
  try {
    const current = await loadSession(record.name);
    const publishedThisLaunch = !!current
      && current.createdAt === record.createdAt
      && current.id === record.id
      && current.runnerPid === record.runnerPid
      && current.launcherPgid === record.launcherPgid
      && current.remoteLaunchId === record.remoteLaunchId
      && current.remoteIncarnation === record.remoteIncarnation;
    if (publishedThisLaunch) {
      return (await updateSession(record.name, patch)) !== null;
    }
    // Name admission may deliberately reuse a cursor-less dead/done legacy
    // row. If publication failed before overwriting it, patching that old row
    // would preserve the wrong pid/pgid and lose the escaped new incarnation.
    // Publish the provisional ownership row in full instead.
    await saveSession({ ...record, ...patch });
    return true;
  } catch {
    return false;
  }
}

export function launchPublicationError(
  cause: unknown,
  cleanup: LaunchCleanupProof,
  ownershipPersisted: boolean,
  settlement?: { settled: boolean; detail: string },
): Error {
  const message = messageOf(cause);
  return new Error(
    `${message}; exact launched runtime cleanup ${cleanup.stopped ? "confirmed" : `unconfirmed: ${cleanup.detail}`}`
      + (settlement && !settlement.settled ? `; canonical publication settlement unconfirmed: ${settlement.detail}` : "")
      + (!cleanup.stopped ? `; stop-doubt ownership ${ownershipPersisted ? "persisted" : "could not be persisted"}` : ""),
    { cause },
  );
}
