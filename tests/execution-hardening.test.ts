// H3 merge-gate hardening: two-phase effect-index crash windows, terminal
// event self-healing, lease-expiry execution stop, required capabilityLeaseId,
// launch-race fencing for cancel/release, and reconciliation-driven release
// continuation after a delayed launch.
import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type JsonObject } from "../src/execution/contract.js";
import { executionRoot } from "../src/execution/nodeState.js";
import { admitOperation, readOperation } from "../src/execution/opsStore.js";
import {
  admitRunStart,
  mutateReservation,
  readEffectIndex,
  readReservation,
  readRunEvents,
  runKey,
  writeEffectIndex,
} from "../src/execution/runStore.js";
import { claimWorkingCopy, readWorkingCopy, registerWorkingCopy } from "../src/execution/workingCopies.js";
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
  SNAPSHOT_DIGEST,
} from "./executionTestKit.js";

const RUN_ID = "run-0001";

async function startRunning(opts: { control?: ReturnType<typeof fakeControl>; expiresAt?: string } = {}) {
  const ctx = await installTestAuthority();
  const counting = countingLauncher();
  const control = opts.control ?? fakeControl();
  const service = makeService({ launcher: counting.launcher, control: control.control });
  await service.runStart(buildRunStartEnvelope(ctx, opts.expiresAt ? { expiresAt: opts.expiresAt } : {}));
  return { ctx, counting, control, service };
}

test("two-phase index: a pending entry with the same facts is repairable; a different run/key reuse conflicts", async () => {
  await withTempStore(async () => {
    const { ctx, service } = await startRunning();
    // Crash window: pending op-index entry written, record write lost.
    const body: JsonObject = { runId: RUN_ID, command: { kind: "send", text: "pending-repair" } };
    const envelope = buildOperationEnvelope(ctx, `${RUN_ID}/command/send-pending`, body);
    await writeEffectIndex({
      effectKey: `${RUN_ID}/command/send-pending`,
      requestDigest: String(envelope.requestDigest),
      runId: RUN_ID,
      method: "run.command",
      phase: "pending",
    });
    // Same-fact retry repairs and completes; the index commits.
    const response = (await service.runCommand(envelope)) as JsonObject;
    assert.equal((response.result as JsonObject).commandState, "completed");
    assert.equal((await readEffectIndex(`${RUN_ID}/command/send-pending`))!.phase, "committed");

    // A pending entry bound to ANOTHER run can never be admitted here.
    await writeEffectIndex({
      effectKey: "stolen-key",
      requestDigest: "sha256:" + "1".repeat(64),
      runId: "run-elsewhere",
      method: "run.cancel",
      phase: "pending",
    });
    const clash = (await service.runCancel(buildOperationEnvelope(ctx, "stolen-key", { runId: RUN_ID }))) as JsonObject;
    assert.equal((clash.error as JsonObject).code, "IDEMPOTENCY_CONFLICT");

    // run.start: pending entry for a different run conflicts before any effect.
    const otherStart = buildRunStartEnvelope(ctx, { runId: "run-0002", jobId: "job-0002" });
    await writeEffectIndex({
      effectKey: String(otherStart.effectKey),
      requestDigest: "sha256:" + "2".repeat(64),
      runId: "run-9999",
      method: "run.start",
      phase: "pending",
    });
    const startClash = (await service.runStart(otherStart)) as JsonObject;
    assert.equal((startClash.error as JsonObject).code, "IDEMPOTENCY_CONFLICT");
  });
});

test("event self-healing: state written without its lifecycle events re-derives them on the next read", async () => {
  await withTempStore(async () => {
    const { ctx, service } = await startRunning();
    // Crash simulation: durable state mutations with NO event appends.
    await mutateReservation(RUN_ID, (record) => ({ ...record, sealedAt: new Date().toISOString(), releasedAt: new Date().toISOString() }));
    const envelope = buildOperationEnvelope(ctx, `${RUN_ID}/command/send-heal`, { runId: RUN_ID, command: { kind: "send", text: "x" } });
    await admitOperation({
      runId: RUN_ID,
      method: "run.command",
      effectKey: `${RUN_ID}/command/send-heal`,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: "sha256:" + "0".repeat(64),
      init: { commandKind: "send", commandState: "completed" },
    });

    await service.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    const types = (await readRunEvents(RUN_ID)).map((event) => event.type);
    for (const expected of ["environment.sealed", "environment.released", "command.accepted", "command.dispatching", "command.completed"]) {
      assert.ok(types.includes(expected), `missing healed event ${expected}`);
    }
  });
});

test("lease expiry stops ongoing execution: confirmed stop -> cancelled(lease_expired); unconfirmed -> lost", async () => {
  await withTempStore(async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const { control } = await startRunning({ expiresAt });
    const later = makeService({ control: control.control, now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    const projection = ((await later.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(projection.state, "cancelled");
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 1);
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result?.cause, "lease_expired");
    const types = (await readRunEvents(RUN_ID)).map((event) => event.type);
    assert.ok(types.includes("cancel.requested"));
    assert.ok(types.includes("run.cancelled"));
  });

  await withTempStore(async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const control = fakeControl({ stopResult: { stopped: false, detail: "clean stop unconfirmed" } });
    await startRunning({ control, expiresAt });
    const later = makeService({ control: control.control, now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    const projection = ((await later.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(projection.state, "lost");
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result, undefined, "no false terminal over a possibly-live harness");
    assert.ok((await readRunEvents(RUN_ID)).some((event) => event.type === "run.lost"));
  });
});

test("stop retries on every reconcile pass: a transient first failure never strands a live harness behind a lost marker", async () => {
  await withTempStore(async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const control = fakeControl({ stopResult: { stopped: false, detail: "transient failure" } });
    await startRunning({ control, expiresAt });
    const later = makeService({ control: control.control, now: () => new Date(Date.now() + 2 * 60 * 60_000) });

    // First pass: stop unconfirmed -> lost, cancel(lease_expired) persisted.
    let projection = ((await later.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(projection.state, "lost");
    const stopsAfterFirst = control.calls.filter((call) => call.method === "stop").length;
    assert.ok(stopsAfterFirst >= 1);

    // Second pass with the failure persisting: the reconciler RETRIES.
    await later.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.ok(control.calls.filter((call) => call.method === "stop").length > stopsAfterFirst, "stop retried on later reconcile");

    // Failure clears: a later reconcile confirms the stop and terminalizes.
    control.behavior.stopResult = { stopped: true, detail: "clean stop confirmed" };
    projection = ((await later.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(projection.state, "cancelled");
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result?.cause, "lease_expired");
    assert.equal(reservation.indeterminateAt, undefined);
  });
});

test("a reservation without capabilityLeaseId fails closed on read", async () => {
  await withTempStore(async () => {
    await startRunning();
    const path = join(executionRoot(), "runs", runKey(RUN_ID), "reservation.json");
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete record.capabilityLeaseId;
    await writeFile(path, JSON.stringify(record, null, 2));
    await assert.rejects(readReservation(RUN_ID), (error: { code?: string }) => error.code === "AUTHORITY_UNAVAILABLE");
  });
});

test("cancel during an in-flight launch stays nonterminal; the post-launch sweep resolves cancelled on confirmed stop", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher({ delayMs: 200 });
    const control = fakeControl();
    const service = makeService({ launcher: counting.launcher, control: control.control });
    const startPromise = service.runStart(buildRunStartEnvelope(ctx));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = (await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "race" }))) as JsonObject;
    const midState = String((response.result as JsonObject).state);
    assert.ok(["starting", "accepted"].includes(midState), `nonterminal during launch, got ${midState}`);
    assert.ok(!(await readRunEvents(RUN_ID)).some((event) => event.type === "run.cancelled"), "no run.cancelled before the stop is real");

    await startPromise;
    // The sweep stopped the newborn session (confirmed) and resolved cancelled.
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 1);
    const projection = ((await service.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(projection.state, "cancelled");
    const types = (await readRunEvents(RUN_ID)).map((event) => event.type);
    assert.ok(types.includes("run.cancelled"));
    assert.ok(!types.includes("run.lost"));
  });
});

test("cancel during launch with an unconfirmable stop projects lost, then converges once exit is proven", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher({ delayMs: 150 });
    const control = fakeControl({ stopResult: { stopped: false, detail: "clean stop unconfirmed" } });
    const service = makeService({ launcher: counting.launcher, control: control.control });
    const startPromise = service.runStart(buildRunStartEnvelope(ctx));
    await new Promise((resolve) => setTimeout(resolve, 40));
    await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "race" }));
    await startPromise;

    const projection = ((await service.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(projection.state, "lost");
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result, undefined);
    let types = (await readRunEvents(RUN_ID)).map((event) => event.type);
    assert.ok(types.includes("run.lost"));
    assert.ok(!types.includes("run.cancelled"));

    // Session outcome later proves exit: reconciliation converges to cancelled.
    const bee = beeNameForRun(RUN_ID);
    await saveSession({ ...(await loadSession(bee))!, status: "done" });
    const settledProjection = ((await service.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal(settledProjection.state, "cancelled");
    assert.equal((await readReservation(RUN_ID))!.indeterminateAt, undefined, "doubt resolved");
    types = (await readRunEvents(RUN_ID)).map((event) => event.type);
    assert.ok(types.includes("run.cancelled"));
  });
});

test("release during an in-flight launch fences all cleanup; reconciliation completes it after the launch resolves", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher({ delayMs: 200 });
    const control = fakeControl();
    const service = makeService({ launcher: counting.launcher, control: control.control });
    await registerWorkingCopy({
      workingCopyId: "wc-race",
      productId: "prod-honeycomb-app",
      path: "/",
      snapshotDigest: SNAPSHOT_DIGEST,
    });
    await claimWorkingCopy("wc-race", RUN_ID);

    const startPromise = service.runStart(buildRunStartEnvelope(ctx, { mutateIntent: (intent) => {
      (intent.placement as JsonObject).workingCopyId = "wc-race";
    } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = (await service.runRelease(buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID }))) as JsonObject;
    const result = response.result as JsonObject;
    assert.equal(result.environmentState, "releasing", "fenced, not released");
    // Nothing was freed while the launch could still bind a harness to it.
    assert.equal((await readWorkingCopy("wc-race"))!.occupancy?.claimedByRunId, RUN_ID);
    assert.ok(!(await readRunEvents(RUN_ID)).some((event) => event.type === "environment.released"));

    await startPromise;
    // Read-side reconciliation (not an exact release retry) continues the
    // desired release: stop confirmed by the sweep, ledger completes.
    await service.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    const record = (await readOperation(RUN_ID, `${RUN_ID}/release`))!;
    assert.ok(record.releaseSteps!.every((step) => step.status === "completed"), JSON.stringify(record.releaseSteps));
    assert.equal((await readWorkingCopy("wc-race"))!.occupancy, undefined);
    assert.ok((await readReservation(RUN_ID))!.releasedAt);

    // The exact retry now replays the terminal receipt.
    const replay = (await service.runRelease(
      buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID }, { requestId: "req-release-after" }),
    )) as JsonObject;
    assert.deepEqual(replay.result, { environmentState: "released", steps: { completed: 4, unrecoverable: 0 } });
  });
});

test("requested evidence kinds this node cannot collect yield a typed partial failure, never a silent complete", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const control = fakeControl();
    const service = makeService({ control: control.control });
    const evidenceContract = { collect: ["logs", "media", "tests"], delivery: "local-manifest" };
    await service.runStart(
      buildRunStartEnvelope(ctx, {
        mutateIntent: (intent) => {
          intent.evidenceContract = structuredClone(evidenceContract);
        },
        mutateLease: (lease) => {
          lease.evidenceContract = structuredClone(evidenceContract);
        },
      }),
    );
    const response = (await service.runCollect(buildOperationEnvelope(ctx, `${RUN_ID}/collect`, { runId: RUN_ID }))) as JsonObject;
    const manifest = response.result as JsonObject;
    assert.equal(manifest.state, "failed", "unsupported kinds cannot silently complete");
    // The supported portion was still collected (typed partial).
    assert.ok((manifest.entries as JsonObject[]).some((entry) => entry.kind === "log"));
    const record = (await readOperation(RUN_ID, `${RUN_ID}/collect`))!;
    assert.match(record.cause!, /media, tests|tests, media/);
    assert.ok(!(await readRunEvents(RUN_ID)).some((event) => event.type === "collection.completed"));
  });
});
