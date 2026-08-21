/**
 * Spec 06 §4.2 — one-key idempotency at the RPC surface, against a REAL
 * daemon process (temp store/socket, stub agent only):
 *  - every mutation verb accepts a caller-supplied idempotencyKey; a replayed
 *    key answers with the ORIGINAL result marked `deduped: true` instead of
 *    executing twice (spawn never mints a second bee; send never enqueues a
 *    second message; registry deletes never turn into not_found on replay);
 *  - replay after settle returns the settled command status;
 *  - keys survive a daemon SIGKILL + restart (durable in the core store);
 *  - distinct keys are unaffected; a bad key is a typed invalid_request.
 *
 * SAFETY: temp dirs only; never ~/.hive, never the live daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  CommandsResult,
  ListResult,
  MailboxResult,
  MutationResult,
  SendRpcResult,
  SpawnResult,
  TemplateDeleteResult,
  TemplatePutResult,
  ViewResult,
} from "../src/protocol.ts";
import { RpcError } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const TEMPLATE_FIELDS = {
  name: "idem-demo",
  scope: "personal",
  agent: "stub",
  prompt: "do the thing",
};

test("idem-rpc.1: spawn replay returns the original bee/command — one bee, marked deduped", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const first = await client.request<SpawnResult>("spawn", {
      name: "worker",
      agent: "stub",
      cwd: "/tmp",
      idempotencyKey: "spawn-1",
    });
    assert.equal(first.deduped, undefined);
    const replay = await client.request<SpawnResult>("spawn", {
      name: "worker",
      agent: "stub",
      cwd: "/tmp",
      idempotencyKey: "spawn-1",
    });
    assert.equal(replay.deduped, true);
    assert.equal(replay.beeId, first.beeId);
    assert.equal(replay.commandId, first.commandId);
    const { views } = await client.request<ListResult>("list");
    assert.equal(views.length, 1, "no second bee minted");

    // Replay AFTER the spawn command settles → the settled status comes back.
    await waitFor(async () => {
      const { commands } = await client.request<CommandsResult>("commands", { beeId: first.beeId });
      return commands.find((c) => c.id === first.commandId)?.status === "done";
    }, "spawn command settled");
    const settled = await client.request<SpawnResult>("spawn", {
      name: "worker",
      agent: "stub",
      cwd: "/tmp",
      idempotencyKey: "spawn-1",
    });
    assert.equal(settled.deduped, true);
    assert.equal(settled.status, "done");
    assert.equal(settled.beeId, first.beeId);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("idem-rpc.1b: spawn atomically admits its first message and replays one receipt", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const first = await client.request<SpawnResult>("spawn", {
      name: "briefed-worker",
      agent: "stub",
      cwd: "/tmp",
      prompt: "hello exactly once",
      idempotencyKey: "spawn-with-message-1",
    });
    assert.equal(typeof first.messageId, "number");
    const replay = await client.request<SpawnResult>("spawn", {
      name: "briefed-worker",
      agent: "stub",
      cwd: "/tmp",
      prompt: "hello exactly once",
      idempotencyKey: "spawn-with-message-1",
    });
    assert.equal(replay.deduped, true);
    assert.equal(replay.beeId, first.beeId);
    assert.equal(replay.commandId, first.commandId);
    assert.equal(replay.messageId, first.messageId);
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId: first.beeId });
    assert.equal(messages.filter((message) => message.body === "hello exactly once").length, 1);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("idem-rpc.2: send replay returns the original message — mailbox has exactly one row", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "worker", agent: "stub", cwd: "/tmp" });
    const first = await client.request<SendRpcResult>("send", {
      beeId: spawned.beeId,
      body: "hello once",
      idempotencyKey: "send-1",
    });
    const replay = await client.request<SendRpcResult>("send", {
      beeId: spawned.beeId,
      body: "hello once",
      idempotencyKey: "send-1",
    });
    assert.equal(replay.deduped, true);
    assert.equal(replay.messageId, first.messageId);
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId: spawned.beeId });
    assert.equal(messages.filter((m) => m.body === "hello once").length, 1);

    // A DIFFERENT key is a fresh send.
    const other = await client.request<SendRpcResult>("send", {
      beeId: spawned.beeId,
      body: "hello twice",
      idempotencyKey: "send-2",
    });
    assert.notEqual(other.messageId, first.messageId);
    assert.equal(other.deduped, undefined);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("idem-rpc.3: stop replay dedups (queued and settled); bad keys are typed invalid_request", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "worker", agent: "stub", cwd: "/tmp" });
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return v.view.runtimeState === "idle";
    }, "worker idle");
    const first = await client.request<MutationResult>("stop", { beeId: spawned.beeId, idempotencyKey: "stop-1" });
    const replay = await client.request<MutationResult>("stop", { beeId: spawned.beeId, idempotencyKey: "stop-1" });
    assert.equal(replay.deduped, true);
    assert.equal(replay.commandId, first.commandId);
    await waitFor(async () => {
      const { commands } = await client.request<CommandsResult>("commands", { beeId: spawned.beeId });
      return commands.find((c) => c.id === first.commandId)?.status === "done";
    }, "stop settled");
    const settled = await client.request<MutationResult>("stop", { beeId: spawned.beeId, idempotencyKey: "stop-1" });
    assert.equal(settled.deduped, true);
    assert.equal(settled.status, "done");

    await assert.rejects(
      client.request("stop", { beeId: spawned.beeId, idempotencyKey: "" }),
      (err: unknown) => err instanceof RpcError && err.code === "invalid_request",
    );
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("idem-rpc.4: keys survive a daemon SIGKILL + restart — replay still answers with the original", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    let client = await daemon.client();
    const first = await client.request<SpawnResult>("spawn", {
      name: "worker",
      agent: "stub",
      cwd: "/tmp",
      idempotencyKey: "spawn-boot",
    });
    const sent = await client.request<SendRpcResult>("send", {
      beeId: first.beeId,
      body: "before the crash",
      idempotencyKey: "send-boot",
    });
    client.close();
    await daemon.kill(); // SIGKILL: no graceful teardown

    daemon = await startDaemon(dir);
    client = await daemon.client();
    const spawnReplay = await client.request<SpawnResult>("spawn", {
      name: "worker",
      agent: "stub",
      cwd: "/tmp",
      idempotencyKey: "spawn-boot",
    });
    assert.equal(spawnReplay.deduped, true);
    assert.equal(spawnReplay.beeId, first.beeId);
    const sendReplay = await client.request<SendRpcResult>("send", {
      beeId: first.beeId,
      body: "before the crash",
      idempotencyKey: "send-boot",
    });
    assert.equal(sendReplay.deduped, true);
    assert.equal(sendReplay.messageId, sent.messageId);
    const { views } = await client.request<ListResult>("list");
    assert.equal(views.length, 1);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

test("idem-rpc.5: registry verbs dedup — template.put replays its outcome; delete replay never not_found", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const first = await client.request<TemplatePutResult>("template.put", {
      fields: TEMPLATE_FIELDS,
      idempotencyKey: "tpl-put-1",
    });
    assert.equal(first.outcome, "created");
    const replay = await client.request<TemplatePutResult>("template.put", {
      fields: TEMPLATE_FIELDS,
      idempotencyKey: "tpl-put-1",
    });
    assert.equal(replay.deduped, true);
    assert.equal(replay.outcome, "created"); // the ORIGINAL outcome, not "unchanged"
    assert.equal(replay.template.id, first.template.id);

    const del = await client.request<TemplateDeleteResult>("template.delete", {
      id: first.template.id,
      idempotencyKey: "tpl-del-1",
    });
    assert.equal(del.template.id, first.template.id);
    // Replay after the row is gone: recorded result, NOT template_not_found.
    const delReplay = await client.request<TemplateDeleteResult>("template.delete", {
      id: first.template.id,
      idempotencyKey: "tpl-del-1",
    });
    assert.equal(delReplay.deduped, true);
    assert.equal(delReplay.template.id, first.template.id);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
  }
});
