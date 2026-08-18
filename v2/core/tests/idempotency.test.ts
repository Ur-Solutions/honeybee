/**
 * Spec 06 §4.2 — one-key idempotency at the core store level:
 *  - commands.idempotency_key (nullable UNIQUE): a duplicate key returns the
 *    ORIGINAL command at its current status (queued/running/settled) with
 *    `deduped: true`, never a second command;
 *  - keys survive close/reopen (boot replay);
 *  - schema v1 → v2 migration is explicit (additive column) and a NEWER store
 *    is refused with a typed SchemaVersionError;
 *  - the rpc_idempotency table records/answers RPC results with bounded
 *    retention (newest maxRpcIdempotencyRows kept).
 * Temp dirs only — never ~/.hive, never a live store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CoreError,
  SCHEMA_VERSION,
  SchemaVersionError,
  replayAudit,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

test("idem.1: duplicate key returns the ORIGINAL command (queued) — deduped, nothing new enqueued", () => {
  const h = harness();
  const store = h.open();
  const { bee } = makeBee(store);
  const first = store.enqueueCommand("stop", bee.id, { cause: "stopped_by_user" }, { idempotencyKey: "k1" });
  assert.equal(first.deduped, false);
  assert.equal(first.idempotencyKey, "k1");
  const replay = store.enqueueCommand("stop", bee.id, { cause: "stopped_by_user" }, { idempotencyKey: "k1" });
  assert.equal(replay.deduped, true);
  assert.equal(replay.id, first.id);
  assert.equal(replay.status, "queued");
  assert.equal(store.listCommands({ beeId: bee.id }).length, 1);
  // Audit replay still reproduces the exact state (dedup rows are no-ops).
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
  h.cleanup();
});

test("idem.2: replay while running and after settle returns the current/settled status", () => {
  const h = harness();
  const store = h.open();
  const { bee } = makeBee(store);
  const cmd = store.enqueueCommand("stop", bee.id, {}, { idempotencyKey: "k-settle" });

  const claimed = store.claimNextCommand();
  assert.equal(claimed?.id, cmd.id);
  const whileRunning = store.enqueueCommand("stop", bee.id, {}, { idempotencyKey: "k-settle" });
  assert.equal(whileRunning.deduped, true);
  assert.equal(whileRunning.status, "running");

  store.completeCommand(cmd.id);
  const afterSettle = store.enqueueCommand("stop", bee.id, {}, { idempotencyKey: "k-settle" });
  assert.equal(afterSettle.deduped, true);
  assert.equal(afterSettle.id, cmd.id);
  assert.equal(afterSettle.status, "done");
  assert.ok(afterSettle.finishedAt != null);
  assert.equal(store.listCommands({ beeId: bee.id }).length, 1);
  store.close();
  h.cleanup();
});

test("idem.3: replay of a settled failure returns failed — never re-executes", () => {
  const h = harness();
  const store = h.open({ maxAttempts: 1 });
  const { bee } = makeBee(store);
  const cmd = store.enqueueCommand("revive", bee.id, {}, { idempotencyKey: "k-fail" });
  store.claimNextCommand();
  store.reportCommandFailure(cmd.id, "spawn_failed", "boom");
  const replay = store.enqueueCommand("revive", bee.id, {}, { idempotencyKey: "k-fail" });
  assert.equal(replay.deduped, true);
  assert.equal(replay.status, "failed");
  assert.equal(replay.failureCause, "spawn_failed");
  store.close();
  h.cleanup();
});

test("idem.4: distinct keys (and keyless enqueues) are unaffected", () => {
  const h = harness();
  const store = h.open();
  const { bee } = makeBee(store);
  const a = store.enqueueCommand("stop", bee.id, {}, { idempotencyKey: "ka" });
  const b = store.enqueueCommand("stop", bee.id, {}, { idempotencyKey: "kb" });
  const c = store.enqueueCommand("stop", bee.id); // keyless
  const d = store.enqueueCommand("stop", bee.id); // many NULL keys allowed (partial index)
  assert.ok(new Set([a.id, b.id, c.id, d.id]).size === 4);
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, false);
  assert.equal(c.idempotencyKey, null);
  assert.equal(d.idempotencyKey, null);
  assert.throws(() => store.enqueueCommand("stop", bee.id, {}, { idempotencyKey: "" }), CoreError);
  store.close();
  h.cleanup();
});

test("idem.5: keys survive close/reopen (boot replay) — a running command requeues WITH its key", () => {
  const h = harness();
  let store = h.open();
  const { bee } = makeBee(store);
  const cmd = store.enqueueCommand("stop", bee.id, {}, { idempotencyKey: "k-boot" });
  store.claimNextCommand(); // running at "crash"
  store.close();

  store = h.open(); // boot replay: running → queued
  const requeued = store.getCommand(cmd.id);
  assert.equal(requeued?.status, "queued");
  assert.equal(requeued?.idempotencyKey, "k-boot");
  const replay = store.enqueueCommand("stop", bee.id, {}, { idempotencyKey: "k-boot" });
  assert.equal(replay.deduped, true);
  assert.equal(replay.id, cmd.id);
  store.close();
  h.cleanup();
});

test("idem.6: replay of a settled delete returns the settled outcome — not BeeNotFound", () => {
  const h = harness();
  const store = h.open();
  const { bee } = makeBee(store);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
  const del = store.enqueueCommand("delete", bee.id, {}, { idempotencyKey: "k-del" });
  store.claimNextCommand();
  store.completeCommand(del.id);
  store.deleteBee(bee.id);
  // Bee row is gone; the keyed replay must still answer from the command row.
  const replay = store.enqueueCommand("delete", bee.id, {}, { idempotencyKey: "k-del" });
  assert.equal(replay.deduped, true);
  assert.equal(replay.id, del.id);
  assert.equal(replay.status, "done");
  store.close();
  h.cleanup();
});

test("idem.7: v1 store (no stamp, no column) migrates additively to v2 on open", () => {
  const h = harness();
  // Hand-build a minimal v1 database: commands table WITHOUT idempotency_key,
  // meta WITHOUT schema_version, one settled command row.
  const db = new DatabaseSync(h.path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE commands (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      verb              TEXT NOT NULL CHECK (verb IN ('spawn','send_wake','stop','revive','archive','unarchive','delete')),
      bee_id            TEXT NOT NULL,
      args              TEXT NOT NULL DEFAULT '{}',
      target_generation INTEGER,
      status            TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
      attempts          INTEGER NOT NULL DEFAULT 0,
      next_attempt_at   INTEGER NOT NULL,
      enqueued_at       INTEGER NOT NULL,
      finished_at       INTEGER,
      failure_cause     TEXT
    ) STRICT;
  `);
  db.prepare(
    "INSERT INTO commands(verb, bee_id, args, status, attempts, next_attempt_at, enqueued_at, finished_at) VALUES('stop','bee-v1','{}','done',1,1,1,2)",
  ).run();
  db.close();

  const store = h.open();
  const migrated = store.getCommand(1);
  assert.equal(migrated?.verb, "stop");
  assert.equal(migrated?.idempotencyKey, null); // column added, old rows null
  store.close(); // release the EXCLUSIVE lock (B9) before inspecting directly
  // Stamped to the current version, and the UNIQUE index is live.
  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(Number(version.value), SCHEMA_VERSION);
    const idx = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'commands_idempotency_key'")
      .get();
    assert.ok(idx, "unique idempotency index exists after migration");
  } finally {
    check.close();
  }
  h.cleanup();
});

test("idem.8: a NEWER store is refused with a typed schema_newer error (no silent downgrade)", () => {
  const h = harness();
  const store = h.open();
  store.close();
  const db = new DatabaseSync(h.path);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
  db.close();
  assert.throws(
    () => h.open(),
    (err: unknown) => err instanceof SchemaVersionError && err.kind === "schema_newer",
  );
  h.cleanup();
});

test("idem.9: rpc_idempotency records round-trip and retention evicts the oldest beyond the bound", () => {
  const h = harness();
  const store = h.open({ maxRpcIdempotencyRows: 3 });
  assert.equal(store.lookupRpcResult("nope"), null);
  store.recordRpcResult("r1", "spawn", 7, { beeId: "b", commandId: 7 });
  const hit = store.lookupRpcResult("r1");
  assert.equal(hit?.verb, "spawn");
  assert.equal(hit?.commandId, 7);
  assert.deepEqual(hit?.result, { beeId: "b", commandId: 7 });

  store.recordRpcResult("r2", "send", null, { messageId: 1 });
  store.recordRpcResult("r3", "stop", 9, { commandId: 9 });
  store.recordRpcResult("r4", "archive", 10, { commandId: 10 });
  // Bound 3: the oldest (r1) is gone; the newest three answer.
  assert.equal(store.lookupRpcResult("r1"), null);
  assert.ok(store.lookupRpcResult("r2"));
  assert.ok(store.lookupRpcResult("r3"));
  assert.ok(store.lookupRpcResult("r4"));
  store.close();
  h.cleanup();
});

test("idem.10: rpc_idempotency records survive close/reopen", () => {
  const h = harness();
  let store = h.open();
  store.recordRpcResult("persist", "spawn", 1, { beeId: "b1", commandId: 1 });
  store.close();
  store = h.open();
  assert.deepEqual(store.lookupRpcResult("persist")?.result, { beeId: "b1", commandId: 1 });
  store.close();
  h.cleanup();
});
