/**
 * Cell-transport seq cursor: events.jsonl as an exactly-resumable stream.
 *
 *   - appendHsrEvent stamps a per-bee monotonic `seq` (starting at 1) on every
 *     append and persists the issued high-water to seq.json AFTER the event
 *     lands, so a process restart (or a lost sidecar) can never reissue a seq
 *     and never leaves a hole in the cursor space.
 *   - readHsrEventsAfterSeq returns exactly the events with `seq > afterSeq`;
 *     a cursor below the oldest retained seq gets an EXPLICIT gap marker —
 *     never silent divergence.
 *   - ackHsrEvents advances a durable consumer watermark; compaction may only
 *     fold events at or below it (the size cap yields to ack correctness).
 *     Without a watermark, compaction behaves exactly as today (HIVE-13), so
 *     local-only usage never accumulates an unbounded log.
 *   - The node-level `events` RPC accepts {afterSeq} (afterTs keeps working);
 *     `ackEvents {bee, upToSeq}` advances the watermark.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  assertHsrSourceEventLogIntegrity,
  HsrSourceEventIntegrityError,
  readHsrEventIntegrityReceipt,
} from "../src/hsr/eventIntegrity.js";
import {
  currentHsrEventEpoch,
  hsrObservations,
  hsrUsageObservation,
  pendingNeedsInput,
  readEventTail,
} from "../src/hsr/observe.js";
import { buildController } from "../src/hsr/remoteHost.js";
import { captureProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import {
  __testOnlyClearHsrEventReplaySessions,
  __testOnlyResetSeqState,
  __testOnlySetReplayPageAfterSessionClaim,
  __testOnlySetHsrEventAuthorityTimeout,
  __testOnlySetSourceValidationAfterEventRead,
  __testOnlySetWholeEventLogReadGuard,
  ackHsrEvents,
  appendHsrEvent,
  compactHsrEvents,
  discardHsrEventConsumer,
  ensureHsrRunDir,
  foldHsrRetainedEventsStrict,
  forgetHsrRunState,
  hsrEventAuthorityLockPath,
  hsrEventsPath,
  hsrRunDir,
  hsrSeqPath,
  HSR_EVENT_REPLAY_PAGE_MAX_EVENTS,
  markHsrConsumerSubscribed,
  markHsrConsumerSubscribedStrict,
  readHsrEventsAfterSeq,
  readHsrEventsPageAfterSeqStrict,
  readHsrEventsAfterSeqStrict,
  readHsrSourceListProjectionStrict,
  readHsrSeqState,
  removeConfirmedStoppedHsrRunDir,
  validateHsrSourceEventLogStrict,
  writeHsrMeta,
  type HsrMeta,
} from "../src/hsr/runDir.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import { loadSession, saveSession } from "../src/store.js";

/** chmod-based failure injection needs a non-root uid to actually deny writes. */
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const CTX = { connectionId: 1, close() {} };
const execFileAsync = promisify(execFile);
const BUILT_TEST_GRAPH = process.env.HIVE_TEST_BUILT_CLI === "1";

function childSourceModule(pathWithoutExtension: string): string {
  return new URL(`../src/${pathWithoutExtension}.${BUILT_TEST_GRAPH ? "js" : "ts"}`, import.meta.url).href;
}

function childModuleArgs(script: string): string[] {
  return [
    ...(BUILT_TEST_GRAPH ? [] : ["--import", "tsx"]),
    "--input-type=module",
    "--eval",
    script,
  ];
}

/** Point HIVE_STORE_ROOT at a fresh temp dir for the duration of `fn`. */
async function withTempStore<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-seq-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** A live LOCAL meta (this test process is the "host" pid, so it probes alive). */
function liveMeta(bee: string): HsrMeta {
  return {
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: process.pid,
    startedAt: new Date().toISOString(),
    controlSocket: "/tmp/unused.sock",
    status: "running",
  };
}

async function readLines(bee: string): Promise<string[]> {
  const raw = await readFile(hsrEventsPath(bee), "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

/** Append `count` text events (awaiting the chain) and return the last promise. */
async function appendTexts(bee: string, count: number, startTs = 1): Promise<void> {
  let last: Promise<void> = Promise.resolve();
  for (let i = 0; i < count; i++) {
    last = appendHsrEvent(bee, { type: "text", ts: startTs + i, text: `chunk-${i}` });
  }
  await last;
}

function seqsOf(events: RunnerEvent[]): Array<number | undefined> {
  return events.map((event) => event.seq);
}

test("appendHsrEvent stamps a monotonic per-bee seq from 1 and persists the high-water", async () => {
  await withTempStore(async () => {
    const bee = "seq-stamper";
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, liveMeta(bee));
    await appendHsrEvent(bee, { type: "turn_start", ts: 1 });
    await appendHsrEvent(bee, { type: "needs_input", ts: 2, kind: "question", question: "pick?", requestId: "req-seq" });
    await appendHsrEvent(bee, { type: "text", ts: 3, text: "hello" });

    const lines = await readLines(bee);
    assert.deepEqual(lines.map((line) => (JSON.parse(line) as RunnerEvent).seq), [1, 2, 3]);
    assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 3 }, "seq.json must persist the issued high-water");

    // Independent bees own independent seq spaces.
    const other = "seq-stamper-other";
    await ensureHsrRunDir(other);
    await appendHsrEvent(other, { type: "text", ts: 1, text: "solo" });
    assert.equal((JSON.parse((await readLines(other))[0]!) as RunnerEvent).seq, 1);

    // The stamped field must not break existing event readers.
    const tail = await readEventTail(bee);
    assert.equal(tail.length, 3);
    assert.equal((await pendingNeedsInput(bee))?.requestId, "req-seq");
  });
});

test("seq issuance survives simulated restarts and can never reissue", async () => {
  await withTempStore(async () => {
    const bee = "seq-restarter";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 3);

    // Restart with both artifacts intact: continue from seq.json.
    __testOnlyResetSeqState(bee);
    await appendHsrEvent(bee, { type: "text", ts: 10, text: "after-restart" });
    assert.equal((JSON.parse((await readLines(bee)).at(-1)!) as RunnerEvent).seq, 4);

    // Restart with a LOST sidecar: the stamped log is the backstop.
    await rm(hsrSeqPath(bee));
    __testOnlyResetSeqState(bee);
    await appendHsrEvent(bee, { type: "text", ts: 11, text: "after-crash" });
    assert.equal((JSON.parse((await readLines(bee)).at(-1)!) as RunnerEvent).seq, 5);

    // Restart with a LOST/truncated log: seq.json proves issued history is
    // missing. Never append seq 51 across that loss; source integrity must be
    // settled explicitly before any successor work.
    await writeFile(hsrSeqPath(bee), `${JSON.stringify({ lastSeq: 50 })}\n`, { mode: 0o600 });
    await rm(hsrEventsPath(bee));
    __testOnlyResetSeqState(bee);
    await assert.rejects(
      appendHsrEvent(bee, { type: "text", ts: 12, text: "after-wipe" }),
      /ends below durable high-water 50/,
    );
    assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 50 });
  });
});

test("legacy seq-less events upgrade cleanly: new appends start at 1, readers keep working", async () => {
  await withTempStore(async () => {
    const bee = "seq-legacy";
    await ensureHsrRunDir(bee);
    const legacy: RunnerEvent[] = [
      { type: "turn_start", ts: 1 },
      { type: "usage", ts: 2, inputTokens: 5, outputTokens: 5 },
      { type: "turn_end", ts: 3 },
    ];
    await writeFile(hsrEventsPath(bee), `${legacy.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });

    await appendHsrEvent(bee, { type: "text", ts: 4, text: "post-upgrade" });
    await appendHsrEvent(bee, { type: "text", ts: 5, text: "post-upgrade-2" });

    const lines = await readLines(bee);
    assert.deepEqual(lines.map((line) => (JSON.parse(line) as RunnerEvent).seq), [undefined, undefined, undefined, 1, 2]);

    // ts-based readers still see the whole log, legacy prefix included.
    assert.equal((await readEventTail(bee)).length, 5);
    assert.deepEqual((await hsrUsageObservation(bee)).totals, { inputTokens: 5, outputTokens: 5 });

    // The seq cursor covers only stamped events — a fresh cursor is NOT a gap.
    const fromStart = await readHsrEventsAfterSeq(bee, 0);
    assert.equal(fromStart.gap, undefined);
    assert.deepEqual(seqsOf(fromStart.events), [1, 2]);
  });
});

test("readHsrEventsAfterSeq: empty, mid, and tail cursors", async () => {
  await withTempStore(async () => {
    const bee = "seq-cursors";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 5);

    const all = await readHsrEventsAfterSeq(bee, 0);
    assert.deepEqual(seqsOf(all.events), [1, 2, 3, 4, 5]);
    assert.equal(all.gap, undefined);

    const mid = await readHsrEventsAfterSeq(bee, 3);
    assert.deepEqual(seqsOf(mid.events), [4, 5]);
    assert.equal(mid.gap, undefined);

    const caughtUp = await readHsrEventsAfterSeq(bee, 5);
    assert.deepEqual(caughtUp.events, []);
    assert.equal(caughtUp.gap, undefined);

    // A cursor from the future (a wiped store reused the bee name) yields
    // nothing rather than inventing events.
    const future = await readHsrEventsAfterSeq(bee, 99);
    assert.deepEqual(future.events, []);
    assert.equal(future.gap, undefined);

    // A missing run dir is an empty stream, not an error.
    const missing = await readHsrEventsAfterSeq("seq-cursors-nobody", 0);
    assert.deepEqual(missing, { events: [] });
  });
});

test("the ack watermark caps what compaction may fold; folded prefix still checkpoints", async () => {
  await withTempStore(async () => {
    const bee = "seq-ack-compact";
    await ensureHsrRunDir(bee);
    let last: Promise<void> = Promise.resolve();
    for (let i = 1; i <= 10; i++) {
      last =
        i === 2 || i === 9
          ? appendHsrEvent(bee, { type: "usage", ts: i, inputTokens: 1, outputTokens: 1 })
          : appendHsrEvent(bee, { type: "text", ts: i, text: `chunk-${i}` });
    }
    await last;
    assert.equal(await ackHsrEvents(bee, 6), 6);
    assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 10, ackedSeq: 6 });

    // keepLines 2 would fold seqs 1..8, but the watermark stops the fold at 6.
    await compactHsrEvents(bee, { keepLines: 2, targetBytes: 10_000 });
    const lines = await readLines(bee);
    const stamped = lines.map((line) => (JSON.parse(line) as RunnerEvent).seq).filter((seq) => seq !== undefined);
    assert.deepEqual(stamped, [7, 8, 9, 10], "every un-acked event must survive compaction verbatim");
    // The folded prefix (seqs 1..6) still checkpoints: its usage total lives on.
    assert.deepEqual((await hsrUsageObservation(bee)).totals, { inputTokens: 2, outputTokens: 2 });

    // Cursors at/above the watermark resume exactly; below it get an explicit gap.
    const resumed = await readHsrEventsAfterSeq(bee, 6);
    assert.deepEqual(seqsOf(resumed.events), [7, 8, 9, 10]);
    assert.equal(resumed.gap, undefined);
    const stale = await readHsrEventsAfterSeq(bee, 4);
    assert.deepEqual(stale.gap, { fromSeq: 5, toSeq: 6 });
    assert.deepEqual(seqsOf(stale.events), [7, 8, 9, 10]);
  });
});

test("the size cap yields to the watermark: un-acked events are kept past the bounds", async () => {
  await withTempStore(async () => {
    const bee = "seq-ack-blocks";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 10);
    await ackHsrEvents(bee, 1);

    // The bounds would keep only the final line; the watermark keeps 2..10.
    await compactHsrEvents(bee, { keepLines: 1, targetBytes: 64 });
    const stamped = (await readLines(bee)).map((line) => (JSON.parse(line) as RunnerEvent).seq).filter((seq) => seq !== undefined);
    assert.deepEqual(stamped, [2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Acks never regress and clamp to the issued high-water.
    assert.equal(await ackHsrEvents(bee, 5), 5);
    assert.equal(await ackHsrEvents(bee, 3), 5, "a stale ack must not lower the watermark");
    assert.equal(await ackHsrEvents(bee, 999), 10, "an over-ack clamps to lastSeq");
  });
});

test("without any ack, compaction behaves exactly as today and gaps are still explicit", async () => {
  await withTempStore(async () => {
    const bee = "seq-no-ack";
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, liveMeta(bee));
    await appendHsrEvent(bee, { type: "turn_start", ts: 1 });
    await appendHsrEvent(bee, { type: "needs_input", ts: 2, kind: "permission", question: "allow?", tool: "Bash", requestId: "req-noack" });
    await appendTexts(bee, 10, 3);

    await compactHsrEvents(bee, { keepLines: 2, targetBytes: 10_000 });
    assert.equal((await readHsrSeqState(bee))?.ackedSeq, undefined, "no consumer — no watermark");

    const lines = await readLines(bee);
    const sourceCheckpoint = lines
      .map((line) => JSON.parse(line) as RunnerEvent)
      .find((event) => event.type === "source_cursor_checkpoint");
    assert.deepEqual(sourceCheckpoint && {
      type: sourceCheckpoint.type,
      throughSeq: sourceCheckpoint.throughSeq,
    }, { type: "source_cursor_checkpoint", throughSeq: 10 });
    // Re-carried checkpoint markers are seq-LESS: a folded seq leaves the
    // cursor space (reported as a gap) instead of punching silent holes.
    const markers = lines.filter((line) => line.includes("turn_start") || line.includes("needs_input"));
    assert.equal(markers.length, 2, "compaction must keep the dropped lifecycle markers");
    for (const marker of markers) assert.equal((JSON.parse(marker) as RunnerEvent).seq, undefined);
    assert.equal((await pendingNeedsInput(bee))?.requestId, "req-noack", "observer derivation survives the fold");

    const stamped = lines.map((line) => (JSON.parse(line) as RunnerEvent).seq).filter((seq) => seq !== undefined);
    assert.deepEqual(stamped, [11, 12], "size-first fold must proceed exactly as today without a watermark");

    const resumed = await readHsrEventsAfterSeq(bee, 0);
    assert.deepEqual(resumed.gap, { fromSeq: 1, toSeq: 10 });
    assert.deepEqual(seqsOf(resumed.events), [11, 12]);
    await validateHsrSourceEventLogStrict(bee);
  });
});

test("a fully lost log still signals the whole issued span as a gap", async () => {
  await withTempStore(async () => {
    const bee = "seq-lost-log";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 4);
    await rm(hsrEventsPath(bee));

    const lost = await readHsrEventsAfterSeq(bee, 2);
    assert.deepEqual(lost.events, []);
    assert.deepEqual(lost.gap, { fromSeq: 3, toSeq: 4 });
  });
});

test("the node-level events RPC serves afterSeq cursors (afterTs unchanged) and ackEvents advances the watermark", async () => {
  await withTempStore(async () => {
    const controller = buildController();
    try {
      const bee = "seq-rpc";
      await ensureHsrRunDir(bee);
      await appendTexts(bee, 4, 100); // ts 100..103, seq 1..4
      const consumerId = "seq-rpc-consumer";
      await markHsrConsumerSubscribedStrict(bee, consumerId);

      const bySeq = (await controller.methods.events!({ bee, consumerId, afterSeq: 2 }, CTX)) as {
        ok: boolean;
        events: RunnerEvent[];
        gap?: unknown;
        throughSeq?: number;
        hasMore?: boolean;
        pageToken?: string;
      };
      assert.equal(bySeq.ok, true);
      assert.deepEqual(seqsOf(bySeq.events), [3, 4]);
      assert.equal(bySeq.gap, undefined);
      assert.equal(bySeq.throughSeq, 4);
      assert.equal(bySeq.hasMore, false);
      assert.equal(bySeq.pageToken, undefined);

      // Existing afterTs callers keep working, seq stamps included.
      const byTs = (await controller.methods.events!({ bee, afterTs: 101 }, CTX)) as { ok: boolean; events: RunnerEvent[] };
      assert.equal(byTs.ok, true);
      assert.deepEqual(seqsOf(byTs.events), [3, 4]);

      // Ack, then compact past the watermark: the RPC result carries the gap.
      const acked = (await controller.methods.ackEvents!({ bee, consumerId, upToSeq: 3 }, CTX)) as { ok: boolean; ackedSeq?: number };
      assert.deepEqual(acked, { ok: true, ackedSeq: 3 });
      await compactHsrEvents(bee, { keepLines: 1, targetBytes: 10_000 });
      const gapped = (await controller.methods.events!({ bee, consumerId, afterSeq: 0 }, CTX)) as {
        ok: boolean;
        events: RunnerEvent[];
        gap?: { fromSeq: number; toSeq: number };
      };
      assert.equal(gapped.ok, true);
      assert.deepEqual(gapped.gap, { fromSeq: 1, toSeq: 3 });
      assert.deepEqual(seqsOf(gapped.events), [4]);

      // Parameter guards.
      const noBee = (await controller.methods.ackEvents!({ upToSeq: 1 }, CTX)) as { ok: boolean };
      assert.equal(noBee.ok, false);
      const badSeq = (await controller.methods.ackEvents!({ bee, upToSeq: 0 }, CTX)) as { ok: boolean };
      assert.equal(badSeq.ok, false);
    } finally {
      // This fixture creates event storage without a runtime/authority receipt.
      // Remove that synthetic run dir before exercising quiescent controller
      // close, which now correctly fails closed on unowned durable run state.
      await rm(hsrRunDir("seq-rpc"), { recursive: true, force: true });
      await controller.close();
    }
  });
});

// --- correctness blockers: never expose a seq/watermark as durable before the
// backing write is confirmed --------------------------------------------------

test("a failed append does NOT burn a seq — the next append reuses it (no silent hole)", async () => {
  if (IS_ROOT) return; // chmod cannot deny writes to root; skip the injection
  await withTempStore(async () => {
    const bee = "seq-failed-append";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 2); // seq 1..2 durable
    assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 2 });

    // Deny writes to the events file so the seq-3 append rejects AFTER seq 2 is
    // durable. lastSeq must NOT advance — the candidate is only committed once
    // the event lands.
    await chmod(hsrEventsPath(bee), 0o400);
    await assert.rejects(appendHsrEvent(bee, { type: "text", ts: 3, text: "never-lands" }));
    assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 2 }, "a failed append must not persist a new high-water");

    // Recover: the next append REUSES seq 3 (a clean reissue), never 4.
    await chmod(hsrEventsPath(bee), 0o600);
    await appendHsrEvent(bee, { type: "text", ts: 4, text: "lands-clean" });
    const seqs = (await readLines(bee)).map((line) => (JSON.parse(line) as RunnerEvent).seq);
    assert.deepEqual(seqs, [1, 2, 3], "the un-landed seq is reissued into a clean line — no [1,2,4] hole");
    const resumed = await readHsrEventsAfterSeq(bee, 0);
    assert.equal(resumed.gap, undefined, "a contiguous [1,2,3] stream has no gap");
  });
});

test("a crash-torn trailing record is preserved and fenced; only a complete missing newline is repaired", async () => {
  await withTempStore(async () => {
    // (a) torn partial mid-write carrying an un-landed seq 2.
    const torn = "seq-torn-partial";
    await ensureHsrRunDir(torn);
    await writeFile(
      hsrEventsPath(torn),
      `${JSON.stringify({ type: "text", ts: 1, seq: 1, text: "ok" })}\n{"type":"text","ts":2,"seq":2,"tex`,
      { mode: 0o600 },
    );
    await writeFile(hsrSeqPath(torn), `${JSON.stringify({ lastSeq: 1 })}\n`, { mode: 0o600 });
    const tornMeta = { ...liveMeta(torn), childAdmission: "none" as const, controlSocket: "" };
    await writeHsrMeta(torn, tornMeta);
    await saveSession({
      name: torn,
      agent: "stub",
      cwd: "/tmp",
      command: "stub",
      tmuxTarget: torn,
      substrate: "hsr",
      runnerPid: tornMeta.hostPid,
      createdAt: tornMeta.startedAt,
      updatedAt: tornMeta.startedAt,
      status: "running",
    });
    __testOnlyResetSeqState(torn);
    const tornRaw = await readFile(hsrEventsPath(torn), "utf8");
    await assert.rejects(
      appendHsrEvent(torn, { type: "text", ts: 2, text: "must-not-reissue" }),
      /malformed trailing record/,
    );
    assert.equal(await readFile(hsrEventsPath(torn), "utf8"), tornRaw, "partial provider evidence is never truncated or fused");
    assert.deepEqual(await readHsrSeqState(torn), { lastSeq: 1 }, "no replacement event advances or reuses the uncertain seq");
    await assert.rejects(validateHsrSourceEventLogStrict(torn), /malformed record/);
    await assert.rejects(
      assertHsrSourceEventLogIntegrity({ bee: torn, meta: tornMeta, operation: "torn-tail recovery admission" }),
      (error: unknown) => error instanceof HsrSourceEventIntegrityError,
    );
    const receipt = await readHsrEventIntegrityReceipt(torn);
    assert.equal(receipt?.phase, "unresolved", "crash evidence reaches the purge-surviving manual settlement boundary");
    const canonical = await loadSession(torn);
    assert.equal(canonical?.status, "kill_failed");
    assert.equal(canonical?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
    assert.equal(await readFile(hsrEventsPath(torn), "utf8"), tornRaw, "fencing never rewrites the malformed evidence");

    // (b) a COMPLETE record that merely never got its trailing newline is kept.
    const noNl = "seq-no-newline";
    await ensureHsrRunDir(noNl);
    await writeFile(hsrEventsPath(noNl), `${JSON.stringify({ type: "text", ts: 1, seq: 1, text: "whole" })}`, { mode: 0o600 });
    await writeFile(hsrSeqPath(noNl), `${JSON.stringify({ lastSeq: 1 })}\n`, { mode: 0o600 });
    __testOnlyResetSeqState(noNl);
    await appendHsrEvent(noNl, { type: "text", ts: 2, text: "next" });
    const noNlLines = await readLines(noNl);
    for (const line of noNlLines) JSON.parse(line);
    assert.deepEqual(noNlLines.map((l) => (JSON.parse(l) as RunnerEvent).seq), [1, 2], "the whole record survives, seq 2 lands on its own line");
  });
});

test("a failed ack sidecar write does NOT advance the cached watermark (no fold of un-acked events)", async () => {
  if (IS_ROOT) return; // chmod cannot deny writes to root; skip the injection
  await withTempStore(async () => {
    const bee = "seq-failed-ack";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 5); // seq 1..5
    assert.equal(await ackHsrEvents(bee, 1), 1);

    // Deny writes to the run dir so the ack-to-4 sidecar write rejects. The
    // cached ackedSeq must stay 1 — compaction reads that cache.
    await chmod(hsrRunDir(bee), 0o500);
    await assert.rejects(ackHsrEvents(bee, 4));
    await chmod(hsrRunDir(bee), 0o700);
    assert.equal((await readHsrSeqState(bee))?.ackedSeq, 1, "the durable watermark stays at the last confirmed ack");

    // Compaction may only fold at/below the CONFIRMED watermark (1); seqs 2..5
    // survive. (The bug folded up to the never-persisted 4, retaining only 5.)
    await compactHsrEvents(bee, { keepLines: 1, targetBytes: 10_000 });
    const stamped = (await readLines(bee)).map((l) => (JSON.parse(l) as RunnerEvent).seq).filter((s) => s !== undefined);
    assert.deepEqual(stamped, [2, 3, 4, 5], "un-acked events must not be folded by a watermark that never persisted");
  });
});

test("an active-but-un-acked consumer protects every stamped event; a non-consumer still folds size-first", async () => {
  await withTempStore(async () => {
    // Subscribed (consumer active) but no ack yet: floor is 0, so nothing folds.
    const sub = "seq-subscribed";
    await ensureHsrRunDir(sub);
    await markHsrConsumerSubscribed(sub);
    await appendTexts(sub, 10); // seq 1..10, none acked
    assert.deepEqual(await readHsrSeqState(sub), { lastSeq: 10, subscribed: true }, "subscribed marker is durable; no ackedSeq");
    await compactHsrEvents(sub, { keepLines: 1, targetBytes: 64 });
    const subStamped = (await readLines(sub)).map((l) => (JSON.parse(l) as RunnerEvent).seq).filter((s) => s !== undefined);
    assert.deepEqual(subStamped, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "a connected consumer's un-acked events all survive");

    // No consumer ever: undefined watermark → today's byte-identical size-first fold.
    const plain = "seq-no-consumer";
    await ensureHsrRunDir(plain);
    await appendTexts(plain, 10);
    assert.deepEqual(await readHsrSeqState(plain), { lastSeq: 10 }, "no consumer marker at all");
    await compactHsrEvents(plain, { keepLines: 1, targetBytes: 64 });
    const plainStamped = (await readLines(plain)).map((l) => (JSON.parse(l) as RunnerEvent).seq).filter((s) => s !== undefined);
    assert.deepEqual(plainStamped, [10], "legacy local-only serve mode still folds to the tail, unchanged");
  });
});

test("multiple durable consumers compact only through the slowest ack and reconnect does not overwrite its authority", async () => {
  await withTempStore(async () => {
    const bee = "seq-multi-consumer-floor";
    const fast = "controller-fast";
    const slow = "controller-slow";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 10);
    await markHsrConsumerSubscribedStrict(bee, fast);
    await markHsrConsumerSubscribedStrict(bee, slow);
    assert.equal(await ackHsrEvents(bee, 10, fast), 10);
    assert.equal(await ackHsrEvents(bee, 4, slow), 4);

    await compactHsrEvents(bee, { keepLines: 1, targetBytes: 64 });
    const compacted = (await readLines(bee)).map((line) => JSON.parse(line) as RunnerEvent);
    assert.equal(
      compacted.find((event) => event.type === "source_cursor_checkpoint")?.throughSeq,
      4,
      "the fast controller cannot compact beyond the slow controller's ack",
    );
    assert.deepEqual(seqsOf(compacted.filter((event) => event.seq !== undefined)), [5, 6, 7, 8, 9, 10]);

    // A reconnect re-admits only its stable consumer identity. It must not
    // replace or advance the other controller's durable acknowledgement.
    await markHsrConsumerSubscribedStrict(bee, fast);
    assert.deepEqual((await readHsrSeqState(bee))?.consumers, {
      [fast]: { ackedSeq: 10 },
      [slow]: { ackedSeq: 4 },
    });
    assert.deepEqual(seqsOf((await readHsrEventsAfterSeqStrict(bee, 4, slow)).events), [5, 6, 7, 8, 9, 10]);
    assert.deepEqual(await readHsrEventsAfterSeqStrict(bee, 10, fast), { events: [] });
  });
});

test("strict exact replay pages a long unacked suffix through one immutable bounded snapshot", async () => {
  await withTempStore(async () => {
    const bee = "seq-bounded-replay-pages";
    const consumerId = "bounded-page-controller";
    const count = HSR_EVENT_REPLAY_PAGE_MAX_EVENTS * 2 + 19;
    await ensureHsrRunDir(bee);
    await appendTexts(bee, count);
    await markHsrConsumerSubscribedStrict(bee, consumerId);

    let cursor = 0;
    let pageToken: string | undefined;
    const seen: number[] = [];
    const pageSizes: number[] = [];
    do {
      const page = await readHsrEventsPageAfterSeqStrict(bee, cursor, consumerId, pageToken);
      assert.equal(page.gap, undefined);
      assert.ok(page.events.length <= HSR_EVENT_REPLAY_PAGE_MAX_EVENTS);
      pageSizes.push(page.events.length);
      seen.push(...page.events.map((event) => Number(event.seq)));
      cursor = page.throughSeq;
      await ackHsrEvents(bee, cursor, consumerId);
      pageToken = page.pageToken;
      assert.equal(page.hasMore, pageToken !== undefined);
    } while (pageToken);

    assert.deepEqual(pageSizes, [HSR_EVENT_REPLAY_PAGE_MAX_EVENTS, HSR_EVENT_REPLAY_PAGE_MAX_EVENTS, 19]);
    assert.deepEqual(seen, Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(cursor, count);
    assert.equal((await readHsrSeqState(bee))?.consumers?.[consumerId]?.ackedSeq, count);
  });
});

test("an exact full replay page proves EOF instead of speculating an empty continuation", async () => {
  await withTempStore(async () => {
    const bee = "seq-replay-exact-page-eof";
    const consumerId = "exact-page-controller";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, HSR_EVENT_REPLAY_PAGE_MAX_EVENTS);
    await appendFile(hsrEventsPath(bee), "\n", "utf8");
    await markHsrConsumerSubscribedStrict(bee, consumerId);

    const page = await readHsrEventsPageAfterSeqStrict(bee, 0, consumerId);
    assert.equal(page.events.length, HSR_EVENT_REPLAY_PAGE_MAX_EVENTS);
    assert.equal(page.throughSeq, HSR_EVENT_REPLAY_PAGE_MAX_EVENTS);
    assert.equal(page.hasMore, false);
    assert.equal(page.pageToken, undefined);
  });
});

test("opening a bounded replay page never regresses the live writer high-water cache", async () => {
  await withTempStore(async () => {
    const bee = "seq-page-cache-monotonic";
    const consumerId = "page-cache-controller";
    const count = HSR_EVENT_REPLAY_PAGE_MAX_EVENTS + 1;
    await ensureHsrRunDir(bee);
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    await appendTexts(bee, count);

    // Model the event-before-sidecar durability window while keeping this
    // process's writer cache at N+1. The first bounded page ends before EOF;
    // it must not replace that monotonic cache with stale seq.json=N.
    await writeFile(hsrSeqPath(bee), `${JSON.stringify({
      lastSeq: count - 1,
      consumers: { [consumerId]: {} },
    })}\n`, { mode: 0o600 });
    const first = await readHsrEventsPageAfterSeqStrict(bee, 0, consumerId);
    assert.equal(first.events.length, HSR_EVENT_REPLAY_PAGE_MAX_EVENTS);
    assert.equal(first.hasMore, true);
    assert.ok(first.pageToken);

    await appendHsrEvent(bee, { type: "text", ts: count + 1, text: "after-open-page" });
    const stamped = (await readLines(bee)).map((line) => Number((JSON.parse(line) as RunnerEvent).seq));
    assert.deepEqual(stamped, Array.from({ length: count + 1 }, (_value, index) => index + 1));

    const last = await readHsrEventsPageAfterSeqStrict(bee, first.throughSeq, consumerId, first.pageToken);
    assert.deepEqual(seqsOf(last.events), [count]);
    assert.equal(last.hasMore, false);
    assert.equal((await readHsrSeqState(bee))?.lastSeq, count + 1);
  });
});

test("paged replay heals a landed suffix before admitting a cursor at its high-water", async () => {
  await withTempStore(async () => {
    const bee = "seq-page-sidecar-lag-cursor-high";
    const consumerId = "sidecar-lag-controller";
    await ensureHsrRunDir(bee);
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    await appendTexts(bee, 3);

    // Model event seq=3 (and its exact source proof) landing before the
    // best-effort seq.json update. The controller projected seq=3 from the live
    // tap, then both processes restarted before its progress ack arrived.
    const state = await readHsrSeqState(bee);
    assert.ok(state);
    await writeFile(hsrSeqPath(bee), `${JSON.stringify({ ...state, lastSeq: 2 })}\n`, { mode: 0o600 });
    forgetHsrRunState(bee);

    const page = await readHsrEventsPageAfterSeqStrict(bee, 3, consumerId);
    assert.deepEqual(page, { events: [], throughSeq: 3, hasMore: false });
    assert.deepEqual(await readHsrSeqState(bee), { ...state, lastSeq: 3 });

    // The healed high-water is also the next writer's allocation boundary.
    await appendHsrEvent(bee, { type: "text", ts: 4, text: "after-healed-replay" });
    assert.deepEqual(seqsOf(await readHsrEventsAfterSeqStrict(bee, 3, consumerId).then((result) => result.events)), [4]);
  });
});

test("an actively read replay continuation cannot be evicted by 256 other bees", async () => {
  await withTempStore(async () => {
    await __testOnlyClearHsrEventReplaySessions();
    const consumerId = "active-page-controller";
    const target = "seq-active-replay-session";
    const count = HSR_EVENT_REPLAY_PAGE_MAX_EVENTS + 2;
    const source = `${Array.from({ length: count }, (_value, index) => JSON.stringify({
      type: "text",
      ts: index + 1,
      text: `target-${index + 1}`,
      seq: index + 1,
    })).join("\n")}\n`;
    await ensureHsrRunDir(target);
    await writeFile(hsrEventsPath(target), source, { mode: 0o600 });
    await writeFile(hsrSeqPath(target), `${JSON.stringify({
      lastSeq: count,
      consumers: { [consumerId]: {} },
    })}\n`, { mode: 0o600 });
    const first = await readHsrEventsPageAfterSeqStrict(target, 0, consumerId);
    assert.ok(first.pageToken);

    let releaseActive!: () => void;
    const activeRelease = new Promise<void>((resolveRelease) => { releaseActive = resolveRelease; });
    let markClaimed!: () => void;
    const claimed = new Promise<void>((resolveClaimed) => { markClaimed = resolveClaimed; });
    __testOnlySetReplayPageAfterSessionClaim(async (bee, token) => {
      if (bee !== target || token !== first.pageToken) return;
      markClaimed();
      await activeRelease;
    });
    const activePage = readHsrEventsPageAfterSeqStrict(target, first.throughSeq, consumerId, first.pageToken);
    await claimed;
    try {
      // Each other source retains its own continuation. At the production LRU
      // cap this would evict the target if an in-use token remained visible.
      for (let index = 0; index < 256; index += 1) {
        const bee = `seq-eviction-peer-${index}`;
        await ensureHsrRunDir(bee);
        await writeFile(hsrEventsPath(bee), source, { mode: 0o600 });
        await writeFile(hsrSeqPath(bee), `${JSON.stringify({
          lastSeq: count,
          consumers: { [consumerId]: {} },
        })}\n`, { mode: 0o600 });
        const page = await readHsrEventsPageAfterSeqStrict(bee, 0, consumerId);
        assert.equal(page.hasMore, true);
      }
      releaseActive();
      const second = await activePage;
      assert.deepEqual(seqsOf(second.events), [count - 1, count]);
      assert.equal(second.hasMore, false);
    } finally {
      releaseActive();
      __testOnlySetReplayPageAfterSessionClaim(undefined);
      await activePage.catch(() => undefined);
      await __testOnlyClearHsrEventReplaySessions();
    }
  });
});

test("authority-locked retained folding validates a long pinned suffix with constant caller state", async () => {
  await withTempStore(async () => {
    const bee = "seq-streaming-retained-fold";
    const consumerId = "streaming-fold-controller";
    const count = HSR_EVENT_REPLAY_PAGE_MAX_EVENTS * 3 + 11;
    await ensureHsrRunDir(bee);
    for (let index = 0; index < count; index += 1) {
      await appendHsrEvent(bee, {
        type: "usage",
        ts: index + 1,
        inputTokens: 1,
        outputTokens: 2,
      });
    }
    await markHsrConsumerSubscribedStrict(bee, consumerId);

    const folded = await foldHsrRetainedEventsStrict(bee, { count: 0, input: 0, output: 0 }, (summary, event) => {
      summary.count += 1;
      if (event.type === "usage") {
        summary.input += event.inputTokens ?? 0;
        summary.output += event.outputTokens ?? 0;
      }
      return summary;
    });

    assert.equal(folded.throughSeq, count);
    assert.deepEqual(folded.value, { count, input: count, output: count * 2 });
    assert.equal((await readHsrSeqState(bee))?.consumers?.[consumerId]?.ackedSeq, undefined);
  });
});

test("re-observe admission uses the durable source proof without materializing a pinned backlog", async () => {
  await withTempStore(async () => {
    const bee = "seq-streaming-subscribe-admission";
    const slow = "streaming-subscribe-slow";
    const reconnect = "streaming-subscribe-reconnect";
    await ensureHsrRunDir(bee);
    await markHsrConsumerSubscribedStrict(bee, slow);
    const payload = "x".repeat(8 * 1024);
    for (let index = 0; index < 160; index += 1) {
      await appendHsrEvent(bee, { type: "text", ts: index + 1, text: `${index}:${payload}` });
    }
    assert.ok((await readFile(hsrEventsPath(bee))).byteLength > 1024 * 1024, "slow consumer pins a >1MiB source");

    __testOnlySetWholeEventLogReadGuard((readBee) => {
      if (readBee === bee) throw new Error("whole pinned source materialized");
    });
    try {
      await markHsrConsumerSubscribedStrict(bee, reconnect);
    } finally {
      __testOnlySetWholeEventLogReadGuard(undefined);
    }
    assert.deepEqual((await readHsrSeqState(bee))?.consumers, {
      [slow]: {},
      [reconnect]: {},
    });
  });
});

test("strict exact replay bounds retained-prefix scan work for a fast consumer", async () => {
  await withTempStore(async () => {
    const bee = "seq-bounded-replay-prefix-scan";
    const consumerId = "fast-controller-with-slow-prefix";
    const count = HSR_EVENT_REPLAY_PAGE_MAX_EVENTS * 2 + 19;
    await ensureHsrRunDir(bee);
    await appendTexts(bee, count);
    await markHsrConsumerSubscribedStrict(bee, consumerId);

    let cursor = count - 1;
    let pageToken: string | undefined;
    const pageSizes: number[] = [];
    const seen: number[] = [];
    do {
      const page = await readHsrEventsPageAfterSeqStrict(bee, cursor, consumerId, pageToken);
      pageSizes.push(page.events.length);
      seen.push(...page.events.map((event) => Number(event.seq)));
      cursor = page.throughSeq;
      pageToken = page.pageToken;
    } while (pageToken);

    assert.deepEqual(pageSizes, [0, 0, 1]);
    assert.deepEqual(seen, [count]);
    assert.equal(cursor, count);
  });
});

test("a detached host append merges serve-side consumer authority before persisting or compacting", async () => {
  await withTempStore(async () => {
    const bee = "seq-cross-process-consumer-merge";
    const fast = "detached-host-fast";
    const slow = "serve-controller-slow";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 10);

    const ready = join(process.env.HIVE_STORE_ROOT!, "consumer-cache-ready");
    const release = join(process.env.HIVE_STORE_ROOT!, "consumer-cache-release");
    const moduleUrl = childSourceModule("hsr/runDir");
    const script = [
      `const {readFile,writeFile}=await import("node:fs/promises");`,
      `const {setTimeout:delay}=await import("node:timers/promises");`,
      `const m=await import(${JSON.stringify(moduleUrl)});`,
      `await m.markHsrConsumerSubscribedStrict(${JSON.stringify(bee)},${JSON.stringify(fast)});`,
      `await m.ackHsrEvents(${JSON.stringify(bee)},10,${JSON.stringify(fast)});`,
      `await writeFile(${JSON.stringify(ready)},"ready");`,
      `for(;;){try{await readFile(${JSON.stringify(release)});break}catch{await delay(10)}}`,
      `await m.appendHsrEvent(${JSON.stringify(bee)},{type:"text",ts:11,text:"from detached host"});`,
      `await m.compactHsrEvents(${JSON.stringify(bee)},{keepLines:1,targetBytes:64});`,
    ].join("");
    const child = execFileAsync(process.execPath, childModuleArgs(script), {
      cwd: process.cwd(),
      env: { ...process.env },
    });
    let released = false;
    try {
      const deadline = Date.now() + 5_000;
      while (true) {
        try {
          if ((await readFile(ready, "utf8")) === "ready") break;
        } catch {
          if (Date.now() >= deadline) throw new Error("detached cache fixture did not become ready");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      // The serve process admits a second controller after the detached host
      // cached only `fast`. The child's next append must absorb this disk state
      // instead of overwriting it from its process-local cache.
      await markHsrConsumerSubscribedStrict(bee, slow);
      await ackHsrEvents(bee, 4, slow);
      await writeFile(release, "go");
      released = true;
      await child;

      assert.deepEqual(await readHsrSeqState(bee), {
        lastSeq: 11,
        consumers: {
          [fast]: { ackedSeq: 10 },
          [slow]: { ackedSeq: 4 },
        },
      });
      const compacted = (await readLines(bee)).map((line) => JSON.parse(line) as RunnerEvent);
      assert.equal(compacted.find((event) => event.type === "source_cursor_checkpoint")?.throughSeq, 4);
      assert.deepEqual(seqsOf(compacted.filter((event) => event.seq !== undefined)), [5, 6, 7, 8, 9, 10, 11]);
    } finally {
      if (!released) await writeFile(release, "go").catch(() => undefined);
      await child.catch(() => undefined);
    }
  });
});

test("a detached host's stale cache cannot resurrect an explicitly discarded durable consumer", async () => {
  await withTempStore(async () => {
    const bee = "seq-cross-process-consumer-release";
    const consumerId = "departed-controller";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 3);
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    await ackHsrEvents(bee, 3, consumerId);

    const ready = join(process.env.HIVE_STORE_ROOT!, "consumer-release-cache-ready");
    const release = join(process.env.HIVE_STORE_ROOT!, "consumer-release-cache-go");
    const moduleUrl = childSourceModule("hsr/runDir");
    const script = [
      `const {readFile,writeFile}=await import("node:fs/promises");`,
      `const {setTimeout:delay}=await import("node:timers/promises");`,
      `const m=await import(${JSON.stringify(moduleUrl)});`,
      `await m.markHsrConsumerSubscribedStrict(${JSON.stringify(bee)},${JSON.stringify(consumerId)});`,
      `await writeFile(${JSON.stringify(ready)},"ready");`,
      `for(;;){try{await readFile(${JSON.stringify(release)});break}catch{await delay(10)}}`,
      `await m.appendHsrEvent(${JSON.stringify(bee)},{type:"text",ts:4,text:"after consumer departure"});`,
    ].join("");
    const child = execFileAsync(process.execPath, childModuleArgs(script), {
      cwd: process.cwd(),
      env: { ...process.env },
    });
    let released = false;
    try {
      const deadline = Date.now() + 5_000;
      while (true) {
        try {
          if ((await readFile(ready, "utf8")) === "ready") break;
        } catch {
          if (Date.now() >= deadline) throw new Error("stale consumer-cache fixture did not become ready");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      await discardHsrEventConsumer(bee, consumerId, {
        launchId: "00000000-0000-4000-8000-000000000901",
        incarnation: "00000000-0000-4000-8000-000000000902",
      });
      const discardedState = await readHsrSeqState(bee);
      assert.equal(discardedState?.lastSeq, 3);
      assert.equal(discardedState?.consumerRevision, 1);
      assert.equal(discardedState?.consumers, undefined);
      assert.equal(discardedState?.consumerDiscards?.[consumerId]?.throughSeq, 3);
      assert.equal(typeof discardedState?.consumerDiscards?.[consumerId]?.discardedAt, "string");
      await writeFile(release, "go");
      released = true;
      await child;

      const state = await readHsrSeqState(bee);
      assert.equal(state?.lastSeq, 4);
      assert.equal(state?.consumerRevision, 1);
      assert.equal(state?.consumers, undefined);
      assert.equal(state?.consumerDiscards?.[consumerId]?.throughSeq, 3);
      assert.deepEqual(seqsOf((await readHsrEventsAfterSeq(bee, 3)).events), [4]);
    } finally {
      if (!released) await writeFile(release, "go").catch(() => undefined);
      await child.catch(() => undefined);
    }
  });
});

test("gap detection catches an INTERNAL hole and a tail lost below seq.json's lastSeq", async () => {
  await withTempStore(async () => {
    // Internal hole: retained [1,3] (seq 2 reissued into a torn line and dropped).
    const holed = "seq-internal-hole";
    await ensureHsrRunDir(holed);
    const holedLines = [
      { type: "text", ts: 1, seq: 1, text: "a" },
      { type: "text", ts: 3, seq: 3, text: "c" },
    ];
    await writeFile(hsrEventsPath(holed), `${holedLines.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
    await writeFile(hsrSeqPath(holed), `${JSON.stringify({ lastSeq: 3 })}\n`, { mode: 0o600 });
    const holeResult = await readHsrEventsAfterSeq(holed, 0);
    assert.deepEqual(seqsOf(holeResult.events), [1, 3]);
    assert.deepEqual(holeResult.gap, { fromSeq: 2, toSeq: 2 }, "an internal hole is an explicit gap, not silent divergence");

    // Retained prefix ends below the issued high-water: [1,2,3] but lastSeq 5.
    const shortTail = "seq-short-tail";
    await ensureHsrRunDir(shortTail);
    const tailLines = [
      { type: "text", ts: 1, seq: 1, text: "a" },
      { type: "text", ts: 2, seq: 2, text: "b" },
      { type: "text", ts: 3, seq: 3, text: "c" },
    ];
    await writeFile(hsrEventsPath(shortTail), `${tailLines.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
    await writeFile(hsrSeqPath(shortTail), `${JSON.stringify({ lastSeq: 5 })}\n`, { mode: 0o600 });
    const tailResult = await readHsrEventsAfterSeq(shortTail, 0);
    assert.deepEqual(seqsOf(tailResult.events), [1, 2, 3]);
    assert.deepEqual(tailResult.gap, { fromSeq: 4, toSeq: 5 }, "seqs issued past the retained tail are reported as a gap");
  });
});

test("a hot-cache local source writer refuses holed or malformed stamped history without a consumer", async () => {
  await withTempStore(async () => {
    const holed = "seq-local-source-hole";
    await ensureHsrRunDir(holed);
    await appendTexts(holed, 3);
    const lines = await readLines(holed);
    const corrupt = `${lines.filter((line) => (JSON.parse(line) as RunnerEvent).seq !== 2).join("\n")}\n`;
    await writeFile(hsrEventsPath(holed), corrupt, { mode: 0o600 });

    await assert.rejects(
      appendHsrEvent(holed, { type: "text", ts: 4, text: "must-not-land" }),
      /internal sequence gap after 1/,
    );
    assert.equal(await readFile(hsrEventsPath(holed), "utf8"), corrupt, "writer recovery preserves the corrupt proof for manual fencing");
    assert.deepEqual(await readHsrSeqState(holed), { lastSeq: 3 }, "the issued high-water is never healed backwards");

    const malformed = "seq-local-source-malformed";
    await ensureHsrRunDir(malformed);
    await appendTexts(malformed, 2);
    const malformedRaw = `${(await readLines(malformed))[0]}\n{broken-middle\n${(await readLines(malformed))[1]}\n`;
    await writeFile(hsrEventsPath(malformed), malformedRaw, { mode: 0o600 });
    await assert.rejects(
      appendHsrEvent(malformed, { type: "text", ts: 3, text: "must-not-land" }),
      /malformed record/,
    );
    assert.equal(await readFile(hsrEventsPath(malformed), "utf8"), malformedRaw);
  });
});

test("local observation isolates a corrupt source Bee while preserving a healthy Bee across ticks", async () => {
  await withTempStore(async () => {
    const damaged = "seq-observe-damaged-a";
    const healthy = "seq-observe-healthy-b";
    const fingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(fingerprint);
    const metas = new Map<string, HsrMeta>();
    for (const [index, bee] of [damaged, healthy].entries()) {
      const startedAt = new Date(Date.now() + index).toISOString();
      const meta: HsrMeta = {
        ...liveMeta(bee),
        startedAt,
        hostFingerprint: fingerprint!,
        childAdmission: "none",
        controlSocket: "",
        runningAt: startedAt,
      };
      metas.set(bee, meta);
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, meta);
      await saveSession({
        name: bee,
        agent: "stub",
        cwd: process.cwd(),
        command: "stub",
        tmuxTarget: bee,
        substrate: "hsr",
        runnerPid: process.pid,
        runnerFingerprint: fingerprint!,
        createdAt: startedAt,
        updatedAt: startedAt,
        status: "running",
      });
      const host = { hostPid: process.pid, startedAt, hostFingerprint: fingerprint! };
      await appendHsrEvent(bee, { type: "host_epoch", ts: 1, host });
      await appendHsrEvent(bee, { type: "text", ts: 2, text: `${bee}-output`, host });
    }
    await appendHsrEvent(damaged, {
      type: "turn_end",
      ts: 3,
      host: {
        hostPid: process.pid,
        startedAt: metas.get(damaged)!.startedAt,
        hostFingerprint: fingerprint!,
      },
    });
    const damagedLines = await readLines(damaged);
    await writeFile(
      hsrEventsPath(damaged),
      `${damagedLines.filter((line) => (JSON.parse(line) as RunnerEvent).seq !== 2).join("\n")}\n`,
      { mode: 0o600 },
    );

    for (let tick = 0; tick < 2; tick += 1) {
      const observations = await hsrObservations({ bees: [damaged, healthy], includeEvents: true });
      assert.equal(observations.get(damaged)?.unavailable?.kind, "integrity");
      assert.equal(observations.get(damaged)?.live, false);
      assert.equal(observations.get(healthy)?.unavailable, undefined);
      assert.equal(observations.get(healthy)?.live, true);
      assert.equal(observations.get(healthy)?.state, "ready");
      assert.equal(
        observations.get(healthy)?.eventSnapshot?.events.some(
          (event) => event.type === "text" && event.text === `${healthy}-output`,
        ),
        true,
      );
    }
    assert.equal((await readHsrEventIntegrityReceipt(damaged))?.phase, "unresolved");
    assert.equal(await readHsrEventIntegrityReceipt(healthy), null);
    assert.equal((await loadSession(healthy))?.status, "running");
  });
});

test("a restarted local source refuses a deleted no-consumer log below its durable high-water", async () => {
  await withTempStore(async () => {
    const bee = "seq-local-source-missing-after-restart";
    await ensureHsrRunDir(bee);
    const fingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(fingerprint);
    const meta = { ...liveMeta(bee), childAdmission: "none" as const, hostFingerprint: fingerprint! };
    await writeHsrMeta(bee, meta);
    await saveSession({
      name: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      runnerPid: process.pid,
      runnerFingerprint: fingerprint!,
      createdAt: meta.startedAt,
      updatedAt: meta.startedAt,
      status: "running",
    });
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
    await rm(hsrEventsPath(bee));
    forgetHsrRunState(bee); // exact process-restart shape: only seq.json survives

    await assert.rejects(
      appendHsrEvent(bee, { type: "text", ts: 3, text: "must-not-land" }),
      /ends below durable high-water 2/,
    );
    await assert.rejects(readFile(hsrEventsPath(bee), "utf8"), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT");
    assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 2 });
    await assert.rejects(
      assertHsrSourceEventLogIntegrity({ bee, meta, operation: "deleted-log recovery admission" }),
      (error: unknown) => error instanceof HsrSourceEventIntegrityError,
    );
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(receipt?.phase, "unresolved");
    assert.equal((await loadSession(bee))?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
  });
});

test("a no-consumer retained suffix cannot invent a compacted prefix without an authority checkpoint", async () => {
  await withTempStore(async () => {
    const bee = "seq-local-source-prefix-deleted";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 3);
    const lines = await readLines(bee);
    const corrupt = `${lines.slice(1).join("\n")}\n`;
    await writeFile(hsrEventsPath(bee), corrupt, { mode: 0o600 });
    forgetHsrRunState(bee);

    await assert.rejects(
      appendHsrEvent(bee, { type: "text", ts: 4, text: "must-not-land" }),
      /starts stamped history at 2 without exact compaction proof through 1/,
    );
    assert.equal(await readFile(hsrEventsPath(bee), "utf8"), corrupt);
    assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 3 });
  });
});

test("strict source validation serializes an actual second-process append behind its authority snapshot", async () => {
  await withTempStore(async () => {
    const bee = "seq-cross-process-validation";
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    let appendPromise: ReturnType<typeof execFileAsync> | undefined;
    __testOnlySetSourceValidationAfterEventRead(() => {
      if (appendPromise) return;
      __testOnlySetSourceValidationAfterEventRead(undefined);
      const moduleUrl = childSourceModule("hsr/runDir");
      const script = `const m = await import(${JSON.stringify(moduleUrl)}); await m.appendHsrEvent(${JSON.stringify(bee)}, {type:"text",ts:2,text:"two"});`;
      appendPromise = execFileAsync(process.execPath, childModuleArgs(script), {
        cwd: process.cwd(),
        env: { ...process.env },
      });
    });
    try {
      await assertHsrSourceEventLogIntegrity({
        bee,
        meta: {
          bee,
          harness: "stub",
          tier: "stream",
          hostPid: process.pid,
          childAdmission: "none",
          startedAt: "2026-08-15T20:00:00.000Z",
          controlSocket: "",
          status: "running",
        },
        operation: "cross-process validation",
      });
    } finally {
      __testOnlySetSourceValidationAfterEventRead(undefined);
    }
    await appendPromise;
    assert.deepEqual((await readLines(bee)).map((line) => (JSON.parse(line) as RunnerEvent).seq), [1, 2]);
    assert.equal((await readHsrSeqState(bee))?.lastSeq, 2);
    assert.equal(await readHsrEventIntegrityReceipt(bee), null, "a healthy interleaving creates no receipt or stop fence");
  });
});

test("a visible partial append held by cross-process writer authority is retryable, never corruption", async () => {
  await withTempStore(async () => {
    const bee = "seq-append-before-sidecar-validation";
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    const hostFingerprint = await captureProcessBirthFingerprint(process.pid);
    assert.ok(hostFingerprint);
    await writeHsrMeta(bee, { ...liveMeta(bee), hostFingerprint: hostFingerprint! });
    await markHsrConsumerSubscribedStrict(bee, "busy-consumer");
    const ready = join(process.env.HIVE_STORE_ROOT!, "partial-ready");
    const release = join(process.env.HIVE_STORE_ROOT!, "partial-release");
    const lockModuleUrl = childSourceModule("lock");
    const script = [
      `const {appendFile,readFile,writeFile}=await import("node:fs/promises");`,
      `const {setTimeout:delay}=await import("node:timers/promises");`,
      `const {withFileLock}=await import(${JSON.stringify(lockModuleUrl)});`,
      `await withFileLock(${JSON.stringify(hsrEventAuthorityLockPath(bee))},async()=>{`,
      `await appendFile(${JSON.stringify(hsrEventsPath(bee))},'{"type":"turn_start","ts":2,');`,
      `await writeFile(${JSON.stringify(ready)},'ready');`,
      `for(;;){try{await readFile(${JSON.stringify(release)});break}catch{await delay(10)}}`,
      `await appendFile(${JSON.stringify(hsrEventsPath(bee))},'"seq":2}\\n');`,
      `await writeFile(${JSON.stringify(hsrSeqPath(bee))},JSON.stringify({lastSeq:2})+'\\n');`,
      `},{timeoutMs:5000,pollMs:10});`,
    ].join("");
    const writer = execFileAsync(process.execPath, childModuleArgs(script), {
      cwd: process.cwd(),
      env: { ...process.env },
    });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        if ((await readFile(ready, "utf8")) === "ready") break;
      } catch {
        if (Date.now() >= deadline) throw new Error("partial writer did not acquire authority");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const controller = buildController();
    let released = false;
    __testOnlySetHsrEventAuthorityTimeout(50);
    try {
      await assert.rejects(
        assertHsrSourceEventLogIntegrity({
          bee,
          meta: liveMeta(bee),
          operation: "writer-held source validation",
        }),
        (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_EVENT_LOG_BUSY",
      );
      const localObservation = (await hsrObservations({ bees: [bee], includeEvents: true })).get(bee);
      assert.equal(localObservation?.unavailable?.kind, "busy");
      assert.equal(localObservation?.state, undefined, "a partial turn_start can never be skipped into a stale idle projection");
      assert.equal(localObservation?.eventSnapshot, undefined);
      const [observe, events, ack, list] = await Promise.all([
        controller.methods.observe!({ bee, consumerId: "busy-consumer" }, CTX),
        controller.methods.events!({ bee, consumerId: "busy-consumer", afterSeq: 0 }, CTX),
        controller.methods.ackEvents!({ bee, consumerId: "busy-consumer", upToSeq: 1 }, CTX),
        controller.methods.list!(undefined, CTX),
      ]);
      for (const response of [observe, events, ack] as Array<{ ok?: boolean; integrityFailure?: boolean; error?: string }>) {
        assert.equal(response.ok, false);
        assert.notEqual(response.integrityFailure, true, response.error);
        assert.match(response.error ?? "", /changing; retry/);
      }
      assert.ok(Array.isArray(list));
      const busyRow = (list as Array<{ bee?: string; unavailable?: string; integrityFailure?: boolean; error?: string }>)
        .find((row) => row.bee === bee);
      assert.equal(busyRow?.unavailable, "busy");
      assert.notEqual(busyRow?.integrityFailure, true, busyRow?.error);
      assert.match(busyRow?.error ?? "", /changing; retry/);
      assert.equal(await readHsrEventIntegrityReceipt(bee), null, "busy authority cannot publish an integrity receipt");
      await writeFile(release, "release");
      released = true;
      await writer;
      await validateHsrSourceEventLogStrict(bee);
      assert.deepEqual((await readLines(bee)).map((line) => (JSON.parse(line) as RunnerEvent).seq), [1, 2]);
      assert.equal((await readHsrSeqState(bee))?.lastSeq, 2);
    } finally {
      __testOnlySetHsrEventAuthorityTimeout(undefined);
      if (!released) await writeFile(release, "release").catch(() => undefined);
      await writer.catch(() => undefined);
      await rm(hsrRunDir(bee), { recursive: true, force: true });
      await controller.close();
    }
  });
});

test("strict source history accepts only a seq-less legacy prefix, never records injected after stamped authority", async () => {
  await withTempStore(async () => {
    const legacy = "seq-legacy-prefix";
    await ensureHsrRunDir(legacy);
    await writeFile(hsrEventsPath(legacy), [
      JSON.stringify({ type: "text", ts: 0, text: "legacy" }),
      JSON.stringify({ type: "text", ts: 1, text: "one", seq: 1 }),
      JSON.stringify({ type: "text", ts: 2, text: "two", seq: 2 }),
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(hsrSeqPath(legacy), `${JSON.stringify({ lastSeq: 2 })}\n`, { mode: 0o600 });
    await validateHsrSourceEventLogStrict(legacy);

    const injected = "seq-injected-hostless-middle";
    await ensureHsrRunDir(injected);
    await writeFile(hsrEventsPath(injected), [
      JSON.stringify({ type: "text", ts: 1, text: "one", seq: 1 }),
      JSON.stringify({ type: "auth_resume", ts: 2, source: "auto" }),
      JSON.stringify({ type: "text", ts: 3, text: "three", seq: 2 }),
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(hsrSeqPath(injected), `${JSON.stringify({ lastSeq: 2 })}\n`, { mode: 0o600 });
    await assert.rejects(validateHsrSourceEventLogStrict(injected), /seq-less record after stamped history/);
  });
});

test("forgetHsrRunState evicts the in-process seq cache so a recreated run dir restarts at 1", async () => {
  await withTempStore(async () => {
    const bee = "seq-recreate";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 3); // seq 1..3; cache now holds lastSeq 3

    // The in-process cache is also loss evidence: a raw delete/recreate without
    // the lifecycle deletion helper must fail closed instead of silently
    // resetting or issuing across the missing prefix.
    await rm(hsrRunDir(bee), { recursive: true, force: true });
    await ensureHsrRunDir(bee);
    await assert.rejects(
      appendHsrEvent(bee, { type: "text", ts: 4, text: "stale-cache" }),
      /ends below durable high-water 3/,
    );
    await assert.rejects(readFile(hsrEventsPath(bee), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    // With eviction on lifecycle delete, the recreated dir starts from on-disk truth.
    await rm(hsrRunDir(bee), { recursive: true, force: true });
    forgetHsrRunState(bee);
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "text", ts: 5, text: "fresh" });
    assert.equal((JSON.parse((await readLines(bee)).at(-1)!) as RunnerEvent).seq, 1, "forget resets the cache — fresh dir issues seq 1");
  });
});

test("confirmed run-dir removal drains old appends, forgets their cache, and same-name reuse starts at seq 1", async () => {
  await withTempStore(async () => {
    const bee = "seq-confirmed-remove-recreate";
    const hostPid = 77881;
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid,
      startedAt: "2026-08-15T20:00:00.000Z",
      controlSocket: "",
      status: "exited",
      endedAt: "2026-08-15T20:00:01.000Z",
      exitCode: null,
    });
    await appendTexts(bee, 3);

    // Leave one predecessor append in the serialized writer chain while the
    // lifecycle cleanup begins. Cleanup must wait for it before removing the
    // directory and evicting the per-name high-water cache.
    const predecessorTail = appendHsrEvent(bee, {
      type: "text",
      ts: 4,
      text: "predecessor-tail",
    });
    await removeConfirmedStoppedHsrRunDir(bee, hostPid);
    await predecessorTail;

    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "text", ts: 5, text: "successor-first" });
    const successor = JSON.parse((await readLines(bee)).at(-1)!) as RunnerEvent;
    assert.equal(successor.seq, 1, "the successor cannot inherit the removed predecessor's issued high-water");
    assert.equal(successor.type, "text");
    if (successor.type === "text") assert.equal(successor.text, "successor-first");
  });
});

test("strict resume rejects corrupt storage and a cursor ahead of the issued high-water", async () => {
  await withTempStore(async () => {
    const ahead = "seq-strict-ahead";
    await ensureHsrRunDir(ahead);
    await appendTexts(ahead, 2);
    await markHsrConsumerSubscribedStrict(ahead);
    await assert.rejects(
      readHsrEventsAfterSeqStrict(ahead, 3),
      /exceeds durable high-water 2/,
    );

    const corrupt = "seq-strict-corrupt";
    await ensureHsrRunDir(corrupt);
    await appendTexts(corrupt, 1);
    await writeFile(hsrSeqPath(corrupt), "{not-json\n", { mode: 0o600 });
    __testOnlyResetSeqState(corrupt);
    await assert.rejects(markHsrConsumerSubscribedStrict(corrupt), /malformed/);

    const unreadableLog = "seq-strict-unreadable-log";
    await ensureHsrRunDir(unreadableLog);
    await appendTexts(unreadableLog, 1);
    await rm(hsrEventsPath(unreadableLog));
    await mkdir(hsrEventsPath(unreadableLog));
    __testOnlyResetSeqState(unreadableLog);
    await assert.rejects(markHsrConsumerSubscribedStrict(unreadableLog), /unreadable/);
  });
});

test("strict subscribe and replay reject a retained suffix whose compacted prefix has no checkpoint proof", async () => {
  await withTempStore(async () => {
    const subscribeBee = "seq-strict-unproven-subscribe";
    await ensureHsrRunDir(subscribeBee);
    await writeFile(
      hsrEventsPath(subscribeBee),
      `${JSON.stringify({ type: "text", ts: 10, seq: 10, text: "unproven tail" })}\n`,
      { mode: 0o600 },
    );
    await writeFile(hsrSeqPath(subscribeBee), `${JSON.stringify({ lastSeq: 10 })}\n`, { mode: 0o600 });
    __testOnlyResetSeqState(subscribeBee);
    await assert.rejects(
      markHsrConsumerSubscribedStrict(subscribeBee, "new-controller"),
      /starts stamped history at 10 without exact compaction proof through 9/,
    );

    const replayBee = "seq-strict-unproven-replay";
    const consumerId = "existing-controller";
    await ensureHsrRunDir(replayBee);
    await writeFile(
      hsrEventsPath(replayBee),
      `${JSON.stringify({ type: "text", ts: 10, seq: 10, text: "unproven tail" })}\n`,
      { mode: 0o600 },
    );
    await writeFile(hsrSeqPath(replayBee), `${JSON.stringify({
      lastSeq: 10,
      consumers: { [consumerId]: { ackedSeq: 10 } },
    })}\n`, { mode: 0o600 });
    __testOnlyResetSeqState(replayBee);
    await assert.rejects(
      readHsrEventsAfterSeqStrict(replayBee, 10, consumerId),
      /starts stamped history at 10 without exact compaction proof through 9/,
    );
  });
});

test("remote observe reports strict storage corruption as typed integrity, not a retryable refusal", async () => {
  await withTempStore(async () => {
    const bee = "seq-observe-integrity-wire";
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, liveMeta(bee));
    await appendTexts(bee, 1);
    await writeFile(hsrSeqPath(bee), "{broken\n", { mode: 0o600 });
    __testOnlyResetSeqState(bee);
    const controller = buildController();
    try {
      const response = await controller.methods.observe!({ bee, consumerId: "corrupt-observer" }, CTX) as {
        ok?: boolean;
        integrityFailure?: boolean;
        error?: string;
      };
      assert.equal(response.ok, false);
      assert.equal(response.integrityFailure, true);
      assert.match(response.error ?? "", /malformed/);
    } finally {
      await rm(hsrRunDir(bee), { recursive: true, force: true });
      await controller.close();
    }
  });
});

test("remote observe refuses a seq-less mutation injected after stamped source authority", async () => {
  await withTempStore(async () => {
    const bee = "seq-observe-seqless-middle";
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, liveMeta(bee));
    await writeFile(hsrEventsPath(bee), [
      JSON.stringify({ type: "text", ts: 1, text: "one", seq: 1 }),
      JSON.stringify({ type: "auth_resume", ts: 2, source: "legacy" }),
      JSON.stringify({ type: "text", ts: 3, text: "two", seq: 2 }),
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(hsrSeqPath(bee), `${JSON.stringify({ lastSeq: 2 })}\n`, { mode: 0o600 });
    __testOnlyResetSeqState(bee);
    const controller = buildController();
    try {
      const response = await controller.methods.observe!({ bee, consumerId: "seqless-observer" }, CTX) as {
        ok?: boolean;
        integrityFailure?: boolean;
        error?: string;
      };
      assert.equal(response.ok, false);
      assert.equal(response.integrityFailure, true);
      assert.match(response.error ?? "", /seq-less record after stamped history/);
    } finally {
      await rm(hsrRunDir(bee), { recursive: true, force: true });
      await controller.close();
    }
  });
});

test("strict subscribe repairs the append-to-sidecar crash window and serializes a concurrent append", async () => {
  await withTempStore(async () => {
    const bee = "seq-strict-sidecar-repair";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 2);
    await rm(hsrSeqPath(bee));
    __testOnlyResetSeqState(bee);

    await markHsrConsumerSubscribedStrict(bee);
    assert.deepEqual(await readHsrSeqState(bee), { lastSeq: 2, subscribed: true });
    assert.deepEqual(seqsOf((await readHsrEventsAfterSeqStrict(bee, 0)).events), [1, 2]);

    // appendHsrEvent installs its append-chain barrier synchronously. A strict
    // snapshot started immediately afterward must observe either the complete
    // prior state or the complete append, never log N / sidecar N+1.
    const append = appendHsrEvent(bee, { type: "needs_input", ts: 3, kind: "question", question: "silent?", requestId: "r3" });
    const replay = readHsrEventsAfterSeqStrict(bee, 2);
    await append;
    const result = await replay;
    assert.equal(result.gap, undefined);
    assert.deepEqual(seqsOf(result.events), [3]);
  });
});

test("strict replay repairs a proven append-before-sidecar suffix for an already-admitted consumer", async () => {
  await withTempStore(async () => {
    const bee = "seq-strict-replay-sidecar-repair";
    const consumerId = "already-admitted-controller";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 2);
    await markHsrConsumerSubscribedStrict(bee, consumerId);

    // Model appendHsrEvent's durability order: seq 3 reached events.jsonl, but
    // the following best-effort seq.json write was lost. No second observe RPC
    // is guaranteed for a terminal replay, so `events` itself must heal this
    // fully proven contiguous suffix rather than return a false integrity fault.
    const prior = await readFile(hsrEventsPath(bee), "utf8");
    await writeFile(
      hsrEventsPath(bee),
      `${prior}${JSON.stringify({ type: "exit", ts: 3, seq: 3, code: 0 })}\n`,
      { mode: 0o600 },
    );
    assert.deepEqual(await readHsrSeqState(bee), {
      lastSeq: 2,
      consumers: { [consumerId]: {} },
    });

    const replay = await readHsrEventsAfterSeqStrict(bee, 2, consumerId);
    assert.equal(replay.gap, undefined);
    assert.deepEqual(seqsOf(replay.events), [3]);
    assert.deepEqual(await readHsrSeqState(bee), {
      lastSeq: 3,
      consumers: { [consumerId]: {} },
    });
    assert.equal(await ackHsrEvents(bee, 3, consumerId), 3, "the repaired high-water is immediately acknowledgeable");
  });
});

test("compaction preserves only the latest host epoch's ordered lifecycle facts", async () => {
  await withTempStore(async () => {
    const hostA = {
      hostPid: 101,
      startedAt: "2026-08-15T00:00:00.000Z",
      hostFingerprint: { pgid: 101, startedAt: "host-a" },
    };
    const hostB = {
      hostPid: 202,
      startedAt: "2026-08-15T00:01:00.000Z",
      hostFingerprint: { pgid: 202, startedAt: "host-b" },
    };

    const silent = "seq-compact-host-silent";
    await ensureHsrRunDir(silent);
    await appendHsrEvent(silent, { type: "host_epoch", ts: 1, host: hostA });
    await appendHsrEvent(silent, { type: "exhausted", ts: 2, resetHint: "A", host: hostA });
    await appendHsrEvent(silent, { type: "needs_input", ts: 3, kind: "question", question: "A?", requestId: "a", host: hostA });
    await appendHsrEvent(silent, { type: "host_epoch", ts: 4, host: hostB });
    await appendTexts(silent, 5, 10);
    await compactHsrEvents(silent, { keepLines: 1, targetBytes: 10_000 });
    const silentEpoch = currentHsrEventEpoch(await readEventTail(silent), hostB);
    assert.ok(silentEpoch.events.some((event) => event.type === "host_epoch"));
    assert.equal(silentEpoch.events.some((event) => event.type === "exhausted"), false);
    assert.equal(silentEpoch.events.some((event) => event.type === "needs_input"), false);

    const current = "seq-compact-host-current";
    await ensureHsrRunDir(current);
    await appendHsrEvent(current, { type: "host_epoch", ts: 1, host: hostA });
    await appendHsrEvent(current, { type: "exhausted", ts: 2, resetHint: "A", host: hostA });
    await appendHsrEvent(current, { type: "host_epoch", ts: 3, host: hostB });
    await appendHsrEvent(current, { type: "exhausted", ts: 4, resetHint: "B", host: hostB });
    await appendHsrEvent(current, { type: "turn_start", ts: 5, host: hostB });
    await appendHsrEvent(current, { type: "needs_input", ts: 6, kind: "question", question: "B?", requestId: "b", host: hostB });
    await appendTexts(current, 5, 10);
    await compactHsrEvents(current, { keepLines: 1, targetBytes: 10_000 });
    const currentEpoch = currentHsrEventEpoch(await readEventTail(current), hostB);
    assert.deepEqual(
      currentEpoch.events.filter((event) => event.type === "exhausted").map((event) => event.resetHint),
      ["B"],
    );
    assert.equal(currentEpoch.events.some((event) => event.type === "turn_start"), true);
    assert.equal(currentEpoch.events.some((event) => event.type === "needs_input" && event.requestId === "b"), true);
  });
});

test("incremental host-epoch projection preserves cumulative usage and equals a strict rebuild", async () => {
  await withTempStore(async () => {
    const bee = "seq-source-projection-host-usage";
    const hostA = {
      hostPid: 301,
      startedAt: "2026-08-15T00:00:00.000Z",
      hostFingerprint: { pgid: 301, startedAt: "projection-host-a" },
    };
    const hostB = {
      hostPid: 302,
      startedAt: "2026-08-15T00:01:00.000Z",
      hostFingerprint: { pgid: 302, startedAt: "projection-host-b" },
    };
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "host_epoch", ts: 1, host: hostA });
    await appendHsrEvent(bee, {
      type: "usage",
      ts: 2,
      inputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      outputTokens: 5,
      reasoningTokens: 7,
      host: hostA,
    });
    await appendHsrEvent(bee, { type: "exhausted", ts: 3, resetHint: "old host", host: hostA });
    await appendHsrEvent(bee, {
      type: "needs_input",
      ts: 4,
      kind: "question",
      question: "old host?",
      requestId: "old-host-request",
      host: hostA,
    });
    await appendHsrEvent(bee, { type: "host_epoch", ts: 5, host: hostB });
    await appendHsrEvent(bee, {
      type: "usage",
      ts: 6,
      inputTokens: 11,
      outputTokens: 13,
      reasoningTokens: 17,
      host: hostB,
    });
    await appendHsrEvent(bee, { type: "turn_start", ts: 7, host: hostB });
    await appendHsrEvent(bee, { type: "turn_end", ts: 8, host: hostB });

    const incremental = await readHsrSourceListProjectionStrict(bee, hostB);
    assert.deepEqual(incremental, {
      stateEvents: [
        { type: "turn_start", ts: 7, host: hostB, seq: 7 },
        { type: "turn_end", ts: 8, host: hostB, seq: 8 },
      ],
      usage: { totals: { inputTokens: 20, outputTokens: 42 } },
    });

    // Delete only the rebuildable projection proof and drop process caches.
    // The same source bytes must fold to exactly the incremental result.
    await rm(join(hsrRunDir(bee), "source-proof.json"), { force: true });
    forgetHsrRunState(bee);
    const rebuilt = await readHsrSourceListProjectionStrict(bee, hostB);
    assert.deepEqual(rebuilt, incremental);
  });
});

test("mirror compaction refuses to launder a corrupt remote-origin gap into a checkpoint", async () => {
  await withTempStore(async () => {
    const bee = "seq-compact-origin-gap";
    const launchId = "00000000-0000-4000-8000-000000000701";
    const incarnation = "00000000-0000-4000-8000-000000000702";
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: 0,
      startedAt: "2026-08-15T00:00:00.000Z",
      controlSocket: "",
      status: "running",
      mirrorOfNode: "remote-node",
      mirrorRemoteLaunchId: launchId,
      mirrorRemoteIncarnation: incarnation,
    });
    const corrupt = [1, 2, 4].map((remoteSeq, index) => JSON.stringify({
      type: "text",
      ts: index + 1,
      seq: index + 1,
      remoteSeq,
      text: `remote-${remoteSeq}`,
    })).join("\n") + "\n";
    await writeFile(hsrEventsPath(bee), corrupt, { mode: 0o600 });

    await assert.rejects(
      compactHsrEvents(bee, { keepLines: 1, targetBytes: 10_000 }),
      /non-contiguous at 4/,
    );
    assert.equal(await readFile(hsrEventsPath(bee), "utf8"), corrupt, "failed compaction leaves corruption visible for the mirror fence");
  });
});

test("explicit compaction serializes its snapshot replacement before a concurrent append", async () => {
  await withTempStore(async () => {
    const bee = "seq-compact-append-race";
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    await appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
    await markHsrConsumerSubscribedStrict(bee);
    assert.equal(await ackHsrEvents(bee, 1), 1);

    let snapshotRead!: () => void;
    const entered = new Promise<void>((resolve) => { snapshotRead = resolve; });
    let releaseCompact!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCompact = resolve; });
    const compacting = compactHsrEvents(bee, {
      keepLines: 1,
      targetBytes: 10_000,
      afterSnapshotRead: async () => {
        snapshotRead();
        await gate;
      },
    });
    await entered;
    const appending = appendHsrEvent(bee, { type: "needs_input", ts: 3, kind: "question", question: "three?", requestId: "r3" });
    releaseCompact();
    await Promise.all([compacting, appending]);

    const resumed = await readHsrEventsAfterSeqStrict(bee, 1);
    assert.equal(resumed.gap, undefined);
    assert.deepEqual(resumed.events.map((event) => event.seq), [2, 3]);
    assert.equal(
      resumed.events.filter((event) => event.type === "needs_input" && event.requestId === "r3").length,
      1,
      "the append queued behind compaction survives the atomic replacement exactly once",
    );
  });
});
