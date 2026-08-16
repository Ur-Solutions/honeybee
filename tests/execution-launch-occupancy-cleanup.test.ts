import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { JsonObject } from "../src/execution/contract.js";
import { executionError } from "../src/execution/errors.js";
import { createHsrRunLauncher } from "../src/execution/launcher.js";
import { deliverSessionText } from "../src/delivery.js";
import { executionRoot } from "../src/execution/nodeState.js";
import {
  beeNameForRun,
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
import { HsrDeliveryAmbiguousError } from "../src/hsr/pendingTurns.js";
import { readBeeRequests } from "../src/requests/store.js";
import { loadSession, saveSession } from "../src/store.js";
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

test("prompt failure after runtime publication exact-stops the Bee before releasing occupancy", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    let live = true;
    let stopCalls = 0;
    const beeName = beeNameForRun("run-0001");
    const runnerFingerprint = { pgid: 43124, startedAt: "Fri Aug 15 12:00:00 2026" };
    const runtime: SpawnedRuntimeHandle = {
      identity: {
        kind: "hsr",
        beeName,
        hostPid: 43124,
        hostFingerprint: runnerFingerprint,
      },
      stop: async () => {
        stopCalls += 1;
        live = false;
        return { stopped: true, detail: "exact injected runtime stopped" };
      },
    };
    const launcher = createHsrRunLauncher({
      nodeId: async () => ctx.nodeId,
      spawn: async (request, _config, cwd, onRuntimeLaunched) => {
        const at = new Date().toISOString();
        await saveSession({
          name: request.beeName,
          agent: "claude",
          cwd,
          command: "claude",
          tmuxTarget: request.beeName,
          substrate: "hsr",
          runnerPid: runtime.identity.hostPid,
          runnerFingerprint,
          createdAt: at,
          updatedAt: at,
          status: "running",
          id: "CO.post-publication",
          executionRunId: request.runId,
        });
        await onRuntimeLaunched?.(runtime);
        throw new Error("injected positional prompt delivery failure");
      },
    });
    const service = makeService({ launcher });

    const result = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.deepEqual(result.result, { runId: "run-0001", state: "failed" });
    assert.equal(stopCalls, 1, "the exact published runtime is stopped once");
    assert.equal(live, false, "no live Bee survives a definite launcher failure");
    assert.equal(await loadSession(beeName), null, "the stopped execution generation cannot be auto-revived");
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy, undefined);
    const reservation = (await readReservation("run-0001"))!;
    assert.equal(reservation.launchOccupancyCleanup?.proof, "launcher-definite-failure");
    assert.equal(reservation.launchOccupancyCleanup?.state, "released");
  });
});

test("unconfirmed cleanup after post-publication prompt failure stays lost and retains occupancy", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    const beeName = beeNameForRun("run-0001");
    const runnerFingerprint = { pgid: 43125, startedAt: "Fri Aug 15 12:00:01 2026" };
    const runtime: SpawnedRuntimeHandle = {
      identity: {
        kind: "hsr",
        beeName,
        hostPid: 43125,
        hostFingerprint: runnerFingerprint,
      },
      stop: async () => ({ stopped: false, detail: "injected exact stop doubt" }),
    };
    const launcher = createHsrRunLauncher({
      nodeId: async () => ctx.nodeId,
      spawn: async (request, _config, cwd, onRuntimeLaunched) => {
        const at = new Date().toISOString();
        await saveSession({
          name: request.beeName,
          agent: "claude",
          cwd,
          command: "claude",
          tmuxTarget: request.beeName,
          substrate: "hsr",
          runnerPid: runtime.identity.hostPid,
          runnerFingerprint,
          createdAt: at,
          updatedAt: at,
          status: "running",
          id: "CO.post-publication-doubt",
          executionRunId: request.runId,
        });
        await onRuntimeLaunched?.(runtime);
        throw new Error("injected positional prompt delivery failure");
      },
    });
    const service = makeService({ launcher });

    const result = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.deepEqual(result.result, { runId: "run-0001", state: "lost" });
    const reservation = (await readReservation("run-0001"))!;
    assert.equal(reservation.indeterminateCause, "spawn_cleanup_unconfirmed");
    assert.equal(reservation.launchOccupancyCleanup, undefined);
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy?.claimedByRunId, "run-0001");
    assert.equal((await loadSession(beeName))?.status, "kill_failed");
  });
});

test("ambiguous initial delivery stays lost and occupied even after exact runtime stop", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    const beeName = beeNameForRun("run-0001");
    const runnerFingerprint = { pgid: 43126, startedAt: "Fri Aug 15 12:00:02 2026" };
    let stops = 0;
    const runtime: SpawnedRuntimeHandle = {
      identity: { kind: "hsr", beeName, hostPid: 43126, hostFingerprint: runnerFingerprint },
      stop: async () => {
        stops += 1;
        return { stopped: true, detail: "exact runtime stopped after ambiguous acceptance" };
      },
    };
    const launcher = createHsrRunLauncher({
      nodeId: async () => ctx.nodeId,
      spawn: async (request, _config, cwd, onRuntimeLaunched) => {
        const at = new Date().toISOString();
        await saveSession({
          name: request.beeName,
          agent: "claude",
          cwd,
          command: "claude",
          tmuxTarget: request.beeName,
          substrate: "hsr",
          runnerPid: runtime.identity.hostPid,
          runnerFingerprint,
          createdAt: at,
          updatedAt: at,
          status: "running",
          id: "CO.initial-delivery-ambiguous",
          executionRunId: request.runId,
        });
        await onRuntimeLaunched?.(runtime);
        throw new HsrDeliveryAmbiguousError(
          "delivery:initial-ambiguous",
          "provider accepted the initial turn but its RPC reply was lost",
        );
      },
    });
    const service = makeService({ launcher });

    const response = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.deepEqual(response.result, { runId: "run-0001", state: "lost" });
    assert.equal(stops, 1);
    assert.equal((await readReservation("run-0001"))?.indeterminateCause, "initial_delivery_ambiguous");
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))?.occupancy?.claimedByRunId, "run-0001");
    assert.equal((await loadSession(beeName))?.status, "kill_failed", "ambiguous turn evidence remains non-runnable and collectable");
  });
});

test("accepted initial delivery with failed SessionRecord metadata publication stays lost and occupied", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    const beeName = beeNameForRun("run-0001");
    const runnerFingerprint = { pgid: 43129, startedAt: "Fri Aug 15 12:00:04 2026" };
    let accepted = 0;
    let stops = 0;
    const runtime: SpawnedRuntimeHandle = {
      identity: { kind: "hsr", beeName, hostPid: 43129, hostFingerprint: runnerFingerprint },
      stop: async () => {
        stops += 1;
        return { stopped: true, detail: "exact runtime stopped after accepted turn metadata fault" };
      },
    };
    const launcher = createHsrRunLauncher({
      nodeId: async () => ctx.nodeId,
      spawn: async (request, _config, cwd, onRuntimeLaunched) => {
        const at = new Date().toISOString();
        const published = {
          name: request.beeName,
          agent: "claude",
          cwd,
          command: "claude",
          tmuxTarget: request.beeName,
          substrate: "hsr" as const,
          runnerPid: runtime.identity.hostPid,
          runnerFingerprint,
          createdAt: at,
          updatedAt: at,
          status: "running" as const,
          id: "CO.initial-metadata-ambiguous",
          executionRunId: request.runId,
        };
        await saveSession(published);
        await onRuntimeLaunched?.(runtime);
        await deliverSessionText(published, "accepted initial execution brief", {
          deliveryId: "delivery:execution-initial-metadata-fault",
          deliver: async () => { accepted += 1; },
          metadata: () => { throw new Error("injected post-accept metadata publication failure"); },
        });
        throw new Error("delivery metadata fault should have remained typed");
      },
    });
    const service = makeService({ launcher });

    const response = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.deepEqual(response.result, { runId: "run-0001", state: "lost" });
    assert.equal(accepted, 1, "the provider-facing handoff crossed exactly once");
    assert.equal(stops, 1);
    assert.equal((await readReservation("run-0001"))?.indeterminateCause, "initial_delivery_ambiguous");
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))?.occupancy?.claimedByRunId, "run-0001");
    assert.equal((await loadSession(beeName))?.status, "kill_failed");
    assert.ok((await readBeeRequests(beeName)).some((request) =>
      request.status === "open"
      && request.evidence.source === "hsr-delivery"
      && (request.input as { deliveryId?: unknown } | undefined)?.deliveryId
        === "delivery:execution-initial-metadata-fault"));
  });
});

test("crash after execution stop dispatch leaves Run lost, occupied, and Bee non-runnable", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    const beeName = beeNameForRun("run-0001");
    const runnerFingerprint = { pgid: 43127, startedAt: "Fri Aug 15 12:00:03 2026" };
    const runtime: SpawnedRuntimeHandle = {
      identity: { kind: "hsr", beeName, hostPid: 43127, hostFingerprint: runnerFingerprint },
      stop: async () => {
        assert.equal((await loadSession(beeName))?.status, "kill_failed", "fence is durable before stop dispatch");
        return { stopped: true, detail: "exact runtime stopped" };
      },
    };
    const launcher = createHsrRunLauncher({
      nodeId: async () => ctx.nodeId,
      afterRuntimeStopDispatch: async () => { throw new Error("injected coordinator crash after signal"); },
      spawn: async (request, _config, cwd, onRuntimeLaunched) => {
        const at = new Date().toISOString();
        await saveSession({
          name: request.beeName,
          agent: "claude",
          cwd,
          command: "claude",
          tmuxTarget: request.beeName,
          substrate: "hsr",
          runnerPid: runtime.identity.hostPid,
          runnerFingerprint,
          createdAt: at,
          updatedAt: at,
          status: "running",
          id: "CO.stop-dispatch-crash",
          executionRunId: request.runId,
        });
        await onRuntimeLaunched?.(runtime);
        throw new Error("injected post-publication failure");
      },
    });
    const service = makeService({ launcher });

    const response = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.deepEqual(response.result, { runId: "run-0001", state: "lost" });
    assert.equal((await loadSession(beeName))?.status, "kill_failed");
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))?.occupancy?.claimedByRunId, "run-0001");
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

test("a carried exact fresh-publication rollback is not stopped twice and releases occupancy", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await registerRunCopy();
    let duplicateStops = 0;
    const runtime: SpawnedRuntimeHandle = {
      identity: { kind: "hsr", beeName: beeNameForRun("run-0001"), hostPid: 43128 },
      stop: async () => {
        duplicateStops += 1;
        return { stopped: false, detail: "run state was already exactly purged" };
      },
    };
    const launcher = createHsrRunLauncher({
      nodeId: async () => ctx.nodeId,
      spawn: async () => {
        throw new SpawnAfterForkError(
          "session-save",
          runtime,
          { stopped: true, detail: "exact launched HSR incarnation stop confirmed" },
          new Error("session save surfaced after exact rollback"),
          { settled: true, detail: "canonical row, run state, and launch journal purged" },
        );
      },
    });
    const service = makeService({ launcher });

    const result = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assert.deepEqual(result.result, { runId: "run-0001", state: "failed" });
    assert.equal(duplicateStops, 0, "the consumed exact rollback proof prevents an unprovable second stop");
    assert.equal(await loadSession(beeNameForRun("run-0001")), null);
    assert.equal((await readWorkingCopy(WORKING_COPY_ID))!.occupancy, undefined);
    assert.equal((await readReservation("run-0001"))?.launchOccupancyCleanup?.proof, "launcher-definite-failure");
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
