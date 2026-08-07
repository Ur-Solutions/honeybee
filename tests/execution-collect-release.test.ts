// H3 run.collect / run.retain / run.release: digest-addressed node-local
// evidence that survives restart, retention as a debug-window extension only,
// and desired-state release over a durable step ledger (RFC acceptance tests
// 15 and 16, local portion).
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { computeSchemaDigest, createExecutionValidator, loadExecutionContract, type JsonObject } from "../src/execution/contract.js";
import { collectGitDiffMetadata, readEvidence } from "../src/execution/evidence.js";
import { admitOperation, readOperation } from "../src/execution/opsStore.js";
import { canonicalDigest } from "../src/comb/canonical.js";
import { createRunOperations } from "../src/execution/operations.js";
import { effectKeyHash, mutateReservation, readReservation, readRunEvents } from "../src/execution/runStore.js";
import { storeSessionEvidenceSource } from "../src/execution/service.js";
import { claimWorkingCopy, readWorkingCopy, registerWorkingCopy } from "../src/execution/workingCopies.js";
import type { JsonValue } from "../src/comb/types.js";
import {
  beeNameForRun,
  buildOperationEnvelope,
  buildRunStartEnvelope,
  countingLauncher,
  fakeControl,
  installTestAuthority,
  makeService,
  withTempStore,
  SNAPSHOT_DIGEST,
  type TestAuthority,
} from "./executionTestKit.js";

const execFileAsync = promisify(execFile);
const contract = loadExecutionContract();
const validator = createExecutionValidator(contract);
const RUN_ID = "run-0001";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initializeGitWorkingCopy(repo: string): Promise<string> {
  await git(repo, ["init", "--initial-branch", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "app.txt"), "one\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "init"]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

/** Real git working copy registered + claimed for the run, with a dirty edit. */
async function withGitWorkingCopy(fn: (repo: string, head: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "honeybee-h3-repo-"));
  try {
    const head = await initializeGitWorkingCopy(repo);
    await writeFile(join(repo, "app.txt"), "one\ntwo\n");
    await fn(repo, head);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

function collectEnvelope(ctx: TestAuthority, effectKey = `${RUN_ID}/collect`, requestId?: string): JsonObject {
  return buildOperationEnvelope(ctx, effectKey, { runId: RUN_ID }, requestId ? { requestId } : {});
}

async function startRun(opts: { control?: ReturnType<typeof fakeControl> } = {}) {
  const ctx = await installTestAuthority();
  const counting = countingLauncher();
  const control = opts.control ?? fakeControl();
  const service = makeService({ launcher: counting.launcher, control: control.control });
  await service.runStart(buildRunStartEnvelope(ctx));
  return { ctx, counting, control, service };
}

test("run.collect: digest-addressed manifest with log, diff, environment-manifest; replay and restart are byte-stable", async () => {
  await withTempStore(async () => {
    await withGitWorkingCopy(async (repo, head) => {
      const { ctx, service } = await startRun();
      await registerWorkingCopy({
        workingCopyId: "wc-0001",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
        revision: head,
        branch: "main",
      });
      await claimWorkingCopy("wc-0001", RUN_ID);

      const response = (await service.runCollect(collectEnvelope(ctx))) as JsonObject;
      assert.deepEqual(validator.validate("execution-response-envelope", response).errors, []);
      const manifest = response.result as JsonObject;
      assert.deepEqual(validator.validate("collection-manifest", manifest).errors, []);
      assert.equal(manifest.state, "complete");
      const entries = manifest.entries as JsonObject[];
      const kinds = entries.map((entry) => entry.kind).sort();
      // transcript is honestly absent (no HSR events file for the fake bee).
      assert.deepEqual(kinds, ["diff", "environment-manifest", "log"]);

      for (const entry of entries) {
        const ref = entry.ref as JsonObject;
        assert.equal(ref.kind, "node-local");
        // The token resolves through the provider-owned path and the bytes
        // match the manifest digest exactly (readEvidence verifies).
        const bytes = await readEvidence(String(ref.token));
        assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.digest);
        assert.equal(bytes.length, entry.sizeBytes);
      }

      const diffEntry = entries.find((entry) => entry.kind === "diff")!;
      const diff = JSON.parse((await readEvidence(String((diffEntry.ref as JsonObject).token))).toString()) as JsonObject;
      assert.equal(diff.baseRevision, head);
      assert.equal(diff.workingCopyId, "wc-0001");
      assert.equal((diff.diff as JsonObject).filesChanged, 1);
      assert.ok((diff.status as JsonObject[]).some((line) => line.path === "app.txt"));

      const envEntry = entries.find((entry) => entry.kind === "environment-manifest")!;
      const envManifest = JSON.parse((await readEvidence(String((envEntry.ref as JsonObject).token))).toString()) as JsonObject;
      assert.equal(envManifest.runId, RUN_ID);
      assert.equal((envManifest.harness as JsonObject).driverId, "claude");
      // No credential-looking bytes: the manifest is built from admitted
      // protocol facts only, never the process environment.
      const serialized = JSON.stringify(envManifest);
      assert.ok(!serialized.includes("PATH="), "no environment variables in the manifest");
      assert.ok(!/sk-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}/.test(serialized));

      assert.ok((await readRunEvents(RUN_ID)).some((event) => event.type === "collection.completed"));

      // Identical retry replays the recorded manifest byte-stably even though
      // the underlying tree/log kept changing.
      await writeFile(join(repo, "app.txt"), "one\ntwo\nthree\n");
      const replay = (await service.runCollect(collectEnvelope(ctx, `${RUN_ID}/collect`, "req-collect-2"))) as JsonObject;
      assert.equal((replay.receipt as JsonObject).outcome, "replayed");
      assert.equal(canonicalDigest(replay.result as JsonValue), canonicalDigest(manifest as JsonValue));

      // Restart survival: a fresh coordinator replays the same manifest and
      // the evidence bytes are still resolvable.
      const restarted = makeService({ control: fakeControl().control });
      const afterRestart = (await restarted.runCollect(collectEnvelope(ctx, `${RUN_ID}/collect`, "req-collect-3"))) as JsonObject;
      assert.equal(canonicalDigest(afterRestart.result as JsonValue), canonicalDigest(manifest as JsonValue));
      await readEvidence(String((diffEntry.ref as JsonObject).token));

      // A NEW collect effect snapshots the changed tree under a new receipt.
      const fresh = (await service.runCollect(collectEnvelope(ctx, `${RUN_ID}/collect-0002`))) as JsonObject;
      assert.equal((fresh.receipt as JsonObject).outcome, "created");
      assert.notEqual(canonicalDigest(fresh.result as JsonValue), canonicalDigest(manifest as JsonValue));
    });
  });
});

test("run.collect works on a terminal run and after lease expiry (evidence is not mutation)", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const control = fakeControl();
    const service = makeService({ control: control.control });
    await service.runStart(buildRunStartEnvelope(ctx, { expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }));
    await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID }));

    const later = makeService({ control: control.control, now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    const response = (await later.runCollect(collectEnvelope(ctx))) as JsonObject;
    const manifest = response.result as JsonObject;
    assert.equal(manifest.state, "complete");
    // Log evidence includes the cancellation history collected post-terminal.
    const logEntry = (manifest.entries as JsonObject[]).find((entry) => entry.kind === "log")!;
    const log = (await readEvidence(String((logEntry.ref as JsonObject).token))).toString();
    assert.ok(log.includes("run.cancelled"));
  });
});

test("run.collect retries the same stable effect after a transient failure and replaces it with complete", async () => {
  await withTempStore(async () => {
    const repo = await mkdtemp(join(tmpdir(), "honeybee-h3-repairable-"));
    try {
      const { ctx, service } = await startRun();
      // Registered and owned, but not a git repository yet: diff collection
      // fails transiently after admission rather than fabricating completion.
      await registerWorkingCopy({
        workingCopyId: "wc-0001",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
      });
      await claimWorkingCopy("wc-0001", RUN_ID);

      const envelope = collectEnvelope(ctx);
      const failed = (await service.runCollect(envelope)) as JsonObject;
      assert.equal((failed.result as JsonObject).state, "failed");
      const failedReceipt = failed.receipt as JsonObject;
      const failedRecord = (await readOperation(RUN_ID, `${RUN_ID}/collect`))!;
      assert.equal(failedRecord.collectionFailure, "retryable");
      assert.equal(failedRecord.collectionState, "failed");

      await initializeGitWorkingCopy(repo);
      const recovered = (await service.runCollect(collectEnvelope(ctx, `${RUN_ID}/collect`, "req-collect-recover"))) as JsonObject;
      assert.equal((recovered.receipt as JsonObject).outcome, "replayed");
      assert.equal((recovered.receipt as JsonObject).receiptId, failedReceipt.receiptId);
      assert.equal((recovered.receipt as JsonObject).resultVersion, 2);
      assert.equal((recovered.result as JsonObject).state, "complete");
      const recoveredRecord = (await readOperation(RUN_ID, `${RUN_ID}/collect`))!;
      assert.equal(recoveredRecord.collectionState, "complete");
      assert.equal(recoveredRecord.collectionFailure, undefined);
      assert.equal(recoveredRecord.cause, undefined);
      assert.equal((await readRunEvents(RUN_ID)).filter((event) => event.type === "collection.completed").length, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("run.collect retryable failure survives coordinator restart and the same effect resumes", async () => {
  await withTempStore(async () => {
    const repo = await mkdtemp(join(tmpdir(), "honeybee-h3-restart-repair-"));
    try {
      const { ctx, service } = await startRun();
      await registerWorkingCopy({
        workingCopyId: "wc-0001",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
      });
      await claimWorkingCopy("wc-0001", RUN_ID);
      const first = (await service.runCollect(collectEnvelope(ctx))) as JsonObject;
      assert.equal((first.result as JsonObject).state, "failed");
      assert.equal((await readOperation(RUN_ID, `${RUN_ID}/collect`))!.collectionFailure, "retryable");

      await initializeGitWorkingCopy(repo);
      const restarted = makeService({ control: fakeControl().control });
      const recovered = (await restarted.runCollect(collectEnvelope(ctx, `${RUN_ID}/collect`, "req-after-restart"))) as JsonObject;
      assert.equal((recovered.receipt as JsonObject).outcome, "replayed");
      assert.equal((recovered.result as JsonObject).state, "complete");
      assert.equal((await readOperation(RUN_ID, `${RUN_ID}/collect`))!.collectionState, "complete");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("two service instances join one durable failed-to-collecting recovery attempt", async () => {
  await withTempStore(async () => {
    const repo = await mkdtemp(join(tmpdir(), "honeybee-h3-two-service-collect-"));
    try {
      const control = fakeControl();
      const { ctx, service } = await startRun({ control });
      await registerWorkingCopy({
        workingCopyId: "wc-0001",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
      });
      await claimWorkingCopy("wc-0001", RUN_ID);
      const effectKey = `${RUN_ID}/collect-two-service`;
      const failed = (await service.runCollect(collectEnvelope(ctx, effectKey))) as JsonObject;
      assert.equal((failed.result as JsonObject).state, "failed");
      await initializeGitWorkingCopy(repo);

      let reachedCollector!: () => void;
      const collectorPaused = new Promise<void>((resolve) => {
        reachedCollector = resolve;
      });
      let resumeCollector!: () => void;
      const resume = new Promise<void>((resolve) => {
        resumeCollector = resolve;
      });
      const common = {
        contract,
        validator,
        protocolVersion: "0.1",
        schemaDigest: computeSchemaDigest(contract),
        now: () => new Date(),
        binding: async () => ctx.binding,
        control: control.control,
        sessions: storeSessionEvidenceSource(),
        settle: async (reservation: NonNullable<Awaited<ReturnType<typeof readReservation>>>) => ({ reservation, state: "running" }),
        origin: async () => ({ nodeId: ctx.nodeId }),
      };
      const serviceA = createRunOperations({
        ...common,
        collectGitDiffMetadata: async (copy, generatedAt) => {
          reachedCollector();
          await resume;
          return collectGitDiffMetadata(copy, generatedAt);
        },
      });
      let peerCollectorCalls = 0;
      const serviceB = createRunOperations({
        ...common,
        collectGitDiffMetadata: async (copy, generatedAt) => {
          peerCollectorCalls += 1;
          return collectGitDiffMetadata(copy, generatedAt);
        },
      });

      const aPromise = serviceA.runCollect(collectEnvelope(ctx, effectKey, "req-collect-service-a"));
      await collectorPaused;
      const owned = (await readOperation(RUN_ID, effectKey))!;
      assert.equal(owned.collectionState, "collecting");
      assert.equal(owned.operationAttempt?.kind, "collection");
      assert.equal(owned.receipt.resultVersion, 1, "the prior failed receipt remains canonical until replacement");

      let peerSettled = false;
      const bPromise = serviceB.runCollect(collectEnvelope(ctx, effectKey, "req-collect-service-b")).finally(() => {
        peerSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.equal(peerSettled, false);
      assert.equal(peerCollectorCalls, 0, "the peer never enters collection while the durable owner is live");
      assert.equal((await readOperation(RUN_ID, effectKey))!.receipt.resultVersion, 1);

      resumeCollector();
      const [a, b] = (await Promise.all([aPromise, bPromise])) as JsonObject[];
      assert.equal(peerCollectorCalls, 0);
      assert.equal(canonicalDigest(a.result as JsonValue), canonicalDigest(b.result as JsonValue));
      assert.equal((a.receipt as JsonObject).receiptId, (b.receipt as JsonObject).receiptId);
      assert.equal((a.receipt as JsonObject).resultVersion, 2);
      assert.equal((b.receipt as JsonObject).resultVersion, 2);
      const completed = (await readOperation(RUN_ID, effectKey))!;
      assert.equal(completed.collectionState, "complete");
      assert.equal(completed.operationAttempt, undefined);
      assert.equal(completed.receipt.resultVersion, 2);
      assert.equal((await readRunEvents(RUN_ID)).filter((event) => event.type === "collection.completed").length, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test("run.collect holds working-copy ownership through its durable snapshot before release hands the copy to another run", async () => {
  await withTempStore(async () => {
    await withGitWorkingCopy(async (repo, head) => {
      const control = fakeControl();
      const { ctx, service } = await startRun({ control });
      await registerWorkingCopy({
        workingCopyId: "wc-0001",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
        revision: head,
        branch: "main",
      });
      await claimWorkingCopy("wc-0001", RUN_ID);

      let reachedOwnedRead!: () => void;
      const ownedRead = new Promise<void>((resolve) => {
        reachedOwnedRead = resolve;
      });
      let resumeCollection!: () => void;
      const resume = new Promise<void>((resolve) => {
        resumeCollection = resolve;
      });
      const pausedOps = createRunOperations({
        contract,
        validator,
        protocolVersion: "0.1",
        schemaDigest: computeSchemaDigest(contract),
        now: () => new Date(),
        binding: async () => ctx.binding,
        control: control.control,
        sessions: storeSessionEvidenceSource(),
        settle: async (reservation) => ({ reservation, state: "running" }),
        origin: async () => ({ nodeId: ctx.nodeId }),
        collectGitDiffMetadata: async (copy, generatedAt) => {
          // This callback is entered only after occupancy was revalidated while
          // holding the shared per-copy lock, immediately before git reads.
          reachedOwnedRead();
          await resume;
          return collectGitDiffMetadata(copy, generatedAt);
        },
      });

      const collecting = pausedOps.runCollect(collectEnvelope(ctx, `${RUN_ID}/collect-ownership-barrier`));
      await ownedRead;

      let stopReached!: () => void;
      const stopped = new Promise<void>((resolve) => {
        stopReached = resolve;
      });
      const baseStop = control.control.stop;
      control.control.stop = async (beeName) => {
        stopReached();
        return baseStop(beeName);
      };
      let handoffSettled = false;
      const handoff = (async () => {
        const released = (await service.runRelease(
          buildOperationEnvelope(ctx, `${RUN_ID}/release-ownership-barrier`, { runId: RUN_ID }),
        )) as JsonObject;
        assert.equal((released.result as JsonObject).environmentState, "released");
        await claimWorkingCopy("wc-0001", "run-B");
        await writeFile(join(repo, "b-only.txt"), "belongs to run B\n");
      })().finally(() => {
        handoffSettled = true;
      });
      await stopped;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(handoffSettled, false, "release and successor claim wait for A's collection lease");
      assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, RUN_ID);

      resumeCollection();
      const collected = (await collecting) as JsonObject;
      await handoff;
      assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, "run-B");

      const manifest = collected.result as JsonObject;
      assert.equal(manifest.state, "complete");
      const diffEntry = (manifest.entries as JsonObject[]).find((entry) => entry.kind === "diff")!;
      const diff = JSON.parse((await readEvidence(String((diffEntry.ref as JsonObject).token))).toString()) as JsonObject;
      const paths = (diff.status as JsonObject[]).map((entry) => entry.path);
      assert.ok(paths.includes("app.txt"), "A's dirty state is present");
      assert.ok(!paths.includes("b-only.txt"), "successor state cannot leak into A's evidence");
    });
  });
});

test("run.retain extends the debug window monotonically; run.get projects retainedUntil", async () => {
  await withTempStore(async () => {
    const { ctx, service } = await startRun();
    const until = "2036-02-01T00:00:00Z";
    const response = (await service.runRetain(buildOperationEnvelope(ctx, `${RUN_ID}/retain-0001`, { runId: RUN_ID, retainUntil: until }))) as JsonObject;
    assert.deepEqual(response.result, { runId: RUN_ID, retainedUntil: until });

    const projection = ((await service.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
    assert.equal((projection.environment as JsonObject).retainedUntil, until);
    assert.deepEqual(validator.validate("run-projection", projection).errors, []);

    // An earlier retainUntil under a new effect never SHRINKS the window.
    const earlier = "2036-01-15T00:00:00Z";
    const shrink = (await service.runRetain(buildOperationEnvelope(ctx, `${RUN_ID}/retain-0002`, { runId: RUN_ID, retainUntil: earlier }))) as JsonObject;
    assert.deepEqual(shrink.result, { runId: RUN_ID, retainedUntil: until });

    // Identical replay returns the recorded result and receipt.
    const replay = (await service.runRetain(
      buildOperationEnvelope(ctx, `${RUN_ID}/retain-0001`, { runId: RUN_ID, retainUntil: until }, { requestId: "req-retain-2" }),
    )) as JsonObject;
    assert.equal((replay.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(replay.result, { runId: RUN_ID, retainedUntil: until });
  });
});

test("an admitted retain that loses to release is refused under the reservation lock and stays refused on restart", async () => {
  await withTempStore(async () => {
    const control = fakeControl();
    const { ctx, service } = await startRun({ control });
    const effectKey = `${RUN_ID}/retain-race`;
    const retainUntil = "2036-02-01T00:00:00Z";
    const envelope = buildOperationEnvelope(ctx, effectKey, { runId: RUN_ID, retainUntil });
    // Simulate admission followed by a coordinator pause before the
    // reservation mutation. This is the replay path that bypasses the NEW
    // effect guard and used to settle a false retainedUntil after release.
    await admitOperation({
      runId: RUN_ID,
      method: "run.retain",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: { retainUntil },
    });

    let reachedPause!: () => void;
    const paused = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    let resumeRetain!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeRetain = resolve;
    });
    const pausedOps = createRunOperations({
      contract,
      validator,
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      now: () => new Date(),
      binding: async () => ctx.binding,
      control: control.control,
      sessions: storeSessionEvidenceSource(),
      settle: async (reservation) => {
        reachedPause();
        await resume;
        return { reservation, state: "running" };
      },
      origin: async () => ({ nodeId: ctx.nodeId }),
    });

    const pendingRetain = pausedOps.runRetain(envelope);
    await paused;
    const release = (await service.runRelease(buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID }))) as JsonObject;
    assert.equal((release.result as JsonObject).environmentState, "released");
    resumeRetain();

    const raced = (await pendingRetain) as JsonObject;
    assert.equal((raced.error as JsonObject).code, "RUN_VERSION_CONFLICT");
    const reservation = (await readReservation(RUN_ID))!;
    assert.ok(reservation.releasedAt);
    assert.equal(reservation.retainUntil, undefined);
    assert.equal(reservation.retentionEffects?.[effectKeyHash(effectKey)], undefined);
    assert.equal((await readOperation(RUN_ID, effectKey))!.result, undefined);

    // A fresh lifecycle coordinator sees the same durable ordering and cannot
    // turn the admitted loser into a successful retention receipt.
    const restarted = makeService({ control: fakeControl().control });
    const replay = (await restarted.runRetain(
      buildOperationEnvelope(ctx, effectKey, { runId: RUN_ID, retainUntil }, { requestId: "req-retain-race-restart" }),
    )) as JsonObject;
    assert.equal((replay.error as JsonObject).code, "RUN_VERSION_CONFLICT");
    assert.equal((await readOperation(RUN_ID, effectKey))!.result, undefined);
  });
});

test("retain provenance recovers a crash after persistence but before the operation result", async () => {
  await withTempStore(async () => {
    const { ctx, service } = await startRun();
    const effectKey = `${RUN_ID}/retain-crash`;
    const retainUntil = "2036-02-01T00:00:00Z";
    const envelope = buildOperationEnvelope(ctx, effectKey, { runId: RUN_ID, retainUntil });
    await admitOperation({
      runId: RUN_ID,
      method: "run.retain",
      effectKey,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: computeSchemaDigest(contract),
      init: { retainUntil },
    });
    // Crash fixture: the serialized reservation write won, but the separate
    // operation-result write did not happen before the coordinator exited.
    const retentionEffectId = effectKeyHash(effectKey);
    await mutateReservation(RUN_ID, (reservation) => ({
      ...reservation,
      retainUntil,
      retentionEffects: {
        ...(reservation.retentionEffects ?? {}),
        [retentionEffectId]: { retainUntil, persistedAt: new Date().toISOString() },
      },
    }));
    await service.runRelease(buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID }));

    const restarted = makeService({ control: fakeControl().control });
    const replay = (await restarted.runRetain(
      buildOperationEnvelope(ctx, effectKey, { runId: RUN_ID, retainUntil }, { requestId: "req-retain-crash-replay" }),
    )) as JsonObject;
    assert.equal((replay.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(replay.result, { runId: RUN_ID, retainedUntil: retainUntil });
  });
});

test("run.release: step ledger releases exact occupancy, seals+releases the environment, retains evidence, replays terminally", async () => {
  await withTempStore(async () => {
    await withGitWorkingCopy(async (repo, head) => {
      const control = fakeControl();
      const { ctx, service } = await startRun({ control });
      await registerWorkingCopy({
        workingCopyId: "wc-0001",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
        revision: head,
        branch: "main",
      });
      await claimWorkingCopy("wc-0001", RUN_ID);
      // Another run's occupancy must never be touched by this release.
      await registerWorkingCopy({
        workingCopyId: "wc-other",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
      });
      await claimWorkingCopy("wc-other", "run-other");

      const collected = (await service.runCollect(collectEnvelope(ctx))) as JsonObject;
      const logToken = String(
        (((collected.result as JsonObject).entries as JsonObject[]).find((entry) => entry.kind === "log")!.ref as JsonObject).token,
      );

      const response = (await service.runRelease(buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID }))) as JsonObject;
      assert.deepEqual(validator.validate("execution-response-envelope", response).errors, []);
      assert.deepEqual(response.result, { environmentState: "released", steps: { completed: 4, unrecoverable: 0 } });

      // Live harness ended through the control socket, exactly once.
      assert.equal(control.calls.filter((call) => call.method === "stop").length, 1);
      // Exact occupancy released; the other run's claim is untouched; nothing
      // was deleted from disk (the registered path still exists).
      assert.equal((await readWorkingCopy("wc-0001"))!.occupancy, undefined);
      assert.equal((await readWorkingCopy("wc-other"))!.occupancy?.claimedByRunId, "run-other");
      const reservation = (await readReservation(RUN_ID))!;
      assert.ok(reservation.releasedAt);
      assert.equal(reservation.result?.outcome, "cancelled");
      assert.equal(reservation.result?.cause, "released");

      const events = await readRunEvents(RUN_ID);
      assert.ok(events.some((event) => event.type === "environment.sealed"));
      assert.ok(events.some((event) => event.type === "environment.released"));
      assert.ok(events.some((event) => event.type === "run.cancelled"));

      // Evidence survives release.
      await readEvidence(logToken);

      // Terminal repeat returns the original receipt; no second stop.
      const replay = (await service.runRelease(
        buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID }, { requestId: "req-release-2" }),
      )) as JsonObject;
      assert.equal((replay.receipt as JsonObject).outcome, "replayed");
      assert.deepEqual(replay.result, response.result);
      assert.equal(control.calls.filter((call) => call.method === "stop").length, 1);

      // Retain after release is a typed refusal; collect after release skips
      // the diff (occupancy is gone) but still serves the run log.
      const retain = (await service.runRetain(
        buildOperationEnvelope(ctx, `${RUN_ID}/retain-0009`, { runId: RUN_ID, retainUntil: "2036-03-01T00:00:00Z" }),
      )) as JsonObject;
      assert.equal((retain.error as JsonObject).code, "RUN_VERSION_CONFLICT");
      const postCollect = (await service.runCollect(collectEnvelope(ctx, `${RUN_ID}/collect-post-release`))) as JsonObject;
      const postKinds = ((postCollect.result as JsonObject).entries as JsonObject[]).map((entry) => entry.kind);
      assert.ok(!postKinds.includes("diff"));
      assert.ok(postKinds.includes("log"));
    });
  });
});

test("run.release continues an interrupted step ledger without repeating completed steps", async () => {
  await withTempStore(async () => {
    const control = fakeControl();
    const { ctx, service } = await startRun({ control });
    const body: JsonObject = { runId: RUN_ID };
    const envelope = buildOperationEnvelope(ctx, `${RUN_ID}/release`, body);
    // Simulate a prior coordinator that crashed after completing harness-stop.
    await admitOperation({
      runId: RUN_ID,
      method: "run.release",
      effectKey: `${RUN_ID}/release`,
      requestDigest: String(envelope.requestDigest),
      protocolVersion: "0.1",
      schemaDigest: "sha256:" + "0".repeat(64),
      init: {
        releaseSteps: [
          { step: "harness-stop", status: "completed", detail: "clean stop confirmed", completedAt: new Date().toISOString() },
          { step: "occupancy-release", status: "pending" },
          { step: "environment-seal", status: "pending" },
          { step: "environment-release", status: "pending" },
        ],
      },
    });

    const response = (await service.runRelease(envelope)) as JsonObject;
    assert.equal((response.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(response.result, { environmentState: "released", steps: { completed: 4, unrecoverable: 0 } });
    // harness-stop was already completed by the pre-crash attempt: no new stop.
    assert.equal(control.calls.filter((call) => call.method === "stop").length, 0);
    const record = (await readOperation(RUN_ID, `${RUN_ID}/release`))!;
    assert.ok(record.releaseSteps!.every((step) => step.status === "completed"));
    assert.ok((await readReservation(RUN_ID))!.releasedAt);
  });
});

test("release with an unconfirmable stop FENCES cleanup: occupancy stays claimed, nothing released, retry completes", async () => {
  await withTempStore(async () => {
    await withGitWorkingCopy(async (repo, head) => {
      const control = fakeControl({ stopResult: { stopped: false, detail: "clean stop unconfirmed" } });
      const { ctx, service } = await startRun({ control });
      await registerWorkingCopy({
        workingCopyId: "wc-0001",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
        revision: head,
        branch: "main",
      });
      await claimWorkingCopy("wc-0001", RUN_ID);

      const envelope = buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID });
      const response = (await service.runRelease(envelope)) as JsonObject;
      // Honest non-terminal cleanup receipt: NOT released.
      const result = response.result as JsonObject;
      assert.equal(result.environmentState, "releasing");
      assert.deepEqual(result.steps, { completed: 0, unrecoverable: 0, pending: 4 });

      // The working copy a possibly-live harness may be mutating stays claimed;
      // nothing was sealed or released; the run is honestly lost, not cancelled.
      assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, RUN_ID);
      const reservation = (await readReservation(RUN_ID))!;
      assert.equal(reservation.releasedAt, undefined);
      assert.equal(reservation.sealedAt, undefined);
      assert.equal(reservation.result, undefined);
      assert.ok(reservation.indeterminateAt);
      const events = await readRunEvents(RUN_ID);
      assert.ok(!events.some((event) => event.type === "environment.released"));
      assert.ok(!events.some((event) => event.type === "environment.sealed"));
      assert.ok(events.some((event) => event.type === "run.lost"));
      const projection = ((await service.runGet({ protocolVersion: "0.1", runId: RUN_ID })) as { result: JsonObject }).result;
      assert.equal(projection.state, "lost");

      // Retry after the stop becomes confirmable continues the SAME effect to
      // a terminal released receipt.
      control.behavior.stopResult = { stopped: true, detail: "clean stop confirmed" };
      const retry = (await service.runRelease(
        buildOperationEnvelope(ctx, `${RUN_ID}/release`, { runId: RUN_ID }, { requestId: "req-release-retry" }),
      )) as JsonObject;
      assert.equal((retry.receipt as JsonObject).outcome, "replayed");
      assert.deepEqual(retry.result, { environmentState: "released", steps: { completed: 4, unrecoverable: 0 } });
      assert.equal((await readWorkingCopy("wc-0001"))!.occupancy, undefined);
      assert.equal((await readReservation(RUN_ID))!.result?.outcome, "cancelled");
    });
  });
});

test("release keeps cleanup fenced when a terminal result races an unconfirmed owned-harness stop", async () => {
  await withTempStore(async () => {
    await withGitWorkingCopy(async (repo, head) => {
      const control = fakeControl({ stopResult: { stopped: false, detail: "owned harness may still be live" } });
      const { ctx, service } = await startRun({ control });
      await registerWorkingCopy({
        workingCopyId: "wc-0001",
        productId: "prod-honeycomb-app",
        path: repo,
        snapshotDigest: SNAPSHOT_DIGEST,
        revision: head,
        branch: "main",
      });
      await claimWorkingCopy("wc-0001", RUN_ID);

      // Model the exact race: release settled the Run as running, then another
      // terminal reconciler commits completion while the clean stop is in
      // flight. stop=false must still dominate cleanup liveness.
      const baseStop = control.control.stop;
      let injectedTerminal = false;
      control.control.stop = async (beeName) => {
        if (!injectedTerminal) {
          injectedTerminal = true;
          await mutateReservation(RUN_ID, (record) => ({
            ...record,
            result: { outcome: "completed", finishedAt: new Date().toISOString(), harnessExitCode: 0 },
          }));
        }
        return baseStop(beeName);
      };

      const envelope = buildOperationEnvelope(ctx, `${RUN_ID}/release-terminal-stop-race`, { runId: RUN_ID });
      const first = (await service.runRelease(envelope)) as JsonObject;
      assert.deepEqual(first.result, {
        environmentState: "releasing",
        steps: { completed: 0, unrecoverable: 0, pending: 4 },
        cause: "harness stop unconfirmed; cleanup fenced until a retry confirms the stop",
      });
      const fenced = (await readReservation(RUN_ID))!;
      assert.equal(fenced.result?.outcome, "completed", "the prior terminal winner remains immutable");
      assert.equal(fenced.indeterminateCause, "release_stop_unconfirmed");
      assert.ok(fenced.lossEpisodeId);
      assert.equal(fenced.releasedAt, undefined);
      assert.equal(fenced.sealedAt, undefined);
      assert.equal((await readWorkingCopy("wc-0001"))!.occupancy?.claimedByRunId, RUN_ID);
      assert.ok((await readRunEvents(RUN_ID)).some((event) => event.type === "run.lost"));
      assert.ok((await readOperation(RUN_ID, `${RUN_ID}/release-terminal-stop-race`))!.releaseSteps!.every(
        (step) => step.status === "pending",
      ));

      control.behavior.stopResult = { stopped: true, detail: "owned harness is now down" };
      const retry = (await service.runRelease(
        buildOperationEnvelope(
          ctx,
          `${RUN_ID}/release-terminal-stop-race`,
          { runId: RUN_ID },
          { requestId: "req-release-terminal-stop-retry" },
        ),
      )) as JsonObject;
      assert.equal((retry.receipt as JsonObject).outcome, "replayed");
      assert.deepEqual(retry.result, { environmentState: "released", steps: { completed: 4, unrecoverable: 0 } });
      const recovered = (await readReservation(RUN_ID))!;
      assert.equal(recovered.result?.outcome, "completed");
      assert.equal(recovered.indeterminateAt, undefined);
      assert.ok(recovered.releasedAt);
      assert.equal((await readWorkingCopy("wc-0001"))!.occupancy, undefined);
      const events = await readRunEvents(RUN_ID);
      assert.ok(events.some((event) => event.type === "run.recovering"));
      assert.ok(events.some((event) => event.type === "run.completed"));
    });
  });
});

test("cancel with an unconfirmable stop stays a desired state: no false cancelled terminal, retry converges", async () => {
  await withTempStore(async () => {
    const control = fakeControl({ stopResult: { stopped: false, detail: "clean stop unconfirmed" } });
    const { ctx, service } = await startRun({ control });
    const response = (await service.runCancel(buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "op" }))) as JsonObject;
    assert.deepEqual(response.result, { runId: RUN_ID, state: "lost" });
    const reservation = (await readReservation(RUN_ID))!;
    assert.equal(reservation.result, undefined, "no terminal cancelled over a possibly-live harness");
    assert.ok(reservation.cancel, "cancellation intent stays durable");
    assert.ok(reservation.indeterminateAt);
    const events = await readRunEvents(RUN_ID);
    assert.ok(events.some((event) => event.type === "cancel.requested"));
    assert.ok(events.some((event) => event.type === "run.lost"));
    assert.ok(!events.some((event) => event.type === "run.cancelled"));

    // Retry once the stop can be confirmed: the SAME effect converges to
    // cancelled and resolves the liveness doubt.
    control.behavior.stopResult = { stopped: true, detail: "clean stop confirmed" };
    const retry = (await service.runCancel(
      buildOperationEnvelope(ctx, `${RUN_ID}/cancel`, { runId: RUN_ID, reason: "op" }, { requestId: "req-cancel-retry" }),
    )) as JsonObject;
    assert.equal((retry.receipt as JsonObject).outcome, "replayed");
    assert.deepEqual(retry.result, { runId: RUN_ID, state: "cancelled" });
    const settled = (await readReservation(RUN_ID))!;
    assert.equal(settled.result?.outcome, "cancelled");
    assert.equal(settled.indeterminateAt, undefined);
    assert.ok((await readRunEvents(RUN_ID)).some((event) => event.type === "run.cancelled"));
  });
});

test("effect keys are globally exclusive across methods: reusing a key with different content conflicts", async () => {
  await withTempStore(async () => {
    const { ctx, service } = await startRun();
    await service.runCollect(collectEnvelope(ctx, `${RUN_ID}/shared-key`));
    const clash = (await service.runRetain(
      buildOperationEnvelope(ctx, `${RUN_ID}/shared-key`, { runId: RUN_ID, retainUntil: "2036-02-01T00:00:00Z" }),
    )) as JsonObject;
    assert.equal((clash.error as JsonObject).code, "IDEMPOTENCY_CONFLICT");
    // Reusing run.start's effect key for an operation also conflicts.
    const startKeyClash = (await service.runCancel(
      buildOperationEnvelope(ctx, "job-0001/run-0001/start", { runId: RUN_ID }),
    )) as JsonObject;
    assert.equal((startKeyClash.error as JsonObject).code, "IDEMPOTENCY_CONFLICT");
  });
});
