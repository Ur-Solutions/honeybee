import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  captureAccountFromHome,
  findAccount,
  listAccounts,
  mergeCredentialsJson,
  normalizeAccountRecord,
  PROVIDER_BY_CLI,
  removeAccount,
  resolveSpawnAgent,
  syncClaudeChainToVault,
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
