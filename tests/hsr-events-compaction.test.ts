/**
 * HIVE-13: events.jsonl must stay bounded and cheap to observe.
 *
 *   - compactHsrEvents folds the dropped prefix into checkpoint events so
 *     cumulative usage totals and the exhaustion edge survive compaction.
 *   - appendHsrEvent auto-compacts once the log crosses HSR_EVENTS_MAX_BYTES.
 *   - readEventTail (via hsrObservations/pendingNeedsInput) reads only the
 *     trailing bytes, so a huge legacy log still observes correctly.
 *
 * HIVE-55: the derived structured state must survive long turns.
 *
 *   - observers scan the whole writer-bounded log (no fixed line window), so
 *     a turn emitting hundreds of text chunks still observes as "active".
 *   - compaction preserves the last turn/needs markers from the dropped
 *     prefix, so the derived state is invariant under compaction.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EVENT_TAIL_MAX_BYTES, hsrObservations, hsrUsageObservation, pendingNeedsInput } from "../src/hsr/observe.js";
import {
  HSR_EVENTS_MAX_BYTES,
  __testOnlyHasAppendChain,
  appendHsrEvent,
  compactHsrEvents,
  ensureHsrRunDir,
  hsrEventsPath,
  writeHsrMeta,
  type HsrMeta,
} from "../src/hsr/runDir.js";
import type { RunnerEvent } from "../src/hsr/types.js";

/** Point HIVE_STORE_ROOT at a fresh temp dir for the duration of `fn`. */
async function withTempStore<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-compact-"));
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

/** Write a bee's events.jsonl (one RunnerEvent per line) into its run dir. */
async function writeEvents(bee: string, events: RunnerEvent[]): Promise<void> {
  await ensureHsrRunDir(bee);
  await writeFile(hsrEventsPath(bee), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
}

async function readLines(bee: string): Promise<string[]> {
  const raw = await readFile(hsrEventsPath(bee), "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

test("compactHsrEvents folds dropped usage/exhausted into checkpoints, keeps the tail verbatim", async () => {
  await withTempStore(async () => {
    const bee = "compactee";
    const events: RunnerEvent[] = [
      { type: "usage", ts: 1, inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      { type: "usage", ts: 2, inputTokens: 50, outputTokens: 5, totalTokens: 55 },
      { type: "exhausted", ts: 3, resetHint: "R1" },
      ...Array.from({ length: 10 }, (_, i): RunnerEvent => ({ type: "text", ts: 4 + i, text: `chunk-${i}` })),
      { type: "turn_start", ts: 14 },
      { type: "needs_input", ts: 15, kind: "question", question: "pick?", requestId: "req-1" },
    ];
    await writeEvents(bee, events);
    await writeHsrMeta(bee, liveMeta(bee));
    const before = await readLines(bee);

    // Within bounds → a no-op (nothing dropped, file byte-identical).
    await compactHsrEvents(bee, { keepLines: 1_000, targetBytes: 10_000_000 });
    assert.deepEqual(await readLines(bee), before, "compaction within bounds must not rewrite the log");

    await compactHsrEvents(bee, { keepLines: 4, targetBytes: 10_000 });

    const lines = await readLines(bee);
    // usage checkpoint + exhausted checkpoint + text stub (the dropped prefix
    // held assistant text but no turn markers) + the 4 kept tail lines.
    assert.equal(lines.length, 7);
    assert.deepEqual(JSON.parse(lines[0]!), { type: "usage", ts: 2, inputTokens: 150, outputTokens: 15, totalTokens: 165 });
    assert.deepEqual(JSON.parse(lines[1]!), { type: "exhausted", ts: 3, resetHint: "R1" });
    assert.deepEqual(JSON.parse(lines[2]!), { type: "text", ts: 11, text: "…" });
    assert.deepEqual(lines.slice(3), before.slice(-4), "kept tail must be preserved verbatim");

    // The cumulative usage observation is EXACTLY what it was pre-compaction.
    const usage = await hsrUsageObservation(bee);
    assert.deepEqual(usage.totals, { inputTokens: 150, outputTokens: 15 });
    assert.deepEqual(usage.latestExhausted, { ts: 3, resetHint: "R1" });

    // The unresolved needs_input in the kept tail still observes: blocked + pending.
    const observation = (await hsrObservations()).get(bee);
    assert.equal(observation?.live, true);
    assert.equal(observation?.state, "blocked");
    const observedWithEvents = (await hsrObservations({ includeEvents: true })).get(bee);
    assert.deepEqual(observedWithEvents?.eventSnapshot?.usage.totals, { inputTokens: 150, outputTokens: 15 });
    assert.deepEqual(observedWithEvents?.eventSnapshot?.usage.latestExhausted, { ts: 3, resetHint: "R1" });
    assert.equal(observedWithEvents?.eventSnapshot?.pendingNeedsInput?.requestId, "req-1");
    const pending = await pendingNeedsInput(bee);
    assert.equal(pending?.requestId, "req-1");
    assert.equal(pending?.question, "pick?");
  });
});

test("appendHsrEvent auto-compacts past the byte cap without losing usage totals", async () => {
  await withTempStore(async () => {
    const bee = "auto-compactee";
    await ensureHsrRunDir(bee);

    // ~2000 events × ~650 bytes ≈ 1.3 MiB — crosses HSR_EVENTS_MAX_BYTES once.
    const padding = "x".repeat(600);
    let expectedInput = 0;
    let expectedOutput = 0;
    let last: Promise<void> = Promise.resolve();
    last = appendHsrEvent(bee, { type: "exhausted", ts: 5, resetHint: "early-reset" });
    for (let i = 0; i < 2_000; i++) {
      if (i % 20 === 0) {
        expectedInput += 7;
        expectedOutput += 3;
        last = appendHsrEvent(bee, { type: "usage", ts: i, inputTokens: 7, outputTokens: 3 });
      } else {
        last = appendHsrEvent(bee, { type: "text", ts: i, text: padding });
      }
    }
    // Appends are chained per bee, so awaiting the last settles them all.
    await last;

    const { size } = await stat(hsrEventsPath(bee));
    assert.ok(size < HSR_EVENTS_MAX_BYTES, `events.jsonl must stay under the cap after compaction (got ${size})`);

    // The usage/exhaustion observation is unaffected by the compaction: the
    // dropped prefix's usage lives on in the checkpoint event.
    const usage = await hsrUsageObservation(bee);
    assert.deepEqual(usage.totals, { inputTokens: expectedInput, outputTokens: expectedOutput });
    assert.equal(usage.latestExhausted?.resetHint, "early-reset");
  });
});

test("appendHsrEvent drops settled append-chain entries", async () => {
  await withTempStore(async () => {
    const bee = "chain-cleanup";
    await ensureHsrRunDir(bee);

    await appendHsrEvent(bee, { type: "text", ts: 1, text: "one" });
    assert.equal(__testOnlyHasAppendChain(bee), false, "settled append chain must not remain cached");

    const first = appendHsrEvent(bee, { type: "text", ts: 2, text: "two" });
    const second = appendHsrEvent(bee, { type: "text", ts: 3, text: "three" });
    await Promise.all([first, second]);
    assert.equal(__testOnlyHasAppendChain(bee), false, "concurrent append chain must also clean itself up");
  });
});

test("observers read only the tail of a huge legacy log and still derive state", async () => {
  await withTempStore(async () => {
    const bee = "tail-reader";
    // Prefix noise beyond the tail-read byte cap (a legacy log no writer ever
    // compacted), with the story that matters — an unresolved needs_input — at
    // the very end.
    const padding = "y".repeat(500);
    const events: RunnerEvent[] = [
      { type: "usage", ts: 0, inputTokens: 1, outputTokens: 1 },
      ...Array.from({ length: 3_000 }, (_, i): RunnerEvent => ({ type: "text", ts: i, text: padding })),
      { type: "turn_start", ts: 9_000 },
      { type: "needs_input", ts: 9_001, kind: "permission", question: "allow?", tool: "Bash", requestId: "req-tail" },
    ];
    await writeEvents(bee, events);
    await writeHsrMeta(bee, liveMeta(bee));
    const { size } = await stat(hsrEventsPath(bee));
    assert.ok(size > EVENT_TAIL_MAX_BYTES, `fixture must exceed the tail-read byte cap (got ${size})`);

    const observation = (await hsrObservations()).get(bee);
    assert.equal(observation?.live, true);
    assert.equal(observation?.state, "blocked", "bounded tail read must still see the unresolved needs_input");

    const pending = await pendingNeedsInput(bee);
    assert.equal(pending?.requestId, "req-tail");
    assert.equal(pending?.kind, "permission");
    assert.equal(pending?.tool, "Bash");
  });
});

test("a turn emitting hundreds of text chunks still observes as active (HIVE-55)", async () => {
  await withTempStore(async () => {
    const bee = "long-turner";
    // One in-flight turn whose turn_start sits behind 500 text chunks — far
    // beyond the old 200-line window that misread this as "ready".
    const events: RunnerEvent[] = [
      { type: "turn_start", ts: 1 },
      ...Array.from({ length: 500 }, (_, i): RunnerEvent => ({ type: "text", ts: 2 + i, text: `chunk-${i}` })),
    ];
    await writeEvents(bee, events);
    await writeHsrMeta(bee, liveMeta(bee));

    const observation = (await hsrObservations()).get(bee);
    assert.equal(observation?.live, true);
    assert.equal(observation?.state, "active", "mid-turn bee must observe active, not ready");
  });
});

test("an unresolved needs_input buried under hundreds of events still observes as blocked (HIVE-55)", async () => {
  await withTempStore(async () => {
    const bee = "buried-needs";
    const events: RunnerEvent[] = [
      { type: "turn_start", ts: 1 },
      { type: "needs_input", ts: 2, kind: "question", question: "which?", requestId: "req-buried" },
      ...Array.from({ length: 500 }, (_, i): RunnerEvent => ({ type: "text", ts: 3 + i, text: `chunk-${i}` })),
    ];
    await writeEvents(bee, events);
    await writeHsrMeta(bee, liveMeta(bee));

    const observation = (await hsrObservations()).get(bee);
    assert.equal(observation?.state, "blocked", "unresolved needs_input must observe blocked");
    const pending = await pendingNeedsInput(bee);
    assert.equal(pending?.requestId, "req-buried");
    assert.equal(pending?.question, "which?");
  });
});

test("compaction preserves in-flight turn markers and unresolved needs_input (HIVE-55)", async () => {
  await withTempStore(async () => {
    // 1. An in-flight turn whose turn_start falls into the dropped prefix.
    const active = "compact-active";
    await writeEvents(active, [
      { type: "turn_start", ts: 1 },
      ...Array.from({ length: 50 }, (_, i): RunnerEvent => ({ type: "text", ts: 2 + i, text: `chunk-${i}` })),
    ]);
    await writeHsrMeta(active, liveMeta(active));
    await compactHsrEvents(active, { keepLines: 10, targetBytes: 10_000 });
    assert.equal((await hsrObservations()).get(active)?.state, "active", "in-flight turn must survive compaction");

    // 2. An unresolved needs_input dropped with the prefix keeps its payload.
    const blocked = "compact-blocked";
    await writeEvents(blocked, [
      { type: "turn_start", ts: 1 },
      { type: "needs_input", ts: 2, kind: "permission", question: "allow?", tool: "Bash", requestId: "req-compact" },
      ...Array.from({ length: 50 }, (_, i): RunnerEvent => ({ type: "text", ts: 3 + i, text: `chunk-${i}` })),
    ]);
    await writeHsrMeta(blocked, liveMeta(blocked));
    await compactHsrEvents(blocked, { keepLines: 10, targetBytes: 10_000 });
    assert.equal((await hsrObservations()).get(blocked)?.state, "blocked", "unresolved needs_input must survive compaction");
    const pending = await pendingNeedsInput(blocked);
    assert.equal(pending?.requestId, "req-compact");
    assert.equal(pending?.kind, "permission");
    assert.equal(pending?.tool, "Bash");
    assert.equal(pending?.question, "allow?");

    // 3. A finished turn (turn_end after turn_start, both dropped) stays idle.
    const idle = "compact-idle";
    await writeEvents(idle, [
      { type: "turn_start", ts: 1 },
      { type: "needs_input", ts: 2, kind: "question", question: "resolved?", requestId: "req-old" },
      { type: "turn_end", ts: 3 },
      ...Array.from({ length: 50 }, (_, i): RunnerEvent => ({ type: "text", ts: 4 + i, text: `chunk-${i}` })),
    ]);
    await writeHsrMeta(idle, liveMeta(idle));
    await compactHsrEvents(idle, { keepLines: 10, targetBytes: 10_000 });
    assert.equal((await hsrObservations()).get(idle)?.state, "idle_with_output", "finished turn must stay idle after compaction");
    assert.equal(await pendingNeedsInput(idle), null, "a resolved needs_input must not resurface after compaction");
  });
});

test("compaction preserves scoped root lifecycle when nested turns are newer", async () => {
  await withTempStore(async () => {
    const bee = "compact-scoped-root";
    await writeEvents(bee, [
      { type: "turn_start", ts: 1, threadId: "root-thread" },
      { type: "text", ts: 2, text: "root still working" },
      { type: "turn_start", ts: 3, threadId: "nested-thread" },
      { type: "turn_end", ts: 4, threadId: "nested-thread" },
      ...Array.from({ length: 50 }, (_, i): RunnerEvent => ({ type: "text", ts: 5 + i, text: `chunk-${i}` })),
    ]);
    await writeHsrMeta(bee, { ...liveMeta(bee), harness: "codex", tier: "server", sessionId: "root-thread" });

    await compactHsrEvents(bee, { keepLines: 10, targetBytes: 10_000 });

    assert.equal(
      (await hsrObservations()).get(bee)?.state,
      "active",
      "nested lifecycle checkpoints must not hide the root in-flight turn",
    );
    assert.ok(
      (await readLines(bee)).some((line) => line.includes('"threadId":"root-thread"')),
      "compaction must keep the dropped root lifecycle marker",
    );
  });
});
