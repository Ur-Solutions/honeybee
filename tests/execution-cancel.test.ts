// H3 run.cancel: desired-state, idempotent cancellation that is safe in every
// nonterminal state, survives restart, never revives a terminal run, and
// never touches a session bound to a different run (RFC acceptance test 13).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  computeSchemaDigest,
  createExecutionValidator,
  loadExecutionContract,
  type JsonObject,
} from "../src/execution/contract.js";
import { admitOperation, readOperation, setOperationResult } from "../src/execution/opsStore.js";
import {
  admitRunStart,
  appendRunEvents,
  enterLossEpisode,
  mutateReservation,
  readReservation,
  readRunEvents,
} from "../src/execution/runStore.js";
import { validateRunStart } from "../src/execution/runStart.js";
import { requireExecutionBinding } from "../src/execution/nodeState.js";
import { loadSession, saveSession } from "../src/store.js";
import {
  beeNameForRun,
  buildOperationEnvelope,
  buildRunStartEnvelope,
  countingLauncher,
  fakeControl,
  installTestAuthority,
  makeService,
  withTempStore,
} from "./executionTestKit.js";

const contract = loadExecutionContract();
const validator = createExecutionValidator(contract);
const RUN_ID = "run-0001";

function cancelEnvelope(ctx: Awaited<ReturnType<typeof installTestAuthority>>, effectKey = `${RUN_ID}/cancel`, reason = "operator cancel") {
  return buildOperationEnvelope(ctx, effectKey, { runId: RUN_ID, reason });
}

test("run.cancel of a running run: persists intent, stops only the bound session, replays the same receipt", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher();
    const control = fakeControl();
    const service = makeService({ launcher: counting.launcher, control: control.control });
    await service.runStart(buildRunStartEnvelope(ctx));

    const envelope = cancelEnvelope(ctx);
    assert.deepEqual(validator.validate("run-cancel-body", envelope.body).errors, []);
    const response = (await service.runCancel(envelope)) as JsonObject;
    assert.deepEqual(validator.validate("execution-response-envelope", response).errors, []);
    const receipt = response.receipt as JsonObject;
    assert.equal(receipt.outcome, "created");
    assert.deepEqual(response.result, { runId: RUN_ID, state: "cancelled" });

    const stops = control.calls.filter((call) => call.method === "stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0]!.beeName, beeNameForRun(RUN_ID));

    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.cancel?.reason, "operator cancel");
    assert.equal(reservation.result?.outcome, "cancelled");

    const events = await readRunEvents(RUN_ID);
    assert.ok(events.some((event) => event.type === "cancel.requested"));
    assert.ok(events.some((event) => event.type === "run.cancelled"));
    for (const event of events) assert.deepEqual(validator.validate("run-event", event).errors, [], event.type);

    // Terminal repeat: the original receipt replays, nothing is stopped twice.
    const replay = (await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "operator cancel" }, { requestId: "req-cancel-2" }))) as JsonObject;
    assert.equal((replay.receipt as JsonObject).outcome, "replayed");
    assert.equal((replay.receipt as JsonObject).receiptId, receipt.receiptId);
    assert.deepEqual(replay.result, { runId: RUN_ID, state: "cancelled" });
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 1);

    // The projection agrees after a coordinator restart.
    const restarted = makeService({ control: fakeControl().control });
    const projection = ((await restarted.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(projection.state, "cancelled");
  });
});

test("run.cancel of a reserved (never-launched) run cancels it and a run.start replay never relaunches", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const envelope = buildRunStartEnvelope(ctx);
    // Admit the reservation durably WITHOUT launching (crash-before-launch).
    const binding = await requireExecutionBinding();
    const validated = validateRunStart(envelope, { validator, binding, nodeId: binding.nodeId, protocolVersion: "0.1" });
    await admitRunStart({
      runId: validated.runId,
      effectKey: validated.effectKey,
      requestDigest: validated.requestDigest,
      protocolVersion: "0.1",
      schemaDigest: "sha256:" + "0".repeat(64),
      ownerScopeId: String(validated.authority.ownerScopeId),
      workspaceId: String(validated.authority.workspaceId),
      jobId: String(validated.intent.jobId),
      leaseId: String(validated.lease.leaseId),
      leaseExpiresAt: String(validated.lease.expiresAt),
      capabilityLeaseId: String(validated.authority.capabilityLeaseId),
      intent: validated.intent,
    });

    const counting = countingLauncher();
    const control = fakeControl();
    const service = makeService({ launcher: counting.launcher, control: control.control });
    const response = (await service.runCancel(cancelEnvelope(ctx))) as JsonObject;
    assert.deepEqual(response.result, { runId: RUN_ID, state: "cancelled" });
    // Nothing was ever started, so nothing is stopped.
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0);

    // The identical run.start retry replays its receipt and must NOT launch.
    const startReplay = (await service.runStart(envelope)) as JsonObject;
    assert.equal((startReplay.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(startReplay.result, { runId: RUN_ID, state: "cancelled" });
    assert.equal(counting.calls.length, 0);
  });
});

test("run.cancel of a terminal run records the terminal state and never revives the run", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const control = fakeControl();
    const service = makeService({ control: control.control });
    await service.runStart(buildRunStartEnvelope(ctx));
    // The harness finished on its own (session record no longer running).
    const bee = beeNameForRun(RUN_ID);
    await saveSession({ ...(await loadSession(bee))!, status: "done" });
    const projection = ((await service.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(projection.state, "failed");

    const response = (await service.runCancel(cancelEnvelope(ctx))) as JsonObject;
    assert.deepEqual(response.result, { runId: RUN_ID, state: "failed" });
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0);
    const events = await readRunEvents(RUN_ID);
    assert.ok(!events.some((event) => event.type === "cancel.requested"), "terminal cancel emits no cancel.requested");
    assert.ok(!events.some((event) => event.type === "run.cancelled"));
    assert.equal((await readReservation(RUN_ID))!.result?.outcome, "failed");
  });
});

test("run.cancel never stops a session stamped with a different run or mistakes it for runtime-down proof", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const control = fakeControl();
    const service = makeService({ control: control.control });
    await service.runStart(buildRunStartEnvelope(ctx));
    const bee = beeNameForRun(RUN_ID);
    await saveSession({ ...(await loadSession(bee))!, executionRunId: "run-imposter" });

    const response = (await service.runCancel(cancelEnvelope(ctx))) as JsonObject;
    assert.deepEqual(response.result, { runId: RUN_ID, state: "lost" });
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0, "imposter session must not be stopped");
    assert.equal((await readReservation(RUN_ID))!.result, undefined, "a foreign record does not prove this Run's host exited");
  });
});

test("run.cancel remains available after lease expiry (cleanup is not new mutation)", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const control = fakeControl();
    const service = makeService({ control: control.control });
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }));

    const later = makeService({ control: control.control, now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    const response = (await later.runCancel(cancelEnvelope(ctx))) as JsonObject;
    assert.deepEqual(response.result, { runId: RUN_ID, state: "cancelled" });
  });
});

test("run.cancel of a pre-launch lease-expired failure remains an ordinary terminal replay", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    let clock = Date.now();
    const expiresAt = new Date(clock + 60 * 60_000).toISOString();
    const control = fakeControl();
    const service = makeService({
      control: control.control,
      now: () => new Date(clock),
      afterLaunchClaim: () => { clock += 2 * 60 * 60_000; },
    });
    const start = (await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }))) as JsonObject;
    assert.deepEqual(start.result, { runId: RUN_ID, state: "failed" });
    const failedReservation = (await readReservation(RUN_ID))!;
    assert.deepEqual(failedReservation.result, {
      outcome: "failed",
      cause: "lease_expired",
      finishedAt: new Date(clock).toISOString(),
    });
    assert.equal(failedReservation.failureCause, "LEASE_DENIED: lease expired before the reserved launch could start");

    const effectKey = `${RUN_ID}/cancel-failed-lease`;
    const cancelled = (await service.runCancel(cancelEnvelope(ctx, effectKey))) as JsonObject;
    assert.deepEqual(cancelled.result, { runId: RUN_ID, state: "failed" });
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0);
    assert.equal((await readOperation(RUN_ID, effectKey))!.cancelLifecycle, undefined);
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      0,
    );
  });
});

test("a failed explicit cancel after lease parking remains durable and plain run.get retries the archive", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const control = fakeControl();
    const service = makeService({ control: control.control });
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }));

    let archiveConfirmed = false;
    let archiveAttempts = 0;
    const later = makeService({
      control: control.control,
      now: () => new Date(Date.now() + 2 * 60 * 60_000),
      stopAndRetireSession: async () => {
        archiveAttempts += 1;
        return archiveConfirmed
          ? { settled: true, detail: "explicit archive confirmed", cleanup: { stopped: true, detail: "already parked" } }
          : {
              settled: false,
              detail: "archive write unconfirmed",
              cleanup: { stopped: true, detail: "runtime was already parked" },
              stopDoubtPersisted: true,
            };
      },
    });
    const expired = ((await later.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(expired.state, "cancelled");
    assert.equal((await readReservation(RUN_ID))!.result?.cause, "lease_expired");

    const cancel = (await later.runCancel(cancelEnvelope(ctx, `${RUN_ID}/cancel-after-lease`))) as JsonObject;
    assert.deepEqual(cancel.result, { runId: RUN_ID, state: "lost" });
    assert.equal(archiveAttempts, 1);
    assert.equal((await readReservation(RUN_ID))!.indeterminateCause, "cancel_stop_unconfirmed");
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" &&
        (event.payload as JsonObject).effectKey === `${RUN_ID}/cancel-after-lease`).length,
      0,
      "an unresolved stop cannot publish the final explicit marker before terminal-event repair",
    );

    archiveConfirmed = true;
    const reconciled = ((await later.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(reconciled.state, "cancelled");
    assert.equal(
      archiveAttempts,
      3,
      "ordinary reconciliation proves the stop, then the operation idempotently binds its new-writer archive receipt",
    );
    assert.equal((await readReservation(RUN_ID))!.indeterminateAt, undefined);
    assert.equal((await readReservation(RUN_ID))!.result?.cause, "lease_expired", "explicit cleanup does not rewrite the immutable Run result");
    assert.equal(
      (await readOperation(RUN_ID, `${RUN_ID}/cancel-after-lease`))!.cancelLifecycle?.state,
      "archive-settled",
    );

    const settledEvents = await readRunEvents(RUN_ID);
    const leaseTerminal = settledEvents.find((event) => event.type === "run.cancelled")!;
    const explicitMarkers = settledEvents.filter((event) =>
      event.type === "cancel.requested" &&
      (event.payload as JsonObject).effectKey === `${RUN_ID}/cancel-after-lease`);
    assert.equal(explicitMarkers.length, 1);
    assert.ok(explicitMarkers[0]!.seq > leaseTerminal.seq, "explicit operator intent is newer than the lease terminal row");
    assert.equal((explicitMarkers[0]!.payload as JsonObject).reason, "operator cancel");

    await later.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    const replayedEvents = await readRunEvents(RUN_ID);
    assert.equal(
      replayedEvents.filter((event) =>
        event.type === "cancel.requested" &&
        (event.payload as JsonObject).effectKey === `${RUN_ID}/cancel-after-lease`).length,
      1,
      "read/reconcile replay keeps the explicit marker idempotent",
    );
  });
});

test("a crash after cancel admission cannot publish explicit intent before archive proof", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const service = makeService();
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }));

    const expired = makeService({ now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    await expired.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal((await readReservation(RUN_ID))!.result?.cause, "lease_expired");

    const effectKey = `${RUN_ID}/admitted-cancel`;
    const envelope = cancelEnvelope(ctx, effectKey);
    await admitOperation({
      runId: RUN_ID,
      method: "run.cancel",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: { cause: "operator cancel" },
    });
    assert.equal((await readOperation(RUN_ID, effectKey))!.result, undefined, "crash left admission without progression proof");
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      0,
    );

    let archiveConfirmed = false;
    let archiveAttempts = 0;
    const restarted = makeService({
      stopAndRetireSession: async () => {
        archiveAttempts += 1;
        return archiveConfirmed
          ? { settled: true, detail: "archive confirmed", cleanup: { stopped: true, detail: "stopped" } }
          : {
              settled: false,
              detail: "archive unconfirmed",
              cleanup: { stopped: true, detail: "stopped" },
              stopDoubtPersisted: true,
            };
      },
    });

    await restarted.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal(archiveAttempts, 1);
    assert.deepEqual((await readOperation(RUN_ID, effectKey))!.result, { runId: RUN_ID, state: "lost" });
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      0,
      "an admitted/lost operation is not publication proof",
    );

    archiveConfirmed = true;
    await restarted.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal(
      archiveAttempts,
      3,
      "ordinary reconciliation proves the stop, then the operation idempotently binds its archive receipt",
    );
    assert.deepEqual((await readOperation(RUN_ID, effectKey))!.result, { runId: RUN_ID, state: "cancelled" });
    assert.equal((await readOperation(RUN_ID, effectKey))!.cancelLifecycle?.state, "archive-settled");
    const events = await readRunEvents(RUN_ID);
    const marker = events.filter((event) =>
      event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey);
    assert.equal(marker.length, 1);
    assert.ok(marker[0]!.seq > events.find((event) => event.type === "run.cancelled")!.seq);

    await restarted.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal(archiveAttempts, 3);
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      1,
    );
  });
});

test("a legacy terminal cancel result is not archive proof for a lease-parked Bee", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const service = makeService();
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }));
    const expired = makeService({ now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    await expired.runGet({ protocolVersion: "0.1", runId: RUN_ID });

    const effectKey = `${RUN_ID}/settled-cancel`;
    const envelope = cancelEnvelope(ctx, effectKey);
    await admitOperation({
      runId: RUN_ID,
      method: "run.cancel",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: { cause: "operator cancel" },
    });
    // Pre-change coordinators wrote these exact bytes for any terminal Run
    // without attempting Bee archival. New code must not trust them.
    await setOperationResult(RUN_ID, effectKey, { runId: RUN_ID, state: "cancelled" });
    await appendRunEvents(
      RUN_ID,
      "0.1",
      [{
        type: "cancel.requested",
        payload: { effectKey },
        origin: { nodeId: "legacy-daemon" },
      }],
      { onlyIfAbsentKeys: true },
    );
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      1,
      "the simulated old daemon left one bare, unproven compatibility marker",
    );

    let stopAttempts = 0;
    const restarted = makeService({
      stopAndRetireSession: async () => {
        stopAttempts += 1;
        return { settled: true, detail: "exact archive confirmed", cleanup: { stopped: true, detail: "stopped" } };
      },
    });
    await restarted.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal(stopAttempts, 1, "legacy result bytes still require exact lifecycle progression");
    assert.equal((await readOperation(RUN_ID, effectKey))!.cancelLifecycle?.state, "archive-settled");
    const events = await readRunEvents(RUN_ID);
    const markers = events.filter((event) =>
      event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey);
    assert.equal(markers.length, 2, "the proof-bearing member supersedes rather than deduplicates against the unsafe legacy row");
    const marker = markers.find((event) => (event.payload as JsonObject).lifecycleProofId !== undefined)!;
    assert.equal(((marker.payload as JsonObject).lifecycleProof as JsonObject).state, "archive-settled");
    assert.ok(marker.seq > markers.find((event) => (event.payload as JsonObject).lifecycleProofId === undefined)!.seq);
    assert.ok(marker.seq > events.find((event) => event.type === "run.cancelled")!.seq);
  });
});

test("a crash after the new archive-settlement proof self-heals only the missing marker", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const service = makeService();
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }));
    const expired = makeService({ now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    await expired.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    const reservation = (await readReservation(RUN_ID))!;

    const effectKey = `${RUN_ID}/proved-cancel`;
    const envelope = cancelEnvelope(ctx, effectKey);
    await admitOperation({
      runId: RUN_ID,
      method: "run.cancel",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: { cause: "operator cancel" },
    });
    // Exact new durable boundary written after stop/archive and before the
    // event append. Simulate process death between those two writes.
    await setOperationResult(
      RUN_ID,
      effectKey,
      { runId: RUN_ID, state: "cancelled" },
      {
        cancelLifecycle: {
          version: 1,
          state: "archive-settled",
          runId: RUN_ID,
          effectKey,
          beeName: reservation.beeName,
          leaseId: reservation.leaseId,
          resultCause: "lease_expired",
          settledAt: new Date().toISOString(),
          ...(reservation.sessionRef ? { sessionRef: reservation.sessionRef } : {}),
        },
      },
    );
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      0,
    );

    let stopAttempts = 0;
    const restarted = makeService({
      stopAndRetireSession: async () => {
        stopAttempts += 1;
        throw new Error("new settlement proof must not redispatch stop");
      },
    });
    await restarted.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal(stopAttempts, 0);
    const events = await readRunEvents(RUN_ID);
    const marker = events.filter((event) =>
      event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey);
    assert.equal(marker.length, 1);
    assert.ok(marker[0]!.seq > events.find((event) => event.type === "run.cancelled")!.seq);
  });
});

test("a mismatched archive-settlement proof fails closed without stopping or publishing", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const service = makeService();
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }));
    const expired = makeService({ now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    await expired.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    const reservation = (await readReservation(RUN_ID))!;

    const effectKey = `${RUN_ID}/mismatched-proof-cancel`;
    const envelope = cancelEnvelope(ctx, effectKey);
    await admitOperation({
      runId: RUN_ID,
      method: "run.cancel",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: { cause: "operator cancel" },
    });
    await setOperationResult(
      RUN_ID,
      effectKey,
      { runId: RUN_ID, state: "cancelled" },
      {
        cancelLifecycle: {
          version: 1,
          state: "archive-settled",
          runId: RUN_ID,
          effectKey,
          beeName: reservation.beeName,
          leaseId: "different-lease",
          resultCause: "lease_expired",
          settledAt: new Date().toISOString(),
          ...(reservation.sessionRef ? { sessionRef: reservation.sessionRef } : {}),
        },
      },
    );

    let stopAttempts = 0;
    const restarted = makeService({
      stopAndRetireSession: async () => {
        stopAttempts += 1;
        return { settled: true, detail: "must not run", cleanup: { stopped: true, detail: "must not run" } };
      },
    });
    await restarted.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal(stopAttempts, 0);
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      0,
    );
  });
});

test("a reservation uncertainty writer racing proof persistence prevents proof and publication", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const service = makeService();
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }));
    const expired = makeService({ now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    await expired.runGet({ protocolVersion: "0.1", runId: RUN_ID });

    const effectKey = `${RUN_ID}/proof-race-cancel`;
    const envelope = cancelEnvelope(ctx, effectKey);
    await admitOperation({
      runId: RUN_ID,
      method: "run.cancel",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: { cause: "operator cancel" },
    });

    let injected = false;
    let stopAttempts = 0;
    const raced = makeService({
      stopAndRetireSession: async () => {
        stopAttempts += 1;
        return { settled: true, detail: "exact archive confirmed", cleanup: { stopped: true, detail: "stopped" } };
      },
      operationPersistence: {
        setOperationResult: async (...args) => {
          const extra = args[3];
          if (!injected && extra?.cancelLifecycle) {
            injected = true;
            await mutateReservation(RUN_ID, (record) =>
              enterLossEpisode(record, "injected-concurrent-uncertainty", new Date().toISOString()),
            );
          }
          return setOperationResult(...args);
        },
      },
    });
    await raced.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal(stopAttempts, 1);
    assert.equal(injected, true);
    assert.equal((await readReservation(RUN_ID))!.indeterminateCause, "injected-concurrent-uncertainty");
    assert.equal((await readOperation(RUN_ID, effectKey))!.cancelLifecycle, undefined);
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      0,
    );
  });
});

test("a terminal-outcome mismatch racing proof persistence prevents proof and publication", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const service = makeService();
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt }));
    const expired = makeService({ now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    await expired.runGet({ protocolVersion: "0.1", runId: RUN_ID });

    const effectKey = `${RUN_ID}/outcome-race-cancel`;
    const envelope = cancelEnvelope(ctx, effectKey);
    await admitOperation({
      runId: RUN_ID,
      method: "run.cancel",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: { cause: "operator cancel" },
    });

    let injected = false;
    const raced = makeService({
      stopAndRetireSession: async () => ({
        settled: true,
        detail: "exact archive confirmed",
        cleanup: { stopped: true, detail: "stopped" },
      }),
      operationPersistence: {
        setOperationResult: async (...args) => {
          const extra = args[3];
          if (!injected && extra?.cancelLifecycle) {
            injected = true;
            await mutateReservation(RUN_ID, (record) => ({
              ...record,
              result: { ...record.result!, outcome: "failed" },
            }));
          }
          return setOperationResult(...args);
        },
      },
    });
    await raced.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.equal(injected, true);
    assert.equal((await readReservation(RUN_ID))!.result?.outcome, "failed");
    assert.equal((await readOperation(RUN_ID, effectKey))!.cancelLifecycle, undefined);
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) =>
        event.type === "cancel.requested" && (event.payload as JsonObject).effectKey === effectKey).length,
      0,
    );
  });
});
