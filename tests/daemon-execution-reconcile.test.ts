import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createExecutionInventoryDispatcher,
} from "../src/daemon/executionReconcile.js";

test("daemon execution inventory is detached, bounded, cursor-driven, and restarts from durable head", async () => {
  let nowMs = 1_000;
  const jobs: Array<() => Promise<void>> = [];
  const calls: Array<{ afterDirectory?: string; limit?: number }> = [];
  const service = {
    async reconcileInventory(options: { afterDirectory?: string; limit?: number } = {}) {
      calls.push(options);
      return {
        outcomes: [{
          runId: options.afterDirectory ? "run-b" : "run-a",
          directory: options.afterDirectory ? "run-b-dir" : "run-a-dir",
          action: "reconciled" as const,
          phase: "started" as const,
        }],
        nextAfterDirectory: options.afterDirectory ? null : "run-a-dir",
      };
    },
  };
  const dispatcher = createExecutionInventoryDispatcher({
    service: () => service,
    now: () => nowMs,
    intervalMs: 100,
    batchSize: 7,
    startBackground: (job) => jobs.push(job),
  });

  assert.deepEqual(await dispatcher(), [], "tick-facing call never awaits the inventory work");
  assert.equal(jobs.length, 1);
  assert.equal(calls.length, 0);
  await jobs.shift()!();

  assert.deepEqual((await dispatcher()).map((outcome) => outcome.runId), ["run-a"]);
  assert.deepEqual(calls, [{ limit: 7 }]);
  assert.equal(jobs.length, 0, "settlement interval is a retry backoff, not a hot loop");

  nowMs += 100;
  assert.deepEqual(await dispatcher(), []);
  await jobs.shift()!();
  assert.deepEqual(calls[1], { afterDirectory: "run-a-dir", limit: 7 });
  assert.deepEqual((await dispatcher()).map((outcome) => outcome.runId), ["run-b"]);

  // A new daemon owns no ephemeral cursor. It starts at the durable inventory
  // head, so obligations need no client reconnect and no in-memory queue to
  // survive process restart.
  const restartedJobs: Array<() => Promise<void>> = [];
  const restarted = createExecutionInventoryDispatcher({
    service: () => service,
    now: () => nowMs,
    intervalMs: 100,
    batchSize: 7,
    startBackground: (job) => restartedJobs.push(job),
  });
  assert.deepEqual(await restarted(), []);
  await restartedJobs.shift()!();
  assert.deepEqual(calls.at(-1), { limit: 7 });

  await restarted.close();
  nowMs += 100;
  assert.deepEqual((await restarted()).map((outcome) => outcome.runId), ["run-a"]);
  assert.equal(restartedJobs.length, 0, "closed daemon lane never schedules new work");
});

test("daemon execution inventory isolates a rejected page and retries after its bounded interval", async () => {
  let nowMs = 0;
  const jobs: Array<() => Promise<void>> = [];
  let attempts = 0;
  const dispatcher = createExecutionInventoryDispatcher({
    service: () => ({
      async reconcileInventory() {
        attempts += 1;
        throw new Error("transient execution store outage");
      },
    }),
    now: () => nowMs,
    intervalMs: 50,
    startBackground: (job) => jobs.push(job),
  });

  await dispatcher();
  await jobs.shift()!();
  const [failure] = await dispatcher();
  assert.equal(failure?.action, "error");
  assert.match(failure?.error ?? "", /transient execution store outage/);
  assert.equal(attempts, 1);

  nowMs = 49;
  await dispatcher();
  assert.equal(jobs.length, 0);
  nowMs = 50;
  await dispatcher();
  assert.equal(jobs.length, 1);
});

test("daemon shutdown waits for an already-running execution page before ownership can hand off", async () => {
  const jobs: Array<() => Promise<void>> = [];
  let entered!: () => void;
  const didEnter = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sideEffectActive = false;
  const dispatcher = createExecutionInventoryDispatcher({
    service: () => ({
      async reconcileInventory() {
        sideEffectActive = true;
        entered();
        await gate;
        sideEffectActive = false;
        return { outcomes: [], nextAfterDirectory: null };
      },
    }),
    startBackground: (job) => jobs.push(job),
  });

  await dispatcher();
  const running = jobs.shift();
  assert.ok(running);
  const runningPromise = running();
  await didEnter;
  assert.equal(sideEffectActive, true);

  let closeSettled = false;
  const closing = dispatcher.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false, "daemon ownership cannot hand off over a live launch/cleanup page");

  release();
  await Promise.all([runningPromise, closing]);
  assert.equal(sideEffectActive, false);
  assert.equal(closeSettled, true);
  assert.deepEqual(await dispatcher(), [], "closed owner schedules no successor page");
});
