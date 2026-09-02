/**
 * v18 — idle-timeout reaper, core tier:
 *  - the `idle_timeout` exit cause is in the closed list and the runtimes
 *    CHECK accepts it (idle → stopped(idle_timeout))
 *  - the v17 → v18 migration REBUILDS `runtimes` (SQLite cannot alter a
 *    CHECK) preserving every row and the observation-cursor rows that
 *    reference it, and adds `bees.idle_timeout_ms`
 *  - `updateBeeIdleTimeout` / `createBee {idleTimeoutMs}`: null inherit,
 *    0 never, >0 ms; validation; audit `bee.idle_timeout_set`; no-op on same
 *  - `lastDeliveredAt` (the reaper's "delivered since the idle edge" input)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CoreError, EXIT_CAUSES } from "../src/index.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";
import { harness, makeBee, bootToRunning } from "./helpers.ts";

test("idle.core.1: idle_timeout is a closed-list exit cause and the runtimes CHECK accepts it", () => {
  assert.ok((EXIT_CAUSES as readonly string[]).includes("idle_timeout"));
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 4242, 1);
    store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "idle_timeout" });
    const rt = store.currentRuntime(bee.id);
    assert.equal(rt?.state, "stopped");
    assert.equal(rt?.exitCause, "idle_timeout");
    const view = store.view(bee.id);
    assert.equal(view.exitCause, "idle_timeout");
    assert.equal(view.reachable, true);
    assert.equal(view.working, false);
    // A reap is not a boot failure: the budget is untouched.
    assert.equal(store.getBee(bee.id)?.spawnFailures, 0);
    // Revive mints N+1 like any stopped runtime.
    const next = store.reviveBee(bee.id);
    assert.equal(next.generation, 2);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("idle.core.2: v18 migration rebuilds runtimes (new CHECK), keeps rows + observation cursors, adds bees.idle_timeout_ms", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '17');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT, parent_id TEXT, forked_from TEXT, fork_seed TEXT,
        account TEXT, handle TEXT
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, handle) VALUES('old-1','old','claude','hsr','/tmp','active',5,'CL.0001');
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, handle) VALUES('old-2','old2','codex','hsr','/tmp','active',5,'CX.0002');
      CREATE TABLE runtimes (
        bee_id         TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
        generation     INTEGER NOT NULL CHECK (generation >= 1),
        state          TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
        exit_cause     TEXT CHECK (exit_cause IN ('clean','crashed','stopped_by_user','stopped_by_system','machine_restart')),
        pid            INTEGER,
        pid_started_at INTEGER,
        boot_evidence  TEXT CHECK (boot_evidence IN ('synthetic','real')),
        started_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (bee_id, generation),
        CHECK ((state = 'stopped') = (exit_cause IS NOT NULL))
      ) STRICT;
      INSERT INTO runtimes VALUES('old-1', 1, 'stopped', 'stopped_by_system', 11, 12, 'real', 5, 6);
      INSERT INTO runtimes VALUES('old-1', 2, 'idle', NULL, 13, 14, 'real', 7, 8);
      INSERT INTO runtimes VALUES('old-2', 1, 'stopped', 'machine_restart', NULL, NULL, NULL, 5, 6);
      CREATE TABLE runtime_observation_cursors (
        bee_id TEXT NOT NULL, generation INTEGER NOT NULL, cursor INTEGER NOT NULL CHECK (cursor >= 0), updated_at INTEGER NOT NULL,
        PRIMARY KEY (bee_id, generation),
        FOREIGN KEY (bee_id, generation) REFERENCES runtimes(bee_id, generation) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO runtime_observation_cursors VALUES('old-1', 2, 41, 9);
    `);
    db.close();

    const store = h.open();
    // Every runtime row survived the rebuild verbatim.
    assert.deepEqual(
      store.listRuntimes("old-1").map((r) => [r.generation, r.state, r.exitCause, r.pid, r.pidStartedAt, r.bootEvidence, r.startedAt, r.updatedAt]),
      [
        [1, "stopped", "stopped_by_system", 11, 12, "real", 5, 6],
        [2, "idle", null, 13, 14, "real", 7, 8],
      ],
    );
    assert.equal(store.currentRuntime("old-2")?.exitCause, "machine_restart");
    // The cursor row was not cascaded away by the rebuild.
    assert.equal(store.runtimeObservationCursor("old-1", 2), 41);
    // The new value is accepted on the live runtime.
    store.updateRuntimeState("old-1", 2, "stopped", { exitCause: "idle_timeout" });
    assert.equal(store.currentRuntime("old-1")?.exitCause, "idle_timeout");
    // The additive bee column arrived, defaulting to inherit.
    assert.equal(store.getBee("old-1")?.idleTimeoutMs, null);
    store.updateBeeIdleTimeout("old-1", 0);
    assert.equal(store.getBee("old-1")?.idleTimeoutMs, 0);
    store.close();

    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 18);
      const ddl = check.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtimes'").get() as { sql: string };
      assert.match(ddl.sql, /'idle_timeout'/);
      assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'runtimes_v18'").get(), undefined, "temp table gone");
      assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      check.close();
    }
    // Reopen: the rebuild is idempotent (DDL already carries the value).
    const again = h.open();
    assert.equal(again.currentRuntime("old-1")?.exitCause, "idle_timeout");
    assert.equal(again.runtimeObservationCursor("old-1", 2), 41);
    again.close();
  } finally {
    h.cleanup();
  }
});

test("idle.core.3: per-bee idle timeout — createBee value, setter semantics, validation, audit", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    assert.equal(bee.idleTimeoutMs, null, "inherit by default");
    const { bee: keeper } = store.createBee({ name: "keeper", agent: "claude", substrate: "hsr", cwd: "/tmp", idleTimeoutMs: 0 });
    assert.equal(keeper.idleTimeoutMs, 0);
    const { bee: quick } = store.createBee({ name: "quick", agent: "claude", substrate: "hsr", cwd: "/tmp", idleTimeoutMs: 60_000 });
    assert.equal(quick.idleTimeoutMs, 60_000);

    const set = store.updateBeeIdleTimeout(bee.id, 900_000);
    assert.equal(set.applied, true);
    assert.equal(set.bee.idleTimeoutMs, 900_000);
    assert.equal(store.updateBeeIdleTimeout(bee.id, 900_000).applied, false, "same value: silent no-op");
    const cleared = store.updateBeeIdleTimeout(bee.id, null);
    assert.equal(cleared.applied, true);
    assert.equal(cleared.bee.idleTimeoutMs, null);
    const audits = store.auditRows().filter((a) => a.kind === "bee.idle_timeout_set" && a.beeId === bee.id);
    assert.deepEqual(
      audits.map((a) => a.payload),
      [
        { beeId: bee.id, idleTimeoutMs: 900_000, previous: null },
        { beeId: bee.id, idleTimeoutMs: null, previous: 900_000 },
      ],
    );

    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "15m"]) {
      assert.throws(() => store.updateBeeIdleTimeout(bee.id, bad as number), CoreError, String(bad));
    }
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", idleTimeoutMs: -5 }), CoreError);
    assert.throws(() => store.updateBeeIdleTimeout("nope", 1), CoreError);
    // The setter survives replay: a fresh open reads the stored value.
    store.updateBeeIdleTimeout(bee.id, 0);
    store.close();
    const reopened = h.open();
    assert.equal(reopened.getBee(bee.id)?.idleTimeoutMs, 0);
    assert.equal(reopened.getBee(keeper.id)?.idleTimeoutMs, 0);
    reopened.close();
  } finally {
    try {
      store.close();
    } catch {
      /* closed above */
    }
    h.cleanup();
  }
});

test("idle.core.4: lastDeliveredAt — per current generation; null before any delivery", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 7, 1);
    store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
    assert.equal(store.lastDeliveredAt(bee.id, 1), null);
    const a = store.send(bee.id, "one");
    const b = store.send(bee.id, "two");
    store.markDelivered(a.message.id, 1);
    const first = store.lastDeliveredAt(bee.id, 1);
    assert.ok(first != null && first > 0);
    store.markDelivered(b.message.id, 1);
    const second = store.lastDeliveredAt(bee.id, 1);
    assert.ok(second != null && second > (first as number), "max of the generation's deliveries");
    assert.equal(store.lastDeliveredAt(bee.id, 2), null, "other generations do not count");
  } finally {
    store.close();
    h.cleanup();
  }
});
