import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { deadSessionRecords, olderThanMillis, parseAge } from "../src/clean.js";
import type { SessionRecord } from "../src/store.js";

const execFileAsync = promisify(execFile);

test("deadSessionRecords returns sessions whose tmux target is not live", () => {
  const records = [
    session("CO.aaa", "CO-aaa"),
    session("CL.bbb", "CL-bbb"),
    session("GR.ccc", "GR-ccc"),
  ];

  assert.deepEqual(deadSessionRecords(records, new Set(["CO-aaa", "GR-ccc"])).map((record) => record.name), ["CL.bbb"]);
});

test("olderThanMillis filters by last update age", () => {
  const now = Date.parse("2026-05-28T12:00:00.000Z");
  const fresh = session("fresh", "fresh-target");
  fresh.updatedAt = "2026-05-28T11:45:00.000Z";
  const stale = session("stale", "stale-target");
  stale.updatedAt = "2026-05-28T09:30:00.000Z";

  assert.deepEqual(olderThanMillis([fresh, stale], 60 * 60 * 1000, now).map((record) => record.name), ["stale"]);
});

test("parseAge accepts compact duration strings", () => {
  assert.equal(parseAge("30m"), 30 * 60 * 1000);
  assert.equal(parseAge("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseAge("7d"), 7 * 24 * 60 * 60 * 1000);
});

test("hive clean --dead removes dead session metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const dead = session("dead", "dead-target");
    dead.updatedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await writeFile(join(dir, "sessions", "dead.json"), `${JSON.stringify(dead)}\n`);

    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(dryRun.stdout, /dead\tdead\tdead\tcodex\t\d+[smhdwoy]\t\/tmp/);
    await readFile(join(dir, "sessions", "dead.json"), "utf8");

    const cleaned = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(cleaned.stdout, /cleaned\tdead/);
    await assert.rejects(readFile(join(dir, "sessions", "dead.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive clean --dead --older-than only removes stale dead sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-clean-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    const fresh = session("fresh", "fresh-target");
    fresh.updatedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const stale = session("stale", "stale-target");
    stale.updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await writeFile(join(dir, "sessions", "fresh.json"), `${JSON.stringify(fresh)}\n`);
    await writeFile(join(dir, "sessions", "stale.json"), `${JSON.stringify(stale)}\n`);

    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead", "--older-than", "1h", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.doesNotMatch(dryRun.stdout, /fresh/);
    assert.match(dryRun.stdout, /stale/);

    const cleaned = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "clean", "--dead", "--older-than", "1h"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(cleaned.stdout, /cleaned\tstale/);
    assert.doesNotMatch(cleaned.stdout, /fresh/);
    await readFile(join(dir, "sessions", "fresh.json"), "utf8");
    await assert.rejects(readFile(join(dir, "sessions", "stale.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function session(name: string, tmuxTarget: string): SessionRecord {
  return {
    name,
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    status: "running",
  };
}
