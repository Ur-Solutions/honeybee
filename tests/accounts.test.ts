import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountCli,
  accountDir,
  accountHasCredentials,
  accountIdFor,
  accountsRegistryPath,
  activateAccountIntoHome,
  addAccount,
  assertGrokHomeAuthFresh,
  autoAccountTool,
  captureAccountFromHome,
  findAccount,
  listAccounts,
  mergeCredentialsJson,
  normalizeAccountRecord,
  parseClaudeChain,
  PROVIDER_BY_CLI,
  removeAccount,
  resolveSpawnAgent,
  roundRobinAccountTool,
  syncAccountCredentialsToVault,
  syncClaudeChainToVault,
  syncCodexAuthToVault,
  type AccountRecord,
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

function hexPayload(raw: string): string {
  return Buffer.from(raw, "utf8").toString("hex");
}

test("parseClaudeChain decodes hex-encoded keychain payloads", () => {
  const raw = chainJson("tok-hex", 1_797_782_400_000, "refresh-hex");
  const chain = parseClaudeChain(hexPayload(raw), "keychain");
  assert.equal(chain?.oauth.accessToken, "tok-hex");
  assert.equal(chain?.refreshToken, "refresh-hex");
  assert.equal(chain?.expiresAt, 1_797_782_400_000);
  assert.equal(chain?.raw, raw);
});

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${body}.sig`;
}

function codexAuthJson(email: string, accountId: string, lastRefresh: string, token: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ email }),
      access_token: `access-${token}`,
      refresh_token: `refresh-${token}`,
      account_id: accountId,
    },
    last_refresh: lastRefresh,
  });
}

function opencodeAuthJson(provider: string, token: string): string {
  return JSON.stringify({ [provider]: { type: "api", key: token } });
}

function grokAuthJson(email: string, createTime: string, token: string): string {
  const created = new Date(createTime);
  const expiresAt = new Date(created.getTime() + 6 * 60 * 60 * 1000).toISOString();
  return JSON.stringify({
    "https://auth.x.ai::test-client": {
      auth_mode: "oidc",
      email,
      key: `key-${token}`,
      refresh_token: `refresh-${token}`,
      create_time: createTime,
      expires_at: expiresAt,
      principal_type: "User",
    },
  });
}

async function writeDatedFile(path: string, data: string, iso: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, data);
  const date = new Date(iso);
  await utimes(path, date, date);
}

test("claude activation seeds skipDangerousModePermissionPrompt without clobbering other settings", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "bypass@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok", now + 3_600_000, "r"));
    // The vault's settings.json carries model/theme but NOT the bypass flag —
    // exactly the shape that re-stamps over (and wipes) a home's acceptance.
    await writeFile(join(accountDir(account), "settings.json"), `{\n  "model": "claude-fable-5",\n  "theme": "dark"\n}\n`);

    const home = join(dir, "homes", account.id);
    const written = await activateAccountIntoHome(account, home);

    assert.ok(written.includes("settings.json"), "settings.json should be reported as written");
    const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    // The flag is asserted so claude's bypass-permissions dialog never appears.
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    // ...and the vault's own keys are preserved (merged, not replaced).
    assert.equal(settings.model, "claude-fable-5");
    assert.equal(settings.theme, "dark");
  });
});

test("claude activation re-asserts the bypass flag every time, surviving a vault copy that lacks it", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "reassert@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok", now + 3_600_000, "r"));
    await writeFile(join(accountDir(account), "settings.json"), `{"theme":"dark"}`);
    const home = join(dir, "homes", account.id);

    // First activation seeds the flag; simulate claude later persisting more
    // state, then a second activation re-stamping the flagless vault copy.
    await activateAccountIntoHome(account, home);
    await activateAccountIntoHome(account, home);

    const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.equal(settings.theme, "dark");
  });
});

test("generic file-backed activation pulls newer dedicated-home credentials into the vault", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("opencode", "minimax", { provider: "minimax-coding-plan" });
    const rel = join("xdg-data", "opencode", "auth.json");
    await writeDatedFile(
      join(accountDir(account), rel),
      opencodeAuthJson("minimax-coding-plan", "old-key"),
      "2026-06-01T00:00:00.000Z",
    );
    const home = join(dir, "homes", account.id);
    await writeDatedFile(
      join(home, rel),
      opencodeAuthJson("minimax-coding-plan", "fresh-key"),
      "2026-06-02T00:00:00.000Z",
    );

    await activateAccountIntoHome(account, home);

    const vault = JSON.parse(await readFile(join(accountDir(account), rel), "utf8"));
    assert.equal(vault["minimax-coding-plan"].key, "fresh-key");
    const activated = JSON.parse(await readFile(join(home, rel), "utf8"));
    assert.equal(activated["minimax-coding-plan"].key, "fresh-key");
  });
});

test("generic file-backed sync covers every non-special identity harness", async () => {
  await withTempStore(async (dir) => {
    const cases = [
      {
        tool: "opencode",
        label: "zai-table",
        provider: "zai-coding-plan",
        rel: join("xdg-data", "opencode", "auth.json"),
        old: opencodeAuthJson("zai-coding-plan", "old-opencode"),
        fresh: opencodeAuthJson("zai-coding-plan", "fresh-opencode"),
        readToken: (value: Record<string, unknown>) => (value["zai-coding-plan"] as { key: string }).key,
      },
      {
        tool: "grok",
        label: "grok-table",
        rel: "auth.json",
        old: grokAuthJson("grok-table", "2026-06-01T00:00:00.000Z", "old-grok"),
        fresh: grokAuthJson("grok-table", "2026-06-02T00:00:00.000Z", "fresh-grok"),
        readToken: (value: Record<string, unknown>) => (value["https://auth.x.ai::test-client"] as { key: string }).key,
      },
      {
        tool: "kimi",
        label: "kimi-table",
        rel: join("credentials", "kimi-code.json"),
        old: JSON.stringify({ accessToken: "old-kimi" }),
        fresh: JSON.stringify({ accessToken: "fresh-kimi" }),
        readToken: (value: Record<string, unknown>) => value.accessToken,
      },
      {
        tool: "cursor",
        label: "cursor-table",
        provider: "cursor",
        rel: "cli-config.json",
        old: JSON.stringify({ token: "old-cursor" }),
        fresh: JSON.stringify({ token: "fresh-cursor" }),
        readToken: (value: Record<string, unknown>) => value.token,
      },
    ];

    for (const item of cases) {
      const account = await addAccount(item.tool, item.label, item.provider ? { provider: item.provider } : {});
      await writeDatedFile(join(accountDir(account), item.rel), item.old, "2026-06-01T00:00:00.000Z");
      const home = join(dir, "homes", account.id);
      await writeDatedFile(join(home, item.rel), item.fresh, "2026-06-02T00:00:00.000Z");

      const result = await syncAccountCredentialsToVault(account);

      assert.equal(result.vaultUpdated, true, item.tool);
      const vault = JSON.parse(await readFile(join(accountDir(account), item.rel), "utf8"));
      assert.equal(item.readToken(vault), item.readToken(JSON.parse(item.fresh)), item.tool);
    }
  });
});

test("generic credential sync ignores arbitrary homes unless a session binding trusts them", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("opencode", "zai", { provider: "zai-coding-plan" });
    const rel = join("xdg-data", "opencode", "auth.json");
    await writeDatedFile(
      join(accountDir(account), rel),
      opencodeAuthJson("zai-coding-plan", "vault-key"),
      "2026-06-01T00:00:00.000Z",
    );
    const arbitraryHome = join(dir, "some-shared-home");
    await writeDatedFile(
      join(arbitraryHome, rel),
      opencodeAuthJson("zai-coding-plan", "session-key"),
      "2026-06-03T00:00:00.000Z",
    );

    const ignored = await syncAccountCredentialsToVault(account, arbitraryHome);
    assert.equal(ignored.vaultUpdated, false);
    let vault = JSON.parse(await readFile(join(accountDir(account), rel), "utf8"));
    assert.equal(vault["zai-coding-plan"].key, "vault-key");

    const trusted = await syncAccountCredentialsToVault(account, arbitraryHome, { trustExtraHome: true });
    assert.equal(trusted.vaultUpdated, true);
    vault = JSON.parse(await readFile(join(accountDir(account), rel), "utf8"));
    assert.equal(vault["zai-coding-plan"].key, "session-key");
  });
});

test("grok sync pulls newer shared-home auth when the email matches the account", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("grok", "sync@a.b");
    await writeDatedFile(
      join(accountDir(account), "auth.json"),
      grokAuthJson("sync@a.b", "2026-06-01T00:00:00.000Z", "old"),
      "2026-06-01T00:00:00.000Z",
    );
    const sharedHome = join(dir, "shared-grok");
    await writeDatedFile(
      join(sharedHome, "auth.json"),
      grokAuthJson("sync@a.b", "2026-06-02T00:00:00.000Z", "fresh"),
      "2026-06-02T00:00:00.000Z",
    );

    const result = await syncAccountCredentialsToVault(account, sharedHome);

    assert.equal(result.vaultUpdated, true);
    const vault = JSON.parse(await readFile(join(accountDir(account), "auth.json"), "utf8"));
    assert.equal(vault["https://auth.x.ai::test-client"].key, "key-fresh");
  });
});

test("grok sync refuses a newer shared-home auth that belongs to another email", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("grok", "mine@a.b");
    await writeDatedFile(
      join(accountDir(account), "auth.json"),
      grokAuthJson("mine@a.b", "2026-06-01T00:00:00.000Z", "mine-old"),
      "2026-06-01T00:00:00.000Z",
    );
    const foreignHome = join(dir, "foreign-grok");
    await writeDatedFile(
      join(foreignHome, "auth.json"),
      grokAuthJson("other@a.b", "2026-06-03T00:00:00.000Z", "other-fresh"),
      "2026-06-03T00:00:00.000Z",
    );

    const result = await syncAccountCredentialsToVault(account, foreignHome);

    assert.equal(result.vaultUpdated, false);
    const vault = JSON.parse(await readFile(join(accountDir(account), "auth.json"), "utf8"));
    assert.equal(vault["https://auth.x.ai::test-client"].key, "key-mine-old");
  });
});

test("grok auth freshness check rejects expired or nearly expired OAuth", async () => {
  await withTempStore(async (dir) => {
    const home = join(dir, "homes", "grok");
    await writeDatedFile(
      join(home, "auth.json"),
      grokAuthJson("stale@a.b", "2026-06-01T00:00:00.000Z", "stale"),
      "2026-06-01T00:00:00.000Z",
    );

    await assert.rejects(
      () => assertGrokHomeAuthFresh(home, { accountId: "grok-stale", now: () => Date.parse("2026-06-01T06:01:00.000Z") }),
      /Cannot start Grok .* OAuth token expired .* hive login grok-stale/,
    );

    await assert.rejects(
      () => assertGrokHomeAuthFresh(home, { accountId: "grok-stale", now: () => Date.parse("2026-06-01T05:58:00.000Z") }),
      /Cannot start Grok .* OAuth token expires soon .* hive login grok-stale/,
    );
  });
});

test("grok activation refuses to stamp expired auth into a home", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("grok", "expired@a.b");
    await writeFile(join(accountDir(account), "auth.json"), grokAuthJson("expired@a.b", "2026-06-01T00:00:00.000Z", "expired"));
    const home = join(dir, "homes", account.id);

    await assert.rejects(
      () => activateAccountIntoHome(account, home, { now: () => Date.parse("2026-06-01T06:01:00.000Z") }),
      /Cannot activate .* Grok OAuth token expired .* hive login grok-expired-a.b/,
    );
    await assert.rejects(() => readFile(join(home, "auth.json"), "utf8"), /ENOENT/);
  });
});

test("codex activation pulls newer home auth into the vault before stamping", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "sync@a.b");
    const oldAuth = codexAuthJson("sync@a.b", "acct-sync", "2026-06-01T00:00:00.000Z", "old");
    const freshAuth = codexAuthJson("sync@a.b", "acct-sync", "2026-06-02T00:00:00.000Z", "fresh");
    await writeFile(join(accountDir(account), "auth.json"), oldAuth);

    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "auth.json"), freshAuth);

    await activateAccountIntoHome(account, home);

    const vault = JSON.parse(await readFile(join(accountDir(account), "auth.json"), "utf8"));
    assert.equal(vault.tokens.access_token, "access-fresh");
    const activated = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    assert.equal(activated.tokens.access_token, "access-fresh");
    const mirror = JSON.parse(await readFile(join(home, ".codex", "auth.json"), "utf8"));
    assert.equal(mirror.tokens.access_token, "access-fresh");
  });
});

test("syncCodexAuthToVault pulls a newer login-home auth by last_refresh", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "login@a.b");
    await writeFile(
      join(accountDir(account), "auth.json"),
      codexAuthJson("login@a.b", "acct-login", "2026-06-01T00:00:00.000Z", "old"),
    );
    const loginHome = join(dir, "login-homes", account.id);
    await mkdir(loginHome, { recursive: true });
    await writeFile(
      join(loginHome, "auth.json"),
      codexAuthJson("login@a.b", "acct-login", "2026-06-03T00:00:00.000Z", "fresh"),
    );

    const result = await syncCodexAuthToVault(account);

    assert.equal(result.vaultUpdated, true);
    const vault = JSON.parse(await readFile(join(accountDir(account), "auth.json"), "utf8"));
    assert.equal(vault.tokens.refresh_token, "refresh-fresh");
  });
});

test("codex sync refuses a newer home auth that belongs to another account", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("codex", "mine@a.b");
    await writeFile(
      join(accountDir(account), "auth.json"),
      codexAuthJson("mine@a.b", "acct-mine", "2026-06-01T00:00:00.000Z", "mine-old"),
    );
    const foreignHome = join(dir, "foreign");
    await mkdir(foreignHome, { recursive: true });
    await writeFile(
      join(foreignHome, "auth.json"),
      codexAuthJson("other@a.b", "acct-other", "2026-06-04T00:00:00.000Z", "other-fresh"),
    );

    const result = await syncCodexAuthToVault(account, foreignHome);

    assert.equal(result.vaultUpdated, false);
    const vault = JSON.parse(await readFile(join(accountDir(account), "auth.json"), "utf8"));
    assert.equal(vault.tokens.access_token, "access-mine-old");
  });
});

test("codex activation rescues a foreign occupant auth before stamping", async () => {
  await withTempStore(async (dir) => {
    const tenant = await addAccount("codex", "tenant@a.b");
    const incoming = await addAccount("codex", "incoming@a.b");
    await writeFile(
      join(accountDir(tenant), "auth.json"),
      codexAuthJson("tenant@a.b", "acct-tenant", "2026-06-01T00:00:00.000Z", "tenant-old"),
    );
    await writeFile(
      join(accountDir(incoming), "auth.json"),
      codexAuthJson("incoming@a.b", "acct-incoming", "2026-06-01T00:00:00.000Z", "incoming"),
    );
    const home = join(dir, "shared-home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "auth.json"),
      codexAuthJson("tenant@a.b", "acct-tenant", "2026-06-05T00:00:00.000Z", "tenant-live"),
    );

    await activateAccountIntoHome(incoming, home);

    const tenantVault = JSON.parse(await readFile(join(accountDir(tenant), "auth.json"), "utf8"));
    assert.equal(tenantVault.tokens.refresh_token, "refresh-tenant-live");
    const homeAuth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    assert.equal(homeAuth.tokens.access_token, "access-incoming");
  });
});

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

test("activation refuses to stamp an expired chain when refresh fails", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "dead@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-dead", now - 1_000, "r1"));
    const home = join(dir, "homes", account.id);

    const warnings: string[] = [];
    await assert.rejects(
      () => activateAccountIntoHome(account, home, {
        refreshClaudeToken: async () => null,
        onWarn: (message) => warnings.push(message),
      }),
      /Cannot activate .* expired .* could not be refreshed/,
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /provider rejected the refresh token/);
    await assert.rejects(() => readFile(join(home, ".credentials.json"), "utf8"), /ENOENT/);
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

    const deps = { fetchProfileEmail: async () => "sync@a.b" };
    const first = await syncClaudeChainToVault(account, undefined, deps);
    assert.equal(first.vaultUpdated, true);
    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-live");

    const second = await syncClaudeChainToVault(account, undefined, deps);
    assert.equal(second.vaultUpdated, false);
  });
});

test("syncClaudeChainToVault prefers an equal-expiry link with a refresh token", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "same-expiry@a.b");
    const expiresAt = Date.now() + 3_600_000;
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-vault", expiresAt));
    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), chainJson("tok-home", expiresAt, "refresh-home"));

    const result = await syncClaudeChainToVault(account, undefined, { fetchProfileEmail: async () => "same-expiry@a.b" });

    assert.equal(result.vaultUpdated, true);
    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-home");
    assert.equal(vault.claudeAiOauth.refreshToken, "refresh-home");
  });
});

test("syncClaudeChainToVault never drops a refreshable vault link for a later-expiry link without one", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "keep-refresh@a.b");
    const now = Date.now();
    // Vault link is expired but refreshable — activation can still recover it.
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-vault", now - 3_600_000, "refresh-vault"));
    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    // Home link expires later but has no refresh token — once it expires the
    // chain would be unrecoverable ("expired token has no refresh token").
    await writeFile(join(home, ".credentials.json"), chainJson("tok-home", now - 1_000));

    const result = await syncClaudeChainToVault(account);

    assert.equal(result.vaultUpdated, false);
    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-vault");
    assert.equal(vault.claudeAiOauth.refreshToken, "refresh-vault");
  });
});

test("syncClaudeChainToVault prefers an earlier-expiry refreshable home link over a non-refreshable vault link", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "gain-refresh@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-vault", now + 8 * 3_600_000));
    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), chainJson("tok-home", now + 3_600_000, "refresh-home"));

    const result = await syncClaudeChainToVault(account, undefined, { fetchProfileEmail: async () => "gain-refresh@a.b" });

    assert.equal(result.vaultUpdated, true);
    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-home");
    assert.equal(vault.claudeAiOauth.refreshToken, "refresh-home");
  });
});

test("syncClaudeChainToVault parks a verified foreign chain with its owner instead of adopting it", async () => {
  await withTempStore(async (dir) => {
    const victim = await addAccount("claude", "victim@a.b");
    const owner = await addAccount("claude", "owner@c.d");
    const now = Date.now();
    await writeFile(join(accountDir(victim), ".credentials.json"), chainJson("tok-victim", now + 3_600_000));
    await writeFile(join(accountDir(owner), ".credentials.json"), chainJson("tok-owner-old", now - 1_000));
    // A racing swap stamped the OWNER's live chain into the victim's
    // dedicated home; adopting it would hijack the victim's vault.
    const home = join(dir, "homes", victim.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), chainJson("tok-owner-live", now + 8 * 3_600_000));

    const result = await syncClaudeChainToVault(victim, undefined, {
      fetchProfileEmail: async (token) => (token === "tok-owner-live" ? "owner@c.d" : "victim@a.b"),
    });

    // The victim's vault is untouched...
    assert.equal(result.vaultUpdated, false);
    const victimVault = JSON.parse(await readFile(join(accountDir(victim), ".credentials.json"), "utf8"));
    assert.equal(victimVault.claudeAiOauth.accessToken, "tok-victim");
    // ...and the stranded chain was rescued into its real owner's vault.
    const ownerVault = JSON.parse(await readFile(join(accountDir(owner), ".credentials.json"), "utf8"));
    assert.equal(ownerVault.claudeAiOauth.accessToken, "tok-owner-live");
  });
});

test("syncClaudeChainToVault adopts an unverifiable fresh chain (endpoint unreachable keeps rescue semantics)", async () => {
  await withTempStore(async (dir) => {
    const account = await addAccount("claude", "offline@a.b");
    const now = Date.now();
    await writeFile(join(accountDir(account), ".credentials.json"), chainJson("tok-old", now + 1_000));
    const home = join(dir, "homes", account.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".credentials.json"), chainJson("tok-rotated", now + 8 * 3_600_000));

    const result = await syncClaudeChainToVault(account, undefined, {
      fetchProfileEmail: async () => {
        throw new Error("offline");
      },
    });

    assert.equal(result.vaultUpdated, true);
    const vault = JSON.parse(await readFile(join(accountDir(account), ".credentials.json"), "utf8"));
    assert.equal(vault.claudeAiOauth.accessToken, "tok-rotated");
  });
});

test("mergeCredentialsJson overlays the new chain and preserves sibling keys", () => {
  const merged = JSON.parse(mergeCredentialsJson(
    JSON.stringify({ mcpOAuth: { server: "kept" }, claudeAiOauth: { accessToken: "old" } }),
    JSON.stringify({ claudeAiOauth: { accessToken: "new" } }),
  ));
  assert.deepEqual(merged.mcpOAuth, { server: "kept" });
  assert.equal(merged.claudeAiOauth.accessToken, "new");

  const mergedFromHexTarget = JSON.parse(mergeCredentialsJson(
    hexPayload(JSON.stringify({ mcpOAuth: { server: "kept-from-hex" }, claudeAiOauth: { accessToken: "old" } })),
    JSON.stringify({ claudeAiOauth: { accessToken: "new-from-hex" } }),
  ));
  assert.deepEqual(mergedFromHexTarget.mcpOAuth, { server: "kept-from-hex" });
  assert.equal(mergedFromHexTarget.claudeAiOauth.accessToken, "new-from-hex");

  const mergedFromHexSource = JSON.parse(mergeCredentialsJson(
    JSON.stringify({ mcpOAuth: { server: "kept-source" }, claudeAiOauth: { accessToken: "old" } }),
    hexPayload(JSON.stringify({ claudeAiOauth: { accessToken: "new-source" } })),
  ));
  assert.deepEqual(mergedFromHexSource.mcpOAuth, { server: "kept-source" });
  assert.equal(mergedFromHexSource.claudeAiOauth.accessToken, "new-source");

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

// ──────────────────────────────────────────────────────────────────────────
// S2 — account-first spawn resolution
// ──────────────────────────────────────────────────────────────────────────

test("resolveSpawnAgent: an exact account id binds the account (account-first keystone)", async () => {
  await withTempStore(async () => {
    const created = await addAccount("codex", "tormod@ursolutions.no");
    const spec = await resolveSpawnAgent(created.id);
    assert.equal(spec.agent, "codex");
    assert.equal(spec.account?.id, created.id);
    assert.equal(spec.account?.label, "tormod@ursolutions.no");
  });
});

test("resolveSpawnAgent: a bare driver kind never binds an account", async () => {
  await withTempStore(async () => {
    await addAccount("codex", "tormod@ursolutions.no");
    // `claude` is a driver kind, not an account id — it must pass through with
    // NO account even though accounts exist.
    assert.deepEqual(await resolveSpawnAgent("claude"), { agent: "claude" });
  });
});

test("resolveSpawnAgent: an account LABELED 'claude' does NOT hijack the bare 'claude' token (fix #2)", async () => {
  await withTempStore(async () => {
    // Free-form label collides with a driver kind. Its id is `claude-claude`,
    // so the bare token `claude` must still resolve as the driver kind with no
    // account — matching is id-only, never label.
    const labeled = await addAccount("claude", "claude");
    assert.equal(labeled.label, "claude");
    assert.notEqual(labeled.id, "claude");
    assert.deepEqual(await resolveSpawnAgent("claude"), { agent: "claude" });
    // The account is still reachable by its exact id.
    const byId = await resolveSpawnAgent(labeled.id);
    assert.equal(byId.account?.id, labeled.id);
  });
});

test("resolveSpawnAgent: driver-kind aliases (cc1/codex2) pass through with no account", async () => {
  await withTempStore(async () => {
    await addAccount("codex", "tormod@ursolutions.no");
    assert.deepEqual(await resolveSpawnAgent("cc1"), { agent: "cc1" });
    assert.deepEqual(await resolveSpawnAgent("codex2"), { agent: "codex2" });
  });
});

test("resolveSpawnAgent: <tool>-<query> shorthand still binds an account", async () => {
  await withTempStore(async () => {
    const created = await addAccount("codex", "tormod@ursolutions.no");
    const spec = await resolveSpawnAgent("codex-ur");
    assert.equal(spec.agent, "codex");
    assert.equal(spec.account?.id, created.id);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S1 — accounts data model (provider + model)
// ──────────────────────────────────────────────────────────────────────────

function legacyRecord(over: Partial<AccountRecord> & { id: string; tool: string }): AccountRecord {
  return { label: over.id, addedAt: "2026-01-01T00:00:00.000Z", ...over };
}

test("normalizeAccountRecord infers a provider from the CLI for single-provider tools", () => {
  assert.equal(normalizeAccountRecord(legacyRecord({ id: "claude-a", tool: "claude" })).provider, "anthropic");
  assert.equal(normalizeAccountRecord(legacyRecord({ id: "codex-a", tool: "codex" })).provider, "openai");
  assert.equal(normalizeAccountRecord(legacyRecord({ id: "grok-a", tool: "grok" })).provider, "xai");
  assert.equal(normalizeAccountRecord(legacyRecord({ id: "kimi-a", tool: "kimi" })).provider, "moonshot");
});

test("normalizeAccountRecord leaves opencode provider-less (ambiguous) and preserves an explicit provider", () => {
  // opencode multiplexes providers — nothing to infer.
  const oc = normalizeAccountRecord(legacyRecord({ id: "opencode-x", tool: "opencode" }));
  assert.equal(oc.provider, undefined);

  // An explicit provider is never overwritten, even where one could be inferred.
  const explicit = normalizeAccountRecord(legacyRecord({ id: "opencode-glm", tool: "opencode", provider: "zai-coding-plan" }));
  assert.equal(explicit.provider, "zai-coding-plan");
  const explicitClaude = normalizeAccountRecord(legacyRecord({ id: "claude-b", tool: "claude", provider: "custom" }));
  assert.equal(explicitClaude.provider, "custom");

  // PROVIDER_BY_CLI is the source of truth and excludes opencode.
  assert.equal(PROVIDER_BY_CLI.opencode, undefined);
  assert.deepEqual(Object.keys(PROVIDER_BY_CLI).sort(), ["claude", "codex", "grok", "kimi"]);
});

test("normalizeAccountRecord leaves an unknown/future CLI provider-less and untouched", () => {
  // Any CLI without a PROVIDER_BY_CLI entry (a typo, or a not-yet-mapped tool)
  // is treated like opencode: no inference, returned unchanged, excluded from
  // provider-keyed features rather than mis-tagged.
  const rec = legacyRecord({ id: "weird-x", tool: "some-future-cli" });
  const out = normalizeAccountRecord(rec);
  assert.equal(out.provider, undefined);
  assert.equal(out, rec); // returned by reference (no copy) when there is nothing to backfill
});

test("accountCli reads the on-disk tool field", () => {
  assert.equal(accountCli({ tool: "opencode" }), "opencode");
});

test("listAccounts backfills providers for a legacy fixture WITHOUT mutating the file on disk", async () => {
  await withTempStore(async () => {
    // A legacy registry: no `provider` field anywhere on disk.
    const legacy = [
      { id: "claude-old", tool: "claude", label: "old@a.b", addedAt: "2025-01-01T00:00:00.000Z" },
      { id: "codex-old", tool: "codex", label: "old@c.d", addedAt: "2025-01-02T00:00:00.000Z" },
      { id: "opencode-opencode1", tool: "opencode", label: "opencode1", addedAt: "2025-01-03T00:00:00.000Z" },
    ];
    await mkdir(join(accountsRegistryPath(), ".."), { recursive: true });
    const onDiskBefore = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(accountsRegistryPath(), onDiskBefore);

    const accounts = await listAccounts();
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
    assert.equal(byId["claude-old"]!.provider, "anthropic");
    assert.equal(byId["codex-old"]!.provider, "openai");
    // opencode stays provider-less — surfaced/excluded by provider-keyed features.
    assert.equal(byId["opencode-opencode1"]!.provider, undefined);

    // The backfill is read-only: disk is untouched (still has no provider).
    const onDiskAfter = await readFile(accountsRegistryPath(), "utf8");
    assert.equal(onDiskAfter, onDiskBefore);
    assert.equal(onDiskAfter.includes("provider"), false);
  });
});

test("addAccount writes provider+model, defaults provider from cli, and throws for opencode without --provider", async () => {
  await withTempStore(async () => {
    // Default provider inferred from the CLI.
    const claude = await addAccount("claude", "p@a.b");
    assert.equal(claude.provider, "anthropic");
    assert.equal(claude.model, undefined);

    // Explicit provider + model are written.
    const oc = await addAccount("opencode", "minimax", { provider: "minimax-coding-plan", model: "MiniMax-M3" });
    assert.equal(oc.provider, "minimax-coding-plan");
    assert.equal(oc.model, "MiniMax-M3");

    // The written record round-trips through listAccounts with provider+model.
    const reloaded = (await listAccounts()).find((a) => a.id === oc.id)!;
    assert.equal(reloaded.provider, "minimax-coding-plan");
    assert.equal(reloaded.model, "MiniMax-M3");

    // opencode with no provider is refused — never writes a provider-less record.
    await assert.rejects(() => addAccount("opencode", "glm"), /Cannot infer a provider for CLI opencode/);

    // Duplicate ids still rejected (unchanged behavior).
    await assert.rejects(() => addAccount("opencode", "minimax", { provider: "minimax-coding-plan" }), /already exists/);
  });
});

test("the registry validator stays permissive: accepts legacy (no-provider) and v2 records, drops malformed ones", async () => {
  await withTempStore(async () => {
    // Mix: a legacy record (no provider), a full v2 record (with provider+model),
    // and a malformed record (missing required `addedAt`) that must be dropped.
    const entries = [
      { id: "claude-legacy", tool: "claude", label: "legacy@a.b", addedAt: "2025-01-01T00:00:00.000Z" },
      { id: "opencode-v2", tool: "opencode", label: "minimax", provider: "minimax-coding-plan", model: "MiniMax-M3", addedAt: "2025-01-02T00:00:00.000Z" },
      { id: "broken", tool: "claude", label: "no-addedAt" },
    ];
    await mkdir(join(accountsRegistryPath(), ".."), { recursive: true });
    await writeFile(accountsRegistryPath(), `${JSON.stringify(entries, null, 2)}\n`);

    const accounts = await listAccounts();
    // Both valid shapes survive; the malformed one is dropped (not crashed on).
    assert.deepEqual(accounts.map((a) => a.id).sort(), ["claude-legacy", "opencode-v2"]);
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
    assert.equal(byId["claude-legacy"]!.provider, "anthropic"); // legacy backfilled
    assert.equal(byId["opencode-v2"]!.provider, "minimax-coding-plan"); // v2 preserved
  });
});

test("addAccount on a legacy registry lazily upgrades siblings; mixed legacy+v2 still loads", async () => {
  await withTempStore(async () => {
    // Pre-seed a legacy entry, then addAccount a v2 entry: the file now mixes shapes.
    const legacy = [{ id: "claude-legacy", tool: "claude", label: "legacy@a.b", addedAt: "2025-01-01T00:00:00.000Z" }];
    await mkdir(join(accountsRegistryPath(), ".."), { recursive: true });
    await writeFile(accountsRegistryPath(), `${JSON.stringify(legacy, null, 2)}\n`);

    const v2 = await addAccount("opencode", "glm", { provider: "zai-coding-plan", model: "glm-5.2" });

    const accounts = await listAccounts();
    assert.equal(accounts.length, 2);
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
    // Legacy backfilled on read; v2 keeps its explicit provider/model.
    assert.equal(byId["claude-legacy"]!.provider, "anthropic");
    assert.equal(byId[v2.id]!.provider, "zai-coding-plan");
    assert.equal(byId[v2.id]!.model, "glm-5.2");

    // addAccount rewrites the whole registry from the (already-normalized) read,
    // so a sibling legacy entry is lazily upgraded on this touch — a desirable
    // one-way migration, never a downgrade. Both entries now carry providers on
    // disk and the mixed file still loads cleanly.
    const raw = JSON.parse(await readFile(accountsRegistryPath(), "utf8")) as Array<Record<string, unknown>>;
    assert.equal(raw.find((r) => r.id === "claude-legacy")!.provider, "anthropic");
    assert.equal(raw.find((r) => r.id === v2.id)!.provider, "zai-coding-plan");
  });
});

test("autoAccountTool and roundRobinAccountTool parse only their reserved query", () => {
  // <tool>-auto picks the auto query; <tool>-rr picks the rr query. Neither
  // claims the other, and neither matches plain tools, account ids, or empty
  // suffixes — those fall through to the real account resolver.
  assert.equal(autoAccountTool("claude-auto"), "claude");
  assert.equal(autoAccountTool("codex-auto"), "codex");
  assert.equal(autoAccountTool("claude-rr"), undefined);
  assert.equal(autoAccountTool("claude-thto"), undefined);
  assert.equal(autoAccountTool("claude"), undefined);
  assert.equal(autoAccountTool("claude-"), undefined);
  assert.equal(autoAccountTool(""), undefined);

  assert.equal(roundRobinAccountTool("claude-rr"), "claude");
  assert.equal(roundRobinAccountTool("codex-rr"), "codex");
  assert.equal(roundRobinAccountTool("claude-auto"), undefined);
  assert.equal(roundRobinAccountTool("claude-thto"), undefined);
  assert.equal(roundRobinAccountTool("claude"), undefined);
  assert.equal(roundRobinAccountTool("claude-"), undefined);
  assert.equal(roundRobinAccountTool(""), undefined);

  // An unknown leading tool isn't shorthand at all — both detectors must
  // refuse so the resolver treats the whole token as an arbitrary executable.
  assert.equal(autoAccountTool("nosuchtool-auto"), undefined);
  assert.equal(roundRobinAccountTool("nosuchtool-rr"), undefined);
});
