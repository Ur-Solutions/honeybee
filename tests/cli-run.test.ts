import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { hasSession, kill } from "../src/tmux.js";

const execFileAsync = promisify(execFile);

test("run sends to arbitrary executables without provider readiness checks", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-run-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "honeybee-run-cwd-"));
  const name = `hive-test-arbitrary-${process.pid}`;
  try {
    const result = await runCli(
      [
        "run",
        "sh",
        "--name",
        name,
        "-p",
        "echo HIVE_ARBITRARY_OK",
        "--cwd",
        cwd,
        "--boot-ms",
        "500",
        "--wait-ms",
        "300",
        "--rm",
        "--",
        "-i",
      ],
      { HIVE_STORE_ROOT: storeRoot },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /HIVE_ARBITRARY_OK/);
    assert.equal(await hasSession(name), false);
  } finally {
    await kill(name);
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run --rm cleans up when known driver readiness fails", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-run-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "honeybee-run-cwd-"));
  const name = `hive-test-cleanup-${process.pid}`;
  try {
    const result = await runCli(
      [
        "run",
        "claude",
        "--name",
        name,
        "-p",
        "echo SHOULD_NOT_SEND",
        "--cwd",
        cwd,
        "--boot-ms",
        "300",
        "--rm",
        "--",
        "-i",
      ],
      { HIVE_STORE_ROOT: storeRoot, HIVE_CLAUDE_CMD: "sh" },
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Timed out waiting for claude to become ready/);
    assert.equal(await hasSession(name), false);
    assert.deepEqual(await sessionFiles(storeRoot), []);
  } finally {
    await kill(name);
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, NO_COLOR: "1" },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}

async function sessionFiles(storeRoot: string): Promise<string[]> {
  return readdir(join(storeRoot, "sessions")).catch(() => []);
}
