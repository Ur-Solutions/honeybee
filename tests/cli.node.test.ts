import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

async function hiveExpectFail(dir: string, ...args: string[]): Promise<string> {
  try {
    await hive(dir, ...args);
    throw new Error("expected command to fail");
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    return err.stderr ?? "";
  }
}

test("hive node list synthesizes implicit local on a fresh store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-node-"));
  try {
    const { stdout } = await hive(dir, "node", "list");
    assert.match(stdout, /local-tmux\s+local\s+localhost/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive node register / inspect / unregister round-trips a real record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-node-"));
  try {
    const reg = await hive(dir, "node", "register", "mini01", "--kind", "ssh-tmux", "--endpoint", "trmd@mini01", "--capabilities", "claude,codex");
    assert.match(reg.stdout, /registered\s+mini01\s+ssh-tmux\s+trmd@mini01/);

    const inspect = await hive(dir, "node", "inspect", "mini01");
    const parsed = JSON.parse(inspect.stdout);
    assert.equal(parsed.kind, "ssh-tmux");
    assert.deepEqual(parsed.capabilities, ["claude", "codex"]);

    await hive(dir, "node", "unregister", "mini01");
    const inspectFail = await hiveExpectFail(dir, "node", "inspect", "mini01");
    assert.match(inspectFail, /Unknown node/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive spawn --node fails early with an actionable error when the node is unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-node-"));
  try {
    const stderr = await hiveExpectFail(dir, "spawn", "codex", "--node", "ghost");
    assert.match(stderr, /Unknown node: ghost/);
    assert.match(stderr, /hive node register ghost/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive spawn --node fails early on capability mismatch with an actionable hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-node-"));
  try {
    await hive(dir, "node", "register", "mini01", "--kind", "ssh-tmux", "--endpoint", "trmd@mini01", "--capabilities", "claude,codex");
    const stderr = await hiveExpectFail(dir, "spawn", "grok", "--node", "mini01");
    assert.match(stderr, /Node "mini01" does not list capability "grok"/);
    assert.match(stderr, /hive node update mini01 --capabilities claude,codex,grok/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive node refuses unregistering the implicit local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-node-"));
  try {
    const stderr = await hiveExpectFail(dir, "node", "unregister", "local");
    assert.match(stderr, /Cannot unregister implicit local node/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive substrate list reports per-kind counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-substrate-"));
  try {
    await hive(dir, "node", "register", "mini01", "--kind", "ssh-tmux", "--endpoint", "trmd@mini01");
    const { stdout } = await hive(dir, "substrate", "list");
    assert.match(stdout, /local-tmux\s+1/);
    assert.match(stdout, /ssh-tmux\s+1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hive node register rejects ssh-command with whitespace and tells the user to use --ssh-args", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-node-"));
  try {
    const stderr = await hiveExpectFail(dir, "node", "register", "weird", "--kind", "ssh-tmux", "--endpoint", "x", "--ssh-command", "ssh -F /etc/ssh/config");
    assert.match(stderr, /must be a single binary path/);
    assert.match(stderr, /--ssh-args/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
