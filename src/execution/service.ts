// Execution coordinator for the H1 slice of local-core-v1: effect-keyed
// run.start admission -> durable reservation -> injected launcher -> bound
// session, plus run.get / run.events over the durable per-Run control events.
//
// The launcher is an injected seam (RunLauncher): production wires the HSR
// spawn path (launcher.ts); tests wire fakes and crash injections. The
// coordinator itself never resolves a cwd and never falls back to a CLI after
// admission — if the launcher cannot satisfy the leased placement it throws a
// typed error and the Run fails with that cause.
import type { JsonValue } from "../comb/types.js";
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
  appendRunEvents,
  classifyLaunch,
  mutateReservation,
  readReservation,
  readRunEvents,
  type LaunchEvidence,
  type RunEnvironmentFacts,
  type RunEventInput,
  type RunReservation,
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
  sessionRef?: string;
  environment: RunEnvironmentFacts;
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

export function createExecutionService(options: ExecutionServiceOptions): ExecutionService {
  const contract = loadExecutionContract();
  const validator = createExecutionValidator(contract);
  const schemaDigest = computeSchemaDigest(contract);
  const protocolVersion = typeof contract.profile.protocolVersion === "string" ? contract.profile.protocolVersion : "0.1";
  const now = options.now ?? (() => new Date());
  const control = options.control ?? hsrHarnessControl();
  const stopKnownExecution = options.stopKnownExecution ?? (async (beeName: string) => {
    const result = await (await import("../hsr/substrate.js")).stopKnownHsrExecution(beeName);
    return { stopped: result.ok, detail: result.ok ? "HSR stop confirmed" : result.stderr || "HSR stop unconfirmed" };
  });
  const inFlight = new Map<string, Promise<void>>();

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
  ]);

  /**
   * Establish the contract's lost -> recovering edge before convergence.
   * Reservation mutation and event append are separate durable writes, so a
   * crash may leave indeterminateAt/cause without its run.lost event. Repair
   * both edges together under one event-log lock before any recovered receipt.
   */
  async function beginLostRecovery(reservation: RunReservation, verified: string[]): Promise<void> {
    if (
      !reservation.indeterminateAt ||
      !reservation.indeterminateCause ||
      !recoverableLostCauses.has(reservation.indeterminateCause)
    ) return;
    const eventOrigin = await origin();
    await appendRunEvents(
      reservation.runId,
      protocolVersion,
      [
        {
          type: "run.lost",
          payload: { cause: reservation.indeterminateCause },
          origin: eventOrigin,
        },
        {
          type: "run.recovering",
          payload: { cause: reservation.indeterminateCause, verified },
          origin: eventOrigin,
        },
      ],
      { onlyIfAbsentTypes: true },
    );
  }

  /**
   * Repair the second coordinator-write gap: phase=started is persisted only
   * after launcher readiness succeeds, so its session/environment facts are
   * durable proof that these receipts belong before any later terminal fold.
   * Unresolved lost state is excluded; its recovery path must establish
   * run.recovering and clear indeterminateAt first.
   */
  async function ensureStartedReceipts(reservation: RunReservation): Promise<void> {
    if (
      reservation.phase !== "started" ||
      reservation.indeterminateAt ||
      !reservation.environment ||
      !reservation.sessionRef
    ) return;
    await appendRunEvents(
      reservation.runId,
      protocolVersion,
      [
        {
          type: "environment.ready",
          payload: { environmentId: reservation.environment.environmentId },
          origin: await origin({ providerId: reservation.environment.providerId }),
        },
        {
          type: "harness.running",
          payload: { sessionRef: reservation.sessionRef },
          origin: await origin({ driverId: driverIdOf(reservation) }),
        },
      ],
      { onlyIfAbsentTypes: true },
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

  /** Run the launcher for a reservation this caller owns. Never throws. */
  async function launch(reservation: RunReservation, lease: JsonObject): Promise<void> {
    const runId = reservation.runId;
    const attempt = (async () => {
      await mutateReservation(runId, (current) => ({
        ...current,
        phase: "launching",
        launchAttemptedAt: now().toISOString(),
      }));
      await appendRunEvents(
        runId,
        protocolVersion,
        [
          { type: "environment.materializing", payload: {}, origin: await origin({ providerId: NATIVE_PROVIDER_ID }) },
          { type: "harness.starting", payload: { operationId: runId }, origin: await origin({ driverId: driverIdOf(reservation) }) },
        ],
        { onlyIfAbsentTypes: true },
      );
      try {
        const spawnedById = await runSpawnedById(reservation);
        const result = await options.launcher({
          runId,
          beeName: reservation.beeName,
          intent: reservation.intent,
          lease,
          ...(spawnedById ? { spawnedById } : {}),
        });
        await mutateReservation(runId, (current) => ({
          ...current,
          phase: "started",
          startedAt: now().toISOString(),
          ...(result.sessionRef ? { sessionRef: result.sessionRef } : {}),
          environment: result.environment,
        }));
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
              payload: result.sessionRef ? { sessionRef: result.sessionRef } : {},
              origin: await origin({ driverId: driverIdOf(reservation) }),
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
            const stop = await control.stop(reservation.beeName);
            stopConfirmed = stop.stopped;
            detail = stop.detail;
          } catch (error) {
            detail = error instanceof Error ? error.message : String(error);
          }
          if (stopConfirmed) {
            // The sweep owns terminal resolution for a cancel that landed
            // pre-running: confirmed stop -> atomically cancelled + event.
            const resolved = await mutateReservation(runId, (record) => {
              const { indeterminateAt: _resolved, ...rest } = record;
              if (rest.result) return rest as RunReservation;
              return {
                ...(rest as RunReservation),
                result: { outcome: "cancelled", cause: record.cancel?.reason ?? "cancel_requested", finishedAt: now().toISOString() },
              };
            });
            if (resolved.result?.outcome === "cancelled") {
              await appendRunEvents(
                runId,
                protocolVersion,
                [{ type: "run.cancelled", payload: { cause: resolved.result.cause ?? "cancel_requested" }, origin: await origin() }],
                { onlyIfAbsentTypes: true },
              );
            }
          } else {
            await mutateReservation(runId, (record) =>
              record.indeterminateAt ? record : { ...record, indeterminateAt: now().toISOString() },
            );
            await appendRunEvents(
              runId,
              protocolVersion,
              [{ type: "run.lost", payload: { cause: "cancel_stop_unconfirmed", ...(detail ? { detail } : {}) }, origin: await origin() }],
              { onlyIfAbsentTypes: true },
            );
          }
        }
      } catch (error) {
        const wire = toWireError(error);
        if (error instanceof IndeterminateExecutionError) {
          await mutateReservation(runId, (current) => ({
            ...current,
            indeterminateAt: current.indeterminateAt ?? now().toISOString(),
            indeterminateCause: current.indeterminateCause ?? error.cause,
            failureCause: current.failureCause ?? `${wire.code}: ${wire.message}`,
          }));
          await appendRunEvents(
            runId,
            protocolVersion,
            [{
              type: "run.lost",
              payload: {
                cause: error.cause,
                ...(error.details !== undefined ? { detail: error.details } : {}),
              },
              origin: await origin(),
            }],
            { onlyIfAbsentTypes: true },
          );
          return;
        }
        await mutateReservation(runId, (current) => ({
          ...current,
          phase: "failed",
          failedAt: now().toISOString(),
          failureCause: `${wire.code}: ${wire.message}`,
          result: { outcome: "failed", cause: `${wire.code}: ${wire.message}`, finishedAt: now().toISOString() },
        }));
        await appendRunEvents(
          runId,
          protocolVersion,
          [{ type: "run.failed", payload: { cause: wire.code, message: wire.message }, origin: await origin() }],
          { onlyIfAbsentTypes: true },
        );
      }
    })();
    inFlight.set(runId, attempt);
    try {
      await attempt;
    } finally {
      if (inFlight.get(runId) === attempt) inFlight.delete(runId);
    }
  }

  /**
   * Reconcile a reservation with the durable session evidence: repair the
   * started-receipt-lost crash window, mark indeterminate outcomes lost, and
   * fold a finished harness into terminal state + events. Idempotent; called
   * from run.start replays, run.get, and run.events.
   */
  async function reconcile(reservation: RunReservation): Promise<RunReservation> {
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
        current = await mutateReservation(current.runId, (record) => ({
          ...record,
          indeterminateAt: record.indeterminateAt ?? now().toISOString(),
          indeterminateCause: record.indeterminateCause ?? "session_ref_missing",
        }));
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "run.lost", payload: { cause: "session_ref_missing" }, origin: await origin() }],
          { onlyIfAbsentTypes: true },
        );
      } else {
        // Explicit placement already claimed its locator before spawn. Rebuild
        // its path-free environment receipt so the repaired lifecycle remains
        // environment.ready -> harness.running after a coordinator crash.
        const recoveredEnvironment = current.environment ?? await (async () => {
          const { recoverExplicitPlacementEnvironment } = await import("./launcher.js");
          return recoverExplicitPlacementEnvironment(await canonicalNodeId(), current);
        })();
        if (!recoveredEnvironment) {
          current = await mutateReservation(current.runId, (record) => ({
            ...record,
            sessionRef: launchEvidence.sessionRef,
            indeterminateAt: record.indeterminateAt ?? now().toISOString(),
            indeterminateCause: record.indeterminateCause ?? "environment_receipt_missing",
          }));
          await appendRunEvents(
            current.runId,
            protocolVersion,
            [{ type: "run.lost", payload: { cause: "environment_receipt_missing" }, origin: await origin() }],
            { onlyIfAbsentTypes: true },
          );
        } else {
          await beginLostRecovery(current, ["run-identity", "hsr-readiness", "session-identity", "environment-ownership"]);
          current = await mutateReservation(current.runId, (record) => {
            const { indeterminateAt: _lostAt, indeterminateCause: _lostCause, ...rest } = record;
            return record.phase === "launching"
              ? {
                  ...(rest as RunReservation),
                  phase: "started",
                  startedAt: record.startedAt ?? now().toISOString(),
                  sessionRef: launchEvidence.sessionRef,
                  environment: recoveredEnvironment,
                }
              : record;
          });
        }
      }
    } else if (classification === "booting-receipt-lost") {
      if (launchEvidence.ready === undefined && !current.indeterminateAt) {
        current = await mutateReservation(current.runId, (record) => ({
          ...record,
          indeterminateAt: record.indeterminateAt ?? now().toISOString(),
          indeterminateCause: record.indeterminateCause ?? "readiness_evidence_missing",
        }));
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "run.lost", payload: { cause: "readiness_evidence_missing" }, origin: await origin() }],
          { onlyIfAbsentTypes: true },
        );
      }
      const outcome = await options.sessions.outcome(current.beeName);
      if (outcome && !outcome.live) {
        await beginLostRecovery(current, ["run-identity", "process-exit"]);
        const finishedAt = now().toISOString();
        current = await mutateReservation(current.runId, (record) => {
          const { indeterminateAt: _lostAt, indeterminateCause: _lostCause, ...rest } = record;
          return {
            ...(rest as RunReservation),
            phase: "failed",
            failedAt: record.failedAt ?? finishedAt,
            failureCause: record.failureCause ?? "HARNESS_UNAVAILABLE: harness exited before readiness",
            result: record.result ?? { outcome: "failed", cause: "HARNESS_UNAVAILABLE: harness exited before readiness", finishedAt },
          };
        });
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "run.failed", payload: { cause: "HARNESS_UNAVAILABLE", message: "harness exited before readiness" }, origin: await origin() }],
          { onlyIfAbsentTypes: true },
        );
      }
    } else if (classification === "indeterminate") {
      if (!current.indeterminateAt) {
        current = await mutateReservation(current.runId, (record) =>
          record.indeterminateAt
            ? record
            : { ...record, indeterminateAt: now().toISOString(), indeterminateCause: "start_outcome_indeterminate" },
        );
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "run.lost", payload: { cause: "start_outcome_indeterminate" }, origin: await origin() }],
          { onlyIfAbsentTypes: true },
        );
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
          const finishedAt = now().toISOString();
          current = await mutateReservation(current.runId, (record) => {
            const { indeterminateAt: _lostAt, indeterminateCause: _lostCause, ...rest } = record;
            return {
              ...(rest as RunReservation),
              phase: "failed",
              failedAt: record.failedAt ?? finishedAt,
              failureCause: record.failureCause ?? "HARNESS_UNAVAILABLE: readiness timed out; stop eventually confirmed",
              result: record.result ?? {
                outcome: "failed",
                cause: "HARNESS_UNAVAILABLE: readiness timed out; stop eventually confirmed",
                finishedAt,
              },
            };
          });
          await appendRunEvents(
            current.runId,
            protocolVersion,
            [{ type: "run.failed", payload: { cause: "HARNESS_UNAVAILABLE", message: "readiness timed out; stop confirmed" }, origin: await origin() }],
            { onlyIfAbsentTypes: true },
          );
        }
      }
    }
    await ensureStartedReceipts(current);
    const leaseExpired = Date.parse(current.leaseExpiresAt) < now().getTime();
    if (current.phase === "started" && !current.result && (current.cancel !== undefined || leaseExpired)) {
      // Durable desired-state stop reconciler. Two ways in: execution
      // authority died with the lease (a still-running harness must not
      // continue unbounded), or a cancellation intent exists whose stop was
      // never confirmed. EVERY reconcile pass retries the clean stop until it
      // is confirmed or the session outcome proves exit — a transient stop
      // failure never strands a live harness behind a lost marker.
      if (!current.cancel) {
        current = await mutateReservation(current.runId, (record) =>
          record.cancel ? record : { ...record, cancel: { requestedAt: now().toISOString(), reason: "lease_expired" } },
        );
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "cancel.requested", payload: { reason: "lease_expired" }, origin: await origin() }],
          { onlyIfAbsentKeys: true },
        );
      }
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
        current = await mutateReservation(current.runId, (record) => {
          const { indeterminateAt: _resolved, ...rest } = record;
          if (rest.result) return rest as RunReservation;
          return {
            ...(rest as RunReservation),
            result: { outcome: "cancelled", cause: record.cancel?.reason ?? "cancel_requested", finishedAt: now().toISOString() },
          };
        });
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "run.cancelled", payload: { cause: current.result?.cause ?? "cancel_requested" }, origin: await origin() }],
          { onlyIfAbsentTypes: true },
        );
      } else {
        current = await mutateReservation(current.runId, (record) =>
          record.indeterminateAt ? record : { ...record, indeterminateAt: now().toISOString() },
        );
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "run.lost", payload: { cause: "cancel_stop_unconfirmed", detail }, origin: await origin() }],
          { onlyIfAbsentTypes: true },
        );
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
        current = await mutateReservation(current.runId, (record) => {
          if (record.result) return record;
          const { indeterminateAt: _resolved, ...rest } = record;
          return {
            ...(rest as RunReservation),
            result: { outcome: "cancelled", cause: record.cancel?.reason ?? "cancel_requested", finishedAt: now().toISOString() },
          };
        });
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "run.cancelled", payload: { cause: current.cancel?.reason ?? "cancel_requested" }, origin: await origin() }],
          { onlyIfAbsentTypes: true },
        );
      }
    }
    if (current.phase === "started" && !current.result) {
      const outcome = await options.sessions.outcome(current.beeName);
      if (outcome && !outcome.live) {
        const exitCode = outcome.exitCode ?? undefined;
        // A run with durable cancellation intent whose harness is now provably
        // down finished by being cancelled, not by "failing".
        const terminal: "completed" | "failed" | "cancelled" = current.cancel
          ? "cancelled"
          : exitCode === 0
            ? "completed"
            : "failed";
        current = await mutateReservation(current.runId, (record) => {
          if (record.result) return record;
          // Proven exit resolves any outstanding liveness doubt.
          const { indeterminateAt: _resolved, ...rest } = record;
          return {
            ...(rest as RunReservation),
            result: {
              outcome: terminal,
              ...(terminal === "failed" ? { cause: "harness_exited" } : {}),
              ...(terminal === "cancelled" ? { cause: record.cancel?.reason ?? "cancel_requested" } : {}),
              ...(exitCode !== undefined ? { harnessExitCode: exitCode } : {}),
              finishedAt: now().toISOString(),
            },
          };
        });
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [
            {
              type: "harness.exited",
              payload: exitCode !== undefined ? { exitCode } : {},
              origin: await origin({ driverId: driverIdOf(current) }),
            },
            {
              type: terminal === "completed" ? "run.completed" : terminal === "cancelled" ? "run.cancelled" : "run.failed",
              payload: {},
              origin: await origin(),
            },
          ],
          { onlyIfAbsentTypes: true },
        );
      }
    }
    if (current.result && current.indeterminateAt) {
      // A terminal fact recorded while a stop was unconfirmable: the doubt
      // clears only when the session outcome proves the harness exited.
      const outcome = await options.sessions.outcome(current.beeName);
      if (outcome && !outcome.live) {
        current = await mutateReservation(current.runId, (record) => {
          const { indeterminateAt: _resolved, ...rest } = record;
          return rest as RunReservation;
        });
        await appendRunEvents(
          current.runId,
          protocolVersion,
          [{ type: "harness.exited", payload: {}, origin: await origin({ driverId: driverIdOf(current) }) }],
          { onlyIfAbsentTypes: true },
        );
      }
    }
    // Self-heal missing lifecycle events: a crash can land between a durable
    // state write and its event append, and replays deliberately skip side
    // effects — so every read re-derives the events its state implies.
    const repairs: RunEventInput[] = [];
    if (current.result) {
      repairs.push({ type: `run.${current.result.outcome}`, payload: {}, origin: await origin() });
    }
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
      await appendRunEvents(
        reservation.runId,
        protocolVersion,
        [{ type: "run.accepted", payload: { effectKey: reservation.effectKey, receiptId: reservation.receipt.receiptId }, origin: await origin() }],
        { onlyIfAbsentTypes: true },
      );
      if (created) {
        await launch(reservation, validated.lease);
        const settled = await reconcile((await readReservation(reservation.runId))!);
        return effectResponse(requestId, settled, "created", deriveState(settled, inFlight.has(settled.runId)).state);
      }
      // Identical retry: replay the original receipt; continue the effect only
      // when the durable evidence proves the launch never started.
      let current = await reconcile(reservation);
      const classification = classifyLaunch(current, await options.sessions.evidence(current.beeName), {
        inFlight: inFlight.has(current.runId),
        nowMs: now().getTime(),
        ...(options.launchGraceMs !== undefined ? { graceMs: options.launchGraceMs } : {}),
      });
      // A reservation that already carries a terminal result (e.g. cancelled
      // before its launch ever started) must never relaunch on replay.
      if (classification === "reserved-not-started" && !current.result) {
        if (Date.parse(current.leaseExpiresAt) < now().getTime()) {
          const finishedAt = now().toISOString();
          current = await mutateReservation(current.runId, (record) =>
            record.phase === "started" || record.result
              ? record
              : {
                  ...record,
                  phase: "failed",
                  failedAt: finishedAt,
                  failureCause: "LEASE_DENIED: lease expired before the reserved launch could start",
                  result: { outcome: "failed", cause: "lease_expired", finishedAt },
                },
          );
          await appendRunEvents(
            current.runId,
            protocolVersion,
            [{ type: "run.failed", payload: { cause: "lease_expired" }, origin: await origin() }],
            { onlyIfAbsentTypes: true },
          );
        } else {
          await launch(current, validated.lease);
          current = await reconcile((await readReservation(current.runId))!);
        }
      }
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
      const limit = typeof doc.limit === "number" && doc.limit >= 1 ? Math.floor(doc.limit) : Number.POSITIVE_INFINITY;
      const all = await readRunEvents(reservation.runId);
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
      const [{ loadSession }, { readHsrMeta }] = await Promise.all([import("../store.js"), import("../hsr/runDir.js")]);
      const record = await loadSession(beeName);
      const meta = await readHsrMeta(beeName);
      return {
        sessionExists: record !== null || meta !== null,
        ...(record?.executionRunId !== undefined ? { stampedRunId: record.executionRunId } : {}),
        ...(record?.id !== undefined ? { sessionRef: record.id } : {}),
        ...(meta !== null ? { ready: meta.status === "running" && typeof meta.runningAt === "string" } : {}),
      };
    },
    async outcome(beeName) {
      const [{ loadSession }, { readHsrMeta }, { defaultIsPidAlive }] = await Promise.all([
        import("../store.js"),
        import("../hsr/runDir.js"),
        import("../fsx.js"),
      ]);
      const meta = await readHsrMeta(beeName);
      if (meta) {
        if (meta.status === "exited") return { live: false, exitCode: meta.exitCode ?? null };
        if (!meta.mirrorOfNode && !defaultIsPidAlive(meta.hostPid)) return { live: false, exitCode: null };
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
