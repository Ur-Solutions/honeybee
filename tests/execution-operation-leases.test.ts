import { strict as assert } from "node:assert";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { canonicalDigest } from "../src/comb/canonical.js";
import type { JsonValue } from "../src/comb/types.js";
import { computeSchemaDigest, createExecutionValidator, loadExecutionContract, type JsonObject } from "../src/execution/contract.js";
import { admitOperation, readOperation, setOperationResult, type OperationAttempt } from "../src/execution/opsStore.js";
import { createRunOperations, type RunOperationsDeps } from "../src/execution/operations.js";
import { appendRunEvents, effectKeyHash, readRunEvents } from "../src/execution/runStore.js";
import { storeSessionEvidenceSource } from "../src/execution/service.js";
import { captureProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import {
  buildOperationEnvelope,
  buildRunStartEnvelope,
  fakeControl,
  installTestAuthority,
  makeService,
  withTempStore,
  type TestAuthority,
} from "./executionTestKit.js";

const contract = loadExecutionContract();
const validator = createExecutionValidator(contract);
const schemaDigest = computeSchemaDigest(contract);
const RUN_ID = "run-0001";
const LEASE_MS = 60;
const HEARTBEAT_MS = 10;

type AttemptOptions = Pick<
  RunOperationsDeps,
  | "now"
  | "operationAttemptLeaseMs"
  | "operationAttemptHeartbeatMs"
  | "operationAttemptPollMs"
  | "operationPersistence"
>;

async function startRun() {
  const ctx = await installTestAuthority();
  const control = fakeControl();
  const service = makeService({ control: control.control });
  await service.runStart(buildRunStartEnvelope(ctx));
  return { ctx, control };
}

function operations(
  ctx: TestAuthority,
  control: ReturnType<typeof fakeControl>["control"],
  options: Partial<AttemptOptions> = {},
) {
  return createRunOperations({
    contract,
    validator,
    protocolVersion: "0.1",
    schemaDigest,
    now: options.now ?? (() => new Date()),
    binding: async () => ctx.binding,
    control,
    sessions: storeSessionEvidenceSource(),
    retireSession: async () => ({ retired: true, detail: "test SessionRecord archived" }),
    settle: async (reservation) => ({ reservation, state: "running" }),
    origin: async () => ({ nodeId: ctx.nodeId }),
    operationAttemptLeaseMs: options.operationAttemptLeaseMs ?? LEASE_MS,
    operationAttemptHeartbeatMs: options.operationAttemptHeartbeatMs ?? HEARTBEAT_MS,
    operationAttemptPollMs: options.operationAttemptPollMs ?? 2,
    ...(options.operationPersistence ? { operationPersistence: options.operationPersistence } : {}),
  });
}

function sendEnvelope(ctx: TestAuthority, effectKey: string, requestId: string): JsonObject {
  return buildOperationEnvelope(
    ctx,
    effectKey,
    { runId: RUN_ID, command: { kind: "send", text: "deliver once" } },
    { requestId },
  );
}

function collectEnvelope(ctx: TestAuthority, effectKey: string, requestId: string): JsonObject {
  return buildOperationEnvelope(ctx, effectKey, { runId: RUN_ID }, { requestId });
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for deterministic test barrier");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

async function strandedAttempt(kind: OperationAttempt["kind"], attemptId: string, clockOffsetMs = 0): Promise<OperationAttempt> {
  const ownerBirth = await captureProcessBirthFingerprint(process.pid);
  const renewedAt = new Date(Date.now() + clockOffsetMs);
  return {
    kind,
    attemptId,
    ownerId: `dead-continuation-${attemptId}`,
    ownerPid: process.pid,
    ...(ownerBirth ? { ownerBirth } : {}),
    startedAt: renewedAt.toISOString(),
    leaseDurationMs: LEASE_MS,
    renewedAt: renewedAt.toISOString(),
    leaseExpiresAt: new Date(renewedAt.getTime() + LEASE_MS).toISOString(),
    heartbeatSequence: 7,
  };
}

test("post-claim command event/result write failures converge in-process and never redeliver", async () => {
  await withTempStore(async () => {
    const { ctx, control } = await startRun();

    let failDispatchEvent = true;
    const eventFaultOps = operations(ctx, control.control, {
      operationPersistence: {
        appendRunEvents: async (...args) => {
          if (failDispatchEvent && args[2].some((event) => event.type === "command.dispatching")) {
            failDispatchEvent = false;
            throw new Error("injected command.dispatching append failure");
          }
          return appendRunEvents(...args);
        },
      },
    });
    const eventKey = `${RUN_ID}/command/event-write-fault`;
    const eventFirst = await eventFaultOps.runCommand(sendEnvelope(ctx, eventKey, "req-event-fault"));
    assert.equal((eventFirst.result as JsonObject).commandState, "indeterminate");
    const eventReplay = await eventFaultOps.runCommand(sendEnvelope(ctx, eventKey, "req-event-replay"));
    assert.equal((eventReplay.result as JsonObject).commandState, "indeterminate");
    assert.equal(control.calls.filter((call) => call.method === "send").length, 0);

    let resultWriteFailures = 2;
    const resultFaultOps = operations(ctx, control.control, {
      operationPersistence: {
        setOperationResult: async (...args) => {
          const extra = args[3];
          if (resultWriteFailures > 0 && extra?.commandState !== undefined) {
            resultWriteFailures -= 1;
            throw new Error("injected post-dispatch result write failure");
          }
          return setOperationResult(...args);
        },
      },
    });
    const resultKey = `${RUN_ID}/command/result-write-fault`;
    const resultFirst = await resultFaultOps.runCommand(sendEnvelope(ctx, resultKey, "req-result-fault"));
    assert.equal((resultFirst.error as JsonObject).code, "AUTHORITY_UNAVAILABLE");
    assert.equal((await readOperation(RUN_ID, resultKey))!.commandState, "dispatching");
    assert.equal(control.calls.filter((call) => call.method === "send").length, 1);

    // The local flight is gone while this process remains alive. Replay uses
    // continuation ownership (not PID birth) and folds the uncertain delivery.
    const resultReplay = await resultFaultOps.runCommand(sendEnvelope(ctx, resultKey, "req-result-replay"));
    assert.equal((resultReplay.result as JsonObject).commandState, "indeterminate");
    assert.equal((await readOperation(RUN_ID, resultKey))!.operationAttempt, undefined);
    assert.equal(control.calls.filter((call) => call.method === "send").length, 1, "uncertain delivery is never repeated");
  });
});

test("collection completion and catch-path write failures expire and recompute one canonical result", async () => {
  await withTempStore(async () => {
    const { ctx, control } = await startRun();
    const effectKey = `${RUN_ID}/collect-write-fault`;
    let resultWriteFailures = 3;
    const faulting = operations(ctx, control.control, {
      operationPersistence: {
        setOperationResult: async (...args) => {
          const extra = args[3];
          if (resultWriteFailures > 0 && extra?.collectionState !== undefined) {
            resultWriteFailures -= 1;
            throw new Error("injected collection result/catch write failure");
          }
          return setOperationResult(...args);
        },
      },
    });

    const first = await faulting.runCollect(collectEnvelope(ctx, effectKey, "req-collect-fault"));
    assert.equal((first.error as JsonObject).code, "AUTHORITY_UNAVAILABLE");
    const stranded = (await readOperation(RUN_ID, effectKey))!;
    assert.equal(stranded.collectionState, "collecting");
    assert.ok(stranded.operationAttempt);

    // A fresh service instance shares the live process but not the dead local
    // continuation. It observes the unchanged heartbeat generation for one TTL,
    // claims a new attempt, and safely recomputes the same stable effect.
    const restarted = operations(ctx, control.control);
    const recovered = await restarted.runCollect(collectEnvelope(ctx, effectKey, "req-collect-replay"));
    assert.equal((recovered.result as JsonObject).state, "complete");
    const canonical = (await readOperation(RUN_ID, effectKey))!;
    assert.equal(canonical.collectionState, "complete");
    assert.equal(canonical.operationAttempt, undefined);
    assert.equal(canonicalDigest(canonical.result as JsonValue), canonicalDigest(recovered.result as JsonValue));
    assert.equal((await readRunEvents(RUN_ID)).filter((event) => event.type === "collection.completed").length, 1);
  });
});

test("a live command continuation renews beyond its base TTL and cannot be stolen", async () => {
  await withTempStore(async () => {
    const { ctx, control } = await startRun();
    let atDriver!: () => void;
    const enteredDriver = new Promise<void>((resolve) => { atDriver = resolve; });
    let resumeDriver!: () => void;
    const resume = new Promise<void>((resolve) => { resumeDriver = resolve; });
    let driverEffects = 0;
    control.control.send = async () => {
      atDriver();
      await resume;
      driverEffects += 1;
    };
    // The owner writes wall-clock timestamps a day behind the peer. A peer
    // comparing leaseExpiresAt directly would steal immediately; generation
    // progress measured on the peer's monotonic clock remains authoritative.
    const owner = operations(ctx, control.control, { now: () => new Date(Date.now() - 24 * 60 * 60_000) });
    const peer = operations(ctx, control.control, { now: () => new Date(Date.now() + 24 * 60 * 60_000) });
    const effectKey = `${RUN_ID}/command/live-renewal`;
    const first = owner.runCommand(sendEnvelope(ctx, effectKey, "req-live-owner"));
    await enteredDriver;
    const initialSequence = (await readOperation(RUN_ID, effectKey))!.operationAttempt!.heartbeatSequence;
    await waitUntil(async () => (await readOperation(RUN_ID, effectKey))!.operationAttempt!.heartbeatSequence >= initialSequence + 7);

    let peerSettled = false;
    const second = peer.runCommand(sendEnvelope(ctx, effectKey, "req-live-peer")).finally(() => { peerSettled = true; });
    const peerObservedSequence = (await readOperation(RUN_ID, effectKey))!.operationAttempt!.heartbeatSequence;
    await waitUntil(async () => (await readOperation(RUN_ID, effectKey))!.operationAttempt!.heartbeatSequence >= peerObservedSequence + 3);
    assert.equal(peerSettled, false, "renewed attempt remains owned beyond the original TTL");
    assert.equal(driverEffects, 0);

    resumeDriver();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(driverEffects, 1);
    assert.equal((a.result as JsonObject).commandState, "completed");
    assert.deepEqual(b.result, a.result);
  });
});

test("an expired attempt with a live owner process recovers with method-safe semantics", async () => {
  await withTempStore(async () => {
    const { ctx, control } = await startRun();
    const ops = operations(ctx, control.control);

    const commandKey = `${RUN_ID}/command/dead-continuation`;
    const commandEnvelope = sendEnvelope(ctx, commandKey, "req-command-dead-continuation");
    await admitOperation({
      runId: RUN_ID,
      method: "run.command",
      effectKey: commandKey,
      requestDigest: String(commandEnvelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest,
      init: {
        commandKind: "send",
        commandState: "dispatching",
        deliveryId: `op-${effectKeyHash(commandKey).slice(0, 16)}`,
        operationAttempt: await strandedAttempt("command-dispatch", "attempt-command-live-process", 24 * 60 * 60_000),
      },
    });
    const command = await ops.runCommand(commandEnvelope);
    assert.equal((command.result as JsonObject).commandState, "indeterminate");
    assert.equal(control.calls.filter((call) => call.method === "send").length, 0, "expired command is never redelivered");

    const collectKey = `${RUN_ID}/collect-dead-continuation`;
    const collectRequest = collectEnvelope(ctx, collectKey, "req-collect-dead-continuation");
    await admitOperation({
      runId: RUN_ID,
      method: "run.collect",
      effectKey: collectKey,
      requestDigest: String(collectRequest.requestDigest),
      protocolVersion: "0.1",
      schemaDigest,
      init: {
        collectionId: `coll-${effectKeyHash(collectKey).slice(0, 12)}`,
        collectionState: "collecting",
        operationAttempt: await strandedAttempt("collection", "attempt-collect-live-process", 24 * 60 * 60_000),
      },
    });
    const collection = await ops.runCollect(collectRequest);
    assert.equal((collection.result as JsonObject).state, "complete", "expired collection safely recomputes");
    assert.equal((await readOperation(RUN_ID, collectKey))!.operationAttempt, undefined);
  });
});

test("fresh skewed service instances race a stranded collection by monotonic lease generation", async () => {
  await withTempStore(async () => {
    const { ctx, control } = await startRun();
    const effectKey = `${RUN_ID}/collect-restart-skew`;
    const request = collectEnvelope(ctx, effectKey, "req-collect-restart-skew");
    await admitOperation({
      runId: RUN_ID,
      method: "run.collect",
      effectKey,
      requestDigest: String(request.requestDigest),
      protocolVersion: "0.1",
      schemaDigest,
      init: {
        collectionId: `coll-${effectKeyHash(effectKey).slice(0, 12)}`,
        collectionState: "collecting",
        // Far-future wall time: a behind-clock observer must still recover the
        // unchanged continuation within the bounded local lease duration.
        operationAttempt: await strandedAttempt("collection", "attempt-restart-skew", 12 * 60 * 60_000),
      },
    });

    let completionWrites = 0;
    const persistence = {
      setOperationResult: async (...args: Parameters<typeof setOperationResult>) => {
        if (args[3]?.collectionState === "complete") completionWrites += 1;
        return setOperationResult(...args);
      },
    };
    const behind = operations(ctx, control.control, {
      now: () => new Date(Date.now() - 24 * 60 * 60_000),
      operationPersistence: persistence,
    });
    const ahead = operations(ctx, control.control, {
      now: () => new Date(Date.now() + 24 * 60 * 60_000),
      operationPersistence: persistence,
    });
    const [a, b] = await Promise.all([
      behind.runCollect(request),
      ahead.runCollect(collectEnvelope(ctx, effectKey, "req-collect-restart-skew-peer")),
    ]);
    assert.equal((a.result as JsonObject).state, "complete");
    assert.equal(canonicalDigest(a.result as JsonValue), canonicalDigest(b.result as JsonValue));
    assert.equal(completionWrites, 1, "only the atomically claimed replacement attempt writes the canonical result");
    assert.equal((await readOperation(RUN_ID, effectKey))!.operationAttempt, undefined);
  });
});
