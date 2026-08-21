/**
 * Schema v6 — the pre-flip verb set at the core tier: rename, tag,
 * parenting (parent_id + orphan-on-delete policy), fork provenance + the
 * one-shot fork seed, questions (ask → open → answer → delivered as mail),
 * seals, the v5 → v6 migration, and audit replay for every new kind.
 * Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CoreError,
  QuestionNotFoundError,
  QuestionNotOpenError,
  SCHEMA_VERSION,
  SealNotFoundError,
  replayAudit,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

test("setBeeTitle: sets title, audits bee.titled with previous, replays; identical = silent no-op; empty refused", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "apiary-waggle-1");
    const r1 = store.setBeeTitle(bee.id, "Fix auto-titling");
    assert.equal(r1.applied, true);
    assert.equal(r1.bee.title, "Fix auto-titling");
    const r2 = store.setBeeTitle(bee.id, "Fix auto-titling");
    assert.equal(r2.applied, false);
    const rows = store.auditRows().filter((r) => r.kind === "bee.titled");
    assert.equal(rows.length, 1, "no audit row for the no-op");
    assert.deepEqual(rows[0]?.payload, {
      beeId: bee.id,
      title: "Fix auto-titling",
      previous: null,
      source: "auto",
    });
    assert.throws(() => store.setBeeTitle(bee.id, ""), CoreError);
    assert.throws(() => store.setBeeTitle("nope", "x"), CoreError);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v6.rename: renames, audits bee.renamed with previous, replays; identical = silent no-op; empty refused", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    const r1 = store.renameBee(bee.id, "worker-2");
    assert.equal(r1.applied, true);
    assert.equal(r1.bee.name, "worker-2");
    const r2 = store.renameBee(bee.id, "worker-2");
    assert.equal(r2.applied, false);
    const rows = store.auditRows().filter((r) => r.kind === "bee.renamed");
    assert.equal(rows.length, 1, "no audit row for the no-op");
    assert.deepEqual(rows[0]?.payload, { beeId: bee.id, name: "worker-2", previous: "worker" });
    assert.throws(() => store.renameBee(bee.id, ""), CoreError);
    assert.throws(() => store.renameBee("nope", "x"), CoreError);
    // names are labels, not identities: two bees may share one (createBee rules)
    const { bee: other } = makeBee(store, "other");
    assert.equal(store.renameBee(other.id, "worker-2").applied, true);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v6.tag: remove-then-add, order preserved, duplicates collapse, audit carries the full list; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = store.createBee({ name: "w", agent: "stub", substrate: "hsr", cwd: "/tmp", tags: ["a", "b", "c"] });
    const r1 = store.tagBee(bee.id, { add: ["d", "a", "d"], remove: ["b"] });
    assert.equal(r1.applied, true);
    assert.deepEqual(r1.bee.tags, ["a", "c", "d"]);
    assert.deepEqual(r1.added, ["d"]);
    assert.deepEqual(r1.removed, ["b"]);
    // the same tag in add AND remove: remove runs first, then add → PRESENT
    const r2 = store.tagBee(bee.id, { add: ["x"], remove: ["x"] });
    assert.deepEqual(r2.bee.tags, ["a", "c", "d", "x"]);
    const r3 = store.tagBee(bee.id, { add: ["a"] });
    assert.equal(r3.applied, false, "already present = no-op");
    const r4 = store.tagBee(bee.id, { remove: ["zzz"] });
    assert.equal(r4.applied, false, "absent = no-op");
    // apiary workspace membership is a tag: moving = remove old, add new
    const moved = store.tagBee(bee.id, { remove: ["apiary:workspace=old"], add: ["apiary:workspace=new"] });
    assert.ok(moved.bee.tags.includes("apiary:workspace=new"));
    const rows = store.auditRows().filter((r) => r.kind === "bee.tagged");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0]?.payload, { beeId: bee.id, tags: ["a", "c", "d"], previous: ["a", "b", "c"], added: ["d"], removed: ["b"] });
    assert.throws(() => store.tagBee(bee.id, { add: [1 as unknown as string] }), CoreError);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v6.parenting: parent_id at create; children read; archive parent leaves children; delete parent ORPHANS (audit bee.orphaned), never cascades; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee: parent } = makeBee(store, "parent");
    const { bee: c1 } = store.createBee({ name: "c1", agent: "stub", substrate: "hsr", cwd: "/tmp", parentId: parent.id });
    const { bee: c2 } = store.createBee({ name: "c2", agent: "stub", substrate: "hsr", cwd: "/tmp", parentId: parent.id });
    const { bee: grandchild } = store.createBee({ name: "g", agent: "stub", substrate: "hsr", cwd: "/tmp", parentId: c1.id });
    assert.equal(c1.parentId, parent.id);
    assert.deepEqual(store.listChildren(parent.id).map((b) => b.id).sort(), [c1.id, c2.id].sort());
    assert.deepEqual(store.listChildren(c1.id).map((b) => b.id), [grandchild.id]);
    // bee.created carries parentId (the mirror learns it from the row)
    const created = store.auditRows().find((r) => r.kind === "bee.created" && r.beeId === c1.id);
    assert.equal((created?.payload.bee as { parentId: string }).parentId, parent.id);

    // archive parent ≠ archive children
    store.archiveBee(parent.id);
    assert.equal(store.getBee(c1.id)?.lifecycle, "active");
    assert.equal(store.getBee(c2.id)?.lifecycle, "active");
    assert.equal(store.getBee(c1.id)?.parentId, parent.id, "archive keeps the edge");

    // delete parent → children orphaned (parent_id null), still exist, grandchild untouched
    const del = store.deleteBee(parent.id);
    assert.deepEqual(del.orphanedChildIds.sort(), [c1.id, c2.id].sort());
    assert.ok(store.getBee(c1.id) && store.getBee(c2.id), "children survive (no cascade)");
    assert.equal(store.getBee(c1.id)?.parentId, null);
    assert.equal(store.getBee(c2.id)?.parentId, null);
    assert.equal(store.getBee(grandchild.id)?.parentId, c1.id, "grandchild keeps its edge");
    assert.deepEqual(store.listChildren(parent.id), []);
    const orphaned = store.auditRows().filter((r) => r.kind === "bee.orphaned");
    assert.equal(orphaned.length, 2);
    assert.deepEqual(orphaned.map((r) => r.payload.parentId), [parent.id, parent.id]);
    assert.deepEqual(orphaned.map((r) => r.payload.reason), ["parent_deleted", "parent_deleted"]);
    // audit order: orphaning is recorded before the parent's bee.deleted
    const seqs = store.auditRows().filter((r) => r.kind === "bee.orphaned" || (r.kind === "bee.deleted" && r.beeId === parent.id)).map((r) => r.kind);
    assert.deepEqual(seqs, ["bee.orphaned", "bee.orphaned", "bee.deleted"]);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v6.fork-seed: forkedFrom/forkSeed at create; recording the fork's own session id consumes the seed (audit forkSeedConsumed); replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee: source } = makeBee(store, "src");
    store.recordProviderSessionId(source.id, "src-session");
    const { bee: fork } = store.createBee({
      name: "src-fork",
      agent: source.agent,
      substrate: source.substrate,
      cwd: source.cwd,
      parentId: source.id,
      forkedFrom: source.id,
      forkSeed: "src-session",
    });
    assert.equal(fork.forkedFrom, source.id);
    assert.equal(fork.forkSeed, "src-session");
    assert.equal(fork.providerSessionId, null, "the fork owns no session until its runtime reports one");
    store.recordFork(fork.id, source.id, "src-session");
    // the fork boots with --resume src-session --fork-session and reports a NEW id
    assert.equal(store.recordProviderSessionId(fork.id, "fork-session").applied, true);
    const after = store.getBee(fork.id)!;
    assert.equal(after.providerSessionId, "fork-session");
    assert.equal(after.forkSeed, null, "seed consumed");
    assert.equal(after.forkedFrom, source.id, "provenance stays");
    const rec = store.auditRows().find((r) => r.kind === "bee.provider_session" && r.beeId === fork.id);
    assert.equal(rec?.payload.forkSeedConsumed, "src-session");
    // source untouched
    assert.equal(store.getBee(source.id)?.providerSessionId, "src-session");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v6.questions: ask → open row (generation stamped); answer → answered + delivered as prefixed mail (+ wake when no live runtime); twice refused; unknown refused; list filters; replay; cascade on delete", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "asker");
    store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
    store.updateRuntimeState(bee.id, 1, "idle");
    const q = store.askQuestion(bee.id, { text: "merge or rebase?", options: ["merge", "rebase"] });
    assert.equal(q.status, "open");
    assert.equal(q.generation, 1);
    assert.deepEqual(q.options, ["merge", "rebase"]);
    assert.equal(q.answer, null);
    const q2 = store.askQuestion(bee.id, { text: "free-form?" });
    assert.equal(q2.options, null);
    assert.deepEqual(store.listQuestions({ open: true }).map((x) => x.id), [q.id, q2.id]);
    assert.deepEqual(store.listQuestions({ beeId: bee.id }).length, 2);
    assert.deepEqual(store.listQuestions({ beeId: "nope" }), []);

    // answer while the runtime is live: no wake needed
    const a = store.answerQuestion(q.id, "rebase", { answeredBy: "tormod" });
    assert.equal(a.question.status, "answered");
    assert.equal(a.question.answer, "rebase");
    assert.equal(a.question.answeredBy, "tormod");
    assert.equal(a.question.deliveryMessageId, a.send.message.id);
    assert.equal(a.send.wakeCommand, null);
    assert.equal(a.send.message.sender, "tormod");
    assert.ok(a.send.message.body.startsWith(`[answer to question ${q.id}] rebase`), a.send.message.body);
    assert.ok(a.send.message.body.includes("merge or rebase?"), "the delivered mail restates the question");
    assert.deepEqual(store.undeliveredMessages(bee.id).map((m) => m.id), [a.send.message.id]);
    assert.deepEqual(store.listQuestions({ open: true }).map((x) => x.id), [q2.id]);
    assert.deepEqual(store.listQuestions({ open: false }).map((x) => x.id), [q.id]);

    // answering again is refused (typed); unknown id typed
    assert.throws(() => store.answerQuestion(q.id, "merge"), QuestionNotOpenError);
    assert.throws(() => store.answerQuestion("nope", "x"), QuestionNotFoundError);
    assert.throws(() => store.askQuestion(bee.id, { text: "" }), CoreError);

    // answer while stopped: send() enqueues the wake in the same transaction
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
    const b = store.answerQuestion(q2.id, "yes");
    assert.ok(b.send.wakeCommand, "revive-on-answer: a send_wake is enqueued");
    assert.equal(b.question.answeredBy, "operator");

    // audit shapes + replay
    const asked = store.auditRows().filter((r) => r.kind === "question.asked");
    assert.equal(asked.length, 2);
    const answered = store.auditRows().filter((r) => r.kind === "question.answered");
    assert.equal(answered.length, 2);
    assert.equal(answered[0]?.payload.deliveryMessageId, a.send.message.id);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());

    // delete the bee → its questions go with it (cascade), replay agrees
    store.deleteBee(bee.id);
    assert.deepEqual(store.listQuestions(), []);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v6.seals: create ties to the current generation; list/get; refs; typed not-found; replay; cascade on delete", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "sealer");
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
    store.reviveBee(bee.id); // generation 2
    const s1 = store.createSeal(bee.id, { title: "impl done", body: "all tests green", refs: ["feat/x@abc123", "https://ci/1"] });
    assert.equal(s1.generation, 2);
    assert.deepEqual(s1.refs, ["feat/x@abc123", "https://ci/1"]);
    const s2 = store.createSeal(bee.id, { title: "review", body: "" });
    assert.deepEqual(s2.refs, []);
    assert.deepEqual(store.listSeals({ beeId: bee.id }).map((s) => s.id), [s1.id, s2.id]);
    assert.deepEqual(store.listSeals().length, 2);
    assert.equal(store.getSeal(s1.id)?.title, "impl done");
    assert.equal(store.getSeal("nope"), null);
    assert.throws(() => store.mustGetSeal("nope"), SealNotFoundError);
    assert.throws(() => store.createSeal(bee.id, { title: "", body: "" }), CoreError);
    assert.throws(() => store.createSeal("nope", { title: "t", body: "" }), CoreError);
    const rows = store.auditRows().filter((r) => r.kind === "seal.created");
    assert.equal(rows.length, 2);
    assert.deepEqual((rows[0]?.payload.seal as { id: string }).id, s1.id);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.deleteBee(bee.id);
    assert.deepEqual(store.listSeals(), []);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v6.migration: a v5 store opens as v6 — parent_id/forked_from/fork_seed added, questions/seals created, data intact, stamp bumped", () => {
  const h = harness();
  try {
    // A faithful v5 shape: stamped 5, bees through `args`, no questions/seals.
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '5');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, provider_session_id, args)
        VALUES('old-1','old','claude','hsr','/tmp','active',5,'sid-old','["--model","opus"]');
      CREATE TABLE runtimes (
        bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK (generation >= 1),
        state TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
        exit_cause TEXT, pid INTEGER, pid_started_at INTEGER, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (bee_id, generation)
      ) STRICT;
      INSERT INTO runtimes(bee_id, generation, state, exit_cause, started_at, updated_at) VALUES('old-1', 1, 'stopped', 'clean', 5, 6);
    `);
    db.close();
    const store = h.open();
    const old = store.getBee("old-1");
    assert.equal(old?.parentId, null);
    assert.equal(old?.forkedFrom, null);
    assert.equal(old?.forkSeed, null);
    assert.equal(old?.providerSessionId, "sid-old", "v3 data intact");
    assert.deepEqual(old?.args, ["--model", "opus"], "v5 data intact");
    // the new tables work on the migrated store
    const q = store.askQuestion("old-1", { text: "still there?" });
    store.answerQuestion(q.id, "yes");
    store.createSeal("old-1", { title: "t", body: "b" });
    assert.equal(store.tagBee("old-1", { add: ["migrated"] }).applied, true);
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 11);
      const cols = (check.prepare("SELECT name FROM pragma_table_info('bees')").all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of ["parent_id", "forked_from", "fork_seed", "args", "spawn_failures"]) assert.ok(cols.includes(c), c);
      const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      assert.ok(tables.includes("questions") && tables.includes("seals"));
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});

test("v6.dump: StateDump carries questions + seals; a fresh store's replay equals its dump", () => {
  const h = harness();
  try {
    const store = h.open();
    const dump = store.dumpState();
    assert.deepEqual(dump.questions, []);
    assert.deepEqual(dump.seals, []);
    assert.deepEqual(replayAudit(store.auditRows()), dump);
    store.close();
  } finally {
    h.cleanup();
  }
});
