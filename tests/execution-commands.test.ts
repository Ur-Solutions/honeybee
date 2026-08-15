// H3 run.command: effect-keyed send/interrupt with durable receipts, honest
// at-most-once delivery, crash-window indeterminate (never blind redelivery),
// the corpus preconditions (RFC acceptance test 12), and the honest refusals
// (answer until needs_input.opened is bridged, checkpoint, refresh-credential).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeSchemaDigest, createExecutionValidator, loadExecutionContract, type JsonObject } from "../src/execution/contract.js";
import { HarnessDispatchError } from "../src/execution/harnessControl.js";
import { admitOperation, mutateOperation, readOperation } from "../src/execution/opsStore.js";
import { createRunOperations } from "../src/execution/operations.js";
import { effectKeyHash, readRunEvents } from "../src/execution/runStore.js";
import { storeSessionEvidenceSource } from "../src/execution/service.js";
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

test("two service instances join one live durable command attempt instead of declaring the peer crashed", async () => {
  await withTempStore(async () => {
    const control = fakeControl();
    let reachedDriver!: () => void;
    const atDriver = new Promise<void>((resolve) => {
      reachedDriver = resolve;
    });
    let resumeDriver!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeDriver = resolve;
    });
    let driverEffects = 0;
    control.control.send = async () => {
      // The durable dispatch owner has already been recorded when this entry is
      // reached; withhold the actual effect to expose the second service race.
      reachedDriver();
      await resume;
      driverEffects += 1;
    };

    const { ctx, service: serviceA } = await startRunningRun({ control });
    const serviceB = makeService({ control: control.control });
    const effectKey = `${RUN_ID}/command/send-two-service`;
    const body: JsonObject = { runId: RUN_ID, command: { kind: "send", text: "once across services" } };
    const first = serviceA.runCommand(buildOperationEnvelope(ctx, effectKey, body, { requestId: "req-service-a" }));
    await atDriver;
    const claimed = (await readOperation(RUN_ID, effectKey))!;
    assert.equal(claimed.commandState, "dispatching");
    assert.equal(claimed.operationAttempt?.kind, "command-dispatch");

    let peerSettled = false;
    const second = serviceB
      .runCommand(buildOperationEnvelope(ctx, effectKey, body, { requestId: "req-service-b" }))
      .finally(() => {
        peerSettled = true;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(peerSettled, false, "the peer joins the live owner instead of folding dispatching to indeterminate");
    assert.equal((await readOperation(RUN_ID, effectKey))!.commandState, "dispatching");

    resumeDriver();
    const [a, b] = (await Promise.all([first, second])) as JsonObject[];
    assert.equal(driverEffects, 1);
    assert.deepEqual(a.result, { commandState: "completed" });
    assert.deepEqual(b.result, a.result);
    assert.equal((a.receipt as JsonObject).receiptId, (b.receipt as JsonObject).receiptId);
    assert.equal((a.receipt as JsonObject).resultVersion, (b.receipt as JsonObject).resultVersion);
    assert.equal((await readOperation(RUN_ID, effectKey))!.operationAttempt, undefined);
    const events = await readRunEvents(RUN_ID);
    for (const type of ["command.accepted", "command.dispatching", "command.completed"]) {
      assert.equal(events.filter((event) => event.type === type && (event.payload as JsonObject).effectKey === effectKey).length, 1);
    }
    assert.equal(events.filter((event) => event.type === "command.indeterminate").length, 0);
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

test("run.command answer is CAPABILITY_MISMATCH until needs_input.opened is bridged — schema-valid, never dispatched, no durable effect", async () => {
  await withTempStore(async () => {
    // Even with an open input request on the legacy control socket, the
    // protocol path must refuse: needs_input.opened never reaches protocol
    // consumers, so an advertised answer command could not be driven honestly.
    const control = fakeControl({ pendingInput: "inp-0001" });
    const { ctx, service } = await startRunningRun({ control });

    const envelope = buildOperationEnvelope(ctx, `${RUN_ID}/command/answer-0001`, {
      runId: RUN_ID,
      command: { kind: "answer", inputRequestId: "inp-0001", answer: { approved: true } },
    });
    // The vocabulary still validates answer (like checkpoint) — the refusal is
    // a capability fact, not a schema gap.
    assert.deepEqual(validator.validate("run-command-body", envelope.body).errors, []);

    const refused = (await service.runCommand(envelope)) as JsonObject;
    assert.equal((refused.error as JsonObject).code, "CAPABILITY_MISMATCH");
    // Refused BEFORE any durable effect or delivery attempt.
    assert.equal(await readOperation(RUN_ID, `${RUN_ID}/command/answer-0001`), null);
    assert.equal(control.calls.filter((call) => call.method === "answer").length, 0);
    const events = await readRunEvents(RUN_ID);
    assert.ok(!events.some((event) => event.type.startsWith("needs_input.")), "no needs_input events without the bridge");
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
    const { ctx, startEnvelope } = await startRunningRun();
    const envelope = sendEnvelope(ctx, "crash window", `${RUN_ID}/command/send-crash`);

    // Crash fixture from the pre-owner ledger: dispatching persisted, but the
    // coordinator generation (and its attempt owner fact) is gone. A genuinely
    // live owner is covered by the two-service join barrier above.
    await admitOperation({
      runId: RUN_ID,
      method: "run.command",
      effectKey: `${RUN_ID}/command/send-crash`,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: {
        commandKind: "send",
        commandState: "accepted",
        deliveryId: `op-${effectKeyHash(`${RUN_ID}/command/send-crash`).slice(0, 16)}`,
      },
    });
    await mutateOperation(RUN_ID, `${RUN_ID}/command/send-crash`, (record) => ({ ...record, commandState: "dispatching" }));
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

test("run.command vs concurrent cancel: a cancel landing after the pre-lock settle is refused under the admission lock", async () => {
  await withTempStore(async () => {
    const { createRunOperations } = await import("../src/execution/operations.js");
    const { computeSchemaDigest } = await import("../src/execution/contract.js");
    const { storeSessionEvidenceSource } = await import("../src/execution/service.js");
    const control = fakeControl();
    const { ctx, service } = await startRunningRun({ control });

    // Deterministic interleaving: this operations instance settles the run as
    // "running" — the exact STALE pre-lock view a concurrent RPC captures
    // before another caller's cancel lands.
    const staleOps = createRunOperations({
      contract,
      validator,
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      now: () => new Date(),
      binding: async () => ctx.binding,
      control: control.control,
      sessions: storeSessionEvidenceSource(),
      retireSession: async () => ({ retired: true, detail: "test SessionRecord archived" }),
      settle: async (reservation) => ({ reservation, state: "running" }),
      origin: async () => ({ nodeId: ctx.nodeId }),
    });

    // The cancel completes fully in the window between that stale settle and
    // the command's admission.
    await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "race" }));

    const refused = (await staleOps.runCommand(sendEnvelope(ctx, "late steer", `${RUN_ID}/command/send-race`))) as JsonObject;
    assert.equal((refused.error as JsonObject).code, "RUN_VERSION_CONFLICT");
    // Refused under the lock BEFORE any durable effect or delivery: the
    // cancelled run never receives steering.
    assert.equal(await readOperation(RUN_ID, `${RUN_ID}/command/send-race`), null);
    assert.equal(control.calls.filter((call) => call.method === "send").length, 0);
  });
});

test("run.command admitted before cancel rechecks the reservation at the dispatch barrier and never reaches the driver", async () => {
  await withTempStore(async () => {
    const control = fakeControl();
    const { ctx, service } = await startRunningRun({ control });

    let reachedDispatchBarrier!: () => void;
    const atDispatchBarrier = new Promise<void>((resolve) => {
      reachedDispatchBarrier = resolve;
    });
    let resumeDispatch!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeDispatch = resolve;
    });
    let blockAcceptedOrigin = true;
    const racingOps = createRunOperations({
      contract,
      validator,
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      now: () => new Date(),
      binding: async () => ctx.binding,
      control: control.control,
      sessions: storeSessionEvidenceSource(),
      retireSession: async () => ({ retired: true, detail: "test SessionRecord archived" }),
      // Preserve the running snapshot captured before the concurrent cancel;
      // the dispatch claim itself must close the remaining race.
      settle: async (reservation) => ({ reservation, state: "running" }),
      origin: async () => {
        if (blockAcceptedOrigin) {
          blockAcceptedOrigin = false;
          reachedDispatchBarrier();
          await resume;
        }
        return { nodeId: ctx.nodeId };
      },
    });
    const effectKey = `${RUN_ID}/command/send-admitted-race`;
    const envelope = sendEnvelope(ctx, "must not arrive", effectKey);
    const pendingCommand = racingOps.runCommand(envelope);
    await atDispatchBarrier;
    assert.equal((await readOperation(RUN_ID, effectKey))?.commandState, "accepted", "effect is admitted before the barrier opens");

    await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "race winner" }));
    resumeDispatch();
    const response = (await pendingCommand) as JsonObject;
    assert.equal((response.result as JsonObject).commandState, "failed");
    assert.match(String((response.result as JsonObject).cause), /nothing was delivered/);
    assert.equal(control.calls.filter((call) => call.method === "send").length, 0);
    assert.equal((await readOperation(RUN_ID, effectKey))?.commandState, "failed");
    const events = await readRunEvents(RUN_ID);
    assert.ok(events.some((event) => event.type === "command.failed"));
    assert.ok(!events.some((event) => event.type === "command.completed"));
  });
});

test("restart replay of a pre-admitted accepted command after cancel fails durably without delivery", async () => {
  await withTempStore(async () => {
    const initialControl = fakeControl();
    const { ctx, service } = await startRunningRun({ control: initialControl });
    const effectKey = `${RUN_ID}/command/send-admitted-restart`;
    const envelope = sendEnvelope(ctx, "must not arrive after restart", effectKey);
    // Crash fixture: admission committed, but the coordinator exited before
    // it could claim accepted -> dispatching.
    await admitOperation({
      runId: RUN_ID,
      method: "run.command",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: {
        commandKind: "send",
        commandState: "accepted",
        deliveryId: `op-${effectKeyHash(effectKey).slice(0, 16)}`,
      },
    });
    await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "cancelled while down" }));

    const restartedControl = fakeControl();
    const restarted = makeService({ control: restartedControl.control });
    const replay = (await restarted.runCommand(
      buildOperationEnvelope(
        ctx,
        effectKey,
        { runId: RUN_ID, command: { kind: "send", text: "must not arrive after restart" } },
        { requestId: "req-command-after-cancel-restart" },
      ),
    )) as JsonObject;
    assert.equal((replay.receipt as JsonObject).outcome, "replayed");
    assert.equal((replay.result as JsonObject).commandState, "failed");
    assert.match(String((replay.result as JsonObject).cause), /nothing was delivered/);
    assert.equal(restartedControl.calls.filter((call) => call.method === "send").length, 0);
    assert.equal((await readOperation(RUN_ID, effectKey))?.commandState, "failed");
  });
});
