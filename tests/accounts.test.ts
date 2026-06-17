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
  listAccounts,
  mergeCredentialsJson,
  removeAccount,
  resolveSpawnAgent,
  syncClaudeChainToVault,
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

test("activate seeds creds into a home; codex keeps a legacy .codex auth mirror", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "codex@a.b");
    const sourceHome = join(dir, "codex-src");
    await mkdir(sourceHome, { recursive: true });
    await writeFile(join(sourceHome, "auth.json"), `{"id":"codex-token"}`);
    await captureAccountFromHome(account, sourceHome);

    const slot = join(dir, "codex-slot");
    const written = await activateAccountIntoHome(account, slot);
    assert.deepEqual(written.sort(), [".codex/auth.json", "auth.json", "config.toml"]);
    assert.equal(await readFile(join(slot, "auth.json"), "utf8"), `{"id":"codex-token"}`);
    assert.equal(await readFile(join(slot, ".codex", "auth.json"), "utf8"), `{"id":"codex-token"}`);
    const config = await readFile(join(slot, "config.toml"), "utf8");
    assert.match(config, /model = "gpt-5\.5"/);
    assert.match(config, /model_reasoning_effort = "xhigh"/);
    assert.match(config, /service_tier = "fast"/);
    assert.match(config, /\[notice\]\nhide_full_access_warning = true/);
  });
});

test("codex activation preserves vaulted config and fills missing standard defaults", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "codex-config@a.b");
    const sourceHome = join(dir, "codex-src");
    await mkdir(sourceHome, { recursive: true });
    await writeFile(join(sourceHome, "auth.json"), `{"id":"codex-token"}`);
    await writeFile(
      join(sourceHome, "config.toml"),
      `model = "custom-codex"\n\n[projects."/repo"]\ntrust_level = "trusted"\n`,
    );
    assert.deepEqual((await captureAccountFromHome(account, sourceHome)).sort(), ["auth.json", "config.toml"]);

    const slot = join(dir, "codex-slot");
    await activateAccountIntoHome(account, slot);

    const config = await readFile(join(slot, "config.toml"), "utf8");
    assert.match(config, /model = "custom-codex"/);
    assert.match(config, /model_reasoning_effort = "xhigh"/);
    assert.match(config, /service_tier = "fast"/);
    assert.match(config, /\[projects\."\/repo"\]\ntrust_level = "trusted"/);
  });
});

test("activate fails when the vault is empty for the account", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "novault@a.b");
    await assert.rejects(() => activateAccountIntoHome(account, join(dir, "slot")), /no credentials/i);
  });
});

function chainJson(accessToken: string, expiresAt: number, refreshToken?: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, ...(refreshToken ? { refreshToken } : {}) } });
}

test("activation pulls a fresher home chain into the vault instead of stamping a stale one", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "rot@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-old", now + 3_600_000, "r-old"));
    // The account's dedicated home holds the rotated, fresher link (a past
    // session refreshed there; refresh tokens rotate, so r-old is dead).
    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), chainJson("tok-live", now + 8 * 3_600_000, "r-live"));

    await activateAccountIntoHome(account, home);

    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-live");
    assert.equal(vault.claudeAiOauth.refreshToken, "r-live");
    // The home keeps the live link — the stale vault snapshot never lands.
    const homeCreds = JSON.parse(await readFile(join(home, ".credentials.json"), "utf8"));
    assert.equal(homeCreds.claudeAiOauth.accessToken, "tok-live");
  });
});

test("activation refreshes an expired chain and persists the rotation before stamping", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "stale@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-dead", now - 1_000, "r1"));
    const home = join(dir, "homes", account.id);

    const refreshedWith: string[] = [];
    await activateAccountIntoHome(account, home, {
      refreshClaudeToken: async (refreshToken) => {
        refreshedWith.push(refreshToken);
        return { accessToken: "tok-new", refreshToken: "r2", expiresAt: now + 8 * 3_600_000 };
      },
    });

    assert.deepEqual(refreshedWith, ["r1"]);
    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-new");
    // The rotated refresh token MUST be persisted or the chain is orphaned.
    assert.equal(vault.claudeAiOauth.refreshToken, "r2");
    const homeCreds = JSON.parse(await readFile(join(home, ".credentials.json"), "utf8"));
    assert.equal(homeCreds.claudeAiOauth.accessToken, "tok-new");
  });
});

test("activation warns but proceeds when the expired chain cannot be refreshed", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "dead@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-dead", now - 1_000, "r1"));
    const home = join(dir, "homes", account.id);

    const warnings: string[] = [];
    await activateAccountIntoHome(account, home, {
      refreshClaudeToken: async () => null,
      onWarn: (message) => warnings.push(message),
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not be refreshed/);
    // Still stamped: claude may yet recover (e.g. the refresh failed offline).
    const homeCreds = JSON.parse(await readFile(join(home, ".credentials.json"), "utf8"));
    assert.equal(homeCreds.claudeAiOauth.accessToken, "tok-dead");
  });
});

test("activation rescues a foreign occupant's fresher chain into its own vault", async () => {
  await withTempStore(async (dir) => {
    const tenant = await addAccount("claude", "tenant@b.c");
    const incoming = await addAccount("claude", "incoming@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(tenant), ".credentials.json"), chainJson("tok-tenant-old", now - 1_000));
    await writeFile(join(accountDir(incoming), ".credentials.json"), chainJson("tok-incoming", now + 3_600_000));
    // A shared home currently logged in as the tenant, holding the live link
    // of the tenant's chain (which exists nowhere else).
    const home = join(dir, "shared-home");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), chainJson("tok-tenant-live", now + 8 * 3_600_000));
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "tenant@b.c" } }));

    await activateAccountIntoHome(incoming, home);

    // The tenant's live link was evacuated before the stamp destroyed it.
    const tenantVault = JSON.parse(await readFile(join(accountDir(tenant), ".credentials.json"), "utf8"));
    assert.equal(tenantVault.claudeAiOauth.accessToken, "tok-tenant-live");
    // And the home now belongs to the incoming account.
    const homeCreds = JSON.parse(await readFile(join(home, ".credentials.json"), "utf8"));
    assert.equal(homeCreds.claudeAiOauth.accessToken, "tok-incoming");
  });
});

test("syncClaudeChainToVault pulls the freshest link from the account's homes", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "sync@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-old", now + 1_000));
    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), chainJson("tok-live", now + 8 * 3_600_000));

    const first = await syncClaudeChainToVault(account);
    assert.equal(first.vaultUpdated, true);
    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-live");

    const second = await syncClaudeChainToVault(account);
    assert.equal(second.vaultUpdated, false);
  });
});

test("mergeCredentialsJson overlays the new chain and preserves sibling keys", () => {
  const merged = JSON.parse(mergeCredentialsJson(
    JSON.stringify({ mcpOAuth: { server: "kept" }, claudeAiOauth: { accessToken: "old" } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "new" } }),
  ));
  assert.deepEqual(merged.mcpOAuth, { server: "kept" });
  assert.equal(merged.claudeAiOauth.accessToken, "new");
  // Unparseable or missing targets fall back to the source verbatim.
  assert.equal(mergeCredentialsJson("not-json", `{"a":1}`), `{"a":1}`);
  assert.equal(JSON.parse(mergeCredentialsJson(null, `{"a":1}`)).a, 1);
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
