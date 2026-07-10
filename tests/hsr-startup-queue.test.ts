import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LockBusyError } from "../src/fsx.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { runHsrHost, type HsrHostHandle } from "../src/hsr/host.js";
import { hsrObservations } from "../src/hsr/observe.js";
import { hsrRunDir, readHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import type { RunnerAdapter, RunnerOpts } from "../src/hsr/types.js";
import { withCodexStartupSlot } from "../src/hsr/startupQueue.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function optsFor(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

test("Codex HSR cold starts queue visibly and admit only the configured concurrency", async () => {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const previousConcurrency = process.env.HIVE_CODEX_START_CONCURRENCY;
  const root = await mkdtemp(join(tmpdir(), "honeybee-hsr-startup-queue-"));
  process.env.HIVE_STORE_ROOT = root;
  process.env.HIVE_CODEX_START_CONCURRENCY = "1";

  const releaseFirstStart = deferred();
  let firstStarts = 0;
  let secondStarts = 0;
  const adapter = (onStart: () => Promise<void>, count: () => void): RunnerAdapter => ({
    harness: "codex",
    tier: () => "server",
    async start(opts) {
      count();
      await onStart();
      return stubAdapter.start(opts);
    },
  });

  let firstHandle: HsrHostHandle | undefined;
  let secondHandle: HsrHostHandle | undefined;
  try {
    const first = runHsrHost({
      bee: "queued-one",
      adapter: adapter(() => releaseFirstStart.promise, () => { firstStarts += 1; }),
      opts: optsFor("queued-one"),
      queueStartup: true,
    });
    await waitFor(async () => (await readHsrMeta("queued-one"))?.status === "queued", "first queued meta");
    assert.equal(firstStarts, 1, "first host owns the only startup slot");

    const second = runHsrHost({
      bee: "queued-two",
      adapter: adapter(async () => undefined, () => { secondStarts += 1; }),
      opts: optsFor("queued-two"),
      queueStartup: true,
    });
    await waitFor(async () => (await readHsrMeta("queued-two"))?.status === "queued", "second queued meta");
    await sleep(150);
    assert.equal(secondStarts, 0, "second app-server start waits behind the slot");

    const observations = await hsrObservations();
    assert.equal(observations.get("queued-one")?.live, true);
    assert.equal(observations.get("queued-one")?.state, "queued");
    assert.equal(observations.get("queued-two")?.live, true);
    assert.equal(observations.get("queued-two")?.state, "queued");

    // Fire-and-forget prompt delivery persists while queued; it must return
    // before admission and appear once the second host becomes live.
    await hsrSubstrate().sendText("queued-two", "hello from the queue");

    releaseFirstStart.resolve();
    firstHandle = await first;
    await waitFor(() => secondStarts === 1, "second admitted after first startup");
    secondHandle = await second;
    assert.equal((await readHsrMeta("queued-one"))?.status, "running");
    assert.equal((await readHsrMeta("queued-two"))?.status, "running");
    await waitFor(
      async () => (await hsrSubstrate().capture("queued-two")).includes("echo:hello from the queue"),
      "queued prompt drained after admission",
    );
  } finally {
    await secondHandle?.stop().catch(() => undefined);
    await firstHandle?.stop().catch(() => undefined);
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    if (previousConcurrency === undefined) delete process.env.HIVE_CODEX_START_CONCURRENCY;
    else process.env.HIVE_CODEX_START_CONCURRENCY = previousConcurrency;
    await rm(root, { recursive: true, force: true });
  }
});

test("the startup gate never mistakes an adapter LockBusyError for a busy queue slot", async () => {
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const previousConcurrency = process.env.HIVE_CODEX_START_CONCURRENCY;
  const root = await mkdtemp(join(tmpdir(), "honeybee-hsr-startup-error-"));
  process.env.HIVE_STORE_ROOT = root;
  process.env.HIVE_CODEX_START_CONCURRENCY = "1";
  let attempts = 0;
  try {
    await assert.rejects(
      withCodexStartupSlot("adapter-error", async () => {
        attempts += 1;
        throw new LockBusyError("adapter-owned lock is busy", null);
      }),
      /adapter-owned lock is busy/,
    );
    assert.equal(attempts, 1, "adapter failures propagate without a hidden restart");
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    if (previousConcurrency === undefined) delete process.env.HIVE_CODEX_START_CONCURRENCY;
    else process.env.HIVE_CODEX_START_CONCURRENCY = previousConcurrency;
    await rm(root, { recursive: true, force: true });
  }
});
