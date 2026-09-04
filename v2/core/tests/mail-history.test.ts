import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore } from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("mail history pages by sends and folds delivered, expedited, and canceled audit events", () => {
  const store = openCoreStore(":memory:", { ephemeral: true });
  try {
    const firstBee = makeBee(store, "history-first").bee;
    const secondBee = makeBee(store, "history-second").bee;
    const noiseBee = makeBee(store, "history-noise").bee;
    bootToRunning(store, firstBee.id, 101, 1_001);

    const delivered = store.send(firstBee.id, "old delivered", { urgency: "idle" }).message;
    assert.deepEqual(store.expediteMessage(firstBee.id, delivered.id, "now"), { applied: true });
    assert.deepEqual(store.markDelivered(delivered.id, 1), { applied: true });
    assert.deepEqual(store.markDelivered(delivered.id, 1), { applied: false });

    const canceled = store.send(secondBee.id, "canceled but retained", { urgency: "idle" }).message;
    assert.deepEqual(store.cancelMessage(secondBee.id, canceled.id), { canceled: true });
    assert.equal(store.getMessage(canceled.id), null, "cancel still deletes the mailbox row");

    const queued = store.send(firstBee.id, "new queued").message;

    const audit = store.auditRows();
    const enqueueSeq = new Map(
      audit
        .filter((row) => row.kind === "mail.enqueued")
        .map((row) => [(row.payload.message as { id: number }).id, row.seq]),
    );
    const expeditedAt = audit.find(
      (row) => row.kind === "mail.expedited" && row.payload.messageId === delivered.id,
    )?.ts;
    const canceledAt = audit.find(
      (row) => row.kind === "mail.canceled" && row.payload.messageId === canceled.id,
    )?.ts;
    assert.ok(expeditedAt);
    assert.ok(canceledAt);

    for (let i = 0; i < 1_005; i += 1) store.recordOutput(noiseBee.id);

    const firstPage = store.mailHistory({ limit: 2 });
    assert.deepEqual(firstPage.messages.map((message) => message.messageId), [queued.id, canceled.id]);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextBeforeSeq, enqueueSeq.get(canceled.id));
    assert.ok(firstPage.snapshotSeq > (enqueueSeq.get(queued.id) ?? 0));
    assert.deepEqual(firstPage.messages[0], {
      seq: enqueueSeq.get(queued.id),
      messageId: queued.id,
      beeId: firstBee.id,
      sender: "operator",
      senderTruncated: false,
      body: "new queued",
      bodyTruncated: false,
      priority: 0,
      urgency: "next",
      enqueuedAt: queued.enqueuedAt,
      expeditedAt: null,
      lifecycle: { state: "queued" },
    });
    assert.deepEqual(firstPage.messages[1]?.lifecycle, { state: "canceled", canceledAt, reason: "requested" });

    store.recordOutput(noiseBee.id);
    const secondPage = store.mailHistory({
      limit: 2,
      beforeSeq: firstPage.nextBeforeSeq ?? undefined,
      snapshotSeq: firstPage.snapshotSeq,
    });
    assert.equal(secondPage.snapshotSeq, firstPage.snapshotSeq);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.nextBeforeSeq, null);
    assert.deepEqual(secondPage.messages, [
      {
        seq: enqueueSeq.get(delivered.id),
        messageId: delivered.id,
        beeId: firstBee.id,
        sender: "operator",
        senderTruncated: false,
        body: "old delivered",
        bodyTruncated: false,
        priority: 0,
        urgency: "now",
        enqueuedAt: delivered.enqueuedAt,
        expeditedAt,
        lifecycle: {
          state: "delivered",
          deliveredAt: store.getMessage(delivered.id)?.deliveredAt,
          deliveredGeneration: 1,
        },
      },
    ]);
  } finally {
    store.close();
  }
});

test("mail history audit indexes are installed on disk", () => {
  const rig = harness();
  try {
    const store = rig.open();
    store.close();
    const db = new DatabaseSync(rig.path, { readOnly: true });
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>).map((row) => row.name);
      assert.ok(names.includes("audit_mail_enqueued_seq"));
      assert.ok(names.includes("audit_mail_delivered_message_seq"));
      assert.ok(names.includes("audit_mail_expedited_message_seq"));
      assert.ok(names.includes("audit_mail_canceled_message_seq"));
      assert.ok(names.includes("audit_bee_deleted_bee_seq"));
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail_history_enqueues'").get(),
      );
    } finally {
      db.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("deleting a bee closes all queued history with one bounded bee terminal event", () => {
  const store = openCoreStore(":memory:", { ephemeral: true });
  try {
    const bee = makeBee(store, "history-deleted").bee;
    bootToRunning(store, bee.id, 202, 2_002);
    const delivered = store.send(bee.id, "already delivered").message;
    assert.deepEqual(store.markDelivered(delivered.id, 1), { applied: true });
    const firstQueued = store.send(bee.id, "deleted queued one", { urgency: "idle" }).message;
    const secondQueued = store.send(bee.id, "deleted queued two", { urgency: "now" }).message;

    store.deleteBee(bee.id);

    const byId = new Map(store.mailHistory().messages.map((message) => [message.messageId, message]));
    assert.equal(byId.get(delivered.id)?.lifecycle.state, "delivered");
    for (const message of [firstQueued, secondQueued]) {
      const lifecycle = byId.get(message.id)?.lifecycle;
      assert.deepEqual(lifecycle, {
        state: "canceled",
        reason: "bee_deleted",
        canceledAt: store.auditRows().find((row) => row.kind === "bee.deleted")?.ts,
      });
    }

    const deleteCancellations = store.auditRows().filter(
      (row) => row.kind === "mail.canceled" && row.payload.reason === "bee_deleted",
    );
    assert.deepEqual(deleteCancellations, []);
    assert.equal(store.auditRows().filter((row) => row.kind === "bee.deleted").length, 1);
  } finally {
    store.close();
  }
});

test("mail history bounds body previews and aggregate page bytes without skipping sends", () => {
  const store = openCoreStore(":memory:", { ephemeral: true });
  try {
    const bee = makeBee(store, "history-large-bodies").bee;
    const sentIds: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      sentIds.push(store.send(bee.id, `${i}:${"🐝".repeat(5_000)}`).message.id);
    }

    const seen: number[] = [];
    let beforeSeq: number | undefined;
    let snapshotSeq: number | undefined;
    for (;;) {
      const page = store.mailHistory({ limit: 70, beforeSeq, snapshotSeq });
      snapshotSeq ??= page.snapshotSeq;
      assert.equal(page.snapshotSeq, snapshotSeq);
      assert.ok(page.messages.length > 0);
      assert.ok(
        page.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.body, "utf8"), 0) <=
          1024 * 1024,
      );
      assert.ok(
        page.messages.reduce(
          (bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message), "utf8"),
          0,
        ) <= 2 * 1024 * 1024,
      );
      assert.ok(page.messages.every((message) => Buffer.byteLength(message.body, "utf8") <= 16 * 1024));
      assert.ok(page.messages.every((message) => message.bodyTruncated));
      seen.push(...page.messages.map((message) => message.messageId));
      if (!page.hasMore) break;
      assert.ok(page.nextBeforeSeq !== null);
      beforeSeq = page.nextBeforeSeq;
    }

    assert.deepEqual(seen, sentIds.reverse());
  } finally {
    store.close();
  }
});

test("mail history projection bounds oversized sender plus first-row JSON", () => {
  const rig = harness();
  try {
    const initial = rig.open();
    const bee = makeBee(initial, "history-nul-and-sender").bee;
    const body = `a${"b".repeat(20_000)}`;
    initial.send(bee.id, body, { sender: "s".repeat(3 * 1024 * 1024) });
    initial.close();

    const fixture = new DatabaseSync(rig.path);
    fixture.exec("DROP TABLE mail_history_enqueues");
    fixture.close();

    const reopened = rig.open();
    try {
      const message = reopened.mailHistory({ limit: 1 }).messages[0];
      assert.ok(message);
      assert.equal(message.body.startsWith("a"), true);
      assert.equal(message.bodyTruncated, true);
      assert.ok(Buffer.byteLength(message.body, "utf8") <= 16 * 1024);
      assert.equal(message.senderTruncated, true);
      assert.ok(Buffer.byteLength(message.sender, "utf8") <= 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(message), "utf8") <= 2 * 1024 * 1024);
    } finally {
      reopened.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("mail history send-time and rebuilt projections agree for ill-formed UTF-16", () => {
  const rig = harness();
  try {
    const initial = rig.open();
    const bee = makeBee(initial, "history-utf16-parity").bee;
    initial.send(bee.id, `\ud800${"x".repeat(20_000)}`);
    const sentProjection = initial.mailHistory().messages[0];
    initial.close();

    const fixture = new DatabaseSync(rig.path);
    fixture.exec("DROP TABLE mail_history_enqueues");
    fixture.close();

    const reopened = rig.open();
    try {
      const rebuiltProjection = reopened.mailHistory().messages[0];
      assert.equal(sentProjection?.body.startsWith("�"), true);
      assert.deepEqual(rebuiltProjection, sentProjection);
    } finally {
      reopened.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("mail history projection persists an audit high-water and advances without historical rescan", () => {
  const rig = harness();
  try {
    const initial = rig.open();
    const bee = makeBee(initial, "history-high-water").bee;
    initial.send(bee.id, "one");
    initial.send(bee.id, "two");
    initial.close();

    const firstReopen = rig.open();
    firstReopen.close();
    const fixture = new DatabaseSync(rig.path);
    const firstHighWater = Number(
      (fixture.prepare("SELECT value FROM meta WHERE key = 'mail_history_projection_seq'").get() as { value: string })
        .value,
    );
    const firstHead = Number((fixture.prepare("SELECT MAX(seq) AS seq FROM audit").get() as { seq: number }).seq);
    assert.equal(firstHighWater, firstHead);
    const inserted = fixture
      .prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES (?, 'bee.output', ?, '{}')")
      .run(rig.now(), bee.id);
    fixture.close();

    const secondReopen = rig.open();
    secondReopen.close();
    const check = new DatabaseSync(rig.path, { readOnly: true });
    try {
      const secondHighWater = Number(
        (check.prepare("SELECT value FROM meta WHERE key = 'mail_history_projection_seq'").get() as { value: string })
          .value,
      );
      assert.equal(secondHighWater, Number(inserted.lastInsertRowid));
    } finally {
      check.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("mail pending rebuild infers durable legacy spawn origin and fails unknown origin closed", () => {
  const rig = harness();
  try {
    const initial = rig.open();
    const bee = makeBee(initial, "history-origin-rebuild").bee;
    const spawned = initial.send(bee.id, "spawn admission", { origin: "spawn.prompt" }).message;
    const legacy = initial.send(bee.id, "legacy ordinary send").message;
    initial.recordRpcResult("legacy-spawn", "spawn", null, { beeId: bee.id, messageId: spawned.id });
    initial.close();

    const fixture = new DatabaseSync(rig.path);
    fixture
      .prepare(
        "UPDATE audit SET payload = json_remove(payload, '$.origin') WHERE kind = 'mail.enqueued'",
      )
      .run();
    fixture.exec("DROP TABLE mail_history_enqueues");
    fixture.close();

    const reopened = rig.open();
    try {
      const byId = new Map(reopened.pendingMail(bee.id).messages.map((message) => [message.id, message]));
      assert.equal(byId.get(spawned.id)?.origin, "spawn.prompt");
      assert.equal(byId.get(legacy.id)?.origin, "legacy.unknown");
    } finally {
      reopened.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("bee admission rejects an identity large enough to break bounded mail pages", () => {
  const store = openCoreStore(":memory:", { ephemeral: true });
  try {
    assert.throws(
      () =>
        store.createBee({
          id: "b".repeat(2_200_000),
          name: "oversized-id",
          agent: "stub",
          substrate: "hsr",
          cwd: "/tmp",
        }),
      /bee id.*256 UTF-8 bytes/,
    );
    assert.equal(store.listBees().length, 0);
  } finally {
    store.close();
  }
});

test("mail admission rejects NUL before authoritative mailbox and projection writes", () => {
  const store = openCoreStore(":memory:", { ephemeral: true });
  try {
    const bee = makeBee(store, "history-nul-rejected").bee;
    assert.throws(() => store.send(bee.id, "a\0tail"), /body must not contain U\+0000/);
    assert.throws(
      () => store.send(bee.id, "safe body", { sender: "sender\0tail" }),
      /sender must not contain U\+0000/,
    );
    assert.deepEqual(store.listMessages(bee.id), []);
    assert.deepEqual(store.mailHistory().messages, []);
  } finally {
    store.close();
  }
});

test("mail history reads its send-time projection without reparsing enqueue audit bodies", () => {
  const rig = harness();
  try {
    const initial = rig.open();
    const bee = makeBee(initial, "history-projected").bee;
    const message = initial.send(bee.id, "projected body").message;
    initial.close();

    const fixture = new DatabaseSync(rig.path);
    fixture
      .prepare("UPDATE audit SET payload = 'not-json' WHERE kind = 'mail.enqueued'")
      .run();
    fixture.close();

    const reopened = rig.open();
    try {
      assert.equal(reopened.mailHistory().messages[0]?.messageId, message.id);
      assert.equal(reopened.mailHistory().messages[0]?.body, "projected body");
    } finally {
      reopened.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("mail history folds only the latest repeated lifecycle event of each kind", () => {
  const store = openCoreStore(":memory:", { ephemeral: true });
  try {
    const bee = makeBee(store, "history-repeated-lifecycle").bee;
    const message = store.send(bee.id, "repeat expedite").message;
    for (let i = 0; i < 1_005; i += 1) {
      store.expediteMessage(bee.id, message.id, i % 2 === 0 ? "idle" : "now");
    }
    const latest = store.auditRows().findLast(
      (row) => row.kind === "mail.expedited" && row.payload.messageId === message.id,
    );

    const history = store.mailHistory({ limit: 1 }).messages[0];
    assert.equal(history?.urgency, "idle");
    assert.equal(history?.expeditedAt, latest?.ts);
  } finally {
    store.close();
  }
});

test("mail history reopens pre-fix bee deletion audit as snapshot-correct cancellation", () => {
  const rig = harness();
  try {
    const initial = rig.open();
    const bee = makeBee(initial, "history-legacy-delete").bee;
    const message = initial.send(bee.id, "legacy cascade").message;
    initial.close();

    const deletedAt = rig.now();
    const fixture = new DatabaseSync(rig.path);
    fixture.exec("PRAGMA foreign_keys = ON");
    fixture.exec("DROP TABLE IF EXISTS mail_history_enqueues");
    fixture.prepare("DELETE FROM bees WHERE id = ?").run(bee.id);
    const inserted = fixture
      .prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES (?, 'bee.deleted', ?, ?)")
      .run(deletedAt, bee.id, JSON.stringify({ beeId: bee.id, deletedAt }));
    const deleteSeq = Number(inserted.lastInsertRowid);
    fixture.close();

    const reopened = rig.open();
    try {
      assert.deepEqual(reopened.mailHistory({ snapshotSeq: deleteSeq - 1 }).messages[0]?.lifecycle, {
        state: "queued",
      });
      assert.deepEqual(reopened.mailHistory().messages[0]?.lifecycle, {
        state: "canceled",
        reason: "bee_deleted",
        canceledAt: deletedAt,
      });
      assert.equal(reopened.getMessage(message.id), null);
    } finally {
      reopened.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("mail history reads only fixed deletion columns, not an unbounded audit payload", () => {
  const rig = harness();
  try {
    const initial = rig.open();
    const bee = makeBee(initial, "history-bounded-delete").bee;
    initial.send(bee.id, "bounded deletion lookup");
    initial.close();

    const deletedAt = rig.now();
    const fixture = new DatabaseSync(rig.path);
    fixture.exec("PRAGMA foreign_keys = ON");
    fixture.prepare("DELETE FROM bees WHERE id = ?").run(bee.id);
    fixture
      .prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES (?, 'bee.deleted', ?, ?)")
      .run(deletedAt, bee.id, `not-json-${"x".repeat(1024 * 1024)}`);
    fixture.close();

    const reopened = rig.open();
    try {
      assert.deepEqual(reopened.mailHistory().messages[0]?.lifecycle, {
        state: "canceled",
        reason: "bee_deleted",
        canceledAt: deletedAt,
      });
    } finally {
      reopened.close();
    }
  } finally {
    rig.cleanup();
  }
});
