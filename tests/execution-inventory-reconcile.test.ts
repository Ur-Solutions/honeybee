import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { JsonObject } from "../src/execution/contract.js";
import {
  mutateReservation,
  readEffectIndex,
  readReservation,
  runDir,
  writeEffectIndex,
} from "../src/execution/runStore.js";
import {
  buildRunStartEnvelope,
  countingLauncher,
  installTestAuthority,
  makeService,
  withTempStore,
} from "./executionTestKit.js";

test("daemon inventory resumes a post-admission crash from the exact durable validated lease", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const envelope = buildRunStartEnvelope(ctx);
    const admitting = makeService({
      afterAdmission: () => {
        throw new Error("simulated coordinator exit after durable admission");
      },
    });
    const interrupted = await admitting.runStart(envelope);
    assert.equal((interrupted.error as JsonObject).code, "AUTHORITY_UNAVAILABLE");
    const admitted = (await readReservation("run-0001"))!;
    assert.equal(admitted.phase, "reserved");
    assert.deepEqual(admitted.lease, (envelope.body as JsonObject).lease, "only the signed admitted lease is retained");
    await writeEffectIndex({
      effectKey: admitted.effectKey,
      requestDigest: admitted.requestDigest,
      runId: admitted.runId,
      method: "run.start",
      phase: "pending",
    });

    const counting = countingLauncher();
    const restarted = makeService({ launcher: counting.launcher });
    const page = await restarted.reconcileInventory({ limit: 8 });

    assert.equal(counting.calls.length, 1, "a fresh node coordinator finishes the never-invoked launch");
    assert.equal((await readReservation("run-0001"))!.phase, "started");
    assert.equal((await readEffectIndex(admitted.effectKey))?.phase, "committed", "inventory repairs the indexed admission crash gap first");
    assert.equal(page.outcomes.find((outcome) => outcome.runId === "run-0001")?.action, "resumed");
  });
});

test("daemon inventory never relaunches an activated owner-death window with no SessionRecord", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const admitting = makeService({
      afterAdmission: () => {
        throw new Error("simulated coordinator exit after durable admission");
      },
    });
    await admitting.runStart(buildRunStartEnvelope(ctx));
    await mutateReservation("run-0001", (record) => ({
      ...record,
      phase: "launching",
      launchAttemptedAt: new Date().toISOString(),
      launchAttempt: {
        attemptId: "activated-attempt",
        stage: "launching",
        claimedAt: new Date().toISOString(),
        owner: {
          ownerId: "dead-coordinator",
          pid: 999_999,
          machineId: "test-machine",
          hostname: "test-host",
          processFingerprint: { pgid: 999_999, startedAt: "dead-process-birth" },
        },
      },
    }));

    const counting = countingLauncher({ persistSession: false });
    const restarted = makeService({
      launcher: counting.launcher,
      inspectLaunchOwner: async () => "dead",
    });
    const page = await restarted.reconcileInventory({ limit: 8 });

    assert.equal(counting.calls.length, 0, "activation is the irreversible launcher fence even when the owner is dead");
    const durable = (await readReservation("run-0001"))!;
    assert.equal(durable.phase, "launching");
    assert.equal(durable.indeterminateCause, "readiness_evidence_missing");
    assert.equal(page.outcomes.find((outcome) => outcome.runId === "run-0001")?.action, "reconciled");
  });
});

test("daemon inventory takes over only a proven-dead preparing launch owner", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const admitting = makeService({
      afterAdmission: () => {
        throw new Error("simulated coordinator exit after durable admission");
      },
    });
    await admitting.runStart(buildRunStartEnvelope(ctx));
    await mutateReservation("run-0001", (record) => ({
      ...record,
      phase: "launching",
      launchAttemptedAt: new Date().toISOString(),
      launchAttempt: {
        attemptId: "preparing-attempt",
        stage: "preparing",
        claimedAt: new Date().toISOString(),
        owner: {
          ownerId: "dead-preparing-coordinator",
          pid: 999_998,
          machineId: "test-machine",
          hostname: "test-host",
          processFingerprint: { pgid: 999_998, startedAt: "dead-preparing-birth" },
        },
      },
    }));

    const counting = countingLauncher();
    const restarted = makeService({
      launcher: counting.launcher,
      inspectLaunchOwner: async () => "dead",
    });
    await restarted.reconcileInventory({ limit: 8 });

    assert.equal(counting.calls.length, 1);
    const durable = (await readReservation("run-0001"))!;
    assert.equal(durable.phase, "started");
    assert.equal(durable.launchAttempt?.takeoverOf, "preparing-attempt");
  });
});

test("one corrupt reservation is isolated and cannot abort later inventory obligations", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const admitting = makeService({
      afterAdmission: () => {
        throw new Error("leave both reservations admitted");
      },
    });
    await admitting.runStart(buildRunStartEnvelope(ctx, { runId: "run-corrupt", jobId: "job-corrupt" }));
    await admitting.runStart(buildRunStartEnvelope(ctx, { runId: "run-healthy", jobId: "job-healthy" }));
    await writeFile(`${runDir("run-corrupt")}/reservation.json`, "{ torn reservation", "utf8");

    const counting = countingLauncher();
    const restarted = makeService({ launcher: counting.launcher });
    const page = await restarted.reconcileInventory({ limit: 8 });

    assert.equal(page.outcomes.some((outcome) => outcome.action === "error" && outcome.directory.includes("run-corrupt")), true);
    assert.equal(page.outcomes.find((outcome) => outcome.runId === "run-healthy")?.action, "resumed");
    assert.deepEqual(counting.calls.map((call) => call.runId), ["run-healthy"]);
    assert.equal((await readReservation("run-healthy"))!.phase, "started");
  });
});
