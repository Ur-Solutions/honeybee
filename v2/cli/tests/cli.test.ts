/**
 * WP4 CLI tier: the thin client — RPC when the daemon is up, read-only
 * SQLite fallback clearly labeled stale when it is down, `send --wait` (Q3),
 * and the service-layer glue (label/exec-args). Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { runV2Cli, serviceEnv, serviceExecArgs, serviceLabel, type CliIo } from "../src/main.ts";
import { stripAnsi } from "../src/style.ts";
import { claudeHsrRecord, makeFrozenFixture } from "../../core/tests/frozen-fixture.ts";
import { commitInCell, g, makeOrigin } from "../../driver-cell/tests/helpers.ts";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(stripAnsi(l)), err: (l) => err.push(stripAnsi(l)) }, out, err };
}

test("cli.1: help prints and exits 0; unknown command exits 1", async () => {
  const a = capture();
  assert.equal(await runV2Cli(["help"], a.io), 0);
  assert.ok(a.out.join("\n").includes("hive <command>"));
  const b = capture();
  assert.equal(await runV2Cli(["frobnicate"], b.io), 1);
  assert.ok(b.err[0]?.includes("unknown command"));
});

test("cli.2: reads fall back to the read-only store when the daemon is down — labeled stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cli-"));
  try {
    // Build a store offline (no daemon): one bee, runtime stopped(crashed).
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "bee-a", name: "alpha", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store.updateRuntimeState("bee-a", 1, "stopped", { exitCause: "crashed" });
    store.send("bee-a", "queued while down");
    store.close();

    // json: stale flag set.
    const j = capture();
    assert.equal(await runV2Cli(["list", "--all", "--data-dir", dir, "--json"], j.io), 0);
    const parsed = JSON.parse(j.out[0] ?? "{}") as { stale?: boolean; views: Array<{ view: { beeId: string } }> };
    assert.equal(parsed.stale, true);
    assert.equal(parsed.views[0]?.view.beeId, "bee-a");

    // human: STALE banner on stderr, stale-prefixed rows, view by NAME resolves.
    const h = capture();
    assert.equal(await runV2Cli(["view", "alpha", "--data-dir", dir], h.io), 0);
    assert.ok(h.err[0]?.startsWith("STALE"), `stderr labeled: ${h.err[0]}`);
    assert.ok(h.out[0]?.startsWith("stale: "), `row labeled: ${h.out[0]}`);
    assert.ok(h.out[0]?.includes("stopped(crashed)"));

    // mailbox fallback too.
    const m = capture();
    assert.equal(await runV2Cli(["mailbox", "alpha", "--data-dir", dir, "--json"], m.io), 0);
    const mail = JSON.parse(m.out[0] ?? "{}") as { stale?: boolean; messages: Array<{ body: string }> };
    assert.equal(mail.stale, true);

    // A LOCKED store means a live daemon holds it (B9): the fallback must
    // report the rpc failure honestly, never SQLite's bare "database is
    // locked" (2026-08-19 soak misdirection).
    const writer = openCoreStore(join(dir, "core.sqlite3"));
    try {
      const locked = capture();
      assert.equal(await runV2Cli(["list", "--all", "--data-dir", dir], locked.io), 1);
      const msg = [...locked.err, ...locked.out].join("\n");
      assert.match(msg, /daemon appears to be running .* but the request failed/);
      assert.doesNotMatch(msg, /^database is locked$/m);
    } finally {
      writer.close();
    }
    assert.equal(mail.messages[0]?.body, "queued while down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.3: mutations NEVER fall back — daemon down means a loud, typed failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cli-"));
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "bee-a", name: "alpha", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store.close();
    const a = capture();
    assert.equal(await runV2Cli(["send", "alpha", "hi", "--data-dir", dir], a.io), 1);
    assert.ok(a.err[0]?.includes("daemon not reachable"), a.err[0]);
    const b = capture();
    assert.equal(await runV2Cli(["stop", "alpha", "--data-dir", dir], b.io), 1);
    assert.ok(b.err[0]?.includes("daemon not reachable"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.3b: a misspelled flag is a LOUD error (never a silent no-op), and spawn takes the agent positionally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cli-"));
  try {
    // The 2026-08-19 soak: `--substarte cell` parsed as an unknown boolean
    // plus a stray positional, so an hsr claude spawned where a codex cell
    // was asked for — silently.
    const a = capture();
    assert.equal(await runV2Cli(["spawn", "x", "codex", "--substarte", "cell", "--data-dir", dir], a.io), 1);
    const aMsg = [...a.err, ...a.out].join("\n");
    assert.match(aMsg, /unknown flag: --substarte/);
    assert.match(aMsg, /did you mean --substrate\?/);

    // Unknown flags that are nowhere near a real one still refuse, without a hint.
    const b = capture();
    assert.equal(await runV2Cli(["spawn", "x", "--frobnicate", "--data-dir", dir], b.io), 1);
    assert.match([...b.err, ...b.out].join("\n"), /unknown flag: --frobnicate/);

    // A stray extra positional is refused rather than ignored.
    const c = capture();
    assert.equal(await runV2Cli(["spawn", "x", "codex", "cell", "--data-dir", dir], c.io), 1);
    assert.match([...c.err, ...c.out].join("\n"), /unexpected argument 'cell'/);

    // Two disagreeing agent forms refuse instead of silently picking one.
    const d = capture();
    assert.equal(await runV2Cli(["spawn", "x", "codex", "--agent", "claude", "--data-dir", dir], d.io), 1);
    assert.match([...d.err, ...d.out].join("\n"), /agent given twice and they disagree/);

    // Short aliases still resolve (they expand before the known-flag check).
    const e = capture();
    assert.equal(await runV2Cli(["tail", "nope", "-n", "5", "-f", "--data-dir", dir], e.io), 1);
    assert.doesNotMatch([...e.err, ...e.out].join("\n"), /unknown flag/);
    const tf = capture();
    assert.equal(await runV2Cli(["transcript", "nope", "-f", "--data-dir", dir], tf.io), 1);
    assert.doesNotMatch([...tf.err, ...tf.out].join("\n"), /unknown flag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.4: against a live daemon — spawn, list (not stale), send --wait blocks on the delivery mark", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(
      await runV2Cli(["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], s.io),
      0,
    );
    const spawned = JSON.parse(s.out[0] ?? "{}") as { beeId: string; commandId: number };
    assert.ok(spawned.beeId.length > 0);
    assert.ok(spawned.commandId > 0, "mutation returns the enqueued command id");

    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["view", "worker", "--data-dir", dir, "--json"], l.io);
      const v = JSON.parse(l.out[0] ?? "{}") as { stale?: boolean; view?: { runtimeState: string } };
      assert.notEqual(v.stale, true, "live daemon reads are never stale-labeled");
      return v.view?.runtimeState === "idle";
    }, "worker idle", 10_000);

    // Q3: --wait returns only after delivered_generation is marked.
    const w = capture();
    assert.equal(
      await runV2Cli(["send", "worker", "do the thing", "--wait", "--data-dir", dir, "--json"], w.io),
      0,
    );
    const sent = JSON.parse(w.out[0] ?? "{}") as { messageId: number; deliveredGeneration?: number };
    assert.equal(sent.deliveredGeneration, 1);

    // health through the CLI.
    const h = capture();
    assert.equal(await runV2Cli(["health", "--data-dir", dir, "--json"], h.io), 0);
    const health = JSON.parse(h.out[0] ?? "{}") as { i1Violations: number; bees: { total: number } };
    assert.equal(health.i1Violations, 0);
    assert.equal(health.bees.total, 1);

    // daemon status via RPC probe (no service manager involved).
    const st = capture();
    assert.equal(await runV2Cli(["daemon", "status", "--data-dir", dir, "--json"], st.io), 0);
    assert.equal((JSON.parse(st.out[0] ?? "{}") as { running: boolean }).running, true);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.4b: --idempotency-key passes through on spawn and send — replays dedup to the original", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);

    const a = capture();
    assert.equal(
      await runV2Cli(
        ["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--idempotency-key", "cli-spawn-1", "--data-dir", dir, "--json"],
        a.io,
      ),
      0,
    );
    const first = JSON.parse(a.out[0] ?? "{}") as { beeId: string; commandId: number; deduped?: boolean };
    assert.ok(first.beeId.length > 0);
    assert.notEqual(first.deduped, true);

    const b = capture();
    assert.equal(
      await runV2Cli(
        ["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--idempotency-key", "cli-spawn-1", "--data-dir", dir, "--json"],
        b.io,
      ),
      0,
    );
    const replay = JSON.parse(b.out[0] ?? "{}") as { beeId: string; commandId: number; deduped?: boolean };
    assert.equal(replay.deduped, true, "second spawn with the same key is a dedup");
    assert.equal(replay.beeId, first.beeId);
    assert.equal(replay.commandId, first.commandId);

    // Only one bee exists.
    const l = capture();
    assert.equal(await runV2Cli(["list", "--all", "--data-dir", dir, "--json"], l.io), 0);
    assert.equal((JSON.parse(l.out[0] ?? "{}") as { views: unknown[] }).views.length, 1);

    // send: same key → same message id, marked deduped in human output too.
    const s1 = capture();
    assert.equal(
      await runV2Cli(["send", "worker", "ping", "--idempotency-key", "cli-send-1", "--data-dir", dir, "--json"], s1.io),
      0,
    );
    const sent = JSON.parse(s1.out[0] ?? "{}") as { messageId: number };
    const s2 = capture();
    assert.equal(
      await runV2Cli(["send", "worker", "ping", "--idempotency-key", "cli-send-1", "--data-dir", dir], s2.io),
      0,
    );
    assert.ok(s2.out[0]?.startsWith("deduped: already sent message"), s2.out[0]);
    assert.ok(s2.out[0]?.includes(`message ${sent.messageId} `), "same message id on replay");
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.4c: per-bee args — `spawn --arg` (repeatable), `bee set-args <bee> -- <args…>` / --clear, `bee args`, `revive --arg`, view/list carry args; stale read shows them too", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(await runV2Cli(["spawn", "argsy", "--agent", "stub", "--cwd", "/tmp", "--arg", "--model", "--arg", "fable", "--data-dir", dir, "--json"], s.io), 0);
    const spawned = JSON.parse(s.out[0] ?? "{}") as { beeId: string };
    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["view", "argsy", "--data-dir", dir, "--json"], l.io);
      return (JSON.parse(l.out[0] ?? "{}") as { view?: { runtimeState: string } }).view?.runtimeState === "idle";
    }, "argsy idle", 10_000);
    const v = capture();
    assert.equal(await runV2Cli(["view", "argsy", "--data-dir", dir], v.io), 0);
    assert.ok(v.out.join("\n").includes('["--model","fable"]'), `human view shows args: ${v.out.join(" | ")}`);
    const a1 = capture();
    assert.equal(await runV2Cli(["bee", "args", "argsy", "--data-dir", dir, "--json"], a1.io), 0);
    assert.deepEqual(JSON.parse(a1.out[0] ?? "{}"), { beeId: spawned.beeId, args: ["--model", "fable"] });

    // set-args with `--`: everything after is verbatim (even tokens that look like our own flags)
    const set = capture();
    assert.equal(await runV2Cli(["bee", "set-args", "argsy", "--data-dir", dir, "--json", "--", "--model", "opus", "--effort", "high", "--dangerously-skip-permissions"], set.io), 0);
    const setRes = JSON.parse(set.out[0] ?? "{}") as { applied: boolean; bee: { args: string[] | null } };
    assert.equal(setRes.applied, true);
    assert.deepEqual(setRes.bee.args, ["--model", "opus", "--effort", "high", "--dangerously-skip-permissions"]);
    // human, unchanged
    const same = capture();
    assert.equal(await runV2Cli(["bee", "set-args", "argsy", "--data-dir", dir, "--", "--model", "opus", "--effort", "high", "--dangerously-skip-permissions"], same.io), 0);
    assert.ok(same.out[0]?.includes("unchanged args for"), same.out[0]);
    // usage errors: no args and no --clear
    const bad = capture();
    assert.equal(await runV2Cli(["bee", "set-args", "argsy", "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err[0]?.includes("usage: hive bee set-args"));
    const bad2 = capture();
    assert.equal(await runV2Cli(["bee", "frob", "--data-dir", dir], bad2.io), 1);
    // --clear
    const clr = capture();
    assert.equal(await runV2Cli(["bee", "set-args", "argsy", "--clear", "--data-dir", dir, "--json"], clr.io), 0);
    assert.equal((JSON.parse(clr.out[0] ?? "{}") as { bee: { args: unknown } }).bee.args, null);

    // revive --arg: stop, then revive with replacement args → row updated, generation 2
    const st = capture();
    assert.equal(await runV2Cli(["stop", "argsy", "--data-dir", dir], st.io), 0);
    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["view", "argsy", "--data-dir", dir, "--json"], l.io);
      return (JSON.parse(l.out[0] ?? "{}") as { view?: { runtimeState: string } }).view?.runtimeState === "stopped";
    }, "argsy stopped", 10_000);
    const rv = capture();
    assert.equal(await runV2Cli(["revive", "argsy", "--arg", "--effort", "--arg", "max", "--data-dir", dir], rv.io), 0);
    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["view", "argsy", "--data-dir", dir, "--json"], l.io);
      const parsed = JSON.parse(l.out[0] ?? "{}") as { view?: { generation: number; runtimeState: string }; bee?: { args: string[] | null } };
      return parsed.view?.generation === 2 && parsed.view.runtimeState === "idle" ? parsed : null;
    }, "argsy gen 2 idle", 10_000);
    const after = capture();
    await runV2Cli(["list", "--data-dir", dir, "--json"], after.io);
    const listed = JSON.parse(after.out[0] ?? "{}") as { views: Array<{ bee: { name: string; args: string[] | null } }> };
    assert.deepEqual(listed.views.find((x) => x.bee.name === "argsy")?.bee.args, ["--effort", "max"]);

    // daemon down: the read-only fallback still shows args (stale)
    await daemon.stop();
    daemon = null;
    const stale = capture();
    assert.equal(await runV2Cli(["bee", "args", "argsy", "--data-dir", dir, "--json"], stale.io), 0);
    assert.deepEqual(JSON.parse(stale.out[0] ?? "{}"), { stale: true, beeId: spawned.beeId, args: ["--effort", "max"] });
    // set-args is a mutation: never falls back
    const down = capture();
    assert.equal(await runV2Cli(["bee", "set-args", "argsy", "--data-dir", dir, "--", "--x"], down.io), 1);
    assert.ok(down.err[0]?.includes("daemon"), down.err[0]);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.4d: cells — `spawn --substrate cell --origin`, `cell capture --onto` (landed / refused as results), `cell remove` (refused-dirty exit 2, --force)", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-cli-cells-"));
  const origin = makeOrigin(root);
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    cells: { root: join(root, "cells") },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);

    // --origin alone implies --substrate cell; --sha pins the checkout.
    const s = capture();
    assert.equal(
      await runV2Cli(["spawn", "celly", "--agent", "stub", "--origin", origin.repo, "--sha", origin.sha, "--data-dir", dir, "--json"], s.io),
      0,
    );
    const spawned = JSON.parse(s.out[0] ?? "{}") as { beeId: string };
    // Usage errors are loud: cell without origin; origin with an explicit non-cell substrate.
    const u1 = capture();
    assert.equal(await runV2Cli(["spawn", "x", "--agent", "stub", "--substrate", "cell", "--data-dir", dir], u1.io), 1);
    assert.ok(u1.err[0]?.includes("--origin"), u1.err[0]);
    const u2 = capture();
    assert.equal(await runV2Cli(["spawn", "x", "--agent", "stub", "--substrate", "hsr", "--origin", origin.repo, "--data-dir", dir], u2.io), 1);

    let cwd = "";
    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["view", "celly", "--data-dir", dir, "--json"], l.io);
      const v = JSON.parse(l.out[0] ?? "{}") as { view?: { runtimeState: string }; bee?: { substrate: string; cwd: string } };
      cwd = v.bee?.cwd ?? "";
      return v.view?.runtimeState === "idle" && v.bee?.substrate === "cell";
    // Provisioning performs real worktree and runner setup. Keep the wait
    // bounded while allowing for filesystem contention in the full gate.
    }, "cell bee idle", 60_000);
    assert.ok(/-space-/.test(cwd), `cwd is the space dir: ${cwd}`);
    // list shows the substrate in the human row? (view line carries agent/state; substrate lives on the row json)
    const lj = capture();
    assert.equal(await runV2Cli(["list", "--data-dir", dir, "--json"], lj.io), 0);
    const listed = JSON.parse(lj.out[0] ?? "{}") as { views: Array<{ bee: { substrate: string } }> };
    assert.equal(listed.views[0]?.bee.substrate, "cell");

    // capture onto the checked-out branch → refused (a RESULT): human exit 2, json exit 0.
    const r1 = capture();
    assert.equal(await runV2Cli(["cell", "capture", "celly", "--onto", "main", "--data-dir", dir], r1.io), 2);
    assert.ok(r1.out[0]?.includes("refused (target_checked_out)"), r1.out[0]);
    assert.ok(r1.out[0]?.includes("was not modified"));
    const r1j = capture();
    assert.equal(await runV2Cli(["cell", "capture", "celly", "--onto", "main", "--data-dir", dir, "--json"], r1j.io), 0);
    assert.equal((JSON.parse(r1j.out[0] ?? "{}") as { status: string }).status, "refused");

    // Work in the cell (from the test — the plain stub does not run shell), then land onto a new branch.
    commitInCell(cwd, "cli.txt", "hi\n", "cli work");
    const r2 = capture();
    assert.equal(
      await runV2Cli(["cell", "capture", "celly", "--onto", "throwaway/cli", "--rebase", "--idempotency-key", "cli-cap-1", "--data-dir", dir, "--json"], r2.io),
      0,
    );
    const landed = JSON.parse(r2.out[0] ?? "{}") as { status: string; mode: string; resultSha: string; beeId: string };
    assert.equal(landed.status, "landed");
    assert.equal(landed.mode, "rebase");
    assert.equal(landed.beeId, spawned.beeId);
    assert.equal(g(origin.repo, ["rev-parse", "throwaway/cli"]), landed.resultSha);
    // Replay: deduped, printed as such.
    const r2b = capture();
    assert.equal(await runV2Cli(["cell", "capture", "celly", "--onto", "throwaway/cli", "--rebase", "--idempotency-key", "cli-cap-1", "--data-dir", dir], r2b.io), 0);
    assert.ok(r2b.out[0]?.startsWith("deduped: landed"), r2b.out[0]);

    // remove while live → typed runtime_refused, exit 1.
    const rm0 = capture();
    assert.equal(await runV2Cli(["cell", "remove", "celly", "--data-dir", dir], rm0.io), 1);
    assert.ok(rm0.err[0]?.includes("runtime_refused"), rm0.err[0]);
    // stop, dirty the cell, remove → refused (exit 2) with the causes; --force deletes.
    assert.equal(await runV2Cli(["stop", "celly", "--data-dir", dir], capture().io), 0);
    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["view", "celly", "--data-dir", dir, "--json"], l.io);
      return (JSON.parse(l.out[0] ?? "{}") as { view?: { runtimeState: string } }).view?.runtimeState === "stopped";
    }, "stopped", 15_000);
    writeFileSync(join(cwd, "wip.txt"), "wip\n");
    const rm1 = capture();
    assert.equal(await runV2Cli(["cell", "remove", "celly", "--data-dir", dir], rm1.io), 2);
    assert.ok(rm1.out[0]?.includes("uncommitted changes"), rm1.out[0]);
    assert.ok(existsSync(cwd), "refused: nothing removed");
    const rm2 = capture();
    assert.equal(await runV2Cli(["cell", "remove", "celly", "--force", "--data-dir", dir, "--json"], rm2.io), 0);
    const removed = JSON.parse(rm2.out[0] ?? "{}") as { status: string; forced: boolean; commandId: number };
    assert.equal(removed.status, "deleted");
    assert.equal(removed.forced, true);
    assert.ok(removed.commandId > 0);
    assert.equal(existsSync(cwd), false, "cell gone");
    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["list", "--data-dir", dir, "--json"], l.io);
      return (JSON.parse(l.out[0] ?? "{}") as { views: unknown[] }).views.length === 0;
    }, "bee deleted", 10_000);
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli.4e: v6 verbs — rename, tag, interrupt, fork, children, spawn --parent (+ ambient HIVE_BEE_ID), ask/answer/question list, seal create/list/get; stale fallbacks for the reads", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  const savedEnv = process.env.HIVE_BEE_ID;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(await runV2Cli(["spawn", "boss", "--agent", "stub", "--cwd", "/tmp", "--tag", "apiary:workspace=a", "--data-dir", dir, "--json"], s.io), 0);
    const boss = (JSON.parse(s.out[0] ?? "{}") as { beeId: string }).beeId;
    const idle = async (needle: string): Promise<void> => {
      await waitFor(async () => {
        const l = capture();
        await runV2Cli(["view", needle, "--data-dir", dir, "--json"], l.io);
        return (JSON.parse(l.out[0] ?? "{}") as { view?: { runtimeState: string } }).view?.runtimeState === "idle";
      }, `${needle} idle`, 10_000);
    };
    await idle(boss);

    // rename by name, then by id; unchanged
    const r = capture();
    assert.equal(await runV2Cli(["rename", "boss", "chief", "--data-dir", dir], r.io), 0);
    assert.ok(r.out[0]?.includes(`renamed ${boss} → "chief"`), r.out[0]);
    const r2 = capture();
    assert.equal(await runV2Cli(["rename", boss, "chief", "--data-dir", dir], r2.io), 0);
    assert.ok(r2.out[0]?.includes("unchanged"), r2.out[0]);

    // tag: --add / --remove (repeatable)
    const t = capture();
    assert.equal(await runV2Cli(["tag", "chief", "--remove", "apiary:workspace=a", "--add", "apiary:workspace=b", "--add", "x", "--data-dir", dir, "--json"], t.io), 0);
    const tagged = JSON.parse(t.out[0] ?? "{}") as { bee: { tags: string[] }; added: string[]; removed: string[] };
    assert.deepEqual(tagged.bee.tags, ["apiary:workspace=b", "x"]);
    assert.deepEqual(tagged.removed, ["apiary:workspace=a"]);
    const tu = capture();
    assert.equal(await runV2Cli(["tag", "chief", "--data-dir", dir], tu.io), 1, "no edit = usage error");

    // interrupt an idle bee: reasoned no-op, exit 0
    const i = capture();
    assert.equal(await runV2Cli(["interrupt", "chief", "--data-dir", dir, "--json"], i.io), 0);
    assert.deepEqual(JSON.parse(i.out[0] ?? "{}"), { beeId: boss, generation: 1, interrupted: false, reason: "idle" });

    // spawn --parent (explicit, by name) and the ambient HIVE_BEE_ID stamp
    const c1 = capture();
    assert.equal(await runV2Cli(["spawn", "kid-1", "--agent", "stub", "--cwd", "/tmp", "--parent", "chief", "--data-dir", dir, "--json"], c1.io), 0);
    const kid1 = (JSON.parse(c1.out[0] ?? "{}") as { beeId: string }).beeId;
    process.env.HIVE_BEE_ID = boss; // this process "is" the boss bee
    const c2 = capture();
    assert.equal(await runV2Cli(["spawn", "kid-2", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], c2.io), 0);
    const kid2 = (JSON.parse(c2.out[0] ?? "{}") as { beeId: string }).beeId;
    const c3 = capture();
    assert.equal(await runV2Cli(["spawn", "root-2", "--agent", "stub", "--cwd", "/tmp", "--no-parent", "--data-dir", dir, "--json"], c3.io), 0);
    process.env.HIVE_BEE_ID = "not-a-bee-on-this-node";
    const c4 = capture();
    assert.equal(await runV2Cli(["spawn", "root-3", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], c4.io), 0, "an unknown ambient stamp is dropped, not an error");
    process.env.HIVE_BEE_ID = boss;
    const ch = capture();
    assert.equal(await runV2Cli(["children", "chief", "--data-dir", dir, "--json"], ch.io), 0);
    const children = JSON.parse(ch.out[0] ?? "{}") as { children: Array<{ bee: { id: string; parentId: string } }> };
    assert.deepEqual(children.children.map((v) => v.bee.id).sort(), [kid1, kid2].sort());
    const chh = capture();
    assert.equal(await runV2Cli(["children", "root-2", "--data-dir", dir], chh.io), 0);
    assert.equal(chh.out[0], "no children");

    // ask from inside the boss bee (HIVE_BEE_ID) → open question; list; answer → delivered
    const a = capture();
    assert.equal(await runV2Cli(["ask", "merge", "or", "rebase?", "--option", "merge", "--option", "rebase", "--data-dir", dir, "--json"], a.io), 0);
    const asked = JSON.parse(a.out[0] ?? "{}") as { question: { id: string; beeId: string; status: string; options: string[] } };
    assert.equal(asked.question.beeId, boss);
    assert.equal(asked.question.status, "open");
    assert.deepEqual(asked.question.options, ["merge", "rebase"]);
    const ql = capture();
    assert.equal(await runV2Cli(["question", "list", "--open", "--data-dir", dir], ql.io), 0);
    assert.ok(ql.out[0]?.includes(asked.question.id) && ql.out[0]?.includes("open"), ql.out[0]);
    const an = capture();
    assert.equal(await runV2Cli(["answer", asked.question.id, "rebase", "please", "--by", "tormod", "--data-dir", dir, "--json"], an.io), 0);
    const answered = JSON.parse(an.out[0] ?? "{}") as { question: { status: string; answer: string }; messageId: number };
    assert.equal(answered.question.status, "answered");
    assert.equal(answered.question.answer, "rebase please");
    await waitFor(async () => {
      const m = capture();
      await runV2Cli(["mailbox", "chief", "--data-dir", dir, "--json"], m.io);
      const mail = JSON.parse(m.out[0] ?? "{}") as { messages: Array<{ id: number; deliveredAt: number | null; body: string; sender: string }> };
      const row = mail.messages.find((x) => x.id === answered.messageId);
      return row?.deliveredAt != null && row.body.startsWith(`[answer to question ${asked.question.id}] rebase please`) && row.sender === "tormod";
    }, "answer delivered as mail", 10_000);
    const an2 = capture();
    assert.equal(await runV2Cli(["question", "answer", asked.question.id, "again", "--data-dir", dir], an2.io), 1, "already answered = typed error");
    assert.ok(an2.err[0]?.includes("invalid_request"), an2.err[0]);
    // ask outside a bee without --bee: loud usage error; with --bee: fine
    delete process.env.HIVE_BEE_ID;
    const noBee = capture();
    assert.equal(await runV2Cli(["ask", "who am i?", "--data-dir", dir], noBee.io), 1);
    assert.ok(noBee.err[0]?.includes("HIVE_BEE_ID"), noBee.err[0]);
    const withBee = capture();
    assert.equal(await runV2Cli(["ask", "who am i?", "--bee", "kid-1", "--data-dir", dir, "--json"], withBee.io), 0);
    assert.equal((JSON.parse(withBee.out[0] ?? "{}") as { question: { beeId: string } }).question.beeId, kid1);

    // seals: create (title positional, --body, --ref…) for --bee; list; get
    const sc = capture();
    assert.equal(await runV2Cli(["seal", "impl done", "--body", "all green", "--ref", "main@abc", "--ref", "https://ci/1", "--bee", "chief", "--data-dir", dir, "--json"], sc.io), 0);
    const seal = (JSON.parse(sc.out[0] ?? "{}") as { seal: { id: string; beeId: string; refs: string[]; generation: number } }).seal;
    assert.equal(seal.beeId, boss);
    assert.deepEqual(seal.refs, ["main@abc", "https://ci/1"]);
    process.env.HIVE_BEE_ID = kid1;
    const sc2 = capture();
    assert.equal(await runV2Cli(["seal", "kid seal", "--data-dir", dir, "--json"], sc2.io), 0);
    assert.equal((JSON.parse(sc2.out[0] ?? "{}") as { seal: { beeId: string } }).seal.beeId, kid1);
    const sl = capture();
    assert.equal(await runV2Cli(["seal", "list", "--bee", "chief", "--data-dir", dir, "--json"], sl.io), 0);
    assert.deepEqual((JSON.parse(sl.out[0] ?? "{}") as { seals: Array<{ id: string }> }).seals.map((x) => x.id), [seal.id]);
    const sg = capture();
    assert.equal(await runV2Cli(["seal", "get", seal.id, "--data-dir", dir], sg.io), 0);
    assert.ok(sg.out[0]?.includes("impl done") && sg.out[1]?.includes("all green"), sg.out.join("|"));
    const sgn = capture();
    assert.equal(await runV2Cli(["seal", "get", "nope", "--data-dir", dir], sgn.io), 1);
    assert.ok(sgn.err[0]?.includes("seal_not_found"), sgn.err[0]);

    // fork (stub: no fork mechanism → boots fresh; provenance + parent recorded)
    const f = capture();
    assert.equal(await runV2Cli(["fork", "chief", "--name", "chief-b", "take", "over", "--data-dir", dir, "--json"], f.io), 0);
    const forked = JSON.parse(f.out[0] ?? "{}") as { beeId: string; forkedFrom: string; messageId: number | null; bee: { name: string; parentId: string; forkedFrom: string } };
    assert.equal(forked.forkedFrom, boss);
    assert.equal(forked.bee.name, "chief-b");
    assert.equal(forked.bee.parentId, boss);
    assert.ok(forked.messageId != null, "positional prompt enqueued");
    await idle("chief-b");
    const chf = capture();
    assert.equal(await runV2Cli(["children", "chief", "--data-dir", dir, "--json"], chf.io), 0);
    assert.equal((JSON.parse(chf.out[0] ?? "{}") as { children: unknown[] }).children.length, 3);

    // stale fallbacks: stop the daemon; children / question list / seal list / seal get read the store directly
    await daemon.stop();
    daemon = null;
    const sch = capture();
    assert.equal(await runV2Cli(["children", "chief", "--data-dir", dir, "--json"], sch.io), 0);
    const staleKids = JSON.parse(sch.out[0] ?? "{}") as { stale?: boolean; children: unknown[] };
    assert.equal(staleKids.stale, true);
    assert.equal(staleKids.children.length, 3);
    const sql = capture();
    assert.equal(await runV2Cli(["question", "list", "--data-dir", dir, "--json"], sql.io), 0);
    const staleQ = JSON.parse(sql.out[0] ?? "{}") as { stale?: boolean; questions: Array<{ status: string }> };
    assert.equal(staleQ.stale, true);
    assert.equal(staleQ.questions.length, 2);
    const ssl = capture();
    assert.equal(await runV2Cli(["seal", "list", "--data-dir", dir], ssl.io), 0);
    assert.ok(ssl.err[0]?.startsWith("STALE"));
    assert.equal(ssl.out.length, 2);
    assert.ok(ssl.out[0]?.startsWith("stale: "));
    const ssg = capture();
    assert.equal(await runV2Cli(["seal", "get", seal.id, "--data-dir", dir, "--json"], ssg.io), 0);
    assert.equal((JSON.parse(ssg.out[0] ?? "{}") as { stale?: boolean }).stale, true);
    // mutations never fall back
    const sm = capture();
    assert.equal(await runV2Cli(["rename", "chief", "x", "--data-dir", dir], sm.io), 1);
    assert.ok(sm.err[0]?.includes("daemon not reachable"));
  } finally {
    if (savedEnv === undefined) delete process.env.HIVE_BEE_ID;
    else process.env.HIVE_BEE_ID = savedEnv;
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.daemon: usage lists restart as a stop+start alias", async () => {
  const a = capture();
  assert.equal(await runV2Cli(["daemon", "nope"], a.io), 1);
  assert.match(a.err.join("\n"), /restart/);
  const help = capture();
  assert.equal(await runV2Cli(["help"], help.io), 0);
  assert.match(help.out.join("\n"), /daemon install\|uninstall\|start\|stop\|restart\|status/);
});

test("cli.5: daemon status when nothing runs and no service is installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cli-"));
  try {
    const a = capture();
    process.env.HIVE_V2_SERVICE_DIR = join(dir, "no-services");
    try {
      assert.equal(await runV2Cli(["daemon", "status", "--data-dir", dir, "--json"], a.io), 0);
    } finally {
      delete process.env.HIVE_V2_SERVICE_DIR;
    }
    const parsed = JSON.parse(a.out[0] ?? "{}") as { running: boolean; service: unknown };
    assert.equal(parsed.running, false);
    assert.equal(parsed.service, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli.6: service glue — label never the live daemon's, exec args env override wins", () => {
  assert.equal(serviceLabel({}), "dev.honeybee.hive.v2");
  assert.notEqual(serviceLabel({}), "dev.honeybee.hive");
  assert.equal(serviceLabel({ HIVE_V2_SERVICE_LABEL: "x.test" }), "x.test");
  assert.deepEqual(
    serviceExecArgs("/data", { HIVE_V2_SERVICE_ARGS: JSON.stringify(["/bin/node", "/x.js", "daemon", "run"]) }),
    ["/bin/node", "/x.js", "daemon", "run"],
  );
  const computed = serviceExecArgs("/data", {});
  assert.equal(computed[0], process.execPath);
  assert.deepEqual(computed.slice(-3), ["run", "--data-dir", "/data"]);
  // Service env bakes the installing shell's PATH (launchd/systemd give the
  // daemon a bare PATH that cannot resolve claude/codex — 2026-08-19 soak).
  assert.deepEqual(serviceEnv("/data", { PATH: "/a:/b" }), { HIVE_V2_DATA_DIR: "/data", PATH: "/a:/b" });
  assert.deepEqual(serviceEnv("/data", {}), { HIVE_V2_DATA_DIR: "/data" });
});

test("cli.7: cutover verbs — `freeze` writes/refuses locally; `import --from-frozen` reports (dry-run, marker refusal, real import, idempotent) over RPC", async () => {
  const fx = makeFrozenFixture();
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    fx.writeRecord("a.json", claudeHsrRecord(fx.root, { runnerPid: 4_190_000, runnerFingerprint: { pgid: 4_190_000, startedAt: "Tue Aug 18 07:42:57 2026" } }));
    fx.writeRecord("kf.json", claudeHsrRecord(fx.root, { id: "CL.kf", name: "kf-bee", status: "kill_failed" }));
    daemon = await startDaemon(dir);

    // import before freeze → refused (marker missing), exit 1, nothing written
    const r0 = capture();
    assert.equal(await runV2Cli(["import", "--from-frozen", "--root", fx.root, "--data-dir", dir], r0.io), 1);
    assert.ok(r0.out.some((l) => l.includes("FROZEN MISSING")), r0.out.join("\n"));
    assert.ok(r0.out.some((l) => l.startsWith("REFUSED:") && l.includes("hive v2 freeze")), r0.out.join("\n"));

    // usage guard
    const bad = capture();
    assert.equal(await runV2Cli(["import", "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err[0]?.includes("usage: hive import --from-frozen"));

    // freeze: lock pid alive → refused; impossible pid → written; again → already frozen
    fx.writeDaemonLock({ pid: process.pid, startedAt: new Date().toISOString() });
    const f0 = capture();
    assert.equal(await runV2Cli(["freeze", "--root", fx.root, "--data-dir", dir], f0.io), 1);
    assert.ok(f0.out[0]?.includes("refused") && f0.out[0]?.includes(String(process.pid)), f0.out[0]);
    fx.writeDaemonLock({ pid: 4_190_001, startedAt: "2026-08-17T12:22:29.035Z" });
    const f1 = capture();
    assert.equal(await runV2Cli(["freeze", "--root", fx.root, "--data-dir", dir, "--json"], f1.io), 0);
    assert.equal((JSON.parse(f1.out[0] ?? "{}") as { outcome: string }).outcome, "written");
    const f2 = capture();
    assert.equal(await runV2Cli(["freeze", "--root", fx.root, "--data-dir", dir], f2.io), 0);
    assert.ok(f2.out[0]?.startsWith("already frozen"));

    // dry-run: plan listed, nothing written, exit 0
    const d = capture();
    assert.equal(await runV2Cli(["import", "--from-frozen", "--root", fx.root, "--dry-run", "--data-dir", dir], d.io), 0);
    assert.ok(d.out.some((l) => l.startsWith("dry-run: import --from-frozen")), d.out.join("\n"));
    assert.ok(d.out.some((l) => l.includes("would import 1, skip 1")), d.out.join("\n"));
    assert.ok(d.out.some((l) => l.includes("import CL.fe6f") && l.includes("resume=native(9aa1f08d")), d.out.join("\n"));
    assert.ok(d.out.some((l) => l.includes("skip   CL.kf") && l.includes("reason=kill_failed")), d.out.join("\n"));
    assert.ok(d.out.some((l) => l === "dry-run: nothing written"));
    const l0 = capture();
    await runV2Cli(["list", "--all", "--data-dir", dir, "--json"], l0.io);
    assert.equal((JSON.parse(l0.out[0] ?? "{}") as { views: unknown[] }).views.length, 0);

    // real import, json
    const i1 = capture();
    assert.equal(await runV2Cli(["import", "--from-frozen", "--root", fx.root, "--data-dir", dir, "--json"], i1.io), 0);
    const report = JSON.parse(i1.out[0] ?? "{}") as { applied: boolean; imported: Array<{ beeId: string; resume: string }> };
    assert.equal(report.applied, true);
    assert.deepEqual(report.imported, [{ beeId: "CL.fe6f", name: "apiary-waggle-msx67afb-1", agent: "claude", resume: "harness_native" }]);
    // the bee is visible + stopped + reachable through the normal read path
    const v = capture();
    assert.equal(await runV2Cli(["view", "CL.fe6f", "--data-dir", dir], v.io), 0);
    assert.ok(v.out[0]?.includes("stopped(stopped_by_system)"), v.out[0]);

    // idempotent re-run through the CLI
    const i2 = capture();
    assert.equal(await runV2Cli(["import", "--from-frozen", "--root", fx.root, "--data-dir", dir], i2.io), 0);
    assert.ok(i2.out.some((l) => l.includes("already_imported=1")), i2.out.join("\n"));
    assert.ok(i2.out.some((l) => l.includes("imported 0 bee(s)")));
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
    fx.cleanup();
  }
});

test("cli.urgency: send --urgency passes through to the row; the mailbox read surfaces it; an unknown value is a typed error", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const s = capture();
    assert.equal(
      await runV2Cli(["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], s.io),
      0,
    );
    await waitFor(async () => {
      const l = capture();
      await runV2Cli(["view", "worker", "--data-dir", dir, "--json"], l.io);
      return (JSON.parse(l.out[0] ?? "{}") as { view?: { runtimeState: string } }).view?.runtimeState === "idle";
    }, "worker idle", 10_000);

    // --urgency idle passes through (the bee is idle, so it still delivers).
    const w = capture();
    assert.equal(
      await runV2Cli(["send", "worker", "for later", "--urgency", "idle", "--wait", "--data-dir", dir, "--json"], w.io),
      0,
    );
    const sent = JSON.parse(w.out[0] ?? "{}") as { messageId: number };
    // Default: no flag = next.
    const d = capture();
    assert.equal(await runV2Cli(["send", "worker", "plain", "--wait", "--data-dir", dir, "--json"], d.io), 0);
    const plain = JSON.parse(d.out[0] ?? "{}") as { messageId: number };

    const m = capture();
    assert.equal(await runV2Cli(["mailbox", "worker", "--data-dir", dir, "--json"], m.io), 0);
    const mail = JSON.parse(m.out[0] ?? "{}") as { messages: Array<{ id: number; urgency: string }> };
    assert.equal(mail.messages.find((x) => x.id === sent.messageId)?.urgency, "idle");
    assert.equal(mail.messages.find((x) => x.id === plain.messageId)?.urgency, "next");

    // Unknown urgency: the daemon's typed invalid_request surfaces, exit 1.
    const bad = capture();
    assert.equal(await runV2Cli(["send", "worker", "x", "--urgency", "soon", "--data-dir", dir], bad.io), 1);
    assert.ok(bad.err[0]?.includes("invalid_request"), bad.err.join("\n"));
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("cli.version: --version answers (Apiary's Doctor gates local runs on it)", async () => {
  for (const argv of [["--version"], ["-v"], ["version"]]) {
    const c = capture();
    assert.equal(await runV2Cli(argv, c.io), 0);
    assert.match(c.out[0] ?? "", /^honeybee \S+$/);
  }
});

test("cli.task: add/ls/done/supply round-trip through the daemon; unknown command is gone", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const spawn = capture();
    assert.equal(
      await runV2Cli(["spawn", "worker", "--agent", "stub", "--cwd", "/tmp", "--data-dir", dir, "--json"], spawn.io),
      0,
    );
    const spawned = JSON.parse(spawn.out[0] ?? "{}") as { beeId: string };

    const add = capture();
    assert.equal(
      await runV2Cli(
        ["task", "add", "worker", "-p", "paint the button", "--sender-human", "operator", "--data-dir", dir, "--json"],
        add.io,
      ),
      0,
    );
    const added = JSON.parse(add.out[0] ?? "{}") as { task: { id: string; status: string; auto: boolean; title: string } };
    assert.equal(added.task.status, "pending");
    assert.equal(added.task.auto, true);
    assert.equal(added.task.title, "paint the button");

    const ls = capture();
    assert.equal(await runV2Cli(["task", "ls", "worker", "--data-dir", dir, "--json"], ls.io), 0);
    const listed = JSON.parse(ls.out[0] ?? "{}") as { tasks: Array<{ id: string }> };
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0]?.id, added.task.id);

    const done = capture();
    assert.equal(await runV2Cli(["task", "done", added.task.id, "--data-dir", dir, "--json"], done.io), 0);
    const closed = JSON.parse(done.out[0] ?? "{}") as { task: { status: string } };
    assert.equal(closed.task.status, "done");

    const supply = capture();
    assert.equal(await runV2Cli(["task", "supply", spawned.beeId, "--on", "--data-dir", dir, "--json"], supply.io), 0);
    const set = JSON.parse(supply.out[0] ?? "{}") as { supply: { on: boolean; paused: boolean } };
    assert.equal(set.supply.on, true);
    assert.equal(set.supply.paused, false);

    const help = capture();
    assert.equal(await runV2Cli(["help"], help.io), 0);
    assert.ok(help.out.join("\n").includes("task"));
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
