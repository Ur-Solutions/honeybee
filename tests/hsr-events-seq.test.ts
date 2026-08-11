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
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  forgetHsrRunState,
  hsrEventsPath,
  hsrRunDir,
  hsrSeqPath,
  markHsrConsumerSubscribed,
  readHsrEventsAfterSeq,
  readHsrSeqState,
  writeHsrMeta,
  type HsrMeta,
} from "../src/hsr/runDir.js";
import type { RunnerEvent } from "../src/hsr/types.js";

/** chmod-based failure injection needs a non-root uid to actually deny writes. */
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

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

test("a crash-torn trailing record is repaired, not fused into a swallowed line", async () => {
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
    __testOnlyResetSeqState(torn);
    await appendHsrEvent(torn, { type: "text", ts: 2, text: "reissued" });
    const tornLines = await readLines(torn);
    // Every line must parse (no fused garbage) and the un-landed seq 2 is reused.
    for (const line of tornLines) JSON.parse(line);
    assert.deepEqual(tornLines.map((l) => (JSON.parse(l) as RunnerEvent).seq), [1, 2]);
    assert.equal((await readHsrEventsAfterSeq(torn, 0)).gap, undefined);

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

test("forgetHsrRunState evicts the in-process seq cache so a recreated run dir restarts at 1", async () => {
  await withTempStore(async () => {
    const bee = "seq-recreate";
    await ensureHsrRunDir(bee);
    await appendTexts(bee, 3); // seq 1..3; cache now holds lastSeq 3

    // The in-process cache is keyed by bee, so WITHOUT eviction a delete+recreate
    // of the same name resurrects the stale high-water (the hazard being fixed).
    await rm(hsrRunDir(bee), { recursive: true, force: true });
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "text", ts: 4, text: "stale-cache" });
    assert.equal((JSON.parse((await readLines(bee)).at(-1)!) as RunnerEvent).seq, 4, "the sticky cache would keep counting from 3");

    // With eviction on lifecycle delete, the recreated dir starts from on-disk truth.
    await rm(hsrRunDir(bee), { recursive: true, force: true });
    forgetHsrRunState(bee);
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "text", ts: 5, text: "fresh" });
    assert.equal((JSON.parse((await readLines(bee)).at(-1)!) as RunnerEvent).seq, 1, "forget resets the cache — fresh dir issues seq 1");
  });
});
