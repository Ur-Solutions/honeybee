/**
 * Delivery urgency (schema v8 — spec 01 Q2 amendment 2026-08-18): the mailbox
 * `urgency` column ('now'|'next'|'idle', default 'next') that supersedes the
 * reserved `priority` column's ROLE. Core scope only: stored / defaulted /
 * validated / never reorders FIFO / audited + replayed / v7 → v8 migration.
 * The daemon's eligibility + interrupt behavior is proven in
 * v2/daemon/tests/loops.test.ts and the integration tier.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  MESSAGE_URGENCIES,
  SCHEMA_VERSION,
  UnknownUrgencyError,
  replayAudit,
  type AuditRow,
} from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("urgency.1: send stores urgency; omitted defaults to 'next'; the closed list is enforced", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 4, 4);

  assert.deepEqual(MESSAGE_URGENCIES, ["now", "next", "idle"]);
  assert.equal(store.send(bee.id, "default").message.urgency, "next");
  for (const urgency of MESSAGE_URGENCIES) {
    const { message } = store.send(bee.id, `u-${urgency}`, { urgency });
    assert.equal(message.urgency, urgency);
    assert.equal(store.getMessage(message.id)?.urgency, urgency, "read back from the row");
  }
  assert.throws(
    () => store.send(bee.id, "bad", { urgency: "soon" as never }),
    UnknownUrgencyError,
    "urgency outside the closed list throws",
  );
  assert.equal(store.undeliveredMessages(bee.id).length, 4, "the refused send inserted nothing");
  store.close();
});

test("urgency.2: urgency never reorders the per-bee FIFO — the store keeps enqueue order; eligibility is the daemon's job", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 5, 5);
  store.send(bee.id, "first", { urgency: "idle" });
  store.send(bee.id, "second", { urgency: "now" }); // `now` must NOT jump the stored queue
  store.send(bee.id, "third"); // default next
  assert.deepEqual(
    store.undeliveredMessages(bee.id).map((m) => [m.body, m.urgency]),
    [
      ["first", "idle"],
      ["second", "now"],
      ["third", "next"],
    ],
  );
  store.close();
});

test("urgency.3: audited on the mail.enqueued payload and replayed exactly; pre-v8 audit rows replay as 'next'", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 6, 6);
  store.send(bee.id, "a", { urgency: "now" });
  const idle = store.send(bee.id, "b", { urgency: "idle" }).message;
  store.markDelivered(idle.id, 1);

  const rows = store.auditRows();
  const enqueued = rows.filter((r) => r.kind === "mail.enqueued");
  assert.deepEqual(
    enqueued.map((r) => (r.payload.message as { urgency: string }).urgency),
    ["now", "idle"],
    "audit payloads carry urgency",
  );
  assert.deepEqual(replayAudit(rows), store.dumpState(), "replay reproduces urgency");

  // Back-compat: a pre-v8 mail.enqueued payload (no urgency key) replays as
  // the migrated store reads the row — the column default, 'next'.
  const legacy: AuditRow[] = rows.map((r) => {
    if (r.kind !== "mail.enqueued") return r;
    const { urgency: _dropped, ...message } = r.payload.message as Record<string, unknown>;
    return { ...r, payload: { ...r.payload, message } };
  });
  const replayed = replayAudit(legacy);
  assert.deepEqual(
    replayed.mailbox.map((m) => m.urgency),
    ["next", "next"],
  );
  store.close();
});

test("urgency.4: question answers are delivered at 'next' — never an interrupt, never held for idle", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 7, 7);
  const q = store.askQuestion(bee.id, { text: "which port?" });
  const { send } = store.answerQuestion(q.id, "8080");
  assert.equal(send.message.urgency, "next");
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("urgency.5: v8 migration — a v7 store opens as v8: mailbox.urgency added, old rows read 'next', new sends store theirs, stamp bumped", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const db = new DatabaseSync(h.path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO meta(key, value) VALUES('schema_version', '7');
    CREATE TABLE bees (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
      created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
      provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
      spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT, parent_id TEXT, forked_from TEXT, fork_seed TEXT, account TEXT
    ) STRICT;
    INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at)
      VALUES('old-1','old','claude','hsr','/tmp','active',5);
    CREATE TABLE runtimes (
      bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK (generation >= 1),
      state TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
      exit_cause TEXT, pid INTEGER, pid_started_at INTEGER, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (bee_id, generation)
    ) STRICT;
    INSERT INTO runtimes(bee_id, generation, state, started_at, updated_at) VALUES('old-1', 1, 'idle', 5, 6);
    -- v7 mailbox shape: priority, no urgency
    CREATE TABLE mailbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
      sender TEXT NOT NULL, body TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      enqueued_at INTEGER NOT NULL, delivered_at INTEGER, delivered_generation INTEGER
    ) STRICT;
    INSERT INTO mailbox(bee_id, sender, body, priority, enqueued_at) VALUES('old-1', 'operator', 'pre-urgency', 3, 5);
  `);
  db.close();

  const store = h.open();
  const [old] = store.undeliveredMessages("old-1");
  assert.equal(old?.body, "pre-urgency");
  assert.equal(old?.urgency, "next", "pre-v8 rows read the column default");
  assert.equal(old?.priority, 3, "the reserved compat column survives untouched");
  const fresh = store.send("old-1", "post-migration", { urgency: "idle" }).message;
  assert.equal(store.getMessage(fresh.id)?.urgency, "idle");
  store.close();

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(Number(version.value), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 18);
    const cols = (check.prepare("SELECT name FROM pragma_table_info('mailbox')").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes("urgency"));
    assert.ok(cols.includes("priority"));
  } finally {
    check.close();
  }
});

test("mail.cancel: undelivered removed + audited; delivered refused; absent refused", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  {
    const store = h.open();
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 4, 4);
    const queued = store.send(bee.id, "cancel me", { urgency: "idle" });
    assert.deepEqual(store.cancelMessage(queued.message.id), { canceled: true });
    assert.equal(store.getMessage(queued.message.id), null);
    assert.ok(store.auditRows().some((r) => r.kind === "mail.canceled"));
    const delivered = store.send(bee.id, "already gone");
    store.markDelivered(delivered.message.id, store.currentRuntime(bee.id)!.generation);
    assert.deepEqual(store.cancelMessage(delivered.message.id), { canceled: false, reason: "delivered" });
    assert.deepEqual(store.cancelMessage(99999), { canceled: false, reason: "not_found" });
  }
});

test("mail.expedite: undelivered urgency changes + audited; delivered refused; unknown urgency throws", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  {
    const store = h.open();
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 4, 4);
    const queued = store.send(bee.id, "later", { urgency: "idle" });
    assert.deepEqual(store.expediteMessage(queued.message.id, "now"), { applied: true });
    assert.equal(store.getMessage(queued.message.id)?.urgency, "now");
    assert.ok(store.auditRows().some((r) => r.kind === "mail.expedited"));
    assert.throws(() => store.expediteMessage(queued.message.id, "whenever" as never));
    store.markDelivered(queued.message.id, store.currentRuntime(bee.id)!.generation);
    assert.deepEqual(store.expediteMessage(queued.message.id, "next"), { applied: false, reason: "delivered" });
  }
});
