import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

type SeedRecord = {
  name: string;
  agent: string;
  cwd: string;
  colony?: string;
  tags?: string[];
  parentId?: string;
  reportsToId?: string;
  forkedFromId?: string;
};

async function seed(dir: string, record: SeedRecord): Promise<void> {
  const sessionsDir = join(dir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const now = "2026-06-17T00:00:00.000Z";
  const full = {
    name: record.name,
    agent: record.agent,
    cwd: record.cwd,
    command: `${record.agent} --foo`,
    tmuxTarget: record.name,
    id: record.name,
    createdAt: now,
    updatedAt: now,
    status: "dead" as const,
    ...(record.colony ? { colony: record.colony } : {}),
    ...(record.tags ? { tags: record.tags } : {}),
    ...(record.parentId ? { parentId: record.parentId } : {}),
    ...(record.reportsToId ? { reportsToId: record.reportsToId } : {}),
    ...(record.forkedFromId ? { forkedFromId: record.forkedFromId } : {}),
  };
  await writeFile(join(sessionsDir, `${record.name}.json`), `${JSON.stringify(full, null, 2)}\n`);
}

async function readField<T = unknown>(dir: string, name: string, field: string): Promise<T | undefined> {
  const raw = await readFile(join(dir, "sessions", `${name}.json`), "utf8");
  return (JSON.parse(raw) as Record<string, T>)[field];
}

async function recordExists(dir: string, name: string): Promise<boolean> {
  try {
    await readFile(join(dir, "sessions", `${name}.json`), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function withFixture(fn: (ctx: { store: string; repoA: string }) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "hive-own-store-"));
  const repoA = realpathSync(await mkdtemp(join(tmpdir(), "hive-own-repo-")));
  execFileSync("git", ["-C", repoA, "init", "-q"], { stdio: "ignore" });
  try {
    await fn({ store, repoA });
  } finally {
    for (const d of [store, repoA]) await rm(d, { recursive: true, force: true });
  }
}

test("R1: hive own sets reportsToId and owns: returns the owned bees", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "me", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.b", agent: "claude", cwd: repoA });

    await hive(store, "own", "me", "CL.a", "CL.b");
    assert.equal(await readField(store, "CL.a", "reportsToId"), "me");
    assert.equal(await readField(store, "CL.b", "reportsToId"), "me");

    const owned = JSON.parse((await hive(store, "list", "owns:me", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(owned.map((r) => r.name).sort(), ["CL.a", "CL.b"]);
  });
});

test("R1: owned-by:/reports-to: are aliases of owns:", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "me", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA });
    await hive(store, "own", "me", "CL.a");

    for (const verb of ["owns:me", "owned-by:me", "reports-to:me"]) {
      const rows = JSON.parse((await hive(store, "list", verb, "--json")).stdout) as Array<{ name: string }>;
      assert.deepEqual(rows.map((r) => r.name), ["CL.a"], `selector ${verb}`);
    }
  });
});

test("hive own errors when the owner selector matches 0 or >1 bees", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA, colony: "fe" });
    await seed(store, { name: "CL.b", agent: "claude", cwd: repoA, colony: "fe" });

    await assert.rejects(hive(store, "own", "colony:fe", "CL.a"), (err: unknown) => {
      const message = err instanceof Error ? `${err.message}${(err as { stderr?: string }).stderr ?? ""}` : String(err);
      assert.match(message, /matched 2 bees|pick one/);
      return true;
    });
    await assert.rejects(hive(store, "own", "colony:nope", "CL.a"), (err: unknown) => {
      const message = err instanceof Error ? `${err.message}${(err as { stderr?: string }).stderr ?? ""}` : String(err);
      assert.match(message, /Unknown colony|matched no bee/);
      return true;
    });
  });
});

test("R3: hive own --clear removes the edge and never kills the bee", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "me", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.b", agent: "claude", cwd: repoA });
    await hive(store, "own", "me", "CL.a", "CL.b");

    await hive(store, "own", "CL.a", "--clear");
    assert.equal(await readField(store, "CL.a", "reportsToId"), undefined);
    assert.equal(await recordExists(store, "CL.a"), true);

    const owned = JSON.parse((await hive(store, "list", "owns:me", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(owned.map((r) => r.name), ["CL.b"]);
  });
});

test("R3: hive move <bee> --owner '' clears ownership equivalently", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "me", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA, reportsToId: "me" });

    await hive(store, "move", "CL.a", "--owner", "");
    assert.equal(await readField(store, "CL.a", "reportsToId"), undefined);
    assert.equal(await recordExists(store, "CL.a"), true);
  });
});

test("hive move <bee> --owner <o> is an alias for hive own", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "me", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA });

    await hive(store, "move", "CL.a", "--owner", "me");
    assert.equal(await readField(store, "CL.a", "reportsToId"), "me");
    const owned = JSON.parse((await hive(store, "list", "owns:me", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(owned.map((r) => r.name), ["CL.a"]);
  });
});

test("hive move <bee> --colony reassigns the colony and colony: selector follows", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA, colony: "fe" });

    await hive(store, "move", "CL.a", "--colony", "x");
    assert.equal(await readField(store, "CL.a", "colony"), "x");

    const rows = JSON.parse((await hive(store, "list", "colony:x", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(rows.map((r) => r.name), ["CL.a"]);
  });
});

test("the hive tag reserved-namespace rejection redirects to a real hive move", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA, colony: "fe" });
    await assert.rejects(hive(store, "tag", "CL.a", "colony:other"), (err: unknown) => {
      const message = err instanceof Error ? `${err.message}${(err as { stderr?: string }).stderr ?? ""}` : String(err);
      assert.match(message, /hive move/);
      return true;
    });
    // colony unchanged.
    assert.equal(await readField(store, "CL.a", "colony"), "fe");
  });
});

test("R2: children-of: returns the child set via parentId", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.kid", agent: "claude", cwd: repoA, parentId: "CL.a" });
    await seed(store, { name: "CL.other", agent: "claude", cwd: repoA });

    const rows = JSON.parse((await hive(store, "list", "children-of:CL.a", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(rows.map((r) => r.name), ["CL.kid"]);
  });
});

test("forks-of: returns the fork set via forkedFromId", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.src", agent: "claude", cwd: repoA });
    await seed(store, { name: "CL.fork", agent: "claude", cwd: repoA, forkedFromId: "CL.src" });

    const rows = JSON.parse((await hive(store, "list", "forks-of:CL.src", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(rows.map((r) => r.name), ["CL.fork"]);
  });
});

test("dead-anchor: owns:<removed-owner> still returns surviving bees", async () => {
  await withFixture(async ({ store, repoA }) => {
    // The owner record never exists; bees carry its id directly.
    await seed(store, { name: "CL.a", agent: "claude", cwd: repoA, reportsToId: "GONE.id" });
    await seed(store, { name: "CL.b", agent: "claude", cwd: repoA, reportsToId: "GONE.id" });

    const rows = JSON.parse((await hive(store, "list", "owns:GONE.id", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(rows.map((r) => r.name).sort(), ["CL.a", "CL.b"]);
  });
});
