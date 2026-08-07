// The H3 per-run effect methods: run.command, run.cancel, run.collect,
// run.retain, run.release (RFC §10.6-10.10). Every method follows the same
// fail-closed shape:
//
//   validate common envelope -> load + bind the reservation -> replay an
//   existing effect from its durable record, or guard + admit a new one
//   BEFORE any side effect -> progress the effect durably (each state change
//   persisted before the next side effect) -> respond with the receipt.
//
// Steering (run.command) is external mutation and dies with the execution
// lease; cancel/collect/retain/release are cleanup/evidence and stay
// available after lease expiry. Command dispatch is at-most-once: a crash
// window that cannot prove delivery becomes `indeterminate` durably and is
// NEVER blindly redelivered.
import type { JsonValue } from "../comb/types.js";
import { randomUUID } from "node:crypto";
import {
  captureProcessBirthFingerprint,
  inspectProcessBirth,
  sameProcessBirthFingerprint,
} from "../hsr/processIdentity.js";
import type { ExecutionContract, ExecutionValidator, JsonObject } from "./contract.js";
import { isTransitionAllowed } from "./contract.js";
import { executionError, toWireError } from "./errors.js";
import { assertLeaseNotExpired, assertRunBinding, validateOperationEnvelope, type ValidatedOperationEnvelope } from "./envelope.js";
import { collectGitDiffMetadata, putEvidence, readRunLogBytes, readTranscriptBytes } from "./evidence.js";
import { HarnessDispatchError, type HarnessControl } from "./harnessControl.js";
import type { ExecutionBindingRecord } from "./nodeState.js";
import {
  admitOperation,
  listOperations,
  mutateOperation,
  readOperation,
  setOperationResult,
  type OperationMethod,
  type OperationAttempt,
  type OperationAttemptKind,
  type OperationRecord,
  type ReleaseStep,
  type ReleaseStepId,
} from "./opsStore.js";
import {
  appendRunEvents,
  appendRunTerminalEvents,
  commitRunTerminalResult,
  enterLossEpisode,
  effectKeyHash,
  lastEventSeq,
  lossEpisodePayload,
  mutateReservation,
  readReservation,
  type RunReservation,
} from "./runStore.js";
import type { SignatureVerifier } from "./signing.js";
import {
  readWorkingCopy,
  releaseWorkingCopy,
  withWorkingCopyOccupancyLock,
  type WorkingCopyRecord,
} from "./workingCopies.js";
import { arch as osArch, platform as osPlatform, release as osRelease } from "node:os";

/* ---------------------------------------------------------------- */
/* Deps                                                              */
/* ---------------------------------------------------------------- */

export type SessionEvidenceReader = {
  evidence(beeName: string): Promise<{ sessionExists: boolean; stampedRunId?: string }>;
};

export type RunOperationsDeps = {
  contract: ExecutionContract;
  validator: ExecutionValidator;
  protocolVersion: string;
  schemaDigest: string;
  now: () => Date;
  binding: () => Promise<ExecutionBindingRecord>;
  verifySignature?: SignatureVerifier;
  control: HarnessControl;
  sessions: SessionEvidenceReader;
  /** Injectable only to place deterministic tests at the post-ownership read barrier. */
  collectGitDiffMetadata?: typeof collectGitDiffMetadata;
  /** Reconcile a reservation and derive its current projection state. */
  settle(reservation: RunReservation): Promise<{ reservation: RunReservation; state: string }>;
  origin(extra?: { driverId?: string; providerId?: string }): Promise<{ nodeId: string; driverId?: string; providerId?: string }>;
};

export type RunOperations = {
  runCommand(request: JsonValue): Promise<JsonObject>;
  runCancel(request: JsonValue): Promise<JsonObject>;
  runCollect(request: JsonValue): Promise<JsonObject>;
  runRetain(request: JsonValue): Promise<JsonObject>;
  runRelease(request: JsonValue): Promise<JsonObject>;
  /** Fold crashed command dispatch windows to durable `indeterminate`. */
  reconcileOperations(runId: string): Promise<void>;
};

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled"]);

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

export function createRunOperations(deps: RunOperationsDeps): RunOperations {
  const { protocolVersion, schemaDigest, now } = deps;
  const collectWorkingCopyDiff = deps.collectGitDiffMetadata ?? collectGitDiffMetadata;
  const operationOwnerId = randomUUID();
  let operationOwnerBirthPromise: Promise<Awaited<ReturnType<typeof captureProcessBirthFingerprint>>> | undefined;
  const operationOwnerBirth = () =>
    (operationOwnerBirthPromise ??= captureProcessBirthFingerprint(process.pid));
  /** In-flight side-effect continuations, keyed `${runId}#${effectKey}`. */
  const inFlight = new Map<string, Promise<unknown>>();
  const flightKey = (runId: string, effectKey: string): string => `${runId}#${effectKey}`;

  /**
   * Single-flight one effect's progression: concurrent identical replays join
   * the same continuation instead of racing it (two callers can both observe
   * `accepted` after admission — only one may dispatch/stop/collect).
   */
  function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const attempt = fn();
    inFlight.set(key, attempt);
    void attempt
      .catch(() => undefined)
      .finally(() => {
        if (inFlight.get(key) === attempt) inFlight.delete(key);
      });
    return attempt;
  }

  const pause = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function newOperationAttempt(kind: OperationAttemptKind): Promise<OperationAttempt> {
    const ownerBirth = await operationOwnerBirth();
    return {
      kind,
      attemptId: randomUUID(),
      ownerId: operationOwnerId,
      ownerPid: process.pid,
      ...(ownerBirth ? { ownerBirth } : {}),
      startedAt: now().toISOString(),
    };
  }

  /** True only with birth-safe proof that this exact owner generation is gone. */
  async function operationAttemptOwnerDead(attempt: OperationAttempt): Promise<boolean> {
    if (attempt.ownerPid === process.pid) {
      const currentBirth = await operationOwnerBirth();
      return Boolean(attempt.ownerBirth && currentBirth && !sameProcessBirthFingerprint(attempt.ownerBirth, currentBirth));
    }
    const verdict = await inspectProcessBirth(attempt.ownerPid, attempt.ownerBirth);
    return verdict === "gone" || verdict === "mismatch";
  }

  async function waitForOperationAttempt(
    runId: string,
    effectKey: string,
    attempt: OperationAttempt,
  ): Promise<{ record: OperationRecord; ownerDead: boolean }> {
    let current = (await readOperation(runId, effectKey))!;
    while (current.operationAttempt?.attemptId === attempt.attemptId) {
      if (await operationAttemptOwnerDead(attempt)) return { record: current, ownerDead: true };
      await pause(25);
      current = (await readOperation(runId, effectKey))!;
    }
    return { record: current, ownerDead: false };
  }

  const respond = (requestId: JsonValue, record: OperationRecord, outcome: "created" | "replayed"): JsonObject => ({
    protocolVersion,
    requestId: String(requestId ?? ""),
    receipt: { ...record.receipt, outcome },
    result: (record.result ?? {}) as JsonValue,
  });

  const respondError = (requestId: JsonValue, error: unknown): JsonObject =>
    ({ protocolVersion, requestId: String(requestId ?? ""), error: toWireError(error) as unknown as JsonValue }) as JsonObject;

  type PreparedOperation = {
    validated: ValidatedOperationEnvelope;
    reservation: RunReservation;
    state: string;
  };

  async function prepare(request: JsonValue, bodySchema: string, method: OperationMethod): Promise<PreparedOperation> {
    const binding = await deps.binding();
    const validated = validateOperationEnvelope(request, {
      validator: deps.validator,
      binding,
      protocolVersion,
      bodySchema,
      method,
      ...(deps.verifySignature ? { verifySignature: deps.verifySignature } : {}),
    });
    const loaded = await readReservation(validated.runId);
    if (!loaded) throw executionError("RUN_UNKNOWN", `runId ${validated.runId} names no Run reserved on this node`);
    assertRunBinding(loaded, validated.authority);
    const settled = await deps.settle(loaded);
    await reconcileOperations(validated.runId);
    return { validated, reservation: settled.reservation, state: settled.state };
  }

  const driverIdOf = (reservation: RunReservation): string =>
    String((reservation.intent.harness as JsonObject | undefined)?.driverId ?? "");

  /**
   * True when the durable session evidence proves (or at least does not
   * contradict) that the bee bound to this reservation is THIS Run's harness.
   * The bee name is derived from the runId, so a session stamped with a
   * different executionRunId is an imposter/mismatch — never touch it.
   */
  async function sessionIsOurs(reservation: RunReservation): Promise<boolean> {
    const evidence = await deps.sessions.evidence(reservation.beeName);
    if (!evidence.sessionExists) return false;
    return evidence.stampedRunId === undefined || evidence.stampedRunId === reservation.runId;
  }

  /* -------------------------------------------------------------- */
  /* Crash-window reconciliation                                     */
  /* -------------------------------------------------------------- */

  async function reconcileOperations(runId: string): Promise<void> {
    const records = await listOperations(runId);
    if (records.length === 0) return;
    const reservation = await readReservation(runId);
    const driverId = reservation ? driverIdOf(reservation) : undefined;
    for (const record of records) {
      if (record.method === "run.command" && record.commandState === "dispatching" && !inFlight.has(flightKey(runId, record.effectKey))) {
        // A different service/process cannot use its empty local inFlight map
        // as crash evidence. A durable owner with a live birth identity still
        // owns the delivery; peers join it. Only a missing legacy owner or a
        // proven-dead generation closes the ambiguous window as indeterminate.
        if (record.operationAttempt && !(await operationAttemptOwnerDead(record.operationAttempt))) continue;
        const cause = "coordinator crashed during a non-deduplicating delivery window; not redelivered";
        const expectedAttemptId = record.operationAttempt?.attemptId;
        const reconciled = await setOperationResult(
          runId,
          record.effectKey,
          { commandState: "indeterminate", cause },
          { commandState: "indeterminate", cause, operationAttempt: undefined },
          (current) =>
            current.commandState === "dispatching" &&
            (expectedAttemptId === undefined
              ? current.operationAttempt === undefined
              : current.operationAttempt?.attemptId === expectedAttemptId),
        );
        if (reconciled.commandState !== "indeterminate") continue;
        await appendRunEvents(
          runId,
          protocolVersion,
          [{ type: "command.indeterminate", payload: { effectKey: record.effectKey, cause }, origin: await deps.origin() }],
          { onlyIfAbsentKeys: true },
        );
        continue;
      }
      // Self-heal missing per-effect lifecycle events: a crash can land
      // between a durable state write and its event append, and replays skip
      // side effects — re-derive them idempotently (keyed, never type-only).
      const state = record.commandState;
      if (record.method === "run.command" && (state === "completed" || state === "failed" || state === "indeterminate")) {
        await appendRunEvents(
          runId,
          protocolVersion,
          [
            { type: "command.accepted", payload: { effectKey: record.effectKey, ...(record.commandKind ? { kind: record.commandKind } : {}) }, origin: await deps.origin() },
            { type: "command.dispatching", payload: { effectKey: record.effectKey }, origin: await deps.origin(driverId ? { driverId } : {}) },
            {
              type: `command.${state}`,
              payload: { effectKey: record.effectKey, ...(record.cause ? { cause: record.cause } : {}) },
              origin: await deps.origin(driverId ? { driverId } : {}),
            },
          ],
          { onlyIfAbsentKeys: true },
        );
      } else if (record.method === "run.collect" && record.collectionState === "complete" && record.collectionId) {
        await appendRunEvents(
          runId,
          protocolVersion,
          [{ type: "collection.completed", payload: { collectionId: record.collectionId }, origin: await deps.origin() }],
          { onlyIfAbsentKeys: true },
        );
      } else if (
        record.method === "run.release" &&
        (record.releaseSteps ?? []).some((entry) => entry.status === "pending") &&
        !inFlight.has(flightKey(runId, record.effectKey))
      ) {
        // A fenced/interrupted release is DESIRED STATE: reconciliation
        // continues it once the blocking condition (e.g. an in-flight launch)
        // resolves — best-effort here; the RPC retry surfaces errors.
        await progressRelease(runId, record.effectKey).catch(() => undefined);
      } else if (record.method === "run.cancel" && reservation?.cancel) {
        await appendRunEvents(
          runId,
          protocolVersion,
          [{ type: "cancel.requested", payload: { effectKey: record.effectKey }, origin: await deps.origin() }],
          { onlyIfAbsentKeys: true },
        );
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* run.command                                                     */
  /* -------------------------------------------------------------- */

  async function dispatchCommand(
    validated: ValidatedOperationEnvelope,
    reservation: RunReservation,
    command: JsonObject,
  ): Promise<OperationRecord> {
    const { runId, effectKey } = validated;
    const kind = String(command.kind);
    const driverId = driverIdOf(reservation);
    const attempt = async (): Promise<OperationRecord> => {
      await appendRunEvents(
        runId,
        protocolVersion,
        [{ type: "command.accepted", payload: { effectKey, kind }, origin: await deps.origin() }],
        { onlyIfAbsentKeys: true },
      );
      // Atomically CLAIM the dispatch under the admission lock: `dispatching`
      // is durably recorded BEFORE the driver call (RFC §10.6), and only the
      // claimer proceeds — a concurrent coordinator (even another process)
      // that lost the claim must not dispatch a second delivery.
      let claimed = false;
      let cancelledBeforeDelivery = false;
      const dispatchAttempt = await newOperationAttempt("command-dispatch");
      let record = await mutateOperation(runId, effectKey, async (current) => {
        if (current.commandState !== "accepted") return current;
        // Admission guards apply only when a record is first created. An
        // already-admitted `accepted` effect (including a restart replay) can
        // reach this claim after cancellation/terminalization, so bind the
        // accepted -> dispatching decision to the same global serialization
        // boundary as those reservation mutations. If cleanup won, settle a
        // durable failed command atomically and NEVER enter the driver window.
        const fresh = await readReservation(runId);
        if (!fresh) {
          throw executionError("RUN_UNKNOWN", `runId ${runId} names no Run reserved on this node`);
        }
        if (fresh.cancel || fresh.result) {
          cancelledBeforeDelivery = true;
          const cause = fresh.result
            ? `run became ${fresh.result.outcome} before command delivery; nothing was delivered`
            : "run acquired a durable cancellation intent before command delivery; nothing was delivered";
          return {
            ...current,
            commandState: "failed",
            cause,
            result: { commandState: "failed", cause },
            operationAttempt: undefined,
          };
        }
        claimed = true;
        return { ...current, commandState: "dispatching", operationAttempt: dispatchAttempt };
      });
      if (!claimed) {
        if (cancelledBeforeDelivery) {
          // `dispatching` here records the serialized claim attempt, not a
          // driver delivery. Keeping the corpus lifecycle complete also lets
          // restart reconciliation self-heal this exact event sequence.
          await appendRunEvents(
            runId,
            protocolVersion,
            [
              { type: "command.dispatching", payload: { effectKey }, origin: await deps.origin({ driverId }) },
              { type: "command.failed", payload: { effectKey, cause: record.cause! }, origin: await deps.origin({ driverId }) },
            ],
            { onlyIfAbsentKeys: true },
          );
        } else if (record.commandState === "dispatching" && record.operationAttempt) {
          // Another live coordinator owns this exact delivery window. Join its
          // durable attempt instead of declaring it crashed from this service's
          // empty local inFlight map. A proven-dead owner reconciles to
          // indeterminate and is never allowed to redeliver.
          const joined = await waitForOperationAttempt(runId, effectKey, record.operationAttempt);
          record = joined.record;
          if (joined.ownerDead && record.commandState === "dispatching") {
            await reconcileOperations(runId);
            record = (await readOperation(runId, effectKey)) ?? record;
          }
        }
        return record;
      }
      await appendRunEvents(
        runId,
        protocolVersion,
        [{ type: "command.dispatching", payload: { effectKey }, origin: await deps.origin({ driverId }) }],
        { onlyIfAbsentKeys: true },
      );
      let outcome: "completed" | "failed" | "indeterminate" = "completed";
      let cause: string | undefined;
      if (!(await sessionIsOurs(reservation))) {
        outcome = "failed";
        cause = "bound harness session is absent or belongs to a different run; nothing was delivered";
      } else {
        try {
          if (kind === "send") {
            await deps.control.send(reservation.beeName, String(command.text), record.deliveryId ?? effectKeyHash(effectKey));
          } else if (kind === "interrupt") {
            await deps.control.interrupt(reservation.beeName, typeof command.reason === "string" ? command.reason : undefined);
          } else if (kind === "answer") {
            await deps.control.answer(reservation.beeName, String(command.inputRequestId), command.answer as JsonValue);
          } else {
            outcome = "failed";
            cause = `command kind ${kind} has no dispatch path`;
          }
        } catch (error) {
          if (error instanceof HarnessDispatchError) {
            outcome = error.outcome;
            cause = error.message;
          } else {
            outcome = "indeterminate";
            cause = `dispatch failed unclassifiably: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }
      record = await setOperationResult(
        runId,
        effectKey,
        { commandState: outcome, ...(cause ? { cause } : {}) },
        { commandState: outcome, ...(cause ? { cause } : {}), operationAttempt: undefined },
      );
      const events = [
        { type: `command.${outcome}`, payload: { effectKey, ...(cause ? { cause } : {}) } as JsonValue, origin: await deps.origin({ driverId }) },
      ];
      if (outcome === "completed" && kind === "answer") {
        events.push({
          type: "needs_input.resolved",
          payload: { inputRequestId: String(command.inputRequestId) } as JsonValue,
          origin: await deps.origin({ driverId }),
        });
      }
      await appendRunEvents(runId, protocolVersion, events, { onlyIfAbsentKeys: true });
      return record;
    };
    return singleFlight(flightKey(runId, effectKey), attempt);
  }

  async function runCommand(request: JsonValue): Promise<JsonObject> {
    const requestId = (request as JsonObject | null)?.requestId ?? "";
    try {
      const { validated, reservation, state } = await prepare(request, "run-command-body", "run.command");
      const command = asObject(validated.body.command) ?? {};
      const kind = String(command.kind ?? "");
      const { record, created } = await admitOperation({
        runId: validated.runId,
        method: "run.command",
        effectKey: validated.effectKey,
        requestDigest: validated.requestDigest,
        protocolVersion,
        schemaDigest,
        init: {
          commandKind: kind,
          commandState: "accepted",
          deliveryId: `op-${effectKeyHash(validated.effectKey).slice(0, 16)}`,
        },
        guard: async () => {
          if (kind === "refresh-credential") {
            throw executionError("SCHEMA_UNSUPPORTED", "refresh-credential requires the credential-lease-v1 profile, which is not negotiated");
          }
          if (kind === "checkpoint") {
            throw executionError("CAPABILITY_MISMATCH", `driver ${driverIdOf(reservation)} does not support checkpoint on this node`);
          }
          if (kind === "answer") {
            // needs_input.opened is not bridged into the protocol event
            // stream, so an open input request is unobservable from protocol
            // data: answer is not deliverable here (node.describe does not
            // advertise it). The legacy session/UI answer path is unaffected;
            // the dispatch machinery below stays for when the bridge lands.
            throw executionError(
              "CAPABILITY_MISMATCH",
              `driver ${driverIdOf(reservation)} does not deliver answer on this node yet (needs_input.opened is not bridged)`,
            );
          }
          assertLeaseNotExpired(reservation, now());
          if (TERMINAL_RUN_STATES.has(state) || state === "lost") {
            throw executionError("RUN_VERSION_CONFLICT", `run ${validated.runId} is ${state}; steering commands cannot apply`);
          }
          if (state !== "running") {
            throw executionError("HARNESS_UNAVAILABLE", `run ${validated.runId} harness is not running yet (state ${state})`);
          }
          // Preconditions above were settled BEFORE the admission lock; a
          // concurrent cancel/terminal transition can land in that window.
          // Re-read the durable reservation UNDER the lock so a run that is
          // cancelling or already finished can never admit new steering.
          const fresh = await readReservation(validated.runId);
          if (!fresh) {
            throw executionError("RUN_UNKNOWN", `runId ${validated.runId} names no Run reserved on this node`);
          }
          if (fresh.cancel || fresh.result) {
            const why = fresh.result ? `is ${fresh.result.outcome}` : "has a durable cancellation intent";
            throw executionError("RUN_VERSION_CONFLICT", `run ${validated.runId} ${why}; steering commands cannot apply`);
          }
          const expected = validated.body.ifStateVersion;
          if (expected !== undefined) {
            // Recomputed under the lock for the same reason.
            const stateVersion = await lastEventSeq(validated.runId);
            if (expected !== stateVersion) {
              throw executionError("RUN_VERSION_CONFLICT", `ifStateVersion ${String(expected)} is stale (current ${stateVersion})`, {
                expected: expected as JsonValue,
                current: stateVersion,
              });
            }
          }
        },
      });
      let current = record;
      if (created || current.commandState === "accepted") {
        // New effect, or an admitted effect whose dispatch never began
        // (crash between admission and `dispatching`): safe to continue.
        // Concurrent identical replays join the same single-flight attempt.
        current = await dispatchCommand(validated, reservation, command);
      } else if (current.commandState === "dispatching") {
        const pending = inFlight.get(flightKey(validated.runId, validated.effectKey)) as Promise<OperationRecord> | undefined;
        if (pending) {
          current = await pending;
        } else if (current.operationAttempt) {
          const joined = await waitForOperationAttempt(validated.runId, validated.effectKey, current.operationAttempt);
          current = joined.record;
          if (joined.ownerDead && current.commandState === "dispatching") {
            await reconcileOperations(validated.runId);
            current = (await readOperation(validated.runId, validated.effectKey)) ?? current;
          }
        } else {
          await reconcileOperations(validated.runId);
          current = (await readOperation(validated.runId, validated.effectKey)) ?? current;
        }
      }
      return respond(requestId, current, created ? "created" : "replayed");
    } catch (error) {
      return respondError(requestId, error);
    }
  }

  /* -------------------------------------------------------------- */
  /* run.cancel                                                      */
  /* -------------------------------------------------------------- */

  async function runCancel(request: JsonValue): Promise<JsonObject> {
    const requestId = (request as JsonObject | null)?.requestId ?? "";
    try {
      const prepared = await prepare(request, "run-cancel-body", "run.cancel");
      const { validated } = prepared;
      const reason = typeof validated.body.reason === "string" ? validated.body.reason : undefined;
      const { record, created } = await admitOperation({
        runId: validated.runId,
        method: "run.cancel",
        effectKey: validated.effectKey,
        requestDigest: validated.requestDigest,
        protocolVersion,
        schemaDigest,
      });
      // Desired-state progression runs on create AND on replay (retries
      // continue an unfinished cancellation instead of assuming it happened);
      // concurrent identical replays join one single-flight progression.
      const current = await singleFlight<OperationRecord>(flightKey(validated.runId, validated.effectKey), async () => {
        // Re-settle INSIDE the flight: a replay that entered after an earlier
        // progression finished must see the fresh run state, not the state
        // captured before admission (or it would stop/cancel a second time).
        const fresh = await readReservation(validated.runId);
        const settled = fresh ? await deps.settle(fresh) : { reservation: prepared.reservation, state: prepared.state };
        let reservation = settled.reservation;
        let state = settled.state;
        if (!TERMINAL_RUN_STATES.has(state)) {
          if (!isTransitionAllowed(deps.contract, "run", state, "cancelled")) {
            throw executionError("RUN_VERSION_CONFLICT", `run ${validated.runId} cannot be cancelled from state ${state}`);
          }
          reservation = await mutateReservation(validated.runId, (record) =>
            record.result || record.cancel
              ? record
              : { ...record, cancel: { requestedAt: now().toISOString(), ...(reason ? { reason } : {}) } },
          );
          if (reservation.result) {
            // A terminal decision won after the earlier settle but before the
            // cancellation-intent mutation. Never attach late cancel intent or
            // events to an immutable terminal result.
            state = reservation.result.outcome;
          } else {
            await appendRunEvents(
              validated.runId,
              protocolVersion,
              [{ type: "cancel.requested", payload: { effectKey: validated.effectKey, ...(reason ? { reason } : {}) }, origin: await deps.origin() }],
              { onlyIfAbsentKeys: true },
            );
          }
          if (!reservation.result && (state === "accepted" || state === "starting")) {
            // Launch may be in flight or sitting in an unresolved crash
            // window: cancellation stays a NONTERMINAL desired state here.
            // Terminal resolution belongs to reconciliation (which alone can
            // prove "reserved and never started") or to the launch path's
            // post-cancel sweep (which alone can confirm a stop) — never to
            // this call, or run.cancelled could precede a live harness.
            const resettled = await deps.settle(reservation);
            reservation = resettled.reservation;
            state = resettled.state;
          } else if (!reservation.result) {
            // running (or lost): stop only the session provably bound to THIS
            // run, only over its control socket — never a kill -9.
            let stopConfirmed = true;
            let stopDetail: string | undefined;
            if (await sessionIsOurs(reservation)) {
              const stop = await deps.control.stop(reservation.beeName);
              stopDetail = stop.detail;
              stopConfirmed = stop.stopped;
            }
            if (!stopConfirmed) {
              // The owned harness may still be alive: never project terminal
              // `cancelled` over it — the run is honestly lost until a retry
              // confirms the stop or the session outcome proves exit.
              reservation = await mutateReservation(validated.runId, (record) =>
                record.result ? record : enterLossEpisode(record, "cancel_stop_unconfirmed", now().toISOString()),
              );
              if (reservation.result) {
                state = reservation.result.outcome;
              } else {
                await appendRunEvents(
                  validated.runId,
                  protocolVersion,
                  [
                    {
                      type: "run.lost",
                      payload: lossEpisodePayload(reservation, { cause: "cancel_stop_unconfirmed", ...(stopDetail ? { detail: stopDetail } : {}) }),
                      origin: await deps.origin(),
                    },
                  ],
                  { onlyIfAbsentKeys: true },
                );
                state = "lost";
              }
            } else {
              if (reservation.indeterminateCause === "cancel_stop_unconfirmed") {
                await appendRunEvents(
                  validated.runId,
                  protocolVersion,
                  [{
                    type: "run.recovering",
                    payload: lossEpisodePayload(reservation, { cause: "cancel_stop_unconfirmed", verified: ["run-identity", "process-stop"] }),
                    origin: await deps.origin(),
                  }],
                  { onlyIfAbsentKeys: true },
                );
              }
              reservation = await commitRunTerminalResult(
                validated.runId,
                { outcome: "cancelled", cause: reason ?? "cancel_requested" },
                { now, clearIndeterminate: true },
              );
              await appendRunTerminalEvents(reservation, protocolVersion, await deps.origin());
              state = reservation.result?.outcome ?? "cancelled";
            }
          }
        }
        return setOperationResult(validated.runId, validated.effectKey, { runId: validated.runId, state });
      });
      return respond(requestId, current, created ? "created" : "replayed");
    } catch (error) {
      return respondError(requestId, error);
    }
  }

  /* -------------------------------------------------------------- */
  /* run.collect                                                     */
  /* -------------------------------------------------------------- */

  type ManifestEntry = {
    kind: string;
    digest: string;
    sizeBytes: number;
    mediaType: string;
    ref: { kind: "node-local"; nodeId: string; token: string };
  };

  async function buildEnvironmentManifest(reservation: RunReservation): Promise<JsonObject> {
    // Wire-visible node identity is always the canonical bound Apiary nodeId,
    // never the Honeybee-minted signing identity (key custody only).
    const nodeId = (await deps.binding()).nodeId;
    const harness = asObject(reservation.intent.harness);
    // Composed ONLY from admitted protocol facts + static platform identity —
    // never process environment variables, credentials, or machine paths.
    return {
      runId: reservation.runId,
      nodeId,
      platform: { os: osPlatform(), arch: osArch(), version: osRelease() },
      protocol: { version: protocolVersion, schemaDigest },
      harness: { driverId: driverIdOf(reservation), ...(typeof harness?.model === "string" ? { model: harness.model } : {}) },
      ...(reservation.environment
        ? {
            providerId: reservation.environment.providerId,
            environmentId: reservation.environment.environmentId,
            isolation: reservation.environment.isolation as JsonValue,
            ...(reservation.environment.workingCopy ? { workingCopy: reservation.environment.workingCopy as JsonValue } : {}),
          }
        : {}),
      generatedAt: now().toISOString(),
    };
  }

  function workingCopyIdOf(reservation: RunReservation): string | undefined {
    const fromEnvironment = asObject(reservation.environment?.workingCopy as JsonValue | undefined)?.workingCopyId;
    if (typeof fromEnvironment === "string") return fromEnvironment;
    const placement = asObject(reservation.intent.placement);
    return placement?.kind === "explicit" && typeof placement.workingCopyId === "string" ? placement.workingCopyId : undefined;
  }

  async function collectEntries(reservation: RunReservation, ownedWorkingCopy: WorkingCopyRecord | null): Promise<ManifestEntry[]> {
    const nodeId = (await deps.binding()).nodeId;
    const requested = new Set(
      (Array.isArray(asObject(reservation.intent.evidenceContract)?.collect)
        ? (asObject(reservation.intent.evidenceContract)!.collect as JsonValue[])
        : []
      ).filter((entry): entry is string => typeof entry === "string"),
    );
    const entries: ManifestEntry[] = [];
    const push = (kind: string, stored: { digest: string; sizeBytes: number; token: string }, mediaType: string): void => {
      entries.push({ kind, digest: stored.digest, sizeBytes: stored.sizeBytes, mediaType, ref: { kind: "node-local", nodeId, token: stored.token } });
    };
    if (requested.has("logs")) {
      const bytes = await readRunLogBytes(reservation.runId);
      if (bytes) push("log", await putEvidence(reservation.runId, bytes), "application/x-ndjson");
    }
    if (requested.has("transcript")) {
      const bytes = await readTranscriptBytes(reservation.beeName);
      if (bytes) push("transcript", await putEvidence(reservation.runId, bytes), "application/x-ndjson");
    }
    if (requested.has("diff")) {
      if (ownedWorkingCopy) {
        const metadata = await collectWorkingCopyDiff(ownedWorkingCopy, now().toISOString());
        push("diff", await putEvidence(reservation.runId, JSON.stringify(metadata, null, 2)), "application/json");
      }
    }
    if (requested.has("environment-manifest")) {
      const manifest = await buildEnvironmentManifest(reservation);
      push("environment-manifest", await putEvidence(reservation.runId, JSON.stringify(manifest, null, 2)), "application/json");
    }
    return entries;
  }

  /** Evidence kinds run.collect can actually produce in this slice. */
  const COLLECTABLE_KINDS = new Set(["logs", "diff", "environment-manifest", "transcript"]);

  function requestedEvidenceKinds(reservation: RunReservation): string[] {
    const collect = asObject(reservation.intent.evidenceContract)?.collect;
    return (Array.isArray(collect) ? collect : []).filter((entry): entry is string => typeof entry === "string");
  }

  /**
   * Hold one occupancy generation stable for the entire collection transaction.
   * Revalidation occurs after acquisition; release and a successor claim cannot
   * pass until all filesystem reads, evidence writes, and the durable manifest
   * receipt have completed.
   */
  async function withCollectionOccupancy<T>(
    reservation: RunReservation,
    collect: (ownedWorkingCopy: WorkingCopyRecord | null) => Promise<T>,
  ): Promise<T> {
    const workingCopyId = workingCopyIdOf(reservation);
    if (!workingCopyId || !requestedEvidenceKinds(reservation).includes("diff")) return collect(null);
    return withWorkingCopyOccupancyLock(workingCopyId, async () => {
      const copy = await readWorkingCopy(workingCopyId);
      return collect(copy?.occupancy?.claimedByRunId === reservation.runId ? copy : null);
    });
  }

  async function tryClaimCollectionAttempt(
    runId: string,
    effectKey: string,
  ): Promise<{ record: OperationRecord; claimed: boolean }> {
    const observed = await readOperation(runId, effectKey);
    if (!observed) throw executionError("AUTHORITY_UNAVAILABLE", `collection effect ${effectKey} has no durable record`);
    const observedAttempt = observed.operationAttempt;
    const observedOwnerDead = observedAttempt ? await operationAttemptOwnerDead(observedAttempt) : false;
    const candidate = await newOperationAttempt("collection");
    let claimed = false;
    const record = await mutateOperation(runId, effectKey, (current) => {
      if (
        current.collectionState === "complete" ||
        (current.collectionState === "failed" && current.collectionFailure !== "retryable")
      ) return current;

      if (observedAttempt && !observedOwnerDead) return current;
      if (current.operationAttempt) {
        // Take over only the exact generation proven dead outside the lock. A
        // changed owner is a new live fact and must be joined separately.
        if (!observedAttempt || current.operationAttempt.attemptId !== observedAttempt.attemptId) return current;
      } else if (observedAttempt) {
        // The observed owner settled while its liveness was inspected. Replay
        // that settlement rather than immediately turning its retryable failure
        // into another concurrent attempt.
        return current;
      }
      if (current.collectionState !== "collecting" && current.collectionFailure !== "retryable") return current;
      claimed = true;
      return {
        ...current,
        collectionState: "collecting",
        collectionFailure: undefined,
        cause: undefined,
        operationAttempt: candidate,
      };
    });
    return { record, claimed };
  }

  async function runCollect(request: JsonValue): Promise<JsonObject> {
    const requestId = (request as JsonObject | null)?.requestId ?? "";
    try {
      const prepared = await prepare(request, "run-collect-body", "run.collect");
      const { validated, reservation } = prepared;
      const { record, created } = await admitOperation({
        runId: validated.runId,
        method: "run.collect",
        effectKey: validated.effectKey,
        requestDigest: validated.requestDigest,
        protocolVersion,
        schemaDigest,
        init: { collectionId: `coll-${effectKeyHash(validated.effectKey).slice(0, 12)}`, collectionState: "collecting" },
      });
      if (record.collectionState === "complete" || (record.collectionState === "failed" && record.collectionFailure !== "retryable")) {
        // Complete and unsupported/unrecoverable failures replay byte-stable.
        // Legacy failed records have no recovery classification and therefore
        // remain terminal/fail-closed rather than being re-executed blindly.
        return respond(requestId, record, "replayed");
      }
      // Local callers join the in-memory flight; other service instances and
      // processes join the durable operation attempt below.
      const current = await singleFlight<OperationRecord>(flightKey(validated.runId, validated.effectKey), async () => {
        while (true) {
          const claim = await tryClaimCollectionAttempt(validated.runId, validated.effectKey);
          if (!claim.claimed) {
            if (claim.record.operationAttempt) {
              const joined = await waitForOperationAttempt(validated.runId, validated.effectKey, claim.record.operationAttempt);
              if (joined.ownerDead || joined.record.operationAttempt) continue;
              return joined.record;
            }
            if (claim.record.collectionState === "collecting") continue;
            return claim.record;
          }
          const ownedAttemptId = claim.record.operationAttempt!.attemptId;
          try {
            return await withCollectionOccupancy(reservation, async (ownedWorkingCopy) => {
              const entries = await collectEntries(reservation, ownedWorkingCopy);
              const unsupported = requestedEvidenceKinds(reservation).filter((kind) => !COLLECTABLE_KINDS.has(kind));
              if (unsupported.length > 0) {
                // The evidence contract asked for kinds this node cannot collect
                // (commands/tests/media): a "complete" manifest would silently
                // pretend coverage. Return a typed PARTIAL failure carrying what
                // WAS collected, with the gap recorded durably.
                const cause = `requested evidence kinds are not collectable on this node: ${unsupported.join(", ")}`;
                const manifest: JsonObject = {
                  runId: validated.runId,
                  collectionId: claim.record.collectionId!,
                  state: "failed",
                  entries: entries as unknown as JsonValue,
                  createdAt: claim.record.createdAt,
                };
                return setOperationResult(
                  validated.runId,
                  validated.effectKey,
                  manifest,
                  {
                    collectionState: "failed",
                    collectionFailure: "unrecoverable",
                    manifest,
                    cause,
                    operationAttempt: undefined,
                  },
                  (op) => op.operationAttempt?.attemptId === ownedAttemptId,
                );
              }
              const manifest: JsonObject = {
                runId: validated.runId,
                collectionId: claim.record.collectionId!,
                state: "complete",
                entries: entries as unknown as JsonValue,
                createdAt: claim.record.createdAt,
                completedAt: now().toISOString(),
              };
              const updated = await setOperationResult(
                validated.runId,
                validated.effectKey,
                manifest,
                {
                  collectionState: "complete",
                  collectionFailure: undefined,
                  manifest,
                  cause: undefined,
                  operationAttempt: undefined,
                },
                (op) => op.operationAttempt?.attemptId === ownedAttemptId,
              );
              if (updated.collectionState === "complete") {
                await appendRunEvents(
                  validated.runId,
                  protocolVersion,
                  [{ type: "collection.completed", payload: { collectionId: claim.record.collectionId! }, origin: await deps.origin() }],
                  { onlyIfAbsentKeys: true },
                );
              }
              return updated;
            });
          } catch (error) {
            const cause = error instanceof Error ? error.message : String(error);
            // The corpus error registry is the cross-repo retryability contract:
            // known non-retryable protocol failures stay terminal, while raw
            // coordinator/I/O faults map to retryable AUTHORITY_UNAVAILABLE.
            const collectionFailure = toWireError(error).retryable ? "retryable" : "unrecoverable";
            const manifest: JsonObject = {
              runId: validated.runId,
              collectionId: claim.record.collectionId!,
              state: "failed",
              entries: [] as JsonValue,
              createdAt: claim.record.createdAt,
            };
            return setOperationResult(
              validated.runId,
              validated.effectKey,
              manifest,
              {
                collectionState: "failed",
                collectionFailure,
                manifest,
                cause,
                operationAttempt: undefined,
              },
              (op) => op.operationAttempt?.attemptId === ownedAttemptId,
            );
          }
        }
      });
      return respond(requestId, current, created ? "created" : "replayed");
    } catch (error) {
      return respondError(requestId, error);
    }
  }

  /* -------------------------------------------------------------- */
  /* run.retain                                                      */
  /* -------------------------------------------------------------- */

  async function runRetain(request: JsonValue): Promise<JsonObject> {
    const requestId = (request as JsonObject | null)?.requestId ?? "";
    try {
      const prepared = await prepare(request, "run-retain-body", "run.retain");
      const { validated } = prepared;
      const retainUntil = String(validated.body.retainUntil);
      const retentionEffectId = effectKeyHash(validated.effectKey);
      const { record, created } = await admitOperation({
        runId: validated.runId,
        method: "run.retain",
        effectKey: validated.effectKey,
        requestDigest: validated.requestDigest,
        protocolVersion,
        schemaDigest,
        init: { retainUntil },
        guard: async () => {
          // `prepare` precedes the admission lock. Re-read under that lock so
          // a release that already won cannot leave behind a newly admitted
          // retain effect; the post-admission mutation repeats this check for
          // the remaining admitted-retain -> release window.
          const fresh = await readReservation(validated.runId);
          if (!fresh) {
            throw executionError("RUN_UNKNOWN", `runId ${validated.runId} names no Run reserved on this node`);
          }
          if (fresh.releasedAt) {
            throw executionError("RUN_VERSION_CONFLICT", `run ${validated.runId} environment is already released; nothing to retain`);
          }
        },
      });
      if (!created && record.result) return respond(requestId, record, "replayed");
      // Retention only ever EXTENDS the debug window (never shrinks another
      // effect's extension) and never extends execution/credential authority.
      // Record per-effect provenance in the SAME reservation mutation so a
      // replay can prove whether retain or release won even if the coordinator
      // crashed before writing the operation result.
      const reservation = await mutateReservation(validated.runId, (current) => {
        if (current.retentionEffects?.[retentionEffectId]) return current;
        if (current.releasedAt) return current;
        const existing = current.retainUntil ? Date.parse(current.retainUntil) : Number.NEGATIVE_INFINITY;
        const requested = Date.parse(retainUntil);
        const settledUntil = requested > existing ? retainUntil : current.retainUntil ?? retainUntil;
        return {
          ...current,
          retainUntil: settledUntil,
          retentionEffects: {
            ...(current.retentionEffects ?? {}),
            [retentionEffectId]: { retainUntil: settledUntil, persistedAt: now().toISOString() },
          },
        };
      });
      const persisted = reservation.retentionEffects?.[retentionEffectId];
      if (!persisted) {
        throw executionError("RUN_VERSION_CONFLICT", `run ${validated.runId} environment was released before this retain could persist`);
      }
      const current = await setOperationResult(validated.runId, validated.effectKey, {
        runId: validated.runId,
        retainedUntil: persisted.retainUntil,
      });
      return respond(requestId, current, created ? "created" : "replayed");
    } catch (error) {
      return respondError(requestId, error);
    }
  }

  /* -------------------------------------------------------------- */
  /* run.release                                                     */
  /* -------------------------------------------------------------- */

  const RELEASE_STEP_ORDER: ReleaseStepId[] = ["harness-stop", "occupancy-release", "environment-seal", "environment-release"];

  async function completeStep(
    runId: string,
    effectKey: string,
    step: ReleaseStepId,
    status: "completed" | "unrecoverable",
    detail: string,
  ): Promise<OperationRecord> {
    return mutateOperation(runId, effectKey, (record) => ({
      ...record,
      releaseSteps: (record.releaseSteps ?? []).map((entry) =>
        entry.step === step ? { ...entry, status, detail, completedAt: now().toISOString() } : entry,
      ),
    }));
  }

  /**
   * Progress a release effect's durable step ledger (single-flighted).
   * Callable from the RPC retry AND from read-side reconciliation, so a
   * fenced release continues once a delayed launch resolves — not only
   * when the exact release RPC is retried.
   */
  async function progressRelease(runId: string, effectKey: string): Promise<OperationRecord> {
    return singleFlight<OperationRecord>(flightKey(runId, effectKey), async () => {
        // Fresh record + reservation inside the flight: a replay entering
        // after an earlier pass must continue the CURRENT ledger, not a
        // pre-admission snapshot.
        let current = await readOperation(runId, effectKey);
        if (!current) throw executionError("AUTHORITY_UNAVAILABLE", `release effect ${effectKey} has no durable record`);
        let reservation = await readReservation(runId);
        if (!reservation) throw executionError("RUN_UNKNOWN", `runId ${runId} names no Run reserved on this node`);
        // Cleanup FENCE: occupancy release and environment seal/release may
        // only run once the owned harness is provably down. An unconfirmed
        // stop must not free a working copy a live harness may still be
        // mutating — the pass stops here and a retry reconciles.
        let fenced = false;
        for (const stepId of RELEASE_STEP_ORDER) {
          const step = (current.releaseSteps ?? []).find((entry) => entry.step === stepId);
          if (!step || step.status !== "pending") continue;
          if (stepId === "harness-stop") {
            const annotatePending = async (detail: string): Promise<void> => {
              current = await mutateOperation(runId, effectKey, (op) => ({
                ...op,
                releaseSteps: (op.releaseSteps ?? []).map((entry) =>
                  entry.step === stepId ? { ...entry, detail: `${detail}; retry continues this step` } : entry,
                ),
              }));
              fenced = true;
            };
            // Fresh state each pass: release may race an in-flight launch.
            let settled = await deps.settle(reservation);
            reservation = settled.reservation;
            if (!TERMINAL_RUN_STATES.has(settled.state)) {
              // The run must end: persist cancellation desired state FIRST so
              // the launch path's post-cancel sweep stops any session that
              // binds mid-release, then re-settle (reconciliation resolves a
              // provably-never-started reservation to cancelled).
              reservation = await mutateReservation(runId, (record) =>
                record.result || record.cancel
                  ? record
                  : { ...record, cancel: { requestedAt: now().toISOString(), reason: "released" } },
              );
              if (settled.state === "accepted" || settled.state === "starting") {
                // Only unresolved launch states need another lifecycle fold.
                // For running/lost runs this release effect owns the one stop
                // attempt below; asking the general reconciler first would
                // duplicate delivery and obscure which proof fenced cleanup.
                settled = await deps.settle(reservation);
                reservation = settled.reservation;
              }
            }
            const terminal = TERMINAL_RUN_STATES.has(settled.state);
            const ours = await sessionIsOurs(reservation);
            // A durable cancelled result is produced only by the lifecycle
            // reconciler after a confirmed stop (or proof the Run never
            // started). Preserve that proof so release after run.cancel does
            // not deliver a duplicate stop. completed/failed results do not
            // carry this liveness guarantee and must still probe an owned host.
            const stopAlreadyProven = terminal && reservation.result?.outcome === "cancelled";
            if (!terminal && (settled.state === "accepted" || settled.state === "starting") && !ours) {
              // A launch may still be CREATING the process: "no live harness"
              // would be a guess, and releasing occupancy under a nascent
              // harness could free a tree it is about to mutate.
              await annotatePending("launch unresolved and no provable session yet");
              break;
            }
            let detail = stopAlreadyProven
              ? "run cancellation already proved the harness down"
              : terminal
                ? "run terminal; no owned harness remains"
                : "no live harness";
            let stopConfirmed = true;
            if (ours && !stopAlreadyProven) {
              const stop = await deps.control.stop(reservation.beeName);
              detail = stop.detail;
              stopConfirmed = stop.stopped;
            }
            if (!stopConfirmed) {
              // A terminal computation result says nothing about whether the
              // owned process is actually down. Persist the keyed liveness-loss
              // episode even if a concurrent terminal decision already won,
              // and fence every destructive cleanup step until stop is proven.
              reservation = await mutateReservation(runId, (record) =>
                enterLossEpisode(record, "release_stop_unconfirmed", now().toISOString()),
              );
              await appendRunEvents(
                runId,
                protocolVersion,
                [{
                  type: "run.lost",
                  payload: lossEpisodePayload(reservation, { cause: "release_stop_unconfirmed", detail }),
                  origin: await deps.origin(),
                }],
                { onlyIfAbsentKeys: true },
              );
              await annotatePending(detail);
              break;
            }
            // Stop confirmed (or no session belonging to this Run remains):
            // resolve any earlier liveness doubt. The terminal helper preserves
            // an already-committed result while clearing only the loss episode.
            if (reservation.indeterminateCause === "release_stop_unconfirmed") {
              await appendRunEvents(
                runId,
                protocolVersion,
                [{
                  type: "run.recovering",
                  payload: lossEpisodePayload(reservation, { cause: "release_stop_unconfirmed", verified: ["run-identity", "process-stop"] }),
                  origin: await deps.origin(),
                }],
                { onlyIfAbsentKeys: true },
              );
            }
            reservation = await commitRunTerminalResult(
              runId,
              { outcome: "cancelled", cause: "released" },
              { now, clearIndeterminate: true },
            );
            await appendRunTerminalEvents(reservation, protocolVersion, await deps.origin());
            current = await completeStep(runId, effectKey, stepId, "completed", detail);
          } else if (stepId === "occupancy-release") {
            const workingCopyId = workingCopyIdOf(reservation);
            if (workingCopyId) {
              // Releases ONLY this Run's claim; a copy claimed by another Run is
              // untouched, and no working-copy files are ever deleted here.
              await releaseWorkingCopy(workingCopyId, runId);
              current = await completeStep(runId, effectKey, stepId, "completed", `released occupancy of ${workingCopyId}`);
            } else {
              current = await completeStep(runId, effectKey, stepId, "completed", "no working copy claimed");
            }
          } else if (stepId === "environment-seal") {
            if (reservation.environment && !reservation.sealedAt) {
              reservation = await mutateReservation(runId, (record) =>
                record.sealedAt ? record : { ...record, sealedAt: now().toISOString() },
              );
              await appendRunEvents(
                runId,
                protocolVersion,
                [
                  {
                    type: "environment.sealed",
                    payload: { environmentId: reservation.environment!.environmentId },
                    origin: await deps.origin({ providerId: reservation.environment!.providerId }),
                  },
                ],
                { onlyIfAbsentTypes: true },
              );
            }
            current = await completeStep(
              runId,
              effectKey,
              stepId,
              "completed",
              reservation.environment ? "environment sealed" : "no environment materialized",
            );
          } else {
            if (!reservation.releasedAt) {
              reservation = await mutateReservation(runId, (record) =>
                record.releasedAt ? record : { ...record, releasedAt: now().toISOString() },
              );
              if (reservation.environment) {
                await appendRunEvents(
                  runId,
                  protocolVersion,
                  [
                    {
                      type: "environment.released",
                      payload: { environmentId: reservation.environment.environmentId },
                      origin: await deps.origin({ providerId: reservation.environment.providerId }),
                    },
                  ],
                  { onlyIfAbsentTypes: true },
                );
              }
            }
            current = await completeStep(runId, effectKey, stepId, "completed", "environment released; evidence retained");
          }
        }
        const steps = current.releaseSteps ?? [];
        const completed = steps.filter((entry) => entry.status === "completed").length;
        const unrecoverable = steps.filter((entry) => entry.status === "unrecoverable").length;
        const pending = steps.filter((entry) => entry.status === "pending").length;
        if (fenced || pending > 0) {
          // Honest non-terminal cleanup receipt: the environment is NOT
          // released (occupancy retained, nothing sealed) and a retry of this
          // same effect continues from the first pending step.
          return setOperationResult(runId, effectKey, {
            environmentState: "releasing",
            steps: { completed, unrecoverable, pending },
            cause: "harness stop unconfirmed; cleanup fenced until a retry confirms the stop",
          });
        }
        return setOperationResult(runId, effectKey, {
          environmentState: "released",
          steps: { completed, unrecoverable },
        });
    });
  }

  async function runRelease(request: JsonValue): Promise<JsonObject> {
    const requestId = (request as JsonObject | null)?.requestId ?? "";
    try {
      const prepared = await prepare(request, "run-release-body", "run.release");
      const { validated } = prepared;
      const initialSteps: ReleaseStep[] = RELEASE_STEP_ORDER.map((step) => ({ step, status: "pending" }));
      const { created } = await admitOperation({
        runId: validated.runId,
        method: "run.release",
        effectKey: validated.effectKey,
        requestDigest: validated.requestDigest,
        protocolVersion,
        schemaDigest,
        init: { releaseSteps: initialSteps },
      });
      // Desired-state cleanup: every retry continues the durable step ledger
      // from its first pending step; completed steps are never repeated, and
      // concurrent identical replays join one single-flight pass.
      const finished = await progressRelease(validated.runId, validated.effectKey);
      return respond(requestId, finished, created ? "created" : "replayed");
    } catch (error) {
      return respondError(requestId, error);
    }
  }

  return { runCommand, runCancel, runCollect, runRetain, runRelease, reconcileOperations };
}
