/**
 * Additional coverage beyond the 14 spec tests: edge cases the logic deserves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BeeNotFoundError,
  CommandProtocolError,
  CoreError,
  IllegalTransitionError,
  SecondWriterError,
  UnknownFailureCauseError,
  UnknownVerbError,
  SCHEMA_VERSION,
  openCoreStore,
} from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("send to a live runtime does not enqueue a wake", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  // booting counts as live: the runtime is coming up and will consume the mailbox.
  assert.equal(store.send(bee.id, "early").wakeCommand, null);
  bootToRunning(store, bee.id, 1, 1);
  assert.equal(store.send(bee.id, "mid").wakeCommand, null);
  store.updateRuntimeState(bee.id, 1, "idle");
  assert.equal(store.send(bee.id, "idle").wakeCommand, null);
  assert.equal(store.listCommands({ beeId: bee.id }).length, 0);
  store.close();
});

test("runner observation cursors are monotonic and fenced to the live generation", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);

  assert.equal(store.runtimeObservationCursor(bee.id, 1), null);
  assert.equal(
    store.recordRuntimeProc(bee.id, 1, { pid: 101, pidStartedAt: 1001, observationCursor: 0 }).applied,
    true,
  );
  assert.equal(store.runtimeObservationCursor(bee.id, 1), 0);
  assert.equal(store.advanceRuntimeObservationCursor(bee.id, 1, 24).applied, true);
  assert.equal(store.advanceRuntimeObservationCursor(bee.id, 1, 24).applied, false);
  assert.equal(store.advanceRuntimeObservationCursor(bee.id, 1, 12).applied, false);
  assert.equal(store.runtimeObservationCursor(bee.id, 1), 24);

  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  store.reviveBee(bee.id);
  store.recordRuntimeProc(bee.id, 2, { pid: 202, pidStartedAt: 2002, observationCursor: 0 });
  assert.equal(store.advanceRuntimeObservationCursor(bee.id, 1, 99).applied, false);
  assert.equal(store.runtimeObservationCursor(bee.id, 1), 24);
  assert.equal(store.runtimeObservationCursor(bee.id, 2), 0);
  store.close();
});

test("turn completion commits idle and the last-output fact in one store transaction", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 11, 111);
  store.recordRuntimeProc(bee.id, 1, { pid: 11, pidStartedAt: 111, observationCursor: 5 });

  assert.equal(store.getBee(bee.id)?.lastOutputAt, null);
  assert.throws(() => store.transact(() => {
    store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
    store.advanceRuntimeObservationCursor(bee.id, 1, 25);
    throw new Error("simulated daemon death before observation-fold commit");
  }));
  assert.equal(store.currentRuntime(bee.id)?.state, "running");
  assert.equal(store.getBee(bee.id)?.lastOutputAt, null);
  assert.equal(store.runtimeObservationCursor(bee.id, 1), 5);

  store.transact(() => {
    store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
    store.advanceRuntimeObservationCursor(bee.id, 1, 25);
  });
  assert.equal(store.currentRuntime(bee.id)?.state, "idle");
  assert.ok(store.getBee(bee.id)?.lastOutputAt != null);
  assert.equal(store.runtimeObservationCursor(bee.id, 1), 25);
  assert.equal(
    store.auditRows().filter((row) => row.beeId === bee.id && row.kind === "output.recorded").length,
    1,
  );
  store.close();
});

test("repeat sends to a stopped bee dedupe to one pending send_wake", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  const first = store.send(bee.id, "a").wakeCommand;
  const second = store.send(bee.id, "b").wakeCommand;
  assert.ok(first);
  assert.equal(second?.id, first.id); // bounded queue: same pending wake returned
  assert.equal(store.listCommands({ beeId: bee.id }).length, 1);
  store.close();
});

test("unknown verb and unknown failure cause throw (closed lists)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  assert.throws(() => store.enqueueCommand("kill", bee.id), UnknownVerbError); // kill no longer exists
  assert.throws(() => store.enqueueCommand("retire", bee.id), UnknownVerbError); // neither does retire
  const cmd = store.enqueueCommand("stop", bee.id);
  store.claimNextCommand();
  assert.throws(() => store.reportCommandFailure(cmd.id, "kill_failed"), UnknownFailureCauseError);
  store.close();
});

test("command protocol: settle requires a claim; backoff grows exponentially", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open({ maxAttempts: 5, backoffBaseMs: 1_000_000_000 });
  const { bee } = makeBee(store);
  const cmd = store.enqueueCommand("stop", bee.id);
  assert.throws(() => store.completeCommand(cmd.id), CommandProtocolError);
  assert.throws(() => store.reportCommandFailure(cmd.id, "resource_blocked"), CommandProtocolError);

  store.claimNextCommand();
  const r1 = store.reportCommandFailure(cmd.id, "resource_blocked");
  // Backed off far into the future: not claimable now.
  assert.equal(store.claimNextCommand(), null);
  const requeued = store.getCommand(cmd.id);
  assert.equal(requeued?.status, "queued");
  assert.ok(r1.nextAttemptAt != null && r1.nextAttemptAt > h.now());
  store.close();
});

test("backoff doubles per attempt", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  // Hold the clock still during each call so backoff deltas are exact.
  let tick = 5_000_000;
  const store = openCoreStore(h.path, { now: () => tick, maxAttempts: 5, backoffBaseMs: 8, ephemeral: true });
  const { bee } = makeBee(store);
  const cmd = store.enqueueCommand("stop", bee.id);
  const deltas: number[] = [];
  for (let i = 0; i < 3; i++) {
    tick += 100_000; // pass the previous backoff window
    assert.equal(store.claimNextCommand()?.id, cmd.id);
    const res = store.reportCommandFailure(cmd.id, "resource_blocked");
    assert.ok(res.nextAttemptAt != null);
    deltas.push(res.nextAttemptAt - tick);
  }
  assert.deepEqual(deltas, [8, 16, 32]);
  store.close();
});

test("ephemeral: skip fsync but keep B9 exclusive locking and in-process crash/reopen", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = openCoreStore(h.path, { now: h.now, ephemeral: true });
  const { bee } = makeBee(store);
  store.send(bee.id, "keep me");
  assert.throws(() => openCoreStore(h.path, { now: h.now, ephemeral: true }), SecondWriterError);
  store.close();
  store = openCoreStore(h.path, { now: h.now, ephemeral: true });
  assert.equal(store.getBee(bee.id)?.name, "worker");
  assert.equal(store.undeliveredMessages(bee.id).length, 1);
  const dumped = store.dumpState();
  assert.equal(dumped.mailbox.length, 1);
  store.close();
});

test("mailbox is per-bee FIFO; priority column is reserved and unused in ordering (Q2)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 9, 9);
  store.send(bee.id, "first", { priority: 0 });
  store.send(bee.id, "second", { priority: 9 }); // higher tier must NOT jump the line today
  store.send(bee.id, "third", { priority: 5 });
  assert.deepEqual(
    store.undeliveredMessages(bee.id).map((m) => m.body),
    ["first", "second", "third"],
  );
  assert.equal(store.undeliveredMessages(bee.id)[1]?.priority, 9); // but the tier is stored
  store.close();
});

test("batch undelivered read preserves per-bee FIFO and excludes delivered rows", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee: first } = makeBee(store, "first");
  const { bee: second } = makeBee(store, "second");
  bootToRunning(store, first.id, 11, 11);
  bootToRunning(store, second.id, 12, 12);
  const delivered = store.send(first.id, "first-delivered").message;
  store.send(first.id, "first-pending");
  store.send(second.id, "second-pending");
  store.markDelivered(delivered.id, 1);
  const expected: Array<[string, string]> = [[first.id, "first-pending"], [second.id, "second-pending"]];
  assert.deepEqual(
    store.listUndeliveredMessages().map((message) => [message.beeId, message.body]),
    [[first.id, "first-pending"], [second.id, "second-pending"]].sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])),
    ),
  );
  store.close();
});

test("delivery marks are fenced: stale generation and non-live generation are recorded no-ops", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 4, 4);
  const { message } = store.send(bee.id, "hello");
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  assert.equal(store.markDelivered(message.id, 1).applied, false); // gen 1 not live
  store.reviveBee(bee.id);
  assert.equal(store.markDelivered(message.id, 1).applied, false); // gen 1 stale
  assert.equal(store.markDelivered(message.id, 2).applied, true);
  const noops = store.auditRows().filter((r) => r.kind === "mail.deliver_noop");
  assert.equal(noops.length, 2);
  store.close();
});

test("delete is immediate and total (Q1): rows gone, pending commands settled, log path returned", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = store.createBee({
    name: "doomed",
    agent: "codex",
    substrate: "cell",
    cwd: "/tmp/d",
    sessionLogPath: "/tmp/d/session.log",
    tags: ["x"],
    title: "Doomed",
  });
  bootToRunning(store, bee.id, 77, 7);
  store.send(bee.id, "mail");
  store.setFlag(bee.id, "auth_needed", "x");
  const cmd = store.enqueueCommand("stop", bee.id);
  store.archiveBee(bee.id);

  const res = store.deleteBee(bee.id);
  assert.equal(res.sessionLogPath, "/tmp/d/session.log");
  assert.equal(res.livePid, 77); // caller must reap the process
  assert.deepEqual(res.settledCommandIds, [cmd.id]);
  assert.equal(store.getCommand(cmd.id)?.status, "done"); // moot, not failed

  const dump = store.dumpState();
  assert.deepEqual(dump.bees, []);
  assert.deepEqual(dump.runtimes, []);
  assert.deepEqual(dump.flags, []);
  assert.deepEqual(dump.mailbox, []);
  store.close();
});

test("delete of an active bee passes through archived on B1's graph (audited)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  store.deleteBee(bee.id);
  const kinds = store.auditRows().map((r) => r.kind);
  const archIdx = kinds.lastIndexOf("bee.archived");
  const delIdx = kinds.lastIndexOf("bee.deleted");
  assert.ok(archIdx !== -1 && delIdx === archIdx + 1);
  store.close();
});

test("revive: only from stopped; reviving an archived bee unarchives it", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  assert.throws(() => store.reviveBee(bee.id), IllegalTransitionError); // booting is live
  bootToRunning(store, bee.id, 3, 3);
  assert.throws(() => store.reviveBee(bee.id), IllegalTransitionError);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
  store.archiveBee(bee.id);
  const rt = store.reviveBee(bee.id);
  assert.equal(rt.generation, 2);
  assert.equal(rt.state, "booting");
  assert.equal(store.getBee(bee.id)?.lifecycle, "active");
  store.close();
});

test("exit causes: required on stopped, rejected elsewhere", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  assert.throws(() => store.updateRuntimeState(bee.id, 1, "stopped"), IllegalTransitionError);
  assert.throws(
    () => store.updateRuntimeState(bee.id, 1, "running", { exitCause: "clean", pid: 1, pidStartedAt: 1 }),
    IllegalTransitionError,
  );
  store.close();
});

test("boot requeue touches only running commands", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  const { bee } = makeBee(store);
  const done = store.enqueueCommand("stop", bee.id);
  store.claimNextCommand();
  store.completeCommand(done.id);
  const queued = store.enqueueCommand("archive", bee.id);
  const running = store.enqueueCommand("unarchive", bee.id);
  store.claimNextCommand(); // claims `queued` (archive) — order by id
  store.claimNextCommand(); // claims `running` (unarchive)
  store.completeCommand(queued.id);
  store.close();

  store = h.open();
  assert.equal(store.getCommand(done.id)?.status, "done");
  assert.equal(store.getCommand(queued.id)?.status, "done");
  assert.equal(store.getCommand(running.id)?.status, "queued"); // reverted for replay
  store.close();
});

test("currentRuntime is the highest generation; generations are append-only history", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const { bee } = makeBee(store);
  for (let generation = 1; generation <= 3; generation++) {
    store.updateRuntimeState(bee.id, generation, "stopped", { exitCause: "crashed" });
    if (generation < 3) store.reviveBee(bee.id);
  }
  assert.equal(store.currentRuntime(bee.id)?.generation, 3);
  assert.deepEqual(store.listRuntimes(bee.id).map((r) => r.generation), [1, 2, 3]);
  assert.ok(store.listRuntimes(bee.id).every((r) => r.state === "stopped"));
  store.close();
});

test("createBee rejects duplicate ids; bee ops on unknown ids are bee-not-found", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  store.createBee({ id: "fixed", name: "a", agent: "claude", substrate: "tmux", cwd: "/t" });
  assert.throws(
    () => store.createBee({ id: "fixed", name: "b", agent: "claude", substrate: "tmux", cwd: "/t" }),
    CoreError,
  );
  assert.throws(() => store.setFlag("ghost", "auth_needed", "x"), BeeNotFoundError);
  assert.throws(() => store.enqueueCommand("stop", "ghost"), BeeNotFoundError);
  assert.throws(() => store.recordOutput("ghost"), BeeNotFoundError);
  store.close();
});

test("claim skips commands whose backoff is still in the future", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open({ maxAttempts: 3, backoffBaseMs: 1_000_000_000 });
  const { bee } = makeBee(store);
  const delayed = store.enqueueCommand("stop", bee.id);
  store.claimNextCommand();
  store.reportCommandFailure(delayed.id, "resource_blocked"); // far-future retry
  const later = store.enqueueCommand("archive", bee.id);
  assert.equal(store.claimNextCommand()?.id, later.id); // delayed one doesn't block the queue
  store.close();
});

test("pid at spawn: a mid-boot runtime survives daemon restart via re-adoption (WP2 finding)", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  const input = { agent: "codex", substrate: "hsr", cwd: "/tmp" } as const;
  const withProc = store.createBee({ ...input, name: "early-pid", proc: { pid: 900, pidStartedAt: 7 } });
  const withoutProc = store.createBee({ ...input, name: "no-pid" });
  assert.equal(withProc.runtime.pid, 900);
  assert.equal(withoutProc.runtime.pid, null);
  store.close();

  // Daemon restart while both are still booting; the spawned process 900 is alive.
  store = h.open();
  const result = store.reconcileAtBoot([{ pid: 900, startedAt: 7 }]);
  assert.deepEqual(result.adopted, [{ beeId: withProc.bee.id, generation: 1, pid: 900 }]);
  assert.equal(store.currentRuntime(withProc.bee.id)?.state, "booting"); // re-adopted mid-boot
  const orphaned = store.currentRuntime(withoutProc.bee.id);
  assert.equal(orphaned?.state, "stopped"); // pid-less booting row cannot be adopted
  assert.equal(orphaned?.exitCause, "machine_restart");

  // revive can also carry early process identity
  const gen2 = store.reviveBee(withoutProc.bee.id, { proc: { pid: 901, pidStartedAt: 9 } });
  assert.equal(gen2.pid, 901);
  store.close();
});

test("audit reads are boundable: LIMIT'd ascending rows and a real SQL tail (2026-08-21 flush stall)", () => {
  const store = openCoreStore(":memory:");
  const a = makeBee(store, "aud-a").bee;
  const b = makeBee(store, "aud-b").bee;
  // A healthy spread of audit rows across two bees.
  for (let i = 0; i < 6; i += 1) {
    store.send(i % 2 === 0 ? a.id : b.id, `m${i}`, { sender: "operator" });
  }
  const all = store.auditRows();
  assert.ok(all.length >= 8, `expected a real backlog, got ${all.length}`);

  // Bounded ascending read returns exactly the first N past the cursor —
  // the watch flush fetches maxBatch+1 to detect gaps without a full scan.
  const bounded = store.auditRows(0, 3);
  assert.equal(bounded.length, 3);
  assert.deepEqual(bounded.map((r) => r.seq), all.slice(0, 3).map((r) => r.seq));

  // Tail: the LAST n rows, ascending, equivalent to the old read-everything-
  // then-slice(-n) — without materializing the table.
  const tail = store.auditTail(0, 4);
  assert.deepEqual(tail.map((r) => r.seq), all.slice(-4).map((r) => r.seq));

  // Tail filtered to one bee matches the JS-filtered equivalent.
  const beeTail = store.auditTail(0, 2, a.id);
  const expected = all.filter((r) => r.beeId === a.id).slice(-2);
  assert.deepEqual(beeTail.map((r) => r.seq), expected.map((r) => r.seq));

  // afterSeq cursors bound both shapes.
  const mid = all[Math.floor(all.length / 2)]!.seq;
  assert.ok(store.auditRows(mid, 100).every((r) => r.seq > mid));
  assert.ok(store.auditTail(mid, 100).every((r) => r.seq > mid));
  store.close();
});

test("flags: a provider-declared reset expires resource_blocked at the instant; open-ended flags wait for contrary evidence", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    const resetsAt = 1_800_000_000_000;
    const row = store.setFlag(bee.id, "resource_blocked", "claude rate limit rejected", { resetsAt });
    assert.equal(row.resetsAt, resetsAt);
    const { bee: other } = makeBee(store, "other");
    store.setFlag(other.id, "resource_blocked", "API Error: 529 Overloaded"); // no declared reset

    assert.deepEqual(store.expireFlags(resetsAt - 1), [], "never before the declared instant");
    assert.equal(store.activeFlags(bee.id).length, 1);

    // Newer evidence replaces the expiry (the provider re-reports the wall).
    const later = resetsAt + 60_000;
    assert.equal(store.setFlag(bee.id, "resource_blocked", "claude rate limit rejected (again)", { resetsAt: later }).resetsAt, later);
    assert.deepEqual(store.expireFlags(resetsAt), [], "the replaced expiry governs");

    const due = store.expireFlags(later);
    assert.deepEqual(due.map((f) => [f.beeId, f.flag]), [[bee.id, "resource_blocked"]]);
    assert.deepEqual(store.activeFlags(bee.id), []);
    assert.equal(store.activeFlags(other.id).length, 1, "no declared reset → only contrary evidence clears");
    const cleared = store.auditRows().filter((e) => e.kind === "flag.cleared" && e.beeId === bee.id);
    assert.equal(cleared.length, 1);
    assert.match(String((cleared[0]!.payload as { detail: string }).detail), /provider-declared reset 2027-01-15T08:01:00\.000Z passed/);
    assert.deepEqual(store.expireFlags(later + 1), [], "idempotent");
  } finally {
    store.close();
    h.cleanup();
  }
});

test("v17.migration: a v16 store gains flags.resets_at and open rate-limit rows are backfilled from the adapter's textual reset hint", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '16');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at) VALUES('old-1','old','claude','hsr','/tmp','active',5);
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at) VALUES('old-2','old2','claude','hsr','/tmp','active',5);
      CREATE TABLE runtimes (
        bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK (generation >= 1),
        state TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
        exit_cause TEXT, pid INTEGER, pid_started_at INTEGER, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (bee_id, generation)
      ) STRICT;
      INSERT INTO runtimes(bee_id, generation, state, exit_cause, started_at, updated_at) VALUES('old-1', 1, 'stopped', 'stopped_by_system', 5, 6);
      INSERT INTO runtimes(bee_id, generation, state, exit_cause, started_at, updated_at) VALUES('old-2', 1, 'stopped', 'stopped_by_system', 5, 6);
      CREATE TABLE flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
        flag TEXT NOT NULL CHECK (flag IN ('auth_needed','resource_blocked','spawn_failed','node_unreachable')),
        detail TEXT NOT NULL, set_at INTEGER NOT NULL, cleared_at INTEGER
      ) STRICT;
      INSERT INTO flags(bee_id, flag, detail, set_at) VALUES('old-1','resource_blocked','claude rate limit rejected, resets 2026-09-01T15:10:00.000Z', 7);
      INSERT INTO flags(bee_id, flag, detail, set_at) VALUES('old-2','resource_blocked','API Error: 529 Overloaded. This is a server-side issue', 7);
      INSERT INTO flags(bee_id, flag, detail, set_at, cleared_at) VALUES('old-2','resource_blocked','claude rate limit rejected, resets 2026-08-01T00:00:00.000Z', 7, 8);
    `);
    db.close();
    const store = h.open();
    const declared = Date.parse("2026-09-01T15:10:00.000Z");
    assert.equal(store.activeFlags("old-1")[0]?.resetsAt, declared, "backfilled from the textual hint");
    assert.equal(store.activeFlags("old-2")[0]?.resetsAt, null, "no hint → open-ended");
    assert.deepEqual(store.expireFlags(declared - 1), []);
    assert.deepEqual(store.expireFlags(declared).map((f) => f.beeId), ["old-1"]);
    assert.deepEqual(store.activeFlags("old-1"), []);
    assert.equal(store.activeFlags("old-2").length, 1);
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});
