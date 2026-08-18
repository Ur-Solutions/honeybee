/**
 * WP6a — templates + tracks as hive concepts, and the package format
 * (spec 06 §1.4.1 "rows are truth, files are packages"). Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NameConflictError,
  PackageError,
  TemplateNotFoundError,
  TrackNotFoundError,
  exportTemplate,
  exportTrack,
  importLocalConfig,
  importTemplate,
  importTrack,
  legacyTemplateToPackage,
  legacyTrackToPackage,
  parseTemplatePackage,
  replayAudit,
  serializePackage,
  type CoreStore,
  type TemplatePackage,
  type TrackPackage,
} from "../src/index.ts";
import { harness } from "./helpers.ts";

const baseTemplate = {
  name: "commit",
  agent: "codex",
  prompt: "Commit the working tree in small atomic commits.",
  description: "Atomic commits",
  args: ["-m", "gpt-5.6-sol"],
  model: "gpt-5.6-sol",
  effort: "medium",
  tags: ["git"],
};

const baseTrack = {
  name: "ship-it",
  description: "build → review → land",
  steps: [
    { id: "n1", name: "Build", instruction: "Implement the smallest slice." },
    { id: "n2", name: "Review", kind: "review" },
    { id: "n3", name: "Land", templateId: "tpl-land" },
  ],
  tags: ["release"],
};

test("pkg.1: putTemplate is idempotent — same fields twice = one row, unchanged, no extra audit", () => {
  const h = harness();
  try {
    const store = h.open();
    const a = store.putTemplate({ fields: baseTemplate });
    assert.equal(a.outcome, "created");
    assert.equal(a.template.scope, "personal");
    assert.equal(a.template.source, "api");
    assert.equal(a.template.cwdPolicy, "caller");
    assert.equal(a.template.preambleEnabled, true);
    const seqAfterCreate = store.lastAuditSeq();
    const b = store.putTemplate({ fields: baseTemplate });
    assert.equal(b.outcome, "unchanged");
    assert.equal(b.template.id, a.template.id);
    assert.equal(b.template.updatedAt, a.template.updatedAt);
    assert.equal(store.lastAuditSeq(), seqAfterCreate, "no audit row for a no-op put");
    const c = store.putTemplate({ fields: { ...baseTemplate, effort: "high" } });
    assert.equal(c.outcome, "updated");
    assert.equal(c.template.id, a.template.id);
    assert.equal(c.template.effort, "high");
    assert.ok(c.template.updatedAt > a.template.updatedAt);
    assert.equal(c.template.createdAt, a.template.createdAt);
    assert.equal(store.listTemplates().length, 1);
    // Audit replay reproduces the registry (spec01 test 13 discipline).
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    const kinds = store.auditRows().map((r) => r.kind);
    assert.deepEqual(kinds.filter((k) => k.startsWith("template.")), ["template.put", "template.put"]);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("pkg.2: names are unique per scope — id/name conflicts throw NameConflictError; scopes are independent", () => {
  const h = harness();
  try {
    const store = h.open();
    const a = store.putTemplate({ id: "tpl-a", fields: baseTemplate });
    // Same name, different scope: fine.
    const team = store.putTemplate({ fields: { ...baseTemplate, scope: "team" } });
    assert.notEqual(team.template.id, a.template.id);
    // Explicit different id for an existing (scope,name): refused.
    assert.throws(() => store.putTemplate({ id: "tpl-b", fields: baseTemplate }), NameConflictError);
    // Renaming tpl-a onto the team row's name in the team scope: refused.
    assert.throws(() => store.putTemplate({ id: "tpl-a", fields: { ...baseTemplate, scope: "team" } }), NameConflictError);
    // Renaming tpl-a to a free name via id match: fine, keeps id.
    const renamed = store.putTemplate({ id: "tpl-a", fields: { ...baseTemplate, name: "commit-2" } });
    assert.equal(renamed.outcome, "updated");
    assert.equal(renamed.template.name, "commit-2");
    assert.equal(store.getTemplateByName("personal", "commit"), null);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("pkg.3: delete removes the row, audits, and not-found is typed; validation is closed-list", () => {
  const h = harness();
  try {
    const store = h.open();
    const t = store.putTemplate({ fields: baseTemplate }).template;
    const k = store.putTrack({ fields: baseTrack }).track;
    store.deleteTemplate(t.id);
    store.deleteTrack(k.id);
    assert.equal(store.getTemplate(t.id), null);
    assert.equal(store.getTrack(k.id), null);
    assert.throws(() => store.deleteTemplate(t.id), TemplateNotFoundError);
    assert.throws(() => store.deleteTrack(k.id), TrackNotFoundError);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    // Closed lists / required fields.
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, scope: "global" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, source: "magic" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, prompt: "" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, name: "bad name" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, cwdPolicy: "fixed" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, cwd: "/x" } }), PackageError);
    assert.throws(() => store.putTemplate({ fields: { ...baseTemplate, preambleEnabled: false, preamble: "x" } }), PackageError);
    assert.throws(() => store.putTrack({ fields: { ...baseTrack, steps: [{ id: "a", name: "x" }, { id: "a", name: "y" }] } }), PackageError);
    assert.throws(() => store.putTrack({ fields: { ...baseTrack, steps: [{ id: "a", name: "x", status: "blocked" }] } }), PackageError);
    // Unknown fields are dropped, not stored.
    const u = store.putTemplate({ fields: { ...baseTemplate, name: "u", bogus: 1 } }).template;
    assert.equal("bogus" in u, false);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("pkg.4: package import is idempotent and records source; missing id matches by scope+name", () => {
  const h = harness();
  try {
    const store = h.open();
    const doc: TemplatePackage = parseTemplatePackage({ kind: "hive.template", formatVersion: 1, ...baseTemplate });
    assert.equal(doc.id, null);
    const a = importTemplate(store, doc, { source: "package:/repo/.hive/commit.json" });
    assert.equal(a.outcome, "created");
    assert.equal(a.row.source, "package:/repo/.hive/commit.json");
    const b = importTemplate(store, serializePackage(doc), { source: "package:/repo/.hive/commit.json" });
    assert.equal(b.outcome, "unchanged");
    assert.equal(b.row.id, a.row.id);
    assert.equal(store.listTemplates().length, 1);
    // A modified package updates the same row.
    const c = importTemplate(store, { ...doc, prompt: "v2 prompt" }, { source: "package:/repo/.hive/commit.json" });
    assert.equal(c.outcome, "updated");
    assert.equal(c.row.id, a.row.id);
    // Scope override at import (repo `.hive/` forces repo scope) → distinct row.
    const r = importTemplate(store, doc, { scope: "repo", source: "package:/repo/.hive/commit.json" });
    assert.equal(r.row.scope, "repo");
    assert.equal(store.listTemplates().length, 2);
    // Header enforcement.
    assert.throws(() => importTemplate(store, { ...doc, kind: "hive.track" }), PackageError);
    assert.throws(() => importTemplate(store, { ...doc, formatVersion: 2 }), PackageError);
    assert.throws(() => importTemplate(store, "{not json"), PackageError);
    // Track import: same contract.
    const td: TrackPackage = { kind: "hive.track", formatVersion: 1, id: null, name: "ship-it", scope: "personal", description: null, tags: [], steps: baseTrack.steps.map((s) => ({ id: s.id, name: s.name, kind: s.kind ?? "action", templateId: s.templateId ?? null, instruction: s.instruction ?? null, note: null, status: "pending" as const })) };
    const t1 = importTrack(store, td, { source: "package:/x.json" });
    const t2 = importTrack(store, td, { source: "package:/x.json" });
    assert.equal(t1.outcome, "created");
    assert.equal(t2.outcome, "unchanged");
    assert.equal(store.listTracks().length, 1);
    store.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Property: export → import → export is byte-identical, for random rows.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["alpha", "beta", "gamma", "delta", "ø-unicode", "tab\there", "quote\"d", "new\nline", "", "  spaced  "];
const SCOPES = ["personal", "team", "repo"] as const;

function randomTemplateFields(rnd: () => number, i: number): Record<string, unknown> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const maybe = <T>(v: T): T | null => (rnd() < 0.3 ? null : v);
  const fixed = rnd() < 0.3;
  const preambleEnabled = rnd() < 0.8;
  const env: Record<string, string> = {};
  for (let k = 0; k < Math.floor(rnd() * 4); k++) env[`K${Math.floor(rnd() * 5)}`] = pick(WORDS);
  return {
    name: `t${i}-${Math.floor(rnd() * 1000)}`,
    scope: pick(SCOPES),
    agent: pick(["claude", "codex", "grok"]),
    prompt: `${pick(WORDS)} ${pick(WORDS)} x`,
    description: maybe(pick(WORDS)),
    substrate: maybe(pick(["tmux", "hsr", "cell"])),
    model: maybe(pick(["opus", "gpt-5.6-sol"])),
    effort: maybe(pick(["low", "high"])),
    args: Array.from({ length: Math.floor(rnd() * 4) }, () => pick(WORDS)),
    preamble: preambleEnabled ? maybe(pick(WORDS)) : null,
    preambleEnabled,
    cwdPolicy: fixed ? "fixed" : "caller",
    cwd: fixed ? `/tmp/${pick(["a", "b"])}` : null,
    env,
    account: maybe(pick(WORDS)),
    yolo: rnd() < 0.5,
    tags: Array.from({ length: Math.floor(rnd() * 3) }, () => pick(WORDS)),
  };
}

function randomTrackFields(rnd: () => number, i: number): Record<string, unknown> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const maybe = <T>(v: T): T | null => (rnd() < 0.3 ? null : v);
  return {
    name: `k${i}-${Math.floor(rnd() * 1000)}`,
    scope: pick(SCOPES),
    description: maybe(pick(WORDS)),
    tags: Array.from({ length: Math.floor(rnd() * 3) }, () => pick(WORDS)),
    steps: Array.from({ length: Math.floor(rnd() * 5) }, (_, j) => ({
      id: `s${j}`,
      name: `${pick(WORDS)}!`,
      kind: pick(["action", "orchestrate", "review", "ask", "deploy"]),
      templateId: maybe(`tpl-${Math.floor(rnd() * 3)}`),
      instruction: maybe(pick(WORDS)),
      note: maybe(pick(WORDS)),
      status: pick(["pending", "running", "done", "skipped"]),
    })),
  };
}

test("pkg.5: property — export→import→export is byte-identical (templates + tracks, 60 seeds)", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = mulberry32(seed);
    const src = harness();
    const dst = harness();
    try {
      const a = src.open();
      const b = dst.open();
      for (let i = 0; i < 4; i++) {
        const fields = randomTemplateFields(rnd, i);
        const row = a.putTemplate({ fields }).template;
        const text1 = serializePackage(exportTemplate(row));
        const imported = importTemplate(b, text1, { source: "package:/pkg.json" });
        const text2 = serializePackage(exportTemplate(imported.row));
        assert.equal(text2, text1, `seed ${seed} template ${i}`);
        // Re-import on the source store itself: unchanged (source differs → updated once, then unchanged).
        importTemplate(a, text1, { source: "package:/pkg.json" });
        assert.equal(importTemplate(a, text1, { source: "package:/pkg.json" }).outcome, "unchanged");
      }
      for (let i = 0; i < 4; i++) {
        const fields = randomTrackFields(rnd, i);
        const row = a.putTrack({ fields }).track;
        const text1 = serializePackage(exportTrack(row));
        const imported = importTrack(b, text1, { source: "package:/pkg.json" });
        const text2 = serializePackage(exportTrack(imported.row));
        assert.equal(text2, text1, `seed ${seed} track ${i}`);
        assert.equal(importTrack(b, text1, { source: "package:/pkg.json" }).outcome, "unchanged");
      }
      // Ids are carried by the package, so both stores hold identical id sets.
      assert.deepEqual(b.listTemplates().map((t) => t.id).sort(), a.listTemplates().map((t) => t.id).sort());
      assert.deepEqual(replayAudit(a.auditRows()), a.dumpState());
      assert.deepEqual(replayAudit(b.auditRows()), b.dumpState());
      a.close();
      b.close();
    } finally {
      src.cleanup();
      dst.cleanup();
    }
  }
});

test("pkg.6: serialized package is stable — fixed key order, 2-space json, trailing newline", () => {
  const h = harness();
  try {
    const store = h.open();
    const row = store.putTemplate({ id: "tpl-commit", fields: { ...baseTemplate, env: { ZED: "1", ALPHA: "2" } } }).template;
    const text = serializePackage(exportTemplate(row));
    assert.equal(
      text,
      `{
  "kind": "hive.template",
  "formatVersion": 1,
  "id": "tpl-commit",
  "name": "commit",
  "scope": "personal",
  "description": "Atomic commits",
  "agent": "codex",
  "substrate": null,
  "model": "gpt-5.6-sol",
  "effort": "medium",
  "args": [
    "-m",
    "gpt-5.6-sol"
  ],
  "prompt": "Commit the working tree in small atomic commits.",
  "preamble": null,
  "preambleEnabled": true,
  "cwdPolicy": "caller",
  "cwd": null,
  "env": {
    "ALPHA": "2",
    "ZED": "1"
  },
  "account": null,
  "yolo": false,
  "tags": [
    "git"
  ]
}
`,
    );
    const track = store.putTrack({ id: "trk-ship", fields: baseTrack }).track;
    const ttext = serializePackage(exportTrack(track));
    assert.ok(ttext.startsWith('{\n  "kind": "hive.track",\n  "formatVersion": 1,\n  "id": "trk-ship",\n  "name": "ship-it",\n  "scope": "personal",'));
    assert.ok(ttext.includes('"templateId": "tpl-land"'));
    assert.ok(ttext.endsWith("}\n"));
    store.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Local config source — today's ~/.hive layout, rebuilt in a temp dir.
// ---------------------------------------------------------------------------

function writeLocalConfig(dir: string): void {
  mkdirSync(join(dir, "templates"), { recursive: true });
  mkdirSync(join(dir, "tracks", "definitions", "demo", "versions"), { recursive: true });
  mkdirSync(join(dir, "tracks", "attachments"), { recursive: true });
  writeFileSync(
    join(dir, "templates", "commit.json"),
    JSON.stringify({
      name: "commit",
      bee: "codex-auto",
      prompt: "Commit the tree.",
      cwd: "caller",
      description: "Atomic commits + push",
      args: ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"'],
      createdAt: "2026-07-28T13:11:49.137Z",
      updatedAt: "2026-07-31T17:18:43.818Z",
    }),
  );
  writeFileSync(join(dir, "templates", "commit.source"), "/tmp/hive-commit-template.json\n");
  writeFileSync(
    join(dir, "templates", "reviewer.json"),
    JSON.stringify({
      name: "reviewer",
      bee: "claude",
      prompt: "Review the diff.",
      cwd: "/Users/x/repo",
      preamble: false,
      yolo: true,
      account: "work",
      env: { REVIEW: "1" },
    }),
  );
  writeFileSync(join(dir, "templates", "fancy.ts"), "export default { name: 'fancy' }\n");
  writeFileSync(join(dir, "templates", "broken.json"), JSON.stringify({ name: "broken", bee: "claude" })); // no prompt
  writeFileSync(
    join(dir, "tracks", "definitions", "demo.json"),
    JSON.stringify({
      schemaVersion: 2,
      name: "demo",
      description: "Flow-view demo",
      version: 3,
      items: [
        { id: "n1", name: "Map", type: "action", instruction: "Grep call sites." },
        { id: "n2", name: "Migrate", type: "orchestrate", instruction: "Coordinate.", subAgents: { max: 3, harness: "claude" } },
        {
          branch: [
            [{ id: "n3a", name: "Docs", when: "docs changed", type: "action" }],
            [{ id: "n3b", name: "Types", note: "lockstep", type: "action" }],
          ],
        },
        { id: "n4", name: "Review", type: "review", denied: [{ id: "n4d", name: "Re-land", type: "action" }] },
        { id: "n5", name: "Cookie fallback", type: "ask", question: "Keep the cookie path?", blocking: true },
        { id: "n6", name: "Ship", type: "deploy", target: { kind: "nectar", label: "preview" } },
      ],
    }),
  );
  writeFileSync(join(dir, "tracks", "definitions", "demo", "versions", "000001.json"), "{}");
}

test("pkg.7: importLocalConfig reads today's ~/.hive layout read-only, maps old shapes, is idempotent, reports skips", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-localcfg-"));
  try {
    writeLocalConfig(dir);
    const store = h.open();
    const r1 = importLocalConfig(store, dir);
    assert.deepEqual(r1.templates.map((t) => [t.name, t.outcome]), [
      ["commit", "created"],
      ["reviewer", "created"],
    ]);
    assert.deepEqual(r1.tracks.map((t) => [t.name, t.outcome]), [["demo", "created"]]);
    assert.deepEqual(r1.skipped.map((s) => s.path.split("/").pop()).sort(), ["broken.json", "fancy.ts"]);

    const commit = store.getTemplateByName("personal", "commit");
    assert.ok(commit);
    assert.equal(commit.source, "local-config");
    assert.equal(commit.agent, "codex-auto");
    assert.equal(commit.cwdPolicy, "caller");
    assert.equal(commit.preambleEnabled, true);
    assert.deepEqual(commit.args, ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"']);
    assert.equal(commit.model, null, "old args are not parsed into model/effort");
    const reviewer = store.getTemplateByName("personal", "reviewer");
    assert.ok(reviewer);
    assert.equal(reviewer.cwdPolicy, "fixed");
    assert.equal(reviewer.cwd, "/Users/x/repo");
    assert.equal(reviewer.preambleEnabled, false);
    assert.equal(reviewer.yolo, true);
    assert.equal(reviewer.account, "work");
    assert.deepEqual(reviewer.env, { REVIEW: "1" });

    const demo = store.getTrackByName("personal", "demo");
    assert.ok(demo);
    assert.equal(demo.source, "local-config");
    assert.deepEqual(
      demo.steps.map((s) => [s.id, s.kind, s.instruction, s.note]),
      [
        ["n1", "action", "Grep call sites.", null],
        ["n2", "orchestrate", "Coordinate.", null],
        ["n3a", "action", null, "when: docs changed"],
        ["n3b", "action", null, "lockstep"],
        ["n4", "review", null, null],
        ["n4d", "action", null, null],
        ["n5", "ask", "Keep the cookie path?", null],
        ["n6", "deploy", "deploy: nectar preview", null],
      ],
    );
    assert.ok(demo.steps.every((s) => s.status === "pending"));

    // Second import: nothing changes.
    const r2 = importLocalConfig(store, dir);
    assert.ok(r2.templates.every((t) => t.outcome === "unchanged"));
    assert.ok(r2.tracks.every((t) => t.outcome === "unchanged"));
    assert.equal(store.listTemplates().length, 2);
    assert.equal(store.listTracks().length, 1);
    // Edit a file → updated on the next manual import; nothing else moves.
    writeFileSync(join(dir, "templates", "commit.json"), JSON.stringify({ name: "commit", bee: "codex-auto", prompt: "Commit the tree, v2." }));
    const r3 = importLocalConfig(store, dir);
    assert.deepEqual(r3.templates.map((t) => t.outcome), ["updated", "unchanged"]);
    // Missing dir: empty report, no throw.
    const r4 = importLocalConfig(store, join(dir, "nope"));
    assert.deepEqual([r4.templates, r4.tracks, r4.skipped], [[], [], []]);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pkg.8: legacy converters reject garbage with PackageError", () => {
  assert.throws(() => legacyTemplateToPackage(null), PackageError);
  assert.throws(() => legacyTemplateToPackage({ name: "x" }), PackageError);
  assert.throws(() => legacyTrackToPackage([]), PackageError);
  assert.throws(() => legacyTrackToPackage({ name: "bad name" }), PackageError);
  const t = legacyTemplateToPackage({ name: "ok", bee: "claude", prompt: "p", preamble: "custom" });
  assert.equal(t.preamble, "custom");
  assert.equal(t.preambleEnabled, true);
});

// ---------------------------------------------------------------------------
// Fuzz: random registry ops never leave a state outside the model, and audit
// replay always reproduces it.
// ---------------------------------------------------------------------------

test("pkg.9: fuzz — random put/import/delete on templates+tracks keeps names unique per scope and replays exactly", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = mulberry32(seed * 7919);
    const h = harness();
    try {
      let store: CoreStore = h.open();
      const names = ["a", "b", "c"];
      const ids = ["id-1", "id-2", "id-3"];
      for (let op = 0; op < 80; op++) {
        const roll = rnd();
        const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
        try {
          if (roll < 0.3) {
            store.putTemplate({ id: rnd() < 0.5 ? pick(ids) : undefined, fields: { ...randomTemplateFields(rnd, op), name: pick(names) } });
          } else if (roll < 0.5) {
            store.putTrack({ id: rnd() < 0.5 ? pick(ids) : undefined, fields: { ...randomTrackFields(rnd, op), name: pick(names) } });
          } else if (roll < 0.65) {
            const t = pick(store.listTemplates());
            if (t) importTemplate(store, serializePackage(exportTemplate({ ...t, scope: pick(SCOPES) })), { source: "package:/f" });
          } else if (roll < 0.8) {
            const t = pick(store.listTemplates());
            if (t) store.deleteTemplate(t.id);
            const k = pick(store.listTracks());
            if (k) store.deleteTrack(k.id);
          } else if (roll < 0.9) {
            store.deleteTemplate("id-9"); // always throws (not found)
          } else {
            store.close();
            store = h.open(); // "crash" + reopen
          }
        } catch (err) {
          assert.ok(err instanceof NameConflictError || err instanceof TemplateNotFoundError || err instanceof PackageError, `seed ${seed} op ${op}: ${String(err)}`);
        }
        const dump = store.dumpState();
        const seen = new Set<string>();
        for (const t of dump.templates) {
          const key = `${t.scope}/${t.name}`;
          assert.ok(!seen.has(key), `dup ${key}`);
          seen.add(key);
          assert.ok(t.updatedAt >= t.createdAt);
          assert.equal(t.cwdPolicy === "fixed", t.cwd !== null);
        }
        const seenK = new Set<string>();
        for (const k of dump.tracks) {
          const key = `${k.scope}/${k.name}`;
          assert.ok(!seenK.has(key), `dup track ${key}`);
          seenK.add(key);
        }
      }
      assert.deepEqual(replayAudit(store.auditRows()), store.dumpState(), `seed ${seed} replay`);
      store.close();
    } finally {
      h.cleanup();
    }
  }
});
