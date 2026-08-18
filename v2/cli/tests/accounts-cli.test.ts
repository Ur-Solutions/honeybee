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

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
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
    assert.ok(list.out.some((l) => l.startsWith("stub-one  stub  ok") && l.includes("penalty=5")), list.out.join("\n"));
    assert.ok(list.out.some((l) => l.startsWith("stub-two  stub  ok")));
    // pause / unpause / penalty
    const pause = capture();
    assert.equal(await runV2Cli(["account", "pause", "stub-two", ...base], pause.io), 0);
    assert.match(pause.out[0] ?? "", /paused stub-two \(status paused\)/);
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
    assert.match(usage.err[0] ?? "", /usage: hive v2 account/);
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
    assert.match(h.out[0] ?? "", /^stale: claude-a  claude  ok  \/tmp\/h  penalty=3  weekly=40% 5h=5% plan=max$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
