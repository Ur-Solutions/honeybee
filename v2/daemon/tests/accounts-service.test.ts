/**
 * Spec 08 at the daemon tier, in-process (AccountsService over a real store,
 * temp dirs, injected transports):
 *  - selection over the store: candidate rules (paused, credentialed,
 *    auth_needed skipped while a healthy one exists / last resort), the
 *    single-candidate short-circuit, the ported scoring over limits ROWS
 *    (incl. the operator's 30%/3h vs 25%/6d case), live-bee commitments,
 *    penalty, near-tie rotation through the cursor ROW, stale limits used and
 *    logged, the old log line format
 *  - limits: fetch → table (claude via home .credentials.json + injected
 *    usage transport; codex via injected app-server transport); freshness
 *    policy (older than 1h refreshed before an auto pick; fresh rows not;
 *    lone candidate never fetches); auth failure → auth_needed; recovery
 *  - activation: empty home activated from the vault + home defaults;
 *    populated home untouched byte for byte; no vault write ever from a
 *    spawn; claude keychain seed via injected writer
 *  - login seat (real tmux on a private socket, FAKE harness login): mtime
 *    detection (codex) and Keychain digest drift via injected reader
 *    (claude) → recipe files in the vault → status ok + last_login_at
 *  - importer: the old registry layout → rows (dry-run + real, idempotent);
 *    env-only bee backfill by home path
 * SAFETY: temp dirs only. The one read of the REAL ~/.hive is a dry-run of
 * the importer (read-only; asserted by mtime) and is skipped when absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig, type NodeConfigFile, type ResolvedNodeConfig } from "../src/config.ts";
import { recipeFingerprint } from "../src/activation.ts";
import { FAKE_LOGIN_PATH, waitFor } from "./helpers.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Rig {
  dir: string;
  store: CoreStore;
  cfg: ResolvedNodeConfig;
  log: string[];
  now: () => number;
  setNow: (t: number) => void;
  vault: string;
  homes: string;
  cleanup: () => void;
}

function rig(config: NodeConfigFile = {}, opts: { start?: number } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-accounts-"));
  const vault = join(dir, "vault");
  const homes = join(dir, "homes");
  const file: NodeConfigFile = {
    ...config,
    accounts: {
      vaultDir: vault,
      homesDir: homes,
      tmuxSocket: `hb-v2-acct-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      limitsRefreshMs: 0,
      loginTimeoutMs: 15_000,
      ...(config.accounts ?? {}),
    },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(file));
  const cfg = loadNodeConfig(dir);
  let t = opts.start ?? Date.parse("2026-06-10T12:00:00Z");
  const now = () => t;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now });
  const log: string[] = [];
  return {
    dir,
    store,
    cfg,
    log,
    now,
    setNow: (v) => {
      t = v;
    },
    vault,
    homes,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedVault(r: Rig, harness: string, id: string, files: Record<string, string>): string {
  const dir = join(r.vault, harness, id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function addAccount(r: Rig, harness: string, label: string, opts: { penalty?: number; status?: "ok" | "paused" | "auth_needed"; addedAt?: number; vault?: Record<string, string> } = {}) {
  const id = `${harness}-${label}`;
  const account = r.store.createAccount({ id, harness, homePath: join(r.homes, id), label, penalty: opts.penalty ?? 0, status: opts.status ?? "ok", addedAt: opts.addedAt });
  seedVault(r, harness, id, opts.vault ?? (harness === "claude" ? { ".credentials.json": "{}" } : { "auth.json": "{}" }));
  return account;
}

function limitsRow(r: Rig, id: string, weekly: number, fiveHour: number, weeklyResetsAt: number, opts: { fetchedAt?: number; fable?: number; readable?: boolean } = {}) {
  return r.store.putAccountLimits(id, {
    readable: opts.readable ?? true,
    fiveHour: { usedPercent: fiveHour, resetsAt: r.now() + 2 * HOUR, windowMinutes: 300 },
    weekly: { usedPercent: weekly, resetsAt: weeklyResetsAt, windowMinutes: 10_080 },
    ...(opts.fable !== undefined ? { fableWeekly: { usedPercent: opts.fable, resetsAt: weeklyResetsAt, windowMinutes: 10_080 } } : {}),
    fetchedAt: opts.fetchedAt ?? r.now(),
  });
}

function service(r: Rig, extra: Partial<ConstructorParameters<typeof AccountsService>[0]> = {}): AccountsService {
  return new AccountsService({ store: r.store, cfg: r.cfg, log: (op) => r.log.push(op), now: r.now, ...extra });
}

// ---------------------------------------------------------------------------
// selection over the store
// ---------------------------------------------------------------------------

test("select.1: candidate rules — none registered / all paused / none credentialed are typed refusals; a lone candidate short-circuits without a limits read", () => {
  const r = rig();
  try {
    const svc = service(r);
    assert.equal(svc.pick("claude").ok, false);
    assert.equal((svc.pick("claude") as { code: string }).code, "no_accounts");
    const a = addAccount(r, "claude", "a", { status: "paused" });
    assert.equal((svc.pick("claude") as { code: string }).code, "all_paused");
    r.store.setAccountStatus(a.id, "ok");
    // credentialed = vault OR home has the primary credential
    rmSync(join(r.vault, "claude", a.id), { recursive: true, force: true });
    assert.equal((svc.pick("claude") as { code: string }).code, "no_credentials");
    mkdirSync(a.homePath, { recursive: true });
    writeFileSync(join(a.homePath, ".credentials.json"), "{}");
    const lone = svc.pick("claude");
    assert.ok(lone.ok);
    assert.equal(lone.account.id, a.id);
    assert.equal(lone.candidates, 1);
    assert.match(lone.reason, /^only claude account with credentials$/);
    assert.equal(lone.limitsAgeMs, null, "no limits read for a lone candidate");
    assert.ok(r.log.some((l) => l === `account auto → ${a.id} — only claude account with credentials`), r.log.join("\n"));
    // an excluded lone candidate → no_untried
    assert.equal((svc.pick("claude", { excludeAccountIds: new Set([a.id]) }) as { code: string }).code, "no_untried");
  } finally {
    r.cleanup();
  }
});

test("select.2: the operator's case over ROWS — 30% weekly with 3h to reset beats 25% with 6 days; stale rows are used and logged as stale", () => {
  const r = rig();
  try {
    const svc = service(r);
    const far = addAccount(r, "claude", "far", { addedAt: 1 });
    const soon = addAccount(r, "claude", "soon", { addedAt: 2 });
    limitsRow(r, far.id, 25, 5, r.now() + 6 * DAY);
    limitsRow(r, soon.id, 30, 5, r.now() + 3 * HOUR, { fetchedAt: r.now() - 2 * HOUR }); // stale (>1h)
    const pick = svc.pick("claude");
    assert.ok(pick.ok);
    assert.equal(pick.account.id, soon.id);
    assert.match(pick.reason, /behind pace — surplus expires at reset/);
    assert.equal(pick.stale, true);
    assert.equal(pick.limitsAgeMs, 2 * HOUR);
    const line = r.log.find((l) => l.startsWith("account auto →"));
    assert.ok(line);
    assert.match(line, /^account auto → claude-soon \(weekly 30%, 5h 5%, limits 120 min old \(stale\)\) — least effective weekly load \(\d+% behind pace — surplus expires at reset\)$/);
  } finally {
    r.cleanup();
  }
});

test("select.3: auth_needed accounts are skipped while a healthy one exists (named in the reason) and are the last resort otherwise; paused never", () => {
  const r = rig();
  try {
    const svc = service(r);
    const bad = addAccount(r, "codex", "bad", { status: "auth_needed", addedAt: 1 });
    const good = addAccount(r, "codex", "good", { addedAt: 2 });
    limitsRow(r, bad.id, 0, 0, r.now() + DAY);
    limitsRow(r, good.id, 90, 0, r.now() + DAY);
    const pick = svc.pick("codex");
    assert.ok(pick.ok);
    assert.equal(pick.account.id, good.id, "an auth-failed account must not win even with the lowest load");
    assert.match(pick.reason, new RegExp(`only healthy codex account with credentials; skipped ${bad.id} for recent auth failure`));
    // recovery evidence returns the account to auto selection
    r.store.setAccountStatus(bad.id, "ok");
    const recovered = svc.pick("codex");
    assert.ok(recovered.ok);
    assert.equal(recovered.account.id, bad.id);
    // every candidate auth_needed → last resort, said so
    r.store.setAccountStatus(bad.id, "auth_needed");
    r.store.setAccountStatus(good.id, "auth_needed");
    const resort = svc.pick("codex");
    assert.ok(resort.ok);
    assert.match(resort.reason, /every credentialed account has a recent auth failure; using last resort/);
    // paused is out of the pool entirely
    r.store.setAccountStatus(good.id, "paused");
    const p = svc.pick("codex");
    assert.ok(p.ok);
    assert.equal(p.account.id, bad.id);
  } finally {
    r.cleanup();
  }
});

test("select.4: live-bee commitments steer around a busy account; the winner's in-flight load and penalty are named", () => {
  const r = rig();
  try {
    const svc = service(r);
    const busy = addAccount(r, "claude", "busy", { addedAt: 1 });
    const quiet = addAccount(r, "claude", "quiet", { addedAt: 2 });
    // busy is emptier on provider numbers (10 vs 20) but hosts two workers.
    limitsRow(r, busy.id, 10, 10, r.now() + 6 * HOUR);
    limitsRow(r, quiet.id, 20, 10, r.now() + 6 * HOUR);
    for (const name of ["w1", "w2"]) {
      const { bee } = r.store.createBee({ name, agent: "claude", substrate: "hsr", cwd: "/tmp", account: busy.id });
      r.store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
    }
    // an idle bee on quiet is a parked commitment (+2), a stopped one nothing
    const { bee: idle } = r.store.createBee({ name: "idle", agent: "claude", substrate: "hsr", cwd: "/tmp", account: quiet.id });
    r.store.updateRuntimeState(idle.id, 1, "running", { pid: 2, pidStartedAt: 1 });
    r.store.updateRuntimeState(idle.id, 1, "idle");
    const pick = svc.pick("claude");
    assert.ok(pick.ok);
    assert.equal(pick.account.id, quiet.id);
    assert.match(pick.reason, /\+2 in-flight/);
    // penalty: the operator's hint moves the pick
    r.store.setAccountPenalty(quiet.id, 40);
    const penalized = svc.pick("claude");
    assert.ok(penalized.ok);
    assert.equal(penalized.account.id, busy.id);
    assert.match(penalized.reason, /\+16 in-flight/);
  } finally {
    r.cleanup();
  }
});

test("select.5: near-ties rotate through the per-harness cursor ROW (a same-instant burst spreads); a Fable model reaches the scoring", () => {
  const r = rig();
  try {
    const svc = service(r);
    const ids = ["a", "b", "c"].map((l, i) => addAccount(r, "claude", l, { addedAt: i + 1 }).id);
    for (const id of ids) limitsRow(r, id, 10, 10, r.now() + 6 * HOUR);
    const picks: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const p = svc.pick("claude");
      assert.ok(p.ok);
      picks.push(p.account.id);
    }
    assert.deepEqual(picks, ["claude-a", "claude-b", "claude-c", "claude-a"]);
    assert.equal(r.store.getSelectionCursor("claude")?.lastAccountId, "claude-a");
    assert.match(r.log.filter((l) => l.startsWith("account auto"))[1] as string, /near-tie rotation among 3 accounts/);
    // Fable: a's Fable allowance is almost empty — a Fable spawn avoids it, a plain one does not
    limitsRow(r, "claude-a", 10, 10, r.now() + 6 * HOUR, { fable: 99 });
    limitsRow(r, "claude-b", 40, 10, r.now() + 6 * HOUR, { fable: 60 });
    r.store.removeAccount("claude-c");
    const plain = svc.pick("claude");
    assert.ok(plain.ok);
    assert.equal(plain.account.id, "claude-a");
    const fable = svc.pick("claude", { model: "claude-fable-5" });
    assert.ok(fable.ok);
    assert.equal(fable.account.id, "claude-b");
    assert.match(fable.reason, /Fable/);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// limits fetch → table; freshness policy
// ---------------------------------------------------------------------------

test("limits.1: fetch writes the table (claude via the home token + injected usage transport, codex via the injected app-server transport); failures = unreadable rows; auth failure → auth_needed, recovery → ok", async () => {
  const r = rig();
  try {
    const usageCalls: string[] = [];
    const codexCalls: string[] = [];
    let claudeFail: string | null = null;
    const svc = service(r, {
      fetchers: {
        claudeUsage: async (token) => {
          usageCalls.push(token);
          if (claudeFail) throw new Error(claudeFail);
          return { five_hour: { utilization: 12, resets_at: "2026-06-10T14:00:00Z" }, seven_day: { utilization: 40, resets_at: "2026-06-15T00:00:00Z" }, limits: [{ kind: "weekly_scoped", percent: 66, scope: { model: { display_name: "Fable" } } }] };
        },
        codexRateLimits: async (home) => {
          codexCalls.push(home);
          return { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 55, windowDurationMins: 10_080 }, planType: "pro" };
        },
      },
      keychainReader: async () => null,
    });
    const claude = addAccount(r, "claude", "a", { vault: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "vault-token", expiresAt: r.now() + HOUR, subscriptionType: "max" } }) } });
    // the HOME's token is fresher than the vault's → it is the one used (home authoritative)
    mkdirSync(claude.homePath, { recursive: true });
    writeFileSync(join(claude.homePath, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "home-token", expiresAt: r.now() + 2 * HOUR, subscriptionType: "max" } }));
    const codex = addAccount(r, "codex", "c");
    const grok = addAccount(r, "grok", "g");
    const rows = await svc.refreshLimits();
    assert.deepEqual(usageCalls, ["home-token"]);
    assert.deepEqual(codexCalls, [codex.homePath]);
    const byId = new Map(rows.map((x) => [x.account, x]));
    const c = byId.get(claude.id)!;
    assert.equal(c.readable, true);
    assert.equal(c.plan, "max");
    assert.equal(c.fiveHourPct, 12);
    assert.equal(c.weeklyPct, 40);
    assert.equal(c.fableWeeklyPct, 66);
    assert.equal(c.weeklyResetsAt, Date.parse("2026-06-15T00:00:00Z"));
    const x = byId.get(codex.id)!;
    assert.equal(x.readable, true);
    assert.equal(x.plan, "pro");
    assert.equal(x.fiveHourPct, 20);
    assert.equal(x.weeklyPct, 55);
    const g = byId.get(grok.id)!;
    assert.equal(g.readable, false);
    assert.match(g.error ?? "", /no limits source/);
    assert.equal(r.store.getAccountLimits(claude.id)?.weeklyPct, 40, "table row written");
    // a REAL auth failure sets auth_needed; a later readable probe clears it
    claudeFail = "/api/oauth/usage: HTTP 401 — OAuth access token has been revoked";
    await svc.refreshLimits([claude.id]);
    assert.equal(r.store.getAccount(claude.id)?.status, "auth_needed");
    assert.equal(r.store.getAccountLimits(claude.id)?.readable, false);
    claudeFail = null;
    await svc.refreshLimits([claude.id]);
    assert.equal(r.store.getAccount(claude.id)?.status, "ok");
    // a transport error is unreadable but NOT an auth failure
    claudeFail = "fetch failed";
    await svc.refreshLimits([claude.id]);
    assert.equal(r.store.getAccount(claude.id)?.status, "ok");
    assert.equal(r.store.getAccountLimits(claude.id)?.error, "fetch failed");
    // an expired token is unreadable without a network call
    claudeFail = null;
    writeFileSync(join(claude.homePath, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: r.now() - 1 } }));
    rmSync(join(r.vault, "claude", claude.id, ".credentials.json"));
    const before = usageCalls.length;
    await svc.refreshLimits([claude.id]);
    assert.equal(usageCalls.length, before);
    assert.match(r.store.getAccountLimits(claude.id)?.error ?? "", /expired/);
  } finally {
    r.cleanup();
  }
});

test("limits.2: freshness policy — before an auto pick, rows older than limitsStaleMs (or missing) are refreshed, fresh rows are not, and a lone candidate never fetches", async () => {
  const r = rig({ accounts: { limitsStaleMs: HOUR } });
  try {
    const fetched: string[] = [];
    const svc = service(r, {
      fetchers: {
        codexRateLimits: async (home) => {
          fetched.push(home);
          return { primary: { usedPercent: home.endsWith("-a") ? 50 : 10, windowDurationMins: 300 }, secondary: { usedPercent: home.endsWith("-a") ? 50 : 10, windowDurationMins: 10_080 } };
        },
      },
    });
    const a = addAccount(r, "codex", "a", { addedAt: 1 });
    // one candidate: no fetch at all
    assert.deepEqual((await svc.ensureFreshLimits("codex")).refreshed, []);
    assert.deepEqual(fetched, []);
    const b = addAccount(r, "codex", "b", { addedAt: 2 });
    // two candidates, no rows: both fetched
    const first = await svc.ensureFreshLimits("codex");
    assert.deepEqual(first.refreshed.sort(), [a.id, b.id]);
    assert.equal(fetched.length, 2);
    // 2 minutes later: fresh, nothing refetched; the pick rides the rows
    r.setNow(r.now() + 2 * 60_000);
    assert.deepEqual((await svc.ensureFreshLimits("codex")).refreshed, []);
    assert.equal(fetched.length, 2);
    const pick = svc.pick("codex");
    assert.ok(pick.ok);
    assert.equal(pick.account.id, b.id);
    assert.equal(pick.stale, false);
    // 61 minutes later: stale → refreshed before the pick
    r.setNow(r.now() + 61 * 60_000);
    const again = await svc.ensureFreshLimits("codex");
    assert.deepEqual(again.refreshed.sort(), [a.id, b.id]);
    assert.equal(fetched.length, 4);
    // periodic tick: off at 0
    svc.periodicRefreshTick();
    assert.equal(fetched.length, 4);
  } finally {
    r.cleanup();
  }
});

test("limits.3: the periodic in-daemon sweep runs every limitsRefreshMs, never overlaps itself, and is bounded by the fetch timeout", async () => {
  const r = rig({ accounts: { limitsRefreshMs: 1000, limitsFetchTimeoutMs: 50 } });
  try {
    let calls = 0;
    const svc = service(r, {
      fetchers: {
        codexRateLimits: () => {
          calls += 1;
          return new Promise(() => {}); // never answers: the timeout bounds it
        },
      },
    });
    addAccount(r, "codex", "a");
    svc.periodicRefreshTick();
    svc.periodicRefreshTick(); // joins the in-flight sweep
    await waitFor(() => r.store.getAccountLimits("codex-a") ?? null, "timed-out row", 2000);
    assert.equal(calls, 1);
    assert.match(r.store.getAccountLimits("codex-a")?.error ?? "", /timed out after 50ms/);
    // inside the interval: no new sweep; after it: one more
    svc.periodicRefreshTick();
    assert.equal(calls, 1);
    r.setNow(r.now() + 1001);
    svc.periodicRefreshTick();
    await waitFor(() => (calls === 2 ? true : null), "second sweep", 2000);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// activation
// ---------------------------------------------------------------------------

test("activation.1: an EMPTY home is activated from the vault (+ home defaults, mirrors); a POPULATED home is untouched byte for byte; the vault is never written by a spawn; claude keychain seeded via the injected writer", async () => {
  const r = rig();
  try {
    const written: Array<[string, string]> = [];
    const svc = service(r, { keychainWriter: async (home, creds) => { written.push([home, creds]); return true; } });
    // codex: vault has auth.json + config.toml
    const codex = addAccount(r, "codex", "a", { vault: { "auth.json": '{"tokens":"vault"}', "config.toml": 'model = "custom"\n' } });
    const vaultBefore = recipeFingerprint(join(r.vault, "codex", codex.id), "codex");
    const first = svc.activateForSpawn(codex, { cwd: "/tmp/w" });
    assert.equal(first.activated, true);
    assert.deepEqual(first.copied, ["auth.json", "config.toml", ".codex/auth.json"]);
    assert.equal(readFileSync(join(codex.homePath, "auth.json"), "utf8"), '{"tokens":"vault"}');
    assert.equal(readFileSync(join(codex.homePath, ".codex", "auth.json"), "utf8"), '{"tokens":"vault"}');
    const toml = readFileSync(join(codex.homePath, "config.toml"), "utf8");
    assert.match(toml, /^model = "custom"$/m, "operator model kept");
    assert.match(toml, /model_reasoning_effort = "xhigh"/);
    assert.match(toml, /service_tier = "fast"/);
    assert.match(toml, /\[notice\]\nhide_full_access_warning = true/);
    // the home is now populated: a live harness rotates its token in the home…
    writeFileSync(join(codex.homePath, "auth.json"), '{"tokens":"rotated-in-home"}');
    writeFileSync(join(codex.homePath, "config.toml"), "model = \"edited\"\n");
    const homeBefore = recipeFingerprint(codex.homePath, "codex");
    // …and the next spawns do NOTHING to it, and never touch the vault
    for (let i = 0; i < 3; i += 1) {
      const again = svc.activateForSpawn(codex, { cwd: "/tmp/w" });
      assert.equal(again.activated, false);
      assert.equal(again.reason, "home_populated");
    }
    assert.deepEqual(recipeFingerprint(codex.homePath, "codex"), homeBefore, "populated home untouched byte for byte");
    assert.deepEqual(recipeFingerprint(join(r.vault, "codex", codex.id), "codex"), vaultBefore, "no vault write from a spawn");
    // claude: credentials + acceptance + settings defaults + keychain seed
    const claude = addAccount(r, "claude", "b", { vault: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 1 } }), ".claude.json": JSON.stringify({ projects: {} }), "settings.json": JSON.stringify({ model: "opus" }) } });
    const act = svc.activateForSpawn(claude, { cwd: "/tmp/repo" });
    assert.equal(act.activated, true);
    const settings = JSON.parse(readFileSync(join(claude.homePath, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.equal(settings.model, "opus", "an explicit model is left alone");
    const cj = JSON.parse(readFileSync(join(claude.homePath, ".claude.json"), "utf8")) as { hasCompletedOnboarding: boolean; bypassPermissionsModeAccepted: boolean; projects: Record<string, { hasTrustDialogAccepted: boolean }> };
    assert.equal(cj.hasCompletedOnboarding, true);
    assert.equal(cj.bypassPermissionsModeAccepted, true);
    assert.equal(cj.projects["/tmp/repo"]?.hasTrustDialogAccepted, true);
    await waitFor(() => (written.length > 0 ? true : null), "keychain writer called");
    assert.equal(written[0]?.[0], claude.homePath);
    assert.match(written[0]?.[1] ?? "", /"accessToken":"t"/);
    // an empty vault + empty home: nothing to activate (the login seat is the way in)
    const bare = r.store.createAccount({ id: "claude-bare", harness: "claude", homePath: join(r.homes, "claude-bare"), label: "bare" });
    assert.equal(svc.activateForSpawn(bare, { cwd: "/tmp" }).reason, "vault_empty");
    assert.equal(existsSync(join(r.homes, "claude-bare", ".credentials.json")), false);
    // a fresh claude home with no vault settings.json gets the default model
    const fresh = addAccount(r, "claude", "fresh", { vault: { ".credentials.json": "{}" } });
    svc.activateForSpawn(fresh, { cwd: "/tmp" });
    assert.equal((JSON.parse(readFileSync(join(fresh.homePath, "settings.json"), "utf8")) as { model: string }).model, "opus[1m]");
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// login seat
// ---------------------------------------------------------------------------

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("login.1: the login seat (tmux, FAKE harness login) — mtime past baseline (codex) → recipe files captured into the vault, status ok + last_login_at; a rejoin returns the running seat", { skip: !tmuxAvailable && "tmux not installed" }, async () => {
  const r = rig({
    agents: {
      codex: { command: process.execPath, args: [], adapter: "codex", login: { command: process.execPath, args: [FAKE_LOGIN_PATH] }, env: { FAKE_LOGIN_HOME_ENV: "CODEX_HOME", FAKE_LOGIN_FILE: "auth.json", FAKE_LOGIN_DELAY_MS: "300", FAKE_LOGIN_CONTENT: '{"tokens":"fresh"}' } },
    },
  });
  try {
    const svc = service(r);
    // an account that was logged in before: the home holds a stale auth.json (baseline)
    const account = r.store.createAccount({ id: "codex-x", harness: "codex", homePath: join(r.homes, "codex-x"), label: "x", status: "auth_needed" });
    mkdirSync(account.homePath, { recursive: true });
    writeFileSync(join(account.homePath, "auth.json"), '{"tokens":"stale"}');
    writeFileSync(join(account.homePath, "config.toml"), "model = \"x\"\n");
    // make the baseline mtime clearly in the past
    const past = Date.now() - 5000;
    const { utimesSync } = await import("node:fs");
    utimesSync(join(account.homePath, "auth.json"), past / 1000, past / 1000);
    const started = await svc.startLogin(account);
    assert.equal(started.rejoined, false);
    assert.match(started.seat.attach, /tmux -L hb-v2-acct-\S+ attach -t hive-login-codex-x/);
    assert.equal(started.seat.baselineMtime !== null, true);
    assert.equal(started.seat.baselineDigest, null);
    const rejoin = await svc.startLogin(account);
    assert.equal(rejoin.rejoined, true);
    // poll like the tick loop does until the fake login writes the file
    // 30s: the write lands ~300ms in, but node --test runs files in parallel
    // and a saturated dev box starves the tmux child (in-isolation runtime is
    // ~600ms; the 10s budget flaked the deploy gate 4× on 2026-08-19).
    const outcome = await waitFor(async () => {
      const done = await svc.pollLoginSeats();
      return done[0] ?? null;
    }, "login captured", 90_000, 100);
    assert.equal(outcome.accountId, account.id);
    assert.equal(outcome.detectedBy, "mtime");
    assert.deepEqual(outcome.captured, ["auth.json", "config.toml"]);
    assert.equal(readFileSync(join(r.vault, "codex", "codex-x", "auth.json"), "utf8"), '{"tokens":"fresh"}');
    const after = r.store.getAccount(account.id)!;
    assert.equal(after.status, "ok", "login is contrary evidence for auth_needed");
    assert.equal(after.lastLoginAt, r.now());
    assert.equal(svc.seatOf(account.id), null, "seat torn down");
    assert.ok(r.log.some((l) => l.startsWith("account.login.captured account=codex-x by=mtime")));
  } finally {
    r.cleanup();
  }
});

test("login.2: claude — the Keychain item is the authoritative credential: digest drift via the injected reader → the vault's .credentials.json is the keychain JSON; a paused account stays paused", { skip: !tmuxAvailable && "tmux not installed" }, async () => {
  const r = rig({
    agents: {
      // the fake login writes NOTHING claude reads (a real login lands in the Keychain); it idles like the
      // TUI does while the operator completes /login, then exits
      claude: { command: process.execPath, args: [], adapter: "claude", login: { command: process.execPath, args: [FAKE_LOGIN_PATH] }, env: { FAKE_LOGIN_HOME_ENV: "CLAUDE_CONFIG_DIR", FAKE_LOGIN_FILE: ".claude.json", FAKE_LOGIN_DELAY_MS: "8000", FAKE_LOGIN_CONTENT: "{}" } },
    },
  });
  try {
    let keychain: string | null = JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: 1 } });
    const reads: string[] = [];
    const svc = service(r, { keychainReader: async (home) => { reads.push(home); return keychain; } });
    const account = r.store.createAccount({ id: "claude-k", harness: "claude", homePath: join(r.homes, "claude-k"), label: "k", status: "paused" });
    const started = await svc.startLogin(account);
    assert.ok(started.seat.baselineDigest, "keychain baseline recorded");
    assert.equal(reads[0], account.homePath);
    // nothing changed yet (only .claude.json, a supporting file — never the gate)
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual(await svc.pollLoginSeats(), []);
    // the operator completes /login: claude writes the Keychain item
    keychain = JSON.stringify({ claudeAiOauth: { accessToken: "new", expiresAt: 999, refreshToken: "r" } });
    const outcome = await waitFor(async () => (await svc.pollLoginSeats())[0] ?? null, "digest drift detected", 5000, 100);
    assert.equal(outcome.detectedBy, "digest");
    assert.ok(outcome.captured.includes(".credentials.json"));
    assert.equal(readFileSync(join(r.vault, "claude", "claude-k", ".credentials.json"), "utf8"), keychain);
    assert.equal(r.store.getAccount("claude-k")?.status, "paused", "a login never un-pauses");
    assert.equal(r.store.getAccount("claude-k")?.lastLoginAt, r.now());
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// importer + backfill
// ---------------------------------------------------------------------------

function fixtureRoot(dir: string): string {
  const root = join(dir, "old-hive");
  mkdirSync(join(root, "vault", "claude", "claude-tormod-thto.no"), { recursive: true });
  mkdirSync(join(root, "vault", "codex", "codex-tormod-thto.no"), { recursive: true });
  mkdirSync(join(root, "vault", "grok", "grok-x"), { recursive: true });
  mkdirSync(join(root, "homes", "claude-tormod-thto.no"), { recursive: true });
  mkdirSync(join(root, "homes", "codex-tormod-thto.no"), { recursive: true });
  writeFileSync(join(root, "vault", "claude", "claude-tormod-thto.no", ".credentials.json"), "{}");
  writeFileSync(join(root, "vault", "codex", "codex-tormod-thto.no", "auth.json"), "{}");
  writeFileSync(join(root, "homes", "codex-tormod-thto.no", "auth.json"), "{}");
  writeFileSync(
    join(root, "vault", "accounts.json"),
    JSON.stringify([
      { id: "claude-tormod-thto.no", tool: "claude", label: "tormod@thto.no", email: "tormod@thto.no", addedAt: "2026-06-10T07:21:45.119Z", provider: "anthropic", autoPickPenalty: 25 },
      { id: "codex-tormod-thto.no", tool: "codex", label: "tormod@thto.no", addedAt: "2026-06-10T07:21:45.123Z", provider: "openai", pausedAt: "2026-07-01T00:00:00Z" },
      { id: "grok-x", tool: "grok", label: "x", addedAt: "2026-06-16T10:29:20.174Z" },
      { id: "kimi-default", tool: "kimi", label: "default", addedAt: "2026-06-16T10:29:20.802Z" },
      { tool: "broken" },
    ]),
  );
  return root;
}

test("import.1: the old registry → rows (dry-run plans, real applies, re-run skips); the operator's ids/penalty/pause/addedAt come across; env-only bees backfill by home path", () => {
  const r = rig();
  try {
    const svc = service(r);
    const root = fixtureRoot(r.dir);
    const dry = svc.importRegistry(root, { dryRun: true });
    assert.equal(dry.applied, false);
    assert.equal(dry.counts.import, 4);
    assert.equal(dry.counts.skip, 1);
    assert.deepEqual(dry.byHarness, { claude: { import: 1, skip: 0 }, codex: { import: 1, skip: 0 }, grok: { import: 1, skip: 0 }, kimi: { import: 1, skip: 0 } });
    assert.equal(r.store.listAccounts().length, 0, "dry-run writes nothing");
    const claudeEntry = dry.entries.find((e) => e.id === "claude-tormod-thto.no")!;
    assert.equal(claudeEntry.vaultHasCredentials, true);
    assert.equal(claudeEntry.homeExists, true);
    assert.equal(claudeEntry.homeHasCredentials, false);
    assert.equal(claudeEntry.penalty, 25);
    assert.equal(claudeEntry.homePath, join(root, "homes", "claude-tormod-thto.no"));
    const codexEntry = dry.entries.find((e) => e.id === "codex-tormod-thto.no")!;
    assert.equal(codexEntry.status, "paused");
    assert.equal(codexEntry.homeHasCredentials, true);
    // an env-only imported bee whose home is the codex account's home
    const { bee } = r.store.createBee({ name: "old", agent: "codex", substrate: "hsr", cwd: "/tmp", env: { CODEX_HOME: join(root, "homes", "codex-tormod-thto.no") }, importedFrom: "frozen" });
    const { bee: other } = r.store.createBee({ name: "elsewhere", agent: "codex", substrate: "hsr", cwd: "/tmp", env: { CODEX_HOME: "/nowhere" } });
    const real = svc.importRegistry(root);
    assert.equal(real.applied, true);
    assert.equal(real.counts.import, 4);
    const claude = r.store.getAccount("claude-tormod-thto.no")!;
    assert.equal(claude.penalty, 25);
    assert.equal(claude.addedAt, Date.parse("2026-06-10T07:21:45.119Z"));
    assert.equal(claude.label, "tormod@thto.no");
    assert.equal(r.store.getAccount("codex-tormod-thto.no")?.status, "paused");
    assert.equal(r.store.getAccount("kimi-default")?.harness, "kimi");
    const again = svc.importRegistry(root);
    assert.equal(again.counts.import, 0);
    assert.equal(again.counts.skip, 5);
    assert.ok(again.entries.every((e) => e.action === "skip"));
    // backfill
    const plan = svc.backfillBeeAccounts({ dryRun: true });
    assert.deepEqual(plan.bound.map((b) => [b.beeId, b.account]), [[bee.id, "codex-tormod-thto.no"]]);
    assert.deepEqual(plan.unmatched.map((u) => u.beeId), [other.id]);
    assert.equal(r.store.getBee(bee.id)?.account, null);
    svc.backfillBeeAccounts();
    assert.equal(r.store.getBee(bee.id)?.account, "codex-tormod-thto.no");
    assert.deepEqual(svc.backfillBeeAccounts().bound, [], "idempotent");
    // refusals
    assert.match(svc.importRegistry(join(r.dir, "nope"), { dryRun: true }).refusal ?? "", /no old registry/);
  } finally {
    r.cleanup();
  }
});

const realHive = join(homedir(), ".hive");
const realRegistry = join(realHive, "vault", "accounts.json");

test("import.2 (READ-ONLY): a dry-run of the importer against the REAL ~/.hive plans the operator's accounts without writing anything", { skip: !existsSync(realRegistry) && "no ~/.hive/vault/accounts.json on this machine" }, () => {
  const r = rig();
  try {
    const svc = service(r);
    const before = statSync(realRegistry).mtimeMs;
    const report = svc.importRegistry(realHive, { dryRun: true });
    assert.equal(report.applied, false);
    assert.equal(report.refusal, undefined);
    assert.ok(report.counts.import >= 1);
    assert.equal(statSync(realRegistry).mtimeMs, before, "the old registry was not touched");
    assert.equal(r.store.listAccounts().length, 0, "dry-run wrote no rows");
    // Print the census for the report (stderr, so `--test-reporter` output stays clean).
    process.stderr.write(`\n[import.2] REAL ~/.hive dry-run: ${JSON.stringify({ counts: report.counts, byHarness: report.byHarness, entries: report.entries.map((e) => ({ id: e.id, vault: e.vaultHasCredentials, home: e.homeExists, homeCreds: e.homeHasCredentials, status: e.status, penalty: e.penalty })) })}\n`);
  } finally {
    r.cleanup();
  }
});
