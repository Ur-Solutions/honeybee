/**
 * Codex home log reclaim — real sqlite3, no codex and no network.
 *
 * Builds a home whose logs DB looks like the ones hive produces in the wild
 * (WAL mode, auto_vacuum=INCREMENTAL, rows deleted by retention but never
 * released) and checks that a boot-time pass actually shrinks it.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { codexHomeMaintenanceEnabled, reclaimCodexHomeLogs } from "../src/codexHomeMaintenance.js";

const execFileP = promisify(execFile);

async function hasSqlite3(): Promise<boolean> {
  try {
    await execFileP("sqlite3", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A logs DB carrying a large freelist and an unchecked WAL, as codex leaves it.
 *
 * auto_vacuum MUST be set before anything writes the DB header — `journal_mode`
 * first silently leaves the DB at auto_vacuum=NONE, where incremental_vacuum
 * does nothing and this fixture would not resemble a real home at all.
 */
async function seedBloatedHome(home: string, autoVacuum = "INCREMENTAL"): Promise<string> {
  const db = join(home, "logs_2.sqlite");
  await execFileP("sqlite3", [
    db,
    [
      `pragma auto_vacuum=${autoVacuum};`,
      "pragma journal_mode=WAL;",
      "create table logs (id integer primary key autoincrement, ts integer not null, body text);",
      "begin;",
      "insert into logs (ts, body) select value, hex(randomblob(512)) from generate_series(1, 20000);",
      "commit;",
      // Codex's retention prunes rows; nothing ever releases the pages they held.
      "delete from logs where id > 100;",
    ].join(" "),
  ]);
  return db;
}

const sizeOf = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
};

test("boot-time reclaim releases the freelist and truncates the WAL of a quiet home", async (t) => {
  if (!(await hasSqlite3())) return t.skip("sqlite3 not available");
  const home = await mkdtemp(join(tmpdir(), "honeybee-codex-home-"));
  try {
    const db = await seedBloatedHome(home);
    const before = (await sizeOf(db)) + (await sizeOf(`${db}-wal`));
    const { stdout: mode } = await execFileP("sqlite3", [db, "pragma auto_vacuum;"]);
    assert.equal(mode.trim(), "2", "fixture must match the real homes, which report INCREMENTAL");

    const result = await reclaimCodexHomeLogs(home);
    const after = (await sizeOf(db)) + (await sizeOf(`${db}-wal`));

    assert.equal(result.busy, false);
    assert.ok(result.reclaimedBytes > 0, `expected bytes reclaimed, got ${result.reclaimedBytes}`);
    assert.ok(after < before, `expected ${after} < ${before}`);

    // Reclaim is a storage operation: every surviving row must still be there.
    const { stdout } = await execFileP("sqlite3", [db, "select count(*) from logs;"]);
    assert.equal(stdout.trim(), "100");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reclaim leaves a home with no logs DBs untouched rather than failing a boot", async () => {
  const home = await mkdtemp(join(tmpdir(), "honeybee-codex-home-"));
  try {
    await writeFile(join(home, "auth.json"), "{}");
    assert.deepEqual(await reclaimCodexHomeLogs(home), { reclaimedBytes: 0, busy: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reclaim never throws a boot-blocking error on an unreadable home or a corrupt DB", async (t) => {
  assert.deepEqual(await reclaimCodexHomeLogs("/definitely/not/a/codex/home"), { reclaimedBytes: 0, busy: false });

  if (!(await hasSqlite3())) return t.skip("sqlite3 not available");
  const home = await mkdtemp(join(tmpdir(), "honeybee-codex-home-"));
  try {
    await writeFile(join(home, "logs_2.sqlite"), "this is not a sqlite database");
    const result = await reclaimCodexHomeLogs(home);
    assert.equal(result.reclaimedBytes, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a budget that expires mid-vacuum still reports and keeps the bytes already reclaimed", async (t) => {
  if (!(await hasSqlite3())) return t.skip("sqlite3 not available");
  const home = await mkdtemp(join(tmpdir(), "honeybee-codex-home-"));
  try {
    const db = await seedBloatedHome(home);
    const before = (await sizeOf(db)) + (await sizeOf(`${db}-wal`));

    // A budget too small to finish the freelist. The checkpoint has already run
    // by then, so its reclaim must survive the vacuum being cut short — the
    // first version threw on the truncated chunk and reported 0 despite having
    // freed 2.2GB of WAL on a real home.
    const result = await reclaimCodexHomeLogs(home, { budgetMs: 900 });
    const after = (await sizeOf(db)) + (await sizeOf(`${db}-wal`));

    assert.equal(result.busy, false);
    assert.equal(result.reclaimedBytes, before - after, "accounting must match what actually happened on disk");
    const { stdout } = await execFileP("sqlite3", [db, "select count(*) from logs;"]);
    assert.equal(stdout.trim(), "100");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a DB without auto_vacuum=INCREMENTAL returns fast instead of spinning out the boot budget", async (t) => {
  if (!(await hasSqlite3())) return t.skip("sqlite3 not available");
  const home = await mkdtemp(join(tmpdir(), "honeybee-codex-home-"));
  try {
    // incremental_vacuum cannot release anything here, so the loop would burn
    // the full budget on every boot of this home for nothing.
    await seedBloatedHome(home, "NONE");
    const started = Date.now();
    const result = await reclaimCodexHomeLogs(home, { budgetMs: 5_000 });
    const elapsed = Date.now() - started;

    assert.equal(result.busy, false);
    assert.ok(elapsed < 2_000, `expected an early return, took ${elapsed}ms`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reclaim honours its budget and the HIVE_CODEX_HOME_MAINTENANCE kill switch", async (t) => {
  assert.equal(codexHomeMaintenanceEnabled({ HIVE_CODEX_HOME_MAINTENANCE: "0" }), false);
  assert.equal(codexHomeMaintenanceEnabled({}), true);

  if (!(await hasSqlite3())) return t.skip("sqlite3 not available");
  const home = await mkdtemp(join(tmpdir(), "honeybee-codex-home-"));
  try {
    const db = await seedBloatedHome(home);
    const before = await sizeOf(db);
    const disabled = await reclaimCodexHomeLogs(home, { env: { HIVE_CODEX_HOME_MAINTENANCE: "0" } });
    assert.deepEqual(disabled, { reclaimedBytes: 0, busy: false });
    assert.equal(await sizeOf(db), before, "the kill switch must not touch the DB at all");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
