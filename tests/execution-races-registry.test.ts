// H3 hardening: single-flight effect progression under concurrent identical
// replays, fail-closed recovery for lost operation records, and full
// local-core-v1 method registration on the RPC surface.
import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadExecutionContract, type JsonObject } from "../src/execution/contract.js";
import { executionRoot } from "../src/execution/nodeState.js";
import { createExecutionRpcMethods } from "../src/execution/rpcMethods.js";
import { effectKeyHash, runKey } from "../src/execution/runStore.js";
import type { ExecutionService } from "../src/execution/service.js";
import {
  buildOperationEnvelope,
  buildRunStartEnvelope,
  countingLauncher,
  fakeControl,
  installTestAuthority,
  makeService,
  withTempStore,
} from "./executionTestKit.js";

const RUN_ID = "run-0001";

async function startRunning() {
  const ctx = await installTestAuthority();
  const control = fakeControl();
  const service = makeService({ launcher: countingLauncher().launcher, control: control.control });
  await service.runStart(buildRunStartEnvelope(ctx));
  return { ctx, control, service };
}

test("concurrent identical run.command replays dispatch exactly once and share one receipt", async () => {
  await withTempStore(async () => {
    const { ctx, control, service } = await startRunning();
    const body: JsonObject = { runId: RUN_ID, command: { kind: "send", text: "race" } };
    const first = buildOperationEnvelope(ctx, `${RUN_ID}/command/send-race`, body, { requestId: "req-a" });
    const second = buildOperationEnvelope(ctx, `${RUN_ID}/command/send-race`, body, { requestId: "req-b" });

    const [a, b] = (await Promise.all([service.runCommand(first), service.runCommand(second)])) as JsonObject[];
    assert.equal((a!.result as JsonObject).commandState, "completed");
    assert.equal((b!.result as JsonObject).commandState, "completed");
    assert.equal((a!.receipt as JsonObject).receiptId, (b!.receipt as JsonObject).receiptId);
    assert.equal(control.calls.filter((call) => call.method === "send").length, 1, "exactly one delivery");
  });
});

test("concurrent identical run.cancel and run.release progress once (one stop each)", async () => {
  await withTempStore(async () => {
    const { ctx, control, service } = await startRunning();
    const cancelBody: JsonObject = { runId: RUN_ID, reason: "race" };
    await Promise.all([
      service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, cancelBody, { requestId: "req-c1" })),
      service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, cancelBody, { requestId: "req-c2" })),
    ]);
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 1, "cancel stops once");

    const releaseBody: JsonObject = { runId: RUN_ID };
    const [r1, r2] = (await Promise.all([
      service.runRelease(buildOperationEnvelope(ctx, `${RUN_ID}/release`, releaseBody, { requestId: "req-r1" })),
      service.runRelease(buildOperationEnvelope(ctx, `${RUN_ID}/release`, releaseBody, { requestId: "req-r2" })),
    ])) as JsonObject[];
    assert.deepEqual(r1!.result, r2!.result);
    // The run was already cancelled (terminal, session stopped by cancel), so
    // release's harness-stop step must not stop again.
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 1);
  });
});

test("a lost operation record with a surviving effect index fails closed instead of re-executing", async () => {
  await withTempStore(async () => {
    const { ctx, control, service } = await startRunning();
    const body: JsonObject = { runId: RUN_ID, command: { kind: "send", text: "once" } };
    const envelope = buildOperationEnvelope(ctx, `${RUN_ID}/command/send-lost`, body);
    const first = (await service.runCommand(envelope)) as JsonObject;
    assert.equal((first.result as JsonObject).commandState, "completed");
    assert.equal(control.calls.filter((call) => call.method === "send").length, 1);

    // Simulate a lost/deleted record (cannot arise from any legitimate crash:
    // the record is always written before the index).
    await rm(join(executionRoot(), "runs", runKey(RUN_ID), "ops", `${effectKeyHash(`${RUN_ID}/command/send-lost`)}.json`));

    const retry = (await service.runCommand(
      buildOperationEnvelope(ctx, `${RUN_ID}/command/send-lost`, body, { requestId: "req-lost-2" }),
    )) as JsonObject;
    assert.equal((retry.error as JsonObject).code, "AUTHORITY_UNAVAILABLE");
    assert.equal(control.calls.filter((call) => call.method === "send").length, 1, "never redelivered");
  });
});

test("every local-core-v1 method in the corpus profile is registered on the RPC surface", () => {
  const contract = loadExecutionContract();
  const profiles = contract.profile.profiles as JsonObject;
  const localCore = profiles["local-core-v1"] as JsonObject;
  const methods = (localCore.methods as JsonObject[]).map((entry) => String(entry.method));
  const registered = createExecutionRpcMethods(() => {
    throw new Error("service is not needed for registration checks");
  }).methods;
  for (const method of methods) {
    assert.ok(method in registered, `method ${method} is not registered`);
  }
});

test("rpc lazy service: a rejected bootstrap is retried on the next call, not cached forever", async () => {
  await withTempStore(async () => {
    await installTestAuthority();
    let factoryCalls = 0;
    const rpc = createExecutionRpcMethods(() => {
      factoryCalls += 1;
      if (factoryCalls === 1) return Promise.reject(new Error("transient bootstrap failure"));
      return makeService();
    });
    const ctx = { connectionId: 1, close: () => undefined };

    // First call surfaces the bootstrap failure...
    await assert.rejects(Promise.resolve(rpc.methods["run.get"]!({ protocolVersion: "0.1", runId: RUN_ID }, ctx)), /transient bootstrap failure/);
    // ...and the next call retries the factory instead of replaying the
    // cached rejection: it reaches the negotiated-connection gate, proving a
    // live service answered.
    const gated = (await rpc.methods["run.get"]!({ protocolVersion: "0.1", runId: RUN_ID }, ctx)) as JsonObject;
    assert.equal((gated.error as JsonObject).code, "PROTOCOL_INCOMPATIBLE");
    assert.equal(factoryCalls, 2);

    // Success IS cached: further calls do not re-run the factory.
    await rpc.methods["run.get"]!({ protocolVersion: "0.1", runId: RUN_ID }, ctx);
    assert.equal(factoryCalls, 2);
  });
});

// Type-level guard that the registration thunk above matches the factory's
// expected signature (the throw is intentional).
void ((): ExecutionService | Promise<ExecutionService> => {
  throw new Error("unused");
});
