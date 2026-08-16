import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HsrAnswerConflictError,
  assertNoUnresolvedHsrAnswerOwnership,
  canonicalHsrAnswerDigest,
  coordinateHsrAnswerOnHost,
  createHsrAnswerOperation,
  hsrAnswerReconciliationCandidates,
  markHsrAnswerOperationAmbiguous,
  markHsrAnswerOperationSending,
  offerHsrAnswerOperation,
  parseHsrAnswerRpcParams,
  readHsrAnswerReceipt,
  readHsrAnswerReceipts,
  reconcileHsrAnswerOperation,
  type HsrAnswerHostIdentity,
} from "../src/answerReceipt.js";
import { answerAmbiguityRequestId, needsInputRequestId } from "../src/requests/keys.js";
import { withRunnableSessionAdmission } from "../src/delivery.js";
import { withBeeNameLaunchAdmission } from "../src/nameAdmission.js";
import { beginBeeReplacementOperation } from "../src/nameAdmission.js";
import { withSessionLifecycleTransaction } from "../src/lifecycle.js";
import { reviveHsrForAutomaticRecovery } from "../src/recovery/revive.js";
import { purgeSessionData } from "../src/kill.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import { answerLocalHsrSessionInAdmission } from "../src/hsr/answer.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { startRpcServer } from "../src/hsr/rpc.js";

async function withTempStore(fn: (root: string) => Promise<void>): Promise<void> {
  const previous = process.env.HIVE_STORE_ROOT;
  const root = await mkdtemp(join(tmpdir(), "honeybee-answer-receipt-"));
  process.env.HIVE_STORE_ROOT = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function record(name = "answer-bee", overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "stub",
    cwd: process.cwd(),
    command: "stub",
    tmuxTarget: name,
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
    status: "running",
    substrate: "hsr",
    runtimeGeneration: 3,
    id: `id-${name}`,
    uuid: `uuid-${name}`,
    ...overrides,
  };
}

const hostA: HsrAnswerHostIdentity = {
  hostPid: 101,
  startedAt: "2026-08-15T10:00:01.000Z",
  hostFingerprint: { pgid: 101, startedAt: "host-a-birth" },
};

const hostB: HsrAnswerHostIdentity = {
  hostPid: 202,
  startedAt: "2026-08-15T10:00:02.000Z",
  hostFingerprint: { pgid: 202, startedAt: "host-b-birth" },
};

function receiptFile(root: string, bee: string, operation: ReturnType<typeof createHsrAnswerOperation>): string {
  const beeKey = createHash("sha256").update(bee).digest("hex");
  const operationKey = createHash("sha256").update(JSON.stringify(operation)).digest("hex");
  return join(root, "hsr-answer-receipts", beeKey, `answer-${operationKey}.json`);
}

test("answer receipt parser is strict and receipt stores only the canonical digest", async () => {
  await withTempStore(async (root) => {
    const source = record();
    const operation = createHsrAnswerOperation(source, "provider-1", "super-secret-answer", hostA);
    assert.equal(parseHsrAnswerRpcParams({ operation, answer: "super-secret-answer" }).operation, operation);
    assert.throws(
      () => parseHsrAnswerRpcParams({ operation, answer: "different" }),
      HsrAnswerConflictError,
    );
    assert.throws(
      () => parseHsrAnswerRpcParams({ operation, answer: "super-secret-answer", extra: true }),
      /malformed/,
    );
    assert.throws(
      () => parseHsrAnswerRpcParams({
        operation: {
          ...operation,
          source: { ...operation.source, node: "remote", remoteLaunchId: "launch-without-incarnation" },
        },
        answer: "super-secret-answer",
      }),
      /malformed/,
    );

    await offerHsrAnswerOperation(source.name, operation);
    const path = receiptFile(root, source.name, operation);
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes("super-secret-answer"));
    assert.ok(raw.includes(canonicalHsrAnswerDigest("super-secret-answer")));

    const malformed = { ...JSON.parse(raw), unexpected: true };
    await writeFile(path, JSON.stringify(malformed));
    await assert.rejects(readHsrAnswerReceipt(source.name, operation), /malformed HSR answer receipt/);
  });
});

test("answer receipt reads treat non-ENOENT storage failures as closed", async () => {
  await withTempStore(async (root) => {
    const source = record("answer-read-failure");
    const operation = createHsrAnswerOperation(source, "provider-read", "yes", hostA);
    const beeKey = createHash("sha256").update(source.name).digest("hex");
    await mkdir(join(root, "hsr-answer-receipts"), { recursive: true });
    await writeFile(join(root, "hsr-answer-receipts", beeKey), "not-a-directory");
    await assert.rejects(
      readHsrAnswerReceipt(source.name, operation),
      /could not enumerate HSR answer receipts/,
    );
  });
});

test("sending receipt requires a strict transport authority", async () => {
  await withTempStore(async (root) => {
    const source = record("answer-sending-parser");
    const operation = createHsrAnswerOperation(source, "provider-sending", "yes", hostA);
    await offerHsrAnswerOperation(source.name, operation);
    const sending = await markHsrAnswerOperationSending(source.name, operation, "controller");
    assert.equal(sending.phase, "sending");
    assert.equal(sending.sendingAuthority, "controller");
    const promoted = await markHsrAnswerOperationSending(source.name, operation, "node");
    assert.equal(promoted.sendingAuthority, "node");
    assert.equal(
      (await markHsrAnswerOperationSending(source.name, operation, "controller")).sendingAuthority,
      "node",
      "loopback controller replay never downgrades node transport ownership",
    );

    const path = receiptFile(root, source.name, operation);
    const malformed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete malformed.sendingAuthority;
    await writeFile(path, JSON.stringify(malformed));
    await assert.rejects(readHsrAnswerReceipt(source.name, operation), /malformed HSR answer receipt/);
  });
});

test("new controller refuses a legacy host before offer, sending, or provider I/O", async () => {
  await withTempStore(async (root) => {
    const source = record("answer-legacy-host");
    await saveSession(source);
    await ensureHsrRunDir(source.name);
    const socketPath = join(root, "legacy-host", "control.sock");
    let providerEffects = 0;
    const legacy = await startRpcServer({
      socketPath,
      methods: {
        // Pre-receipt hosts exposed only this legacy answer shape and no
        // side-effect-free capability proof.
        answer: () => { providerEffects += 1; },
      },
    });
    await writeHsrMeta(source.name, {
      bee: source.name,
      harness: "stub",
      tier: "stream",
      hostPid: hostA.hostPid,
      hostFingerprint: hostA.hostFingerprint,
      startedAt: hostA.startedAt,
      controlSocket: socketPath,
      status: "running",
    });
    try {
      await assert.rejects(
        answerLocalHsrSessionInAdmission(source, "provider-legacy", "yes"),
        /answerCapabilities|durable answer receipts|method not found/i,
      );
      assert.equal(providerEffects, 0);
      assert.deepEqual(await readHsrAnswerReceipts(source.name), [], "capability refusal leaves no answer fence");
    } finally {
      await legacy.close();
    }
  });
});

test("host coordinator leaves preflight failures offered, settles on callback proof, and replays without a second write", async () => {
  await withTempStore(async () => {
    const source = record();
    const operation = createHsrAnswerOperation(source, "provider-2", "yes", hostA);
    await offerHsrAnswerOperation(source.name, operation);
    await markHsrAnswerOperationSending(source.name, operation);
    await assert.rejects(
      coordinateHsrAnswerOnHost({
        bee: source.name,
        operation,
        host: hostA,
        prepare: async () => { throw new Error("stdin is not writable"); },
      }),
      /stdin is not writable/,
    );
    assert.equal((await readHsrAnswerReceipt(source.name, operation))?.phase, "offered");

    let writes = 0;
    await markHsrAnswerOperationSending(source.name, operation);
    const first = await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation,
      host: hostA,
      prepare: async () => async () => { writes += 1; },
    });
    assert.deepEqual(first, { status: "settled", replayed: false, host: hostA });
    const replay = await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation,
      host: hostA,
      prepare: async () => { throw new Error("pending input was already removed"); },
    });
    assert.deepEqual(replay, { status: "settled", replayed: true, host: hostA });
    assert.equal(writes, 1);
  });
});

test("same-host concurrent duplicate is in-flight while post-call dispatch residue becomes ambiguous", async () => {
  await withTempStore(async (root) => {
    const source = record();
    const operation = createHsrAnswerOperation(source, "provider-3", "yes", hostA);
    await offerHsrAnswerOperation(source.name, operation);
    await markHsrAnswerOperationSending(source.name, operation);
    let entered!: () => void;
    const atDispatch = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinateHsrAnswerOnHost({
      bee: source.name,
      operation,
      host: hostA,
      prepare: async () => async () => { entered(); await hold; },
    });
    await atDispatch;
    assert.deepEqual(await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation,
      host: hostA,
      prepare: async () => async () => { throw new Error("must not write"); },
    }), { status: "in-flight" });
    release();
    assert.equal((await first).status, "settled");

    const abandoned = createHsrAnswerOperation(source, "provider-4", "yes", hostA);
    const offered = await offerHsrAnswerOperation(source.name, abandoned);
    await writeFile(receiptFile(root, source.name, abandoned), JSON.stringify({
      ...offered,
      phase: "dispatching",
      host: hostA,
      updatedAt: "2026-08-15T10:01:00.000Z",
    }));
    let prepared = false;
    const result = await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation: abandoned,
      host: hostA,
      prepare: async () => { prepared = true; return async () => undefined; },
    });
    assert.equal(result.status, "ambiguous");
    assert.equal(prepared, false);
  });
});

test("caller sending receipt fences replacement while a delayed host claim completes", async () => {
  await withTempStore(async () => {
    const source = record("answer-late-host-claim");
    await saveSession(source);
    const operation = createHsrAnswerOperation(source, "provider-late", "yes", hostA);
    await offerHsrAnswerOperation(source.name, operation);

    let providerEffects = 0;
    const bareOffer = await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation,
      host: hostA,
      prepare: async () => {
        providerEffects += 1;
        return async () => { providerEffects += 1; };
      },
    });
    assert.equal(bareOffer.status, "conflict", "a late handler cannot claim a correction-safe offer");
    assert.equal(providerEffects, 0);

    await markHsrAnswerOperationSending(source.name, operation);
    let prepareEntered!: () => void;
    const atPrepare = new Promise<void>((resolve) => { prepareEntered = resolve; });
    let releasePrepare!: () => void;
    const holdPrepare = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const lateHost = coordinateHsrAnswerOnHost({
      bee: source.name,
      operation,
      host: hostA,
      prepare: async () => {
        prepareEntered();
        await holdPrepare;
        return async () => { providerEffects += 1; };
      },
    });
    await atPrepare;

    let replacementEffects = 0;
    await assert.rejects(
      withRunnableSessionAdmission(source, async () => { replacementEffects += 1; }),
      /unresolved answer ownership/,
    );
    assert.equal(replacementEffects, 0, "caller death cannot unlock replacement/new delivery");
    assert.equal(providerEffects, 0, "provider dispatch waits for the host's durable claim");

    releasePrepare();
    assert.equal((await lateHost).status, "settled");
    assert.equal(providerEffects, 1);
  });
});

test("old-host dispatch is ambiguous and a different digest conflicts until operator verdict", async () => {
  await withTempStore(async (root) => {
    const source = record();
    const operation = createHsrAnswerOperation(source, "provider-5", "yes", hostA);
    const offered = await offerHsrAnswerOperation(source.name, operation);
    await writeFile(receiptFile(root, source.name, operation), JSON.stringify({
      ...offered,
      phase: "dispatching",
      host: hostA,
      updatedAt: "2026-08-15T10:01:00.000Z",
    }));
    const result = await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation,
      host: hostB,
      prepare: async () => async () => undefined,
    });
    assert.equal(result.status, "ambiguous");
    await assert.rejects(
      offerHsrAnswerOperation(source.name, createHsrAnswerOperation(source, "provider-5", "no", hostA)),
      HsrAnswerConflictError,
    );
    assert.equal((await reconcileHsrAnswerOperation(source.name, operation, "discard")).phase, "discarded");
    assert.equal((await offerHsrAnswerOperation(
      source.name,
      createHsrAnswerOperation(source, "provider-5", "no", hostA),
    )).phase, "offered");
  });
});

test("hostless caller ambiguity round-trips, fences work/name reuse, and reconciles without provider I/O", async () => {
  await withTempStore(async () => {
    const source = record("fenced-answer");
    await saveSession(source);
    const operation = createHsrAnswerOperation(source, "provider-6", "yes", hostA);
    await offerHsrAnswerOperation(source.name, operation);
    await markHsrAnswerOperationAmbiguous(source.name, operation, "remote reply was lost");
    assert.equal((await readHsrAnswerReceipt(source.name, operation))?.host, undefined);
    await assert.rejects(assertNoUnresolvedHsrAnswerOwnership(source, "test work"), /unresolved answer ownership/);

    let workEffects = 0;
    await assert.rejects(
      withRunnableSessionAdmission(source, async () => { workEffects += 1; }),
      /unresolved answer ownership/,
    );
    assert.equal(workEffects, 0);

    let reviveEffects = 0;
    await assert.rejects(
      reviveHsrForAutomaticRecovery(source, "answer-ambiguity", {
        revive: async (candidate) => { reviveEffects += 1; return candidate; },
      }),
      /unresolved answer ownership/,
    );
    assert.equal(reviveEffects, 0);

    await assert.rejects(
      withSessionLifecycleTransaction(source, (lifecycle) =>
        beginBeeReplacementOperation(lifecycle, "answer-ambiguity-test")),
      /unresolved answer ownership/,
    );

    await rm(join(process.env.HIVE_STORE_ROOT!, "sessions", `${source.name}.json`), { force: true });
    let launchEffects = 0;
    await assert.rejects(
      withBeeNameLaunchAdmission(source.name, async () => { launchEffects += 1; }),
      /unresolved answer ownership/,
    );
    assert.equal(launchEffects, 0);

    assert.equal((await reconcileHsrAnswerOperation(source.name, operation, "delivered")).phase, "settled");
    assert.equal((await readHsrAnswerReceipt(source.name, operation))?.phase, "settled");
  });
});

test("operator delivered/discard reconciliation is idempotent and invokes no provider callback", async () => {
  await withTempStore(async () => {
    const source = record();
    const delivered = createHsrAnswerOperation(source, "provider-7", "yes", hostA);
    await offerHsrAnswerOperation(source.name, delivered);
    await markHsrAnswerOperationAmbiguous(source.name, delivered, "unknown");
    assert.equal((await reconcileHsrAnswerOperation(source.name, delivered, "delivered")).phase, "settled");
    assert.equal((await reconcileHsrAnswerOperation(source.name, delivered, "delivered")).phase, "settled");

    const discarded = createHsrAnswerOperation(source, "provider-8", "no", hostA);
    await offerHsrAnswerOperation(source.name, discarded);
    await markHsrAnswerOperationAmbiguous(source.name, discarded, "unknown");
    assert.equal((await reconcileHsrAnswerOperation(source.name, discarded, "discard")).phase, "discarded");
    assert.equal((await reconcileHsrAnswerOperation(source.name, discarded, "discard")).phase, "discarded");
  });
});

test("an unresolved request X blocks request Y while allowing only X's exact retry", async () => {
  await withTempStore(async () => {
    const source = record("answer-admission");
    const operationX = createHsrAnswerOperation(source, "provider-x", "yes", hostA);
    await offerHsrAnswerOperation(source.name, operationX);
    const operationY = createHsrAnswerOperation(source, "provider-y", "yes", hostA);
    await offerHsrAnswerOperation(source.name, operationY);
    await markHsrAnswerOperationAmbiguous(source.name, operationX, "provider outcome unknown");

    let providerEffects = 0;
    await assert.rejects(
      (async () => {
        await assertNoUnresolvedHsrAnswerOwnership(source, "answer request Y", operationY);
        providerEffects += 1;
      })(),
      /unresolved answer ownership for request provider-x/,
    );
    assert.equal(providerEffects, 0);
    await assert.doesNotReject(assertNoUnresolvedHsrAnswerOwnership(source, "exact retry X", operationX));

    await markHsrAnswerOperationSending(source.name, operationY);
    const hostResult = await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation: operationY,
      host: hostA,
      prepare: async () => {
        providerEffects += 1;
        return async () => { providerEffects += 1; };
      },
    });
    assert.equal(hostResult.status, "conflict");
    assert.equal(providerEffects, 0, "host coordinator independently fences request Y");
  });
});

test("a refreshed host epoch never replays an older settled request id", async () => {
  await withTempStore(async () => {
    const source = record("answer-host-epoch");
    const first = createHsrAnswerOperation(source, "provider-reused", "yes", hostA);
    await offerHsrAnswerOperation(source.name, first);
    await markHsrAnswerOperationSending(source.name, first);
    let writesA = 0;
    assert.equal((await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation: first,
      host: hostA,
      prepare: async () => async () => { writesA += 1; },
    })).status, "settled");

    const refreshed = createHsrAnswerOperation(source, "provider-reused", "yes", hostB);
    assert.equal((await offerHsrAnswerOperation(source.name, refreshed)).phase, "offered");
    await markHsrAnswerOperationSending(source.name, refreshed);
    let writesB = 0;
    const result = await coordinateHsrAnswerOnHost({
      bee: source.name,
      operation: refreshed,
      host: hostB,
      prepare: async () => async () => { writesB += 1; },
    });
    assert.deepEqual(result, { status: "settled", replayed: false, host: hostB });
    assert.equal(writesA, 1);
    assert.equal(writesB, 1);
  });
});

test("reconciliation and request ids select the unresolved refreshed host epoch", async () => {
  await withTempStore(async () => {
    const source = record("answer-host-reconcile");
    const answer = "yes";
    const first = createHsrAnswerOperation(source, "provider-reused", answer, hostA);
    await offerHsrAnswerOperation(source.name, first);
    await reconcileHsrAnswerOperation(source.name, first, "delivered");

    const refreshed = createHsrAnswerOperation(source, "provider-reused", answer, hostB);
    await offerHsrAnswerOperation(source.name, refreshed);
    await markHsrAnswerOperationAmbiguous(source.name, refreshed, "refreshed host reply lost");
    const selected = hsrAnswerReconciliationCandidates({
      receipts: [
        (await readHsrAnswerReceipt(source.name, first))!,
        (await readHsrAnswerReceipt(source.name, refreshed))!,
      ],
      requestId: refreshed.requestId,
      runtimeGeneration: source.runtimeGeneration!,
      answerDigest: refreshed.answerDigest,
      current: source,
    });
    assert.deepEqual(selected.map((receipt) => receipt.operation), [refreshed]);

    assert.notEqual(
      answerAmbiguityRequestId(source.name, source.runtimeGeneration!, first.requestId, first.answerDigest, hostA),
      answerAmbiguityRequestId(source.name, source.runtimeGeneration!, refreshed.requestId, refreshed.answerDigest, hostB),
    );
    assert.notEqual(
      needsInputRequestId(source.name, { requestId: first.requestId, ts: 1, host: hostA }),
      needsInputRequestId(source.name, { requestId: refreshed.requestId, ts: 1, host: hostB }),
    );
  });
});

test("session purge retains the canonical retry locator until answer reconciliation", async () => {
  await withTempStore(async () => {
    const source = record("answer-purge-fence", {
      status: "kill_failed",
      remoteLaunchId: "launch-answer-purge",
      remoteIncarnation: "inc-answer-purge",
      node: "remote-answer-node",
    });
    await saveSession(source);
    const operation = createHsrAnswerOperation(source, "provider-purge", "yes", hostA);
    await offerHsrAnswerOperation(source.name, operation);
    await markHsrAnswerOperationAmbiguous(source.name, operation, "stop crossed unresolved answer");

    await assert.rejects(
      purgeSessionData(source, { emitLedger: false }),
      /unresolved answer ownership/,
    );
    assert.deepEqual(await loadSession(source.name), source, "purge fence preserves the remote reconciliation locator");

    await reconcileHsrAnswerOperation(source.name, operation, "discard");
    assert.equal(await purgeSessionData(source, { emitLedger: false }), true);
    assert.equal(await loadSession(source.name), null);
  });
});
