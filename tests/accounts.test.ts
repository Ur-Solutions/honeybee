import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountDir,
  accountHasCredentials,
  accountIdFor,
  activateAccountIntoHome,
  addAccount,
  captureAccountFromHome,
  findAccount,
  importCaam,
  listAccounts,
  removeAccount,
  resolveSpawnAgent,
} from "../src/accounts.js";

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const oldKeychain = process.env.HIVE_NO_KEYCHAIN;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-accounts-"));
  process.env.HIVE_STORE_ROOT = dir;
  // Activating claude accounts against temp homes must not write entries
  // into the developer's real macOS keychain.
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

test("add/list/find/remove accounts round-trip", async () => {
  await withTempStore(async () => {
    const account = await addAccount("claude", "tormod@example.com");
    assert.equal(account.id, accountIdFor("claude", "tormod@example.com"));
    assert.equal(account.tool, "claude");
    assert.equal(account.email, "tormod@example.com");

    const accounts = await listAccounts();
    assert.equal(accounts.length, 1);

    const found = await findAccount("tormod@example.com");
    assert.equal(found.id, account.id);

    // Substring match works when unique.
    const partial = await findAccount("example");
    assert.equal(partial.id, account.id);

    await removeAccount(account.id);
    assert.deepEqual(await listAccounts(), []);
  });
});

test("addAccount rejects duplicates and unknown tools", async () => {
  await withTempStore(async () => {
    await addAccount("claude", "a@b.c");
    await assert.rejects(() => addAccount("claude", "a@b.c"), /already exists/);
    await assert.rejects(() => addAccount("not-a-tool", "x"), /Unknown tool/);
  });
});

test("alias tool names canonicalize (cc2 -> claude)", async () => {
  await withTempStore(async () => {
    const account = await addAccount("cc2", "alias@a.b");
    assert.equal(account.tool, "claude");
  });
});

test("capture pulls credential files from a home into the vault", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "cap@a.b");
    const home = join(dir, "fake-home");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), `{"token":"secret"}`);
    await writeFile(join(home, ".claude.json"), `{}`);

    const captured = await captureAccountFromHome(account, home);
    assert.deepEqual(captured.sort(), [".claude.json", ".credentials.json"]);

    const vaulted = join(accountDir(account), ".credentials.json");
    assert.equal(await readFile(vaulted, "utf8"), `{"token":"secret"}`);
    assert.equal(((await stat(vaulted)).mode & 0o777), 0o600);
    assert.equal(await accountHasCredentials(account), true);
  });
});

test("capture fails when the home has no credential files", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "empty@a.b");
    const home = join(dir, "empty-home");
    await mkdir(home, { recursive: true });
    await assert.rejects(() => captureAccountFromHome(account, home), /No credential files/);
  });
});

test("activate seeds creds into a home; codex mirrors $HOME/.codex/auth.json", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "codex@a.b");
    const sourceHome = join(dir, "codex-src");
    await mkdir(sourceHome, { recursive: true });
    await writeFile(join(sourceHome, "auth.json"), `{"id":"codex-token"}`);
    await captureAccountFromHome(account, sourceHome);

    const slot = join(dir, "codex-slot");
    const written = await activateAccountIntoHome(account, slot);
    assert.deepEqual(written.sort(), [".codex/auth.json", "auth.json"]);
    assert.equal(await readFile(join(slot, "auth.json"), "utf8"), `{"id":"codex-token"}`);
    assert.equal(await readFile(join(slot, ".codex", "auth.json"), "utf8"), `{"id":"codex-token"}`);
  });
});

test("activate fails when the vault is empty for the account", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "novault@a.b");
    await assert.rejects(() => activateAccountIntoHome(account, join(dir, "slot")), /no credentials/i);
  });
});

test("findAccount resolves <tool>-<query> shorthands (codex-ur, claude-thto)", async () => {
  await withTempStore(async () => {
    await addAccount("codex", "tormod@ursolutions.no");
    await addAccount("codex", "tormod@thto.no");
    await addAccount("claude", "tormod@ursolutions.no");

    assert.equal((await findAccount("codex-ur")).id, accountIdFor("codex", "tormod@ursolutions.no"));
    assert.equal((await findAccount("codex-thto")).id, accountIdFor("codex", "tormod@thto.no"));
    assert.equal((await findAccount("claude-ur")).tool, "claude");
    // "ur" alone is ambiguous across tools; the prefix scopes it.
    await assert.rejects(() => findAccount("ur"), /Ambiguous/);
    // Verbatim ids still resolve first.
    assert.equal((await findAccount(accountIdFor("codex", "tormod@thto.no"))).label, "tormod@thto.no");
  });
});

test("resolveSpawnAgent maps bee specs to tool + account", async () => {
  await withTempStore(async () => {
    await addAccount("codex", "tormod@ursolutions.no");

    // Plain tools and home aliases pass through untouched.
    assert.deepEqual(await resolveSpawnAgent("claude"), { agent: "claude" });
    assert.deepEqual(await resolveSpawnAgent("cc1"), { agent: "cc1" });
    assert.deepEqual(await resolveSpawnAgent("codex2"), { agent: "codex2" });

    // Account shorthand binds the vault account.
    const spec = await resolveSpawnAgent("codex-ur");
    assert.equal(spec.agent, "codex");
    assert.equal(spec.account?.id, accountIdFor("codex", "tormod@ursolutions.no"));

    // The full account id is itself a valid spec (used by tab completion).
    const byId = await resolveSpawnAgent(accountIdFor("codex", "tormod@ursolutions.no"));
    assert.equal(byId.agent, "codex");
    assert.equal(byId.account?.label, "tormod@ursolutions.no");

    // Unknown tokens fall through as arbitrary executables.
    assert.deepEqual(await resolveSpawnAgent("my-agent"), { agent: "my-agent" });
    assert.deepEqual(await resolveSpawnAgent("codex-nosuch"), { agent: "codex-nosuch" });
  });
});

test("import-caam migrates known tools and skips unknown ones", async () => {
  await withTempStore(async (dir) => {
    const caam = join(dir, "caam-vault");
    await mkdir(join(caam, "claude", "tormod@a.b"), { recursive: true });
    await writeFile(join(caam, "claude", "tormod@a.b", ".credentials.json"), `{"t":1}`);
    await writeFile(join(caam, "claude", "tormod@a.b", "meta.json"), `{"profile":"tormod@a.b"}`);
    await mkdir(join(caam, "codex", "tormod@a.b"), { recursive: true });
    await writeFile(join(caam, "codex", "tormod@a.b", "auth.json"), `{"t":2}`);
    // opencode's caam layout keeps auth.json at the root; the recipe nests it.
    await mkdir(join(caam, "opencode", "oc1"), { recursive: true });
    await writeFile(join(caam, "opencode", "oc1", "auth.json"), `{"t":3}`);
    await mkdir(join(caam, "gemini", "g1"), { recursive: true });
    await writeFile(join(caam, "gemini", "g1", "oauth_creds.json"), `{"t":4}`);

    const result = await importCaam(caam);
    assert.deepEqual(result.imported.map((account) => account.tool).sort(), ["claude", "codex", "opencode"]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.tool, "gemini");

    const opencodeAccount = result.imported.find((account) => account.tool === "opencode")!;
    const nested = join(accountDir(opencodeAccount), "xdg-data", "opencode", "auth.json");
    assert.equal(await readFile(nested, "utf8"), `{"t":3}`);

    const claudeAccount = result.imported.find((account) => account.tool === "claude")!;
    assert.equal(await accountHasCredentials(claudeAccount), true);
    // meta.json must not be vaulted.
    await assert.rejects(() => readFile(join(accountDir(claudeAccount), "meta.json"), "utf8"));

    // Re-import is idempotent (updates, no duplicates).
    const again = await importCaam(caam);
    assert.equal((await listAccounts()).length, 3);
    assert.equal(again.imported.length, 3);
  });
});
