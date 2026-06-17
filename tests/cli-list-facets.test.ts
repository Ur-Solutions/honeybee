import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  swarmId?: string;
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
    ...(record.swarmId ? { swarmId: record.swarmId } : {}),
  };
  await writeFile(join(sessionsDir, `${record.name}.json`), `${JSON.stringify(full, null, 2)}\n`);
}

async function withFixture(fn: (ctx: { store: string; repoA: string; repoB: string; plain: string }) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "hive-list-facets-store-"));
  const repoA = realpathSync(await mkdtemp(join(tmpdir(), "hive-list-facets-alpha-")));
  const repoB = realpathSync(await mkdtemp(join(tmpdir(), "hive-list-facets-beta-")));
  const plain = realpathSync(await mkdtemp(join(tmpdir(), "hive-list-facets-plain-")));
  execFileSync("git", ["-C", repoA, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoB, "init", "-q"], { stdio: "ignore" });
  try {
    await fn({ store, repoA, repoB, plain });
  } finally {
    for (const d of [store, repoA, repoB, plain]) await rm(d, { recursive: true, force: true });
  }
}

test("hive list --json emits all records with the documented fields", async () => {
  await withFixture(async ({ store, repoA, repoB }) => {
    await seed(store, { name: "alpha", agent: "claude", cwd: repoA, colony: "frontend" });
    await seed(store, { name: "beta", agent: "codex", cwd: repoB, colony: "backend" });

    const { stdout } = await hive(store, "list", "--json");
    const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    const byName = new Map(rows.map((r) => [r.name as string, r]));
    const a = byName.get("alpha")!;
    // Documented fields are present.
    for (const key of ["ref", "name", "id", "agent", "state", "beeState", "detail", "colony", "node", "repo", "cwd", "createdAt", "updatedAt"]) {
      assert.ok(key in a, `field ${key} present`);
    }
    assert.equal(a.agent, "claude");
    assert.equal(a.colony, "frontend");
    assert.equal(a.cwd, repoA);
    assert.equal(a.repo, basename(repoA));
    // No live tmux → dead.
    assert.equal(a.beeState, "dead");
    assert.equal(a.state, "dead");
  });
});

test("hive list --agent filters by agent", async () => {
  await withFixture(async ({ store, repoA, repoB }) => {
    await seed(store, { name: "alpha", agent: "claude", cwd: repoA });
    await seed(store, { name: "beta", agent: "codex", cwd: repoB });

    const { stdout } = await hive(store, "list", "--agent", "claude", "--json");
    const rows = JSON.parse(stdout) as Array<{ name: string; agent: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "alpha");
    assert.equal(rows[0]!.agent, "claude");
  });
});

test("hive list --repo filters by repoTagFor of the cwd", async () => {
  await withFixture(async ({ store, repoA, repoB, plain }) => {
    await seed(store, { name: "alpha", agent: "claude", cwd: repoA });
    await seed(store, { name: "beta", agent: "codex", cwd: repoB });
    await seed(store, { name: "loner", agent: "claude", cwd: plain });

    const { stdout } = await hive(store, "list", "--repo", basename(repoA), "--json");
    const rows = JSON.parse(stdout) as Array<{ name: string; repo: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "alpha");
    assert.equal(rows[0]!.repo, basename(repoA));

    // A plain (non-repo) cwd is matched by its own basename.
    const out2 = await hive(store, "list", "--repo", basename(plain), "--json");
    const rows2 = JSON.parse(out2.stdout) as Array<{ name: string }>;
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0]!.name, "loner");
  });
});

test("hive list positional colony:x filters by colony", async () => {
  await withFixture(async ({ store, repoA, repoB }) => {
    await seed(store, { name: "alpha", agent: "claude", cwd: repoA, colony: "frontend" });
    await seed(store, { name: "beta", agent: "codex", cwd: repoB, colony: "backend" });

    const { stdout } = await hive(store, "list", "colony:frontend", "--json");
    const rows = JSON.parse(stdout) as Array<{ name: string; colony: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "alpha");
    assert.equal(rows[0]!.colony, "frontend");
  });
});

test("facets compose conjunctively (AND)", async () => {
  await withFixture(async ({ store, repoA, repoB }) => {
    await seed(store, { name: "alpha", agent: "claude", cwd: repoA, colony: "frontend" });
    await seed(store, { name: "beta", agent: "claude", cwd: repoB, colony: "frontend" });
    await seed(store, { name: "gamma", agent: "codex", cwd: repoA, colony: "frontend" });

    // colony AND agent AND repo → only alpha.
    const { stdout } = await hive(store, "list", "colony:frontend", "--agent", "claude", "--repo", basename(repoA), "--json");
    const rows = JSON.parse(stdout) as Array<{ name: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "alpha");

    // A non-matching conjunction over a known facet population yields nothing
    // (colony:frontend exists in the store, but no bee there runs `droid`).
    const out2 = await hive(store, "list", "colony:frontend", "--agent", "droid", "--json");
    assert.deepEqual(JSON.parse(out2.stdout), []);
  });
});

test("hive list rejects a genuinely unknown colony selector", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "alpha", agent: "claude", cwd: repoA, colony: "frontend" });
    await assert.rejects(
      hive(store, "list", "colony:does-not-exist", "--json"),
      /Unknown colony/,
    );
  });
});

test("hive list --state dead matches dead bees with no live tmux", async () => {
  await withFixture(async ({ store, repoA, repoB }) => {
    await seed(store, { name: "alpha", agent: "claude", cwd: repoA });
    await seed(store, { name: "beta", agent: "codex", cwd: repoB });

    const { stdout } = await hive(store, "list", "--state", "dead", "--json");
    const rows = JSON.parse(stdout) as Array<{ name: string; beeState: string }>;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.beeState === "dead"));
  });
});
