import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrRunDir } from "../src/hsr/runDir.js";
import { acceptHsrMessage, startHsrControlServer } from "../src/daemon/hsrControl.js";
import { generateMessageId, listMessages } from "../src/buz.js";
import { readBeeRequests } from "../src/requests/store.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
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
      assert.deepEqual(capabilities, {
        ok: true,
        spawn: 2,
        spawnEnv: 1,
        spawnParent: 1,
        message: 1,
        broker: 1,
        fork: 1,
        handoff: 1,
        execution: 1,
        executionAdmin: 1,
      });

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
      const spoofedFlag = (await client.call("spawn", {
        kind: "definitely-not-a-harness",
        flags: { "spawned-by": "untrusted-parent" },
      })) as { ok: boolean; error?: string };
      assert.equal(spoofedFlag.ok, false);
      assert.doesNotMatch(spoofedFlag.error ?? "", /Unknown spawning bee/, "generic flags cannot enter the trusted parent seam");
      const unknownParent = (await client.call("spawn", {
        kind: "definitely-not-a-harness",
        spawnedById: "missing-parent",
      })) as { ok: boolean; error?: string };
      assert.equal(unknownParent.ok, false);
      assert.match(unknownParent.error ?? "", /Unknown spawning bee/, "top-level parent is validated before spawn");
      const unknown = (await client.call("spawn", { kind: "definitely-not-a-harness" })) as { ok: boolean; error?: string };
      assert.equal(unknown.ok, false, "spawn with an unknown kind should be ok:false");
      assert.ok((unknown.error ?? "").length > 0, "error message expected");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("hsr-control message durably accepts a cold idle bee and rejects an archived bee", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const cold: SessionRecord = {
      name: "cold-idle",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "cold-idle",
      substrate: "hsr",
      createdAt: now,
      updatedAt: now,
      status: "dead",
      providerSessionId: "provider-thread-cold-idle",
    };
    const archived: SessionRecord = { ...cold, name: "archived", tmuxTarget: "archived", status: "done" };
    await saveSession(cold);
    await saveSession(archived);

    const accepted = await acceptHsrMessage({
      bee: cold.name,
      text: "continue from here",
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.delivery, "queued");
    assert.equal(typeof accepted.messageId, "string");
    const queued = await listMessages(cold.name, "queue");
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.message.body, "continue from here");
    const recovering = (await loadSession(cold.name))!;
    assert.equal(recovering.status, "dead", "acceptance does not fabricate runtime lifecycle status");
    assert.equal(recovering.lastObservedState, undefined, "acceptance does not fabricate a daemon observation");
    assert.equal(recovering.recoveryMessageId, accepted.messageId);
    assert.equal(typeof recovering.recoveryRequestedAt, "string");

    const refused = await acceptHsrMessage({
      bee: archived.name,
      text: "do not revive archived work",
    });
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /archived/);
    assert.equal((await listMessages(archived.name, "queue")).length, 0);
  });
});

test("hsr-control message reports missing cwd as durable UNDELIVERABLE needs-action", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "missing-cwd-message",
      agent: "codex",
      cwd: join(tmpdir(), "definitely-missing-hsr-message-cwd-71f23a"),
      command: "codex",
      tmuxTarget: "missing-cwd-message",
      substrate: "hsr",
      providerSessionId: "thread-missing-cwd",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);

    const result = await acceptHsrMessage({ bee: record.name, text: "please continue" });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.outcome, "UNDELIVERABLE");
    assert.equal(result.delivery, "undeliverable");
    assert.equal((await listMessages(record.name, "queue")).length, 1, "persist-first keeps the exact message queued");
    assert.equal((await loadSession(record.name))?.recoveryRequestedAt, undefined, "doomed work is explicitly failed, not left in the hot set");
    const request = (await readBeeRequests(record.name))[0]!;
    assert.equal(request.kind, "manual-action");
    assert.equal(request.scope, "bee");
    assert.equal(request.evidence.detail, "missing-cwd");
    assert.match(request.question ?? "", /Restore or recreate the working copy/);
  });
});

test("hsr-control message skips missing providerSessionId into needs-action without a wake loop", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "missing-provider-message",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "missing-provider-message",
      substrate: "hsr",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);
    const result = await acceptHsrMessage({ bee: record.name, text: "resume this" });
    assert.equal(result.outcome, "UNDELIVERABLE");
    assert.equal((await readBeeRequests(record.name))[0]?.evidence.detail, "missing-provider-session");
    assert.equal((await loadSession(record.name))?.recoveryRequestedAt, undefined);
  });
});

test("hsr-control messageId makes client retries idempotent", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "idempotent-message",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "idempotent-message",
      substrate: "hsr",
      providerSessionId: "thread-idempotent",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);
    const messageId = generateMessageId();
    const first = await acceptHsrMessage({ bee: record.name, text: "same operation", messageId });
    const retry = await acceptHsrMessage({ bee: record.name, text: "same operation", messageId });
    assert.equal(first.messageId, messageId);
    assert.equal(retry.messageId, messageId);
    assert.equal(retry.idempotent, true);
    assert.equal((await listMessages(record.name, "queue")).length, 1);

    const collision = await acceptHsrMessage({ bee: record.name, text: "different operation", messageId });
    assert.equal(collision.ok, false);
    assert.match(String(collision.error), /different payload/);
    assert.equal((await listMessages(record.name, "queue")).length, 1);
  });
});
