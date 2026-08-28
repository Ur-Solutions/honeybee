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
 *  - explicit recovery capture accepts the already-valid current credential
 *    without freshness drift (the login FLOW lives in login-flows.test.ts)
 *  - importer: the old registry layout → rows (dry-run + real, idempotent);
 *    env-only bee backfill by home path
 * SAFETY: temp dirs only. The one read of the REAL ~/.hive is a dry-run of
 * the importer (read-only; asserted by mtime) and is skipped when absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig, type NodeConfigFile, type ResolvedNodeConfig } from "../src/config.ts";
import { recipeFingerprint } from "../src/activation.ts";
import { parseCursorAuth } from "../src/cursorAuth.ts";
import { waitFor } from "./helpers.ts";

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
  const store = openCoreStore(join(dir, "core.sqlite3"), { now, ephemeral: true });
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

test("select.6: rr cycles in registration order, skips auth failures, and does not disturb auto's near-tie cursor", () => {
  const r = rig();
  try {
    const svc = service(r);
    const a = addAccount(r, "claude", "a", { addedAt: 1 });
    const bad = addAccount(r, "claude", "bad", { addedAt: 2, status: "auth_needed" });
    const c = addAccount(r, "claude", "c", { addedAt: 3 });
    r.store.setSelectionCursor("claude", a.id);

    const picks = [svc.pickRoundRobin("claude"), svc.pickRoundRobin("claude"), svc.pickRoundRobin("claude")];
    assert.ok(picks.every((pick) => pick.ok));
    assert.deepEqual(picks.map((pick) => pick.ok ? pick.account.id : null), [a.id, c.id, a.id]);
    assert.match(picks[0]!.reason, /skipped 1 account\(s\) for recent auth failure/);
    assert.equal(r.store.getSelectionCursor("rr:claude")?.lastAccountId, a.id);
    assert.equal(r.store.getSelectionCursor("claude")?.lastAccountId, a.id, "rr has a separate cursor from auto near-ties");
    assert.ok(r.log.some((line) => line.startsWith("account rr → claude-a")));

    r.store.setAccountStatus(bad.id, "ok");
    const restored = [svc.pickRoundRobin("claude"), svc.pickRoundRobin("claude"), svc.pickRoundRobin("claude")];
    assert.deepEqual(restored.map((pick) => pick.ok ? pick.account.id : null), [bad.id, c.id, a.id]);
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
    assert.equal(g.unreadableReason, "auth_expired");
    assert.match(g.error ?? "", /no Grok OAuth credential/);
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
    assert.equal(r.store.getAccountLimits(claude.id)?.unreadableReason, "auth_expired");
    assert.equal(r.store.getAccount(claude.id)?.status, "ok", "expiry alone is not proof that the refresh chain is invalid");
  } finally {
    r.cleanup();
  }
});

test("limits.1b: expired Claude chains refresh once, persist home + keychain + vault, and a rejected refresh is typed auth_failed", async () => {
  const r = rig();
  try {
    let refreshCalls = 0;
    const usageCalls: string[] = [];
    const keychainWrites: string[] = [];
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const svc = service(r, {
      fetchers: {
        claudeRefresh: async (token) => {
          refreshCalls += 1;
          assert.equal(token, "old-refresh");
          await refreshGate;
          return { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: r.now() + HOUR, scopes: ["user:profile"] };
        },
        claudeUsage: async (token) => {
          usageCalls.push(token);
          return { five_hour: { utilization: 7 }, seven_day: { utilization: 19 } };
        },
      },
      keychainReader: async () => null,
      keychainWriter: async (_home, raw) => { keychainWrites.push(raw); return true; },
    });
    const account = addAccount(r, "claude", "refresh", {
      vault: { ".credentials.json": JSON.stringify({ sibling: { keep: true }, claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: r.now() - 1, subscriptionType: "max" } }) },
    });
    mkdirSync(account.homePath, { recursive: true });
    writeFileSync(join(account.homePath, ".credentials.json"), readFileSync(join(r.vault, "claude", account.id, ".credentials.json"), "utf8"));

    const first = svc.refreshLimits([account.id]);
    const second = svc.refreshLimits([account.id]);
    await waitFor(() => (refreshCalls === 1 ? true : null), "single refresh started");
    releaseRefresh();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(refreshCalls, 1, "rotating refresh token is single-flight per account");
    assert.deepEqual(usageCalls, ["new-access", "new-access"]);
    assert.equal(a[0]?.readable, true);
    assert.equal(b[0]?.unreadableReason, null);
    for (const path of [
      join(account.homePath, ".credentials.json"),
      join(r.vault, "claude", account.id, ".credentials.json"),
    ]) {
      const doc = JSON.parse(readFileSync(path, "utf8")) as { sibling?: { keep?: boolean }; claudeAiOauth?: { accessToken?: string; refreshToken?: string } };
      assert.equal(doc.sibling?.keep, true, "non-OAuth credential siblings survive rotation");
      assert.equal(doc.claudeAiOauth?.accessToken, "new-access");
      assert.equal(doc.claudeAiOauth?.refreshToken, "new-refresh");
    }
    assert.equal(keychainWrites.length, 1);
    assert.match(keychainWrites[0] ?? "", /new-refresh/);

    const live = addAccount(r, "claude", "live", {
      vault: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "live-old", refreshToken: "live-refresh", expiresAt: r.now() - 1 } }) },
    });
    const { bee } = r.store.createBee({ name: "live-owner", agent: "claude", substrate: "hsr", cwd: "/tmp", account: live.id });
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 99, pidStartedAt: 1 });
    let racedRefreshes = 0;
    const liveSvc = service(r, {
      fetchers: { claudeRefresh: async () => { racedRefreshes += 1; return null; } },
      keychainReader: async () => null,
    });
    const liveRow = (await liveSvc.refreshLimits([live.id]))[0]!;
    assert.equal(racedRefreshes, 0, "the daemon never races a live Claude runtime's rotating refresh token");
    assert.equal(liveRow.unreadableReason, "auth_expired");
    assert.match(liveRow.error ?? "", /running Claude owns refresh/);
    assert.equal(r.store.getAccount(live.id)?.status, "ok");

    const rejected = addAccount(r, "claude", "rejected", {
      vault: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "bad-access", refreshToken: "bad-refresh", expiresAt: r.now() - 1 } }) },
    });
    const rejectedSvc = service(r, {
      fetchers: { claudeRefresh: async () => null },
      keychainReader: async () => null,
    });
    const failed = (await rejectedSvc.refreshLimits([rejected.id]))[0]!;
    assert.equal(failed.readable, false);
    assert.equal(failed.unreadableReason, "auth_failed");
    assert.match(failed.error ?? "", /refresh failed/);
    assert.equal(r.store.getAccount(rejected.id)?.status, "auth_needed");
  } finally {
    r.cleanup();
  }
});

test("limits.1c: Grok, Kimi, Cursor, MiniMax, and z.ai use their real provider windows; rotating OAuth chains persist", async () => {
  const r = rig();
  try {
    const calls: string[] = [];
    const svc = service(r, {
      providerHttp: {
        postForm: async (url, _headers, form) => {
          calls.push(`form:${url}`);
          if (url.includes("auth.x.ai")) {
            assert.equal(form.client_id, "grok-client");
            assert.equal(form.refresh_token, "grok-refresh");
            return { access_token: "grok-new", refresh_token: "grok-refresh-new", expires_in: 3600 };
          }
          assert.match(url, /auth\.kimi\.com/);
          assert.equal(form.refresh_token, "kimi-refresh");
          return { access_token: "kimi-new", refresh_token: "kimi-refresh-new", expires_in: 900 };
        },
        getJson: async (url, headers) => {
          calls.push(`get:${url}`);
          if (url.includes("cli-chat-proxy.grok.com")) {
            assert.equal(headers.Authorization, "Bearer grok-new");
            return { config: { creditUsagePercent: 27, currentPeriod: { start: "2026-06-08T00:00:00Z", end: "2026-06-15T00:00:00Z" } } };
          }
          if (url.includes("api.kimi.com")) {
            assert.equal(headers.Authorization, "Bearer kimi-new");
            return {
              user: { membership: { level: "LEVEL_MAX" } },
              usage: { limit: "1000", used: "420", resetTime: "2026-06-15T00:00:00Z" },
              limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "11", resetTime: "2026-06-10T14:00:00Z" } }],
            };
          }
          if (url.includes("minimax.io")) {
            return { model_remains: [{ current_interval_total_count: 100, current_interval_usage_count: 8, end_time: r.now() + HOUR, current_weekly_total_count: 1000, current_weekly_usage_count: 90, weekly_end_time: r.now() + DAY }] };
          }
          assert.match(url, /api\.z\.ai/);
          return { data: { level: "pro", limits: [{ type: "TOKENS_LIMIT", percentage: 14, nextResetTime: r.now() + 2 * HOUR }] } };
        },
        postJson: async (url, headers) => {
          calls.push(`json:${url}`);
          assert.match(url, /api2\.cursor\.sh/);
          assert.equal(headers.Authorization, "Bearer cursor-access");
          return {
            billingCycleStart: r.now(),
            billingCycleEnd: r.now() + 30 * DAY,
            planUsage: {
              totalSpend: "125",
              limit: "1000",
              totalPercentUsed: 9,
              apiPercentUsed: 44,
            },
          };
        },
      },
    });
    const grok = addAccount(r, "grok", "g", {
      vault: { "auth.json": JSON.stringify({ issuer: { key: "grok-old", refresh_token: "grok-refresh", expires_at: new Date(r.now() - 1).toISOString(), oidc_client_id: "grok-client", sibling: true } }) },
    });
    const kimi = addAccount(r, "kimi", "k", {
      vault: { "credentials/kimi-code.json": JSON.stringify({ access_token: "kimi-old", refresh_token: "kimi-refresh", expires_at: Math.floor(r.now() / 1000) - 1, sibling: true }) },
    });
    const cursor = addAccount(r, "cursor", "c", { vault: { "auth.json": JSON.stringify({ accessToken: "cursor-access" }) } });
    const minimax = addAccount(r, "opencode", "minimax", { vault: { "xdg-data/opencode/auth.json": JSON.stringify({ "minimax-coding-plan": { type: "api", key: "mini-key" } }) } });
    const zai = addAccount(r, "opencode", "glm", { vault: { "xdg-data/opencode/auth.json": JSON.stringify({ "zai-coding-plan": { type: "api", key: "zai-key" } }) } });

    const rows = new Map((await svc.refreshLimits([grok.id, kimi.id, cursor.id, minimax.id, zai.id])).map((row) => [row.account, row]));
    assert.equal(rows.get(grok.id)?.weeklyPct, 27);
    assert.equal(rows.get(grok.id)?.weeklyMinutes, 10_080);
    assert.equal(rows.get(kimi.id)?.plan, "max");
    assert.equal(rows.get(kimi.id)?.fiveHourPct, 11);
    assert.equal(rows.get(kimi.id)?.weeklyPct, 42);
    assert.equal(rows.get(cursor.id)?.weeklyPct, 44, "routing uses the tighter explicit pool");
    assert.equal(rows.get(cursor.id)?.weeklyMinutes, 43_200);
    assert.deepEqual(rows.get(cursor.id)?.displayWindows, [
      { key: "cursor-models", label: "cursor models", usedPercent: 9, resetsAt: r.now() + 30 * DAY, windowMinutes: 43_200 },
      { key: "other-models", label: "third-party", usedPercent: 44, resetsAt: r.now() + 30 * DAY, windowMinutes: 43_200 },
    ]);
    assert.equal(rows.get(minimax.id)?.fiveHourPct, 8);
    assert.equal(rows.get(minimax.id)?.weeklyPct, 9);
    assert.equal(rows.get(zai.id)?.plan, "pro");
    assert.equal(rows.get(zai.id)?.fiveHourPct, 14);
    assert.equal(calls.length, 7);

    for (const path of [join(grok.homePath, "auth.json"), join(r.vault, "grok", grok.id, "auth.json")]) {
      const entry = (JSON.parse(readFileSync(path, "utf8")) as { issuer: { key: string; refresh_token: string; sibling: boolean } }).issuer;
      assert.equal(entry.key, "grok-new");
      assert.equal(entry.refresh_token, "grok-refresh-new");
      assert.equal(entry.sibling, true);
    }
    for (const path of [join(kimi.homePath, "credentials", "kimi-code.json"), join(r.vault, "kimi", kimi.id, "credentials", "kimi-code.json")]) {
      const credential = JSON.parse(readFileSync(path, "utf8")) as { access_token: string; refresh_token: string; sibling: boolean };
      assert.equal(credential.access_token, "kimi-new");
      assert.equal(credential.refresh_token, "kimi-refresh-new");
      assert.equal(credential.sibling, true);
    }
  } finally {
    r.cleanup();
  }
});

test("limits.1d: the daemon never races a live Grok runtime's rotating refresh token", async () => {
  const r = rig();
  try {
    let refreshCalls = 0;
    const account = addAccount(r, "grok", "live", {
      vault: { "auth.json": JSON.stringify({ issuer: { key: "old", refresh_token: "refresh", expires_at: new Date(r.now() - 1).toISOString(), oidc_client_id: "client" } }) },
    });
    const { bee } = r.store.createBee({ name: "grok-owner", agent: "grok", substrate: "hsr", cwd: "/tmp", account: account.id });
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 42, pidStartedAt: 1 });
    const svc = service(r, { providerHttp: { postForm: async () => { refreshCalls += 1; return {}; } } });
    const row = (await svc.refreshLimits([account.id]))[0]!;
    assert.equal(refreshCalls, 0);
    assert.equal(row.unreadableReason, "auth_expired");
    assert.match(row.error ?? "", /running Grok owns refresh/);
    assert.equal(r.store.getAccount(account.id)?.status, "ok");
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
// explicit capture (the login FLOW itself is covered in login-flows.test.ts)
// ---------------------------------------------------------------------------

test("capture.1: explicit recovery captures an unchanged valid Claude credential from the external store (dotted account id)", async () => {
  const r = rig();
  const current = JSON.stringify({ claudeAiOauth: { accessToken: "fresh", expiresAt: 999, refreshToken: "r" } });
  try {
    const svc = service(r, { keychainReader: async () => current });
    const account = r.store.createAccount({
      id: "claude-recovery.example",
      harness: "claude",
      homePath: join(r.homes, "claude-recovery.example"),
      label: "recovery.example",
      status: "auth_needed",
    });
    seedVault(r, "claude", account.id, {
      ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: 1 } }),
    });
    const captured = await svc.captureAccount(account);
    assert.equal(captured.source, "external");
    assert.deepEqual(captured.captured, [".credentials.json"]);
    assert.equal(readFileSync(join(r.vault, "claude", account.id, ".credentials.json"), "utf8"), current);
    assert.equal(captured.account.status, "ok");
    assert.equal(captured.account.lastLoginAt, r.now());
    assert.ok(r.log.some((line) => line === `account.capture account=${account.id} source=external files=.credentials.json`));
  } finally {
    r.cleanup();
  }
});

test("capture.2: explicit recovery refuses an invalid current credential without touching the vault or login state", async () => {
  const r = rig();
  try {
    const svc = service(r);
    const account = r.store.createAccount({ id: "codex-recovery-invalid", harness: "codex", homePath: join(r.homes, "codex-recovery-invalid"), label: "invalid", status: "auth_needed" });
    mkdirSync(account.homePath, { recursive: true });
    writeFileSync(join(account.homePath, "auth.json"), "not-json");

    await assert.rejects(() => svc.captureAccount(account), /no valid codex credential found/);
    assert.equal(existsSync(join(r.vault, "codex", account.id, "auth.json")), false);
    assert.equal(r.store.getAccount(account.id)?.status, "auth_needed");
    assert.equal(r.store.getAccount(account.id)?.lastLoginAt, null);
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
