/**
 * Per-bee spawn args (schema v5) — core tier:
 *  - `bees.args` round-trips through createBee / updateBeeArgs / reviveBee,
 *    is audited (`bee.args_set`) and replayable, identical values are no-ops
 *  - a v4-shaped store (spawn_failures present, no args column) migrates
 *    additively to v5 on open; a NEWER store is still refused
 *  - the frozen importer's keep/drop table against fixture records shaped
 *    like the real ones (claude `--model fable --effort high
 *    --dangerously-skip-permissions --session-id … --append-system-prompt …`,
 *    codex `-m gpt-5.6-sol -c model_reasoning_effort="ultra"
 *    --dangerously-bypass-approvals-and-sandbox -c service_tier=default`),
 *    the `command`-string fallback, the first-class `model` override and
 *    `modelExtraArgs`, and the dropped flags recorded in the provenance row
 *
 * All against mkdtemp fixtures; nothing under ~/.hive is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  SCHEMA_VERSION,
  SchemaVersionError,
  beeArgsFromRecord,
  extractBeeArgs,
  importFromFrozen,
  oldLaunchArgs,
  parseFrozenRecord,
  replayAudit,
  shellWords,
  type FrozenRecord,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";
import {
  CLAUDE_HSR_LAUNCH_ARGV,
  CLAUDE_HSR_SESSION_ID,
  claudeHsrRecord,
  codexHsrRecord,
  codexTmuxRecord,
  deadProbes,
  makeFrozenFixture,
} from "./frozen-fixture.ts";

test("args.1: bees.args round-trips; updateBeeArgs audits bee.args_set, no-ops on identical, null clears; reviveBee applies args in the same tx; replay matches", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = store.createBee({ name: "w", agent: "claude", substrate: "hsr", cwd: "/tmp", args: ["--model", "fable"] });
    assert.deepEqual(bee.args, ["--model", "fable"]);
    assert.equal(makeBee(store, "plain").bee.args, null, "absent = null (no per-bee args)");

    const set = store.updateBeeArgs(bee.id, ["--model", "opus", "--effort", "high"]);
    assert.equal(set.applied, true);
    assert.deepEqual(set.bee.args, ["--model", "opus", "--effort", "high"]);
    assert.equal(store.updateBeeArgs(bee.id, ["--model", "opus", "--effort", "high"]).applied, false, "identical = silent no-op");
    assert.equal(store.updateBeeArgs(bee.id, null).applied, true);
    assert.equal(store.getBee(bee.id)?.args, null);
    assert.equal(store.updateBeeArgs(bee.id, null).applied, false);
    const rows = store.auditRows().filter((r) => r.kind === "bee.args_set");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]?.payload, { beeId: bee.id, args: ["--model", "opus", "--effort", "high"], previous: ["--model", "fable"] });
    assert.deepEqual(rows[1]?.payload, { beeId: bee.id, args: null, previous: ["--model", "opus", "--effort", "high"] });

    // revive with replacement args: applied before generation N+1 is minted
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_user" });
    const rt = store.reviveBee(bee.id, { args: ["--model", "fable", "--dangerously-skip-permissions"] });
    assert.equal(rt.generation, 2);
    assert.deepEqual(store.getBee(bee.id)?.args, ["--model", "fable", "--dangerously-skip-permissions"]);
    const seqs = store.auditRows().map((r) => r.kind);
    assert.ok(seqs.lastIndexOf("bee.args_set") < seqs.lastIndexOf("runtime.created"), "args_set precedes the new generation's runtime.created");
    // reviveBee without args leaves them alone
    store.updateRuntimeState(bee.id, 2, "stopped", { exitCause: "crashed" });
    store.reviveBee(bee.id);
    assert.deepEqual(store.getBee(bee.id)?.args, ["--model", "fable", "--dangerously-skip-permissions"]);

    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    assert.throws(() => store.updateBeeArgs(bee.id, "nope" as unknown as string[]), /array of strings/);
    assert.throws(() => store.updateBeeArgs(bee.id, [1] as unknown as string[]), /array of strings/);
    assert.throws(() => store.updateBeeArgs("ghost", []), /bee not found/);
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", args: { a: 1 } as unknown as string[] }), /array of strings/);
    // empty array is a legitimate (distinct from null) value
    assert.equal(store.updateBeeArgs(bee.id, []).applied, true);
    assert.deepEqual(store.getBee(bee.id)?.args, []);
    // dumpState/list carry it
    assert.deepEqual(store.listBees().find((b) => b.id === bee.id)?.args, []);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("args.2: a v4-shaped store (spawn_failures, no args column) migrates additively to v5 on open; args NULL for old rows; newer store refused", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '4');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, provider_session_id, spawn_failures)
        VALUES('old-1','old','claude','hsr','/tmp','active',5,'sid-old',2);
    `);
    db.close();
    const store = h.open();
    const old = store.getBee("old-1");
    assert.equal(old?.args, null, "v5 column NULL for pre-v5 rows");
    assert.equal(old?.providerSessionId, "sid-old", "v3 data intact");
    assert.equal(old?.spawnFailures, 2, "v4 data intact");
    assert.equal(store.updateBeeArgs("old-1", ["--effort", "max"]).applied, true);
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 5);
      const cols = (check.prepare("SELECT name FROM pragma_table_info('bees')").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("args"));
      assert.ok(cols.includes("spawn_failures"));
      const row = check.prepare("SELECT args FROM bees WHERE id = 'old-1'").get() as { args: string };
      assert.equal(row.args, '["--effort","max"]');
    } finally {
      check.close();
    }
    // re-open (now v5) is a no-op migration; then a NEWER stamp is refused
    h.open().close();
    const bump = new DatabaseSync(h.path);
    bump.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    bump.close();
    assert.throws(() => h.open(), (err: unknown) => err instanceof SchemaVersionError && err.kind === "schema_newer");
  } finally {
    h.cleanup();
  }
});

test("args.3: keep/drop table — claude keeps --model/--effort/--dangerously-skip-permissions, drops session-id / system prompt / plumbing; codex canonicalizes -m and -c reasoning, drops service_tier & fast_mode; unknown harness drops all", () => {
  // claude, real shape (program stripped by oldLaunchArgs)
  const claude = extractBeeArgs("claude", CLAUDE_HSR_LAUNCH_ARGV.slice(1));
  assert.deepEqual(claude.args, ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high"]);
  assert.deepEqual(claude.dropped, [["--session-id", CLAUDE_HSR_SESSION_ID], ["--append-system-prompt", CLAUDE_HSR_LAUNCH_ARGV[9]]]);
  // the v2 base-args plumbing and other old flags drop; --model=x spelling accepted; later --model wins; boolean idempotent
  const claude2 = extractBeeArgs("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model=opus", "--dangerously-skip-permissions", "--permission-mode", "plan", "--dangerously-skip-permissions", "--model", "fable", "--resume", "abc", "-r", "def", "--continue", "--unknown-flag", "positional"]);
  assert.deepEqual(claude2.args, ["--dangerously-skip-permissions", "--model", "fable"]);
  assert.deepEqual(claude2.dropped, [["-p"], ["--input-format", "stream-json"], ["--output-format", "stream-json"], ["--verbose"], ["--permission-mode", "plan"], ["--resume", "abc"], ["-r", "def"], ["--continue"], ["--unknown-flag"], ["positional"]]);
  assert.equal(extractBeeArgs("claude", ["--dangerously-skip-permissions=yes"]).args, null, "an inline value on a boolean flag is not the flag");

  // codex, real shape
  const codex = extractBeeArgs("codex", ["-c", "service_tier=default", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"', "-c", "features.fast_mode=false"]);
  assert.deepEqual(codex.args, ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"']);
  assert.deepEqual(codex.dropped, [["-c", "service_tier=default"], ["-c", "features.fast_mode=false"]]);
  // spellings fold: --model=, --config, -c=, --config=; last model wins; last reasoning wins; app-server & sandbox flags drop
  const codex2 = extractBeeArgs("codex", ["app-server", "--model=gpt-5.5", "--config", 'model_reasoning_effort="high"', "-c=model_reasoning_effort=xhigh", "--full-auto", "-a", "never", "-s", "danger-full-access", "-m", "gpt-5.6-sol", "--config=service_tier=fast", "-c", "sandbox_workspace_write.network_access=true"]);
  assert.deepEqual(codex2.args, ["-c", "model_reasoning_effort=xhigh", "--model", "gpt-5.6-sol"]);
  assert.deepEqual(codex2.dropped, [["app-server"], ["--full-auto"], ["-a", "never"], ["-s", "danger-full-access"], ["--config=service_tier=fast"], ["-c", "sandbox_workspace_write.network_access=true"]]);
  assert.deepEqual(extractBeeArgs("codex", ["-c"]).dropped, [["-c"]], "dangling -c drops");
  assert.deepEqual(extractBeeArgs("codex", ["-m"]), { args: null, dropped: [["-m"]] }, "dangling -m drops");

  // other harnesses: nothing kept, everything recorded
  const grok = extractBeeArgs("grok", ["--permission-mode", "bypassPermissions", "--always-approve"]);
  assert.equal(grok.args, null);
  assert.deepEqual(grok.dropped, [["--permission-mode"], ["bypassPermissions"], ["--always-approve"]]);
});

test("args.4: oldLaunchArgs — launchArgv preferred (program stripped); command string fallback strips env prefix + program and honours quotes; shellWords", () => {
  assert.deepEqual(shellWords(`CODEX_HOME=/h codex -c 'model_reasoning_effort="high"' --model "gpt 5" a\\ b`), ["CODEX_HOME=/h", "codex", "-c", 'model_reasoning_effort="high"', "--model", "gpt 5", "a b"]);
  assert.deepEqual(shellWords(`  --x  "" y `), ["--x", "", "y"]);
  const rec = (o: Partial<FrozenRecord>): Pick<FrozenRecord, "launchArgv" | "command"> => ({ launchArgv: null, command: null, ...o });
  assert.deepEqual(oldLaunchArgs(rec({ launchArgv: ["claude", "--model", "fable"], command: "claude --model opus" })), { args: ["--model", "fable"], source: "launchArgv" });
  assert.deepEqual(oldLaunchArgs(rec({ command: "CLAUDE_CONFIG_DIR=/x/y HIVE_BEE=CL.1 claude --dangerously-skip-permissions --model opus --effort high --session-id s1" })), {
    args: ["--dangerously-skip-permissions", "--model", "opus", "--effort", "high", "--session-id", "s1"],
    source: "command",
  });
  assert.deepEqual(oldLaunchArgs(rec({ command: `CODEX_HOME=/h codex -c service_tier=default -c 'model_reasoning_effort="medium"'` })), {
    args: ["-c", "service_tier=default", "-c", 'model_reasoning_effort="medium"'],
    source: "command",
  });
  assert.equal(oldLaunchArgs(rec({ command: "ONLY_ENV=1" })), null, "no program → nothing");
  assert.equal(oldLaunchArgs(rec({})), null);
});

test("args.5: beeArgsFromRecord — first-class model overrides the argv model; modelExtraArgs layer on top through the same table; command fallback; other harness → null", () => {
  const fx = makeFrozenFixture();
  try {
    const parse = (raw: Record<string, unknown>): FrozenRecord => {
      const p = parseFrozenRecord("/p", raw);
      assert.ok("record" in p);
      return p.record;
    };
    // as recorded
    const claude = beeArgsFromRecord(parse(claudeHsrRecord(fx.root)));
    assert.deepEqual(claude.args, ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high"]);
    assert.equal(claude.provenance.argsSource, "launchArgv");
    assert.equal(claude.provenance.droppedArgs.length, 2);
    assert.equal(claude.provenance.modelOverride, null);
    // old `hive set-model opus -- --effort max`: model + extra flags override
    const claudeSet = beeArgsFromRecord(parse(claudeHsrRecord(fx.root, { model: "opus", modelExtraArgs: "--effort max --append-system-prompt 'x y'" })));
    assert.deepEqual(claudeSet.args, ["--dangerously-skip-permissions", "--model", "opus", "--effort", "max"]);
    assert.equal(claudeSet.provenance.modelOverride, "opus");
    assert.equal(claudeSet.provenance.modelExtraArgs, "--effort max --append-system-prompt 'x y'");
    assert.deepEqual(claudeSet.provenance.droppedArgs.at(-1), ["--append-system-prompt", "x y"]);
    // codex: -m canonicalized, service_tier/fast_mode dropped; set-model override wins over -m
    const codex = beeArgsFromRecord(parse(codexHsrRecord(fx.root)));
    assert.deepEqual(codex.args, ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"']);
    const codexSet = beeArgsFromRecord(parse(codexHsrRecord(fx.root, { model: "gpt-5.6-luna", modelExtraArgs: `-c 'model_reasoning_effort="xhigh"' -c service_tier=fast` })));
    assert.deepEqual(codexSet.args, ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="xhigh"']);
    // command-string fallback when launchArgv is absent
    const fromCommand = beeArgsFromRecord(parse(codexTmuxRecord(fx.root, { launchArgv: undefined })));
    assert.equal(fromCommand.provenance.argsSource, "command");
    assert.deepEqual(fromCommand.args, ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"']);
    // nothing to read → null, no source
    const bare = beeArgsFromRecord(parse(claudeHsrRecord(fx.root, { launchArgv: undefined, command: undefined })));
    assert.equal(bare.args, null);
    assert.equal(bare.provenance.argsSource, null);
    // a model-only record (no argv) still yields --model
    assert.deepEqual(beeArgsFromRecord(parse(claudeHsrRecord(fx.root, { launchArgv: undefined, command: undefined, model: "sonnet" }))).args, ["--model", "sonnet"]);
    // other harness: model override does not apply; args null
    assert.equal(beeArgsFromRecord(parse(claudeHsrRecord(fx.root, { agent: "grok", model: "grok-4" }))).args, null);
  } finally {
    fx.cleanup();
  }
});

test("args.6: importFromFrozen writes bees.args from the fixture records and records kept/dropped args in the bee.imported provenance row", () => {
  const fx = makeFrozenFixture();
  const h = harness();
  try {
    fx.writeMarker();
    fx.writeRecord("cl.json", claudeHsrRecord(fx.root));
    fx.writeRecord("co.json", codexHsrRecord(fx.root));
    fx.writeRecord("co2.json", codexTmuxRecord(fx.root, { launchArgv: undefined, command: undefined, model: "gpt-5.6-luna" }));
    const store = h.open();
    const report = importFromFrozen(store, fx.root, { probes: deadProbes });
    assert.equal(report.applied, true, report.refusal ?? "");
    assert.deepEqual(store.getBee("CL.fe6f")?.args, ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high"]);
    assert.deepEqual(store.getBee("CO.3ae1")?.args, ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"']);
    assert.deepEqual(store.getBee("CO.2232")?.args, ["--model", "gpt-5.6-luna"], "first-class model with no argv → --model only");
    const prov = store.auditRows().filter((r) => r.kind === "bee.imported" && r.beeId === "CL.fe6f");
    assert.equal(prov.length, 1);
    const p = prov[0]!.payload;
    assert.equal(p.argsSource, "launchArgv");
    assert.deepEqual(p.keptArgs, ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high"]);
    assert.deepEqual((p.droppedArgs as string[][]).map((d) => d[0]), ["--session-id", "--append-system-prompt"]);
    const entry = report.plan.entries.find((e) => e.originalId === "CL.fe6f");
    assert.ok(entry?.notes.some((n) => n.startsWith("args --dangerously-skip-permissions --model fable --effort high")), `notes: ${JSON.stringify(entry?.notes)}`);
    assert.ok(entry?.notes.some((n) => n.startsWith("dropped 2 old launch flag(s): --session-id --append-system-prompt")));
    // the plan's bee input carries args too (dry-run visibility)
    assert.deepEqual(entry?.bee?.args, ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high"]);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    fx.cleanup();
    h.cleanup();
  }
});
