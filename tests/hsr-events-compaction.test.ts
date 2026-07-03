/**
 * HIVE-13: events.jsonl must stay bounded and cheap to observe.
 *
 *   - compactHsrEvents folds the dropped prefix into checkpoint events so
 *     cumulative usage totals and the exhaustion edge survive compaction.
 *   - appendHsrEvent auto-compacts once the log crosses HSR_EVENTS_MAX_BYTES.
 *   - readEventTail (via hsrObservations/pendingNeedsInput) reads only the
 *     trailing bytes, so a huge legacy log still observes correctly.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hsrObservations, hsrUsageObservation, pendingNeedsInput } from "../src/hsr/observe.js";
import {
  HSR_EVENTS_MAX_BYTES,
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
    // usage checkpoint + exhausted checkpoint + the 4 kept tail lines.
    assert.equal(lines.length, 6);
    assert.deepEqual(JSON.parse(lines[0]!), { type: "usage", ts: 2, inputTokens: 150, outputTokens: 15, totalTokens: 165 });
    assert.deepEqual(JSON.parse(lines[1]!), { type: "exhausted", ts: 3, resetHint: "R1" });
    assert.deepEqual(lines.slice(2), before.slice(-4), "kept tail must be preserved verbatim");

    // The cumulative usage observation is EXACTLY what it was pre-compaction.
    const usage = await hsrUsageObservation(bee);
    assert.deepEqual(usage.totals, { inputTokens: 150, outputTokens: 15 });
    assert.deepEqual(usage.latestExhausted, { ts: 3, resetHint: "R1" });

    // The unresolved needs_input in the kept tail still observes: blocked + pending.
    const observation = (await hsrObservations()).get(bee);
    assert.equal(observation?.live, true);
    assert.equal(observation?.state, "blocked");
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

test("observers read only the tail of a huge legacy log and still derive state", async () => {
  await withTempStore(async () => {
    const bee = "tail-reader";
    // > 256 KiB of prefix noise (a legacy log no writer ever compacted), with
    // the story that matters — an unresolved needs_input — at the very end.
    const padding = "y".repeat(120);
    const events: RunnerEvent[] = [
      { type: "usage", ts: 0, inputTokens: 1, outputTokens: 1 },
      ...Array.from({ length: 3_000 }, (_, i): RunnerEvent => ({ type: "text", ts: i, text: padding })),
      { type: "turn_start", ts: 9_000 },
      { type: "needs_input", ts: 9_001, kind: "permission", question: "allow?", tool: "Bash", requestId: "req-tail" },
    ];
    await writeEvents(bee, events);
    await writeHsrMeta(bee, liveMeta(bee));
    const { size } = await stat(hsrEventsPath(bee));
    assert.ok(size > 256 * 1024, `fixture must exceed the tail-read byte cap (got ${size})`);

    const observation = (await hsrObservations()).get(bee);
    assert.equal(observation?.live, true);
    assert.equal(observation?.state, "blocked", "bounded tail read must still see the unresolved needs_input");

    const pending = await pendingNeedsInput(bee);
    assert.equal(pending?.requestId, "req-tail");
    assert.equal(pending?.kind, "permission");
    assert.equal(pending?.tool, "Bash");
  });
});
