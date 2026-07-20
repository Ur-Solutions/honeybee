import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("hive-x with no args reports the same usage as hive x", async () => {
  const fast = await runCli("src/cli-x.ts", []);
  const full = await runCli("src/cli.ts", ["x"]);

  assert.equal(fast.code, 1);
  assert.equal(fast.stdout, full.stdout);
  assert.equal(fast.stderr, full.stderr);
  assert.match(fast.stderr, /Usage: hive x <bee> <prompt>/);
});

test("hive-x preserves cmdX validation errors", async () => {
  const fast = await runCli("src/cli-x.ts", ["sh", "do something", "--count", "3"]);
  const full = await runCli("src/cli.ts", ["x", "sh", "do something", "--count", "3"]);

  assert.equal(fast.code, 1);
  assert.equal(fast.stdout, full.stdout);
  assert.equal(fast.stderr, full.stderr);
  assert.match(fast.stderr, /hive x spawns a single bee/);
});

async function runCli(entrypoint: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", entrypoint, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}
