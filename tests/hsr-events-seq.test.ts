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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hsrUsageObservation, pendingNeedsInput, readEventTail } from "../src/hsr/observe.js";
import { buildController } from "../src/hsr/remoteHost.js";
import {
  __testOnlyResetSeqState,
  ackHsrEvents,
  appendHsrEvent,
  compactHsrEvents,
  ensureHsrRunDir,
  hsrEventsPath,
  hsrSeqPath,
  readHsrEventsAfterSeq,
  readHsrSeqState,
  writeHsrMeta,
  type HsrMeta,
} from "../src/hsr/runDir.js";
import type { RunnerEvent } from "../src/hsr/types.js";

const CTX = { connectionId: 1, close() {} };

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

    // Restart with a LOST/truncated log: seq.json wins — seqs are never reissued.
    await writeFile(hsrSeqPath(bee), `${JSON.stringify({ lastSeq: 50 })}\n`, { mode: 0o600 });
    await rm(hsrEventsPath(bee));
    __testOnlyResetSeqState(bee);
    await appendHsrEvent(bee, { type: "text", ts: 12, text: "after-wipe" });
    assert.equal((JSON.parse((await readLines(bee)).at(-1)!) as RunnerEvent).seq, 51);
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

      const bySeq = (await controller.methods.events!({ bee, afterSeq: 2 }, CTX)) as { ok: boolean; events: RunnerEvent[]; gap?: unknown };
      assert.equal(bySeq.ok, true);
      assert.deepEqual(seqsOf(bySeq.events), [3, 4]);
      assert.equal(bySeq.gap, undefined);

      // Existing afterTs callers keep working, seq stamps included.
      const byTs = (await controller.methods.events!({ bee, afterTs: 101 }, CTX)) as { ok: boolean; events: RunnerEvent[] };
      assert.equal(byTs.ok, true);
      assert.deepEqual(seqsOf(byTs.events), [3, 4]);

      // Ack, then compact past the watermark: the RPC result carries the gap.
      const acked = (await controller.methods.ackEvents!({ bee, upToSeq: 3 }, CTX)) as { ok: boolean; ackedSeq?: number };
      assert.deepEqual(acked, { ok: true, ackedSeq: 3 });
      await compactHsrEvents(bee, { keepLines: 1, targetBytes: 10_000 });
      const gapped = (await controller.methods.events!({ bee, afterSeq: 0 }, CTX)) as {
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
      await controller.close();
    }
  });
});
