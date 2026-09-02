/**
 * Spec 08 CLI tier: `hive v2 account list|get|add|remove|pause|unpause|penalty|
 * limits|import|backfill`, `spawn --account`, `bee swap-account`; the
 * read-only fallback for `account list` when the daemon is down. Temp dirs
 * only; the import runs against a FIXTURE old-registry root, never ~/.hive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { runV2Cli, type CliIo } from "../src/main.ts";
import { stripAnsi } from "../src/style.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(stripAnsi(l)), err: (l) => err.push(stripAnsi(l)) }, out, err };
}

test("cli.accounts.1: account verbs over RPC + spawn --account + bee swap-account (stub) + import --dry-run against a fixture root", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const base = ["--data-dir", dir];
    // add (json) — default id + home
    const add = capture();
    assert.equal(await runV2Cli(["account", "add", "stub", "one", "--penalty", "5", ...base, "--json"], add.io), 0);
    const added = JSON.parse(add.out[0] ?? "{}") as { account: { id: string; homePath: string; penalty: number } };
    assert.equal(added.account.id, "stub-one");
    assert.equal(added.account.penalty, 5);
    assert.equal(added.account.homePath, join(dir, "homes", "stub-one"));
    assert.equal(await runV2Cli(["account", "add", "stub", "two", "--home", join(dir, "h2"), ...base], capture().io), 0);
    // list (human)
    const list = capture();
    assert.equal(await runV2Cli(["account", "list", ...base], list.io), 0);
    assert.ok(list.out.some((l) => l.includes("stub-one") && l.includes("stub") && l.includes("ok") && l.includes("creds=unverified") && l.includes("penalty=5")), list.out.join("\n"));
    assert.ok(list.out.some((l) => l.includes("stub-two") && l.includes("stub") && l.includes("ok")));
    // v18: verify says what the probe proved — a recipe-less harness has none (exit 1: not verified)
    const verify = capture();
    assert.equal(await runV2Cli(["account", "verify", "stub-two", ...base], verify.io), 1);
    assert.match(verify.out[0] ?? "", /^stub-two\s+unverified\s+ok\s+probe=none\s+stub has no credential probe/);
    const verifyJson = capture();
    assert.equal(await runV2Cli(["account", "verify", "stub-two", ...base, "--json"], verifyJson.io), 1);
    assert.deepEqual((JSON.parse(verifyJson.out[0] ?? "{}") as { outcome: string; probe: string }).outcome, "unverified");
    // v18: a fresh codex add is logged OUT — the CLI says so instead of "ok"
    const fresh = capture();
    assert.equal(await runV2Cli(["account", "add", "codex", "fresh", ...base], fresh.io), 0);
    assert.match(fresh.out[0] ?? "", /status auth_needed; log in with: hive account login codex-fresh/);
    const freshList = capture();
    assert.equal(await runV2Cli(["account", "list", "--harness", "codex", ...base], freshList.io), 0);
    assert.ok(freshList.out.some((l) => l.includes("codex-fresh") && l.includes("auth_needed") && l.includes("creds=absent")), freshList.out.join("\n"));
    // agy schedules a file-presence probe, never a provider-authentication probe.
    const agyHome = join(dir, "agy-home");
    const agyToken = join(agyHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    mkdirSync(join(agyHome, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(agyToken, "agy-oauth-token");
    const agyAdd = capture();
    assert.equal(await runV2Cli(["account", "add", "agy", "personal", "--home", agyHome, "--import-existing", ...base], agyAdd.io), 0);
    assert.match(agyAdd.out[0] ?? "", /checking the required credential file/);
    const agyVerify = capture();
    assert.equal(await runV2Cli(["account", "verify", "agy-personal", ...base], agyVerify.io), 1);
    assert.match(agyVerify.out[0] ?? "", /probe=credential_file\s+the required credential file is present/);
    // pause / unpause / penalty
    const pause = capture();
    assert.equal(await runV2Cli(["account", "pause", "stub-two", ...base], pause.io), 0);
    assert.match(pause.out[0] ?? "", /paused\s+stub-two \(status paused\)/);
    const pen = capture();
    assert.equal(await runV2Cli(["account", "penalty", "stub-one", "0", ...base], pen.io), 0);
    assert.match(pen.out[0] ?? "", /set penalty for stub-one: 0/);
    // spawn --account explicit paused → typed error; auto picks the lone candidate; none → unbound
    const bad = capture();
    assert.equal(await runV2Cli(["spawn", "w", "--agent", "stub", "--cwd", dir, "--account", "stub-two", ...base], bad.io), 1);
    assert.match(bad.err[0] ?? "", /account_paused/);
    const auto = capture();
    assert.equal(await runV2Cli(["spawn", "w", "--agent", "stub", "--cwd", dir, ...base, "--json"], auto.io), 0);
    const spawned = JSON.parse(auto.out[0] ?? "{}") as { beeId: string; account: string | null; accountReason?: string };
    assert.equal(spawned.account, "stub-one");
    assert.match(spawned.accountReason ?? "", /only stub account/);
    const none = capture();
    assert.equal(await runV2Cli(["spawn", "u", "--agent", "stub", "--cwd", dir, "--account", "none", ...base, "--json"], none.io), 0);
    assert.equal((JSON.parse(none.out[0] ?? "{}") as { account: string | null }).account, null);
    // get shows the bee binding
    const get = capture();
    assert.equal(await runV2Cli(["account", "get", "stub-one", ...base, "--json"], get.io), 0);
    assert.deepEqual((JSON.parse(get.out[0] ?? "{}") as { bees: string[] }).bees, [spawned.beeId]);
    // remove refused while referenced (typed), then swap the bee away and remove
    const rm = capture();
    assert.equal(await runV2Cli(["account", "remove", "stub-one", ...base], rm.io), 1);
    assert.match(rm.err[0] ?? "", /account_referenced/);
    assert.equal(await runV2Cli(["account", "unpause", "stub-two", ...base], capture().io), 0);
    const swap = capture();
    assert.equal(await runV2Cli(["bee", "swap-account", "w", "stub-two", ...base, "--json"], swap.io), 0);
    const swapped = JSON.parse(swap.out[0] ?? "{}") as { to: string; from: string; action: string };
    assert.equal(swapped.to, "stub-two");
    assert.equal(swapped.from, "stub-one");
    const rm2 = capture();
    assert.equal(await runV2Cli(["account", "remove", "stub-one", ...base], rm2.io), 0);
    assert.match(rm2.out[0] ?? "", /removed account stub-one/);
    // limits (stub has no source → unreadable rows, still a table)
    const lim = capture();
    assert.equal(await runV2Cli(["account", "limits", ...base], lim.io), 0);
    assert.match(lim.out[0] ?? "", /stub-two\s+unreadable: stub has no limits source/);
    // import --dry-run against a fixture root (never ~/.hive)
    const root = join(dir, "old-hive");
    mkdirSync(join(root, "vault", "codex", "codex-x"), { recursive: true });
    writeFileSync(join(root, "vault", "codex", "codex-x", "auth.json"), "{}");
    writeFileSync(join(root, "vault", "accounts.json"), JSON.stringify([{ id: "codex-x", tool: "codex", label: "x", addedAt: "2026-06-10T07:21:45.119Z", autoPickPenalty: 25 }]));
    const imp = capture();
    assert.equal(await runV2Cli(["account", "import", "--root", root, "--dry-run", ...base], imp.io), 0);
    assert.match(imp.out[0] ?? "", /dry-run: would import 1 account\(s\), skip 0/);
    assert.ok(imp.out.some((l) => l.includes("+ codex-x  codex  penalty=25  vaultCreds=true homeCreds=false")), imp.out.join("\n"));
    const real = capture();
    assert.equal(await runV2Cli(["account", "import", "--root", root, ...base, "--json"], real.io), 0);
    const report = JSON.parse(real.out[0] ?? "{}") as { applied: boolean; counts: { import: number }; backfill: { bound: unknown[] } };
    assert.equal(report.applied, true);
    assert.equal(report.counts.import, 1);
    assert.deepEqual(report.backfill.bound, []);
    const bf = capture();
    assert.equal(await runV2Cli(["account", "backfill", "--dry-run", ...base], bf.io), 0);
    assert.match(bf.out[0] ?? "", /dry-run: would bind 0 bee\(s\)/);
    // usage errors
    const usage = capture();
    assert.equal(await runV2Cli(["account", "frob", ...base], usage.io), 1);
    assert.match(usage.err[0] ?? "", /usage: hive account/);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.accounts.2: `account list` falls back to the read-only store when the daemon is down — labeled stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cli-acct-"));
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createAccount({ id: "claude-a", harness: "claude", homePath: "/tmp/h", label: "a", penalty: 3 });
    store.putAccountLimits("claude-a", { readable: true, weekly: { usedPercent: 40 }, fiveHour: { usedPercent: 5 }, plan: "max" });
    store.close();
    const j = capture();
    assert.equal(await runV2Cli(["account", "list", "--data-dir", dir, "--json"], j.io), 0);
    const parsed = JSON.parse(j.out[0] ?? "{}") as { stale?: boolean; accounts: Array<{ id: string }>; limits: Array<{ weeklyPct: number }> };
    assert.equal(parsed.stale, true);
    assert.equal(parsed.accounts[0]?.id, "claude-a");
    assert.equal(parsed.limits[0]?.weeklyPct, 40);
    const h = capture();
    assert.equal(await runV2Cli(["account", "list", "--data-dir", dir], h.io), 0);
    assert.ok(h.err[0]?.startsWith("STALE"));
    // v18: the read-only store cannot derive credentialHealth (daemon-only) — shown as `?`, never guessed.
    assert.match(h.out[0] ?? "", /^stale: claude-a\s+claude\s+ok\s+creds=\?\s+\/tmp\/h\s+penalty=3\s+weekly=40%\s+5h=5%\s+plan=max$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.accounts.3: agent-auto and agent-rr collapse at the v2 CLI edge; rr advances the daemon-owned cursor", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const base = ["--data-dir", dir, "--json"];
    assert.equal(await runV2Cli(["account", "add", "stub", "one", ...base], capture().io), 0);
    assert.equal(await runV2Cli(["account", "add", "stub", "two", ...base], capture().io), 0);

    const explicit = capture();
    assert.equal(
      await runV2Cli(["spawn", "explicit", "stub-rr", "--account", "stub-two", "--cwd", dir, ...base], explicit.io),
      0,
    );
    assert.equal((JSON.parse(explicit.out[0] ?? "{}") as { account: string | null }).account, "stub-two");

    const auto = capture();
    assert.equal(await runV2Cli(["spawn", "auto", "stub-auto", "--cwd", dir, ...base], auto.io), 0);
    const autoSpawn = JSON.parse(auto.out[0] ?? "{}") as { agent: string; account: string | null };
    assert.equal(autoSpawn.agent, "stub");
    assert.ok(["stub-one", "stub-two"].includes(autoSpawn.account ?? ""));

    const first = capture();
    const second = capture();
    assert.equal(await runV2Cli(["spawn", "rr-one", "stub-rr", "--cwd", dir, ...base], first.io), 0);
    assert.equal(await runV2Cli(["spawn", "rr-two", "stub-rr", "--cwd", dir, ...base], second.io), 0);
    const firstSpawn = JSON.parse(first.out[0] ?? "{}") as { agent: string; account: string | null; accountReason?: string };
    const secondSpawn = JSON.parse(second.out[0] ?? "{}") as { agent: string; account: string | null; accountReason?: string };
    assert.equal(firstSpawn.agent, "stub");
    assert.equal(secondSpawn.agent, "stub");
    assert.deepEqual([firstSpawn.account, secondSpawn.account], ["stub-one", "stub-two"]);
    assert.match(firstSpawn.accountReason ?? "", /round-robin: first pick/);
    assert.match(secondSpawn.accountReason ?? "", /round-robin: next after stub-one/);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.accounts.4: fuzzy selectors work through spawn shorthand and account/swap surfaces", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const base = ["--data-dir", dir, "--json"];
    assert.equal(await runV2Cli(["account", "add", "stub", "owner@gmail.com", ...base], capture().io), 0);
    assert.equal(await runV2Cli(["account", "add", "stub", "owner@company.com", ...base], capture().io), 0);
    assert.equal(await runV2Cli(["account", "add", "codex", "coder@gmail.com", ...base], capture().io), 0);

    const spawned = capture();
    assert.equal(await runV2Cli(["spawn", "fuzzy", "stub-gmail", "--cwd", dir, ...base], spawned.io), 0);
    const result = JSON.parse(spawned.out[0] ?? "{}") as { beeId: string; agent: string; account: string | null };
    assert.equal(result.agent, "stub");
    assert.equal(result.account, "stub-owner-gmail.com");

    const get = capture();
    assert.equal(await runV2Cli(["account", "get", "stub-company", ...base], get.io), 0);
    assert.equal((JSON.parse(get.out[0] ?? "{}") as { account: { id: string } }).account.id, "stub-owner-company.com");

    const swapped = capture();
    assert.equal(await runV2Cli(["swap-account", "fuzzy", "stub-company", ...base], swapped.io), 0);
    assert.equal((JSON.parse(swapped.out[0] ?? "{}") as { to: string }).to, "stub-owner-company.com");

    const ambiguous = capture();
    assert.equal(await runV2Cli(["account", "get", "gmail", ...base], ambiguous.io), 1);
    assert.match(ambiguous.err[0] ?? "", /invalid_request.*ambiguous account.*stub-owner-gmail\.com.*codex-coder-gmail\.com/i);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
