/**
 * `pickRoundRobinAccount` advances a persistent cursor through a tool's
 * credentialed accounts. Tests exercise: cycle order, wrap-around, the cursor
 * file format, error shapes (none / no-creds), and concurrency under the file
 * lock. Each test runs against an isolated HIVE_STORE_ROOT.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountDir, addAccount } from "../src/accounts.js";
import { identityRecipeForAgent } from "../src/drivers.js";
import { pickRoundRobinAccount } from "../src/roundRobin.js";
import { storeRoot } from "../src/fsx.js";

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const oldKeychain = process.env.HIVE_NO_KEYCHAIN;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-rr-"));
  process.env.HIVE_STORE_ROOT = dir;
  process.env.HIVE_NO_KEYCHAIN = "1";
  try {
    return await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    if (oldKeychain === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = oldKeychain;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Drop the primary credential file into the account's vault dir so the picker sees it as credentialed. */
async function vaultPrimaryCredential(account: { id: string; tool: string }): Promise<void> {
  const recipe = identityRecipeForAgent(account.tool);
  if (!recipe) throw new Error(`no recipe for ${account.tool}`);
  const dir = accountDir(account as Parameters<typeof accountDir>[0]);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, recipe.credentialFiles[0]!), `{"token":"stub-${account.id}"}`, { mode: 0o600 });
}

test("pickRoundRobinAccount walks credentialed accounts in addedAt order and wraps", async () => {
  await withTempStore(async () => {
    // Insert in non-alphabetical order to prove the cycle follows registration
    // time (addedAt), not id. addAccount uses Date.now() under the hood, so
    // queue them sequentially.
    const c = await addAccount("claude", "c@x.example");
    const a = await addAccount("claude", "a@x.example");
    const b = await addAccount("claude", "b@x.example");
    for (const acct of [a, b, c]) await vaultPrimaryCredential(acct);

    const seq: string[] = [];
    for (let i = 0; i < 5; i += 1) seq.push((await pickRoundRobinAccount("claude")).account.id);
    assert.deepEqual(seq, [c.id, a.id, b.id, c.id, a.id]);

    const cursorRaw = await readFile(join(storeRoot(), "round-robin.json"), "utf8");
    const cursor = JSON.parse(cursorRaw) as Record<string, { lastAccountId?: string }>;
    assert.equal(cursor.claude?.lastAccountId, a.id);
  });
});

test("pickRoundRobinAccount skips accounts that have no vaulted credentials", async () => {
  await withTempStore(async () => {
    const credentialed = await addAccount("claude", "yes@x.example");
    await addAccount("claude", "no@x.example");
    await vaultPrimaryCredential(credentialed);

    // The uncredentialed sibling must not appear, even on the wrap.
    const first = (await pickRoundRobinAccount("claude")).account.id;
    const second = (await pickRoundRobinAccount("claude")).account.id;
    assert.equal(first, credentialed.id);
    assert.equal(second, credentialed.id);
  });
});

test("pickRoundRobinAccount surfaces the same error shape as the auto picker", async () => {
  await withTempStore(async () => {
    await assert.rejects(
      () => pickRoundRobinAccount("claude"),
      /No claude accounts registered/,
    );
    await addAccount("claude", "creds@x.example"); // registered but vault is empty
    await assert.rejects(
      () => pickRoundRobinAccount("claude"),
      /No claude account has vaulted credentials/,
    );
  });
});

test("two concurrent round-robin picks pick distinct accounts via the file lock", async () => {
  await withTempStore(async () => {
    const a = await addAccount("claude", "p1@x.example");
    const b = await addAccount("claude", "p2@x.example");
    for (const acct of [a, b]) await vaultPrimaryCredential(acct);

    const [first, second] = await Promise.all([pickRoundRobinAccount("claude"), pickRoundRobinAccount("claude")]);
    // Order between the two parallel picks is non-deterministic, but they
    // must serialize through the lock so the cursor never doubles up: with
    // two candidates that's exactly {a, b}.
    assert.notEqual(first.account.id, second.account.id);
    assert.deepEqual([first.account.id, second.account.id].sort(), [a.id, b.id].sort());
  });
});
