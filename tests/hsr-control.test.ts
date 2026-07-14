import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrRunDir } from "../src/hsr/runDir.js";
import { startHsrControlServer } from "../src/daemon/hsrControl.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-control-"));
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

function optsFor(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

test("hsr-control: liveness/list/observe-relay/send across the aggregate endpoint", async () => {
  await withTempStore(async () => {
    const bee = "ctltest";
    const server = await startHsrControlServer();
    const host = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee) });
    const client = await connectRpcClient(server.path);
    // Relayed bee events arrive as `hsr.event` { bee, event }.
    const relayed: Array<{ bee: string; event: RunnerEvent }> = [];
    client.on("hsr.event", (p) => relayed.push(p as { bee: string; event: RunnerEvent }));

    try {
      // liveness() includes the live bee.
      const liveness = (await client.call("liveness")) as Record<string, boolean>;
      assert.equal(liveness[bee], true, "liveness should show the bee alive");

      // list() carries the bee's tier / sessionId / controlSocket.
      await waitFor(async () => {
        const rows = (await client.call("list")) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r.bee === bee);
        return !!row && row.sessionId === "stub-session";
      }, "list() shows learned sessionId");
      const rows = (await client.call("list")) as Array<Record<string, unknown>>;
      const row = rows.find((r) => r.bee === bee)!;
      assert.equal(row.live, true);
      assert.equal(row.tier, "stream");
      assert.equal(row.status, "running");
      assert.equal(typeof row.controlSocket, "string");
      assert.ok((row.controlSocket as string).length > 0, "controlSocket path present");

      // observe() then send() → the client receives the relayed text + turn_end.
      const observe = (await client.call("observe", { bee })) as { ok: boolean };
      assert.equal(observe.ok, true, "observe should succeed");

      const send = (await client.call("send", { bee, text: "hello" })) as { ok: boolean };
      assert.equal(send.ok, true, "send should succeed");

      await waitFor(
        () => relayed.some((r) => r.bee === bee && r.event.type === "text" && r.event.text === "echo:hello"),
        "relayed hsr.event text echo:hello",
      );
      await waitFor(
        () => relayed.some((r) => r.bee === bee && r.event.type === "turn_end"),
        "relayed hsr.event turn_end",
      );

      await client.call("send", { bee, text: "ask me" });
      await waitFor(
        () => relayed.some((r) => r.bee === bee && r.event.type === "needs_input"),
        "relayed needs_input",
      );
      const pending = (await client.call("pendingInput", { bee })) as Record<string, unknown>;
      assert.equal(pending.requestId, "r1");
      assert.equal(pending.question, "proceed?");
      assert.equal(pending.kind, "question");
      assert.equal((await client.call("answer", { bee, requestId: "r1", answer: "yes" }) as { ok: boolean }).ok, true);

      // send to a non-existent bee → { ok:false } (no throw).
      const bad = (await client.call("send", { bee: "nope", text: "x" })) as { ok: boolean };
      assert.equal(bad.ok, false, "send to unknown bee should be ok:false");

      // After stopping the host, liveness flips to false.
      await host.stop();
      const after = (await client.call("liveness")) as Record<string, boolean>;
      assert.equal(after[bee], false, "liveness should show the bee not alive after stop");
    } finally {
      client.close();
      await host.stop().catch(() => undefined);
      await server.close();
    }
  });
});

// NOTE: `spawn` is intentionally not exercised here — it shells out to the real
// `hive spawn` CLI (resolveAgent/account activation), which a store-only unit
// test cannot drive. Verified manually via the daemon endpoint against a real
// harness.
