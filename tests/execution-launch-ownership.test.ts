import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/execution/contract.js";
import { executionError } from "../src/execution/errors.js";
import { requireExecutionBinding } from "../src/execution/nodeState.js";
import {
  activateRunLaunchAttempt,
  appendRunEvents,
  commitRunTerminalResult,
  readReservation,
  readRunEvents,
  type RunLaunchOwner,
} from "../src/execution/runStore.js";
import { inspectRunLaunchOwner } from "../src/execution/service.js";
import { claimWorkingCopy, readWorkingCopy, registerWorkingCopy } from "../src/execution/workingCopies.js";
import {
  buildOperationEnvelope,
  buildRunStartEnvelope,
  countingLauncher,
  fakeControl,
  installTestAuthority,
  makeService,
  SNAPSHOT_DIGEST,
  type TestAuthority,
  withTempStore,
} from "./executionTestKit.js";

const RUN_ID = "run-0001";

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { enter, entered, release, released };
}

function owner(
  ownerId: string,
  pid: number,
  identity: { machineId?: string; hostname?: string } = {},
): RunLaunchOwner {
  return {
    ownerId,
    pid,
    machineId: identity.machineId ?? "machine-a",
    hostname: identity.hostname ?? "test-host",
    processFingerprint: { pgid: pid, startedAt: `birth-${pid}` },
  };
}

async function createActivatedOwnerDeathWithOccupiedCopy(
  ctx: TestAuthority,
  options: { reconcileBeforeReturn?: boolean } = {},
) {
  await registerWorkingCopy({
    workingCopyId: "wc-0001",
    productId: "prod-honeycomb-app",
    path: "/tmp/honeybee-activated-owner-death",
    snapshotDigest: SNAPSHOT_DIGEST,
  });
  const ownerA = owner("owner-activated-hidden-runtime", 41601);
  const ownerB = owner("owner-recovering-hidden-runtime", 41602);
  const serviceA = makeService({
    launcher: countingLauncher().launcher,
    launchOwner: ownerA,
    afterLaunchClaim: async (reservation, attemptId) => {
      const nodeId = (await requireExecutionBinding()).nodeId;
      await appendRunEvents(
        reservation.runId,
        "0.1",
        [
          { type: "environment.materializing", payload: {}, origin: { nodeId } },
          { type: "harness.starting", payload: { operationId: reservation.runId }, origin: { nodeId } },
        ],
        { onlyIfAbsentTypes: true },
      );
      assert.equal((await activateRunLaunchAttempt(reservation.runId, attemptId)).activated, true);
      // Model the real crash window after the launcher has claimed the Cell
      // and may have forked, but before it published a SessionRecord.
      await claimWorkingCopy("wc-0001", reservation.runId);
      throw executionError("AUTHORITY_UNAVAILABLE", "simulated coordinator death after launch side effect");
    },
  });
  const interrupted = (await serviceA.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
  assert.equal((interrupted.error as JsonObject).code, "AUTHORITY_UNAVAILABLE");

  const control = fakeControl();
  const recoveryLauncher = countingLauncher();
  const serviceB = makeService({
    launcher: recoveryLauncher.launcher,
    control: control.control,
    launchOwner: ownerB,
    inspectLaunchOwner: async (candidate) => candidate.ownerId === ownerA.ownerId ? "dead" : "alive",
  });
  if (options.reconcileBeforeReturn !== false) {
    const replay = (await serviceB.runStart(
      buildRunStartEnvelope(ctx, { requestId: "req-reconcile-hidden-runtime" }),
    )) as JsonObject;
    assert.deepEqual(replay.result, { runId: RUN_ID, state: "lost" });
    assert.equal((await readReservation(RUN_ID))!.indeterminateCause, "readiness_evidence_missing");
  }
  assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, RUN_ID);
  return { service: serviceB, control, recoveryLauncher };
}

test("same owner resumes durable preparation after transient launch-event publication failure", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher();
    let appendCalls = 0;
    const service = makeService({
      launcher: counting.launcher,
      appendLaunchEvents: async (...args) => {
        appendCalls += 1;
        if (appendCalls === 1) {
          throw executionError("AUTHORITY_UNAVAILABLE", "injected launch event-store rejection");
        }
        return appendRunEvents(...args);
      },
    });

    const first = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.equal((first.error as JsonObject).code, "AUTHORITY_UNAVAILABLE");
    assert.equal(counting.calls.length, 0, "publisher failure occurs before the launcher side effect");
    assert.equal((await readReservation(RUN_ID))!.launchAttempt?.stage, "preparing");

    const retry = (await service.runStart(buildRunStartEnvelope(ctx, { requestId: "req-retry" }))) as JsonObject;
    assert.deepEqual(retry.result, { runId: RUN_ID, state: "running" });
    assert.equal(counting.calls.length, 1);
    assert.equal((await readReservation(RUN_ID))!.launchAttempt?.stage, "launching");

    await service.runStart(buildRunStartEnvelope(ctx, { requestId: "req-replay" }));
    assert.equal(counting.calls.length, 1, "settled replay never invokes the launcher again");
    const types = (await readRunEvents(RUN_ID)).map((event) => event.type);
    assert.equal(types.filter((type) => type === "environment.materializing").length, 1);
    assert.equal(types.filter((type) => type === "harness.starting").length, 1);
  });
});

test("two services: replay after durable admission elects exactly one launch owner", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const admitted = barrier();
    const counting = countingLauncher();
    const serviceA = makeService({
      launcher: counting.launcher,
      afterAdmission: async () => {
        admitted.enter();
        await admitted.released;
      },
    });
    const serviceB = makeService({ launcher: counting.launcher });

    const a = serviceA.runStart(buildRunStartEnvelope(ctx));
    await admitted.entered;
    const b = (await serviceB.runStart(buildRunStartEnvelope(ctx, { requestId: "req-service-b" }))) as JsonObject;
    assert.deepEqual(b.result, { runId: RUN_ID, state: "running" });
    assert.equal(counting.calls.length, 1);

    admitted.release();
    const aResult = (await a) as JsonObject;
    assert.deepEqual(aResult.result, { runId: RUN_ID, state: "running" });
    assert.equal(counting.calls.length, 1, "admission loser observes B's durable started commit");
  });
});

test("two services: a live launching owner is never stolen after the old grace window", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const launching = barrier();
    const counting = countingLauncher();
    const gatedLauncher = async (request: Parameters<typeof counting.launcher>[0]) => {
      launching.enter();
      await launching.released;
      return counting.launcher(request);
    };
    const baseTime = new Date("2026-08-07T10:00:00.000Z");
    const serviceA = makeService({ launcher: gatedLauncher, now: () => baseTime });
    const serviceB = makeService({
      launcher: gatedLauncher,
      now: () => new Date(baseTime.getTime() + 60_000),
      launchGraceMs: 1,
    });

    const a = serviceA.runStart(buildRunStartEnvelope(ctx));
    await launching.entered;
    const replay = (await serviceB.runStart(buildRunStartEnvelope(ctx, { requestId: "req-after-grace" }))) as JsonObject;
    assert.deepEqual(replay.result, { runId: RUN_ID, state: "starting" });
    assert.equal(counting.calls.length, 0, "A is still inside its first launcher call");

    launching.release();
    await a;
    assert.equal(counting.calls.length, 1, "elapsed time never creates a second launcher call");
  });
});

test("two services: hostname change on the same machine permits proven-dead owner takeover", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const claimed = barrier();
    const counting = countingLauncher();
    const ownerA = owner("owner-a", 41001, { machineId: "machine-a", hostname: "old-hostname" });
    const ownerB = owner("owner-b", 41002, { machineId: "machine-a", hostname: "new-hostname" });
    const serviceA = makeService({
      launcher: counting.launcher,
      launchOwner: ownerA,
      afterLaunchClaim: async () => {
        claimed.enter();
        await claimed.released;
      },
    });
    const serviceB = makeService({
      launcher: counting.launcher,
      launchOwner: ownerB,
      inspectLaunchOwner: (candidate) => inspectRunLaunchOwner(
        candidate,
        { machineId: ownerB.machineId!, hostname: ownerB.hostname },
        async () => candidate.ownerId === ownerA.ownerId ? "gone" : "match",
      ),
    });

    const a = serviceA.runStart(buildRunStartEnvelope(ctx));
    await claimed.entered;
    const b = (await serviceB.runStart(buildRunStartEnvelope(ctx, { requestId: "req-takeover" }))) as JsonObject;
    assert.deepEqual(b.result, { runId: RUN_ID, state: "running" });
    assert.equal(counting.calls.length, 1);
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.launchAttempt?.owner.ownerId, ownerB.ownerId);
    assert.ok(reservation.launchAttempt?.takeoverOf);

    claimed.release();
    await a;
    assert.equal(counting.calls.length, 1, "the stale A continuation revalidates its attempt token before launch");
  });
});

test("two services: a dead owner after activation is not relaunched when runtime evidence is missing", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const firstCounting = countingLauncher();
    const secondCounting = countingLauncher();
    const ownerA = owner("owner-activated", 41501);
    const ownerB = owner("owner-recovering", 41502);
    let activatedAttemptId = "";

    const serviceA = makeService({
      launcher: firstCounting.launcher,
      launchOwner: ownerA,
      afterLaunchClaim: async (reservation, attemptId) => {
        const nodeId = (await requireExecutionBinding()).nodeId;
        await appendRunEvents(
          reservation.runId,
          "0.1",
          [
            { type: "environment.materializing", payload: {}, origin: { nodeId } },
            { type: "harness.starting", payload: { operationId: reservation.runId }, origin: { nodeId } },
          ],
          { onlyIfAbsentTypes: true },
        );
        const activation = await activateRunLaunchAttempt(reservation.runId, attemptId);
        assert.equal(activation.activated, true);
        activatedAttemptId = attemptId;
        throw executionError("AUTHORITY_UNAVAILABLE", "simulated coordinator crash after launch activation");
      },
    });

    const interrupted = (await serviceA.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.equal((interrupted.error as JsonObject).code, "AUTHORITY_UNAVAILABLE");
    assert.equal(firstCounting.calls.length, 0, "crash lands after activation but before launcher invocation");
    let reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.launchAttempt?.stage, "launching");
    assert.equal(reservation.launchAttempt?.attemptId, activatedAttemptId);

    const serviceB = makeService({
      launcher: secondCounting.launcher,
      launchOwner: ownerB,
      inspectLaunchOwner: async (candidate) => candidate.ownerId === ownerA.ownerId ? "dead" : "alive",
    });
    const replay = (await serviceB.runStart(
      buildRunStartEnvelope(ctx, { requestId: "req-after-activated-owner-death" }),
    )) as JsonObject;

    assert.deepEqual(replay.result, { runId: RUN_ID, state: "lost" });
    assert.equal(secondCounting.calls.length, 0, "missing evidence never authorizes a second launcher");
    reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.launchAttempt?.owner.ownerId, ownerA.ownerId, "activated ownership is never replaced");
    assert.equal(reservation.launchAttempt?.attemptId, activatedAttemptId);
    assert.equal(reservation.launchAttempt?.takeoverOf, undefined);
    assert.equal(reservation.indeterminateCause, "readiness_evidence_missing");
    assert.ok(reservation.indeterminateAt, "the unknowable launch outcome is durable");

    const events = await readRunEvents(RUN_ID);
    assert.deepEqual(events.map((event) => event.type), [
      "run.accepted",
      "environment.materializing",
      "harness.starting",
      "run.lost",
    ]);
    assert.equal((events.at(-1)!.payload as JsonObject).cause, "readiness_evidence_missing");

    const repeated = (await serviceB.runStart(
      buildRunStartEnvelope(ctx, { requestId: "req-after-activated-owner-death-replay" }),
    )) as JsonObject;
    assert.deepEqual(repeated.result, { runId: RUN_ID, state: "lost" });
    assert.equal(secondCounting.calls.length, 0);
    assert.equal(
      (await readRunEvents(RUN_ID)).filter((event) => event.type === "run.lost").length,
      1,
      "reconciliation repairs or deduplicates the one durable loss episode",
    );
  });
});

test("cancel cannot turn an activated owner-death gap into false runtime-down proof", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const { service, control } = await createActivatedOwnerDeathWithOccupiedCopy(ctx);

    const cancelled = (await service.runCancel(
      buildOperationEnvelope(ctx, `${RUN_ID}/cancel-hidden-runtime`, { runId: RUN_ID, reason: "operator cancel" }),
    )) as JsonObject;

    assert.deepEqual(cancelled.result, { runId: RUN_ID, state: "lost" });
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result, undefined);
    assert.ok(reservation.cancel);
    assert.equal(reservation.launchOccupancyCleanup, undefined);
    assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, RUN_ID);
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0, "an absent record is not a stoppable identity");
  });
});

test("cancel arriving first cannot hide an activated dead-owner launch from inventory reconciliation", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const { service, control, recoveryLauncher } = await createActivatedOwnerDeathWithOccupiedCopy(
      ctx,
      { reconcileBeforeReturn: false },
    );

    const beforeCancel = (await readReservation(RUN_ID))!;
    assert.equal(beforeCancel.launchAttempt?.stage, "launching");
    assert.equal(beforeCancel.indeterminateAt, undefined);

    const cancelled = (await service.runCancel(
      buildOperationEnvelope(ctx, `${RUN_ID}/cancel-first-hidden-runtime`, { runId: RUN_ID, reason: "operator cancel" }),
    )) as JsonObject;
    assert.deepEqual(cancelled.result, { runId: RUN_ID, state: "starting" });
    assert.ok((await readReservation(RUN_ID))!.cancel, "the desired cancellation is durable before recovery");

    const page = await service.reconcileInventory({ limit: 8 });
    assert.equal(page.outcomes.find((outcome) => outcome.runId === RUN_ID)?.action, "reconciled");
    const reconciled = (await readReservation(RUN_ID))!;
    assert.equal(reconciled.indeterminateCause, "readiness_evidence_missing");
    assert.equal(reconciled.result, undefined);
    assert.equal(recoveryLauncher.calls.length, 0, "an activated attempt is never relaunched");
    assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, RUN_ID);
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0);

    const repeated = await service.reconcileInventory({ limit: 8 });
    assert.equal(repeated.outcomes.find((outcome) => outcome.runId === RUN_ID)?.action, "stable");
    assert.equal(recoveryLauncher.calls.length, 0);
    assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, RUN_ID);
  });
});

test("release cannot free an activated owner-death Cell without positive runtime-down proof", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const { service, control } = await createActivatedOwnerDeathWithOccupiedCopy(ctx);

    const released = (await service.runRelease(
      buildOperationEnvelope(ctx, `${RUN_ID}/release-hidden-runtime`, { runId: RUN_ID }),
    )) as JsonObject;

    assert.deepEqual(released.result, {
      environmentState: "releasing",
      steps: { completed: 0, unrecoverable: 0, pending: 4 },
      cause: "harness stop unconfirmed; cleanup fenced until a retry confirms the stop",
    });
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result, undefined);
    assert.equal(reservation.releasedAt, undefined);
    assert.equal(reservation.launchOccupancyCleanup, undefined);
    assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, RUN_ID);
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0);
  });
});

test("two services: a foreign-machine owner on the shared store is never inspected or stolen", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const claimed = barrier();
    const counting = countingLauncher();
    const foreignOwner = owner("owner-foreign", 42001, { machineId: "machine-foreign", hostname: "shared-name" });
    const localOwner = owner("owner-local", 42002, { machineId: "machine-local", hostname: "shared-name" });
    let localBirthInspections = 0;
    const serviceA = makeService({
      launcher: counting.launcher,
      launchOwner: foreignOwner,
      afterLaunchClaim: async () => {
        claimed.enter();
        await claimed.released;
      },
    });
    const serviceB = makeService({
      launcher: counting.launcher,
      launchOwner: localOwner,
      inspectLaunchOwner: (candidate) => inspectRunLaunchOwner(
        candidate,
        { machineId: localOwner.machineId!, hostname: localOwner.hostname },
        async () => {
          localBirthInspections += 1;
          return "gone";
        },
      ),
    });

    const a = serviceA.runStart(buildRunStartEnvelope(ctx));
    await claimed.entered;
    const b = (await serviceB.runStart(buildRunStartEnvelope(ctx, { requestId: "req-foreign" }))) as JsonObject;
    assert.deepEqual(b.result, { runId: RUN_ID, state: "starting" });
    assert.equal(localBirthInspections, 0, "a foreign PID is never interpreted through the local process table");
    assert.equal(counting.calls.length, 0);

    claimed.release();
    await a;
    assert.equal(counting.calls.length, 1, "only the foreign owner's original continuation launches");
  });
});

test("terminal winner before started CAS tears down A's exact runtime and is never overwritten", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const launched = barrier();
    let exactStops = 0;
    const counting = countingLauncher({
      persistSession: false,
      cleanup: async () => {
        exactStops += 1;
        return { stopped: true, detail: "exact fake incarnation stopped" };
      },
    });
    const service = makeService({
      launcher: async (request) => {
        launched.enter();
        await launched.released;
        return counting.launcher(request);
      },
    });

    const start = service.runStart(buildRunStartEnvelope(ctx));
    await launched.entered;
    await commitRunTerminalResult(
      RUN_ID,
      { outcome: "failed", cause: "terminal_winner", failureCause: "terminal_winner" },
    );
    launched.release();
    const response = (await start) as JsonObject;

    assert.deepEqual(response.result, { runId: RUN_ID, state: "failed" });
    assert.equal(exactStops, 1);
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result?.cause, "terminal_winner");
    assert.equal(reservation.sessionRef, undefined, "stale started facts never overwrite the terminal winner");
    assert.ok(!(await readRunEvents(RUN_ID)).some((event) => event.type === "harness.running"));
  });
});

test("lost started CAS with unconfirmed exact cleanup remains visibly indeterminate", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const launched = barrier();
    const counting = countingLauncher({
      persistSession: false,
      cleanup: async () => ({ stopped: false, detail: "absence unconfirmed" }),
    });
    const service = makeService({
      launcher: async (request) => {
        launched.enter();
        await launched.released;
        return counting.launcher(request);
      },
    });

    const start = service.runStart(buildRunStartEnvelope(ctx));
    await launched.entered;
    await commitRunTerminalResult(
      RUN_ID,
      { outcome: "failed", cause: "terminal_winner", failureCause: "terminal_winner" },
    );
    launched.release();
    const response = (await start) as JsonObject;

    assert.deepEqual(response.result, { runId: RUN_ID, state: "lost" });
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result?.cause, "terminal_winner");
    assert.equal(reservation.indeterminateCause, "launch_commit_cleanup_unconfirmed");
    assert.ok((await readRunEvents(RUN_ID)).some((event) => event.type === "run.lost"));
  });
});
