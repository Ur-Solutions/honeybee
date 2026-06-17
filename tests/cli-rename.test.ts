import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { SessionRecord } from "../src/store.js";

const execFileAsync = promisify(execFile);

// A stub title generator (sh -c, prompt on stdin) keeps the test off the real
// claude/codex CLIs while exercising the full cmdRename → generateTitle path.
const STUB_COMMAND = 'cat >/dev/null; printf "Stub Generated Title"';

async function withStore(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-rename-"));
  try {
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "config.json"), JSON.stringify({ naming: { command: STUB_COMMAND } }));
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeBee(root: string, overrides: Partial<SessionRecord> = {}): Promise<string> {
  const name = overrides.name ?? "CL.a3f";
  const record: SessionRecord = {
    name,
    agent: "shell", // no transcript provider → title derives from the brief alone
    cwd: root,
    command: "sh",
    tmuxTarget: `hive:${name}`,
    createdAt: "2026-06-10T11:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    status: "running",
    ...overrides,
  };
  await writeFile(join(root, "sessions", `${name}.json`), JSON.stringify(record, null, 2));
  return name;
}

async function readBee(root: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "sessions", `${name}.json`), "utf8"));
}

async function runCli(args: string[], root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: root, NO_COLOR: "1" },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

test("rename <title>: sets a user title", async () => {
  await withStore(async (root) => {
    const name = await writeBee(root);
    const result = await runCli(["rename", name, "My", "explicit", "title"], root);
    assert.equal(result.code, 0, result.stderr);
    const rec = await readBee(root, name);
    assert.equal(rec.title, "My explicit title");
    assert.equal(rec.titleSource, "user");
  });
});

test("rename --auto: derives a title via the configured generator", async () => {
  await withStore(async (root) => {
    const name = await writeBee(root, { brief: "Refactor the parser tokenizer" });
    const result = await runCli(["rename", name, "--auto"], root);
    assert.equal(result.code, 0, result.stderr);
    const rec = await readBee(root, name);
    assert.equal(rec.title, "Stub Generated Title");
    assert.equal(rec.titleSource, "auto");
    assert.ok(rec.autoTitleAt, "stamps the attempt time for the daemon backoff");
  });
});

test("rename --auto: works past the attempt cap (manual override)", async () => {
  await withStore(async (root) => {
    const name = await writeBee(root, { brief: "Ship the webhook retry", autoTitleAttempts: 3 });
    const result = await runCli(["rename", name, "--auto"], root);
    assert.equal(result.code, 0, result.stderr);
    const rec = await readBee(root, name);
    assert.equal(rec.title, "Stub Generated Title");
    assert.equal(rec.titleSource, "auto");
  });
});

test("rename --auto: errors when there is nothing to derive a title from", async () => {
  await withStore(async (root) => {
    const name = await writeBee(root); // no brief, no transcript
    const result = await runCli(["rename", name, "--auto"], root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no brief and no transcript/);
  });
});

test("rename --clear: drops title, source, and the auto-title bookkeeping", async () => {
  await withStore(async (root) => {
    const name = await writeBee(root, {
      title: "Old title",
      titleSource: "auto",
      autoTitleAt: "2026-06-10T12:00:00.000Z",
      autoTitleAttempts: 3,
    });
    const result = await runCli(["rename", name, "--clear"], root);
    assert.equal(result.code, 0, result.stderr);
    const rec = await readBee(root, name);
    assert.equal(rec.title, undefined);
    assert.equal(rec.titleSource, undefined);
    assert.equal(rec.autoTitleAt, undefined);
    assert.equal(rec.autoTitleAttempts, undefined, "cleared so the daemon treats it as a fresh candidate");
  });
});

test("rename: rejects an explicit title plus --auto/--clear", async () => {
  await withStore(async (root) => {
    const name = await writeBee(root, { brief: "x" });
    const both = await runCli(["rename", name, "--auto", "some", "title"], root);
    assert.notEqual(both.code, 0);
    assert.match(both.stderr, /Usage: hive rename/);
  });
});
