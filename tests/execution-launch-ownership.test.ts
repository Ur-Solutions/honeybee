import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/execution/contract.js";
import {
  commitRunTerminalResult,
  readReservation,
  readRunEvents,
  type RunLaunchOwner,
} from "../src/execution/runStore.js";
import {
  buildRunStartEnvelope,
  countingLauncher,
  installTestAuthority,
  makeService,
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

function owner(ownerId: string, pid: number): RunLaunchOwner {
  return {
    ownerId,
    pid,
    hostname: "test-host",
    processFingerprint: { pgid: pid, startedAt: `birth-${pid}` },
  };
}

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

test("two services: a proven-dead birth-fenced owner permits one takeover", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const claimed = barrier();
    const counting = countingLauncher();
    const ownerA = owner("owner-a", 41001);
    const ownerB = owner("owner-b", 41002);
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
      inspectLaunchOwner: async (candidate) => candidate.ownerId === ownerA.ownerId ? "dead" : "alive",
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
