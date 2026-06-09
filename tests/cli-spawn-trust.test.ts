import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { capture, hasSession, kill } from "../src/tmux.js";

const execFileAsync = promisify(execFile);

// Emulate a codex-style TUI: show the trust prompt, then on Enter re-render
// (alternate screen + clear) into the ready prompt. The alternate screen has
// no scrollback, so once cleared the trust text is gone from `capture-pane`,
// exactly like the real codex CLI.
const FAKE_CODEX = `#!/bin/sh
printf '\\033[?1049h'
printf 'Do you trust the contents of this directory?\\r\\n'
printf 'Press enter to continue\\r\\n'
read _
printf '\\033[2J\\033[H'
printf 'What can I help with?\\r\\n'
printf '> \\r\\n'
sleep 30
`;

test("spawn auto-accepts the codex trust prompt and waits for readiness", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-spawn-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "honeybee-spawn-cwd-"));
  const fakeCodex = join(storeRoot, "fake-codex.sh");
  await writeFile(fakeCodex, FAKE_CODEX);
  await chmod(fakeCodex, 0o755);
  const name = `hive-test-trust-${process.pid}`;
  try {
    const result = await runCli(
      ["spawn", "codex", "--name", name, "--cwd", cwd, "--boot-ms", "8000"],
      { HIVE_STORE_ROOT: storeRoot, HIVE_CODEX_CMD: fakeCodex },
    );

    assert.equal(result.code, 0, result.stderr);
    // Spawn must not return until readiness is confirmed, so the trust prompt
    // has already been accepted (Enter sent) and the ready prompt is showing.
    const pane = await capture(name, 100);
    assert.match(pane, /What can I help with/);
    assert.doesNotMatch(pane, /Do you trust the contents of this directory/);
  } finally {
    await kill(name);
    await rm(storeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("spawn --no-wait skips readiness and returns before the trust prompt is accepted", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "honeybee-spawn-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "honeybee-spawn-cwd-"));
  const fakeCodex = join(storeRoot, "fake-codex.sh");
  await writeFile(fakeCodex, FAKE_CODEX);
  await chmod(fakeCodex, 0o755);
  const name = `hive-test-nowait-${process.pid}`;
  try {
    const result = await runCli(
      ["spawn", "codex", "--name", name, "--cwd", cwd, "--no-wait"],
      { HIVE_STORE_ROOT: storeRoot, HIVE_CODEX_CMD: fakeCodex },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await hasSession(name), true);
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
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
}
