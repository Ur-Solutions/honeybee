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
      const capabilities = (await client.call("capabilities")) as Record<string, unknown>;
      assert.deepEqual(capabilities, { ok: true, spawn: 2, spawnEnv: 1 });

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

      // Interrupting an already-idle runner is an idempotent success. The
      // structured result is preserved through host → daemon, and no fake
      // turn_end is emitted for clients to wait on.
      const idleEndCount = relayed.filter((r) => r.event.type === "turn_end").length;
      const idleInterrupt = (await client.call("interrupt", { bee })) as Record<string, unknown>;
      assert.deepEqual(idleInterrupt, {
        ok: true,
        result: { status: "already_idle" },
      });
      await sleep(30);
      assert.equal(
        relayed.filter((r) => r.event.type === "turn_end").length,
        idleEndCount,
        "idle interrupt must not synthesize a lifecycle boundary",
      );

      // A live turn reports that an interrupt was requested and then emits the
      // real turn_end boundary consumed by Apiary.
      await client.call("send", { bee, text: "hang forever" });
      await waitFor(
        () => relayed.some((r) => r.event.type === "text" && r.event.text === "hanging:hang forever"),
        "hanging turn started",
      );
      const activeInterrupt = (await client.call("interrupt", { bee })) as Record<string, unknown>;
      assert.deepEqual(activeInterrupt, {
        ok: true,
        result: { status: "interrupt_requested" },
      });
      await waitFor(
        () => relayed.filter((r) => r.event.type === "turn_end").length > idleEndCount,
        "interrupted turn ended",
      );

      await client.call("send", { bee, text: "ask me" });
      await waitFor(
        () => relayed.some((r) => r.bee === bee && r.event.type === "needs_input"),
        "relayed needs_input",
      );
      await waitFor(async () => {
        return (await client.call("pendingInput", { bee })) !== null;
      }, "pending input persisted");
      const pending = (await client.call("pendingInput", { bee })) as Record<string, unknown> | null;
      assert.ok(pending);
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

// NOTE: `spawn` now runs spawnSingleBee IN-PROCESS (no CLI shell-out). The
// happy path needs a real harness binary (resolveAgent/exec-check), which a
// store-only unit test cannot drive — verified manually via the daemon
// endpoint. The guarded error path IS exercised below: it must come back as
// { ok:false, error } over the socket, never a throw.
test("hsr control socket: spawn with an unknown kind returns ok:false", async () => {
  await withTempStore(async () => {
    const server = await startHsrControlServer();
    const client = await connectRpcClient(server.path);
    try {
      const missing = (await client.call("spawn", {})) as { ok: boolean; error?: string };
      assert.equal(missing.ok, false, "spawn without kind should be ok:false");
      const unknown = (await client.call("spawn", { kind: "definitely-not-a-harness" })) as { ok: boolean; error?: string };
      assert.equal(unknown.ok, false, "spawn with an unknown kind should be ok:false");
      assert.ok((unknown.error ?? "").length > 0, "error message expected");
    } finally {
      client.close();
      await server.close();
    }
  });
});
