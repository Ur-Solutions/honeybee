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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService, defaultCodexRateLimits } from "../src/accountsService.ts";
import { activateHomeIfEmpty } from "../src/activation.ts";
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

test("limits.0: the real Codex app-server transport returns typed success and authentication failures", async () => {
  const r = rig();
  try {
    // This smoke includes a real process spawn. Keep its test budget above
    // the production-path timing assertions exercised with injected clocks;
    // loaded developer/CI hosts routinely need more than the 750 ms RPC
    // slice produced by a 1 s aggregate timeout.
    const smokeTimeoutMs = 5_000;
    const stub = join(r.dir, "codex-stub");
    const writeStub = (messages: unknown[]) => {
      writeFileSync(stub, [
        "#!/usr/bin/env node",
        `for (const message of ${JSON.stringify(messages)}) process.stdout.write(JSON.stringify(message) + "\\n");`,
        "setInterval(() => undefined, 1000);",
      ].join("\n"));
      chmodSync(stub, 0o700);
    };
    const home = join(r.homes, "codex-transport");
    writeStub([
      { id: 1, result: {} },
      { id: 2, result: { rateLimits: { primary: { usedPercent: 9, windowDurationMins: 300 } } } },
    ]);
    assert.deepEqual(await defaultCodexRateLimits(smokeTimeoutMs, stub)(home), {
      ok: true,
      limits: { primary: { usedPercent: 9, windowDurationMins: 300 } },
    });

    writeStub([{ id: 1, error: { code: 401, message: "Unauthorized credential" } }]);
    const failed = await defaultCodexRateLimits(smokeTimeoutMs, stub)(home);
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.unreadableReason, "auth_failed");
      assert.match(failed.error, /Unauthorized/);
    }
  } finally {
    r.cleanup();
  }
});

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
          return { ok: true, limits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 55, windowDurationMins: 10_080 }, planType: "pro" } };
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
    // A transient transport error is not an auth failure and cannot erase the
    // readable snapshot that the selector and mirror already have.
    claudeFail = "fetch failed";
    const lastGood = r.store.getAccountLimits(claude.id)!;
    await svc.refreshLimits([claude.id]);
    assert.equal(r.store.getAccount(claude.id)?.status, "ok");
    assert.deepEqual(r.store.getAccountLimits(claude.id), lastGood);
    assert.ok(r.log.some((line) => line.includes(`account.limits.transient_failure account=${claude.id}`)));
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

test("limits.agy: an imported HOME-scoped token clears auth_needed while provider limits remain unsupported", async () => {
  const r = rig();
  try {
    const svc = service(r);
    const tokenFile = ".gemini/antigravity-cli/antigravity-oauth-token";
    const account = addAccount(r, "agy", "personal", { status: "auth_needed", vault: { [tokenFile]: "agy-oauth-token" } });
    assert.deepEqual(svc.homeEnvOf(account), {
      HOME: account.homePath,
      SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 1",
    });
    assert.equal(svc.hasCredentialProbe("agy"), true);
    assert.equal(svc.credentialProbeOf("agy"), "credential_file");
    assert.equal(svc.credentialed(account), true);
    assert.equal(svc.credentialHealthOf(account), "unverified");
    assert.equal(r.store.getAccount(account.id)?.status, "auth_needed");

    const [unsupported] = await svc.refreshLimits([account.id]);
    assert.equal(unsupported?.readable, false);
    assert.equal(unsupported?.unreadableReason, "unsupported");
    assert.equal(unsupported?.error, "agy has no limits source");
    assert.equal(r.store.getAccount(account.id)?.status, "ok");
    const refreshedAccount = r.store.getAccount(account.id);
    assert.ok(refreshedAccount);
    assert.equal(svc.credentialHealthOf(refreshedAccount), "unverified");
    assert.ok(r.log.some((line) => line === `account.auth_ok account=${account.id} by=credential_probe`));

    const present = await svc.verifyCredentials(refreshedAccount);
    assert.equal(present.outcome, "unverified");
    assert.equal(present.probe, "credential_file");
    assert.equal(present.limits, null, "a credential-file check does not return provider limits");
    assert.equal(r.store.getAccountLimits(account.id)?.unreadableReason, "unsupported", "usage keeps the accepted unsupported-limits row");

    rmSync(join(r.vault, "agy", account.id, tokenFile));
    const missing = await svc.verifyCredentials(present.account);
    assert.equal(missing.outcome, "absent");
    assert.equal(missing.probe, "credential_file");
    assert.equal(missing.limits, null);
    assert.equal(svc.credentialed(account), false);
    assert.equal(missing.account.status, "auth_needed");
    assert.equal(r.store.getAccount(account.id)?.status, "auth_needed");
  } finally {
    r.cleanup();
  }
});

test("limits.1a: Codex probes are per-home single-flight; transient failure keeps the last good row while auth failure invalidates it", async () => {
  const r = rig();
  try {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const account = addAccount(r, "codex", "single");
    const svc = service(r, {
      fetchers: {
        codexRateLimits: async () => {
          calls += 1;
          await gate;
          return { ok: true, limits: { primary: { usedPercent: 14, windowDurationMins: 300 }, secondary: { usedPercent: 22, windowDurationMins: 10_080 } } };
        },
      },
    });
    const first = svc.refreshLimits([account.id]);
    const second = svc.refreshLimits([account.id]);
    await waitFor(() => (calls === 1 ? true : null), "single Codex probe started");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(a[0]?.weeklyPct, 22);
    assert.equal(b[0]?.weeklyPct, 22);

    const lastGood = r.store.getAccountLimits(account.id)!;
    const transientSvc = service(r, {
      fetchers: {
        codexRateLimits: async () => ({ ok: false, unreadableReason: "timeout", error: "probe timed out" }),
      },
    });
    const [preserved] = await transientSvc.refreshLimits([account.id]);
    assert.deepEqual(preserved, lastGood);
    assert.deepEqual(r.store.getAccountLimits(account.id), lastGood);
    assert.equal(r.store.getAccount(account.id)?.status, "ok");

    const authSvc = service(r, {
      fetchers: {
        codexRateLimits: async () => ({ ok: false, unreadableReason: "auth_failed", error: "Unauthorized" }),
      },
    });
    const [invalidated] = await authSvc.refreshLimits([account.id]);
    assert.equal(invalidated?.readable, false);
    assert.equal(invalidated?.weeklyPct, null);
    assert.equal(invalidated?.unreadableReason, "auth_failed");
    assert.equal(r.store.getAccount(account.id)?.status, "auth_needed");
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

test("limits.2: freshness policy schedules stale candidates off the caller path, deduplicates the lane, and skips fresh/lone candidates", async () => {
  const r = rig({ accounts: { limitsStaleMs: HOUR } });
  try {
    const fetched: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let gated = true;
    const svc = service(r, {
      fetchers: {
        codexRateLimits: async (home) => {
          fetched.push(home);
          if (gated) await firstGate;
          return { ok: true, limits: { primary: { usedPercent: home.endsWith("-a") ? 50 : 10, windowDurationMins: 300 }, secondary: { usedPercent: home.endsWith("-a") ? 50 : 10, windowDurationMins: 10_080 } } };
        },
      },
    });
    const a = addAccount(r, "codex", "a", { addedAt: 1 });
    // one candidate: no fetch at all
    assert.deepEqual(svc.scheduleFreshLimits("codex").scheduled, []);
    assert.deepEqual(fetched, []);
    const b = addAccount(r, "codex", "b", { addedAt: 2 });
    // Two candidates, no rows: scheduling returns before the gated transport,
    // and a burst joins the same background batch.
    const first = svc.scheduleFreshLimits("codex");
    assert.deepEqual(first.scheduled.sort(), [a.id, b.id]);
    assert.deepEqual(svc.scheduleFreshLimits("codex").scheduled.sort(), [a.id, b.id]);
    await waitFor(() => (fetched.length === 1 ? true : null), "detached Codex refresh started");
    assert.equal(r.store.getAccountLimits(a.id), null, "schedule did not await the provider");
    gated = false;
    releaseFirst();
    await waitFor(() => (fetched.length === 2 && r.store.getAccountLimits(b.id) ? true : null), "background refresh completed");
    assert.equal(fetched.length, 2);
    // 2 minutes later: fresh, nothing refetched; the pick rides the rows
    r.setNow(r.now() + 2 * 60_000);
    assert.deepEqual(svc.scheduleFreshLimits("codex").scheduled, []);
    assert.equal(fetched.length, 2);
    const pick = svc.pick("codex");
    assert.ok(pick.ok);
    assert.equal(pick.account.id, b.id);
    assert.equal(pick.stale, false);
    // 61 minutes later: stale → queued and refreshed in the background.
    r.setNow(r.now() + 61 * 60_000);
    const again = svc.scheduleFreshLimits("codex");
    assert.deepEqual(again.scheduled.sort(), [a.id, b.id]);
    await waitFor(() => (fetched.length === 4 ? true : null), "stale background refresh completed");
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
          return new Promise(() => {}); // never answers: the service timeout bounds it
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
    // an empty vault + empty home: nothing to activate (a login flow is the way in)
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

// ---------------------------------------------------------------------------
// credential health (F2): validation evidence, never file-existence
// ---------------------------------------------------------------------------

test("health.1: credentialHealthOf — absent without a primary credential; a file alone is unverified; login or a readable limits probe verify", () => {
  const r = rig();
  try {
    const svc = service(r);

    // No vault, no home: absent.
    const bare = r.store.createAccount({ id: "codex-bare", harness: "codex", homePath: join(r.homes, "codex-bare"), label: "bare" });
    assert.equal(svc.credentialHealthOf(bare), "absent");

    // A credential FILE (vault or home) with zero validation evidence: unverified.
    const filed = addAccount(r, "codex", "filed");
    assert.equal(svc.credentialHealthOf(filed), "unverified");

    // A recorded login (login flow / explicit capture) is validation evidence.
    const login = r.store.recordAccountLogin(filed.id).account;
    assert.equal(svc.credentialHealthOf(login), "verified");

    // A readable limits probe is validation evidence too (probe == auth check).
    const probed = addAccount(r, "codex", "probed");
    assert.equal(svc.credentialHealthOf(probed), "unverified");
    limitsRow(r, probed.id, 10, 5, r.now() + 3 * HOUR);
    assert.equal(svc.credentialHealthOf(probed), "verified");

    // An UNREADABLE limits row proves nothing: still unverified.
    const failed = addAccount(r, "codex", "failed");
    r.store.putAccountLimits(failed.id, { readable: false, unreadableReason: "auth_failed", error: "401" });
    assert.equal(svc.credentialHealthOf(failed), "unverified");
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// v18 — honest credentials: import from the machine's vendor home, status
// that never claims ok without a credential, the real probe as verification
// ---------------------------------------------------------------------------

const CODEX_AUTH = '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"i","access_token":"a","refresh_token":"r","account_id":"acc"},"last_refresh":"2026-04-01T00:00:00Z"}';

function fakeMachine(r: Rig): { home: string; env: Record<string, string | undefined> } {
  const home = join(r.dir, "machine-home");
  mkdirSync(home, { recursive: true });
  return { home, env: {} };
}

function writeAt(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

test("import.v18.1: importExisting copies the vendor home's credential (+ config) into the vault — the home env var when set, else the recipe default under $HOME; nothing anywhere is a typed refusal listing every path checked", async () => {
  const r = rig();
  try {
    const svc = service(r, { keychainReader: async () => null, cursorAuthReader: async () => null });
    const machine = fakeMachine(r);
    const target = { harness: "codex", id: "codex-w", homePath: join(r.homes, "codex-w") };

    // Nothing anywhere: refusal, and the caller sees exactly what was checked (account home, vault, vendor home).
    const nothing = await svc.importExistingCredentials(target, { env: machine.env, home: machine.home });
    assert.equal(nothing.ok, false);
    assert.deepEqual(nothing.checked, [
      { path: join(target.homePath, "auth.json"), state: "missing" },
      { path: join(r.vault, "codex", "codex-w", "auth.json"), state: "missing" },
      { path: join(machine.home, ".codex", "auth.json"), state: "missing" },
    ]);
    assert.equal(existsSync(join(r.vault, "codex", "codex-w")), false, "a refusal writes nothing");

    // The field finding: ~/.codex/auth.json (real shape, stale April session) with CODEX_HOME unset.
    writeAt(join(machine.home, ".codex", "auth.json"), CODEX_AUTH);
    writeAt(join(machine.home, ".codex", "config.toml"), 'model = "gpt-5.6"\n');
    const imported = await svc.importExistingCredentials(target, { env: machine.env, home: machine.home });
    assert.ok(imported.ok);
    assert.equal(imported.source, "vendor_home");
    assert.equal(imported.from, join(machine.home, ".codex"));
    assert.deepEqual(imported.files, ["auth.json", "config.toml"]);
    assert.equal(readFileSync(join(r.vault, "codex", "codex-w", "auth.json"), "utf8"), CODEX_AUTH);
    assert.equal(readFileSync(join(r.vault, "codex", "codex-w", "config.toml"), "utf8"), 'model = "gpt-5.6"\n');
    assert.equal(existsSync(target.homePath), false, "the account home is never written by an import (activation does that at spawn)");
    // The row it seeds: a credential exists but nothing validated it → unverified; status ok is honest (contrary evidence flips it).
    const row = r.store.createAccount({ ...target, label: "w", status: svc.honestStatus(target, "ok") });
    assert.equal(row.status, "ok");
    assert.equal(svc.credentialHealthOf(row), "unverified");
    assert.equal(row.lastLoginAt, null, "an import is not a login");

    // A leftover vault entry is found FIRST on a second import for the same id (no vendor read needed).
    const again = await svc.importExistingCredentials(target, { env: {}, home: join(r.dir, "nowhere") });
    assert.ok(again.ok);
    assert.equal(again.source, "vault");

    // The home env var wins over the default dir; a blank value is unset.
    const envHome = join(r.dir, "codex-env-home");
    writeAt(join(envHome, "auth.json"), '{"tokens":{"access_token":"env"}}');
    const viaEnv = await svc.importExistingCredentials({ harness: "codex", id: "codex-e", homePath: join(r.homes, "codex-e") }, { env: { CODEX_HOME: envHome }, home: machine.home });
    assert.ok(viaEnv.ok);
    assert.equal(viaEnv.source, "vendor_home");
    assert.equal(viaEnv.from, envHome);
    assert.deepEqual(viaEnv.files, ["auth.json"]);
    assert.equal(readFileSync(join(r.vault, "codex", "codex-e", "auth.json"), "utf8"), '{"tokens":{"access_token":"env"}}');

    // An unparsable primary is `invalid`, never adopted.
    const badHome = join(r.dir, "codex-bad");
    writeAt(join(badHome, "auth.json"), "not json");
    const bad = await svc.importExistingCredentials({ harness: "codex", id: "codex-bad", homePath: join(r.homes, "codex-bad") }, { env: { CODEX_HOME: badHome }, home: machine.home });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.checked.at(-1), { path: join(badHome, "auth.json"), state: "invalid" });

    // The account's own home (a machine home handed in as homePath) is adopted first and captured into the vault.
    const handedIn = join(r.dir, "handed-in");
    writeAt(join(handedIn, "auth.json"), '{"tokens":{"access_token":"home"}}');
    const fromHome = await svc.importExistingCredentials({ harness: "codex", id: "codex-h", homePath: handedIn }, { env: {}, home: machine.home });
    assert.ok(fromHome.ok);
    assert.equal(fromHome.source, "home");
    assert.deepEqual(fromHome.files, ["auth.json"]);
    assert.equal(readFileSync(join(r.vault, "codex", "codex-h", "auth.json"), "utf8"), '{"tokens":{"access_token":"home"}}');

    // No recipe: nothing to import (the home is the account).
    const stub = await svc.importExistingCredentials({ harness: "stub", id: "stub-x", homePath: join(r.homes, "stub-x") }, { env: {}, home: machine.home });
    assert.equal(stub.ok, false);
    assert.deepEqual(stub.checked, []);
  } finally {
    r.cleanup();
  }
});

test("import.v18.2: relocated vendor files — Claude's ~/.claude.json + Keychain item (external), opencode's XDG data store — land under the recipe's vault layout", async () => {
  const r = rig();
  try {
    const machine = fakeMachine(r);
    const keychainReads: string[] = [];
    const claudeCred = JSON.stringify({ claudeAiOauth: { accessToken: "kc", refreshToken: "rk", expiresAt: r.now() + HOUR } });
    const svc = service(r, {
      keychainReader: async (home) => {
        keychainReads.push(home);
        return home === join(machine.home, ".claude") ? claudeCred : null;
      },
      cursorAuthReader: async () => null,
    });
    // macOS shape: no .credentials.json file; ~/.claude.json at $HOME; settings under ~/.claude.
    writeAt(join(machine.home, ".claude.json"), '{"projects":{}}');
    writeAt(join(machine.home, ".claude", "settings.json"), '{"model":"opus"}');
    const claude = await svc.importExistingCredentials({ harness: "claude", id: "claude-m", homePath: join(r.homes, "claude-m") }, { env: {}, home: machine.home });
    assert.ok(claude.ok);
    assert.equal(claude.source, "external");
    assert.equal(claude.from, `keychain:${join(machine.home, ".claude")}`);
    assert.deepEqual(claude.files, [".credentials.json", ".claude.json", "settings.json"]);
    assert.deepEqual(keychainReads, [join(machine.home, ".claude")]);
    assert.equal(readFileSync(join(r.vault, "claude", "claude-m", ".credentials.json"), "utf8"), claudeCred);
    assert.equal(readFileSync(join(r.vault, "claude", "claude-m", ".claude.json"), "utf8"), '{"projects":{}}');
    assert.deepEqual(claude.checked.map((c) => c.state), ["missing", "missing", "missing", "present"]);
    // A Keychain item that is not a credential document is `invalid`, and the import refuses.
    const svc2 = service(r, { keychainReader: async () => '{"nope":true}', cursorAuthReader: async () => null });
    const refused = await svc2.importExistingCredentials({ harness: "claude", id: "claude-n", homePath: join(r.homes, "claude-n") }, { env: {}, home: machine.home });
    assert.equal(refused.ok, false);
    assert.equal(refused.checked.at(-1)?.state, "invalid");
    // opencode: XDG_DATA_HOME relocates the auth store; the vault keeps the account-home layout.
    const xdg = join(r.dir, "xdg-data");
    writeAt(join(xdg, "opencode", "auth.json"), '{"anthropic":{"type":"api","key":"k"}}');
    const oc = await svc.importExistingCredentials({ harness: "opencode", id: "opencode-o", homePath: join(r.homes, "opencode-o") }, { env: { XDG_DATA_HOME: xdg }, home: machine.home });
    assert.ok(oc.ok);
    assert.equal(oc.source, "vendor_home");
    assert.deepEqual(oc.files, ["xdg-data/opencode/auth.json"]);
    assert.equal(readFileSync(join(r.vault, "opencode", "opencode-o", "xdg-data", "opencode", "auth.json"), "utf8"), '{"anthropic":{"type":"api","key":"k"}}');
  } finally {
    r.cleanup();
  }
});

test("status.v18: honestStatus never returns ok without a credential (auth_needed instead); paused / auth_needed pass through; a recipe-less harness is always credentialed", () => {
  const r = rig();
  try {
    const svc = service(r);
    const bare = { harness: "codex", id: "codex-bare", homePath: join(r.homes, "codex-bare") };
    assert.equal(svc.honestStatus(bare, "ok"), "auth_needed");
    assert.equal(svc.honestStatus(bare, "paused"), "paused");
    assert.equal(svc.honestStatus(bare, "auth_needed"), "auth_needed");
    const filed = addAccount(r, "codex", "filed");
    assert.equal(svc.honestStatus(filed, "ok"), "ok");
    assert.equal(svc.honestStatus({ harness: "stub", id: "stub-s", homePath: join(r.homes, "stub-s") }, "ok"), "ok");
    // the pair every consumer relies on: status ok ⇒ health is never absent
    const ok = r.store.createAccount({ ...bare, label: "bare", status: svc.honestStatus(bare, "ok") });
    assert.equal(ok.status, "auth_needed");
    assert.equal(svc.credentialHealthOf(ok), "absent");
    assert.equal(svc.mirrorRow(ok).credentialHealth, "absent");
    // login success (capture / flow) flips it to ok + verified
    mkdirSync(ok.homePath, { recursive: true });
    writeFileSync(join(ok.homePath, "auth.json"), '{"tokens":{"access_token":"t"}}');
    const login = r.store.recordAccountLogin(ok.id).account;
    assert.equal(login.status, "ok");
    assert.equal(svc.mirrorRow(login).credentialHealth, "verified");
  } finally {
    r.cleanup();
  }
});

test("verify.v18: the real limits probe settles an import — readable → verified (and the row is re-published for the mirror), auth failure → auth_needed; no probe → unverified; nothing → absent; a Codex probe activates the EMPTY home from the vault first", async () => {
  const r = rig();
  try {
    let answer: "ok" | "auth" = "ok";
    const probed: string[] = [];
    const svc = service(r, {
      fetchers: {
        codexRateLimits: async (home) => {
          probed.push(home);
          if (answer === "auth") return { ok: false, unreadableReason: "auth_failed", error: "401 Unauthorized" };
          return { ok: true, limits: { primary: { usedPercent: 3, windowDurationMins: 300 }, secondary: { usedPercent: 9, windowDurationMins: 10_080 } } };
        },
      },
      keychainReader: async () => null,
    });
    // imported (vault only, empty home), status ok, unverified
    const imported = addAccount(r, "codex", "imp", { vault: { "auth.json": CODEX_AUTH } });
    assert.equal(svc.credentialHealthOf(imported), "unverified");
    const seqBefore = r.store.lastAuditSeq();
    const ok = await svc.verifyCredentials(imported);
    assert.equal(ok.outcome, "verified");
    assert.equal(ok.probe, "limits");
    assert.equal(ok.limits?.readable, true);
    assert.equal(ok.account.status, "ok");
    assert.equal(svc.credentialHealthOf(ok.account), "verified");
    assert.deepEqual(probed, [imported.homePath], "the probe ran against the account home");
    assert.equal(readFileSync(join(imported.homePath, "auth.json"), "utf8"), CODEX_AUTH, "the empty home was activated from the vault so codex app-server could see the credential");
    assert.ok(r.log.some((l) => l.startsWith(`account.activate account=${imported.id}`) && l.endsWith("by=limits_probe")));
    // the mirror learns: a status-neutral verification still re-publishes the account row
    const puts = r.store.auditRows(seqBefore).filter((row) => row.kind === "account.put");
    assert.equal(puts.length, 1);
    assert.equal(puts[0]?.payload.reason, "credential health unverified → verified by limits probe");
    assert.ok(r.log.includes(`account.credential_health account=${imported.id} unverified→verified by=limits_probe`));
    // a second, identical probe changes nothing and re-publishes nothing
    const seqMid = r.store.lastAuditSeq();
    assert.equal((await svc.verifyCredentials(ok.account)).outcome, "verified");
    assert.equal(r.store.auditRows(seqMid).filter((row) => row.kind === "account.put").length, 0);

    // a stale session: the provider refuses → auth_needed with the typed reason on the limits row
    answer = "auth";
    const stale = addAccount(r, "codex", "stale", { vault: { "auth.json": CODEX_AUTH } });
    const bad = await svc.verifyCredentials(stale);
    assert.equal(bad.outcome, "auth_needed");
    assert.equal(bad.account.status, "auth_needed");
    assert.equal(bad.limits?.unreadableReason, "auth_failed");
    assert.equal(svc.credentialHealthOf(bad.account), "unverified", "a failed probe is no validation evidence");

    // no probe for the harness: honest `unverified`, probe none
    const stub = r.store.createAccount({ id: "stub-s", harness: "stub", homePath: join(r.homes, "stub-s"), label: "s" });
    assert.deepEqual(await svc.verifyCredentials(stub), { account: stub, outcome: "unverified", probe: "none", limits: null });
    assert.equal(svc.hasCredentialProbe("stub"), false);
    // nothing to verify
    const bare = r.store.createAccount({ id: "codex-bare", harness: "codex", homePath: join(r.homes, "codex-bare"), label: "bare" });
    const absent = await svc.verifyCredentials(bare);
    assert.equal(absent.outcome, "absent");
    assert.equal(absent.account.status, "auth_needed");
    assert.equal(r.store.getAccount(bare.id)?.status, "auth_needed");

    // background scheduling: only probe-capable accounts are queued; the outcome lands on the row
    answer = "ok";
    const later = addAccount(r, "codex", "later", { vault: { "auth.json": CODEX_AUTH } });
    assert.deepEqual(svc.scheduleVerification([later.id, stub.id, "nope"]), [later.id]);
    await waitFor(() => (svc.credentialHealthOf(r.store.getAccount(later.id)!) === "verified" ? true : null), "background verification landed");
    // a populated home is left alone by the probe's activation rule
    const populated = addAccount(r, "codex", "pop", { vault: { "auth.json": CODEX_AUTH } });
    mkdirSync(populated.homePath, { recursive: true });
    writeFileSync(join(populated.homePath, "auth.json"), '{"tokens":{"access_token":"home-owned"}}');
    await svc.verifyCredentials(populated);
    assert.equal(readFileSync(join(populated.homePath, "auth.json"), "utf8"), '{"tokens":{"access_token":"home-owned"}}');
    assert.equal(activateHomeIfEmpty("codex", populated.homePath, join(r.vault, "codex", populated.id)).reason, "home_populated");
  } finally {
    r.cleanup();
  }
});

test("import.v18.3: the old-registry importer creates a credential-less record as auth_needed, never as a usable-looking ok row", () => {
  const r = rig();
  try {
    const svc = service(r);
    const root = join(r.dir, "old-hive");
    mkdirSync(join(root, "vault", "codex", "codex-creds"), { recursive: true });
    writeFileSync(join(root, "vault", "codex", "codex-creds", "auth.json"), CODEX_AUTH);
    writeFileSync(join(root, "vault", "accounts.json"), JSON.stringify([
      { id: "codex-creds", tool: "codex", label: "creds", addedAt: "2026-06-10T07:21:45.119Z" },
      { id: "codex-empty", tool: "codex", label: "empty", addedAt: "2026-06-10T07:21:45.119Z" },
      { id: "codex-parked", tool: "codex", label: "parked", addedAt: "2026-06-10T07:21:45.119Z", pausedAt: "2026-06-11T00:00:00Z" },
    ]));
    const report = svc.importRegistry(root);
    assert.deepEqual(report.entries.map((e) => [e.id, e.status]), [["codex-creds", "ok"], ["codex-empty", "auth_needed"], ["codex-parked", "paused"]]);
    assert.equal(r.store.getAccount("codex-empty")?.status, "auth_needed");
    assert.equal(r.store.getAccount("codex-creds")?.status, "ok");
    assert.equal(svc.credentialHealthOf(r.store.getAccount("codex-empty")!), "absent");
  } finally {
    r.cleanup();
  }
});
