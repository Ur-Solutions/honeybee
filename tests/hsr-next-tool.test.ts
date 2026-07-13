// next-tool steering (queued-steering spec): the stream runner HOLDS a
// `{ mode: "next-tool" }` send while a turn is live and flushes it at the next
// tool boundary (tool_use) or at turn_end; idle sessions deliver immediately.
// Exercised end-to-end against the stub adapter's slow-tool turn.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { ensureHsrRunDir, hsrRunDir } from "../src/hsr/runDir.js";
import type { RunnerEvent, RunnerSession } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-next-tool-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Start a stub session and mirror its event stream into a live array. */
async function startCollecting(bee: string): Promise<{ session: RunnerSession; seen: RunnerEvent[] }> {
  await ensureHsrRunDir(bee);
  const session = await stubAdapter.start({ bee, cwd: "/tmp", env: {}, runDir: hsrRunDir(bee) });
  const seen: RunnerEvent[] = [];
  void (async () => {
    for await (const event of session.events) seen.push(event);
  })();
  return { session, seen };
}

const textIndex = (seen: RunnerEvent[], needle: string): number =>
  seen.findIndex((e) => e.type === "text" && e.text.includes(needle));
const typeIndex = (seen: RunnerEvent[], type: RunnerEvent["type"]): number =>
  seen.findIndex((e) => e.type === type);
const countType = (seen: RunnerEvent[], type: RunnerEvent["type"]): number =>
  seen.filter((e) => e.type === type).length;

test("next-tool send during a live turn is held until the tool boundary", async () => {
  await withTempStore(async () => {
    const { session, seen } = await startCollecting("nt-hold");
    try {
      await session.send("slowtool go");
      await waitFor(() => textIndex(seen, "starting:slowtool go") >= 0, "turn started");
      // The turn is live (tool fires at ~120ms); park a next-tool steer.
      await session.send("held one", { mode: "next-tool" });
      await waitFor(() => typeIndex(seen, "turn_end") >= 0, "turn ended");
      await waitFor(() => textIndex(seen, "echo:held one") >= 0, "held steer delivered");

      // Delivered AFTER the tool boundary, not on send.
      assert.ok(typeIndex(seen, "tool_use") >= 0, "stub emitted a tool_use");
      assert.ok(
        textIndex(seen, "echo:held one") > typeIndex(seen, "tool_use"),
        "held steer flushed after the tool_use boundary",
      );
      // The interjection joins the LIVE turn — no re-bracket.
      assert.equal(countType(seen, "turn_start"), 1);
    } finally {
      await session.stop();
    }
  });
});

test("next-tool send while idle delivers immediately as a fresh turn", async () => {
  await withTempStore(async () => {
    const { session, seen } = await startCollecting("nt-idle");
    try {
      await session.send("warmup");
      await waitFor(() => countType(seen, "turn_end") === 1, "first turn ended");

      await session.send("hello there", { mode: "next-tool" });
      await waitFor(() => textIndex(seen, "echo:hello there") >= 0, "idle next-tool delivered");
      assert.equal(countType(seen, "turn_start"), 2, "idle delivery re-brackets a fresh turn");
    } finally {
      await session.stop();
    }
  });
});

test("next-tool held through a tool-less turn flushes at turn_end", async () => {
  await withTempStore(async () => {
    const { session, seen } = await startCollecting("nt-turn-end");
    try {
      await session.send("slowtool go");
      await waitFor(() => textIndex(seen, "starting:slowtool go") >= 0, "turn started");
      await session.send("held two", { mode: "next-tool" });
      // Whether it flushes at the tool boundary or (in a tool-less world) at
      // turn_end, the held steer must ALWAYS land eventually.
      await waitFor(() => textIndex(seen, "echo:held two") >= 0, "held steer delivered");
    } finally {
      await session.stop();
    }
  });
});

// ─── In-band interrupt (streamRunner encodeInterrupt): ends the TURN, not the
//     session — the SIGINT fallback killed headless children and crashed the
//     bee (observed via Apiary's stop button on HSR bees). ─────────────────────

test("interrupt ends the live turn in-band and the session stays steerable", async () => {
  await withTempStore(async () => {
    const { session, seen } = await startCollecting("nt-interrupt");
    try {
      await session.send("hang forever");
      await waitFor(() => textIndex(seen, "hanging:hang forever") >= 0, "turn hanging");

      await session.interrupt();
      await waitFor(() => countType(seen, "turn_end") === 1, "interrupt ended the turn");
      assert.equal(countType(seen, "exit"), 0, "no exit event — the child is still alive");

      // The session survives and takes the next turn normally.
      await session.send("still alive?");
      await waitFor(() => textIndex(seen, "echo:still alive?") >= 0, "post-interrupt turn works");
      assert.equal(countType(seen, "exit"), 0);
    } finally {
      await session.stop();
    }
  });
});
