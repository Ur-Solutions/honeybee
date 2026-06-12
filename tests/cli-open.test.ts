import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

async function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-open-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("open forwards unknown flags to the bee without --", async () => {
  await withStore(async (dir) => {
    const { stdout } = await hive(dir, "open", "claude", "--raw", "--resume", "c5dab839-0c3f-4a59-8b53-4f5d84184eac", "--print");
    assert.match(stdout, /claude --dangerously-skip-permissions --resume c5dab839-0c3f-4a59-8b53-4f5d84184eac/);
    // open's own flags must not leak into the bee command.
    assert.doesNotMatch(stdout, /--print/);
  });
});

test("open keeps -- passthrough for flags open itself owns", async () => {
  await withStore(async (dir) => {
    const { stdout } = await hive(dir, "open", "claude", "--raw", "--print", "--", "--print", "--continue");
    assert.match(stdout, /claude --dangerously-skip-permissions --print --continue/);
  });
});

test("open seeds claude home acceptances (bypass, onboarding, folder trust)", async () => {
  await withStore(async (dir) => {
    const home = join(dir, "home");
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "hive-open-cwd-")));
    try {
      await hive(dir, "open", "claude", "--raw", "--home", home, "--cwd", cwd, "--print");
      const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
      assert.equal(config.hasCompletedOnboarding, true);
      assert.equal(config.bypassPermissionsModeAccepted, true);
      assert.equal(config.projects[cwd].hasTrustDialogAccepted, true);
      assert.equal(config.projects[cwd].hasCompletedProjectOnboarding, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("open merges acceptances into an existing .claude.json without clobbering it", async () => {
  await withStore(async (dir) => {
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { email: "x@y.z" }, projects: { "/elsewhere": { hasTrustDialogAccepted: true } } }));
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "hive-open-cwd-")));
    try {
      await hive(dir, "open", "claude", "--raw", "--home", home, "--cwd", cwd, "--print");
      const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
      assert.deepEqual(config.oauthAccount, { email: "x@y.z" });
      assert.equal(config.projects["/elsewhere"].hasTrustDialogAccepted, true);
      assert.equal(config.projects[cwd].hasTrustDialogAccepted, true);
      assert.equal(config.bypassPermissionsModeAccepted, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("open respects --no-yolo and --no-accept-trust when seeding", async () => {
  await withStore(async (dir) => {
    const home = join(dir, "home");
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "hive-open-cwd-")));
    try {
      const { stdout } = await hive(dir, "open", "claude", "--raw", "--home", home, "--cwd", cwd, "--no-yolo", "--no-accept-trust", "--print");
      assert.doesNotMatch(stdout, /--dangerously-skip-permissions/);
      const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
      assert.equal(config.hasCompletedOnboarding, true);
      assert.equal(config.bypassPermissionsModeAccepted, undefined);
      assert.equal(config.projects, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("open --window/--app imply --raw (print shows the raw agent command)", async () => {
  await withStore(async (dir) => {
    const { stdout } = await hive(dir, "open", "claude", "--window", "--print");
    assert.match(stdout, /claude --dangerously-skip-permissions/);
    assert.doesNotMatch(stdout, /tmux/);
  });
});
