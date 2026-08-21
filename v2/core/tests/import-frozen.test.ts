/**
 * WP7 importer (spec 07 B3/B4, §F) — core tier: selection rules with exact
 * reasons, old→v2 field mapping (provider session id, harness home env,
 * session-log pointer, substrate, tags, preserved id + createdAt),
 * provenance, idempotent re-run, dry-run, marker requirement, the A2
 * preflight refusal (daemon lock / hsr host+child / tmux launcher+session)
 * and `--force`, `freezeRoot` semantics, and the v3 store surface the daemon's
 * revive path reads (recordProviderSessionId + audit replay + v2→v3 migration).
 *
 * All against mkdtemp fixtures; nothing under ~/.hive is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FROZEN_MARKER,
  SCHEMA_VERSION,
  freezeRoot,
  importFromFrozen,
  mapSubstrate,
  parseFrozenRecord,
  planFrozenImport,
  readFrozenSessions,
  replayAudit,
  resumeModeFor,
  type ImportPlanEntry,
  type PreflightProbes,
} from "../src/index.ts";
import { harness } from "./helpers.ts";
import {
  CLAUDE_HSR_SESSION_ID,
  CODEX_HSR_THREAD_ID,
  CODEX_TMUX_THREAD_ID,
  claudeHsrRecord,
  codexHsrRecord,
  codexTmuxRecord,
  deadProbes,
  hsrMeta,
  makeFrozenFixture,
} from "./frozen-fixture.ts";

function entry(entries: ImportPlanEntry[], id: string): ImportPlanEntry {
  const e = entries.find((x) => x.originalId === id);
  assert.ok(e, `plan entry for ${id}`);
  return e;
}

test("import.1: selection — active bees import with exact resume modes; done/kill_failed/archived/zombie/remote/unsupported/unparsable skip with reasons", () => {
  const fx = makeFrozenFixture();
  const h = harness();
  try {
    fx.writeMarker();
    fx.writeRecord("apiary-waggle-msx67afb-1.json", claudeHsrRecord(fx.root));
    fx.writeRecord("xr-dfc1452083e3.json", codexHsrRecord(fx.root));
    fx.writeRecord("CO.2232.json", codexTmuxRecord(fx.root));
    // codex tmux, live at ~, no session id: active but nothing to resume → import as FRESH
    fx.writeRecord("CO.19fa.json", codexTmuxRecord(fx.root, { id: "CO.19fa", name: "CO.19fa", cwd: "/tmp", providerSessionId: undefined, transcriptPath: undefined, title: undefined, lastObservedState: "ready" }));
    // codex tmux crashed at ~, no session id, no transcript → zombie
    fx.writeRecord("CO.2421.json", codexTmuxRecord(fx.root, { id: "CO.2421", name: "CO.2421", cwd: "/tmp", providerSessionId: undefined, transcriptPath: undefined, lastObservedState: "crashed" }));
    // codex tmux crashed WITH a session id → import (crash is runtime death; the conversation continues)
    fx.writeRecord("CO.6986.json", codexTmuxRecord(fx.root, { id: "CO.6986", name: "CO.6986", lastObservedState: "crashed" }));
    // grok tmux crashed no sid → zombie AND unsupported; zombie wins (checked first, it is the operator-visible truth)
    fx.writeRecord("GR.616c.json", codexTmuxRecord(fx.root, { id: "GR.616c", name: "GR.616c", agent: "grok", cwd: "/tmp", providerSessionId: undefined, transcriptPath: undefined, lastObservedState: "crashed" }));
    // grok live-ish with a transcript → unsupported_agent on a node without a grok agent spec
    fx.writeRecord("GR.live.json", codexTmuxRecord(fx.root, { id: "GR.live", name: "GR.live", agent: "grok", lastObservedState: "ready" }));
    fx.writeRecord("done.json", claudeHsrRecord(fx.root, { id: "CL.done", name: "done-bee", status: "done" }));
    fx.writeRecord("dead.json", claudeHsrRecord(fx.root, { id: "CL.dead", name: "dead-bee", status: "dead" }));
    fx.writeRecord("kf.json", claudeHsrRecord(fx.root, { id: "CL.kf", name: "kf-bee", status: "kill_failed", lastObservedState: "kill_failed" }));
    fx.writeRecord("archived.json", claudeHsrRecord(fx.root, { id: "CL.arch", name: "arch-bee", stateMachine: { lifecycle: "archived", runtime: "parked", work: "done", revision: 1, transitionedAt: "2026-08-18T00:00:00Z" } }));
    fx.writeRecord("remote.json", claudeHsrRecord(fx.root, { id: "CL.remote", name: "remote-bee", node: "metal-3" }));
    fx.writeRecord("nocwd.json", claudeHsrRecord(fx.root, { id: "CL.nocwd", name: "nocwd-bee", cwd: undefined }));
    fx.writeRecord("gonecwd.json", claudeHsrRecord(fx.root, { id: "CL.gone", name: "gone-bee", cwd: join(fx.root, "no-such-dir") }));
    fx.writeRaw("broken.json", "{ this is not json");
    fx.writeRaw("array.json", "[1,2,3]");

    const store = h.open();
    const report = importFromFrozen(store, fx.root, { dryRun: true, knownAgents: ["claude", "codex", "stub"], probes: deadProbes });
    assert.equal(report.refusal, null);
    assert.equal(report.applied, false, "dry-run writes nothing");
    assert.equal(store.listBees().length, 0);
    const e = report.plan.entries;

    assert.equal(entry(e, "CL.fe6f").action, "import");
    assert.equal(entry(e, "CL.fe6f").resume, "harness_native");
    assert.equal(entry(e, "CO.3ae1").resume, "harness_native");
    assert.equal(entry(e, "CO.2232").resume, "harness_native");
    assert.equal(entry(e, "CO.6986").action, "import");
    assert.equal(entry(e, "CO.19fa").action, "import");
    assert.equal(entry(e, "CO.19fa").resume, "fresh_no_session_id");
    assert.equal(entry(e, "CO.2421").reason, "zombie_no_history");
    assert.equal(entry(e, "GR.616c").reason, "zombie_no_history");
    assert.equal(entry(e, "GR.live").reason, "unsupported_agent");
    assert.equal(entry(e, "CL.done").reason, "done");
    assert.equal(entry(e, "CL.dead").reason, "done");
    assert.equal(entry(e, "CL.kf").reason, "kill_failed");
    assert.equal(entry(e, "CL.arch").reason, "archived");
    assert.equal(entry(e, "CL.remote").reason, "remote_node");
    assert.equal(entry(e, "CL.nocwd").reason, "unusable_record");
    assert.equal(entry(e, "CL.gone").reason, "cwd_missing");
    const unparsable = e.filter((x) => x.reason === "unparsable");
    assert.equal(unparsable.length, 2, "broken json + non-object");

    assert.equal(report.plan.counts.import, 5);
    assert.equal(report.plan.counts.skip, 12);
    assert.deepEqual(report.plan.counts.byResume, { harness_native: 4, fresh_no_session_id: 1 });
    assert.equal(report.plan.counts.byReason.zombie_no_history, 2);
    store.close();
  } finally {
    fx.cleanup();
    h.cleanup();
  }
});

test("import.2: mapping — id preserved, provider session id + harness home env, session log = transcriptPath, substrate, tags, createdAt, provenance audit; runtime 1 stopped; revive mints gen 2", () => {
  const fx = makeFrozenFixture();
  const h = harness();
  try {
    fx.writeMarker();
    fx.writeRecord("a.json", claudeHsrRecord(fx.root));
    fx.writeRecord("b.json", codexHsrRecord(fx.root));
    fx.writeRecord("c.json", codexTmuxRecord(fx.root));
    const store = h.open();
    const report = importFromFrozen(store, fx.root, { probes: deadProbes, now: () => 1_700_000_000_000 });
    assert.equal(report.applied, true, report.refusal ?? "");
    assert.deepEqual(
      report.imported.map((i) => [i.beeId, i.resume]),
      [
        ["CL.fe6f", "harness_native"],
        ["CO.3ae1", "harness_native"],
        ["CO.2232", "harness_native"],
      ],
    );

    const claude = store.getBee("CL.fe6f");
    assert.ok(claude);
    assert.equal(claude.name, "apiary-waggle-msx67afb-1");
    assert.equal(claude.agent, "claude");
    assert.equal(claude.substrate, "hsr");
    assert.equal(claude.cwd, join(fx.root, "cwd-apiary"));
    assert.equal(claude.title, "Optimize Apiary core performance");
    assert.deepEqual(claude.tags, ["apiary:workspace=ws-a33e3761-4c6d-4f37-a8f5-b0562e07662e"]);
    assert.equal(claude.providerSessionId, CLAUDE_HSR_SESSION_ID);
    assert.equal(claude.sessionLogPath, join(fx.root, "homes", "claude-fixture-account", "projects", "-tmp-fixture-apiary", `${CLAUDE_HSR_SESSION_ID}.jsonl`));
    assert.deepEqual(claude.env, { CLAUDE_CONFIG_DIR: join(fx.root, "homes", "claude-fixture-account") });
    assert.equal(claude.importedFrom, "frozen");
    assert.equal(claude.createdAt, Date.parse("2026-08-17T11:48:37.633Z"));
    assert.equal(claude.lifecycle, "active");
    const rt = store.currentRuntime("CL.fe6f");
    assert.equal(rt?.generation, 1);
    assert.equal(rt?.state, "stopped");
    assert.equal(rt?.exitCause, "stopped_by_system");
    const view = store.view("CL.fe6f");
    assert.equal(view.reachable, true, "an imported bee is reachable (contract §4.4)");

    const codex = store.getBee("CO.3ae1");
    assert.equal(codex?.providerSessionId, CODEX_HSR_THREAD_ID);
    assert.deepEqual(codex?.env, { CODEX_HOME: join(fx.root, "homes", "codex-fixture-account") });
    assert.equal(codex?.substrate, "hsr");
    assert.deepEqual(codex?.tags, ["apiary:workspace=ws-cc64dd8f-c81a-4fc4-a449-e146d3ad24a5", "apiary:workspace=ws-d80b1dc7-b656-4ce7-9898-8ff46a2719bd"]);

    const tmux = store.getBee("CO.2232");
    assert.equal(tmux?.substrate, "tmux", "absent old substrate = local-tmux → v2 tmux");
    assert.equal(tmux?.providerSessionId, CODEX_TMUX_THREAD_ID);

    // provenance: the bee.imported audit row carries the old record's facts
    const prov = store.auditRows().filter((r) => r.kind === "bee.imported" && r.beeId === "CL.fe6f");
    assert.equal(prov.length, 1);
    assert.equal(prov[0]?.payload.imported_from, "frozen");
    assert.equal(prov[0]?.payload.originalId, "CL.fe6f");
    assert.equal(prov[0]?.payload.accountId, "claude-fixture-account");
    assert.equal(prov[0]?.payload.providerSessionIdSource, "record");
    assert.equal(prov[0]?.payload.resume, "harness_native");
    assert.equal(prov[0]?.payload.importedAt, 1_700_000_000_000);

    // audit replay reproduces the imported state exactly (test 13 discipline)
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());

    // revive-on-message path: send enqueues a wake; reviveBee mints generation 2 with the id still on the bee
    const sent = store.send("CL.fe6f", "are you still there?");
    assert.ok(sent.wakeCommand, "no live runtime → send_wake enqueued");
    const gen2 = store.reviveBee("CL.fe6f");
    assert.equal(gen2.generation, 2);
    assert.equal(store.getBee("CL.fe6f")?.providerSessionId, CLAUDE_HSR_SESSION_ID);
    store.close();
  } finally {
    fx.cleanup();
    h.cleanup();
  }
});

test("import.3: idempotent — a re-run skips every imported id as already_imported (no dupes); a v2-born id collision is refused per-record", () => {
  const fx = makeFrozenFixture();
  const h = harness();
  try {
    fx.writeMarker();
    fx.writeRecord("a.json", claudeHsrRecord(fx.root));
    fx.writeRecord("b.json", codexHsrRecord(fx.root));
    fx.writeRecord("c.json", codexHsrRecord(fx.root, { id: "CO.native", name: "native" }));
    const store = h.open();
    // a v2-born bee already holds CO.native
    store.createBee({ id: "CO.native", name: "mine", agent: "codex", substrate: "hsr", cwd: "/tmp" });
    const first = importFromFrozen(store, fx.root, { probes: deadProbes });
    assert.equal(first.applied, true);
    assert.equal(first.imported.length, 2);
    assert.equal(first.plan.entries.find((e) => e.originalId === "CO.native")?.reason, "id_collision");
    const before = store.dumpState();
    const second = importFromFrozen(store, fx.root, { probes: deadProbes });
    assert.equal(second.applied, true);
    assert.equal(second.imported.length, 0);
    assert.equal(second.plan.counts.byReason.already_imported, 2);
    assert.equal(second.plan.counts.byReason.id_collision, 1);
    assert.deepEqual(store.dumpState(), before, "re-run changed nothing");
    assert.equal(store.listBees().length, 3);
    store.close();
  } finally {
    fx.cleanup();
    h.cleanup();
  }
});

test("import.4: marker required — refuses without <root>/FROZEN, and never writes into the frozen root", () => {
  const fx = makeFrozenFixture();
  const h = harness();
  try {
    fx.writeRecord("a.json", claudeHsrRecord(fx.root));
    const store = h.open();
    const report = importFromFrozen(store, fx.root, { probes: deadProbes });
    assert.equal(report.applied, false);
    assert.match(report.refusal ?? "", /FROZEN.*missing.*hive v2 freeze/);
    assert.equal(report.preflight.markerPresent, false);
    assert.equal(store.listBees().length, 0);
    assert.equal(existsSync(join(fx.root, FROZEN_MARKER)), false, "import did not create the marker");
    // no store at all → refused with a pointer
    const none = importFromFrozen(store, join(fx.root, "nope"), { probes: deadProbes });
    assert.match(none.refusal ?? "", /no old-world store/);
    store.close();
  } finally {
    fx.cleanup();
    h.cleanup();
  }
});

test("import.5: A2 preflight — live old daemon / hsr host+child / tmux launcher / tmux session refuse with exact detail; --force imports anyway; parked kill_failed pids are not probed", () => {
  const fx = makeFrozenFixture();
  const h = harness();
  try {
    fx.writeMarker();
    fx.writeRecord("a.json", claudeHsrRecord(fx.root)); // runnerPid 24394
    fx.writeHsrMeta("apiary-waggle-msx67afb-1", hsrMeta("apiary-waggle-msx67afb-1", "claude", CLAUDE_HSR_SESSION_ID, 7530)); // host 7530, child 7570
    fx.writeRecord("c.json", codexTmuxRecord(fx.root)); // launcherPgid 95736, tmuxTarget CO-2232
    fx.writeRecord("kf.json", claudeHsrRecord(fx.root, { id: "CL.kf", name: "kf-bee", status: "kill_failed", runnerPid: 4242 }));
    fx.writeDaemonLock({ pid: 71440, startedAt: "2026-08-17T12:22:29.035Z" });

    const probed: Array<[number, number | null]> = [];
    const alive = new Set([71440, 24394, 7570, 95736]);
    const probes: PreflightProbes = {
      pidLive: (pid, startedAt) => {
        probed.push([pid, startedAt]);
        return alive.has(pid);
      },
      tmuxSessionLive: (t) => t === "CO-2232",
    };
    const store = h.open();
    const report = importFromFrozen(store, fx.root, { probes });
    assert.equal(report.applied, false);
    assert.equal(report.preflight.ok, false);
    const kinds = report.preflight.live.map((l) => l.kind).sort();
    assert.deepEqual(kinds, ["hsr_child", "hsr_host", "old_daemon", "tmux_launcher", "tmux_session"]);
    assert.match(report.refusal ?? "", /old daemon pid 71440 is alive/);
    assert.match(report.refusal ?? "", /hsr runner pid 24394 is alive \(bee CL\.fe6f/);
    assert.match(report.refusal ?? "", /hsr child pid 7570/);
    assert.match(report.refusal ?? "", /tmux launcher pid 95736/);
    assert.match(report.refusal ?? "", /tmux session 'CO-2232' exists/);
    // start-time stamps were handed to the probe (lock ISO, ps-lstart fingerprints)
    assert.ok(probed.some(([pid, at]) => pid === 71440 && at === Date.parse("2026-08-17T12:22:29.035Z")));
    assert.ok(probed.some(([pid, at]) => pid === 24394 && at === Date.parse("Tue Aug 18 07:42:57 2026")));
    assert.ok(!probed.some(([pid]) => pid === 4242), "kill_failed pids are not probed");
    assert.equal(store.listBees().length, 0);

    // dry-run still reports the preflight but is not "refused" from listing the plan
    const dry = importFromFrozen(store, fx.root, { probes, dryRun: true });
    assert.equal(dry.plan.counts.import, 2);
    assert.equal(dry.preflight.live.length, 5);

    // --force
    const forced = importFromFrozen(store, fx.root, { probes, force: true });
    assert.equal(forced.applied, true);
    assert.equal(forced.imported.length, 2);
    assert.equal(forced.preflight.ok, false, "the report still tells the operator what was live");
    store.close();
  } finally {
    fx.cleanup();
    h.cleanup();
  }
});

test("import.6: session id fallback from hsr/<name>/meta.json when the record lacks it; unknown home env is noted, not applied", () => {
  const fx = makeFrozenFixture();
  const h = harness();
  try {
    fx.writeMarker();
    fx.writeRecord("a.json", codexHsrRecord(fx.root, { providerSessionId: undefined }));
    fx.writeHsrMeta("xr-dfc1452083e3", hsrMeta("xr-dfc1452083e3", "codex", "thread-from-meta"));
    fx.writeRecord("b.json", codexTmuxRecord(fx.root, { id: "PI.1", name: "pi-bee", agent: "pi", homePath: "/tmp/pi-home" }));
    const store = h.open();
    const report = importFromFrozen(store, fx.root, { probes: deadProbes });
    assert.equal(report.applied, true);
    const codex = store.getBee("CO.3ae1");
    assert.equal(codex?.providerSessionId, "thread-from-meta");
    const codexEntry = report.plan.entries.find((e) => e.originalId === "CO.3ae1");
    assert.ok(codexEntry?.notes.some((n) => n.includes("meta.json")));
    const pi = store.getBee("PI.1");
    assert.deepEqual(pi?.env, {}, "no known home env var for pi → nothing applied");
    assert.equal(report.plan.entries.find((e) => e.originalId === "PI.1")?.resume, "fresh_no_resume_path");
    store.close();
  } finally {
    fx.cleanup();
    h.cleanup();
  }
});

test("import.7: freezeRoot — writes the marker once, refuses while the old daemon lock pid is alive, --force overrides, idempotent, refuses a non-store", () => {
  const fx = makeFrozenFixture();
  try {
    fx.writeDaemonLock({ pid: 71440, startedAt: "2026-08-17T12:22:29.035Z" });
    const alive: PreflightProbes = { pidLive: (pid) => pid === 71440, tmuxSessionLive: () => false };
    const refused = freezeRoot(fx.root, { probes: alive });
    assert.equal(refused.outcome, "refused");
    assert.match(refused.refusal ?? "", /old daemon pid 71440 is alive/);
    assert.equal(existsSync(join(fx.root, FROZEN_MARKER)), false);

    const forced = freezeRoot(fx.root, { probes: alive, force: true, now: () => Date.parse("2026-08-18T10:00:00Z"), by: "test" });
    assert.equal(forced.outcome, "written");
    const marker = JSON.parse(readFileSync(join(fx.root, FROZEN_MARKER), "utf8")) as { frozenAt: string; by: string };
    assert.equal(marker.frozenAt, "2026-08-18T10:00:00.000Z");
    assert.equal(marker.by, "test");

    const again = freezeRoot(fx.root, { probes: deadProbes });
    assert.equal(again.outcome, "already_frozen");
    assert.equal(readFileSync(join(fx.root, FROZEN_MARKER), "utf8").includes('"by": "test"'), true, "existing marker untouched");

    const dead = freezeRoot(fx.root + "-missing", { probes: deadProbes });
    assert.equal(dead.outcome, "refused");
  } finally {
    fx.cleanup();
  }
});

test("import.8: pure helpers — parseFrozenRecord, mapSubstrate, resumeModeFor, readFrozenSessions ordering", () => {
  const fx = makeFrozenFixture();
  try {
    assert.equal(mapSubstrate("hsr"), "hsr");
    assert.equal(mapSubstrate("local-tmux"), "tmux");
    assert.equal(mapSubstrate(null), "tmux");
    assert.equal(resumeModeFor("claude", "x"), "harness_native");
    assert.equal(resumeModeFor("codex", null), "fresh_no_session_id");
    assert.equal(resumeModeFor("grok", "x"), "fresh_no_resume_path");
    const parsed = parseFrozenRecord("/p", claudeHsrRecord(fx.root));
    assert.ok("record" in parsed);
    assert.equal(parsed.record.runnerStartedAt, Date.parse("Tue Aug 18 07:42:57 2026"));
    assert.equal(parsed.record.lifecycle, "active");
    const noId = parseFrozenRecord("/p", claudeHsrRecord(fx.root, { id: undefined, uuid: undefined }));
    assert.ok("record" in noId && noId.record.id === "apiary-waggle-msx67afb-1", "id falls back to uuid then name");
    const bad = parseFrozenRecord("/p", "nope");
    assert.ok("reason" in bad && bad.reason === "unparsable");
    fx.writeRecord("b.json", codexHsrRecord(fx.root));
    fx.writeRecord("a.json", claudeHsrRecord(fx.root));
    fx.writeRaw("notes.txt", "ignored");
    const read = readFrozenSessions(fx.root);
    assert.deepEqual(read.records.map((r) => r.id), ["CL.fe6f", "CO.3ae1"], "sorted by file name; non-json ignored");
    assert.equal(readFrozenSessions(join(fx.root, "missing")).records.length, 0);
    const plan = planFrozenImport(read, { frozenRoot: fx.root, existing: () => null, hsrMeta: () => null });
    assert.equal(plan.counts.import, 2);
  } finally {
    fx.cleanup();
  }
});

test("import.9: store v3 — recordProviderSessionId is bee-scoped, idempotent, audited + replayable; env/importedFrom round-trip; v2 store migrates additively", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = store.createBee({ name: "w", agent: "claude", substrate: "hsr", cwd: "/tmp", env: { CLAUDE_CONFIG_DIR: "/tmp/h" } });
    assert.equal(bee.providerSessionId, null);
    assert.deepEqual(bee.env, { CLAUDE_CONFIG_DIR: "/tmp/h" });
    assert.equal(bee.importedFrom, null);
    assert.equal(store.recordProviderSessionId(bee.id, "sid-1").applied, true);
    assert.equal(store.recordProviderSessionId(bee.id, "sid-1").applied, false, "same value = silent no-op");
    assert.equal(store.recordProviderSessionId(bee.id, "sid-2").applied, true);
    assert.equal(store.getBee(bee.id)?.providerSessionId, "sid-2");
    assert.equal(store.auditRows().filter((r) => r.kind === "bee.provider_session").length, 2);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    assert.throws(() => store.recordProviderSessionId(bee.id, ""), /non-empty/);
    assert.throws(() => store.recordProviderSessionId("ghost", "x"), /bee not found/);
    store.close();
  } finally {
    h.cleanup();
  }

  // v2-shaped store (bees without the v3 columns) migrates on open.
  const h2 = harness();
  try {
    const db = new DatabaseSync(h2.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '2');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at) VALUES('old-1','old','claude','hsr','/tmp','active',5);
    `);
    db.close();
    const store = h2.open();
    const old = store.getBee("old-1");
    assert.equal(old?.providerSessionId, null);
    assert.deepEqual(old?.env, {});
    assert.equal(old?.importedFrom, null);
    assert.equal(old?.spawnFailures, 0); // v4 column, defaulted by the migration
    assert.equal(old?.args, null); // v5 column, NULL by the migration
    store.recordProviderSessionId("old-1", "after-migration");
    store.close();
    const check = new DatabaseSync(h2.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 11);
    } finally {
      check.close();
    }
  } finally {
    h2.cleanup();
  }
});
