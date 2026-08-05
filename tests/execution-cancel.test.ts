// H3 run.cancel: desired-state, idempotent cancellation that is safe in every
// nonterminal state, survives restart, never revives a terminal run, and
// never touches a session bound to a different run (RFC acceptance test 13).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createExecutionValidator, loadExecutionContract, type JsonObject } from "../src/execution/contract.js";
import { admitRunStart, readReservation, readRunEvents } from "../src/execution/runStore.js";
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

test("run.cancel never stops a session stamped with a different run, but still cancels durably", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const control = fakeControl();
    const service = makeService({ control: control.control });
    await service.runStart(buildRunStartEnvelope(ctx));
    const bee = beeNameForRun(RUN_ID);
    await saveSession({ ...(await loadSession(bee))!, executionRunId: "run-imposter" });

    const response = (await service.runCancel(cancelEnvelope(ctx))) as JsonObject;
    assert.deepEqual(response.result, { runId: RUN_ID, state: "cancelled" });
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0, "imposter session must not be stopped");
    assert.equal((await readReservation(RUN_ID))!.result?.outcome, "cancelled");
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
