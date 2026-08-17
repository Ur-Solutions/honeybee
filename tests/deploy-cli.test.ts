// `hive deploy` CLI wiring: flag routing, usage refusals, and the read-only
// surfaces (--list). The effectful paths (build, restart, init migration) are
// covered in deploy-runtime.test.ts via injected hooks / are print-only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["tests/cli-entry.mjs", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

async function hiveExpectFail(dir: string, ...args: string[]): Promise<string> {
  try {
    await hive(dir, ...args);
    throw new Error(`expected command to fail: hive ${args.join(" ")}`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    return err.stderr ?? "";
  }
}

async function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-deploy-cli-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function seedRuntime(dir: string): Promise<void> {
  const root = join(dir, "runtime");
  await mkdir(join(root, SHA_A, "dist"), { recursive: true });
  await mkdir(join(root, SHA_B, "dist"), { recursive: true });
  await writeFile(join(root, SHA_A, "dist", "cli.js"), "console.log('a');\n");
  await writeFile(join(root, SHA_B, "dist", "cli.js"), "console.log('b');\n");
  await symlink(SHA_B, join(root, "current"));
  await writeFile(
    join(root, "deploys.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        { sha: SHA_A, at: "2026-08-01T00:00:00.000Z", artifactHash: "1".repeat(64), by: "op" },
        { sha: SHA_B, at: "2026-08-02T00:00:00.000Z", artifactHash: "2".repeat(64), by: "op" },
      ],
    }),
  );
}

test("hive deploy --list on an empty store points at hive deploy", async () => {
  await withStore(async (dir) => {
    const { stdout } = await hive(dir, "deploy", "--list");
    assert.match(stdout, /no deploys recorded/);
  });
});

test("hive deploy --list prints history newest-first with the current marker", async () => {
  await withStore(async (dir) => {
    await seedRuntime(dir);
    const { stdout } = await hive(dir, "deploy", "--list");
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0]!.split("\t"), [SHA_B, "2026-08-02T00:00:00.000Z", "2".repeat(64), "op", "current"]);
    assert.deepEqual(lines[1]!.split("\t"), [SHA_A, "2026-08-01T00:00:00.000Z", "1".repeat(64), "op", ""]);
  });
});

test("hive deploy --list --json emits root, current, and entries", async () => {
  await withStore(async (dir) => {
    await seedRuntime(dir);
    const { stdout } = await hive(dir, "deploy", "--list", "--json");
    const parsed = JSON.parse(stdout) as { root: string; current: string | null; entries: Array<{ sha: string }> };
    assert.equal(parsed.root, join(dir, "runtime"));
    assert.equal(parsed.current, SHA_B);
    assert.deepEqual(parsed.entries.map((entry) => entry.sha), [SHA_A, SHA_B]);
  });
});

test("hive deploy refuses conflicting modes and stray positionals", async () => {
  await withStore(async (dir) => {
    assert.match(await hiveExpectFail(dir, "deploy", "--list", "--rollback"), /Usage: hive deploy/);
    assert.match(await hiveExpectFail(dir, "deploy", SHA_A, "--rollback"), /Usage: hive deploy/);
    assert.match(await hiveExpectFail(dir, "deploy", "one", "two"), /Usage: hive deploy/);
  });
});

test("hive deploy outside the honeybee repo refuses before doing anything", async () => {
  await withStore(async (dir) => {
    const elsewhere = await mkdtemp(join(tmpdir(), "hive-deploy-elsewhere-"));
    try {
      const stderr = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "tests", "cli-entry.mjs"), "deploy"],
        { cwd: elsewhere, env: ENV(dir) },
      ).then(
        () => {
          throw new Error("expected deploy to fail outside the repo");
        },
        (error: NodeJS.ErrnoException & { stderr?: string }) => error.stderr ?? "",
      );
      assert.match(stderr, /not a git repository here|not the honeybee repo/);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
