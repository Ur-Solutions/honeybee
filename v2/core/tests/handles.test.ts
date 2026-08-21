/**
 * v10 — pretty handles (operator ruling 2026-08-19): a short human display id
 * (`CL.a3f2`) minted per node at spawn, unique per node, riding alongside the
 * canonical UUID. Covers minting, explicit handles, collision growth, the
 * v9 → v10 backfill (old pretty ids kept), and the unique index.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handlePrefix, HANDLE_RE } from "../src/store.ts";
import { CoreError } from "../src/types.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";
import { harness } from "./helpers.ts";

test("handles.0: prefix derivation — first two letters uppercased, non-letters skipped", () => {
  assert.equal(handlePrefix("claude"), "CL");
  assert.equal(handlePrefix("codex"), "CO");
  assert.equal(handlePrefix("grok"), "GR");
  assert.equal(handlePrefix("opencode"), "OP");
  assert.equal(handlePrefix("x9"), "XX");
  assert.equal(handlePrefix(""), "XX");
});

test("handles.1: every created bee gets a minted, unique, well-formed handle", () => {
  const h = harness();
  try {
    const store = h.open();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { bee } = store.createBee({ name: `b${i}`, agent: i % 2 === 0 ? "claude" : "codex", substrate: "hsr", cwd: "/tmp" });
      assert.ok(bee.handle, "handle minted");
      assert.match(bee.handle as string, HANDLE_RE);
      assert.ok((bee.handle as string).startsWith(i % 2 === 0 ? "CL." : "CO."));
      assert.ok(!seen.has(bee.handle as string), `handle unique: ${bee.handle}`);
      seen.add(bee.handle as string);
    }
    store.close();
  } finally {
    h.cleanup();
  }
});

test("handles.2: sustained collision grows the suffix instead of failing; a broken rng fails loudly", () => {
  const h = harness();
  try {
    // rng emitting only zeros: every 4-char mint is CL.0000, every 5-char
    // CL.00000, 6-char CL.000000 — three bees fit, the fourth must throw.
    const store = h.open({ random: () => 0 });
    const a = store.createBee({ name: "a", agent: "claude", substrate: "hsr", cwd: "/tmp" }).bee;
    const b = store.createBee({ name: "b", agent: "claude", substrate: "hsr", cwd: "/tmp" }).bee;
    const c = store.createBee({ name: "c", agent: "claude", substrate: "hsr", cwd: "/tmp" }).bee;
    assert.deepEqual([a.handle, b.handle, c.handle], ["CL.0000", "CL.00000", "CL.000000"]);
    assert.throws(
      () => store.createBee({ name: "d", agent: "claude", substrate: "hsr", cwd: "/tmp" }),
      (err: unknown) => err instanceof CoreError && /mintHandle/.test((err as Error).message),
    );
    store.close();
  } finally {
    h.cleanup();
  }
});

test("handles.3: explicit handle is preserved; a taken handle is a loud CoreError", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = store.createBee({ name: "imp", agent: "claude", substrate: "hsr", cwd: "/tmp", handle: "CL.7920" });
    assert.equal(bee.handle, "CL.7920");
    assert.throws(
      () => store.createBee({ name: "imp2", agent: "claude", substrate: "hsr", cwd: "/tmp", handle: "CL.7920" }),
      (err: unknown) => err instanceof CoreError && /already taken/.test((err as Error).message),
    );
    store.close();
  } finally {
    h.cleanup();
  }
});

test("handles.4: v9-shaped store backfills on open — an old pretty id becomes the handle, others get minted; stamp moves to v10", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '9');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT, parent_id TEXT,
        forked_from TEXT, fork_seed TEXT, account TEXT
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, imported_from)
        VALUES('CL.7920','old-pretty','claude','hsr','/tmp','active',5,'frozen');
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at)
        VALUES('ebdf9650-cf42-48f5-87a3-750d915599c7','uuid-born','codex','hsr','/tmp','active',6);
    `);
    db.close();
    const store = h.open();
    assert.equal(store.getBee("CL.7920")?.handle, "CL.7920", "old pretty id kept as handle");
    const minted = store.getBee("ebdf9650-cf42-48f5-87a3-750d915599c7")?.handle;
    assert.ok(minted && HANDLE_RE.test(minted) && minted.startsWith("CO."), `minted for uuid row: ${minted}`);
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 12);
      const idx = check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='bees_handle'").get();
      assert.ok(idx, "unique handle index exists");
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});
