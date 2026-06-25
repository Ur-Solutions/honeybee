// Contract coverage for resolveSpawnSpec (src/spawnResolve.ts): the resolver the
// flow + loop spawn paths use to turn a bee token into {agent, account?} so
// flow/loop-spawned bees bind an account (the gap that made `hive loop launch`
// with codex-auto die on spawn). The `<tool>-auto` least-loaded branch needs
// live provider limits + vaulted credentials and is exercised end-to-end against
// the real vault elsewhere; here we lock the deterministic branches: empty,
// plain kind, exact account id, and `<tool>-<account>` shorthand.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addAccount } from "../src/accounts.js";
import { resolveSpawnSpec } from "../src/spawnResolve.js";

async function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-spawn-resolve-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("empty / whitespace token passes through with no account", async () => {
  await withStore(async () => {
    assert.deepEqual(await resolveSpawnSpec(""), { agent: "" });
    assert.deepEqual(await resolveSpawnSpec("   "), { agent: "" });
  });
});

test("a plain driver kind resolves to itself with NO account bound", async () => {
  await withStore(async () => {
    await addAccount("codex", "ursolutions", { model: "gpt-5-codex" });
    const spec = await resolveSpawnSpec("codex");
    assert.equal(spec.agent, "codex");
    assert.equal(spec.account, undefined, "a bare kind must not hijack a registered account");
  });
});

test("an exact account id binds that account (kind = the account's tool)", async () => {
  await withStore(async () => {
    await addAccount("codex", "ursolutions", { model: "gpt-5-codex" });
    const spec = await resolveSpawnSpec("codex-ursolutions");
    assert.equal(spec.agent, "codex");
    assert.equal(spec.account?.id, "codex-ursolutions");
    assert.equal(spec.account?.model, "gpt-5-codex", "the account's default model rides along for the spawn");
  });
});

test("a <tool>-<account> shorthand binds via tool-scoped fuzzy match", async () => {
  await withStore(async () => {
    await addAccount("codex", "ursolutions", {});
    const spec = await resolveSpawnSpec("codex-urs");
    assert.equal(spec.agent, "codex");
    assert.equal(spec.account?.id, "codex-ursolutions");
  });
});
