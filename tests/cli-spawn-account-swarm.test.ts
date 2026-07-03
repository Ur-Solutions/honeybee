import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { accountDir, addAccount, type AccountRecord } from "../src/accounts.js";
import { identityRecipeForAgent } from "../src/drivers.js";
import { writeFrameFromObject } from "../src/frame.js";
import { loadSession, type SessionRecord } from "../src/store.js";
import { setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";

const execFileAsync = promisify(execFile);

async function withStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-spawn-account-swarm-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const previousKeychain = process.env.HIVE_NO_KEYCHAIN;
  process.env.HIVE_STORE_ROOT = dir;
  process.env.HIVE_NO_KEYCHAIN = "1";
  try {
    return await fn(dir);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    if (previousKeychain === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = previousKeychain;
    await rm(dir, { recursive: true, force: true });
  }
}

async function withIsolatedTmux<T>(fn: (socket: string) => Promise<T>): Promise<T> {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-cli-spawn-account-socket-"));
  const socket = join(socketDir, "s.sock");
  const previousTmpdir = process.env.TMUX_TMPDIR;
  const previousSocket = process.env.HIVE_TMUX_SOCKET;
  const previousTmux = process.env.TMUX;
  process.env.TMUX_TMPDIR = socketDir;
  process.env.HIVE_TMUX_SOCKET = socket;
  delete process.env.TMUX;
  setTmuxSocket(socket);
  try {
    return await fn(socket);
  } finally {
    await tmux(["kill-server"], { reject: false });
    setTmuxSocket(undefined);
    if (previousTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = previousTmpdir;
    if (previousSocket === undefined) delete process.env.HIVE_TMUX_SOCKET;
    else process.env.HIVE_TMUX_SOCKET = previousSocket;
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    await rm(socketDir, { recursive: true, force: true });
  }
}

async function hive(dir: string, socket: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HIVE_STORE_ROOT: dir,
      HIVE_TMUX_SOCKET: socket,
      HIVE_NO_KEYCHAIN: "1",
      HIVE_OPENCODE_CMD: "sleep 600",
      NO_COLOR: "1",
      TERM: "dumb",
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
}

async function seedOpencodeCredential(account: AccountRecord): Promise<void> {
  const recipe = identityRecipeForAgent(account.tool);
  const rel = recipe?.credentialFiles[0];
  if (!rel) throw new Error(`no primary credential recipe for ${account.tool}`);
  const path = join(accountDir(account), rel);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ [account.provider ?? "zai-coding-plan"]: { type: "api", key: `test-${account.id}` } }));
}

async function seedOpencodeAccounts(): Promise<string[]> {
  const accounts: AccountRecord[] = [];
  for (const label of ["a", "b", "c"]) {
    const account = await addAccount("opencode", label, { provider: "zai-coding-plan" });
    await seedOpencodeCredential(account);
    accounts.push(account);
  }
  return accounts.map((account) => account.id);
}

function spawnedNames(stdout: string): string[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line && !line.startsWith("swarm\t"))
    .map((line) => line.split("\t")[0]!)
    .filter(Boolean);
}

async function recordsFor(names: string[]): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for (const name of names) {
    const record = await loadSession(name);
    assert.ok(record, `missing session record for ${name}`);
    records.push(record);
  }
  return records;
}

test("spawn <tool>-rr --count re-resolves the account for each bee", async () => {
  await withIsolatedTmux(async (socket) => {
    await withStore(async (dir) => {
      const expected = await seedOpencodeAccounts();
      const cwd = await mkdtemp(join(tmpdir(), "hive-cli-spawn-account-cwd-"));
      try {
        const { stdout } = await hive(dir, socket, [
          "spawn",
          "opencode-rr",
          "--count",
          "3",
          "--cwd",
          cwd,
          "--swarm-id",
          "rr-count",
          "--no-wait",
        ]);

        const records = await recordsFor(spawnedNames(stdout));
        assert.deepEqual(records.map((record) => record.accountId), expected);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});

test("spawn --frame re-resolves <tool>-rr for each bee in a multi-count caste", async () => {
  await withIsolatedTmux(async (socket) => {
    await withStore(async (dir) => {
      const expected = await seedOpencodeAccounts();
      await writeFrameFromObject({
        name: "rr-frame",
        castes: [{ name: "worker", bee: "opencode-rr", count: 3, brief: "wait" }],
      });
      const cwd = await mkdtemp(join(tmpdir(), "hive-cli-spawn-frame-cwd-"));
      try {
        const { stdout } = await hive(dir, socket, [
          "spawn",
          "--frame",
          "rr-frame",
          "--cwd",
          cwd,
          "--swarm-id",
          "rr-frame-swarm",
          "--no-wait",
        ]);

        const records = await recordsFor(spawnedNames(stdout));
        assert.deepEqual(records.map((record) => record.accountId), expected);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});
