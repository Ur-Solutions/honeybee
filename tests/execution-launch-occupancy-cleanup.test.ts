import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { JsonObject } from "../src/execution/contract.js";
import { executionError } from "../src/execution/errors.js";
import { createHsrRunLauncher } from "../src/execution/launcher.js";
import { executionRoot } from "../src/execution/nodeState.js";
import {
  mutateReservation,
  readReservation,
  reconcileRunLaunchOccupancyCleanup,
} from "../src/execution/runStore.js";
import {
  claimWorkingCopy,
  readWorkingCopy,
  registerWorkingCopy,
  withWorkingCopyOccupancyLock,
} from "../src/execution/workingCopies.js";
import { SpawnAfterForkError, type SpawnedRuntimeHandle } from "../src/spawnRuntime.js";
import { saveSession } from "../src/store.js";
import {
  buildRunStartEnvelope,
  countingLauncher,
  installTestAuthority,
  makeService,
  SNAPSHOT_DIGEST,
  withTempStore,
} from "./executionTestKit.js";

const WORKING_COPY_ID = "wc-0001";

async function registerRunCopy(path = "/tmp/honeybee-failed-launch-copy"): Promise<void> {
  await registerWorkingCopy({
    workingCopyId: WORKING_COPY_ID,
    productId: "prod-honeycomb-app",
    path,
    snapshotDigest: SNAPSHOT_DIGEST,
    origin: "https://git.example.com/acme/honeycomb-app.git",
    revision: "3f9c2b7d1a6e4f0c9b8a7d6e5f4c3b2a1d0e9f8c",
  });
}

test("definite spawn failure durably releases occupancy before run.start returns", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    let spawnCalls = 0;
    const launcher = createHsrRunLauncher({
      nodeId: async () => ctx.nodeId,
      spawn: async () => {
        spawnCalls += 1;
        throw new Error("account resolution refused before host fork");
      },
    });
    const service = makeService({ launcher });

    const first = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.deepEqual(first.result, { runId: "run-0001", state: "failed" });
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy, undefined);
    const firstReservation = (await readReservation("run-0001"))!;
    assert.equal(firstReservation.launchOccupancyCleanup?.proof, "launcher-definite-failure");
    assert.equal(firstReservation.launchOccupancyCleanup?.state, "released");

    // No caller-issued run.release is needed before the same locator can serve
    // a successor Run. The second failed attempt compensates independently.
    const second = (await service.runStart(buildRunStartEnvelope(ctx, { runId: "run-0002" }))) as JsonObject;
    assert.deepEqual(second.result, { runId: "run-0002", state: "failed" });
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy, undefined);
    assert.equal(spawnCalls, 2);
  });
});

test("post-fork ambiguity stays lost and never releases the possibly-live runtime's copy", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    const runtime: SpawnedRuntimeHandle = {
      identity: { kind: "hsr", beeName: "xr-ambiguous", hostPid: process.pid },
      stop: async () => ({ stopped: false, detail: "exact host identity cannot be confirmed down" }),
    };
    const launcher = createHsrRunLauncher({
      nodeId: async () => ctx.nodeId,
      spawn: async () => {
        throw new SpawnAfterForkError(
          "runtime-publish",
          runtime,
          { stopped: false, detail: "exact host identity cannot be confirmed down" },
          new Error("coordinator connection dropped after fork"),
        );
      },
    });
    const service = makeService({ launcher });

    const first = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.deepEqual(first.result, { runId: "run-0001", state: "lost" });
    let reservation = (await readReservation("run-0001"))!;
    assert.equal(reservation.indeterminateCause, "spawn_cleanup_unconfirmed");
    assert.equal(reservation.launchOccupancyCleanup, undefined);
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy?.claimedByRunId, "run-0001");

    const restarted = makeService({ launcher: countingLauncher().launcher });
    const replay = (await restarted.runStart(
      buildRunStartEnvelope(ctx, { requestId: "req-replay-after-ambiguous-fork" }),
    )) as JsonObject;
    assert.deepEqual(replay.result, { runId: "run-0001", state: "lost" });
    reservation = (await readReservation("run-0001"))!;
    assert.equal(reservation.launchOccupancyCleanup, undefined);
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy?.claimedByRunId, "run-0001");

    // Once durable outcome evidence proves that exact Run is down, the lost
    // episode may terminalize and the same compensation becomes safe.
    const observedAt = new Date().toISOString();
    await saveSession({
      name: reservation.beeName,
      agent: "claude",
      cwd: "/tmp/honeybee-failed-launch-copy",
      command: "claude",
      tmuxTarget: reservation.beeName,
      substrate: "hsr",
      createdAt: observedAt,
      updatedAt: observedAt,
      status: "dead",
      id: "CO.proven-dead-after-ambiguous-fork",
      executionRunId: "run-0001",
    });
    const provenDown = await restarted.runGet({ protocolVersion: "0.1", runId: "run-0001" });
    assert.ok("result" in provenDown);
    assert.equal(provenDown.result.state, "failed");
    reservation = (await readReservation("run-0001"))!;
    assert.equal(reservation.launchOccupancyCleanup?.proof, "runtime-down");
    assert.equal(reservation.launchOccupancyCleanup?.state, "released");
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy, undefined);
  });
});

test("restart completes a durable pending cleanup exactly once after release persistence recovers", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    const registryPath = join(executionRoot(), "working-copies.json");
    let healthyRegistry = "";
    const launcher = async ({ runId }: { runId: string }) => {
      await claimWorkingCopy(WORKING_COPY_ID, runId);
      healthyRegistry = await readFile(registryPath, "utf8");
      // Model a restartable authority-store outage after the terminal result
      // and cleanup intent can be persisted but before occupancy release.
      await writeFile(registryPath, "{ interrupted working-copy registry", "utf8");
      throw executionError("HARNESS_UNAVAILABLE", "spawn refused with no runtime");
    };
    const firstService = makeService({ launcher });
    const interrupted = (await firstService.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.equal((interrupted.error as JsonObject).code, "AUTHORITY_UNAVAILABLE");
    const pending = (await readReservation("run-0001"))!;
    assert.equal(pending.result?.outcome, "failed", "terminal fact survives the cleanup-store outage");
    assert.equal(pending.launchOccupancyCleanup?.state, "pending");

    await writeFile(registryPath, healthyRegistry, "utf8");
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy?.claimedByRunId, "run-0001");

    const counting = countingLauncher();
    const restarted = makeService({ launcher: counting.launcher });
    const recovered = await restarted.reconcileInventory({ limit: 8 });
    assert.equal(recovered.outcomes.find((outcome) => outcome.runId === "run-0001")?.action, "reconciled");
    assert.equal(counting.calls.length, 0, "restart reconciles cleanup without relaunching");
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy, undefined);
    const completed = (await readReservation("run-0001"))!;
    assert.equal(completed.launchOccupancyCleanup?.state, "released");
    const releasedAt = completed.launchOccupancyCleanup?.releasedAt;
    const registryAfterRelease = await readFile(registryPath, "utf8");

    await restarted.reconcileInventory({ limit: 8 });
    assert.equal((await readReservation("run-0001"))!.launchOccupancyCleanup?.releasedAt, releasedAt);
    assert.equal(
      await readFile(registryPath, "utf8"),
      registryAfterRelease,
      "a completed compensation is not reissued on later reconciliation",
    );
  });
});

test("pending cleanup never holds admission while waiting for the per-copy lock", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    const registryPath = join(executionRoot(), "working-copies.json");
    let healthyRegistry = "";
    const launcher = async ({ runId }: { runId: string }) => {
      await claimWorkingCopy(WORKING_COPY_ID, runId);
      healthyRegistry = await readFile(registryPath, "utf8");
      await writeFile(registryPath, "{ interrupted working-copy registry", "utf8");
      throw executionError("HARNESS_UNAVAILABLE", "spawn refused with no runtime");
    };
    const service = makeService({ launcher });
    await service.runStart(buildRunStartEnvelope(ctx));
    const pending = (await readReservation("run-0001"))!;
    assert.equal(pending.launchOccupancyCleanup?.state, "pending");
    await writeFile(registryPath, healthyRegistry, "utf8");

    let cleanup!: Promise<unknown>;
    let admissionMutation!: Promise<unknown>;
    let admissionProgressedWhileCopyLocked = false;
    await withWorkingCopyOccupancyLock(WORKING_COPY_ID, async () => {
      cleanup = reconcileRunLaunchOccupancyCleanup(pending);
      // Let cleanup reach the occupied per-copy lock. If it retained the
      // admission lock while waiting, the no-op reservation mutation below
      // could not finish until this callback returned: a lock-order cycle with
      // run.collect's existing per-copy -> admission transaction.
      await delay(75);
      admissionMutation = mutateReservation("run-0001", (current) => current);
      admissionProgressedWhileCopyLocked = await Promise.race([
        admissionMutation.then(() => true),
        delay(500).then(() => false),
      ]);
    });
    await Promise.all([cleanup, admissionMutation]);

    assert.equal(admissionProgressedWhileCopyLocked, true);
    assert.equal((await readReservation("run-0001"))!.launchOccupancyCleanup?.state, "released");
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy, undefined);
  });
});
