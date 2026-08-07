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
import type { SessionEvidenceSource } from "../src/execution/service.js";
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

/** Hold the launcher after admission so race tests synchronize on state, not wall-clock sleeps. */
function gatedCountingLauncher() {
  const counting = countingLauncher();
  let markEntered!: () => void;
  let releaseLaunch!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  return {
    calls: counting.calls,
    entered,
    release: releaseLaunch,
    launcher: async (request: Parameters<typeof counting.launcher>[0]) => {
      markEntered();
      await released;
      return counting.launcher(request);
    },
  };
}

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

test("terminal event repair is atomic and idempotent for every durable result", async () => {
  for (const outcome of ["completed", "failed", "cancelled"] as const) {
    await withTempStore(async () => {
      const { service } = await startRunning();
      // Crash gap: reservation commit succeeded, terminal event append did not.
      await mutateReservation(RUN_ID, (record) => ({
        ...record,
        result: {
          outcome,
          ...(outcome === "failed" ? { cause: "harness_exited", harnessExitCode: 7 } : {}),
          ...(outcome === "cancelled" ? { cause: "operator cancel" } : {}),
          finishedAt: new Date().toISOString(),
        },
      }));

      // Concurrent repair attempts serialize on the event lock and append one
      // member of the mutually-exclusive terminal family.
      await Promise.all(
        Array.from({ length: 6 }, () => service.runGet({ protocolVersion: "0.1", runId: RUN_ID })),
      );
      const events = await readRunEvents(RUN_ID);
      const terminal = events.filter((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type));
      assert.deepEqual(terminal.map((event) => event.type), [`run.${outcome}`]);
      assert.equal(events.at(-1)!.type, `run.${outcome}`);
    });
  }
});

test("stale exit folds cannot escape a concurrently committed cancellation", async () => {
  for (const exitCode of [0, 17]) {
    await withTempStore(async () => {
      const ctx = await installTestAuthority();
      const control = fakeControl();
      let armed = false;
      let gated = false;
      let enterGate!: () => void;
      let releaseGate!: () => void;
      const gateEntered = new Promise<void>((resolve) => {
        enterGate = resolve;
      });
      const gateReleased = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const sessions: SessionEvidenceSource = {
        async evidence() {
          return { sessionExists: true, stampedRunId: RUN_ID };
        },
        async outcome() {
          if (!armed || gated) return { live: true };
          gated = true;
          // Capture the down outcome, then hold it until cancellation has
          // committed both its reservation result and terminal event.
          const observed = { live: false, exitCode };
          enterGate();
          await gateReleased;
          return observed;
        },
      };
      const service = makeService({ control: control.control, sessions });
      await service.runStart(buildRunStartEnvelope(ctx));

      armed = true;
      const staleFold = service.runGet({ protocolVersion: "0.1", runId: RUN_ID });
      await gateEntered;
      const cancelled = (await service.runCancel(
        buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "race winner" }),
      )) as JsonObject;
      assert.deepEqual(cancelled.result, { runId: RUN_ID, state: "cancelled" });
      assert.equal((await readReservation(RUN_ID))!.result?.outcome, "cancelled");

      releaseGate();
      const projection = await staleFold;
      assert.ok("result" in projection, JSON.stringify(projection));
      assert.equal(projection.result.state, "cancelled");
      assert.equal((projection.result.result as JsonObject).outcome, "cancelled");
      assert.deepEqual(service.validator.validate("run-projection", projection.result).errors, []);

      const events = await readRunEvents(RUN_ID);
      const terminal = events.filter((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type));
      assert.deepEqual(terminal.map((event) => event.type), ["run.cancelled"]);
      assert.equal(terminal[0]!.type, `run.${(await readReservation(RUN_ID))!.result!.outcome}`);
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "run.accepted",
          "environment.materializing",
          "harness.starting",
          "environment.ready",
          "harness.running",
          "cancel.requested",
          "run.cancelled",
        ],
      );
      assert.equal(events.at(-1)!.type, "run.cancelled", "no stale harness/result event may escape after terminal cancellation");
      assert.ok(events.findIndex((event) => event.type === "cancel.requested") < events.findIndex((event) => event.type === "run.cancelled"));
      for (const event of events) assert.deepEqual(service.validator.validate("run-event", event).errors, [], event.type);
    });
  }
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
    const events = await readRunEvents(RUN_ID);
    assert.deepEqual(events.slice(-5).map((event) => event.type), [
      "cancel.requested",
      "run.lost",
      "run.recovering",
      "harness.exited",
      "run.cancelled",
    ]);
    const lostId = (events.find((event) => event.type === "run.lost")!.payload as JsonObject).lossEpisodeId;
    assert.ok(typeof lostId === "string" && lostId.length > 0);
    assert.equal(
      (events.find((event) => event.type === "run.recovering")!.payload as JsonObject).lossEpisodeId,
      lostId,
      "one durable loss episode spans unconfirmed stop and terminal recovery",
    );
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
    const counting = gatedCountingLauncher();
    const control = fakeControl();
    const service = makeService({ launcher: counting.launcher, control: control.control });
    const startPromise = service.runStart(buildRunStartEnvelope(ctx));
    await counting.entered;

    try {
      const response = (await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "race" }))) as JsonObject;
      assert.ok(response.result, `cancel failed: ${JSON.stringify(response.error)}`);
      const midState = String((response.result as JsonObject).state);
      assert.ok(["starting", "accepted"].includes(midState), `nonterminal during launch, got ${midState}`);
      assert.ok(!(await readRunEvents(RUN_ID)).some((event) => event.type === "run.cancelled"), "no run.cancelled before the stop is real");
    } finally {
      counting.release();
    }

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
    const counting = gatedCountingLauncher();
    const control = fakeControl({ stopResult: { stopped: false, detail: "clean stop unconfirmed" } });
    const service = makeService({ launcher: counting.launcher, control: control.control });
    const startPromise = service.runStart(buildRunStartEnvelope(ctx));
    await counting.entered;
    try {
      await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "race" }));
    } finally {
      counting.release();
    }
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

test("two services preserve pre-launch cancellation while retrying an unconfirmed post-launch stop to stream convergence", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = gatedCountingLauncher();
    const control = fakeControl({ stopResult: { stopped: false, detail: "clean stop unconfirmed" } });
    const launcherService = makeService({ launcher: counting.launcher, control: control.control });
    // This independent service cannot see launcherService's in-memory flight.
    // Zero grace makes the no-session barrier a deterministic never-started
    // classification while the launcher is paused before persisting evidence.
    const cancellingService = makeService({ control: control.control, launchGraceMs: 0 });

    const startPromise = launcherService.runStart(buildRunStartEnvelope(ctx));
    await counting.entered;
    const cancelled = (await cancellingService.runCancel(
      buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "two-service race" }),
    )) as JsonObject;
    assert.deepEqual(cancelled.result, { runId: RUN_ID, state: "cancelled" });
    const cancellationResult = structuredClone((await readReservation(RUN_ID))!.result);
    assert.equal(cancellationResult?.outcome, "cancelled");

    counting.release();
    const started = await startPromise;
    assert.equal((started.result as JsonObject).state, "lost");
    let reservation = (await readReservation(RUN_ID))!;
    assert.deepEqual(reservation.result, cancellationResult, "launch never replaces the durable cancelled result");
    assert.equal(reservation.phase, "started");
    assert.equal(reservation.indeterminateCause, "cancel_stop_unconfirmed");
    const unconfirmedStops = control.calls.filter((call) => call.method === "stop").length;
    assert.ok(unconfirmedStops >= 2, "post-launch sweep and reconciliation both retry the unconfirmed stop");

    let events = await readRunEvents(RUN_ID);
    const lost = events.find((event) => event.type === "run.lost")!;
    const lossEpisodeId = (lost.payload as JsonObject).lossEpisodeId;
    assert.equal(typeof lossEpisodeId, "string");
    assert.ok(events.findIndex((event) => event.type === "run.cancelled") < events.indexOf(lost));
    assert.equal(events.at(-1)!.type, "run.lost", "the partial stream exposes the live-runtime doubt");

    control.behavior.stopResult = { stopped: true, detail: "clean stop confirmed" };
    const settled = await cancellingService.runGet({ protocolVersion: "0.1", runId: RUN_ID });
    assert.ok("result" in settled, JSON.stringify(settled));
    assert.equal(settled.result.state, "cancelled");
    assert.ok(control.calls.filter((call) => call.method === "stop").length > unconfirmedStops);
    reservation = (await readReservation(RUN_ID))!;
    assert.deepEqual(reservation.result, cancellationResult, "stop recovery preserves the original terminal fact");
    assert.equal(reservation.indeterminateAt, undefined);

    events = await readRunEvents(RUN_ID);
    const recovering = events.find((event) => event.type === "run.recovering")!;
    const exited = events.find((event) =>
      event.type === "harness.exited" && (event.payload as JsonObject).lossEpisodeId === lossEpisodeId,
    )!;
    assert.equal((recovering.payload as JsonObject).lossEpisodeId, lossEpisodeId);
    assert.ok(events.indexOf(lost) < events.indexOf(recovering));
    assert.ok(events.indexOf(recovering) < events.indexOf(exited));
    assert.equal(events.at(-1)!.type, "harness.exited", "recovery cannot clear doubt while Apiary still ends at lost");
    assert.equal(events.filter((event) => event.type === "run.cancelled").length, 1);
    for (const event of events) {
      assert.deepEqual(launcherService.validator.validate("run-event", event).errors, [], event.type);
    }
  });
});

test("release during an in-flight launch fences all cleanup; reconciliation completes it after the launch resolves", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = gatedCountingLauncher();
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
    await counting.entered;

    try {
      const response = (await service.runRelease(buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID }))) as JsonObject;
      const result = response.result as JsonObject;
      assert.equal(result.environmentState, "releasing", "fenced, not released");
      // Nothing was freed while the launch could still bind a harness to it.
      assert.equal((await readWorkingCopy("wc-race"))!.occupancy?.claimedByRunId, RUN_ID);
      assert.ok(!(await readRunEvents(RUN_ID)).some((event) => event.type === "environment.released"));
    } finally {
      counting.release();
    }

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
    assert.equal(record.collectionFailure, "unrecoverable");
    assert.ok(!(await readRunEvents(RUN_ID)).some((event) => event.type === "collection.completed"));

    // Unsupported/unrecoverable collection failures remain terminal across
    // replay and restart; only failures explicitly classified retryable may
    // re-enter under the same stable effect.
    const restarted = makeService({ control: fakeControl().control });
    const replay = (await restarted.runCollect(
      buildOperationEnvelope(ctx, `${RUN_ID}/collect`, { runId: RUN_ID }, { requestId: "req-unsupported-replay" }),
    )) as JsonObject;
    assert.equal((replay.receipt as JsonObject).outcome, "replayed");
    assert.equal((replay.result as JsonObject).state, "failed");
    assert.equal((replay.receipt as JsonObject).resultVersion, (response.receipt as JsonObject).resultVersion);
    assert.equal((await readOperation(RUN_ID, `${RUN_ID}/collect`))!.collectionFailure, "unrecoverable");
  });
});
