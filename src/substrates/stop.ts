import type { ProcessBirthFingerprint } from "../hsr/processIdentity.js";
import type { SessionRecord } from "../store.js";
import type { Substrate } from "./types.js";

export type StrictRuntimeStopOptions = {
  launcherPgid?: number;
  launcherFingerprint?: ProcessBirthFingerprint;
  remoteLaunchId?: string;
  remoteIncarnation?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  context?: string;
};

export type StrictRuntimeStopResult = {
  alreadyGone: boolean;
  attempts: number;
};

export type ReplacementRuntimeStopOptions = Omit<
  StrictRuntimeStopOptions,
  "launcherPgid" | "launcherFingerprint"
> & {
  /** Persist unresolved explicit-stop ownership before this helper throws. */
  onStopUnconfirmed?: (message: string) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killError(result: Awaited<ReturnType<Substrate["kill"]>>): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

/**
 * Stop a runtime before launching its replacement. Unlike terminal cleanup,
 * this path has no durable kill_failed state to reconcile later, so every
 * observation and the substrate's exact cleanup result must be positive.
 */
export async function stopRuntimeStrict(
  substrate: Substrate,
  target: string,
  options: StrictRuntimeStopOptions = {},
): Promise<StrictRuntimeStopResult> {
  const context = options.context ?? `Could not stop ${target}`;
  const pollAttempts = Math.max(1, options.pollAttempts ?? 8);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 500);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let initiallyAlive: boolean;
  try {
    initiallyAlive = await substrate.hasSession(target);
  } catch (error) {
    throw new Error(`${context}: initial liveness observation failed: ${errorMessage(error)}`);
  }

  // ssh-tmux always owns a detached remote process group. A legacy/malformed
  // record without its birth evidence cannot use pane absence as process-death
  // proof, so still enter kill() and let the substrate fail closed.
  const needsRemoteGroupProof = substrate.kind === "ssh-tmux" || substrate.kind === "remote-hsr";
  // HSR liveness tracks the host, not its detached child. A false observation
  // therefore still requires the substrate's strict incarnation cleanup.
  const needsLocalHsrCleanup = substrate.kind === "hsr";
  const mustKill = initiallyAlive || options.launcherPgid !== undefined || needsRemoteGroupProof || needsLocalHsrCleanup;
  let attempts = 0;
  if (mustKill) {
    attempts += 1;
    let result: Awaited<ReturnType<Substrate["kill"]>>;
    try {
      result = await substrate.kill(target, {
        launcherPgid: options.launcherPgid,
        launcherFingerprint: options.launcherFingerprint,
        remoteLaunchId: options.remoteLaunchId,
        remoteIncarnation: options.remoteIncarnation,
      });
    } catch (error) {
      throw new Error(`${context}: kill failed: ${errorMessage(error)}`);
    }
    if (!result.ok) throw new Error(`${context}: exact cleanup unconfirmed: ${killError(result)}`);
    if (result.incarnationStopped) return { alreadyGone: !initiallyAlive, attempts };
  }

  for (let i = 0; i < pollAttempts; i += 1) {
    let alive: boolean;
    try {
      alive = await substrate.hasSession(target);
    } catch (error) {
      throw new Error(`${context}: final liveness observation failed: ${errorMessage(error)}`);
    }
    if (!alive) return { alreadyGone: !initiallyAlive, attempts };
    if (i < pollAttempts - 1 && pollIntervalMs > 0) await sleep(pollIntervalMs);
  }
  throw new Error(`${context}: ${target} is still alive after exact cleanup`);
}

/**
 * Resolve ownership before replacing an existing runtime incarnation.
 *
 * `kill_failed` means an explicit stop was attempted but exact teardown could
 * not be proved. A missing local tmux target is therefore insufficient: the
 * detached launcher group may still be alive, and a replacement would create
 * duplicate ownership. Modern local records must carry both the group id and
 * its birth fingerprint so strict cleanup can prove the exact incarnation.
 */
export async function stopRuntimeForReplacement(
  record: SessionRecord,
  substrate: Substrate,
  target: string,
  options: ReplacementRuntimeStopOptions = {},
): Promise<StrictRuntimeStopResult> {
  const context = options.context ?? `Could not stop ${record.name} before replacement`;
  if (
    record.status === "kill_failed"
    && substrate.kind === "local-tmux"
    && (record.launcherPgid === undefined || record.launcherFingerprint === undefined)
  ) {
    throw new Error(`${context}: unresolved stop state and no exact launcher identity`);
  }
  const { onStopUnconfirmed, ...strictOptions } = options;
  try {
    return await stopRuntimeStrict(substrate, target, {
      ...strictOptions,
      context,
      launcherPgid: record.launcherPgid,
      launcherFingerprint: record.launcherFingerprint,
      remoteLaunchId: record.remoteLaunchId,
      remoteIncarnation: record.remoteIncarnation,
    });
  } catch (error) {
    const message = errorMessage(error);
    await onStopUnconfirmed?.(message);
    throw error;
  }
}
