import assert from "node:assert/strict";
import { test } from "node:test";
import { openCoreStore } from "../../core/src/index.ts";
import {
  RpcError,
  type DeployInfoResult,
  type MailHistoryResult,
  type MailPendingResult,
} from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

test("rpc.mail.history exposes capped, snapshot-stable backward pages and canceled mail", async () => {
  const rig = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const store = openCoreStore(`${rig.dir}/core.sqlite3`, { ephemeral: true });
    const created = store.createBee({
      name: "rpc-history",
      agent: "stub",
      substrate: "hsr",
      cwd: rig.dir,
    });
    const sentIds: number[] = [];
    for (let i = 0; i < 251; i += 1) {
      sentIds.push(store.send(created.bee.id, `history ${i}`).message.id);
    }
    assert.deepEqual(store.cancelMessage(created.bee.id, sentIds[0]!), { canceled: true });
    store.close();

    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info.capabilities.includes("mail.history.v1"));

    const first = await client.request<MailHistoryResult>("mail.history", { limit: 1_000 });
    assert.equal(first.messages.length, 250, "RPC clamps one page to the wire maximum");
    assert.equal(first.messages[0]?.messageId, sentIds[250]);
    assert.equal(first.messages[249]?.messageId, sentIds[1]);
    assert.equal(first.hasMore, true);
    assert.equal(first.truncated, true);
    assert.equal(first.total, undefined);
    assert.ok(first.nextBeforeSeq);

    const second = await client.request<MailHistoryResult>("mail.history", {
      beforeSeq: first.nextBeforeSeq,
      snapshotSeq: first.snapshotSeq,
    });
    assert.equal(second.snapshotSeq, first.snapshotSeq);
    assert.equal(second.hasMore, false);
    assert.equal(second.truncated, false);
    assert.deepEqual(second.messages.map((message) => message.messageId), [sentIds[0]]);
    assert.equal(second.messages[0]?.lifecycle.state, "canceled");

    await assert.rejects(
      client.request("mail.history", { beforeSeq: -1 }),
      (error: unknown) => error instanceof RpcError && error.code === "invalid_request",
    );
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});

test("mail mutation RPCs reject a valid same-node message id owned by another bee", async () => {
  const rig = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const store = openCoreStore(`${rig.dir}/core.sqlite3`, { ephemeral: true });
    const owner = store.createBee({
      name: "rpc-mail-owner",
      agent: "stub",
      substrate: "hsr",
      cwd: rig.dir,
    }).bee;
    const wrongBee = store.createBee({
      name: "rpc-mail-wrong-owner",
      agent: "stub",
      substrate: "hsr",
      cwd: rig.dir,
    }).bee;
    const cancelTarget = store.send(owner.id, "must remain queued").message;
    const expediteTarget = store.send(owner.id, "must remain idle", { urgency: "idle" }).message;
    store.close();

    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const attempts = await Promise.allSettled([
      client.request("mail.cancel", { beeId: wrongBee.id, messageId: cancelTarget.id }),
      client.request("mail.expedite", { beeId: wrongBee.id, messageId: expediteTarget.id, urgency: "now" }),
    ]);
    for (const attempt of attempts) {
      assert.equal(attempt.status, "rejected");
      if (attempt.status === "rejected") {
        assert.ok(attempt.reason instanceof RpcError);
        assert.equal(attempt.reason.code, "invalid_request");
      }
    }

    const history = await client.request<MailHistoryResult>("mail.history");
    const byId = new Map(history.messages.map((message) => [message.messageId, message]));
    assert.equal(byId.get(cancelTarget.id)?.lifecycle.state, "queued");
    assert.equal(byId.get(expediteTarget.id)?.urgency, "idle");
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});

test("mail mutation RPCs accept pre-owner params during a rolling upgrade", async () => {
  const rig = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const store = openCoreStore(`${rig.dir}/core.sqlite3`, { ephemeral: true });
    const bee = store.createBee({
      name: "rpc-mail-legacy-client",
      agent: "stub",
      substrate: "hsr",
      cwd: rig.dir,
    }).bee;
    const cancelTarget = store.send(bee.id, "legacy cancel").message;
    const expediteTarget = store.send(bee.id, "legacy expedite", { urgency: "idle" }).message;
    store.close();

    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    assert.deepEqual(
      await client.request("mail.cancel", { messageId: cancelTarget.id }),
      { canceled: true },
    );
    assert.deepEqual(
      await client.request("mail.expedite", {
        messageId: expediteTarget.id,
        urgency: "now",
      }),
      { applied: true },
    );
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});

test("mail mutation RPCs replay keyed success with one durable effect", async () => {
  const rig = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const store = openCoreStore(`${rig.dir}/core.sqlite3`, { ephemeral: true });
    const bee = store.createBee({
      name: "rpc-mail-idempotency",
      agent: "stub",
      substrate: "hsr",
      cwd: rig.dir,
    }).bee;
    const cancelTarget = store.send(bee.id, "cancel once").message;
    const expediteTarget = store.send(bee.id, "expedite once", { urgency: "idle" }).message;
    store.close();

    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const cancelParams = { beeId: bee.id, messageId: cancelTarget.id, idempotencyKey: "mail-cancel-once" };
    const expediteParams = {
      beeId: bee.id,
      messageId: expediteTarget.id,
      urgency: "now",
      idempotencyKey: "mail-expedite-once",
    };
    const firstCancel = await client.request<{ canceled: boolean; deduped?: boolean }>("mail.cancel", cancelParams);
    const firstExpedite = await client.request<{ applied: boolean; deduped?: boolean }>(
      "mail.expedite",
      expediteParams,
    );
    const [cancelReplay, expediteReplay] = await Promise.allSettled([
      client.request<{ canceled: boolean; deduped?: boolean }>("mail.cancel", cancelParams),
      client.request<{ applied: boolean; deduped?: boolean }>("mail.expedite", expediteParams),
    ]);
    assert.deepEqual(firstCancel, { canceled: true });
    assert.deepEqual(firstExpedite, { applied: true });
    assert.deepEqual(cancelReplay, { status: "fulfilled", value: { canceled: true, deduped: true } });
    assert.deepEqual(expediteReplay, { status: "fulfilled", value: { applied: true, deduped: true } });
    client.close();
    await daemon.stop();
    daemon = null;

    const check = openCoreStore(`${rig.dir}/core.sqlite3`, { ephemeral: true });
    try {
      assert.equal(check.getMessage(cancelTarget.id), null);
      assert.equal(check.getMessage(expediteTarget.id)?.urgency, "now");
      assert.equal(
        check.auditRows().filter(
          (row) => row.kind === "mail.canceled" && row.payload.messageId === cancelTarget.id,
        ).length,
        1,
      );
      assert.equal(
        check.auditRows().filter(
          (row) => row.kind === "mail.expedited" && row.payload.messageId === expediteTarget.id,
        ).length,
        1,
      );
    } finally {
      check.close();
    }
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});

test("rpc.mail.pending returns only bounded undelivered previews in FIFO order", async () => {
  const rig = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const store = openCoreStore(`${rig.dir}/core.sqlite3`, { ephemeral: true });
    const bee = store.createBee({
      name: "rpc-mail-pending",
      agent: "stub",
      substrate: "hsr",
      cwd: rig.dir,
    }).bee;
    const runtime = store.currentRuntime(bee.id)!;
    store.updateRuntimeState(bee.id, runtime.generation, "running", { pid: 303, pidStartedAt: 3_003 });
    const delivered = store.send(bee.id, "delivered history must stay out").message;
    assert.deepEqual(store.markDelivered(delivered.id, runtime.generation), { applied: true });
    const firstPending = store.send(bee.id, `a${"b".repeat(20_000)}`, {
      sender: "s".repeat(3 * 1024 * 1024),
      urgency: "idle",
      origin: "spawn.prompt",
    }).message;
    const pendingIds = [firstPending.id];
    for (let i = 0; i < 250; i += 1) pendingIds.push(store.send(bee.id, `pending ${i}`).message.id);
    store.close();

    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info.capabilities.includes("mail.pending.v1"));
    await assert.rejects(
      client.request("send", { beeId: bee.id, body: "a\0tail" }),
      (error: unknown) => error instanceof RpcError && error.code === "invalid_request",
    );
    const result = await client.request<MailPendingResult>("mail.pending", { beeId: bee.id, limit: 1_000 });
    assert.equal(result.messages.length, 250);
    assert.equal(result.hasMore, true);
    assert.equal(result.messages[0]?.id, firstPending.id);
    assert.equal(result.messages[0]?.origin, "spawn.prompt");
    assert.equal(result.messages.some((message) => message.id === delivered.id), false);
    assert.deepEqual(result.messages.map((message) => message.id), pendingIds.slice(0, 250));
    assert.equal(result.messages[0]?.body.startsWith("a"), true);
    assert.equal(result.messages[0]?.bodyTruncated, true);
    assert.equal(result.messages[0]?.senderTruncated, true);
    assert.ok(
      result.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.body, "utf8"), 0) <=
        1024 * 1024,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result.messages), "utf8") <= 2 * 1024 * 1024);
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});
