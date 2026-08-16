import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertNoUnresolvedHsrAnswerOwnership,
  assertNoUnresolvedHsrAnswerReceiptsForBee,
} from "./answerReceipt.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import type { ProcessBirthFingerprint } from "./hsr/processIdentity.js";
import {
  captureProcessBirthFingerprint,
  inspectProcessBirth,
  sameProcessBirthFingerprint,
} from "./hsr/processIdentity.js";
import {
  hsrMetaProvesProviderNeverStarted,
  hsrRunDir,
  readHsrMetaStrict,
  verifyHsrEventStreamClosure,
} from "./hsr/runDir.js";
import {
  assertNoCanonicalHsrEventIntegrityDoubt,
  assertHsrSourceEventLogIntegrity,
  assertNoUnresolvedHsrEventIntegrity,
  fenceCanonicalHsrEventIntegrity,
  readHsrEventIntegrityReceipt,
} from "./hsr/eventIntegrity.js";
import { withSessionLifecycleLock, type SessionLifecycleTransaction } from "./lifecycle.js";
import { isActiveSessionLifecycle } from "./stateMachine.js";
import { currentSessionRuntimeReplacement, loadSession, safeName, type SessionRecord } from "./store.js";
import type { NewSessionResult, SubstrateKind } from "./substrates/types.js";

export type TmuxLaunchReservationRuntime = {
  kind: "tmux";
  substrate: Extract<SubstrateKind, "local-tmux" | "ssh-tmux">;
  target: string;
  node?: string;
  paneId: string;
  launcherPgid?: number;
  launcherFingerprint?: ProcessBirthFingerprint;
};

export type HsrLaunchReservationRuntime = {
  kind: "hsr";
  substrate: "hsr";
  hostPid: number;
  hostFingerprint?: ProcessBirthFingerprint;
  childAdmission?: "pending" | "admitted" | "none";
};

export type RemoteHsrLaunchReservationRuntime = {
  kind: "remote-hsr";
  substrate: "remote-hsr";
  node: string;
  remoteLaunchId: string;
  remoteIncarnation?: string;
};

export type LaunchReservationRuntime =
  | TmuxLaunchReservationRuntime
  | HsrLaunchReservationRuntime
  | RemoteHsrLaunchReservationRuntime;

export type BeeNameLaunchReservationRecord = {
  version: 1;
  reservationId: string;
  name: string;
  operation: string;
  phase: "reserved" | "stopping" | "dispatching" | "launched" | "stop_doubt" | "published";
  coordinatorPid: number;
  coordinatorFingerprint: ProcessBirthFingerprint;
  createdAt: string;
  updatedAt: string;
  /** Exact canonical generation whose runtime this operation is replacing. */
  replacementOf?: { createdAt: string; id?: string; uuid?: string; runtimeGeneration: number };
  runtime?: LaunchReservationRuntime;
  externalPublication?: { node: string; remoteLaunchId: string; remoteIncarnation: string };
  publishedRecord?: { createdAt: string; id?: string; uuid?: string; runtimeGeneration: number };
  lastError?: string;
};

export type BeeNameLaunchReservation = {
  readonly id: string;
  readonly name: string;
  readonly prelaunch: boolean;
  readonly settled: boolean;
  /** Fence work admission before the predecessor receives any stop signal. */
  markPredecessorStopping(): Promise<void>;
  /** Persist ambiguity before invoking any operation that may create a runtime. */
  markLaunchDispatch(): Promise<void>;
  /** Persist the remote authority's client launch id before dispatch. */
  markRemoteLaunchDispatch(input: { node: string; remoteLaunchId: string }): Promise<void>;
  /** Bind the remote-issued immutable incarnation immediately after response. */
  recordRemoteLaunch(input: { node: string; remoteLaunchId: string; remoteIncarnation: string }): Promise<void>;
  /** Persist the concrete newSession result before constructing/publishing a row. */
  recordTmuxLaunch(input: {
    substrate: Extract<SubstrateKind, "local-tmux" | "ssh-tmux">;
    target: string;
    node?: string;
    launch: NewSessionResult;
  }): Promise<void>;
  /** Persist the detached local HSR host locator as soon as spawn returns. */
  recordHsrLaunch(input: {
    hostPid: number;
    hostFingerprint?: ProcessBirthFingerprint;
    childAdmission?: "pending" | "admitted" | "none";
  }): Promise<void>;
  /** Clear the journal only after a matching birth-qualified SessionRecord exists. */
  promotePublished(record: SessionRecord): Promise<void>;
  /** Remote authority supplied its own immutable launch token/incarnation proof. */
  promoteExternallyPublished(record: SessionRecord): Promise<void>;
  /** Cleanup positively proved that this launch left no owned runtime behind. */
  clearAfterConfirmedStop(): Promise<void>;
  /** Keep the concrete launch locator fenced when exact cleanup is unconfirmed. */
  retainStopDoubt(detail: string): Promise<void>;
  /** Retain the complete remote locator even if its first journal update failed. */
  retainRemoteStopDoubt(
    input: { node: string; remoteLaunchId: string; remoteIncarnation?: string },
    detail: string,
  ): Promise<void>;
  /** @internal Persist callback failure without weakening the ownership fence. */
  noteFailure(detail: string): Promise<void>;
  /** @internal Release only a reservation whose launch dispatch never began. */
  clearBeforeLaunchFailure(): Promise<void>;
};

export type BeeNameLaunchAdmissionOptions = {
  operation?: string;
};

type ReservationState = BeeNameLaunchReservationRecord["phase"] | "cleared";

/** Stable, traversal-proof location for the one durable reservation per Bee name. */
export function beeNameLaunchReservationPath(name: string, root = storeRoot()): string {
  const directory = resolve(root, "launch-reservations");
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
  const target = resolve(directory, `${safeName(name).slice(0, 80)}-${digest}.json`);
  if (dirname(target) !== directory) throw new Error(`launch reservation escaped its store root: ${name}`);
  return target;
}

export async function readBeeNameLaunchReservation(
  name: string,
  root = storeRoot(),
): Promise<BeeNameLaunchReservationRecord | null> {
  const path = beeNameLaunchReservationPath(name, root);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`launch reservation for ${name} is unreadable; exact ownership must be resolved before reuse`, {
      cause: error,
    });
  }
  if (!isLaunchReservationRecord(parsed) || parsed.name !== name) {
    throw new Error(`launch reservation for ${name} is malformed; exact ownership must be resolved before reuse`);
  }
  return parsed;
}

/**
 * Purge the redundant residue of a publication whose canonical row still
 * proves the exact birth. Call this before deleting that row; failure must
 * abort the purge so publication evidence is never destroyed out of order.
 */
export async function clearPublishedBeeNameLaunchReservationForPurge(
  record: SessionRecord,
  options: { runtimeStopConfirmed?: boolean } = {},
): Promise<void> {
  const reservation = await readBeeNameLaunchReservation(record.name);
  if (!reservation) return;
  const matchingPublished = (
    reservation.phase !== "published"
      ? false
      : !!reservation.publishedRecord && reservationMatchesRecord(reservation, record)
  );
  const confirmedAmbiguousLaunch = options.runtimeStopConfirmed === true
    && (reservation.phase === "dispatching" || reservation.phase === "launched" || reservation.phase === "stop_doubt")
    && reservation.runtime !== undefined
    && reservationRuntimeMayOwnRecord(reservation.runtime, record);
  const confirmedPredecessorOnlyAttempt = options.runtimeStopConfirmed === true
    && (reservation.phase === "reserved" || reservation.phase === "stopping")
    && replacementSourceMatchesRecord(reservation, record);
  if (!matchingPublished && !confirmedAmbiguousLaunch && !confirmedPredecessorOnlyAttempt) {
    throw new Error(
      `refusing to purge ${record.name} while a non-matching launch reservation still owns the name`,
    );
  }
  await removeOwnedReservation(reservation);
}

/**
 * Reserve a Bee name through runtime launch and birth-qualified publication.
 *
 * The lifecycle lock closes concurrent in-flight races. The journal closes the
 * process-crash gap that the lock cannot: it is written before any launch and
 * upgraded with the concrete pid/pgid immediately after newSession/spawn
 * returns. A crashed coordinator therefore leaves an explicit, non-runnable
 * ownership fence instead of making the name look safely reusable.
 */
export async function withBeeNameLaunchAdmission<T>(
  name: string,
  launchAndPublish: (reservation: BeeNameLaunchReservation) => Promise<T>,
  options: BeeNameLaunchAdmissionOptions = {},
): Promise<T> {
  return withSessionLifecycleLock(name, async () => {
    let reservation = await readBeeNameLaunchReservation(name);
    const existing = await loadSession(name);
    if (existing) {
      assertNoCanonicalHsrEventIntegrityDoubt(existing, options.operation ?? "launch");
    }

    // A coordinator may die after the SessionRecord's atomic rename but before
    // deleting the journal. Matching birth evidence proves publication won;
    // collapse that redundant fence before applying the ordinary row policy.
    if (
      reservation?.phase === "published"
      && existing
      && reservationMatchesRecord(reservation, existing)
    ) {
      // Failure to remove is ownership uncertainty, not permission to forget
      // the fence. In particular a cursor-less terminal row could otherwise be
      // overwritten while the journal still durably claims its runtime.
      await removeOwnedReservation(reservation);
      reservation = null;
    }

    // Only a strictly pre-dispatch reservation is reclaimable. Bind its owner
    // to process birth so a long wait, a stale lifecycle lock, or PID reuse can
    // never mistake a different live process for the coordinator that wrote it.
    if (reservation?.phase === "reserved") {
      const verdict = await inspectProcessBirth(
        reservation.coordinatorPid,
        reservation.coordinatorFingerprint,
      );
      if (
        verdict === "gone"
        || verdict === "mismatch"
        || (reservation.coordinatorPid === process.pid && verdict === "match")
      ) {
        await removeOwnedReservation(reservation);
        reservation = null;
      }
    }

    if (existing && (
      existing.stateMachine !== undefined
      || isActiveSessionLifecycle(existing)
      || existing.status === "kill_failed"
    )) {
      throw new Error(
        `session record already owns name ${name}; retire it or resolve its stop before launching a replacement`,
      );
    }
    if (reservation) {
      throw new Error(
        `launch reservation already owns name ${name} (${reservation.phase}); resolve its exact runtime ownership before reuse`,
      );
    }
    await assertNoUnresolvedHsrAnswerReceiptsForBee(name, options.operation ?? "launch");
    await assertNoUnresolvedHsrEventIntegrity(name, options.operation ?? "launch");
    const hsrMeta = await readHsrMetaStrict(name);
    if (hsrMeta || await hsrRunStateExists(name)) {
      throw new Error(
        `HSR run state already owns name ${name}; complete exact cleanup before launching a replacement`,
      );
    }

    const now = new Date().toISOString();
    const coordinatorFingerprint = await captureProcessBirthFingerprint(process.pid);
    if (!coordinatorFingerprint) {
      throw new Error(`cannot reserve ${name}: coordinator process birth identity is unavailable`);
    }
    const initial: BeeNameLaunchReservationRecord = {
      version: 1,
      reservationId: randomUUID(),
      name,
      operation: options.operation ?? "launch",
      phase: "reserved",
      coordinatorPid: process.pid,
      coordinatorFingerprint,
      createdAt: now,
      updatedAt: now,
    };
    await writeReservation(initial);
    const handle = new DurableBeeNameLaunchReservation(initial);
    try {
      const value = await launchAndPublish(handle);
      if (!handle.settled) {
        await handle.noteFailure("launch callback returned before birth-qualified publication");
        throw new Error(`launch for ${name} returned before its reservation was promoted`);
      }
      return value;
    } catch (error) {
      if (handle.prelaunch) {
        // Dispatch was never attempted, so this invocation cannot own a
        // launched process. Remove only its own reservation; a failed unlink
        // is safely conservative and leaves the name fenced.
        await handle.clearBeforeLaunchFailure().catch(() => undefined);
      } else if (!handle.settled) {
        await handle.noteFailure(messageOf(error)).catch(() => undefined);
      }
      throw error;
    }
  });
}

/**
 * Fail closed on a fresh/replacement launch journal while the caller already
 * owns this Bee's lifecycle lock. Only a fully published journal whose exact
 * canonical generation and birth still match is redundant and healable.
 * `launched` is deliberately unresolved: record rename may have won while
 * spawn-options/brief publication still failed.
 */
export async function assertNoUnresolvedBeeNameLaunchReservationInAdmission(
  record: SessionRecord,
  operation = "new work",
): Promise<void> {
  const reservation = await readBeeNameLaunchReservation(record.name);
  if (!reservation) return;
  if (reservation.phase === "published" && reservationMatchesRecord(reservation, record)) {
    await removeOwnedReservation(reservation);
    return;
  }
  throw new Error(
    `${operation}: ${record.name} has unresolved launch ownership (${reservation.phase}); exact reconciliation is required`,
  );
}

/**
 * Fence or heal a prior replacement attempt before its predecessor is stopped.
 *
 * Callers already hold the Bee's lifecycle transaction. A journal whose exact
 * launched birth is now canonical proves the prior publication committed and
 * is redundant. A dead coordinator may release only a strictly pre-dispatch
 * reservation. Every other phase remains an ownership fence: replay must not
 * launch a second replacement beside an escaped first one.
 */
export async function reconcileBeeReplacementLaunchAdmission(
  lifecycle: SessionLifecycleTransaction,
): Promise<SessionRecord> {
  const current = await lifecycle.refresh();
  await admitReplacementReservation(current);
  return current;
}

/**
 * Journal one runtime replacement while the caller's lifecycle transaction is
 * held. Unlike fresh-name admission this deliberately accepts a canonical row,
 * binding the attempt to that row's exact identity and runtime generation.
 */
export async function withBeeReplacementLaunchAdmission<T>(
  lifecycle: SessionLifecycleTransaction,
  operation: string,
  launchAndPublish: (reservation: BeeNameLaunchReservation) => Promise<T>,
): Promise<T> {
  const handle = await beginBeeReplacementOperation(lifecycle, operation);
  return continueBeeReplacementLaunchAdmission(handle, launchAndPublish);
}

/** Continue the successor-launch half of an already fenced replacement. */
export async function continueBeeReplacementLaunchAdmission<T>(
  handle: BeeNameLaunchReservation,
  launchAndPublish: (reservation: BeeNameLaunchReservation) => Promise<T>,
): Promise<T> {
  const name = handle.name;
  try {
    const value = await launchAndPublish(handle);
    if (!handle.settled) {
      await handle.noteFailure("replacement callback returned before birth-qualified publication");
      throw new Error(`replacement launch for ${name} returned before its reservation was promoted`);
    }
    return value;
  } catch (error) {
    if (handle.prelaunch) {
      await handle.clearBeforeLaunchFailure().catch(() => undefined);
    } else if (!handle.settled) {
      await handle.noteFailure(messageOf(error)).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Begin (or safely adopt after coordinator death) the whole replacement,
 * durably fencing ordinary work before predecessor teardown starts.
 */
export async function beginBeeReplacementOperation(
  lifecycle: SessionLifecycleTransaction,
  operation: string,
): Promise<BeeNameLaunchReservation> {
  const current = await lifecycle.refresh();
  assertNoCanonicalHsrEventIntegrityDoubt(current, `replacement operation ${operation}`);
  await assertNoUnresolvedHsrEventIntegrity(current.name, `replacement operation ${operation}`);
  await assertReplacementSourceEventIntegrity(current, `replacement operation ${operation}`);
  await assertNoUnresolvedHsrAnswerOwnership(current, `replacement operation ${operation}`);
  if (current.deliveryStopDoubt) {
    throw new Error(
      `replacement operation ${operation} cannot start for ${current.name}: unresolved delivery ownership `
      + `${current.deliveryStopDoubt.deliveryId} must be reconciled first`,
    );
  }
  const existing = await readBeeNameLaunchReservation(current.name);
  if (
    existing?.phase === "stopping"
    && existing.operation === operation
    && replacementSourceMatchesRecord(existing, current)
  ) {
    const verdict = await inspectProcessBirth(existing.coordinatorPid, existing.coordinatorFingerprint);
    // The caller holds the Bee's non-reentrant lifecycle lock. If the journal
    // names this same process, acquiring that lock proves the earlier callback
    // already unwound even though the long-lived daemon process itself remains
    // alive; a different live process still remains a hard fence.
    const priorSameProcessCallSettled = existing.coordinatorPid === process.pid && verdict === "match";
    if (verdict === "gone" || verdict === "mismatch" || priorSameProcessCallSettled) {
      if (current.status !== "kill_failed") {
        throw new Error(
          `cannot adopt replacement for ${current.name}: its stopping journal is not paired with a non-runnable canonical fence`,
        );
      }
      const coordinatorFingerprint = await captureProcessBirthFingerprint(process.pid);
      if (!coordinatorFingerprint) {
        throw new Error(`cannot adopt replacement for ${current.name}: coordinator birth identity is unavailable`);
      }
      const adopted: BeeNameLaunchReservationRecord = {
        ...existing,
        operation,
        coordinatorPid: process.pid,
        coordinatorFingerprint,
        updatedAt: new Date().toISOString(),
      };
      await writeReservation(adopted);
      const adoptedAt = new Date().toISOString();
      await lifecycle.commit({
        runtimeReplacement: {
          version: 1,
          reservationId: adopted.reservationId,
          operation,
          sourceGeneration: current.runtimeGeneration ?? 0,
          state: "pending",
          startedAt: current.runtimeReplacement?.reservationId === adopted.reservationId
            ? current.runtimeReplacement.startedAt
            : adopted.createdAt,
          updatedAt: adoptedAt,
        },
        updatedAt: adoptedAt,
      });
      return new DurableBeeNameLaunchReservation(adopted);
    }
  }

  if (existing?.phase === "stopping" && replacementSourceMatchesRecord(existing, current)) {
    throw new Error(
      `replacement operation ${existing.operation} already owns ${current.name}; refusing to reinterpret it as ${operation}`,
    );
  }

  const handle = await createBeeReplacementLaunchAdmission(lifecycle, operation);
  const startedAt = new Date().toISOString();
  try {
    await lifecycle.commit({
      status: "kill_failed",
      lastError: `replacement operation ${operation} is stopping generation ${current.runtimeGeneration ?? 0}`,
      runtimeReplacement: {
        version: 1,
        reservationId: handle.id,
        operation,
        sourceGeneration: current.runtimeGeneration ?? 0,
        state: "pending",
        startedAt,
        updatedAt: startedAt,
      },
      updatedAt: startedAt,
    });
  } catch (error) {
    // No stop signal has been sent yet. Remove our journal before surfacing the
    // failed canonical fence; an unlink fault remains conservatively fenced.
    await handle.clearAfterConfirmedStop().catch(() => undefined);
    throw error;
  }
  // The canonical row is already non-runnable. Persisting `stopping` now makes
  // every subsequent coordinator crash replayable only by exact-generation
  // adoption; a crash while the journal is still `reserved` proves no stop was
  // dispatched and is safely reclaimable.
  try {
    await handle.markPredecessorStopping();
  } catch (error) {
    // The reservation write is an ambiguous durability boundary: a failed
    // atomic write may have left either `reserved` or `stopping` on disk. Never
    // roll the canonical work fence back or ask the in-memory handle to rewrite
    // the journal from its stale phase. Instead expose a genuine, mutation-
    // closed admission failure until exact reservation reconciliation repairs
    // it; this must not masquerade forever as a normal lazy wake.
    const message = messageOf(error);
    const currentFenced = await lifecycle.refresh();
    const replacement = currentSessionRuntimeReplacement(currentFenced);
    const failedAt = new Date().toISOString();
    await lifecycle.commit({
      status: "kill_failed",
      lastError: `replacement operation ${operation} could not persist predecessor-stop admission: ${message}`,
      ...(replacement ? {
        runtimeReplacement: {
          ...replacement,
          state: "stop-failed" as const,
          updatedAt: failedAt,
          detail: `predecessor-stop admission persistence failed: ${message}`,
        },
      } : {}),
      updatedAt: failedAt,
    });
    throw error;
  }
  return handle;
}

/** Low-level form for operations whose existing cleanup transaction spans launch and publication. */
export async function beginBeeReplacementLaunchAdmission(
  lifecycle: SessionLifecycleTransaction,
  operation: string,
): Promise<BeeNameLaunchReservation> {
  return createBeeReplacementLaunchAdmission(lifecycle, operation);
}

async function createBeeReplacementLaunchAdmission(
  lifecycle: SessionLifecycleTransaction,
  operation: string,
): Promise<DurableBeeNameLaunchReservation> {
  if (!operation) throw new Error("replacement launch operation must be non-empty");
  const current = await reconcileBeeReplacementLaunchAdmission(lifecycle);
  assertNoCanonicalHsrEventIntegrityDoubt(current, `replacement launch ${operation}`);
  await assertNoUnresolvedHsrEventIntegrity(current.name, `replacement launch ${operation}`);
  await assertReplacementSourceEventIntegrity(current, `replacement launch ${operation}`);
  await assertNoUnresolvedHsrAnswerOwnership(current, `replacement launch ${operation}`);
  const now = new Date().toISOString();
  const coordinatorFingerprint = await captureProcessBirthFingerprint(process.pid);
  if (!coordinatorFingerprint) {
    throw new Error(`cannot reserve replacement for ${current.name}: coordinator process birth identity is unavailable`);
  }
  const initial: BeeNameLaunchReservationRecord = {
    version: 1,
    reservationId: randomUUID(),
    name: current.name,
    operation,
    phase: "reserved",
    coordinatorPid: process.pid,
    coordinatorFingerprint,
    createdAt: now,
    updatedAt: now,
    replacementOf: sessionGenerationProof(current),
  };
  await writeReservation(initial);
  return new DurableBeeNameLaunchReservation(initial);
}

async function assertReplacementSourceEventIntegrity(
  current: SessionRecord,
  operation: string,
): Promise<void> {
  if (current.substrate !== "hsr" || current.node) return;
  const meta = await readHsrMetaStrict(current.name);
  if (!meta) return;
  if (
    (current.runnerPid !== undefined && current.runnerPid !== meta.hostPid)
    || (current.runnerFingerprint !== undefined
      && !sameProcessBirthFingerprint(current.runnerFingerprint, meta.hostFingerprint))
  ) {
    throw new Error(`${operation}: ${current.name}'s HSR run directory belongs to another host generation`);
  }
  if (meta.status === "exited") {
    const clean = hsrMetaProvesProviderNeverStarted(meta)
      || await verifyHsrEventStreamClosure(current.name, meta);
    if (!clean) {
      await assertHsrSourceEventLogIntegrity({
        bee: current.name,
        meta: {
          ...meta,
          eventIntegrityFailure: "runner host exited without durable terminal event-stream proof",
        },
        operation,
      });
    }
  } else {
    const host = await inspectProcessBirth(meta.hostPid, meta.hostFingerprint);
    if (host === "gone" || host === "mismatch") {
      await assertHsrSourceEventLogIntegrity({
        bee: current.name,
        meta: {
          ...meta,
          eventIntegrityFailure: "runner host died without durable terminal event-stream proof",
        },
        operation,
      });
    }
    if (host === "unverifiable") {
      throw new Error(`${operation}: ${current.name}'s HSR host birth is unverifiable`);
    }
  }
  await assertHsrSourceEventLogIntegrity({
    bee: current.name,
    meta,
    operation,
  });
}

async function admitReplacementReservation(current: SessionRecord): Promise<void> {
  let reservation = await readBeeNameLaunchReservation(current.name);
  if (!reservation) return;

  if (reservationMatchesRecord(reservation, current)) {
    await removeOwnedReservation(reservation);
    return;
  }
  if (reservation.phase === "reserved") {
    const verdict = await inspectProcessBirth(
      reservation.coordinatorPid,
      reservation.coordinatorFingerprint,
    );
    if (
      verdict === "gone"
      || verdict === "mismatch"
      || (reservation.coordinatorPid === process.pid && verdict === "match")
    ) {
      await removeOwnedReservation(reservation);
      reservation = null;
    }
  }
  if (reservation) {
    const source = reservation.replacementOf;
    const generation = source ? ` replacing generation ${source.runtimeGeneration}` : "";
    throw new Error(
      `launch reservation already owns name ${current.name} (${reservation.phase}${generation}); `
      + "resolve its exact runtime ownership before replacement replay",
    );
  }
}

async function hsrRunStateExists(name: string): Promise<boolean> {
  try {
    await stat(hsrRunDir(name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`unable to prove HSR run state absent for ${name}`, { cause: error });
  }
}

class DurableBeeNameLaunchReservation implements BeeNameLaunchReservation {
  #record: BeeNameLaunchReservationRecord;
  #state: ReservationState;

  constructor(record: BeeNameLaunchReservationRecord) {
    this.#record = record;
    this.#state = record.phase;
  }

  get id(): string {
    return this.#record.reservationId;
  }

  get name(): string {
    return this.#record.name;
  }

  get prelaunch(): boolean {
    return this.#state === "reserved";
  }

  get settled(): boolean {
    return this.#state === "cleared";
  }

  async markPredecessorStopping(): Promise<void> {
    this.assertMutable("mark predecessor stopping");
    if (this.#state !== "reserved") {
      throw new Error(`predecessor stop for ${this.name} was already marked`);
    }
    await this.persist({ phase: "stopping" });
  }

  async markLaunchDispatch(): Promise<void> {
    this.assertMutable("mark launch dispatch");
    if (this.#state !== "reserved" && this.#state !== "stopping") {
      throw new Error(`launch dispatch for ${this.name} was already marked`);
    }
    // Replacement teardown can be the operation that exposes a source-log
    // failure. The host publishes its outside receipt before stop completes,
    // so this post-stop/pre-dispatch recheck closes the A-stop -> B-launch race.
    const current = await loadSession(this.name);
    if (current) {
      assertNoCanonicalHsrEventIntegrityDoubt(current, "launch dispatch");
      await assertReplacementSourceEventIntegrity(current, "launch dispatch");
    }
    await assertNoUnresolvedHsrEventIntegrity(this.name, "launch dispatch");
    await this.persist({ phase: "dispatching" });
  }

  async markRemoteLaunchDispatch(input: { node: string; remoteLaunchId: string }): Promise<void> {
    this.assertMutable("mark remote launch dispatch");
    if (this.#state !== "reserved" && this.#state !== "stopping") {
      throw new Error(`launch dispatch for ${this.name} was already marked`);
    }
    const current = await loadSession(this.name);
    if (current) {
      assertNoCanonicalHsrEventIntegrityDoubt(current, "remote launch dispatch");
      await assertReplacementSourceEventIntegrity(current, "remote launch dispatch");
    }
    await assertNoUnresolvedHsrEventIntegrity(this.name, "remote launch dispatch");
    await this.persist({ phase: "dispatching", runtime: remoteRuntime(input) });
  }

  async recordRemoteLaunch(input: {
    node: string;
    remoteLaunchId: string;
    remoteIncarnation: string;
  }): Promise<void> {
    this.assertMutable("record remote launch");
    this.assertRemoteLocator(input);
    await this.persist({ phase: "launched", runtime: remoteRuntime(input) });
  }

  async recordTmuxLaunch(input: {
    substrate: Extract<SubstrateKind, "local-tmux" | "ssh-tmux">;
    target: string;
    node?: string;
    launch: NewSessionResult;
  }): Promise<void> {
    this.assertMutable("record tmux launch");
    await this.persist({
      phase: "launched",
      runtime: {
        kind: "tmux",
        substrate: input.substrate,
        target: input.target,
        ...(input.node ? { node: input.node } : {}),
        paneId: input.launch.paneId,
        ...(input.launch.launcherPgid ? { launcherPgid: input.launch.launcherPgid } : {}),
        ...(input.launch.launcherFingerprint ? { launcherFingerprint: input.launch.launcherFingerprint } : {}),
      },
    });
  }

  async recordHsrLaunch(input: {
    hostPid: number;
    hostFingerprint?: ProcessBirthFingerprint;
    childAdmission?: "pending" | "admitted" | "none";
  }): Promise<void> {
    this.assertMutable("record HSR launch");
    await this.persist({
      phase: "launched",
      runtime: {
        kind: "hsr",
        substrate: "hsr",
        hostPid: input.hostPid,
        ...(input.hostFingerprint ? { hostFingerprint: input.hostFingerprint } : {}),
        ...(input.childAdmission ? { childAdmission: input.childAdmission } : {}),
      },
    });
  }

  async promotePublished(record: SessionRecord): Promise<void> {
    this.assertMutable("promote publication");
    if (record.status === "kill_failed") {
      throw new Error(`refusing to publish ${this.name}'s replacement while its canonical work fence remains active`);
    }
    if (!replacementPublicationGenerationMatches(this.#record, record)) {
      throw new Error(`refusing to clear ${this.name}'s replacement reservation without its next runtime generation`);
    }
    if (!reservationRuntimeMatchesRecord(this.#record.runtime, record)) {
      throw new Error(`refusing to clear ${this.name}'s launch reservation without matching birth-qualified publication`);
    }
    let canonical = await loadSession(this.name);
    const integrityHead = await readHsrEventIntegrityReceipt(this.name);
    if (integrityHead?.phase === "unresolved") {
      await fenceCanonicalHsrEventIntegrity(integrityHead);
      await assertNoUnresolvedHsrEventIntegrity(this.name, "launch publication");
      canonical = await loadSession(this.name);
    }
    const canonicalIdentityMatches = !!canonical && samePublishedRecord(record, canonical);
    const canonicalGenerationMatches = !!canonical && replacementPublicationGenerationMatches(this.#record, canonical);
    const canonicalRuntimeMatches = !!canonical && reservationRuntimeMatchesRecord(this.#record.runtime, canonical);
    if (!canonical || canonical.status === "kill_failed" || !canonicalIdentityMatches || !canonicalGenerationMatches || !canonicalRuntimeMatches) {
      throw new Error(
        `refusing to clear ${this.name}'s launch reservation before its canonical record is durable `
        + `(status=${canonical?.status ?? "missing"}, identity=${canonicalIdentityMatches}, generation=${canonicalGenerationMatches}, runtime=${canonicalRuntimeMatches})`,
      );
    }
    await this.persist({
      phase: "published",
      publishedRecord: {
        createdAt: canonical.createdAt,
        ...(canonical.id ? { id: canonical.id } : {}),
        ...(canonical.uuid ? { uuid: canonical.uuid } : {}),
        runtimeGeneration: canonical.runtimeGeneration ?? 0,
      },
      lastError: undefined,
    });
    // A published journal left by an unlink failure is harmless and is healed
    // on the next admission when its exact SessionRecord still exists.
    await removeOwnedReservation(this.#record).catch(() => undefined);
    this.#state = "cleared";
  }

  async promoteExternallyPublished(record: SessionRecord): Promise<void> {
    this.assertMutable("promote external publication");
    if (record.status === "kill_failed") {
      throw new Error(`refusing to publish ${this.name}'s replacement while its canonical work fence remains active`);
    }
    if (!replacementPublicationGenerationMatches(this.#record, record)) {
      throw new Error(`refusing to clear ${this.name}'s replacement reservation without its next runtime generation`);
    }
    const proof = externalPublicationProof(record);
    if (!proof) {
      throw new Error(`refusing to clear ${this.name}'s launch reservation without remote authority proof`);
    }
    if (!reservationRuntimeMatchesRecord(this.#record.runtime, record)) {
      throw new Error(`refusing to clear ${this.name}'s launch reservation without its reserved remote authority proof`);
    }
    let canonical = await loadSession(this.name);
    const integrityHead = await readHsrEventIntegrityReceipt(this.name);
    if (integrityHead?.phase === "unresolved") {
      await fenceCanonicalHsrEventIntegrity(integrityHead);
      await assertNoUnresolvedHsrEventIntegrity(this.name, "remote launch publication");
      canonical = await loadSession(this.name);
    }
    const canonicalProof = canonical ? externalPublicationProof(canonical) : null;
    if (
      !canonical || canonical.status === "kill_failed" || !samePublishedRecord(record, canonical) || !canonicalProof
      || !replacementPublicationGenerationMatches(this.#record, canonical)
      || canonicalProof.node !== proof.node
      || canonicalProof.remoteLaunchId !== proof.remoteLaunchId
      || canonicalProof.remoteIncarnation !== proof.remoteIncarnation
    ) {
      throw new Error(`refusing to clear ${this.name}'s launch reservation before its remote authority record is durable`);
    }
    await this.persist({
      phase: "published",
      externalPublication: proof,
      publishedRecord: {
        createdAt: canonical.createdAt,
        ...(canonical.id ? { id: canonical.id } : {}),
        ...(canonical.uuid ? { uuid: canonical.uuid } : {}),
        runtimeGeneration: canonical.runtimeGeneration ?? 0,
      },
      lastError: undefined,
    });
    await removeOwnedReservation(this.#record).catch(() => undefined);
    this.#state = "cleared";
  }

  async clearAfterConfirmedStop(): Promise<void> {
    this.assertMutable("clear confirmed stop");
    await removeOwnedReservation(this.#record);
    this.#state = "cleared";
  }

  async retainStopDoubt(detail: string): Promise<void> {
    this.assertMutable("retain stop doubt");
    if (this.#state === "reserved") {
      throw new Error(`cannot retain stop doubt before launch dispatch for ${this.name}`);
    }
    await this.persist({
      // A locator write may itself have failed after dispatch. Preserve that
      // explicit unknown-dispatch state instead of fabricating stop_doubt with
      // no locator (which could later be mistaken for a malformed safe row).
      phase: this.#record.runtime ? "stop_doubt" : "dispatching",
      lastError: detail,
    });
  }

  async retainRemoteStopDoubt(
    input: { node: string; remoteLaunchId: string; remoteIncarnation?: string },
    detail: string,
  ): Promise<void> {
    this.assertMutable("retain remote stop doubt");
    this.assertRemoteLocator(input);
    await this.persist({ phase: "stop_doubt", runtime: remoteRuntime(input), lastError: detail });
  }

  async noteFailure(detail: string): Promise<void> {
    if (this.#state === "cleared") return;
    await this.persist({ lastError: detail });
  }

  async clearBeforeLaunchFailure(): Promise<void> {
    if (this.#state !== "reserved") return;
    await removeOwnedReservation(this.#record);
    this.#state = "cleared";
  }

  private assertMutable(action: string): void {
    if (this.#state === "cleared") throw new Error(`cannot ${action}: launch reservation ${this.id} is already settled`);
  }

  private assertRemoteLocator(input: { node: string; remoteLaunchId: string }): void {
    const runtime = this.#record.runtime;
    if (
      runtime?.kind !== "remote-hsr"
      || runtime.node !== input.node
      || runtime.remoteLaunchId !== input.remoteLaunchId
    ) {
      throw new Error(`remote launch locator does not own reservation ${this.id}`);
    }
  }

  private async persist(patch: Partial<BeeNameLaunchReservationRecord>): Promise<void> {
    const next = stripUndefined({
      ...this.#record,
      ...patch,
      version: 1 as const,
      reservationId: this.#record.reservationId,
      name: this.#record.name,
      updatedAt: new Date().toISOString(),
    }) as BeeNameLaunchReservationRecord;
    await writeReservation(next);
    this.#record = next;
    this.#state = next.phase;
  }
}

async function writeReservation(record: BeeNameLaunchReservationRecord): Promise<void> {
  await atomicWriteFile(
    beeNameLaunchReservationPath(record.name),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function removeOwnedReservation(expected: BeeNameLaunchReservationRecord): Promise<void> {
  const current = await readBeeNameLaunchReservation(expected.name);
  if (!current) return;
  if (current.reservationId !== expected.reservationId) {
    throw new Error(`launch reservation ownership changed for ${expected.name}`);
  }
  await rm(beeNameLaunchReservationPath(expected.name));
}

function reservationMatchesRecord(reservation: BeeNameLaunchReservationRecord, record: SessionRecord): boolean {
  // stop_doubt is explicit unresolved ownership even when the canonical row
  // was repointed at the suspect runtime. Only exact teardown/purge may clear
  // it. launched may heal a crash after the canonical commit but before the
  // journal's publication transition; kill_failed is never such a success.
  if (
    (reservation.phase !== "launched" && reservation.phase !== "published")
    || (reservation.phase === "launched" && record.status === "kill_failed")
    || !replacementPublicationGenerationMatches(reservation, record)
  ) return false;
  const external = reservation.externalPublication;
  if (external) {
    const proof = externalPublicationProof(record);
    if (
      !proof
      || proof.node !== external.node
      || proof.remoteLaunchId !== external.remoteLaunchId
      || proof.remoteIncarnation !== external.remoteIncarnation
    ) return false;
  } else if (!reservationRuntimeMatchesRecord(reservation.runtime, record)) {
    return false;
  }
  const published = reservation.publishedRecord;
  return !published || (
    published.createdAt === record.createdAt
    && published.runtimeGeneration === (record.runtimeGeneration ?? 0)
    && (published.id === undefined || published.id === record.id)
    && (published.uuid === undefined || published.uuid === record.uuid)
  );
}

function reservationRuntimeMatchesRecord(
  runtime: LaunchReservationRuntime | undefined,
  record: SessionRecord,
): boolean {
  if (!runtime) return false;
  if (runtime.kind === "remote-hsr") {
    return !!runtime.remoteIncarnation
      && record.node === runtime.node
      && record.remoteLaunchId === runtime.remoteLaunchId
      && record.remoteIncarnation === runtime.remoteIncarnation;
  }
  if (runtime.kind === "hsr") {
    return record.substrate === "hsr"
      && record.runnerPid === runtime.hostPid
      && sameProcessBirthFingerprint(runtime.hostFingerprint, record.runnerFingerprint)
      && (runtime.childAdmission === "admitted" || runtime.childAdmission === "none");
  }
  return record.tmuxTarget === runtime.target
    && record.node === runtime.node
    && record.agentPaneId === runtime.paneId
    && record.launcherPgid === runtime.launcherPgid
    && sameProcessBirthFingerprint(runtime.launcherFingerprint, record.launcherFingerprint);
}

function reservationRuntimeMayOwnRecord(
  runtime: LaunchReservationRuntime,
  record: SessionRecord,
): boolean {
  if (runtime.kind === "remote-hsr") {
    return record.node === runtime.node
      && record.remoteLaunchId === runtime.remoteLaunchId
      && (runtime.remoteIncarnation === undefined || record.remoteIncarnation === runtime.remoteIncarnation);
  }
  // Local cleanup may clear a journal only when the canonical row carries the
  // same fully admitted birth identity. A target/pane or bare host pid can
  // disappear while an escaped process group survives.
  return reservationRuntimeMatchesRecord(runtime, record);
}

function samePublishedRecord(left: SessionRecord, right: SessionRecord): boolean {
  return left.name === right.name
    && left.createdAt === right.createdAt
    && (left.runtimeGeneration ?? 0) === (right.runtimeGeneration ?? 0)
    && (left.id === undefined || left.id === right.id)
    && (left.uuid === undefined || left.uuid === right.uuid);
}

function sessionGenerationProof(
  record: SessionRecord,
): NonNullable<BeeNameLaunchReservationRecord["replacementOf"]> {
  return {
    createdAt: record.createdAt,
    ...(record.id ? { id: record.id } : {}),
    ...(record.uuid ? { uuid: record.uuid } : {}),
    runtimeGeneration: record.runtimeGeneration ?? 0,
  };
}

function replacementSourceMatchesRecord(
  reservation: BeeNameLaunchReservationRecord,
  record: SessionRecord,
): boolean {
  const source = reservation.replacementOf;
  return !!source
    && source.createdAt === record.createdAt
    && source.runtimeGeneration === (record.runtimeGeneration ?? 0)
    && (source.id === undefined || source.id === record.id)
    && (source.uuid === undefined || source.uuid === record.uuid);
}

function replacementPublicationGenerationMatches(
  reservation: BeeNameLaunchReservationRecord,
  record: SessionRecord,
): boolean {
  const source = reservation.replacementOf;
  return !source || (
    record.createdAt === source.createdAt
    && (source.id === undefined || record.id === source.id)
    && (source.uuid === undefined || record.uuid === source.uuid)
    && (record.runtimeGeneration ?? 0) === source.runtimeGeneration + 1
  );
}

function externalPublicationProof(record: SessionRecord): {
  node: string;
  remoteLaunchId: string;
  remoteIncarnation: string;
} | null {
  const candidate = record as SessionRecord & {
    remoteLaunchId?: unknown;
    remoteIncarnation?: unknown;
  };
  return typeof candidate.node === "string"
    && typeof candidate.remoteLaunchId === "string"
    && candidate.remoteLaunchId.length > 0
    && typeof candidate.remoteIncarnation === "string"
    && candidate.remoteIncarnation.length > 0
    ? {
        node: candidate.node,
        remoteLaunchId: candidate.remoteLaunchId,
        remoteIncarnation: candidate.remoteIncarnation,
      }
    : null;
}

function isLaunchReservationRecord(value: unknown): value is BeeNameLaunchReservationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && typeof candidate.reservationId === "string" && candidate.reservationId.length > 0
    && typeof candidate.name === "string" && candidate.name.length > 0
    && typeof candidate.operation === "string" && candidate.operation.length > 0
    && (candidate.phase === "reserved" || candidate.phase === "stopping" || candidate.phase === "dispatching" || candidate.phase === "launched" || candidate.phase === "stop_doubt" || candidate.phase === "published")
    && Number.isSafeInteger(candidate.coordinatorPid) && Number(candidate.coordinatorPid) > 0
    && isProcessFingerprint(candidate.coordinatorFingerprint)
    && typeof candidate.createdAt === "string" && candidate.createdAt.length > 0
    && typeof candidate.updatedAt === "string" && candidate.updatedAt.length > 0
    && (candidate.lastError === undefined || typeof candidate.lastError === "string")
    && (candidate.replacementOf === undefined || isSessionGenerationProof(candidate.replacementOf))
    && (candidate.runtime === undefined || isLaunchRuntime(candidate.runtime))
    && (candidate.externalPublication === undefined || isExternalPublication(candidate.externalPublication))
    && (candidate.publishedRecord === undefined || isPublishedRecordProof(candidate.publishedRecord))
    && validReservationPhaseShape(candidate);
}

function validReservationPhaseShape(candidate: Record<string, unknown>): boolean {
  const phase = candidate.phase as BeeNameLaunchReservationRecord["phase"];
  const runtime = candidate.runtime as LaunchReservationRuntime | undefined;
  const external = candidate.externalPublication as BeeNameLaunchReservationRecord["externalPublication"] | undefined;
  const published = candidate.publishedRecord as BeeNameLaunchReservationRecord["publishedRecord"] | undefined;
  const replacement = candidate.replacementOf as BeeNameLaunchReservationRecord["replacementOf"] | undefined;
  if (phase === "reserved" || phase === "stopping") {
    return runtime === undefined && external === undefined && published === undefined;
  }
  if (phase === "dispatching") {
    return external === undefined && published === undefined
      && (runtime === undefined || (runtime.kind === "remote-hsr" && runtime.remoteIncarnation === undefined));
  }
  if (phase === "launched" || phase === "stop_doubt") {
    return external === undefined && published === undefined && runtime !== undefined
      && (phase === "stop_doubt" || runtime.kind !== "remote-hsr" || !!runtime.remoteIncarnation);
  }
  if (!published || !runtime) return false;
  if (replacement && published.runtimeGeneration !== replacement.runtimeGeneration + 1) return false;
  if (external) {
    return runtime.kind === "remote-hsr"
      && runtime.node === external.node
      && runtime.remoteLaunchId === external.remoteLaunchId
      && runtime.remoteIncarnation === external.remoteIncarnation;
  }
  return runtime.kind !== "remote-hsr" && isBirthQualifiedLocalRuntime(runtime);
}

function isPublishedRecordProof(value: unknown): value is NonNullable<BeeNameLaunchReservationRecord["publishedRecord"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.createdAt === "string"
    && candidate.createdAt.length > 0
    && (candidate.id === undefined || (typeof candidate.id === "string" && candidate.id.length > 0))
    && (candidate.uuid === undefined || (typeof candidate.uuid === "string" && candidate.uuid.length > 0))
    && Number.isSafeInteger(candidate.runtimeGeneration)
    && Number(candidate.runtimeGeneration) >= 0;
}

function isSessionGenerationProof(
  value: unknown,
): value is NonNullable<BeeNameLaunchReservationRecord["replacementOf"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.createdAt === "string"
    && candidate.createdAt.length > 0
    && (candidate.id === undefined || (typeof candidate.id === "string" && candidate.id.length > 0))
    && (candidate.uuid === undefined || (typeof candidate.uuid === "string" && candidate.uuid.length > 0))
    && Number.isSafeInteger(candidate.runtimeGeneration)
    && Number(candidate.runtimeGeneration) >= 0;
}

function isBirthQualifiedLocalRuntime(runtime: LaunchReservationRuntime): boolean {
  if (runtime.kind === "remote-hsr") return false;
  if (runtime.kind === "hsr") {
    return !!runtime.hostFingerprint
      && (runtime.childAdmission === "admitted" || runtime.childAdmission === "none");
  }
  return !!runtime.launcherFingerprint;
}

function isProcessFingerprint(value: unknown): value is ProcessBirthFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.pgid)
    && Number(candidate.pgid) > 0
    && typeof candidate.startedAt === "string"
    && candidate.startedAt.length > 0;
}

function isExternalPublication(
  value: unknown,
): value is NonNullable<BeeNameLaunchReservationRecord["externalPublication"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.node === "string"
    && candidate.node.length > 0
    && typeof candidate.remoteLaunchId === "string"
    && candidate.remoteLaunchId.length > 0
    && typeof candidate.remoteIncarnation === "string"
    && candidate.remoteIncarnation.length > 0;
}

function isLaunchRuntime(value: unknown): value is LaunchReservationRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const runtime = value as Record<string, unknown>;
  if (runtime.kind === "remote-hsr") {
    return runtime.substrate === "remote-hsr"
      && typeof runtime.node === "string"
      && runtime.node.length > 0
      && typeof runtime.remoteLaunchId === "string"
      && runtime.remoteLaunchId.length > 0
      && (runtime.remoteIncarnation === undefined
        || (typeof runtime.remoteIncarnation === "string" && runtime.remoteIncarnation.length > 0));
  }
  if (runtime.kind === "hsr") {
    return runtime.substrate === "hsr"
      && Number.isSafeInteger(runtime.hostPid)
      && Number(runtime.hostPid) > 0
      && (runtime.hostFingerprint === undefined || isProcessFingerprint(runtime.hostFingerprint))
      && (runtime.childAdmission === undefined
        || runtime.childAdmission === "pending"
        || runtime.childAdmission === "admitted"
        || runtime.childAdmission === "none");
  }
  return runtime.kind === "tmux"
    && (runtime.substrate === "local-tmux" || runtime.substrate === "ssh-tmux")
    && typeof runtime.target === "string" && runtime.target.length > 0
    && (runtime.node === undefined || (typeof runtime.node === "string" && runtime.node.length > 0))
    && typeof runtime.paneId === "string" && runtime.paneId.length > 0
    && (runtime.launcherPgid === undefined
      || (Number.isSafeInteger(runtime.launcherPgid) && Number(runtime.launcherPgid) > 0))
    && (runtime.launcherFingerprint === undefined || isProcessFingerprint(runtime.launcherFingerprint));
}

function remoteRuntime(input: {
  node: string;
  remoteLaunchId: string;
  remoteIncarnation?: string;
}): RemoteHsrLaunchReservationRuntime {
  if (!input.node || !input.remoteLaunchId || (input.remoteIncarnation !== undefined && !input.remoteIncarnation)) {
    throw new Error("remote launch reservation requires non-empty node and immutable launch tokens");
  }
  return {
    kind: "remote-hsr",
    substrate: "remote-hsr",
    node: input.node,
    remoteLaunchId: input.remoteLaunchId,
    ...(input.remoteIncarnation ? { remoteIncarnation: input.remoteIncarnation } : {}),
  };
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
