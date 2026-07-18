import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrLiveness, reapDeadHosts } from "../src/hsr/observe.js";
import {
  ensureHsrRunDir,
  hsrControlSocketPath,
  hsrEventsPath,
  hsrRingPath,
  hsrRunDir,
  readHsrMeta,
  writeHsrMeta,
} from "../src/hsr/runDir.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-host-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Poll `cond` on a short interval until true, or throw after `timeoutMs`. */
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function readEventLog(bee: string): Promise<RunnerEvent[]> {
  let raw: string;
  try {
    raw = await readFile(hsrEventsPath(bee), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunnerEvent);
}

function optsFor(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

test("runner-host: spawn+turn, sessionId, needs_input, snapshot, liveness, stop", async () => {
  await withTempStore(async () => {
    const bee = "betatest";
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee) });
    const client = await connectRpcClient(handle.controlSocket);
    const events: RunnerEvent[] = [];
    client.on("event", (p) => events.push(p as RunnerEvent));

    try {
      // 1. spawn + turn: a text echo and a following turn_end, over the socket.
      await client.call("send", { text: "hello" });
      await waitFor(
        () => events.some((e) => e.type === "text" && e.text === "echo:hello"),
        "text echo:hello broadcast",
      );
      await waitFor(() => events.some((e) => e.type === "turn_end"), "turn_end broadcast");

      // events.jsonl contains them (runner is the sole writer).
      await waitFor(async () => {
        const log = await readEventLog(bee);
        return (
          log.some((e) => e.type === "text" && e.text === "echo:hello") &&
          log.some((e) => e.type === "turn_end")
        );
      }, "events.jsonl has echo:hello + turn_end");

      // ring.txt contains the echoed output (written after a short debounce).
      await waitFor(async () => {
        try {
          return (await readFile(hsrRingPath(bee), "utf8")).includes("echo:hello");
        } catch {
          return false;
        }
      }, "ring.txt has echo:hello");

      // 2. sessionId learned into meta.json (the stub's fixed id).
      await waitFor(async () => {
        const meta = await readHsrMeta(bee);
        return meta?.sessionId === "stub-session";
      }, "meta.sessionId learned");

      // 3. needs_input round-trip.
      const beforeAsk = events.length;
      await client.call("send", { text: "ask me" });
      await waitFor(
        () => events.slice(beforeAsk).some((e) => e.type === "needs_input" && e.requestId === "r1"),
        "needs_input r1",
      );
      const needs = events.slice().reverse().find((event) => event.type === "needs_input") as Extract<RunnerEvent, { type: "needs_input" }>;
      assert.deepEqual(await client.call("pendingInput"), {
        requestId: "r1",
        ts: needs.ts,
        kind: "question",
        question: "proceed?",
      });
      const beforeAnswer = events.length;
      await client.call("answer", { requestId: "r1", answer: "yes" });
      await waitFor(
        () => events.slice(beforeAnswer).some((e) => e.type === "text" && e.text === "answered:yes"),
        "answered:yes text",
      );

      // The host preserves OpenCode's native multi-question matrix over RPC;
      // legacy string-only adapters receive its JSON compatibility form.
      const beforeStructuredAsk = events.length;
      await client.call("send", { text: "ask structured" });
      await waitFor(
        () => events.slice(beforeStructuredAsk).some((e) => e.type === "needs_input" && e.requestId === "r1"),
        "structured needs_input r1",
      );
      const beforeStructuredAnswer = events.length;
      await client.call("answer", { requestId: "r1", answer: [["core", "cli"], ["safe"]] });
      await waitFor(
        () => events.slice(beforeStructuredAnswer).some(
          (e) => e.type === "text" && e.text === 'answered:[["core","cli"],["safe"]]',
        ),
        "structured answer preserved over host RPC",
      );

      // 4. snapshot returns the echoed output tail.
      const snap = (await client.call("snapshot", { lines: 5 })) as string;
      assert.match(snap, /echo:hello/);

      // 5. liveness + stop.
      const liveBefore = await hsrLiveness();
      assert.equal(liveBefore.get(bee), true, "bee should be alive before stop");

      await client.call("stop");
      await handle.done;

      const liveAfter = await hsrLiveness();
      assert.equal(liveAfter.get(bee), false, "bee should not be alive after stop");

      const meta = await readHsrMeta(bee);
      assert.equal(meta?.status, "exited");
      assert.ok(meta?.endedAt, "meta.endedAt should be set");
    } finally {
      client.close();
      await handle.stop().catch(() => undefined);
    }
  });
});

test("reapDeadHosts: stale running meta with a dead host pid flips to exited", async () => {
  await withTempStore(async () => {
    const bee = "ghost";
    await ensureHsrRunDir(bee);
    // A pid that cannot exist — INT32_MAX. Host is "running" but dead.
    const deadPid = 2 ** 31 - 1;
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: deadPid,
      startedAt: new Date().toISOString(),
      controlSocket: hsrControlSocketPath(bee),
      status: "running",
    });

    const live = await hsrLiveness();
    assert.equal(live.get(bee), false, "dead host should read as not alive");

    const reaped = await reapDeadHosts();
    assert.deepEqual(reaped, [bee]);

    const meta = await readHsrMeta(bee);
    assert.equal(meta?.status, "exited");
    assert.ok(meta?.endedAt, "reaped meta.endedAt should be set");

    // Idempotent: a second reap finds nothing to do.
    assert.deepEqual(await reapDeadHosts(), []);
  });
});
