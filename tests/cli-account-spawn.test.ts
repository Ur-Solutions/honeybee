import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

const ENV = (dir: string) => ({ ...process.env, HIVE_STORE_ROOT: dir, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" });

async function hive(dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), env: ENV(dir) });
}

async function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-cli-acct-spawn-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Seed an opencode account's primary credential into the vault so activation succeeds. */
async function seedOpencodeCredential(dir: string, accountId: string): Promise<void> {
  const credPath = join(dir, "vault", "opencode", accountId, "xdg-data", "opencode", "auth.json");
  await mkdir(join(credPath, ".."), { recursive: true });
  await writeFile(credPath, JSON.stringify({ "minimax-coding-plan": { type: "api", key: "test-key" } }));
}

test("account-first open embeds the opencode --model <provider>/<model> selector", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax");
    // Account-first: the bare account id resolves CLI + provider + model.
    const { stdout } = await hive(dir, "open", "opencode-minimax", "--raw", "--print");
    assert.match(stdout, /--model minimax-coding-plan\/MiniMax-M3/);
  });
});

test("a thin profile referencing an account overlays its model (flag > profile > account)", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax");
    // Profile names the account and overrides the model → PROFILE wins over the
    // account default (MiniMax-M3).
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ bees: { mm: { account: "opencode-minimax", model: "MiniMax-M3-pro" } } }),
    );
    const { stdout } = await hive(dir, "open", "mm", "--raw", "--print");
    assert.match(stdout, /--model minimax-coding-plan\/MiniMax-M3-pro/);
    assert.doesNotMatch(stdout, /MiniMax-M3\b(?!-pro)/);
  });
});

test("a thin profile with NO model override falls back to the account default model (account precedence)", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax");
    await writeFile(join(dir, "config.json"), JSON.stringify({ bees: { mm: { account: "opencode-minimax" } } }));
    const { stdout } = await hive(dir, "open", "mm", "--raw", "--print");
    assert.match(stdout, /--model minimax-coding-plan\/MiniMax-M3/);
  });
});

test("a thin profile appends its extra args", async () => {
  await withStore(async (dir) => {
    await hive(dir, "account", "add", "opencode", "minimax", "--provider", "minimax-coding-plan", "--model", "MiniMax-M3");
    await seedOpencodeCredential(dir, "opencode-minimax");
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ bees: { mm: { account: "opencode-minimax", args: ["--share"] } } }),
    );
    const { stdout } = await hive(dir, "open", "mm", "--raw", "--print");
    assert.match(stdout, /--share/);
  });
});

test("a thin profile referencing a missing account errors clearly", async () => {
  await withStore(async (dir) => {
    await writeFile(join(dir, "config.json"), JSON.stringify({ bees: { mm: { account: "opencode-nope" } } }));
    await assert.rejects(
      () => hive(dir, "open", "mm", "--raw", "--print"),
      (error: unknown) => {
        const message = error instanceof Error ? `${error.message}${(error as { stderr?: string }).stderr ?? ""}` : String(error);
        assert.match(message, /Unknown account: opencode-nope/);
        return true;
      },
    );
  });
});
