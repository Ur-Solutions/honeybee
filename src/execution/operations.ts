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
  type OperationRecord,
  type ReleaseStep,
  type ReleaseStepId,
} from "./opsStore.js";
import {
  appendRunEvents,
  effectKeyHash,
  lastEventSeq,
  mutateReservation,
  readReservation,
  type RunReservation,
} from "./runStore.js";
import type { SignatureVerifier } from "./signing.js";
import { readWorkingCopy, releaseWorkingCopy } from "./workingCopies.js";
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
        // Durably `dispatching` with no live continuation: the coordinator
        // crashed inside the delivery window. Delivery cannot be proven either
        // way, so the outcome is honestly indeterminate — never a redelivery.
        const cause = "coordinator crashed during a non-deduplicating delivery window; not redelivered";
        await setOperationResult(runId, record.effectKey, { commandState: "indeterminate", cause }, { commandState: "indeterminate", cause });
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
      let record = await mutateOperation(runId, effectKey, (current) => {
        if (current.commandState !== "accepted") return current;
        claimed = true;
        return { ...current, commandState: "dispatching" };
      });
      if (!claimed) return record;
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
        { commandState: outcome, ...(cause ? { cause } : {}) },
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
            record.cancel ? record : { ...record, cancel: { requestedAt: now().toISOString(), ...(reason ? { reason } : {}) } },
          );
          await appendRunEvents(
            validated.runId,
            protocolVersion,
            [{ type: "cancel.requested", payload: { effectKey: validated.effectKey, ...(reason ? { reason } : {}) }, origin: await deps.origin() }],
            { onlyIfAbsentKeys: true },
          );
          if (state === "accepted" || state === "starting") {
            // Launch may be in flight or sitting in an unresolved crash
            // window: cancellation stays a NONTERMINAL desired state here.
            // Terminal resolution belongs to reconciliation (which alone can
            // prove "reserved and never started") or to the launch path's
            // post-cancel sweep (which alone can confirm a stop) — never to
            // this call, or run.cancelled could precede a live harness.
            const resettled = await deps.settle(reservation);
            reservation = resettled.reservation;
            state = resettled.state;
          } else {
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
                record.indeterminateAt ? record : { ...record, indeterminateAt: now().toISOString() },
              );
              await appendRunEvents(
                validated.runId,
                protocolVersion,
                [
                  {
                    type: "run.lost",
                    payload: { cause: "cancel_stop_unconfirmed", ...(stopDetail ? { detail: stopDetail } : {}) },
                    origin: await deps.origin(),
                  },
                ],
                { onlyIfAbsentTypes: true },
              );
              state = "lost";
            } else {
              reservation = await mutateReservation(validated.runId, (record) => {
                const { indeterminateAt: _resolved, ...rest } = record;
                return rest.result
                  ? (rest as RunReservation)
                  : {
                      ...(rest as RunReservation),
                      result: { outcome: "cancelled", cause: reason ?? "cancel_requested", finishedAt: now().toISOString() },
                    };
              });
              if (reservation.result?.outcome === "cancelled") {
                await appendRunEvents(
                  validated.runId,
                  protocolVersion,
                  [{ type: "run.cancelled", payload: { ...(reason ? { reason } : {}), ...(stopDetail ? { stop: stopDetail } : {}) }, origin: await deps.origin() }],
                  { onlyIfAbsentTypes: true },
                );
              }
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

  async function collectEntries(reservation: RunReservation): Promise<ManifestEntry[]> {
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
      const workingCopyId = workingCopyIdOf(reservation);
      const copy = workingCopyId ? await readWorkingCopy(workingCopyId) : null;
      // Diff evidence only while this Run still owns the copy: after release
      // (or under another Run's occupancy) the tree is no longer ours to read.
      if (copy && copy.occupancy?.claimedByRunId === reservation.runId) {
        const metadata = await collectGitDiffMetadata(copy, now().toISOString());
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
      if (record.collectionState === "complete" || record.collectionState === "failed") {
        // Completed collections replay byte-stable: the recorded manifest is
        // the effect's result, not a fresh snapshot under an old receipt.
        return respond(requestId, record, "replayed");
      }
      // Concurrent identical replays join one collection pass.
      const current = await singleFlight<OperationRecord>(flightKey(validated.runId, validated.effectKey), async () => {
        const latest = await readOperation(validated.runId, validated.effectKey);
        if (latest && (latest.collectionState === "complete" || latest.collectionState === "failed")) return latest;
        try {
          const entries = await collectEntries(reservation);
          const unsupported = requestedEvidenceKinds(reservation).filter((kind) => !COLLECTABLE_KINDS.has(kind));
          if (unsupported.length > 0) {
            // The evidence contract asked for kinds this node cannot collect
            // (commands/tests/media): a "complete" manifest would silently
            // pretend coverage. Return a typed PARTIAL failure carrying what
            // WAS collected, with the gap recorded durably.
            const cause = `requested evidence kinds are not collectable on this node: ${unsupported.join(", ")}`;
            const manifest: JsonObject = {
              runId: validated.runId,
              collectionId: record.collectionId!,
              state: "failed",
              entries: entries as unknown as JsonValue,
              createdAt: record.createdAt,
            };
            return setOperationResult(validated.runId, validated.effectKey, manifest, {
              collectionState: "failed",
              manifest,
              cause,
            });
          }
          const manifest: JsonObject = {
            runId: validated.runId,
            collectionId: record.collectionId!,
            state: "complete",
            entries: entries as unknown as JsonValue,
            createdAt: record.createdAt,
            completedAt: now().toISOString(),
          };
          const updated = await setOperationResult(validated.runId, validated.effectKey, manifest, {
            collectionState: "complete",
            manifest,
          });
          await appendRunEvents(
            validated.runId,
            protocolVersion,
            [{ type: "collection.completed", payload: { collectionId: record.collectionId! }, origin: await deps.origin() }],
            { onlyIfAbsentKeys: true },
          );
          return updated;
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error);
          const manifest: JsonObject = {
            runId: validated.runId,
            collectionId: record.collectionId!,
            state: "failed",
            entries: [] as JsonValue,
            createdAt: record.createdAt,
          };
          return setOperationResult(validated.runId, validated.effectKey, manifest, {
            collectionState: "failed",
            manifest,
            cause,
          });
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
      const { record, created } = await admitOperation({
        runId: validated.runId,
        method: "run.retain",
        effectKey: validated.effectKey,
        requestDigest: validated.requestDigest,
        protocolVersion,
        schemaDigest,
        init: { retainUntil },
        guard: async () => {
          if (prepared.reservation.releasedAt) {
            throw executionError("RUN_VERSION_CONFLICT", `run ${validated.runId} environment is already released; nothing to retain`);
          }
        },
      });
      if (!created && record.result) return respond(requestId, record, "replayed");
      // Retention only ever EXTENDS the debug window (never shrinks another
      // effect's extension) and never extends execution/credential authority.
      const reservation = await mutateReservation(validated.runId, (current) => {
        if (current.releasedAt) return current;
        const existing = current.retainUntil ? Date.parse(current.retainUntil) : Number.NEGATIVE_INFINITY;
        const requested = Date.parse(retainUntil);
        return requested > existing ? { ...current, retainUntil } : current;
      });
      const current = await setOperationResult(validated.runId, validated.effectKey, {
        runId: validated.runId,
        retainedUntil: reservation.retainUntil ?? retainUntil,
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
                record.cancel ? record : { ...record, cancel: { requestedAt: now().toISOString(), reason: "released" } },
              );
              settled = await deps.settle(reservation);
              reservation = settled.reservation;
            }
            let detail = "no live harness";
            if (TERMINAL_RUN_STATES.has(settled.state)) {
              // Provably over (exit fold, confirmed stop, or proven never
              // started); indeterminateAt cannot be set here — a lost
              // projection wins over any recorded result.
              detail = "run already terminal; harness provably down";
            } else {
              const ours = await sessionIsOurs(reservation);
              if ((settled.state === "accepted" || settled.state === "starting") && !ours) {
                // A launch may still be CREATING the process: "no live
                // harness" would be a guess, and releasing occupancy under a
                // nascent harness could free a tree it is about to mutate.
                await annotatePending("launch unresolved and no provable session yet");
                break;
              }
              let stopConfirmed = true;
              if (ours) {
                const stop = await deps.control.stop(reservation.beeName);
                detail = stop.detail;
                stopConfirmed = stop.stopped;
              }
              if (!stopConfirmed) {
                // Step stays pending (retryable); the run is honestly lost,
                // not terminal, and every later cleanup step is fenced off.
                reservation = await mutateReservation(runId, (record) =>
                  record.indeterminateAt ? record : { ...record, indeterminateAt: now().toISOString() },
                );
                await appendRunEvents(
                  runId,
                  protocolVersion,
                  [{ type: "run.lost", payload: { cause: "release_stop_unconfirmed", detail }, origin: await deps.origin() }],
                  { onlyIfAbsentTypes: true },
                );
                await annotatePending(detail);
                break;
              }
              // Stop confirmed (or nothing verifiable of ours remains):
              // terminalize and resolve any earlier liveness doubt.
              reservation = await mutateReservation(runId, (record) => {
                const { indeterminateAt: _resolved, ...rest } = record;
                return rest.result
                  ? (rest as RunReservation)
                  : {
                      ...(rest as RunReservation),
                      result: { outcome: "cancelled", cause: "released", finishedAt: now().toISOString() },
                    };
              });
              if (reservation.result?.outcome === "cancelled") {
                await appendRunEvents(
                  runId,
                  protocolVersion,
                  [{ type: "run.cancelled", payload: { cause: "released" }, origin: await deps.origin() }],
                  { onlyIfAbsentTypes: true },
                );
              }
            }
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
