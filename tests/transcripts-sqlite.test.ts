import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { firstUserText, lastAssistantText, latestTranscript, renderTranscript } from "../src/transcripts.js";

// Build an opencode.db with the real 1.17.7 schema columns the reader uses, by
// piping CREATE/INSERT statements through the sqlite3 CLI (the same binary the
// reader shells out to). Returns false when sqlite3 is unavailable.
function buildOpenCodeDb(dbPath: string, statements: string): boolean {
  const result = spawnSync("sqlite3", [dbPath], { input: statements, encoding: "utf8" });
  return result.status === 0;
}

function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Minimal session/message/part rows: a session in cwd with one user message
// (one text part) and one assistant message (a reasoning part that MUST be
// ignored + a text part that is the answer).
function seedStatements(cwd: string): string {
  const sessionId = "ses_test123";
  const userMsg = "msg_user";
  const asstMsg = "msg_asst";
  return [
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);",
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
    `INSERT INTO session VALUES (${q(sessionId)}, ${q(cwd)}, ${q("Migrate store to SQLite")}, '1.17.7', 100, 200, NULL);`,
    `INSERT INTO message VALUES (${q(userMsg)}, ${q(sessionId)}, 100, 100, ${q(JSON.stringify({ role: "user" }))});`,
    `INSERT INTO message VALUES (${q(asstMsg)}, ${q(sessionId)}, 110, 110, ${q(JSON.stringify({ role: "assistant" }))});`,
    `INSERT INTO part VALUES ('prt_u1', ${q(userMsg)}, ${q(sessionId)}, 101, 101, ${q(JSON.stringify({ type: "text", text: "do the thing" }))});`,
    `INSERT INTO part VALUES ('prt_a0', ${q(asstMsg)}, ${q(sessionId)}, 111, 111, ${q(JSON.stringify({ type: "reasoning", text: "internal thoughts that must not render" }))});`,
    `INSERT INTO part VALUES ('prt_a1', ${q(asstMsg)}, ${q(sessionId)}, 112, 112, ${q(JSON.stringify({ type: "step-start" }))});`,
    `INSERT INTO part VALUES ('prt_a2', ${q(asstMsg)}, ${q(sessionId)}, 113, 113, ${q(JSON.stringify({ type: "text", text: "thing done" }))});`,
  ].join("\n");
}

test("latestTranscript reads an opencode 1.17.7 SQLite db, matching cwd/title/rows", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-opencode-sqlite-"));
  try {
    const cwd = join(dir, "workspace");
    const dbDir = join(dir, "xdg-data", "opencode");
    await mkdir(dbDir, { recursive: true });
    const dbPath = join(dbDir, "opencode.db");
    if (!buildOpenCodeDb(dbPath, seedStatements(cwd))) {
      t.skip("sqlite3 CLI unavailable");
      return;
    }

    const tx = await latestTranscript("opencode", cwd, { homePath: dir });

    assert.ok(tx, "expected a transcript");
    assert.equal(tx.provider, "opencode");
    assert.equal(tx.sessionId, "ses_test123");
    assert.equal(tx.title, "Migrate store to SQLite");
    assert.equal(tx.mtimeMs, 200);
    assert.equal(tx.path, `${dbPath}:ses_test123`);
    assert.equal(tx.matchedBy.includes("cwd"), true);
    // reasoning + step-start parts are dropped; only text parts reconstruct rows.
    assert.equal(renderTranscript(tx.rows), "## user\ndo the thing\n\n## assistant\nthing done");
    assert.equal(firstUserText(tx.rows), "do the thing");
    assert.equal(lastAssistantText(tx.rows), "thing done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript scores an opencode session by prompt and sessionId", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-opencode-sqlite-score-"));
  try {
    const cwd = join(dir, "workspace");
    const dbDir = join(dir, "xdg-data", "opencode");
    await mkdir(dbDir, { recursive: true });
    const dbPath = join(dbDir, "opencode.db");
    if (!buildOpenCodeDb(dbPath, seedStatements(cwd))) {
      t.skip("sqlite3 CLI unavailable");
      return;
    }

    const tx = await latestTranscript("opencode", cwd, { homePath: dir, prompt: "do the thing", sessionId: "ses_test123" });

    assert.ok(tx);
    assert.equal(tx.matchedBy.includes("prompt"), true);
    assert.equal(tx.matchedBy.includes("session-id"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript returns null for opencode when neither db nor file store exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-opencode-absent-"));
  try {
    // Give the home its own relocated opencode tree (so both the SQLite reader
    // and the file-tree fallback stay scoped to this home and never reach the
    // machine's global default store), but leave it empty: no opencode.db and
    // an empty storage/session tree.
    await mkdir(join(dir, "xdg-data", "opencode", "storage", "session"), { recursive: true });
    const tx = await latestTranscript("opencode", join(dir, "workspace"), { homePath: dir });
    assert.equal(tx, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("opencode reader stays scoped to an isolated home and never leaks the global default store", async () => {
  // An identity/account home owns a relocated xdg-data/opencode tree but has no
  // db and no storage/ (e.g. the SQLite read yielded nothing for this cwd). The
  // file-tree fallback MUST stay scoped to this home and return null rather than
  // reach ~/.local/share/opencode/storage and surface a DIFFERENT bee's history.
  const home = await mkdtemp(join(tmpdir(), "honeybee-oc-leak-"));
  try {
    await mkdir(join(home, "xdg-data", "opencode"), { recursive: true });
    const tx = await latestTranscript("opencode", "/tmp/some-cwd", { homePath: home });
    assert.equal(tx, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
