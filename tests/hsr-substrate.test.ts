import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrRunDir, readHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import type { RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-sub-"));
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

test("SubstrateHsr: hasSession/capture/sendText/listSessions/kill against a stub host", async () => {
  await withTempStore(async () => {
    const bee = "subtest";
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee) });
    const sub = hsrSubstrate();

    try {
      // Static shape: kind/node/probe and the pane-less no-ops.
      assert.equal(sub.kind, "hsr");
      assert.deepEqual(await sub.probe(), { ok: true });
      assert.equal((await sub.listPanes()).size, 0);
      assert.equal((await sub.listSessionStates()).size, 0);
      assert.deepEqual(sub.attachCommand(bee), []);

      // hasSession + listSessions see the live runner host.
      assert.equal(await sub.hasSession(bee), true, "live host should report hasSession");
      assert.ok((await sub.listSessions()).includes(bee), "listSessions should include the bee");

      // sendText delivers a turn over the control socket; the ring buffer grows.
      await sub.sendText(bee, "hello");
      await waitFor(async () => (await sub.capture(bee)).includes("echo:hello"), "capture shows echo:hello");
      const tail = await sub.capture(bee, 5);
      assert.match(tail, /echo:hello/);

      // sendText to a bee with no host throws a clear error.
      await assert.rejects(() => sub.sendText("nope-no-host", "hi"), /no live runner host/);

      // kill stops the host cleanly (no self-SIGTERM in-process) and the bee goes away.
      const result = await sub.kill(bee);
      assert.equal(result.ok, true);
      await handle.done;
      await waitFor(async () => (await sub.hasSession(bee)) === false, "hasSession false after kill");
      const meta = await readHsrMeta(bee);
      assert.equal(meta?.status, "exited");

      // kill on an already-dead bee is a no-op success (never throws).
      const again = await sub.kill(bee);
      assert.equal(again.ok, true);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
