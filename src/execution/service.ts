// Execution coordinator for the H1 slice of local-core-v1: effect-keyed
// run.start admission -> durable reservation -> injected launcher -> bound
// session, plus run.get / run.events over the durable per-Run control events.
//
// The launcher is an injected seam (RunLauncher): production wires the HSR
// spawn path (launcher.ts); tests wire fakes and crash injections. The
// coordinator itself never resolves a cwd and never falls back to a CLI after
// admission — if the launcher cannot satisfy the leased placement it throws a
// typed error and the Run fails with that cause.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { JsonValue } from "../comb/types.js";
import { machineId } from "../fsx.js";
import { captureProcessBirthFingerprint, inspectProcessBirth } from "../hsr/processIdentity.js";
import type { SpawnedRuntimeHandle } from "../spawnRuntime.js";
import {
  computeSchemaDigest,
  createExecutionValidator,
  loadExecutionContract,
  type ExecutionContract,
  type ExecutionValidator,
  type JsonObject,
} from "./contract.js";
import { assertDescribeScope, buildNodeDescriptor, NATIVE_PROVIDER_ID, type HarnessProbe } from "./describe.js";
import {
  ExecutionProtocolError,
  IndeterminateExecutionError,
  executionError,
  indeterminateExecutionError,
  toWireError,
  type ExecutionErrorWire,
} from "./errors.js";
import { negotiateHello, supportedFeatures, type HelloResult } from "./hello.js";
import {
  loadNodeIdentity,
  requireExecutionBinding,
  type ExecutionBindingRecord,
  type ExecutionNodeIdentity,
} from "./nodeState.js";
import {
  admitRunStart,
  activateRunLaunchAttempt,
  acceptedCursorResetThroughSeq,
  appendRunEvents,
  appendRunTerminalEvents,
  claimRunLaunchAttempt,
  classifyLaunch,
  clearLossEpisode,
  commitRunLaunchStarted,
  commitRunTerminalResult,
  enterLossEpisode,
  ensureRunAcceptedFirst,
  lossEpisodePayload,
  launchAttemptOwns,
  mutateReservation,
  readReservation,
  readRunEvents,
  type LaunchEvidence,
  type RunEnvironmentFacts,
  type RunEventInput,
  type RunReservation,
  type RunLaunchOwner,
  type RunLaunchOwnerStatus,
  type StoredRunEvent,
} from "./runStore.js";
import { assertLeaseWindow, validateRunStart } from "./runStart.js";
import { hsrHarnessControl, type HarnessControl } from "./harnessControl.js";
import { createRunOperations, type RunOperations } from "./operations.js";
import type { SignatureVerifier } from "./signing.js";

/* ---------------------------------------------------------------- */
/* Injected seams                                                    */
/* ---------------------------------------------------------------- */

export type RunLaunchRequest = {
  runId: string;
  beeName: string;
  intent: JsonObject;
  lease: JsonObject;
  /**
   * Trusted parent bee id for the spawned harness, resolved by the
   * coordinator from admitted facts only (parent Run's actual bee identity,
   * else the admitted agent initiator). Absent for human/root initiators —
   * the spawn must then carry NO parent edge, ambient context included.
   */
  spawnedById?: string;
};

export type RunLaunchResult = {
  /** Provider session reference (bee id / provider session id) once known. */
  sessionRef: string;
  environment: RunEnvironmentFacts;
  /** Exact launched incarnation, used if this attempt loses its commit CAS. */
  runtime?: SpawnedRuntimeHandle;
};

/**
 * Materialize the leased placement and start the harness for one reserved
 * Run. Must be path-free at the boundary: placement identity arrives as the
 * intent's placement/working-copy reference, never as a caller cwd. Throws
 * ExecutionProtocolError (MATERIALIZATION_FAILED / HARNESS_UNAVAILABLE / ...)
 * on typed refusals.
 */
export type RunLauncher = (request: RunLaunchRequest) => Promise<RunLaunchResult>;

/** Durable evidence about the session a reservation may have started. */
export type SessionEvidenceSource = {
  evidence(beeName: string): Promise<LaunchEvidence>;
  /** Latest liveness/outcome for a bound session; null when nothing exists. */
  outcome(beeName: string): Promise<{ live: boolean; exitCode?: number | null } | null>;
};

export type ExecutionServiceOptions = {
  launcher: RunLauncher;
  sessions: SessionEvidenceSource;
  /** Harness steering/stop channel; defaults to the HSR control-socket path. */
  control?: HarnessControl;
  /** Strict stop for a spawn-known runtime; missing HSR meta is unconfirmed. */
  stopKnownExecution?: (beeName: string) => Promise<{ stopped: boolean; detail: string }>;
  harnessProbe?: HarnessProbe;
  verifySignature?: SignatureVerifier;
  now?: () => Date;
  /** Durable launch-owner identity and liveness seams (deterministic tests). */
  launchOwner?: RunLaunchOwner;
  inspectLaunchOwner?: (owner: RunLaunchOwner) => Promise<RunLaunchOwnerStatus>;
  /** Test barrier after durable admission but before launch ownership claim. */
  afterAdmission?: (reservation: RunReservation) => void | Promise<void>;
  /** Test barrier after claim; production leaves this absent. */
  afterLaunchClaim?: (reservation: RunReservation, attemptId: string) => void | Promise<void>;
  /** Test seam for a transient launch-lifecycle event-store rejection. */
  appendLaunchEvents?: typeof appendRunEvents;
  /** @deprecated Elapsed time no longer grants launch authority. */
  launchGraceMs?: number;
};

/* ---------------------------------------------------------------- */
/* Service                                                           */
/* ---------------------------------------------------------------- */

export type NonEffectResult = { result: JsonObject } | { error: ExecutionErrorWire };

export type ExecutionService = {
  contract: ExecutionContract;
  validator: ExecutionValidator;
  schemaDigest: string;
  protocolVersion: string;
  hello(request: JsonValue): HelloResult;
  describe(request: JsonValue): Promise<NonEffectResult>;
  runStart(request: JsonValue): Promise<JsonObject>;
  runGet(request: JsonValue): Promise<NonEffectResult>;
  runEvents(request: JsonValue): Promise<NonEffectResult>;
  runCommand(request: JsonValue): Promise<JsonObject>;
  runCancel(request: JsonValue): Promise<JsonObject>;
  runCollect(request: JsonValue): Promise<JsonObject>;
  runRetain(request: JsonValue): Promise<JsonObject>;
  runRelease(request: JsonValue): Promise<JsonObject>;
};

/**
 * Inspect a persisted launch owner only when it belongs to this machine.
 * Stable machineId is authoritative; hostname is display-only for new
 * records and the fail-closed identity fallback for legacy records.
 */
export async function inspectRunLaunchOwner(
  owner: RunLaunchOwner,
  current: { machineId: string; hostname: string } = { machineId: machineId(), hostname: hostname() },
  inspectBirth: typeof inspectProcessBirth = inspectProcessBirth,
): Promise<RunLaunchOwnerStatus> {
  if (owner.machineId) {
    if (owner.machineId !== current.machineId) return "unverifiable";
  } else if (owner.hostname !== current.hostname) {
    return "unverifiable";
  }
  const verdict = await inspectBirth(owner.pid, owner.processFingerprint);
  if (verdict === "match") return "alive";
  if (verdict === "gone" || verdict === "mismatch") return "dead";
  return "unverifiable";
}

export function createExecutionService(options: ExecutionServiceOptions): ExecutionService {
  const contract = loadExecutionContract();
  const validator = createExecutionValidator(contract);
  const schemaDigest = computeSchemaDigest(contract);
  const protocolVersion = typeof contract.profile.protocolVersion === "string" ? contract.profile.protocolVersion : "0.1";
  const now = options.now ?? (() => new Date());
  const control = options.control ?? hsrHarnessControl();
  const appendLaunchEvents = options.appendLaunchEvents ?? appendRunEvents;
  const stopKnownExecution = options.stopKnownExecution ?? (async (beeName: string) => {
    const result = await (await import("../hsr/substrate.js")).stopKnownHsrExecution(beeName);
    return { stopped: result.ok, detail: result.ok ? "HSR stop confirmed" : result.stderr || "HSR stop unconfirmed" };
  });
  const inFlight = new Map<string, Promise<void>>();
  let launchOwnerPromise: Promise<RunLaunchOwner> | undefined;
  const launchOwner = (): Promise<RunLaunchOwner> => (launchOwnerPromise ??= (async () => {
    if (options.launchOwner) return options.launchOwner;
    const processFingerprint = await captureProcessBirthFingerprint(process.pid);
    if (!processFingerprint) {
      throw executionError("AUTHORITY_UNAVAILABLE", "cannot durably claim run.start: coordinator process birth identity is unavailable");
    }
    return {
      ownerId: randomUUID(),
      pid: process.pid,
      machineId: machineId(),
      hostname: hostname(),
      processFingerprint,
    };
  })());
  const inspectLaunchOwner = options.inspectLaunchOwner ?? inspectRunLaunchOwner;

  let identityPromise: Promise<ExecutionNodeIdentity> | undefined;
  const identity = (): Promise<ExecutionNodeIdentity> => (identityPromise ??= loadNodeIdentity());

  // The canonical public node identity is the Apiary nodeId pinned in the
  // installed binding (nodeState.ts). A binding is immutable once installed
  // (first-use bind never replaces), so caching the first successful read is
  // safe; failures are NOT cached so a bind that lands later is picked up.
  let cachedBinding: ExecutionBindingRecord | undefined;
  const binding = async (): Promise<ExecutionBindingRecord> => (cachedBinding ??= await requireExecutionBinding());
  const canonicalNodeId = async (): Promise<string> => (await binding()).nodeId;

  const origin = async (extra?: { driverId?: string; providerId?: string }) => ({
    nodeId: await canonicalNodeId(),
    ...(extra?.driverId ? { driverId: extra.driverId } : {}),
    ...(extra?.providerId ? { providerId: extra.providerId } : {}),
  });

  /* -------------------------------------------------------------- */
  /* Launch + recovery                                               */
  /* -------------------------------------------------------------- */

  const driverIdOf = (reservation: RunReservation): string =>
    String((reservation.intent.harness as JsonObject | undefined)?.driverId ?? "");

  const recoverableLostCauses = new Set([
    "readiness_evidence_missing",
    "session_ref_missing",
    "environment_receipt_missing",
    "readiness_stop_unconfirmed",
    "cancel_stop_unconfirmed",
    "release_stop_unconfirmed",
  ]);

  /**
   * Establish the contract's lost -> recovering edge before convergence.
   * Reservation mutation and event append are separate durable writes, so a
   * crash may leave indeterminateAt/cause without its run.lost event. Repair
   * both edges together under one event-log lock before any recovered receipt.
   */
  async function beginLostRecovery(reservation: RunReservation, verified: string[]): Promise<RunReservation | null> {
    if (
      !reservation.indeterminateAt ||
      !reservation.indeterminateCause ||
      !recoverableLostCauses.has(reservation.indeterminateCause)
    ) return null;
    const durable = reservation.lossEpisodeId
      ? reservation
      : await mutateReservation(reservation.runId, (record) =>
          enterLossEpisode(record, reservation.indeterminateCause!, reservation.indeterminateAt!),
        );
    const eventOrigin = await origin();
    await appendRunEvents(
      reservation.runId,
      protocolVersion,
      [
        {
          type: "run.lost",
          payload: lossEpisodePayload(durable, { cause: durable.indeterminateCause! }),
          origin: eventOrigin,
        },
        {
          type: "run.recovering",
          payload: lossEpisodePayload(durable, { cause: durable.indeterminateCause!, verified }),
          origin: eventOrigin,
        },
      ],
      { onlyIfAbsentKeys: true },
    );
    return durable;
  }

  /**
   * Publish the observable end of one liveness-loss episode before its durable
   * marker is cleared. This is intentionally separate from terminal append:
   * an already-published terminal member may precede a later stop doubt, and
   * appendRunTerminalEvents must not place an exit precursor after it.
   */
  async function publishLossRecoveryExit(
    reservation: RunReservation,
    verified: string[],
    exitCode?: number,
  ): Promise<RunReservation | null> {
    const recovering = await beginLostRecovery(reservation, verified);
    if (!recovering?.lossEpisodeId) return null;
    await appendRunEvents(
      recovering.runId,
      protocolVersion,
      [{
        type: "harness.exited",
        payload: lossEpisodePayload(recovering, exitCode !== undefined ? { exitCode } : {}),
        origin: await origin({ driverId: driverIdOf(recovering) }),
      }],
      { onlyIfAbsentKeys: true },
    );
    return recovering;
  }

  /** Clear exactly the episode whose complete recovery stream is durable. */
  async function clearPublishedLossEpisode(recovering: RunReservation): Promise<RunReservation> {
    return mutateReservation(recovering.runId, (record) =>
      record.lossEpisodeId === recovering.lossEpisodeId ? clearLossEpisode(record) : record,
    );
  }

  /** Repair the admission/event crash gap for every read/reconcile entrypoint. */
  async function ensureAcceptedReceipt(reservation: RunReservation): Promise<void> {
    await ensureRunAcceptedFirst(
      reservation.runId,
      protocolVersion,
      {
        type: "run.accepted",
        payload: { effectKey: reservation.effectKey, receiptId: reservation.receipt.receiptId },
        origin: await origin(),
        occurredAt: reservation.createdAt,
      },
    );
  }

  /**
   * Repair the second coordinator-write gap: phase=started is persisted only
   * after launcher readiness succeeds, so its session/environment facts are
   * durable proof that these receipts belong before any later terminal fold.
   * Unresolved lost state is excluded; its recovery path must establish
   * run.recovering and clear indeterminateAt first.
   */
  async function ensureStartedReceipts(
    reservation: RunReservation,
    recoveryEpisodeId?: string,
  ): Promise<void> {
    if (
      reservation.phase !== "started" ||
      (reservation.indeterminateAt && !recoveryEpisodeId) ||
      !reservation.environment ||
      !reservation.sessionRef
    ) return;
    const recoveryPayload: JsonObject = recoveryEpisodeId ? { lossEpisodeId: recoveryEpisodeId } : {};
    const runningPayload: JsonObject = {
      sessionRef: reservation.sessionRef,
      ...(recoveryEpisodeId ? { recovered: true, lossEpisodeId: recoveryEpisodeId } : {}),
    };
    await appendRunEvents(
      reservation.runId,
      protocolVersion,
      [
        // A normal started-state write proves the earlier launch phases too.
        // A lost recovery deliberately skips these: Apiary requires
        // lost -> recovering -> running, not recovering -> materializing.
        ...(!recoveryEpisodeId
          ? [
              { type: "environment.materializing", payload: {}, origin: await origin({ providerId: NATIVE_PROVIDER_ID }) },
              { type: "harness.starting", payload: { operationId: reservation.runId }, origin: await origin({ driverId: driverIdOf(reservation) }) },
            ]
          : []),
        {
          type: "environment.ready",
          payload: { environmentId: reservation.environment.environmentId, ...recoveryPayload },
          origin: await origin({ providerId: reservation.environment.providerId }),
        },
        {
          type: "harness.running",
          payload: runningPayload,
          origin: await origin({ driverId: driverIdOf(reservation) }),
        },
      ],
      recoveryEpisodeId
        ? { onlyIfAbsentKeys: true }
        : {
            onlyIfAbsentTypes: true,
            skipTypesWhenMarkerPresent: {
              markerType: "run.recovering",
              types: ["environment.materializing", "harness.starting"],
            },
          },
    );
  }

  /** Minimal immutable initiator fact from a validated authority envelope. */
  function initiatorOf(authority: JsonObject): { kind: string; id: string } | undefined {
    const actor = authority.actor;
    if (actor === null || typeof actor !== "object" || Array.isArray(actor)) return undefined;
    const raw = (actor as JsonObject).initiator;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const { kind, id } = raw as JsonObject;
    return typeof kind === "string" && typeof id === "string" ? { kind, id } : undefined;
  }

  /**
   * Trusted parent authorship for the harness spawn. A same-scope parentRunId
   * (validated at admission) contributes its ACTUAL bee identity once known;
   * otherwise an agent initiator from the admitted ActorContext is the parent.
   * Human/root initiators get no parent — never an invented one.
   */
  async function runSpawnedById(reservation: RunReservation): Promise<string | undefined> {
    const parentRunId = reservation.intent.parentRunId;
    if (typeof parentRunId === "string") {
      const parent = await readReservation(parentRunId);
      if (parent?.sessionRef) return parent.sessionRef;
    }
    return reservation.initiator?.kind === "agent" ? reservation.initiator.id : undefined;
  }

  async function markLaunchLost(runId: string, error: IndeterminateExecutionError, wire = toWireError(error)): Promise<void> {
    const lost = await mutateReservation(runId, (current) =>
      enterLossEpisode(
        { ...current, failureCause: current.failureCause ?? `${wire.code}: ${wire.message}` },
        error.cause,
        now().toISOString(),
      ),
    );
    await appendRunEvents(
      runId,
      protocolVersion,
      [{
        type: "run.lost",
        payload: lossEpisodePayload(lost, {
          cause: error.cause,
          ...(error.details !== undefined ? { detail: error.details } : {}),
        }),
        origin: await origin(),
      }],
      { onlyIfAbsentKeys: true },
    );
  }

  async function cleanupUncommittedLaunch(
    result: RunLaunchResult,
    cause: string,
    indeterminateCause = "launch_commit_cleanup_unconfirmed",
  ): Promise<void> {
    let stopped = false;
    let detail = "launcher returned no exact runtime cleanup handle";
    if (result.runtime) {
      try {
        const cleanup = await result.runtime.stop();
        stopped = cleanup.stopped;
        detail = cleanup.detail;
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
    }
    if (!stopped) {
      throw indeterminateExecutionError(
        "HARNESS_UNAVAILABLE",
        `launched runtime could not commit ${cause} and exact cleanup was unconfirmed`,
        indeterminateCause,
        { detail, ...(result.runtime ? { runtime: result.runtime.identity } : {}) },
      );
    }
  }

  /** Prepare, activate, and run only the exact durable attempt this service owns. */
  async function launch(
    reservation: RunReservation,
    lease: JsonObject,
    attemptId: string,
    newlyClaimed: boolean,
  ): Promise<void> {
    const runId = reservation.runId;
    const existing = inFlight.get(runId);
    if (existing) return existing;
    const attempt = (async () => {
      // Establish local single-flight before any test barrier/event I/O. If
      // publication rejects, the durable stage remains `preparing`, allowing
      // this exact owner to resume it on an identical retry.
      if (newlyClaimed) await options.afterLaunchClaim?.(reservation, attemptId);
      let fresh = await readReservation(runId);
      if (
        !fresh ||
        !launchAttemptOwns(fresh, attemptId) ||
        fresh.launchAttempt?.stage !== "preparing"
      ) return;
      if (Date.parse(fresh.leaseExpiresAt) < now().getTime()) {
        const failureCause = "LEASE_DENIED: lease expired before the reserved launch could start";
        const failed = await commitRunTerminalResult(
          fresh.runId,
          { outcome: "failed", cause: "lease_expired", failureCause },
          { now, canCommit: (record) => launchAttemptOwns(record, attemptId) },
        );
        await appendRunTerminalEvents(failed, protocolVersion, await origin());
        return;
      }
      if (fresh.cancel) {
        const cancelled = await commitRunTerminalResult(
          fresh.runId,
          { outcome: "cancelled", cause: "cancel_requested" },
          { now, canCommit: (record) => launchAttemptOwns(record, attemptId) },
        );
        await appendRunTerminalEvents(cancelled, protocolVersion, await origin());
        return;
      }

      // Resolve every fallible precondition before crossing the side-effect
      // fence. After activateRunLaunchAttempt returns true there is no await
      // before options.launcher is synchronously invoked.
      const spawnedById = await runSpawnedById(fresh);
      await appendLaunchEvents(
        runId,
        protocolVersion,
        [
          { type: "environment.materializing", payload: {}, origin: await origin({ providerId: NATIVE_PROVIDER_ID }) },
          { type: "harness.starting", payload: { operationId: runId }, origin: await origin({ driverId: driverIdOf(reservation) }) },
        ],
        { onlyIfAbsentTypes: true },
      );

      const activation = await activateRunLaunchAttempt(runId, attemptId);
      if (!activation.activated) {
        // A cancellation can land after event publication but before the
        // activation CAS. `preparing` proves no launcher ran, so settle it
        // without any cleanup side effect.
        const blocked = activation.reservation;
        const settled = blocked.cancel && !blocked.result && launchAttemptOwns(blocked, attemptId)
          ? await commitRunTerminalResult(
              runId,
              { outcome: "cancelled", cause: "cancel_requested" },
              { now, canCommit: (record) => launchAttemptOwns(record, attemptId) && record.cancel !== undefined },
            )
          : blocked;
        if (settled.result) await appendRunTerminalEvents(settled, protocolVersion, await origin());
        return;
      }
      fresh = activation.reservation;

      try {
        const launched = options.launcher({
          runId,
          beeName: fresh.beeName,
          intent: fresh.intent,
          lease,
          ...(spawnedById ? { spawnedById } : {}),
        });
        const result = await launched;
        if (!result.sessionRef) {
          await cleanupUncommittedLaunch(result, "without a canonical session reference", "session_ref_missing");
          throw executionError("HARNESS_UNAVAILABLE", "harness reached readiness without a canonical session reference; exact cleanup confirmed");
        }
        const started = await commitRunLaunchStarted(
          runId,
          attemptId,
          { sessionRef: result.sessionRef, environment: result.environment },
          { now },
        );
        if (!started.committed) {
          // A terminal decision or a different launch-attempt token won while
          // the non-deduplicating launcher was in flight. Never overwrite it;
          // tear down only the concrete incarnation returned by this attempt.
          await cleanupUncommittedLaunch(
            result,
            "because launch ownership was lost",
            started.reservation.cancel ? "cancel_stop_unconfirmed" : "launch_commit_cleanup_unconfirmed",
          );
          const settled = started.reservation.cancel && !started.reservation.result
            ? await commitRunTerminalResult(
                runId,
                { outcome: "cancelled", cause: "cancel_requested" },
                { now, canCommit: (record) => launchAttemptOwns(record, attemptId) && record.cancel !== undefined },
              )
            : started.reservation;
          await appendRunTerminalEvents(settled, protocolVersion, await origin());
          return;
        }
        await appendRunEvents(
          runId,
          protocolVersion,
          [
            {
              type: "environment.ready",
              payload: { environmentId: result.environment.environmentId },
              origin: await origin({ providerId: result.environment.providerId }),
            },
            {
              type: "harness.running",
              payload: { sessionRef: result.sessionRef },
              origin: await origin({ driverId: driverIdOf(fresh) }),
            },
          ],
          { onlyIfAbsentTypes: true },
        );
        // A cancel that landed while this launch was in flight wins: stop the
        // just-started session so a durably cancelled Run never keeps running.
        // An UNCONFIRMED stop must not hide behind the cancelled terminal —
        // record honest liveness doubt so reconciliation stays observable.
        const post = await readReservation(runId);
        if (post?.cancel || post?.result?.outcome === "cancelled") {
          let stopConfirmed = false;
          let detail = "";
          try {
            // Prefer the launcher-returned incarnation handle while it is
            // available. The bound control path remains the compatibility
            // fallback for injected launchers that predate exact handles.
            const stop = result.runtime
              ? await result.runtime.stop()
              : await control.stop(fresh.beeName);
            stopConfirmed = stop.stopped;
            detail = stop.detail;
          } catch (error) {
            detail = error instanceof Error ? error.message : String(error);
          }
          if (stopConfirmed) {
            // The sweep owns terminal resolution for a cancel that landed
            // pre-running: confirmed stop -> atomically cancelled + event.
            const resolved = await commitRunTerminalResult(
              runId,
              { outcome: "cancelled", cause: "cancel_requested" },
              { now, clearIndeterminate: true },
            );
            await appendRunTerminalEvents(resolved, protocolVersion, await origin());
          } else {
            const unresolved = await mutateReservation(runId, (record) =>
              record.cancel || record.result?.outcome === "cancelled"
                ? enterLossEpisode(record, "cancel_stop_unconfirmed", now().toISOString())
                : record,
            );
            if (unresolved.indeterminateCause === "cancel_stop_unconfirmed") {
              await appendRunEvents(
                runId,
                protocolVersion,
                [{
                  type: "run.lost",
                  payload: lossEpisodePayload(unresolved, { cause: "cancel_stop_unconfirmed", ...(detail ? { detail } : {}) }),
                  origin: await origin(),
                }],
                { onlyIfAbsentKeys: true },
              );
            }
          }
        }
      } catch (error) {
        const wire = toWireError(error);
        if (error instanceof IndeterminateExecutionError) {
          await markLaunchLost(runId, error, wire);
          return;
        }
        const cause = `${wire.code}: ${wire.message}`;
        const failed = await commitRunTerminalResult(
          runId,
          { outcome: "failed", cause, failureCause: cause },
          { now, canCommit: (record) => launchAttemptOwns(record, attemptId) },
        );
        await appendRunTerminalEvents(failed, protocolVersion, await origin());
      }
    })();
    inFlight.set(runId, attempt);
    try {
      await attempt;
    } finally {
      if (inFlight.get(runId) === attempt) inFlight.delete(runId);
    }
  }

  /** Claim/continue one launch; only the atomic claim winner calls launcher. */
  async function continueLaunch(reservation: RunReservation, lease: JsonObject): Promise<RunReservation> {
    const claim = await claimRunLaunchAttempt(reservation.runId, await launchOwner(), {
      now,
      inspectOwner: inspectLaunchOwner,
      evidence: () => options.sessions.evidence(reservation.beeName),
    });
    if (!claim.attemptId) return claim.reservation;
    const resumablePreparation =
      claim.disposition === "owned" && claim.reservation.launchAttempt?.stage === "preparing";
    if (!claim.claimed && !resumablePreparation) return claim.reservation;
    await launch(claim.reservation, lease, claim.attemptId, claim.claimed);
    return (await readReservation(claim.reservation.runId))!;
  }

  /**
   * Reconcile a reservation with the durable session evidence: repair the
   * started-receipt-lost crash window, mark indeterminate outcomes lost, and
   * fold a finished harness into terminal state + events. Idempotent; called
   * from run.start replays, run.get, and run.events.
   */
  async function reconcile(reservation: RunReservation): Promise<RunReservation> {
    await ensureAcceptedReceipt(reservation);
    const launchEvidence = await options.sessions.evidence(reservation.beeName);
    const classification = classifyLaunch(reservation, launchEvidence, {
      inFlight: inFlight.has(reservation.runId),
      nowMs: now().getTime(),
      ...(options.launchGraceMs !== undefined ? { graceMs: options.launchGraceMs } : {}),
    });
    let current = reservation;
    if (classification === "started-receipt-lost") {
      // The process started durably but the receipt path crashed. Binding to
      // the provisional xr-* lookup name would leak the wrong public identity;
      // require the canonical SessionRecord.id carried by launch evidence.
      if (!launchEvidence.sessionRef) {
        current = await mutateReservation(current.runId, (record) =>
          record.result ? record : enterLossEpisode(record, "session_ref_missing", now().toISOString()),
        );
        if (!current.result) {
          await appendRunEvents(
            current.runId,
            protocolVersion,
            [{ type: "run.lost", payload: lossEpisodePayload(current, { cause: "session_ref_missing" }), origin: await origin() }],
            { onlyIfAbsentKeys: true },
          );
        }
      } else {
        // Explicit placement already claimed its locator before spawn. Rebuild
        // its path-free environment receipt so the repaired lifecycle remains
        // environment.ready -> harness.running after a coordinator crash.
        const recoveredEnvironment = current.environment ?? await (async () => {
          const { recoverExplicitPlacementEnvironment } = await import("./launcher.js");
          return recoverExplicitPlacementEnvironment(await canonicalNodeId(), current);
        })();
        if (!recoveredEnvironment) {
          current = await mutateReservation(current.runId, (record) =>
            record.result
              ? record
              : enterLossEpisode({ ...record, sessionRef: launchEvidence.sessionRef }, "environment_receipt_missing", now().toISOString()),
          );
          if (!current.result) {
            await appendRunEvents(
              current.runId,
              protocolVersion,
              [{ type: "run.lost", payload: lossEpisodePayload(current, { cause: "environment_receipt_missing" }), origin: await origin() }],
              { onlyIfAbsentKeys: true },
            );
          }
        } else {
          const recovering = await beginLostRecovery(current, ["run-identity", "hsr-readiness", "session-identity", "environment-ownership"]);
          current = await mutateReservation(current.runId, (record) => {
            return record.phase === "launching" && !record.result
              ? {
                  ...record,
                  phase: "started",
                  startedAt: record.startedAt ?? now().toISOString(),
                  sessionRef: launchEvidence.sessionRef,
                  environment: recoveredEnvironment,
                }
              : record;
          });
          if (recovering?.lossEpisodeId) {
            await ensureStartedReceipts(current, recovering.lossEpisodeId);
            current = await mutateReservation(current.runId, (record) => clearLossEpisode(record));
          }
        }
      }
    } else if (classification === "booting-receipt-lost") {
      if (launchEvidence.ready === undefined && !current.indeterminateAt) {
        current = await mutateReservation(current.runId, (record) =>
          record.result ? record : enterLossEpisode(record, "readiness_evidence_missing", now().toISOString()),
        );
        if (!current.result) {
          await appendRunEvents(
            current.runId,
            protocolVersion,
            [{ type: "run.lost", payload: lossEpisodePayload(current, { cause: "readiness_evidence_missing" }), origin: await origin() }],
            { onlyIfAbsentKeys: true },
          );
        }
      }
      const outcome = await options.sessions.outcome(current.beeName);
      if (outcome && !outcome.live) {
        await beginLostRecovery(current, ["run-identity", "process-exit"]);
        const cause = "HARNESS_UNAVAILABLE: harness exited before readiness";
        current = await commitRunTerminalResult(
          current.runId,
          { outcome: "failed", cause, failureCause: cause },
          { now, clearIndeterminate: true, canCommit: (record) => record.phase === "launching" },
        );
        await appendRunTerminalEvents(current, protocolVersion, await origin());
      }
    } else if (classification === "indeterminate") {
      if (!current.indeterminateAt) {
        current = await mutateReservation(current.runId, (record) =>
          record.result ? record : enterLossEpisode(record, "start_outcome_indeterminate", now().toISOString()),
        );
        if (!current.result) {
          await appendRunEvents(
            current.runId,
            protocolVersion,
            [{ type: "run.lost", payload: lossEpisodePayload(current, { cause: "start_outcome_indeterminate" }), origin: await origin() }],
            { onlyIfAbsentKeys: true },
          );
        }
      }

      // A readiness timeout whose first stop was unconfirmed remains lost,
      // never terminally failed, while the runtime may be live. Reconciliation
      // retries a now-available control socket and resolves only after stop or
      // outcome evidence proves the process is down.
      if (current.indeterminateCause === "readiness_stop_unconfirmed") {
        const outcome = await options.sessions.outcome(current.beeName);
        let stopConfirmed = Boolean(outcome && !outcome.live);
        if (outcome?.live) {
          try {
            stopConfirmed = (await stopKnownExecution(current.beeName)).stopped;
          } catch {
            stopConfirmed = false;
          }
        }
        if (stopConfirmed) {
          await beginLostRecovery(current, ["run-identity", "process-stop"]);
          const cause = "HARNESS_UNAVAILABLE: readiness timed out; stop eventually confirmed";
          current = await commitRunTerminalResult(
            current.runId,
            { outcome: "failed", cause, failureCause: cause },
            {
              now,
              clearIndeterminate: true,
              canCommit: (record) => record.indeterminateCause === "readiness_stop_unconfirmed",
            },
          );
          await appendRunTerminalEvents(current, protocolVersion, await origin());
        }
      }
    }
    // A started Run may lose liveness more than once. Positive durable
    // readiness/session evidence repairs each episode independently. Publish
    // the episode-keyed running receipt BEFORE clearing its durable key so a
    // crash cannot strand Apiary at recovering with no way to replay it.
    if (
      current.phase === "started" &&
      current.indeterminateAt &&
      recoverableLostCauses.has(current.indeterminateCause ?? "") &&
      launchEvidence.ready === true &&
      launchEvidence.sessionRef === current.sessionRef &&
      (launchEvidence.stampedRunId === undefined || launchEvidence.stampedRunId === current.runId) &&
      current.environment &&
      current.sessionRef
    ) {
      const recovering = await beginLostRecovery(current, ["run-identity", "hsr-readiness", "session-identity", "environment-ownership"]);
      if (recovering?.lossEpisodeId) {
        await ensureStartedReceipts(current, recovering.lossEpisodeId);
        current = await mutateReservation(current.runId, (record) => clearLossEpisode(record));
      }
    }
    await ensureStartedReceipts(current);
    if (
      current.phase === "launching" &&
      current.cancel &&
      !current.result &&
      current.indeterminateCause === "cancel_stop_unconfirmed"
    ) {
      // The launcher lost its started CAS to cancellation and its first exact
      // stop was unconfirmed. A later proven process exit (or strict stop of
      // the still-bound HSR execution) is enough to resolve cancellation; no
      // second launch is ever admitted while this owner token remains.
      const outcome = await options.sessions.outcome(current.beeName);
      let stopConfirmed = Boolean(outcome && !outcome.live);
      if (outcome?.live) {
        try {
          stopConfirmed = (await stopKnownExecution(current.beeName)).stopped;
        } catch {
          stopConfirmed = false;
        }
      }
      if (stopConfirmed) {
        await beginLostRecovery(current, ["run-identity", "process-stop"]);
        const attemptId = current.launchAttempt?.attemptId;
        current = await commitRunTerminalResult(
          current.runId,
          { outcome: "cancelled", cause: "cancel_requested" },
          {
            now,
            clearIndeterminate: true,
            canCommit: (record) => !!attemptId && launchAttemptOwns(record, attemptId) && record.cancel !== undefined,
          },
        );
        await appendRunTerminalEvents(current, protocolVersion, await origin());
      }
    }
    const leaseExpired = Date.parse(current.leaseExpiresAt) < now().getTime();
    const terminalCancelStopDoubt =
      current.result?.outcome === "cancelled" && current.indeterminateCause === "cancel_stop_unconfirmed";
    if (
      current.phase === "started" &&
      ((!current.result && (current.cancel !== undefined || leaseExpired)) || terminalCancelStopDoubt)
    ) {
      // Durable desired-state stop reconciler. Two ways in: execution
      // authority died with the lease (a still-running harness must not
      // continue unbounded), or a cancellation intent exists whose stop was
      // never confirmed. EVERY reconcile pass retries the clean stop until it
      // is confirmed or the session outcome proves exit — a transient stop
      // failure never strands a live harness behind a lost marker.
      if (!current.result && !current.cancel) {
        current = await mutateReservation(current.runId, (record) =>
          record.result || record.cancel
            ? record
            : { ...record, cancel: { requestedAt: now().toISOString(), reason: "lease_expired" } },
        );
        if (!current.result && current.cancel?.reason === "lease_expired") {
          await appendRunEvents(
            current.runId,
            protocolVersion,
            [{ type: "cancel.requested", payload: { reason: "lease_expired" }, origin: await origin() }],
            { onlyIfAbsentKeys: true },
          );
        }
      }
      if (!current.result || terminalCancelStopDoubt) {
        const evidence = await options.sessions.evidence(current.beeName);
        const ours = evidence.sessionExists && (evidence.stampedRunId === undefined || evidence.stampedRunId === current.runId);
        let stopConfirmed = true;
        let detail = "no live harness";
        if (ours) {
          try {
            const stop = await control.stop(current.beeName);
            stopConfirmed = stop.stopped;
            detail = stop.detail;
          } catch (error) {
            stopConfirmed = false;
            detail = error instanceof Error ? error.message : String(error);
          }
        }
        if (stopConfirmed) {
          const recovering = current.indeterminateCause === "cancel_stop_unconfirmed"
            ? await publishLossRecoveryExit(current, ["run-identity", "process-stop"])
            : null;
          if (current.result) {
            if (recovering) current = await clearPublishedLossEpisode(recovering);
          } else {
            current = await commitRunTerminalResult(
              current.runId,
              { outcome: "cancelled", cause: "cancel_requested" },
              {
                now,
                clearIndeterminate: true,
                canCommit: (record) => record.phase === "started" && record.cancel !== undefined,
              },
            );
          }
          await appendRunTerminalEvents(current, protocolVersion, await origin());
        } else {
          current = await mutateReservation(current.runId, (record) =>
            !record.result || record.result.outcome === "cancelled"
              ? enterLossEpisode(record, "cancel_stop_unconfirmed", now().toISOString())
              : record,
          );
          if (current.indeterminateCause === "cancel_stop_unconfirmed") {
            await appendRunEvents(
              current.runId,
              protocolVersion,
              [{
                type: "run.lost",
                payload: lossEpisodePayload(current, { cause: "cancel_stop_unconfirmed", detail }),
                origin: await origin(),
              }],
              { onlyIfAbsentKeys: true },
            );
          }
        }
      }
    }
    if (!current.result && current.cancel) {
      // Durable cancellation intent resolves terminally ONLY on proof: a
      // reservation that provably never started (no launch in flight, no
      // session evidence, grace elapsed) can never run, so cancelled is fact,
      // not hope. Every other case waits for a confirmed stop or exit fold.
      const cancelClassification = classifyLaunch(current, await options.sessions.evidence(current.beeName), {
        inFlight: inFlight.has(current.runId),
        nowMs: now().getTime(),
        ...(options.launchGraceMs !== undefined ? { graceMs: options.launchGraceMs } : {}),
      });
      if (cancelClassification === "reserved-not-started") {
        current = await commitRunTerminalResult(
          current.runId,
          { outcome: "cancelled", cause: "cancel_requested" },
          { now, clearIndeterminate: true, canCommit: (record) => record.phase !== "started" },
        );
        await appendRunTerminalEvents(current, protocolVersion, await origin());
      }
    }
    if (current.phase === "started" && !current.result) {
      const outcome = await options.sessions.outcome(current.beeName);
      if (outcome && !outcome.live) {
        const exitCode = outcome.exitCode ?? undefined;
        // The exit code is only a candidate. The terminal decision is made
        // from the fresh record under the reservation lock, where an existing
        // result or cancellation intent wins over this possibly stale read.
        current = await commitRunTerminalResult(
          current.runId,
          {
            outcome: exitCode === 0 ? "completed" : "failed",
            ...(exitCode === 0 ? {} : { cause: "harness_exited" }),
            ...(exitCode !== undefined ? { harnessExitCode: exitCode } : {}),
          },
          { now, clearIndeterminate: true, canCommit: (record) => record.phase === "started" },
        );
        await appendRunTerminalEvents(
          current,
          protocolVersion,
          await origin(),
          [
            {
              type: "harness.exited",
              payload: exitCode !== undefined ? { exitCode } : {},
              origin: await origin({ driverId: driverIdOf(current) }),
            },
          ],
        );
      }
    }
    if (current.result && current.indeterminateAt) {
      // A terminal fact recorded while a stop was unconfirmable: the doubt
      // clears only after the stream durably shows recovering + exited.
      const outcome = await options.sessions.outcome(current.beeName);
      if (outcome && !outcome.live) {
        const recovering = await publishLossRecoveryExit(
          current,
          ["run-identity", "process-exit"],
          outcome.exitCode ?? undefined,
        );
        if (recovering) current = await clearPublishedLossEpisode(recovering);
      }
    }
    // Self-heal missing lifecycle events: a crash can land between a durable
    // state write and its event append, and replays deliberately skip side
    // effects — so every read re-derives the events its state implies.
    if (current.result) await appendRunTerminalEvents(current, protocolVersion, await origin());
    const repairs: RunEventInput[] = [];
    if (current.sealedAt && current.environment) {
      repairs.push({
        type: "environment.sealed",
        payload: { environmentId: current.environment.environmentId },
        origin: await origin({ providerId: current.environment.providerId }),
      });
    }
    if (current.releasedAt && current.environment) {
      repairs.push({
        type: "environment.released",
        payload: { environmentId: current.environment.environmentId },
        origin: await origin({ providerId: current.environment.providerId }),
      });
    }
    if (repairs.length > 0) await appendRunEvents(current.runId, protocolVersion, repairs, { onlyIfAbsentTypes: true });
    return current;
  }

  /** Derive the projection state/health from a reconciled reservation. */
  function deriveState(reservation: RunReservation, launchInFlight: boolean): { state: string; health: "ready" | "degraded" | "lost" } {
    // Unresolved liveness doubt WINS over a recorded terminal fact: a result
    // written while a stop was unconfirmable must not project a comfortable
    // terminal state over a possibly-live harness. Reconciliation clears
    // indeterminateAt once the session outcome proves exit.
    if (reservation.indeterminateAt) return { state: "lost", health: "lost" };
    if (reservation.result) {
      return { state: reservation.result.outcome, health: "ready" };
    }
    switch (reservation.phase) {
      case "reserved":
        return { state: "accepted", health: "ready" };
      case "launching":
        return { state: "starting", health: launchInFlight ? "ready" : "degraded" };
      case "started":
        return { state: "running", health: "ready" };
      case "failed":
        return { state: "failed", health: "ready" };
    }
  }

  async function buildProjection(reservation: RunReservation): Promise<JsonObject> {
    const nodeId = await canonicalNodeId();
    const events = await readRunEvents(reservation.runId);
    const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
    const { state, health } = deriveState(reservation, inFlight.has(reservation.runId));
    return {
      runId: reservation.runId,
      jobId: reservation.jobId,
      state,
      stateVersion: lastSeq,
      lastEventSeq: lastSeq,
      health,
      updatedAt: reservation.updatedAt,
      ...(reservation.environment
        ? {
            environment: {
              runId: reservation.runId,
              nodeId,
              providerId: reservation.environment.providerId,
              environmentId: reservation.environment.environmentId,
              isolation: reservation.environment.isolation,
              ...(reservation.environment.workingCopy ? { workingCopy: reservation.environment.workingCopy } : {}),
              ...(reservation.retainUntil && !reservation.releasedAt ? { retainedUntil: reservation.retainUntil } : {}),
            },
          }
        : {}),
      ...(reservation.result ? { result: { ...reservation.result } } : {}),
    };
  }

  /* -------------------------------------------------------------- */
  /* Per-run operations (run.command/cancel/collect/retain/release)  */
  /* -------------------------------------------------------------- */

  const ops: RunOperations = createRunOperations({
    contract,
    validator,
    protocolVersion,
    schemaDigest,
    now,
    binding,
    ...(options.verifySignature ? { verifySignature: options.verifySignature } : {}),
    control,
    sessions: options.sessions,
    settle: async (reservation) => {
      const settled = await reconcile(reservation);
      return { reservation: settled, state: deriveState(settled, inFlight.has(settled.runId)).state };
    },
    origin,
  });

  /* -------------------------------------------------------------- */
  /* Methods                                                         */
  /* -------------------------------------------------------------- */

  function effectResponse(requestId: JsonValue, reservation: RunReservation, outcome: "created" | "replayed", state: string): JsonObject {
    return {
      protocolVersion,
      requestId: String(requestId ?? ""),
      receipt: { ...reservation.receipt, outcome },
      result: { runId: reservation.runId, state },
    };
  }

  function effectError(requestId: JsonValue, error: unknown): JsonObject {
    return { protocolVersion, requestId: String(requestId ?? ""), error: toWireError(error) as unknown as JsonValue } as JsonObject;
  }

  async function runStart(request: JsonValue): Promise<JsonObject> {
    const requestId = (request as JsonObject | null)?.requestId ?? "";
    try {
      const installed = await binding();
      const validated = validateRunStart(request, {
        validator,
        binding: installed,
        nodeId: installed.nodeId,
        protocolVersion,
        ...(options.verifySignature ? { verifySignature: options.verifySignature } : {}),
        now,
        // The validity window is enforced below for NEW admissions and for
        // relaunches only: an identical retry must still replay its recorded
        // receipt after the lease expired (replay is read-only).
        skipTimeWindow: true,
      });
      const peeked = await readReservation(validated.runId);
      const identicalRetry =
        peeked !== null && peeked.effectKey === validated.effectKey && peeked.requestDigest === validated.requestDigest;
      if (!identicalRetry) assertLeaseWindow(validated.lease, now());
      // Trusted parent authorship, admitted once from validated facts only:
      // the initiator is the authority ActorContext initiator, and a
      // parentRunId must name a Run reserved on THIS node in the SAME owner
      // scope + workspace — a parent is never invented for an unknown or
      // cross-scope reference. Checked for NEW admissions only, so identical
      // replays stay read-only even after the parent Run is released.
      const initiator = initiatorOf(validated.authority);
      if (!identicalRetry) {
        const parentRunId = (validated.intent as JsonObject).parentRunId;
        if (parentRunId !== undefined) {
          const parent = typeof parentRunId === "string" ? await readReservation(parentRunId) : null;
          if (!parent) {
            throw executionError("RUN_UNKNOWN", `parentRunId ${String(parentRunId)} names no Run reserved on this node`);
          }
          if (
            parent.ownerScopeId !== String(validated.authority.ownerScopeId) ||
            parent.workspaceId !== String(validated.authority.workspaceId)
          ) {
            throw executionError("LEASE_DENIED", `parentRunId ${parent.runId} belongs to a different owner scope/workspace`);
          }
        }
      }
      const { reservation, created } = await admitRunStart({
        runId: validated.runId,
        effectKey: validated.effectKey,
        requestDigest: validated.requestDigest,
        protocolVersion,
        schemaDigest,
        ownerScopeId: String(validated.authority.ownerScopeId),
        workspaceId: String(validated.authority.workspaceId),
        jobId: String(validated.intent.jobId),
        leaseId: String(validated.lease.leaseId),
        leaseExpiresAt: String(validated.lease.expiresAt),
        capabilityLeaseId: String(validated.authority.capabilityLeaseId),
        intent: validated.intent,
        ...(initiator ? { initiator } : {}),
      });
      // Admission and event append are separate durable writes. An identical
      // retry after a crash in between must repair run.accepted before it can
      // materialize, reconcile, or terminalize anything downstream.
      await ensureAcceptedReceipt(reservation);
      if (created) {
        await options.afterAdmission?.(reservation);
        await continueLaunch(reservation, validated.lease);
        const settled = await reconcile((await readReservation(reservation.runId))!);
        return effectResponse(requestId, settled, "created", deriveState(settled, inFlight.has(settled.runId)).state);
      }
      // Identical retry: replay the original receipt. The atomic durable claim
      // decides whether this process may continue the effect: reserved records
      // are claimable; a launching record is claimable only after its exact
      // owner is proven dead and positive launch evidence is absent.
      let current = await reconcile(reservation);
      current = await continueLaunch(current, validated.lease);
      current = await reconcile((await readReservation(current.runId))!);
      return effectResponse(requestId, current, "replayed", deriveState(current, inFlight.has(current.runId)).state);
    } catch (error) {
      return effectError(requestId, error);
    }
  }

  async function loadReservationFor(request: JsonValue, schema: string): Promise<RunReservation> {
    const check = validator.validate(schema, request);
    if (!check.valid) {
      throw executionError("SCHEMA_UNSUPPORTED", `invalid ${schema} request: ${check.errors.join("; ")}`);
    }
    const doc = request as JsonObject;
    if (doc.protocolVersion !== protocolVersion) {
      throw executionError("PROTOCOL_INCOMPATIBLE", `protocolVersion ${String(doc.protocolVersion)} is not ${protocolVersion}`);
    }
    const runId = String(doc.runId);
    const reservation = await readReservation(runId);
    if (!reservation) throw executionError("RUN_UNKNOWN", `runId ${runId} names no Run reserved on this node`);
    return reservation;
  }

  async function runGet(request: JsonValue): Promise<NonEffectResult> {
    try {
      const reservation = await reconcile(await loadReservationFor(request, "run-get-request"));
      await ops.reconcileOperations(reservation.runId);
      return { result: await buildProjection(reservation) };
    } catch (error) {
      return { error: toWireError(error) };
    }
  }

  async function runEvents(request: JsonValue): Promise<NonEffectResult> {
    try {
      const reservation = await reconcile(await loadReservationFor(request, "run-events-request"));
      await ops.reconcileOperations(reservation.runId);
      const doc = request as JsonObject;
      const afterSeq = Number(doc.afterSeq ?? 0);
      const all = await readRunEvents(reservation.runId);
      const cursorResetThrough = acceptedCursorResetThroughSeq(all);
      if (cursorResetThrough !== null && afterSeq > 0 && afterSeq <= cursorResetThrough) {
        throw executionError(
          "CURSOR_EXPIRED",
          `run ${reservation.runId} event history was repaired; cursor ${afterSeq} belongs to the pre-repair generation`,
          undefined,
          { nextSeq: 0 },
        );
      }
      // A reset page is deliberately complete even when the stale consumer's
      // normal page size is smaller. Numeric v1 cursors carry no generation;
      // returning the repaired head in one page makes its next cursor greater
      // than every invalidated pre-repair cursor and removes the ambiguity.
      const resetReplay = cursorResetThrough !== null && afterSeq === 0;
      const limit = resetReplay
        ? Number.POSITIVE_INFINITY
        : typeof doc.limit === "number" && doc.limit >= 1 ? Math.floor(doc.limit) : Number.POSITIVE_INFINITY;
      const events: StoredRunEvent[] = [];
      for (const event of all) {
        if (event.seq <= afterSeq) continue;
        if (events.length >= limit) break;
        events.push(event);
      }
      const nextAfterSeq = events.length > 0 ? events[events.length - 1]!.seq : afterSeq;
      return {
        result: {
          runId: reservation.runId,
          afterSeq,
          events: events as unknown as JsonValue[],
          nextAfterSeq,
          // H1 keeps the full control log (no compaction), so replay always
          // starts at seq 1; CURSOR_EXPIRED arrives with compaction in H2.
          retention: { oldestReplayableSeq: all.length > 0 ? all[0]!.seq : 1 },
        },
      };
    } catch (error) {
      return { error: toWireError(error) };
    }
  }

  async function describe(request: JsonValue): Promise<NonEffectResult> {
    try {
      const check = validator.validate("node-describe-request", request);
      if (!check.valid) {
        throw executionError("SCHEMA_UNSUPPORTED", `invalid node.describe request: ${check.errors.join("; ")}`);
      }
      const doc = request as JsonObject;
      if (doc.protocolVersion !== protocolVersion) {
        throw executionError("PROTOCOL_INCOMPATIBLE", `protocolVersion ${String(doc.protocolVersion)} is not ${protocolVersion}`);
      }
      const installed = await binding();
      assertDescribeScope(doc, installed);
      const descriptor = await buildNodeDescriptor({
        identity: await identity(),
        binding: installed,
        protocolVersion,
        features: supportedFeatures(contract),
        ...(options.harnessProbe ? { harnessProbe: options.harnessProbe } : {}),
        now,
      });
      return { result: descriptor };
    } catch (error) {
      return { error: toWireError(error) };
    }
  }

  return {
    contract,
    validator,
    schemaDigest,
    protocolVersion,
    hello: (request) => negotiateHello(request, contract, validator, schemaDigest),
    describe,
    runStart,
    runGet,
    runEvents,
    runCommand: ops.runCommand,
    runCancel: ops.runCancel,
    runCollect: ops.runCollect,
    runRetain: ops.runRetain,
    runRelease: ops.runRelease,
  };
}

/* ---------------------------------------------------------------- */
/* Production session-evidence source                                */
/* ---------------------------------------------------------------- */

/** Durable evidence from the session store + HSR run dir (production wiring). */
export function storeSessionEvidenceSource(): SessionEvidenceSource {
  return {
    async evidence(beeName) {
      const [{ loadSession }, { readHsrMeta }, { inspectHsrHostProcess }] = await Promise.all([
        import("../store.js"),
        import("../hsr/runDir.js"),
        import("../hsr/observe.js"),
      ]);
      const record = await loadSession(beeName);
      const meta = await readHsrMeta(beeName);
      let ready: boolean | undefined;
      if (meta) {
        if (meta.status !== "running" || typeof meta.runningAt !== "string") {
          ready = false;
        } else if (meta.mirrorOfNode) {
          ready = true;
        } else {
          const identity = await inspectHsrHostProcess(meta);
          if (identity === "match") ready = true;
          else if (identity === "gone" || identity === "mismatch") ready = false;
        }
      }
      return {
        sessionExists: record !== null || meta !== null,
        ...(record?.executionRunId !== undefined ? { stampedRunId: record.executionRunId } : {}),
        ...(record?.id !== undefined ? { sessionRef: record.id } : {}),
        ...(ready !== undefined ? { ready } : {}),
      };
    },
    async outcome(beeName) {
      const [{ loadSession }, { readHsrMeta }, { inspectHsrHostProcess }] = await Promise.all([
        import("../store.js"),
        import("../hsr/runDir.js"),
        import("../hsr/observe.js"),
      ]);
      const meta = await readHsrMeta(beeName);
      if (meta) {
        if (meta.status === "exited") return { live: false, exitCode: meta.exitCode ?? null };
        if (!meta.mirrorOfNode) {
          const identity = await inspectHsrHostProcess(meta);
          if (identity === "gone" || identity === "mismatch") return { live: false, exitCode: null };
          if (identity !== "match") return null;
        }
        return { live: true };
      }
      const record = await loadSession(beeName);
      if (!record) return null;
      // A record-only HSR session proves identity/ownership, not process
      // liveness. Its host meta may be delayed; wait for it (or a later record
      // terminal state) instead of treating the label "running" as proof.
      if (record.substrate === "hsr" && record.status === "running") return null;
      return record.status === "running" ? { live: true } : { live: false, exitCode: null };
    },
  };
}
