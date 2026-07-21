// enqueueTurnForBootingHsrHost — the no-wait spawn's first-prompt path.
// spawnBee returns before the detached host cold-starts, so the first turn is
// persisted against the forked host PID before meta.json exists and must be
// drained by the host's queued→running transition.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { enqueueTurnForBootingHsrHost } from "../src/hsr/pendingTurns.js";
import { hsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import type { RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-pending-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function optsFor(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

/** A PID that is certainly not alive (past kernel pid ranges on macOS/Linux). */
const DEAD_PID = 2 ** 30;

test("enqueueTurnForBootingHsrHost: persists a turn before meta exists when the host pid is alive", async () => {
  await withTempStore(async () => {
    const bee = "preboot";
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), true);
    const files = await readdir(join(hsrRunDir(bee), "pending-turns"));
    assert.equal(files.filter((name) => name.endsWith(".json")).length, 1);
  });
});

test("enqueueTurnForBootingHsrHost: refuses when the host pid is dead or missing", async () => {
  await withTempStore(async () => {
    assert.equal(await enqueueTurnForBootingHsrHost("deadhost", DEAD_PID, "hello"), false);
    assert.equal(await enqueueTurnForBootingHsrHost("nohost", undefined, "hello"), false);
  });
});

test("enqueueTurnForBootingHsrHost: refuses on a running or exited meta (caller uses the live path)", async () => {
  await withTempStore(async () => {
    const bee = "poststartup";
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "running",
    });
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), false);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "exited",
      exitCode: 0,
      endedAt: new Date().toISOString(),
    });
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), false);
  });
});

test("enqueueTurnForBootingHsrHost: accepts against a queued meta with a live host", async () => {
  await withTempStore(async () => {
    const bee = "queuedhost";
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "queued",
    });
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), true);
    // ...but not when the recorded host pid is dead (crashed pre-drain).
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: DEAD_PID,
      startedAt: new Date().toISOString(),
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "queued",
    });
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), false);
  });
});

test("a turn enqueued before host boot is drained into the harness at queued→running", async () => {
  await withTempStore(async () => {
    const bee = "drainer";
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello-from-before-boot"), true);
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee), queueStartup: true });
    try {
      const sub = hsrSubstrate();
      await waitFor(
        async () => (await sub.capture(bee, 50)).includes("echo:hello-from-before-boot"),
        "pre-boot turn echoed by the harness",
      );
      const files = await readdir(join(hsrRunDir(bee), "pending-turns")).catch(() => [] as string[]);
      assert.equal(files.filter((name) => name.endsWith(".json")).length, 0);
    } finally {
      await handle.stop();
    }
  });
});
