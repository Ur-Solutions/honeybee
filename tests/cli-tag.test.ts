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

type SeedRecord = { name: string; agent: string; cwd: string; colony?: string; tags?: string[] };

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
  };
  await writeFile(join(sessionsDir, `${record.name}.json`), `${JSON.stringify(full, null, 2)}\n`);
}

async function readTags(dir: string, name: string): Promise<string[] | undefined> {
  const raw = await readFile(join(dir, "sessions", `${name}.json`), "utf8");
  return (JSON.parse(raw) as { tags?: string[] }).tags;
}

async function withFixture(fn: (ctx: { store: string; repoA: string }) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "hive-tag-store-"));
  const repoA = realpathSync(await mkdtemp(join(tmpdir(), "hive-tag-repo-")));
  execFileSync("git", ["-C", repoA, "init", "-q"], { stdio: "ignore" });
  try {
    await fn({ store, repoA });
  } finally {
    for (const d of [store, repoA]) await rm(d, { recursive: true, force: true });
  }
}

test("T1: hive tag adds user tags, --tag lists them, --remove drops them", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.x", agent: "claude", cwd: repoA });

    await hive(store, "tag", "CL.x", "migration", "prio:p1");
    assert.deepEqual(await readTags(store, "CL.x"), ["migration", "prio:p1"]);

    const byMigration = JSON.parse((await hive(store, "list", "--tag", "migration", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(byMigration.map((r) => r.name), ["CL.x"]);

    const byPrio = JSON.parse((await hive(store, "list", "--tag", "prio:p1", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(byPrio.map((r) => r.name), ["CL.x"]);

    await hive(store, "tag", "CL.x", "--remove", "migration");
    assert.deepEqual(await readTags(store, "CL.x"), ["prio:p1"]);

    const afterRemove = JSON.parse((await hive(store, "list", "--tag", "migration", "--json")).stdout) as Array<unknown>;
    assert.deepEqual(afterRemove, []);
  });
});

test("T1: hive tag --list shows the effective tag set (reserved + user)", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.x", agent: "claude", cwd: repoA, colony: "fe", tags: ["migration"] });
    const { stdout } = await hive(store, "tag", "CL.x", "--list");
    assert.match(stdout, /colony:fe/);
    assert.match(stdout, /agent:claude/);
    assert.match(stdout, /migration/);
  });
});

test("T2: a reserved-namespace tag is rejected with a redirect; the bee is unchanged", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.x", agent: "claude", cwd: repoA, colony: "fe" });
    await assert.rejects(hive(store, "tag", "CL.x", "colony:other"), (err: unknown) => {
      const message = err instanceof Error ? `${err.message}${(err as { stderr?: string }).stderr ?? ""}` : String(err);
      assert.match(message, /reserved facet/);
      assert.match(message, /hive move/);
      return true;
    });
    // colony unchanged, no user tag smuggled in.
    assert.equal(await readTags(store, "CL.x"), undefined);
    const rows = JSON.parse((await hive(store, "list", "--json")).stdout) as Array<{ name: string; colony: string }>;
    assert.equal(rows.find((r) => r.name === "CL.x")!.colony, "fe");
  });
});

test("T3: a pre-existing record with colony but no tags matches --tag colony:fe (derived on read)", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.x", agent: "claude", cwd: repoA, colony: "fe" });
    // No migration step — the reserved tag is derived.
    const rows = JSON.parse((await hive(store, "list", "--tag", "colony:fe", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(rows.map((r) => r.name), ["CL.x"]);
    // The selector form also works.
    const rows2 = JSON.parse((await hive(store, "list", "colony:fe", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(rows2.map((r) => r.name), ["CL.x"]);
  });
});

test("T4: --tag repeats conjunctively and composes with other facets", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.x", agent: "claude", cwd: repoA, colony: "fe", tags: ["migration", "prio:p1"] });
    await seed(store, { name: "CL.y", agent: "claude", cwd: repoA, colony: "fe", tags: ["migration"] });
    await seed(store, { name: "CO.z", agent: "codex", cwd: repoA, colony: "fe", tags: ["migration", "prio:p1"] });

    // migration AND prio:p1 → CL.x and CO.z.
    const both = JSON.parse((await hive(store, "list", "--tag", "migration", "--tag", "prio:p1", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(both.map((r) => r.name).sort(), ["CL.x", "CO.z"]);

    // migration AND prio:p1 AND agent claude → CL.x only.
    const composed = JSON.parse(
      (await hive(store, "list", "--tag", "migration", "--tag", "prio:p1", "--agent", "claude", "--json")).stdout,
    ) as Array<{ name: string }>;
    assert.deepEqual(composed.map((r) => r.name), ["CL.x"]);

    // --colony composes with --tag.
    const colonyTag = JSON.parse((await hive(store, "list", "--colony", "fe", "--tag", "prio:p1", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(colonyTag.map((r) => r.name).sort(), ["CL.x", "CO.z"]);
  });
});

test("tag a whole colony in one command (multi-bee selector)", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.x", agent: "claude", cwd: repoA, colony: "fe" });
    await seed(store, { name: "CL.y", agent: "claude", cwd: repoA, colony: "fe" });
    await seed(store, { name: "CO.z", agent: "codex", cwd: repoA, colony: "be" });

    await hive(store, "tag", "colony:fe", "waiting-review");
    assert.deepEqual(await readTags(store, "CL.x"), ["waiting-review"]);
    assert.deepEqual(await readTags(store, "CL.y"), ["waiting-review"]);
    assert.equal(await readTags(store, "CO.z"), undefined);
  });
});

test("back-compat: legacy colony:/@swarm selectors and #tag selectors filter list", async () => {
  await withFixture(async ({ store, repoA }) => {
    await seed(store, { name: "CL.x", agent: "claude", cwd: repoA, colony: "fe", tags: ["migration"] });
    await seed(store, { name: "CO.z", agent: "codex", cwd: repoA, colony: "be" });

    const colonyRows = JSON.parse((await hive(store, "list", "colony:fe", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(colonyRows.map((r) => r.name), ["CL.x"]);

    const hashRows = JSON.parse((await hive(store, "list", "#migration", "--json")).stdout) as Array<{ name: string }>;
    assert.deepEqual(hashRows.map((r) => r.name), ["CL.x"]);
  });
});
