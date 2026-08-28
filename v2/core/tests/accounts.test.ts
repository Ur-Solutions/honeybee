/**
 * Schema v7 — accounts at the core tier (spec 08 tests 1, 9, 10 groundwork):
 * account CRUD (remove refused while referenced), status / penalty / login /
 * exhaustion edits, bee ↔ account binding ('auto' never stored), the env +
 * session rekey helpers swapAccount uses, limits snapshots, the per-harness
 * selection cursor, the v6 → v7 migration, audit replay for every new kind,
 * and the pure provider-response parsers. Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AccountNotFoundError,
  AccountReferencedError,
  CoreError,
  SCHEMA_VERSION,
  accountIdFor,
  isAuthFailureLimitsError,
  parseClaudeCredentials,
  parseClaudeUsage,
  parseCodexRateLimits,
  recipeFor,
  recipeEnvFor,
  replayAudit,
  safeName,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

test("v7.recipes: the Claude recipe's CLI login is the native auth flow", () => {
  assert.deepEqual(recipeFor("claude")?.login, { command: "claude", args: ["auth", "login"] });
});

test("v7.crud: create/get/list (registration order), remove; remove refused while a bee references it; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const a = store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/homes/claude-a", label: "a" });
    assert.equal(a.status, "ok");
    assert.equal(a.penalty, 0);
    assert.equal(a.lastLoginAt, null);
    const b = store.createAccount({ id: "claude-b", harness: "claude", homePath: "/tmp/homes/claude-b", label: "b", penalty: 10, status: "paused" });
    store.createAccount({ id: "codex-c", harness: "codex", homePath: "/tmp/homes/codex-c", label: "c", addedAt: 5 });
    assert.deepEqual(store.listAccounts().map((x) => x.id), ["codex-c", "claude-a", "claude-b"], "added_at then id");
    assert.deepEqual(store.listAccounts({ harness: "claude" }).map((x) => x.id), ["claude-a", "claude-b"]);
    assert.equal(store.getAccount("nope"), null);
    assert.throws(() => store.createAccount({ id: "claude-a", harness: "claude", homePath: "/x", label: "dup" }), /already exists/);
    assert.throws(() => store.createAccount({ id: "auto", harness: "claude", homePath: "/x", label: "auto" }), /reserved/);
    assert.throws(() => store.createAccount({ id: "claude-z", harness: "claude", homePath: "/x", label: "z", penalty: 101 }), /penalty/);
    assert.throws(() => store.createAccount({ id: "claude-z", harness: "claude", homePath: "/x", label: "z", status: "nope" as never }), /status/);

    // A bee on the account blocks removal (typed), until it is unbound.
    const { bee } = store.createBee({ name: "w", agent: "claude", substrate: "hsr", cwd: "/tmp", account: a.id });
    assert.equal(bee.account, a.id);
    assert.deepEqual(store.beesOnAccount(a.id).map((x) => x.id), [bee.id]);
    assert.throws(() => store.removeAccount(a.id), (err: unknown) => err instanceof AccountReferencedError && err.beeIds[0] === bee.id);
    assert.ok(store.getAccount(a.id), "refusal changed nothing");
    store.setBeeAccount(bee.id, null);
    const removed = store.removeAccount(a.id);
    assert.equal(removed.id, a.id);
    assert.equal(store.getAccount(a.id), null);
    assert.throws(() => store.removeAccount(a.id), AccountNotFoundError);
    // paused b stays; the codex one is untouched
    assert.equal(store.getAccount(b.id)?.status, "paused");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v7.edits: status/penalty/login/exhaustion/fields — audited as account.put updated with changed+previous; identical = no-op; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "codex-a", harness: "codex", homePath: "/tmp/a", label: "a" });
    assert.equal(store.setAccountStatus("codex-a", "auth_needed", "adapter: not logged in").applied, true);
    assert.equal(store.setAccountStatus("codex-a", "auth_needed").applied, false, "identical = silent");
    assert.equal(store.setAccountPenalty("codex-a", 25).applied, true);
    assert.throws(() => store.setAccountPenalty("codex-a", -1), CoreError);
    assert.throws(() => store.setAccountPenalty("codex-a", 100.5), CoreError);
    // A completed login clears auth_needed and stamps last_login_at.
    const login = store.recordAccountLogin("codex-a", 777);
    assert.equal(login.account.status, "ok");
    assert.equal(login.account.lastLoginAt, 777);
    // …but never un-pauses a parked account.
    store.setAccountStatus("codex-a", "paused", "operator");
    assert.equal(store.recordAccountLogin("codex-a", 888).account.status, "paused");
    assert.equal(store.getAccount("codex-a")?.lastLoginAt, 888);
    assert.equal(store.recordAccountExhaustion("codex-a", 999).account.exhaustedAt, 999);
    assert.equal(store.recordAccountExhaustion("codex-a", null).account.exhaustedAt, null);
    assert.equal(store.updateAccountFields("codex-a", { label: "A", homePath: "/tmp/A" }).account.label, "A");
    assert.throws(() => store.updateAccountFields("codex-a", { label: "" }), CoreError);
    assert.throws(() => store.setAccountStatus("nope", "ok"), AccountNotFoundError);
    const puts = store.auditRows().filter((r) => r.kind === "account.put");
    assert.equal(puts[0]?.payload.outcome, "created");
    assert.equal(puts[1]?.payload.outcome, "updated");
    assert.deepEqual(puts[1]?.payload.changed, ["status"]);
    assert.deepEqual(puts[1]?.payload.previous, { status: "ok" });
    assert.equal(puts[1]?.payload.reason, "adapter: not logged in");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v7.binding: setBeeAccount requires an existing account, never stores account selectors; setBeeEnv + rekeyBeeSession audit + replay", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/a", label: "a" });
    store.createAccount({ id: "claude-b", harness: "claude", homePath: "/tmp/b", label: "b" });
    const { bee } = makeBee(store, "w");
    assert.equal(bee.account, null);
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", account: "auto" }), /never a stored binding/);
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", account: "rr" }), /never a stored binding/);
    assert.throws(() => store.createBee({ name: "x", agent: "claude", substrate: "hsr", cwd: "/tmp", account: "nope" }), AccountNotFoundError);
    assert.throws(() => store.setBeeAccount(bee.id, "auto"), CoreError);
    assert.throws(() => store.setBeeAccount(bee.id, "rr"), CoreError);
    assert.throws(() => store.setBeeAccount(bee.id, "nope"), AccountNotFoundError);
    const r1 = store.setBeeAccount(bee.id, "claude-a");
    assert.equal(r1.applied, true);
    assert.equal(r1.bee.account, "claude-a");
    assert.equal(store.setBeeAccount(bee.id, "claude-a").applied, false);
    const r2 = store.setBeeAccount(bee.id, "claude-b");
    assert.equal(r2.bee.account, "claude-b");
    const sets = store.auditRows().filter((r) => r.kind === "bee.account_set");
    assert.deepEqual(sets.map((r) => [r.payload.account, r.payload.previous]), [["claude-a", null], ["claude-b", "claude-a"]]);
    // env (the home mechanism)
    assert.equal(store.setBeeEnv(bee.id, { CLAUDE_CONFIG_DIR: "/tmp/b" }).applied, true);
    assert.equal(store.setBeeEnv(bee.id, { CLAUDE_CONFIG_DIR: "/tmp/b" }).applied, false);
    assert.deepEqual(store.getBee(bee.id)?.env, { CLAUDE_CONFIG_DIR: "/tmp/b" });
    assert.throws(() => store.setBeeEnv(bee.id, { X: 1 } as never), CoreError);
    // rekey (claude cross-account: resume the source under a NEW session via the fork seed)
    assert.equal(store.rekeyBeeSession(bee.id).applied, false, "nothing to rekey without a session");
    store.recordProviderSessionId(bee.id, "sid-1");
    const rekeyed = store.rekeyBeeSession(bee.id);
    assert.equal(rekeyed.applied, true);
    assert.equal(rekeyed.bee.forkSeed, "sid-1");
    assert.equal(rekeyed.bee.providerSessionId, null);
    // the fork's own id consumes the seed, like bee.fork
    store.recordProviderSessionId(bee.id, "sid-2");
    assert.equal(store.getBee(bee.id)?.forkSeed, null);
    assert.equal(store.getBee(bee.id)?.providerSessionId, "sid-2");
    // deleting the bee frees the account for removal
    store.deleteBee(bee.id);
    store.removeAccount("claude-b");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v7.limits+cursor: putAccountLimits replaces the one row per account (cascade on remove); selection cursor upserts; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/a", label: "a" });
    store.createAccount({ id: "claude-b", harness: "claude", homePath: "/tmp/b", label: "b" });
    assert.equal(store.getAccountLimits("claude-a"), null);
    const l1 = store.putAccountLimits("claude-a", {
      readable: true,
      plan: "max",
      fiveHour: { usedPercent: 3, resetsAt: 100, windowMinutes: 300 },
      weekly: { usedPercent: 40.5, resetsAt: 200, windowMinutes: 10_080 },
      fableWeekly: { usedPercent: 16, resetsAt: 200, windowMinutes: 10_080 },
      displayWindows: [
        { key: "cursor-models", label: "cursor models", usedPercent: 9, resetsAt: 300, windowMinutes: 43_200 },
      ],
      fetchedAt: 50,
    });
    assert.equal(l1.fetchedAt, 50);
    assert.equal(l1.weeklyPct, 40.5);
    assert.equal(l1.fableWeeklyPct, 16);
    assert.deepEqual(l1.displayWindows, [
      { key: "cursor-models", label: "cursor models", usedPercent: 9, resetsAt: 300, windowMinutes: 43_200 },
    ]);
    const l2 = store.putAccountLimits("claude-a", { readable: false, error: "HTTP 401 revoked" });
    assert.equal(l2.readable, false);
    assert.equal(l2.weeklyPct, null, "replaced, not merged");
    assert.deepEqual(l2.displayWindows, [], "display windows are replaced too");
    assert.equal(store.listAccountLimits().length, 1);
    assert.throws(() => store.putAccountLimits("nope", { readable: true }), AccountNotFoundError);
    // cursor
    assert.equal(store.getSelectionCursor("claude"), null);
    store.setSelectionCursor("claude", "claude-a");
    store.setSelectionCursor("claude", "claude-b");
    assert.equal(store.getSelectionCursor("claude")?.lastAccountId, "claude-b");
    assert.equal(store.listSelectionCursors().length, 1);
    // removing the account the cursor points at clears the cursor + cascades limits
    store.removeAccount("claude-b");
    assert.equal(store.getSelectionCursor("claude"), null);
    store.putAccountLimits("claude-a", { readable: true, weekly: { usedPercent: 1 } });
    store.removeAccount("claude-a");
    assert.deepEqual(store.listAccountLimits(), []);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v7.migration: a v6 store opens as v7 — bees.account added, accounts/account_limits/selection_cursors created, data intact, stamp bumped", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '6');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT, parent_id TEXT, forked_from TEXT, fork_seed TEXT
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, provider_session_id, env)
        VALUES('old-1','old','claude','hsr','/tmp','active',5,'sid-old','{"CLAUDE_CONFIG_DIR":"/tmp/homes/claude-x"}');
      CREATE TABLE runtimes (
        bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK (generation >= 1),
        state TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
        exit_cause TEXT, pid INTEGER, pid_started_at INTEGER, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (bee_id, generation)
      ) STRICT;
      INSERT INTO runtimes(bee_id, generation, state, exit_cause, started_at, updated_at) VALUES('old-1', 1, 'stopped', 'clean', 5, 6);
    `);
    db.close();
    const store = h.open();
    const old = store.getBee("old-1");
    assert.equal(old?.account, null);
    assert.equal(old?.providerSessionId, "sid-old", "v3 data intact");
    assert.deepEqual(old?.env, { CLAUDE_CONFIG_DIR: "/tmp/homes/claude-x" });
    // the new tables work on the migrated store; binding the old bee works
    store.createAccount({ id: "claude-x", harness: "claude", homePath: "/tmp/homes/claude-x", label: "x" });
    assert.equal(store.setBeeAccount("old-1", "claude-x").applied, true);
    store.putAccountLimits("claude-x", { readable: true, weekly: { usedPercent: 2 } });
    store.setSelectionCursor("claude", "claude-x");
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 16);
      const cols = (check.prepare("SELECT name FROM pragma_table_info('bees')").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("account"));
      const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      for (const t of ["accounts", "account_limits", "selection_cursors"]) assert.ok(tables.includes(t), t);
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});

test("v7.dump: StateDump carries accounts + limits + cursors; a fresh store's replay equals its dump", () => {
  const h = harness();
  try {
    const store = h.open();
    const dump = store.dumpState();
    assert.deepEqual(dump.accounts, []);
    assert.deepEqual(dump.accountLimits, []);
    assert.deepEqual(dump.selectionCursors, []);
    assert.deepEqual(replayAudit(store.auditRows()), dump);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v12+v13 migration: account_limits gains typed failures and display windows without inventing old data", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '11');
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, harness TEXT NOT NULL, home_path TEXT NOT NULL, label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ok','auth_needed','paused')), penalty INTEGER NOT NULL DEFAULT 0,
        last_login_at INTEGER, exhausted_at INTEGER, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO accounts VALUES('claude-old','claude','/tmp/claude-old','old','ok',0,NULL,NULL,1,1);
      CREATE TABLE account_limits (
        account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        fetched_at INTEGER NOT NULL, readable INTEGER NOT NULL CHECK (readable IN (0,1)), error TEXT, plan TEXT,
        five_hour_pct REAL, five_hour_resets_at INTEGER, five_hour_minutes INTEGER,
        weekly_pct REAL, weekly_resets_at INTEGER, weekly_minutes INTEGER,
        fable_weekly_pct REAL, fable_resets_at INTEGER, fable_minutes INTEGER
      ) STRICT;
      INSERT INTO account_limits VALUES('claude-old',2,0,'old failure',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    `);
    db.close();
    const store = h.open();
    assert.equal(store.getAccountLimits("claude-old")?.unreadableReason, null);
    const refreshed = store.putAccountLimits("claude-old", {
      readable: false,
      unreadableReason: "auth_expired",
      error: "expired",
    });
    assert.equal(refreshed.unreadableReason, "auth_expired");
    store.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const columns = (check.prepare("SELECT name FROM pragma_table_info('account_limits')").all() as Array<{ name: string }>).map((row) => row.name);
      assert.ok(columns.includes("unreadable_reason"));
      assert.ok(columns.includes("display_windows"));
      assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// recipes + ids
// ---------------------------------------------------------------------------

test("v7.ids: accountIdFor follows the old registry rule (safeName, lower-case) — the operator's ids come across byte-identical", () => {
  assert.equal(accountIdFor("claude", "tormod@thto.no"), "claude-tormod-thto.no");
  assert.equal(accountIdFor("claude", "tormod.haugland@gmail.com"), "claude-tormod.haugland-gmail.com");
  assert.equal(accountIdFor("codex", " Codex Tormod Digitech "), "codex-codex-tormod-digitech");
  assert.equal(accountIdFor("kimi", "default"), "kimi-default");
  assert.equal(safeName("..."), "---");
  assert.deepEqual(recipeEnvFor("opencode", "/h"), { XDG_DATA_HOME: "/h/xdg-data" });
  assert.deepEqual(recipeEnvFor("claude", "/h"), {});
});

// ---------------------------------------------------------------------------
// provider response parsing (ported from the old limits tests)
// ---------------------------------------------------------------------------

// old: "claude limits use the freshest unexpired token and map the usage windows" (mapping half)
//    + "claude limits map the Fable-scoped weekly entry to fableWeekly"
test("v7.parse.claude: five_hour/seven_day → windows with implied lengths; the Fable weekly_scoped entry → fableWeekly; no windows = unreadable", () => {
  const parsed = parseClaudeUsage({
    five_hour: { utilization: 12, resets_at: "2026-06-10T14:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-06-15T00:00:00Z" },
    limits: [
      null,
      { kind: "session", percent: 12 },
      { kind: "weekly_scoped", percent: 66, resets_at: "2026-06-15T00:00:00Z", scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Other" } } },
    ],
  }, "max");
  assert.deepEqual(parsed, {
    readable: true,
    plan: "max",
    fiveHour: { usedPercent: 12, windowMinutes: 300, resetsAt: Date.parse("2026-06-10T14:00:00Z") },
    weekly: { usedPercent: 40, windowMinutes: 10_080, resetsAt: Date.parse("2026-06-15T00:00:00Z") },
    fableWeekly: { usedPercent: 66, windowMinutes: 10_080, resetsAt: Date.parse("2026-06-15T00:00:00Z") },
  });
  const empty = parseClaudeUsage({ five_hour: { utilization: null }, seven_day: null });
  assert.equal(empty.readable, false);
  assert.match(empty.error ?? "", /no windows/);
  // a weekly-only answer is readable
  assert.equal(parseClaudeUsage({ seven_day: { utilization: 1 } }).readable, true);
});

// old: "codex keeps a weekly-only primary window out of the 5h column"
//    + "codex snapshot fallback classifies a weekly-only primary window by duration"
//    + "codex prefers live app-server limits" (mapping half)
test("v7.parse.codex: duration-classified windows win; a weekly-only primary stays out of the 5h column; positional fallback for duration-less windows", () => {
  const live = parseCodexRateLimits({
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_700_000_000 },
    secondary: { usedPercent: 55, windowDurationMins: 10_080, resetsAt: 1_700_500_000 },
    planType: "pro",
  });
  assert.deepEqual(live, {
    readable: true,
    plan: "pro",
    fiveHour: { usedPercent: 20, resetsAt: 1_700_000_000_000, windowMinutes: 300 },
    weekly: { usedPercent: 55, resetsAt: 1_700_500_000_000, windowMinutes: 10_080 },
  });
  // Codex promotes the weekly window to `primary` when the 5h limit is disabled.
  const weeklyOnly = parseCodexRateLimits({ primary: { usedPercent: 33, windowDurationMins: 10_080 }, secondary: null });
  assert.equal(weeklyOnly.fiveHour, undefined);
  assert.equal(weeklyOnly.weekly?.usedPercent, 33);
  // No duration metadata → positional (primary = 5h, secondary = weekly).
  const positional = parseCodexRateLimits({ primary: { usedPercent: 1 }, secondary: { usedPercent: 2 } });
  assert.equal(positional.fiveHour?.usedPercent, 1);
  assert.equal(positional.weekly?.usedPercent, 2);
  // Mixed: a classified weekly primary + a duration-less secondary lands in the free (5h) slot.
  const mixed = parseCodexRateLimits({ primary: { usedPercent: 7, windowDurationMins: 10_080 }, secondary: { usedPercent: 9 } });
  assert.equal(mixed.weekly?.usedPercent, 7);
  assert.equal(mixed.fiveHour?.usedPercent, 9);
  assert.equal(parseCodexRateLimits({}).readable, false);
});

test("v7.parse.claude-credentials + auth-failure classifier", () => {
  assert.equal(parseClaudeCredentials(null), null);
  assert.equal(parseClaudeCredentials("nope"), null);
  assert.equal(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "t" } })), null, "expiresAt required");
  assert.deepEqual(
    parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 5, subscriptionType: "max", refreshToken: "r" } })),
    { accessToken: "t", expiresAt: 5, subscriptionType: "max", refreshToken: "r" },
  );
  assert.equal(isAuthFailureLimitsError("/api/oauth/usage: HTTP 401 — OAuth access token has been revoked"), true);
  assert.equal(isAuthFailureLimitsError("invalid_grant"), true);
  assert.equal(isAuthFailureLimitsError("HTTP 429 rate limited"), false);
  assert.equal(isAuthFailureLimitsError("fetch failed"), false);
});
