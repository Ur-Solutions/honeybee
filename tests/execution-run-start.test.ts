// Effect-keyed run.start (H1): fail-before-mutation validation, durable
// reservation idempotency (RFC acceptance tests 3-4), concurrent admission,
// and crash-window recovery (reserved-not-started / started-receipt-lost /
// indeterminate). Every request and response is validated against the exact
// corpus schemas.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadExecutionContract, createExecutionValidator } from "../src/execution/contract.js";
import { executionError } from "../src/execution/errors.js";
import { requireExecutionBinding } from "../src/execution/nodeState.js";
import {
  admitRunStart,
  beeNameForRun,
  mutateReservation,
  readReservation,
  readRunEvents,
  runDir,
} from "../src/execution/runStore.js";
import { validateRunStart } from "../src/execution/runStart.js";
import type { JsonObject } from "../src/execution/contract.js";
import { saveSession } from "../src/store.js";
import {
  buildRunStartEnvelope,
  countingLauncher,
  installTestAuthority,
  makeService,
  withTempStore,
  type TestAuthority,
} from "./executionTestKit.js";

const contract = loadExecutionContract();
const validator = createExecutionValidator(contract);

function assertEnvelopeShape(response: JsonObject): void {
  assert.deepEqual(validator.validate("execution-response-envelope", response).errors, []);
  if (response.receipt !== undefined) {
    assert.deepEqual(validator.validate("effect-receipt", response.receipt).errors, []);
  }
  if (response.error !== undefined) {
    assert.deepEqual(validator.validate("error", response.error).errors, []);
  }
}

function errorCode(response: JsonObject): string | undefined {
  return (response.error as JsonObject | undefined)?.code as string | undefined;
}

/** Admit a reservation directly (bypassing launch) to stage crash windows. */
async function stageReservation(ctx: TestAuthority, envelope: JsonObject) {
  const binding = await requireExecutionBinding();
  const validated = validateRunStart(envelope, {
    validator,
    binding,
    nodeId: binding.nodeId,
    protocolVersion: "0.1",
  });
  const { reservation } = await admitRunStart({
    runId: validated.runId,
    effectKey: validated.effectKey,
    requestDigest: validated.requestDigest,
    protocolVersion: "0.1",
    schemaDigest: "sha256:" + "0".repeat(64),
    ownerScopeId: String(validated.authority.ownerScopeId),
    workspaceId: String(validated.authority.workspaceId),
    jobId: String(validated.intent.jobId),
    leaseId: String(validated.lease.leaseId),
    leaseExpiresAt: String(validated.lease.expiresAt),
    capabilityLeaseId: String(validated.authority.capabilityLeaseId),
    intent: validated.intent,
  });
  return reservation;
}

test("run.start golden path: request validates, launch binds, events are durable and ordered", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const envelope = buildRunStartEnvelope(ctx);
    // The minted request itself satisfies the corpus request schemas.
    assert.deepEqual(validator.validate("execution-request-envelope", envelope).errors, []);
    assert.deepEqual(validator.validate("run-start-body", envelope.body).errors, []);

    const counting = countingLauncher();
    const service = makeService({ launcher: counting.launcher });
    const response = (await service.runStart(envelope)) as JsonObject;
    assertEnvelopeShape(response);
    assert.equal(response.requestId, "req-0001");
    const receipt = response.receipt as JsonObject;
    assert.equal(receipt.outcome, "created");
    assert.equal(receipt.requestDigest, envelope.requestDigest);
    assert.deepEqual(response.result, { runId: "run-0001", state: "running" });
    assert.equal(counting.calls.length, 1);
    assert.equal(counting.calls[0]!.beeName, beeNameForRun("run-0001"));

    const reservation = (await readReservation("run-0001"))!;
    assert.equal(reservation.phase, "started");
    assert.equal(reservation.beeName, beeNameForRun("run-0001"));

    const events = await readRunEvents("run-0001");
    assert.deepEqual(
      events.map((event) => [event.seq, event.type]),
      [
        [1, "run.accepted"],
        [2, "environment.materializing"],
        [3, "harness.starting"],
        [4, "environment.ready"],
        [5, "harness.running"],
      ],
    );
    for (const event of events) {
      assert.deepEqual(validator.validate("run-event", event).errors, [], `event seq ${event.seq}`);
    }
  });
});

test("run.start idempotency: identical retry replays the original receipt; changed content conflicts", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher();
    const service = makeService({ launcher: counting.launcher });

    const first = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    const retry = (await service.runStart(buildRunStartEnvelope(ctx, { requestId: "req-0009" }))) as JsonObject;
    assertEnvelopeShape(retry);
    assert.equal(retry.requestId, "req-0009");
    assert.equal((retry.receipt as JsonObject).outcome, "replayed");
    assert.equal((retry.receipt as JsonObject).receiptId, (first.receipt as JsonObject).receiptId);
    assert.equal((retry.receipt as JsonObject).recordedAt, (first.receipt as JsonObject).recordedAt);
    assert.equal(counting.calls.length, 1, "identical retry must not launch again");

    // Same effect key, different content.
    const conflicting = (await service.runStart(
      buildRunStartEnvelope(ctx, { requestId: "req-0010", brief: "Entirely different work." }),
    )) as JsonObject;
    assertEnvelopeShape(conflicting);
    assert.equal(errorCode(conflicting), "IDEMPOTENCY_CONFLICT");

    // Same runId under a different effect key.
    const reusedRun = (await service.runStart(
      buildRunStartEnvelope(ctx, { requestId: "req-0011", effectKey: "job-0001/run-0001/start-again" }),
    )) as JsonObject;
    assert.equal(errorCode(reusedRun), "IDEMPOTENCY_CONFLICT");
    assert.equal(counting.calls.length, 1, "conflicts must not create effects");
  });
});

test("run.start concurrency: N identical concurrent calls -> one launch, one receipt", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher({ delayMs: 100 });
    const service = makeService({ launcher: counting.launcher });
    const responses = (await Promise.all(
      Array.from({ length: 5 }, (_, index) => service.runStart(buildRunStartEnvelope(ctx, { requestId: `req-c${index}` }))),
    )) as JsonObject[];
    for (const response of responses) assertEnvelopeShape(response);
    assert.equal(counting.calls.length, 1, "exactly one launch across concurrent identical calls");
    const outcomes = responses.map((response) => (response.receipt as JsonObject).outcome).sort();
    assert.deepEqual(outcomes, ["created", "replayed", "replayed", "replayed", "replayed"]);
    const receiptIds = new Set(responses.map((response) => (response.receipt as JsonObject).receiptId));
    assert.equal(receiptIds.size, 1, "one stable receipt id");
  });
});

test("run.start validation matrix fails closed before any reservation", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher();
    const service = makeService({ launcher: counting.launcher });
    const cases: Array<{ label: string; envelope: JsonObject; code: string }> = [
      {
        label: "malformed envelope",
        envelope: { protocolVersion: "0.1", requestId: "req-bad" } as JsonObject,
        code: "SCHEMA_UNSUPPORTED",
      },
      {
        label: "digest mismatch",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v1",
          mutateSigned: (envelope) => {
            envelope.requestDigest = "sha256:" + "9".repeat(64);
          },
        }),
        code: "SCHEMA_UNSUPPORTED",
      },
      {
        label: "tampered envelope signature",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v2",
          mutateSigned: (envelope) => {
            envelope.traceId = "trace-tampered";
            envelope.requestDigest = envelope.requestDigest; // digest still valid; signature now stale
          },
        }),
        code: "LEASE_DENIED",
      },
      {
        label: "foreign owner scope",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v3",
          mutateIntent: (intent) => {
            intent.ownerScopeId = "oscope-foreign";
          },
          mutateLease: (lease) => {
            lease.ownerScopeId = "oscope-foreign";
          },
          mutateAuthority: (authority) => {
            authority.ownerScopeId = "oscope-foreign";
          },
        }),
        code: "BINDING_DENIED",
      },
      {
        label: "wrong audience node",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v4",
          mutateLease: (lease) => {
            (lease.audience as JsonObject).nodeId = "node-somewhere-else";
          },
        }),
        code: "LEASE_DENIED",
      },
      {
        label: "expired lease",
        envelope: buildRunStartEnvelope(ctx, { runId: "run-v5", expiresAt: "2026-08-02T00:00:00Z" }),
        code: "LEASE_DENIED",
      },
      {
        label: "stale authority epoch",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v6",
          mutateLease: (lease) => {
            lease.authorityEpoch = 2;
          },
          mutateAuthority: (authority) => {
            authority.authorityEpoch = 2;
          },
        }),
        code: "BINDING_DENIED",
      },
      {
        label: "snapshot digest not leased",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v7",
          mutateIntent: (intent) => {
            (intent.target as JsonObject).digest = "sha256:" + "2".repeat(64);
          },
        }),
        code: "LEASE_DENIED",
      },
      {
        label: "harness differs from lease",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v8",
          mutateIntent: (intent) => {
            (intent.harness as JsonObject).model = "claude-opus-5";
          },
        }),
        code: "LEASE_DENIED",
      },
      {
        label: "capability outside the lease",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v9",
          mutateIntent: (intent) => {
            (intent.requiredCapabilities as JsonObject[]).push({ capability: "harness/codex" });
          },
        }),
        code: "LEASE_DENIED",
      },
      {
        label: "leased but unsupported capability",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v10",
          mutateIntent: (intent) => {
            (intent.requiredCapabilities as JsonObject[]).push({ capability: "provider/microvm" });
          },
          mutateLease: (lease) => {
            (lease.capabilities as JsonObject[]).push({ capability: "provider/microvm" });
          },
        }),
        code: "CAPABILITY_MISMATCH",
      },
      {
        label: "widened mutation authority",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v11",
          mutateIntent: (intent) => {
            (intent.mutationAuthority as JsonObject[]).push({ kind: "branch-push" });
          },
        }),
        code: "LEASE_DENIED",
      },
      {
        label: "unadvertised harness driver",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v12",
          mutateIntent: (intent) => {
            (intent.harness as JsonObject).driverId = "opencode";
            intent.requiredCapabilities = [];
          },
          mutateLease: (lease) => {
            (lease.allowedHarness as JsonObject).driverId = "opencode";
            lease.capabilities = [];
          },
        }),
        code: "HARNESS_UNAVAILABLE",
      },
      {
        label: "capability constraint widened beyond the leased entry",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v14",
          mutateIntent: (intent) => {
            (intent.requiredCapabilities as JsonObject[])[0]!.minVersion = "99.0.0";
          },
        }),
        code: "LEASE_DENIED",
      },
      {
        label: "leased capability constraints unsupported by this node",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v15",
          mutateIntent: (intent) => {
            (intent.requiredCapabilities as JsonObject[])[0]!.minVersion = "1.0.0";
          },
          mutateLease: (lease) => {
            (lease.capabilities as JsonObject[])[0]!.minVersion = "1.0.0";
          },
        }),
        code: "CAPABILITY_MISMATCH",
      },
      {
        label: "foreign trust zone",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v16",
          mutateIntent: (intent) => {
            intent.trustZone = "cloud-shared";
          },
        }),
        code: "CAPABILITY_MISMATCH",
      },
      {
        label: "capability lease linkage broken",
        envelope: buildRunStartEnvelope(ctx, {
          runId: "run-v13",
          mutateAuthority: (authority) => {
            authority.capabilityLeaseId = "cap-lease-other";
          },
        }),
        code: "LEASE_DENIED",
      },
    ];
    for (const testCase of cases) {
      const response = (await service.runStart(testCase.envelope)) as JsonObject;
      assertEnvelopeShape(response);
      assert.equal(errorCode(response), testCase.code, `${testCase.label}: ${JSON.stringify(response.error)}`);
      const runId = ((testCase.envelope.body as JsonObject | undefined)?.intent as JsonObject | undefined)?.runId;
      if (typeof runId === "string") {
        assert.equal(await readReservation(runId), null, `${testCase.label}: no reservation may exist`);
      }
    }
    assert.equal(counting.calls.length, 0, "no refused request may launch");
  });
});

test("run.start launcher failure: typed cause, durable failed state, no relaunch on retry", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const failing = countingLauncher({ failWith: executionError("MATERIALIZATION_FAILED", "working copy wc-0001 is not registered on this node") });
    const service = makeService({ launcher: failing.launcher });
    const response = (await service.runStart(buildRunStartEnvelope(ctx))) as JsonObject;
    assertEnvelopeShape(response);
    assert.equal((response.receipt as JsonObject).outcome, "created");
    assert.deepEqual(response.result, { runId: "run-0001", state: "failed" });
    const reservation = (await readReservation("run-0001"))!;
    assert.equal(reservation.phase, "failed");
    assert.match(reservation.failureCause!, /^MATERIALIZATION_FAILED/);
    const events = await readRunEvents("run-0001");
    assert.ok(events.some((event) => event.type === "run.failed"));

    const retry = (await service.runStart(buildRunStartEnvelope(ctx, { requestId: "req-0002" }))) as JsonObject;
    assert.equal((retry.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(retry.result, { runId: "run-0001", state: "failed" });
    assert.equal(failing.calls.length, 1, "a failed run is terminal; retry is a new runId");
  });
});

test("crash recovery: reserved-not-started relaunches once on identical retry", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const envelope = buildRunStartEnvelope(ctx);
    await stageReservation(ctx, envelope);
    // Simulate a daemon crash after the launch attempt was recorded but before
    // any spawn persistence, past the evidence grace window.
    await mutateReservation("run-0001", (record) => ({
      ...record,
      phase: "launching",
      launchAttemptedAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    const counting = countingLauncher();
    const restarted = makeService({ launcher: counting.launcher });
    const response = (await restarted.runStart(buildRunStartEnvelope(ctx, { requestId: "req-r1" }))) as JsonObject;
    assertEnvelopeShape(response);
    assert.equal((response.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(response.result, { runId: "run-0001", state: "running" });
    assert.equal(counting.calls.length, 1, "the interrupted effect continues with exactly one launch");
    assert.equal((await readReservation("run-0001"))!.phase, "started");
  });
});

test("crash recovery: started-receipt-lost binds the session without a second launch", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const envelope = buildRunStartEnvelope(ctx);
    await stageReservation(ctx, envelope);
    await mutateReservation("run-0001", (record) => ({
      ...record,
      phase: "launching",
      launchAttemptedAt: new Date().toISOString(),
    }));
    // The spawn persisted its record (stamped with the runId) before the crash.
    const now = new Date().toISOString();
    await saveSession({
      name: beeNameForRun("run-0001"),
      agent: "claude",
      cwd: "/",
      command: "claude",
      tmuxTarget: beeNameForRun("run-0001"),
      substrate: "hsr",
      createdAt: now,
      updatedAt: now,
      status: "running",
      executionRunId: "run-0001",
    });

    const counting = countingLauncher();
    const restarted = makeService({ launcher: counting.launcher });
    const response = (await restarted.runStart(buildRunStartEnvelope(ctx, { requestId: "req-r2" }))) as JsonObject;
    assertEnvelopeShape(response);
    assert.equal((response.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(response.result, { runId: "run-0001", state: "running" });
    assert.equal(counting.calls.length, 0, "an already-started run must never launch twice");
    assert.equal((await readReservation("run-0001"))!.phase, "started");
    const events = await readRunEvents("run-0001");
    assert.ok(events.some((event) => event.type === "harness.running"), "repair appends the missing running event");
  });
});

test("crash recovery: fresh crash window and foreign session stamp are indeterminate, never relaunched", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    // Case A: recent attempt, no evidence yet -> indeterminate.
    await stageReservation(ctx, buildRunStartEnvelope(ctx));
    await mutateReservation("run-0001", (record) => ({
      ...record,
      phase: "launching",
      launchAttemptedAt: new Date().toISOString(),
    }));
    const counting = countingLauncher();
    const restarted = makeService({ launcher: counting.launcher });
    const response = (await restarted.runStart(buildRunStartEnvelope(ctx, { requestId: "req-r3" }))) as JsonObject;
    assertEnvelopeShape(response);
    assert.equal((response.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(response.result, { runId: "run-0001", state: "lost" });
    assert.equal(counting.calls.length, 0);
    const reservation = (await readReservation("run-0001"))!;
    assert.ok(reservation.indeterminateAt, "indeterminate outcome is persisted");
    const events = await readRunEvents("run-0001");
    assert.ok(events.some((event) => event.type === "run.lost"));

    // Once indeterminate, even an elapsed grace window cannot relaunch.
    const later = makeService({ launcher: counting.launcher, now: () => new Date(Date.now() + 120_000) });
    const still = (await later.runStart(buildRunStartEnvelope(ctx, { requestId: "req-r4" }))) as JsonObject;
    assert.deepEqual(still.result, { runId: "run-0001", state: "lost" });
    assert.equal(counting.calls.length, 0);

    // Case B: a session under the bound name stamped for a DIFFERENT run.
    const envelopeB = buildRunStartEnvelope(ctx, { runId: "run-0002", effectKey: "job-0001/run-0002/start" });
    await stageReservation(ctx, envelopeB);
    await mutateReservation("run-0002", (record) => ({
      ...record,
      phase: "launching",
      launchAttemptedAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    const now = new Date().toISOString();
    await saveSession({
      name: beeNameForRun("run-0002"),
      agent: "claude",
      cwd: "/",
      command: "claude",
      tmuxTarget: beeNameForRun("run-0002"),
      createdAt: now,
      updatedAt: now,
      status: "running",
      executionRunId: "run-9999",
    });
    const responseB = (await restarted.runStart(
      buildRunStartEnvelope(ctx, { runId: "run-0002", effectKey: "job-0001/run-0002/start", requestId: "req-r5" }),
    )) as JsonObject;
    assert.deepEqual(responseB.result, { runId: "run-0002", state: "lost" });
    assert.equal(counting.calls.length, 0);
  });
});

test("crash recovery: lease expiry before a reserved-not-started relaunch fails the run, no zombie launch", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await stageReservation(ctx, buildRunStartEnvelope(ctx, { expiresAt }));
    await mutateReservation("run-0001", (record) => ({
      ...record,
      phase: "launching",
      launchAttemptedAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    const counting = countingLauncher();
    // The retry arrives two hours later: the recorded receipt still replays,
    // but the expired lease cannot authorize the launch.
    const service = makeService({ launcher: counting.launcher, now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    const response = (await service.runStart(buildRunStartEnvelope(ctx, { requestId: "req-r6", expiresAt }))) as JsonObject;
    assertEnvelopeShape(response);
    assert.equal((response.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(response.result, { runId: "run-0001", state: "failed" });
    assert.equal(counting.calls.length, 0);
    assert.equal((await readReservation("run-0001"))!.result?.cause, "lease_expired");
  });
});

test("corrupt reservation fails closed: no duplicate admission, no silent overwrite", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const counting = countingLauncher();
    const service = makeService({ launcher: counting.launcher });
    await service.runStart(buildRunStartEnvelope(ctx));
    await writeFile(join(runDir("run-0001"), "reservation.json"), "{ torn bytes", "utf8");
    const retry = (await service.runStart(buildRunStartEnvelope(ctx, { requestId: "req-r7" }))) as JsonObject;
    assertEnvelopeShape(retry);
    assert.equal(errorCode(retry), "AUTHORITY_UNAVAILABLE");
    assert.equal((retry.error as JsonObject).retryable, true);
    assert.equal(counting.calls.length, 1, "corruption must never re-admit the effect");
  });
});
