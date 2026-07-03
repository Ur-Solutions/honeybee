import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listLedgerFiles, makeSnippet, resetSessionMetaCache, search, type CorpusReader, type SearchHit } from "../src/search.js";
import { recordSeal, validateSealArtifact } from "../src/seal.js";
import { appendLedger, saveSession, type SessionRecord } from "../src/store.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-search-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    resetSessionMetaCache();
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    resetSessionMetaCache();
    await rm(dir, { recursive: true, force: true });
  }
}

function makeSessionRecord(overrides: Partial<SessionRecord> & { name: string }): SessionRecord {
  return {
    name: overrides.name,
    agent: overrides.agent ?? "codex",
    cwd: overrides.cwd ?? "/tmp/work",
    command: overrides.command ?? "codex",
    tmuxTarget: overrides.tmuxTarget ?? overrides.name,
    createdAt: overrides.createdAt ?? "2026-05-28T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-28T11:00:00.000Z",
    status: overrides.status ?? "running",
    ...(overrides.colony ? { colony: overrides.colony } : {}),
    ...(overrides.swarmId ? { swarmId: overrides.swarmId } : {}),
    ...(overrides.brief ? { brief: overrides.brief } : {}),
    ...(overrides.notes ? { notes: overrides.notes } : {}),
    ...(overrides.title ? { title: overrides.title } : {}),
    ...(overrides.lastPrompt ? { lastPrompt: overrides.lastPrompt } : {}),
    ...(overrides.id ? { id: overrides.id } : {}),
  };
}

test("search finds hits across seals, ledger, and session records", async () => {
  await withTempStore(async () => {
    // Seal that mentions widget
    await recordSeal("CO.aaa", validateSealArtifact({
      status: "done",
      summary: "Implemented the widget overhaul",
      type: "implementation",
    }));
    // Session record whose brief mentions widget
    await saveSession(makeSessionRecord({
      name: "CL.bbb",
      brief: "Investigate the widget regression",
    }));
    // Ledger gets an event with the word widget via the brief save we made above,
    // plus a direct entry.
    await appendLedger({ type: "note", session: "CO.aaa", summary: "widget fallback verified" });

    const result = await search({ query: "widget" });
    const types = new Set(result.hits.map((h) => h.type));
    assert.ok(types.has("seal"), `expected a seal hit: ${JSON.stringify(result.hits.map((h) => h.type))}`);
    assert.ok(types.has("session"), "expected a session hit");
    assert.ok(types.has("ledger"), "expected a ledger hit");
  });
});

test("search ranks seals above ledger above sessions, within recency order", async () => {
  await withTempStore(async () => {
    await recordSeal("CO.aaa", validateSealArtifact({ status: "done", summary: "alpha frob" }));
    await saveSession(makeSessionRecord({ name: "CL.bbb", brief: "alpha frob revisited" }));
    await appendLedger({ type: "note", session: "CO.aaa", text: "alpha frob noted" });

    const result = await search({ query: "frob" });
    const types = result.hits.map((h) => h.type);
    // Corpus dominates recency: seals must come first.
    assert.equal(types[0], "seal");
    // Ledger must come before session.
    assert.ok(types.indexOf("ledger") < types.indexOf("session"), `ordering: ${types.join(",")}`);
  });
});

test("search --colony filter matches sessions by colony and skips others", async () => {
  await withTempStore(async () => {
    await saveSession(makeSessionRecord({ name: "CL.aaa", brief: "rebuild parser", colony: "alpha" }));
    await saveSession(makeSessionRecord({ name: "CL.bbb", brief: "rebuild parser", colony: "beta" }));
    // Skip the loadColony check by passing no colony — the CLI does the existence check.
    const result = await search({ query: "parser", colony: "alpha", types: new Set(["sessions"]) });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.beeName, "CL.aaa");
  });
});

test("search matches inherited session titles", async () => {
  await withTempStore(async () => {
    await saveSession(makeSessionRecord({ name: "CO.aaa", title: "Repair Title Inheritance" }));
    const result = await search({ query: "Inheritance", types: new Set(["sessions"]) });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.beeName, "CO.aaa");
  });
});

test("search --status restricts seal hits", async () => {
  await withTempStore(async () => {
    await recordSeal("CO.aaa", validateSealArtifact({ status: "done", summary: "shipped widget" }));
    await recordSeal("CO.bbb", validateSealArtifact({ status: "blocked", summary: "blocked on widget" }));
    const onlyDone = await search({ query: "widget", types: new Set(["seals"]), status: "done" });
    assert.equal(onlyDone.hits.length, 1);
    assert.equal(onlyDone.hits[0]!.beeName, "CO.aaa");
    const onlyBlocked = await search({ query: "widget", types: new Set(["seals"]), status: "blocked" });
    assert.equal(onlyBlocked.hits.length, 1);
    assert.equal(onlyBlocked.hits[0]!.beeName, "CO.bbb");
  });
});

test("makeSnippet caps total length and returns correct match offsets", () => {
  const long = "a".repeat(200) + "MATCH" + "b".repeat(200);
  const matchStart = 200;
  const matchEnd = matchStart + "MATCH".length;
  const snippet = makeSnippet(long, matchStart, matchEnd);
  // 40 before + 5 match + 80 after = 125 chars, plus 2 ellipses
  assert.ok(snippet.text.length <= 130, `snippet too long: ${snippet.text.length}`);
  assert.ok(snippet.text.includes("MATCH"));
  // Verify the match offsets point at the right text inside the snippet.
  assert.equal(snippet.text.slice(snippet.matchStart, snippet.matchEnd), "MATCH");
});

test("makeSnippet handles matches near the start without losing context", () => {
  const text = "MATCH at the very beginning of a longer string that needs snippeting";
  const snippet = makeSnippet(text, 0, 5);
  assert.equal(snippet.text.slice(snippet.matchStart, snippet.matchEnd), "MATCH");
  assert.ok(!snippet.text.startsWith("…"));
});

test("search --regex with --case is case-sensitive", async () => {
  await withTempStore(async () => {
    await saveSession(makeSessionRecord({ name: "CL.aaa", brief: "WidgetMaker spec" }));
    await saveSession(makeSessionRecord({ name: "CL.bbb", brief: "widgetmaker spec" }));
    const caseSensitive = await search({
      query: "Widget",
      regex: true,
      caseSensitive: true,
      types: new Set(["sessions"]),
    });
    assert.equal(caseSensitive.hits.length, 1);
    assert.equal(caseSensitive.hits[0]!.beeName, "CL.aaa");
    const caseInsensitive = await search({
      query: "Widget",
      regex: true,
      types: new Set(["sessions"]),
    });
    assert.equal(caseInsensitive.hits.length, 2);
  });
});

test("search rejects an invalid regex with a clear error", async () => {
  await withTempStore(async () => {
    await saveSession(makeSessionRecord({ name: "CL.aaa", brief: "noop" }));
    await assert.rejects(
      () => search({ query: "(unterminated", regex: true }),
      /Invalid regex/,
    );
  });
});

test("search --since filters out older ledger entries", async () => {
  await withTempStore(async () => {
    // Old ledger entry (artificial timestamp injection by writing the file directly).
    // We use the public appendLedger first so the file exists, then append an old line.
    await appendLedger({ type: "note", session: "CO.aaa", text: "recent widget run" });

    const ledgerFile = (await listLedgerFiles())[0]!;
    const old = `${JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", type: "note", text: "ancient widget run" })}\n`;
    const { writeFile, readFile } = await import("node:fs/promises");
    const existing = await readFile(ledgerFile, "utf8");
    await writeFile(ledgerFile, old + existing);

    const recentMs = Date.parse("2024-01-01T00:00:00.000Z");
    const result = await search({ query: "widget", sinceMs: recentMs, types: new Set(["ledger"]) });
    assert.ok(result.hits.length >= 1);
    for (const hit of result.hits) {
      const ts = Date.parse(hit.matchedAt);
      assert.ok(ts >= recentMs, `hit older than sinceMs: ${hit.matchedAt}`);
    }
  });
});

test("search reads rotated ledger files newest-first", async () => {
  await withTempStore(async (dir) => {
    // Write three ledger files manually so we can control their mtimes.
    const ledgerDir = dir;
    await mkdir(ledgerDir, { recursive: true });

    const lines: { path: string; ts: string; text: string }[] = [
      { path: join(ledgerDir, "ledger.jsonl.2026-01-01"), ts: "2026-01-01T00:00:00.000Z", text: "oldest widget" },
      { path: join(ledgerDir, "ledger.jsonl.2026-03-01"), ts: "2026-03-01T00:00:00.000Z", text: "middle widget" },
      { path: join(ledgerDir, "ledger.jsonl"), ts: "2026-06-01T00:00:00.000Z", text: "newest widget" },
    ];
    for (const entry of lines) {
      await writeFile(entry.path, `${JSON.stringify({ ts: entry.ts, type: "note", text: entry.text })}\n`);
    }
    // Stamp mtimes in order.
    const { utimes } = await import("node:fs/promises");
    await utimes(lines[0]!.path, new Date(lines[0]!.ts), new Date(lines[0]!.ts));
    await utimes(lines[1]!.path, new Date(lines[1]!.ts), new Date(lines[1]!.ts));
    await utimes(lines[2]!.path, new Date(lines[2]!.ts), new Date(lines[2]!.ts));

    const files = await listLedgerFiles();
    assert.equal(files.length, 3);
    assert.ok(files[0]!.endsWith("ledger.jsonl"), `expected current ledger first, got ${files[0]}`);
    assert.ok(files[1]!.endsWith(".2026-03-01"));
    assert.ok(files[2]!.endsWith(".2026-01-01"));

    const result = await search({ query: "widget", types: new Set(["ledger"]) });
    const tsOrder = result.hits.map((h) => h.matchedAt);
    // Sorted by score (recency within corpus). Newest first.
    assert.equal(tsOrder[0], "2026-06-01T00:00:00.000Z");
    assert.equal(tsOrder[1], "2026-03-01T00:00:00.000Z");
    assert.equal(tsOrder[2], "2026-01-01T00:00:00.000Z");
  });
});

test("search default --limit is 30 and truncated flag is set", async () => {
  await withTempStore(async () => {
    for (let i = 0; i < 35; i += 1) {
      const stamp = `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`;
      await saveSession(makeSessionRecord({
        name: `CL.b${String(i).padStart(2, "0")}`,
        brief: "shared keyword",
        createdAt: stamp,
        updatedAt: stamp,
      }));
    }
    const result = await search({ query: "shared keyword", types: new Set(["sessions"]) });
    assert.equal(result.hits.length, 30);
    assert.equal(result.truncated, true);
    // limit 0 = unlimited
    const all = await search({ query: "shared keyword", types: new Set(["sessions"]), limit: 0 });
    assert.equal(all.hits.length, 35);
    assert.equal(all.truncated, false);
  });
});

test("search with a mock corpus reader bypasses the filesystem", async () => {
  const sealHit = {
    path: "/fake/seal.json",
    record: validateSealArtifact({ status: "done", summary: "synthetic seal mentions FOO" }),
  };
  const sealRecord = { ...sealHit.record, beeName: "MOCK.bee", sealedAt: "2026-06-01T00:00:00.000Z" };
  const mock: CorpusReader = {
    listLedgerFiles: async () => [],
    readSeals: async function* () {
      yield { path: sealHit.path, record: sealRecord };
    },
    readSessionRecords: async function* () {},
    readLedgerLines: async function* () {},
  };
  const result = await search({ query: "FOO" }, mock);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.type, "seal");
  assert.equal(result.hits[0]!.path, "/fake/seal.json");
});

test("search filters out empty queries with a friendly error", async () => {
  await assert.rejects(() => search({ query: "" }), /requires a non-empty query/);
});

test("search --type seals,ledger excludes session hits", async () => {
  await withTempStore(async () => {
    await saveSession(makeSessionRecord({ name: "CL.aaa", brief: "frob the gadget" }));
    await recordSeal("CO.bbb", validateSealArtifact({ status: "done", summary: "gadget sealed" }));
    await appendLedger({ type: "note", session: "CO.bbb", text: "gadget" });

    const result = await search({ query: "gadget", types: new Set(["seals", "ledger"]) });
    for (const hit of result.hits) {
      assert.notEqual(hit.type, "session", `found a session hit when none expected: ${JSON.stringify(hit)}`);
    }
  });
});

test("highlightSnippet offsets stay correct when snippet is short", async () => {
  await withTempStore(async () => {
    await saveSession(makeSessionRecord({ name: "CL.aaa", brief: "tiny" }));
    const result = await search({ query: "tiny", types: new Set(["sessions"]) });
    assert.equal(result.hits.length, 1);
    const hit: SearchHit = result.hits[0]!;
    assert.equal(hit.snippet.slice(hit.matchStartInSnippet, hit.matchEndInSnippet), "tiny");
  });
});

test("makeSnippet offsets point at the matched occurrence when text repeats", () => {
  const text = "needle before some context and then needle again";
  const matchStart = text.lastIndexOf("needle");
  const snippet = makeSnippet(text, matchStart, matchStart + "needle".length);
  assert.equal(snippet.text.slice(snippet.matchStart, snippet.matchEnd), "needle");
  assert.equal(snippet.matchStart, snippet.text.lastIndexOf("needle"));
});

test("search --since drops records and lines with unparseable timestamps", async () => {
  const recentSeal = {
    ...validateSealArtifact({ status: "done", summary: "widget recent seal" }),
    beeName: "CO.good",
    sealedAt: "2026-06-01T00:00:00.000Z",
  };
  const badSeal = {
    ...validateSealArtifact({ status: "done", summary: "widget invalid seal" }),
    beeName: "CO.bad-seal",
    sealedAt: "not-a-date",
  };
  const goodSession = makeSessionRecord({
    name: "CO.good-session",
    brief: "widget recent session",
    updatedAt: "2026-06-02T00:00:00.000Z",
  });
  const badSession = makeSessionRecord({
    name: "CO.bad-session",
    brief: "widget invalid session",
    updatedAt: "not-a-date",
  });
  const mock: CorpusReader = {
    listLedgerFiles: async () => [],
    readSeals: async function* () {
      yield { path: "/fake/good-seal.json", record: recentSeal };
      yield { path: "/fake/bad-seal.json", record: badSeal };
    },
    readSessionRecords: async function* () {
      yield { path: "/fake/good-session.json", record: goodSession };
      yield { path: "/fake/bad-session.json", record: badSession };
    },
    readLedgerLines: async function* () {
      yield {
        path: "/fake/ledger.jsonl",
        line: JSON.stringify({ ts: "not-a-date", type: "note", text: "widget invalid ledger" }),
        ts: "not-a-date",
        lineNumber: 1,
      };
      yield {
        path: "/fake/ledger.jsonl",
        line: JSON.stringify({ ts: "2026-06-03T00:00:00.000Z", type: "note", text: "widget recent ledger" }),
        ts: "2026-06-03T00:00:00.000Z",
        lineNumber: 2,
      };
    },
  };

  const result = await search({ query: "widget", sinceMs: Date.parse("2026-01-01T00:00:00.000Z") }, mock);
  assert.deepEqual(result.hits.map((hit) => hit.beeName ?? hit.path).sort(), [
    "/fake/ledger.jsonl:2",
    "CO.good",
    "CO.good-session",
  ]);
});

test("search hits do not retain raw records or ledger lines", async () => {
  await withTempStore(async () => {
    await saveSession(makeSessionRecord({ name: "CL.aaa", brief: "tiny" }));
    const result = await search({ query: "tiny", types: new Set(["sessions"]) });
    assert.equal(Object.hasOwn(result.hits[0]!, "raw"), false);
  });
});

test("search snippets redact secret-shaped prompt and seal content", async () => {
  await withTempStore(async () => {
    const secret = "sk-ant-oat01-FAKE-setup-token-never-real-xyz";
    await saveSession(makeSessionRecord({
      name: "CL.secret",
      lastPrompt: `please call the API token endpoint with api_key=${secret}`,
    }));
    await recordSeal("CO.secret", validateSealArtifact({
      status: "done",
      summary: `verified refresh_token=${secret}`,
    }));

    const result = await search({ query: "token", types: new Set(["seals", "sessions"]) });
    assert.ok(result.hits.length >= 2);
    for (const hit of result.hits) {
      assert.doesNotMatch(hit.snippet, new RegExp(secret));
      assert.match(hit.snippet, /\[redacted\]/);
    }
  });
});
