// H3 run.command: effect-keyed send/answer/interrupt with durable receipts,
// honest at-most-once delivery, crash-window indeterminate (never blind
// redelivery), and the corpus preconditions (RFC acceptance test 12).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createExecutionValidator, loadExecutionContract, type JsonObject } from "../src/execution/contract.js";
import { HarnessDispatchError } from "../src/execution/harnessControl.js";
import { readOperation } from "../src/execution/opsStore.js";
import { readRunEvents } from "../src/execution/runStore.js";
import { saveSession, loadSession } from "../src/store.js";
import {
  beeNameForRun,
  buildOperationEnvelope,
  buildRunStartEnvelope,
  countingLauncher,
  fakeControl,
  installTestAuthority,
  makeService,
  withTempStore,
  type TestAuthority,
} from "./executionTestKit.js";

const contract = loadExecutionContract();
const validator = createExecutionValidator(contract);

const RUN_ID = "run-0001";

function sendEnvelope(ctx: TestAuthority, text = "run the tests", effectKey = `${RUN_ID}/command/send-0001`, extra: JsonObject = {}): JsonObject {
  return buildOperationEnvelope(ctx, effectKey, { runId: RUN_ID, command: { kind: "send", text }, ...extra });
}

function assertReceiptEnvelope(response: JsonObject): void {
  assert.deepEqual(validator.validate("execution-response-envelope", response).errors, []);
}

async function startRunningRun(opts: { control?: ReturnType<typeof fakeControl>; now?: () => Date; expiresAt?: string } = {}) {
  const ctx = await installTestAuthority();
  const counting = countingLauncher();
  const control = opts.control ?? fakeControl();
  const service = makeService({ launcher: counting.launcher, control: control.control, ...(opts.now ? { now: opts.now } : {}) });
  const startEnvelope = buildRunStartEnvelope(ctx, opts.expiresAt ? { expiresAt: opts.expiresAt } : {});
  const started = (await service.runStart(startEnvelope)) as JsonObject;
  assert.deepEqual(started.result, { runId: RUN_ID, state: "running" });
  return { ctx, counting, control, service, startEnvelope };
}

test("run.command send: durable receipt, control-socket dispatch, per-effect events, byte-stable replay", async () => {
  await withTempStore(async () => {
    const { ctx, control, service } = await startRunningRun();
    const envelope = sendEnvelope(ctx);
    assert.deepEqual(validator.validate("run-command-body", envelope.body).errors, []);

    const response = (await service.runCommand(envelope)) as JsonObject;
    assertReceiptEnvelope(response);
    const receipt = response.receipt as JsonObject;
    assert.equal(receipt.outcome, "created");
    assert.equal(receipt.effectKey, `${RUN_ID}/command/send-0001`);
    assert.deepEqual(response.result, { commandState: "completed" });

    // Delivered exactly once, in-process, to the run's bound bee.
    const sends = control.calls.filter((call) => call.method === "send");
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.beeName, beeNameForRun(RUN_ID));
    assert.equal(sends[0]!.args[0], "run the tests");
    assert.match(String(sends[0]!.args[1]), /^op-[0-9a-f]{16}$/);

    // Normalized durable command lifecycle events, schema-valid.
    const events = await readRunEvents(RUN_ID);
    const types = events.map((event) => event.type);
    for (const expected of ["command.accepted", "command.dispatching", "command.completed"]) {
      assert.ok(types.includes(expected), `missing ${expected}`);
    }
    for (const event of events) assert.deepEqual(validator.validate("run-event", event).errors, [], event.type);

    // Identical retry (new transport requestId, same effect + digest, freshly
    // signed) replays the original receipt and never redispatches.
    const retryEnvelope = buildOperationEnvelope(
      ctx,
      `${RUN_ID}/command/send-0001`,
      { runId: RUN_ID, command: { kind: "send", text: "run the tests" } },
      { requestId: "req-retry" },
    );
    const replay = (await service.runCommand(retryEnvelope)) as JsonObject;
    const replayReceipt = replay.receipt as JsonObject;
    assert.equal(replayReceipt.outcome, "replayed");
    assert.equal(replayReceipt.receiptId, receipt.receiptId);
    assert.deepEqual(replay.result, { commandState: "completed" });
    assert.equal(control.calls.filter((call) => call.method === "send").length, 1);
    assert.equal((await readRunEvents(RUN_ID)).length, events.length);
  });
});

test("run.command: effect key reuse with different content conflicts; distinct effects each dispatch with keyed dedup", async () => {
  await withTempStore(async () => {
    const { ctx, control, service } = await startRunningRun();
    await service.runCommand(sendEnvelope(ctx, "first", `${RUN_ID}/command/send-0001`));

    const drifted = (await service.runCommand(sendEnvelope(ctx, "DIFFERENT TEXT", `${RUN_ID}/command/send-0001`))) as JsonObject;
    assert.equal((drifted.error as JsonObject).code, "IDEMPOTENCY_CONFLICT");

    const second = (await service.runCommand(sendEnvelope(ctx, "second", `${RUN_ID}/command/send-0002`))) as JsonObject;
    assert.deepEqual(second.result, { commandState: "completed" });
    assert.equal(control.calls.filter((call) => call.method === "send").length, 2);

    // Repeated command families are keyed per effect, not deduped by type.
    const events = await readRunEvents(RUN_ID);
    assert.equal(events.filter((event) => event.type === "command.accepted").length, 2);
    assert.equal(events.filter((event) => event.type === "command.completed").length, 2);
  });
});

test("run.command answer: resolves an open input request; a resolved/unopened request is a typed precondition failure", async () => {
  await withTempStore(async () => {
    const control = fakeControl({ pendingInput: "inp-0001" });
    const { ctx, service } = await startRunningRun({ control });

    const wrong = (await service.runCommand(
      buildOperationEnvelope(ctx, `${RUN_ID}/command/answer-0002`, {
        runId: RUN_ID,
        command: { kind: "answer", inputRequestId: "inp-9999", answer: { approved: true } },
      }),
    )) as JsonObject;
    assert.equal((wrong.error as JsonObject).code, "RUN_VERSION_CONFLICT");
    // Refused BEFORE any durable effect: no record, and a later retry may succeed.
    assert.equal(await readOperation(RUN_ID, `${RUN_ID}/command/answer-0002`), null);

    const answer = (await service.runCommand(
      buildOperationEnvelope(ctx, `${RUN_ID}/command/answer-0001`, {
        runId: RUN_ID,
        command: { kind: "answer", inputRequestId: "inp-0001", answer: { approved: true } },
      }),
    )) as JsonObject;
    assert.deepEqual(answer.result, { commandState: "completed" });
    assert.equal(control.calls.filter((call) => call.method === "answer").length, 1);
    const events = await readRunEvents(RUN_ID);
    assert.ok(events.some((event) => event.type === "needs_input.resolved" && (event.payload as JsonObject).inputRequestId === "inp-0001"));
  });
});

test("run.command interrupt completes; checkpoint and refresh-credential fail explicitly with no durable effect", async () => {
  await withTempStore(async () => {
    const { ctx, control, service } = await startRunningRun();

    const interrupt = (await service.runCommand(
      buildOperationEnvelope(ctx, `${RUN_ID}/command/interrupt-0001`, { runId: RUN_ID, command: { kind: "interrupt", reason: "steer" } }),
    )) as JsonObject;
    assert.deepEqual(interrupt.result, { commandState: "completed" });
    assert.equal(control.calls.filter((call) => call.method === "interrupt").length, 1);

    const checkpoint = (await service.runCommand(
      buildOperationEnvelope(ctx, `${RUN_ID}/command/checkpoint-0001`, { runId: RUN_ID, command: { kind: "checkpoint" } }),
    )) as JsonObject;
    assert.equal((checkpoint.error as JsonObject).code, "CAPABILITY_MISMATCH");
    assert.equal(await readOperation(RUN_ID, `${RUN_ID}/command/checkpoint-0001`), null);

    const refresh = (await service.runCommand(
      buildOperationEnvelope(ctx, `${RUN_ID}/command/refresh-0001`, {
        runId: RUN_ID,
        command: { kind: "refresh-credential", credentialLeaseId: "cred-lease-0001" },
      }),
    )) as JsonObject;
    assert.equal((refresh.error as JsonObject).code, "SCHEMA_UNSUPPORTED");
  });
});

test("run.command preconditions: stale ifStateVersion conflicts, matching version succeeds", async () => {
  await withTempStore(async () => {
    const { ctx, service } = await startRunningRun();
    const projection = ((await service.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    const current = Number(projection.stateVersion);

    const stale = (await service.runCommand(sendEnvelope(ctx, "text", `${RUN_ID}/command/send-stale`, { ifStateVersion: current + 5 }))) as JsonObject;
    assert.equal((stale.error as JsonObject).code, "RUN_VERSION_CONFLICT");

    const fresh = (await service.runCommand(sendEnvelope(ctx, "text", `${RUN_ID}/command/send-fresh`, { ifStateVersion: current }))) as JsonObject;
    assert.deepEqual(fresh.result, { commandState: "completed" });
  });
});

test("run.command authority binding: wrong workspace/scope/capability lease and tampered signatures are refused", async () => {
  await withTempStore(async () => {
    const { ctx, service } = await startRunningRun();
    const cases: Array<[string, JsonObject, string]> = [
      [
        "wrong workspace",
        buildOperationEnvelope(ctx, `${RUN_ID}/command/send-ws`, { runId: RUN_ID, command: { kind: "send", text: "x" } }, {
          mutateAuthority: (authority) => {
            authority.workspaceId = "wsp-other";
          },
        }),
        "LEASE_DENIED",
      ],
      [
        "wrong owner scope",
        buildOperationEnvelope(ctx, `${RUN_ID}/command/send-scope`, { runId: RUN_ID, command: { kind: "send", text: "x" } }, {
          mutateAuthority: (authority) => {
            authority.ownerScopeId = "oscope-other";
          },
        }),
        "BINDING_DENIED",
      ],
      [
        "wrong capability lease",
        buildOperationEnvelope(ctx, `${RUN_ID}/command/send-cap`, { runId: RUN_ID, command: { kind: "send", text: "x" } }, {
          mutateAuthority: (authority) => {
            authority.capabilityLeaseId = "cap-lease-9999";
          },
        }),
        "LEASE_DENIED",
      ],
      [
        "stale authority epoch",
        buildOperationEnvelope(ctx, `${RUN_ID}/command/send-epoch`, { runId: RUN_ID, command: { kind: "send", text: "x" } }, {
          mutateAuthority: (authority) => {
            authority.authorityEpoch = 7;
          },
        }),
        "BINDING_DENIED",
      ],
      [
        "tampered signature",
        buildOperationEnvelope(ctx, `${RUN_ID}/command/send-sig`, { runId: RUN_ID, command: { kind: "send", text: "x" } }, {
          mutateSigned: (envelope) => {
            envelope.signature = "ed25519:dGFtcGVyZWQ=";
          },
        }),
        "LEASE_DENIED",
      ],
    ];
    for (const [label, envelope, code] of cases) {
      const response = (await service.runCommand(envelope)) as JsonObject;
      assert.equal((response.error as JsonObject | undefined)?.code, code, label);
    }
    const unknown = (await service.runCommand(
      buildOperationEnvelope(ctx, "run-9999/command/send-1", { runId: "run-9999", command: { kind: "send", text: "x" } }),
    )) as JsonObject;
    assert.equal((unknown.error as JsonObject).code, "RUN_UNKNOWN");
  });
});

test("run.command after lease expiry is LEASE_DENIED (steering dies with the lease)", async () => {
  await withTempStore(async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const { ctx, control } = await startRunningRun({ expiresAt });
    // A later coordinator instance (clock beyond expiry) over the same store.
    const later = makeService({ control: fakeControl().control, now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    const refused = (await later.runCommand(sendEnvelope(ctx, "late steer", `${RUN_ID}/command/send-late`))) as JsonObject;
    assert.equal((refused.error as JsonObject).code, "LEASE_DENIED");
    assert.equal(control.calls.filter((call) => call.method === "send").length, 0);
  });
});

test("run.command dispatch refusal is a durable failed command; a fresh effect can still succeed", async () => {
  await withTempStore(async () => {
    const control = fakeControl({ dispatchError: new HarnessDispatchError("failed", "no live runner host") });
    const { ctx, service } = await startRunningRun({ control });

    const failed = (await service.runCommand(sendEnvelope(ctx, "try", `${RUN_ID}/command/send-f1`))) as JsonObject;
    assert.equal((failed.result as JsonObject).commandState, "failed");
    const record = await readOperation(RUN_ID, `${RUN_ID}/command/send-f1`);
    assert.equal(record?.commandState, "failed");
    assert.ok((await readRunEvents(RUN_ID)).some((event) => event.type === "command.failed"));

    control.behavior.dispatchError = undefined as never;
    const retried = (await service.runCommand(sendEnvelope(ctx, "try", `${RUN_ID}/command/send-f2`))) as JsonObject;
    assert.deepEqual(retried.result, { commandState: "completed" });
  });
});

test("run.command crash window: durably dispatching with no live continuation becomes indeterminate and is never redelivered", async () => {
  await withTempStore(async () => {
    const hanging = fakeControl({ hang: true });
    const { ctx, service, startEnvelope } = await startRunningRun({ control: hanging });
    const envelope = sendEnvelope(ctx, "crash window", `${RUN_ID}/command/send-crash`);

    // Dispatch begins and never resolves (the crash window): do not await.
    void service.runCommand(envelope);
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (let i = 0; i < 100; i++) {
      const record = await readOperation(RUN_ID, `${RUN_ID}/command/send-crash`);
      if (record?.commandState === "dispatching") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await readOperation(RUN_ID, `${RUN_ID}/command/send-crash`))?.commandState, "dispatching");

    // "Restart": a fresh coordinator over the same durable store.
    const restartedControl = fakeControl();
    const restarted = makeService({ control: restartedControl.control });
    const retryEnvelope = buildOperationEnvelope(
      ctx,
      `${RUN_ID}/command/send-crash`,
      { runId: RUN_ID, command: { kind: "send", text: "crash window" } },
      { requestId: "req-after-crash" },
    );
    const replay = (await restarted.runCommand(retryEnvelope)) as JsonObject;
    const receipt = replay.receipt as JsonObject;
    assert.equal(receipt.outcome, "replayed");
    assert.equal((replay.result as JsonObject).commandState, "indeterminate");
    // Never blindly redelivered: the restarted control saw no send at all.
    assert.equal(restartedControl.calls.filter((call) => call.method === "send").length, 0);
    const record = await readOperation(RUN_ID, `${RUN_ID}/command/send-crash`);
    assert.equal(record?.commandState, "indeterminate");
    const events = await readRunEvents(RUN_ID);
    assert.ok(events.some((event) => event.type === "command.indeterminate"));

    // run.start replay over the same store also stays receipt-stable.
    const startReplay = (await restarted.runStart(startEnvelope)) as JsonObject;
    assert.equal((startReplay.receipt as JsonObject).outcome, "replayed");
  });
});

test("run.command refuses delivery when the bound session is stamped with a different run", async () => {
  await withTempStore(async () => {
    const { ctx, control, service } = await startRunningRun();
    const bee = beeNameForRun(RUN_ID);
    const record = (await loadSession(bee))!;
    await saveSession({ ...record, executionRunId: "run-imposter" });

    const response = (await service.runCommand(sendEnvelope(ctx, "steer", `${RUN_ID}/command/send-imposter`))) as JsonObject;
    assert.equal((response.result as JsonObject).commandState, "failed");
    assert.match(String((response.result as JsonObject).cause), /different run/);
    assert.equal(control.calls.filter((call) => call.method === "send").length, 0);
  });
});

test("run.command on a terminal run is RUN_VERSION_CONFLICT with no durable effect", async () => {
  await withTempStore(async () => {
    const { ctx, service } = await startRunningRun();
    await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "test" }));
    const refused = (await service.runCommand(sendEnvelope(ctx, "after cancel", `${RUN_ID}/command/send-post`))) as JsonObject;
    assert.equal((refused.error as JsonObject).code, "RUN_VERSION_CONFLICT");
    assert.equal(await readOperation(RUN_ID, `${RUN_ID}/command/send-post`), null);
  });
});
