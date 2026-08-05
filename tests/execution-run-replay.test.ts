// run.get and sequence-addressed run.events (H1 minimal H2 floor): durable
// replay across coordinator restart, exclusive afterSeq cursors, append-once
// terminal reconciliation from HSR session facts, and fail-closed event-log
// corruption handling.
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createExecutionValidator, loadExecutionContract, type JsonObject } from "../src/execution/contract.js";
import { appendRunEvents, beeNameForRun, readRunEvents, runDir, type StoredRunEvent } from "../src/execution/runStore.js";
import { writeHsrMeta } from "../src/hsr/runDir.js";
import {
  buildRunStartEnvelope,
  countingLauncher,
  installTestAuthority,
  makeService,
  withTempStore,
} from "./executionTestKit.js";

const contract = loadExecutionContract();
const validator = createExecutionValidator(contract);

test("run.get: projection is schema-valid, cursor-addressed, and RUN_UNKNOWN is typed", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    const service = makeService();
    const unknown = await service.runGet({ protocolVersion: "0.1", runId: "run-none" });
    assert.ok("error" in unknown && unknown.error.code === "RUN_UNKNOWN");
    assert.deepEqual(validator.validate("error", unknown.error).errors, []);

    await service.runStart(buildRunStartEnvelope(ctx));
    const outcome = await service.runGet({ protocolVersion: "0.1", runId: "run-0001" });
    assert.ok("result" in outcome, JSON.stringify(outcome));
    const projection = outcome.result;
    assert.deepEqual(validator.validate("run-projection", projection).errors, []);
    assert.equal(projection.state, "running");
    assert.equal(projection.jobId, "job-0001");
    assert.equal(projection.lastEventSeq, 5);
    assert.equal(projection.health, "ready");
  });
});

test("run.events: replay from any cursor survives coordinator restart", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await makeService().runStart(buildRunStartEnvelope(ctx));

    // A fresh service instance = restarted coordinator reading only disk.
    const restarted = makeService();
    const full = await restarted.runEvents({ protocolVersion: "0.1", runId: "run-0001", afterSeq: 0 });
    assert.ok("result" in full);
    const page = full.result;
    assert.deepEqual(validator.validate("run-events-page", page).errors, []);
    const events = page.events as unknown as StoredRunEvent[];
    assert.deepEqual(
      events.map((event) => event.type),
      ["run.accepted", "environment.materializing", "harness.starting", "environment.ready", "harness.running"],
    );
    assert.equal(page.nextAfterSeq, 5);
    assert.deepEqual(page.retention, { oldestReplayableSeq: 1 });

    // Exclusive cursor + limit paging reconstructs the identical history.
    const paged: StoredRunEvent[] = [];
    let cursor = 0;
    for (;;) {
      const outcome = await restarted.runEvents({ protocolVersion: "0.1", runId: "run-0001", afterSeq: cursor, limit: 2 });
      assert.ok("result" in outcome);
      const chunk = outcome.result.events as unknown as StoredRunEvent[];
      if (chunk.length === 0) break;
      paged.push(...chunk);
      cursor = outcome.result.nextAfterSeq as number;
    }
    assert.deepEqual(paged, events, "paged replay equals one-shot replay");

    // A cursor past the head returns an empty page at the same cursor.
    const beyond = await restarted.runEvents({ protocolVersion: "0.1", runId: "run-0001", afterSeq: 99 });
    assert.ok("result" in beyond);
    assert.deepEqual(beyond.result.events, []);
    assert.equal(beyond.result.nextAfterSeq, 99);
  });
});

test("terminal reconciliation: harness exit folds into completed state + events exactly once", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await makeService().runStart(buildRunStartEnvelope(ctx));
    const beeName = beeNameForRun("run-0001");
    await writeHsrMeta(beeName, {
      bee: beeName,
      harness: "claude",
      tier: "stream",
      hostPid: 0,
      startedAt: new Date().toISOString(),
      controlSocket: "/dev/null",
      status: "exited",
      exitCode: 0,
      endedAt: new Date().toISOString(),
    });

    const restarted = makeService();
    const first = await restarted.runGet({ protocolVersion: "0.1", runId: "run-0001" });
    assert.ok("result" in first);
    assert.equal(first.result.state, "completed");
    const result = first.result.result as JsonObject;
    assert.equal(result.outcome, "completed");
    assert.equal(result.harnessExitCode, 0);
    assert.deepEqual(validator.validate("run-projection", first.result).errors, []);

    // Reconciliation is append-once: repeated reads and a second instance
    // do not duplicate terminal events.
    await restarted.runGet({ protocolVersion: "0.1", runId: "run-0001" });
    await makeService().runGet({ protocolVersion: "0.1", runId: "run-0001" });
    const events = await readRunEvents("run-0001");
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "run.accepted",
        "environment.materializing",
        "harness.starting",
        "environment.ready",
        "harness.running",
        "harness.exited",
        "run.completed",
      ],
    );
    for (const event of events) assert.deepEqual(validator.validate("run-event", event).errors, []);
  });
});

test("terminal reconciliation: nonzero exit maps to failed", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await makeService().runStart(buildRunStartEnvelope(ctx));
    const beeName = beeNameForRun("run-0001");
    await writeHsrMeta(beeName, {
      bee: beeName,
      harness: "claude",
      tier: "stream",
      hostPid: 0,
      startedAt: new Date().toISOString(),
      controlSocket: "/dev/null",
      status: "exited",
      exitCode: 3,
    });
    const outcome = await makeService().runGet({ protocolVersion: "0.1", runId: "run-0001" });
    assert.ok("result" in outcome);
    assert.equal(outcome.result.state, "failed");
    assert.equal((outcome.result.result as JsonObject).harnessExitCode, 3);
    const events = await readRunEvents("run-0001");
    assert.ok(events.some((event) => event.type === "run.failed"));
  });
});

test("event log: torn trailing record is recovered under the append lock, never concatenated", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await makeService().runStart(buildRunStartEnvelope(ctx));
    const path = join(runDir("run-0001"), "events.jsonl");
    // Crash mid-append: partial JSON with no trailing newline.
    await appendFile(path, '{"protocolVersion":"0.1","runId":"run-0001","seq":6,"type":"harness.exi');
    const events = await readRunEvents("run-0001");
    assert.equal(events.length, 5, "torn tail is excluded from replay");
    const appended = await appendRunEvents("run-0001", "0.1", [
      { type: "run.completed", payload: {}, origin: { nodeId: "node-test" } },
    ]);
    assert.equal(appended[0]!.seq, 6, "seq continues from the recovered prefix");
    const raw = await readFile(path, "utf8");
    for (const line of raw.split("\n").filter((entry) => entry.trim().length > 0)) {
      JSON.parse(line); // every persisted line parses cleanly again
    }
    const after = await readRunEvents("run-0001");
    assert.deepEqual(after.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
  });
});

test("event log: interior corruption and sequence reuse fail closed, never partial replay", async () => {
  await withTempStore(async () => {
    const ctx = await installTestAuthority();
    await makeService().runStart(buildRunStartEnvelope(ctx));
    const path = join(runDir("run-0001"), "events.jsonl");
    const original = await readFile(path, "utf8");

    // Interior garbage line.
    const lines = original.split("\n");
    lines[2] = "{ corrupted interior line";
    await writeFile(path, lines.join("\n"), "utf8");
    const corrupted = await makeService().runEvents({ protocolVersion: "0.1", runId: "run-0001", afterSeq: 0 });
    assert.ok("error" in corrupted && corrupted.error.code === "AUTHORITY_UNAVAILABLE", JSON.stringify(corrupted));

    // Sequence reuse (a duplicated seq) is corruption, not replayable history.
    const events = original.split("\n").filter((entry) => entry.trim().length > 0);
    await writeFile(path, [...events, events[events.length - 1]!].join("\n") + "\n", "utf8");
    const reused = await makeService().runEvents({ protocolVersion: "0.1", runId: "run-0001", afterSeq: 0 });
    assert.ok("error" in reused && reused.error.code === "AUTHORITY_UNAVAILABLE");
  });
});

test("read-path requests are schema-validated and version-pinned", async () => {
  await withTempStore(async () => {
    await installTestAuthority();
    const service = makeService();
    const badShape = await service.runGet({ runId: "run-0001" });
    assert.ok("error" in badShape && badShape.error.code === "SCHEMA_UNSUPPORTED");
    const badVersion = await service.runEvents({ protocolVersion: "9.9", runId: "run-0001", afterSeq: 0 });
    assert.ok("error" in badVersion && badVersion.error.code === "PROTOCOL_INCOMPATIBLE");
  });
});
